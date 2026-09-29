//! Reviewed rollback scope. The fingerprint is a compare-and-swap value, not
//! authorization or a bearer credential. Only an authenticated actor may use it.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeSet;
const MAX_TARGETS: usize = 10_000;
fn id(value: &str) -> Result<String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| ApiError::invalid("Rollback identities must be hyphenated UUIDs"))?;
    let normalized = parsed.hyphenated().to_string();
    if !normalized.eq_ignore_ascii_case(value) {
        return Err(ApiError::invalid(
            "Rollback identities must be hyphenated UUIDs",
        ));
    }
    Ok(normalized)
}
pub(crate) fn token(request: &Value) -> Result<Option<&str>> {
    request
        .get("review_token")
        .map(|v| {
            v.as_str()
                .filter(|v| {
                    v.len() == 64
                        && v.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| {
                    ApiError::invalid("review_token must be a lowercase SHA-256 fingerprint")
                })
        })
        .transpose()
}
fn blocker(code: &str, reason: &str) -> Value {
    json!({"code":code,"reason":reason})
}
pub async fn get(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(source): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let source = id(&source)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let result = preview(&mut tx, &source).await?;
    tx.rollback().await?;
    Ok(Json(result))
}
pub(crate) async fn preview(db: &mut SqliteConnection, source: &str) -> Result<Value> {
    let deployment = db::record(db, "deployment", source).await?;
    let version = id(deployment["version_id"].as_str().ok_or_else(|| {
        ApiError::invalid("Create a reviewed policy deployment to restore an earlier policy")
    })?)?;
    let source_priority = deployment["priority"]
        .as_i64()
        .filter(|p| (-1_000_000..=1_000_000).contains(p))
        .ok_or_else(|| ApiError::conflict("Stored deployment priority is invalid"))?;
    let priority = (source_priority + 1).min(1_000_000);
    let source_status = deployment["status"]
        .as_str()
        .filter(|v| v.len() <= 64)
        .ok_or_else(|| ApiError::conflict("Stored deployment status is invalid"))?;
    let source_action = if source_priority == 1_000_000 {
        "unassign"
    } else {
        "cancel"
    };
    let rows=sqlx::query("SELECT t.device_id,t.state,t.generation,t.previous_version_id,t.previous_artifact_sha256,t.previous_generation,a.version_id AS associated_version_id,a.sha256 AS associated_sha256,d.id AS current_id,substr(d.name,1,240) AS device_name,d.revoked,d.desired_version_id,d.desired_generation,d.assignment_id FROM deployment_targets t LEFT JOIN desired_artifacts a ON a.device_id=t.device_id AND a.generation=t.previous_generation LEFT JOIN devices d ON d.id=t.device_id WHERE t.deployment_id=? ORDER BY t.device_id LIMIT 10001").bind(source).fetch_all(&mut *db).await?;
    if rows.len() > MAX_TARGETS {
        return Err(ApiError::invalid(
            "Rollback review supports at most 10000 historical targets; create a new deployment for an explicitly reviewed subset",
        ));
    }
    let mut eligible = Vec::new();
    let mut excluded = Vec::new();
    let mut identities = Vec::new();
    let mut previous = BTreeSet::new();
    let mut unknown_previous = false;
    let mut live_excluded = false;
    let mut missing_prior_artifact = false;
    let mut invalid_prior_association = false;
    for row in rows {
        let device = id(&row.get::<String, _>("device_id"))?;
        let exists = row.get::<Option<String>, _>("current_id").is_some();
        let revoked = row.get::<Option<bool>, _>("revoked").unwrap_or(true);
        let state: String = row.get("state");
        let generation: i64 = row.get("generation");
        let prior: Option<String> = row.get("previous_version_id");
        let prior_sha: Option<String> = row.get("previous_artifact_sha256");
        let prior_generation: Option<i64> = row.get("previous_generation");
        let reason = if !exists {
            Some("missing")
        } else if revoked {
            Some("revoked")
        } else if state == "removed" {
            Some("removed")
        } else if generation <= 0 {
            Some("not_released")
        } else {
            None
        };
        let name: Option<String> = row.get("device_name");
        if let Some(reason) = reason {
            excluded.push(json!({"device_id":device,"device_name":name,"reason":reason}));
            live_excluded |= exists && !revoked && reason == "not_released";
        } else {
            eligible
                .push(json!({"device_id":device,"device_name":name,"artifact_sha256":prior_sha}));
            missing_prior_artifact |= prior_sha.is_none();
            if prior_sha.is_some() || prior_generation.is_some() {
                invalid_prior_association |= prior_sha.as_deref()
                    != row.get::<Option<String>, _>("associated_sha256").as_deref()
                    || prior.as_deref()
                        != row
                            .get::<Option<String>, _>("associated_version_id")
                            .as_deref()
                    || prior_generation.is_none();
            }
            match prior.as_deref().and_then(|v| id(v).ok()) {
                Some(v) => {
                    previous.insert(v);
                }
                None => unknown_previous = true,
            }
        }
        // Ordinary target progress and display names do not change reviewed
        // identity. Admission, prior content, eligibility and current delivery do.
        identities.push(json!({"device_id":device,"generation":generation,"previous_version_id":prior,"previous_generation":prior_generation,"previous_artifact_sha256":prior_sha,"removed":state=="removed","exists":exists,"revoked":revoked,"reason":reason,"desired_version_id":row.get::<Option<String>,_>("desired_version_id"),"desired_generation":row.get::<Option<i64>,_>("desired_generation"),"assignment_id":row.get::<Option<String>,_>("assignment_id")}));
    }
    let mut blockers = Vec::new();
    if !["active", "paused", "completed", "cancelled", "failed"].contains(&source_status) {
        blockers.push(blocker("SOURCE_NOT_ROLLBACKABLE","This assignment is not eligible for rollback. Create a new reviewed deployment instead."));
    }
    if eligible.is_empty() {
        blockers.push(blocker(
            "NO_ELIGIBLE_TARGETS",
            "No original released identities remain eligible for this rollback.",
        ));
    }
    if unknown_previous {
        blockers.push(blocker("PRIOR_VERSION_UNKNOWN","These devices ran their local config before this deployment, so there is no earlier version to roll back to. Remove this assignment to stop managing them; they keep the config they run now."));
    }
    if invalid_prior_association {
        blockers.push(blocker("PRIOR_ARTIFACT_MISMATCH","The recorded prior artifact no longer matches its target and generation. Preserve history and create a separately reviewed deployment."));
    }
    if previous.len() > 1 {
        blockers.push(blocker("MIXED_PRIOR_VERSIONS","Eligible identities have different prior versions. Review them in separate deployments; no subset has been selected automatically."));
    }
    if live_excluded && matches!(source_status, "active" | "paused" | "completed") {
        blockers.push(blocker("UNSAFE_SOURCE_REMOVAL","Stopping the original assignment would also remove its binding from unreleased live identities excluded from this rollback. Another assignment could then take effect on those identities. Create a separately reviewed deployment instead."));
    }
    let previous_version = if !unknown_previous && previous.len() == 1 {
        previous.first().cloned()
    } else {
        None
    };
    let mut previous_number = Value::Null;
    let mut configuration = Value::Null;
    let mut configuration_name = Value::Null;
    let mut previous_sha = Value::Null;
    if let Some(ref prior) = previous_version {
        if let Some(row)=sqlx::query("SELECT CASE WHEN json_type(v.data,'$.number')='integer' AND json_extract(v.data,'$.number') BETWEEN 1 AND 9007199254740991 THEN json_extract(v.data,'$.number') ELSE NULL END AS number,CASE WHEN json_type(v.data,'$.configuration_id')='text' THEN json_extract(v.data,'$.configuration_id') ELSE NULL END AS configuration_id,CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) ELSE NULL END AS configuration_name,CASE WHEN json_type(v.data,'$.sha256')='text' THEN substr(json_extract(v.data,'$.sha256'),1,65) ELSE NULL END AS sha FROM records v LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id') WHERE v.kind='version' AND v.id=?").bind(prior).fetch_optional(&mut *db).await? {
            previous_number=json!(row.get::<Option<i64>,_>("number"));
            configuration=json!(row.get::<Option<String>,_>("configuration_id").and_then(|v|id(&v).ok()));
            configuration_name=json!(row.get::<Option<String>,_>("configuration_name"));
            previous_sha=json!(row.get::<Option<String>,_>("sha"));
        } else {blockers.push(blocker("PRIOR_VERSION_MISSING","The recorded prior version is unavailable. Preserve deployment history and review a replacement version."));}
        if missing_prior_artifact {
            let version = db::record(db, "version", prior).await?;
            if version["variables"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
            {
                blockers.push(blocker("PRIOR_ARTIFACT_UNKNOWN","An exact prior target artifact is missing. Create a separately reviewed deployment; rollback will not guess variable values."));
            } else {
                for target in &mut eligible {
                    if target["artifact_sha256"].is_null() {
                        target["artifact_sha256"] = version["sha256"].clone();
                    }
                }
            }
        }
    }
    if blockers.is_empty() {
        blockers.extend(
            rollout::rollback_blockers(
                db,
                source,
                previous_version.as_deref().unwrap(),
                priority,
                &eligible
                    .iter()
                    .map(|v| v["device_id"].as_str().unwrap().to_owned())
                    .collect(),
            )
            .await?,
        );
    }
    let review_token = db::hash(format!(
        "vectory-rollback-review-v1\n{}",
        json!({"source_deployment_id":source,"source_version_id":version,"source_status":source_status,"source_priority":source_priority,"source_action":source_action,"previous_version_id":previous_version,"previous_sha256":previous_sha,"targets":identities})
    ));
    Ok(
        json!({"source_deployment_id":source,"source_version_id":version,"source_status":source_status,"source_action":source_action,"previous_version_id":previous_version,"previous_version_number":previous_number,"previous_configuration_id":configuration,"previous_configuration_name":configuration_name,"priority":priority,"eligible_devices":eligible,"excluded_devices":excluded,"ready":blockers.is_empty(),"blockers":blockers,"review_token":review_token}),
    )
}
pub(crate) async fn commit(
    db: &mut SqliteConnection,
    source: &str,
    review: Option<&str>,
    actor: &str,
) -> Result<Value> {
    let Some(token) = review else {
        return rollout::action(db, source, "rollback", actor).await;
    };
    let plan = preview(db, source).await?;
    if plan["review_token"].as_str() != Some(token) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ROLLBACK_REVIEW_CHANGED",
            "Rollback scope or delivery state changed. Review the eligible and excluded identities again before confirming.",
        ));
    }
    if plan["ready"] != true {
        return Err(ApiError::conflict(
            plan["blockers"][0]["reason"]
                .as_str()
                .unwrap_or("Rollback is not currently available"),
        ));
    }
    let deployment = db::record(db, "deployment", source).await?;
    rollout::execute_rollback(
        db,
        deployment,
        plan["previous_version_id"].as_str().unwrap(),
        plan["eligible_devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["device_id"].as_str().unwrap().to_owned())
            .collect(),
        actor,
    )
    .await
}
