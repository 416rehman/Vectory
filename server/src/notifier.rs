//! The notifier: turns outbox events into deliveries and sends them.
//!
//! One background task ticks every two seconds. Each tick reads without the
//! writer lock, then writes in short transactions, and never holds the lock
//! across network I/O: sends run in their own tasks, one per channel at a
//! time and at most `SEND_SLOTS` at once, so a slow receiver delays only its
//! own channel. Everything takes `now` as an argument, so tests drive the
//! clock.
//!
//! - Rollout facts come from the audit trail (`deployment.gate`,
//!   `deployment.activate`, `deployment.rollback`), read from a cursor.
//! - Issue facts come from hooks in `issues` (see `notifications`).
//! - Offline and back-online facts come from a scan of check-in times, one
//!   outage per device: announced once when it passes a channel's threshold,
//!   and "back online" once after two check-ins, so a flapping device sends
//!   nothing new. After the server starts, silence counts from the end of a
//!   recovery window (`RECOVERY_WINDOW_SECONDS`), so a fleet that could not
//!   reach the server is not reported offline the moment it returns.
//! - At most `RATE_LIMIT` messages go to a channel in any minute; the rest
//!   are summarised in one digest. Quiet hours hold messages and send one
//!   digest when they end. A failed send retries after 1, 5 and 30 minutes,
//!   then gives up.
use crate::{
    State, db,
    error::Result,
    notifications::{self, Channel, Kind, Secrets},
    outbound::{self, Outcome},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeSet, HashMap, HashSet};

pub const TICK_SECONDS: u64 = 2;
/// Messages per channel in any 60-second window, retries and tests included.
pub const RATE_LIMIT: usize = 30;
/// Messages one channel sends per tick, so a burst reaches a receiver in
/// small groups rather than all at once.
pub const BURST: usize = 5;
/// Pending messages per channel before new ones go straight into a digest.
pub const MAX_QUEUE: i64 = 500;
/// Retry delays after the first, second and third failed attempt.
pub const BACKOFF_SECONDS: [i64; 3] = [60, 300, 1800];
pub const MAX_ATTEMPTS: i64 = 4;
/// The delivery log and finished deliveries are kept this long.
pub const RETENTION_DAYS: i64 = 30;
/// How often device check-ins are scanned for outages.
pub const SCAN_SECONDS: i64 = 60;
/// After the server starts, devices have this long to reconnect before any of
/// them can be reported offline. An agent that could not reach the server
/// waits twice as long between attempts, up to five minutes, so the check-ins
/// that went unanswered while the server was down say nothing about the
/// devices.
pub const RECOVERY_WINDOW_SECONDS: i64 = 300;
/// Sends in flight across all channels.
const SEND_SLOTS: usize = 4;
const FANOUT_BATCH: i64 = 200;
const AUDIT_BATCH: i64 = 5000;
/// Items listed in a digest message; the rest are counted.
const DIGEST_ITEMS: usize = 20;

/// Process-local notifier state, kept on `App`.
pub struct Runtime {
    inflight: std::sync::Mutex<HashSet<String>>,
    slots: std::sync::Arc<tokio::sync::Semaphore>,
    last_scan: std::sync::Mutex<Option<DateTime<Utc>>>,
    last_prune: std::sync::Mutex<Option<DateTime<Utc>>>,
    /// When the devices' time to reconnect after a server start ends; none
    /// until a start opens the window.
    recovery_ends: std::sync::Mutex<Option<DateTime<Utc>>>,
}
impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            inflight: Default::default(),
            slots: std::sync::Arc::new(tokio::sync::Semaphore::new(SEND_SLOTS)),
            last_scan: Default::default(),
            last_prune: Default::default(),
            recovery_ends: Default::default(),
        }
    }
}
impl Runtime {
    /// The server started at `now`: no device is reported offline before
    /// `RECOVERY_WINDOW_SECONDS` have passed, and silence counts from the end
    /// of that window for any device that has not checked in since.
    pub fn begin_recovery_window(&self, now: DateTime<Utc>) {
        *lock(&self.recovery_ends) = Some(now + Duration::seconds(RECOVERY_WINDOW_SECONDS));
    }
}
fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}
fn parse_time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}
fn bounded(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_owned()
    } else {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// The background loop. Started once by the server binary.
pub async fn run(s: State) {
    s.notifier.begin_recovery_window(Utc::now());
    if let Err(e) = recover(&s, Utc::now()).await {
        tracing::warn!(code = e.code, "notifier recovery failed; continuing");
    }
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(TICK_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if let Err(e) = tick(&s, Utc::now()).await {
            tracing::warn!(code = e.code, "notifier tick failed; retrying");
        }
    }
}
/// A restart interrupts sends in flight: retry those (a receiver may see one
/// twice, and each message carries a stable ID to de-duplicate with).
pub async fn recover(s: &State, now: DateTime<Utc>) -> Result<()> {
    let (_guard, mut tx) = db::write_tx(s).await?;
    sqlx::query("UPDATE notification_deliveries SET status='retrying',next_attempt_at=?,updated_at=? WHERE status='sending' AND kind<>'test'")
        .bind(stamp(now))
        .bind(stamp(now))
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE notification_deliveries SET status='failed',updated_at=? WHERE status='sending' AND kind='test'")
        .bind(stamp(now))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// One pass: record new facts, fan events out to channels, prune, and start
/// sends that are due. Returns the send tasks it started (tests await them).
pub async fn tick(s: &State, now: DateTime<Utc>) -> Result<Vec<tokio::task::JoinHandle<()>>> {
    collect(s, now).await?;
    fan_out(s, now).await?;
    prune(s, now).await?;
    dispatch(s, now).await
}

/* ---------- Facts: audit trail and outages ---------- */

struct Fact {
    identity: String,
    kind: &'static str,
    channel: Option<String>,
    data: Value,
    at: String,
}
async fn collect(s: &State, now: DateTime<Utc>) -> Result<()> {
    let mut conn = s.pool.acquire().await?;
    let channels = notifications::channels(&mut conn).await?;
    let listening = channels.iter().any(|c| c.enabled);
    let (mut facts, cursor) = audit_facts(&mut conn, listening).await?;
    let scan_due = {
        let last = lock(&s.notifier.last_scan);
        last.is_none_or(|at| (now - at).num_seconds() >= SCAN_SECONDS || now < at)
    };
    let outages = if scan_due {
        let enabled: Vec<&Channel> = channels.iter().filter(|c| c.enabled).collect();
        let recovery_ends = *lock(&s.notifier.recovery_ends);
        Some(scan(&mut conn, &enabled, now, recovery_ends, &mut facts).await?)
    } else {
        None
    };
    drop(conn);
    if cursor.is_none() && facts.is_empty() && outages.as_ref().is_none_or(Vec::is_empty) {
        if scan_due {
            *lock(&s.notifier.last_scan) = Some(now);
        }
        return Ok(());
    }
    let (_guard, mut tx) = db::write_tx(s).await?;
    if let Some(cursor) = cursor {
        sqlx::query("INSERT INTO notification_state(key,value) VALUES('audit_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(cursor.to_string())
            .execute(&mut *tx)
            .await?;
    }
    for change in outages.unwrap_or_default() {
        match change {
            OutageChange::Save {
                device,
                since,
                returned_at,
                notified,
            } => {
                sqlx::query("INSERT INTO notification_outages(device_id,since,returned_at,notified) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET since=excluded.since,returned_at=excluded.returned_at,notified=excluded.notified")
                    .bind(device)
                    .bind(since)
                    .bind(returned_at)
                    .bind(json!(notified).to_string())
                    .execute(&mut *tx)
                    .await?;
            }
            OutageChange::Remove(device) => {
                sqlx::query("DELETE FROM notification_outages WHERE device_id=?")
                    .bind(device)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    for fact in &facts {
        notifications::emit(
            &mut tx,
            &fact.identity,
            fact.kind,
            fact.channel.as_deref(),
            &fact.data,
            &fact.at,
        )
        .await?;
    }
    tx.commit().await?;
    if scan_due {
        *lock(&s.notifier.last_scan) = Some(now);
    }
    Ok(())
}

/// Rollout facts from new audit events. Returns the facts and the cursor to
/// store (None when nothing new was read).
async fn audit_facts(
    db: &mut SqliteConnection,
    listening: bool,
) -> Result<(Vec<Fact>, Option<i64>)> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM notification_state WHERE key='audit_cursor'")
            .fetch_optional(&mut *db)
            .await?;
    let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM audit_sequence")
        .fetch_one(&mut *db)
        .await?;
    let Some(cursor) = stored.and_then(|v| v.parse::<i64>().ok()) else {
        // Never announce history: start from here.
        return Ok((Vec::new(), Some(head)));
    };
    if head <= cursor {
        return Ok((Vec::new(), None));
    }
    let upto = head.min(cursor.saturating_add(AUDIT_BATCH));
    if !listening {
        return Ok((Vec::new(), Some(upto)));
    }
    let rows = sqlx::query("SELECT r.id,r.data FROM audit_sequence s JOIN records r ON r.kind='audit' AND r.id=s.audit_id WHERE s.sequence>? AND s.sequence<=? AND json_extract(r.data,'$.action') IN ('deployment.gate','deployment.activate','deployment.rollback') ORDER BY s.sequence")
        .bind(cursor)
        .bind(upto)
        .fetch_all(&mut *db)
        .await?;
    let mut facts = Vec::new();
    for row in rows {
        let id: String = row.get("id");
        let event = db::parse(row.get("data"))?;
        let action = event["action"].as_str().unwrap_or("");
        let outcome = event["outcome"].as_str().unwrap_or("");
        let kind = match (action, outcome) {
            ("deployment.gate", "failed" | "incompatible") => "rollout.failed",
            ("deployment.activate", "blocked" | "incompatible" | "conflict") => "rollout.failed",
            ("deployment.gate", "paused") => "canary.paused",
            ("deployment.rollback", "success") => "rollout.rolled_back",
            _ => continue,
        };
        facts.push(Fact {
            identity: format!("audit:{id}"),
            kind,
            channel: None,
            data: json!({
                "deployment_id": event["target"],
                "actor": event["actor"],
                "action": action,
                "outcome": outcome,
                "severity": if kind == "rollout.failed" { "error" } else { "warning" },
            }),
            at: event["created_at"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(db::now),
        });
    }
    Ok((facts, Some(upto)))
}

enum OutageChange {
    Save {
        device: String,
        since: String,
        returned_at: Option<String>,
        notified: Vec<String>,
    },
    Remove(String),
}
/// Compare check-in times with open outages. A device is offline after three
/// missed check-ins, as everywhere else in Vectory, and a channel announces it
/// once it has been silent for the channel's minutes. Silence counts from the
/// later of the last check-in and `recovery_ends`, the end of the time devices
/// have to reconnect after the server started.
async fn scan(
    db: &mut SqliteConnection,
    channels: &[&Channel],
    now: DateTime<Utc>,
    recovery_ends: Option<DateTime<Utc>>,
    facts: &mut Vec<Fact>,
) -> Result<Vec<OutageChange>> {
    let silent_from = |at: DateTime<Utc>| recovery_ends.map_or(at, |end| at.max(end));
    let rows = sqlx::query("SELECT id,revoked,policy,policy_generation,json_extract(data,'$.last_seen') AS last_seen,json_extract(data,'$.policy_generation') AS reported,json_extract(data,'$.heartbeat_floor_seconds') AS floor FROM devices")
        .fetch_all(&mut *db)
        .await?;
    let mut outages: HashMap<String, (String, Option<String>, Vec<String>)> = HashMap::new();
    for row in sqlx::query("SELECT device_id,since,returned_at,notified FROM notification_outages")
        .fetch_all(&mut *db)
        .await?
    {
        let notified: Vec<String> =
            serde_json::from_str(row.get::<&str, _>("notified")).unwrap_or_default();
        outages.insert(
            row.get("device_id"),
            (row.get("since"), row.get("returned_at"), notified),
        );
    }
    let wants_offline: Vec<&&Channel> = channels
        .iter()
        .filter(|c| c.rules.events.contains("device.offline"))
        .collect();
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for row in rows {
        let device: String = row.get("id");
        seen.insert(device.clone());
        let outage = outages.get(&device).cloned();
        if row.get::<bool, _>("revoked") {
            if outage.is_some() {
                changes.push(OutageChange::Remove(device));
            }
            continue;
        }
        let Some(last_seen) = row
            .get::<Option<String>, _>("last_seen")
            .and_then(|at| parse_time(&at).map(|t| (at, t)))
        else {
            continue;
        };
        let policy: Value =
            serde_json::from_str(row.get::<&str, _>("policy")).unwrap_or(Value::Null);
        let evidence = json!({
            "policy_generation": row.get::<Option<i64>, _>("reported"),
            "heartbeat_floor_seconds": row.get::<Option<i64>, _>("floor"),
        });
        let interval =
            crate::rollout::check_in_seconds(&policy, &evidence, row.get("policy_generation"));
        let offline = (now - silent_from(last_seen.1)).num_seconds() > interval * 3;
        match (offline, outage) {
            (true, outage) => {
                // Nothing is stored until a channel is told: until then the
                // outage starts at the last check-in, which can't move.
                let (since, returned_at, mut notified) =
                    outage.unwrap_or_else(|| (last_seen.0.clone(), None, Vec::new()));
                let told = notified.len();
                let since_time = parse_time(&since).unwrap_or(last_seen.1);
                for channel in &wants_offline {
                    if notified.contains(&channel.id) {
                        continue;
                    }
                    let crossing = silent_from(since_time)
                        + Duration::minutes(channel.rules.offline_minutes as i64);
                    // A channel reports outages that pass its threshold after
                    // it exists, not every device that was already gone.
                    if now >= crossing && crossing >= channel.created_at {
                        notified.push(channel.id.clone());
                        facts.push(Fact {
                            identity: format!("device.offline:{device}:{since}:{}", channel.id),
                            kind: "device.offline",
                            channel: Some(channel.id.clone()),
                            data: json!({"device_id": device, "since": since, "severity": "warning"}),
                            at: stamp(now),
                        });
                    }
                }
                // Offline again before a second check-in: still the same
                // outage, so no new message, and "back" waits for the next.
                if notified.len() > told || returned_at.is_some() {
                    changes.push(OutageChange::Save {
                        device,
                        since,
                        returned_at: None,
                        notified,
                    });
                }
            }
            (false, None) => {}
            (false, Some((since, returned_at, notified))) => {
                if notified.is_empty() {
                    changes.push(OutageChange::Remove(device));
                } else if parse_time(&since).is_some_and(|since| last_seen.1 <= since) {
                    // Not back: the recovery window only keeps a device that
                    // has not checked in since the outage began from reading
                    // as offline.
                } else if let Some(first) = returned_at.as_deref().and_then(parse_time) {
                    // The second check-in since the outage: back for real.
                    if last_seen.1 > first {
                        for channel in channels.iter().filter(|c| {
                            notified.contains(&c.id) && c.rules.events.contains("device.recovered")
                        }) {
                            facts.push(Fact {
                                identity: format!("device.recovered:{device}:{since}:{}", channel.id),
                                kind: "device.recovered",
                                channel: Some(channel.id.clone()),
                                data: json!({"device_id": device, "since": since, "returned_at": returned_at, "severity": "warning"}),
                                at: stamp(now),
                            });
                        }
                        changes.push(OutageChange::Remove(device));
                    }
                } else {
                    changes.push(OutageChange::Save {
                        device,
                        since,
                        returned_at: Some(last_seen.0),
                        notified,
                    });
                }
            }
        }
    }
    for device in outages.keys().filter(|d| !seen.contains(*d)) {
        changes.push(OutageChange::Remove(device.clone()));
    }
    Ok(changes)
}

/* ---------- Events to deliveries ---------- */

/// What an event is about, for filters and the message.
struct Context {
    notice: Value,
    pipeline: Option<String>,
    groups: BTreeSet<String>,
}
async fn device_groups(db: &mut SqliteConnection, device: &str) -> Result<BTreeSet<String>> {
    Ok(sqlx::query_scalar::<_, String>("SELECT g.id FROM records g WHERE g.kind='group' AND EXISTS(SELECT 1 FROM json_each(g.data,'$.device_ids') m WHERE m.value=?)")
        .bind(device)
        .fetch_all(&mut *db)
        .await?
        .into_iter()
        .collect())
}
async fn device_name(
    db: &mut SqliteConnection,
    device: &str,
) -> Result<Option<(String, Option<String>)>> {
    Ok(sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT substr(name,1,120),desired_version_id FROM devices WHERE id=?",
    )
    .bind(device)
    .fetch_optional(&mut *db)
    .await?)
}
/// `{id,name,version_number}` of the pipeline a version belongs to.
async fn pipeline(db: &mut SqliteConnection, version: Option<&str>) -> Result<Option<Value>> {
    let Some(version) = version else {
        return Ok(None);
    };
    let row: Option<(Option<String>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT json_extract(v.data,'$.configuration_id'),substr(json_extract(c.data,'$.name'),1,120),json_extract(v.data,'$.number') FROM records v LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id') WHERE v.kind='version' AND v.id=?",
    )
    .bind(version)
    .fetch_optional(&mut *db)
    .await?;
    Ok(row.and_then(|(id, name, number)| {
        Some(json!({"id": id?, "name": name.unwrap_or_else(|| "A pipeline".into()), "version_number": number}))
    }))
}
fn pipeline_label(p: &Value) -> String {
    match p["version_number"].as_i64() {
        Some(n) => format!("{} v{n}", p["name"].as_str().unwrap_or("A pipeline")),
        None => p["name"].as_str().unwrap_or("A pipeline").to_owned(),
    }
}
fn duration_words(seconds: i64) -> String {
    let minutes = (seconds / 60).max(1);
    if minutes < 60 {
        return format!("{minutes} min");
    }
    let hours = minutes / 60;
    if hours < 48 {
        let rest = minutes % 60;
        return if rest == 0 {
            format!("{hours} h")
        } else {
            format!("{hours} h {rest} min")
        };
    }
    format!("{} days", hours / 24)
}
fn identity_id(identity: &str) -> String {
    db::hash(identity)[..32].to_owned()
}
async fn context(
    db: &mut SqliteConnection,
    id: &str,
    kind: &str,
    data: &Value,
    at: &str,
    now: DateTime<Utc>,
) -> Result<Context> {
    let severity = data["severity"].as_str().unwrap_or("warning");
    let mut notice = json!({
        "id": identity_id(id),
        "type": kind,
        "severity": severity,
        "recovery": matches!(kind, "issue.resolved" | "device.recovered"),
        "occurred_at": at,
        "device": Value::Null,
        "pipeline": Value::Null,
        "deployment": Value::Null,
        "issue": Value::Null,
    });
    let mut groups = BTreeSet::new();
    let pipeline_id;
    match kind {
        "issue.opened" | "issue.resolved" => {
            let device = data["device_id"].as_str().unwrap_or("");
            let name = device_name(db, device)
                .await?
                .map(|d| d.0)
                .unwrap_or_else(|| "A device".into());
            groups = device_groups(db, device).await?;
            let p = pipeline(db, data["version_id"].as_str()).await?;
            pipeline_id = p.as_ref().and_then(|p| p["id"].as_str().map(str::to_owned));
            let title = data["title"]
                .as_str()
                .unwrap_or("A device reported a problem");
            notice["device"] = json!({"id": device, "name": name});
            notice["pipeline"] = p.clone().unwrap_or(Value::Null);
            notice["issue"] = json!({"id": data["issue_id"], "code": data["code"], "resolved_reason": data["resolved_reason"]});
            notice["path"] = json!(format!("/#/issues?device={device}"));
            if kind == "issue.opened" {
                notice["headline"] = json!(format!("Issue on {name}: {title}"));
                notice["message"] = data["message"].clone();
            } else {
                notice["headline"] = json!(format!("Resolved on {name}: {title}"));
                notice["message"] = json!(match data["resolved_reason"].as_str() {
                    Some("healthy") => "Delivery is healthy again: the latest checks were clean.",
                    _ => "The device verified a configuration since the failure.",
                });
            }
            if let Some(p) = &p {
                notice["context"] = json!([
                    format!("Pipeline: {}", pipeline_label(p)),
                    format!("Device: {name}")
                ]);
            } else {
                notice["context"] = json!([format!("Device: {name}")]);
            }
        }
        "rollout.failed" | "rollout.rolled_back" | "canary.paused" => {
            let deployment = data["deployment_id"].as_str().unwrap_or("");
            let record = db::record(db, "deployment", deployment).await.ok();
            let p = match &record {
                Some(r) => pipeline(db, r["version_id"].as_str()).await?,
                None => None,
            };
            pipeline_id = p.as_ref().and_then(|p| p["id"].as_str().map(str::to_owned));
            let name = match (&record, &p) {
                (Some(r), _) if r["name"].as_str().is_some_and(|n| !n.trim().is_empty()) => {
                    bounded(r["name"].as_str().unwrap_or(""), 120)
                }
                (_, Some(p)) => pipeline_label(p),
                (Some(r), None) if r["policy"].is_object() => "Agent settings".to_owned(),
                _ => "A deployment".to_owned(),
            };
            if let Some(r) = &record {
                for group in r["selector"]["group_ids"].as_array().into_iter().flatten() {
                    if let Some(g) = group.as_str() {
                        groups.insert(g.to_owned());
                    }
                }
                groups.extend(
                    sqlx::query_scalar::<_, String>("SELECT DISTINCT g.id FROM records g,json_each(g.data,'$.device_ids') m WHERE g.kind='group' AND m.value IN (SELECT device_id FROM deployment_targets WHERE deployment_id=?)")
                        .bind(deployment)
                        .fetch_all(&mut *db)
                        .await?,
                );
            }
            notice["deployment"] = json!({"id": deployment, "name": name});
            notice["pipeline"] = p.clone().unwrap_or(Value::Null);
            notice["path"] = json!(format!("/#/deployments/{deployment}"));
            let reason = record
                .as_ref()
                .and_then(|r| r["failure_reason"].as_str())
                .unwrap_or("");
            let mut restored: Option<Value> = None;
            let (headline, message) = match (kind, data["outcome"].as_str().unwrap_or("")) {
                ("canary.paused", _) => (
                    format!("Canary paused: {name}"),
                    "Devices that applied it stopped delivering events, so the next wave waits. Resume it once delivery is fixed.".to_owned(),
                ),
                ("rollout.rolled_back", _) => {
                    let actor: Option<String> = sqlx::query_scalar("SELECT substr(name,1,120) FROM users WHERE id=?")
                        .bind(data["actor"].as_str().unwrap_or(""))
                        .fetch_optional(&mut *db)
                        .await?;
                    // What the rollback restored: the version its replacement deploys.
                    restored = match record.as_ref().and_then(|r| r["rolled_back_by"].as_str()) {
                        Some(replacement) => match db::record(db, "deployment", replacement).await {
                            Ok(r) => pipeline(db, r["version_id"].as_str()).await?,
                            Err(_) => None,
                        },
                        None => None,
                    };
                    // A version of another pipeline needs that pipeline's name.
                    let to = match (&restored, &p) {
                        (Some(restored), Some(p)) if restored["id"] == p["id"] => restored["version_number"]
                            .as_i64()
                            .map(|n| format!(" to v{n}"))
                            .unwrap_or_default(),
                        (Some(restored), _) => format!(" to {}", pipeline_label(restored)),
                        (None, _) => String::new(),
                    };
                    (
                        format!("Rolled back: {name}"),
                        format!("{} rolled it back{to}.", actor.unwrap_or_else(|| "Someone".into())),
                    )
                }
                (_, "blocked") => (
                    format!("Rollout failed: {name}"),
                    "Its scheduled start was blocked: an active canary covers some of its devices.".to_owned(),
                ),
                (_, "conflict") => (
                    format!("Rollout failed: {name}"),
                    "Its scheduled start was blocked: another assignment with the same priority conflicts.".to_owned(),
                ),
                (_, "incompatible") => (
                    format!("Rollout failed: {name}"),
                    "A device it was about to update became incompatible, so it stopped.".to_owned(),
                ),
                _ if reason == "data_plane" => (
                    format!("Rollout failed: {name}"),
                    "Devices that applied it stopped delivering events, so it stopped before the next wave.".to_owned(),
                ),
                _ => (
                    format!("Rollout failed: {name}"),
                    "More devices failed to apply it than its failure threshold allows, so it stopped.".to_owned(),
                ),
            };
            notice["headline"] = json!(headline);
            notice["message"] = json!(message);
            notice["context"] = json!([format!("Deployment: {name}")]);
            if kind == "rollout.rolled_back" {
                notice["restored"] = restored.unwrap_or(Value::Null);
            }
        }
        _ => {
            let device = data["device_id"].as_str().unwrap_or("");
            let info = device_name(db, device).await?;
            let name = info
                .as_ref()
                .map(|d| d.0.clone())
                .unwrap_or_else(|| "A device".into());
            groups = device_groups(db, device).await?;
            let p = pipeline(db, info.as_ref().and_then(|d| d.1.as_deref())).await?;
            pipeline_id = p.as_ref().and_then(|p| p["id"].as_str().map(str::to_owned));
            let since = data["since"].as_str().and_then(parse_time);
            notice["device"] = json!({"id": device, "name": name});
            notice["pipeline"] = p.clone().unwrap_or(Value::Null);
            notice["path"] = json!(format!("/#/devices/{device}"));
            if kind == "device.offline" {
                notice["headline"] = json!(format!("{name} is offline"));
                notice["message"] = json!(match since {
                    Some(since) => format!(
                        "No check-in for {} (last seen {}).",
                        duration_words((now - since).num_seconds()),
                        since.format("%Y-%m-%d %H:%M UTC")
                    ),
                    None => "It stopped checking in.".to_owned(),
                });
            } else {
                let back = data["returned_at"].as_str().and_then(parse_time);
                notice["headline"] = json!(format!("{name} is back online"));
                notice["message"] = json!(match (since, back) {
                    (Some(since), Some(back)) => format!(
                        "It checked in again after {} offline.",
                        duration_words((back - since).num_seconds())
                    ),
                    _ => "It checked in again.".to_owned(),
                });
            }
            let mut context = vec![format!("Device: {name}")];
            if let Some(p) = &p {
                context.push(format!("Pipeline: {}", pipeline_label(p)));
            }
            notice["context"] = json!(context);
        }
    }
    Ok(Context {
        notice,
        pipeline: pipeline_id,
        groups,
    })
}

async fn fan_out(s: &State, now: DateTime<Utc>) -> Result<()> {
    let mut conn = s.pool.acquire().await?;
    let events = sqlx::query("SELECT id,identity,kind,channel_id,data,created_at FROM notification_events WHERE processed=0 ORDER BY id LIMIT ?")
        .bind(FANOUT_BATCH)
        .fetch_all(&mut *conn)
        .await?;
    if events.is_empty() {
        return Ok(());
    }
    let channels = notifications::channels(&mut conn).await?;
    let mut pending: HashMap<String, i64> = HashMap::new();
    for channel in &channels {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_deliveries WHERE channel_id=? AND status IN ('queued','held','retrying')")
            .bind(&channel.id)
            .fetch_one(&mut *conn)
            .await?;
        pending.insert(channel.id.clone(), count);
    }
    struct Planned {
        channel: String,
        event: i64,
        status: &'static str,
        next: DateTime<Utc>,
        notice: Value,
    }
    let mut planned = Vec::new();
    let mut backlog: Vec<(String, Value)> = Vec::new();
    let mut processed = Vec::new();
    for row in &events {
        let id: i64 = row.get("id");
        processed.push(id);
        let kind: String = row.get("kind");
        let identity: String = row.get("identity");
        let target: Option<String> = row.get("channel_id");
        let at: String = row.get("created_at");
        let data = match db::parse(row.get("data")) {
            Ok(data) => data,
            Err(_) => continue,
        };
        let occurred = parse_time(&at).unwrap_or(now);
        let wanted: Vec<&Channel> = channels
            .iter()
            .filter(|c| c.enabled && target.as_deref().is_none_or(|t| t == c.id))
            .filter(|c| c.created_at <= occurred)
            .collect();
        if wanted.is_empty() {
            continue;
        }
        let ctx = context(&mut conn, &identity, &kind, &data, &at, now).await?;
        let severity = ctx.notice["severity"]
            .as_str()
            .unwrap_or("warning")
            .to_owned();
        let recovery = ctx.notice["recovery"] == true;
        for channel in wanted {
            if !channel
                .rules
                .matches(&kind, &severity, ctx.pipeline.as_deref(), &ctx.groups)
            {
                continue;
            }
            let count = pending.entry(channel.id.clone()).or_insert(0);
            if *count >= MAX_QUEUE {
                backlog.push((channel.id.clone(), ctx.notice.clone()));
                continue;
            }
            *count += 1;
            let quiet = channel.rules.quiet.as_ref().filter(|q| {
                q.active(now) && !(q.errors_bypass && severity == "error" && !recovery)
            });
            planned.push(Planned {
                channel: channel.id.clone(),
                event: id,
                status: if quiet.is_some() { "held" } else { "queued" },
                next: quiet.map_or(now, |q| q.end_after(now)),
                notice: ctx.notice.clone(),
            });
        }
    }
    drop(conn);
    let (_guard, mut tx) = db::write_tx(s).await?;
    for p in planned {
        sqlx::query("INSERT OR IGNORE INTO notification_deliveries(id,channel_id,event_id,kind,status,attempts,next_attempt_at,data,created_at,updated_at) VALUES(?,?,?,'event',?,0,?,?,?,?)")
            .bind(db::id())
            .bind(&p.channel)
            .bind(p.event)
            .bind(p.status)
            .bind(stamp(p.next))
            .bind(json!({"notice": p.notice}).to_string())
            .bind(stamp(now))
            .bind(stamp(now))
            .execute(&mut *tx)
            .await?;
    }
    for (channel, notice) in backlog {
        fold(&mut tx, &channel, "backlog", &[notice], now, now).await?;
    }
    for id in processed {
        sqlx::query("UPDATE notification_events SET processed=1 WHERE id=?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Add notices to the channel's open digest of this reason, creating one due
/// at `due` if there is none. Returns the digest's ID.
async fn fold(
    db: &mut SqliteConnection,
    channel: &str,
    reason: &str,
    notices: &[Value],
    due: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<String> {
    let open: Option<(String, String)> = sqlx::query_as("SELECT id,data FROM notification_deliveries WHERE channel_id=? AND kind='digest' AND status IN ('queued','held') AND json_extract(data,'$.reason')=? ORDER BY created_at DESC LIMIT 1")
        .bind(channel)
        .bind(reason)
        .fetch_optional(&mut *db)
        .await?;
    let (id, mut data, existing) = match open {
        Some((id, data)) => (id, db::parse(&data)?, true),
        None => (
            db::id(),
            json!({"reason": reason, "count": 0, "types": {}, "items": [], "severity": "warning"}),
            false,
        ),
    };
    for notice in notices {
        data["count"] = json!(data["count"].as_u64().unwrap_or(0) + 1);
        let kind = notice["type"].as_str().unwrap_or("event");
        data["types"][kind] = json!(data["types"][kind].as_u64().unwrap_or(0) + 1);
        if notice["severity"] == "error" {
            data["severity"] = json!("error");
        }
        if let Some(items) = data["items"].as_array_mut() {
            if items.len() < DIGEST_ITEMS {
                items.push(json!({
                    "type": notice["type"],
                    "severity": notice["severity"],
                    "headline": notice["headline"],
                    "occurred_at": notice["occurred_at"],
                    "path": notice["path"],
                }));
            }
        }
    }
    if existing {
        sqlx::query(
            "UPDATE notification_deliveries SET data=?,next_attempt_at=?,updated_at=? WHERE id=?",
        )
        .bind(data.to_string())
        .bind(stamp(due))
        .bind(stamp(now))
        .bind(&id)
        .execute(&mut *db)
        .await?;
    } else {
        sqlx::query("INSERT INTO notification_deliveries(id,channel_id,event_id,kind,status,attempts,next_attempt_at,data,created_at,updated_at) VALUES(?,?,NULL,'digest','queued',0,?,?,?,?)")
            .bind(&id)
            .bind(channel)
            .bind(stamp(due))
            .bind(data.to_string())
            .bind(stamp(now))
            .bind(stamp(now))
            .execute(&mut *db)
            .await?;
    }
    Ok(id)
}

/* ---------- Sending ---------- */

#[derive(Clone)]
struct Due {
    id: String,
    kind: String,
    status: String,
    attempts: i64,
    data: Value,
}
async fn dispatch(s: &State, now: DateTime<Utc>) -> Result<Vec<tokio::task::JoinHandle<()>>> {
    let mut conn = s.pool.acquire().await?;
    let rows = sqlx::query("SELECT id,channel_id,kind,status,attempts,data FROM notification_deliveries WHERE status IN ('queued','held','retrying') AND next_attempt_at<=? ORDER BY next_attempt_at,kind='digest',COALESCE(event_id,0),created_at,id LIMIT 1000")
        .bind(stamp(now))
        .fetch_all(&mut *conn)
        .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let channels: HashMap<String, Channel> = notifications::channels(&mut conn)
        .await?
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect();
    let busy = lock(&s.notifier.inflight).clone();
    let mut by_channel: Vec<(String, Vec<Due>)> = Vec::new();
    for row in rows {
        let channel: String = row.get("channel_id");
        if busy.contains(&channel) {
            continue;
        }
        let due = Due {
            id: row.get("id"),
            kind: row.get("kind"),
            status: row.get("status"),
            attempts: row.get("attempts"),
            data: db::parse(row.get("data")).unwrap_or(Value::Null),
        };
        match by_channel.iter_mut().find(|(c, _)| *c == channel) {
            Some((_, list)) => list.push(due),
            None => by_channel.push((channel, vec![due])),
        }
    }
    let mut windows = HashMap::new();
    for (channel, _) in &by_channel {
        let recent: Vec<String> = sqlx::query_scalar(
            "SELECT at FROM notification_attempts WHERE channel_id=? AND at>? ORDER BY at",
        )
        .bind(channel)
        .bind(stamp(now - Duration::seconds(60)))
        .fetch_all(&mut *conn)
        .await?;
        windows.insert(channel.clone(), recent);
    }
    drop(conn);
    let (guard, mut tx) = db::write_tx(s).await?;
    let mut batches: Vec<(Channel, Vec<Due>)> = Vec::new();
    for (channel_id, mut due) in by_channel {
        let Some(channel) = channels.get(&channel_id).filter(|c| c.enabled) else {
            for item in &due {
                set_status(&mut tx, &item.id, "dropped", None, now).await?;
            }
            continue;
        };
        // Quiet hours ended: what they held goes out as one digest.
        let held: Vec<Due> = due
            .iter()
            .filter(|d| d.status == "held" && d.kind == "event")
            .cloned()
            .collect();
        if held.len() >= 2 {
            let notices: Vec<Value> = held.iter().map(|d| d.data["notice"].clone()).collect();
            let digest = fold(&mut tx, &channel_id, "quiet", &notices, now, now).await?;
            for item in &held {
                digested(&mut tx, &item.id, &digest, now).await?;
            }
            due.retain(|d| !(d.status == "held" && d.kind == "event"));
            let data: String =
                sqlx::query_scalar("SELECT data FROM notification_deliveries WHERE id=?")
                    .bind(&digest)
                    .fetch_one(&mut *tx)
                    .await?;
            due.push(Due {
                id: digest,
                kind: "digest".into(),
                status: "queued".into(),
                attempts: 0,
                data: db::parse(&data)?,
            });
        }
        let window = windows.remove(&channel_id).unwrap_or_default();
        let remaining = RATE_LIMIT.saturating_sub(window.len());
        if due.len() > remaining {
            // Keep the first ones individual, reserving one slot for a
            // digest of the rest; with no slot free, the digest waits for
            // the oldest message to leave the window.
            let keep = remaining.saturating_sub(1);
            let overflow: Vec<Due> = due.split_off(keep);
            let digest_due = if remaining > 0 {
                now
            } else {
                window
                    .first()
                    .and_then(|at| parse_time(at))
                    .map_or(now + Duration::seconds(60), |at| at + Duration::seconds(61))
            };
            let notices: Vec<Value> = overflow
                .iter()
                .flat_map(|d| {
                    if d.kind == "digest" {
                        // A digest already pending joins the new one.
                        d.data["items"].as_array().cloned().unwrap_or_default()
                    } else {
                        vec![d.data["notice"].clone()]
                    }
                })
                .collect();
            let digest = fold(&mut tx, &channel_id, "rate", &notices, digest_due, now).await?;
            for item in overflow.iter().filter(|d| d.id != digest) {
                digested(&mut tx, &item.id, &digest, now).await?;
            }
            if remaining > 0 {
                let data: String =
                    sqlx::query_scalar("SELECT data FROM notification_deliveries WHERE id=?")
                        .bind(&digest)
                        .fetch_one(&mut *tx)
                        .await?;
                due.push(Due {
                    id: digest,
                    kind: "digest".into(),
                    status: "queued".into(),
                    attempts: 0,
                    data: db::parse(&data)?,
                });
            }
        }
        due.truncate(BURST);
        if due.is_empty() {
            continue;
        }
        for item in &mut due {
            item.attempts += 1;
            sqlx::query("UPDATE notification_deliveries SET status='sending',attempts=?,updated_at=? WHERE id=?")
                .bind(item.attempts)
                .bind(stamp(now))
                .bind(&item.id)
                .execute(&mut *tx)
                .await?;
        }
        batches.push((channel.clone(), due));
    }
    tx.commit().await?;
    drop(guard);
    let mut tasks = Vec::new();
    for (channel, batch) in batches {
        lock(&s.notifier.inflight).insert(channel.id.clone());
        let s = s.clone();
        tasks.push(tokio::spawn(async move {
            let _release = Inflight(s.clone(), channel.id.clone());
            let secrets = notifications::open(&s, &channel.id, &channel.sealed);
            for item in batch {
                let notice = if item.kind == "digest" {
                    digest_notice(&item.id, &item.data, now)
                } else {
                    item.data["notice"].clone()
                };
                let outcome = match &secrets {
                    Ok(secrets) => {
                        let _slot = s.notifier.slots.acquire().await;
                        send(&s, &channel, secrets, &item.id, &notice).await
                    }
                    Err(_) => Outcome {
                        delivered: false,
                        status: None,
                        latency_ms: 0,
                        error: Some("This channel's saved secrets can't be read with this instance's keys. Replace them in Settings → Notifications.".into()),
                        retryable: false,
                    },
                };
                let next = (!outcome.delivered && outcome.retryable && item.attempts < MAX_ATTEMPTS)
                    .then(|| now + Duration::seconds(BACKOFF_SECONDS[(item.attempts - 1).clamp(0, 2) as usize]));
                let mut stored = false;
                for _ in 0..3 {
                    let result = async {
                        let (_guard, mut tx) = db::write_tx(&s).await?;
                        record(
                            &mut tx,
                            Recorded {
                                delivery: &item.id,
                                channel: &channel,
                                attempt: item.attempts,
                                at: now,
                                outcome: &outcome,
                                next_attempt_at: next,
                                summary: &notice,
                            },
                        )
                        .await?;
                        tx.commit().await?;
                        crate::error::Result::Ok(())
                    }
                    .await;
                    if result.is_ok() {
                        stored = true;
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
                if !stored {
                    tracing::warn!("notification delivery result could not be recorded; it will be retried after restart");
                }
            }
        }));
    }
    Ok(tasks)
}
/// Clears a channel's in-flight mark however its task ends.
struct Inflight(State, String);
impl Drop for Inflight {
    fn drop(&mut self) {
        lock(&self.0.notifier.inflight).remove(&self.1);
    }
}
async fn set_status(
    db: &mut SqliteConnection,
    id: &str,
    status: &str,
    next: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE notification_deliveries SET status=?,next_attempt_at=?,updated_at=? WHERE id=?",
    )
    .bind(status)
    .bind(next.map(stamp))
    .bind(stamp(now))
    .bind(id)
    .execute(&mut *db)
    .await?;
    Ok(())
}
async fn digested(
    db: &mut SqliteConnection,
    id: &str,
    digest: &str,
    now: DateTime<Utc>,
) -> Result<()> {
    sqlx::query("UPDATE notification_deliveries SET status='digested',digest_id=?,next_attempt_at=NULL,updated_at=? WHERE id=?")
        .bind(digest)
        .bind(stamp(now))
        .bind(id)
        .execute(&mut *db)
        .await?;
    Ok(())
}

pub struct Recorded<'a> {
    pub delivery: &'a str,
    pub channel: &'a Channel,
    pub attempt: i64,
    pub at: DateTime<Utc>,
    pub outcome: &'a Outcome,
    /// When the next attempt goes out; None when this was the last.
    pub next_attempt_at: Option<DateTime<Utc>>,
    pub summary: &'a Value,
}
/// Log one attempt and move its delivery on. Returns the attempt's ID.
pub async fn record(db: &mut SqliteConnection, r: Recorded<'_>) -> Result<i64> {
    let (outcome, status) = if r.outcome.delivered {
        ("delivered", "delivered")
    } else if r.next_attempt_at.is_some() {
        ("failed", "retrying")
    } else if r.outcome.retryable {
        ("gave_up", "gave_up")
    } else {
        ("failed", "failed")
    };
    let id = sqlx::query("INSERT INTO notification_attempts(delivery_id,channel_id,attempt,at,outcome,status_code,latency_ms,error,next_attempt_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .bind(r.delivery)
        .bind(&r.channel.id)
        .bind(r.attempt)
        .bind(stamp(r.at))
        .bind(outcome)
        .bind(r.outcome.status.map(i64::from))
        .bind(i64::try_from(r.outcome.latency_ms).unwrap_or(i64::MAX))
        .bind(r.outcome.error.as_deref().map(|e| bounded(e, outbound::ERROR_CAP)))
        .bind(r.next_attempt_at.map(stamp))
        .bind(json!({
            "channel_name": bounded(&r.channel.name, 80),
            "kind": if r.summary["type"] == "test" { "test" } else if r.summary["type"] == "digest" { "digest" } else { "event" },
            "type": r.summary["type"],
            "title": bounded(r.summary["headline"].as_str().unwrap_or(""), 200),
        }).to_string())
        .execute(&mut *db)
        .await?
        .last_insert_rowid();
    set_status(db, r.delivery, status, r.next_attempt_at, r.at).await?;
    Ok(id)
}

/* ---------- Messages ---------- */

pub fn test_notice(channel: &Channel, now: DateTime<Utc>) -> Value {
    json!({
        "id": identity_id(&format!("test:{}:{}", channel.id, stamp(now))),
        "type": "test",
        "severity": "info",
        "recovery": false,
        "test": true,
        "occurred_at": stamp(now),
        "headline": "Test message from Vectory",
        "message": format!("This is a test from the “{}” channel. Nothing happened in your fleet: if you can read this, notifications reach you here.", bounded(&channel.name, 80)),
        "context": ["Test message"],
        "path": "/#/notifications",
        "device": Value::Null, "pipeline": Value::Null, "deployment": Value::Null, "issue": Value::Null,
    })
}
/// A sample message for the dashboard's preview. Clearly an example: the
/// names say so, and the response carries `example: true`.
pub fn example_notice(kind: &str, now: DateTime<Utc>) -> Value {
    let device = json!({"id": "00000000-0000-4000-8000-000000000000", "name": "example-device"});
    let pipeline = json!({"id": "00000000-0000-4000-8000-000000000000", "name": "Example pipeline", "version_number": 3});
    let deployment =
        json!({"id": "00000000-0000-4000-8000-000000000000", "name": "Example pipeline v3"});
    let (headline, message, context, severity) = match kind {
        "issue.resolved" => ("Resolved on example-device: example-sink can't deliver events", "Delivery is healthy again: the latest checks were clean.".to_owned(), vec!["Pipeline: Example pipeline v3", "Device: example-device"], "error"),
        "rollout.failed" => ("Rollout failed: Example pipeline v3", "More devices failed to apply it than its failure threshold allows, so it stopped.".to_owned(), vec!["Deployment: Example pipeline v3"], "error"),
        "rollout.rolled_back" => ("Rolled back: Example pipeline v3", "An administrator rolled it back to v2.".to_owned(), vec!["Deployment: Example pipeline v3"], "warning"),
        "canary.paused" => ("Canary paused: Example pipeline v3", "Devices that applied it stopped delivering events, so the next wave waits. Resume it once delivery is fixed.".to_owned(), vec!["Deployment: Example pipeline v3"], "warning"),
        "device.offline" => ("example-device is offline", format!("No check-in for 16 min (last seen {}).", (now - Duration::minutes(16)).format("%Y-%m-%d %H:%M UTC")), vec!["Device: example-device", "Pipeline: Example pipeline v3"], "warning"),
        "device.recovered" => ("example-device is back online", "It checked in again after 42 min offline.".to_owned(), vec!["Device: example-device", "Pipeline: Example pipeline v3"], "warning"),
        _ => ("Issue on example-device: example-sink can't deliver events", "The http sink example-sink is failing about 12 requests a minute (connection refused).".to_owned(), vec!["Pipeline: Example pipeline v3", "Device: example-device"], "error"),
    };
    let rollout = kind.starts_with("rollout.") || kind == "canary.paused";
    json!({
        "id": identity_id(&format!("example:{kind}")),
        "type": kind,
        "severity": severity,
        "recovery": matches!(kind, "issue.resolved" | "device.recovered"),
        "example": true,
        "occurred_at": stamp(now),
        "headline": headline,
        "message": message,
        "context": context,
        "path": if rollout { "/#/deployments" } else { "/#/issues" },
        "device": if rollout { Value::Null } else { device },
        "pipeline": pipeline,
        "deployment": if rollout { deployment } else { Value::Null },
        "issue": Value::Null,
        "restored": if kind == "rollout.rolled_back" { json!({"id": "00000000-0000-4000-8000-000000000000", "name": "Example pipeline", "version_number": 2}) } else { Value::Null },
    })
}
fn digest_notice(id: &str, data: &Value, now: DateTime<Utc>) -> Value {
    let count = data["count"].as_u64().unwrap_or(0);
    let items = data["items"].as_array().cloned().unwrap_or_default();
    let plural = |n: u64| {
        if n == 1 {
            "notification"
        } else {
            "notifications"
        }
    };
    let headline = match data["reason"].as_str() {
        Some("quiet") => format!("{count} {} from quiet hours", plural(count)),
        Some("backlog") => format!(
            "{count} more {} while this channel was behind",
            plural(count)
        ),
        _ => format!(
            "{count} more {}, summarised to avoid flooding this channel",
            plural(count)
        ),
    };
    let mut lines: Vec<String> = items
        .iter()
        .map(|item| format!("• {}", item["headline"].as_str().unwrap_or("")))
        .collect();
    if count as usize > items.len() {
        lines.push(format!("…and {} more.", count as usize - items.len()));
    }
    json!({
        "id": identity_id(&format!("digest:{id}")),
        "type": "digest",
        "severity": data["severity"],
        "recovery": false,
        "occurred_at": stamp(now),
        "headline": headline,
        "message": lines.join("\n"),
        "context": ["Open Vectory for the details"],
        "path": "/#/overview",
        "count": count,
        "items": items,
        "device": Value::Null, "pipeline": Value::Null, "deployment": Value::Null, "issue": Value::Null,
    })
}
fn url(s: &crate::App, path: &str) -> Option<String> {
    s.settings
        .public_url
        .as_deref()
        .map(|origin| format!("{}{}", origin.trim_end_matches('/'), path))
}
/// The documented, machine-readable event carried in every webhook body.
fn event_json(s: &crate::App, notice: &Value) -> Value {
    let mut event = Map::new();
    event.insert("schema".into(), json!("vectory.notification.v1"));
    for key in [
        "id",
        "type",
        "severity",
        "recovery",
        "occurred_at",
        "headline",
        "message",
        "device",
        "pipeline",
        "deployment",
        "issue",
    ] {
        event.insert(key.into(), notice[key].clone());
    }
    event.insert("test".into(), json!(notice["type"] == "test"));
    event.insert("instance".into(), json!(s.settings.instance_name));
    event.insert(
        "url".into(),
        json!(url(s, notice["path"].as_str().unwrap_or("/"))),
    );
    if notice["type"] == "digest" {
        event.insert("count".into(), notice["count"].clone());
        event.insert("items".into(), notice["items"].clone());
    }
    if notice["type"] == "rollout.rolled_back" {
        event.insert("restored".into(), notice["restored"].clone());
    }
    Value::Object(event)
}
fn slack_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn context_line(s: &crate::App, notice: &Value) -> String {
    let mut parts: Vec<String> = notice["context"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().map(str::to_owned))
        .collect();
    // A recovery says that it is one, not how serious the problem was.
    let severity = match (notice["type"].as_str(), notice["severity"].as_str()) {
        (Some("issue.resolved"), _) => "Resolved",
        (Some("device.recovered"), _) => "Back online",
        (_, Some("error")) => "Error",
        (_, Some("warning")) => "Warning",
        _ => "",
    };
    if !severity.is_empty() && notice["type"] != "digest" {
        parts.push(severity.into());
    }
    parts.push(s.settings.instance_name.clone());
    parts.join(" · ")
}
/// Slack-compatible body: `text` for the notification, `blocks` for the
/// message, and `event` for any other receiver. Slack renders `text` with its
/// markup, as it does the blocks, so a pipeline's name can't ping a channel or
/// disguise a link: both are escaped. `event` carries the words as written.
pub fn webhook_body(s: &crate::App, notice: &Value) -> Value {
    let headline = notice["headline"].as_str().unwrap_or("");
    let message = notice["message"].as_str().unwrap_or("");
    let mut blocks = vec![
        json!({"type": "section", "text": {"type": "mrkdwn", "text": bounded(&format!("*{}*\n{}", slack_escape(headline), slack_escape(message)), 2900)}}),
        json!({"type": "context", "elements": [{"type": "mrkdwn", "text": bounded(&slack_escape(&context_line(s, notice)), 2900)}]}),
    ];
    if let Some(link) = url(s, notice["path"].as_str().unwrap_or("/")) {
        blocks.push(json!({"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Open in Vectory"}, "url": link}]}));
    }
    json!({
        // Bounded first, so the cut never falls inside an escape.
        "text": slack_escape(&bounded(headline, 300)),
        "blocks": blocks,
        "event": event_json(s, notice),
    })
}
pub fn email_content(s: &crate::App, channel_name: &str, notice: &Value) -> (String, String) {
    let headline = notice["headline"].as_str().unwrap_or("");
    let subject = bounded(
        &format!("[{}] {headline}", s.settings.instance_name).replace(['\r', '\n'], " "),
        200,
    );
    let mut body = format!(
        "{headline}\n\n{}\n",
        notice["message"].as_str().unwrap_or("")
    );
    let context: Vec<&str> = notice["context"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !context.is_empty() {
        body.push('\n');
        for line in context {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some(link) = url(s, notice["path"].as_str().unwrap_or("/")) {
        body.push_str(&format!("\nOpen in Vectory: {link}\n"));
    }
    body.push_str(&format!(
        "\n—\nSent by the “{}” channel in {}. Change what it sends in Settings → Notifications.\n",
        bounded(channel_name, 80),
        s.settings.instance_name
    ));
    (subject, body)
}
/// What the dashboard shows in the add-channel preview.
pub fn preview(s: &crate::App, channel_name: &str, notice: &Value) -> Value {
    let (subject, body) = email_content(s, channel_name, notice);
    json!({
        "example": true,
        "headline": notice["headline"],
        "message": notice["message"],
        "context": context_line(s, notice),
        "link": url(s, notice["path"].as_str().unwrap_or("/")),
        "webhook": webhook_body(s, notice),
        "email": {"subject": subject, "body": body},
    })
}
fn signature(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let mut mac =
        Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}
/// Send one message on one channel and report exactly what happened.
pub async fn send(
    s: &crate::App,
    channel: &Channel,
    secrets: &Secrets,
    delivery: &str,
    notice: &Value,
) -> Outcome {
    let refused = |message: String| Outcome {
        delivered: false,
        status: None,
        latency_ms: 0,
        error: Some(message),
        retryable: false,
    };
    match channel.kind {
        Kind::Webhook => {
            let Some(url) = secrets.url.as_deref() else {
                return refused(
                    "This channel has no saved URL. Replace it in Settings → Notifications.".into(),
                );
            };
            let destination = match outbound::webhook_destination(url, channel.allow_private) {
                Ok(d) => d,
                Err(reason) => return refused(reason),
            };
            let body = serde_json::to_vec(&webhook_body(s, notice)).unwrap_or_default();
            let mut headers = vec![
                (
                    "User-Agent".to_owned(),
                    format!("Vectory/{}", env!("CARGO_PKG_VERSION")),
                ),
                (
                    "X-Vectory-Event".to_owned(),
                    notice["type"].as_str().unwrap_or("event").to_owned(),
                ),
                ("X-Vectory-Delivery".to_owned(), delivery.to_owned()),
            ];
            if let Some(secret) = secrets.signing_secret.as_deref() {
                let timestamp = Utc::now().timestamp();
                headers.push((
                    "X-Vectory-Signature".to_owned(),
                    format!("t={timestamp},v1={}", signature(secret, timestamp, &body)),
                ));
            }
            if let (Some(name), Some(value)) = (
                channel.data["webhook"]["header_name"].as_str(),
                secrets.header_value.as_deref(),
            ) {
                headers.push((name.to_owned(), value.to_owned()));
            }
            let redactions = secrets.redactions(Some(&destination));
            outbound::post(
                &s.settings.outbound,
                outbound::HttpMessage {
                    destination: &destination,
                    allow_private: channel.allow_private,
                    headers,
                    body,
                    secrets: redactions,
                },
            )
            .await
        }
        Kind::Email => {
            let e = &channel.data["email"];
            let Some(security) =
                outbound::SmtpSecurity::parse(e["security"].as_str().unwrap_or(""))
            else {
                return refused("This channel's email settings are incomplete.".into());
            };
            let to: Vec<String> = e["to"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            let (subject, body) = email_content(s, &channel.name, notice);
            outbound::email(
                &s.settings.outbound,
                outbound::EmailMessage {
                    host: e["host"].as_str().unwrap_or(""),
                    port: e["port"]
                        .as_u64()
                        .and_then(|p| u16::try_from(p).ok())
                        .unwrap_or(587),
                    security,
                    allow_private: channel.allow_private,
                    username: e["username"].as_str(),
                    password: secrets.password.as_deref(),
                    from: e["from"].as_str().unwrap_or(""),
                    to: &to,
                    subject: &subject,
                    body: &body,
                },
            )
            .await
        }
    }
}

/* ---------- Retention ---------- */

async fn prune(s: &State, now: DateTime<Utc>) -> Result<()> {
    {
        let mut last = lock(&s.notifier.last_prune);
        if last.is_some_and(|at| (now - at).num_seconds() < 3600 && now >= at) {
            return Ok(());
        }
        *last = Some(now);
    }
    let cutoff = stamp(now - Duration::days(RETENTION_DAYS));
    let (_guard, mut tx) = db::write_tx(s).await?;
    sqlx::query("DELETE FROM notification_attempts WHERE at<?")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM notification_deliveries WHERE status IN ('delivered','failed','gave_up','digested','dropped') AND updated_at<?")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM notification_events WHERE processed=1 AND created_at<? AND NOT EXISTS(SELECT 1 FROM notification_deliveries d WHERE d.event_id=notification_events.id)")
        .bind(&cutoff)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_follow_the_documented_scheme() {
        // HMAC-SHA256 over "<timestamp>.<body>", hex encoded.
        let expected = {
            let mut mac = Hmac::<sha2::Sha256>::new_from_slice(b"0123456789abcdef").unwrap();
            mac.update(b"1700000000.{\"a\":1}");
            hex::encode(mac.finalize().into_bytes())
        };
        assert_eq!(
            signature("0123456789abcdef", 1_700_000_000, b"{\"a\":1}"),
            expected
        );
    }

    #[test]
    fn durations_read_like_people_say_them() {
        assert_eq!(duration_words(30), "1 min");
        assert_eq!(duration_words(16 * 60), "16 min");
        assert_eq!(duration_words(3 * 3600), "3 h");
        assert_eq!(duration_words(3 * 3600 + 12 * 60), "3 h 12 min");
        assert_eq!(duration_words(5 * 86400), "5 days");
    }

    #[test]
    fn digests_list_what_they_hold() {
        let data = json!({"reason":"rate","count":23,"severity":"error","items":[{"headline":"Issue on a: x","type":"issue.opened"},{"headline":"b is offline","type":"device.offline"}]});
        let notice = digest_notice("d", &data, Utc::now());
        assert_eq!(
            notice["headline"],
            "23 more notifications, summarised to avoid flooding this channel"
        );
        assert!(
            notice["message"]
                .as_str()
                .unwrap()
                .ends_with("…and 21 more.")
        );
        assert_eq!(notice["severity"], "error");
    }

    #[tokio::test]
    async fn slack_markup_in_a_headline_is_escaped_in_the_text_and_kept_raw_in_the_event() {
        let temp = tempfile::tempdir().unwrap();
        let s = crate::initialize(crate::Settings {
            data_dir: temp.path().join("state"),
            bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
            instance_name: "Test".into(),
            ..Default::default()
        })
        .await
        .unwrap();
        // A pipeline named by someone who wants the whole channel to be pinged,
        // or a link that reads as something else.
        let headline =
            "Rollout of <!channel> <@U123ABC> *bold* <https://evil.example|click here> R&D";
        let notice = json!({"type":"deployment.failed","severity":"error","headline":headline,"message":"It <failed> & stopped","context":["Pipeline: <b>"],"path":"/"});
        let body = webhook_body(&s, &notice);
        let escaped = "Rollout of &lt;!channel&gt; &lt;@U123ABC&gt; *bold* &lt;https://evil.example|click here&gt; R&amp;D";
        // Slack renders `text` with its markup (for notifications and as the
        // fallback), so it is escaped like the blocks; receivers that read the
        // event get the headline as written.
        assert_eq!(body["text"], escaped);
        assert_eq!(body["event"]["headline"], headline);
        assert!(
            body["blocks"][0]["text"]["text"]
                .as_str()
                .unwrap()
                .starts_with(&format!("*{escaped}*"))
        );
        // The bound counts the headline's own characters and never cuts an escape in two.
        let long = format!("{}&&z", "x".repeat(298));
        let body = webhook_body(
            &s,
            &json!({"type":"issue.opened","headline":long,"message":"m"}),
        );
        let text = body["text"].as_str().unwrap();
        assert_eq!(text, format!("{}&amp;…", "x".repeat(298)));
        assert_eq!(body["event"]["headline"], long);
        s.pool.close().await;
    }
}
