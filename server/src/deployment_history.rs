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
use sqlx::{QueryBuilder, Row, Sqlite};
use std::collections::BTreeMap;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    search: Option<String>,
    status: Option<String>,
    scheduled: Option<bool>,
    group_id: Option<String>,
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
const STATUS_LABEL: &str = "CASE WHEN json_type(d.data,'$.rolled_back_by')='text' THEN 'Rolled back' WHEN json_extract(d.data,'$.status')='unassigned' AND json_type(d.data,'$.replaced_by')='array' THEN 'Replaced' ELSE CASE json_extract(d.data,'$.status') WHEN 'active' THEN 'In progress' WHEN 'completed' THEN 'Complete' WHEN 'failed' THEN 'Failed' WHEN 'unassigned' THEN 'Removed' WHEN 'missed' THEN 'Schedule missed' ELSE json_extract(d.data,'$.status') END END";
const ROLLED_BACK: &str = "json_type(d.data,'$.rolled_back_by')='text'";
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
    group: Option<&str>,
) {
    q.push(" WHERE d.kind='deployment'");
    if status == "rolled_back" {
        // A rolled-back source keeps its stopped status; lineage decides the label.
        q.push(" AND json_extract(d.data,'$.status') IN ('cancelled','unassigned') AND ")
            .push(ROLLED_BACK);
    } else if status != "all" {
        q.push(" AND json_extract(d.data,'$.status')=")
            .push_bind(status.to_owned());
        if matches!(status, "cancelled" | "unassigned") {
            q.push(" AND NOT COALESCE(").push(ROLLED_BACK).push(",0)");
        }
    }
    if let Some(group) = group {
        q.push(
            " AND EXISTS(SELECT 1 FROM json_each(d.data,'$.selector.group_ids') g WHERE g.value=",
        )
        .push_bind(group.to_owned())
        .push(")");
    }
    if let Some(scheduled) = scheduled {
        q.push(" AND ")
            .push(SCHEDULED)
            .push(if scheduled { "=1" } else { "=0" });
    }
    if !search.is_empty() {
        q.push(" AND instr(lower(CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) ELSE '' END||' '||COALESCE(json_extract(c.data,'$.name'),'')||' '||COALESCE(json_extract(d.data,'$.status'),'')||' '||CASE json_extract(d.data,'$.status') WHEN 'active' THEN 'In progress' WHEN 'completed' THEN 'Complete' WHEN 'failed' THEN 'Needs attention Failed' WHEN 'unassigned' THEN 'Removed' WHEN 'missed' THEN 'Schedule missed' ELSE '' END||CASE WHEN json_type(d.data,'$.rolled_back_by')='text' THEN ' Rolled back' ELSE '' END||CASE WHEN json_type(d.data,'$.replaced_by')='array' THEN ' Replaced' ELSE '' END||' '||CASE WHEN v.id IS NOT NULL THEN 'Version '||COALESCE(json_extract(v.data,'$.number'),'') ELSE '' END||' '||CASE WHEN json_type(d.data,'$.policy')='object' THEN 'Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat, '||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN 'Sync paused' ELSE 'Sync enabled' END||' Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat '||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN 'Sync paused' ELSE 'Sync enabled' END||CASE WHEN json_extract(d.data,'$.policy.sync_paused')=1 THEN ' Agent settings '||COALESCE(json_extract(d.data,'$.policy.heartbeat_seconds'),'')||'s heartbeat, Pause sync' ELSE '' END ELSE '' END),lower(")
            .push_bind(search.to_owned()).push("))>0");
    }
}
fn count_query(
    status: &str,
    scheduled: Option<bool>,
    search: &str,
    group: Option<&str>,
) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("SELECT count(*) FROM records d");
    if !search.is_empty() {
        q.push(JOINS);
    }
    history_filter(&mut q, status, scheduled, search, group);
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
        'state_counts',json((SELECT json_group_object(state,n) FROM counts WHERE deployment_id=d.id)),\
        'created_by_name',(SELECT substr(u.name,1,120) FROM users u WHERE u.id=COALESCE(json_extract(d.data,'$.created_by'),(SELECT json_extract(a.data,'$.actor') FROM records a WHERE a.kind='audit' AND json_extract(a.data,'$.target')=d.id AND json_extract(a.data,'$.action') IN ('deployment.create','deployment.schedule') LIMIT 1))),\
        'policy_id',CASE WHEN json_type(d.data,'$.policy_id')='text' THEN json_extract(d.data,'$.policy_id') END,\
        'policy_name',(SELECT substr(json_extract(sp.data,'$.name'),1,120) FROM records sp WHERE sp.kind='policy' AND sp.id=json_extract(d.data,'$.policy_id')),\
        'rollback_available',json(CASE WHEN EXISTS(SELECT 1 FROM deployment_targets rt WHERE rt.deployment_id=d.id AND rt.generation>0 AND rt.state<>'removed' AND rt.previous_version_id IS NOT NULL) THEN 'true' ELSE 'false' END),\
        'completed_at',CASE WHEN json_type(d.data,'$.completed_at')='text' THEN json_extract(d.data,'$.completed_at') END,\
        'failed_at',CASE WHEN json_type(d.data,'$.failed_at')='text' THEN json_extract(d.data,'$.failed_at') END,\
        'failure_reason',CASE WHEN json_type(d.data,'$.failure_reason')='text' THEN substr(json_extract(d.data,'$.failure_reason'),1,64) END,\
        'cancelled_at',CASE WHEN json_type(d.data,'$.cancelled_at')='text' THEN json_extract(d.data,'$.cancelled_at') END,\
        'removed_at',CASE WHEN json_type(d.data,'$.removed_at')='text' THEN json_extract(d.data,'$.removed_at') END,\
        'status_before_removal',CASE WHEN json_type(d.data,'$.status_before_removal')='text' THEN substr(json_extract(d.data,'$.status_before_removal'),1,64) END,\
        'status_before_rollback',CASE WHEN json_type(d.data,'$.status_before_rollback')='text' THEN substr(json_extract(d.data,'$.status_before_rollback'),1,64) END,\
        'rolled_back_at',CASE WHEN json_type(d.data,'$.rolled_back_at')='text' THEN json_extract(d.data,'$.rolled_back_at') END,\
        'rolled_back_by',CASE WHEN json_type(d.data,'$.rolled_back_by')='text' THEN json_extract(d.data,'$.rolled_back_by') END,\
        'rolled_back_to_version',(SELECT json_extract(lv.data,'$.number') FROM records lb JOIN records lv ON lv.kind='version' AND lv.id=json_extract(lb.data,'$.version_id') WHERE lb.kind='deployment' AND lb.id=json_extract(d.data,'$.rolled_back_by')),\
        'rollback_of',CASE WHEN json_type(d.data,'$.rollback_of')='text' THEN json_extract(d.data,'$.rollback_of') END,\
        'rollback_of_version',(SELECT json_extract(lv.data,'$.number') FROM records lb JOIN records lv ON lv.kind='version' AND lv.id=json_extract(lb.data,'$.version_id') WHERE lb.kind='deployment' AND lb.id=json_extract(d.data,'$.rollback_of')),\
        'replaced_by',json(COALESCE((SELECT json_group_array(json_object('deployment_id',json_extract(e.value,'$.deployment_id'),'device_count',json_extract(e.value,'$.device_count'),'at',json_extract(e.value,'$.at'),'version_number',(SELECT json_extract(nv.data,'$.number') FROM records n JOIN records nv ON nv.kind='version' AND nv.id=json_extract(n.data,'$.version_id') WHERE n.kind='deployment' AND n.id=json_extract(e.value,'$.deployment_id')))) FROM json_each(d.data,'$.replaced_by') e WHERE json_type(d.data,'$.replaced_by')='array'),'[]')),\
        'replaces',json(COALESCE((SELECT json_group_array(json_object('deployment_id',r.value,'version_number',(SELECT json_extract(rv.data,'$.number') FROM records rd JOIN records rv ON rv.kind='version' AND rv.id=json_extract(rd.data,'$.version_id') WHERE rd.kind='deployment' AND rd.id=r.value))) FROM json_each(d.data,'$.replaces') r WHERE json_type(d.data,'$.replaces')='array'),'[]'))) FROM page d");
    q.push(JOINS).push(" ORDER BY ").push(order);
}
fn page_query(
    status: &str,
    scheduled: Option<bool>,
    search: &str,
    group: Option<&str>,
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
    history_filter(&mut q, status, scheduled, search, group);
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
            | "rolled_back"
    ) {
        return Err(ApiError::invalid("Invalid deployment status"));
    }
    let group = input
        .group_id
        .as_deref()
        .map(|id| {
            uuid::Uuid::parse_str(id)
                .ok()
                .map(|parsed| parsed.hyphenated().to_string())
                .filter(|parsed| parsed == id)
                .ok_or_else(|| ApiError::invalid("group_id must be a lowercase UUID"))
        })
        .transpose()?;
    let order = history_order(input.sort.as_deref(), input.direction.as_deref())?;
    let mut tx = s.pool.begin().await?;
    let total: i64 = count_query(status, input.scheduled, search, group.as_deref())
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = page_query(
        status,
        input.scheduled,
        search,
        group.as_deref(),
        size,
        offset,
        &order,
    )
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
        "SELECT json_object('device_id',t.device_id,'device_name',d.name,'state',t.state,'generation',t.generation,'error',t.error,'original',json(CASE WHEN t.original=1 THEN 'true' ELSE 'false' END),\
        'released_at',t.released_at,'verified_at',t.verified_at,'last_seen',CASE WHEN json_type(d.data,'$.last_seen')='text' THEN substr(json_extract(d.data,'$.last_seen'),1,64) END,\
        'replaced_by',CASE WHEN t.state='removed' THEN (SELECT json_extract(e.value,'$.deployment_id') FROM records rp,json_each(rp.data,'$.replaced_by') e JOIN deployment_targets rn ON rn.deployment_id=json_extract(e.value,'$.deployment_id') AND rn.device_id=t.device_id WHERE rp.kind='deployment' AND rp.id=t.deployment_id AND json_type(rp.data,'$.replaced_by')='array' LIMIT 1) END,\
        'next_release_at',(SELECT min(x.released_at) FROM deployment_targets x WHERE x.device_id=t.device_id AND x.deployment_id<>t.deployment_id AND x.released_at>t.released_at),\
        '_attempt',json_extract(d.data,'$.configuration_attempt'),'_terminal',json_extract(d.data,'$.terminal_configuration_attempt'),\
        '_policy',json(d.policy),'_policy_generation',d.policy_generation,\
        '_acknowledgement',json_object('policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds')))"
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
    for item in &mut items {
        finish_target(item);
    }
    timelines(&mut tx, &mut items).await?;
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

const FAILED_STATES: [&str; 6] = [
    "failed",
    "rolled_back",
    "verification_unknown",
    "incompatible",
    "blocked",
    // Applied, but a data-plane issue on this version shows it isn't
    // delivering. Lanes and failure groups only; never a stored target state.
    "degraded",
];
/// The first sanitized diagnostic the agent reported for this exact candidate.
/// Older agents and servers omit diagnostics; callers fall back to the error.
fn diagnostic(attempt: &Value, generation: &Value) -> Option<String> {
    if !attempt.is_object() || attempt["generation"] != *generation {
        return None;
    }
    let error = &attempt["error"];
    let first = error["diagnostics"]
        .as_array()
        .and_then(|list| list.first());
    let text = first
        .and_then(|item| {
            item.as_str()
                .or_else(|| item["message"].as_str())
                .or_else(|| item["summary"].as_str())
        })
        .or_else(|| error["summary"].as_str())?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(500).collect())
}
// Private join columns become public, bounded fields; nothing else leaves.
fn finish_target(item: &mut Value) {
    let object = item.as_object_mut().unwrap();
    let attempt = object.remove("_attempt").unwrap_or(Value::Null);
    let terminal = object.remove("_terminal").unwrap_or(Value::Null);
    let policy = object.remove("_policy").unwrap_or(Value::Null);
    let policy_generation = object
        .remove("_policy_generation")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let acknowledgement = object.remove("_acknowledgement").unwrap_or(Value::Null);
    let generation = object.get("generation").cloned().unwrap_or(Value::Null);
    object.insert(
        "diagnostic".into(),
        json!(diagnostic(&terminal, &generation).or_else(|| diagnostic(&attempt, &generation))),
    );
    object.insert(
        "check_in_seconds".into(),
        if policy.is_object() {
            json!(crate::rollout::check_in_seconds(
                &policy,
                &acknowledgement,
                policy_generation
            ))
        } else {
            Value::Null
        },
    );
}
/// Observed progress for each released target on this page, from the device's
/// recorded apply-state changes between its release and the next release of
/// another deployment (or verification). Heartbeats can skip states; missing
/// steps stay missing rather than being invented.
async fn timelines(db: &mut sqlx::SqliteConnection, items: &mut [Value]) -> Result<()> {
    let released: Vec<(String, String)> = items
        .iter()
        .filter_map(|item| {
            Some((
                item["device_id"].as_str()?.to_owned(),
                item["released_at"].as_str()?.to_owned(),
            ))
        })
        .collect();
    if released.is_empty() {
        for item in items.iter_mut() {
            item["timeline"] = json!([]);
            item.as_object_mut().unwrap().remove("next_release_at");
        }
        return Ok(());
    }
    let earliest = released.iter().map(|(_, at)| at.clone()).min().unwrap();
    let mut q = QueryBuilder::<Sqlite>::new(
        "SELECT json_extract(r.data,'$.target') AS device,substr(json_extract(r.data,'$.outcome'),1,32) AS state,r.created_at AS at FROM records r JOIN audit_sequence s ON s.audit_id=r.id WHERE r.kind='audit' AND json_extract(r.data,'$.target') IN (",
    );
    let mut separated = q.separated(",");
    for (device, _) in &released {
        separated.push_bind(device.clone());
    }
    separated.push_unseparated(")");
    q.push(" AND json_extract(r.data,'$.action')='device.apply_state' AND r.created_at>=")
        .push_bind(earliest)
        .push(" ORDER BY s.sequence LIMIT 5000");
    let rows = q.build().fetch_all(&mut *db).await?;
    for item in items.iter_mut() {
        let (Some(device), Some(start)) = (
            item["device_id"].as_str().map(str::to_owned),
            item["released_at"].as_str().map(str::to_owned),
        ) else {
            item["timeline"] = json!([]);
            continue;
        };
        let end = [
            item["next_release_at"].as_str(),
            item["verified_at"].as_str(),
        ]
        .into_iter()
        .flatten()
        .min()
        .map(str::to_owned);
        let mut events: Vec<Value> = Vec::new();
        for row in &rows {
            let (who, state, at): (String, Option<String>, String) =
                (row.get("device"), row.get("state"), row.get("at"));
            if who != device || at < start || end.as_ref().is_some_and(|end| &at > end) {
                continue;
            }
            let Some(state) = state else { continue };
            if events.last().is_some_and(|last| last["state"] == state) {
                continue;
            }
            events.push(json!({"state":state,"at":at}));
        }
        if events.len() > 12 {
            events.drain(..events.len() - 12);
        }
        item["timeline"] = json!(events);
    }
    for item in items.iter_mut() {
        item.as_object_mut().unwrap().remove("next_release_at");
    }
    Ok(())
}
/// Stage lanes and failure groups for the rollout page. Waves are recovered from
/// persisted release times; future waves follow the scheduler's own order
/// (pending targets by device ID, canary first, then batches).
pub async fn rollout(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    query(raw.as_deref(), parsed)?;
    let mut tx = s.pool.begin().await?;
    let context = crate::canary_gate::load(&mut tx, &id).await?;
    if context.is_null() {
        return Err(ApiError::missing());
    }
    let rows: Vec<String> = sqlx::query_scalar("SELECT json_object('device_id',t.device_id,'device_name',substr(d.name,1,240),'state',t.state,'generation',t.generation,'released_at',t.released_at,'verified_at',t.verified_at,'error',t.error,\
        '_attempt',json_extract(d.data,'$.configuration_attempt'),'_terminal',json_extract(d.data,'$.terminal_configuration_attempt'),\
        '_policy',json(d.policy),'_policy_generation',d.policy_generation,\
        '_acknowledgement',json_object('policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds')),\
        '_data_plane',CASE WHEN t.state='verified_applied' AND json_extract(d.data,'$.data_plane.version_id')=? AND json_type(d.data,'$.data_plane.issues')='array' THEN json_extract(d.data,'$.data_plane.issues[0]') END) \
        FROM deployment_targets t LEFT JOIN devices d ON d.id=t.device_id WHERE t.deployment_id=? ORDER BY t.device_id LIMIT 10001")
        .bind(context["version_id"].as_str())
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?;
    if rows.len() > 10_000 {
        return Err(ApiError::invalid(
            "Rollout lanes support at most 10000 targets",
        ));
    }
    let mut targets = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    for target in &mut targets {
        finish_target(target);
        // The first open data-plane issue explains a degraded device in the
        // user's words: its title, the measured reason and the fix.
        let issue = target
            .as_object_mut()
            .unwrap()
            .remove("_data_plane")
            .filter(|issue| issue.is_object());
        if let Some(issue) = issue {
            target["state"] = json!("degraded");
            target["error"] = issue["title"].clone();
            target["diagnostic"] = issue["message"].clone();
            target["fix"] = issue["hint"].clone();
        }
    }
    let status = context["status"].as_str().unwrap_or("");
    let canary = context["rollout"]["kind"] == "canary";
    // Only a rollout that can still release has a queue of future waves.
    let planning = matches!(status, "active" | "paused" | "scheduled");
    let size = |key: &str| {
        context["rollout"][key]
            .as_u64()
            .unwrap_or(1)
            .clamp(1, 10_000) as usize
    };
    let removed = targets.iter().filter(|t| t["state"] == "removed").count();
    let mut waves: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    let mut unreleased: Vec<&Value> = Vec::new();
    for target in targets.iter().filter(|t| t["state"] != "removed") {
        match target["released_at"].as_str() {
            Some(at) => waves.entry(at.to_owned()).or_default().push(target),
            None => unreleased.push(target),
        }
    }
    let lane = |kind: &str, index: usize, members: &[&Value], released_at: Option<&str>| {
        let mut counts = BTreeMap::<String, u64>::new();
        for member in members {
            *counts
                .entry(member["state"].as_str().unwrap_or("unknown").to_owned())
                .or_default() += 1;
        }
        let verified = counts.get("verified_applied").copied().unwrap_or(0) as usize;
        let failing = FAILED_STATES
            .iter()
            .map(|state| counts.get(*state).copied().unwrap_or(0))
            .sum::<u64>();
        let state = if released_at.is_none() {
            if !planning || members.iter().any(|m| m["state"] != "pending") {
                "stopped"
            } else {
                "queued"
            }
        } else if failing > 0 {
            "failed"
        } else if verified == members.len() {
            "verified"
        } else {
            "in_progress"
        };
        let verified_at = if state == "verified" {
            members
                .iter()
                .filter_map(|m| m["verified_at"].as_str())
                .max()
                .map(str::to_owned)
        } else {
            None
        };
        json!({"kind":kind,"index":index,"state":state,"released_at":released_at,"verified_at":verified_at,"size":members.len(),"counts":counts,
            "devices":members.iter().take(60).map(|m| json!({"device_id":m["device_id"],"device_name":m["device_name"],"state":m["state"]})).collect::<Vec<_>>(),
            "more":members.len().saturating_sub(60)})
    };
    let mut stages = Vec::new();
    let mut batch = 0;
    for (position, (at, members)) in waves.iter().enumerate() {
        let kind = if !canary {
            if position == 0 { "all" } else { "added" }
        } else if position == 0 {
            "canary"
        } else {
            batch += 1;
            "batch"
        };
        stages.push(lane(kind, batch, members, Some(at)));
    }
    if !unreleased.is_empty() {
        if !planning {
            stages.push(lane("not_released", 0, &unreleased, None));
        } else {
            let mut queue = unreleased.as_slice();
            let mut first = waves.is_empty();
            while !queue.is_empty() {
                let take = if !canary {
                    queue.len()
                } else if first {
                    size("canary_size")
                } else {
                    size("batch_size")
                };
                let (wave, rest) = queue.split_at(take.min(queue.len()));
                let kind = if !canary {
                    if waves.is_empty() { "all" } else { "added" }
                } else if first {
                    "canary"
                } else {
                    batch += 1;
                    "batch"
                };
                stages.push(lane(kind, batch, wave, None));
                queue = rest;
                first = false;
            }
        }
    }
    let mut failures: BTreeMap<(String, String), (Value, Vec<Value>)> = BTreeMap::new();
    for target in targets
        .iter()
        .filter(|t| FAILED_STATES.contains(&t["state"].as_str().unwrap_or("")))
    {
        let state = target["state"].as_str().unwrap_or("").to_owned();
        let diagnostic = target["diagnostic"].as_str().map(str::to_owned);
        let message = target["error"].as_str().map(str::to_owned);
        let key = (
            state.clone(),
            diagnostic.clone().or(message.clone()).unwrap_or_default(),
        );
        let fix = target["fix"].as_str().map(str::to_owned);
        failures
            .entry(key)
            .or_insert_with(|| {
                let mut group = json!({"state":state,"message":message,"diagnostic":diagnostic});
                if fix.is_some() {
                    group["fix"] = json!(fix);
                }
                (group, Vec::new())
            })
            .1
            .push(json!({"device_id":target["device_id"],"device_name":target["device_name"]}));
    }
    let mut failures: Vec<Value> = failures
        .into_values()
        .map(|(mut group, devices)| {
            group["count"] = json!(devices.len());
            // Every member (bounded) so a retry covers the whole group, not
            // only the names shown.
            group["device_ids"] = json!(
                devices
                    .iter()
                    .take(1000)
                    .map(|device| device["device_id"].clone())
                    .collect::<Vec<_>>()
            );
            group["devices"] = json!(devices.into_iter().take(8).collect::<Vec<_>>());
            group
        })
        .collect();
    failures.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
    let check_in_seconds = targets
        .iter()
        .filter(|t| t["state"] != "removed")
        .filter_map(|t| t["check_in_seconds"].as_i64())
        .max();
    let mut next_admission_at = Value::Null;
    if crate::canary_gate::enabled(&context) {
        let gate = crate::canary_gate::evaluate(&mut tx, &context, None)
            .await?
            .projection(&context);
        if gate["state"] == "observing" {
            if let Some(started) = gate["observation_started_at"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            {
                let due = started
                    + chrono::Duration::seconds(gate["observation_seconds"].as_i64().unwrap_or(0));
                next_admission_at = json!(
                    due.with_timezone(&chrono::Utc)
                        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
                );
            }
        }
    }
    Ok(Json(
        json!({"deployment_id":id,"status":status,"evaluated_at":db::now(),"stages":stages,"failures":failures,"removed_count":removed,"check_in_seconds":check_in_seconds,"next_admission_at":next_admission_at}),
    ))
}

/// Values each device last received for a new version's variables: from the
/// most recent released deployment of the same pipeline that bound them, when
/// the name and type still match. A rollback in between (which restores exact
/// artifacts and binds nothing) doesn't lose them. Variables are nonsecret by
/// contract; operators see them in review.
pub async fn binding_suggestions(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    let object = v
        .as_object()
        .ok_or_else(|| ApiError::invalid("Request must be an object"))?;
    if object
        .keys()
        .any(|key| key != "version_id" && key != "device_ids")
    {
        return Err(ApiError::invalid("Unknown request field"));
    }
    let uuid = |value: &Value| {
        value
            .as_str()
            .and_then(|text| uuid::Uuid::parse_str(text).ok().map(|id| (text, id)))
            .filter(|(text, id)| id.hyphenated().to_string() == *text)
            .map(|(text, _)| text.to_owned())
    };
    let version_id =
        uuid(&v["version_id"]).ok_or_else(|| ApiError::invalid("version_id must be a UUID"))?;
    let devices: Vec<String> = v["device_ids"]
        .as_array()
        .filter(|ids| ids.len() <= 10_000)
        .ok_or_else(|| ApiError::invalid("device_ids must list at most 10000 device IDs"))?
        .iter()
        .map(|id| uuid(id).ok_or_else(|| ApiError::invalid("device_ids must contain device IDs")))
        .collect::<Result<_>>()?;
    let mut tx = s.pool.begin().await?;
    let version = db::record(&mut tx, "version", &version_id).await?;
    let declared: BTreeMap<String, String> = version["variables"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    Some((
                        item["name"].as_str()?.to_owned(),
                        item["type"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut values = serde_json::Map::new();
    let mut sources = serde_json::Map::new();
    let Some(pipeline) = version["configuration_id"].as_str() else {
        return Ok(Json(json!({"devices":values,"sources":sources})));
    };
    if declared.is_empty() || devices.is_empty() {
        return Ok(Json(json!({"devices":values,"sources":sources})));
    }
    let typed = |kind: &str, value: &Value| match kind {
        "integer" => value.is_i64(),
        "boolean" => value.is_boolean(),
        _ => value.as_str().is_some_and(|text| text.len() <= 4096),
    };
    for chunk in devices.chunks(500) {
        let mut query: QueryBuilder<Sqlite> = QueryBuilder::new(
            "SELECT t.device_id AS device,d.id AS deployment,json_extract(d.data,'$.variable_bindings') AS bindings,\
             CASE WHEN json_type(v.data,'$.number')='integer' THEN json_extract(v.data,'$.number') END AS number \
             FROM deployment_targets t JOIN devices dev ON dev.id=t.device_id AND dev.revoked=0 \
             JOIN records d ON d.kind='deployment' AND d.id=t.deployment_id \
             JOIN records v ON v.kind='version' AND v.id=json_extract(d.data,'$.version_id') \
             WHERE t.generation>0 AND json_type(d.data,'$.variable_bindings')='object' AND json_extract(v.data,'$.configuration_id')=",
        );
        query.push_bind(pipeline);
        query.push(" AND t.device_id IN (");
        let mut separated = query.separated(",");
        for id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY d.created_at DESC,d.id");
        for row in query.build().fetch_all(&mut *tx).await? {
            let device: String = row.get("device");
            let bindings = db::parse(&row.get::<String, _>("bindings"))?;
            let found = values
                .entry(device.clone())
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            let mut added = false;
            for (name, kind) in &declared {
                if found.get(name).is_some() {
                    continue;
                }
                let value = bindings["devices"][&device]
                    .get(name)
                    .or_else(|| bindings["defaults"].get(name));
                if let Some(value) = value.filter(|value| typed(kind, value)) {
                    found[name] = value.clone();
                    added = true;
                }
            }
            // The newest deployment that supplied a value is the source.
            if added && !sources.contains_key(&device) {
                sources.insert(
                    device,
                    json!({"deployment_id":row.get::<String, _>("deployment"),"version_number":row.get::<Option<i64>, _>("number")}),
                );
            }
        }
    }
    values.retain(|_, found| found.as_object().is_some_and(|map| !map.is_empty()));
    Ok(Json(json!({"devices":values,"sources":sources})))
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
            let q = page_query(status, scheduled, "", None, 12, 0, ORDER);
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
            let q = count_query(status, scheduled, "", None);
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
        let total: i64 = count_query("all", None, "", None)
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
        let rows: Vec<String> = page_query("all", None, "", None, 12, 0, ORDER)
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
        let total: i64 = count_query("all", None, "", None)
            .build_query_scalar()
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 2);
    }
}
