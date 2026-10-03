//! Agent updates: the team's setting, what each device reports about them, and
//! what the server tells the dashboard about the fleet.
//!
//! A team turns updates on once (Settings → Agent updates, an Administrator
//! with their password), and a host consents when it is enrolled or upgraded.
//! Everything here is additive: while updates are off no heartbeat offers a
//! build, no route but the setting answers, and `Device` carries nothing new.
//!
//! The heartbeat member `agent_update` is parsed strictly before any write
//! (`parse`) and stored as the device sent it (`store`); the server never
//! infers a report and never keeps a stale one. A device is counted as updated
//! only by `agent_update_rollouts`, from its own observation of the new build.
use crate::{
    State,
    accounts::{reauthenticate, recheck},
    agent_release::ReleaseKey,
    agent_release_keys as keys, auth, db,
    error::{ApiError, Result},
    install,
};
use axum::{
    Json,
    body::Bytes,
    extract::State as AppState,
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub mod offer;
pub mod review;
pub use review::{Facts, OPEN_STATES, Refusal, RolloutSettings, Statements, facts};

/// Listed in the signed manifest's `features` while updates are on, so agents
/// report and read offers; a stopped server still lists it.
pub const FEATURE: &str = "agent_update";
/// The target of audit events about the setting itself.
pub const SERVER_TARGET: &str = "server";
/// Most reported counters above the stored sequence that count (see
/// `next_counter`): no device can use the sequence up.
const COUNTER_REACH: i64 = 1_000_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_COUNTER: i64 = 9_007_199_254_740_991;

// ---------------------------------------------------------------------------
// Errors

pub fn off() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "AGENT_UPDATES_OFF",
        "Agent updates are off. An Administrator can turn them on in Settings → Agent updates.",
    )
}
/// What the agent listener answers while updates are off: what a server that
/// has no such route answers, so a server with updates off looks like an older
/// one.
pub fn off_public() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Route not found")
}
pub fn stopped() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "AGENT_UPDATES_STOPPED",
        "All agent updates are stopped. An Administrator can clear the stop in Settings → Agent updates.",
    )
}
pub fn stale() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "STALE_REVISION",
        "Agent updates changed since you opened this page. Reload and try again.",
    )
}

// ---------------------------------------------------------------------------
// The setting

pub struct Stop {
    pub reason: String,
    pub by_name: Option<String>,
    pub at: String,
}
pub struct Setting {
    pub enabled: bool,
    pub custody: Option<String>,
    pub current_key: Option<String>,
    pub stopped: Option<Stop>,
    pub counter_sequence: i64,
    pub revision: i64,
}
pub async fn setting(conn: &mut SqliteConnection) -> Result<Setting> {
    let row = sqlx::query("SELECT enabled,custody,current_key,stopped_reason,stopped_by_name,stopped_at,counter_sequence,revision FROM agent_update_settings WHERE id=1")
        .fetch_one(&mut *conn)
        .await?;
    let stopped = match (
        row.get::<Option<String>, _>("stopped_reason"),
        row.get::<Option<String>, _>("stopped_at"),
    ) {
        (Some(reason), Some(at)) => Some(Stop {
            reason,
            by_name: row.get("stopped_by_name"),
            at,
        }),
        _ => None,
    };
    Ok(Setting {
        enabled: row.get("enabled"),
        custody: row.get("custody"),
        current_key: row.get("current_key"),
        stopped,
        counter_sequence: row.get("counter_sequence"),
        revision: row.get("revision"),
    })
}
/// Whether updates are on: the one read the heartbeat, the scheduler and the
/// agent-listener routes make.
pub async fn enabled(conn: &mut SqliteConnection) -> Result<bool> {
    Ok(
        sqlx::query_scalar("SELECT enabled FROM agent_update_settings WHERE id=1")
            .fetch_one(&mut *conn)
            .await?,
    )
}
/// `404 AGENT_UPDATES_OFF` while updates are off: what every route but the
/// setting asks first, before it reads a body or a query.
pub async fn guard(s: &State) -> Result<()> {
    let mut conn = s.pool.acquire().await?;
    if enabled(&mut conn).await? {
        Ok(())
    } else {
        Err(off())
    }
}
/// The setting, or `404 AGENT_UPDATES_OFF` while updates are off.
pub async fn require_on(conn: &mut SqliteConnection) -> Result<Setting> {
    let setting = setting(conn).await?;
    if setting.enabled {
        Ok(setting)
    } else {
        Err(off())
    }
}
/// Advances the revision: the setting, its custody, its current key or its stop
/// state changed.
pub async fn advance(conn: &mut SqliteConnection) -> Result<()> {
    sqlx::query("UPDATE agent_update_settings SET revision=revision+1,updated_at=? WHERE id=1")
        .bind(db::now())
        .execute(&mut *conn)
        .await?;
    Ok(())
}
/// An audit row about agent updates. `details` holds only what the audit view
/// allowlists: versions, digests, counters, fingerprints and codes, never key
/// material.
pub async fn audit(
    conn: &mut SqliteConnection,
    actor: &str,
    action: &str,
    target: &str,
    outcome: &str,
    details: Value,
) -> Result<()> {
    db::insert(
        conn,
        "audit",
        &json!({"id":db::id(),"actor":actor,"action":action,"target":target,"outcome":outcome,"created_at":db::now(),"details":details}),
    )
    .await
}

// ---------------------------------------------------------------------------
// Scalars the contract fixes

fn lowercase_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn fingerprint(value: &str) -> bool {
    lowercase_hex(value, 64)
}
/// `major.minor.patch`: three numbers, each `0` or one to nine digits that start
/// with 1 to 9, and nothing else.
pub fn parse_version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split('.');
    let mut numbers = [0u64; 3];
    for number in &mut numbers {
        let part = parts.next()?;
        let digits = part.bytes().all(|b| b.is_ascii_digit());
        if part.is_empty() || part.len() > 9 || !digits || (part.len() > 1 && part.starts_with('0'))
        {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(numbers)
}
/// A UTC instant in whole seconds, `YYYY-MM-DDTHH:MM:SSZ`, years 1970 to 9999,
/// as Unix seconds.
pub fn parse_instant(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    let shape = bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z'
        && bytes
            .iter()
            .enumerate()
            .all(|(at, b)| matches!(at, 4 | 7 | 10 | 13 | 16 | 19) || b.is_ascii_digit());
    if !shape {
        return None;
    }
    let number = |from: usize, to: usize| value[from..to].parse::<u32>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if year < 1970 || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, day)?
        .and_hms_opt(hour, minute, second)
        .map(|at| at.and_utc().timestamp())
}
/// `instant`, written the way every UTC member of the API is.
pub fn instant(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
/// A reason (a stop, a withdrawal, a revocation): 1 to 500 Unicode scalar
/// values after trimming, with no control character.
pub fn reason(value: &Value) -> Result<String> {
    let text = value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= 500)
        .filter(|text| !text.chars().any(db::refused_in_name))
        .ok_or_else(|| {
            ApiError::invalid(
                "Give a reason of 1 to 500 characters, without line breaks or control characters",
            )
        })?;
    Ok(text.to_owned())
}
/// A body the routes take: one JSON object, no duplicate member, only the
/// members named.
pub fn body(bytes: &Bytes, allowed: &[&str]) -> Result<Map<String, Value>> {
    let value = crate::token_requests::parse(bytes)?;
    let object = value
        .as_object()
        .ok_or_else(|| ApiError::invalid("Send a JSON object"))?;
    if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(ApiError::invalid(format!("Unknown member {unknown}")));
    }
    Ok(object.clone())
}

// ---------------------------------------------------------------------------
// The heartbeat member

pub const AGENT_CODES: [&str; 30] = [
    "UPDATES_OFF",
    "UPDATES_PAUSED",
    "KEY_NOT_PINNED",
    "SIGNATURE_INVALID",
    "MANIFEST_INVALID",
    "MANIFEST_EXPIRED",
    "KEY_ROLLOVER_CONFLICT",
    "RELEASE_ALREADY_TRIED",
    "COUNTER_REPLAYED",
    "DOWNGRADE_REFUSED",
    "VERSION_NOT_ON_TRACK",
    "AGENT_TOO_OLD",
    "ALREADY_RUNNING",
    "PLATFORM_NOT_IN_RELEASE",
    "PACKAGE_MANAGED",
    "NO_SERVICE",
    "UNTRUSTED_LOCATION",
    "READ_ONLY",
    "HELPER_NOT_RUNNING",
    "SERVICE_DEFINITION_OUTDATED",
    "DOWNLOAD_FAILED",
    "ARTIFACT_MISMATCH",
    "DISK_FULL",
    "PROBE_FAILED",
    "START_FAILED",
    "NO_CHECK_IN",
    "UNHEALTHY",
    "INTERRUPTED",
    "BINARY_CHANGED",
    "ROLLBACK_UNHEALTHY",
];
pub const ELIGIBILITY: [&str; 8] = [
    "eligible",
    "PACKAGE_MANAGED",
    "NO_SERVICE",
    "UNTRUSTED_LOCATION",
    "READ_ONLY",
    "HELPER_NOT_RUNNING",
    "SERVICE_DEFINITION_OUTDATED",
    "PLATFORM_NOT_IN_RELEASE",
];
pub const STATES: [&str; 9] = [
    "idle",
    "downloading",
    "staged",
    "waiting_for_host",
    "waiting_for_window",
    "applying",
    "trial",
    "refused",
    "failed",
];
const OUTCOMES: [&str; 4] = ["committed", "rolled_back", "failed", "refused"];
const REPORT_KEYS: usize = 4;
const REPORT_WINDOWS: usize = 7;
const REPORT_WINDOW_CHARACTERS: usize = 40;
const REPORT_SERVICE_DEFINITION: u64 = 1000;
const REPORT_FIRST_CHECK_IN_MS: u64 = 86_400_000;
const REPORT_VERSION_BYTES: usize = 128;

/// A report that passed `parse`: the member as the device sent it, without the
/// optional members it left null.
#[derive(Clone, Debug)]
pub struct Report {
    member: Value,
}
impl Report {
    pub fn member(&self) -> &Value {
        &self.member
    }
    pub fn state(&self) -> &str {
        self.member["state"].as_str().unwrap_or("idle")
    }
    pub fn release(&self) -> Option<&str> {
        self.member["release"].as_str()
    }
    pub fn code(&self) -> Option<&str> {
        self.member["code"].as_str()
    }
    pub fn last(&self) -> Option<&Value> {
        self.member.get("last")
    }
}

/// The member in the heartbeat, checked before anything is written. `None`
/// when the heartbeat carries none (an absent member and a null count alike);
/// a member that is not exactly what the contract lists is `400 INVALID_INPUT`
/// and changes nothing. The bounds and the cases are the shared fixture
/// `contracts/fixtures/agent-release/report.json`.
pub fn parse(heartbeat: &Value) -> Result<Option<Report>> {
    let Some(member) = heartbeat.get("agent_update").filter(|m| !m.is_null()) else {
        return Ok(None);
    };
    match validate(member) {
        Ok(()) => {}
        Err(problem) => {
            return Err(ApiError::invalid(format!(
                "Invalid agent_update: {problem}"
            )));
        }
    }
    let mut kept = Map::new();
    for (key, value) in member.as_object().into_iter().flatten() {
        if !value.is_null() {
            kept.insert(key.clone(), value.clone());
        }
    }
    Ok(Some(Report {
        member: Value::Object(kept),
    }))
}

fn exactly(object: &Map<String, Value>, required: &[&str], optional: &[&str]) -> bool {
    required.iter().all(|name| object.contains_key(*name))
        && object
            .keys()
            .all(|name| required.contains(&name.as_str()) || optional.contains(&name.as_str()))
}
/// A member of an object, or null when it has none: indexing a `Map` panics on a
/// missing key, and what a device sends must never panic.
fn member_of<'a>(object: &'a Map<String, Value>, key: &str) -> &'a Value {
    object.get(key).unwrap_or(&Value::Null)
}
fn present(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).is_some_and(|value| !value.is_null())
}
fn counter(value: &Value, most: u64) -> bool {
    value.as_u64().is_some_and(|n| n <= most)
}
fn digest(value: &Value) -> bool {
    value.as_str().is_some_and(fingerprint)
}
fn identifying(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        (1..=REPORT_VERSION_BYTES).contains(&text.len()) && !text.chars().any(db::refused_in_name)
    })
}

fn validate_last(last: &Value) -> std::result::Result<(), &'static str> {
    let last = last.as_object().ok_or("last is an object")?;
    if !exactly(
        last,
        &[
            "release",
            "outcome",
            "code",
            "at",
            "from_version",
            "to_version",
        ],
        &["first_check_in_ms"],
    ) {
        return Err("last has exactly its members");
    }
    if !digest(&member_of(last, "release")) {
        return Err("last.release is a manifest digest");
    }
    let outcome = member_of(last, "outcome")
        .as_str()
        .filter(|outcome| OUTCOMES.contains(outcome))
        .ok_or("last.outcome is not known")?;
    let code = match &member_of(last, "code") {
        Value::Null => None,
        Value::String(code) if AGENT_CODES.contains(&code.as_str()) => Some(code),
        _ => return Err("last.code is not a code"),
    };
    match (outcome, code) {
        ("committed", Some(_)) => return Err("a committed result has no code"),
        ("committed", None) => {}
        (_, None) => return Err("a result that is not committed has a code"),
        _ => {}
    }
    if member_of(last, "at")
        .as_str()
        .and_then(parse_instant)
        .is_none()
    {
        return Err("last.at is a UTC instant");
    }
    if !identifying(&member_of(last, "from_version")) {
        return Err("last.from_version is 1 to 128 bytes without control characters");
    }
    if !member_of(last, "to_version").is_null()
        && member_of(last, "to_version")
            .as_str()
            .and_then(parse_version)
            .is_none()
    {
        return Err("last.to_version is a version or null");
    }
    if let Some(ms) = last.get("first_check_in_ms")
        && !counter(ms, REPORT_FIRST_CHECK_IN_MS)
    {
        return Err("last.first_check_in_ms is 0 to 86,400,000");
    }
    Ok(())
}

fn validate(member: &Value) -> std::result::Result<(), &'static str> {
    let member = member.as_object().ok_or("the member is an object")?;
    if !exactly(
        member,
        &[
            "consent",
            "paused",
            "track",
            "windows",
            "window_open",
            "keys",
            "highest_counter",
            "eligibility",
            "state",
        ],
        &[
            "next_window_at",
            "service_definition",
            "release",
            "code",
            "rollover_conflict",
            "last",
        ],
    ) {
        return Err("unknown or missing member");
    }
    let text = |key: &str| member_of(member, key).as_str();
    let consent = text("consent").filter(|c| matches!(*c, "off" | "auto" | "ask"));
    let consent = consent.ok_or("consent is off, auto or ask")?;
    if !member_of(member, "paused").is_boolean() {
        return Err("paused is a boolean");
    }
    if !text("track").is_some_and(|track| matches!(track, "patch" | "minor")) {
        return Err("track is patch or minor");
    }
    let windows_ok = member_of(member, "windows")
        .as_array()
        .is_some_and(|windows| {
            windows.len() <= REPORT_WINDOWS
                && windows.iter().all(|window| {
                    window.as_str().is_some_and(|window| {
                        (1..=REPORT_WINDOW_CHARACTERS).contains(&window.len())
                            && window.bytes().all(|b| (0x20..=0x7e).contains(&b))
                    })
                })
        });
    if !windows_ok {
        return Err("windows are at most 7 strings of 1 to 40 printable ASCII characters");
    }
    if !member_of(member, "window_open").is_boolean() {
        return Err("window_open is a boolean");
    }
    if present(member, "next_window_at")
        && member_of(member, "next_window_at")
            .as_str()
            .and_then(parse_instant)
            .is_none()
    {
        return Err("next_window_at is a UTC instant");
    }
    let keys_ok = member_of(member, "keys").as_array().is_some_and(|keys| {
        keys.len() <= REPORT_KEYS
            && keys.iter().all(digest)
            && keys
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                .len()
                == keys.len()
    });
    if !keys_ok {
        return Err("keys are at most 4 distinct fingerprints");
    }
    if !counter(&member_of(member, "highest_counter"), MAX_SAFE) {
        return Err("highest_counter is 0 to 2^53-1");
    }
    if !text("eligibility").is_some_and(|code| ELIGIBILITY.contains(&code)) {
        return Err("eligibility is not known");
    }
    if present(member, "service_definition")
        && !member_of(member, "service_definition")
            .as_u64()
            .is_some_and(|n| (1..=REPORT_SERVICE_DEFINITION).contains(&n))
    {
        return Err("service_definition is 1 to 1,000");
    }
    let state = text("state").filter(|state| STATES.contains(state));
    let state = state.ok_or("state is not known")?;
    if present(member, "release") && !digest(&member_of(member, "release")) {
        return Err("release is a manifest digest");
    }
    if present(member, "code") && !text("code").is_some_and(|code| AGENT_CODES.contains(&code)) {
        return Err("code is not a code");
    }
    if present(member, "rollover_conflict") {
        let conflict = member_of(member, "rollover_conflict")
            .as_object()
            .filter(|conflict| exactly(conflict, &["from", "to"], &[]))
            .ok_or(CONFLICT)?;
        let successors = member_of(conflict, "to")
            .as_array()
            .filter(|to| to.len() == 2);
        let sound = digest(&member_of(conflict, "from"))
            && successors.is_some_and(|to| {
                to.iter().all(digest)
                    && to[0] != to[1]
                    && !to.contains(&member_of(conflict, "from"))
            });
        if !sound {
            return Err(CONFLICT);
        }
    }
    if present(member, "last") {
        validate_last(&member_of(member, "last"))?;
    }
    let in_progress = matches!(
        state,
        "downloading" | "staged" | "waiting_for_host" | "waiting_for_window" | "applying" | "trial"
    );
    if in_progress && !present(member, "release") {
        return Err("a state about a release names it");
    }
    if matches!(state, "refused" | "failed") && !present(member, "code") {
        return Err("a refusal or a failure has a code");
    }
    if consent == "off" && (state != "idle" || present(member, "release")) {
        return Err("a host that is off reports idle");
    }
    if present(member, "rollover_conflict") != (text("code") == Some("KEY_ROLLOVER_CONFLICT")) {
        return Err("rollover_conflict and its code go together");
    }
    Ok(())
}
const CONFLICT: &str = "rollover_conflict is a fingerprint and two different successors of it";

/// Stores the report (a check-in without one removes it) beside the device.
pub async fn store(
    conn: &mut SqliteConnection,
    device: &str,
    report: Option<&Report>,
    now: &str,
) -> Result<()> {
    match report {
        Some(report) => {
            sqlx::query("INSERT INTO agent_update_reports(device_id,report,reported_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET report=excluded.report,reported_at=excluded.reported_at")
                .bind(device)
                .bind(report.member().to_string())
                .bind(now)
                .execute(&mut *conn)
                .await?;
        }
        None => {
            sqlx::query("DELETE FROM agent_update_reports WHERE device_id=?")
                .bind(device)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Adds the read-only `agent_update` to each device of a projection while
/// updates are on and the device reported it: the report as the device sent it,
/// the version of the release its digest names, and when it reported. A device
/// that sent nothing carries nothing, and the dashboard says "Not reported".
pub async fn attach(conn: &mut SqliteConnection, devices: &mut [Value]) -> Result<()> {
    if devices.is_empty() || !enabled(conn).await? {
        return Ok(());
    }
    let ids: Vec<&str> = devices.iter().filter_map(|d| d["id"].as_str()).collect();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT device_id,report,reported_at FROM agent_update_reports WHERE device_id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(ids).to_string())
    .fetch_all(&mut *conn)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut reports: HashMap<String, (Value, String)> = HashMap::new();
    for (device, report, at) in rows {
        reports.insert(device, (db::parse(&report)?, at));
    }
    let digests: BTreeSet<&str> = reports
        .values()
        .filter_map(|(report, _)| report["release"].as_str())
        .collect();
    let versions: HashMap<String, String> = if digests.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, String)>(
            "SELECT manifest_sha256,version FROM agent_releases WHERE manifest_sha256 IN (SELECT value FROM json_each(?))",
        )
        .bind(json!(digests).to_string())
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect()
    };
    for device in devices {
        let Some((report, at)) = device["id"].as_str().and_then(|id| reports.get(id)) else {
            continue;
        };
        device["agent_update"] = projection(report, at, &versions);
    }
    Ok(())
}
/// `Device.agent_update` of a stored report.
pub fn projection(report: &Value, reported_at: &str, versions: &HashMap<String, String>) -> Value {
    let optional = |key: &str| report.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "consent": report["consent"],
        "paused": report["paused"],
        "track": report["track"],
        "windows": report["windows"],
        "window_open": report["window_open"],
        "next_window_at": optional("next_window_at"),
        "keys": report["keys"],
        "eligibility": report["eligibility"],
        "state": report["state"],
        "release_version": report["release"].as_str().and_then(|digest| versions.get(digest)),
        "code": optional("code"),
        "rollover_conflict": optional("rollover_conflict"),
        "last": optional("last"),
        "reported_at": reported_at,
    })
}

/// The release counter a new release takes: one more than the larger of the
/// sequence so far and the highest counter any device reports it attempted, so
/// no host holds a floor at or above it. A reported counter more than a million
/// above the sequence is ignored: no device can use the sequence up.
pub async fn next_counter(conn: &mut SqliteConnection, sequence: i64) -> Result<i64> {
    let reported: Option<i64> = sqlx::query_scalar(
        "SELECT max(json_extract(r.report,'$.highest_counter')) FROM agent_update_reports r JOIN devices d ON d.id=r.device_id WHERE d.revoked=0 AND json_extract(r.report,'$.highest_counter')<=?",
    )
    .bind(sequence.saturating_add(COUNTER_REACH))
    .fetch_one(&mut *conn)
    .await?;
    let next = sequence.max(reported.unwrap_or(0)).saturating_add(1);
    if next > MAX_COUNTER {
        return Err(ApiError::conflict(
            "The release counter sequence is exhausted",
        ));
    }
    Ok(next)
}

// ---------------------------------------------------------------------------
// The heartbeat

/// What a heartbeat says about the build that sent it.
pub struct Build<'a> {
    pub device_id: &'a str,
    pub agent_version: &'a str,
    /// The running build's SHA-256, when the agent reports it.
    pub agent_sha256: Option<&'a str>,
    /// A fresh value for every agent process.
    pub boot_id: &'a str,
}
/// What a check-in leaves for the manifest: whether the feature is listed, and
/// the offer the device holds.
pub struct Outcome {
    pub enabled: bool,
    pub offer: Option<Value>,
}
/// The agent-update part of a check-in, inside its transaction: store the report
/// (a check-in without one removes it), let the device's target move as far as
/// the check-in proves, and find the offer the device holds. While updates are
/// off nothing but the stored report is touched, and nothing is offered.
pub async fn heartbeat(
    conn: &mut SqliteConnection,
    s: &State,
    now: &str,
    build: &Build<'_>,
    report: Option<&Report>,
) -> Result<Outcome> {
    store(conn, build.device_id, report, now).await?;
    let setting = setting(conn).await?;
    if !setting.enabled {
        return Ok(Outcome {
            enabled: false,
            offer: None,
        });
    }
    crate::agent_update_rollouts::observe(conn, s, now, build, report).await?;
    let offer = if setting.stopped.is_some() {
        None
    } else {
        offer::for_device(conn, build.device_id, now)
            .await?
            .map(|offer| offer.member())
    };
    Ok(Outcome {
        enabled: true,
        offer,
    })
}

// ---------------------------------------------------------------------------
// What the dashboard reads

/// `AgentUpdates`: the setting, the fleet's agent versions and update levels
/// from the devices' reports, and the builds this server's catalog could roll
/// out. `fleet` and `catalog` are null while updates are off.
pub async fn view(s: &State, conn: &mut SqliteConnection) -> Result<Value> {
    let setting = setting(conn).await?;
    let current_key = match &setting.current_key {
        Some(fingerprint) => crate::agent_release_keys::view(conn, fingerprint).await?,
        None => Value::Null,
    };
    let active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_update_rollouts WHERE status IN ('active','paused')",
    )
    .fetch_one(&mut *conn)
    .await?;
    let (fleet, catalog) = if setting.enabled {
        let (fleet, counts) = fleet(conn).await?;
        let catalog = catalog(s, conn, &counts).await?;
        (fleet, json!(catalog))
    } else {
        (Value::Null, Value::Null)
    };
    Ok(json!({
        "enabled": setting.enabled,
        "custody": setting.custody,
        "revision": setting.revision,
        "current_key": current_key,
        "stopped": setting.stopped.map(|stop| json!({"reason":stop.reason,"by_name":stop.by_name,"at":stop.at})),
        "active_rollouts": active,
        "fleet": fleet,
        "catalog": catalog,
    }))
}

/// The agent versions the fleet reports, newest first, and how each device
/// takes updates. Every non-revoked device is in exactly one level.
async fn fleet(conn: &mut SqliteConnection) -> Result<(Value, BTreeMap<[u64; 3], i64>)> {
    let versions: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT CASE WHEN json_type(data,'$.agent_version')='text' THEN json_extract(data,'$.agent_version') END AS version,count(*) FROM devices WHERE revoked=0 GROUP BY version",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut valid: BTreeMap<[u64; 3], (String, i64)> = BTreeMap::new();
    let mut unknown = 0;
    let mut total = 0;
    for (version, devices) in versions {
        total += devices;
        match version
            .as_deref()
            .and_then(|v| Some((parse_version(v)?, v)))
        {
            Some((number, text)) => {
                valid.insert(number, (text.to_owned(), devices));
            }
            None => unknown += devices,
        }
    }
    let counts = valid
        .iter()
        .map(|(number, (_, devices))| (*number, *devices))
        .collect();
    let room = 50 - usize::from(unknown > 0);
    let mut listed: Vec<Value> = valid
        .into_values()
        .rev()
        .take(room)
        .map(|(version, devices)| json!({"version":version,"devices":devices}))
        .collect();
    if unknown > 0 {
        listed.push(json!({"version":"unknown","devices":unknown}));
    }
    let mut levels = BTreeMap::from([
        ("automatic", 0),
        ("ask", 0),
        ("off", 0),
        ("cannot_update", 0),
        ("not_reported", 0),
    ]);
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT CASE WHEN r.device_id IS NULL THEN 'not_reported' WHEN json_extract(r.report,'$.eligibility')<>'eligible' THEN 'cannot_update' WHEN json_extract(r.report,'$.consent')='off' THEN 'off' WHEN json_extract(r.report,'$.consent')='ask' THEN 'ask' ELSE 'automatic' END AS level,count(*) FROM devices d LEFT JOIN agent_update_reports r ON r.device_id=d.id WHERE d.revoked=0 GROUP BY level",
    )
    .fetch_all(&mut *conn)
    .await?;
    for (level, devices) in rows {
        if let Some(count) = levels.get_mut(level.as_str()) {
            *count = devices;
        }
    }
    Ok((
        json!({"devices_total":total,"versions":listed,"levels":levels}),
        counts,
    ))
}

/// Versions in this server's agent catalog that are newer than the agent of at
/// least one device: each with its platforms, the devices behind it and its
/// release, when one that is not withdrawn exists.
async fn catalog(
    s: &State,
    conn: &mut SqliteConnection,
    fleet: &BTreeMap<[u64; 3], i64>,
) -> Result<Vec<Value>> {
    let mut by_version: BTreeMap<[u64; 3], (String, BTreeSet<(usize, usize, String, String)>)> =
        BTreeMap::new();
    for build in &install::catalog(s).await.releases {
        let Some(number) = parse_version(&build.version) else {
            continue;
        };
        let (os, arch) = (build.os.clone(), build.arch.clone());
        by_version
            .entry(number)
            .or_insert_with(|| (build.version.clone(), BTreeSet::new()))
            .1
            .insert((platform_rank(&os), arch_rank(&arch), os, arch));
    }
    let mut entries = Vec::new();
    for (number, (version, platforms)) in by_version.into_iter().rev() {
        let behind: i64 = fleet.range(..number).map(|(_, devices)| *devices).sum();
        if behind == 0 {
            continue;
        }
        let release: Option<(String, String)> = sqlx::query_as(
            "SELECT id,state FROM agent_releases WHERE version=? AND state<>'withdrawn' ORDER BY prepared_at DESC LIMIT 1",
        )
        .bind(&version)
        .fetch_optional(&mut *conn)
        .await?;
        entries.push(json!({
            "version": version,
            "platforms": platforms.iter().map(|(_, _, os, arch)| json!({"os":os,"arch":arch})).collect::<Vec<_>>(),
            "devices_behind": behind,
            "release": release.map(|(id, state)| json!({"id":id,"state":state})),
        }));
        if entries.len() == 20 {
            break;
        }
    }
    Ok(entries)
}
fn platform_rank(os: &str) -> usize {
    ["linux", "darwin", "windows"]
        .iter()
        .position(|name| *name == os)
        .unwrap_or(3)
}
fn arch_rank(arch: &str) -> usize {
    ["amd64", "arm64"]
        .iter()
        .position(|name| *name == arch)
        .unwrap_or(2)
}

/// `GET /api/v1/agent-updates`: any signed-in role; it answers while updates
/// are off.
pub async fn get(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    Ok(Json(view(&s, &mut tx).await?))
}

/// `POST /api/v1/agent-updates/stop {reason}`: Stop all updates. Operators and
/// Administrators. In one transaction it cancels every active or paused update
/// rollout and withdraws every offer; the devices that held an offer are asked
/// to check in once it commits, so the withdrawal reaches them in seconds.
pub async fn stop(AppState(s): AppState<State>, h: HeaderMap, bytes: Bytes) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    guard(&s).await?;
    let request = body(&bytes, &["reason"])?;
    let reason = reason(request.get("reason").unwrap_or(&Value::Null))?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let setting = require_on(&mut tx).await?;
    let mut asked = Vec::new();
    // Stopping a stopped server changes nothing and keeps the first reason.
    if setting.stopped.is_none() {
        let now = instant(Utc::now());
        sqlx::query("UPDATE agent_update_settings SET stopped_reason=?,stopped_by=?,stopped_by_name=?,stopped_at=? WHERE id=1")
            .bind(&reason)
            .bind(actor["id"].as_str())
            .bind(actor["name"].as_str())
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        advance(&mut tx).await?;
        let cancelled = crate::agent_update_rollouts::cancel_all(&mut tx, "stop", &now).await?;
        audit(
            &mut tx,
            actor["id"].as_str().unwrap_or(""),
            "agent_update.stop",
            SERVER_TARGET,
            "success",
            json!({"reason":reason,"cancelled_rollouts":cancelled.rollouts.len()}),
        )
        .await?;
        asked = cancelled.devices;
    }
    let out = view(&s, &mut tx).await?;
    tx.commit().await?;
    for device in &asked {
        crate::wake::ask(device);
    }
    Ok(Json(out))
}

/// `POST /api/v1/agent-updates/stop/clear {revision}`: an Administrator ends the
/// stop. It resumes nothing.
pub async fn clear(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    guard(&s).await?;
    let request = body(&bytes, &["revision"])?;
    let revision = request
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| ApiError::invalid("revision must be a whole number"))?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let setting = require_on(&mut tx).await?;
    if setting.revision != revision {
        return Err(stale());
    }
    if setting.stopped.is_none() {
        return Err(ApiError::conflict("Agent updates are not stopped."));
    }
    sqlx::query("UPDATE agent_update_settings SET stopped_reason=NULL,stopped_by=NULL,stopped_by_name=NULL,stopped_at=NULL WHERE id=1")
        .execute(&mut *tx)
        .await?;
    advance(&mut tx).await?;
    audit(
        &mut tx,
        actor["id"].as_str().unwrap_or(""),
        "agent_update.stop_clear",
        SERVER_TARGET,
        "success",
        json!({}),
    )
    .await?;
    let out = view(&s, &mut tx).await?;
    tx.commit().await?;
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Turning updates on and off

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Server,
    Offline,
}
impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Server => "server",
            Kind::Offline => "offline",
        }
    }
}
/// What a settings request asks for.
struct Put {
    enabled: bool,
    custody: Option<(Kind, Option<String>)>,
    password: String,
    revision: i64,
}

fn parse_put(bytes: &Bytes) -> Result<Put> {
    let request = body(
        bytes,
        &["enabled", "custody", "current_password", "revision"],
    )?;
    let enabled = request
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| ApiError::invalid("enabled must be true or false"))?;
    let revision = request
        .get("revision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 0)
        .ok_or_else(|| ApiError::invalid("revision must be a whole number"))?;
    let password = keys::password_of(&request)?;
    let custody = match request.get("custody") {
        None | Some(Value::Null) => None,
        Some(Value::Object(fields)) => {
            if let Some(unknown) = fields
                .keys()
                .find(|key| !matches!(key.as_str(), "kind" | "public_key"))
            {
                return Err(ApiError::invalid(format!(
                    "Unknown custody member {unknown}"
                )));
            }
            let kind = match fields.get("kind").and_then(Value::as_str) {
                Some("server") => Kind::Server,
                Some("offline") => Kind::Offline,
                _ => return Err(ApiError::invalid("custody.kind is server or offline")),
            };
            let public_key = match fields.get("public_key") {
                None | Some(Value::Null) => None,
                Some(Value::String(line)) if line.len() <= 4096 => Some(line.clone()),
                Some(_) => return Err(ApiError::invalid("public_key must be a key line")),
            };
            Some((kind, public_key))
        }
        Some(_) => return Err(ApiError::invalid("custody must be an object")),
    };
    if custody.is_some() && !enabled {
        return Err(ApiError::invalid(
            "A custody is chosen when updates are turned on",
        ));
    }
    if matches!(custody, Some((Kind::Server, Some(_)))) {
        return Err(ApiError::invalid(
            "The server generates a key it holds: send no public_key with kind server",
        ));
    }
    Ok(Put {
        enabled,
        custody,
        password,
        revision,
    })
}

fn rollouts_active() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "AGENT_UPDATE_ROLLOUTS_ACTIVE",
        "Agent updates can't be turned off while an update rollout is running or paused. Cancel it, or use Stop all updates.",
    )
}

/// `PUT /api/v1/agent-updates/settings {enabled,custody?,current_password,revision}`:
/// an Administrator, with the password, turns updates on (choosing who holds
/// the release key, once) or off. A request that changes nothing succeeds with
/// no new revision and no audit row.
pub async fn put(AppState(s): AppState<State>, h: HeaderMap, bytes: Bytes) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let request = parse_put(&bytes)?;
    // A key line is read before anything is written: it is refused as a key, not
    // as a request.
    let offline = match &request.custody {
        Some((Kind::Offline, Some(line))) => {
            Some(ReleaseKey::parse(line).map_err(|error| keys::invalid_key(error.reason()))?)
        }
        _ => None,
    };
    let (_, hash) = reauthenticate(&s, &h, &["admin"], &request.password).await?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    let setting = setting(&mut tx).await?;
    if setting.revision != request.revision {
        return Err(stale());
    }
    let current = keys::current(&mut tx).await?;
    let at = instant(Utc::now());
    let actor_id = actor["id"].as_str().unwrap_or("").to_owned();
    // A key made for this request: its sealed file stays only once the
    // transaction has committed.
    let mut generated: Option<keys::Generated<'_>> = None;
    let mut retired: Option<String> = None;
    let mut changed = false;
    if !request.enabled {
        if setting.enabled {
            let active: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM agent_update_rollouts WHERE status IN ('active','paused')",
            )
            .fetch_one(&mut *tx)
            .await?;
            if active > 0 {
                return Err(rollouts_active());
            }
            sqlx::query("UPDATE agent_update_settings SET enabled=0 WHERE id=1")
                .execute(&mut *tx)
                .await?;
            audit(
                &mut tx,
                &actor_id,
                "agent_update.disable",
                SERVER_TARGET,
                "success",
                json!({}),
            )
            .await?;
            changed = true;
        }
    } else {
        // The key this request makes current, with the custody it names, when it
        // makes one.
        let mut made: Option<(ReleaseKey, Kind)> = None;
        let mut new_key = |kind: Kind| -> Result<ReleaseKey> {
            match kind {
                Kind::Server => {
                    let fresh = keys::generate_and_seal(&s)?;
                    let key = fresh.key.clone();
                    generated = Some(fresh);
                    Ok(key)
                }
                Kind::Offline => offline.clone().ok_or_else(|| {
                    ApiError::invalid("custody offline needs the team's public key")
                }),
            }
        };
        match &current {
            None => {
                let (kind, _) = request
                    .custody
                    .as_ref()
                    .ok_or_else(keys::custody_required)?;
                made = Some((new_key(*kind)?, *kind));
            }
            Some(current) => {
                let keeps = |custody: &(Kind, Option<String>)| {
                    custody.0.as_str() == current.custody && custody.1.is_none()
                };
                if setting.enabled {
                    // The custody is fixed while updates are on and a key is current.
                    if request
                        .custody
                        .as_ref()
                        .is_some_and(|custody| !keeps(custody))
                    {
                        return Err(keys::custody_locked());
                    }
                } else if let Some(custody) =
                    request.custody.as_ref().filter(|custody| !keeps(custody))
                {
                    // Another kind, or a new key of the same: it replaces the old
                    // key, which hosts that pinned it leave only by upgrading
                    // their agent, so no statement is made.
                    made = Some((new_key(custody.0)?, custody.0));
                    if current.custody == "server" {
                        retired = Some(current.fingerprint.clone());
                    }
                }
            }
        }
        if let Some((key, kind)) = &made {
            keys::check_unused(&s, &mut tx, key).await?;
            if let Some(current) = &current {
                keys::retire(&mut tx, &current.fingerprint, &at).await?;
            }
            keys::insert_current(&mut tx, key, kind.as_str(), &actor, &at, None).await?;
            keys::switch_current(&mut tx, key.fingerprint(), Some(kind.as_str())).await?;
        }
        if made.is_some() || !setting.enabled {
            sqlx::query("UPDATE agent_update_settings SET enabled=1 WHERE id=1")
                .execute(&mut *tx)
                .await?;
            let (custody, fingerprint) = match (&made, &current) {
                (Some((key, kind)), _) => (kind.as_str().to_owned(), key.fingerprint().to_owned()),
                (None, Some(current)) => (current.custody.clone(), current.fingerprint.clone()),
                (None, None) => (String::new(), String::new()),
            };
            audit(
                &mut tx,
                &actor_id,
                "agent_update.enable",
                SERVER_TARGET,
                "success",
                json!({"custody":custody,"fingerprint":fingerprint}),
            )
            .await?;
            changed = true;
        }
    }
    if changed {
        advance(&mut tx).await?;
    }
    let out = view(&s, &mut tx).await?;
    tx.commit().await?;
    if let Some(fresh) = generated.as_mut() {
        fresh.keep();
    }
    if let Some(old) = retired {
        keys::wipe_seed(&s, &old);
    }
    Ok(Json(out))
}
