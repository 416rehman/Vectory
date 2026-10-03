//! Apply failures as operator issues. Acknowledgement is an operator
//! disposition, distinct from verified runtime resolution.
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
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupQuery {
    search: Option<String>,
    state: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    revision: u64,
    #[serde(default)]
    reason: Option<String>,
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

/// A failure report to persist as an issue.
pub(crate) struct Failure<'a> {
    pub device_id: &'a str,
    /// Allowlisted error from `configuration_attempt::safe_error`.
    pub error: &'a Value,
    /// Version the failure belongs to; part of the issue identity.
    pub version_id: Option<&'a str>,
    /// Identity of the failed attempt: a new identity is a new occurrence.
    pub attempt: Value,
    pub deployment_id: Option<String>,
}

fn counter(issue: &Value, key: &str) -> u64 {
    issue[key]
        .as_u64()
        .filter(|n| *n <= MAX_INTEGER)
        .unwrap_or(0)
}
fn increment(value: u64) -> Result<Value> {
    value
        .checked_add(1)
        .filter(|n| *n <= MAX_INTEGER)
        .map(|n| json!(n))
        .ok_or_else(|| ApiError::conflict("Issue occurrence count is exhausted"))
}

/// Record one failure report. Issues are keyed by device, version, code and
/// stage. `count` counts distinct failed attempts (a new generation or local
/// materialization); `reports` counts every report. Only a new attempt or a
/// recurrence after resolution advances the revision and clears an
/// acknowledgement, so repeated check-ins never undo an operator's decision.
pub(crate) async fn record_failure(db: &mut SqliteConnection, f: Failure<'_>) -> Result<()> {
    let code = f.error["code"].as_str().unwrap_or("APPLY_FAILED");
    let stage = f.error["stage"].as_str().unwrap_or("apply");
    let version = f.version_id.unwrap_or("");
    let id = db::hash(format!("{}:{version}:{code}:{stage}", f.device_id));
    let now = db::now();
    let (mut issue, new) = match db::record(db, "issue", &id).await {
        Ok(v) => (v, false),
        Err(e) if e.status == axum::http::StatusCode::NOT_FOUND => (
            json!({"id":id,"device_id":f.device_id,"code":code,"stage":stage,"count":0,"reports":0,"first_seen":now,"resolved":false,"revision":1}),
            true,
        ),
        Err(e) => return Err(e),
    };
    let opened = new || issue["resolved"] == true;
    if new || issue["resolved"] == true || issue["last_attempt"] != f.attempt {
        if !new {
            advance_revision(&mut issue)?;
        }
        clear_acknowledgement(&mut issue);
        issue["count"] = increment(counter(&issue, "count"))?;
        issue["resolved"] = json!(false);
        if let Some(o) = issue.as_object_mut() {
            o.remove("resolved_reason");
            o.remove("resolved_at");
        }
    }
    let reports = counter(&issue, "reports").max(counter(&issue, "count").saturating_sub(1));
    issue["reports"] = increment(reports)?;
    issue["last_seen"] = json!(now);
    issue["last_attempt"] = f.attempt;
    // The reason is rendered on read from the code and validated diagnostics,
    // so a stored free-text message (from any server version) is never shown.
    if let Some(o) = issue.as_object_mut() {
        o.remove("message");
    }
    match f.error.get("diagnostics") {
        Some(d) => issue["diagnostics"] = d.clone(),
        None => {
            issue.as_object_mut().unwrap().remove("diagnostics");
        }
    }
    issue["desired_version_id"] = json!(f.version_id);
    issue["deployment_id"] = json!(f.deployment_id);
    if new {
        db::insert(db, "issue", &issue).await?;
    } else {
        db::update(db, "issue", &issue).await?;
    }
    if opened {
        crate::notifications::issue_opened(db, &issue).await?;
    }
    Ok(())
}

/// Resolve a device's open issues: `verified` when it verified a
/// configuration after the failure, `unassigned` when its assignment was
/// removed, `revoked` when its identity was revoked. Acknowledgement context
/// stays as history. Verifying a configuration says nothing about delivery,
/// so data-plane issues resolve only through their own evaluation (or when
/// the assignment or the device goes away); it says nothing about the agent
/// either, so agent update issues resolve only when the device verifies a
/// later update, or with the device.
pub(crate) async fn resolve_device(
    db: &mut SqliteConnection,
    device_id: &str,
    reason: &str,
) -> Result<()> {
    // Agent update issues end only with a later update the device verified
    // (`resolve_agent_update`) or with the device itself.
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.device_id')=? AND COALESCE(json_type(data,'$.resolved')='true',0)=0 AND (?=0 OR COALESCE(json_extract(data,'$.code'),'') NOT GLOB 'DATA_PLANE_*') AND (?=1 OR COALESCE(json_extract(data,'$.code'),'') NOT GLOB 'AGENT_UPDATE_*')")
        .bind(device_id)
        .bind(reason == "verified")
        .bind(reason == "revoked")
        .fetch_all(&mut *db)
        .await?;
    for row in rows {
        let mut issue = db::parse(&row)?;
        resolve(&mut issue, reason)?;
        db::update(db, "issue", &issue).await?;
        crate::notifications::issue_resolved(db, &issue).await?;
    }
    Ok(())
}
fn resolve(issue: &mut Value, reason: &str) -> Result<()> {
    advance_revision(issue)?;
    issue["resolved"] = json!(true);
    issue["resolved_reason"] = json!(reason);
    issue["resolved_at"] = json!(db::now());
    Ok(())
}

/// One data-plane evaluation that found a condition (see `data_plane`).
pub(crate) struct DataPlaneReport<'a> {
    pub device_id: &'a str,
    pub version_id: &'a str,
    pub code: &'static str,
    /// Keyed component; `None` for a pipeline-wide condition.
    pub component: Option<&'a str>,
    /// Validated-shape diagnostics; the first explains the condition.
    pub diagnostics: &'a Value,
    pub evidence: &'a Value,
    pub deployment_id: Option<String>,
    /// Evaluations that found the condition since the issue was last written.
    pub extra_reports: u64,
}
/// Open or refresh a data-plane issue keyed by device, version, code and
/// component. `count` counts openings (a recurrence after resolution is a new
/// occurrence and clears an acknowledgement); `reports` counts evaluations
/// that found the condition while it was open. Returns the issue ID.
pub(crate) async fn record_data_plane(
    db: &mut SqliteConnection,
    r: DataPlaneReport<'_>,
) -> Result<String> {
    let component = r.component.unwrap_or("");
    let id = db::hash(format!(
        "{}:{}:{}:component:{component}",
        r.device_id, r.version_id, r.code
    ));
    let now = db::now();
    let (mut issue, new) = match db::record(db, "issue", &id).await {
        Ok(v) => (v, false),
        Err(e) if e.status == axum::http::StatusCode::NOT_FOUND => (
            json!({"id":id,"device_id":r.device_id,"code":r.code,"stage":"delivery","count":0,"reports":0,"first_seen":now,"resolved":false,"revision":1}),
            true,
        ),
        Err(e) => return Err(e),
    };
    let opened = new || issue["resolved"] == true;
    if opened {
        if !new {
            advance_revision(&mut issue)?;
        }
        clear_acknowledgement(&mut issue);
        issue["count"] = increment(counter(&issue, "count"))?;
        issue["resolved"] = json!(false);
        if let Some(o) = issue.as_object_mut() {
            o.remove("resolved_reason");
            o.remove("resolved_at");
        }
    }
    for _ in 0..=r.extra_reports.min(1000) {
        issue["reports"] = increment(counter(&issue, "reports"))?;
    }
    issue["last_seen"] = json!(now);
    issue["component"] = json!(r.component);
    // Never fail a heartbeat over presentation: an invalid finding renders
    // from the code's generic message instead.
    issue["diagnostics"] =
        crate::configuration_attempt::diagnostics(r.diagnostics).unwrap_or_else(|_| json!([]));
    issue["evidence"] = r.evidence.clone();
    issue["desired_version_id"] = json!(r.version_id);
    issue["deployment_id"] = json!(r.deployment_id);
    if new {
        db::insert(db, "issue", &issue).await?;
    } else {
        db::update(db, "issue", &issue).await?;
    }
    if opened {
        crate::notifications::issue_opened(db, &issue).await?;
    }
    Ok(id)
}
/// An update of a device's agent that was rolled back or failed.
pub(crate) struct AgentUpdateFailure<'a> {
    pub device_id: &'a str,
    pub release_version: &'a str,
    /// `rolled_back` or `failed`.
    pub outcome: &'a str,
    /// The agent's code, or `NO_REPORT`.
    pub code: &'a str,
    pub rollout_id: &'a str,
}
/// Open or refresh the issue of an agent update that was rolled back
/// (`AGENT_UPDATE_ROLLED_BACK`) or failed (`AGENT_UPDATE_FAILED`), keyed by
/// device, release version and code. A new rollout's failure, or one after the
/// issue resolved, is a new occurrence and clears an acknowledgement. The agent
/// update events of the notifier announce it, so no `issue.opened` follows.
pub(crate) async fn record_agent_update(
    db: &mut SqliteConnection,
    f: AgentUpdateFailure<'_>,
) -> Result<()> {
    let code = if f.outcome == "rolled_back" {
        "AGENT_UPDATE_ROLLED_BACK"
    } else {
        "AGENT_UPDATE_FAILED"
    };
    let id = db::hash(format!(
        "{}:{}:{code}:agent_update",
        f.device_id, f.release_version
    ));
    let now = db::now();
    let attempt = json!({"rollout_id":f.rollout_id});
    let (mut issue, new) = match db::record(db, "issue", &id).await {
        Ok(v) => (v, false),
        Err(e) if e.status == axum::http::StatusCode::NOT_FOUND => (
            json!({"id":id,"device_id":f.device_id,"code":code,"stage":"agent_update","count":0,"reports":0,"first_seen":now,"resolved":false,"revision":1}),
            true,
        ),
        Err(e) => return Err(e),
    };
    if new || issue["resolved"] == true || issue["last_attempt"] != attempt {
        if !new {
            advance_revision(&mut issue)?;
        }
        clear_acknowledgement(&mut issue);
        issue["count"] = increment(counter(&issue, "count"))?;
        issue["resolved"] = json!(false);
        if let Some(o) = issue.as_object_mut() {
            o.remove("resolved_reason");
            o.remove("resolved_at");
        }
    }
    let reports = counter(&issue, "reports").max(counter(&issue, "count").saturating_sub(1));
    issue["reports"] = increment(reports)?;
    issue["last_seen"] = json!(now);
    issue["last_attempt"] = attempt;
    issue["update_version"] = json!(f.release_version);
    issue["update_code"] = json!(f.code);
    issue["desired_version_id"] = Value::Null;
    issue["deployment_id"] = Value::Null;
    if new {
        db::insert(db, "issue", &issue).await
    } else {
        db::update(db, "issue", &issue).await
    }
}
/// Resolve a device's open agent update issues as `verified`: it verified a
/// later update.
pub(crate) async fn resolve_agent_update(db: &mut SqliteConnection, device_id: &str) -> Result<()> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.device_id')=? AND COALESCE(json_type(data,'$.resolved')='true',0)=0 AND COALESCE(json_extract(data,'$.code'),'') GLOB 'AGENT_UPDATE_*'")
        .bind(device_id)
        .fetch_all(&mut *db)
        .await?;
    for row in rows {
        let mut issue = db::parse(&row)?;
        resolve(&mut issue, "verified")?;
        db::update(db, "issue", &issue).await?;
    }
    Ok(())
}
/// Resolve one data-plane issue, e.g. `healthy` after clean evaluations.
pub(crate) async fn resolve_data_plane_issue(
    db: &mut SqliteConnection,
    id: &str,
    reason: &str,
) -> Result<()> {
    let mut issue = match db::record(db, "issue", id).await {
        Ok(v) => v,
        Err(e) if e.status == axum::http::StatusCode::NOT_FOUND => return Ok(()),
        Err(e) => return Err(e),
    };
    if issue["resolved"] != true {
        resolve(&mut issue, reason)?;
        db::update(db, "issue", &issue).await?;
        crate::notifications::issue_resolved(db, &issue).await?;
    }
    Ok(())
}
/// Resolve a device's open data-plane issues for every version except `keep`.
pub(crate) async fn resolve_data_plane(
    db: &mut SqliteConnection,
    device_id: &str,
    keep: Option<&str>,
    reason: &str,
) -> Result<()> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.device_id')=? AND COALESCE(json_type(data,'$.resolved')='true',0)=0 AND COALESCE(json_extract(data,'$.code'),'') GLOB 'DATA_PLANE_*' AND json_extract(data,'$.desired_version_id') IS NOT ?")
        .bind(device_id)
        .bind(keep)
        .fetch_all(&mut *db)
        .await?;
    for row in rows {
        let mut issue = db::parse(&row)?;
        resolve(&mut issue, reason)?;
        db::update(db, "issue", &issue).await?;
        crate::notifications::issue_resolved(db, &issue).await?;
    }
    Ok(())
}

const COUNT: &str = "CASE WHEN json_type(i.data,'$.count')='integer' AND json_extract(i.data,'$.count') BETWEEN 0 AND 9007199254740991 THEN json_extract(i.data,'$.count') ELSE 0 END";
const REPORTS: &str = "CASE WHEN json_type(i.data,'$.reports')='integer' AND json_extract(i.data,'$.reports') BETWEEN 0 AND 9007199254740991 THEN json_extract(i.data,'$.reports') ELSE NULL END";
const CODE: &str = "CASE WHEN json_type(i.data,'$.code')='text' THEN substr(json_extract(i.data,'$.code'),1,128) ELSE 'APPLY_FAILED' END";
const VERSION: &str = "CASE WHEN json_type(i.data,'$.desired_version_id')='text' THEN substr(json_extract(i.data,'$.desired_version_id'),1,128) ELSE '' END";
/// SQL for the plain-language title of the issue record `alias`, so search
/// matches what operators read and the audit log names an issue event by it.
pub(crate) fn title_sql(alias: &str) -> String {
    let code = CODE.replace("i.data", &format!("{alias}.data"));
    let mut sql = format!("CASE {code}");
    for code in crate::configuration_attempt::CODES {
        let title = crate::configuration_attempt::title(code).replace('\'', "''");
        sql.push_str(&format!(" WHEN '{code}' THEN '{title}'"));
    }
    for code in crate::data_plane::CODES {
        let title = crate::data_plane::generic_title(code).replace('\'', "''");
        sql.push_str(&format!(" WHEN '{code}' THEN '{title}'"));
    }
    sql.push_str(" END");
    sql
}
const JOINS: &str = " LEFT JOIN devices d ON d.id=json_extract(i.data,'$.device_id') LEFT JOIN records v ON v.kind='version' AND v.id=json_extract(i.data,'$.desired_version_id') LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')";

fn projection(q: &mut QueryBuilder<'_, Sqlite>) {
    q.push("SELECT ");
    issue_object(q);
    q.push(" FROM records i").push(JOINS);
}
/// The allowlisted Issue projection of `records i` joined with `JOINS`.
fn issue_object(q: &mut QueryBuilder<'_, Sqlite>) {
    q.push("json_object(\
        'id',i.id,'device_id',CASE WHEN json_type(i.data,'$.device_id')='text' THEN substr(json_extract(i.data,'$.device_id'),1,128) ELSE '' END,\
        'device_name',substr(d.name,1,256),'device_revoked',CASE WHEN d.id IS NULL THEN NULL ELSE json(CASE WHEN d.revoked=1 THEN 'true' ELSE 'false' END) END,\
        'code',").push(CODE).push(",\
        'stage',CASE WHEN json_type(i.data,'$.stage')='text' THEN substr(json_extract(i.data,'$.stage'),1,64) ELSE 'apply' END,\
        'diagnostics',CASE WHEN json_type(i.data,'$.diagnostics')='array' AND json_array_length(i.data,'$.diagnostics')<=10 AND length(json_extract(i.data,'$.diagnostics'))<=6000 THEN json(json_extract(i.data,'$.diagnostics')) ELSE json('[]') END,\
        'count',").push(COUNT).push(",\
        'reports',COALESCE(").push(REPORTS).push(",").push(COUNT).push("),\
        'first_seen',").push(first_seen()).push(",'last_seen',").push(last_seen()).push(",\
        'desired_version_id',CASE WHEN json_type(i.data,'$.desired_version_id')='text' THEN substr(json_extract(i.data,'$.desired_version_id'),1,128) ELSE NULL END,\
        'version_number',CASE WHEN json_type(v.data,'$.number')='integer' AND json_extract(v.data,'$.number') BETWEEN 1 AND 9007199254740991 THEN json_extract(v.data,'$.number') ELSE NULL END,\
        'configuration_id',CASE WHEN json_type(v.data,'$.configuration_id')='text' THEN substr(json_extract(v.data,'$.configuration_id'),1,128) ELSE NULL END,\
        'configuration_name',CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) ELSE NULL END,\
        'deployment_id',CASE WHEN json_type(i.data,'$.deployment_id')='text' THEN substr(json_extract(i.data,'$.deployment_id'),1,128) ELSE NULL END,\
        'update_version',CASE WHEN json_type(i.data,'$.update_version')='text' THEN substr(json_extract(i.data,'$.update_version'),1,64) ELSE NULL END,\
        'update_code',CASE WHEN json_type(i.data,'$.update_code')='text' THEN substr(json_extract(i.data,'$.update_code'),1,64) ELSE NULL END,\
        'resolved',json(CASE WHEN json_type(i.data,'$.resolved')='true' THEN 'true' ELSE 'false' END),\
        'resolved_reason',CASE WHEN json_type(i.data,'$.resolved')='true' THEN CASE WHEN json_extract(i.data,'$.resolved_reason') IN ('verified','unassigned','healthy','superseded','unmonitored','revoked') THEN json_extract(i.data,'$.resolved_reason') ELSE 'verified' END ELSE NULL END,\
        'resolved_at',").push(timestamp("json_extract(i.data,'$.resolved_at')")).push(",\
        'revision',CASE WHEN json_type(i.data,'$.revision')='integer' AND json_extract(i.data,'$.revision') BETWEEN 1 AND 9007199254740991 THEN json_extract(i.data,'$.revision') ELSE 1 END,\
        'acknowledged',json(CASE WHEN json_type(i.data,'$.acknowledged')='true' THEN 'true' ELSE 'false' END),\
        'acknowledged_at',").push(timestamp("json_extract(i.data,'$.acknowledged_at')")).push(",\
        'acknowledged_by',CASE WHEN json_type(i.data,'$.acknowledged_by')='text' THEN substr(json_extract(i.data,'$.acknowledged_by'),1,128) ELSE NULL END,\
        'acknowledged_by_name',CASE WHEN json_type(i.data,'$.acknowledged_by_name')='text' THEN substr(json_extract(i.data,'$.acknowledged_by_name'),1,120) ELSE NULL END,\
        'acknowledgement_reason',CASE WHEN json_type(i.data,'$.acknowledgement_reason')='text' THEN substr(json_extract(i.data,'$.acknowledgement_reason'),1,1000) ELSE NULL END,\
        'disposition',").push(DISPOSITION).push(")");
}
/// Render the plain-language title and reason from the code and the
/// diagnostics, which are revalidated so imported records cannot inject
/// unbounded or unexpected content.
pub(crate) fn render(mut issue: Value) -> Value {
    let code = issue["code"].as_str().unwrap_or("APPLY_FAILED").to_owned();
    if let Some(fields) = issue.as_object_mut() {
        let version = fields.remove("update_version");
        let agent_code = fields.remove("update_code");
        if code.starts_with("AGENT_UPDATE_") {
            let version = version.as_ref().and_then(Value::as_str).unwrap_or("");
            let device = issue["device_name"].as_str().unwrap_or("A device");
            issue["title"] = json!(agent_update_title(&code, device, version));
            issue["message"] = json!(
                crate::agent_update_rollouts::detail::message(
                    agent_code.as_ref().and_then(Value::as_str)
                )
                .unwrap_or("The update of the agent didn't finish.")
            );
            issue["diagnostics"] = json!([]);
            return issue;
        }
    }
    let diagnostics = crate::configuration_attempt::diagnostics(&issue["diagnostics"])
        .unwrap_or_else(|_| json!([]));
    if crate::data_plane::is_data_plane(&code) {
        let first = &diagnostics[0];
        let component = first["component_id"]
            .as_str()
            .filter(|_| code != crate::data_plane::STALLED);
        issue["title"] = json!(crate::data_plane::title(&code, component));
        issue["message"] = json!(
            first["message"]
                .as_str()
                .unwrap_or("The device's numbers show this version isn't delivering events.")
        );
        issue["diagnostics"] = diagnostics;
        return issue;
    }
    issue["title"] = json!(
        first_version_title(&code, issue["device_name"].as_str(), &issue, 1)
            .unwrap_or_else(|| crate::configuration_attempt::title(&code).to_owned())
    );
    issue["message"] = json!(crate::configuration_attempt::summary(&code, &diagnostics));
    issue["diagnostics"] = diagnostics;
    issue
}
/// "edge-02 rolled back agent 0.1.1", or "edge-02 couldn't update to agent
/// 0.1.1", cut to 120 characters.
fn agent_update_title(code: &str, device: &str, version: &str) -> String {
    let title = if code == "AGENT_UPDATE_ROLLED_BACK" {
        format!("{device} rolled back agent {version}")
    } else {
        format!("{device} couldn't update to agent {version}")
    };
    if title.chars().count() <= 120 {
        title
    } else {
        title.chars().take(119).chain(['…']).collect()
    }
}
/// A device's first version that stopped Vector says who couldn't start
/// what: "edge-01 couldn't start Syslog intake v1", or "3 devices couldn't
/// start ..." for a group. None for other codes or without the names.
fn first_version_title(
    code: &str,
    device: Option<&str>,
    issue: &Value,
    devices: i64,
) -> Option<String> {
    if code != "ROLLBACK_UNAVAILABLE" {
        return None;
    }
    let pipeline = issue["configuration_name"].as_str()?;
    let version = issue["version_number"].as_u64()?;
    let who = match device {
        Some(name) if devices <= 1 => name.to_owned(),
        _ => format!("{devices} devices"),
    };
    let title = format!("{who} couldn't start {pipeline} v{version}");
    Some(if title.chars().count() <= 120 {
        title
    } else {
        title.chars().take(119).chain(['…']).collect()
    })
}
fn rendered(rows: &[String]) -> Result<Vec<Value>> {
    rows.iter().map(|row| db::parse(row).map(render)).collect()
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
        q.push(" AND instr(lower(COALESCE(substr(d.name,1,256),'')||' '||CASE WHEN json_type(i.data,'$.device_id')='text' THEN substr(json_extract(i.data,'$.device_id'),1,128) ELSE '' END||' '||").push(CODE).push("||' '||COALESCE(").push(title_sql("i")).push(",'')||' '||CASE WHEN json_type(i.data,'$.stage')='text' THEN substr(json_extract(i.data,'$.stage'),1,64) ELSE 'apply' END||' '||COALESCE(CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) END,'')),lower(").push_bind(search.to_owned()).push("))>0");
    }
}
fn count_query(state: &str, device: Option<&str>, search: &str) -> QueryBuilder<'static, Sqlite> {
    let mut q = QueryBuilder::new("SELECT count(*) FROM records i");
    if !search.is_empty() {
        q.push(JOINS);
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
    // Search is empty here, so the count reads the state index only.
    Ok(count_query("open", None, "")
        .build_query_scalar()
        .fetch_one(db)
        .await?)
}
/// The unpaged list answers with the newest issues only; clients that need
/// more page through `GET /issues/history`. Delivery problems can open many
/// issues at once, so the table is not bounded by the fleet's size.
const LEGACY_ISSUES: i64 = 1000;
pub(crate) async fn legacy(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let mut q = QueryBuilder::new("");
    projection(&mut q);
    filter(&mut q, "all", None, "");
    q.push(" ORDER BY ").push(order());
    q.push(" LIMIT ").push_bind(LEGACY_ISSUES);
    let rows: Vec<String> = q.build_query_scalar().fetch_all(db).await?;
    rendered(&rows)
}
async fn read(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let mut q = QueryBuilder::new("");
    projection(&mut q);
    q.push(" WHERE i.kind='issue' AND i.id=")
        .push_bind(id.to_owned());
    let row: Option<String> = q.build_query_scalar().fetch_optional(db).await?;
    db::parse(&row.ok_or_else(ApiError::missing)?).map(render)
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
    let items = rendered(&rows)?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

/// `GET /issues/groups`: issues grouped by (version, code), newest first,
/// with up to 50 devices per group. Groups count devices, distinct failed
/// attempts and reports across the group.
pub async fn groups(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<GroupQuery>, QueryRejection>,
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
    let mut tx = s.pool.begin().await?;
    let mut total = QueryBuilder::new("SELECT count(*) FROM (SELECT 1 FROM records i");
    // Group keys read only the issue; search is the one filter that joins.
    if !search.is_empty() {
        total.push(JOINS);
    }
    filter(&mut total, state, None, search);
    total
        .push(" GROUP BY ")
        .push(VERSION)
        .push(",")
        .push(CODE)
        .push(")");
    let total: i64 = total.build_query_scalar().fetch_one(&mut *tx).await?;
    let mut keys = QueryBuilder::new("SELECT ");
    keys.push(VERSION)
        .push(" AS version,")
        .push(CODE)
        .push(" AS code,count(DISTINCT json_extract(i.data,'$.device_id')) AS devices,count(*) AS issues,sum(")
        .push(COUNT)
        .push(") AS attempts,sum(COALESCE(")
        .push(REPORTS)
        .push(",")
        .push(COUNT)
        .push(")) AS reports,min(")
        .push(first_seen())
        .push(") AS oldest,max(")
        .push(last_seen())
        .push(") AS newest FROM records i")
        .push(JOINS);
    filter(&mut keys, state, None, search);
    keys.push(" GROUP BY version,code ORDER BY newest DESC NULLS LAST,version,code LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset);
    let keys = keys.build().fetch_all(&mut *tx).await?;
    // Up to 50 most recent member issues for every group on the page, in one
    // read: each group key is a (version, code) pair from the page above.
    let mut members: std::collections::BTreeMap<(String, String), Vec<String>> =
        std::collections::BTreeMap::new();
    if !keys.is_empty() {
        use sqlx::Row;
        let mut q = QueryBuilder::new("SELECT version,code,issue FROM (SELECT ");
        q.push(VERSION)
            .push(" AS version,")
            .push(CODE)
            .push(" AS code,");
        issue_object(&mut q);
        q.push(" AS issue,ROW_NUMBER() OVER (PARTITION BY ")
            .push(VERSION)
            .push(",")
            .push(CODE)
            .push(" ORDER BY ")
            .push(order())
            .push(") AS n FROM records i")
            .push(JOINS);
        filter(&mut q, state, None, search);
        q.push(" AND (")
            .push(VERSION)
            .push(",")
            .push(CODE)
            .push(") IN (VALUES ");
        let mut pairs = q.separated(",");
        for key in &keys {
            pairs
                .push("(")
                .push_bind_unseparated(key.get::<String, _>("version"))
                .push_unseparated(",")
                .push_bind_unseparated(key.get::<String, _>("code"))
                .push_unseparated(")");
        }
        q.push(")) WHERE n<=50 ORDER BY version,code,n");
        for row in q.build().fetch_all(&mut *tx).await? {
            members
                .entry((row.get("version"), row.get("code")))
                .or_default()
                .push(row.get("issue"));
        }
    }
    let mut items = Vec::with_capacity(keys.len());
    for key in keys {
        use sqlx::Row;
        let version: String = key.get("version");
        let code: String = key.get("code");
        let rows = members
            .remove(&(version.clone(), code.clone()))
            .unwrap_or_default();
        let devices = rendered(&rows)?;
        let first = devices.first().cloned().unwrap_or(Value::Null);
        let mut deployments: Vec<&str> = devices
            .iter()
            .filter_map(|d| d["deployment_id"].as_str())
            .collect();
        deployments.sort_unstable();
        deployments.dedup();
        let device_count = key.get::<i64, _>("devices");
        let title = match first_version_title(&code, None, &first, device_count) {
            Some(title) if device_count > 1 => json!(title),
            _ => first["title"].clone(),
        };
        items.push(json!({
            "key": db::hash(format!("{version}:{code}")),
            "code": code,
            "title": title,
            "message": first["message"],
            "diagnostics": first["diagnostics"],
            "version_id": if version.is_empty() { Value::Null } else { json!(version) },
            "version_number": first["version_number"],
            "configuration_id": first["configuration_id"],
            "configuration_name": first["configuration_name"],
            "deployment_ids": deployments,
            "device_count": device_count,
            "issue_count": key.get::<i64, _>("issues"),
            "attempts": key.get::<Option<i64>, _>("attempts").unwrap_or(0),
            "reports": key.get::<Option<i64>, _>("reports").unwrap_or(0),
            "first_seen": key.get::<Option<String>, _>("oldest"),
            "last_seen": key.get::<Option<String>, _>("newest"),
            "devices": devices,
        }));
    }
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
    let Json(input) = input.map_err(|_| ApiError::invalid("Provide the issue revision"))?;
    let reason = input.reason.as_deref().unwrap_or("").trim().to_owned();
    // An acknowledgement note is optional; reopening states why.
    if !(1..=MAX_INTEGER).contains(&input.revision)
        || (!acknowledge && reason.is_empty())
        || reason.chars().count() > 1000
        || reason.contains('\0')
    {
        return Err(ApiError::invalid(
            "Provide a current positive revision; a note is at most 1000 characters and required to reopen",
        ));
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let mut issue = db::record(&mut tx, "issue", &id).await?;
    if revision(&issue) != input.revision {
        return Err(ApiError::conflict(
            "Issue changed; review the latest occurrence and disposition",
        ));
    }
    if issue["resolved"] == true {
        return Err(ApiError::conflict(
            "Resolved issues cannot be acknowledged or reopened",
        ));
    }
    let device_id = issue["device_id"]
        .as_str()
        .ok_or_else(|| ApiError::conflict("The original device identity is unavailable"))?
        .to_owned();
    let exists: Option<bool> = sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
        .bind(&device_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::conflict(
            "The original device identity is unavailable",
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
        issue["acknowledgement_reason"] = if reason.is_empty() {
            Value::Null
        } else {
            json!(reason)
        };
    }
    db::update(&mut tx, "issue", &issue).await?;
    db::insert(&mut tx,"audit",&json!({"id":db::id(),"actor":actor["id"],"action":if acknowledge {"issue.acknowledge"} else {"issue.reopen"},"target":id,"device_id":device_id,"issue_revision":issue["revision"],"reason":if reason.is_empty() { Value::Null } else { json!(reason) },"outcome":"success","created_at":db::now()})).await?;
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

    /// A reason ends only the issues it says something about: a verified
    /// configuration says nothing of delivery or of the agent, a removed
    /// assignment says nothing of the agent, and only the device going away ends
    /// every kind.
    #[tokio::test]
    async fn a_reason_resolves_only_the_issues_it_says_something_about() {
        const DEVICE: &str = "10000000-0000-4000-8000-000000000001";
        const OTHER: &str = "10000000-0000-4000-8000-000000000002";
        for (reason, ended) in [
            ("verified", vec!["APPLY_FAILED"]),
            ("unassigned", vec!["APPLY_FAILED", "DATA_PLANE_STALLED"]),
            (
                "revoked",
                vec![
                    "AGENT_UPDATE_ROLLED_BACK",
                    "APPLY_FAILED",
                    "DATA_PLANE_STALLED",
                ],
            ),
        ] {
            let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
            sqlx::migrate!("./migrations").run(&pool).await.unwrap();
            let mut conn = pool.acquire().await.unwrap();
            for device in [DEVICE, OTHER] {
                for (code, stage) in [
                    ("APPLY_FAILED", "apply"),
                    ("DATA_PLANE_STALLED", "data_plane"),
                ] {
                    db::insert(
                        &mut conn,
                        "issue",
                        &json!({"id":db::hash(format!("{device}:{code}")),"device_id":device,"code":code,"stage":stage,"count":1,"reports":1,"first_seen":db::now(),"resolved":false,"revision":1}),
                    )
                    .await
                    .unwrap();
                }
                record_agent_update(
                    &mut conn,
                    AgentUpdateFailure {
                        device_id: device,
                        release_version: "0.1.1",
                        outcome: "rolled_back",
                        code: "UNHEALTHY",
                        rollout_id: "r1",
                    },
                )
                .await
                .unwrap();
            }
            resolve_device(&mut conn, DEVICE, reason).await.unwrap();
            let rows: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT json_extract(data,'$.device_id'),json_extract(data,'$.code'),COALESCE(json_extract(data,'$.resolved_reason'),'') FROM records WHERE kind='issue' AND json_extract(data,'$.resolved')=1 ORDER BY 2",
            )
            .fetch_all(&mut *conn)
            .await
            .unwrap();
            let got: Vec<&str> = rows.iter().map(|row| row.1.as_str()).collect();
            assert_eq!(got, ended, "{reason}: {rows:?}");
            assert!(
                rows.iter().all(|row| row.0 == DEVICE && row.2 == reason),
                "{reason}: only its own device's, by that reason: {rows:?}"
            );
        }
    }

    /// An update the device verified ends the update issues and nothing else,
    /// and says nothing to a channel.
    #[tokio::test]
    async fn a_verified_update_ends_only_the_update_issues_of_its_device() {
        const DEVICE: &str = "10000000-0000-4000-8000-000000000001";
        const OTHER: &str = "10000000-0000-4000-8000-000000000002";
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        for device in [DEVICE, OTHER] {
            for (version, outcome) in [("0.1.1", "rolled_back"), ("0.1.2", "failed")] {
                record_agent_update(
                    &mut conn,
                    AgentUpdateFailure {
                        device_id: device,
                        release_version: version,
                        outcome,
                        code: "PROBE_FAILED",
                        rollout_id: "r1",
                    },
                )
                .await
                .unwrap();
            }
        }
        db::insert(
            &mut conn,
            "issue",
            &json!({"id":db::hash("plain"),"device_id":DEVICE,"code":"APPLY_FAILED","stage":"apply","count":1,"reports":1,"first_seen":db::now(),"resolved":false,"revision":1}),
        )
        .await
        .unwrap();
        resolve_agent_update(&mut conn, DEVICE).await.unwrap();
        let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT json_extract(data,'$.device_id'),json_extract(data,'$.code'),COALESCE(json_extract(data,'$.resolved'),0),COALESCE(json_extract(data,'$.resolved_reason'),'') FROM records WHERE kind='issue' ORDER BY 1,2",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap();
        let ended: Vec<(&str, &str, i64, &str)> = rows
            .iter()
            .map(|row| (row.0.as_str(), row.1.as_str(), row.2, row.3.as_str()))
            .collect();
        assert_eq!(
            ended,
            [
                (DEVICE, "AGENT_UPDATE_FAILED", 1, "verified"),
                (DEVICE, "AGENT_UPDATE_ROLLED_BACK", 1, "verified"),
                (DEVICE, "APPLY_FAILED", 0, ""),
                (OTHER, "AGENT_UPDATE_FAILED", 0, ""),
                (OTHER, "AGENT_UPDATE_ROLLED_BACK", 0, ""),
            ]
        );
    }
}
