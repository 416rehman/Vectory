//! Durable creation identities shared by create and duplicate. Call execute
//! under the caller's writer transaction, after live authorization and CSRF.
use crate::{
    State, api, auth, db,
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

const HISTORY_SQL: &str = "WITH page AS MATERIALIZED (SELECT request_id,operation,source_configuration_id,source_revision,configuration_id,created_at FROM pipeline_requests WHERE actor_id=? ORDER BY created_at DESC,request_id DESC LIMIT ? OFFSET ?) SELECT json_object('request_id',p.request_id,'operation',p.operation,'source_configuration_id',p.source_configuration_id,'source_revision',p.source_revision,'configuration_id',p.configuration_id,'configuration_name',CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) ELSE NULL END,'created_at',p.created_at) FROM page p LEFT JOIN records c ON c.kind='configuration' AND c.id=p.configuration_id ORDER BY p.created_at DESC,p.request_id DESC";

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    page: Option<u64>,
    page_size: Option<u64>,
}

async fn result(conn: &mut SqliteConnection, id: &str, key: &str) -> Result<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM records WHERE kind='configuration' AND id=?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    let mut configuration = db::normalize_variables("configuration",db::parse(&raw.ok_or_else(|| {
        ApiError::conflict(
            "The original pipeline is unavailable; this request ID cannot create another pipeline",
        )
    })?)?);
    // Current result state is recovered; original supplied metadata/config must
    // never overwrite subsequent edits. This correlation field is response-only.
    configuration["request_id"] = json!(key);
    Ok(configuration)
}

pub async fn execute(
    conn: &mut SqliteConnection,
    source: Option<&str>,
    request: &Value,
    actor: &Value,
) -> Result<Value> {
    let key = crate::deployment_requests::request_id(request)?;
    let operation = if source.is_some() {
        "duplicate"
    } else {
        "create"
    };
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Pipeline request must be an object"))?
        .remove("request_id");
    let digest = db::hash(format!(
        "vectory-pipeline-request-v1\n{}",
        crate::deployment_requests::canonical(&payload)
    ));
    let actor_id = api::text(actor, "id");
    if let Some(key) = &key {
        let prior:Option<(String,Option<String>,String,String)>=sqlx::query_as("SELECT operation,source_configuration_id,payload_sha256,configuration_id FROM pipeline_requests WHERE actor_id=? AND request_id=?").bind(actor_id).bind(key).fetch_optional(&mut *conn).await?;
        if let Some((prior_operation, prior_source, prior_digest, id)) = prior {
            if prior_operation != operation
                || prior_source.as_deref() != source
                || prior_digest != digest
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "This request ID already belongs to a different pipeline request; recover the original result before starting another operation",
                ));
            }
            // Before source lookup/revision validation: the source may now be
            // edited, archived or unavailable, and the clone may have changed.
            return result(conn, &id, key).await;
        }
        if source.is_some()
            && payload["revision"]
                .as_u64()
                .is_none_or(|v| !(1..=9_007_199_254_740_991).contains(&v))
        {
            return Err(ApiError::invalid(
                "revision must be a positive safe integer",
            ));
        }
    }
    let mut configuration = if let Some(source) = source {
        crate::pipelines::action(conn, source, "duplicate", &payload, actor).await?
    } else {
        let name = db::string(&payload, "name", 120)?;
        api::validate_draft(&payload)?;
        let variables = crate::variables::declarations(
            &payload["config"],
            payload.get("variables").unwrap_or(&json!([])),
        )?;
        let record = json!({"id":db::id(),"name":name,"description":api::description(&payload)?,"revision":1,"graph":payload["graph"],"config":payload["config"],"variables":variables,"archived":false,"archived_at":null,"created_at":db::now(),"updated_at":db::now()});
        db::insert(conn, "configuration", &record).await?;
        api::revision(conn, &record, actor, "Initial draft", None).await?;
        db::audit(
            conn,
            actor_id,
            "configuration.create",
            api::text(&record, "id"),
            "success",
        )
        .await?;
        record
    };
    if let Some(key) = key {
        let source_revision = source.and_then(|_| payload["revision"].as_i64());
        sqlx::query("INSERT INTO pipeline_requests(actor_id,request_id,operation,source_configuration_id,source_revision,payload_sha256,configuration_id,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(actor_id).bind(&key).bind(operation).bind(source).bind(source_revision).bind(digest).bind(api::text(&configuration,"id")).bind(db::now()).execute(conn).await?;
        configuration["request_id"] = json!(key);
    }
    Ok(configuration)
}

pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["editor"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let key = crate::deployment_requests::parse_id(&id)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["editor"], false).await?;
    let prior:Option<(String,Option<String>,Option<i64>,String)>=sqlx::query_as("SELECT operation,source_configuration_id,source_revision,configuration_id FROM pipeline_requests WHERE actor_id=? AND request_id=?").bind(api::text(&actor,"id")).bind(&key).fetch_optional(&mut *tx).await?;
    Ok(Json(match prior {
        None => json!({"request_id":key,"found":false}),
        Some((operation, source, revision, id)) => {
            json!({"request_id":key,"found":true,"operation":operation,"source_configuration_id":source,"source_revision":revision,"configuration":result(&mut tx,&id,&key).await?})
        }
    }))
}

pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["editor"], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (_, page, size, offset) =
        crate::deployment_history::bounds(None, input.page, input.page_size)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["editor"], false).await?;
    let actor = api::text(&actor, "id");
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM pipeline_requests WHERE actor_id=?")
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = sqlx::query_scalar(HISTORY_SQL)
        .bind(actor)
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
    async fn history_materializes_indexed_registry_page_before_current_name_join() {
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
        assert!(plan.contains("MATERIALIZE page"), "{plan}");
        assert!(plan.contains("pipeline_requests_recent"), "{plan}");
        assert!(
            plan.contains("SEARCH c USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)"),
            "{plan}"
        );
        assert!(!HISTORY_SQL.contains("payload_sha256"));
        assert!(!HISTORY_SQL.contains("$.config"));
        assert!(!HISTORY_SQL.contains("$.graph"));
    }
}
