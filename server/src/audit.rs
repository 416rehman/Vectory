//! Bounded audit metadata. No raw audit or referenced record is deserialized.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};

fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub search: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub action: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub family: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub outcome: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub actor_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub device_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_id: Option<String>,
    /// `changes` hides sign-in activity; `security` shows only sign-in,
    /// account and signing-key events. Absent means every event.
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub scope: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub from: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub to: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    search: Option<String>,
    action: Option<String>,
    family: Option<String>,
    outcome: Option<String>,
    actor_id: Option<String>,
    device_id: Option<String>,
    target_id: Option<String>,
    scope: Option<String>,
    from: Option<String>,
    to: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
    sort: Option<String>,
    direction: Option<String>,
}

fn history_order(sort: Option<&str>, direction: Option<&str>) -> Result<&'static str> {
    // Only fixed SQL fragments can reach ORDER BY. Export keysets deliberately
    // keep their original chronological order, independent of browsing choices.
    let sort = sort.unwrap_or("created_at");
    let direction = direction.unwrap_or("desc");
    match (sort, direction) {
        ("created_at", "desc") => Ok("order_time DESC,sequence DESC"),
        ("created_at", "asc") => Ok("created_at IS NULL,order_time ASC,sequence ASC"),
        ("action", "asc") => Ok("action COLLATE NOCASE ASC,sequence DESC"),
        ("action", "desc") => Ok("action COLLATE NOCASE DESC,sequence DESC"),
        ("actor", "asc") => Ok("actor COLLATE NOCASE ASC,sequence DESC"),
        ("actor", "desc") => Ok("actor COLLATE NOCASE DESC,sequence DESC"),
        ("outcome", "asc") => Ok("outcome COLLATE NOCASE ASC,sequence DESC"),
        ("outcome", "desc") => Ok("outcome COLLATE NOCASE DESC,sequence DESC"),
        _ => Err(ApiError::invalid("Invalid audit sort or direction")),
    }
}
impl Filters {
    pub fn validate(mut self) -> Result<Self> {
        for (name, value, max) in [
            ("search", &mut self.search, 200),
            ("action", &mut self.action, 128),
            ("family", &mut self.family, 128),
            ("outcome", &mut self.outcome, 128),
            ("actor_id", &mut self.actor_id, 128),
            ("target_id", &mut self.target_id, 256),
        ] {
            if let Some(text) = value.as_mut() {
                *text = text.trim().to_owned();
                if text.chars().count() > max || text.contains('\0') {
                    return Err(ApiError::invalid(format!("Invalid {name} filter")));
                }
                if text.is_empty() {
                    *value = None;
                }
            }
        }
        for text in [&self.action, &self.family, &self.outcome]
            .into_iter()
            .flatten()
        {
            if !text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
            {
                return Err(ApiError::invalid(
                    "Invalid action, family or outcome filter",
                ));
            }
        }
        if let Some(scope) = &mut self.scope {
            *scope = scope.trim().to_owned();
            match scope.as_str() {
                "" => self.scope = None,
                "changes" | "security" => {}
                _ => return Err(ApiError::invalid("Invalid scope filter")),
            }
        }
        if self.action.is_some() && self.family.is_some() {
            return Err(ApiError::invalid("Choose action or family, not both"));
        }
        if let Some(id) = &mut self.device_id {
            let parsed = uuid::Uuid::parse_str(id)
                .map_err(|_| ApiError::invalid("device_id must be a UUID"))?;
            if id.len() != 36 || parsed.to_string() != id.to_ascii_lowercase() {
                return Err(ApiError::invalid("device_id must be a UUID"));
            }
            *id = parsed.to_string();
        }
        for value in [&mut self.from, &mut self.to] {
            if let Some(text) = value {
                let at = chrono::DateTime::parse_from_rfc3339(text)
                    .map_err(|_| ApiError::invalid("Dates must be RFC3339 UTC timestamps"))?;
                if at.offset().local_minus_utc() != 0
                    || at.timestamp_subsec_nanos() % 1_000_000 != 0
                {
                    return Err(ApiError::invalid(
                        "Dates must use UTC and at most millisecond precision",
                    ));
                }
                *text = at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            }
        }
        if let (Some(from), Some(to)) = (&self.from, &self.to) {
            if from > to {
                return Err(ApiError::invalid("from must not follow to"));
            }
        }
        Ok(self)
    }
}

fn text(path: &str, max: usize) -> String {
    format!(
        "CASE WHEN json_type(r.data,'$.{path}')='text' THEN substr(json_extract(r.data,'$.{path}'),1,{max}) ELSE NULL END"
    )
}
fn timestamp(expression: &str) -> String {
    format!(
        "CASE WHEN typeof({expression})='text' AND length({expression})<=64 AND {expression} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' THEN strftime('%Y-%m-%dT%H:%M:%fZ',{expression}) ELSE NULL END"
    )
}
fn number(path: &str) -> String {
    format!(
        "CASE WHEN json_type(r.data,'$.{path}')='integer' AND json_extract(r.data,'$.{path}') BETWEEN 0 AND 9007199254740991 THEN json_extract(r.data,'$.{path}') ELSE NULL END"
    )
}
fn flag(path: &str) -> String {
    format!(
        "CASE json_type(r.data,'$.{path}') WHEN 'true' THEN json('true') WHEN 'false' THEN json('false') ELSE NULL END"
    )
}
fn uuid_sql(expression: &str) -> String {
    format!(
        "(length({expression})=36 AND substr({expression},9,1)='-' AND substr({expression},14,1)='-' AND substr({expression},19,1)='-' AND substr({expression},24,1)='-' AND length(replace({expression},'-',''))=32 AND replace({expression},'-','') NOT GLOB '*[^0-9a-f]*')"
    )
}
fn compound_sql(expression: &str) -> String {
    format!(
        "(length({expression})=73 AND substr({expression},37,1)=':' AND {} AND {})",
        uuid_sql(&format!("substr({expression},1,36)")),
        uuid_sql(&format!("substr({expression},38,36)"))
    )
}
fn digest(path: &str) -> String {
    let t = text(path, 65);
    format!("CASE WHEN length({t})=64 AND {t} NOT GLOB '*[^0-9a-f]*' THEN {t} ELSE NULL END")
}

// The CTEs are flattened by SQLite. Only the final allowlisted JSON projection
// crosses into Rust; neither names maps nor full referenced payloads are loaded.
fn base(details: bool) -> String {
    let extras = if details {
        format!(
            ",json_object('reason',{},'issue_revision',{},'previous_group_revision',{},'group_revision',{},'secret_revision',{},'previous_secret_revision',{},'actual_sha256',{},'applied_template_sha256',{},'device_id',{},'previous_generation',{},'generation',{},'previous_policy_generation',{},'policy_generation',{},'secret_revision_floor',{},'version_id',{},'sha256',{},'policy_sha256',{},'browser_sessions',{},'password_reset_codes',{},'enrollment_tokens_to_revoke',{},'mfa_recovery_codes',{},'reason_code',{},'name',{},'token_id',{},'agent_os',{},'agent_arch',{},'agent_version',{},'configuration_mode',{},'client_address',{},'summary',{},'tests_failed',{},'tests_failed_count',{},'tests_refused_count',{},'tests_not_run_count',{},'tests_passed_count',{},'stage',{},'gate_state',{},'released_count',{},'verified_count',{},'measuring_count',{},'next_released_count',{},'validation_id',{},'configuration_id',{},'run_tests',{},'truncated',{},'device_count',{},'pending_count',{},'offline_count',{},'unsupported_count',{}) AS extra",
            text("reason", 1000),
            number("issue_revision"),
            number("previous_group_revision"),
            number("group_revision"),
            number("secret_revision"),
            number("previous_secret_revision"),
            digest("actual_sha256"),
            digest("applied_template_sha256"),
            text("details.device_id", 128),
            number("details.previous_generation"),
            number("details.generation"),
            number("details.previous_policy_generation"),
            number("details.policy_generation"),
            number("details.secret_revision_floor"),
            text("details.version_id", 128),
            digest("details.sha256"),
            digest("details.policy_sha256"),
            number("details.browser_sessions"),
            number("details.password_reset_codes"),
            number("details.enrollment_tokens_to_revoke"),
            number("details.mfa_recovery_codes"),
            text("details.reason_code", 64),
            text("details.name", 100),
            text("details.token_id", 128),
            text("details.agent_os", 64),
            text("details.agent_arch", 64),
            text("details.agent_version", 64),
            text("details.configuration_mode", 16),
            text("details.client_address", 64),
            text("details.summary", 500),
            flag("details.tests_failed"),
            number("details.tests_failed_count"),
            number("details.tests_refused_count"),
            number("details.tests_not_run_count"),
            number("details.tests_passed_count"),
            text("details.stage", 32),
            text("details.gate_state", 32),
            number("details.released_count"),
            number("details.verified_count"),
            number("details.measuring_count"),
            number("details.next_released_count"),
            text("details.validation_id", 36),
            text("details.configuration_id", 128),
            flag("details.run_tests"),
            flag("details.truncated"),
            number("details.device_count"),
            number("details.pending_count"),
            number("details.offline_count"),
            number("details.unsupported_count")
        )
    } else {
        String::new()
    };
    let compound = compound_sql("target");
    let a_compound = compound_sql("a.target");
    // An issue record keeps no title: it is built from the issue's code, as the
    // issue list builds it, so an event names the issue as people read it.
    let issue_title = crate::issues::title_sql("other");
    // Version/revision references resolve through their immutable parent ID. A
    // missing parent retains that historical identity, but is not linkable.
    let parent = "CASE WHEN json_type(v.data,'$.configuration_id')='text' THEN substr(json_extract(v.data,'$.configuration_id'),1,128) WHEN json_type(rv.data,'$.configuration_id')='text' THEN substr(json_extract(rv.data,'$.configuration_id'),1,128) ELSE NULL END";
    let configuration_target = format!(
        "CASE WHEN v.id IS NOT NULL OR rv.id IS NOT NULL THEN {parent} ELSE a.linked_target END"
    );
    format!(
        "WITH raw AS (
            SELECT s.sequence,s.created_at AS order_time,substr(r.id,1,128) AS id,
                COALESCE({},'unknown') AS actor_id,COALESCE({},'unknown') AS action,
                COALESCE({},'') AS target,COALESCE({},'unknown') AS outcome,
                {} AS explicit_device,{} AS request_id,{} AS created_at,{} AS detail_name {extras}
            FROM audit_sequence s CROSS JOIN records r ON r.kind='audit' AND r.id=s.audit_id
        ), classified AS (
            SELECT raw.*,
                CASE WHEN action='deployment.release' AND {compound} THEN substr(target,1,36)
                     WHEN action='device.recovery_complete' AND {compound} THEN substr(target,38,36)
                     ELSE target END AS linked_target,
                CASE WHEN action LIKE 'configuration.%' OR action='deployment.device_validation_requested' THEN 'configuration'
                     WHEN action LIKE 'deployment.%' THEN 'deployment'
                     WHEN action LIKE 'device.%' OR action='server.restore_generation_fence' THEN 'device'
                     WHEN action LIKE 'issue.%' THEN 'issue' WHEN action LIKE 'group.%' THEN 'group'
                     WHEN action LIKE 'policy.%' THEN 'policy' WHEN action LIKE 'token.%' THEN 'token'
                     WHEN action LIKE 'signing.%' THEN 'signing_key' WHEN action LIKE 'server.%' THEN 'server'
                     WHEN action IN ('bootstrap','login','logout') OR action LIKE 'user.%' OR action LIKE 'account.%' OR action LIKE 'mfa.%' THEN 'user'
                     ELSE 'unknown' END AS target_kind
            FROM raw
        ), named AS (
            SELECT a.*,COALESCE(substr(au.name,1,120),substr(ad.name,1,256),
                    CASE WHEN json_type(atk.data,'$.name')='text' THEN substr(json_extract(atk.data,'$.name'),1,120) END,a.actor_id) AS actor,
                CASE WHEN au.id IS NOT NULL THEN 'user' WHEN ad.id IS NOT NULL THEN 'device'
                     WHEN a.actor_id IN ('anonymous','scheduler','local-admin') THEN 'system' ELSE 'unknown' END AS actor_kind,
                CASE WHEN a.target_kind='unknown' OR a.linked_target='' THEN NULL
                     WHEN a.target_kind='configuration' THEN {configuration_target}
                     ELSE a.linked_target END AS target_id,
                CASE a.target_kind WHEN 'configuration' THEN c.id IS NOT NULL
                     WHEN 'user' THEN tu.id IS NOT NULL WHEN 'device' THEN td.id IS NOT NULL
                     WHEN 'token' THEN et.id IS NOT NULL
                     WHEN 'deployment' THEN other.id IS NOT NULL WHEN 'group' THEN other.id IS NOT NULL
                     WHEN 'policy' THEN other.id IS NOT NULL WHEN 'issue' THEN other.id IS NOT NULL
                     ELSE 0 END AS target_exists,
                COALESCE(substr(tu.name,1,120),substr(td.name,1,256),
                    CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,120) END,
                    CASE WHEN json_type(other.data,'$.name')='text' THEN substr(json_extract(other.data,'$.name'),1,120) END,
                    CASE WHEN a.target_kind='issue' AND other.id IS NOT NULL THEN substr({issue_title},1,120)||CASE WHEN idv.id IS NOT NULL THEN ' on '||substr(idv.name,1,100) ELSE '' END END,
                    CASE WHEN json_type(et.data,'$.name')='text' THEN substr(json_extract(et.data,'$.name'),1,120) END,
                    CASE WHEN json_type(dc.data,'$.name')='text' THEN substr(json_extract(dc.data,'$.name'),1,120)||CASE WHEN json_type(dv.data,'$.number')='integer' THEN ' v'||json_extract(dv.data,'$.number') ELSE '' END END,
                    CASE WHEN json_type(dp.data,'$.name')='text' THEN 'Agent settings: '||substr(json_extract(dp.data,'$.name'),1,100) END,
                    CASE WHEN a.target_kind='deployment' AND json_type(other.data,'$.policy')='object' THEN 'Agent settings' END,
                    CASE WHEN a.action LIKE 'notification.channel.%' THEN a.detail_name
                         WHEN a.action='detection.update' THEN 'Detection thresholds' END) AS target_name,
                CASE WHEN length(a.explicit_device)=36 THEN a.explicit_device
                     WHEN a.action='deployment.release' AND {a_compound} THEN substr(a.target,38,36)
                     WHEN a.target_kind='device' AND length(a.linked_target)=36 THEN a.linked_target
                     WHEN ad.id IS NOT NULL THEN ad.id ELSE NULL END AS device_id
            FROM classified a
            LEFT JOIN users au ON au.id=a.actor_id LEFT JOIN devices ad ON ad.id=a.actor_id
            LEFT JOIN enrollment_tokens atk ON atk.id=a.actor_id
            LEFT JOIN users tu ON tu.id=a.linked_target LEFT JOIN devices td ON td.id=a.linked_target
            LEFT JOIN records v ON v.kind='version' AND v.id=a.target
            LEFT JOIN records rv ON rv.kind='revision' AND rv.id=a.target
            LEFT JOIN records c ON c.kind='configuration' AND c.id={configuration_target}
            LEFT JOIN records other ON other.kind=a.target_kind AND other.id=a.linked_target
            LEFT JOIN enrollment_tokens et ON a.target_kind='token' AND et.id=a.linked_target
            LEFT JOIN devices idv ON a.target_kind='issue' AND idv.id=json_extract(other.data,'$.device_id')
            LEFT JOIN records dv ON a.target_kind='deployment' AND dv.kind='version' AND dv.id=json_extract(other.data,'$.version_id')
            LEFT JOIN records dc ON a.target_kind='deployment' AND dc.kind='configuration' AND dc.id=json_extract(dv.data,'$.configuration_id')
            LEFT JOIN records dp ON a.target_kind='deployment' AND dp.kind='policy' AND dp.id=json_extract(other.data,'$.policy_id')
        )",
        text("actor", 128),
        text("action", 128),
        text("target", 256),
        text("outcome", 128),
        format!(
            "CASE WHEN {} THEN {} WHEN json_extract(r.data,'$.action')='server.restore_generation_fence' AND {} THEN {} ELSE NULL END",
            uuid_sql(&text("device_id", 128)),
            text("device_id", 128),
            uuid_sql(&text("details.device_id", 128)),
            text("details.device_id", 128)
        ),
        text("request_id", 128),
        timestamp("s.created_at"),
        // Notification channels are named in their own audit details.
        text("details.name", 120)
    )
}
fn filter(q: &mut QueryBuilder<'_, Sqlite>, f: &Filters, cutoff: Option<i64>) {
    q.push(" WHERE 1=1");
    if let Some(n) = cutoff {
        q.push(" AND sequence<=").push_bind(n);
    }
    for (column, value) in [
        ("action", &f.action),
        ("outcome", &f.outcome),
        ("actor_id", &f.actor_id),
    ] {
        if let Some(value) = value {
            q.push(" AND ")
                .push(column)
                .push("=")
                .push_bind(value.clone());
        }
    }
    match f.scope.as_deref() {
        Some("changes") => {
            q.push(" AND NOT (action IN ('login','logout') OR substr(action,1,6)='login.')");
        }
        Some("security") => {
            q.push(" AND (action IN ('bootstrap','login','logout') OR substr(action,1,6)='login.' OR substr(action,1,8)='account.' OR substr(action,1,5)='user.' OR substr(action,1,4)='mfa.' OR substr(action,1,8)='signing.' OR substr(action,1,22)='server.restore_access.')");
        }
        _ => {}
    }
    if let Some(family) = &f.family {
        q.push(" AND (action=")
            .push_bind(family.clone())
            .push(" OR substr(action,1,")
            .push_bind(family.len() as i64 + 1)
            .push(")=")
            .push_bind(format!("{family}."))
            .push(")");
    }
    if let Some(id) = &f.target_id {
        q.push(" AND (target=")
            .push_bind(id.clone())
            .push(" OR target_id=")
            .push_bind(id.clone())
            .push(")");
    }
    let compound = compound_sql("target");
    if let Some(id) = &f.device_id {
        q.push(" AND (target=")
            .push_bind(id.clone())
            .push(" OR actor_id=")
            .push_bind(id.clone())
            .push(" OR explicit_device=")
            .push_bind(id.clone())
            .push(" OR (action='deployment.release' AND ")
            .push(&compound)
            .push(" AND substr(target,38,36)=")
            .push_bind(id.clone())
            .push(") OR (action='device.recovery_complete' AND ")
            .push(&compound)
            .push(" AND (substr(target,1,36)=")
            .push_bind(id.clone())
            .push(" OR substr(target,38,36)=")
            .push_bind(id.clone())
            .push(")))");
    }
    if let Some(from) = &f.from {
        q.push(" AND created_at>=").push_bind(from.clone());
    }
    if let Some(to) = &f.to {
        q.push(" AND created_at<=").push_bind(to.clone());
    }
    if let Some(search) = &f.search {
        q.push(" AND instr(lower(actor||' '||actor_id||' '||action||' '||replace(replace(action,'.',' '),'_',' ')||' '||target||' '||COALESCE(target_name,'')||' '||outcome),lower(").push_bind(search.clone()).push("))>0");
    }
}
const SUMMARY: &str = "json_object('id',id,'actor_id',actor_id,'actor',actor,'actor_kind',actor_kind,'action',action,'target',target,'target_id',target_id,'target_kind',target_kind,'target_exists',json(CASE WHEN target_exists THEN 'true' ELSE 'false' END),'target_name',target_name,'device_id',device_id,'device_name',(SELECT substr(dn.name,1,256) FROM devices dn WHERE dn.id=named.device_id),'outcome',outcome,'created_at',created_at,'request_id',request_id)";
pub(crate) async fn count(
    conn: &mut SqliteConnection,
    f: &Filters,
    cutoff: Option<i64>,
) -> Result<i64> {
    let mut q = QueryBuilder::new(base(false));
    q.push(" SELECT count(*) FROM named");
    filter(&mut q, f, cutoff);
    Ok(q.build_query_scalar().fetch_one(conn).await?)
}
/// Where someone connected from is for the people who run devices and
/// accounts: viewers read every event without its client address.
pub(crate) fn for_reader(mut event: Value, reader: &Value) -> Value {
    if reader["role"] == "viewer" {
        if let Some(details) = event["details"].as_object_mut() {
            details.remove("client_address");
        }
    }
    event
}
pub(crate) async fn legacy(conn: &mut SqliteConnection, size: i64) -> Result<Vec<Value>> {
    let records = rows(conn, &Filters::default(), size, 0, None, None, true).await?;
    Ok(records
        .into_iter()
        .map(|(mut v, _)| {
            let action = v["action"].as_str().unwrap_or("").to_owned();
            if action.starts_with("issue.") || action == "device.secret_reconciliation" {
                let details = v["details"].as_object().cloned().unwrap_or_default();
                v.as_object_mut().unwrap().extend(details);
            }
            v
        })
        .collect())
}
pub(crate) struct Cursor {
    pub sequence: i64,
}
pub(crate) async fn rows(
    conn: &mut SqliteConnection,
    f: &Filters,
    size: i64,
    offset: i64,
    cutoff: Option<i64>,
    cursor: Option<&Cursor>,
    detail: bool,
) -> Result<Vec<(Value, Cursor)>> {
    ordered_rows(
        conn,
        f,
        size,
        offset,
        cutoff,
        cursor,
        detail,
        "order_time DESC,sequence DESC",
    )
    .await
}

async fn ordered_rows(
    conn: &mut SqliteConnection,
    f: &Filters,
    size: i64,
    offset: i64,
    cutoff: Option<i64>,
    cursor: Option<&Cursor>,
    detail: bool,
    order: &'static str,
) -> Result<Vec<(Value, Cursor)>> {
    let mut q = QueryBuilder::new(base(detail));
    q.push(" SELECT ")
        .push(SUMMARY)
        .push(" AS summary,sequence");
    if detail {
        q.push(",extra");
    }
    q.push(" FROM named");
    filter(&mut q, f, cutoff);
    if let Some(cursor) = cursor {
        q.push(
            " AND (order_time,sequence)<((SELECT created_at FROM audit_sequence WHERE sequence=",
        )
        .push_bind(cursor.sequence)
        .push("),")
        .push_bind(cursor.sequence)
        .push(")");
    }
    q.push(" ORDER BY ")
        .push(order)
        .push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset);
    let records = q.build().fetch_all(conn).await?;
    records
        .iter()
        .map(|r| {
            let mut v = db::parse(r.get("summary"))?;
            if detail {
                let extra = db::parse(r.get("extra"))?;
                v["details"] = details(&v, &extra);
            }
            Ok((
                v,
                Cursor {
                    sequence: r.get("sequence"),
                },
            ))
        })
        .collect()
}
fn details(v: &Value, extra: &Value) -> Value {
    let mut out = json!({});
    let action = v["action"].as_str().unwrap_or("");
    let keys: &[&str] = match action {
        "issue.acknowledge" | "issue.reopen" => &["reason", "issue_revision"],
        "group.update" => &["previous_group_revision", "group_revision"],
        "device.secret_reconciliation" => &[
            "secret_revision",
            "previous_secret_revision",
            "actual_sha256",
            "applied_template_sha256",
        ],
        "server.restore_generation_fence" => &[
            "device_id",
            "previous_generation",
            "generation",
            "previous_policy_generation",
            "policy_generation",
            "secret_revision_floor",
            "version_id",
            "sha256",
            "policy_sha256",
        ],
        "server.restore_access.invalidate" => &[
            "browser_sessions",
            "password_reset_codes",
            "enrollment_tokens_to_revoke",
            "mfa_recovery_codes",
        ],
        // Written by notifications and detection: a name and a change summary
        // built from secret-free settings (never a URL path or credential).
        "notification.channel.create"
        | "notification.channel.update"
        | "notification.channel.delete"
        | "notification.channel.test" => &["name", "summary"],
        "detection.update" => &["summary"],
        // The stage that was released early, what the gate showed then, and how
        // many devices it released.
        "deployment.stage_released_early" => &[
            "summary",
            "stage",
            "gate_state",
            "released_count",
            "verified_count",
            "measuring_count",
            "next_released_count",
        ],
        // A check on devices: which pipeline version, and counts of devices
        // by what happened to each at the request. Never the configuration.
        "deployment.device_validation_requested" => &[
            "validation_id",
            "configuration_id",
            "version_id",
            "run_tests",
            "truncated",
            "device_count",
            "pending_count",
            "offline_count",
            "unsupported_count",
        ],
        // Published over failing tests: the counts and one sentence, never a
        // test's name or body.
        "configuration.publish" => &[
            "tests_failed",
            "tests_failed_count",
            "tests_refused_count",
            "tests_not_run_count",
            "tests_passed_count",
            "summary",
        ],
        // The one row a minute says how many refusals the shared budget left out.
        "device.enroll_refusals_summarized" => &["summary"],
        // Written by the enrollment endpoint from bounded, secret-free fields.
        "device.enroll" => &[
            "reason_code",
            "name",
            "token_id",
            "agent_os",
            "agent_arch",
            "agent_version",
            "configuration_mode",
            "client_address",
        ],
        _ => &[],
    };
    for key in keys {
        if !extra[*key].is_null() {
            out[*key] = extra[*key].clone();
        }
    }
    let target = v["target"].as_str().unwrap_or("");
    if let Some((left, right)) = target.split_once(':') {
        if uuid::Uuid::parse_str(left).is_ok() && uuid::Uuid::parse_str(right).is_ok() {
            match action {
                "deployment.release" => {
                    out["deployment_id"] = json!(left);
                    out["device_id"] = json!(right);
                }
                "device.recovery_complete" => {
                    out["previous_device_id"] = json!(left);
                    out["replacement_device_id"] = json!(right);
                }
                _ => {}
            }
        }
        if action == "signing.rotate.prepare"
            && [left, right]
                .iter()
                .all(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            out["previous_signing_key_id"] = json!(left);
            out["signing_key_id"] = json!(right);
        }
    }
    out
}
pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let q = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (_, page, size, offset) = crate::deployment_history::bounds(None, q.page, q.page_size)?;
    let order = history_order(q.sort.as_deref(), q.direction.as_deref())?;
    let f = Filters {
        search: q.search,
        action: q.action,
        family: q.family,
        outcome: q.outcome,
        actor_id: q.actor_id,
        device_id: q.device_id,
        target_id: q.target_id,
        scope: q.scope,
        from: q.from,
        to: q.to,
    }
    .validate()?;
    let mut tx = s.pool.begin().await?;
    let total = count(&mut tx, &f, None).await?;
    let items = ordered_rows(&mut tx, &f, size, offset, None, None, false, order)
        .await?
        .into_iter()
        .map(|(v, _)| v)
        .collect::<Vec<_>>();
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
    let reader = auth::authorize(&s, &h, &[], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let mut q = QueryBuilder::new(base(true));
    q.push(" SELECT ")
        .push(SUMMARY)
        .push(" AS summary,extra FROM named WHERE id=")
        .push_bind(id);
    let r = q
        .build()
        .fetch_optional(&s.pool)
        .await?
        .ok_or_else(ApiError::missing)?;
    let mut v = db::parse(r.get("summary"))?;
    v["details"] = details(&v, &db::parse(r.get("extra"))?);
    Ok(Json(for_reader(v, &reader)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn audit_page_order_uses_durable_time_sequence_index() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (detail, condition, limit) in [
            (false, "", 12),
            (
                true,
                " WHERE action='issue.acknowledge' AND sequence<=20000",
                100,
            ),
            (
                true,
                " WHERE action='issue.acknowledge' AND sequence<=20000 AND (order_time,sequence)<((SELECT created_at FROM audit_sequence WHERE sequence=10000),10000)",
                100,
            ),
        ] {
            let sql = format!(
                "EXPLAIN QUERY PLAN {} SELECT {}{} FROM named {} ORDER BY order_time DESC,sequence DESC LIMIT {}",
                base(detail),
                SUMMARY,
                if detail { ",extra" } else { "" },
                condition,
                limit
            );
            let plan = sqlx::query(&sql)
                .fetch_all(&pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(plan.contains("audit_sequence_recent"), "{plan}");
            assert!(!plan.contains("TEMP B-TREE FOR ORDER BY"), "{plan}");
        }
    }
}
