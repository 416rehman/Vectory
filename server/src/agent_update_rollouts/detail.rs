//! What the rollout page reads: one rollout with its stages and the failures
//! grouped by code, and its targets, paged.
use super::{STATES, load, view};
use crate::{
    State, agent_updates, auth, db,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row as _;
use std::collections::BTreeMap;

/// Devices one stage lists; the rest are counted.
const STAGE_DEVICES: usize = 60;
/// Queued stages one rollout lists.
const QUEUED_STAGES: usize = 20;
/// Device IDs and names one failure group lists.
const GROUP_IDS: usize = 1000;
const GROUP_NAMES: usize = 8;

/// The sentence for what an agent code, or the server's `NO_REPORT`, means for
/// a device that rolled back, failed or refused.
pub fn message(code: Option<&str>) -> Option<&'static str> {
    Some(match code? {
        "START_FAILED" => "The new agent didn't start, so the previous build was put back.",
        "NO_CHECK_IN" => {
            "The new agent started but didn't check in within 5 minutes, so the previous build was put back."
        }
        "UNHEALTHY" => {
            "The new agent started but didn't pass its health check, so the previous build was put back."
        }
        "INTERRUPTED" => "The update was interrupted. The host kept the build it had.",
        "ROLLBACK_UNHEALTHY" => {
            "The update was rolled back, but the previous build isn't healthy either. Check the host."
        }
        "BINARY_CHANGED" => {
            "The agent file was replaced outside the update, so the update was dropped."
        }
        "PROBE_FAILED" => {
            "The new build didn't report the expected version and platform, so nothing was changed."
        }
        "ARTIFACT_MISMATCH" => "The downloaded build didn't match its signed size and digest.",
        "DISK_FULL" => "The host has no room for the new build.",
        "DOWNLOAD_FAILED" => "The host couldn't download the build.",
        "NO_REPORT" => {
            "The device went quiet while it updated, and Vectory never saw the new build check in."
        }
        "UPDATES_OFF" => "Updates are off on this host.",
        "UPDATES_PAUSED" => "Updates are paused on this host.",
        "KEY_NOT_PINNED" => "The host pins no key that signed this build.",
        "SIGNATURE_INVALID" => "The host couldn't verify the build's signature.",
        "MANIFEST_INVALID" => "The host found the release manifest invalid.",
        "MANIFEST_EXPIRED" => "The release manifest had expired on the host's clock.",
        "KEY_ROLLOVER_CONFLICT" => {
            "The host saw two successors of a key it pins, so it refuses every update until it is pinned again."
        }
        "RELEASE_ALREADY_TRIED" => "The host already tried this build and rolled back.",
        "COUNTER_REPLAYED" => "The host already attempted a release at least as new.",
        "DOWNGRADE_REFUSED" => {
            "The host runs a newer agent, or one whose version can't be compared, and a host never goes back."
        }
        "VERSION_NOT_ON_TRACK" => "The build isn't on the update track the host allowed.",
        "AGENT_TOO_OLD" => "The host's agent is too old to take this build.",
        "ALREADY_RUNNING" => "The host already runs this version.",
        "PLATFORM_NOT_IN_RELEASE" => "The release has no build for this host's platform.",
        "PACKAGE_MANAGED" => "A package manager owns this agent.",
        "NO_SERVICE" => "The agent has no service manager to restart it.",
        "UNTRUSTED_LOCATION" => {
            "The install path or a directory above it isn't owned by root, or others can write to it."
        }
        "READ_ONLY" => "The install directory is on a read-only file system.",
        "HELPER_NOT_RUNNING" => "The privileged update step isn't running on the host.",
        "SERVICE_DEFINITION_OUTDATED" => {
            "The build needs a newer service definition than the host has."
        }
        _ => return None,
    })
}

/// How a stage is doing. `done` is true when every device it released has
/// ended or waits for its host.
fn stage_state(status: &str, latest: bool, done: bool, observing: bool) -> &'static str {
    match status {
        "failed" if latest => "failed",
        "cancelled" if latest => "stopped",
        _ if done && (!latest || status == "completed") => "passed",
        _ if done && latest && status == "active" && observing => "observing",
        _ => "in_progress",
    }
}

/// `GET /api/v1/agent-update-rollouts/{id}`: the rollout, its stages, and its
/// failures grouped by code. Any signed-in role.
pub async fn get(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    agent_updates::require_on(&mut tx).await?;
    let row = load(&mut tx, &id).await?;
    let mut out = view(&mut tx, &row).await?;
    let targets = sqlx::query(
        "SELECT t.device_id,t.device_name,t.stage,t.state,t.code,t.released_at,d.policy,d.policy_generation,json_object('policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds')) AS evidence FROM agent_update_targets t LEFT JOIN devices d ON d.id=t.device_id WHERE t.rollout_id=? ORDER BY t.device_name COLLATE NOCASE,t.device_id",
    )
    .bind(&id)
    .fetch_all(&mut *tx)
    .await?;
    struct Stage {
        released_at: Option<String>,
        counts: BTreeMap<String, i64>,
        devices: Vec<Value>,
        size: i64,
    }
    let mut stages: BTreeMap<i64, Stage> = BTreeMap::new();
    let mut groups: BTreeMap<(String, Option<String>), Vec<(String, String)>> = BTreeMap::new();
    let mut interval: Option<i64> = None;
    let mut pending = 0i64;
    let mut unreleased_cancelled = 0i64;
    for target in &targets {
        let state: String = target.get("state");
        let code: Option<String> = target.get("code");
        let device: String = target.get("device_id");
        let name: String = target.get("device_name");
        if let Some(policy) = target.get::<Option<String>, _>("policy") {
            let policy = db::parse(&policy)?;
            let evidence = db::parse(&target.get::<String, _>("evidence"))?;
            let seconds = rollout::check_in_seconds(
                &policy,
                &evidence,
                target
                    .get::<Option<i64>, _>("policy_generation")
                    .unwrap_or(0),
            );
            interval = Some(interval.map_or(seconds, |longest| longest.max(seconds)));
        }
        let index: Option<i64> = target.get("stage");
        if state == "pending" {
            pending += 1;
        } else if index.is_none() && state == "cancelled" {
            unreleased_cancelled += 1;
        }
        if matches!(state.as_str(), "rolled_back" | "failed" | "refused") {
            groups
                .entry((state.clone(), code.clone()))
                .or_default()
                .push((device.clone(), name.clone()));
        }
        let Some(index) = index else {
            continue;
        };
        let stage = stages.entry(index).or_insert_with(|| Stage {
            released_at: None,
            counts: BTreeMap::new(),
            devices: Vec::new(),
            size: 0,
        });
        stage.size += 1;
        *stage.counts.entry(state.clone()).or_default() += 1;
        let released: Option<String> = target.get("released_at");
        if let Some(released) = released
            && stage
                .released_at
                .as_ref()
                .is_none_or(|first| released < *first)
        {
            stage.released_at = Some(released);
        }
        if stage.devices.len() < STAGE_DEVICES {
            stage
                .devices
                .push(json!({"device_id":device,"device_name":name,"state":state,"code":code}));
        }
    }
    let settings = &row.settings;
    let latest = stages.keys().next_back().copied();
    let mut listed: Vec<Value> = stages
        .iter()
        .map(|(index, stage)| {
            let in_flight: i64 = ["offered", "downloading", "staged", "applying", "restarted"]
                .iter()
                .map(|state| stage.counts.get(*state).copied().unwrap_or(0))
                .sum();
            let state = stage_state(
                &row.status,
                Some(*index) == latest,
                in_flight == 0,
                row.observation_started_at.is_some(),
            );
            json!({
                "kind": if *index == 0 { "canary" } else { "batch" },
                "index": index,
                "state": state,
                "released_at": stage.released_at,
                "size": stage.size,
                "counts": stage.counts,
                "devices": stage.devices,
                "more": (stage.size - stage.devices.len() as i64).max(0),
            })
        })
        .collect();
    // What was not released yet, as the stages it will make: queued while the
    // rollout can still release them, stopped once it ended without.
    let (unreleased, unreleased_state) = match row.status.as_str() {
        "active" | "paused" => (pending, "queued"),
        "cancelled" | "failed" => (unreleased_cancelled, "stopped"),
        _ => (0, "queued"),
    };
    if unreleased > 0 {
        let mut waiting = unreleased;
        let mut index = latest.map_or(0, |last| last + 1);
        let mut queued = 0;
        while waiting > 0 && queued < QUEUED_STAGES {
            let size = waiting.min(if index == 0 {
                settings.canary_size
            } else {
                settings.batch_size
            });
            listed.push(json!({
                "kind": if index == 0 { "canary" } else { "batch" },
                "index": index,
                "state": unreleased_state,
                "released_at": Value::Null,
                "size": size,
                "counts": {"pending": size},
                "devices": [],
                "more": size,
            }));
            waiting -= size;
            index += 1;
            queued += 1;
        }
    }
    let failures: Vec<Value> = {
        let mut groups: Vec<_> = groups.into_iter().collect();
        groups.sort_by(|(a, x), (b, y)| y.len().cmp(&x.len()).then_with(|| a.cmp(b)));
        groups
            .into_iter()
            .map(|((state, code), devices)| {
                json!({
                    "state": state,
                    "code": code,
                    "message": message(code.as_deref()),
                    "count": devices.len(),
                    "device_ids": devices.iter().take(GROUP_IDS).map(|(id, _)| id).collect::<Vec<_>>(),
                    "devices": devices.iter().take(GROUP_NAMES).map(|(id, name)| json!({"device_id":id,"device_name":name})).collect::<Vec<_>>(),
                })
            })
            .collect()
    };
    out["stages"] = json!(listed);
    out["failures"] = json!(failures);
    out["evaluated_at"] = json!(db::now());
    out["check_in_seconds"] = json!(interval);
    Ok(Json(out))
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetsQuery {
    page: Option<u64>,
    page_size: Option<u64>,
    search: Option<String>,
    state: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
}

/// `GET /api/v1/agent-update-rollouts/{id}/targets`: the devices of a rollout,
/// paged and sorted. Any signed-in role.
pub async fn targets(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<TargetsQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    agent_updates::guard(&s).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (search, page, size, offset) =
        crate::deployment_history::bounds(input.search.as_deref(), input.page, input.page_size)?;
    let state = match input.state.as_deref() {
        None | Some("") => None,
        Some(state) if STATES.contains(&state) => Some(state),
        Some(_) => return Err(ApiError::invalid("Invalid target state")),
    };
    let sort = match input.sort.as_deref().unwrap_or("device_name") {
        "device_name" => "t.device_name COLLATE NOCASE",
        "state" => "t.state",
        "updated_at" => "t.updated_at",
        _ => {
            return Err(ApiError::invalid(
                "sort must be device_name, state or updated_at",
            ));
        }
    };
    let direction = match input.direction.as_deref().unwrap_or("asc") {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(ApiError::invalid("direction must be asc or desc")),
    };
    let needle = search.to_ascii_lowercase();
    let mut tx = s.pool.begin().await?;
    agent_updates::require_on(&mut tx).await?;
    load(&mut tx, &id).await?;
    let filter = "FROM agent_update_targets t JOIN agent_update_rollouts r ON r.id=t.rollout_id JOIN agent_releases rel ON rel.id=r.release_id WHERE t.rollout_id=?1 AND (?2='' OR instr(lower(t.device_name),?2)>0) AND (?3 IS NULL OR t.state=?3)";
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) {filter}"))
        .bind(&id)
        .bind(&needle)
        .bind(state)
        .fetch_one(&mut *tx)
        .await?;
    let rows = sqlx::query(&format!(
        "SELECT t.device_id,t.device_name,t.stage,t.state,t.code,t.from_version,rel.version AS to_version,t.released_at,t.updated_at,t.verified_at {filter} ORDER BY {sort} {direction},t.device_id LIMIT ?4 OFFSET ?5"
    ))
    .bind(&id)
    .bind(&needle)
    .bind(state)
    .bind(size)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "device_id": row.get::<String, _>("device_id"),
                "device_name": row.get::<String, _>("device_name"),
                "stage": row.get::<Option<i64>, _>("stage"),
                "state": row.get::<String, _>("state"),
                "code": row.get::<Option<String>, _>("code"),
                "from_version": row.get::<Option<String>, _>("from_version"),
                "to_version": row.get::<String, _>("to_version"),
                "released_at": row.get::<Option<String>, _>("released_at"),
                "updated_at": row.get::<String, _>("updated_at"),
                "verified_at": row.get::<Option<String>, _>("verified_at"),
            })
        })
        .collect();
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}
