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
        .route("/agent/v1/artifacts/{sha256}", get(artifact))
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
    // One client (an IPv6 /64 counts as one) gets the budget the whole server
    // used to share, so a noisy host cannot block `vectory setup` fleet-wide.
    let client = peer.map_or_else(
        || "unknown".into(),
        |ip| crate::throttle_group(&ip.to_string()),
    );
    let minute = std::time::Duration::from_secs(60);
    s.limit("enrollment".into(), 600, minute)?;
    s.limit(format!("enrollment:{client}"), 60, minute)?;
    let mut details = attempt_details(&v, peer);
    let (reason, token_id, error) = match enroll_inner(&s, &v, &details).await {
        Ok(response) => return Ok(response),
        Err(Refusal::Refused { reason, token_id }) => (reason, token_id, ApiError::enrollment()),
        Err(Refusal::Error(error)) => ("INTERNAL", None, error),
    };
    // Refusals that carry no real token are junk or a repeated typo: record
    // the first per client and reason each minute. The audit log is
    // append-only, so repeats must not grow it without bound.
    if matches!(reason, "TOKEN_UNKNOWN" | "MALFORMED")
        && s.limit(format!("enrollment-audit:{client}:{reason}"), 1, minute)
            .is_err()
    {
        return Err(error);
    }
    details["reason_code"] = json!(reason);
    details["token_id"] = json!(token_id);
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    db::insert(
        &mut tx,
        "audit",
        &json!({"id":db::id(),"actor":"anonymous","action":"device.enroll","target":"unregistered","outcome":"failure","created_at":db::now(),"details":details}),
    )
    .await?;
    tx.commit().await?;
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
    let request = db::string(v, "request_id", 128).map_err(|_| malformed())?;
    let name = db::string(v, "name", 100)
        .map_err(|_| malformed())?
        .trim()
        .to_ascii_lowercase();
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(malformed());
    }
    for field in ["os", "arch", "agent_version", "vector_version"] {
        db::string(v, field, 64).map_err(|_| malformed())?;
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
    let device = json!({"id":id,"name":name,"os":v["os"],"arch":v["arch"],"agent_version":v["agent_version"],"vector_version":v["vector_version"],"configuration_mode":mode,"last_seen":Value::Null,"status":"unmanaged","labels":{},"desired_generation":0,"reported_generation":0,"actual_sha256":Value::Null,"apply_state":"unmanaged","sync_paused":false,"pause_acknowledged":false,"telemetry":Value::Null,"created_at":db::now()});
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&id)
        .bind(&name)
        .bind(device.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(issued.fingerprint)
    .bind(&id)
    .bind(issued.expires)
    .bind(s.keys.active_signing_id())
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO enrollments(request_id,key_hash,token_id,response) VALUES(?,?,?,?)")
        .bind(request)
        .bind(key_hash)
        .bind(token_id.clone())
        .bind(issued.response.to_string())
        .execute(&mut *tx)
        .await?;
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
    let _guard = s.writer.lock().await;
    let id = authenticated(&s, &peer).await?;
    s.limit(
        format!("renew:{id}"),
        8,
        std::time::Duration::from_secs(86400),
    )?;
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
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(issued.fingerprint)
    .bind(&id)
    .bind(issued.expires)
    .bind(s.keys.active_signing_id())
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
];

fn token(value: &Value, max: usize, extra: &[u8]) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    })
}
fn plain(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
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

/// Redacted groups of recent Vector warnings and errors (at most 20).
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
    for item in items {
        let fields = item.as_object().ok_or_else(invalid)?;
        for (key, value) in fields {
            let ok = match key.as_str() {
                "fingerprint" => value.as_str().is_some_and(|f| {
                    f.len() == 16
                        && f.bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                }),
                "level" => matches!(value.as_str(), Some("error" | "warn")),
                "component_id" => token(value, 100, b"_.-"),
                "component_kind" => matches!(value.as_str(), Some("source" | "transform" | "sink")),
                "component_type" | "error_type" | "stage" => token(value, 64, b"_"),
                "reason" => token(value, 32, b"_"),
                "message" => plain(value, 300),
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
    }
    Ok(v.clone())
}

pub async fn heartbeat(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let _guard = s.writer.lock().await;
    let id = authenticated(&s, &peer).await?;
    s.limit(
        format!("heartbeat:{id}"),
        30,
        std::time::Duration::from_secs(60),
    )?;
    let mode = configuration_mode(&v)?;
    if v["protocol_version"] != 1 {
        return Err(ApiError::invalid("Unsupported protocol"));
    }
    let nonce = db::string(&v, "nonce", 64)?;
    if STANDARD.decode(nonce).map_or(true, |b| b.len() != 32) {
        return Err(ApiError::invalid("Nonce must be 32 random bytes in base64"));
    }
    for field in ["request_id", "boot_id", "agent_version", "vector_version"] {
        db::string(&v, field, 128)?;
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
        json!({"version_id":version_id,"sha256":sha256,"size":artifact.size,"artifact_path":format!("/agent/v1/artifacts/{sha256}"),"vector_version":crate::validation::VECTOR_VERSION})
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
    if old_mode != mode {
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
    let old_reported = device["reported_generation"].clone();
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
    if old_state != device["apply_state"] || old_reported != device["reported_generation"] {
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
    let issued = Utc::now();
    let payload = json!({"protocol_version":1,"device_id":id,"nonce":nonce,"issued_at":issued.to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(issued+Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"generation":generation,"policy_generation":policy_generation,"policy":policy,"desired":desired,"features":HEARTBEAT_FEATURES});
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
    let row =
        sqlx::query("SELECT desired_version_id,desired_generation,data FROM devices WHERE id=?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    let version: Option<String> = row.get("desired_version_id");
    let generation: i64 = row.get("desired_generation");
    let version = db::record(
        &mut tx,
        "version",
        &version.ok_or_else(ApiError::forbidden)?,
    )
    .await?;
    let artifact =
        match crate::variables::current(&mut tx, &id, generation, text(&version, "id")).await? {
            Some(snapshot) => snapshot,
            None if version["variables"].as_array().is_none_or(Vec::is_empty) => {
                crate::variables::render(&version, &Value::Null, &id)?
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
    let mut response = artifact.bytes.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(response)
}
pub async fn serve_tls(
    s: State,
    addr: &str,
    cert: &std::path::Path,
    key: &std::path::Path,
) -> anyhow::Result<()> {
    let config = s.keys.tls_config(cert, key)?;
    let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let router = router(s);
    let maximum_connections = std::env::var("VECTORY_MAX_AGENT_CONNECTIONS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(16384)
        .clamp(64, 65536);
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(maximum_connections));
    let handshakes = std::sync::Arc::new(tokio::sync::Semaphore::new(128));
    tracing::info!(%addr,"device TLS listener ready");
    loop {
        let (socket, address) = listener.accept().await?;
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            continue;
        };
        let acceptor = acceptor.clone();
        let handshakes = handshakes.clone();
        let router = router.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let handshake_permit = match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                handshakes.acquire_owned(),
            )
            .await
            {
                Ok(Ok(permit)) => permit,
                _ => return,
            };
            let _ = socket.set_nodelay(true);
            let tls = match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                acceptor.accept(socket),
            )
            .await
            {
                Ok(Ok(tls)) => tls,
                _ => return,
            };
            drop(handshake_permit);
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
