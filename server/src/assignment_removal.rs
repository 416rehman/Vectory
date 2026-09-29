//! A review fingerprint binds actual resolver effects, not mutable display names.
//! Simulation and confirmation use the existing resolver in one writer transaction.
use crate::{
    db,
    error::{ApiError, Result},
    rollout,
};
use axum::http::StatusCode;
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State as AppState},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

const MAX_TARGETS: usize = 10_000;
const MAX_SAFE: i64 = 9_007_199_254_740_991;
pub(crate) const CONFIG: &str = "json_object('assignment_id',d.assignment_id,'version_id',d.desired_version_id,'generation',d.desired_generation,'policy',NULL)";
pub(crate) const POLICY: &str = "json_object('assignment_id',d.policy_assignment_id,'version_id',NULL,'generation',d.policy_generation,'policy',json(d.policy))";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitRequest {
    review_token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {}

pub async fn post_preview(
    AppState(s): AppState<crate::State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Json<Value>> {
    crate::auth::authorize(&s, &h, &["operator"], true).await?;
    if query.as_ref().is_some_and(|v| !v.is_empty()) {
        return Err(ApiError::invalid(
            "Assignment removal preview does not accept query parameters",
        ));
    }
    if !body.is_empty() {
        serde_json::from_slice::<PreviewRequest>(&body)
            .map_err(|_| ApiError::invalid("Assignment removal preview accepts an empty object"))?;
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = crate::auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let result = preview(&mut tx, &id, actor["id"].as_str().unwrap()).await?;
    tx.rollback().await?;
    Ok(Json(result))
}
pub async fn post_commit(
    AppState(s): AppState<crate::State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Result<Json<Value>> {
    crate::auth::authorize(&s, &h, &["operator"], true).await?;
    if query.as_ref().is_some_and(|v| !v.is_empty()) {
        return Err(ApiError::invalid(
            "Assignment removal does not accept query parameters",
        ));
    }
    let request: CommitRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError::invalid("Provide only one required assignment-removal review_token")
    })?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = crate::auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let result = commit(
        &mut tx,
        &id,
        &json!({"review_token":request.review_token}),
        actor["id"].as_str().unwrap(),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(result))
}

fn limit() -> ApiError {
    ApiError::invalid(
        "Assignment removal review supports at most 10000 affected or historical device identities; no scope was truncated",
    )
}
fn blocker(code: &str, reason: &str) -> Value {
    json!({"code":code,"reason":reason})
}
fn uuid(value: &str) -> Result<String> {
    let parsed = uuid::Uuid::parse_str(value)
        .map_err(|_| ApiError::invalid("Deployment identity must be a hyphenated UUID"))?;
    let id = parsed.hyphenated().to_string();
    if !id.eq_ignore_ascii_case(value) {
        return Err(ApiError::invalid(
            "Deployment identity must be a hyphenated UUID",
        ));
    }
    Ok(id)
}
fn validate_state(value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    for field in ["assignment_id", "version_id"] {
        if let Some(id) = value[field].as_str() {
            uuid(id)?;
        } else if !value[field].is_null() {
            return Err(ApiError::conflict("Stored delivery identity is invalid"));
        }
    }
    if !value["generation"]
        .as_i64()
        .is_some_and(|n| (0..=MAX_SAFE).contains(&n))
    {
        return Err(ApiError::conflict("Stored delivery generation is invalid"));
    }
    if !value["policy"].is_null() {
        db::validate_policy(&value["policy"])?;
    }
    Ok(())
}
pub(crate) async fn decorate(db: &mut SqliteConnection, value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let mut out = value.clone();
    out["assignment_name"] = Value::Null;
    out["configuration_name"] = Value::Null;
    out["version_number"] = Value::Null;
    if let Some(id) = value["assignment_id"].as_str() {
        out["assignment_name"] = name(db, "deployment", id, 120).await?;
    }
    if let Some(id) = value["version_id"].as_str() {
        if let Some(row)=sqlx::query("SELECT CASE WHEN json_type(v.data,'$.number')='integer' AND json_extract(v.data,'$.number') BETWEEN 1 AND 9007199254740991 THEN json_extract(v.data,'$.number') END AS number,CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) END AS name FROM records v LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id') WHERE v.kind='version' AND v.id=?").bind(id).fetch_optional(&mut *db).await? {
            out["configuration_name"]=json!(row.get::<Option<String>,_>("name"));
            out["version_number"]=json!(row.get::<Option<i64>,_>("number"));
        }
    }
    Ok(out)
}
async fn name(db: &mut SqliteConnection, kind: &str, id: &str, max: i64) -> Result<Value> {
    Ok(json!(sqlx::query_scalar::<_,Option<String>>("SELECT CASE WHEN json_type(data,'$.name')='text' THEN substr(json_extract(data,'$.name'),1,?) END FROM records WHERE kind=? AND id=?").bind(max).bind(kind).bind(id).fetch_optional(db).await?.flatten()))
}

pub(crate) async fn preview(db: &mut SqliteConnection, source: &str, actor: &str) -> Result<Value> {
    let source = uuid(source)?;
    // All temporary tables and simulated resolver writes are rolled back even on
    // rejection. The outer API transaction holds live authorization and the writer.
    sqlx::query("SAVEPOINT assignment_removal_review")
        .execute(&mut *db)
        .await?;
    let result = simulate(db, &source, actor).await;
    sqlx::query("ROLLBACK TO assignment_removal_review")
        .execute(&mut *db)
        .await?;
    sqlx::query("RELEASE assignment_removal_review")
        .execute(&mut *db)
        .await?;
    result
}
async fn simulate(db: &mut SqliteConnection, source: &str, actor: &str) -> Result<Value> {
    let deployment = db::record(db, "deployment", source).await?;
    let resource = if deployment["version_id"].is_string() {
        "configuration"
    } else {
        "policy"
    };
    if !deployment["priority"]
        .as_i64()
        .is_some_and(|v| (-1_000_000..=1_000_000).contains(&v))
    {
        return Err(ApiError::conflict("Stored assignment priority is invalid"));
    }
    if resource == "configuration" {
        uuid(deployment["version_id"].as_str().unwrap())?;
    } else {
        db::validate_policy(&deployment["policy"])?;
    }
    let status = deployment["status"]
        .as_str()
        .filter(|s| s.len() <= 64)
        .ok_or_else(|| ApiError::conflict("Stored assignment status is invalid"))?;
    let removable = matches!(
        status,
        "active" | "paused" | "completed" | "cancelled" | "failed"
    );
    let mut blockers = Vec::new();
    if !removable {
        blockers.push(blocker(
            "SOURCE_NOT_REMOVABLE",
            "Only an activated assignment can be removed. Review the current deployment status.",
        ));
    }
    let target_rows=sqlx::query("SELECT device_id,generation,state FROM deployment_targets WHERE deployment_id=? ORDER BY device_id LIMIT 10001").bind(source).fetch_all(&mut *db).await?;
    if target_rows.len() > MAX_TARGETS {
        return Err(limit());
    }
    let mut targets = BTreeMap::new();
    for row in target_rows {
        if !(0..=MAX_SAFE).contains(&row.get::<i64, _>("generation")) {
            return Err(ApiError::conflict("Stored target generation is invalid"));
        }
        targets.insert(uuid(row.get("device_id"))?,json!({"generation":row.get::<i64,_>("generation"),"removed":row.get::<String,_>("state")=="removed"}));
    }
    let members = if removable {
        rollout::candidate_targets(db, &deployment).await?
    } else {
        BTreeSet::new()
    };
    let mut scope: BTreeSet<String> = targets
        .keys()
        .cloned()
        .chain(members.iter().cloned())
        .collect();
    if scope.len() > MAX_TARGETS {
        return Err(limit());
    }
    // SQLite, not Rust, stores the fleet-wide minimal baseline. This detects
    // existing global resolver collateral without loading complete device blobs.
    sqlx::query(&format!("CREATE TEMP TABLE removal_before AS SELECT d.id,substr(d.name,1,240) AS name,d.revoked,{CONFIG} AS configuration,{POLICY} AS policy_state FROM devices d")).execute(&mut *db).await?;
    let owned: Vec<String> = sqlx::query_scalar(if resource == "configuration" {
        "SELECT id FROM devices WHERE assignment_id=? LIMIT 10001"
    } else {
        "SELECT id FROM devices WHERE policy_assignment_id=? LIMIT 10001"
    })
    .bind(source)
    .fetch_all(&mut *db)
    .await?;
    scope.extend(owned);
    if scope.len() > MAX_TARGETS {
        return Err(limit());
    }
    sqlx::query("CREATE TEMP TABLE removal_scope(id TEXT PRIMARY KEY)")
        .execute(&mut *db)
        .await?;
    for id in &scope {
        sqlx::query("INSERT INTO removal_scope VALUES(?)")
            .bind(id)
            .execute(&mut *db)
            .await?;
    }
    if removable {
        // Simulate the same status transition and resolver, without even
        // attempting a success audit during a read-only preview.
        let mut removed = deployment.clone();
        removed["status"] = json!("unassigned");
        db::update(db, "deployment", &removed).await?;
        rollout::resolve(db).await?;
    }
    let rows=sqlx::query(&format!("WITH ids AS (SELECT id FROM removal_scope UNION SELECT b.id FROM removal_before b JOIN devices d ON d.id=b.id WHERE b.configuration IS NOT {CONFIG} OR b.policy_state IS NOT {POLICY}) SELECT i.id,b.name,b.revoked,b.configuration AS before_config,b.policy_state AS before_policy,CASE WHEN d.id IS NOT NULL THEN {CONFIG} END AS after_config,CASE WHEN d.id IS NOT NULL THEN {POLICY} END AS after_policy FROM ids i LEFT JOIN removal_before b ON b.id=i.id LEFT JOIN devices d ON d.id=i.id ORDER BY i.id LIMIT 10001")).fetch_all(&mut *db).await?;
    if rows.len() > MAX_TARGETS {
        return Err(limit());
    }
    let ids: BTreeSet<String> = rows.iter().map(|r| r.get("id")).collect();
    let winners = rollout::assignment_winners_for(db, Some(&ids)).await?;
    let mut devices = Vec::new();
    let mut identities = Vec::new();
    let mut collateral = false;
    for row in rows {
        let id: String = row.get("id");
        uuid(&id)?;
        let parse = |column: &str| -> Result<Value> {
            row.get::<Option<String>, _>(column)
                .map(|v| db::parse(&v))
                .transpose()
                .map(|v| v.unwrap_or(Value::Null))
        };
        let before_config = parse("before_config")?;
        let after_config = parse("after_config")?;
        let before_policy = parse("before_policy")?;
        let after_policy = parse("after_policy")?;
        let (before, after, other_changed) = if resource == "configuration" {
            (&before_config, &after_config, before_policy != after_policy)
        } else {
            (&before_policy, &after_policy, before_config != after_config)
        };
        validate_state(before)?;
        validate_state(after)?;
        let changed = before != after;
        collateral |= other_changed || (!scope.contains(&id) && changed);
        let exists = !before.is_null();
        let revoked = row.get::<Option<bool>, _>("revoked").unwrap_or(false);
        let winner = winners.get(&(id.clone(), resource.to_owned()));
        let mut winner_identity = Value::Null;
        let mut pending = Value::Null;
        if let Some(winner) = winner {
            let winner_id = winner["id"].as_str().unwrap();
            uuid(winner_id)?;
            if resource == "policy" {
                db::validate_policy(&winner["policy"])?;
            }
            let admitted:Option<i64>=sqlx::query_scalar("SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=? AND state<>'removed'").bind(winner_id).bind(&id).fetch_optional(&mut *db).await?;
            if admitted.unwrap_or(0) == 0 {
                pending = json!(winner_id);
            }
            let sha: Option<String> = if let Some(version) = winner["version_id"].as_str() {
                sqlx::query_scalar("SELECT json_extract(data,'$.sha256') FROM records WHERE kind='version' AND id=?").bind(version).fetch_optional(&mut *db).await?.flatten()
            } else {
                None
            };
            winner_identity = json!({"id":winner_id,"priority":winner["priority"],"version_id":winner["version_id"],"sha256":sha,"policy":winner["policy"],"admitted":admitted.unwrap_or(0)>0});
        }
        let effect = if !exists {
            "missing"
        } else if revoked {
            "revoked"
        } else if changed {
            if after["assignment_id"].is_null() {
                if resource == "configuration" {
                    "unmanaged"
                } else {
                    "default_policy"
                }
            } else {
                "fallback"
            }
        } else if !pending.is_null() && (members.contains(&id) || before["assignment_id"] == source)
        {
            "retained_pending"
        } else if !members.contains(&id) && before["assignment_id"] != source {
            "not_targeted"
        } else {
            "unchanged"
        };
        let pending_name = if let Some(id) = pending.as_str() {
            name(db, "deployment", id, 120).await?
        } else {
            Value::Null
        };
        devices.push(json!({"device_id":id,"device_name":row.get::<Option<String>,_>("name"),"effect":effect,"before":decorate(db,before).await?,"after":decorate(db,after).await?,"pending_assignment_id":pending,"pending_assignment_name":pending_name}));
        identities.push(json!({"id":id,"exists":exists,"revoked":revoked,"member":members.contains(&id),"target":targets.get(&id),"before":before,"after":after,"winner":winner_identity,"other_changed":other_changed}));
    }
    if collateral {
        blockers.push(blocker("UNRELATED_DELIVERY_CHANGE","Current assignment state would also change devices or resources outside this removal. Refresh deployment state and review again before removing this assignment."));
    }
    let token = db::hash(format!(
        "vectory-assignment-removal-v1\n{}",
        json!({"actor":actor,"source":source,"status":status,"priority":deployment["priority"],"resource":resource,"version_id":deployment["version_id"],"policy":deployment["policy"],"devices":identities})
    ));
    Ok(
        json!({"removal_review":true,"source_deployment_id":source,"source_status":status,"resource":resource,"ready":blockers.is_empty(),"review_token":token,"blockers":blockers,"devices":devices}),
    )
}
pub(crate) async fn commit(
    db: &mut SqliteConnection,
    source: &str,
    request: &Value,
    actor: &str,
) -> Result<Value> {
    if request
        .as_object()
        .is_none_or(|v| v.len() != 1 || !v.contains_key("review_token"))
    {
        return Err(ApiError::invalid(
            "Provide only the required assignment-removal review_token",
        ));
    }
    let token = crate::rollback_review::token(request)?
        .ok_or_else(|| ApiError::invalid("Assignment removal requires a review_token"))?;
    let plan = preview(db, source, actor).await?;
    if plan["review_token"].as_str() != Some(token) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ASSIGNMENT_REMOVAL_REVIEW_CHANGED",
            "Assignment membership or removal effects changed. Review the current devices and outcomes again before confirming.",
        ));
    }
    if plan["ready"] != true {
        return Err(ApiError::conflict(
            plan["blockers"][0]["reason"]
                .as_str()
                .unwrap_or("Assignment removal is not available"),
        ));
    }
    rollout::action(db, &uuid(source)?, "unassign", actor).await
}
