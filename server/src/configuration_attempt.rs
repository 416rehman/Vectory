//! Explicit, bounded candidate identity. Workload status alone never attributes a
//! failed download/validation to the currently desired deployment generation.
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
pub const STATES: &[&str] = &[
    "desired",
    "downloaded",
    "validated",
    "written",
    "reload_requested",
    "verified_applied",
    "failed",
    "rolled_back",
    "verification_unknown",
    "paused",
];
const MAX: i64 = 9_007_199_254_740_991;
pub const UNVERIFIED_MESSAGE: &str = "Current application could not be verified.";
/// Target history carries the server-rendered reason: a plain-language title,
/// the first redacted diagnostic and its fix. The caller supplies the accepted
/// (possibly latched) current attempt only.
pub fn target_error(state: &str, attempt: Option<&Value>) -> Option<String> {
    match state {
        "failed" | "rolled_back" => Some(explanation(&safe_error(
            attempt.map(|a| &a["error"]).unwrap_or(&Value::Null),
        ))),
        "verification_unknown" => Some(UNVERIFIED_MESSAGE.into()),
        _ => None,
    }
}

/// One line for places that hold a single string: "Title. Reason. Fix."
pub fn explanation(safe: &Value) -> String {
    let mut out = format!(
        "{}. {}",
        title(safe["code"].as_str().unwrap_or("")),
        safe["message"].as_str().unwrap_or("")
    );
    if let Some(hint) = first_error(&safe["diagnostics"]).and_then(|d| d["hint"].as_str()) {
        out.push(' ');
        out.push_str(hint);
        if !hint.ends_with(['.', '!', '?', '…']) {
            out.push('.');
        }
    }
    truncate(out.trim_end(), 500)
}

fn first_error(diagnostics: &Value) -> Option<&Value> {
    let items = diagnostics.as_array()?;
    items
        .iter()
        .find(|d| d["severity"] == "error")
        .or_else(|| items.first())
}

const MAX_DIAGNOSTICS: usize = 10;
const MAX_DIAGNOSTIC_BYTES: usize = 512;

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let mut out: String = value.chars().take(max - 1).collect();
    out.push('…');
    out
}
fn token(value: &Value, max: usize, extra: &[u8]) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= max
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
    })
}
fn text(value: &Value, min: usize, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        (min..=max).contains(&s.chars().count()) && !s.chars().any(|c| c.is_control())
    })
}

/// Validate redacted agent diagnostics: at most 10 records of at most 512
/// bytes, each field allowlisted and bounded. Unknown fields reject the
/// heartbeat rather than being silently dropped.
pub fn diagnostics(list: &Value) -> Result<Value> {
    diagnostics_up_to(list, MAX_DIAGNOSTICS)
}

/// The same records and bounds with another limit on how many there are: a
/// device check reports up to 20.
pub fn diagnostics_up_to(list: &Value, most: usize) -> Result<Value> {
    let invalid = || ApiError::invalid("Invalid diagnostics");
    let items = list
        .as_array()
        .filter(|a| a.len() <= most)
        .ok_or_else(invalid)?;
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let fields = item.as_object().ok_or_else(invalid)?;
        if serde_json::to_vec(item).map_or(true, |b| b.len() > MAX_DIAGNOSTIC_BYTES) {
            return Err(invalid());
        }
        for (key, value) in fields {
            let ok = match key.as_str() {
                "severity" => matches!(value.as_str(), Some("error" | "warning")),
                "code" => {
                    token(value, 48, b"_")
                        && value
                            .as_str()
                            .unwrap()
                            .bytes()
                            .all(|b| !b.is_ascii_lowercase())
                }
                "component_kind" => matches!(value.as_str(), Some("source" | "transform" | "sink")),
                "component_id" | "route_output" => token(value, 100, b"_.-"),
                "field" => text(value, 1, 128),
                "line" | "column" => value.as_u64().is_some_and(|n| (1..=1_000_000).contains(&n)),
                "reason" => {
                    token(value, 32, b"_")
                        && value
                            .as_str()
                            .unwrap()
                            .bytes()
                            .all(|b| !b.is_ascii_uppercase())
                }
                "message" => text(value, 1, 300),
                "hint" => text(value, 1, 200),
                _ => false,
            };
            if !ok {
                return Err(invalid());
            }
        }
        if !fields.contains_key("severity")
            || !fields.contains_key("code")
            || !fields.contains_key("message")
        {
            return Err(invalid());
        }
        out.push(item.clone());
    }
    Ok(Value::Array(out))
}

/// Failure codes an agent may report; anything else becomes APPLY_FAILED.
pub const CODES: &[&str] = &[
    "RECOVERY_INVALID",
    "CAPABILITY_DENIED",
    "WRITE_FAILED",
    "VALIDATION_FAILED",
    "ACTIVATION_FAILED",
    "DRIFT",
    "PROCESS_EXITED",
    "INCOMPATIBLE",
    "ADOPTION_REQUIRED",
    "DOWNLOAD_FAILED",
    "DIGEST_MISMATCH",
    "PATH_UNSAFE",
    "ROLLBACK_UNAVAILABLE",
    "ROLLBACK_FAILED",
    "APPLY_ROLLED_BACK",
    "PROCESS_STOPPED",
    "TELEMETRY_UNAVAILABLE",
    "APPLY_FAILED",
    "SECRET_RESOLUTION_FAILED",
    "SECRET_REVISION_EXHAUSTED",
    "MANIFEST_EXPIRED",
];

/// Plain-language title for an apply failure code.
pub fn title(code: &str) -> &'static str {
    match code {
        "VALIDATION_FAILED" => "Vector rejected the configuration",
        "APPLY_ROLLED_BACK" => "The new version didn't start",
        "ACTIVATION_FAILED" => "Vector didn't start",
        "CAPABILITY_DENIED" => "The device doesn't allow this configuration",
        "SECRET_RESOLUTION_FAILED" => "A local secret couldn't be read",
        "SECRET_REVISION_EXHAUSTED" => "Local secret revisions are used up",
        "DOWNLOAD_FAILED" | "DIGEST_MISMATCH" => "The device couldn't download the configuration",
        "INCOMPATIBLE" => "The device runs a different Vector version",
        "ADOPTION_REQUIRED" => "The device isn't ready to manage Vector",
        "WRITE_FAILED" | "PATH_UNSAFE" => "The device couldn't write the configuration",
        "ROLLBACK_FAILED" => "The update failed and couldn't be undone",
        // Issues name the device and version (issues::first_version_title).
        "ROLLBACK_UNAVAILABLE" => "The first version couldn't start",
        "RECOVERY_INVALID" => "Local recovery needs attention",
        "PROCESS_EXITED" => "Vector stopped running",
        "PROCESS_STOPPED" => "The agent stopped Vector",
        "MANIFEST_EXPIRED" => "The update expired before it applied",
        "DRIFT" => "The configuration was changed on the device",
        "TELEMETRY_UNAVAILABLE" => "Metrics are unavailable",
        _ => "The device couldn't apply the configuration",
    }
}

fn fallback_summary(code: &str) -> &'static str {
    match code {
        "VALIDATION_FAILED" => "Vector refused this version during validation on the device.",
        "APPLY_ROLLED_BACK" => "The device restored its last working configuration.",
        "ACTIVATION_FAILED" => "Vector didn't confirm startup with this configuration.",
        "CAPABILITY_DENIED" => {
            "This version uses components, paths or destinations that the device's local policy doesn't allow."
        }
        "SECRET_RESOLUTION_FAILED" => {
            "A vectory-secret reference has no readable local file on the device."
        }
        "SECRET_REVISION_EXHAUSTED" => {
            "The device needs local recovery before it can apply new secrets."
        }
        "DOWNLOAD_FAILED" | "DIGEST_MISMATCH" => {
            "The device couldn't download and verify the configuration."
        }
        "INCOMPATIBLE" => "This version targets a Vector release the device doesn't run.",
        "ADOPTION_REQUIRED" => "A host operator must adopt the device's Vector installation first.",
        "WRITE_FAILED" | "PATH_UNSAFE" => {
            "The agent couldn't safely write the managed configuration on the host."
        }
        "ROLLBACK_FAILED" => {
            "The device couldn't restore a working configuration. Inspect the host."
        }
        "ROLLBACK_UNAVAILABLE" => {
            "Vector isn't running: this was the device's first version, so there was nothing earlier to go back to."
        }
        "RECOVERY_INVALID" => "The agent's recovery journal needs a host operator.",
        "PROCESS_EXITED" => "The Vector process exited. The agent restarts it with backoff.",
        "PROCESS_STOPPED" => "The agent service stopped. Restart it to resume Vector.",
        "MANIFEST_EXPIRED" => {
            "The signed update expired before the device applied it. It retries on the next check-in."
        }
        "DRIFT" => "The managed file changed on the device outside Vectory.",
        _ => "The device reported a failure while applying this version.",
    }
}

/// The failure explained in one sentence: the first error diagnostic with its
/// location, or a plain fallback for the code when the agent sent none.
pub fn summary(code: &str, diagnostics: &Value) -> String {
    let Some(d) = first_error(diagnostics) else {
        return fallback_summary(code).to_owned();
    };
    let message = d["message"].as_str().unwrap_or("").trim_end_matches('.');
    let mut place = Vec::new();
    if let Some(id) = d["component_id"].as_str() {
        place.push(match d["route_output"].as_str() {
            Some(route) => format!("{id}.{route}"),
            None => id.to_owned(),
        });
    }
    match (d["line"].as_u64(), d["column"].as_u64()) {
        (Some(line), Some(column)) => place.push(format!("line {line}, column {column}")),
        (Some(line), None) => place.push(format!("line {line}")),
        _ => {}
    }
    let more = diagnostics
        .as_array()
        .map_or(0, |items| {
            items.iter().filter(|d| d["severity"] == "error").count()
        })
        .saturating_sub(1);
    let mut out = if !place.is_empty() {
        format!("{message} ({}).", place.join(", "))
    } else if message.ends_with(['!', '?', '…']) {
        message.to_owned()
    } else {
        format!("{message}.")
    };
    if more > 0 {
        out.push_str(&format!(
            " {more} more {}.",
            if more == 1 { "error" } else { "errors" }
        ));
    }
    truncate(&out, 500)
}
fn bounded<'a>(v: &'a Value, key: &str, min: usize, max: usize) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| (min..=max).contains(&s.chars().count()) && !s.contains('\0'))
        .ok_or_else(|| ApiError::invalid(format!("Invalid configuration_attempt.{key}")))
}
pub fn safe_error(v: &Value) -> Value {
    let code = v["code"]
        .as_str()
        .filter(|x| CODES.contains(x))
        .unwrap_or("APPLY_FAILED");
    let stage = v["stage"]
        .as_str()
        .filter(|x| {
            [
                "fetch",
                "download",
                "validation",
                "apply",
                "reload",
                "verification",
                "rollback",
                "telemetry",
                "credentials",
                "recovery",
                "capability",
                "startup",
                "observation",
                "compatibility",
                "preflight",
                "staging",
                "commit",
                "materialization",
            ]
            .contains(x)
        })
        .unwrap_or("apply");
    let diagnostics = v
        .get("diagnostics")
        .and_then(|d| diagnostics(d).ok())
        .unwrap_or(Value::Null);
    let mut out = json!({"code":code,"stage":stage,"message":summary(code,&diagnostics)});
    if diagnostics.as_array().is_some_and(|d| !d.is_empty()) {
        out["diagnostics"] = diagnostics;
    }
    out
}
pub fn parse(heartbeat: &Value) -> Result<Option<Value>> {
    let Some(v) = heartbeat.get("configuration_attempt") else {
        return Ok(None);
    };
    let o = v
        .as_object()
        .ok_or_else(|| ApiError::invalid("configuration_attempt must be an object"))?;
    if o.keys().any(|k| {
        ![
            "generation",
            "version_id",
            "sha256",
            "state",
            "error",
            "secret_revision",
        ]
        .contains(&k.as_str())
    }) {
        return Err(ApiError::invalid("Unknown configuration_attempt field"));
    }
    let generation = v["generation"]
        .as_i64()
        .filter(|n| (1..=MAX).contains(n))
        .ok_or_else(|| ApiError::invalid("Invalid configuration_attempt.generation"))?;
    let version = bounded(v, "version_id", 36, 36)?;
    let uuid = uuid::Uuid::parse_str(version)
        .map_err(|_| ApiError::invalid("Invalid configuration_attempt.version_id"))?;
    let normalized = uuid.hyphenated().to_string();
    if !normalized.eq_ignore_ascii_case(version) {
        return Err(ApiError::invalid(
            "Invalid configuration_attempt.version_id",
        ));
    }
    let sha = bounded(v, "sha256", 64, 64)?;
    if !sha
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::invalid("Invalid configuration_attempt.sha256"));
    }
    let state = bounded(v, "state", 1, 64)?;
    if !STATES.contains(&state) {
        return Err(ApiError::invalid("Invalid configuration_attempt.state"));
    }
    let mut out =
        json!({"generation":generation,"version_id":normalized,"sha256":sha,"state":state});
    if let Some(revision) = v.get("secret_revision") {
        let n = revision
            .as_i64()
            .filter(|n| (0..=MAX).contains(n))
            .ok_or_else(|| ApiError::invalid("Invalid configuration_attempt.secret_revision"))?;
        out["secret_revision"] = json!(n);
    }
    if let Some(error) = v.get("error") {
        let fields = error
            .as_object()
            .ok_or_else(|| ApiError::invalid("configuration_attempt.error must be an object"))?;
        if fields
            .keys()
            .any(|k| !["code", "stage", "message", "diagnostics"].contains(&k.as_str()))
        {
            return Err(ApiError::invalid(
                "Unknown configuration_attempt.error field",
            ));
        }
        bounded(error, "code", 1, 128)?;
        bounded(error, "stage", 1, 128)?;
        bounded(error, "message", 0, 1000)?;
        if let Some(list) = error.get("diagnostics") {
            diagnostics(list)?;
        }
        out["error"] = safe_error(error);
    }
    Ok(Some(out))
}
pub fn identity_matches(attempt: &Value, generation: i64, desired: &Value) -> bool {
    !desired.is_null()
        && attempt["generation"] == generation
        && attempt["version_id"] == desired["version_id"]
        && attempt["sha256"] == desired["sha256"]
}
pub fn was_verified(marker: &Value, attempt: &Value, uses_secrets: bool) -> bool {
    marker["generation"] == attempt["generation"]
        && marker["version_id"] == attempt["version_id"]
        && marker["sha256"] == attempt["sha256"]
        && (!uses_secrets
            || marker["secret_revision"].as_i64().unwrap_or(0)
                >= attempt["secret_revision"].as_i64().unwrap_or(0))
}
