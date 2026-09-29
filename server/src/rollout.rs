use crate::{
    State, db,
    error::{ApiError, Result},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn ids(v: &Value, k: &str) -> Result<Vec<String>> {
    let a = v[k]
        .as_array()
        .ok_or_else(|| ApiError::invalid(format!("selector.{k} must be an array")))?;
    if a.len() > 10000 {
        return Err(ApiError::invalid("Too many targets"));
    }
    a.iter()
        .map(|x| {
            x.as_str()
                .filter(|s| s.len() <= 64)
                .map(str::to_owned)
                .ok_or_else(|| ApiError::invalid("Invalid target ID"))
        })
        .collect()
}
pub async fn select(db: &mut SqliteConnection, selector: &Value) -> Result<BTreeSet<String>> {
    select_impl(db, selector, true).await
}
async fn select_impl(
    db: &mut SqliteConnection,
    selector: &Value,
    strict: bool,
) -> Result<BTreeSet<String>> {
    let mut selected: BTreeSet<String> = ids(selector, "device_ids")?.into_iter().collect();
    for group in ids(selector, "group_ids")? {
        let g = db::record(db, "group", &group).await?;
        selected.extend(
            g["device_ids"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Invalid group"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned),
        );
    }
    for excluded in ids(selector, "exclude_ids")? {
        selected.remove(&excluded);
    }
    let mut unavailable = Vec::new();
    for id in &selected {
        let found: i64 =
            sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=? AND revoked=0")
                .bind(id)
                .fetch_one(&mut *db)
                .await?;
        if found != 1 {
            if strict {
                return Err(ApiError::invalid(
                    "Selector contains an unknown or revoked device",
                ));
            }
            unavailable.push(id.clone());
        }
    }
    for id in unavailable {
        selected.remove(&id);
    }
    Ok(selected)
}
/// Seconds an agent may currently take between check-ins. Until it acknowledges
/// the current policy it may still use the interval it had before, so the larger
/// of the two decides whether it is late. Never trust a shortened interval early.
pub(crate) fn check_in_seconds(policy: &Value, data: &Value, policy_generation: i64) -> i64 {
    let current = policy["heartbeat_seconds"]
        .as_i64()
        .unwrap_or(60)
        .clamp(10, 3600);
    let acknowledged = data["policy_generation"]
        .as_i64()
        .is_some_and(|reported| reported >= policy_generation);
    if acknowledged {
        current
    } else {
        current.max(
            data["heartbeat_floor_seconds"]
                .as_i64()
                .unwrap_or(60)
                .clamp(10, 3600),
        )
    }
}
/// A device is late after three missed check-ins. A device that has never
/// checked in is not late: it is waiting for its first check-in.
pub(crate) fn checked_in_recently(last_seen: Option<&str>, interval: i64) -> bool {
    last_seen
        .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| {
            let age = Utc::now().signed_duration_since(at).num_seconds();
            age <= interval * 3
        })
}
// Display metadata for every assignment and version that the device list
// references, read in two statements instead of one lookup per device.
async fn projection_metadata(
    db: &mut SqliteConnection,
) -> Result<(
    std::collections::HashMap<String, Value>,
    std::collections::HashMap<String, Value>,
)> {
    let assignments: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.id,json_object('priority',json_extract(r.data,'$.priority'),'target_mode',json_extract(r.data,'$.target_mode'),'status',json_extract(r.data,'$.status'),\
         'name',CASE WHEN json_type(r.data,'$.name')='text' THEN substr(json_extract(r.data,'$.name'),1,120) END,\
         'version_id',CASE WHEN json_type(r.data,'$.version_id')='text' THEN json_extract(r.data,'$.version_id') END,\
         'policy_id',CASE WHEN json_type(r.data,'$.policy_id')='text' THEN json_extract(r.data,'$.policy_id') END,\
         'policy_name',(SELECT substr(json_extract(p.data,'$.name'),1,120) FROM records p WHERE p.kind='policy' AND p.id=json_extract(r.data,'$.policy_id')),\
         'created_at',r.created_at,\
         'created_by_name',(SELECT substr(u.name,1,120) FROM users u WHERE u.id=COALESCE(json_extract(r.data,'$.created_by'),(SELECT json_extract(a.data,'$.actor') FROM records a WHERE a.kind='audit' AND json_extract(a.data,'$.target')=r.id AND json_extract(a.data,'$.action') IN ('deployment.create','deployment.schedule') LIMIT 1))))\
         FROM records r WHERE r.kind='deployment' AND r.id IN (SELECT assignment_id FROM devices WHERE assignment_id IS NOT NULL UNION SELECT policy_assignment_id FROM devices WHERE policy_assignment_id IS NOT NULL)",
    )
    .fetch_all(&mut *db)
    .await?;
    let versions: Vec<(String, String)> = sqlx::query_as(
        "SELECT v.id,json_object('sha256',json_extract(v.data,'$.sha256'),'uses_local_secrets',json(CASE WHEN json_extract(v.data,'$.uses_local_secrets')=1 THEN 'true' ELSE 'false' END),\
         'number',CASE WHEN json_type(v.data,'$.number')='integer' THEN json_extract(v.data,'$.number') END,\
         'configuration_id',json_extract(v.data,'$.configuration_id'),\
         'configuration_name',CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) END)\
         FROM records v LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')\
         WHERE v.kind='version' AND v.id IN (SELECT desired_version_id FROM devices WHERE desired_version_id IS NOT NULL UNION SELECT json_extract(data,'$.verified_configuration_attempt.version_id') FROM devices WHERE json_type(data,'$.verified_configuration_attempt.version_id')='text')",
    )
    .fetch_all(&mut *db)
    .await?;
    let parse = |rows: Vec<(String, String)>| {
        rows.into_iter()
            .map(|(id, value)| Ok((id, db::parse(&value)?)))
            .collect::<Result<std::collections::HashMap<_, _>>>()
    };
    Ok((parse(assignments)?, parse(versions)?))
}
fn version_label(versions: &std::collections::HashMap<String, Value>, id: &str) -> Value {
    let version = versions.get(id);
    json!({"id":id,"number":version.map(|v| v["number"].clone()),"configuration_id":version.map(|v| v["configuration_id"].clone()),"configuration_name":version.map(|v| v["configuration_name"].clone())})
}
pub async fn devices(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM devices ORDER BY name")
        .fetch_all(&mut *db)
        .await?;
    let (assignments, versions) = projection_metadata(db).await?;
    let mut out = Vec::new();
    for row in rows {
        let mut d = db::parse(row.get("data"))?;
        // The last verified candidate is what the host runs, even after a
        // later failure restored it or the assignment was removed.
        let running = d["verified_configuration_attempt"].clone();
        d["running_version"] = match running["version_id"].as_str() {
            Some(id) => {
                let mut label = version_label(&versions, id);
                label["generation"] = running["generation"].clone();
                label
            }
            None => Value::Null,
        };
        d.as_object_mut()
            .unwrap()
            .remove("verified_configuration_attempt");
        d.as_object_mut()
            .unwrap()
            .remove("terminal_configuration_attempt");
        d.as_object_mut().unwrap().remove("heartbeat_floor_seconds");
        d["retry_preconditions"] = json!(true);
        if d["configuration_mode"] != "full" {
            d["configuration_mode"] = json!("restricted");
        }
        d["desired_generation"] = json!(row.get::<i64, _>("desired_generation"));
        d["desired_version_id"] = json!(row.get::<Option<String>, _>("desired_version_id"));
        let attempt_matches = d["configuration_attempt"].is_object()
            && d["configuration_attempt"]["generation"] == d["desired_generation"]
            && d["configuration_attempt"]["version_id"] == d["desired_version_id"];
        if !attempt_matches {
            d.as_object_mut().unwrap().remove("configuration_attempt");
        }
        if !d["desired_version_id"].is_null()
            && !attempt_matches
            && d["reported_generation"] != d["desired_generation"]
        {
            if d["reported_apply_state"].is_null() {
                d["reported_apply_state"] = d["apply_state"].clone();
            }
            d["apply_state"] = json!("desired");
        }
        let policy = db::parse(row.get("policy"))?;
        let interval = check_in_seconds(&policy, &d, row.get("policy_generation"));
        d["effective_policy"] = policy.clone();
        d["sync_paused"] = policy["sync_paused"].clone();
        d["check_in_seconds"] = json!(interval);
        d["desired_version"] = match d["desired_version_id"].as_str() {
            Some(id) => version_label(&versions, id),
            None => Value::Null,
        };
        let revoked: bool = row.get("revoked");
        let mut verified_current = false;
        if d["apply_state"] == "verified_applied"
            && d["reported_generation"] == d["desired_generation"]
        {
            if let Some(metadata) = d["desired_version_id"]
                .as_str()
                .and_then(|version| versions.get(version))
            {
                if let Some(sha) = metadata["sha256"].as_str() {
                    let expected_sha = d["desired_artifact_sha256"].as_str().unwrap_or(sha);
                    verified_current = if metadata["uses_local_secrets"] == true {
                        d["applied_template_sha256"].as_str() == Some(expected_sha)
                            && d["actual_sha256"].as_str().is_some_and(|actual| {
                                actual.len() == 64
                                    && d["verified_effective_sha256"].as_str() == Some(actual)
                            })
                            && d["verified_secret_revision"].as_u64().unwrap_or(0) >= 1
                    } else {
                        d["actual_sha256"].as_str() == Some(expected_sha)
                    };
                }
            }
        }
        let never_seen = d["last_seen"].as_str().is_none();
        let online = checked_in_recently(d["last_seen"].as_str(), interval);
        d["status"] = json!(if revoked {
            "revoked"
        } else if never_seen {
            "awaiting_first_check_in"
        } else if !online {
            "offline"
        } else if policy["sync_paused"] == true || d["local_paused"] == true {
            "paused"
        } else if d["desired_version_id"].is_null() {
            "unmanaged"
        } else {
            match text(&d, "apply_state") {
                "verified_applied" if verified_current => "verified",
                "failed" => "failed",
                "verification_unknown" => "verification_unknown",
                "rolled_back" => "rolled_back",
                _ => "applying",
            }
        });
        // Assignment metadata comes from the control plane, never device-reported data.
        for (field, column) in [
            ("assignment", "assignment_id"),
            ("policy_assignment", "policy_assignment_id"),
        ] {
            d.as_object_mut().unwrap().remove(field);
            if let Some(assignment) = row.get::<Option<String>, _>(column) {
                if let Some(a) = assignments.get(&assignment) {
                    let resource = if a["version_id"].is_string() {
                        "configuration"
                    } else {
                        "policy"
                    };
                    d[field] = json!({"id":assignment,"priority":a["priority"],"reason":format!("{} assignment; current resolved {resource}",text(a,"target_mode")),
                        "name":a["name"],"target_mode":a["target_mode"],"status":a["status"],"policy_id":a["policy_id"],"policy_name":a["policy_name"],
                        "created_at":a["created_at"],"created_by_name":a["created_by_name"]});
                }
            }
        }
        d["desired_sha256"] = d["desired_artifact_sha256"].clone();
        d.as_object_mut().unwrap().remove("desired_artifact_sha256");
        out.push(d);
    }
    Ok(out)
}
pub async fn targets(db: &mut SqliteConnection, id: &str) -> Result<Vec<Value>> {
    let rows=sqlx::query("SELECT device_id,state,generation,error,original FROM deployment_targets WHERE deployment_id=? ORDER BY device_id").bind(id).fetch_all(db).await?;
    Ok(rows.iter().map(|r|json!({"device_id":r.get::<String,_>("device_id"),"state":r.get::<String,_>("state"),"generation":r.get::<i64,_>("generation"),"error":r.get::<Option<String>,_>("error"),"original":r.get::<bool,_>("original")})).collect())
}
pub async fn deployment(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let mut v = db::record(db, "deployment", id).await?;
    v.as_object_mut().unwrap().remove("observation_evidence");
    v.as_object_mut().unwrap().remove("target_refresh_revision");
    v.as_object_mut().unwrap().remove("variable_bindings");
    v.as_object_mut().unwrap().remove("rollback_artifacts");
    v["targets"] = json!(targets(db, id).await?);
    v["rollback_idempotency"] = json!(true);
    v["rollback_review"] = json!(true);
    v["request_correlation"] = json!(true);
    Ok(v)
}
pub async fn deployments(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let mut a = db::records(db, "deployment").await?;
    for v in &mut a {
        v.as_object_mut().unwrap().remove("observation_evidence");
        v.as_object_mut().unwrap().remove("target_refresh_revision");
        v.as_object_mut().unwrap().remove("variable_bindings");
        v.as_object_mut().unwrap().remove("rollback_artifacts");
        v["targets"] = json!(targets(db, text(v, "id")).await?);
        v["rollback_idempotency"] = json!(true);
        v["rollback_review"] = json!(true);
        v["request_correlation"] = json!(true);
    }
    Ok(a)
}
fn kind(v: &Value) -> &str {
    if v["version_id"].is_string() {
        "configuration"
    } else {
        "policy"
    }
}

// This is only the portion of the local policy that can be known from a
// published document. File roots, network destinations, platform resources,
// credentials and actual Vector validation remain the device's decision.
fn requires_full_mode(config: &Value) -> bool {
    if !config.is_object() {
        // Legacy test/import records may lack the original configuration.
        return false;
    }
    static RESTRICTED_COMPONENTS: OnceLock<BTreeSet<(String, String)>> = OnceLock::new();
    let allowed = RESTRICTED_COMPONENTS.get_or_init(|| {
        let catalog: Value =
            serde_json::from_str(include_str!("../../vector-catalog/catalog.json"))
                .expect("pinned Vector component catalog must be JSON");
        catalog["components"]
            .as_array()
            .expect("pinned Vector component catalog must have components")
            .iter()
            .filter(|component| component["device_capability"] == "allowed")
            .filter_map(|component| {
                Some((
                    component["kind"].as_str()?.to_owned(),
                    component["type"].as_str()?.to_owned(),
                ))
            })
            .collect()
    });
    let restricted_roots = [
        "sources",
        "transforms",
        "sinks",
        "data_dir",
        "api",
        "acknowledgements",
        "healthchecks",
        "timezone",
    ];
    if config.as_object().is_some_and(|fields| {
        fields
            .keys()
            .any(|key| !restricted_roots.contains(&key.as_str()))
    }) {
        return true;
    }
    for section in ["sources", "transforms", "sinks"] {
        if let Some(components) = config[section].as_object() {
            for component in components.values() {
                let Some(typ) = component["type"].as_str() else {
                    return true;
                };
                if !allowed.contains(&(section.to_owned(), typ.to_owned()))
                    || (typ == "console" && component["target"] != "stderr")
                {
                    return true;
                }
            }
        }
    }
    if config["api"]["enabled"] == true {
        let loopback = config["api"]["address"]
            .as_str()
            .and_then(|address| address.parse::<std::net::SocketAddr>().ok())
            .is_some_and(|address| address.ip().is_loopback());
        if !loopback {
            return true;
        }
    }
    fn native_feature(value: &Value) -> bool {
        match value {
            Value::Object(fields) => fields.iter().any(|(key, value)| {
                let key = key.to_ascii_lowercase();
                [
                    "command",
                    "exec",
                    "provider",
                    "secret",
                    "secrets",
                    "source_files",
                    "files",
                    "enrichment_tables",
                ]
                .contains(&key.as_str())
                    || (["verify_certificate", "verify_hostname"].contains(&key.as_str())
                        && value == false)
                    || native_feature(value)
            }),
            Value::Array(items) => items.iter().any(native_feature),
            Value::String(value) => {
                let bytes = value.as_bytes();
                bytes.windows(2).any(|pair| {
                    pair[0] == b'$' && (pair[1].is_ascii_alphabetic() || pair[1] == b'_')
                }) || value.contains("${")
                    || value.contains("{{")
                    || value.contains("%{")
                    || value.contains("SECRET[")
                    || [
                        "get_env_var",
                        "get_secret",
                        "set_secret",
                        "remove_secret",
                        "dns_lookup",
                        "get_enrichment_table",
                        "find_enrichment_table",
                    ]
                    .iter()
                    .any(|function| value.to_ascii_lowercase().contains(function))
            }
            _ => false,
        }
    }
    native_feature(config)
}

fn compatibility_problems(
    device: &Value,
    needs_full_mode: bool,
) -> [Option<(&'static str, &'static str)>; 2] {
    [
        (text(device, "vector_version") != crate::validation::VECTOR_VERSION).then_some((
            "VECTOR_VERSION_INCOMPATIBLE",
            "The selected device does not report the required Vector 0.58.0 version. Review its local Vector installation before deploying.",
        )),
        (needs_full_mode && device["configuration_mode"] != "full").then_some((
            "FULL_VECTOR_MODE_REQUIRED",
            "This published configuration requires full Vector mode on the selected device. Only its host operator can enable that mode locally.",
        )),
    ]
}

fn compatibility_problem(
    device: &Value,
    needs_full_mode: bool,
) -> Option<(&'static str, &'static str)> {
    compatibility_problems(device, needs_full_mode)
        .into_iter()
        .flatten()
        .next()
}

pub(crate) async fn compatibility_blockers(
    db: &mut SqliteConnection,
    request: &Value,
    selected: &BTreeSet<String>,
) -> Result<Vec<Value>> {
    if kind(request) != "configuration" {
        return Ok(Vec::new());
    }
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let selected_json = serde_json::to_string(selected)
        .map_err(|_| ApiError::invalid("Cannot inspect selected devices"))?;
    let rows = sqlx::query("SELECT d.id,d.data FROM json_each(?) AS selected JOIN devices d ON d.id=selected.value WHERE d.revoked=0")
        .bind(selected_json)
        .fetch_all(&mut *db)
        .await?;
    let mut by_code = BTreeMap::<&'static str, (&'static str, Vec<String>)>::new();
    for row in rows {
        let device = db::parse(row.get("data"))?;
        let id: String = row.get("id");
        let rendered = crate::variables::target_artifact(db, request, &id).await?;
        let rendered_config: Value = serde_json::from_str(&rendered.bytes)
            .map_err(|_| ApiError::invalid("Rendered device artifact is invalid"))?;
        let needs_full_mode = requires_full_mode(&rendered_config);
        for (code, reason) in compatibility_problems(&device, needs_full_mode)
            .into_iter()
            .flatten()
        {
            by_code
                .entry(code)
                .or_insert((reason, Vec::new()))
                .1
                .push(id.clone());
        }
    }
    Ok(by_code
        .into_iter()
        .map(|(code, (reason, mut device_ids))| {
            device_ids.sort();
            device_ids.dedup();
            json!({"code":code,"reason":reason,"resource":"configuration","device_ids":device_ids})
        })
        .collect())
}
async fn identity(db: &mut SqliteConnection, v: &Value, device: &str) -> Result<String> {
    if v["version_id"].is_string() {
        let sha = crate::variables::target_artifact(db, v, device)
            .await?
            .sha256;
        Ok(format!("{}:{sha}", text(v, "version_id")))
    } else {
        Ok(v["policy"].to_string())
    }
}
fn candidate_status(v: &Value) -> bool {
    ["active", "paused", "completed", "cancelled", "failed"].contains(&text(v, "status"))
}
pub(crate) async fn candidate_targets(
    db: &mut SqliteConnection,
    d: &Value,
) -> Result<BTreeSet<String>> {
    if text(d, "target_mode") == "persistent"
        && !["cancelled", "failed"].contains(&text(d, "status"))
    {
        select_impl(db, &d["selector"], false).await
    } else {
        let rows = sqlx::query(
            "SELECT device_id,generation FROM deployment_targets WHERE deployment_id=? AND state<>'removed'",
        )
        .bind(text(d, "id"))
        .fetch_all(db)
        .await?;
        Ok(rows
            .iter()
            .filter(|r| {
                !["cancelled", "failed"].contains(&text(d, "status"))
                    || r.get::<i64, _>("generation") > 0
            })
            .map(|r| r.get("device_id"))
            .collect())
    }
}
/// One candidate assignment and the devices it currently selects.
pub(crate) struct Candidate {
    pub deployment: Value,
    pub devices: BTreeSet<String>,
}
/// A proposed state evaluated without writing: an additional candidate, an
/// assignment ignored entirely, and (assignment, device) pairs that a reviewed
/// replacement will have retired once it releases those devices.
#[derive(Default)]
pub(crate) struct Proposal<'a> {
    pub extra: Option<&'a Value>,
    pub ignored: Option<&'a str>,
    pub retired: BTreeSet<(String, String)>,
}
fn replaced_ids(d: &Value) -> Vec<&str> {
    d["replaces"]
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}
/// Every current candidate with its selected devices. A deployment that replaces
/// another assignment defers to it on each device until it releases that device;
/// the release retires the replaced assignment there (see `retire_replaced`).
/// Neither assignment is ever chosen by identity or creation order.
pub(crate) async fn candidates(
    db: &mut SqliteConnection,
    proposal: &Proposal<'_>,
) -> Result<Vec<Candidate>> {
    let mut deployments = db::records(db, "deployment").await?;
    deployments.retain(|d| Some(text(d, "id")) != proposal.ignored);
    if let Some(x) = proposal.extra {
        deployments.retain(|d| d["id"] != x["id"]);
        deployments.push(x.clone());
    }
    let mut out = Vec::new();
    for d in deployments.into_iter().filter(candidate_status) {
        let mut devices = if proposal.extra.is_some_and(|e| e["id"] == d["id"]) {
            select(db, &d["selector"]).await?
        } else {
            candidate_targets(db, &d).await?
        };
        if !proposal.retired.is_empty() {
            let id = text(&d, "id").to_owned();
            devices.retain(|device| !proposal.retired.contains(&(id.clone(), device.clone())));
        }
        out.push(Candidate {
            deployment: d,
            devices,
        });
    }
    let deferring: Vec<usize> = out
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            !replaced_ids(&c.deployment).is_empty()
                && proposal.extra.is_none_or(|e| e["id"] != c.deployment["id"])
        })
        .map(|(index, _)| index)
        .collect();
    for index in deferring {
        let unreleased: BTreeSet<String> = sqlx::query_scalar(
            "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation=0 AND state<>'removed'",
        )
        .bind(text(&out[index].deployment, "id"))
        .fetch_all(&mut *db)
        .await?
        .into_iter()
        .collect();
        let replaced: Vec<String> = replaced_ids(&out[index].deployment)
            .into_iter()
            .map(str::to_owned)
            .collect();
        let covered: BTreeSet<String> = out
            .iter()
            .filter(|c| replaced.iter().any(|id| c.deployment["id"] == id.as_str()))
            .flat_map(|c| c.devices.iter().cloned())
            .collect();
        out[index]
            .devices
            .retain(|device| !(unreleased.contains(device) && covered.contains(device)));
    }
    Ok(out)
}
async fn cached_identity(
    db: &mut SqliteConnection,
    cache: &mut std::collections::HashMap<(usize, String), String>,
    candidates: &[Candidate],
    index: usize,
    device: &str,
) -> Result<String> {
    let key = (index, device.to_owned());
    if let Some(identity) = cache.get(&key) {
        return Ok(identity.clone());
    }
    let value = identity(db, &candidates[index].deployment, device).await?;
    cache.insert(key, value.clone());
    Ok(value)
}
/// Equal-priority candidates for the same device and resource must deliver the
/// same payload. Rendering a payload identity is costly, so it is computed only
/// for (device, resource, priority) collisions.
pub(crate) async fn conflicts_among(
    db: &mut SqliteConnection,
    candidates: &[Candidate],
) -> Result<Vec<Value>> {
    let mut first: BTreeMap<(String, &str, i64), usize> = BTreeMap::new();
    let mut cache = std::collections::HashMap::new();
    let mut conflicts = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let d = &candidate.deployment;
        let resource = kind(d);
        let priority = d["priority"].as_i64().unwrap_or(0);
        for device in &candidate.devices {
            let key = (device.clone(), resource, priority);
            let Some(&other) = first.get(&key) else {
                first.insert(key, index);
                continue;
            };
            let theirs = cached_identity(db, &mut cache, candidates, other, device).await?;
            let ours = cached_identity(db, &mut cache, candidates, index, device).await?;
            if theirs != ours {
                conflicts.push(json!({"device_id":device,"assignment_ids":[text(&candidates[other].deployment,"id"),text(d,"id")],"priority":d["priority"],"resource":resource}));
            }
        }
    }
    Ok(conflicts)
}
/// Highest explicit priority wins. Equal priorities are either identical
/// payloads (so the lower ID is only a stable representative) or conflicts.
pub(crate) fn winners_among<'a>(
    candidates: impl IntoIterator<Item = &'a Candidate>,
    scope: Option<&BTreeSet<String>>,
) -> BTreeMap<(String, String), Value> {
    let mut winners: BTreeMap<(String, String), &Value> = BTreeMap::new();
    for candidate in candidates {
        let d = &candidate.deployment;
        for device in &candidate.devices {
            if scope.is_some_and(|ids| !ids.contains(device)) {
                continue;
            }
            let key = (device.clone(), kind(d).to_owned());
            let replace = winners.get(&key).is_none_or(|old| {
                d["priority"].as_i64() > old["priority"].as_i64()
                    || (d["priority"] == old["priority"] && text(d, "id") < text(old, "id"))
            });
            if replace {
                winners.insert(key, d);
            }
        }
    }
    winners
        .into_iter()
        .map(|(key, d)| (key, d.clone()))
        .collect()
}
pub async fn conflicts(db: &mut SqliteConnection, extra: Option<&Value>) -> Result<Vec<Value>> {
    let set = candidates(
        db,
        &Proposal {
            extra,
            ..Default::default()
        },
    )
    .await?;
    conflicts_among(db, &set).await
}
async fn conflicts_excluding(
    db: &mut SqliteConnection,
    extra: Option<&Value>,
    excluded: Option<&str>,
) -> Result<Vec<Value>> {
    let set = candidates(
        db,
        &Proposal {
            extra,
            ignored: excluded,
            ..Default::default()
        },
    )
    .await?;
    conflicts_among(db, &set).await
}
pub fn validate_request(v: &Value) -> Result<()> {
    validate_request_inner(v, false)
}
fn validate_request_inner(v: &Value, trusted_rollback: bool) -> Result<()> {
    let object = v
        .as_object()
        .ok_or_else(|| ApiError::invalid("Deployment request must be an object"))?;
    let allowed = [
        "request_id",
        "name",
        "version_id",
        "policy",
        "selector",
        "expected_device_ids",
        "priority",
        "target_mode",
        "scheduled_at",
        "rollout",
        "variable_bindings",
        "replaces",
        "policy_id",
    ];
    if object.keys().any(|key| {
        !allowed.contains(&key.as_str())
            && !(trusted_rollback && ["rollback_artifacts", "rollback_of"].contains(&key.as_str()))
    }) {
        return Err(ApiError::invalid("Unknown deployment request field"));
    }
    crate::deployment_requests::request_id(v)?;
    if let Some(replaces) = v.get("replaces") {
        let list = replaces
            .as_array()
            .filter(|list| list.len() <= 100)
            .ok_or_else(|| ApiError::invalid("replaces must list at most 100 assignment IDs"))?;
        let mut seen = BTreeSet::new();
        for id in list {
            let id = id
                .as_str()
                .ok_or_else(|| ApiError::invalid("replaces must contain assignment IDs"))?;
            let parsed = uuid::Uuid::parse_str(id)
                .map_err(|_| ApiError::invalid("replaces must contain assignment IDs"))?;
            if parsed.hyphenated().to_string() != id || !seen.insert(id) {
                return Err(ApiError::invalid(
                    "replaces must contain distinct lowercase assignment IDs",
                ));
            }
        }
    }
    if let Some(policy_id) = v.get("policy_id") {
        if !v["policy"].is_object()
            || policy_id
                .as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .is_none()
        {
            return Err(ApiError::invalid(
                "policy_id identifies the saved agent settings of a policy deployment",
            ));
        }
    }
    if !v["name"].is_null()
        && v["name"]
            .as_str()
            .is_none_or(|name| name.chars().count() > 120)
    {
        return Err(ApiError::invalid(
            "Deployment name must be null or a string of at most 120 characters",
        ));
    }
    if v["version_id"].is_string() == v["policy"].is_object() {
        return Err(ApiError::invalid(
            "Provide exactly one version_id or complete policy",
        ));
    }
    if v["policy"].is_object() {
        db::validate_policy(&v["policy"])?
    }
    if v["priority"]
        .as_i64()
        .is_none_or(|x| !(-1000000..=1000000).contains(&x))
    {
        return Err(ApiError::invalid(
            "priority must be an integer between -1000000 and 1000000",
        ));
    }
    if !["snapshot", "persistent"].contains(&text(v, "target_mode")) {
        return Err(ApiError::invalid(
            "target_mode must be snapshot or persistent",
        ));
    }
    let r = &v["rollout"];
    if !["all", "canary"].contains(&text(r, "kind")) {
        return Err(ApiError::invalid("Invalid rollout kind"));
    }
    for (key, min, max) in [
        ("canary_size", 1, 10000),
        ("batch_size", 1, 10000),
        ("observation_seconds", 0, 86400),
        ("failure_threshold", 0, 10000),
    ] {
        if r[key].as_u64().is_none_or(|n| n < min || n > max) {
            return Err(ApiError::invalid(format!("Invalid rollout {key}")));
        }
    }
    if !v["scheduled_at"].is_null() {
        let dt = DateTime::parse_from_rfc3339(db::string(v, "scheduled_at", 64)?)
            .map_err(|_| ApiError::invalid("Invalid scheduled_at"))?;
        if dt <= Utc::now() {
            return Err(ApiError::invalid(
                "Scheduled activation must be in the future",
            ));
        }
        if text(v, "target_mode") != "snapshot" {
            return Err(ApiError::invalid(
                "Scheduled deployments require a frozen snapshot",
            ));
        }
    }
    Ok(())
}
async fn creation_blockers(
    db: &mut SqliteConnection,
    request: &Value,
    selected: &BTreeSet<String>,
    exclude_deployment: Option<&str>,
) -> Result<Vec<Value>> {
    let mut blockers = Vec::new();
    for old in db::records(db, "deployment").await? {
        if Some(text(&old, "id")) != exclude_deployment
            && kind(&old) == kind(request)
            && text(&old["rollout"], "kind") == "canary"
            && text(&old, "status") == "active"
        {
            let members = candidate_targets(db, &old).await?;
            let overlapping: Vec<_> = selected.intersection(&members).cloned().collect();
            if !overlapping.is_empty() {
                blockers.push(json!({"deployment_id":old["id"],"device_ids":overlapping,"resource":kind(request),"code":"ACTIVE_CANARY_OVERLAP","reason":"An active canary overlaps these targets; pause or cancel it before superseding"}));
            }
        }
    }
    Ok(blockers)
}
pub async fn preview(db: &mut SqliteConnection, v: &Value) -> Result<Value> {
    preview_inner(db, v, false).await
}
async fn preview_inner(
    db: &mut SqliteConnection,
    v: &Value,
    trusted_rollback: bool,
) -> Result<Value> {
    validate_request_inner(v, trusted_rollback)?;
    let selected = select(db, &v["selector"]).await?;
    let artifact_previews = if let Some(version_id) = v["version_id"].as_str() {
        let version = db::record(db, "version", version_id).await?;
        if trusted_rollback && v["rollback_artifacts"].is_object() {
            let overrides = v["rollback_artifacts"].as_object().unwrap();
            if overrides.len() != selected.len()
                || !selected
                    .iter()
                    .all(|id| overrides.get(id).and_then(Value::as_str).is_some())
            {
                return Err(ApiError::invalid(
                    "Rollback artifacts must cover every frozen target",
                ));
            }
        } else {
            crate::variables::validate_bindings(
                &version,
                &v["variable_bindings"],
                &selected,
                v["target_mode"] == "persistent",
            )?;
        }
        let mut previews = Vec::with_capacity(selected.len());
        for device in &selected {
            let artifact = if trusted_rollback {
                crate::variables::target_artifact(db, v, device).await?
            } else {
                crate::variables::render(&version, &v["variable_bindings"], device)?
            };
            previews
                .push(json!({"device_id":device,"sha256":artifact.sha256,"size":artifact.size}));
        }
        previews
    } else {
        if !v["variable_bindings"].is_null() {
            return Err(ApiError::invalid(
                "Agent policy deployments cannot have variable bindings",
            ));
        }
        Vec::new()
    };
    let compatibility = compatibility_blockers(db, v, &selected).await?;
    let fleet = devices(db)
        .await?
        .into_iter()
        .filter(|d| selected.contains(text(d, "id")))
        .collect::<Vec<_>>();
    let plan = replacement_plan(db, v, &selected).await?;
    let retired: BTreeSet<(String, String)> = plan
        .iter()
        .flat_map(|r| {
            r.devices
                .iter()
                .map(|device| (text(&r.deployment, "id").to_owned(), device.clone()))
        })
        .collect();
    if let Some(policy_id) = v["policy_id"].as_str() {
        let saved = db::record(db, "policy", policy_id)
            .await
            .map_err(|_| ApiError::invalid("These saved agent settings are no longer available"))?;
        if saved["policy"] != v["policy"] {
            return Err(ApiError::conflict(
                "These saved agent settings changed. Review the current settings before applying them.",
            ));
        }
    }
    let mut candidate = v.clone();
    candidate["id"] = json!("preview");
    candidate["status"] = json!("active");
    // Review the state after the replacements take effect on every device.
    let mut set = candidates(
        db,
        &Proposal {
            extra: Some(&candidate),
            ..Default::default()
        },
    )
    .await?;
    let before = winners_among(
        set.iter().filter(|c| c.deployment["id"] != "preview"),
        Some(&selected),
    );
    for c in &mut set {
        let id = text(&c.deployment, "id").to_owned();
        c.devices
            .retain(|device| !retired.contains(&(id.clone(), device.clone())));
    }
    let issues = conflicts_among(db, &set).await?;
    let after = winners_among(
        set.iter().filter(|c| c.deployment["id"] != "preview"),
        Some(&selected),
    );
    let mut blockers = creation_blockers(db, v, &selected, None).await?;
    blockers.extend(compatibility);
    let resource = kind(v);
    let mut described = std::collections::HashMap::new();
    let requested_configuration = match v["version_id"].as_str() {
        Some(version) => db::record(db, "version", version).await?["configuration_id"].clone(),
        None => Value::Null,
    };
    let requested_sha: BTreeMap<&str, &str> = artifact_previews
        .iter()
        .filter_map(|a| Some((a["device_id"].as_str()?, a["sha256"].as_str()?)))
        .collect();
    let mut outcomes = Vec::with_capacity(selected.len());
    let mut suggestions: BTreeMap<String, (Value, Vec<String>)> = BTreeMap::new();
    let mut winning_priority: Option<i64> = None;
    for device in &selected {
        let key = (device.clone(), resource.to_owned());
        let mut result = json!({"device_id":device,"resource":resource,"outcome":"requested"});
        if let Some(winner) = before.get(&key) {
            result["winner"] = describe(db, &mut described, winner).await?;
            let replaced = retired.contains(&(text(winner, "id").to_owned(), device.clone()));
            let same_lineage = if resource == "policy" {
                winner["policy"] != v["policy"]
            } else if !requested_configuration.is_null()
                && result["winner"]["configuration_id"] == requested_configuration
            {
                let theirs = identity(db, winner, device).await?;
                requested_sha
                    .get(device.as_str())
                    .is_none_or(|sha| theirs != format!("{}:{sha}", text(v, "version_id")))
            } else {
                false
            };
            if !replaced && same_lineage {
                suggestions
                    .entry(text(winner, "id").to_owned())
                    .or_insert_with(|| (winner.clone(), Vec::new()))
                    .1
                    .push(device.clone());
            }
        }
        if let Some(r) = plan.iter().find(|r| r.devices.contains(device)) {
            result["replaces"] = describe(db, &mut described, &r.deployment).await?;
        }
        let blocking = after
            .get(&key)
            .filter(|w| w["priority"].as_i64() >= v["priority"].as_i64());
        if issues
            .iter()
            .any(|issue| text(issue, "device_id") == device && text(issue, "resource") == resource)
        {
            result["outcome"] = json!("conflict");
        } else if let Some(winner) =
            blocking.filter(|w| w["priority"].as_i64() > v["priority"].as_i64())
        {
            result["outcome"] = json!("higher_priority");
            result["assignment"] = json!({"id":winner["id"],"priority":winner["priority"],"reason":format!("{} {} assignment has higher priority; rollout admission may still be pending",text(winner,"target_mode"),resource)});
        } else if result.get("replaces").is_some() {
            result["outcome"] = json!("replace");
        }
        if matches!(text(&result, "outcome"), "conflict" | "higher_priority") {
            if let Some(winner) = blocking {
                let needed = winner["priority"].as_i64().unwrap_or(0).saturating_add(1);
                winning_priority = Some(winning_priority.map_or(needed, |p| p.max(needed)));
            }
        }
        outcomes.push(result);
    }
    let mut conflicts_described = Vec::with_capacity(issues.len());
    for mut issue in issues {
        let mut existing = Vec::new();
        for id in issue["assignment_ids"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| *id != "preview")
        {
            if let Ok(d) = db::record(db, "deployment", id).await {
                existing.push(describe(db, &mut described, &d).await?);
            }
        }
        issue["assignments"] = json!(existing);
        conflicts_described.push(issue);
    }
    let mut replacements = Vec::with_capacity(plan.len());
    for r in &plan {
        replacements.push(json!({"assignment":describe(db,&mut described,&r.deployment).await?,"device_ids":r.devices,"retires_assignment":r.retires_assignment}));
    }
    let mut suggested_replaces = Vec::with_capacity(suggestions.len());
    let mut suggested_priority: Option<i64> = None;
    for (winner, devices) in suggestions.into_values() {
        let priority = winner["priority"].as_i64().unwrap_or(0);
        suggested_priority = Some(suggested_priority.map_or(priority, |p| p.max(priority)));
        suggested_replaces.push(
            json!({"assignment":describe(db,&mut described,&winner).await?,"device_ids":devices}),
        );
    }
    let paused: Vec<&Value> = if resource == "configuration" {
        fleet
            .iter()
            .filter(|d| d["sync_paused"] == true || d["local_paused"] == true)
            .map(|d| &d["id"])
            .collect()
    } else {
        Vec::new()
    };
    let mut warnings = Vec::new();
    if fleet.is_empty() {
        warnings.push("No devices selected.".to_owned())
    }
    let offline = fleet
        .iter()
        .filter(|d| ["offline", "awaiting_first_check_in"].contains(&text(d, "status")))
        .count();
    if offline > 0 {
        warnings.push(format!(
            "{offline} {} not checking in. {} after {} reconnect.",
            if offline == 1 {
                "device is"
            } else {
                "devices are"
            },
            if offline == 1 {
                "It applies the change"
            } else {
                "They apply the change"
            },
            if offline == 1 { "it" } else { "they" },
        ));
    }
    if !paused.is_empty() {
        warnings.push(format!(
            "{} {} sync paused. This change waits until sync resumes.",
            paused.len(),
            if paused.len() == 1 {
                "device has"
            } else {
                "devices have"
            },
        ));
    }
    if v["scheduled_at"].is_string() {
        warnings.push("Priorities are checked again when the schedule starts.".into());
    }
    Ok(
        json!({"devices":fleet,"conflicts":conflicts_described,"warnings":warnings,"outcomes":outcomes,"artifact_previews":artifact_previews,"create_idempotency":true,"request_correlation":true,"blockers":blockers,
            "replacements":replacements,"suggested_replaces":suggested_replaces,"suggested_priority":suggested_priority,"winning_priority":winning_priority.filter(|p| *p <= 1_000_000),"paused_device_ids":paused}),
    )
}
/// Display metadata for an assignment: names and numbers, never selectors,
/// targets, variable values or artifacts.
pub(crate) async fn describe(
    db: &mut SqliteConnection,
    cache: &mut std::collections::HashMap<String, Value>,
    d: &Value,
) -> Result<Value> {
    let id = text(d, "id").to_owned();
    if let Some(described) = cache.get(&id) {
        return Ok(described.clone());
    }
    let mut out = json!({"id":id,"name":d["name"].as_str().map(|name| name.chars().take(120).collect::<String>()),"resource":kind(d),"priority":d["priority"],"target_mode":d["target_mode"],"status":d["status"],"created_at":d["created_at"],
        "version_id":null,"version_number":null,"configuration_id":null,"configuration_name":null,"policy":null,"policy_id":null,"policy_name":null,"created_by_name":null});
    if let Some(actor) = d["created_by"].as_str() {
        out["created_by_name"] = json!(
            sqlx::query_scalar::<_, String>("SELECT substr(name,1,120) FROM users WHERE id=?")
                .bind(actor)
                .fetch_optional(&mut *db)
                .await?
        );
    }
    if let Some(version) = d["version_id"].as_str() {
        out["version_id"] = json!(version);
        if let Some(row) = sqlx::query("SELECT CASE WHEN json_type(v.data,'$.number')='integer' THEN json_extract(v.data,'$.number') END AS number,json_extract(v.data,'$.configuration_id') AS configuration_id,CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) END AS name FROM records v LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id') WHERE v.kind='version' AND v.id=?").bind(version).fetch_optional(&mut *db).await? {
            out["version_number"] = json!(row.get::<Option<i64>, _>("number"));
            out["configuration_id"] = json!(row.get::<Option<String>, _>("configuration_id"));
            out["configuration_name"] = json!(row.get::<Option<String>, _>("name"));
        }
    } else {
        out["policy"] = d["policy"].clone();
        if let Some(policy) = d["policy_id"].as_str() {
            out["policy_id"] = json!(policy);
            out["policy_name"] = json!(sqlx::query_scalar::<_, Option<String>>("SELECT substr(json_extract(data,'$.name'),1,120) FROM records WHERE kind='policy' AND id=?").bind(policy).fetch_optional(&mut *db).await?.flatten());
        }
    }
    cache.insert(id, out.clone());
    Ok(out)
}
/// An explicit, reviewed replacement of existing assignments on these devices.
pub(crate) struct Replacement {
    pub deployment: Value,
    pub devices: BTreeSet<String>,
    /// Whether nothing remains for the replaced assignment to deliver afterwards.
    pub retires_assignment: bool,
}
fn replacement_changed() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "REPLACEMENT_CHANGED",
        "An assignment you chose to replace changed or no longer applies to these devices. Review the deployment again.",
    )
}
// A persistent replacement that follows every group and device of the old
// persistent assignment also takes over its future members.
fn covers(new: &Value, old: &Value, selected: &BTreeSet<String>) -> bool {
    let ids = |v: &Value, key: &str| -> BTreeSet<String> {
        v["selector"][key]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    new["target_mode"] == "persistent"
        && new["scheduled_at"].is_null()
        && ids(old, "group_ids").is_subset(&ids(new, "group_ids"))
        && ids(old, "device_ids")
            .difference(&ids(old, "exclude_ids"))
            .all(|device| selected.contains(device))
}
async fn replacement_plan(
    db: &mut SqliteConnection,
    v: &Value,
    selected: &BTreeSet<String>,
) -> Result<Vec<Replacement>> {
    let mut plan = Vec::new();
    for id in replaced_ids(v) {
        let old = match db::record(db, "deployment", id).await {
            Ok(old) => old,
            Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {
                return Err(replacement_changed());
            }
            Err(error) => return Err(error),
        };
        if kind(&old) != kind(v) {
            return Err(ApiError::invalid(
                "A replacement must be the same kind of assignment: pipeline or agent settings",
            ));
        }
        if !candidate_status(&old) {
            return Err(replacement_changed());
        }
        let members = candidate_targets(db, &old).await?;
        let devices: BTreeSet<String> = members.intersection(selected).cloned().collect();
        if devices.is_empty() {
            return Err(replacement_changed());
        }
        let retires_assignment = members.is_subset(&devices)
            && (old["target_mode"] != "persistent"
                || ["cancelled", "failed"].contains(&text(&old, "status"))
                || covers(v, &old, selected));
        plan.push(Replacement {
            deployment: old,
            devices,
            retires_assignment,
        });
    }
    Ok(plan)
}
/// A retry on an earlier server raised a device's generation without copying its
/// rendered artifact. The retry resent the exact same bytes, so the newest earlier
/// snapshot of that version with the digest the device recorded is that artifact.
/// It is stored under the generation again, which also lets check-ins resume.
async fn resent_snapshot(
    db: &mut SqliteConnection,
    device: &str,
    generation: i64,
    version: &str,
    recorded_sha: Option<&str>,
) -> Result<Option<crate::variables::Artifact>> {
    let Some(recorded_sha) = recorded_sha else {
        return Ok(None);
    };
    let sha: Option<String> = sqlx::query_scalar(
        "SELECT sha256 FROM desired_artifacts WHERE device_id=? AND version_id=? AND generation<? AND sha256=? ORDER BY generation DESC LIMIT 1",
    )
    .bind(device)
    .bind(version)
    .bind(generation)
    .bind(recorded_sha)
    .fetch_optional(&mut *db)
    .await?;
    let Some(sha) = sha else {
        return Ok(None);
    };
    let artifact = crate::variables::blob(db, &sha).await?;
    crate::variables::snapshot(db, device, generation, version, &artifact).await?;
    Ok(Some(artifact))
}
/// Once a replacing deployment releases devices, the assignments it replaces stop
/// selecting them. Retained rows keep their history; a persistent assignment also
/// excludes them so later membership changes cannot bring the old one back.
async fn retire_replaced(db: &mut SqliteConnection, d: &Value, released: &[String]) -> Result<()> {
    if released.is_empty() {
        return Ok(());
    }
    let selected = candidate_targets(db, d).await?;
    for id in replaced_ids(d) {
        let Ok(mut old) = db::record(db, "deployment", id).await else {
            continue;
        };
        if !candidate_status(&old) {
            continue;
        }
        let members = candidate_targets(db, &old).await?;
        let taken: Vec<&String> = released
            .iter()
            .filter(|device| members.contains(*device))
            .collect();
        if taken.is_empty() {
            continue;
        }
        if old["target_mode"] == "persistent" {
            let mut excluded: BTreeSet<String> = old["selector"]["exclude_ids"]
                .as_array()
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            excluded.extend(taken.iter().map(|device| (*device).clone()));
            old["selector"]["exclude_ids"] = json!(excluded);
        }
        for device in &taken {
            sqlx::query("UPDATE deployment_targets SET state='removed' WHERE deployment_id=? AND device_id=? AND state<>'removed'")
                .bind(id)
                .bind(device)
                .execute(&mut *db)
                .await?;
        }
        let mut entries = old["replaced_by"].as_array().cloned().unwrap_or_default();
        match entries
            .iter_mut()
            .find(|entry| entry["deployment_id"] == d["id"])
        {
            Some(entry) => {
                entry["device_count"] =
                    json!(entry["device_count"].as_u64().unwrap_or(0) + taken.len() as u64);
                entry["at"] = json!(db::now());
            }
            None => entries
                .push(json!({"deployment_id":d["id"],"device_count":taken.len(),"at":db::now()})),
        }
        old["replaced_by"] = json!(entries);
        let remaining = candidate_targets(db, &old).await?;
        if remaining.is_empty()
            && (old["target_mode"] != "persistent"
                || ["cancelled", "failed"].contains(&text(&old, "status"))
                || covers(d, &old, &selected))
        {
            // Nothing is left for it to deliver. Retire the binding without
            // rewriting how its own rollout ended.
            old["status_before_removal"] = old["status"].clone();
            old["status"] = json!("unassigned");
            old["removed_at"] = json!(db::now());
            crate::canary_gate::clear(&mut old);
        }
        db::update(db, "deployment", &old).await?;
        db::audit(
            db,
            d["created_by"].as_str().unwrap_or("scheduler"),
            "deployment.replace",
            id,
            "success",
        )
        .await?;
    }
    Ok(())
}
pub async fn create(db: &mut SqliteConnection, v: &Value, actor: &str) -> Result<Value> {
    create_inner(db, v, actor, false).await
}
async fn create_inner(
    db: &mut SqliteConnection,
    v: &Value,
    actor: &str,
    trusted_rollback: bool,
) -> Result<Value> {
    let p = preview_inner(db, v, trusted_rollback).await?;
    if !p["conflicts"].as_array().unwrap().is_empty() {
        return Err(ApiError::conflict(
            "Equal-priority assignments have different payloads",
        ));
    }
    if p["devices"].as_array().unwrap().is_empty() {
        return Err(ApiError::invalid("Select at least one device"));
    }
    let selected: BTreeSet<String> = p["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| text(d, "id").into())
        .collect();
    if v.get("expected_device_ids").is_some() {
        let expected = ids(
            &serde_json::json!({"device_ids":v["expected_device_ids"]}),
            "device_ids",
        )?;
        let reviewed = expected.iter().cloned().collect::<BTreeSet<_>>();
        if reviewed.len() != expected.len() || reviewed != selected {
            return Err(ApiError::conflict(
                "Target membership changed after preview; review the concrete targets again",
            ));
        }
    }
    if let Some(blocker) = p["blockers"].as_array().unwrap().first() {
        return Err(ApiError::conflict(
            blocker["reason"]
                .as_str()
                .unwrap_or("This deployment has a target compatibility blocker"),
        ));
    }
    let mut d = v.clone();
    d["id"] = json!(db::id());
    d["created_at"] = json!(db::now());
    d["created_by"] = json!(actor);
    d["status"] = json!(if v["scheduled_at"].is_string() {
        "scheduled"
    } else {
        "active"
    });
    d.as_object_mut().unwrap().remove("targets");
    d.as_object_mut().unwrap().remove("target_refresh_revision");
    db::insert(db, "deployment", &d).await?;
    for device in selected {
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id) VALUES(?,?)")
            .bind(text(&d, "id"))
            .bind(device)
            .execute(&mut *db)
            .await?;
    }
    db::audit(
        db,
        actor,
        if d["status"] == "scheduled" {
            "deployment.schedule"
        } else {
            "deployment.create"
        },
        text(&d, "id"),
        "success",
    )
    .await?;
    if d["status"] == "active" {
        advance(db, &mut d).await?;
        resolve(db).await?;
    }
    deployment(db, text(&d, "id")).await
}
// Capture selectors before a group edit, while the enclosing writer transaction
// still sees its reviewed membership. Historical target rows are not selectors.
pub async fn persistent_memberships(
    db: &mut SqliteConnection,
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut memberships = BTreeMap::new();
    for d in db::records(db, "deployment").await? {
        if text(&d, "target_mode") == "persistent"
            && ["active", "paused", "completed"].contains(&text(&d, "status"))
        {
            memberships.insert(
                text(&d, "id").to_owned(),
                select_impl(db, &d["selector"], false).await?,
            );
        }
    }
    Ok(memberships)
}

// Run after the proposed group is written, but before any target admission or
// generation changes. The caller rolls the whole edit back on a blocker.
pub async fn guard_membership_additions(
    db: &mut SqliteConnection,
    previous: &BTreeMap<String, BTreeSet<String>>,
) -> Result<()> {
    for d in db::records(db, "deployment").await? {
        let Some(before) = previous.get(text(&d, "id")) else {
            continue;
        };
        let after = select_impl(db, &d["selector"], false).await?;
        let added = after.difference(before).cloned().collect::<BTreeSet<_>>();
        if !added.is_empty()
            && !creation_blockers(db, &d, &added, Some(text(&d, "id")))
                .await?
                .is_empty()
        {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                "ACTIVE_CANARY_OVERLAP",
                "These membership changes overlap an active canary. Wait for it to finish, or review its pause/cancel controls before trying again.",
            ));
        }
        if let Some(blocker) = compatibility_blockers(db, &d, &added).await?.first() {
            return Err(ApiError::conflict(format!(
                "Group membership would add an incompatible device: {}",
                blocker["reason"]
                    .as_str()
                    .unwrap_or("review the target device")
            )));
        }
    }
    Ok(())
}

// Retiring a credential must not run global conflict/admission reconciliation.
// Only current persistent bindings change eligibility; snapshots and stopped
// bindings retain their historical target states. Retained generation and
// timestamps are evidence, never authority for admission while state=removed.
pub async fn retire_persistent_targets(db: &mut SqliteConnection, device: &str) -> Result<()> {
    sqlx::query("UPDATE deployment_targets SET state='removed' WHERE device_id=? AND state<>'removed' AND deployment_id IN (SELECT id FROM records WHERE kind='deployment' AND json_extract(data,'$.target_mode')='persistent' AND json_extract(data,'$.status') IN ('active','paused','completed'))")
        .bind(device).execute(db).await?;
    Ok(())
}
async fn mark_ineligible_targets(
    db: &mut SqliteConnection,
    deployment: &str,
    members: &BTreeSet<String>,
) -> Result<()> {
    for target in targets(db, deployment).await? {
        if !members.contains(text(&target, "device_id")) && target["state"] != "removed" {
            sqlx::query("UPDATE deployment_targets SET state='removed' WHERE deployment_id=? AND device_id=?")
                .bind(deployment).bind(text(&target,"device_id")).execute(&mut *db).await?;
        }
    }
    Ok(())
}

pub async fn reconcile_membership(db: &mut SqliteConnection) -> Result<()> {
    if !conflicts(db, None).await?.is_empty() {
        return Err(ApiError::conflict(
            "Group membership creates conflicting equal-priority assignments",
        ));
    }
    // Releasing one assignment can retire another it replaces, so read each
    // record fresh instead of trusting a snapshot taken before the loop.
    for id in deployment_ids(db).await? {
        let mut d = db::record(db, "deployment", &id).await?;
        if text(&d, "target_mode") != "persistent"
            || !["active", "paused", "completed"].contains(&text(&d, "status"))
        {
            continue;
        }
        let members = select_impl(db, &d["selector"], false).await?;
        let mut added = false;
        mark_ineligible_targets(db, text(&d, "id"), &members).await?;
        for device in &members {
            let result=sqlx::query("INSERT OR IGNORE INTO deployment_targets(deployment_id,device_id,original) VALUES(?,?,0)").bind(text(&d,"id")).bind(device).execute(&mut *db).await?;
            added |= result.rows_affected() > 0;
            let restored=sqlx::query("UPDATE deployment_targets SET state='pending',generation=0,released_at=NULL,verified_at=NULL,error=NULL,previous_version_id=NULL WHERE deployment_id=? AND device_id=? AND state='removed'").bind(text(&d,"id")).bind(device).execute(&mut *db).await?;
            added |= restored.rows_affected() > 0;
        }
        if added && d["status"] == "completed" {
            d["status"] = json!("active");
            d["wave_started_at"] = Value::Null;
            db::update(db, "deployment", &d).await?;
        }
        if text(&d, "status") == "active" {
            advance(db, &mut d).await?;
        }
    }
    resolve(db).await
}
// Preview and resolution must agree even when the winning assignment's target has
// not been released yet. Admission gates application, not priority selection.
async fn assignment_winners(
    db: &mut SqliteConnection,
) -> Result<BTreeMap<(String, String), Value>> {
    assignment_winners_for(db, None).await
}
pub(crate) async fn assignment_winners_for(
    db: &mut SqliteConnection,
    scope: Option<&BTreeSet<String>>,
) -> Result<BTreeMap<(String, String), Value>> {
    let set = candidates(db, &Proposal::default()).await?;
    Ok(winners_among(&set, scope))
}
pub async fn resolve(db: &mut SqliteConnection) -> Result<()> {
    if !conflicts(db, None).await?.is_empty() {
        return Err(ApiError::conflict(
            "Inconsistent assignment state; preserving last valid desired state",
        ));
    }
    let winners = assignment_winners(db).await?;
    let rows = sqlx::query("SELECT * FROM devices WHERE revoked=0")
        .fetch_all(&mut *db)
        .await?;
    for row in rows {
        let device: String = row.get("id");
        for resource in ["configuration", "policy"] {
            let old_id: Option<String> = row.get(if resource == "configuration" {
                "assignment_id"
            } else {
                "policy_assignment_id"
            });
            let winner = winners.get(&(device.clone(), resource.into()));
            if let Some(w) = winner {
                let admitted:Option<i64>=sqlx::query_scalar("SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=? AND state<>'removed'").bind(text(w,"id")).bind(&device).fetch_optional(&mut *db).await?;
                if admitted.unwrap_or(0) == 0 {
                    continue;
                } // Candidate cannot bypass rollout admission.
                if old_id.as_deref() == Some(text(w, "id")) {
                    continue;
                }
                crate::canary_gate::invalidate_resource(db, &device, resource == "configuration")
                    .await?;
                if resource == "configuration" {
                    let current: Option<String> = row.get("desired_version_id");
                    let new = text(w, "version_id");
                    let artifact = crate::variables::target_artifact(db, w, &device).await?;
                    let previous_sha = if let Some(previous_assignment) = old_id.as_deref() {
                        let previous = db::record(db, "deployment", previous_assignment).await?;
                        if current.as_deref() != previous["version_id"].as_str() {
                            return Err(ApiError::conflict(
                                "Previous assignment and desired version disagree",
                            ));
                        }
                        let old_generation: i64 = row.get("desired_generation");
                        if old_generation <= 0 {
                            return Err(ApiError::conflict(
                                "Previous assignment has no desired generation",
                            ));
                        }
                        let prior_version_id = current.as_deref().unwrap();
                        // The existing generation is authoritative. Historical deployment
                        // metadata can no longer change the bytes used for rollback or
                        // deciding whether a same-version redeploy changes the workload.
                        let recorded_sha = db::parse(row.get("data"))?["desired_artifact_sha256"]
                            .as_str()
                            .map(str::to_owned);
                        let previous_artifact = if let Some(stored) =
                            crate::variables::current(db, &device, old_generation, prior_version_id)
                                .await?
                        {
                            stored
                        } else if let Some(resent) = resent_snapshot(
                            db,
                            &device,
                            old_generation,
                            prior_version_id,
                            recorded_sha.as_deref(),
                        )
                        .await?
                        {
                            resent
                        } else {
                            let prior_version = db::record(db, "version", prior_version_id).await?;
                            if prior_version["variables"]
                                .as_array()
                                .is_some_and(|items| !items.is_empty())
                            {
                                return Err(ApiError::conflict(
                                    "Previous variable artifact snapshot is missing",
                                ));
                            }
                            let legacy =
                                crate::variables::render(&prior_version, &Value::Null, &device)?;
                            crate::variables::snapshot(
                                db,
                                &device,
                                old_generation,
                                prior_version_id,
                                &legacy,
                            )
                            .await?;
                            legacy
                        };
                        if recorded_sha.is_some_and(|sha| sha != previous_artifact.sha256) {
                            return Err(ApiError::conflict(
                                "Previous desired artifact digest disagrees with its snapshot",
                            ));
                        }
                        Some(previous_artifact.sha256)
                    } else {
                        None
                    };
                    let content_changed = current.as_deref() != Some(new)
                        || previous_sha.as_deref() != Some(artifact.sha256.as_str());
                    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=desired_generation+?,assignment_id=?,data=json_set(data,'$.desired_artifact_sha256',?) WHERE id=?")
                        .bind(new).bind(if content_changed { 1 } else { 0 })
                        .bind(text(w,"id")).bind(&artifact.sha256).bind(&device)
                        .execute(&mut *db).await?;
                    let generation: i64 =
                        sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
                            .bind(&device)
                            .fetch_one(&mut *db)
                            .await?;
                    crate::variables::snapshot(db, &device, generation, new, &artifact).await?;
                    sqlx::query("UPDATE deployment_targets SET generation=?,previous_version_id=?,previous_artifact_sha256=?,previous_generation=? WHERE deployment_id=? AND device_id=?")
                        .bind(generation).bind(current).bind(previous_sha)
                        .bind(old_id.as_ref().map(|_| row.get::<i64,_>("desired_generation")))
                        .bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                } else {
                    let old = db::parse(row.get("policy"))?;
                    if old["sync_paused"] != w["policy"]["sync_paused"]
                        || old["heartbeat_seconds"] != w["policy"]["heartbeat_seconds"]
                    {
                        crate::canary_gate::invalidate_resource(db, &device, true).await?;
                    }
                    let inc = if old == w["policy"] && old_id.is_some() {
                        0
                    } else {
                        1
                    };
                    // Until the agent acknowledges, it may check in at its old interval.
                    let floor = check_in_seconds(
                        &old,
                        &db::parse(row.get("data"))?,
                        row.get("policy_generation"),
                    );
                    sqlx::query("UPDATE devices SET policy=?,policy_generation=policy_generation+?,policy_assignment_id=?,data=CASE WHEN ?=1 THEN json_set(data,'$.heartbeat_floor_seconds',?) ELSE data END WHERE id=?").bind(w["policy"].to_string()).bind(inc).bind(text(w,"id")).bind(inc).bind(floor).bind(&device).execute(&mut *db).await?;
                    let generation: i64 =
                        sqlx::query_scalar("SELECT policy_generation FROM devices WHERE id=?")
                            .bind(&device)
                            .fetch_one(&mut *db)
                            .await?;
                    sqlx::query("UPDATE deployment_targets SET generation=? WHERE deployment_id=? AND device_id=?").bind(generation.max(1)).bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                }
            } else if old_id.is_some() {
                crate::canary_gate::invalidate_resource(db, &device, resource == "configuration")
                    .await?;
                if resource == "configuration" {
                    sqlx::query("UPDATE devices SET desired_version_id=NULL,desired_generation=desired_generation+1,assignment_id=NULL,data=json_remove(data,'$.desired_artifact_sha256') WHERE id=?").bind(&device).execute(&mut *db).await?;
                } else {
                    let old = db::parse(row.get("policy"))?;
                    let default = db::default_policy();
                    if old["sync_paused"] != default["sync_paused"]
                        || old["heartbeat_seconds"] != default["heartbeat_seconds"]
                    {
                        crate::canary_gate::invalidate_resource(db, &device, true).await?;
                    }
                    let floor = check_in_seconds(
                        &old,
                        &db::parse(row.get("data"))?,
                        row.get("policy_generation"),
                    );
                    sqlx::query("UPDATE devices SET policy=?,policy_generation=policy_generation+1,policy_assignment_id=NULL,data=json_set(data,'$.heartbeat_floor_seconds',?) WHERE id=?").bind(db::default_policy().to_string()).bind(floor).bind(&device).execute(&mut *db).await?;
                }
            }
        }
    }
    Ok(())
}
async fn advance(db: &mut SqliteConnection, d: &mut Value) -> Result<()> {
    if d["status"] != "active" {
        return Ok(());
    }
    let current_members = candidate_targets(db, d).await?;
    let all = targets(db, text(d, "id")).await?;
    let relevant: Vec<_> = all
        .iter()
        .filter(|t| current_members.contains(text(t, "device_id")))
        .collect();
    let pending: Vec<_> = relevant
        .iter()
        .filter(|t| t["generation"] == 0 && t["state"] == "pending")
        .collect();
    let released: Vec<_> = relevant
        .iter()
        .filter(|t| t["generation"].as_i64().unwrap_or(0) > 0)
        .collect();
    let failures = released
        .iter()
        .filter(|t| ["failed", "rolled_back", "incompatible"].contains(&text(t, "state")))
        .count();
    if failures as u64 > d["rollout"]["failure_threshold"].as_u64().unwrap_or(0) {
        d["status"] = json!("failed");
        d["failed_at"] = json!(db::now());
        d["failure_reason"] = json!("threshold");
        db::update(db, "deployment", d).await?;
        db::audit(db, "scheduler", "deployment.gate", text(d, "id"), "failed").await?;
        return Ok(());
    }
    let is_canary = d["rollout"]["kind"] == "canary";
    let proof = if is_canary {
        Some(crate::canary_gate::evaluate(db, d, None).await?)
    } else {
        None
    };
    let all_verified = if let Some(proof) = &proof {
        proof.all_verified()
    } else if released
        .iter()
        .any(|target| target["state"] != "verified_applied")
    {
        false
    } else {
        // All-at-once completion remains a historical receipt, without a
        // continuous observation interval or subsequent wave to authorize.
        // One read covers every released device instead of one per target.
        let released_ids = released
            .iter()
            .map(|target| text(target, "device_id"))
            .collect::<BTreeSet<_>>();
        let rows = sqlx::query("SELECT t.device_id,d.id AS existing,d.revoked,d.policy,d.policy_generation,json_object('last_seen',json_extract(d.data,'$.last_seen'),'policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds')) AS evidence FROM deployment_targets t LEFT JOIN devices d ON d.id=t.device_id WHERE t.deployment_id=? AND t.generation>0")
            .bind(text(d, "id"))
            .fetch_all(&mut *db)
            .await?;
        let mut fresh = BTreeSet::new();
        for row in rows {
            let device: String = row.get("device_id");
            if !released_ids.contains(device.as_str())
                || row.get::<Option<String>, _>("existing").is_none()
                || row.get::<Option<bool>, _>("revoked").unwrap_or(true)
            {
                continue;
            }
            let evidence = db::parse(row.get("evidence"))?;
            let policy = db::parse(&row.get::<String, _>("policy"))?;
            let interval = check_in_seconds(&policy, &evidence, row.get("policy_generation"));
            if checked_in_recently(evidence["last_seen"].as_str(), interval) {
                fresh.insert(device);
            }
        }
        released_ids.iter().all(|device| fresh.contains(*device))
    };
    if is_canary && !released.is_empty() {
        let proof = proof.as_ref().unwrap();
        if !all_verified {
            if !d["observation_started_at"].is_null() {
                crate::canary_gate::clear(d);
                db::update(db, "deployment", d).await?;
            }
            return Ok(());
        }
        let at = d["observation_started_at"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        if at.is_none() || !proof.matches_window(d) {
            d["observation_started_at"] = json!(db::now());
            d["observation_evidence"] = json!(proof.fingerprint);
            db::update(db, "deployment", d).await?;
            return Ok(());
        }
        if Utc::now().signed_duration_since(at.unwrap()).num_seconds()
            < d["rollout"]["observation_seconds"].as_i64().unwrap_or(60)
        {
            return Ok(());
        }
    }
    if pending.is_empty() && all_verified {
        d["status"] = json!("completed");
        d["completed_at"] = json!(db::now());
        db::update(db, "deployment", d).await?;
        return Ok(());
    }
    let take = if !is_canary {
        pending.len()
    } else if released.is_empty() {
        d["rollout"]["canary_size"].as_u64().unwrap_or(1) as usize
    } else {
        d["rollout"]["batch_size"].as_u64().unwrap_or(10) as usize
    };
    let configuration = kind(d) == "configuration";
    let mut wave = Vec::new();
    for target in pending.into_iter().take(take) {
        let row = sqlx::query("SELECT data,revoked FROM devices WHERE id=?")
            .bind(text(target, "device_id"))
            .fetch_optional(&mut *db)
            .await?;
        let problem = match row {
            None => Some("Device is unavailable or revoked"),
            Some(row) if row.get::<bool, _>("revoked") => Some("Device is unavailable or revoked"),
            Some(row) => {
                let device = db::parse(row.get("data"))?;
                if configuration {
                    let rendered =
                        crate::variables::target_artifact(db, d, text(target, "device_id")).await?;
                    let config: Value = serde_json::from_str(&rendered.bytes)
                        .map_err(|_| ApiError::invalid("Rendered device artifact is invalid"))?;
                    compatibility_problem(&device, requires_full_mode(&config))
                        .map(|(_, reason)| reason)
                } else {
                    None
                }
            }
        };
        wave.push((text(target, "device_id").to_owned(), problem));
    }
    if wave.iter().any(|(_, problem)| problem.is_some()) {
        // A changed device mode/version cannot admit a partial wave. Previous
        // released targets retain their history and running content.
        for (device, problem) in &wave {
            sqlx::query("UPDATE deployment_targets SET state=?,error=? WHERE deployment_id=? AND device_id=? AND generation=0")
                .bind(if problem.is_some() { "incompatible" } else { "blocked" })
                .bind(problem.unwrap_or("This wave was not released because another target became incompatible"))
                .bind(text(d, "id"))
                .bind(device)
                .execute(&mut *db)
                .await?;
        }
        d["status"] = json!("failed");
        d["failed_at"] = json!(db::now());
        d["failure_reason"] = json!("incompatible");
        db::audit(
            db,
            "scheduler",
            "deployment.gate",
            text(d, "id"),
            "incompatible",
        )
        .await?;
    } else {
        for (device, _) in &wave {
            // Positive sentinel marks admission. resolve immediately replaces it with actual generation in the same transaction.
            sqlx::query("UPDATE deployment_targets SET state='desired',generation=1,released_at=? WHERE deployment_id=? AND device_id=? AND generation=0")
                .bind(db::now())
                .bind(text(d, "id"))
                .bind(device)
                .execute(&mut *db)
                .await?;
            db::audit(
                db,
                "scheduler",
                "deployment.release",
                &format!("{}:{}", text(d, "id"), device),
                "success",
            )
            .await?;
        }
        let released: Vec<String> = wave.iter().map(|(device, _)| device.clone()).collect();
        retire_replaced(db, d, &released).await?;
    }
    d["observation_started_at"] = Value::Null;
    db::update(db, "deployment", d).await?;
    Ok(())
}
async fn deployment_ids(db: &mut SqliteConnection) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM records WHERE kind='deployment' ORDER BY created_at DESC,id",
    )
    .fetch_all(db)
    .await?)
}
pub async fn tick(s: &State) -> Result<()> {
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    for id in deployment_ids(&mut tx).await? {
        let mut d = db::record(&mut tx, "deployment", &id).await?;
        if d["status"] == "scheduled" {
            let at = DateTime::parse_from_rfc3339(text(&d, "scheduled_at"))
                .map_err(|_| ApiError::invalid("Invalid stored schedule"))?;
            let late = Utc::now().signed_duration_since(at).num_seconds();
            if late < 0 {
                continue;
            }
            if late > 3600 {
                d["status"] = json!("missed");
                db::update(&mut tx, "deployment", &d).await?;
                db::audit(
                    &mut tx,
                    "scheduler",
                    "deployment.missed",
                    text(&d, "id"),
                    "missed",
                )
                .await?;
                continue;
            }
            // A schedule was reviewed against assignments at creation time.
            // Recheck the same serialization gate at activation, before it
            // becomes a candidate or releases any target. Keep its stored
            // status scheduled during this check so a canary cannot block
            // itself. A failed activation requires a new operator review.
            let selected = candidate_targets(&mut tx, &d).await?;
            let blockers = creation_blockers(&mut tx, &d, &selected, None).await?;
            if !blockers.is_empty() {
                d["status"] = json!("failed");
                db::update(&mut tx, "deployment", &d).await?;
                let blocked_devices: BTreeSet<_> = blockers
                    .iter()
                    .flat_map(|blocker| blocker["device_ids"].as_array().unwrap())
                    .filter_map(Value::as_str)
                    .collect();
                for device in blocked_devices {
                    sqlx::query("UPDATE deployment_targets SET state='blocked',error='Scheduled activation blocked by an active canary; pause or cancel it, then create a new reviewed deployment' WHERE deployment_id=? AND device_id=? AND generation=0")
                        .bind(text(&d, "id"))
                        .bind(device)
                        .execute(&mut *tx)
                        .await?;
                }
                db::audit(
                    &mut tx,
                    "scheduler",
                    "deployment.activate",
                    text(&d, "id"),
                    "blocked",
                )
                .await?;
                continue;
            }
            let compatibility = compatibility_blockers(&mut tx, &d, &selected).await?;
            if !compatibility.is_empty() {
                let mut failures = BTreeMap::new();
                for blocker in &compatibility {
                    let reason = blocker["reason"]
                        .as_str()
                        .unwrap_or("Device compatibility changed after the schedule was saved");
                    if let Some(ids) = blocker["device_ids"].as_array() {
                        for id in ids.iter().filter_map(Value::as_str) {
                            failures.insert(id.to_owned(), reason);
                        }
                    }
                }
                for device in &selected {
                    let reason = failures.get(device).copied().unwrap_or(
                        "Schedule was not activated because another target became incompatible",
                    );
                    sqlx::query("UPDATE deployment_targets SET state=?,error=? WHERE deployment_id=? AND device_id=? AND generation=0")
                        .bind(if failures.contains_key(device) { "incompatible" } else { "blocked" })
                        .bind(reason)
                        .bind(text(&d, "id"))
                        .bind(device)
                        .execute(&mut *tx)
                        .await?;
                }
                d["status"] = json!("failed");
                db::update(&mut tx, "deployment", &d).await?;
                db::audit(
                    &mut tx,
                    "scheduler",
                    "deployment.activate",
                    text(&d, "id"),
                    "incompatible",
                )
                .await?;
                continue;
            }
            d["status"] = json!("active");
            db::update(&mut tx, "deployment", &d).await?;
            if !conflicts(&mut tx, None).await?.is_empty() {
                d["status"] = json!("failed");
                db::update(&mut tx, "deployment", &d).await?;
                db::audit(
                    &mut tx,
                    "scheduler",
                    "deployment.activate",
                    text(&d, "id"),
                    "conflict",
                )
                .await?;
                continue;
            }
            db::audit(
                &mut tx,
                "scheduler",
                "deployment.activate",
                text(&d, "id"),
                "success",
            )
            .await?;
        }
        if text(&d, "target_mode") == "persistent"
            && ["active", "paused", "completed"].contains(&text(&d, "status"))
        {
            let members = select_impl(&mut tx, &d["selector"], false).await?;
            mark_ineligible_targets(&mut tx, text(&d, "id"), &members).await?;
        }
        advance(&mut tx, &mut d).await?;
    }
    resolve(&mut tx).await?;
    let cutoff =
        (Utc::now() - chrono::Duration::days(db::telemetry_retention_days())).timestamp() / 60;
    sqlx::query("DELETE FROM telemetry WHERE bucket<?")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE expires_at<?")
        .bind(db::now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn action(
    db: &mut SqliteConnection,
    id: &str,
    action: &str,
    actor: &str,
) -> Result<Value> {
    let mut d = db::record(db, "deployment", id).await?;
    match action {
        "cancel" => {
            if !["active", "paused", "scheduled", "failed"].contains(&text(&d, "status")) {
                return Err(ApiError::conflict(
                    "Deployment cannot be cancelled in its current state",
                ));
            }
            d["status"] = json!("cancelled");
            d["cancelled_at"] = json!(db::now());
        }
        "pause" => {
            if d["status"] != "active" {
                return Err(ApiError::conflict("Only active deployments can be paused"));
            }
            d["status"] = json!("paused");
            crate::canary_gate::clear(&mut d);
        }
        "resume" => {
            if d["status"] != "paused" {
                return Err(ApiError::conflict("Only paused deployments can be resumed"));
            }
            // Pausing permits other reviewed deployments to be created. Resume
            // must recheck their canary gates before either changing status or
            // admitting another wave. Snapshot scope stays frozen; persistent
            // scope uses current selectors, and historical retired IDs cannot
            // authorize current delivery or create a spurious overlap.
            let mut selected = candidate_targets(db, &d).await?;
            let live: BTreeSet<String> =
                sqlx::query_scalar("SELECT id FROM devices WHERE revoked=0")
                    .fetch_all(&mut *db)
                    .await?
                    .into_iter()
                    .collect();
            selected.retain(|id| live.contains(id));
            if !creation_blockers(db, &d, &selected, Some(id))
                .await?
                .is_empty()
            {
                return Err(ApiError::new(
                    axum::http::StatusCode::CONFLICT,
                    "ACTIVE_CANARY_OVERLAP",
                    "This rollout overlaps another active canary. Wait for it to finish, or review its pause/cancel controls before resuming.",
                ));
            }
            if let Some(blocker) = compatibility_blockers(db, &d, &selected).await?.first() {
                return Err(ApiError::conflict(
                    blocker["reason"]
                        .as_str()
                        .unwrap_or("A target is incompatible"),
                ));
            }
            d["status"] = json!("active");
            crate::canary_gate::clear(&mut d);
        }
        "unassign" => {
            if !candidate_status(&d) {
                return Err(ApiError::conflict(
                    "Only an activated assignment can be removed",
                ));
            }
            // Keep how the rollout itself ended; removal is an assignment change.
            d["status_before_removal"] = d["status"].clone();
            d["removed_at"] = json!(db::now());
            d["status"] = json!("unassigned");
        }
        "rollback" => {
            if !candidate_status(&d) {
                return Err(ApiError::conflict(
                    "Only an activated assignment can be rolled back; create a new reviewed deployment for removed assignments",
                ));
            }
            if kind(&d) != "configuration" {
                return Err(ApiError::invalid(
                    "Create a new policy deployment to restore an earlier policy",
                ));
            }
            let rows=sqlx::query("SELECT device_id,previous_version_id FROM deployment_targets WHERE deployment_id=? AND generation>0 AND state<>'removed'").bind(id).fetch_all(&mut *db).await?;
            let previous: BTreeSet<String> = rows
                .iter()
                .filter_map(|r| r.get::<Option<String>, _>("previous_version_id"))
                .collect();
            if previous.len() != 1
                || rows
                    .iter()
                    .any(|r| r.get::<Option<String>, _>("previous_version_id").is_none())
            {
                return Err(ApiError::conflict(
                    "Rollback needs one previously managed version; target devices individually when prior versions differ",
                ));
            }
            return execute_rollback(
                db,
                d,
                previous.first().unwrap(),
                rows.iter()
                    .map(|r| r.get::<String, _>("device_id"))
                    .collect(),
                actor,
            )
            .await;
        }
        _ => return Err(ApiError::missing()),
    }
    db::update(db, "deployment", &d).await?;
    db::audit(db, actor, &format!("deployment.{action}"), id, "success").await?;
    if action == "resume" {
        advance(db, &mut d).await?;
        resolve(db).await?;
    }
    if action == "unassign" {
        resolve(db).await?;
    }
    deployment(db, id).await
}

/// Internal reviewed plan execution; caller holds the writer transaction and
/// has either validated a fresh review or retained legacy strict target rules.
pub(crate) async fn execute_rollback(
    db: &mut SqliteConnection,
    mut d: Value,
    previous: &str,
    devices: Vec<String>,
    actor: &str,
) -> Result<Value> {
    let prior_version = db::record(db, "version", previous).await?;
    let mut rollback_artifacts = serde_json::Map::new();
    for device in &devices {
        let row = sqlx::query("SELECT previous_version_id,previous_artifact_sha256,previous_generation FROM deployment_targets WHERE deployment_id=? AND device_id=? AND generation>0 AND state<>'removed'")
            .bind(text(&d,"id")).bind(device).fetch_optional(&mut *db).await?.ok_or_else(||ApiError::conflict("Rollback target history changed"))?;
        if row
            .get::<Option<String>, _>("previous_version_id")
            .as_deref()
            != Some(previous)
        {
            return Err(ApiError::conflict("Rollback prior version changed"));
        }
        let prior_sha = row.get::<Option<String>, _>("previous_artifact_sha256");
        let prior_generation = row.get::<Option<i64>, _>("previous_generation");
        if let (Some(sha), Some(generation)) = (prior_sha.as_deref(), prior_generation) {
            let associated:Option<String>=sqlx::query_scalar("SELECT sha256 FROM desired_artifacts WHERE device_id=? AND generation=? AND version_id=?")
                .bind(device).bind(generation).bind(previous).fetch_optional(&mut *db).await?;
            if associated.as_deref() != Some(sha) {
                return Err(ApiError::conflict(
                    "Prior target artifact association changed",
                ));
            }
        } else if prior_sha.is_some() || prior_generation.is_some() {
            return Err(ApiError::conflict(
                "Prior target artifact history is incomplete",
            ));
        }
        let sha = if let Some(sha) = prior_sha {
            sha
        } else if prior_version["variables"]
            .as_array()
            .is_none_or(Vec::is_empty)
        {
            text(&prior_version, "sha256").to_owned()
        } else {
            return Err(ApiError::conflict(
                "Prior target artifact is unavailable; create a new reviewed deployment",
            ));
        };
        // Preflight the retained bytes before changing the source assignment.
        let blob = crate::variables::blob(db, &sha).await.or_else(|_| {
            if sha == text(&prior_version, "sha256")
                && prior_version["variables"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
            {
                crate::variables::render(&prior_version, &Value::Null, device)
            } else {
                Err(ApiError::conflict(
                    "Prior target artifact bytes are unavailable",
                ))
            }
        })?;
        if blob.sha256 != sha {
            return Err(ApiError::conflict("Prior target artifact identity changed"));
        }
        rollback_artifacts.insert(device.clone(), json!(sha));
    }
    let original_priority = d["priority"].as_i64().unwrap_or(0);
    let at_ceiling = original_priority == 1_000_000;
    let rollback_priority = if at_ceiling {
        original_priority
    } else {
        original_priority + 1
    };
    let target_set = devices.iter().cloned().collect::<BTreeSet<_>>();
    if let Some(blocker) =
        rollback_blockers(db, text(&d, "id"), previous, rollback_priority, &target_set)
            .await?
            .first()
    {
        return Err(ApiError::conflict(
            blocker["reason"].as_str().unwrap_or("Rollback is blocked"),
        ));
    }
    // The source stops releasing (or loses its binding at the ceiling), but its
    // history keeps how the rollout itself ended and links to the rollback.
    d["status_before_rollback"] = d["status"].clone();
    if at_ceiling {
        d["status_before_removal"] = d["status"].clone();
        d["removed_at"] = json!(db::now());
    }
    d["status"] = json!(if at_ceiling {
        "unassigned"
    } else {
        "cancelled"
    });
    db::update(db, "deployment", &d).await?;
    let v = json!({"version_id":previous,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":rollback_priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0},"rollback_artifacts":rollback_artifacts,"rollback_of":d["id"]});
    let result = create_inner(db, &v, actor, true).await?;
    d["rolled_back_by"] = result["id"].clone();
    d["rolled_back_at"] = json!(db::now());
    db::update(db, "deployment", &d).await?;
    db::audit(db, actor, "deployment.rollback", text(&d, "id"), "success").await?;
    Ok(result)
}

/// Preview the replacement after excluding only the trusted original binding.
/// No temporary writes, target changes, or audit events are needed to review.
pub(crate) async fn rollback_blockers(
    db: &mut SqliteConnection,
    source: &str,
    version: &str,
    priority: i64,
    devices: &BTreeSet<String>,
) -> Result<Vec<Value>> {
    let prior_version = db::record(db, "version", version).await?;
    let mut artifacts = serde_json::Map::new();
    for device in devices {
        let prior_sha:Option<String>=sqlx::query_scalar("SELECT previous_artifact_sha256 FROM deployment_targets WHERE deployment_id=? AND device_id=?")
            .bind(source).bind(device).fetch_optional(&mut *db).await?.flatten();
        let sha = prior_sha
            .or_else(|| {
                prior_version["variables"]
                    .as_array()
                    .is_none_or(Vec::is_empty)
                    .then(|| text(&prior_version, "sha256").to_owned())
            })
            .ok_or_else(|| ApiError::conflict("Prior target artifact is unavailable"))?;
        artifacts.insert(device.clone(), json!(sha));
    }
    let candidate = json!({"id":"rollback-preview","version_id":version,"rollback_artifacts":artifacts,"priority":priority,"status":"active","target_mode":"snapshot","selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]}});
    let mut out = Vec::new();
    if !conflicts_excluding(db, Some(&candidate), Some(source))
        .await?
        .is_empty()
    {
        out.push(json!({"code":"ASSIGNMENT_CONFLICT","reason":"The rollback would conflict with another equal-priority assignment. Review active assignments before continuing."}));
    }
    if !creation_blockers(db, &candidate, devices, Some(source))
        .await?
        .is_empty()
    {
        out.push(json!({"code":"ACTIVE_CANARY_OVERLAP","reason":"Another active canary overlaps the rollback targets. Wait for it to finish, or review its pause/cancel controls."}));
    }
    out.extend(compatibility_blockers(db, &candidate, devices).await?);
    // Admission is not priority selection: even an unreleased winning target
    // prevents this replacement from owning delivery. At equal priority with
    // identical content, the newly allocated UUID would decide the winner, so
    // a read-only review cannot promise this assignment will be selected.
    let mut higher = false;
    let mut tied = false;
    for existing in db::records(db, "deployment")
        .await?
        .into_iter()
        .filter(|d| candidate_status(d) && kind(d) == "configuration" && text(d, "id") != source)
    {
        let existing_priority = existing["priority"].as_i64().unwrap_or(0);
        if existing_priority >= priority
            && !candidate_targets(db, &existing).await?.is_disjoint(devices)
        {
            higher |= existing_priority > priority;
            tied |= existing_priority == priority;
        }
    }
    if higher {
        out.push(json!({"code":"HIGHER_PRIORITY_ASSIGNMENT","reason":"A higher-priority configuration assignment still selects an included identity. This rollback would not own its delivery. Review current assignments before continuing; priority has not been raised automatically."}));
    }
    if tied {
        out.push(json!({"code":"ASSIGNMENT_PRECEDENCE","reason":"An equal-priority configuration assignment also selects an included identity. Delivery ownership would depend on assignment identity; review current assignments before continuing."}));
    }
    Ok(out)
}
