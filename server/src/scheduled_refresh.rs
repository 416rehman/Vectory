//! Reviewed replacement of an unactivated schedule's saved target set.
//! No rollout admission or desired device state is changed here.
use crate::{
    auth, db,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State as AppState},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeSet;
const MAX: usize = 10_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    review_token: String,
    expected_device_ids: Vec<String>,
}
fn identity(value: &str) -> Result<String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| ApiError::invalid("Expected a hyphenated UUID"))?
        .hyphenated()
        .to_string();
    if !parsed.eq_ignore_ascii_case(value) {
        return Err(ApiError::invalid("Expected a hyphenated UUID"));
    }
    Ok(parsed)
}
fn bounded(ids: impl IntoIterator<Item = String>) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for id in ids {
        out.insert(identity(&id)?);
        if out.len() > MAX {
            return Err(ApiError::invalid(
                "Scheduled device review supports at most 10000 identities; no selection was truncated",
            ));
        }
    }
    Ok(out)
}
fn blocker(code: &str, reason: &str) -> Value {
    json!({"code":code,"reason":reason})
}
fn reject_query(query: Option<String>) -> Result<()> {
    if query.is_some_and(|q| !q.is_empty()) {
        return Err(ApiError::invalid(
            "Scheduled device refresh does not accept query parameters",
        ));
    }
    Ok(())
}
pub async fn post_preview(
    AppState(s): AppState<crate::State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    reject_query(query)?;
    if !body.is_empty() {
        serde_json::from_slice::<Empty>(&body)
            .map_err(|_| ApiError::invalid("Scheduled device preview accepts an empty object"))?;
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let (out, _, _) = plan(&mut tx, &identity(&id)?, actor["id"].as_str().unwrap()).await?;
    tx.rollback().await?;
    Ok(Json(out))
}
pub async fn post_commit(
    AppState(s): AppState<crate::State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    reject_query(query)?;
    let request: Request = serde_json::from_slice(&body)
        .map_err(|_| ApiError::invalid("Provide only review_token and expected_device_ids"))?;
    if request.review_token.len() != 64
        || !request
            .review_token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ApiError::invalid("Invalid scheduled device review token"));
    }
    if request.expected_device_ids.is_empty() || request.expected_device_ids.len() > MAX {
        return Err(ApiError::invalid(
            "Expected device IDs must contain 1..10000 distinct UUIDs",
        ));
    }
    let expected = bounded(request.expected_device_ids.clone())?;
    if expected.len() != request.expected_device_ids.len() {
        return Err(ApiError::invalid("Expected device IDs must be distinct"));
    }
    let id = identity(&id)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let actor = actor["id"].as_str().unwrap();
    let (preview, mut source, revision) = plan(&mut tx, &id, actor).await?;
    let proposed: BTreeSet<String> = preview["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_owned())
        .collect();
    if preview["review_token"] != request.review_token || proposed != expected {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "SCHEDULE_REFRESH_REVIEW_CHANGED",
            "The schedule or device selection changed after review. Review the current saved and proposed devices again.",
        ));
    }
    if preview["ready"] != true {
        return Err(ApiError::conflict(
            "This schedule cannot refresh its saved devices; review its current state",
        ));
    }
    let saved: BTreeSet<String> = preview["saved_devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_owned())
        .collect();
    if saved != proposed {
        let next = revision
            .checked_add(1)
            .filter(|n| *n <= MAX_SAFE)
            .ok_or_else(|| ApiError::conflict("Scheduled device revision is exhausted"))?;
        sqlx::query("DELETE FROM deployment_targets WHERE deployment_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        for device in proposed {
            sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id) VALUES(?,?)")
                .bind(&id)
                .bind(device)
                .execute(&mut *tx)
                .await?;
        }
        source["target_refresh_revision"] = json!(next);
        db::update(&mut tx, "deployment", &source).await?;
        db::audit(&mut tx, actor, "deployment.refresh_targets", &id, "success").await?;
    }
    let result = rollout::deployment(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
async fn selection(db: &mut SqliteConnection, v: &Value) -> Result<BTreeSet<String>> {
    fn array(v: &Value, key: &str) -> Result<Vec<String>> {
        let a = v[key]
            .as_array()
            .filter(|a| a.len() <= MAX)
            .ok_or_else(|| ApiError::invalid("Invalid stored selector"))?;
        a.iter()
            .map(|x| {
                identity(
                    x.as_str()
                        .ok_or_else(|| ApiError::invalid("Invalid stored selector"))?,
                )
            })
            .collect()
    }
    let excluded = bounded(array(v, "exclude_ids")?)?;
    let mut selected = BTreeSet::new();
    for id in array(v, "device_ids")? {
        if !excluded.contains(&id) {
            selected.insert(id);
        }
    }
    for group in array(v, "group_ids")? {
        let g = db::record(db, "group", &group).await?;
        for id in array(&g, "device_ids")? {
            if !excluded.contains(&id) {
                selected.insert(id);
                if selected.len() > MAX {
                    return Err(ApiError::invalid(
                        "Scheduled device review supports at most 10000 identities; no selection was truncated",
                    ));
                }
            }
        }
    }
    for id in &selected {
        let live: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=? AND revoked=0")
            .bind(id)
            .fetch_one(&mut *db)
            .await?;
        if live != 1 {
            return Err(ApiError::invalid(
                "Stored selector contains an unavailable identity",
            ));
        }
    }
    Ok(selected)
}
async fn device(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let row=sqlx::query("SELECT substr(name,1,240) AS name,revoked,CASE WHEN json_type(data,'$.last_seen')='text' THEN substr(json_extract(data,'$.last_seen'),1,64) END AS last_seen,CASE WHEN json_type(data,'$.apply_state')='text' THEN substr(json_extract(data,'$.apply_state'),1,64) END AS apply_state,COALESCE(json_extract(data,'$.local_paused'),0) AS local_paused,COALESCE(json_extract(policy,'$.sync_paused'),0) AS sync_paused,policy,policy_generation,json_object('policy_generation',json_extract(data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(data,'$.heartbeat_floor_seconds')) AS acknowledgement FROM devices WHERE id=?").bind(id).fetch_optional(&mut *db).await?;
    let Some(row) = row else {
        return Ok(json!({"id":id,"name":null,"status":"missing"}));
    };
    let state: Option<String> = row.get("apply_state");
    let at: Option<String> = row.get("last_seen");
    let interval = rollout::check_in_seconds(
        &db::parse(row.get("policy"))?,
        &db::parse(row.get("acknowledgement"))?,
        row.get("policy_generation"),
    );
    let status = if row.get::<bool, _>("revoked") {
        "revoked"
    } else if at.is_none() {
        "awaiting_first_check_in"
    } else if !rollout::checked_in_recently(at.as_deref(), interval) {
        "offline"
    } else if row.get::<bool, _>("local_paused") || row.get::<bool, _>("sync_paused") {
        "paused"
    } else {
        match state.as_deref() {
            Some("failed") => "failed",
            Some("rolled_back") => "rolled_back",
            Some("unmanaged") => "unmanaged",
            Some("verification_unknown") => "verification_unknown",
            _ => "online",
        }
    };
    Ok(json!({"id":id,"name":row.get::<Option<String>,_>("name"),"status":status}))
}
async fn plan(db: &mut SqliteConnection, id: &str, actor: &str) -> Result<(Value, Value, u64)> {
    let source = db::record(db, "deployment", id).await?;
    let at = source["scheduled_at"]
        .as_str()
        .filter(|s| s.len() <= 64)
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .ok_or_else(|| {
            ApiError::conflict("Only a deployment created as a schedule can review saved devices")
        })?;
    let status = source["status"]
        .as_str()
        .filter(|s| {
            [
                "scheduled",
                "active",
                "paused",
                "completed",
                "cancelled",
                "failed",
                "missed",
                "unassigned",
            ]
            .contains(s)
        })
        .ok_or_else(|| ApiError::conflict("Stored schedule status is invalid"))?;
    let revision = match source.get("target_refresh_revision") {
        None => 0,
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= MAX_SAFE)
            .ok_or_else(|| ApiError::conflict("Stored scheduled device revision is invalid"))?,
    };
    let target_rows:Vec<String>=sqlx::query_scalar("SELECT json_object('id',device_id,'state',state,'generation',generation,'released_at',released_at,'verified_at',verified_at) FROM deployment_targets WHERE deployment_id=? ORDER BY device_id LIMIT 10001").bind(id).fetch_all(&mut *db).await?;
    if target_rows.len() > MAX {
        return Err(ApiError::invalid(
            "Scheduled device review supports at most 10000 identities; no selection was truncated",
        ));
    }
    let targets: Vec<Value> = target_rows
        .iter()
        .map(|s| db::parse(s))
        .collect::<Result<_>>()?;
    let saved = bounded(targets.iter().map(|v| v["id"].as_str().unwrap().to_owned()))?;
    let mut blockers = vec![];
    if source["target_mode"] != "snapshot" {
        blockers.push(blocker(
            "INVALID_SCHEDULE",
            "Scheduled device refresh requires an original frozen snapshot schedule.",
        ));
    }
    let selected = if status != "scheduled" {
        blockers.push(blocker(
            "SCHEDULE_INACTIVE",
            "This schedule is no longer waiting to activate. Its saved devices cannot be changed.",
        ));
        BTreeSet::new()
    } else {
        match selection(db, &source["selector"]).await {
            Ok(v) => v,
            Err(e) if e.status == StatusCode::BAD_REQUEST || e.status == StatusCode::NOT_FOUND => {
                blockers.push(blocker("INVALID_SELECTION","The stored selector contains missing, revoked, invalid, or too many device identities. Review the source groups and create a new schedule if needed."));
                BTreeSet::new()
            }
            Err(e) => return Err(e),
        }
    };
    let union = bounded(saved.union(&selected).cloned())?;
    if status == "scheduled" && selected.is_empty() && blockers.is_empty() {
        blockers.push(blocker("NO_TARGETS","Current group membership selects no devices. A schedule must have at least one device."));
    }
    let mut bindings_ready = true;
    if status == "scheduled" && !selected.is_empty() && source["version_id"].is_string() {
        let version = db::record(db, "version", source["version_id"].as_str().unwrap()).await?;
        let mut bound_targets = union.clone();
        if let Some(overrides) = source["variable_bindings"]["devices"].as_object() {
            bound_targets.extend(overrides.keys().cloned());
        }
        if crate::variables::validate_bindings(
            &version,
            &source["variable_bindings"],
            &bound_targets,
            false,
        )
        .is_err()
        {
            bindings_ready = false;
            blockers.push(blocker("VARIABLE_BINDING_REQUIRED","A newly selected device has no value for a version variable. Create a new schedule with reviewed bindings for the updated membership."));
        }
    }
    if status == "scheduled" && !selected.is_empty() && bindings_ready {
        blockers.extend(rollout::compatibility_blockers(db, &source, &selected).await?);
    }
    if status == "scheduled"
        && targets.iter().any(|t| {
            t["state"] != "pending"
                || t["generation"] != 0
                || !t["released_at"].is_null()
                || !t["verified_at"].is_null()
        })
    {
        blockers.push(blocker("SCHEDULE_ALREADY_RELEASED","This schedule contains released or changed target evidence and cannot replace its saved devices."));
    }
    if saved != selected && revision == MAX_SAFE {
        blockers.push(blocker(
            "REVISION_EXHAUSTED",
            "This schedule cannot accept another saved-device revision.",
        ));
    }
    let resource = if source["version_id"].is_string() {
        "configuration"
    } else {
        "policy"
    };
    let authority = json!({"format":1,"actor":actor,"id":id,"status":status,"scheduled_at":at,"resource":resource,"version_id":source["version_id"],"policy":source["policy"],"variable_bindings_sha256":db::hash(&crate::deployment_requests::canonical(&source["variable_bindings"]).to_string()),"priority":source["priority"],"rollout":source["rollout"],"target_mode":source["target_mode"],"selector":source["selector"],"revision":revision,"targets":targets,"selected":selected,"blockers":blockers});
    let token = db::hash(&crate::deployment_requests::canonical(&authority).to_string());
    let mut saved_devices = vec![];
    let mut devices = vec![];
    for id in union {
        let d = device(db, &id).await?;
        if saved.contains(&id) {
            saved_devices.push(d.clone());
        }
        if selected.contains(&id) {
            devices.push(d);
        }
    }
    Ok((
        json!({"refresh_review":true,"source_deployment_id":id,"source_status":status,"resource":resource,"scheduled_at":at,"ready":blockers.is_empty(),"review_token":token,"saved_devices":saved_devices,"devices":devices,"warnings":["This updates only the saved device selection. Priority, active-canary conflicts and device eligibility are checked again when the schedule activates."],"blockers":blockers}),
        source,
        revision,
    ))
}
