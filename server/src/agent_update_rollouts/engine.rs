//! What moves an update rollout: the reports of the devices, and the scheduler
//! step that releases stages, watches them and ends the rollout.
//!
//! A device is counted as updated only from the server's own observation: a
//! check-in after the restart that carries the new build's SHA-256 and
//! version, a new process identity (`boot_id`) and the privileged step's
//! report that the build passed its health check. A download, a staged file or
//! a swap is never reported as an update.
//!
//! Transitions only move forward and are keyed to the rollout's release: a
//! report for another release changes nothing, and a report that would move a
//! target to an earlier row of the state table never does.
use crate::{
    State,
    agent_releases::{self, Release},
    agent_updates::{self, Build, Facts, Report, Statements, instant, review::refusal},
    canary_choice::{self, Ranked},
    db,
    error::Result,
};
use chrono::{DateTime, Duration, Utc};
use serde_json::json;
use sqlx::{Row as _, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

/// A device that was offered a release and reported nothing for this long is
/// skipped.
const OFFER_SILENCE_MINUTES: i64 = 60;
/// A device silent this long after it started applying, or restarted, failed.
const APPLY_SILENCE_MINUTES: i64 = 30;
/// The code a server gives a target that fell silent; never an agent.
pub const NO_REPORT: &str = "NO_REPORT";
const MAX_AUDITED_DEVICES: usize = 100;
/// A stage that finds nothing to release is looked for again this often, not at
/// every tick: reading every pending device is the costly part.
const RETRY_SECONDS: i64 = 10;
/// Rollouts whose last attempt to release a stage found nothing, with the clock
/// it was made at.
static EMPTY: std::sync::Mutex<BTreeMap<String, DateTime<Utc>>> =
    std::sync::Mutex::new(BTreeMap::new());
fn throttled(rollout: &str, now: DateTime<Utc>) -> bool {
    EMPTY
        .lock()
        .ok()
        .and_then(|empty| empty.get(rollout).copied())
        .is_some_and(|at| now >= at && (now - at).num_seconds() < RETRY_SECONDS)
}
fn note_empty(rollout: &str, now: DateTime<Utc>) {
    if let Ok(mut empty) = EMPTY.lock() {
        if empty.len() > 1000 {
            empty.clear();
        }
        empty.insert(rollout.to_owned(), now);
    }
}
fn note_released(rollout: &str) {
    if let Ok(mut empty) = EMPTY.lock() {
        empty.remove(rollout);
    }
}

/// A rollout with more verified devices than this is advanced no more often
/// than every `LOOK_SECONDS`: reading every verified device (their check-ins and
/// the issues opened on them) is the costly part of a step, which runs under the
/// writer lock, and a rollout that large reacts in seconds, not in ticks.
const LARGE_ROLLOUT: i64 = 500;
const LOOK_SECONDS: i64 = 10;
/// Large rollouts, with the clock of the last time they were advanced.
static LOOKED: std::sync::Mutex<BTreeMap<String, DateTime<Utc>>> =
    std::sync::Mutex::new(BTreeMap::new());
/// Whether a large rollout was advanced a moment ago; when it was not, now is
/// remembered as the time it was.
fn looked_recently(rollout: &str, now: DateTime<Utc>) -> bool {
    let Ok(mut looked) = LOOKED.lock() else {
        return false;
    };
    if looked
        .get(rollout)
        .is_some_and(|at| now >= *at && (now - *at).num_seconds() < LOOK_SECONDS)
    {
        return true;
    }
    if looked.len() > 1000 {
        looked.clear();
    }
    looked.insert(rollout.to_owned(), now);
    false
}

pub fn terminal(state: &str) -> bool {
    matches!(
        state,
        "verified" | "rolled_back" | "refused" | "failed" | "cancelled" | "skipped"
    )
}
/// How far along the state table a state is. A report moves a target only to
/// a higher rank.
fn rank(state: &str) -> u8 {
    match state {
        "pending" => 0,
        "offered" => 1,
        "downloading" => 2,
        "staged" => 3,
        "waiting_for_host" | "waiting_for_window" => 4,
        "applying" => 5,
        "restarted" => 6,
        _ => 7,
    }
}

// ---------------------------------------------------------------------------
// Targets

/// The target a device has that has not ended, with what a transition needs to
/// know about its rollout and release.
pub struct OpenTarget {
    pub rollout_id: String,
    pub device_id: String,
    pub device_name: String,
    pub state: String,
    pub from_version: Option<String>,
    pub boot_id_before: Option<String>,
    pub release_id: String,
    pub release_version: String,
    pub manifest_sha256: String,
    pub artifact_sha256: Option<String>,
    /// The device's identity was revoked: it never checks in again.
    pub revoked: bool,
}
const OPEN_TARGET: &str = "SELECT t.rollout_id,t.device_id,t.device_name,t.state,t.from_version,t.boot_id_before,ro.release_id,rel.version AS release_version,rel.manifest_sha256,d.revoked AS revoked,\
    (SELECT a.sha256 FROM agent_release_artifacts a WHERE a.release_id=rel.id AND a.os=json_extract(d.data,'$.os') AND a.arch=json_extract(d.data,'$.arch')) AS artifact_sha256 \
    FROM agent_update_targets t JOIN agent_update_rollouts ro ON ro.id=t.rollout_id JOIN agent_releases rel ON rel.id=ro.release_id JOIN devices d ON d.id=t.device_id";
fn open_target(row: &sqlx::sqlite::SqliteRow) -> OpenTarget {
    OpenTarget {
        rollout_id: row.get("rollout_id"),
        device_id: row.get("device_id"),
        device_name: row.get("device_name"),
        state: row.get("state"),
        from_version: row.get("from_version"),
        boot_id_before: row.get("boot_id_before"),
        release_id: row.get("release_id"),
        release_version: row.get("release_version"),
        manifest_sha256: row.get("manifest_sha256"),
        artifact_sha256: row.get("artifact_sha256"),
        revoked: row.get("revoked"),
    }
}

/// Moves a target to `state` (never backwards: the update names the state it
/// expects the target to be in) and does what the new state asks: the device's
/// audit row, and the issue a rollback or a failure opens.
async fn move_target(
    conn: &mut SqliteConnection,
    s: &State,
    now: &str,
    actor: &str,
    target: &OpenTarget,
    state: &str,
    code: Option<&str>,
) -> Result<()> {
    let moved = sqlx::query("UPDATE agent_update_targets SET state=?,code=?,updated_at=?,verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END WHERE rollout_id=? AND device_id=? AND state=?")
        .bind(state)
        .bind(code)
        .bind(now)
        .bind(state)
        .bind(now)
        .bind(&target.rollout_id)
        .bind(&target.device_id)
        .bind(&target.state)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    if moved == 0 || !matches!(state, "verified" | "rolled_back" | "failed" | "refused") {
        return Ok(());
    }
    if crate::device::audit_row_allowed(s, &target.device_id, "device.agent_update", None) {
        let mut details = json!({
            "rollout_id": target.rollout_id,
            "release_id": target.release_id,
            "version": target.release_version,
            "manifest_sha256": target.manifest_sha256,
            "to_version": target.release_version,
            "state": state,
        });
        if let Some(from) = &target.from_version {
            details["from_version"] = json!(from);
        }
        if let Some(code) = code {
            details["code"] = json!(code);
        }
        let actor = if actor.is_empty() {
            target.device_id.as_str()
        } else {
            actor
        };
        agent_updates::audit(
            conn,
            actor,
            "device.agent_update",
            &target.device_id,
            state,
            details,
        )
        .await?;
    }
    match state {
        "rolled_back" | "failed" => {
            crate::issues::record_agent_update(
                conn,
                crate::issues::AgentUpdateFailure {
                    device_id: &target.device_id,
                    release_version: &target.release_version,
                    outcome: state,
                    code: code.unwrap_or(NO_REPORT),
                    rollout_id: &target.rollout_id,
                },
            )
            .await?
        }
        "verified" => crate::issues::resolve_agent_update(conn, &target.device_id).await?,
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The heartbeat

/// What the target does with a check-in, from the device's report and what the
/// check-in shows about the build that sent it: the state it moves to, and the
/// agent's code for a refusal, a failure or a rollback.
fn decide(
    target: &OpenTarget,
    report: Option<&Report>,
    restarted: bool,
) -> Option<(&'static str, Option<String>)> {
    // Only a release moves a pending target: a report about the offer of a
    // rollout that was paused (the agent reports a check-in behind) is not
    // progress of this one.
    if target.state == "pending" {
        return None;
    }
    let current = rank(&target.state);
    if let Some(last) = report
        .and_then(Report::last)
        .filter(|last| last["release"] == target.manifest_sha256.as_str())
    {
        let code = last["code"].as_str().map(str::to_owned);
        match last["outcome"].as_str() {
            Some("committed") if restarted => return Some(("verified", None)),
            Some("rolled_back") => return Some(("rolled_back", code)),
            Some("failed") => return Some(("failed", code)),
            Some("refused") => return Some(("refused", code)),
            _ => {}
        }
    }
    if restarted && current < rank("restarted") {
        return Some(("restarted", None));
    }
    let report = report?;
    if report.release() != Some(target.manifest_sha256.as_str()) {
        return None;
    }
    let code = report.code().map(str::to_owned);
    let state = match report.state() {
        "downloading" => "downloading",
        "staged" => "staged",
        "waiting_for_host" => "waiting_for_host",
        "waiting_for_window" => "waiting_for_window",
        "applying" | "trial" => "applying",
        "refused" => "refused",
        "failed" => "failed",
        _ => return None,
    };
    let code = matches!(state, "refused" | "failed")
        .then_some(code)
        .flatten();
    (rank(state) > current).then_some((state, code))
}

/// A check-in of a device that has a target that has not ended: remember what
/// the previous build reported, and move the target as far as the check-in
/// proves.
pub async fn observe(
    conn: &mut SqliteConnection,
    s: &State,
    now: &str,
    build: &Build<'_>,
    report: Option<&Report>,
) -> Result<()> {
    let sql = format!(
        "{OPEN_TARGET} WHERE t.device_id=? AND t.state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window','applying','restarted')"
    );
    let Some(row) = sqlx::query(&sql)
        .bind(build.device_id)
        .fetch_optional(&mut *conn)
        .await?
    else {
        return Ok(());
    };
    let target = open_target(&row);
    // The new build: the offered file's digest and version, from a process
    // other than the one the previous build last reported.
    let new_build = target.artifact_sha256.is_some()
        && build.agent_sha256 == target.artifact_sha256.as_deref()
        && build.agent_version == target.release_version;
    if !new_build && rank(&target.state) < rank("restarted") {
        // The build that is still running: the process it runs in is what the
        // new build is told apart from, and the version it ran when the target
        // was released is what the rollout says it updated from.
        let released = target.state != "pending";
        sqlx::query("UPDATE agent_update_targets SET boot_id_before=?1,from_version=CASE WHEN ?2 THEN COALESCE(from_version,?3) ELSE from_version END,from_sha256=CASE WHEN ?2 THEN COALESCE(from_sha256,?4) ELSE from_sha256 END WHERE rollout_id=?5 AND device_id=?6 AND (boot_id_before IS NOT ?1 OR (?2 AND (from_version IS NULL OR from_sha256 IS NULL)))")
            .bind(build.boot_id)
            .bind(released)
            .bind(build.agent_version)
            .bind(build.agent_sha256)
            .bind(&target.rollout_id)
            .bind(&target.device_id)
            .execute(&mut *conn)
            .await?;
    }
    let restarted = new_build
        && target
            .boot_id_before
            .as_deref()
            .is_some_and(|before| before != build.boot_id);
    if let Some((state, code)) = decide(&target, report, restarted) {
        move_target(conn, s, now, "", &target, state, code.as_deref()).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The scheduler step

/// A step of the scheduler tick, inside its transaction: ends what fell silent,
/// then advances every active rollout. A failure here never stops the pipeline
/// rollouts the tick also serves: its changes are rolled back and logged.
pub async fn tick(s: &State, tx: &mut SqliteConnection) {
    let Ok(mut savepoint) = sqlx::Acquire::begin(&mut *tx).await else {
        return;
    };
    match step(&mut savepoint, s, Utc::now()).await {
        Ok(()) => {
            if let Err(error) = savepoint.commit().await {
                tracing::error!(%error, "agent update step could not be saved");
            }
        }
        Err(error) => {
            tracing::error!(
                code = error.code,
                "agent update step failed; its changes were rolled back"
            );
            let _ = savepoint.rollback().await;
        }
    }
}

pub async fn step(conn: &mut SqliteConnection, s: &State, now: DateTime<Utc>) -> Result<()> {
    // Nothing is released, withdrawn or ended while updates are off: turning
    // them off needs every rollout ended first.
    if !agent_updates::enabled(conn).await? {
        return Ok(());
    }
    sweep(conn, s, now).await?;
    let active: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM agent_update_rollouts WHERE status='active' ORDER BY created_at,id",
    )
    .fetch_all(&mut *conn)
    .await?;
    for id in active {
        let rollout = super::load(conn, &id).await?;
        advance(conn, s, now, &rollout).await?;
    }
    Ok(())
}

/// Ends the targets that fell silent: an offer nobody reported on for an hour
/// is skipped, and a device silent for half an hour after it started applying
/// (or restarted) failed with `NO_REPORT`, unless its identity was revoked: its
/// silence then says nothing of the build, and it opens no issue that nothing
/// could ever resolve.
///
/// Only the targets that wait for a report are read, through their partial
/// index (the first term of the `WHERE` is the index's own, which is what lets
/// SQLite use it): the cost follows what is in flight, never the history of
/// every rollout there has been.
async fn sweep(conn: &mut SqliteConnection, s: &State, now: DateTime<Utc>) -> Result<()> {
    let at = instant(now);
    let offered_before = instant(now - Duration::minutes(OFFER_SILENCE_MINUTES));
    let applying_before = instant(now - Duration::minutes(APPLY_SILENCE_MINUTES));
    let mut rows = sqlx::query(&format!(
        "{OPEN_TARGET} WHERE t.state IN ('offered','downloading','staged','applying','restarted') AND ((t.state='offered' AND COALESCE(t.released_at,t.updated_at)<=?) OR (t.state IN ('applying','restarted') AND t.updated_at<=?))"
    ))
    .bind(&offered_before)
    .bind(&applying_before)
    .fetch_all(&mut *conn)
    .await?;
    rows.sort_by(|a, b| {
        (
            a.get::<String, _>("rollout_id"),
            a.get::<String, _>("device_id"),
        )
            .cmp(&(
                b.get::<String, _>("rollout_id"),
                b.get::<String, _>("device_id"),
            ))
    });
    for row in rows {
        let target = open_target(&row);
        let started = matches!(target.state.as_str(), "applying" | "restarted");
        let (state, code) = if started && !target.revoked {
            ("failed", Some(NO_REPORT))
        } else {
            ("skipped", None)
        };
        move_target(conn, s, &at, "scheduler", &target, state, code).await?;
    }
    Ok(())
}

/// Counts of a rollout's targets by state.
pub async fn counts(conn: &mut SqliteConnection, rollout: &str) -> Result<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT state,count(*) FROM agent_update_targets WHERE rollout_id=? GROUP BY state",
    )
    .bind(rollout)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().collect())
}

/// The open data-plane issues (identity and occurrence count) of these devices.
async fn open_delivery_issues(
    conn: &mut SqliteConnection,
    devices: &[&str],
) -> Result<BTreeMap<String, BTreeMap<String, i64>>> {
    let mut out: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    if devices.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT json_extract(data,'$.device_id'),id,COALESCE(json_extract(data,'$.count'),0) FROM records WHERE kind='issue' AND json_extract(data,'$.device_id') IN (SELECT value FROM json_each(?)) AND COALESCE(json_type(data,'$.resolved')='true',0)=0 AND COALESCE(json_extract(data,'$.code'),'') GLOB 'DATA_PLANE_*'",
    )
    .bind(json!(devices).to_string())
    .fetch_all(&mut *conn)
    .await?;
    for (device, id, count) in rows {
        out.entry(device).or_default().insert(id, count);
    }
    Ok(out)
}

/// Verified devices of a rollout on which a data-plane issue opened after the
/// device was released: a build that starts and checks in but stops Vector
/// delivering. An issue that was already open then, or an occurrence of it
/// already counted, is not the build's.
///
/// It reads the open data-plane issues, through the index of an issue's state,
/// and looks each one's device up among the rollout's verified targets: the
/// cost follows the problems there are, not the devices that updated.
pub async fn degraded(conn: &mut SqliteConnection, rollout: &str) -> Result<i64> {
    let open: Vec<(String, String, i64, String)> = sqlx::query_as(
        "SELECT t.device_id,i.id,COALESCE(json_extract(i.data,'$.count'),0),t.baseline_issues FROM records i JOIN agent_update_targets t ON t.device_id=json_extract(i.data,'$.device_id') WHERE i.kind='issue' AND (CASE WHEN json_type(i.data,'$.resolved')='true' THEN 'resolved' WHEN json_type(i.data,'$.acknowledged')='true' THEN 'acknowledged' ELSE 'open' END) IN ('open','acknowledged') AND COALESCE(json_extract(i.data,'$.code'),'') GLOB 'DATA_PLANE_*' AND t.rollout_id=? AND t.state='verified'",
    )
    .bind(rollout)
    .fetch_all(&mut *conn)
    .await?;
    let mut degraded: BTreeSet<&str> = BTreeSet::new();
    for (device, issue, count, baseline) in &open {
        let baseline: BTreeMap<String, i64> = serde_json::from_str(baseline).unwrap_or_default();
        if baseline.get(issue).is_none_or(|before| count > before) {
            degraded.insert(device);
        }
    }
    Ok(i64::try_from(degraded.len()).unwrap_or(i64::MAX))
}

/// Whether the device can be released a build now: nothing in the review
/// refuses it, it checked in within three of its intervals and it is not paused
/// on the host.
fn releasable(f: &Facts, release: &Release, statements: &Statements) -> bool {
    refusal(f, release, statements).is_none() && f.online() && !f.paused()
}

async fn advance(
    conn: &mut SqliteConnection,
    s: &State,
    now: DateTime<Utc>,
    rollout: &super::Row,
) -> Result<()> {
    let at = instant(now);
    let release = agent_releases::load(conn, &rollout.release_id).await?;
    if !release.offerable(&at) {
        return Ok(());
    }
    let counts = counts(conn, &rollout.id).await?;
    let n = |state: &str| counts.get(state).copied().unwrap_or(0);
    let settings = &rollout.settings;
    if n("verified") > LARGE_ROLLOUT && looked_recently(&rollout.id, now) {
        return Ok(());
    }
    let hard = n("rolled_back") + n("failed");
    let degraded = if n("verified") > 0 {
        degraded(conn, &rollout.id).await?
    } else {
        0
    };
    if hard + degraded > settings.failure_threshold {
        let reason = if hard > settings.failure_threshold {
            "threshold"
        } else {
            "data_plane"
        };
        return fail(conn, rollout, reason, &at).await;
    }
    let in_flight = n("offered") + n("downloading") + n("staged") + n("applying") + n("restarted");
    let waiting = n("waiting_for_host") + n("waiting_for_window");
    let pending = n("pending");
    let latest: Option<i64> =
        sqlx::query_scalar("SELECT max(stage) FROM agent_update_targets WHERE rollout_id=?")
            .bind(&rollout.id)
            .fetch_one(&mut *conn)
            .await?;
    let Some(latest) = latest else {
        if pending == 0 && in_flight == 0 && waiting == 0 {
            // Every device ended before anything was released.
            return fail(conn, rollout, "threshold", &at).await;
        }
        return release_canary(conn, s, now, rollout, &release).await;
    };
    if in_flight > 0 {
        return clear_observation(conn, rollout).await;
    }
    if latest == 0 {
        let proven: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent_update_targets WHERE rollout_id=? AND stage=0 AND state='verified'",
        )
        .bind(&rollout.id)
        .fetch_one(&mut *conn)
        .await?;
        if proven == 0 {
            if waiting > 0 {
                // A canary that waits for a person has not proved anything yet.
                return clear_observation(conn, rollout).await;
            }
            // Nothing of the canary updated, and nothing is left that could.
            return fail(conn, rollout, "threshold", &at).await;
        }
    }
    // The observation: every verified device keeps checking in on the new build.
    let Some(evidence) = watched(conn, rollout, &release).await? else {
        return clear_observation(conn, rollout).await;
    };
    let started = rollout
        .observation_started_at
        .as_deref()
        .and_then(|started| DateTime::parse_from_rfc3339(started).ok());
    if started.is_none() || rollout.observation_evidence.as_deref() != Some(evidence.as_str()) {
        sqlx::query("UPDATE agent_update_rollouts SET observation_started_at=?,observation_evidence=? WHERE id=?")
            .bind(&at)
            .bind(&evidence)
            .bind(&rollout.id)
            .execute(&mut *conn)
            .await?;
        return Ok(());
    }
    let waited = now.signed_duration_since(started.unwrap_or_default());
    if waited.num_seconds() < settings.observation_seconds {
        return Ok(());
    }
    if pending > 0 {
        match release_batch(conn, s, now, rollout, &release, latest + 1).await? {
            // Looked for a moment ago, or released a stage: nothing to end yet.
            None | Some(1..) => return Ok(()),
            Some(0) if waiting > 0 => return Ok(()),
            Some(0) => {}
        }
        // Nothing left to release and nobody to wait for: what never became
        // releasable is skipped, and the rollout ends.
        sqlx::query("UPDATE agent_update_targets SET state='skipped',updated_at=? WHERE rollout_id=? AND state='pending'")
            .bind(&at)
            .bind(&rollout.id)
            .execute(&mut *conn)
            .await?;
    } else if waiting > 0 {
        return Ok(());
    }
    complete(conn, rollout, &at).await
}

/// The verified devices, as a fingerprint, when every one of them checked in
/// within three of its intervals and runs the offered build; `None` when one
/// went silent or fell back (which restarts the observation).
async fn watched(
    conn: &mut SqliteConnection,
    rollout: &super::Row,
    release: &Release,
) -> Result<Option<String>> {
    let verified: BTreeSet<String> = sqlx::query_scalar(
        "SELECT device_id FROM agent_update_targets WHERE rollout_id=? AND state='verified'",
    )
    .bind(&rollout.id)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let devices = agent_updates::review::facts(conn, &verified, &rollout.id).await?;
    for device in &devices {
        let on_the_build = release
            .artifact_for(&device.os, &device.arch)
            .is_some_and(|artifact| device.agent_sha256.as_deref() == Some(&artifact.sha256));
        if device.revoked || !device.online() || !on_the_build {
            return Ok(None);
        }
    }
    Ok(Some(db::hash(
        verified.iter().cloned().collect::<Vec<_>>().join(","),
    )))
}

async fn clear_observation(conn: &mut SqliteConnection, rollout: &super::Row) -> Result<()> {
    if rollout.observation_started_at.is_some() || rollout.observation_evidence.is_some() {
        sqlx::query("UPDATE agent_update_rollouts SET observation_started_at=NULL,observation_evidence=NULL WHERE id=?")
            .bind(&rollout.id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The devices that held an offer when a rollout was withdrawn from them.
pub async fn offered_devices(conn: &mut SqliteConnection, rollout: &str) -> Result<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT device_id FROM agent_update_targets WHERE rollout_id=? AND state IN ('offered','downloading','staged','waiting_for_host','waiting_for_window')",
    )
    .bind(rollout)
    .fetch_all(&mut *conn)
    .await?)
}

async fn fail(
    conn: &mut SqliteConnection,
    rollout: &super::Row,
    reason: &str,
    at: &str,
) -> Result<()> {
    let withdrawn = offered_devices(conn, &rollout.id).await?;
    sqlx::query("UPDATE agent_update_targets SET state='cancelled',updated_at=? WHERE rollout_id=? AND state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window')")
        .bind(at)
        .bind(&rollout.id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE agent_update_rollouts SET status='failed',failure_reason=?,failed_at=?,observation_started_at=NULL,observation_evidence=NULL,revision=revision+1 WHERE id=?")
        .bind(reason)
        .bind(at)
        .bind(&rollout.id)
        .execute(&mut *conn)
        .await?;
    let verified = counts(conn, &rollout.id).await?;
    agent_updates::audit(
        conn,
        "scheduler",
        "agent_update_rollout.gate",
        &rollout.id,
        "failed",
        json!({"gate_state":"failed","reason":reason,"verified_count":verified.get("verified").copied().unwrap_or(0)}),
    )
    .await?;
    for device in &withdrawn {
        crate::wake::ask(device);
    }
    Ok(())
}

async fn complete(conn: &mut SqliteConnection, rollout: &super::Row, at: &str) -> Result<()> {
    sqlx::query("UPDATE agent_update_rollouts SET status='completed',completed_at=?,observation_started_at=NULL,observation_evidence=NULL,revision=revision+1 WHERE id=?")
        .bind(at)
        .bind(&rollout.id)
        .execute(&mut *conn)
        .await?;
    let verified = counts(conn, &rollout.id).await?;
    agent_updates::audit(
        conn,
        "scheduler",
        "agent_update_rollout.gate",
        &rollout.id,
        "completed",
        json!({"gate_state":"completed","verified_count":verified.get("verified").copied().unwrap_or(0)}),
    )
    .await
}

// ---------------------------------------------------------------------------
// Releasing stages

/// The pending devices of a rollout that can be released now, with the facts
/// that were read, and the named canary devices that cannot be released only
/// because they are offline or paused (the canary waits for them).
struct Candidates {
    ready: Vec<Facts>,
    holding: bool,
}
async fn candidates(
    conn: &mut SqliteConnection,
    rollout: &super::Row,
    release: &Release,
) -> Result<Candidates> {
    let pending: BTreeSet<String> = sqlx::query_scalar(
        "SELECT device_id FROM agent_update_targets WHERE rollout_id=? AND state='pending' ORDER BY device_id",
    )
    .bind(&rollout.id)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let facts = agent_updates::review::facts(conn, &pending, &rollout.id).await?;
    let statements = Statements::load(conn).await?;
    let named: BTreeSet<&String> = rollout.settings.canary_device_ids.iter().collect();
    let mut ready = Vec::new();
    let mut holding = false;
    for device in facts {
        if releasable(&device, release, &statements) {
            ready.push(device);
        } else if named.contains(&device.id) && refusal(&device, release, &statements).is_none() {
            holding = true;
        }
    }
    ready.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Candidates { ready, holding })
}

/// The devices best placed to be the canary, best first: those that update on
/// their own with their window open or without one, then by the readiness the
/// pipeline canary uses.
pub async fn canary_order(conn: &mut SqliteConnection, devices: &[&Facts]) -> Result<Vec<Ranked>> {
    let ids: BTreeSet<String> = devices.iter().map(|device| device.id.clone()).collect();
    let preferred: BTreeSet<&str> = devices
        .iter()
        .filter(|device| device.consent() == Some("auto") && device.window_open())
        .map(|device| device.id.as_str())
        .collect();
    let mut ranked = canary_choice::rank(conn, &ids).await?;
    ranked.sort_by_key(|device| !preferred.contains(device.id.as_str()));
    Ok(ranked)
}

async fn release_canary(
    conn: &mut SqliteConnection,
    s: &State,
    now: DateTime<Utc>,
    rollout: &super::Row,
    release: &Release,
) -> Result<()> {
    if throttled(&rollout.id, now) {
        return Ok(());
    }
    let candidates = candidates(conn, rollout, release).await?;
    if candidates.holding || candidates.ready.is_empty() {
        note_empty(&rollout.id, now);
        return Ok(());
    }
    let ready: Vec<&Facts> = candidates.ready.iter().collect();
    let ranked = canary_order(conn, &ready).await?;
    let picked = canary_choice::pick(
        &rollout.settings.canary_device_ids,
        &ranked,
        usize::try_from(rollout.settings.canary_size).unwrap_or(1),
    );
    let chosen: Vec<&Facts> = picked
        .iter()
        .filter_map(|id| candidates.ready.iter().find(|device| device.id == *id))
        .collect();
    note_released(&rollout.id);
    release_stage(conn, s, &instant(now), rollout, 0, &chosen).await
}

/// The next batch: the pending devices that can be released now, in device ID
/// order. Returns how many were released, or `None` when it did not look: it
/// looked a moment ago and found nothing.
async fn release_batch(
    conn: &mut SqliteConnection,
    s: &State,
    now: DateTime<Utc>,
    rollout: &super::Row,
    release: &Release,
    index: i64,
) -> Result<Option<usize>> {
    if throttled(&rollout.id, now) {
        return Ok(None);
    }
    let candidates = candidates(conn, rollout, release).await?;
    let take = usize::try_from(rollout.settings.batch_size).unwrap_or(1);
    let chosen: Vec<&Facts> = candidates.ready.iter().take(take).collect();
    let released = chosen.len();
    if released > 0 {
        note_released(&rollout.id);
        release_stage(conn, s, &instant(now), rollout, index, &chosen).await?;
    } else {
        note_empty(&rollout.id, now);
    }
    Ok(Some(released))
}

async fn release_stage(
    conn: &mut SqliteConnection,
    _s: &State,
    at: &str,
    rollout: &super::Row,
    index: i64,
    devices: &[&Facts],
) -> Result<()> {
    if devices.is_empty() {
        return Ok(());
    }
    let ids: Vec<&str> = devices.iter().map(|device| device.id.as_str()).collect();
    let baselines = open_delivery_issues(conn, &ids).await?;
    for device in devices {
        let baseline = baselines.get(&device.id).cloned().unwrap_or_default();
        sqlx::query("UPDATE agent_update_targets SET state='offered',stage=?,code=NULL,released_at=?,updated_at=?,from_version=?,from_sha256=?,baseline_issues=? WHERE rollout_id=? AND device_id=? AND state='pending'")
            .bind(index)
            .bind(at)
            .bind(at)
            .bind(device.agent_version.as_deref())
            .bind(device.agent_sha256.as_deref())
            .bind(json!(baseline).to_string())
            .bind(&rollout.id)
            .bind(&device.id)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("UPDATE agent_update_rollouts SET observation_started_at=NULL,observation_evidence=NULL WHERE id=?")
        .bind(&rollout.id)
        .execute(&mut *conn)
        .await?;
    let audited: Vec<&&str> = ids.iter().take(MAX_AUDITED_DEVICES).collect();
    agent_updates::audit(
        conn,
        "scheduler",
        "agent_update_rollout.release",
        &rollout.id,
        "success",
        json!({"stage":index.to_string(),"device_ids":audited,"released_count":ids.len()}),
    )
    .await?;
    // The offer arrives in the signed manifest of the check-in that follows.
    for device in ids {
        crate::wake::ask(device);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Ending a rollout

/// What cancelling reached.
#[derive(Default)]
pub struct Cancelled {
    pub rollouts: Vec<String>,
    pub devices: Vec<String>,
}

/// Ends one active or paused rollout: its unstarted offers are withdrawn (those
/// targets become `cancelled`) and devices already applying finish their
/// trial. Returns the devices that held an offer.
pub async fn cancel_rollout(
    conn: &mut SqliteConnection,
    id: &str,
    reason: &str,
    now: &str,
) -> Result<Vec<String>> {
    let held = offered_devices(conn, id).await?;
    sqlx::query("UPDATE agent_update_targets SET state='cancelled',updated_at=? WHERE rollout_id=? AND state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window')")
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE agent_update_rollouts SET status='cancelled',cancel_reason=?,cancelled_at=?,observation_started_at=NULL,observation_evidence=NULL,revision=revision+1 WHERE id=? AND status IN ('active','paused')")
        .bind(reason)
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(held)
}

/// Cancels every active or paused update rollout.
pub async fn cancel_all(conn: &mut SqliteConnection, reason: &str, now: &str) -> Result<Cancelled> {
    cancel_where(conn, reason, now, "1=1", None).await
}
/// Cancels the active or paused rollouts of a release.
pub async fn cancel_release(
    conn: &mut SqliteConnection,
    release: &str,
    reason: &str,
    now: &str,
) -> Result<Cancelled> {
    cancel_where(conn, reason, now, "release_id=?", Some(release)).await
}
async fn cancel_where(
    conn: &mut SqliteConnection,
    reason: &str,
    now: &str,
    condition: &str,
    bind: Option<&str>,
) -> Result<Cancelled> {
    let sql = format!(
        "SELECT id FROM agent_update_rollouts WHERE status IN ('active','paused') AND {condition} ORDER BY created_at,id"
    );
    let mut query = sqlx::query_scalar::<_, String>(&sql);
    if let Some(bind) = bind {
        query = query.bind(bind);
    }
    let ids = query.fetch_all(&mut *conn).await?;
    let mut devices = BTreeSet::new();
    for id in &ids {
        devices.extend(cancel_rollout(conn, id, reason, now).await?);
    }
    Ok(Cancelled {
        rollouts: ids,
        devices: devices.into_iter().collect(),
    })
}

/// Pauses a rollout: it stops releasing, and every offer that has not started
/// applying is withdrawn (those targets return to `pending`).
pub async fn pause_rollout(
    conn: &mut SqliteConnection,
    id: &str,
    now: &str,
) -> Result<Vec<String>> {
    let held = offered_devices(conn, id).await?;
    sqlx::query("UPDATE agent_update_targets SET state='pending',stage=NULL,code=NULL,released_at=NULL,updated_at=? WHERE rollout_id=? AND state IN ('offered','downloading','staged','waiting_for_host','waiting_for_window')")
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE agent_update_rollouts SET status='paused',paused_at=?,observation_started_at=NULL,observation_evidence=NULL,revision=revision+1 WHERE id=? AND status='active'")
        .bind(now)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    Ok(held)
}

/// A device's identity was revoked: it never checks in again, so the target it
/// has that has not ended is skipped, whatever it was waiting for. Its silence
/// says nothing of the build: nothing counts against the failure threshold, and
/// no issue opens that nothing could ever resolve. It runs with the revocation,
/// in its transaction.
pub async fn device_revoked(conn: &mut SqliteConnection, device: &str) -> Result<()> {
    sqlx::query("UPDATE agent_update_targets SET state='skipped',updated_at=? WHERE device_id=? AND state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window','applying','restarted')")
        .bind(instant(Utc::now()))
        .bind(device)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
