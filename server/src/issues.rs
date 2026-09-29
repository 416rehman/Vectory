//! Operator acknowledgement is distinct from verified runtime resolution.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{
        Path, Query, RawQuery, State as AppState,
        rejection::{JsonRejection, QueryRejection},
    },
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite, SqliteConnection};

pub(crate) const MESSAGE: &str = "Device reported an operational failure. Inspect the local agent status for sanitized diagnostics.";
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const DISPOSITION: &str = "CASE WHEN json_type(i.data,'$.resolved')='true' THEN 'resolved' WHEN json_type(i.data,'$.acknowledged')='true' THEN 'acknowledged' ELSE 'open' END";
// Keep these expressions equivalent to the indexes in migration 0011. Only
// bounded date-shaped strings reach SQLite's date parser; invalid imported
// values fall back to record time, then null, never invented event times.
fn timestamp(expression: &str) -> String {
    format!(
        "CASE WHEN typeof({expression})='text' AND length({expression})<=64 AND {expression} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' THEN strftime('%Y-%m-%dT%H:%M:%fZ',{expression}) ELSE NULL END"
    )
}
fn first_seen() -> String {
    format!(
        "COALESCE({},{})",
        timestamp("json_extract(i.data,'$.first_seen')"),
        timestamp("i.created_at")
    )
}
fn last_seen() -> String {
    format!(
        "COALESCE({},{},{})",
        timestamp("json_extract(i.data,'$.last_seen')"),
        timestamp("json_extract(i.data,'$.first_seen')"),
        timestamp("i.created_at")
    )
}
fn order() -> String {
    format!("{} DESC,i.id ASC", last_seen())
}
fn browse_order(sort: Option<&str>, direction: Option<&str>) -> Result<String> {
    let direction = match direction.unwrap_or("desc") {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(ApiError::invalid("Invalid sort direction")),
    };
    let expression = match sort.unwrap_or("last_seen") {
        "last_seen" => last_seen(),
        "code" => "CASE WHEN json_type(i.data,'$.code')='text' THEN substr(json_extract(i.data,'$.code'),1,128) ELSE 'APPLY_FAILED' END COLLATE NOCASE".into(),
        "device" => "COALESCE(NULLIF(substr(d.name,1,256),''),CASE WHEN json_type(i.data,'$.device_id')='text' THEN substr(json_extract(i.data,'$.device_id'),1,128) ELSE '' END) COLLATE NOCASE".into(),
        "count" => "CASE WHEN json_type(i.data,'$.count')='integer' AND json_extract(i.data,'$.count') BETWEEN 0 AND 9007199254740991 THEN json_extract(i.data,'$.count') ELSE 0 END".into(),
        "disposition" => DISPOSITION.into(),
        _ => return Err(ApiError::invalid("Invalid issue sort")),
    };
    Ok(format!("{expression} {direction} NULLS LAST,i.id ASC"))
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    search: Option<String>,
    state: Option<String>,
    device_id: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
    sort: Option<String>,
    direction: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    revision: u64,
    reason: String,
}

pub(crate) fn clear_acknowledgement(issue: &mut Value) {
    issue["acknowledged"] = json!(false);
    for key in [
        "acknowledged_at",
        "acknowledged_by",
        "acknowledged_by_name",
        "acknowledgement_reason",
    ] {
        issue[key] = Value::Null;
    }
}
pub(crate) fn revision(issue: &Value) -> u64 {
    issue["revision"].as_u64().filter(|n| *n >= 1).unwrap_or(1)
}
pub(crate) fn advance_revision(issue: &mut Value) -> Result<()> {
    let revision = revision(issue)
        .checked_add(1)
        .filter(|n| *n <= MAX_INTEGER)
        .ok_or_else(|| ApiError::conflict("Issue revision is exhausted"))?;
    issue["revision"] = json!(revision);
    Ok(())
}

fn projection(q: &mut QueryBuilder<'_, Sqlite>) {
    q.push("SELECT json_object(\
        'id',i.id,'device_id',CASE WHEN json_type(i.data,'$.device_id')='text' THEN substr(json_extract(i.data,'$.device_id'),1,128) ELSE '' END,\
        'device_name',substr(d.name,1,256),'device_revoked',CASE WHEN d.id IS NULL THEN NULL ELSE json(CASE WHEN d.revoked=1 THEN 'true' ELSE 'false' END) END,\
        'code',CASE WHEN json_type(i.data,'$.code')='text' THEN substr(json_extract(i.data,'$.code'),1,128) ELSE 'APPLY_FAILED' END,\
        'stage',CASE WHEN json_type(i.data,'$.stage')='text' THEN substr(json_extract(i.data,'$.stage'),1,64) ELSE 'apply' END,\
        'message',").push_bind(MESSAGE).push(",\
        'count',CASE WHEN json_type(i.data,'$.count')='integer' AND json_extract(i.data,'$.count') BETWEEN 0 AND 9007199254740991 THEN json_extract(i.data,'$.count') ELSE 0 END,\
        'first_seen',").push(first_seen()).push(",'last_seen',").push(last_seen()).push(",\
        'desired_version_id',CASE WHEN json_type(i.data,'$.desired_version_id')='text' THEN substr(json_extract(i.data,'$.desired_version_id'),1,128) ELSE NULL END,\
        'resolved',json(CASE WHEN json_type(i.data,'$.resolved')='true' THEN 'true' ELSE 'false' END),\
        'revision',CASE WHEN json_type(i.data,'$.revision')='integer' AND json_extract(i.data,'$.revision') BETWEEN 1 AND 9007199254740991 THEN json_extract(i.data,'$.revision') ELSE 1 END,\
        'acknowledged',json(CASE WHEN json_type(i.data,'$.acknowledged')='true' THEN 'true' ELSE 'false' END),\
        'acknowledged_at',").push(timestamp("json_extract(i.data,'$.acknowledged_at')")).push(",\
        'acknowledged_by',CASE WHEN json_type(i.data,'$.acknowledged_by')='text' THEN substr(json_extract(i.data,'$.acknowledged_by'),1,128) ELSE NULL END,\
        'acknowledged_by_name',CASE WHEN json_type(i.data,'$.acknowledged_by_name')='text' THEN substr(json_extract(i.data,'$.acknowledged_by_name'),1,120) ELSE NULL END,\
        'acknowledgement_reason',CASE WHEN json_type(i.data,'$.acknowledgement_reason')='text' THEN substr(json_extract(i.data,'$.acknowledgement_reason'),1,1000) ELSE NULL END,\
        'disposition',").push(DISPOSITION).push(") FROM records i LEFT JOIN devices d ON d.id=json_extract(i.data,'$.device_id')");
}
fn filter(q: &mut QueryBuilder<'_, Sqlite>, state: &str, device: Option<&str>, search: &str) {
    q.push(" WHERE i.kind='issue'");
    if state != "all" {
        q.push(" AND (")
            .push(DISPOSITION)
            .push(")=")
            .push_bind(state.to_owned());
    }
    if let Some(device) = device {
        q.push(" AND json_extract(i.data,'$.device_id')=")
            .push_bind(device.to_owned());
    }
    if !search.is_empty() {
        // Only advertised bounded fields are searchable. Operator reasons and
        // imported raw diagnostic bodies cannot become a covert search index.
        q.push(" AND instr(lower(COALESCE(substr(d.name,1,256),'')||' '||CASE WHEN json_type(i.data,'$.device_id')='text' THEN substr(json_extract(i.data,'$.device_id'),1,128) ELSE '' END||' '||CASE WHEN json_type(i.data,'$.code')='text' THEN substr(json_extract(i.data,'$.code'),1,128) ELSE 'APPLY_FAILED' END||' '||CASE WHEN json_type(i.data,'$.stage')='text' THEN substr(json_extract(i.data,'$.stage'),1,64) ELSE 'apply' END||' '||").push_bind(MESSAGE).push("),lower(").push_bind(search.to_owned()).push("))>0");
    }
}
fn count_query(state: &str, device: Option<&str>, search: &str) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("SELECT count(*) FROM records i");
    if !search.is_empty() {
        q.push(" LEFT JOIN devices d ON d.id=json_extract(i.data,'$.device_id')");
    }
    filter(&mut q, state, device, search);
    q
}
fn page_query(
    state: &str,
    device: Option<&str>,
    search: &str,
    size: i64,
    offset: i64,
    ordering: &str,
) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("");
    projection(&mut q);
    filter(&mut q, state, device, search);
    q.push(" ORDER BY ")
        .push(ordering)
        .push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset);
    q
}
pub(crate) async fn open_count(db: &mut SqliteConnection) -> Result<i64> {
    Ok(count_query("open", None, "")
        .build_query_scalar()
        .fetch_one(db)
        .await?)
}
pub(crate) async fn legacy(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let mut q = QueryBuilder::new("");
    projection(&mut q);
    filter(&mut q, "all", None, "");
    q.push(" ORDER BY ").push(order());
    let rows: Vec<String> = q.build_query_scalar().fetch_all(db).await?;
    rows.iter().map(|row| db::parse(row)).collect()
}
async fn read(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let mut q = QueryBuilder::new("");
    projection(&mut q);
    q.push(" WHERE i.kind='issue' AND i.id=")
        .push_bind(id.to_owned());
    let row: Option<String> = q.build_query_scalar().fetch_optional(db).await?;
    db::parse(&row.ok_or_else(ApiError::missing)?)
}
pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (search, page, size, offset) =
        crate::deployment_history::bounds(input.search.as_deref(), input.page, input.page_size)?;
    let state = input.state.as_deref().unwrap_or("open");
    if !matches!(state, "open" | "acknowledged" | "resolved" | "all") {
        return Err(ApiError::invalid(
            "state must be open, acknowledged, resolved or all",
        ));
    }
    let device = input
        .device_id
        .as_deref()
        .map(|id| {
            let parsed = uuid::Uuid::parse_str(id)
                .map_err(|_| ApiError::invalid("device_id must be a UUID"))?;
            if id.len() != 36 || parsed.to_string() != id.to_ascii_lowercase() {
                return Err(ApiError::invalid("device_id must be a UUID"));
            }
            Ok(parsed.to_string())
        })
        .transpose()?;
    let ordering = browse_order(input.sort.as_deref(), input.direction.as_deref())?;
    let mut tx = s.pool.begin().await?;
    let total: i64 = count_query(state, device.as_deref(), search)
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = page_query(state, device.as_deref(), search, size, offset, &ordering)
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}
pub async fn detail(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let mut conn = s.pool.acquire().await?;
    Ok(Json(read(&mut conn, &id).await?))
}
pub async fn acknowledge(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    input: std::result::Result<Json<Command>, JsonRejection>,
) -> Result<Json<Value>> {
    command(s, h, id, input, true).await
}
pub async fn reopen(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    input: std::result::Result<Json<Command>, JsonRejection>,
) -> Result<Json<Value>> {
    command(s, h, id, input, false).await
}
async fn command(
    s: State,
    h: HeaderMap,
    id: String,
    input: std::result::Result<Json<Command>, JsonRejection>,
    acknowledge: bool,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    let Json(input) = input.map_err(|_| ApiError::invalid("Provide revision and a reason"))?;
    let reason = input.reason.trim();
    if !(1..=MAX_INTEGER).contains(&input.revision)
        || reason.is_empty()
        || reason.chars().count() > 1000
        || reason.contains('\0')
    {
        return Err(ApiError::invalid(
            "Provide a current positive revision and a reason of 1..1000 characters",
        ));
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let mut issue = db::record(&mut tx, "issue", &id).await?;
    if revision(&issue) != input.revision {
        return Err(ApiError::conflict(
            "Issue changed; review the latest occurrence and disposition",
        ));
    }
    if issue["resolved"] == true {
        return Err(ApiError::conflict(
            "Verified resolved issues cannot be acknowledged or reopened",
        ));
    }
    let device_id = issue["device_id"]
        .as_str()
        .ok_or_else(|| ApiError::conflict("The original device identity is unavailable"))?
        .to_owned();
    let revoked: Option<bool> = sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
        .bind(&device_id)
        .fetch_optional(&mut *tx)
        .await?;
    if revoked != Some(true) {
        return Err(ApiError::conflict(
            "Only unresolved issues on the original revoked device identity can be acknowledged or reopened",
        ));
    }
    if (issue["acknowledged"] == true) == acknowledge {
        return Err(ApiError::conflict("Issue already has this disposition"));
    }
    advance_revision(&mut issue)?;
    clear_acknowledgement(&mut issue);
    if acknowledge {
        issue["acknowledged"] = json!(true);
        issue["acknowledged_at"] = json!(db::now());
        issue["acknowledged_by"] = actor["id"].clone();
        issue["acknowledged_by_name"] = actor["name"].clone();
        issue["acknowledgement_reason"] = json!(reason);
    }
    db::update(&mut tx, "issue", &issue).await?;
    db::insert(&mut tx,"audit",&json!({"id":db::id(),"actor":actor["id"],"action":if acknowledge {"issue.acknowledge"} else {"issue.reopen"},"target":id,"device_id":device_id,"issue_revision":issue["revision"],"reason":reason,"outcome":"success","created_at":db::now()})).await?;
    let out = read(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Execute, Row};

    #[tokio::test]
    async fn issue_history_and_overview_count_use_bounded_metadata_indexes() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (state, device, index) in [
            ("all", None, "issue_history_recent"),
            ("open", None, "issue_history_state"),
            ("acknowledged", None, "issue_history_state"),
            (
                "open",
                Some("10000000-0000-4000-8000-000000000001"),
                "issue_history_device_state",
            ),
        ] {
            let mut builder = page_query(state, device, "", 12, 0, &order());
            let mut query = builder.build();
            let explain = format!("EXPLAIN QUERY PLAN {}", query.sql());
            let arguments = query.take_arguments().unwrap().unwrap();
            let rows = sqlx::query_with(&explain, arguments)
                .fetch_all(&pool)
                .await
                .unwrap();
            let plan = rows
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(plan.contains(index), "{state} {device:?}: {plan}");
            assert!(!plan.contains("TEMP B-TREE FOR ORDER BY"), "{plan}");
            let mut builder = count_query(state, device, "");
            let mut query = builder.build();
            let explain = format!("EXPLAIN QUERY PLAN {}", query.sql());
            let arguments = query.take_arguments().unwrap().unwrap();
            let rows = sqlx::query_with(&explain, arguments)
                .fetch_all(&pool)
                .await
                .unwrap();
            let plan = rows
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(plan.contains("INDEX"), "{plan}");
            assert!(!plan.contains("SCAN i"), "{plan}");
        }
    }
}
