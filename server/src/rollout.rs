use crate::{
    State, db,
    error::{ApiError, Result},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

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
pub async fn devices(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT * FROM devices ORDER BY name")
        .fetch_all(&mut *db)
        .await?;
    let mut out = Vec::new();
    let mut version_evidence = std::collections::HashMap::<String, (String, bool)>::new();
    for row in rows {
        let mut d = db::parse(row.get("data"))?;
        d["desired_generation"] = json!(row.get::<i64, _>("desired_generation"));
        d["desired_version_id"] = json!(row.get::<Option<String>, _>("desired_version_id"));
        let policy = db::parse(row.get("policy"))?;
        d["sync_paused"] = policy["sync_paused"].clone();
        let revoked: bool = row.get("revoked");
        let mut verified_current = false;
        if d["apply_state"] == "verified_applied"
            && d["reported_generation"] == d["desired_generation"]
        {
            if let Some(version) = d["desired_version_id"].as_str() {
                if !version_evidence.contains_key(version) {
                    if let Some(metadata)=sqlx::query("SELECT json_extract(data,'$.sha256') AS sha256,json_extract(data,'$.uses_local_secrets') AS uses_local_secrets FROM records WHERE kind='version' AND id=?").bind(version).fetch_optional(&mut *db).await?{
                        version_evidence.insert(version.to_owned(),(metadata.get("sha256"),metadata.get::<Option<bool>,_>("uses_local_secrets").unwrap_or(false)));
                    }
                }
                if let Some((sha, uses_local_secrets)) = version_evidence.get(version) {
                    verified_current = if *uses_local_secrets {
                        d["applied_template_sha256"].as_str() == Some(sha.as_str())
                            && d["actual_sha256"].as_str().is_some_and(|actual| {
                                actual.len() == 64
                                    && d["verified_effective_sha256"].as_str() == Some(actual)
                            })
                            && d["verified_secret_revision"].as_u64().unwrap_or(0) >= 1
                    } else {
                        d["actual_sha256"].as_str() == Some(sha.as_str())
                    };
                }
            }
        }
        let online = d["last_seen"]
            .as_str()
            .and_then(|x| DateTime::parse_from_rfc3339(x).ok())
            .is_some_and(|at| {
                Utc::now().signed_duration_since(at).num_seconds()
                    <= policy["heartbeat_seconds"].as_i64().unwrap_or(60) * 3
            });
        d["status"] = json!(if revoked {
            "revoked"
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
        if let Some(assignment) = row.get::<Option<String>, _>("assignment_id") {
            if let Ok(a) = db::record(db, "deployment", &assignment).await {
                d["assignment"] = json!({"id":assignment,"priority":a["priority"],"reason":format!("{} assignment; highest explicit priority",text(&a,"target_mode"))});
            }
        }
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
    v["targets"] = json!(targets(db, id).await?);
    Ok(v)
}
pub async fn deployments(db: &mut SqliteConnection) -> Result<Vec<Value>> {
    let mut a = db::records(db, "deployment").await?;
    for v in &mut a {
        v["targets"] = json!(targets(db, text(v, "id")).await?)
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
fn identity(v: &Value) -> String {
    if v["version_id"].is_string() {
        text(v, "version_id").into()
    } else {
        v["policy"].to_string()
    }
}
fn candidate_status(v: &Value) -> bool {
    ["active", "paused", "completed", "cancelled", "failed"].contains(&text(v, "status"))
}
async fn candidate_targets(db: &mut SqliteConnection, d: &Value) -> Result<BTreeSet<String>> {
    if text(d, "target_mode") == "persistent"
        && !["cancelled", "failed"].contains(&text(d, "status"))
    {
        select_impl(db, &d["selector"], false).await
    } else {
        let rows = sqlx::query(
            "SELECT device_id,generation FROM deployment_targets WHERE deployment_id=?",
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
pub async fn conflicts(db: &mut SqliteConnection, extra: Option<&Value>) -> Result<Vec<Value>> {
    let mut deployments = db::records(db, "deployment").await?;
    if let Some(x) = extra {
        deployments.retain(|d| d["id"] != x["id"]);
        deployments.push(x.clone());
    }
    let mut entries: BTreeMap<(String, String, i64), (String, String)> = BTreeMap::new();
    let mut conflicts = Vec::new();
    for d in deployments.iter().filter(|v| candidate_status(v)) {
        let selected = if extra.is_some_and(|e| e["id"] == d["id"]) {
            select(db, &d["selector"]).await?
        } else {
            candidate_targets(db, d).await?
        };
        for device in selected {
            let key = (
                device.clone(),
                kind(d).to_owned(),
                d["priority"].as_i64().unwrap_or(0),
            );
            if let Some((payload, other)) = entries.get(&key) {
                if payload != &identity(d) {
                    conflicts.push(json!({"device_id":device,"assignment_ids":[other,text(d,"id")],"priority":d["priority"],"resource":kind(d)}))
                }
            } else {
                entries.insert(key, (identity(d), text(d, "id").into()));
            }
        }
    }
    Ok(conflicts)
}
pub fn validate_request(v: &Value) -> Result<()> {
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
pub async fn preview(db: &mut SqliteConnection, v: &Value) -> Result<Value> {
    validate_request(v)?;
    let selected = select(db, &v["selector"]).await?;
    if v["version_id"].is_string() {
        db::record(db, "version", text(v, "version_id")).await?;
    }
    let fleet = devices(db)
        .await?
        .into_iter()
        .filter(|d| selected.contains(text(d, "id")))
        .collect::<Vec<_>>();
    let mut candidate = v.clone();
    candidate["id"] = json!("preview");
    candidate["status"] = json!("active");
    let issues = conflicts(db, Some(&candidate)).await?;
    let mut warnings = Vec::new();
    if fleet.is_empty() {
        warnings.push("No devices selected".to_owned())
    }
    if text(v, "target_mode") == "snapshot" {
        warnings.push("Targets are frozen when this deployment is created".into())
    }
    if fleet.iter().any(|d| text(d, "status") == "offline") {
        warnings.push(
            "Offline devices remain pending until they reconnect and verify activation".into(),
        )
    }
    if v["version_id"].is_string()
        && fleet
            .iter()
            .any(|d| text(d, "vector_version") != crate::validation::VECTOR_VERSION)
    {
        warnings.push(format!(
            "Incompatible devices cannot be released: Vector {} required",
            crate::validation::VECTOR_VERSION
        ))
    }
    Ok(json!({"devices":fleet,"conflicts":issues,"warnings":warnings}))
}
pub async fn create(db: &mut SqliteConnection, v: &Value, actor: &str) -> Result<Value> {
    let p = preview(db, v).await?;
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
    for old in db::records(db, "deployment").await? {
        if kind(&old) == kind(v)
            && text(&old["rollout"], "kind") == "canary"
            && text(&old, "status") == "active"
            && !selected.is_disjoint(&candidate_targets(db, &old).await?)
        {
            return Err(ApiError::conflict(
                "An active canary overlaps these targets; pause or cancel it before superseding",
            ));
        }
    }
    let mut d = v.clone();
    d["id"] = json!(db::id());
    d["created_at"] = json!(db::now());
    d["status"] = json!(if v["scheduled_at"].is_string() {
        "scheduled"
    } else {
        "active"
    });
    d.as_object_mut().unwrap().remove("targets");
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
pub async fn reconcile_membership(db: &mut SqliteConnection) -> Result<()> {
    if !conflicts(db, None).await?.is_empty() {
        return Err(ApiError::conflict(
            "Group membership creates conflicting equal-priority assignments",
        ));
    }
    for mut d in db::records(db, "deployment").await? {
        if text(&d, "target_mode") != "persistent"
            || !["active", "paused", "completed"].contains(&text(&d, "status"))
        {
            continue;
        }
        let members = select_impl(db, &d["selector"], false).await?;
        let mut added = false;
        for target in targets(db, text(&d, "id")).await? {
            if !members.contains(text(&target, "device_id")) && target["state"] != "removed" {
                sqlx::query("UPDATE deployment_targets SET state='removed',generation=0,released_at=NULL,verified_at=NULL WHERE deployment_id=? AND device_id=?").bind(text(&d,"id")).bind(text(&target,"device_id")).execute(&mut *db).await?;
            }
        }
        for device in &members {
            let result=sqlx::query("INSERT OR IGNORE INTO deployment_targets(deployment_id,device_id,original) VALUES(?,?,0)").bind(text(&d,"id")).bind(device).execute(&mut *db).await?;
            added |= result.rows_affected() > 0;
            let restored=sqlx::query("UPDATE deployment_targets SET state='pending',generation=0,released_at=NULL,verified_at=NULL WHERE deployment_id=? AND device_id=? AND state='removed'").bind(text(&d,"id")).bind(device).execute(&mut *db).await?;
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
pub async fn resolve(db: &mut SqliteConnection) -> Result<()> {
    if !conflicts(db, None).await?.is_empty() {
        return Err(ApiError::conflict(
            "Inconsistent assignment state; preserving last valid desired state",
        ));
    }
    let mut winners: BTreeMap<(String, String), Value> = BTreeMap::new();
    for d in db::records(db, "deployment")
        .await?
        .into_iter()
        .filter(candidate_status)
    {
        for device in candidate_targets(db, &d).await? {
            let key = (device, kind(&d).into());
            let replace = winners.get(&key).is_none_or(|old| {
                d["priority"].as_i64() > old["priority"].as_i64()
                    || (d["priority"] == old["priority"] && text(&d, "id") < text(old, "id"))
            });
            if replace {
                winners.insert(key, d.clone());
            }
        }
    }
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
                let admitted:Option<i64>=sqlx::query_scalar("SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?").bind(text(w,"id")).bind(&device).fetch_optional(&mut *db).await?;
                if admitted.unwrap_or(0) == 0 {
                    continue;
                } // Candidate cannot bypass rollout admission.
                if old_id.as_deref() == Some(text(w, "id")) {
                    continue;
                }
                if resource == "configuration" {
                    let current: Option<String> = row.get("desired_version_id");
                    let new = text(w, "version_id");
                    if current.as_deref() == Some(new) {
                        sqlx::query("UPDATE devices SET assignment_id=? WHERE id=?")
                            .bind(text(w, "id"))
                            .bind(&device)
                            .execute(&mut *db)
                            .await?;
                    } else {
                        sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=desired_generation+1,assignment_id=? WHERE id=?").bind(new).bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                    }
                    let generation: i64 =
                        sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
                            .bind(&device)
                            .fetch_one(&mut *db)
                            .await?;
                    sqlx::query("UPDATE deployment_targets SET generation=?,previous_version_id=? WHERE deployment_id=? AND device_id=?").bind(generation).bind(current).bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                } else {
                    let old = db::parse(row.get("policy"))?;
                    let inc = if old == w["policy"] && old_id.is_some() {
                        0
                    } else {
                        1
                    };
                    sqlx::query("UPDATE devices SET policy=?,policy_generation=policy_generation+?,policy_assignment_id=? WHERE id=?").bind(w["policy"].to_string()).bind(inc).bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                    let generation: i64 =
                        sqlx::query_scalar("SELECT policy_generation FROM devices WHERE id=?")
                            .bind(&device)
                            .fetch_one(&mut *db)
                            .await?;
                    sqlx::query("UPDATE deployment_targets SET generation=? WHERE deployment_id=? AND device_id=?").bind(generation.max(1)).bind(text(w,"id")).bind(&device).execute(&mut *db).await?;
                }
            } else if old_id.is_some() {
                if resource == "configuration" {
                    sqlx::query("UPDATE devices SET desired_version_id=NULL,desired_generation=desired_generation+1,assignment_id=NULL WHERE id=?").bind(&device).execute(&mut *db).await?;
                } else {
                    sqlx::query("UPDATE devices SET policy=?,policy_generation=policy_generation+1,policy_assignment_id=NULL WHERE id=?").bind(db::default_policy().to_string()).bind(&device).execute(&mut *db).await?;
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
        db::update(db, "deployment", d).await?;
        db::audit(db, "scheduler", "deployment.gate", text(d, "id"), "failed").await?;
        return Ok(());
    }
    let mut all_verified = released.iter().all(|t| t["state"] == "verified_applied");
    for target in &released {
        let row = sqlx::query("SELECT data,policy,revoked FROM devices WHERE id=?")
            .bind(text(target, "device_id"))
            .fetch_one(&mut *db)
            .await?;
        let device = db::parse(row.get("data"))?;
        let policy = db::parse(row.get("policy"))?;
        let fresh = device["last_seen"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .is_some_and(|at| {
                Utc::now().signed_duration_since(at).num_seconds()
                    <= policy["heartbeat_seconds"].as_i64().unwrap_or(60) * 3
            });
        all_verified &= fresh && !row.get::<bool, _>("revoked");
    }
    let is_canary = d["rollout"]["kind"] == "canary";
    if is_canary && !released.is_empty() {
        if !all_verified {
            if !d["observation_started_at"].is_null() {
                d["observation_started_at"] = Value::Null;
                db::update(db, "deployment", d).await?;
            }
            return Ok(());
        }
        let at = d["observation_started_at"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        if at.is_none() {
            d["observation_started_at"] = json!(db::now());
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
    for target in pending.into_iter().take(take) {
        let row = sqlx::query("SELECT data,revoked FROM devices WHERE id=?")
            .bind(text(target, "device_id"))
            .fetch_one(&mut *db)
            .await?;
        let device = db::parse(row.get("data"))?;
        if row.get::<bool, _>("revoked")
            || (kind(d) == "configuration"
                && text(&device, "vector_version") != crate::validation::VECTOR_VERSION)
        {
            sqlx::query("UPDATE deployment_targets SET state='incompatible',error='Device is revoked or Vector version incompatible' WHERE deployment_id=? AND device_id=?").bind(text(d,"id")).bind(text(target,"device_id")).execute(&mut *db).await?;
            d["status"] = json!("failed");
        } else {
            // Positive sentinel marks admission. resolve immediately replaces it with actual generation in the same transaction.
            sqlx::query("UPDATE deployment_targets SET state='desired',generation=1,released_at=? WHERE deployment_id=? AND device_id=? AND generation=0").bind(db::now()).bind(text(d,"id")).bind(text(target,"device_id")).execute(&mut *db).await?;
            db::audit(
                db,
                "scheduler",
                "deployment.release",
                &format!("{}:{}", text(d, "id"), text(target, "device_id")),
                "success",
            )
            .await?;
        }
    }
    d["observation_started_at"] = Value::Null;
    db::update(db, "deployment", d).await?;
    Ok(())
}
pub async fn tick(s: &State) -> Result<()> {
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    for mut d in db::records(&mut tx, "deployment").await? {
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
        }
        "pause" => {
            if d["status"] != "active" {
                return Err(ApiError::conflict("Only active deployments can be paused"));
            }
            d["status"] = json!("paused");
        }
        "resume" => {
            if d["status"] != "paused" {
                return Err(ApiError::conflict("Only paused deployments can be resumed"));
            }
            d["status"] = json!("active");
        }
        "unassign" => {
            if !candidate_status(&d) {
                return Err(ApiError::conflict(
                    "Only an activated assignment can be removed",
                ));
            }
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
            let rows=sqlx::query("SELECT device_id,previous_version_id FROM deployment_targets WHERE deployment_id=? AND generation>0").bind(id).fetch_all(&mut *db).await?;
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
            d["status"] = json!("cancelled");
            db::update(db, "deployment", &d).await?;
            let v = json!({"version_id":previous.first().unwrap(),"selector":{"device_ids":rows.iter().map(|r|r.get::<String,_>("device_id")).collect::<Vec<_>>(),"group_ids":[],"exclude_ids":[]},"priority":d["priority"].as_i64().unwrap_or(0)+1,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}});
            let result = create(db, &v, actor).await?;
            db::audit(db, actor, "deployment.rollback", id, "success").await?;
            return Ok(result);
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
