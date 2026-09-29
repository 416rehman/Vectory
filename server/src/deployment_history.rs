//! Read-only, bounded deployment projections. Raw records never cross the SQL
//! boundary; target progress is reported from persisted states, not inferred.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    search: Option<String>,
    status: Option<String>,
    scheduled: Option<bool>,
    page: Option<u64>,
    page_size: Option<u64>,
    sort: Option<String>,
    direction: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetsQuery {
    search: Option<String>,
    state: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
    sort: Option<String>,
    direction: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyQuery {}

pub(crate) fn bounds(
    search: Option<&str>,
    page: Option<u64>,
    size: Option<u64>,
) -> Result<(&str, u64, i64, i64)> {
    let search = search.unwrap_or("").trim();
    if search.chars().count() > 200 {
        return Err(ApiError::invalid("Search must be at most 200 characters"));
    }
    let page = page.unwrap_or(1);
    let size = size.unwrap_or(12);
    if !(1..=9_007_199_254_740_991).contains(&page) || !(1..=50).contains(&size) {
        return Err(ApiError::invalid(
            "page must be a positive safe integer and page_size must be 1..50",
        ));
    }
    let offset = (page - 1)
        .checked_mul(size)
        .and_then(|n| i64::try_from(n).ok())
        .ok_or_else(|| ApiError::invalid("page is too large"))?;
    Ok((search, page, size as i64, offset))
}

// serde's form decoder is deliberately lenient about malformed percent escapes
// and UTF-8. Reject these before interpreting a query, without echoing its text.
pub(crate) fn query<T>(
    raw: Option<&str>,
    parsed: std::result::Result<Query<T>, QueryRejection>,
) -> Result<T> {
    let input = raw.unwrap_or("").as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' {
            let high = input.get(i + 1).and_then(|b| (*b as char).to_digit(16));
            let low = input.get(i + 2).and_then(|b| (*b as char).to_digit(16));
            match (high, low) {
                (Some(high), Some(low)) => decoded.push((high * 16 + low) as u8),
                _ => return Err(ApiError::invalid("Invalid query parameters")),
            }
            i += 3;
        } else {
            decoded.push(input[i]);
            i += 1;
        }
    }
    std::str::from_utf8(&decoded).map_err(|_| ApiError::invalid("Invalid query parameters"))?;
    parsed
        .map(|Query(value)| value)
        .map_err(|_| ApiError::invalid("Invalid query parameters"))
}

const JOINS: &str = " LEFT JOIN records v ON v.kind='version' AND v.id=json_extract(d.data,'$.version_id') LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')";
const SCHEDULED: &str = "(json_extract(d.data,'$.scheduled_at') IS NOT NULL)";
const ORDER: &str = "d.created_at DESC,d.id ASC";
const NAME: &str = "COALESCE(NULLIF(CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) END,''),CASE WHEN json_type(d.data,'$.policy')='object' THEN 'Agent settings' ELSE COALESCE(NULLIF(json_extract(c.data,'$.name'),''),'Pipeline deployment') END)";
const STATUS_LABEL: &str = "CASE json_extract(d.data,'$.status') WHEN 'active' THEN 'In progress' WHEN 'completed' THEN 'Complete' WHEN 'failed' THEN 'Needs attention' WHEN 'unassigned' THEN 'Removed' WHEN 'missed' THEN 'Schedule missed' ELSE json_extract(d.data,'$.status') END";
const VERIFIED: &str = "(SELECT count(*) FROM deployment_targets st WHERE st.deployment_id=d.id AND st.state='verified_applied')";

fn direction(value: Option<&str>, default: &'static str) -> Result<&'static str> {
    match value.unwrap_or(default) {
        "asc" => Ok("ASC"),
        "desc" => Ok("DESC"),
        _ => Err(ApiError::invalid("Invalid sort direction")),
    }
}
fn history_order(sort: Option<&str>, order: Option<&str>) -> Result<String> {
    let direction = direction(order, "desc")?;
    let expression = match sort.unwrap_or("created_at") {
        "name" => format!("{NAME} COLLATE NOCASE"),
        "status" => format!("{STATUS_LABEL} COLLATE NOCASE"),
        "verified" => VERIFIED.to_owned(),
        "created_at" => "d.created_at".to_owned(),
        "scheduled_at" => "json_extract(d.data,'$.scheduled_at')".to_owned(),
        _ => return Err(ApiError::invalid("Invalid deployment sort")),
    };
    let secondary = if sort == Some("verified") {
        format!(
            ",(SELECT count(*) FROM deployment_targets st WHERE st.deployment_id=d.id) {direction}"
        )
    } else {
        String::new()
    };
    Ok(format!(
        "{expression} {direction} NULLS LAST{secondary},d.id ASC"
    ))
}
fn target_order(sort: Option<&str>, order: Option<&str>, terminal: bool) -> Result<String> {
    let direction = direction(order, "asc")?;
    let expression = match sort.unwrap_or("device_name") {
        "device_name" => "COALESCE(NULLIF(d.name,''),t.device_id) COLLATE NOCASE".to_owned(),
        "state" => {
            let pending = if terminal { "Not released" } else { "Waiting" };
            format!(
                "CASE t.state WHEN 'verified_applied' THEN 'Applied and verified' WHEN 'desired' THEN 'Waiting for agent' WHEN 'pending' THEN '{pending}' WHEN 'written' THEN 'Applying' WHEN 'reload_requested' THEN 'Restarting Vector' WHEN 'verification_unknown' THEN 'Verification needed' WHEN 'rolled_back' THEN 'Rolled back' WHEN 'removed' THEN 'No longer targeted' ELSE replace(t.state,'_',' ') END COLLATE NOCASE"
            )
        }
        "generation" => "t.generation".to_owned(),
        _ => return Err(ApiError::invalid("Invalid target sort")),
    };
    Ok(format!(
        "{expression} {direction} NULLS LAST,t.device_id ASC"
    ))
}

fn history_filter(
    q: &mut QueryBuilder<'_, Sqlite>,
    status: &str,
    scheduled: Option<bool>,
    search: &str,
) {
    q.push(" WHERE d.kind='deployment'");
    if status != "all" {
        q.push(" AND json_extract(d.data,'$.status')=")
            .push_bind(status.to_owned());
    }
    if let Some(scheduled) = scheduled {
        q.push(" AND ")
            .push(SCHEDULED)
            .push(if scheduled { "=1" } else { "=0" });
    }
    if !search.is_empty() {
        q.push(" AND instr(lower(CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) ELSE '' END||' '||COALESCE(json_extract(c.data,'$.name'),'')||' '||COALESCE(json_extract(d.data,'$.status'),'')||' '||CASE json_extract(d.data,'$.status') WHEN 'active' THEN 'In progress' WHEN 'completed' THEN 'Complete' WHEN 'failed' THEN 'Needs attention' WHEN 'unassigned' THEN 'Removed' WHEN 'missed' THEN 'Schedule missed' ELSE '' END||' '||CASE WHEN v.id IS NOT NULL THEN 'Version '||COALESCE(json_extract(v.data,'$.number'),'') ELSE '' END||' '||CASE WHEN json_type(d.data,'$.policy')='object' THEN 'Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat, '||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN 'Sync paused' ELSE 'Sync enabled' END||' Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat '||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN 'Sync paused' ELSE 'Sync enabled' END||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN ' Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat, Pause sync' ELSE '' END ELSE '' END),lower(")
            .push_bind(search.to_owned()).push("))>0");
    }
}
fn count_query(
    status: &str,
    scheduled: Option<bool>,
    search: &str,
) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("SELECT count(*) FROM records d");
    if !search.is_empty() {
        q.push(JOINS);
    }
    history_filter(&mut q, status, scheduled, search);
    q
}

fn projection(q: &mut QueryBuilder<'_, Sqlite>, order: &str) {
    // CROSS JOIN pins the bounded page as the outer loop, so target aggregation
    // uses (deployment_id,state) lookups instead of scanning the whole fleet.
    q.push(", counts AS MATERIALIZED (SELECT t.deployment_id,t.state,count(*) AS n FROM page p CROSS JOIN deployment_targets t ON t.deployment_id=p.id GROUP BY t.deployment_id,t.state) SELECT json_object(\
        'id',d.id,'rollback_idempotency',json('true'),'rollback_review',json('true'),'request_correlation',json('true'),'name',CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) ELSE NULL END,\
        'configuration_id',json_extract(v.data,'$.configuration_id'),'configuration_name',json_extract(c.data,'$.name'),\
        'version_id',CASE WHEN json_type(d.data,'$.version_id')='text' THEN json_extract(d.data,'$.version_id') ELSE NULL END,'version_number',json_extract(v.data,'$.number'),\
        'policy',CASE WHEN json_type(d.data,'$.policy')='object' THEN json_object('heartbeat_seconds',json_extract(d.data,'$.policy.heartbeat_seconds'),'sync_paused',json(CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN 'true' ELSE 'false' END),'telemetry_enabled',json(CASE WHEN json_extract(d.data,'$.policy.telemetry_enabled')=1 THEN 'true' ELSE 'false' END)) ELSE NULL END,\
        'priority',json_extract(d.data,'$.priority'),'target_mode',json_extract(d.data,'$.target_mode'),'status',json_extract(d.data,'$.status'),\
        'scheduled_at',json_extract(d.data,'$.scheduled_at'),'created_at',d.created_at,\
        'rollout',json_object('kind',json_extract(d.data,'$.rollout.kind'),'canary_size',json_extract(d.data,'$.rollout.canary_size'),'batch_size',json_extract(d.data,'$.rollout.batch_size'),'observation_seconds',json_extract(d.data,'$.rollout.observation_seconds'),'failure_threshold',json_extract(d.data,'$.rollout.failure_threshold')),\
        'target_count',COALESCE((SELECT sum(n) FROM counts WHERE deployment_id=d.id),0),\
        'verified_count',COALESCE((SELECT n FROM counts WHERE deployment_id=d.id AND state='verified_applied'),0),\
        'state_counts',json((SELECT json_group_object(state,n) FROM counts WHERE deployment_id=d.id))) FROM page d");
    q.push(JOINS).push(" ORDER BY ").push(order);
}
fn page_query(
    status: &str,
    scheduled: Option<bool>,
    search: &str,
    size: i64,
    offset: i64,
    order: &str,
) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new(
        "WITH page AS MATERIALIZED (SELECT d.id,d.data,d.created_at FROM records d",
    );
    // Names require the immutable version-to-pipeline join before paging.
    if !search.is_empty() || order.contains("c.data") {
        q.push(JOINS);
    }
    history_filter(&mut q, status, scheduled, search);
    q.push(" ORDER BY ")
        .push(order)
        .push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset)
        .push(")");
    projection(&mut q, order);
    q
}

pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let input = query(raw.as_deref(), parsed)?;
    let (search, page, size, offset) =
        bounds(input.search.as_deref(), input.page, input.page_size)?;
    let status = input.status.as_deref().unwrap_or("all");
    if !matches!(
        status,
        "all"
            | "scheduled"
            | "active"
            | "paused"
            | "completed"
            | "cancelled"
            | "failed"
            | "missed"
            | "unassigned"
    ) {
        return Err(ApiError::invalid("Invalid deployment status"));
    }
    let order = history_order(input.sort.as_deref(), input.direction.as_deref())?;
    let mut tx = s.pool.begin().await?;
    let total: i64 = count_query(status, input.scheduled, search)
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = page_query(status, input.scheduled, search, size, offset, &order)
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size,"request_history":true}),
    ))
}
pub async fn summary(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    query(raw.as_deref(), parsed)?;
    let mut q = QueryBuilder::new(
        "WITH page AS MATERIALIZED (SELECT id,data,created_at FROM records WHERE kind='deployment' AND id=",
    );
    q.push_bind(id.clone()).push(")");
    projection(&mut q, ORDER);
    let mut tx = s.pool.begin().await?;
    let row: Option<String> = q.build_query_scalar().fetch_optional(&mut *tx).await?;
    let mut result = db::parse(&row.ok_or_else(ApiError::missing)?)?;
    let context = crate::canary_gate::load(&mut tx, &id).await?;
    if crate::canary_gate::enabled(&context) {
        result["canary_gate"] = crate::canary_gate::evaluate(&mut tx, &context, None)
            .await?
            .projection(&context);
    }
    Ok(Json(result))
}
fn target_filter(q: &mut QueryBuilder<'_, Sqlite>, id: &str, state: &str, search: &str) {
    q.push(" WHERE t.deployment_id=").push_bind(id.to_owned());
    if state != "all" {
        q.push(" AND t.state=").push_bind(state.to_owned());
    }
    if !search.is_empty() {
        q.push(" AND (instr(lower(t.device_id),lower(")
            .push_bind(search.to_owned())
            .push("))>0 OR instr(lower(COALESCE(d.name,'')),lower(")
            .push_bind(search.to_owned())
            .push("))>0)");
    }
}
fn target_query(
    id: &str,
    state: &str,
    search: &str,
    page: Option<(i64, i64)>,
    order: &str,
) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new(if page.is_some() {
        "SELECT json_object('device_id',t.device_id,'device_name',d.name,'state',t.state,'generation',t.generation,'error',t.error,'original',json(CASE WHEN t.original=1 THEN 'true' ELSE 'false' END))"
    } else {
        "SELECT count(*)"
    });
    q.push(" FROM deployment_targets t LEFT JOIN devices d ON d.id=t.device_id");
    target_filter(&mut q, id, state, search);
    if let Some((size, offset)) = page {
        q.push(" ORDER BY ")
            .push(order)
            .push(" LIMIT ")
            .push_bind(size)
            .push(" OFFSET ")
            .push_bind(offset);
    }
    q
}
pub async fn targets(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<TargetsQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let input = query(raw.as_deref(), parsed)?;
    let (search, page, size, offset) =
        bounds(input.search.as_deref(), input.page, input.page_size)?;
    let state = input.state.as_deref().unwrap_or("all");
    if state.is_empty()
        || state.len() > 64
        || !state
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(ApiError::invalid("Invalid target state"));
    }
    let order = target_order(input.sort.as_deref(), input.direction.as_deref(), false)?;
    let mut tx = s.pool.begin().await?;
    let terminal: Option<bool> =
        sqlx::query_scalar("SELECT COALESCE(json_extract(data,'$.status') IN ('failed','cancelled','missed','unassigned'),0) FROM records WHERE kind='deployment' AND id=?")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    // Read only the parent's terminal flag, within the same snapshot as count
    // and rows. Keep global sorting aligned with the displayed pending label.
    let order = if terminal.ok_or_else(ApiError::missing)? {
        target_order(input.sort.as_deref(), input.direction.as_deref(), true)?
    } else {
        order
    };
    let total: i64 = target_query(&id, state, search, None, &order)
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = target_query(&id, state, search, Some((size, offset)), &order)
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await?;
    let mut items = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    let context = crate::canary_gate::load(&mut tx, &id).await?;
    if crate::canary_gate::enabled(&context) {
        let ids = items
            .iter()
            .filter_map(|v| v["device_id"].as_str().map(str::to_owned))
            .collect();
        let proof = crate::canary_gate::evaluate(&mut tx, &context, Some(&ids)).await?;
        for item in &mut items {
            item["gate_reason"] = serde_json::json!(
                proof
                    .target_reasons
                    .get(item["device_id"].as_str().unwrap())
                    .copied()
                    .flatten()
            );
        }
    }
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{
        Row,
        sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    };

    #[tokio::test]
    async fn query_plans_bound_projection_and_use_parent_state_indexes() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (status, scheduled, index) in [
            ("all", None, "deployment_history_recent"),
            ("active", None, "deployment_history_status"),
            ("all", Some(true), "deployment_history_scheduled"),
            ("missed", Some(true), "deployment_history_status_scheduled"),
        ] {
            let q = page_query(status, scheduled, "", 12, 0, ORDER);
            let sql = format!("EXPLAIN QUERY PLAN {}", q.sql());
            let mut explain = sqlx::query(&sql);
            if status != "all" {
                explain = explain.bind(status);
            }
            let plan = explain.bind(12).bind(0).fetch_all(&pool).await.unwrap();
            let detail = plan
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(detail.contains(index), "{status} {scheduled:?}: {detail}");
            assert!(detail.contains("MATERIALIZE page"), "{detail}");
            assert!(
                detail.contains("deployment_targets_state (deployment_id=?)"),
                "{detail}"
            );
            assert!(!detail.contains("SCAN t"), "{detail}");
            assert!(
                detail
                    .contains("SEARCH v USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)"),
                "{detail}"
            );
            let q = count_query(status, scheduled, "");
            let sql = format!("EXPLAIN QUERY PLAN {}", q.sql());
            let mut explain = sqlx::query(&sql);
            if status != "all" {
                explain = explain.bind(status);
            }
            let plan = explain.fetch_all(&pool).await.unwrap();
            let detail = plan
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(detail.contains("INDEX"), "{detail}");
            assert!(!detail.contains("SCAN d"), "{detail}");
        }
        for page in [None, Some((12, 0))] {
            let q = target_query(
                "deployment",
                "pending",
                "",
                page,
                "d.name ASC,t.device_id ASC",
            );
            let sql = format!("EXPLAIN QUERY PLAN {}", q.sql());
            let mut explain = sqlx::query(&sql).bind("deployment").bind("pending");
            if page.is_some() {
                explain = explain.bind(12).bind(0);
            }
            let plan = explain.fetch_all(&pool).await.unwrap();
            let detail = plan
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                detail.contains("deployment_targets_state (deployment_id=? AND state=?)"),
                "{detail}"
            );
            assert!(
                detail.lines().any(|line| line.contains("SEARCH d USING")
                    && line.contains("sqlite_autoindex_devices_1 (id=?)")),
                "{detail}"
            );
        }
    }

    #[tokio::test]
    async fn count_page_and_target_progress_share_a_read_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(temp.path().join("snapshot.db"))
                    .create_if_missing(true)
                    .journal_mode(SqliteJournalMode::Wal),
            )
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO records VALUES('deployment','one','{\"id\":\"one\",\"status\":\"active\"}','2026-01-01')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO devices(id,name,data) VALUES('device','Device','{}')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO deployment_targets(deployment_id,device_id) VALUES('one','device')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mut tx = pool.begin().await.unwrap();
        let total: i64 = count_query("all", None, "")
            .build_query_scalar()
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO records VALUES('deployment','two','{\"id\":\"two\",\"status\":\"active\"}','2026-01-02')").execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id='one'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let rows: Vec<String> = page_query("all", None, "", 12, 0, ORDER)
            .build_query_scalar()
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(rows.len(), 1);
        let summary = db::parse(&rows[0]).unwrap();
        assert_eq!(summary["verified_count"], 0);
        assert_eq!(summary["state_counts"], json!({"pending":1}));
        let target_total: i64 =
            target_query("one", "pending", "", None, "d.name ASC,t.device_id ASC")
                .build_query_scalar()
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let targets: Vec<String> = target_query(
            "one",
            "pending",
            "",
            Some((12, 0)),
            "d.name ASC,t.device_id ASC",
        )
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(target_total, 1);
        assert_eq!(db::parse(&targets[0]).unwrap()["state"], "pending");
        tx.rollback().await.unwrap();
        let total: i64 = count_query("all", None, "")
            .build_query_scalar()
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 2);
    }
}
