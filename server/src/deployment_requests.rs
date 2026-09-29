//! Durable actor-scoped deployment operation keys. Call create/rollback inside
//! the same serialized transaction as live authorization, rollout writes, and audits.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite, SqliteConnection};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    operation: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}

fn history_filter(q: &mut QueryBuilder<'_, Sqlite>, actor: &str, operation: &str) {
    q.push(" WHERE r.actor_id=").push_bind(actor.to_owned());
    if operation != "all" {
        q.push(" AND r.operation_kind=")
            .push_bind(operation.to_owned());
    }
}
fn history_count(actor: &str, operation: &str) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("SELECT count(*) FROM deployment_requests r");
    history_filter(&mut q, actor, operation);
    q
}
fn history_page(
    actor: &str,
    operation: &str,
    size: i64,
    offset: i64,
) -> QueryBuilder<'static, Sqlite> {
    // Page fixed-size registry metadata before reading even the selected result's
    // JSON. No payload digest, original request, selector, artifact, or targets
    // leave SQLite; immutable version ownership supplies pipeline recognition.
    let mut q = QueryBuilder::new(
        "WITH page AS MATERIALIZED (SELECT r.request_id,r.operation_kind,r.source_deployment_id,r.deployment_id,r.created_at FROM deployment_requests r",
    );
    history_filter(&mut q, actor, operation);
    q.push(" ORDER BY r.created_at DESC,r.request_id DESC LIMIT ").push_bind(size)
        .push(" OFFSET ").push_bind(offset).push(") SELECT json_object(\
        'request_id',p.request_id,'operation',p.operation_kind,'source_deployment_id',p.source_deployment_id,\
        'deployment_id',p.deployment_id,'created_at',p.created_at,\
        'deployment_name',CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) ELSE NULL END,\
        'deployment_status',CASE WHEN json_type(d.data,'$.status')='text' THEN substr(json_extract(d.data,'$.status'),1,64) ELSE NULL END,\
        'configuration_name',CASE WHEN json_type(d.data,'$.policy')!='object' OR json_type(d.data,'$.policy') IS NULL THEN CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) ELSE NULL END ELSE NULL END,\
        'version_number',CASE WHEN (json_type(d.data,'$.policy')!='object' OR json_type(d.data,'$.policy') IS NULL) AND json_type(v.data,'$.number')='integer' AND json_extract(v.data,'$.number') BETWEEN 1 AND 9007199254740991 THEN json_extract(v.data,'$.number') ELSE NULL END,\
        'resource',CASE WHEN json_type(d.data,'$.policy')='object' THEN 'policy' ELSE 'configuration' END,\
        'scheduled_at',CASE WHEN json_type(d.data,'$.scheduled_at')='text' AND length(json_extract(d.data,'$.scheduled_at'))<=64 THEN json_extract(d.data,'$.scheduled_at') ELSE NULL END) \
        FROM page p LEFT JOIN records d ON d.kind='deployment' AND d.id=p.deployment_id \
        LEFT JOIN records v ON v.kind='version' AND json_type(d.data,'$.version_id')='text' AND v.id=json_extract(d.data,'$.version_id') \
        LEFT JOIN records c ON c.kind='configuration' AND json_type(v.data,'$.configuration_id')='text' AND c.id=json_extract(v.data,'$.configuration_id') \
        ORDER BY p.created_at DESC,p.request_id DESC");
    q
}

/// Discover only committed identities belonging to the current account. A
/// missing row is not evidence that an in-flight request failed; there is no
/// reviewed request payload here with which to reconstruct a safe replay.
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
    let operation = input.operation.as_deref().unwrap_or("all");
    if !matches!(operation, "all" | "create" | "rollback") {
        return Err(ApiError::invalid(
            "operation must be all, create, or rollback",
        ));
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let actor = actor["id"].as_str().unwrap();
    let total: i64 = history_count(actor, operation)
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = history_page(actor, operation, size, offset)
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let mut item = db::parse(&row)?;
        // Malformed legacy date strings must not become a broken date control
        // or leak arbitrary imported text. Valid metadata is at most 64 chars.
        if item["scheduled_at"]
            .as_str()
            .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
        {
            item["scheduled_at"] = Value::Null;
        }
        items.push(item);
    }
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

pub(crate) fn parse_id(value: &str) -> Result<String> {
    let id = uuid::Uuid::parse_str(value)
        .map_err(|_| ApiError::invalid("request_id must be a hyphenated UUID"))?;
    let normalized = id.hyphenated().to_string();
    if !normalized.eq_ignore_ascii_case(value) {
        return Err(ApiError::invalid("request_id must be a hyphenated UUID"));
    }
    Ok(normalized)
}

pub(crate) fn request_id(value: &Value) -> Result<Option<String>> {
    value
        .get("request_id")
        .map(|id| {
            parse_id(
                id.as_str()
                    .ok_or_else(|| ApiError::invalid("request_id must be a UUID string"))?,
            )
        })
        .transpose()
}

pub(crate) fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let ordered: std::collections::BTreeMap<_, _> = object
                .iter()
                .map(|(key, value)| (key.clone(), canonical(value)))
                .collect();
            Value::Object(ordered.into_iter().collect())
        }
        Value::Array(array) => Value::Array(array.iter().map(canonical).collect()),
        scalar => scalar.clone(),
    }
}

fn payload(request: &Value) -> Result<Value> {
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Deployment request must be an object"))?
        .remove("request_id");
    Ok(payload)
}
fn digest(operation: &str, payload: &Value) -> String {
    // Canonical JSON object order is insignificant. Arrays, null versus omission,
    // and all supplied fields remain significant to avoid silently changing scope.
    db::hash(format!(
        "vectory-deployment-{operation}-v1\n{}",
        canonical(payload)
    ))
}
fn correlate(mut deployment: Value, key: &str, operation: &str, source: Option<&str>) -> Value {
    // The durable mapping, never caller extensions or mutable rollout fields,
    // is the authority for correlation. These fields are response-only.
    deployment["request_id"] = json!(key);
    deployment["operation"] = json!(operation);
    deployment["source_deployment_id"] = json!(source);
    deployment
}
async fn receipt(
    db: &mut SqliteConnection,
    id: &str,
    key: &str,
    operation: &str,
    source: Option<&str>,
) -> Result<Value> {
    let deployment = rollout::deployment(db, id).await.map_err(|error| {
        if error.status == StatusCode::NOT_FOUND {
            ApiError::conflict(
                "The original deployment is unavailable; this request ID cannot create another deployment",
            )
        } else {
            error
        }
    })?;
    Ok(correlate(deployment, key, operation, source))
}
async fn replay(
    db: &mut SqliteConnection,
    actor: &str,
    request_id: &str,
    digest: &str,
    operation: &str,
    source: Option<&str>,
) -> Result<Option<Value>> {
    let prior: Option<(String,String,String,Option<String>)> = sqlx::query_as("SELECT payload_sha256,deployment_id,operation_kind,source_deployment_id FROM deployment_requests WHERE actor_id=? AND request_id=?")
        .bind(actor).bind(&request_id).fetch_optional(&mut *db).await?;
    if let Some((prior_digest, id, prior_operation, prior_source)) = prior {
        if digest != prior_digest
            || operation != prior_operation
            || source != prior_source.as_deref()
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "This request ID already belongs to a different deployment request; recover the original result before starting another operation",
            ));
        }
        // Resolve before validating a now-past schedule, current membership, or
        // rollout overlap. Replaying must never create or apply the request again.
        return Ok(Some(
            receipt(
                db,
                &id,
                request_id,
                &prior_operation,
                prior_source.as_deref(),
            )
            .await?,
        ));
    }
    Ok(None)
}
async fn remember(
    db: &mut SqliteConnection,
    actor: &str,
    request_id: &str,
    digest: &str,
    operation: &str,
    source: Option<&str>,
    deployment: &Value,
) -> Result<()> {
    sqlx::query("INSERT INTO deployment_requests(actor_id,request_id,payload_sha256,deployment_id,created_at,operation_kind,source_deployment_id) VALUES(?,?,?,?,?,?,?)")
        .bind(actor).bind(request_id).bind(digest).bind(deployment["id"].as_str().unwrap()).bind(db::now()).bind(operation).bind(source).execute(&mut *db).await?;
    Ok(())
}
pub async fn create(db: &mut SqliteConnection, request: &Value, actor: &str) -> Result<Value> {
    let Some(request_id) = request_id(request)? else {
        return rollout::create(db, request, actor).await;
    };
    let payload = payload(request)?;
    let digest = digest("create", &payload);
    if let Some(deployment) = replay(db, actor, &request_id, &digest, "create", None).await? {
        return Ok(deployment);
    }
    let deployment = rollout::create(db, &payload, actor).await?;
    remember(db, actor, &request_id, &digest, "create", None, &deployment).await?;
    Ok(correlate(deployment, &request_id, "create", None))
}
pub async fn rollback(
    db: &mut SqliteConnection,
    source: &str,
    request: &Value,
    actor: &str,
) -> Result<Value> {
    let object = request
        .as_object()
        .ok_or_else(|| ApiError::invalid("Rollback request must be an object"))?;
    if object
        .keys()
        .any(|key| key != "request_id" && key != "review_token")
    {
        return Err(ApiError::invalid("Unknown rollback request field"));
    }
    let review = crate::rollback_review::token(request)?;
    let Some(request_id) = request_id(request)? else {
        return crate::rollback_review::commit(db, source, review, actor).await;
    };
    let payload = payload(request)?;
    let digest = digest("rollback", &payload);
    if let Some(deployment) =
        replay(db, actor, &request_id, &digest, "rollback", Some(source)).await?
    {
        return Ok(deployment);
    }
    let deployment = crate::rollback_review::commit(db, source, review, actor).await?;
    remember(
        db,
        actor,
        &request_id,
        &digest,
        "rollback",
        Some(source),
        &deployment,
    )
    .await?;
    Ok(correlate(deployment, &request_id, "rollback", Some(source)))
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
    let id = parse_id(&id)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let mapping: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT deployment_id,operation_kind,source_deployment_id FROM deployment_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor["id"].as_str().unwrap())
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let response = match mapping {
        Some((deployment, operation, source)) => {
            json!({"request_id":id,"found":true,"operation":operation,"source_deployment_id":source,"deployment":receipt(&mut tx,&deployment,&id,&operation,source.as_deref()).await?})
        }
        None => json!({"request_id":id,"found":false}),
    };
    Ok(Json(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{
        Row,
        sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    };

    #[tokio::test]
    async fn history_uses_actor_order_indexes_and_bounds_metadata_joins() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (operation, index) in [
            ("all", "deployment_requests_recent"),
            ("create", "deployment_requests_operation_recent"),
            ("rollback", "deployment_requests_operation_recent"),
        ] {
            let q = history_page("actor", operation, 12, 24);
            let sql = format!("EXPLAIN QUERY PLAN {}", q.sql());
            let mut explain = sqlx::query(&sql).bind("actor");
            if operation != "all" {
                explain = explain.bind(operation);
            }
            let plan = explain.bind(12).bind(24).fetch_all(&pool).await.unwrap();
            let detail = plan
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(detail.contains(index), "{operation}: {detail}");
            assert!(detail.contains("MATERIALIZE page"), "{detail}");
            assert!(!detail.contains("SCAN r"), "{detail}");
            for name in ["d", "v", "c"] {
                assert!(
                    detail.contains(&format!(
                        "SEARCH {name} USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)"
                    )),
                    "{detail}"
                );
            }
            assert!(!q.sql().contains("deployment_targets"));
            assert!(!q.sql().contains("payload_sha256"));
            let q = history_count("actor", operation);
            let sql = format!("EXPLAIN QUERY PLAN {}", q.sql());
            let mut explain = sqlx::query(&sql).bind("actor");
            if operation != "all" {
                explain = explain.bind(operation);
            }
            let count = explain
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(count.contains("SEARCH r USING COVERING INDEX"), "{count}");
            if operation != "all" {
                assert!(count.contains("actor_id=? AND operation_kind=?"), "{count}");
            }
            if std::env::var_os("VECTORY_REQUEST_FIXTURES").is_some() {
                println!(
                    "VECTORY_REQUEST_PLAN {}",
                    json!({"operation":operation,"page":detail,"count":count})
                );
            }
        }
    }

    #[tokio::test]
    async fn history_count_page_and_names_share_one_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(temp.path().join("history.db"))
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO records VALUES('deployment','one','{\"name\":\"Before\",\"status\":\"active\"}','2026-01-01T00:00:00Z')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO deployment_requests(actor_id,request_id,payload_sha256,deployment_id,created_at) VALUES('actor',?,?,'one','2026-01-01T00:00:00Z')").bind("00000000-0000-4000-8000-000000000001").bind("0".repeat(64)).execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        let total: i64 = history_count("actor", "all")
            .build_query_scalar()
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE records SET data='{\"name\":\"After\",\"status\":\"failed\"}' WHERE id='one'",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO records VALUES('deployment','two','{}','2026-01-02T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deployment_requests(actor_id,request_id,payload_sha256,deployment_id,created_at) VALUES('actor',?,?,'two','2026-01-02T00:00:00Z')").bind("00000000-0000-4000-8000-000000000002").bind("0".repeat(64)).execute(&pool).await.unwrap();
        let rows: Vec<String> = history_page("actor", "all", 12, 0)
            .build_query_scalar()
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows.len(), 1);
        let row = db::parse(&rows[0]).unwrap();
        assert_eq!(row["deployment_name"], "Before");
        assert_eq!(row["deployment_status"], "active");
        tx.rollback().await.unwrap();
        assert_eq!(
            history_count("actor", "all")
                .build_query_scalar::<i64>()
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
    }
}
