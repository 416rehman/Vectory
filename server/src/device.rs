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
        .layer(DefaultBodyLimit::max(1024 * 1024))
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
async fn authenticated(s: &State, peer: &PeerCertificate) -> Result<String> {
    let fp = peer.0.as_deref().ok_or_else(ApiError::unauthorized)?;
    let id:Option<String>=sqlx::query_scalar("SELECT c.device_id FROM credentials c JOIN devices d ON d.id=c.device_id WHERE c.fingerprint=? AND c.revoked=0 AND d.revoked=0 AND c.expires_at>?").bind(fp).bind(db::now()).fetch_optional(&s.pool).await?;
    id.ok_or_else(ApiError::unauthorized)
}
pub async fn enroll(AppState(s): AppState<State>, Json(v): Json<Value>) -> Result<Json<Value>> {
    s.limit("enrollment".into(), 60, std::time::Duration::from_secs(60))?;
    let result = enroll_inner(s.clone(), v).await;
    if result.is_err() {
        let _guard = s.writer.lock().await;
        let mut tx = s.pool.begin().await?;
        db::audit(
            &mut tx,
            "anonymous",
            "device.enroll",
            "unregistered",
            "failure",
        )
        .await?;
        tx.commit().await?;
    }
    result
}
async fn enroll_inner(s: State, v: Value) -> Result<Json<Value>> {
    let mode = configuration_mode(&v).map_err(|_| ApiError::enrollment())?;
    if v["protocol_version"] != 1 {
        return Err(ApiError::enrollment());
    }
    let token = v["token"]
        .as_str()
        .filter(|t| t.len() == 64)
        .ok_or_else(ApiError::enrollment)?;
    let request = db::string(&v, "request_id", 128).map_err(|_| ApiError::enrollment())?;
    let name = db::string(&v, "name", 100)
        .map_err(|_| ApiError::enrollment())?
        .trim()
        .to_ascii_lowercase();
    if name.is_empty()
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(ApiError::enrollment());
    }
    for field in ["os", "arch", "agent_version", "vector_version"] {
        db::string(&v, field, 64).map_err(|_| ApiError::enrollment())?;
    }
    let csr = db::string(&v, "csr_pem", 16384).map_err(|_| ApiError::enrollment())?;
    let key_hash = crate::crypto::Keys::csr_key_hash(csr)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query("SELECT id,data FROM enrollment_tokens WHERE verifier=?")
        .bind(db::hash(token))
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::enrollment)?;
    let token_id: String = row.get("id");
    let mut record = db::parse(row.get("data"))?;
    if record["revoked"] == true
        || text(&record, "expires_at") <= db::now().as_str()
        || record["name_prefix"]
            .as_str()
            .is_some_and(|prefix| !name.starts_with(prefix))
    {
        return Err(ApiError::enrollment());
    }
    if record["recovery_name"]
        .as_str()
        .is_some_and(|expected| name != expected)
    {
        return Err(ApiError::enrollment());
    }
    if let Some(old) =
        sqlx::query("SELECT key_hash,token_id,response FROM enrollments WHERE request_id=?")
            .bind(request)
            .fetch_optional(&mut *tx)
            .await?
    {
        if old.get::<String, _>("key_hash") != key_hash
            || old.get::<String, _>("token_id") != token_id
        {
            return Err(ApiError::enrollment());
        }
        let response = db::parse(old.get("response"))?;
        let active: i64 =
            sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=? AND name=? AND revoked=0")
                .bind(text(&response, "device_id"))
                .bind(&name)
                .fetch_one(&mut *tx)
                .await?;
        if active != 1 {
            return Err(ApiError::enrollment());
        }
        return Ok(Json(response));
    }
    if record["max_uses"]
        .as_u64()
        .is_some_and(|max| record["uses"].as_u64().unwrap_or(0) >= max)
    {
        return Err(ApiError::enrollment());
    }
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM devices WHERE name=?")
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(ref existing) = exists {
        if record["recovery_device_id"].as_str() != Some(existing.as_str()) {
            return Err(ApiError::enrollment());
        }
        let retired = format!("{name}#retired-{existing}");
        sqlx::query("UPDATE devices SET revoked=1,name=?,data=json_set(data,'$.name',?,'$.status','revoked') WHERE id=?").bind(&retired).bind(&retired).bind(existing).execute(&mut *tx).await?;
        sqlx::query("UPDATE credentials SET revoked=1 WHERE device_id=?")
            .bind(existing)
            .execute(&mut *tx)
            .await?;
        crate::groups::remove_device(&mut tx, existing).await?;
        crate::rollout::retire_persistent_targets(&mut tx, existing).await?;
    } else if record["recovery_device_id"].is_string() {
        return Err(ApiError::enrollment());
    }
    let id = db::id();
    let issued = s.keys.issue(&id, csr)?;
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
    db::audit(&mut tx, &id, "device.enroll", &id, "success").await?;
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
    let mut tx = s.pool.begin().await?;
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
fn telemetry(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    const FIELDS: &[&str] = &[
        "sampled_at",
        "events_per_second",
        "errors",
        "uptime_seconds",
        "memory_bytes",
        "cpu_seconds",
        "discarded_events",
        "buffer_bytes",
        "components",
    ];
    if !v.is_object()
        || v.as_object()
            .unwrap()
            .keys()
            .any(|k| !FIELDS.contains(&k.as_str()))
    {
        return Err(ApiError::invalid("Telemetry contains an unsupported field"));
    }
    let time = chrono::DateTime::parse_from_rfc3339(db::string(v, "sampled_at", 64)?)
        .map_err(|_| ApiError::invalid("Invalid telemetry timestamp"))?;
    if (Utc::now().signed_duration_since(time).num_seconds()).abs() > 86400 {
        return Err(ApiError::invalid(
            "Telemetry sample is outside the retention window",
        ));
    }
    let mut out = json!({"sampled_at":time.to_rfc3339_opts(chrono::SecondsFormat::Secs,true)});
    for key in [
        "events_per_second",
        "errors",
        "uptime_seconds",
        "memory_bytes",
        "cpu_seconds",
        "discarded_events",
        "buffer_bytes",
    ] {
        if !v[key].is_null() {
            let n = v[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1e15)
                .ok_or_else(|| {
                    ApiError::invalid("Telemetry values must be bounded nonnegative numbers")
                })?;
            out[key] = json!(n)
        }
    }
    if !v["components"].is_null() {
        let components = v["components"]
            .as_array()
            .filter(|c| c.len() <= 50)
            .ok_or_else(|| ApiError::invalid("Telemetry supports at most 50 component samples"))?;
        let mut result = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for component in components {
            if component.as_object().is_none_or(|o| {
                o.keys().any(|k| {
                    ![
                        "id",
                        "type",
                        "events_per_second",
                        "errors",
                        "discarded_events",
                        "buffer_bytes",
                    ]
                    .contains(&k.as_str())
                })
            }) {
                return Err(ApiError::invalid("Invalid component telemetry fields"));
            }
            let id = db::string(component, "id", 100)?;
            if !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                || !seen.insert(id)
            {
                return Err(ApiError::invalid(
                    "Component telemetry IDs must be unique bounded identifiers",
                ));
            }
            let mut sample = json!({"id":id});
            if !component["type"].is_null() {
                let kind = db::string(component, "type", 64)?;
                if !kind
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                {
                    return Err(ApiError::invalid("Invalid component type"));
                }
                sample["type"] = json!(kind);
            }
            for key in [
                "events_per_second",
                "errors",
                "discarded_events",
                "buffer_bytes",
            ] {
                if !component[key].is_null() {
                    let n = component[key]
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1e15)
                        .ok_or_else(|| {
                            ApiError::invalid(
                                "Component metrics must be bounded nonnegative numbers",
                            )
                        })?;
                    sample[key] = json!(n);
                }
            }
            result.push(sample);
        }
        out["components"] = json!(result);
    }
    Ok(out)
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
    let sample = telemetry(&v["telemetry"])?;
    let attempt = crate::configuration_attempt::parse(&v)?;
    let mut tx = s.pool.begin().await?;
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
    let verified = exact && state == "verified_applied" && verified_claim;
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
    } else if !desired.is_null() && (attempt.is_some() || reported != generation) {
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
    sqlx::query("UPDATE devices SET data=? WHERE id=?")
        .bind(device.to_string())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if policy["telemetry_enabled"] == true && !sample.is_null() {
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?) ON CONFLICT(device_id,bucket) DO UPDATE SET data=excluded.data").bind(&id).bind(Utc::now().timestamp()/60).bind(sample.to_string()).execute(&mut *tx).await?;
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
    if !issue_error.is_null() || device["apply_state"] == "failed" {
        let safe = crate::configuration_attempt::safe_error(issue_error);
        let code = text(&safe, "code");
        let stage = text(&safe, "stage");
        let issue_id = db::hash(format!("{id}:{code}:{stage}"));
        let (mut issue, new) = match db::record(&mut tx, "issue", &issue_id).await {
            Ok(v) => (v, false),
            Err(e) if e.status == axum::http::StatusCode::NOT_FOUND => (
                json!({"id":issue_id,"device_id":id,"code":code,"stage":stage,"message":crate::issues::MESSAGE,"count":0,"first_seen":db::now(),"resolved":false,"revision":1}),
                true,
            ),
            Err(e) => return Err(e),
        };
        if !new {
            crate::issues::advance_revision(&mut issue)?;
        }
        crate::issues::clear_acknowledgement(&mut issue);
        issue["count"] = json!(
            issue["count"]
                .as_u64()
                .unwrap_or(0)
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or_else(|| ApiError::conflict("Issue occurrence count is exhausted"))?
        );
        issue["last_seen"] = json!(db::now());
        issue["resolved"] = json!(false);
        issue["desired_version_id"] =
            if candidate_error.is_some() || attempt.is_none() && reported == generation {
                json!(desired_version)
            } else {
                Value::Null
            };
        if new {
            db::insert(&mut tx, "issue", &issue).await?
        } else {
            db::update(&mut tx, "issue", &issue).await?
        }
    } else if device["apply_state"] == "verified_applied" {
        let own_issues=sqlx::query("SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.device_id')=? AND COALESCE(json_type(data,'$.resolved')='true',0)=0").bind(&id).fetch_all(&mut *tx).await?;
        for row in own_issues {
            let mut issue = db::parse(row.get("data"))?;
            crate::issues::advance_revision(&mut issue)?;
            issue["resolved"] = json!(true);
            db::update(&mut tx, "issue", &issue).await?;
        }
    }
    let issued = Utc::now();
    let payload = json!({"protocol_version":1,"device_id":id,"nonce":nonce,"issued_at":issued.to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":(issued+Duration::minutes(5)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"generation":generation,"policy_generation":policy_generation,"policy":policy,"desired":desired});
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
    let _guard = s.writer.lock().await;
    let id = authenticated(&s, &peer).await?;
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
            .fetch_one(&s.pool)
            .await?;
    let version: Option<String> = row.get("desired_version_id");
    let generation: i64 = row.get("desired_generation");
    let mut conn = s.pool.acquire().await?;
    let version = db::record(
        &mut conn,
        "version",
        &version.ok_or_else(ApiError::forbidden)?,
    )
    .await?;
    let artifact =
        match crate::variables::current(&mut conn, &id, generation, text(&version, "id")).await? {
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
        let (socket, _) = listener.accept().await?;
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
            let service =
                hyper_util::service::TowerToHyperService::new(router.layer(Extension(peer)));
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
    #[test]
    fn telemetry_preserves_unavailability_and_bounds_component_cardinality() {
        let minimal = json!({"sampled_at":db::now()});
        let result = telemetry(&minimal).unwrap();
        assert!(result.get("errors").is_none());
        assert!(result.get("memory_bytes").is_none());
        assert!(result.get("components").is_none());
        let measured = json!({"sampled_at":db::now(),"uptime_seconds":12,"cpu_seconds":0,"components":[{"id":"web_ingest","type":"http_server","events_per_second":2.5,"errors":0}]});
        assert_eq!(
            telemetry(&measured).unwrap()["components"][0]["errors"],
            0.0
        );
        let mut invalid = measured.clone();
        invalid["components"][0]["tenant"] = json!("unbounded-label");
        assert!(telemetry(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["memory_bytes"] = json!(-1);
        assert!(telemetry(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["components"] = json!(vec![measured["components"][0].clone(); 51]);
        assert!(telemetry(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["components"] = json!(vec![measured["components"][0].clone(); 2]);
        assert!(telemetry(&invalid).is_err());
    }
}
