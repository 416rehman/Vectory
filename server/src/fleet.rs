//! Fleet-scale reads. A real fleet has thousands of devices, so no page reads
//! all of them: the device inventory is paged, filtered, sorted and counted
//! here, group members page, and the Overview's fleet numbers are computed
//! here instead of in the browser.
//!
//! These reads share one compact projection of the fleet: the device rows as
//! `GET /devices` shows them, reduced to what filters, sorts and counts need.
//! A projection serves one account and role for at most `TTL` and is built
//! once for all of its concurrent requests. Every change made through the
//! dashboard API (any request that isn't a GET) replaces it before the next
//! read, so a caller always sees its own writes; heartbeats and scheduler
//! ticks show up within `TTL`. Rows a page shows are read fresh.
use crate::{
    State, api, auth,
    deployment_history::query,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{self, AtomicU64},
};
use std::time::{Duration, Instant};

/// How long a projection is shared.
pub const TTL: Duration = Duration::from_secs(2);
/// Projections kept at once: one per account and role reading right now.
const MAX_PROJECTIONS: usize = 8;
const DEFAULT_PAGE_SIZE: u64 = 50;
const MAX_PAGE_SIZE: u64 = 100;
/// Longest search, in characters.
const MAX_SEARCH: usize = 100;
/// Most ids `GET /devices/inventory/ids` returns.
pub const MAX_IDS: usize = 10_000;
/// Group names listed per inventory row, and per device on its page.
const ROW_GROUPS: usize = 10;
const DEVICE_GROUPS: usize = 100;
const ATTENTION_DEVICES: usize = 20;
const BUSIEST: usize = 5;
const RUNNING: usize = 20;
const RUNNING_GROUPS: usize = 3;
const CANARY_NAMES: usize = 5;
/// A sample older than this doesn't describe "now" (the dashboard's rule for
/// device rows and fleet throughput).
const FRESH_MS: i64 = 180_000;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
/// JavaScript truthiness, as the dashboard's device model tests fields.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
fn time_ms(value: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|at| at.timestamp_millis())
}
fn iso(ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// The Devices page's status filter values, in its order.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bucket {
    Applied,
    Degraded,
    Held,
    Updating,
    Check,
    Failed,
    Offline,
    Paused,
    Unmanaged,
}
const BUCKETS: [(Bucket, &str); 9] = [
    (Bucket::Applied, "applied"),
    (Bucket::Degraded, "degraded"),
    (Bucket::Held, "held"),
    (Bucket::Updating, "updating"),
    (Bucket::Check, "check"),
    (Bucket::Failed, "failed"),
    (Bucket::Offline, "offline"),
    (Bucket::Paused, "paused"),
    (Bucket::Unmanaged, "unmanaged"),
];
impl Bucket {
    fn index(self) -> usize {
        BUCKETS
            .iter()
            .position(|(bucket, _)| *bucket == self)
            .unwrap()
    }
    /// Problems first, healthy last; revoked devices come after every bucket.
    fn rank(self) -> u8 {
        match self {
            Bucket::Failed => 0,
            Bucket::Degraded => 1,
            Bucket::Check => 2,
            Bucket::Held => 3,
            Bucket::Offline => 4,
            Bucket::Updating => 5,
            Bucket::Paused => 6,
            Bucket::Unmanaged => 7,
            Bucket::Applied => 8,
        }
    }
}
/// The bucket a display state belongs to; none for a revoked device. A state
/// added later reads as in progress rather than healthy.
fn bucket(display: &str) -> Option<Bucket> {
    Some(match display {
        "revoked" => return None,
        "verified" => Bucket::Applied,
        "degraded" => Bucket::Degraded,
        "held" => Bucket::Held,
        "verification_unknown" => Bucket::Check,
        "failed" | "rolled_back" | "conflict" => Bucket::Failed,
        "offline" | "awaiting_first_check_in" => Bucket::Offline,
        "paused" | "pause_requested" => Bucket::Paused,
        "unmanaged" => Bucket::Unmanaged,
        _ => Bucket::Updating,
    })
}
/// Quick views, as `counts.views` names them; bit `i` is `VIEWS[i]`.
const VIEWS: [&str; 5] = [
    "failing",
    "not_on_desired",
    "offline",
    "paused",
    "no_telemetry",
];
const FAILING: u8 = 1;
const NOT_ON_DESIRED: u8 = 2;
const OFFLINE: u8 = 4;
const PAUSED: u8 = 8;
const NO_TELEMETRY: u8 = 16;
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Connection {
    Online,
    Offline,
    Never,
}

/// The open delivery issue of a device that verifiably runs the version it
/// was measured on: the device reads Degraded, "Not delivering".
fn delivery_issue(row: &Value) -> Option<&Value> {
    let summary = &row["data_plane"];
    let measured = summary["version_id"].as_str().filter(|v| !v.is_empty())?;
    if row["status"] != "verified" || row["desired_version_id"].as_str() != Some(measured) {
        return None;
    }
    summary["issues"]
        .as_array()?
        .iter()
        .find(|issue| issue["title"].is_string())
}
/// The state a device's badge shows: Degraded while applied but not
/// delivering, Held while its newest version failed and it keeps running an
/// earlier one, and Pause requested until the agent acknowledges a pause.
fn display_status(row: &Value) -> &str {
    if delivery_issue(row).is_some() {
        return "degraded";
    }
    if truthy(&row["held_on_previous_version"])
        && matches!(text(row, "status"), "failed" | "rolled_back")
    {
        return "held";
    }
    if row["status"] == "paused"
        && !truthy(&row["local_paused"])
        && truthy(&row["sync_paused"])
        && !truthy(&row["pause_acknowledged"])
    {
        return "pause_requested";
    }
    text(row, "status")
}
/// The agent verified the desired version, or last reported it before going
/// offline or pausing.
fn runs_desired(row: &Value) -> bool {
    let status = text(row, "status");
    if !truthy(&row["desired_version_id"]) || status == "revoked" {
        return false;
    }
    status == "verified"
        || (row["apply_state"] == "verified_applied"
            && row["reported_generation"] == row["desired_generation"]
            && matches!(status, "offline" | "paused"))
}
/// "Orders v3", "v3", or none when no version is assigned.
fn version_label(row: &Value) -> Option<String> {
    if !truthy(&row["desired_version_id"]) {
        return None;
    }
    let version = &row["desired_version"];
    let number = match &version["number"] {
        Value::Number(number) => Some(match number.as_i64() {
            Some(whole) => format!("v{whole}"),
            None => format!("v{}", number.as_f64().unwrap_or(0.0)),
        }),
        _ => None,
    };
    let label = [
        version["configuration_name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .map(str::to_owned),
        number,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ");
    Some(if label.is_empty() {
        "Assigned version".to_owned()
    } else {
        label
    })
}
/// Names in the order people expect: case-insensitive, with runs of digits
/// compared by value, so edge-2 sorts before edge-10.
pub(crate) fn natural(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let digits = |chars: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut run = String::new();
                    while let Some(c) = chars.peek().copied().filter(char::is_ascii_digit) {
                        run.push(c);
                        chars.next();
                    }
                    run
                };
                let (m, n) = (digits(&mut x), digits(&mut y));
                let (m, n) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                match m.len().cmp(&n.len()).then_with(|| m.cmp(n)) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(c), Some(d)) => {
                match c.to_lowercase().cmp(d.to_lowercase()) {
                    Ordering::Equal => {}
                    other => return other,
                }
                x.next();
                y.next();
            }
        }
    }
}

/// A group as the projection names it.
struct Group {
    id: String,
    name: String,
}
/// One device, reduced to what filters, sorts, counts and summaries read.
struct Entry {
    id: String,
    name: String,
    revoked: bool,
    /// The state its badge shows.
    display: String,
    /// None for a revoked device.
    bucket: Option<Bucket>,
    views: u8,
    connection: Connection,
    desired_version_id: Option<String>,
    /// The version it verifiably runs right now.
    running_version_id: Option<String>,
    pipeline: Option<String>,
    vector_version: Option<String>,
    /// Lowercased search text: the device's own fields, then its groups.
    search: String,
    /// Length of the device's own part of `search`.
    own: usize,
    /// Indices into `Snapshot::groups`, by group name.
    groups: Vec<usize>,
    last_seen: Option<i64>,
    /// Rates from a fresh sample.
    events_in: Option<f64>,
    events_out: Option<f64>,
}
impl Entry {
    fn new(
        row: &Value,
        running: Option<&str>,
        groups: Vec<usize>,
        names: &[Group],
        now: i64,
    ) -> Self {
        let status = text(row, "status");
        let revoked = status == "revoked";
        let display = display_status(row).to_owned();
        let bucket = bucket(&display);
        let connection = if !truthy(&row["last_seen"]) {
            Connection::Never
        } else if status == "offline" {
            Connection::Offline
        } else {
            Connection::Online
        };
        let sample = &row["telemetry"];
        let fresh = time_ms(&sample["sampled_at"]).is_some_and(|at| now - at <= FRESH_MS);
        let mut views = 0;
        if !revoked {
            if matches!(
                status,
                "failed" | "rolled_back" | "conflict" | "verification_unknown"
            ) || bucket == Some(Bucket::Degraded)
            {
                views |= FAILING;
            }
            if truthy(&row["desired_version_id"]) && !runs_desired(row) {
                views |= NOT_ON_DESIRED;
            }
            if connection != Connection::Online {
                views |= OFFLINE;
            }
            if status == "paused" || truthy(&row["sync_paused"]) || truthy(&row["local_paused"]) {
                views |= PAUSED;
            }
            if !fresh {
                views |= NO_TELEMETRY;
            }
        }
        let pipeline = version_label(row);
        let field = |key: &str| row[key].as_str().filter(|value| !value.is_empty());
        // The Devices page's search text: name, platform, pipeline, Vector
        // and agent versions, then group names.
        let mut search = [
            field("name"),
            field("os"),
            field("arch"),
            pipeline.as_deref(),
            field("vector_version"),
            field("agent_version"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
        let own = search.len();
        for group in &groups {
            if !search.is_empty() {
                search.push(' ');
            }
            search.push_str(&names[*group].name.to_ascii_lowercase());
        }
        Self {
            id: text(row, "id").to_owned(),
            name: text(row, "name").to_owned(),
            revoked,
            display,
            bucket,
            views,
            connection,
            desired_version_id: field("desired_version_id").map(str::to_owned),
            running_version_id: running.map(str::to_owned),
            pipeline,
            vector_version: field("vector_version").map(str::to_owned),
            search,
            own,
            groups,
            last_seen: time_ms(&row["last_seen"]),
            events_in: sample["events_per_second"].as_f64().filter(|_| fresh),
            events_out: sample["events_out_per_second"].as_f64().filter(|_| fresh),
        }
    }
    fn fresh(&self) -> bool {
        self.views & NO_TELEMETRY == 0
    }
}

/// One shared projection of the fleet.
pub struct Snapshot {
    /// In list order (`GET /devices`).
    entries: Vec<Entry>,
    by_id: HashMap<String, usize>,
    /// By name.
    groups: Vec<Group>,
    group_index: HashMap<String, usize>,
    /// The Overview's fields derived from devices.
    overview: Value,
}
impl Snapshot {
    fn names(&self) -> HashMap<&str, &str> {
        self.entries
            .iter()
            .map(|entry| (entry.id.as_str(), entry.name.as_str()))
            .collect()
    }
    fn group_refs(&self, entry: &Entry, limit: usize) -> Value {
        json!({"total":entry.groups.len(),"items":entry.groups.iter().take(limit).map(|g| json!({"id":self.groups[*g].id,"name":self.groups[*g].name})).collect::<Vec<_>>()})
    }
}

/// Shared projections, one per account and role, single-flight per key.
pub struct Cache {
    generation: AtomicU64,
    slots: Mutex<HashMap<String, Slot>>,
    builds: AtomicU64,
    ttl_ms: AtomicU64,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            generation: AtomicU64::new(0),
            slots: Mutex::default(),
            builds: AtomicU64::new(0),
            ttl_ms: AtomicU64::new(TTL.as_millis() as u64),
        }
    }
}
#[derive(Clone)]
struct Slot {
    generation: u64,
    started: Instant,
    cell: Arc<tokio::sync::OnceCell<Arc<Snapshot>>>,
}
impl Cache {
    /// Every later read builds a new projection.
    pub fn invalidate(&self) {
        self.generation.fetch_add(1, atomic::Ordering::SeqCst);
    }
    /// Projections built so far.
    pub fn builds(&self) -> u64 {
        self.builds.load(atomic::Ordering::SeqCst)
    }
    /// How long a projection is shared (`TTL` unless changed, as tests do).
    pub fn set_ttl(&self, ttl: Duration) {
        self.ttl_ms
            .store(ttl.as_millis() as u64, atomic::Ordering::SeqCst);
    }
    async fn snapshot(&self, pool: &sqlx::SqlitePool, reader: &Value) -> Result<Arc<Snapshot>> {
        // Read before building: a projection started before a change is
        // never served after it, even when it finishes later.
        let generation = self.generation.load(atomic::Ordering::SeqCst);
        let ttl = Duration::from_millis(self.ttl_ms.load(atomic::Ordering::SeqCst));
        let key = format!("{}\n{}", text(reader, "id"), text(reader, "role"));
        let now = Instant::now();
        let cell = {
            let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
            // A build still running is joined whatever its age: builds never
            // pile up behind a slow one.
            slots.retain(|_, slot| {
                slot.generation == generation
                    && (slot.cell.get().is_none() || now.duration_since(slot.started) < ttl)
            });
            match slots.get(&key) {
                Some(slot) => slot.cell.clone(),
                None => {
                    if slots.len() >= MAX_PROJECTIONS {
                        if let Some(oldest) = slots
                            .iter()
                            .min_by_key(|(_, slot)| slot.started)
                            .map(|(key, _)| key.clone())
                        {
                            slots.remove(&oldest);
                        }
                    }
                    let slot = Slot {
                        generation,
                        started: now,
                        cell: Arc::default(),
                    };
                    slots.insert(key, slot.clone());
                    slot.cell
                }
            }
        };
        cell.get_or_try_init(|| async {
            self.builds.fetch_add(1, atomic::Ordering::SeqCst);
            let mut tx = pool.begin().await?;
            let (snapshot, _) = build(&mut tx, false).await?;
            tx.rollback().await?;
            Ok::<_, ApiError>(Arc::new(snapshot))
        })
        .await
        .cloned()
    }
}

/// Every group by name, and each device's groups.
async fn groups(db: &mut SqliteConnection) -> Result<(Vec<Group>, HashMap<String, Vec<usize>>)> {
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT id,CASE WHEN json_type(data,'$.name')='text' THEN json_extract(data,'$.name') END,\
         CASE WHEN json_type(data,'$.device_ids')='array' THEN json_extract(data,'$.device_ids') ELSE '[]' END \
         FROM records WHERE kind='group'",
    )
    .fetch_all(&mut *db)
    .await?;
    let mut rows = rows
        .into_iter()
        .map(|(id, name, members)| {
            let members: Vec<Value> = serde_json::from_str(&members).unwrap_or_default();
            (
                Group {
                    id,
                    name: name.unwrap_or_default(),
                },
                members,
            )
        })
        .collect::<Vec<_>>();
    rows.sort_by(|(a, _), (b, _)| natural(&a.name, &b.name).then_with(|| a.id.cmp(&b.id)));
    let mut memberships: HashMap<String, Vec<usize>> = HashMap::new();
    let mut groups = Vec::with_capacity(rows.len());
    for (index, (group, members)) in rows.into_iter().enumerate() {
        for member in members.iter().filter_map(Value::as_str) {
            memberships
                .entry(member.to_owned())
                .or_default()
                .push(index);
        }
        groups.push(group);
    }
    for list in memberships.values_mut() {
        list.dedup();
    }
    Ok((groups, memberships))
}

/// Project the fleet: every device once, then what the Overview derives from
/// it. With `keep_rows` the list rows come back too (the Overview's legacy
/// `devices`).
async fn build(
    db: &mut SqliteConnection,
    keep_rows: bool,
) -> Result<(Snapshot, Option<Vec<Value>>)> {
    let now = Utc::now().timestamp_millis();
    let listed = rollout::listed(db, None).await?;
    let (groups, mut memberships) = groups(db).await?;
    let entries: Vec<Entry> = listed
        .iter()
        .map(|item| {
            let own = memberships
                .remove(text(&item.row, "id"))
                .unwrap_or_default();
            Entry::new(&item.row, item.running.as_deref(), own, &groups, now)
        })
        .collect();
    let by_id = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.id.clone(), index))
        .collect();
    let group_index = groups
        .iter()
        .enumerate()
        .map(|(index, group)| (group.id.clone(), index))
        .collect();
    let mut snapshot = Snapshot {
        entries,
        by_id,
        groups,
        group_index,
        overview: Value::Null,
    };
    snapshot.overview = overview_fields(db, &listed, &snapshot, now).await?;
    let rows = keep_rows.then(|| listed.into_iter().map(|item| item.row).collect());
    Ok((snapshot, rows))
}

async fn overview_fields(
    db: &mut SqliteConnection,
    listed: &[rollout::Listed],
    snapshot: &Snapshot,
    now: i64,
) -> Result<Value> {
    let live: Vec<&Value> = listed
        .iter()
        .map(|item| &item.row)
        .filter(|row| row["status"] != "revoked")
        .collect();
    let mut out = crate::overview::device_aggregates(db, &live).await?;
    let (attention, attention_total) = attention_devices(listed, &snapshot.entries);
    let (running, running_total) = running(db, listed, snapshot).await?;
    crate::overview::merge(
        &mut out,
        json!({
            "devices_total": listed.len(),
            "devices_online": listed.iter().filter(|item| !matches!(text(&item.row, "status"), "offline" | "revoked" | "awaiting_first_check_in")).count(),
            "counts": counts(listed, &snapshot.entries, now),
            "attention_devices": attention,
            "attention_devices_total": attention_total,
            "busiest": busiest(listed, &snapshot.entries, now),
            "running": running,
            "running_total": running_total,
        }),
    );
    Ok(out)
}

/// What the Overview used to derive from every device in the browser: fleet
/// health by bucket, connection, and throughput from fresh samples.
fn counts(listed: &[rollout::Listed], entries: &[Entry], now: i64) -> Value {
    let (mut total, mut health) = (0u64, [0u64; BUCKETS.len()]);
    let (mut online, mut offline, mut never, mut checked_in) = (0u64, 0u64, 0u64, 0u64);
    let mut waiting = Value::Null;
    let (mut eligible, mut reporting, mut stale, mut disabled) = (0u64, 0u64, 0u64, 0u64);
    let (mut rate, mut rate_devices, mut out, mut out_devices) = (0f64, 0u64, 0f64, 0u64);
    let (mut errors, mut error_devices, mut error_rate, mut error_rate_devices) =
        (0f64, 0u64, 0f64, 0u64);
    let mut newest: Option<i64> = None;
    for (item, entry) in listed.iter().zip(entries) {
        if entry.revoked {
            continue;
        }
        let row = &item.row;
        total += 1;
        if let Some(bucket) = entry.bucket {
            health[bucket.index()] += 1;
        }
        match entry.connection {
            Connection::Online => online += 1,
            Connection::Offline => offline += 1,
            Connection::Never => never += 1,
        }
        if truthy(&row["last_seen"]) {
            checked_in += 1;
        } else if waiting.is_null() {
            waiting = json!({"id":entry.id,"name":entry.name});
        }
        eligible += 1;
        let sample = &row["telemetry"];
        let sampled = time_ms(&sample["sampled_at"]);
        let Some(at) = sampled.filter(|at| now - at <= FRESH_MS) else {
            if sampled.is_some() {
                stale += 1;
            }
            if row["effective_policy"]["telemetry_enabled"] == false {
                disabled += 1;
            }
            continue;
        };
        reporting += 1;
        newest = Some(newest.map_or(at, |newest| newest.max(at)));
        if let Some(value) = sample["events_per_second"].as_f64() {
            rate += value;
            rate_devices += 1;
        }
        if let Some(value) = sample["events_out_per_second"].as_f64() {
            out += value;
            out_devices += 1;
        }
        if let Some(value) = sample["errors"].as_f64() {
            errors += value;
            error_devices += 1;
        }
        if let Some(value) = sample["errors_per_minute"].as_f64() {
            error_rate += value;
            error_rate_devices += 1;
        }
    }
    let sum = |value: f64, devices: u64| (devices > 0).then_some(value);
    json!({
        "total": total,
        "health": BUCKETS.iter().map(|(bucket, name)| (name.to_string(), json!(health[bucket.index()]))).collect::<serde_json::Map<_, _>>(),
        "connection": {"online":online,"offline":offline,"never":never},
        "checked_in": checked_in,
        "waiting_device": waiting,
        "telemetry": {
            "eligible": eligible,
            "reporting": reporting,
            "stale": stale,
            "disabled": disabled,
            "events_in_per_second": sum(rate, rate_devices),
            "events_in_devices": rate_devices,
            "events_out_per_second": sum(out, out_devices),
            "events_out_devices": out_devices,
            "errors": sum(errors, error_devices),
            "errors_per_minute": sum(error_rate, error_rate_devices),
            "newest_sample_at": newest.and_then(iso),
        },
    })
}

/// The busiest live devices by events in per second from a fresh sample,
/// with what they deliver.
fn busiest(listed: &[rollout::Listed], entries: &[Entry], now: i64) -> Vec<Value> {
    let mut top: Vec<(&Entry, f64, Value)> = listed
        .iter()
        .zip(entries)
        .filter(|(_, entry)| !entry.revoked)
        .filter_map(|(item, entry)| {
            let sample = &item.row["telemetry"];
            time_ms(&sample["sampled_at"]).filter(|at| now - at <= FRESH_MS)?;
            let rate = sample["events_per_second"].as_f64()?;
            Some((entry, rate, json!(sample["events_out_per_second"].as_f64())))
        })
        .collect();
    // Stable: equal rates keep list order.
    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    top.into_iter()
        .take(BUSIEST)
        .map(|(entry, rate, out)| json!({"id":entry.id,"name":entry.name,"events_in_per_second":rate,"events_out_per_second":out}))
        .collect()
}

/// Devices that need a person, most urgent first: not delivering, failed or
/// rolled back, a check required, held on a previous version, offline. At most
/// `ATTENTION_DEVICES`, and how many there are.
fn attention_devices(listed: &[rollout::Listed], entries: &[Entry]) -> (Vec<Value>, usize) {
    let mut found: Vec<(u8, &'static str, usize)> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        if entry.revoked {
            continue;
        }
        let cause = if entry.bucket == Some(Bucket::Degraded) {
            (0, "degraded")
        } else if entry.bucket == Some(Bucket::Held) {
            (4, "held")
        } else {
            match text(&listed[index].row, "status") {
                "failed" => (1, "failed"),
                "rolled_back" => (2, "rolled_back"),
                "verification_unknown" => (3, "check_required"),
                "offline" => (5, "offline"),
                _ => continue,
            }
        };
        found.push((cause.0, cause.1, index));
    }
    found.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| natural(&entries[a.2].name, &entries[b.2].name))
            .then_with(|| entries[a.2].id.cmp(&entries[b.2].id))
    });
    let total = found.len();
    let items = found
        .into_iter()
        .take(ATTENTION_DEVICES)
        .map(|(_, cause, index)| {
            let (entry, row) = (&entries[index], &listed[index].row);
            let version = &row["desired_version"];
            let mut item = json!({"id":entry.id,"name":entry.name,"cause":cause,"status":entry.display,
                "reason":null,"title":null,"fix":null,"code":null,"component_id":null,"since":null,
                "version_id":row["desired_version_id"],"version_number":version["number"],
                "configuration_id":version["configuration_id"],"configuration_name":version["configuration_name"]});
            match cause {
                "degraded" => {
                    if let Some(issue) = crate::overview::data_plane_issue(row) {
                        item["title"] = issue["title"].clone();
                        item["reason"] = issue["message"].clone();
                        item["fix"] = issue["hint"].clone();
                        item["code"] = issue["code"].clone();
                        item["component_id"] = issue["component_id"].clone();
                        item["since"] = issue["since"].clone();
                    }
                }
                "failed" | "rolled_back" | "held" => {
                    item["reason"] = json!(crate::overview::failure_summary(row));
                    item["code"] = row["configuration_attempt"]["error"]["code"].clone();
                }
                "offline" => item["since"] = row["last_seen"].clone(),
                _ => {}
            }
            item
        })
        .collect();
    (items, total)
}

/// What runs where: one row per pipeline version live devices verifiably run
/// (as they last reported it), most devices first. At most `RUNNING`, and
/// how many versions run.
async fn running(
    db: &mut SqliteConnection,
    listed: &[rollout::Listed],
    snapshot: &Snapshot,
) -> Result<(Vec<Value>, usize)> {
    let entries = &snapshot.entries;
    let mut by_version: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(version) = entry.running_version_id.as_deref() else {
            continue;
        };
        // Only a published version of an existing pipeline counts.
        let label = &listed[index].row["running_version"];
        if !entry.revoked && label["id"] == version && label["configuration_id"].is_string() {
            by_version.entry(version).or_default().push(index);
        }
    }
    let total = by_version.len();
    let label = |devices: &[usize]| &listed[devices[0]].row["running_version"];
    let mut rows: Vec<(&str, Vec<usize>)> = by_version.into_iter().collect();
    rows.sort_by(|(a, x), (b, y)| {
        let (l, m) = (label(x), label(y));
        y.len()
            .cmp(&x.len())
            .then_with(|| {
                match (
                    l["configuration_name"].as_str(),
                    m["configuration_name"].as_str(),
                ) {
                    (Some(l), Some(m)) => natural(l, m),
                    // Unnamed last.
                    (l, m) => l.is_none().cmp(&m.is_none()),
                }
            })
            .then_with(|| m["number"].as_i64().cmp(&l["number"].as_i64()))
            .then_with(|| a.cmp(b))
    });
    rows.truncate(RUNNING);
    let canaries = canaries(db, &rows, snapshot).await?;
    let items = rows
        .iter()
        .map(|(version, devices)| {
            let label = label(devices);
            let mut held: BTreeMap<usize, usize> = BTreeMap::new();
            for device in devices {
                for group in &entries[*device].groups {
                    *held.entry(*group).or_default() += 1;
                }
            }
            let mut groups: Vec<(usize, usize)> = held.into_iter().collect();
            groups.sort_by(|a, b| {
                b.1.cmp(&a.1).then_with(|| {
                    natural(&snapshot.groups[a.0].name, &snapshot.groups[b.0].name)
                })
            });
            let reporting = devices.iter().filter(|d| entries[**d].fresh()).count();
            let sum = |rate: fn(&Entry) -> Option<f64>| {
                devices
                    .iter()
                    .filter_map(|d| rate(&entries[*d]))
                    .fold(None, |total: Option<f64>, value| Some(total.unwrap_or(0.0) + value))
            };
            let not_delivering = devices
                .iter()
                .filter(|d| entries[**d].bucket == Some(Bucket::Degraded))
                .count();
            let canary = canaries.get(*version).cloned().unwrap_or(Value::Null);
            let state = if not_delivering > 0 {
                "not_delivering"
            } else if !canary.is_null() {
                "canary"
            } else {
                "running"
            };
            json!({
                "configuration_id": label["configuration_id"],
                "configuration_name": label["configuration_name"],
                "version_id": version,
                "version": label["number"],
                "device_count": devices.len(),
                "devices_reporting": reporting,
                "groups": groups.iter().take(RUNNING_GROUPS).map(|(group, count)| json!({"id":snapshot.groups[*group].id,"name":snapshot.groups[*group].name,"device_count":count})).collect::<Vec<_>>(),
                "more_groups": groups.len().saturating_sub(RUNNING_GROUPS),
                "events_in_per_second": sum(|entry| entry.events_in),
                "events_out_per_second": sum(|entry| entry.events_out),
                "state": state,
                "not_delivering": not_delivering,
                "canary": canary,
            })
        })
        .collect();
    Ok((items, total))
}

/// Released devices of a canary rollout the Overview looks at: fewer than the
/// gate reads at once, so one read covers them.
const CANARY_SAMPLE: i64 = 50;
/// The newest active canary rollout of each running version, with the devices
/// it released and what its gate is doing: observing once every released
/// device verified (as the scheduler recorded it), otherwise measuring while
/// one of the first released devices still has its delivery measured.
async fn canaries(
    db: &mut SqliteConnection,
    rows: &[(&str, Vec<usize>)],
    snapshot: &Snapshot,
) -> Result<HashMap<String, Value>> {
    let mut out = HashMap::new();
    if rows.is_empty() {
        return Ok(out);
    }
    let versions: Vec<&str> = rows.iter().map(|(version, _)| *version).collect();
    let rollouts: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,json_extract(data,'$.version_id') FROM records WHERE kind='deployment' \
         AND json_extract(data,'$.status')='active' AND json_extract(data,'$.rollout.kind')='canary' \
         AND json_extract(data,'$.version_id') IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id",
    )
    .bind(json!(versions).to_string())
    .fetch_all(&mut *db)
    .await?;
    for (id, version) in rollouts {
        if out.contains_key(&version) {
            continue;
        }
        let released_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM deployment_targets WHERE deployment_id=? AND generation>0 AND state<>'removed'",
        )
        .bind(&id)
        .fetch_one(&mut *db)
        .await?;
        let released: BTreeSet<String> = sqlx::query_scalar(
            "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation>0 AND state<>'removed' ORDER BY device_id LIMIT ?",
        )
        .bind(&id)
        .bind(CANARY_SAMPLE)
        .fetch_all(&mut *db)
        .await?
        .into_iter()
        .collect();
        let context = crate::canary_gate::load(db, &id).await?;
        let phase = if context["observation_started_at"].is_string() {
            "observing"
        } else if crate::canary_gate::evaluate(db, &context, Some(&released))
            .await?
            .reasons
            .get("measuring")
            .is_some_and(|measuring| *measuring > 0)
        {
            "measuring"
        } else {
            "waiting"
        };
        let mut names: Vec<&str> = released
            .iter()
            .filter_map(|device| snapshot.by_id.get(device))
            .map(|index| snapshot.entries[*index].name.as_str())
            .collect();
        names.sort_by(|a, b| natural(a, b));
        out.insert(
            version,
            json!({"deployment_id":id,"phase":phase,"device_count":released_count,"device_names":names.into_iter().take(CANARY_NAMES).collect::<Vec<_>>()}),
        );
    }
    Ok(out)
}

/// `GET /overview`: fleet numbers, rollouts and recent changes. By default it
/// keeps its original `devices` list, read fresh; `slim=1` drops the list and
/// takes the fleet numbers from the shared projection.
pub(crate) async fn overview(
    s: &State,
    reader: &Value,
    raw: Option<&str>,
    parsed: std::result::Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Result<Value> {
    let options = legacy_options(raw, parsed, &["slim"])?;
    let slim = flag(&options, "slim")?;
    let (snapshot, rows) = if slim {
        (s.fleet.snapshot(&s.pool, reader).await?, None)
    } else {
        let mut tx = s.pool.begin().await?;
        let (snapshot, rows) = build(&mut tx, true).await?;
        tx.rollback().await?;
        (Arc::new(snapshot), rows)
    };
    let mut conn = s.pool.acquire().await?;
    let configurations: i64 =
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='configuration'")
            .fetch_one(&mut *conn)
            .await?;
    let deployments_active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='deployment' AND json_extract(data,'$.status') IN ('active','paused')",
    )
    .fetch_one(&mut *conn)
    .await?;
    let issues_open = crate::issues::open_count(&mut conn).await?;
    let audit = api::recent_activity(&mut conn).await?;
    let mut overview = json!({"configurations_total":configurations,"deployments_active":deployments_active,"issues_open":issues_open,"recent_activity":audit});
    crate::overview::merge(&mut overview, snapshot.overview.clone());
    crate::overview::merge(
        &mut overview,
        crate::overview::activity(&mut conn, &snapshot.names()).await?,
    );
    if let Some(rows) = rows {
        overview["devices"] = json!(rows);
    }
    Ok(overview)
}

/// New options on routes that predate them. Without a query string the route
/// behaves as before; unknown parameters are still ignored, but a malformed
/// query or a repeated option is refused.
fn legacy_options(
    raw: Option<&str>,
    parsed: std::result::Result<Query<Vec<(String, String)>>, QueryRejection>,
    known: &[&'static str],
) -> Result<HashMap<&'static str, String>> {
    let mut options = HashMap::new();
    if raw.is_none_or(str::is_empty) {
        return Ok(options);
    }
    for (key, value) in query(raw, parsed)? {
        if let Some(known) = known.iter().copied().find(|known| *known == key) {
            if options.insert(known, value).is_some() {
                return Err(ApiError::invalid("Invalid query parameters"));
            }
        }
    }
    Ok(options)
}
fn flag(options: &HashMap<&'static str, String>, key: &str) -> Result<bool> {
    match options.get(key).map(String::as_str) {
        None | Some("0" | "false") => Ok(false),
        Some("1" | "true") => Ok(true),
        Some(_) => Err(ApiError::invalid(format!("{key} must be 1 or 0"))),
    }
}

/// `GET /groups`: every group with `member_count`. Its `device_ids` stay
/// unless `slim=1`; `include=members` asks for them explicitly.
pub(crate) async fn group_list(
    conn: &mut SqliteConnection,
    raw: Option<&str>,
    parsed: std::result::Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Result<Value> {
    let options = legacy_options(raw, parsed, &["slim", "include"])?;
    let slim = flag(&options, "slim")?;
    match options.get("include").map(String::as_str) {
        None => {}
        Some("members") if !slim => {}
        Some("members") => {
            return Err(ApiError::invalid(
                "slim=1 leaves member lists out; drop include=members or slim",
            ));
        }
        Some(_) => return Err(ApiError::invalid("include must be members")),
    }
    if !slim {
        let mut groups = crate::groups::list(conn).await?;
        for group in &mut groups {
            group["member_count"] = json!(group["device_ids"].as_array().map_or(0, Vec::len));
        }
        return Ok(json!(groups));
    }
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT json_remove(data,'$.device_ids'),CASE WHEN json_type(data,'$.device_ids')='array' THEN json_array_length(data,'$.device_ids') ELSE 0 END \
         FROM records WHERE kind='group' ORDER BY created_at DESC,id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let groups = rows
        .into_iter()
        .map(|(data, members)| {
            let mut group = crate::groups::normalized(crate::db::parse(&data)?)?;
            group["member_count"] = json!(members);
            Ok(group)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!(groups))
}

/// `include=groups` on `GET /devices/{id}`.
pub(crate) fn wants_groups(
    raw: Option<&str>,
    parsed: std::result::Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Result<bool> {
    let options = legacy_options(raw, parsed, &["include"])?;
    match options.get("include").map(String::as_str) {
        None => Ok(false),
        Some("groups") => Ok(true),
        Some(_) => Err(ApiError::invalid("include must be groups")),
    }
}
/// The groups one device belongs to, read fresh: at most `DEVICE_GROUPS` by
/// name, and how many there are.
pub(crate) async fn device_groups(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let mut rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT g.id,CASE WHEN json_type(g.data,'$.name')='text' THEN json_extract(g.data,'$.name') END FROM records g \
         WHERE g.kind='group' AND json_type(g.data,'$.device_ids')='array' \
         AND EXISTS(SELECT 1 FROM json_each(g.data,'$.device_ids') m WHERE m.value=?)",
    )
    .bind(id)
    .fetch_all(&mut *db)
    .await?;
    rows.sort_by(|a, b| {
        natural(a.1.as_deref().unwrap_or(""), b.1.as_deref().unwrap_or(""))
            .then_with(|| a.0.cmp(&b.0))
    });
    Ok(
        json!({"total":rows.len(),"items":rows.into_iter().take(DEVICE_GROUPS).map(|(id, name)| json!({"id":id,"name":name.unwrap_or_default()})).collect::<Vec<_>>()}),
    )
}

fn page_bounds(page: Option<u64>, size: Option<u64>) -> Result<(u64, u64, usize)> {
    let page = page.unwrap_or(1);
    let size = size.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=9_007_199_254_740_991).contains(&page) || !(1..=MAX_PAGE_SIZE).contains(&size) {
        return Err(ApiError::invalid(
            "page must be a positive safe integer and page_size must be 1..100",
        ));
    }
    let offset = (page - 1)
        .checked_mul(size)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| ApiError::invalid("page is too large"))?;
    Ok((page, size, offset))
}
/// A literal search: trimmed, ASCII case-insensitive, other characters exact.
fn search(value: Option<&str>) -> Result<String> {
    let value = value.unwrap_or("").trim();
    if value.chars().count() > MAX_SEARCH {
        return Err(ApiError::invalid("Search must be at most 100 characters"));
    }
    Ok(value.to_ascii_lowercase())
}
/// An optional exact identifier; an empty value is no filter.
fn uuid(value: Option<&str>, name: &str) -> Result<Option<String>> {
    match value.filter(|value| !value.is_empty()) {
        None => Ok(None),
        Some(value) => uuid::Uuid::parse_str(value)
            .ok()
            .map(|parsed| parsed.hyphenated().to_string())
            .filter(|parsed| parsed == value)
            .map(Some)
            .ok_or_else(|| ApiError::invalid(format!("{name} must be a lowercase UUID"))),
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InventoryQuery {
    page: Option<u64>,
    page_size: Option<u64>,
    q: Option<String>,
    status: Option<String>,
    view: Option<String>,
    group: Option<String>,
    version: Option<String>,
    desired_version: Option<String>,
    running_version: Option<String>,
    sort: Option<String>,
    dir: Option<String>,
}
impl InventoryQuery {
    fn filters(self) -> FilterQuery {
        FilterQuery {
            q: self.q,
            status: self.status,
            view: self.view,
            group: self.group,
            version: self.version,
            desired_version: self.desired_version,
            running_version: self.running_version,
            sort: self.sort,
            dir: self.dir,
        }
    }
}
/// The inventory's filters and order, which its ids share.
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilterQuery {
    q: Option<String>,
    status: Option<String>,
    view: Option<String>,
    group: Option<String>,
    version: Option<String>,
    desired_version: Option<String>,
    running_version: Option<String>,
    sort: Option<String>,
    dir: Option<String>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Bucket(Bucket),
    Revoked,
}
#[derive(Clone, Copy)]
enum Sort {
    Name,
    Status,
    LastSeen,
    Pipeline,
    Version,
    EventsIn,
}
struct Filter {
    q: String,
    status: Option<Status>,
    view: Option<u8>,
    group: Option<String>,
    version: Option<String>,
    desired_version: Option<String>,
    running_version: Option<String>,
    sort: Sort,
    descending: bool,
}
/// A filter value; an empty one is no filter.
fn given(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}
impl Filter {
    fn parse(input: &FilterQuery) -> Result<Self> {
        let status = match given(&input.status) {
            None => None,
            Some("revoked") => Some(Status::Revoked),
            Some(value) => Some(Status::Bucket(
                BUCKETS
                    .iter()
                    .find(|(_, name)| *name == value)
                    .map(|(bucket, _)| *bucket)
                    .ok_or_else(|| {
                        ApiError::invalid(
                            "status must be applied, degraded, held, updating, check, failed, offline, paused, unmanaged or revoked",
                        )
                    })?,
            )),
        };
        let view = match given(&input.view) {
            None => None,
            Some(value) => Some(
                VIEWS
                    .iter()
                    .position(|view| *view == value)
                    .map(|index| 1u8 << index)
                    .ok_or_else(|| {
                        ApiError::invalid(
                            "view must be failing, not_on_desired, offline, paused or no_telemetry",
                        )
                    })?,
            ),
        };
        let version = match given(&input.version) {
            Some(value) if value.chars().count() > 64 => {
                return Err(ApiError::invalid("version must be at most 64 characters"));
            }
            value => value.map(str::to_owned),
        };
        let sort = match given(&input.sort).unwrap_or("name") {
            "name" => Sort::Name,
            "status" => Sort::Status,
            "last_seen" => Sort::LastSeen,
            "pipeline" => Sort::Pipeline,
            "version" => Sort::Version,
            "events_in" => Sort::EventsIn,
            _ => {
                return Err(ApiError::invalid(
                    "sort must be name, status, last_seen, pipeline, version or events_in",
                ));
            }
        };
        let descending = match given(&input.dir) {
            // Times and rates read newest and busiest first.
            None => matches!(sort, Sort::LastSeen | Sort::EventsIn),
            Some("asc") => false,
            Some("desc") => true,
            Some(_) => return Err(ApiError::invalid("dir must be asc or desc")),
        };
        Ok(Self {
            q: search(input.q.as_deref())?,
            status,
            view,
            group: uuid(input.group.as_deref(), "group")?,
            version,
            desired_version: uuid(input.desired_version.as_deref(), "desired_version")?,
            running_version: uuid(input.running_version.as_deref(), "running_version")?,
            sort,
            descending,
        })
    }
    /// The search and scope filters, which the counts follow.
    fn scope(&self, snapshot: &Snapshot, entry: &Entry) -> bool {
        (self.q.is_empty() || entry.search.contains(&self.q))
            && self.group.as_ref().is_none_or(|group| {
                snapshot
                    .group_index
                    .get(group)
                    .is_some_and(|group| entry.groups.contains(group))
            })
            && self
                .version
                .as_ref()
                .is_none_or(|version| entry.vector_version.as_ref() == Some(version))
            && self
                .desired_version
                .as_ref()
                .is_none_or(|version| entry.desired_version_id.as_ref() == Some(version))
            && self
                .running_version
                .as_ref()
                .is_none_or(|version| entry.running_version_id.as_ref() == Some(version))
    }
    /// The status and view chips. Revoked devices appear only for status=revoked.
    fn chips(&self, entry: &Entry) -> bool {
        (match self.status {
            None => !entry.revoked,
            Some(Status::Revoked) => entry.revoked,
            Some(Status::Bucket(bucket)) => entry.bucket == Some(bucket),
        }) && self.view.is_none_or(|view| entry.views & view != 0)
    }
    fn compare(&self, a: &Entry, b: &Entry) -> Ordering {
        // Missing values stay last in both directions.
        fn present<T>(
            a: Option<T>,
            b: Option<T>,
            descending: bool,
            order: impl Fn(&T, &T) -> Ordering,
        ) -> Ordering {
            match (a, b) {
                (Some(a), Some(b)) => {
                    let order = order(&a, &b);
                    if descending { order.reverse() } else { order }
                }
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (None, None) => Ordering::Equal,
            }
        }
        let rank = |entry: &Entry| entry.bucket.map_or(BUCKETS.len() as u8, Bucket::rank);
        let d = self.descending;
        match self.sort {
            Sort::Name => present(Some(&a.name), Some(&b.name), d, |a, b| natural(a, b)),
            Sort::Status => present(Some(rank(a)), Some(rank(b)), d, Ord::cmp),
            Sort::LastSeen => present(a.last_seen, b.last_seen, d, Ord::cmp),
            Sort::Pipeline => present(a.pipeline.as_deref(), b.pipeline.as_deref(), d, |a, b| {
                natural(a, b)
            }),
            Sort::Version => present(
                a.vector_version.as_deref(),
                b.vector_version.as_deref(),
                d,
                |a, b| natural(a, b),
            ),
            Sort::EventsIn => present(a.events_in, b.events_in, d, |a, b| {
                a.partial_cmp(b).unwrap_or(Ordering::Equal)
            }),
        }
        .then_with(|| natural(&a.name, &b.name))
        .then_with(|| a.id.cmp(&b.id))
    }
    /// The matching devices in order, and the counts for the chips.
    fn select(&self, snapshot: &Snapshot) -> (Vec<usize>, Value) {
        let (mut health, mut revoked, mut views) = ([0u64; BUCKETS.len()], 0u64, [0u64; 5]);
        let mut matching = Vec::new();
        for (index, entry) in snapshot.entries.iter().enumerate() {
            if !self.scope(snapshot, entry) {
                continue;
            }
            match entry.bucket {
                None => revoked += 1,
                Some(bucket) => health[bucket.index()] += 1,
            }
            for (bit, count) in views.iter_mut().enumerate() {
                if entry.views & (1 << bit) != 0 {
                    *count += 1;
                }
            }
            if self.chips(entry) {
                matching.push(index);
            }
        }
        let entries = &snapshot.entries;
        matching.sort_by(|a, b| self.compare(&entries[*a], &entries[*b]));
        let mut status: serde_json::Map<String, Value> = BUCKETS
            .iter()
            .map(|(bucket, name)| (name.to_string(), json!(health[bucket.index()])))
            .collect();
        status.insert("revoked".into(), json!(revoked));
        let views: serde_json::Map<String, Value> = VIEWS
            .iter()
            .zip(views)
            .map(|(name, count)| (name.to_string(), json!(count)))
            .collect();
        (matching, json!({"status":status,"views":views}))
    }
}

/// `GET /devices/inventory`: one page of devices as lists show them, with
/// the counts for the filter chips.
pub async fn inventory(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<InventoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let reader = auth::authorize(&s, &headers, &[], false).await?;
    let input = query(raw.as_deref(), parsed)?;
    let (page, size, offset) = page_bounds(input.page, input.page_size)?;
    let filter = Filter::parse(&input.filters())?;
    let snapshot = s.fleet.snapshot(&s.pool, &reader).await?;
    let (matching, counts) = filter.select(&snapshot);
    let shown: Vec<&Entry> = matching
        .iter()
        .skip(offset)
        .take(size as usize)
        .map(|index| &snapshot.entries[*index])
        .collect();
    let ids: Vec<String> = shown.iter().map(|entry| entry.id.clone()).collect();
    let mut rows: HashMap<String, Value> = HashMap::new();
    if !ids.is_empty() {
        let mut conn = s.pool.acquire().await?;
        for item in rollout::listed(&mut conn, Some(&ids)).await? {
            rows.insert(text(&item.row, "id").to_owned(), item.row);
        }
    }
    let items: Vec<Value> = ids.iter().filter_map(|id| rows.remove(id)).collect();
    let groups: serde_json::Map<String, Value> = shown
        .iter()
        .map(|entry| (entry.id.clone(), snapshot.group_refs(entry, ROW_GROUPS)))
        .collect();
    Ok(Json(
        json!({"items":items,"total":matching.len(),"page":page,"page_size":size,"counts":counts,"device_groups":groups}),
    ))
}

/// `GET /devices/inventory/ids`: every device the same filters match, for
/// "select all matching", in the same order.
pub async fn inventory_ids(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<FilterQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let reader = auth::authorize(&s, &headers, &[], false).await?;
    let input = query(raw.as_deref(), parsed)?;
    let filter = Filter::parse(&input)?;
    let snapshot = s.fleet.snapshot(&s.pool, &reader).await?;
    let (matching, _) = filter.select(&snapshot);
    Ok(Json(ids_page(&snapshot, &matching, MAX_IDS)))
}
fn ids_page(snapshot: &Snapshot, matching: &[usize], limit: usize) -> Value {
    json!({"ids":matching.iter().take(limit).map(|index| &snapshot.entries[*index].id).collect::<Vec<_>>(),"total":matching.len(),"truncated":matching.len() > limit})
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MembersQuery {
    page: Option<u64>,
    page_size: Option<u64>,
    q: Option<String>,
}
/// `GET /groups/{id}/members`: one page of a group's members by name, each
/// with the state its badge shows. Membership is read fresh; names and
/// states come from the shared projection.
pub async fn members(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<MembersQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let reader = auth::authorize(&s, &headers, &[], false).await?;
    let input = query(raw.as_deref(), parsed)?;
    let (page, size, offset) = page_bounds(input.page, input.page_size)?;
    let q = search(input.q.as_deref())?;
    let snapshot = s.fleet.snapshot(&s.pool, &reader).await?;
    let mut conn = s.pool.acquire().await?;
    let stored: String = sqlx::query_scalar(
        "SELECT CASE WHEN json_type(data,'$.device_ids')='array' THEN json_extract(data,'$.device_ids') ELSE '[]' END FROM records WHERE kind='group' AND id=?",
    )
    .bind(&id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ApiError::missing)?;
    drop(conn);
    let stored: Vec<Value> = serde_json::from_str(&stored).unwrap_or_default();
    let mut members: Vec<(&str, Option<&Entry>)> = stored
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|member| {
            let entry = snapshot
                .by_id
                .get(member)
                .map(|index| &snapshot.entries[*index]);
            (member, entry)
        })
        .filter(|(_, entry)| {
            q.is_empty() || entry.is_some_and(|entry| entry.search[..entry.own].contains(&q))
        })
        .collect();
    members.sort_by(|(a, x), (b, y)| match (x, y) {
        (Some(x), Some(y)) => natural(&x.name, &y.name).then_with(|| a.cmp(b)),
        (x, y) => x.is_none().cmp(&y.is_none()).then_with(|| a.cmp(b)),
    });
    let items: Vec<Value> = members
        .iter()
        .skip(offset)
        .take(size as usize)
        .map(|(id, entry)| match entry {
            Some(entry) => json!({"id":id,"name":entry.name,"status":entry.display}),
            // A member the projection doesn't know yet, or no longer knows.
            None => json!({"id":id,"name":null,"status":"unavailable"}),
        })
        .collect();
    Ok(Json(
        json!({"items":items,"total":members.len(),"page":page,"page_size":size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(fields: Value) -> Value {
        let mut row = json!({"id":"d","name":"edge-01","status":"verified","desired_version_id":"v2","desired_generation":2,"reported_generation":2,"apply_state":"verified_applied","last_seen":"2026-09-29T00:00:00Z","sync_paused":false});
        for (key, value) in fields.as_object().unwrap() {
            row[key] = value.clone();
        }
        row
    }
    fn entry(fields: Value) -> Entry {
        let now = time_ms(&json!("2026-09-29T00:01:00Z")).unwrap();
        Entry::new(&row(fields), None, Vec::new(), &[], now)
    }

    #[test]
    fn display_state_bucket_and_views_follow_the_dashboard_model() {
        let issue = json!({"title":"out can't deliver events"});
        // Applied, but not delivering on the version it runs.
        let degraded = entry(json!({"data_plane":{"version_id":"v2","issues":[issue]}}));
        assert_eq!(degraded.display, "degraded");
        assert_eq!(degraded.bucket, Some(Bucket::Degraded));
        assert_ne!(degraded.views & FAILING, 0);
        assert_eq!(degraded.views & NOT_ON_DESIRED, 0);
        // An issue measured on another version, or without a title, isn't current.
        for data_plane in [
            json!({"version_id":"v1","issues":[issue]}),
            json!({"version_id":"v2","issues":[{"code":"X"}]}),
            json!({"version_id":"","issues":[issue]}),
        ] {
            assert_eq!(
                entry(json!({ "data_plane": data_plane })).display,
                "verified"
            );
        }
        let requested = entry(json!({"status":"paused","sync_paused":true}));
        assert_eq!(requested.display, "pause_requested");
        assert_eq!(requested.bucket, Some(Bucket::Paused));
        let acknowledged =
            entry(json!({"status":"paused","sync_paused":true,"pause_acknowledged":true}));
        assert_eq!(acknowledged.display, "paused");
        // Never connected is offline, not updating.
        let never = entry(json!({"status":"awaiting_first_check_in","last_seen":null}));
        assert_eq!(never.bucket, Some(Bucket::Offline));
        assert_eq!(never.connection, Connection::Never);
        assert_ne!(never.views & OFFLINE, 0);
        // Offline but last verified on the desired version still runs it.
        let offline = entry(json!({"status":"offline"}));
        assert_eq!(offline.views & NOT_ON_DESIRED, 0);
        let behind = entry(json!({"status":"offline","reported_generation":1}));
        assert_ne!(behind.views & NOT_ON_DESIRED, 0);
        let failed = entry(json!({"status":"failed"}));
        assert_eq!(failed.bucket, Some(Bucket::Failed));
        assert_ne!(failed.views & (FAILING | NOT_ON_DESIRED), 0);
        // Failed to take its newest version but verifiably running an earlier
        // one and delivering: held there, amber, still off its desired version
        // and still among the devices that need a look.
        for status in ["failed", "rolled_back"] {
            let held = entry(json!({"status":status,"held_on_previous_version":true}));
            assert_eq!(held.display, "held", "{status}");
            assert_eq!(held.bucket, Some(Bucket::Held));
            assert_ne!(held.views & (FAILING | NOT_ON_DESIRED), 0);
        }
        // The flag only softens a failure; nothing else turns into held.
        for status in ["verified", "offline", "paused", "unmanaged"] {
            let row = entry(json!({"status":status,"held_on_previous_version":true}));
            assert_ne!(row.display, "held", "{status}");
        }
        assert_eq!(
            entry(json!({"status":"failed","held_on_previous_version":false})).bucket,
            Some(Bucket::Failed)
        );
        // A state added later reads as in progress.
        assert_eq!(
            entry(json!({"status":"future_state"})).bucket,
            Some(Bucket::Updating)
        );
        let revoked = entry(json!({"status":"revoked"}));
        assert_eq!((revoked.bucket, revoked.views), (None, 0));
        // Local pause counts as paused even before sync is paused.
        assert_ne!(entry(json!({"local_paused":true})).views & PAUSED, 0);
    }

    #[test]
    fn fresh_rates_and_search_text_match_device_rows() {
        let stale = entry(
            json!({"telemetry":{"sampled_at":"2026-09-28T23:57:59Z","events_per_second":5.0}}),
        );
        assert_eq!(stale.events_in, None);
        assert_ne!(stale.views & NO_TELEMETRY, 0);
        let fresh = entry(
            json!({"telemetry":{"sampled_at":"2026-09-28T23:58:00Z","events_per_second":5.0,"events_out_per_second":4.5}}),
        );
        assert_eq!((fresh.events_in, fresh.events_out), (Some(5.0), Some(4.5)));
        assert_eq!(fresh.views & NO_TELEMETRY, 0);
        let named = entry(
            json!({"os":"Linux","arch":"amd64","vector_version":"0.58.0","agent_version":"1.2.3","desired_version":{"number":3,"configuration_name":"Edge Syslog"}}),
        );
        assert_eq!(
            named.search,
            "edge-01 linux amd64 edge syslog v3 0.58.0 1.2.3"
        );
        assert_eq!(named.pipeline.as_deref(), Some("Edge Syslog v3"));
        let bare = entry(json!({"desired_version":{"number":null,"configuration_name":null}}));
        assert_eq!(bare.pipeline.as_deref(), Some("Assigned version"));
        assert_eq!(entry(json!({"desired_version_id":null})).pipeline, None);
    }

    #[test]
    fn natural_order_compares_digits_by_value_and_ignores_case() {
        let mut names = vec!["edge-10", "Edge-2", "edge-1", "alpha", "edge-02b", "Beta"];
        names.sort_by(|a, b| natural(a, b));
        assert_eq!(
            names,
            ["alpha", "Beta", "edge-1", "Edge-2", "edge-02b", "edge-10"]
        );
        assert_eq!(natural("0.58.0", "0.9.1"), Ordering::Greater);
    }

    #[test]
    fn filters_reject_what_they_do_not_know() {
        let filter = |fields: Value| {
            let input: FilterQuery = serde_json::from_value(fields).unwrap();
            Filter::parse(&input)
        };
        for bad in [
            json!({"status":"verified"}),
            json!({"view":"drift"}),
            json!({"sort":"name;DROP TABLE devices"}),
            json!({"dir":"up"}),
            json!({"group":"not-a-uuid"}),
            json!({"desired_version":"00000000-0000-4000-8000-00000000000A"}),
            json!({"q":"x".repeat(101)}),
            json!({"version":"9".repeat(65)}),
        ] {
            assert!(filter(bad.clone()).is_err(), "{bad}");
        }
        assert!(filter(json!({"q":"%_[]\\'".repeat(10)})).is_ok());
        let empty = filter(json!({"status":"","view":"","sort":"","dir":"","group":""})).unwrap();
        assert!(empty.status.is_none() && empty.view.is_none() && empty.group.is_none());
        assert!(filter(json!({"sort":"last_seen"})).unwrap().descending);
        assert!(
            !filter(json!({"sort":"last_seen","dir":"asc"}))
                .unwrap()
                .descending
        );
    }

    #[test]
    fn id_lists_are_bounded_and_say_when_they_are_cut() {
        let mut snapshot = Snapshot {
            entries: Vec::new(),
            by_id: HashMap::new(),
            groups: Vec::new(),
            group_index: HashMap::new(),
            overview: Value::Null,
        };
        for n in 0..5 {
            snapshot.entries.push(entry(json!({"id":format!("d{n}")})));
        }
        let matching: Vec<usize> = (0..5).collect();
        assert_eq!(
            ids_page(&snapshot, &matching, 3),
            json!({"ids":["d0","d1","d2"],"total":5,"truncated":true})
        );
        assert_eq!(ids_page(&snapshot, &matching, 5)["truncated"], false);
    }
}
