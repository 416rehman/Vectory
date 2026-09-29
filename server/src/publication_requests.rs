//! Immutable publication recovery. Validation remains outside the writer lock;
//! replay is checked before validation and again in the final commit transaction.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    configuration_id: String,
    page: Option<u64>,
    page_size: Option<u64>,
}
const HISTORY_SQL: &str = "SELECT json_object('request_id',request_id,'configuration_id',configuration_id,'version_id',version_id,'number',number,'source_revision',source_revision,'created_at',created_at) FROM publication_requests WHERE actor_id=? AND configuration_id=? ORDER BY created_at DESC,request_id DESC LIMIT ? OFFSET ?";

fn payload_digest(request: &Value) -> Result<String> {
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Publish request must be an object"))?
        .remove("request_id");
    Ok(db::hash(format!(
        "vectory-publication-v1\n{}",
        crate::deployment_requests::canonical(&payload)
    )))
}
fn validate_new(request: &Value) -> Result<()> {
    if request["revision"]
        .as_u64()
        .is_none_or(|v| !(1..=9_007_199_254_740_991).contains(&v))
    {
        return Err(ApiError::invalid(
            "revision must be a positive safe integer",
        ));
    }
    if let Some(message) = request.get("message") {
        if message.as_str().is_none_or(|v| v.len() > 2000) {
            return Err(ApiError::invalid(
                "message must be text of at most 2000 UTF-8 bytes",
            ));
        }
    }
    Ok(())
}
async fn receipt(db: &mut SqliteConnection, id: &str, key: &str) -> Result<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM records WHERE kind='version' AND id=?")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let mut version=db::normalize_variables("version",db::parse(&raw.ok_or_else(||ApiError::conflict("The original published version is unavailable; this request ID cannot publish another version"))?)?);
    version["request_id"] = json!(key);
    Ok(version)
}
pub async fn replay(
    db: &mut SqliteConnection,
    actor: &str,
    configuration: &str,
    request: &Value,
) -> Result<Option<Value>> {
    let Some(key) = crate::deployment_requests::request_id(request)? else {
        return Ok(None);
    };
    let digest = payload_digest(request)?;
    let prior:Option<(String,String,String)>=sqlx::query_as("SELECT configuration_id,payload_sha256,version_id FROM publication_requests WHERE actor_id=? AND request_id=?").bind(actor).bind(&key).fetch_optional(&mut *db).await?;
    if let Some((prior_configuration, prior_digest, id)) = prior {
        if prior_configuration != configuration || prior_digest != digest {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "This request ID already belongs to a different publication; recover the original version before starting another request",
            ));
        }
        return Ok(Some(receipt(db, &id, &key).await?));
    }
    Ok(None)
}
pub async fn before_validation(
    s: &State,
    h: &HeaderMap,
    configuration: &str,
    request: &Value,
) -> Result<Option<Value>> {
    if crate::deployment_requests::request_id(request)?.is_none() {
        return Ok(None);
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, h, &["operator"], true).await?;
    if let Some(version) = replay(
        &mut tx,
        actor["id"].as_str().unwrap(),
        configuration,
        request,
    )
    .await?
    {
        return Ok(Some(version));
    }
    validate_new(request)?;
    Ok(None)
}
pub async fn remember(
    db: &mut SqliteConnection,
    actor: &str,
    configuration: &str,
    request: &Value,
    version: &mut Value,
) -> Result<()> {
    let Some(key) = crate::deployment_requests::request_id(request)? else {
        return Ok(());
    };
    sqlx::query("INSERT INTO publication_requests(actor_id,request_id,configuration_id,payload_sha256,version_id,number,source_revision,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(actor).bind(&key).bind(configuration).bind(payload_digest(request)?).bind(version["id"].as_str().unwrap()).bind(version["number"].as_i64()).bind(version["source_revision"].as_i64()).bind(db::now()).execute(db).await?;
    version["request_id"] = json!(key);
    Ok(())
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
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let id: Option<String> = sqlx::query_scalar(
        "SELECT version_id FROM publication_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor["id"].as_str().unwrap())
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?;
    Ok(Json(match id {
        None => json!({"request_id":key,"found":false}),
        Some(id) => {
            json!({"request_id":key,"found":true,"version":receipt(&mut tx,&id,&key).await?})
        }
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
    let configuration = crate::deployment_requests::parse_id(&input.configuration_id)
        .map_err(|_| ApiError::invalid("configuration_id must be a hyphenated UUID"))?;
    let (_, page, size, offset) =
        crate::deployment_history::bounds(None, input.page, input.page_size)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let actor = actor["id"].as_str().unwrap();
    let total: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM publication_requests WHERE actor_id=? AND configuration_id=?",
    )
    .bind(actor)
    .bind(&configuration)
    .fetch_one(&mut *tx)
    .await?;
    // Immutable result metadata was stored atomically at publication. Discovery
    // needs neither raw configuration bodies nor an unbounded history/name map.
    let rows: Vec<String> = sqlx::query_scalar(HISTORY_SQL)
        .bind(actor)
        .bind(configuration)
        .bind(size)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|v| db::parse(v))
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
    async fn discovery_uses_actor_configuration_index_without_record_payloads() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {HISTORY_SQL}"))
            .bind("actor")
            .bind("configuration")
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
        assert!(
            plan.contains("publication_requests_recent (actor_id=? AND configuration_id=?)"),
            "{plan}"
        );
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
        assert!(!HISTORY_SQL.contains("records"));
        assert!(!HISTORY_SQL.contains("payload_sha256"));
    }
}
