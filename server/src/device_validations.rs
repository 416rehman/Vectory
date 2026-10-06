//! Check on devices: before deploying, ask the real hosts to validate a
//! candidate pipeline version on themselves, without activating it.
//!
//! A check rides `POST /deployments/preview` (`device_validation: true`). It
//! stores one row per addressed device, holding the candidate exactly as that
//! device would be offered it: its own variable values applied, device secrets
//! still references. The signed manifest of a device that announced the
//! feature carries `validation` while its row is pending and unexpired. The
//! agent downloads the candidate (`/agent/v1/artifacts/{sha256}` authorizes
//! the digest of that device's own pending check and of no other device's),
//! validates a staged copy and reports the answer in its next heartbeat.
//!
//! An answer updates its own row and nothing else: no desired state, no
//! generation, no policy and no issue changes because of it, and nothing waits
//! for it. The candidate bytes leave the row with the answer, the expiry or a
//! newer check for the same device; the rest is kept 24 hours.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
    fleet, rollout, variables,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

/// Listed in the manifest's `features`, and in a heartbeat's `agent_features`
/// by an agent that can be checked on.
pub const FEATURE: &str = "validation";
/// A check expires this long after it was requested.
pub const EXPIRY_MINUTES: i64 = 10;
/// Devices one request checks, the first by name; more set `truncated`.
pub const MAX_DEVICES: usize = 50;
/// Candidate bytes one request stores. Each artifact is at most 1 MiB, so this
/// only binds a pipeline of hundreds of kilobytes with a value per device.
const MAX_REQUEST_BYTES: usize = 10 * 1024 * 1024;
/// Candidate bytes waiting for devices across the whole server.
const MAX_WAITING_BYTES: i64 = 128 * 1024 * 1024;
/// Checks a minute per user.
const REQUESTS_PER_MINUTE: u32 = 6;
/// Reads of a check a minute per account: a dialog polls every two seconds.
const READS_PER_MINUTE: u32 = 240;
/// Rows, and the answers in them, are kept this long.
const RETENTION_HOURS: i64 = 24;
const MAX_FEATURES: usize = 16;
const MAX_DIAGNOSTICS: usize = 20;
const MAX_TESTS: usize = 100;
const MAX_DURATION_MS: u64 = 86_400_000;
const MAX_LISTENERS: u64 = 1_000_000;
/// The stored answer, serialized. Every part is bounded already, but JSON
/// escapes can double a string, so the whole is bounded too: the table refuses
/// more than this, and an answer past it is refused with the heartbeat as a
/// `400`, never as a failure the agent would repeat.
const MAX_RESULT_BYTES: usize = 131_072;

fn timestamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// What a preview body adds to ask for a check. Taken out of the body before
/// the deployment validation sees it: they are not part of a deployment, so
/// creating one still refuses them.
#[derive(Clone, Copy, Debug, Default)]
pub struct Request {
    pub device_validation: bool,
    pub run_tests: bool,
}

impl Request {
    pub fn take(body: &mut Value) -> Result<Self> {
        let Some(fields) = body.as_object_mut() else {
            return Ok(Self::default());
        };
        let mut flag = |key: &str| match fields.remove(key) {
            None => Ok(false),
            Some(Value::Bool(value)) => Ok(value),
            Some(_) => Err(ApiError::invalid(format!("{key} must be true or false"))),
        };
        Ok(Self {
            device_validation: flag("device_validation")?,
            run_tests: flag("run_tests")?,
        })
    }

    /// Checking a pipeline needs a version; agent settings have nothing to check.
    pub fn check(&self, body: &Value) -> Result<()> {
        if self.device_validation && !body["version_id"].is_string() {
            return Err(ApiError::invalid(
                "Checking devices applies to a pipeline version, not to agent settings",
            ));
        }
        Ok(())
    }

    /// At most six checks a minute per user. Charged when a check is asked
    /// for, before the writer lock is taken.
    pub fn limit(&self, s: &State, user: &Value) -> Result<()> {
        if !self.device_validation {
            return Ok(());
        }
        s.limit(
            format!("device-validation:{}", user["id"].as_str().unwrap_or("")),
            REQUESTS_PER_MINUTE,
            std::time::Duration::from_secs(60),
        )
    }
}

/// What a created check tells its requester.
pub struct Created {
    pub id: String,
    pub truncated: bool,
    /// The devices that were asked and not yet answered: once the request has
    /// committed, a parked wait of each answers, so the check starts in
    /// seconds instead of at the device's next scheduled check-in.
    pub asked: Vec<String>,
}

/// Whether the device's last report announced that it can be checked on.
fn announced(device: &Value) -> bool {
    device["agent_features"]
        .as_array()
        .is_some_and(|features| features.iter().any(|name| name == FEATURE))
}

/// Create the check for a preview that has just been computed: one row per
/// reviewed device that is not revoked, the first `MAX_DEVICES` by name. A
/// device that last checked in more than three of its own intervals ago, or
/// never, is `offline` at once, and one that never announced the feature is
/// `unsupported`; neither is waited for. A newer check supersedes the older
/// pending one of the same device. Returns nothing when no device is
/// addressed.
pub async fn create(
    tx: &mut SqliteConnection,
    actor: &str,
    request: &Value,
    preview: &Value,
    run_tests: bool,
) -> Result<Option<Created>> {
    let version_id = request["version_id"]
        .as_str()
        .ok_or_else(|| ApiError::invalid("Checking devices needs a pipeline version"))?;
    // The digests the preview computed for every reviewed device.
    let reviewed: BTreeMap<&str, (&str, i64)> = preview["artifact_previews"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry["device_id"].as_str()?,
                (entry["sha256"].as_str()?, entry["size"].as_i64()?),
            ))
        })
        .collect();
    if reviewed.is_empty() {
        return Ok(None);
    }
    let mut named: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,name FROM devices WHERE revoked=0 AND id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(reviewed.keys().collect::<Vec<_>>()).to_string())
    .fetch_all(&mut *tx)
    .await?;
    named.sort_by(|(a_id, a), (b_id, b)| fleet::natural(a, b).then_with(|| a_id.cmp(b_id)));
    let selected = named.len();
    named.truncate(MAX_DEVICES);
    if named.is_empty() {
        return Ok(None);
    }

    let version = db::record(tx, "version", version_id).await?;
    let rows = sqlx::query(
        "SELECT id,data,policy,policy_generation FROM devices WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(named.iter().map(|(id, _)| id).collect::<Vec<_>>()).to_string())
    .fetch_all(&mut *tx)
    .await?;
    let mut devices = BTreeMap::new();
    for row in rows {
        let data = db::parse(row.get("data"))?;
        let policy = db::parse(row.get("policy"))?;
        let interval = rollout::check_in_seconds(&policy, &data, row.get("policy_generation"));
        let online = rollout::checked_in_recently(data["last_seen"].as_str(), interval);
        let state = if !online {
            "offline"
        } else if !announced(&data) {
            "unsupported"
        } else {
            "pending"
        };
        devices.insert(row.get::<String, _>("id"), state);
    }

    // The candidate each device would be offered, the bytes only for a device
    // that will be asked. The request stores a bounded amount: a device that
    // would exceed it, and every device after it, is left out and the request
    // says it was truncated.
    let mut stored = Vec::with_capacity(named.len());
    let mut bytes = 0usize;
    for (device, name) in &named {
        let state = devices.get(device).copied().unwrap_or("offline");
        let &(sha256, size) = reviewed
            .get(device.as_str())
            .ok_or_else(|| ApiError::conflict("The reviewed devices changed. Review again."))?;
        let artifact = if state == "pending" {
            let artifact = variables::render(&version, &request["variable_bindings"], device)?;
            if artifact.sha256 != sha256 || i64::try_from(artifact.size) != Ok(size) {
                return Err(ApiError::conflict(
                    "The candidate changed while the check was prepared. Review again.",
                ));
            }
            if bytes + artifact.size > MAX_REQUEST_BYTES {
                break;
            }
            bytes += artifact.size;
            Some(artifact.bytes)
        } else {
            None
        };
        stored.push((device, name, state, sha256, size, artifact));
    }
    if stored.is_empty() {
        return Ok(None);
    }

    let now = Utc::now();
    let (created_at, expires_at) = (
        timestamp(now),
        timestamp(now + Duration::minutes(EXPIRY_MINUTES)),
    );
    let addressed = json!(stored.iter().map(|row| row.0).collect::<Vec<_>>()).to_string();
    // One outstanding check per device: the older pending one ends here.
    sqlx::query("UPDATE device_validations SET state='expired',artifact=NULL,updated_at=? WHERE state='pending' AND device_id IN (SELECT value FROM json_each(?))")
        .bind(&created_at)
        .bind(&addressed)
        .execute(&mut *tx)
        .await?;
    let waiting: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(size),0) FROM device_validations WHERE state='pending' AND artifact IS NOT NULL",
    )
    .fetch_one(&mut *tx)
    .await?;
    if waiting + bytes as i64 > MAX_WAITING_BYTES {
        return Err(ApiError::throttled(
            "CAPACITY_BUSY",
            "Too many device checks are waiting for answers. Try again in a few minutes.",
            60,
        ));
    }

    let id = db::id();
    let truncated = stored.len() < selected;
    let configuration_id = version["configuration_id"].as_str().unwrap_or("");
    let (mut pending, mut offline, mut unsupported) = (0, 0, 0);
    for (device, name, state, sha256, size, artifact) in &stored {
        match *state {
            "pending" => pending += 1,
            "offline" => offline += 1,
            _ => unsupported += 1,
        }
        sqlx::query("INSERT INTO device_validations(id,device_id,device_name,configuration_id,version_id,sha256,size,run_tests,truncated,requested_by,created_at,expires_at,state,artifact,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(&id)
            .bind(device)
            .bind(name)
            .bind(configuration_id)
            .bind(version_id)
            .bind(sha256)
            .bind(size)
            .bind(run_tests)
            .bind(truncated)
            .bind(actor)
            .bind(&created_at)
            .bind(&expires_at)
            .bind(state)
            .bind(artifact.as_deref().map(str::as_bytes))
            .bind(&created_at)
            .execute(&mut *tx)
            .await?;
    }
    // Counts and the pipeline version's identity, never the configuration.
    db::insert(
        tx,
        "audit",
        &json!({"id":db::id(),"actor":actor,"action":"deployment.device_validation_requested","target":version_id,"outcome":"success","created_at":created_at,
            "details":{"validation_id":id,"configuration_id":configuration_id,"version_id":version_id,"run_tests":run_tests,"device_count":stored.len(),"pending_count":pending,"offline_count":offline,"unsupported_count":unsupported,"truncated":truncated}}),
    )
    .await?;
    let asked = stored
        .iter()
        .filter(|row| row.2 == "pending")
        .map(|row| row.0.clone())
        .collect();
    Ok(Some(Created {
        id,
        truncated,
        asked,
    }))
}

/// The two display fields `vectory status` reads, from the version a manifest
/// names: its number within the pipeline and the pipeline's name as the server
/// shows it. Each is left out when it is not valid, never guessed.
pub async fn labels(
    tx: &mut SqliteConnection,
    version: &Value,
) -> Result<(Option<i64>, Option<String>)> {
    let number = version["number"]
        .as_i64()
        .filter(|n| (1..=9_007_199_254_740_991).contains(n));
    let name: Option<String> = match version["configuration_id"].as_str() {
        Some(configuration) => {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT CASE WHEN json_type(data,'$.name')='text' THEN substr(json_extract(data,'$.name'),1,120) END FROM records WHERE kind='configuration' AND id=?",
            )
            .bind(configuration)
            .fetch_optional(&mut *tx)
            .await?
            .flatten()
        }
        None => None,
    };
    let name =
        name.filter(|name| !name.is_empty() && !name.chars().any(crate::db::hostile_display_char));
    Ok((number, name))
}

/* ---------- The heartbeat ---------- */

/// What a heartbeat adds for this feature: what the agent announced it can
/// do, its readiness facts and the answer to a check. Every member is
/// optional, sent only after a verified manifest listed `validation`.
#[derive(Debug, Default)]
pub struct Reported {
    pub features: Option<Vec<String>>,
    pub readiness: Option<Value>,
    pub answer: Option<Answer>,
}

#[derive(Debug)]
pub struct Answer {
    pub id: String,
    pub valid: bool,
    /// What the row keeps: `valid`, `diagnostics`, `tests`, `secrets_missing`
    /// and `duration_ms` when sent.
    pub stored: Value,
}

fn invalid(what: &str) -> ApiError {
    ApiError::invalid(format!("Invalid {what}"))
}

/// A null stands for an absent member, as it does for an encoder that writes
/// nil as null.
fn member<'a>(heartbeat: &'a Value, key: &str) -> Option<&'a Value> {
    heartbeat.get(key).filter(|value| !value.is_null())
}

fn plain_text(value: &Value, most: usize, least: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|text| (least..=most).contains(&text.len()) && !text.chars().any(char::is_control))
}

/// The name of one of a pipeline's tests: it names something the pipeline
/// defines, so it is held to the rule for names (`db::refused_in_name`), as the
/// other members that name or identify something are.
fn test_name(value: &Value, most: usize) -> Option<&str> {
    plain_text(value, most, 1).filter(|text| !text.chars().any(db::refused_in_name))
}

/// Validate this feature's heartbeat members, strictly: allowlisted keys,
/// bounds and charsets, unknown keys refuse the whole heartbeat. Nothing here
/// reads the database, so a refusal never leaves a partial write.
pub fn parse(heartbeat: &Value) -> Result<Reported> {
    let features = member(heartbeat, "agent_features")
        .map(|list| {
            let list = list
                .as_array()
                .filter(|list| list.len() <= MAX_FEATURES)
                .ok_or_else(|| invalid("agent_features"))?;
            list.iter()
                .map(|name| {
                    name.as_str()
                        .filter(|name| {
                            (1..=32).contains(&name.len())
                                && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                        })
                        .map(str::to_owned)
                        .ok_or_else(|| invalid("agent_features"))
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?;
    let readiness = member(heartbeat, "readiness")
        .map(|facts| {
            let facts = facts.as_object().ok_or_else(|| invalid("readiness"))?;
            let mut kept = serde_json::Map::new();
            for (key, value) in facts {
                let ok = match key.as_str() {
                    "data_dir_writable" => value.is_boolean(),
                    "allowed_listener_count" => {
                        value.as_u64().is_some_and(|count| count <= MAX_LISTENERS)
                    }
                    _ => false,
                };
                // A null stands for a fact the agent does not report.
                let unreported = value.is_null()
                    && matches!(key.as_str(), "data_dir_writable" | "allowed_listener_count");
                if unreported {
                    continue;
                }
                if !ok {
                    return Err(invalid("readiness"));
                }
                kept.insert(key.clone(), value.clone());
            }
            Ok(Value::Object(kept))
        })
        .transpose()?;
    let answer = member(heartbeat, "validation_result")
        .map(parse_answer)
        .transpose()?;
    Ok(Reported {
        features,
        readiness,
        answer,
    })
}

fn parse_answer(result: &Value) -> Result<Answer> {
    let bad = || invalid("validation_result");
    let fields = result.as_object().ok_or_else(bad)?;
    if fields.keys().any(|key| {
        ![
            "id",
            "valid",
            "diagnostics",
            "tests",
            "duration_ms",
            "secrets_missing",
        ]
        .contains(&key.as_str())
    }) {
        return Err(bad());
    }
    let id = fields
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| {
            uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == *id)
        })
        .ok_or_else(bad)?;
    let valid = fields
        .get("valid")
        .and_then(Value::as_bool)
        .ok_or_else(bad)?;
    let mut stored = json!({"valid":valid});
    // Errors first, whatever order they arrived in.
    let mut diagnostics = match fields.get("diagnostics").filter(|list| !list.is_null()) {
        Some(list) => crate::configuration_attempt::diagnostics_up_to(list, MAX_DIAGNOSTICS)?
            .as_array()
            .cloned()
            .unwrap_or_default(),
        None => Vec::new(),
    };
    diagnostics.sort_by_key(|diagnostic| diagnostic["severity"] != "error");
    stored["diagnostics"] = Value::Array(diagnostics);
    stored["tests"] = Value::Array(match fields.get("tests").filter(|list| !list.is_null()) {
        Some(list) => parse_tests(list)?,
        None => Vec::new(),
    });
    stored["secrets_missing"] = match fields.get("secrets_missing").filter(|list| !list.is_null()) {
        Some(list) => crate::validation::reported_secret_names(list).ok_or_else(bad)?,
        None => json!([]),
    };
    if let Some(duration) = fields.get("duration_ms").filter(|value| !value.is_null()) {
        let milliseconds = duration
            .as_u64()
            .filter(|ms| *ms <= MAX_DURATION_MS)
            .ok_or_else(bad)?;
        stored["duration_ms"] = json!(milliseconds);
    }
    if stored.to_string().len() > MAX_RESULT_BYTES {
        return Err(bad());
    }
    Ok(Answer {
        id: id.to_owned(),
        valid,
        stored,
    })
}

/// At most 100 results of the pipeline's own tests: a name, whether it passed,
/// whether Vector never ran it and a short message.
fn parse_tests(list: &Value) -> Result<Vec<Value>> {
    let bad = || invalid("validation_result.tests");
    let items = list
        .as_array()
        .filter(|items| items.len() <= MAX_TESTS)
        .ok_or_else(bad)?;
    items
        .iter()
        .map(|item| {
            let fields = item.as_object().ok_or_else(bad)?;
            if fields
                .keys()
                .any(|key| !["name", "passed", "not_run", "message"].contains(&key.as_str()))
            {
                return Err(bad());
            }
            let name = fields
                .get("name")
                .and_then(|name| test_name(name, 200))
                .ok_or_else(bad)?;
            let passed = fields
                .get("passed")
                .and_then(Value::as_bool)
                .ok_or_else(bad)?;
            let mut test = json!({"name":name,"passed":passed});
            if let Some(not_run) = fields.get("not_run").filter(|value| !value.is_null()) {
                test["not_run"] = json!(not_run.as_bool().ok_or_else(bad)?);
            }
            if let Some(message) = fields.get("message").filter(|value| !value.is_null()) {
                let message = plain_text(message, 512, 0).ok_or_else(bad)?;
                if !message.is_empty() {
                    test["message"] = json!(message);
                }
            }
            Ok(test)
        })
        .collect()
}

/// Keep, on the device's record, what its latest check-in announced and the
/// readiness it reported: current, or unknown when the agent doesn't say,
/// never stale.
pub fn remember(device: &mut serde_json::Map<String, Value>, reported: &Reported) {
    match &reported.features {
        Some(features) => {
            device.insert("agent_features".into(), json!(features));
        }
        None => {
            device.remove("agent_features");
        }
    }
    match &reported.readiness {
        Some(facts) => {
            device.insert("readiness".into(), facts.clone());
        }
        None => {
            device.remove("readiness");
        }
    }
}

/// Record the answer a heartbeat carries, then say which check the manifest
/// must now carry. An answer counts only for this device's own pending check
/// that has not expired; a repeat for one already answered, an expired one or
/// an unknown ID is ignored, never an error. The manifest carries `validation`
/// only while the device has a pending, unexpired check and announced the
/// feature in this very heartbeat.
pub async fn heartbeat(
    tx: &mut SqliteConnection,
    device: &str,
    reported: &Reported,
) -> Result<Option<Value>> {
    let now = db::now();
    if let Some(answer) = &reported.answer {
        sqlx::query("UPDATE device_validations SET state=?,result_json=?,artifact=NULL,updated_at=? WHERE id=? AND device_id=? AND state='pending' AND expires_at>?")
            .bind(if answer.valid { "passed" } else { "failed" })
            .bind(answer.stored.to_string())
            .bind(&now)
            .bind(&answer.id)
            .bind(device)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    let announced = reported
        .features
        .as_ref()
        .is_some_and(|features| features.iter().any(|name| name == FEATURE));
    if !announced {
        return Ok(None);
    }
    let Some(row) = sqlx::query("SELECT id,sha256,size,run_tests,expires_at FROM device_validations WHERE device_id=? AND state='pending' AND expires_at>? AND artifact IS NOT NULL")
        .bind(device)
        .bind(&now)
        .fetch_optional(&mut *tx)
        .await?
    else {
        return Ok(None);
    };
    let sha256: String = row.get("sha256");
    Ok(Some(json!({
        "id":row.get::<String,_>("id"),
        "sha256":sha256,
        "size":row.get::<i64,_>("size"),
        "artifact_path":format!("/agent/v1/artifacts/{sha256}"),
        "run_tests":row.get::<bool,_>("run_tests"),
        "expires_at":row.get::<String,_>("expires_at"),
    })))
}

/// The candidate bytes of this device's own pending, unexpired check with this
/// digest, for the artifact download: never another device's, never one that
/// was answered, superseded or has expired.
pub async fn candidate(
    tx: &mut SqliteConnection,
    device: &str,
    sha256: &str,
) -> Result<Option<Vec<u8>>> {
    let row = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT artifact FROM device_validations WHERE device_id=? AND sha256=? AND state='pending' AND expires_at>? AND artifact IS NOT NULL",
    )
    .bind(device)
    .bind(sha256)
    .bind(db::now())
    .fetch_optional(&mut *tx)
    .await?;
    // The digest is the identity: bytes that don't hash to it are never served.
    Ok(row.filter(|bytes| db::hash(bytes) == sha256))
}

/// A device that can no longer answer (revoked, or replaced by a recovery)
/// stops being waited for.
pub async fn end_for(tx: &mut SqliteConnection, device: &str) -> Result<()> {
    sqlx::query("UPDATE device_validations SET state='expired',artifact=NULL,updated_at=? WHERE device_id=? AND state='pending'")
        .bind(db::now())
        .bind(device)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

/// Retention, from the minute-by-minute job: a pending check past its expiry
/// is expired, bytes only a pending check keeps are cleared, and rows older
/// than 24 hours go.
pub async fn prune(tx: &mut SqliteConnection) -> Result<()> {
    let now = db::now();
    sqlx::query("UPDATE device_validations SET state='expired',artifact=NULL,updated_at=expires_at WHERE state='pending' AND expires_at<=?")
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM device_validations WHERE created_at<?")
        .bind(timestamp(Utc::now() - Duration::hours(RETENTION_HOURS)))
        .execute(&mut *tx)
        .await?;
    Ok(())
}

/* ---------- Reading a check ---------- */

/// `GET /device-validations/{id}`: the check's devices in name order, for the
/// person who requested it or an administrator; anyone else gets 404 exactly
/// as for an ID that does not exist.
pub async fn get(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let reader = auth::authorize(&s, &h, &["operator"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let id = crate::deployment_requests::parse_id(&id)
        .map_err(|_| ApiError::invalid("A device check ID is a hyphenated UUID"))?;
    s.limit(
        format!(
            "device-validation-read:{}",
            reader["id"].as_str().unwrap_or("")
        ),
        READS_PER_MINUTE,
        std::time::Duration::from_secs(60),
    )?;
    let mut conn = s.pool.acquire().await?;
    let rows = sqlx::query("SELECT device_id,device_name,state,run_tests,truncated,requested_by,created_at,expires_at,result_json,updated_at FROM device_validations WHERE id=?")
        .bind(&id)
        .fetch_all(&mut *conn)
        .await?;
    drop(conn);
    let Some(first) = rows.first() else {
        return Err(ApiError::missing());
    };
    if first.get::<String, _>("requested_by") != reader["id"].as_str().unwrap_or("")
        && reader["role"] != "admin"
    {
        return Err(ApiError::missing());
    }
    let check = Check {
        created_at: first.get("created_at"),
        expires_at: first.get("expires_at"),
        truncated: first.get("truncated"),
        run_tests: first.get("run_tests"),
    };
    let entries = rows
        .iter()
        .map(|row| Entry {
            device_id: row.get("device_id"),
            name: row.get("device_name"),
            state: row.get("state"),
            updated_at: row.get("updated_at"),
            result: row.get("result_json"),
        })
        .collect();
    Ok(Json(describe(&id, &check, entries, &db::now())?))
}

/// What every device of one check shares.
struct Check {
    created_at: String,
    expires_at: String,
    truncated: bool,
    run_tests: bool,
}

/// One device's row.
struct Entry {
    device_id: String,
    name: String,
    state: String,
    updated_at: String,
    result: Option<String>,
}

fn unreadable<E>(_: E) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "A stored device check could not be read",
    )
}

/// The check as the dashboard reads it. A pending device whose time has run
/// out reads `expired` whether or not the minute-by-minute job has recorded
/// it yet, and the check is complete when no device is pending.
fn describe(id: &str, check: &Check, entries: Vec<Entry>, now: &str) -> Result<Value> {
    let lapsed = check.expires_at.as_str() <= now;
    let mut devices = Vec::with_capacity(entries.len());
    let mut pending = false;
    for entry in entries {
        let expired = entry.state == "pending" && lapsed;
        let state = if expired {
            "expired"
        } else {
            entry.state.as_str()
        };
        pending |= state == "pending";
        let updated_at = if expired {
            check.expires_at.as_str()
        } else {
            entry.updated_at.as_str()
        };
        let mut device = json!({"id":entry.device_id,"name":entry.name,"state":state,"diagnostics":[],"tests":[],"secrets_missing":[],"updated_at":updated_at});
        if let Some(result) = &entry.result {
            let result = db::parse(result).map_err(unreadable)?;
            device["valid"] = result["valid"].clone();
            for key in ["diagnostics", "tests", "secrets_missing"] {
                if result[key].is_array() {
                    device[key] = result[key].clone();
                }
            }
            if !result["duration_ms"].is_null() {
                device["duration_ms"] = result["duration_ms"].clone();
            }
        }
        devices.push((entry.name, entry.device_id, device));
    }
    devices.sort_by(|a, b| fleet::natural(&a.0, &b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(json!({
        "id":id,
        "state":if pending { "running" } else { "complete" },
        "created_at":check.created_at,
        "expires_at":check.expires_at,
        "truncated":check.truncated,
        "run_tests":check.run_tests,
        "devices":devices.into_iter().map(|(_, _, device)| device).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_preview_body_loses_exactly_the_check_fields() {
        let mut body =
            json!({"version_id":"v","device_validation":true,"run_tests":true,"priority":1});
        let request = Request::take(&mut body).unwrap();
        assert!(request.device_validation && request.run_tests);
        assert_eq!(body, json!({"version_id":"v","priority":1}));
        let mut body = json!({"device_validation":"yes"});
        assert!(Request::take(&mut body).is_err());
        let mut body = json!({"run_tests":1});
        assert!(Request::take(&mut body).is_err());
        let mut body = json!([1]);
        assert!(!Request::take(&mut body).unwrap().device_validation);
    }

    #[test]
    fn the_new_heartbeat_members_are_strict_and_optional() {
        let reported = parse(&json!({})).unwrap();
        assert!(
            reported.features.is_none()
                && reported.readiness.is_none()
                && reported.answer.is_none()
        );
        // null stands for absent.
        let reported =
            parse(&json!({"agent_features":null,"readiness":null,"validation_result":null}))
                .unwrap();
        assert!(reported.features.is_none() && reported.answer.is_none());
        let reported = parse(&json!({"agent_features":["validation","some_future_thing"],"readiness":{"data_dir_writable":false,"allowed_listener_count":3}})).unwrap();
        assert_eq!(
            reported.features.unwrap(),
            ["validation", "some_future_thing"]
        );
        // A fact the agent does not report may be null, and is then absent.
        let reported =
            parse(&json!({"readiness":{"data_dir_writable":null,"allowed_listener_count":3}}))
                .unwrap();
        assert_eq!(
            reported.readiness.unwrap(),
            json!({"allowed_listener_count":3})
        );
        for bad in [
            json!({"agent_features":"validation"}),
            json!({"agent_features":["Validation"]}),
            json!({"agent_features":["has space"]}),
            json!({"agent_features":[""]}),
            json!({"agent_features":["a".repeat(33)]}),
            json!({"agent_features":vec!["a"; 17]}),
            json!({"readiness":{"data_dir_writable":"yes"}}),
            json!({"readiness":{"allowed_listener_count":-1}}),
            json!({"readiness":{"allowed_listener_count":1.5}}),
            json!({"readiness":{"allowed_listener_count":1_000_001}}),
            json!({"readiness":{"data_dir_writable":true,"extra":1}}),
            json!({"readiness":[]}),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    fn result(extra: Value) -> Value {
        let mut base = json!({"id":"3f0f7b3e-4f7b-4f27-8a43-0f8d7fd8d7f1","valid":true});
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        json!({"validation_result":base})
    }

    #[test]
    fn a_result_keeps_only_bounded_allowlisted_fields_with_errors_first() {
        let heartbeat = result(json!({
            "valid":false,
            "diagnostics":[
                {"severity":"warning","code":"HEALTHCHECK_FAILED","message":"A health check failed."},
                {"severity":"error","code":"INVALID_ADDRESS","component_id":"in","field":"address","message":"Not an address.","hint":"Use host:port."}
            ],
            "tests":[{"name":"routes errors","passed":false,"message":"no output"},{"name":"b","passed":false,"not_run":true,"message":""}],
            "duration_ms":1234,
            "secrets_missing":["TOKEN","API_KEY"]
        }));
        let answer = parse(&heartbeat).unwrap().answer.unwrap();
        assert!(!answer.valid);
        assert_eq!(answer.stored["diagnostics"][0]["severity"], "error");
        assert_eq!(answer.stored["diagnostics"][1]["severity"], "warning");
        assert_eq!(
            answer.stored["tests"][1],
            json!({"name":"b","passed":false,"not_run":true})
        );
        assert_eq!(
            answer.stored["secrets_missing"],
            json!(["API_KEY", "TOKEN"])
        );
        assert_eq!(answer.stored["duration_ms"], 1234);
        // Everything optional but the identity and the verdict.
        let minimal = parse(&result(json!({}))).unwrap().answer.unwrap();
        assert_eq!(
            minimal.stored,
            json!({"valid":true,"diagnostics":[],"tests":[],"secrets_missing":[]})
        );
    }

    #[test]
    fn a_malformed_result_is_refused_whole() {
        let diagnostic = json!({"severity":"error","code":"X","message":"m"});
        for extra in [
            json!({"id":"not-a-uuid"}),
            json!({"id":"3F0F7B3E-4F7B-4F27-8A43-0F8D7FD8D7F1"}),
            json!({"valid":"true"}),
            json!({"surprise":1}),
            json!({"diagnostics":vec![diagnostic.clone();21]}),
            json!({"diagnostics":[{"severity":"error","code":"X","message":"m","extra":1}]}),
            json!({"diagnostics":[{"severity":"error","code":"X","message":"m".repeat(301)}]}),
            json!({"tests":vec![json!({"name":"t","passed":true}); 101]}),
            json!({"tests":[{"name":"","passed":true}]}),
            json!({"tests":[{"name":"x".repeat(201),"passed":true}]}),
            json!({"tests":[{"name":"t","passed":true,"message":"m".repeat(513)}]}),
            json!({"tests":[{"name":"t"}]}),
            json!({"tests":[{"name":"t","passed":true,"extra":1}]}),
            json!({"tests":[{"name":"line\nbreak","passed":true}]}),
            json!({"duration_ms":-1}),
            json!({"duration_ms":86_400_001u64}),
            json!({"duration_ms":1.5}),
            json!({"secrets_missing":vec!["A"; 2]}),
            json!({"secrets_missing":["bad name"]}),
            json!({"secrets_missing":(0..65).map(|n| format!("S{n}")).collect::<Vec<_>>()}),
        ] {
            assert!(parse(&result(extra.clone())).is_err(), "{extra}");
        }
        assert!(parse(&json!({"validation_result":"nope"})).is_err());
        assert!(parse(&json!({"validation_result":{"valid":true}})).is_err());
    }

    #[test]
    fn the_largest_plain_answer_is_kept_and_one_inflated_by_escapes_is_refused() {
        let diagnostic =
            json!({"severity":"error","code":"X","message":"m".repeat(260),"hint":"h".repeat(190)});
        let test =
            |text: &str| json!({"name":text.repeat(200),"passed":false,"message":text.repeat(512)});
        let largest = result(json!({
            "valid":false,
            "diagnostics":vec![diagnostic; 20],
            "tests":vec![test("t"); 100],
            "duration_ms":86_400_000u64,
            "secrets_missing":(0..64).map(|n| format!("SECRET_{n:02}")).collect::<Vec<_>>()
        }));
        let kept = parse(&largest).unwrap().answer.unwrap();
        let size = kept.stored.to_string().len();
        assert!(size > 80_000 && size <= MAX_RESULT_BYTES, "{size}");
        // The same tests with every character a quote, which JSON writes as two.
        let inflated = result(json!({"valid":false,"tests":vec![test("\""); 100]}));
        assert!(parse(&inflated).is_err());
    }

    fn entry(device: &str, name: &str, state: &str, result: Option<Value>) -> Entry {
        Entry {
            device_id: device.into(),
            name: name.into(),
            state: state.into(),
            updated_at: "2026-10-02T10:00:30Z".into(),
            result: result.map(|result| result.to_string()),
        }
    }

    fn check() -> Check {
        Check {
            created_at: "2026-10-02T10:00:00Z".into(),
            expires_at: "2026-10-02T10:10:00Z".into(),
            truncated: false,
            run_tests: true,
        }
    }

    #[test]
    fn a_check_runs_until_no_device_is_pending_and_a_late_pending_device_reads_expired() {
        let entries = || {
            vec![
                entry("b", "edge-10", "pending", None),
                entry(
                    "a",
                    "edge-2",
                    "passed",
                    Some(
                        json!({"valid":true,"diagnostics":[],"tests":[],"secrets_missing":[],"duration_ms":900}),
                    ),
                ),
                entry("c", "edge-3", "offline", None),
            ]
        };
        let running = describe("id", &check(), entries(), "2026-10-02T10:05:00Z").unwrap();
        assert_eq!(running["state"], "running");
        // Natural name order: edge-2, edge-3, edge-10.
        let names: Vec<_> = running["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|device| device["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["edge-2", "edge-3", "edge-10"]);
        let passed = &running["devices"][0];
        assert_eq!(
            (passed["valid"].clone(), passed["duration_ms"].clone()),
            (json!(true), json!(900))
        );
        // A device without an answer carries empty lists and no verdict.
        let offline = &running["devices"][1];
        assert!(offline.get("valid").is_none() && offline.get("duration_ms").is_none());
        assert_eq!(offline["diagnostics"], json!([]));
        assert_eq!(running["devices"][2]["state"], "pending");
        // At the expiry the pending device is expired as of that moment and
        // the check is complete; answered rows keep their own time.
        let done = describe("id", &check(), entries(), "2026-10-02T10:10:00Z").unwrap();
        assert_eq!(done["state"], "complete");
        assert_eq!(done["devices"][2]["state"], "expired");
        assert_eq!(done["devices"][2]["updated_at"], "2026-10-02T10:10:00Z");
        assert_eq!(done["devices"][0]["updated_at"], "2026-10-02T10:00:30Z");
        assert_eq!(
            (done["truncated"].clone(), done["run_tests"].clone()),
            (json!(false), json!(true))
        );
    }

    #[test]
    fn only_a_report_that_announced_the_feature_can_be_checked_on() {
        assert!(announced(&json!({"agent_features":["validation"]})));
        assert!(announced(&json!({"agent_features":["wake","validation"]})));
        assert!(!announced(&json!({"agent_features":["wake"]})));
        assert!(!announced(&json!({})));
    }
}
