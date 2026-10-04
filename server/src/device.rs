use crate::{
    State, db,
    error::{ApiError, Result},
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, Path, State as AppState},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Clone, Debug)]
pub struct PeerCertificate(pub Option<String>);
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn configuration_mode(v: &Value) -> Result<&str> {
    match v.get("configuration_mode") {
        None => Ok("restricted"),
        Some(Value::String(mode)) if mode == "restricted" || mode == "full" => Ok(mode),
        _ => Err(ApiError::invalid(
            "configuration_mode must be restricted or full",
        )),
    }
}
pub fn router(s: State) -> Router {
    Router::new()
        .route("/agent/v1/enroll", post(enroll))
        .route("/agent/v1/heartbeat", post(heartbeat))
        .route("/agent/v1/wait", get(crate::wake::wait))
        .route("/agent/v1/artifacts/{sha256}", get(artifact))
        .route(
            "/agent/v1/agent-releases/{sha256}",
            get(crate::agent_releases::download),
        )
        .route(
            "/agent/v1/release-keys",
            get(crate::agent_release_keys::bundle),
        )
        .route("/agent/v1/renew", post(renew))
        .route("/agent/v1/identity", get(crate::install::identity))
        .route("/agent/v1/install.sh", get(crate::install::install_sh))
        .route(
            "/agent/v1/downloads/{os}/{arch}",
            get(crate::install::download_platform),
        )
        .layer(DefaultBodyLimit::max(crate::api::MAX_REQUEST_BODY))
        .layer(axum::middleware::from_fn(crate::api::reject_oversized))
        .layer(axum::middleware::from_fn_with_state(
            s.clone(),
            bounded_request,
        ))
        .layer(axum::middleware::from_fn(crate::api::security_headers))
        // An identity recovery revokes the old device: its parked wait answers.
        .layer(axum::middleware::from_fn_with_state(
            s.clone(),
            crate::wake::middleware,
        ))
        .with_state(s)
}
async fn bounded_request(
    AppState(s): AppState<State>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Ok(_permit) = s.agent_request_slots.try_acquire() else {
        return ApiError::new(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "CAPACITY_BUSY",
            "Agent request capacity busy; retry with jitter",
        )
        .into_response();
    };
    match tokio::time::timeout(std::time::Duration::from_secs(15), next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError::new(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            "REQUEST_TIMEOUT",
            "Agent request deadline exceeded",
        )
        .into_response(),
    }
}
pub(crate) async fn authenticated(s: &State, peer: &PeerCertificate) -> Result<String> {
    authenticated_with(&s.pool, peer).await
}
/// The device a client certificate currently belongs to, read with `db` (the
/// pool, or a transaction that must see the same snapshot as later reads).
async fn authenticated_with<'e>(
    db: impl sqlx::SqliteExecutor<'e>,
    peer: &PeerCertificate,
) -> Result<String> {
    let fp = peer.0.as_deref().ok_or_else(ApiError::unauthorized)?;
    let id:Option<String>=sqlx::query_scalar("SELECT c.device_id FROM credentials c JOIN devices d ON d.id=c.device_id WHERE c.fingerprint=? AND c.revoked=0 AND d.revoked=0 AND c.expires_at>?").bind(fp).bind(db::now()).fetch_optional(db).await?;
    id.ok_or_else(ApiError::unauthorized)
}
/// Why an enrollment was refused. Devices only ever receive the generic
/// ENROLLMENT_FAILED response; the reason is recorded in the audit log so an
/// administrator can see it (Add device and Activity).
enum Refusal {
    Refused {
        reason: &'static str,
        token_id: Option<String>,
    },
    Error(ApiError),
}
impl From<ApiError> for Refusal {
    fn from(e: ApiError) -> Self {
        Refusal::Error(e)
    }
}
impl From<sqlx::Error> for Refusal {
    fn from(e: sqlx::Error) -> Self {
        Refusal::Error(e.into())
    }
}
fn refused(reason: &'static str, token_id: Option<&str>) -> Refusal {
    Refusal::Refused {
        reason,
        token_id: token_id.map(str::to_owned),
    }
}
/// Bounded, secret-free facts about an attempt for the audit record. The
/// values come from an unauthenticated request, so only short printable text
/// is kept; the token itself is never recorded.
fn attempt_details(v: &Value, peer: Option<std::net::IpAddr>) -> Value {
    let field = |key: &str, max: usize| {
        v[key]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.len() <= max && t.bytes().all(|b| b.is_ascii_graphic()))
            .map_or(Value::Null, |t| json!(t))
    };
    let name = field("name", 100);
    json!({
        "name":name.as_str().map(str::to_ascii_lowercase),
        "agent_os":field("os",64),
        "agent_arch":field("arch",64),
        "agent_version":field("agent_version",64),
        "configuration_mode":field("configuration_mode",16),
        "client_address":peer.map(|ip|ip.to_string()),
    })
}
pub async fn enroll(
    AppState(s): AppState<State>,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    // One client (an IPv6 /64 counts as one) has its own budget, charged
    // first; the budget every client shares is charged only for what that lets
    // through, so a noisy host cannot block `vectory setup` fleet-wide.
    let client = peer.map_or_else(
        || "unknown".into(),
        |ip| crate::throttle_group(&ip.to_string()),
    );
    let minute = std::time::Duration::from_secs(60);
    s.limit(format!("enrollment:{client}"), 60, minute)?;
    s.limit("enrollment".into(), 600, minute)?;
    let mut details = attempt_details(&v, peer);
    let (reason, token_id, error) = match enroll_inner(&s, &v, &details).await {
        Ok(response) => return Ok(response),
        Err(Refusal::Refused { reason, token_id }) => (reason, token_id, ApiError::enrollment()),
        Err(Refusal::Error(error)) => ("INTERNAL", None, error),
    };
    // The audit log is append-only, so a refusal that repeats must not grow it
    // without bound: record the first of each kind each minute. Junk and typos
    // carry no real token, so they count per client and reason; a refusal for
    // a real token (revoked, used up, expired, a name it doesn't allow) counts
    // per token and reason, whichever hosts keep trying. All kinds together
    // write at most `enrollment_audit::REFUSAL_ROWS_PER_MINUTE` rows a minute.
    let audit_budget = match token_id.as_deref() {
        Some(token) => Some(format!("enrollment-audit:token:{token}:{reason}")),
        None if matches!(reason, "TOKEN_UNKNOWN" | "MALFORMED") => {
            Some(format!("enrollment-audit:{client}:{reason}"))
        }
        None => None,
    };
    if let Some(key) = audit_budget
        && s.limit(key, 1, minute).is_err()
    {
        return Err(error);
    }
    details["reason_code"] = json!(reason);
    details["token_id"] = json!(token_id);
    crate::enrollment_audit::record(&s, details).await?;
    Err(error)
}
/// Returns the stored response when `request` already enrolled this key with
/// this token, so a device that lost the response can finish.
async fn replay(
    tx: &mut sqlx::SqliteConnection,
    request: &str,
    key_hash: &str,
    token_id: &str,
    name: &str,
) -> std::result::Result<Option<Value>, Refusal> {
    let Some(old) =
        sqlx::query("SELECT key_hash,token_id,response FROM enrollments WHERE request_id=?")
            .bind(request)
            .fetch_optional(&mut *tx)
            .await?
    else {
        return Ok(None);
    };
    if old.get::<String, _>("key_hash") != key_hash || old.get::<String, _>("token_id") != token_id
    {
        return Err(refused("REQUEST_MISMATCH", Some(token_id)));
    }
    let response = db::parse(old.get("response"))?;
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=? AND name=? AND revoked=0")
            .bind(text(&response, "device_id"))
            .bind(name)
            .fetch_one(&mut *tx)
            .await?;
    if active != 1 {
        return Err(refused("DEVICE_REVOKED", Some(token_id)));
    }
    Ok(Some(response))
}
async fn enroll_inner(
    s: &State,
    v: &Value,
    details: &Value,
) -> std::result::Result<Json<Value>, Refusal> {
    let malformed = || refused("MALFORMED", None);
    let mode = configuration_mode(v).map_err(|_| malformed())?;
    if v["protocol_version"] != 1 {
        return Err(malformed());
    }
    let token = v["token"].as_str().ok_or_else(malformed)?;
    if token.len() != 64 {
        // A truncated or mistyped paste can't match any token.
        return Err(refused("TOKEN_UNKNOWN", None));
    }
    let request = db::name_string(v, "request_id", 128).map_err(|_| malformed())?;
    let name =
        crate::enrollment_scope::device_name(db::string(v, "name", 100).map_err(|_| malformed())?)
            .ok_or_else(malformed)?;
    for field in ["os", "arch", "agent_version", "vector_version"] {
        db::name_string(v, field, 64).map_err(|_| malformed())?;
    }
    let csr = db::string(v, "csr_pem", 16384).map_err(|_| malformed())?;
    let key_hash = crate::crypto::Keys::csr_key_hash(csr).map_err(|_| malformed())?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let row = sqlx::query("SELECT id,data FROM enrollment_tokens WHERE verifier=?")
        .bind(db::hash(token))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| refused("TOKEN_UNKNOWN", None))?;
    let token_id: String = row.get("id");
    let mut record = db::parse(row.get("data"))?;
    let token_ref = Some(token_id.as_str());
    let recovery = record["recovery_device_id"].is_string();
    // A retry after a lost response must succeed even when the token expired,
    // was revoked or used up in the meantime: the enrollment already happened.
    // Recovery tokens keep their stricter order, so cancelling an authorized
    // recovery also ends its replay.
    if !recovery
        && let Some(response) = replay(&mut tx, request, &key_hash, &token_id, &name).await?
    {
        return Ok(Json(response));
    }
    if record["revoked"] == true {
        return Err(refused("TOKEN_REVOKED", token_ref));
    }
    if text(&record, "expires_at") <= db::now().as_str() {
        return Err(refused("TOKEN_EXPIRED", token_ref));
    }
    if record["name_prefix"]
        .as_str()
        .is_some_and(|prefix| !name.starts_with(prefix))
    {
        return Err(refused("NAME_PREFIX_MISMATCH", token_ref));
    }
    if record["device_name"]
        .as_str()
        .is_some_and(|expected| name != expected)
    {
        return Err(refused("DEVICE_NAME_MISMATCH", token_ref));
    }
    if let Some(reason) = crate::enrollment_scope::refusal(&record, &name) {
        return Err(refused(reason, token_ref));
    }
    if record["recovery_name"]
        .as_str()
        .is_some_and(|expected| name != expected)
    {
        return Err(refused("RECOVERY_NAME_MISMATCH", token_ref));
    }
    if recovery
        && let Some(response) = replay(&mut tx, request, &key_hash, &token_id, &name).await?
    {
        return Ok(Json(response));
    }
    if record["max_uses"]
        .as_u64()
        .is_some_and(|max| record["uses"].as_u64().unwrap_or(0) >= max)
    {
        return Err(refused("TOKEN_EXHAUSTED", token_ref));
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM devices WHERE name=?")
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(ref existing) = exists {
        if record["recovery_device_id"].as_str() != Some(existing.as_str()) {
            return Err(refused("NAME_TAKEN", token_ref));
        }
        let retired = format!("{name}#retired-{existing}");
        sqlx::query("UPDATE devices SET revoked=1,name=?,data=json_set(data,'$.name',?,'$.status','revoked') WHERE id=?").bind(&retired).bind(&retired).bind(existing).execute(&mut *tx).await?;
        sqlx::query("UPDATE credentials SET revoked=1 WHERE device_id=?")
            .bind(existing)
            .execute(&mut *tx)
            .await?;
        crate::device_revocation::retire(&mut tx, existing).await?;
    } else if recovery {
        return Err(refused("RECOVERY_TARGET_MISSING", token_ref));
    }
    let id = db::id();
    let issued = s.keys.issue(&id, csr).map_err(|_| malformed())?;
    let mut device = json!({"id":id,"name":name,"os":v["os"],"arch":v["arch"],"agent_version":v["agent_version"],"vector_version":v["vector_version"],"configuration_mode":mode,"last_seen":Value::Null,"status":"unmanaged","labels":{},"desired_generation":0,"reported_generation":0,"actual_sha256":Value::Null,"apply_state":"unmanaged","sync_paused":false,"pause_acknowledged":false,"telemetry":Value::Null,"created_at":db::now()});
    // Descriptive labels from the token's scope; they grant nothing.
    device["labels"] = crate::enrollment_scope::device_labels(&record);
    if let Some(kind) = service_manager(v) {
        // Setup says what will keep the agent running; "none" lets Add device
        // say so from the first check-in.
        device["service_manager"] = json!(kind);
    }
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&id)
        .bind(&name)
        .bind(device.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id,ca_id) VALUES(?,?,?,?,?)",
    )
    .bind(issued.fingerprint)
    .bind(&id)
    .bind(issued.expires)
    .bind(s.keys.active_signing_id())
    .bind(issued.ca_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO enrollments(request_id,key_hash,token_id,response) VALUES(?,?,?,?)")
        .bind(request)
        .bind(key_hash)
        .bind(token_id.clone())
        .bind(issued.response.to_string())
        .execute(&mut *tx)
        .await?;
    crate::enrollment_scope::record_use(&mut record, &name);
    record["uses"] = json!(record["uses"].as_u64().unwrap_or(0) + 1);
    sqlx::query("UPDATE enrollment_tokens SET data=? WHERE id=?")
        .bind(record.to_string())
        .bind(&token_id)
        .execute(&mut *tx)
        .await?;
    let mut details = details.clone();
    details["name"] = json!(name);
    details["configuration_mode"] = json!(mode);
    details["token_id"] = json!(token_id);
    db::insert(
        &mut tx,
        "audit",
        &json!({"id":db::id(),"actor":id,"action":"device.enroll","target":id,"outcome":"success","created_at":db::now(),"details":details}),
    )
    .await?;
    if let Some(old) = exists {
        db::audit(
            &mut tx,
            &token_id,
            "device.recovery_complete",
            &format!("{old}:{id}"),
            "success",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(Json(issued.response))
}
pub async fn renew(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    // Enrollment shares this TLS listener, so a request without a device
    // certificate must never wait for the shared SQLite writer here either.
    let id = authenticated(&s, &peer).await?;
    s.limit(
        format!("renew:{id}"),
        8,
        std::time::Duration::from_secs(86400),
    )?;
    let _guard = crate::db::writer(&s).await;
    if authenticated(&s, &peer).await? != id {
        return Err(ApiError::unauthorized());
    }
    let issued = s.keys.issue(&id, db::string(&v, "csr_pem", 16384)?)?;
    let mut tx = db::begin_write(&s.pool).await?;
    let overlap =
        (Utc::now() + Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query(
        "UPDATE credentials SET expires_at=MIN(expires_at,?) WHERE device_id=? AND revoked=0",
    )
    .bind(overlap)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id,ca_id) VALUES(?,?,?,?,?)",
    )
    .bind(issued.fingerprint)
    .bind(&id)
    .bind(issued.expires)
    .bind(s.keys.active_signing_id())
    .bind(issued.ca_id)
    .execute(&mut *tx)
    .await?;
    db::audit(&mut tx, &id, "device.renew", &id, "success").await?;
    tx.commit().await?;
    Ok(Json(issued.response))
}
/// Additive heartbeat fields this server accepts; agents send them only when
/// the signed manifest lists them, so older servers keep working.
pub const HEARTBEAT_FEATURES: &[&str] = &[
    "diagnostics",
    "host_runtime",
    "vector_log_summary",
    "telemetry_v2",
    "secret_names",
    "service_manager",
    "vector_running",
    "agent_sha256",
    "state_dir",
    // `agent_features`, `validation_result` and `readiness`; the manifest then
    // carries `validation` for a device that announced it can be checked on.
    crate::device_validations::FEATURE,
];

/// The manifest's `features`: the heartbeat fields above, plus `wake` while
/// this server holds waits (`GET /agent/v1/wait`) and `agent_update` while
/// agent updates are on.
fn features(s: &State, agent_update: bool) -> Vec<&'static str> {
    let mut features = HEARTBEAT_FEATURES.to_vec();
    if s.wake.enabled() {
        features.push(crate::wake::FEATURE);
    }
    // Listed only while agent updates are on (a stopped server still lists it).
    if agent_update {
        features.push(crate::agent_updates::FEATURE);
    }
    features
}

/// A reported agent state directory: an absolute local path (POSIX or a
/// Windows drive path), bounded and printable (no character
/// `db::refused_in_name`). It is not a secret; the dashboard writes host
/// commands for it.
fn state_dir_path(dir: &str) -> bool {
    let bytes = dir.as_bytes();
    let absolute = dir.starts_with('/')
        || bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
    absolute && dir.len() <= 4096 && !dir.chars().any(db::refused_in_name)
}

/// What keeps an agent running, as the agent reports it.
const SERVICE_MANAGERS: &[&str] = &["systemd", "launchd", "windows", "none"];

/// A reported service manager, or null when absent. The enrollment request
/// ignores a value it doesn't know (a newer agent must still enroll); a
/// heartbeat, which sends it only to servers listing the feature, rejects it.
fn service_manager(v: &Value) -> Option<&str> {
    v["service_manager"]
        .as_str()
        .filter(|kind| SERVICE_MANAGERS.contains(kind))
}

fn token(value: &Value, max: usize, extra: &[u8]) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    })
}
/// A reported directory: not empty, at most `max` characters and nothing
/// `db::refused_in_name`.
fn plain(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty() && s.chars().count() <= max && !s.chars().any(db::refused_in_name)
    })
}

/// The host's own runtime contribution: data directory, drain limit, metrics
/// endpoint and activation method. Every field is allowlisted and bounded.
fn host_runtime(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let invalid = || ApiError::invalid("Invalid host_runtime");
    let fields = v.as_object().ok_or_else(invalid)?;
    for (key, value) in fields {
        let ok = match key.as_str() {
            "data_dir" => plain(value, 4096),
            "data_dir_source" => matches!(
                value.as_str(),
                Some("pipeline" | "host" | "adopted" | "vector_default" | "agent_default")
            ),
            "graceful_shutdown_seconds" => value.as_u64().is_some_and(|n| (1..=3600).contains(&n)),
            "metrics_source" => matches!(value.as_str(), Some("explicit" | "discovered" | "none")),
            "metrics_address" => token(value, 64, b".:[]"),
            "activation" => matches!(value.as_str(), Some("reload" | "restart")),
            _ => false,
        };
        if !ok {
            return Err(invalid());
        }
    }
    Ok(v.clone())
}

/// What a summary group's message says when nothing printable is left of it.
const NO_PRINTABLE_TEXT: &str = "Vector logged a message with no printable text.";

/// Redacted groups of recent Vector warnings and errors (at most 20), as they
/// are stored and served. A message is Vector's own log text, which can echo
/// event data, so it is display text: a control character in it is replaced
/// (`db::display_text`) and never refuses the check-in. Every other member
/// names something the server acts on or shows as a token, and still must be
/// exactly right.
fn log_summary(v: &Value) -> Result<Value> {
    let invalid = || ApiError::invalid("Invalid vector_log_summary");
    let items = v.as_array().filter(|a| a.len() <= 20).ok_or_else(invalid)?;
    let time = |value: &Value| {
        value
            .as_str()
            .filter(|t| t.len() <= 64)
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .is_some()
    };
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        let fields = item.as_object().ok_or_else(invalid)?;
        let mut group = fields.clone();
        for (key, value) in fields {
            let ok = match key.as_str() {
                "fingerprint" => value.as_str().is_some_and(|f| {
                    f.len() == 16
                        && f.bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                }),
                "level" => matches!(value.as_str(), Some("error" | "warn")),
                "component_id" => value
                    .as_str()
                    .is_some_and(crate::validation::reported_component_id),
                "component_kind" => matches!(value.as_str(), Some("source" | "transform" | "sink")),
                "component_type" | "error_type" | "stage" => token(value, 64, b"_"),
                "reason" => token(value, 32, b"_"),
                "message" => match db::display_text(value, 300) {
                    Some(text) => {
                        let shown = if text.is_empty() {
                            NO_PRINTABLE_TEXT.to_owned()
                        } else {
                            text
                        };
                        group.insert(key.clone(), json!(shown));
                        true
                    }
                    None => false,
                },
                "count" => value
                    .as_u64()
                    .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n)),
                "first_seen" | "last_seen" => time(value),
                _ => false,
            };
            if !ok {
                return Err(invalid());
            }
        }
        for required in [
            "fingerprint",
            "level",
            "message",
            "count",
            "first_seen",
            "last_seen",
        ] {
            if !fields.contains_key(required) {
                return Err(invalid());
            }
        }
        kept.push(Value::Object(group));
    }
    Ok(Value::Array(kept))
}

/// How many rows of each kind a device may add to the audit log in one minute.
///
/// A device authors three kinds of audit row about itself, on any check-in that
/// carries a change: `device.apply_state`, `device.configuration_mode_reported`
/// and `device.secret_reconciliation`. The log is append-only and never pruned,
/// so what a device writes stays, and a device that flaps (or lies) must not
/// decide how fast it grows. Three rules bound it:
///
/// - A row is written only when the reported value differs from the one the
///   device record held before this check-in. Identical check-ins add nothing,
///   and a new generation under the same apply state adds nothing either: the
///   row records the state, not the generation.
/// - A device adds at most this many rows of each kind in a minute (a fixed
///   window, counted per device and kind), so one that flips between two values
///   on every check-in adds a few rows a minute, not one per check-in. A busy
///   device never spends another's rows.
/// - The first apply-state row of each state that starts or ends an attempt
///   (`desired`, `verified_applied` and `failed`) for a generation is written
///   whatever the limit says, and does not count toward it. Only the server
///   makes a generation (a release, a retry or the recovery after a restore),
///   never the device, so one released to three versions in a minute still shows
///   each one's start and result, while one that repeats a generation gets that
///   exemption once per state every ten minutes.
///
/// A change that the limit skips is not written later: the device record holds
/// the current value, the audit log holds what fitted. The counts live in memory
/// and start again with the server, like the other request limits.
pub const DEVICE_AUDIT_ROWS_PER_MINUTE: u32 = 4;
/// How long a state's first row for one generation stays the only exempt one.
const FIRST_ROW_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);

/// Whether `device` may add a row of `action` to the audit log now, counting it
/// when it may. Call it only when the value changed. `reached` is the
/// generation and apply state a `device.apply_state` row records; the first such
/// row of a state that starts or ends an attempt is always allowed and is not
/// counted.
pub(crate) fn audit_row_allowed(
    s: &State,
    device: &str,
    action: &str,
    reached: Option<(i64, &str)>,
) -> bool {
    if let Some((generation, state)) = reached
        && matches!(state, "desired" | "verified_applied" | "failed")
        && s.limit(
            format!("device-audit:{device}:{action}:{generation}:{state}"),
            1,
            FIRST_ROW_WINDOW,
        )
        .is_ok()
    {
        return true;
    }
    s.limit(
        format!("device-audit:{device}:{action}"),
        DEVICE_AUDIT_ROWS_PER_MINUTE,
        std::time::Duration::from_secs(60),
    )
    .is_ok()
}

pub async fn heartbeat(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    // The listener permits anonymous TLS for enrollment. Refuse unauthenticated
    // heartbeats before they can queue at the process-wide SQLite writer, and
    // charge a known device's request budget before it joins that queue too.
    let id = authenticated(&s, &peer).await?;
    s.limit(
        format!("heartbeat:{id}"),
        30,
        std::time::Duration::from_secs(60),
    )?;
    let _guard = crate::db::writer(&s).await;
    // Revocation or identity recovery can commit while we wait for the lock.
    // The initial read is only an early rejection, never the writer's permit.
    if authenticated(&s, &peer).await? != id {
        return Err(ApiError::unauthorized());
    }
    let mode = configuration_mode(&v)?;
    if v["protocol_version"] != 1 {
        return Err(ApiError::invalid("Unsupported protocol"));
    }
    let nonce = db::string(&v, "nonce", 64)?;
    if STANDARD.decode(nonce).map_or(true, |b| b.len() != 32) {
        return Err(ApiError::invalid("Nonce must be 32 random bytes in base64"));
    }
    for field in ["request_id", "boot_id", "agent_version", "vector_version"] {
        db::name_string(&v, field, 128)?;
    }
    let reported = v["reported_generation"]
        .as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| ApiError::invalid("Invalid reported_generation"))?;
    let reported_policy = v["policy_generation"]
        .as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| ApiError::invalid("Invalid policy_generation"))?;
    let state = text(&v, "apply_state");
    if ![
        "unmanaged",
        "desired",
        "downloaded",
        "validated",
        "written",
        "reload_requested",
        "verified_applied",
        "verification_unknown",
        "failed",
        "rolled_back",
        "paused",
    ]
    .contains(&state)
    {
        return Err(ApiError::invalid("Invalid apply state"));
    }
    let sha = v["actual_sha256"].as_str().unwrap_or("");
    let template_sha = v["applied_template_sha256"].as_str().unwrap_or("");
    if !template_sha.is_empty()
        && (template_sha.len() != 64
            || !template_sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    {
        return Err(ApiError::invalid("Invalid applied template SHA256"));
    }
    let secret_revision = if v["secret_revision"].is_null() {
        0
    } else {
        v["secret_revision"]
            .as_i64()
            .filter(|n| (0..=9_007_199_254_740_991).contains(n))
            .ok_or_else(|| ApiError::invalid("Invalid secret_revision"))?
    };
    if !sha.is_empty()
        && (sha.len() != 64
            || !sha
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    {
        return Err(ApiError::invalid("Invalid actual SHA256"));
    }
    if !v["local_paused"].is_boolean() || !v["remote_pause_acknowledged"].is_boolean() {
        return Err(ApiError::invalid("Pause flags must be booleans"));
    }
    let sample = crate::telemetry::validate(&v["telemetry"])?;
    let attempt = crate::configuration_attempt::parse(&v)?;
    if let Some(list) = v["error"].get("diagnostics") {
        crate::configuration_attempt::diagnostics(list)?;
    }
    let runtime = host_runtime(&v["host_runtime"])?;
    let logs = match v.get("vector_log_summary") {
        Some(list) => Some(log_summary(list)?),
        None => None,
    };
    // Names bound with configure-secrets: names only, never files or values.
    let secret_names = match v.get("secret_names") {
        Some(list) => Some(
            crate::validation::reported_secret_names(list)
                .ok_or_else(|| ApiError::invalid("Invalid secret_names"))?,
        ),
        None => None,
    };
    let manager = match v.get("service_manager") {
        None | Some(Value::Null) => None,
        Some(_) => {
            Some(service_manager(&v).ok_or_else(|| ApiError::invalid("Invalid service_manager"))?)
        }
    };
    let vector_running = match v.get("vector_running") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(running)) => Some(*running),
        Some(_) => return Err(ApiError::invalid("Invalid vector_running")),
    };
    // The running agent build, for "already runs this build".
    let agent_sha256 = match v.get("agent_sha256") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|sha| {
                    sha.len() == 64
                        && sha
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| ApiError::invalid("Invalid agent_sha256"))?,
        ),
    };
    let state_dir = match v.get("state_dir") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .filter(|dir| state_dir_path(dir))
                .ok_or_else(|| ApiError::invalid("Invalid state_dir"))?,
        ),
    };
    // What the agent announces it can do, its readiness and the answer to a
    // device check: strictly validated like every other member, before any
    // write, so a refusal leaves nothing behind.
    let checks = crate::device_validations::parse(&v)?;
    // What the host reports about agent updates: strict like the rest, before
    // anything is written, so a refusal leaves nothing behind. While updates are
    // off the member is not read at all: a malformed one refuses nothing and
    // nothing of it is kept. The writer guard is held, so nobody turns updates
    // on between this read and the check-in's own.
    let update_report = if crate::agent_updates::is_on(&s).await? {
        crate::agent_updates::parse(&v)?
    } else {
        None
    };
    let mut tx = db::begin_write(&s.pool).await?;
    let row = sqlx::query("SELECT * FROM devices WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let generation: i64 = row.get("desired_generation");
    let policy_generation: i64 = row.get("policy_generation");
    if reported > generation
        || reported_policy > policy_generation
        || attempt
            .as_ref()
            .is_some_and(|a| a["generation"].as_i64().unwrap() > generation)
    {
        return Err(ApiError::conflict(
            "Server state predates device generations; authorized restore recovery is required",
        ));
    }
    let policy = db::parse(row.get("policy"))?;
    let desired_version: Option<String> = row.get("desired_version_id");
    let mut uses_local_secrets = false;
    let desired = if let Some(ref version_id) = desired_version {
        let version = db::record(&mut tx, "version", version_id).await?;
        uses_local_secrets = version["uses_local_secrets"] == true;
        let artifact = match crate::variables::current(&mut tx, &id, generation, version_id).await?
        {
            Some(snapshot) => snapshot,
            None if version["variables"].as_array().is_none_or(Vec::is_empty) => {
                crate::variables::render(&version, &Value::Null, &id)?
            }
            None => {
                return Err(ApiError::conflict(
                    "Target artifact is missing; reconcile this deployment before retrying",
                ));
            }
        };
        let sha256 = artifact.sha256;
        let mut desired = json!({"version_id":version_id,"sha256":sha256,"size":artifact.size,"artifact_path":format!("/agent/v1/artifacts/{sha256}"),"vector_version":crate::validation::VECTOR_VERSION});
        // What `vectory status` names: the version's number in its pipeline
        // and the pipeline's name, covered by the signature like the rest and
        // left out when the server does not know them.
        let (number, name) = crate::device_validations::labels(&mut tx, &version).await?;
        if let Some(number) = number {
            desired["version_number"] = json!(number);
        }
        if let Some(name) = name {
            desired["configuration_name"] = json!(name);
        }
        desired
    } else {
        Value::Null
    };
    let mut device = db::parse(row.get("data"))?;
    if !desired.is_null()
        && device["desired_artifact_sha256"]
            .as_str()
            .is_some_and(|sha| sha != text(&desired, "sha256"))
    {
        return Err(ApiError::conflict(
            "Current artifact identity changed without a new desired generation",
        ));
    }
    crate::canary_gate::invalidate_unproven_device(&mut tx, &id).await?;
    let old_mode = device["configuration_mode"]
        .as_str()
        .unwrap_or("restricted");
    if old_mode != mode && audit_row_allowed(&s, &id, "device.configuration_mode_reported", None) {
        db::audit(
            &mut tx,
            &id,
            "device.configuration_mode_reported",
            &id,
            mode,
        )
        .await?;
    }
    device["configuration_mode"] = json!(mode);
    let old_state = device["apply_state"].clone();
    let old_secret_revision = device["secret_revision"].as_i64().unwrap_or(0);
    if secret_revision < old_secret_revision {
        return Err(ApiError::conflict(
            "Secret revision regressed; preserve local agent state or use explicitly authorized recovery",
        ));
    }
    let old_actual = device["actual_sha256"].clone();
    let verified_attempt = device["verified_configuration_attempt"].clone();
    let mut current_attempt = attempt
        .as_ref()
        .filter(|a| {
            crate::configuration_attempt::identity_matches(a, generation, &desired)
                && (!uses_local_secrets
                    || a["secret_revision"].as_i64().unwrap_or(0) == secret_revision)
        })
        .cloned();
    let verified_claim = current_attempt
        .as_ref()
        .is_none_or(|a| a["state"] == "verified_applied");
    let previous_attempt = &device["terminal_configuration_attempt"];
    if let Some(a) = current_attempt.as_mut() {
        let same = previous_attempt["generation"] == a["generation"]
            && previous_attempt["version_id"] == a["version_id"]
            && previous_attempt["sha256"] == a["sha256"]
            && previous_attempt["secret_revision"].as_i64().unwrap_or(0)
                == a["secret_revision"].as_i64().unwrap_or(0);
        if same
            && ["failed", "rolled_back", "verification_unknown"]
                .contains(&text(previous_attempt, "state"))
            && [
                "desired",
                "downloaded",
                "validated",
                "written",
                "reload_requested",
                "paused",
            ]
            .contains(&text(a, "state"))
        {
            *a = previous_attempt.clone();
        }
    }
    if current_attempt.is_none() {
        for previous in [previous_attempt, &device["configuration_attempt"]] {
            if crate::configuration_attempt::identity_matches(previous, generation, &desired)
                && (!uses_local_secrets
                    || previous["secret_revision"].as_i64().unwrap_or(0) == secret_revision)
            {
                current_attempt = Some(previous.clone());
                break;
            }
        }
    }
    let terminal_attempt = current_attempt.as_ref().is_some_and(|a| {
        crate::configuration_attempt::was_verified(&verified_attempt, a, uses_local_secrets)
    });
    for key in ["agent_version", "vector_version", "local_paused"] {
        device[key] = v[key].clone()
    }
    device["last_seen"] = json!(db::now());
    device["reported_generation"] = json!(reported);
    device["policy_generation"] = json!(reported_policy);
    device["actual_sha256"] = if sha.is_empty() {
        Value::Null
    } else {
        json!(sha)
    };
    let local_secret_evidence = uses_local_secrets
        && template_sha == text(&desired, "sha256")
        && secret_revision >= 1
        && !sha.is_empty()
        && (device["verified_effective_sha256"]
            .as_str()
            .is_none_or(|previous| previous == sha)
            || secret_revision > device["verified_secret_revision"].as_i64().unwrap_or(0));
    let exact = reported == generation
        && !desired.is_null()
        && if uses_local_secrets {
            local_secret_evidence
        } else {
            sha == text(&desired, "sha256")
        };
    device["applied_template_sha256"] = if template_sha.is_empty() {
        Value::Null
    } else {
        json!(template_sha)
    };
    device["secret_revision"] = json!(secret_revision);
    device["uses_local_secrets"] = json!(uses_local_secrets);
    // A paused agent keeps running its verified workload (a stopped process
    // is reported as verification_unknown instead), so pause alone never
    // degrades verified evidence or the deployment target.
    let verified = exact && (state == "verified_applied" || state == "paused") && verified_claim;
    if verified {
        device["verified_effective_sha256"] = json!(sha);
        device["verified_secret_revision"] = json!(secret_revision);
        device["verified_configuration_attempt"] = json!({"generation":generation,"version_id":desired["version_id"],"sha256":desired["sha256"],"secret_revision":secret_revision});
        device
            .as_object_mut()
            .unwrap()
            .remove("terminal_configuration_attempt");
    }
    // Keep the actual workload observation distinct from candidate progress.
    // A stale candidate can never reattach failure to a newer retry generation.
    device["reported_apply_state"] = json!(state);
    device
        .as_object_mut()
        .unwrap()
        .remove("configuration_attempt");
    let attempt_stage = current_attempt.as_ref().map(|a| text(a, "state"));
    let stage = if verified {
        "verified_applied"
    } else if terminal_attempt {
        "verification_unknown"
    } else if let Some(stage) = attempt_stage {
        if stage == "verified_applied" {
            "verification_unknown"
        } else {
            stage
        }
    } else if desired.is_null() {
        // Without an assignment the device keeps its local workload; a report
        // still in flight for a removed assignment is not a failure.
        "unmanaged"
    } else if attempt.is_some() || reported != generation {
        "desired"
    } else if state == "verified_applied" && !exact {
        "failed"
    } else {
        state
    };
    if let Some(a) = current_attempt.as_ref() {
        // Never expose stale terminal failure as the current candidate outcome.
        let mut a = a.clone();
        if verified {
            a["state"] = json!("verified_applied");
            a.as_object_mut().unwrap().remove("error");
        }
        if terminal_attempt && !verified {
            a["state"] = json!("verification_unknown");
            a.as_object_mut().unwrap().remove("error");
        }
        if !verified
            && !terminal_attempt
            && ["failed", "rolled_back", "verification_unknown"].contains(&text(&a, "state"))
        {
            device["terminal_configuration_attempt"] = a.clone();
        }
        device["configuration_attempt"] = a;
    }
    device["apply_state"] = json!(stage);
    device["pause_acknowledged"] = json!(
        reported_policy == policy_generation
            && v["remote_pause_acknowledged"] == true
            && policy["sync_paused"] == true
    );
    if policy["telemetry_enabled"] == true {
        device["telemetry"] = sample.clone();
    } else {
        device["telemetry"] = Value::Null;
    }
    let fields = device.as_object_mut().unwrap();
    if runtime.is_null() {
        fields.remove("host_runtime");
    } else {
        fields.insert("host_runtime".into(), runtime);
    }
    // What keeps the agent running changes rarely; a check-in without it
    // (before the agent learned the feature) keeps what enrollment said.
    // Whether Vector runs is current or unknown, never stale.
    if let Some(kind) = manager {
        fields.insert("service_manager".into(), json!(kind));
    }
    match vector_running {
        Some(running) => {
            fields.insert("vector_running".into(), json!(running));
        }
        None => {
            fields.remove("vector_running");
        }
    }
    // Which build runs and where its state lives: current, or unknown when
    // the agent doesn't say (an older build), never stale.
    for (key, value) in [("agent_sha256", agent_sha256), ("state_dir", state_dir)] {
        match value {
            Some(text) => {
                fields.insert(key.into(), json!(text));
            }
            None => {
                fields.remove(key);
            }
        }
    }
    crate::device_validations::remember(fields, &checks);
    match logs {
        Some(items) => {
            fields.insert(
                "vector_log_summary".into(),
                json!({"reported_at":db::now(),"items":items}),
            );
        }
        None => {
            fields.remove("vector_log_summary");
        }
    }
    match secret_names {
        Some(names) => {
            fields.insert("secret_names".into(), names);
        }
        None => {
            fields.remove("secret_names");
        }
    }
    sqlx::query("UPDATE devices SET data=? WHERE id=?")
        .bind(device.to_string())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if policy["telemetry_enabled"] == true && !sample.is_null() {
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?) ON CONFLICT(device_id,bucket) DO UPDATE SET data=excluded.data").bind(&id).bind(Utc::now().timestamp()/60).bind(crate::telemetry::history_sample(&sample).to_string()).execute(&mut *tx).await?;
    }
    let prior_verified_current =
        crate::configuration_attempt::identity_matches(&verified_attempt, generation, &desired);
    let target_stage = if verified {
        Some("verified_applied")
    } else if terminal_attempt || prior_verified_current && current_attempt.is_none() {
        Some("verification_unknown")
    } else if current_attempt.is_some() {
        Some(stage)
    } else if reported == generation && state == "verified_applied" && !exact {
        Some("verification_unknown")
    } else {
        None
    };
    if let Some(stage) = target_stage {
        if let Some(assignment) = row.get::<Option<String>, _>("assignment_id") {
            let error = crate::configuration_attempt::target_error(stage, current_attempt.as_ref());
            sqlx::query("UPDATE deployment_targets SET state=?,error=?,verified_at=CASE WHEN ?='verified_applied' THEN COALESCE(verified_at,?) ELSE NULL END WHERE deployment_id=? AND device_id=? AND generation=? AND state<>'removed'").bind(stage).bind(error).bind(stage).bind(db::now()).bind(assignment).bind(&id).bind(generation).execute(&mut *tx).await?;
        }
    } else if let Some(assignment) = row.get::<Option<String>, _>("assignment_id") {
        // Also cover upgraded targets whose success predates the private marker.
        // An unverified workload observation may halt success, but cannot invent
        // a candidate failure for clients without explicit attempt evidence.
        sqlx::query("UPDATE deployment_targets SET state='verification_unknown',error=?,verified_at=NULL WHERE deployment_id=? AND device_id=? AND generation=? AND state='verified_applied'")
            .bind(crate::configuration_attempt::UNVERIFIED_MESSAGE).bind(assignment).bind(&id).bind(generation).execute(&mut *tx).await?;
    }
    if reported_policy == policy_generation
        && (policy["sync_paused"] == false || v["remote_pause_acknowledged"] == true)
    {
        if let Some(assignment) = row.get::<Option<String>, _>("policy_assignment_id") {
            sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=COALESCE(verified_at,?) WHERE deployment_id=? AND device_id=? AND state<>'removed'").bind(db::now()).bind(assignment).bind(&id).execute(&mut *tx).await?;
        }
    }
    crate::canary_gate::invalidate_unproven_device(&mut tx, &id).await?;
    if old_state != device["apply_state"]
        && audit_row_allowed(
            &s,
            &id,
            "device.apply_state",
            Some((generation, text(&device, "apply_state"))),
        )
    {
        db::audit(
            &mut tx,
            &id,
            "device.apply_state",
            &id,
            text(&device, "apply_state"),
        )
        .await?;
    }
    if uses_local_secrets
        && (secret_revision != old_secret_revision || old_actual != device["actual_sha256"])
        && audit_row_allowed(&s, &id, "device.secret_reconciliation", None)
    {
        let event = json!({"id":db::id(),"actor":id,"action":"device.secret_reconciliation","target":id,"outcome":device["apply_state"],"created_at":db::now(),"secret_revision":secret_revision,"previous_secret_revision":old_secret_revision,"actual_sha256":device["actual_sha256"],"applied_template_sha256":device["applied_template_sha256"]});
        db::insert(&mut tx, "audit", &event).await?;
    }
    let candidate_error = current_attempt
        .as_ref()
        .filter(|a| {
            !verified
                && !terminal_attempt
                && ["failed", "rolled_back", "verification_unknown"].contains(&text(a, "state"))
        })
        .map(|a| &a["error"]);
    let issue_error = candidate_error.unwrap_or(&v["error"]);
    // Until this response reaches it, the agent still reports its previous
    // attempt: after a retry or a new deployment it describes an older
    // generation, and its error was recorded while that attempt was current.
    // Echoing it is neither a new failure of the desired version nor of the
    // version the device runs.
    let stale_echo = candidate_error.is_none()
        && attempt.as_ref().is_some_and(|a| {
            let workload = crate::configuration_attempt::safe_error(&v["error"]);
            !crate::configuration_attempt::identity_matches(a, generation, &desired)
                && ["failed", "rolled_back"].contains(&text(a, "state"))
                && (a["error"].is_null()
                    || (a["error"]["code"] == workload["code"]
                        && a["error"]["stage"] == workload["stage"]))
        });
    if desired.is_null() {
        crate::issues::resolve_device(&mut tx, &id, "unassigned").await?;
    } else if stale_echo {
        // Nothing to record: see above.
    } else if !issue_error.is_null() || device["apply_state"] == "failed" {
        let safe = crate::configuration_attempt::safe_error(issue_error);
        // A candidate failure belongs to its exact attempt. A workload error
        // belongs to the desired version once the device reports reaching it
        // (without a stale attempt), else to the version it is still verified
        // to run, else to no version.
        let reached = reported == generation
            && attempt.as_ref().is_none_or(|a| {
                crate::configuration_attempt::identity_matches(a, generation, &desired)
            });
        let (version, identity) = match (candidate_error, current_attempt.as_ref()) {
            (Some(_), Some(a)) => (
                desired_version.as_deref(),
                json!({"generation":a["generation"],"secret_revision":a["secret_revision"].as_i64().unwrap_or(0)}),
            ),
            _ if reached => (
                desired_version.as_deref(),
                json!({"generation":generation,"secret_revision":secret_revision}),
            ),
            _ => (
                crate::telemetry::running_version(&device),
                json!({"generation":reported,"secret_revision":secret_revision}),
            ),
        };
        crate::issues::record_failure(
            &mut tx,
            crate::issues::Failure {
                device_id: &id,
                error: &safe,
                version_id: version,
                attempt: identity,
                deployment_id: row.get("assignment_id"),
            },
        )
        .await?;
    } else if device["apply_state"] == "verified_applied" {
        crate::issues::resolve_device(&mut tx, &id, "verified").await?;
    }
    crate::data_plane::observe(
        &mut tx,
        crate::data_plane::Observation {
            device_id: &id,
            device: &device,
            desired_version: desired_version.as_deref(),
            assignment_id: row.get("assignment_id"),
            sample: if policy["telemetry_enabled"] == true {
                &sample
            } else {
                &Value::Null
            },
            monitoring: policy["telemetry_enabled"] == true,
        },
    )
    .await?;
    // The answer to a device check, if this heartbeat carries one, and the
    // check this device is asked to run now. Neither touches desired state,
    // a generation, the policy or an issue.
    let validation = crate::device_validations::heartbeat(&mut tx, &id, &checks).await?;
    // The host's report of agent updates, how far it moves the device's update
    // target, and the offer the signed manifest carries for it.
    let update = crate::agent_updates::heartbeat(
        &mut tx,
        &s,
        &db::now(),
        &crate::agent_updates::Build {
            device_id: &id,
            agent_version: text(&v, "agent_version"),
            agent_sha256,
            boot_id: text(&v, "boot_id"),
        },
        update_report.as_ref(),
    )
    .await?;
    let issued = Utc::now();
    let mut payload = json!({"protocol_version":1,"device_id":id,"nonce":nonce,"issued_at":issued.to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(issued+Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"generation":generation,"policy_generation":policy_generation,"policy":policy,"desired":desired,"features":features(&s, update.enabled)});
    if let Some(validation) = validation {
        payload["validation"] = validation;
    }
    if let Some(offer) = update.offer {
        payload["agent_update"] = offer;
    }
    let signing_id: Option<String> =
        sqlx::query_scalar("SELECT signing_key_id FROM credentials WHERE fingerprint=?")
            .bind(peer.0.as_deref().unwrap_or(""))
            .fetch_one(&mut *tx)
            .await?;
    let envelope = s.keys.envelope_for(
        signing_id.as_deref().unwrap_or(&s.keys.active_signing_id()),
        &payload,
    )?;
    tx.commit().await?;
    Ok(Json(envelope))
}
pub async fn artifact(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
    Path(sha): Path<String>,
) -> Result<Response> {
    // A read: every device of an all-at-once rollout fetches at once, so this
    // never takes the writer lock. One deferred read transaction gives the
    // credential, device row and artifact a single consistent snapshot, and
    // the digest check below refuses anything but the current artifact.
    let mut tx = s.pool.begin().await?;
    let id = authenticated_with(&mut *tx, &peer).await?;
    s.limit(
        format!("artifact:{id}"),
        30,
        std::time::Duration::from_secs(60),
    )?;
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::missing());
    }
    // The device's own desired artifact, exactly as it has always been
    // authorized. Only when that does not authorize this digest, the digest of
    // this device's own pending device check does: never another device's, and
    // never one that was answered, superseded or has expired. A refusal is the
    // desired artifact's refusal.
    let bytes = match desired_artifact(&mut tx, &id, &sha).await {
        Ok(bytes) => bytes.into_bytes(),
        Err(refusal) => match crate::device_validations::candidate(&mut tx, &id, &sha).await? {
            Some(bytes) => bytes,
            None => return Err(refusal),
        },
    };
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}
/// The artifact this device is currently offered, when `sha` is its digest.
async fn desired_artifact(tx: &mut sqlx::SqliteConnection, id: &str, sha: &str) -> Result<String> {
    let row =
        sqlx::query("SELECT desired_version_id,desired_generation,data FROM devices WHERE id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    let version: Option<String> = row.get("desired_version_id");
    let generation: i64 = row.get("desired_generation");
    let version = db::record(tx, "version", &version.ok_or_else(ApiError::forbidden)?).await?;
    let artifact = match crate::variables::current(tx, id, generation, text(&version, "id")).await?
    {
        Some(snapshot) => snapshot,
        None if version["variables"].as_array().is_none_or(Vec::is_empty) => {
            crate::variables::render(&version, &Value::Null, id)?
        }
        None => return Err(ApiError::forbidden()),
    };
    let device = db::parse(row.get("data"))?;
    if device["desired_artifact_sha256"]
        .as_str()
        .is_some_and(|stored| stored != artifact.sha256)
        || artifact.sha256 != sha
    {
        return Err(ApiError::forbidden());
    }
    Ok(artifact.bytes)
}
/// Where the agent listener takes its connections from: a TCP listener in
/// production. A test wraps one to make an accept fail.
pub trait Accept: Send + 'static {
    fn accept(
        &mut self,
    ) -> impl std::future::Future<
        Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>,
    > + Send;
}
impl Accept for tokio::net::TcpListener {
    async fn accept(&mut self) -> std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)> {
        tokio::net::TcpListener::accept(self).await
    }
}

/// What a failed `accept` means for the listener.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcceptFailure {
    /// One connection went away before it was accepted: take the next at once.
    Skip,
    /// The process or the host is short of descriptors, buffers or memory
    /// (`EMFILE`, `ENFILE`, `ENOBUFS`, `ENOMEM`), or met some other passing
    /// trouble. Closing connections frees what it needs, so wait a moment.
    Pause,
    /// The listening socket itself is unusable.
    Unusable,
}

/// How the listener treats an `accept` error. Only a socket that can never
/// accept again ends the listener; ending it ends the whole server, and every
/// parked wait with it.
pub fn accept_failure(error: &std::io::Error) -> AcceptFailure {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::ConnectionAborted
        | ErrorKind::ConnectionReset
        | ErrorKind::ConnectionRefused
        | ErrorKind::Interrupted
        | ErrorKind::WouldBlock
        | ErrorKind::TimedOut => AcceptFailure::Skip,
        ErrorKind::InvalidInput => AcceptFailure::Unusable,
        _ if not_a_socket(error.raw_os_error()) => AcceptFailure::Unusable,
        _ => AcceptFailure::Pause,
    }
}

/// `EBADF` and `ENOTSOCK` (`WSAEBADF` and `WSAENOTSOCK` on Windows): the
/// descriptor is not an open socket.
fn not_a_socket(code: Option<i32>) -> bool {
    #[cfg(target_os = "linux")]
    const CODES: &[i32] = &[9, 88];
    #[cfg(all(unix, not(target_os = "linux")))]
    const CODES: &[i32] = &[9, 38];
    #[cfg(windows)]
    const CODES: &[i32] = &[10009, 10038];
    #[cfg(not(any(unix, windows)))]
    const CODES: &[i32] = &[];
    code.is_some_and(|code| CODES.contains(&code))
}

const PAUSE_SHORTEST: std::time::Duration = std::time::Duration::from_millis(10);
const PAUSE_LONGEST: std::time::Duration = std::time::Duration::from_millis(100);
const REPORT_EVERY: std::time::Duration = std::time::Duration::from_secs(10);

/// A run of failed accepts: how long to pause after the next one, and how
/// often the log hears about it (a descriptor shortage can last as long as an
/// attack does). Each listener keeps its own and names itself in the log.
pub(crate) struct AcceptTrouble {
    listener: &'static str,
    in_a_row: u32,
    unreported: u64,
    reported: Option<std::time::Instant>,
}
impl AcceptTrouble {
    /// `listener` completes the log lines: "the agent listener could not accept
    /// a connection".
    pub(crate) fn new(listener: &'static str) -> Self {
        Self {
            listener,
            in_a_row: 0,
            unreported: 0,
            reported: None,
        }
    }
    /// Note one more failure and say how long to wait before accepting again:
    /// 10 ms, doubling to 100 ms while it lasts.
    pub(crate) fn failed(
        &mut self,
        error: &std::io::Error,
        now: std::time::Instant,
    ) -> std::time::Duration {
        self.in_a_row = self.in_a_row.saturating_add(1);
        self.unreported += 1;
        if self
            .reported
            .is_none_or(|at| now.duration_since(at) >= REPORT_EVERY)
        {
            tracing::warn!(
                %error,
                failures = self.unreported,
                "{} could not accept a connection; pausing briefly and trying again",
                self.listener
            );
            self.reported = Some(now);
            self.unreported = 0;
        }
        (PAUSE_SHORTEST * 2u32.saturating_pow(self.in_a_row - 1)).min(PAUSE_LONGEST)
    }
    pub(crate) fn accepted(&mut self) {
        if self.reported.is_some() {
            tracing::info!("{} accepts connections again", self.listener);
        }
        *self = Self::new(self.listener);
    }
}

/// A connection must deliver its whole ClientHello this soon after it opens.
/// A real client sends it with its first packet. Nothing is reserved for a
/// connection until then, so a flood of silent or slow sockets costs sockets
/// for a few seconds and never a handshake slot.
const CLIENT_HELLO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
/// How long a slot may wait for a free handshake, and a handshake may take
/// once its ClientHello is in.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Handshakes in progress at once, from the connection limit. They finish in
/// milliseconds, so the limit is reached only by a flood of valid hellos.
fn handshake_slots(maximum_connections: usize) -> usize {
    (maximum_connections / 8).clamp(128, 4096)
}

/// One connection's TLS handshake, in the order that keeps silent and slow
/// sockets away from the slots real devices need.
async fn begin_tls(
    socket: tokio::net::TcpStream,
    config: std::sync::Arc<rustls::ServerConfig>,
    handshakes: &std::sync::Arc<tokio::sync::Semaphore>,
) -> Option<tokio_rustls::server::TlsStream<tokio::net::TcpStream>> {
    let hello = tokio::time::timeout(
        CLIENT_HELLO_TIMEOUT,
        tokio_rustls::LazyConfigAcceptor::new(rustls::server::Acceptor::default(), socket),
    )
    .await
    .ok()?
    .ok()?;
    let slot = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshakes.clone().acquire_owned())
        .await
        .ok()?
        .ok()?;
    let tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, hello.into_stream(config))
        .await
        .ok()?
        .ok()?;
    drop(slot);
    Some(tls)
}

pub async fn serve_tls(
    s: State,
    addr: &str,
    cert: &std::path::Path,
    key: &std::path::Path,
) -> anyhow::Result<()> {
    let config = s.keys.tls_config(cert, key)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr,"device TLS listener ready");
    serve_tls_on(s, listener, config).await
}

pub const MAX_CONNECTIONS_VARIABLE: &str = "VECTORY_MAX_AGENT_CONNECTIONS";
const DEFAULT_MAX_CONNECTIONS: usize = 16384;
const MAX_CONNECTIONS_RANGE: std::ops::RangeInclusive<usize> = 64..=65536;
/// Most agent connections accepted at once, for the value the variable holds
/// (`None` when it is unset). Unset or empty is the default; anything that is
/// not a whole number in the range is an error that names the variable, the
/// value and the range, never a different limit.
pub fn max_agent_connections(value: Option<&str>) -> anyhow::Result<usize> {
    let Some(given) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(DEFAULT_MAX_CONNECTIONS);
    };
    given
        .parse::<usize>()
        .ok()
        .filter(|limit| MAX_CONNECTIONS_RANGE.contains(limit))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{MAX_CONNECTIONS_VARIABLE} must be a whole number from {} to {}, not {:?}",
                MAX_CONNECTIONS_RANGE.start(),
                MAX_CONNECTIONS_RANGE.end(),
                given.chars().take(40).collect::<String>()
            )
        })
}

/// The agent listener's loop over any source of connections. It returns only
/// when the source can never accept again; a failed accept is logged, waited
/// out and retried.
pub async fn serve_tls_on<A: Accept>(
    s: State,
    mut listener: A,
    config: rustls::ServerConfig,
) -> anyhow::Result<()> {
    let config = std::sync::Arc::new(config);
    let router = router(s);
    // The server has checked the variable before it started anything.
    let maximum_connections =
        max_agent_connections(std::env::var(MAX_CONNECTIONS_VARIABLE).ok().as_deref())?;
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(maximum_connections));
    let handshakes = std::sync::Arc::new(tokio::sync::Semaphore::new(handshake_slots(
        maximum_connections,
    )));
    let mut trouble = AcceptTrouble::new("the agent listener");
    loop {
        let (socket, address) = match listener.accept().await {
            Ok(accepted) => {
                trouble.accepted();
                accepted
            }
            Err(error) => match accept_failure(&error) {
                AcceptFailure::Skip => continue,
                AcceptFailure::Pause => {
                    let pause = trouble.failed(&error, std::time::Instant::now());
                    tokio::time::sleep(pause).await;
                    continue;
                }
                AcceptFailure::Unusable => {
                    return Err(anyhow::Error::new(error)
                        .context("the agent listener cannot accept connections"));
                }
            },
        };
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            continue;
        };
        let config = config.clone();
        let handshakes = handshakes.clone();
        let router = router.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _ = socket.set_nodelay(true);
            let Some(tls) = begin_tls(socket, config, &handshakes).await else {
                return;
            };
            let peer = PeerCertificate(
                tls.get_ref()
                    .1
                    .peer_certificates()
                    .and_then(|c| c.first())
                    .map(db::hash),
            );
            // The TCP peer, for enrollment audits and download throttling.
            // Nothing proxies this listener, so forwarded headers are ignored.
            let service = hyper_util::service::TowerToHyperService::new(
                router
                    .layer(Extension(peer))
                    .layer(Extension(axum::extract::ConnectInfo(address))),
            );
            let mut builder =
                hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
            builder
                .http1()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(std::time::Duration::from_secs(15));
            builder
                .http2()
                .max_concurrent_streams(16)
                .max_header_list_size(16384);
            let _ = builder
                .serve_connection(hyper_util::rt::TokioIo::new(tls), service)
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[test]
    fn an_aborted_connection_is_skipped_and_a_shortage_is_waited_out() {
        for kind in [
            ErrorKind::ConnectionAborted,
            ErrorKind::ConnectionReset,
            ErrorKind::Interrupted,
            ErrorKind::WouldBlock,
        ] {
            assert_eq!(accept_failure(&Error::from(kind)), AcceptFailure::Skip);
        }
        // Anything else that passes is waited out, never fatal.
        assert_eq!(
            accept_failure(&Error::other("something passing")),
            AcceptFailure::Pause
        );
        assert_eq!(
            accept_failure(&Error::from(ErrorKind::OutOfMemory)),
            AcceptFailure::Pause
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descriptor_and_memory_shortages_are_waited_out_and_a_dead_socket_ends_the_listener() {
        // EMFILE, ENFILE, ENOMEM and ENOBUFS (Linux numbers).
        for code in [24, 23, 12, 105] {
            assert_eq!(
                accept_failure(&Error::from_raw_os_error(code)),
                AcceptFailure::Pause,
                "{code}"
            );
        }
        // ECONNABORTED and EINTR.
        for code in [103, 4] {
            assert_eq!(
                accept_failure(&Error::from_raw_os_error(code)),
                AcceptFailure::Skip,
                "{code}"
            );
        }
        // EBADF, ENOTSOCK and EINVAL (not listening): nothing will ever be accepted.
        for code in [9, 88, 22] {
            assert_eq!(
                accept_failure(&Error::from_raw_os_error(code)),
                AcceptFailure::Unusable,
                "{code}"
            );
        }
    }

    #[test]
    fn pauses_start_short_grow_and_stop_at_a_tenth_of_a_second() {
        let mut trouble = AcceptTrouble::new("the agent listener");
        let error = Error::other("Too many open files");
        let now = std::time::Instant::now();
        let pauses: Vec<u64> = (0..8)
            .map(|_| trouble.failed(&error, now).as_millis() as u64)
            .collect();
        assert_eq!(pauses, [10, 20, 40, 80, 100, 100, 100, 100]);
        // Accepting again starts the next shortage over.
        trouble.accepted();
        assert_eq!(trouble.failed(&error, now).as_millis(), 10);
    }

    #[test]
    fn handshake_slots_follow_the_connection_limit() {
        assert_eq!(handshake_slots(16384), 2048);
        assert_eq!(handshake_slots(64), 128);
        assert_eq!(handshake_slots(1024), 128);
        assert_eq!(handshake_slots(8192), 1024);
        assert_eq!(handshake_slots(65536), 4096);
    }

    #[test]
    fn the_connection_limit_is_a_whole_number_in_its_range_or_the_default() {
        for (given, limit) in [
            (None, 16384),
            (Some(""), 16384),
            (Some("  "), 16384),
            (Some("64"), 64),
            (Some(" 1024 "), 1024),
            (Some("65536"), 65536),
        ] {
            assert_eq!(max_agent_connections(given).unwrap(), limit, "{given:?}");
        }
    }

    #[test]
    fn any_other_connection_limit_stops_the_server_naming_the_variable_value_and_range() {
        for given in ["x", "30d", "1e3", "-1", "0", "63", "65537", "70000", "10.5"] {
            let error = max_agent_connections(Some(given)).unwrap_err().to_string();
            assert_eq!(
                error,
                format!(
                    "VECTORY_MAX_AGENT_CONNECTIONS must be a whole number from 64 to 65536, not {given:?}"
                )
            );
        }
    }

    fn group(extra: Value) -> Value {
        let mut group = json!({
            "fingerprint": "0123456789abcdef",
            "level": "error",
            "message": "Mapping failed with event.",
            "count": 1,
            "first_seen": "2026-10-03T00:00:00Z",
            "last_seen": "2026-10-03T00:00:01Z"
        });
        for (key, value) in extra.as_object().unwrap() {
            group[key] = value.clone();
        }
        group
    }

    /// An id as the shared fixtures write it: a string, a list of ids joined
    /// together, or an id repeated.
    fn built(id: &Value) -> String {
        match id {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts.iter().map(built).collect(),
            Value::Object(_) => built(&id["repeat"]).repeat(id["times"].as_u64().unwrap() as usize),
            other => panic!("not an id: {other}"),
        }
    }

    #[test]
    fn a_log_group_names_its_component_by_the_one_rule_for_ids_a_device_reports() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../vector-catalog/fixtures/component-ids.json"
        ))
        .expect("the fixture is JSON");
        for case in fixture["cases"].as_array().expect("cases") {
            let id = built(&case["id"]);
            let valid = case["valid"].as_bool().expect("valid");
            let list = json!([group(json!({"component_id": id}))]);
            let kept = log_summary(&list);
            assert_eq!(kept.is_ok(), valid, "{}", case["name"]);
            if let Ok(kept) = kept {
                assert_eq!(kept[0]["component_id"], json!(id), "{}", case["name"]);
            }
        }
    }

    #[test]
    fn the_log_summary_bounds_are_the_shared_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../vector-catalog/fixtures/report-bounds.json"
        ))
        .expect("the fixture is JSON");
        let groups = fixture["bounds"]["log_groups"].as_u64().unwrap() as usize;
        let list = |count: usize| Value::Array((0..count).map(|_| group(json!({}))).collect());
        assert!(log_summary(&list(groups)).is_ok());
        assert!(log_summary(&list(groups + 1)).is_err());
        let chars = fixture["bounds"]["log_message_chars"].as_u64().unwrap() as usize;
        // Two-byte characters: the bound counts characters, not bytes.
        let long = |count: usize| json!([group(json!({"message": "\u{e9}".repeat(count)}))]);
        assert!(log_summary(&long(chars)).is_ok());
        assert!(log_summary(&long(chars + 1)).is_err());
    }

    #[test]
    fn the_other_members_of_a_log_group_keep_their_ascii_tokens() {
        for (key, value) in [
            ("component_type", "caf\u{e9}"),
            ("error_type", "caf\u{e9}"),
            ("stage", "a b"),
            ("reason", "t\u{e9}st"),
        ] {
            let list = json!([group(json!({key: value}))]);
            assert!(log_summary(&list).is_err(), "{key}");
        }
    }
}
