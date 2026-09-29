//! Explicit, bounded candidate identity. Workload status alone never attributes a
//! failed download/validation to the currently desired deployment generation.
use crate::{
    error::{ApiError, Result},
    issues,
};
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
/// Target history contains a bounded category, never agent diagnostics. The
/// caller supplies the accepted (possibly latched) current attempt only.
pub fn target_error(state: &str, attempt: Option<&Value>) -> Option<String> {
    match state {
        "failed" | "rolled_back" => {
            let safe = safe_error(attempt.map(|a| &a["error"]).unwrap_or(&Value::Null));
            Some(format!(
                "{} ({})",
                safe["code"].as_str().unwrap(),
                safe["stage"].as_str().unwrap()
            ))
        }
        "verification_unknown" => Some(UNVERIFIED_MESSAGE.into()),
        _ => None,
    }
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
        .filter(|x| {
            [
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
            ]
            .contains(x)
        })
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
    json!({"code":code,"stage":stage,"message":issues::MESSAGE})
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
            .any(|k| !["code", "stage", "message"].contains(&k.as_str()))
        {
            return Err(ApiError::invalid(
                "Unknown configuration_attempt.error field",
            ));
        }
        bounded(error, "code", 1, 128)?;
        bounded(error, "stage", 1, 128)?;
        bounded(error, "message", 0, 1000)?;
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
