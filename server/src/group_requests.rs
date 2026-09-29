//! Fixed-size group-create identities survive retries and result retirement.
//! All creation calls run under the caller's writer lock and live authorization.
use crate::{
    State, api, auth, db,
    error::{ApiError, Result},
    groups, rollout,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

const HISTORY_SQL: &str = "WITH page AS MATERIALIZED (SELECT request_id,group_id,created_at FROM group_requests WHERE actor_id=? ORDER BY created_at DESC,request_id DESC LIMIT ? OFFSET ?) SELECT json_object('request_id',p.request_id,'group_id',p.group_id,'created_at',p.created_at,'group_name',CASE WHEN json_type(g.data,'$.name')='text' THEN substr(json_extract(g.data,'$.name'),1,240) ELSE NULL END) FROM page p LEFT JOIN records g ON g.kind='group' AND g.id=p.group_id ORDER BY p.created_at DESC,p.request_id DESC";

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    page: Option<u64>,
    page_size: Option<u64>,
}

async fn result(db: &mut SqliteConnection, id: &str, key: &str) -> Result<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM records WHERE kind='group' AND id=?")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let mut group = groups::normalized(db::parse(&raw.ok_or_else(|| {
        ApiError::conflict(
            "The original group is unavailable; this request ID cannot create another group",
        )
    })?)?)?;
    // This correlation field is response-only, never durable group metadata.
    group["request_id"] = json!(key);
    Ok(group)
}
pub async fn create(db: &mut SqliteConnection, request: &Value, actor: &str) -> Result<Value> {
    let key = crate::deployment_requests::request_id(request)?;
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Group request must be an object"))?
        .remove("request_id");
    let digest = db::hash(format!(
        "vectory-group-create-v1\n{}",
        crate::deployment_requests::canonical(&payload)
    ));
    if let Some(key) = &key {
        let prior: Option<(String, String)> = sqlx::query_as(
            "SELECT payload_sha256,group_id FROM group_requests WHERE actor_id=? AND request_id=?",
        )
        .bind(actor)
        .bind(key)
        .fetch_optional(&mut *db)
        .await?;
        if let Some((prior_digest, id)) = prior {
            if prior_digest != digest {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "This request ID already belongs to a different group request; recover the original result before starting another operation",
                ));
            }
            // Membership may now be edited, retired or invalid for new creation.
            // Recover the current original result without validation or writes.
            return result(db, &id, key).await;
        }
    }
    let mut group = api::group(db, &payload, None).await?;
    db::insert(db, "group", &group).await?;
    rollout::reconcile_membership(db).await?;
    db::audit(
        db,
        actor,
        "group.create",
        group["id"].as_str().unwrap(),
        "success",
    )
    .await?;
    if let Some(key) = key {
        sqlx::query("INSERT INTO group_requests(actor_id,request_id,payload_sha256,group_id,created_at) VALUES(?,?,?,?,?)").bind(actor).bind(&key).bind(digest).bind(group["id"].as_str().unwrap()).bind(db::now()).execute(db).await?;
        group["request_id"] = json!(key);
    }
    Ok(group)
}
pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let key = crate::deployment_requests::parse_id(&id)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let id: Option<String> =
        sqlx::query_scalar("SELECT group_id FROM group_requests WHERE actor_id=? AND request_id=?")
            .bind(actor["id"].as_str().unwrap())
            .bind(&key)
            .fetch_optional(&mut *tx)
            .await?;
    Ok(Json(match id {
        None => json!({"request_id":key,"found":false}),
        Some(id) => json!({"request_id":key,"found":true,"group":result(&mut tx,&id,&key).await?}),
    }))
}
pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (_, page, size, offset) =
        crate::deployment_history::bounds(None, input.page, input.page_size)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let actor = actor["id"].as_str().unwrap();
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM group_requests WHERE actor_id=?")
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
    // Materialize only registry metadata for the requested page before joining
    // names; no request payload, member arrays or arbitrary extensions leave SQL.
    let rows: Vec<String> = sqlx::query_scalar(HISTORY_SQL)
        .bind(actor)
        .bind(size)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|r| db::parse(r))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    #[tokio::test]
    async fn history_pages_registry_before_indexed_name_join() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {HISTORY_SQL}"))
            .bind("actor")
            .bind(12)
            .bind(24)
            .fetch_all(&pool)
            .await
            .unwrap();
        let plan = rows
            .iter()
            .map(|r| r.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(plan.contains("group_requests_recent"), "{plan}");
        assert!(plan.contains("MATERIALIZE page"), "{plan}");
        assert!(
            plan.contains("SEARCH g USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)"),
            "{plan}"
        );
        assert!(!HISTORY_SQL.contains("payload_sha256"));
        assert!(!HISTORY_SQL.contains("device_ids"));
    }
}
