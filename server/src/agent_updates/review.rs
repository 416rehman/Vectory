//! The review of an update rollout: which devices will update, which will not
//! and why, from each device's latest report and the release, and the token
//! that binds what the person saw to what is created.
//!
//! The same rules gate the stages: a device is released only while it would
//! still be in the review's `will_update`.
use super::{ELIGIBILITY, parse_version};
use crate::{
    agent_releases::Release,
    db,
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

// ---------------------------------------------------------------------------
// The settings of an update rollout

/// `{canary_size,batch_size,observation_seconds,failure_threshold,canary_device_ids?}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RolloutSettings {
    pub canary_size: i64,
    pub batch_size: i64,
    pub observation_seconds: i64,
    pub failure_threshold: i64,
    pub canary_device_ids: Vec<String>,
}
impl RolloutSettings {
    /// A request's `rollout` member: members it leaves out take their defaults,
    /// an unknown member or a value out of range is `400 INVALID_INPUT`.
    pub fn parse(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| ApiError::invalid("rollout must be an object"))?;
        let known = [
            "canary_size",
            "batch_size",
            "observation_seconds",
            "failure_threshold",
            "canary_device_ids",
        ];
        if let Some(unknown) = object.keys().find(|key| !known.contains(&key.as_str())) {
            return Err(ApiError::invalid(format!(
                "Unknown rollout member {unknown}"
            )));
        }
        let number = |key: &str, default: i64, low: i64, high: i64| -> Result<i64> {
            match object.get(key) {
                None => Ok(default),
                Some(value) => value
                    .as_i64()
                    .filter(|n| (low..=high).contains(n))
                    .ok_or_else(|| ApiError::invalid(format!("Invalid rollout {key}"))),
            }
        };
        let canary_size = number("canary_size", 1, 1, 100)?;
        let canary_device_ids = match object.get("canary_device_ids") {
            None => Vec::new(),
            Some(list) => {
                let list = list
                    .as_array()
                    .filter(|list| list.len() <= crate::canary_choice::MAX_CHOSEN)
                    .ok_or_else(|| {
                        ApiError::invalid("canary_device_ids must list at most 100 devices")
                    })?;
                let mut seen = BTreeSet::new();
                let mut ids = Vec::with_capacity(list.len());
                for id in list {
                    let id = id
                        .as_str()
                        .filter(|id| {
                            uuid::Uuid::parse_str(id)
                                .is_ok_and(|parsed| parsed.hyphenated().to_string() == *id)
                        })
                        .ok_or_else(|| {
                            ApiError::invalid("canary_device_ids must contain lowercase device IDs")
                        })?;
                    if !seen.insert(id) {
                        return Err(ApiError::invalid(
                            "canary_device_ids must contain distinct device IDs",
                        ));
                    }
                    ids.push(id.to_owned());
                }
                if ids.len() as i64 > canary_size {
                    return Err(ApiError::invalid(
                        "canary_device_ids lists more devices than canary_size",
                    ));
                }
                ids
            }
        };
        Ok(Self {
            canary_size,
            batch_size: number("batch_size", 10, 1, 50)?,
            observation_seconds: number("observation_seconds", 300, 60, 86_400)?,
            failure_threshold: number("failure_threshold", 0, 0, 100)?,
            canary_device_ids,
        })
    }
    /// The four numbers, and the canary devices the request named when it did.
    pub fn view(&self) -> Value {
        let mut out = json!({
            "canary_size": self.canary_size,
            "batch_size": self.batch_size,
            "observation_seconds": self.observation_seconds,
            "failure_threshold": self.failure_threshold,
        });
        if !self.canary_device_ids.is_empty() {
            out["canary_device_ids"] = json!(self.canary_device_ids);
        }
        out
    }
}

// ---------------------------------------------------------------------------
// What the server knows about a device

/// The target states that still wait for something.
pub const OPEN_STATES: [&str; 8] = [
    "pending",
    "offered",
    "downloading",
    "staged",
    "waiting_for_host",
    "waiting_for_window",
    "applying",
    "restarted",
];

/// One device as the review and the stages see it.
#[derive(Clone, Debug)]
pub struct Facts {
    pub id: String,
    pub name: String,
    pub revoked: bool,
    pub os: String,
    pub arch: String,
    pub agent_version: Option<String>,
    pub agent_sha256: Option<String>,
    pub last_seen: Option<String>,
    pub interval: i64,
    pub report: Option<Value>,
    /// It has a target that has not ended in another update rollout.
    pub elsewhere: bool,
}
impl Facts {
    pub fn online(&self) -> bool {
        crate::rollout::checked_in_recently(self.last_seen.as_deref(), self.interval)
    }
    pub fn consent(&self) -> Option<&str> {
        self.report.as_ref()?.get("consent")?.as_str()
    }
    pub fn paused(&self) -> bool {
        self.report
            .as_ref()
            .is_some_and(|report| report["paused"] == true)
    }
    pub fn window_open(&self) -> bool {
        self.report
            .as_ref()
            .is_some_and(|report| report["window_open"] == true)
    }
    fn highest_counter(&self) -> u64 {
        self.report
            .as_ref()
            .and_then(|report| report["highest_counter"].as_u64())
            .unwrap_or(0)
    }
    pub fn pins(&self) -> Vec<String> {
        self.report
            .as_ref()
            .and_then(|report| report["keys"].as_array())
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    }
}

/// The facts of these devices, in one read. `except` is a rollout whose own
/// target does not count as another update.
pub async fn facts(
    conn: &mut SqliteConnection,
    ids: &BTreeSet<String>,
    except: &str,
) -> Result<Vec<Facts>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT d.id,d.name,d.revoked,d.policy,d.policy_generation,\
           json_extract(d.data,'$.os') AS os,json_extract(d.data,'$.arch') AS arch,\
           json_extract(d.data,'$.agent_version') AS agent_version,json_extract(d.data,'$.agent_sha256') AS agent_sha256,json_extract(d.data,'$.last_seen') AS last_seen,\
           json_object('policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds')) AS evidence,\
           r.report,\
           EXISTS(SELECT 1 FROM agent_update_targets t WHERE t.device_id=d.id AND t.rollout_id<>? AND t.state IN ('pending','offered','downloading','staged','waiting_for_host','waiting_for_window','applying','restarted')) AS elsewhere \
         FROM devices d LEFT JOIN agent_update_reports r ON r.device_id=d.id WHERE d.id IN (SELECT value FROM json_each(?))",
    )
    .bind(except)
    .bind(json!(ids).to_string())
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let policy = db::parse(&row.get::<String, _>("policy"))?;
        let evidence = db::parse(&row.get::<String, _>("evidence"))?;
        let interval = crate::rollout::check_in_seconds(
            &policy,
            &evidence,
            row.get::<i64, _>("policy_generation"),
        );
        out.push(Facts {
            id: row.get("id"),
            name: row.get("name"),
            revoked: row.get("revoked"),
            os: row.get::<Option<String>, _>("os").unwrap_or_default(),
            arch: row.get::<Option<String>, _>("arch").unwrap_or_default(),
            agent_version: row.get("agent_version"),
            agent_sha256: row.get("agent_sha256"),
            last_seen: row.get("last_seen"),
            interval,
            report: match row.get::<Option<String>, _>("report") {
                Some(report) => Some(db::parse(&report)?),
                None => None,
            },
            elsewhere: row.get("elsewhere"),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Rollover statements

/// The rollover statements this server holds, public and in order of the keys
/// they connect: what a release's signer needs on a host that pins an older key.
#[derive(Default)]
pub struct Statements {
    edges: Vec<Edge>,
}
struct Edge {
    from: String,
    to: String,
    statement: String,
    signature: String,
}
/// Statements a host follows in one offer, at most.
pub const CHAIN: usize = 8;
impl Statements {
    /// The statements among keys that are not revoked.
    pub async fn load(conn: &mut SqliteConnection) -> Result<Self> {
        let rows = sqlx::query(
            "SELECT k.introduced_from,k.fingerprint,k.introduced_statement,k.introduced_signature FROM agent_release_keys k JOIN agent_release_keys f ON f.fingerprint=k.introduced_from WHERE k.state<>'revoked' AND f.state<>'revoked' ORDER BY k.created_at,k.fingerprint",
        )
        .fetch_all(&mut *conn)
        .await?;
        Ok(Self {
            edges: rows
                .iter()
                .map(|row| Edge {
                    from: row.get("introduced_from"),
                    to: row.get("fingerprint"),
                    statement: row.get("introduced_statement"),
                    signature: row.get("introduced_signature"),
                })
                .collect(),
        })
    }
    /// The statements, in the order a host follows them, that lead from a key
    /// the host pins to `signer`: none when it pins the signer itself, and
    /// `None` when no chain of at most eight statements reaches it.
    pub fn chain(&self, pins: &[String], signer: &str) -> Option<Vec<(String, String)>> {
        if pins.iter().any(|pin| pin == signer) {
            return Some(Vec::new());
        }
        let mut best: Option<Vec<&Edge>> = None;
        for pin in pins {
            let mut frontier: Vec<(String, Vec<&Edge>)> = vec![(pin.clone(), Vec::new())];
            let mut seen = BTreeSet::from([pin.clone()]);
            while !frontier.is_empty() {
                let mut next = Vec::new();
                for (at, path) in frontier {
                    for edge in self.edges.iter().filter(|edge| edge.from == at) {
                        if path.len() >= CHAIN || !seen.insert(edge.to.clone()) {
                            continue;
                        }
                        let mut longer = path.clone();
                        longer.push(edge);
                        if edge.to == signer {
                            if best.as_ref().is_none_or(|b| longer.len() < b.len()) {
                                best = Some(longer);
                            }
                            continue;
                        }
                        next.push((edge.to.clone(), longer));
                    }
                }
                frontier = next;
            }
        }
        best.map(|path| {
            path.into_iter()
                .map(|edge| (edge.statement.clone(), edge.signature.clone()))
                .collect()
        })
    }
}

// ---------------------------------------------------------------------------
// Why a device will not take a release

/// Why a device will not take a release, with the two successors of a fork.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub successors: Option<[String; 2]>,
}
fn refused(code: &'static str) -> Option<Refusal> {
    Some(Refusal {
        code,
        successors: None,
    })
}
/// The order the review tries the reasons in, which is the order its groups
/// are listed in.
pub const REVIEW_ORDER: [&str; 18] = [
    "DEVICE_REVOKED",
    "AGENT_TOO_OLD",
    "PACKAGE_MANAGED",
    "NO_SERVICE",
    "UNTRUSTED_LOCATION",
    "READ_ONLY",
    "HELPER_NOT_RUNNING",
    "SERVICE_DEFINITION_OUTDATED",
    "PLATFORM_NOT_IN_RELEASE",
    "UPDATES_OFF",
    "KEY_ROLLOVER_CONFLICT",
    "KEY_NOT_PINNED",
    "RELEASE_ALREADY_TRIED",
    "COUNTER_REPLAYED",
    "ALREADY_RUNNING",
    "DOWNGRADE_REFUSED",
    "VERSION_NOT_ON_TRACK",
    "IN_ANOTHER_UPDATE",
];

/// The first reason, in the contract's order, that this device will not take
/// this release, from its latest report: `None` when it will.
pub fn refusal(f: &Facts, release: &Release, statements: &Statements) -> Option<Refusal> {
    if f.revoked {
        return refused("DEVICE_REVOKED");
    }
    let Some(report) = &f.report else {
        return refused("AGENT_TOO_OLD");
    };
    let eligibility = report["eligibility"].as_str().unwrap_or("eligible");
    if eligibility != "eligible"
        && let Some(code) = ELIGIBILITY.iter().find(|code| **code == eligibility)
    {
        return refused(code);
    }
    if report["consent"] == "off" {
        return refused("UPDATES_OFF");
    }
    if let Some(conflict) = report.get("rollover_conflict").filter(|c| c.is_object()) {
        let successors = conflict["to"].as_array().and_then(|to| {
            Some([
                to.first()?.as_str()?.to_owned(),
                to.get(1)?.as_str()?.to_owned(),
            ])
        });
        return Some(Refusal {
            code: "KEY_ROLLOVER_CONFLICT",
            successors,
        });
    }
    if release.artifact_for(&f.os, &f.arch).is_none() {
        return refused("PLATFORM_NOT_IN_RELEASE");
    }
    let reaches = release
        .signer
        .as_deref()
        .is_some_and(|signer| statements.chain(&f.pins(), signer).is_some());
    if !reaches {
        return refused("KEY_NOT_PINNED");
    }
    let counter = u64::try_from(release.counter).unwrap_or(u64::MAX);
    if counter <= f.highest_counter() {
        let tried = report["last"]["release"] == release.manifest_sha256.as_str()
            && report["last"]["outcome"] == "rolled_back";
        return refused(if tried {
            "RELEASE_ALREADY_TRIED"
        } else {
            "COUNTER_REPLAYED"
        });
    }
    // A running version that is not a plain `major.minor.patch` one (`0.1.0-dev`,
    // `v0.1.0`, nothing at all) cannot be compared with the release's, so it is
    // refused as a downgrade: nobody guesses which of the two is newer.
    let Some(running) = f.agent_version.as_deref().and_then(parse_version) else {
        return refused("DOWNGRADE_REFUSED");
    };
    // The release was prepared by this server, with a valid version.
    let offered = parse_version(&release.version)?;
    match running.cmp(&offered) {
        std::cmp::Ordering::Equal => return refused("ALREADY_RUNNING"),
        std::cmp::Ordering::Greater => return refused("DOWNGRADE_REFUSED"),
        std::cmp::Ordering::Less => {}
    }
    let on_track = match report["track"].as_str() {
        Some("minor") => running[0] == offered[0],
        _ => running[0] == offered[0] && running[1] == offered[1],
    };
    if !on_track {
        return refused("VERSION_NOT_ON_TRACK");
    }
    if release
        .min_from
        .as_deref()
        .and_then(parse_version)
        .is_some_and(|minimum| running < minimum)
    {
        return refused("AGENT_TOO_OLD");
    }
    if report["service_definition"]
        .as_i64()
        .is_some_and(|have| have < release.service_definition)
    {
        return refused("SERVICE_DEFINITION_OUTDATED");
    }
    if f.elsewhere {
        return refused("IN_ANOTHER_UPDATE");
    }
    None
}

/// The sentence for a group of devices that will not update, and the sentence
/// that says what to do on the host (null when nothing on the host would
/// change it).
fn describe(code: &str, release: &Release, track_hint: bool) -> (String, Option<&'static str>) {
    let version = &release.version;
    match code {
        "DEVICE_REVOKED" => (
            "These devices were revoked, so they take no update.".into(),
            None,
        ),
        "AGENT_TOO_OLD" => (
            format!("These agents don't report agent updates, or are older than the oldest agent that can update to {version}. They can't take it."),
            Some("Run the Upgrade agent command once; it installs an agent that takes updates."),
        ),
        "PACKAGE_MANAGED" => (
            "A package manager owns these agents, so Vectory leaves their update to it.".into(),
            None,
        ),
        "NO_SERVICE" => (
            "These agents run in the foreground without a service, so nothing restarts them after an update.".into(),
            Some("Run the Upgrade agent command with a service manager."),
        ),
        "UNTRUSTED_LOCATION" => (
            "The install path or a directory above it isn't owned by root, or others can write to it.".into(),
            Some("Make the install path and every directory above it owned by root and not writable by others."),
        ),
        "READ_ONLY" => (
            "The install directory is on a read-only file system.".into(),
            Some("Make the install directory writable, or move the agent."),
        ),
        "HELPER_NOT_RUNNING" => (
            "The privileged update step isn't running on these hosts.".into(),
            Some("Run vectory doctor on the host and follow what it says about the update step."),
        ),
        "SERVICE_DEFINITION_OUTDATED" => (
            format!("{version} needs a newer service definition than these hosts have."),
            Some("Run the Upgrade agent command once; it rewrites the service definition."),
        ),
        "PLATFORM_NOT_IN_RELEASE" => (
            format!("{version} has no build for these hosts' platform, or updates aren't available there in this release."),
            None,
        ),
        "UPDATES_OFF" => (
            "Updates are off on these hosts.".into(),
            Some("Run the Upgrade agent command with updates on, once."),
        ),
        "KEY_ROLLOVER_CONFLICT" => (
            "Two successors of a key these hosts pin were seen, so they refuse every update until they are pinned again.".into(),
            Some("Run the Upgrade agent command with the key you trust."),
        ),
        "KEY_NOT_PINNED" => (
            format!("These hosts pin no key that reaches the key that signed {version}."),
            Some("Run the Upgrade agent command so the host pins the current release key."),
        ),
        "RELEASE_ALREADY_TRIED" => (
            format!("These hosts tried {version} and rolled back. They take the next release."),
            None,
        ),
        "COUNTER_REPLAYED" => (
            format!("These hosts already attempted a release at least as new as {version}."),
            None,
        ),
        "ALREADY_RUNNING" => (format!("These hosts already run {version}."), None),
        "DOWNGRADE_REFUSED" => (
            format!("These hosts run a newer agent than {version}, or one whose version can't be compared with it, and a host never goes back."),
            None,
        ),
        "VERSION_NOT_ON_TRACK" => (
            format!("{version} isn't on the update track these hosts allowed."),
            if track_hint {
                Some("Run the Upgrade agent command with the minor track.")
            } else {
                None
            },
        ),
        _ => (
            "These devices are in another update rollout that hasn't ended.".into(),
            None,
        ),
    }
}

// ---------------------------------------------------------------------------
// The review

pub struct Review {
    pub will_update: Vec<Facts>,
    pub wont_update: BTreeMap<&'static str, Vec<(Facts, Option<[String; 2]>)>>,
    pub token: String,
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The reviewed devices, each in `will_update` or under the first reason that
/// applies, and the token that binds the release, the settings and these exact
/// sets.
pub async fn review(
    conn: &mut SqliteConnection,
    release: &Release,
    selected: &BTreeSet<String>,
    settings: &RolloutSettings,
) -> Result<Review> {
    build(conn, release, selected, settings, true).await
}
/// The review as it would be if no device were in another update rollout: what
/// tells a review that changed only because a device was taken by another
/// rollout from one that changed otherwise.
pub async fn review_ignoring_other_rollouts(
    conn: &mut SqliteConnection,
    release: &Release,
    selected: &BTreeSet<String>,
    settings: &RolloutSettings,
) -> Result<Review> {
    build(conn, release, selected, settings, false).await
}
async fn build(
    conn: &mut SqliteConnection,
    release: &Release,
    selected: &BTreeSet<String>,
    settings: &RolloutSettings,
    overlap: bool,
) -> Result<Review> {
    let mut all = facts(conn, selected, "").await?;
    if !overlap {
        for device in &mut all {
            device.elsewhere = false;
        }
    }
    all.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    let statements = Statements::load(conn).await?;
    let mut will_update = Vec::new();
    let mut wont_update: BTreeMap<&'static str, Vec<(Facts, Option<[String; 2]>)>> =
        BTreeMap::new();
    for device in all {
        match refusal(&device, release, &statements) {
            None => will_update.push(device),
            Some(refusal) => wont_update
                .entry(refusal.code)
                .or_default()
                .push((device, refusal.successors)),
        }
    }
    let token = token(release, settings, &will_update, &wont_update);
    Ok(Review {
        will_update,
        wont_update,
        token,
    })
}

/// The lowercase SHA-256 that binds a review: the release, the settings, the
/// exact `will_update` set (with the level and windows each applies under) and
/// `wont_update` sets. What changes with the clock, such as the start of a
/// device's next window, is not in it.
fn token(
    release: &Release,
    settings: &RolloutSettings,
    will_update: &[Facts],
    wont_update: &BTreeMap<&'static str, Vec<(Facts, Option<[String; 2]>)>>,
) -> String {
    let mut will: Vec<Value> = will_update
        .iter()
        .map(|device| {
            json!([
                device.id,
                device.consent(),
                device.report.as_ref().map(|report| &report["windows"]),
            ])
        })
        .collect();
    will.sort_by_key(|entry| entry[0].as_str().unwrap_or("").to_owned());
    let wont: Vec<Value> = REVIEW_ORDER
        .iter()
        .filter_map(|code| {
            let devices = wont_update.get(code)?;
            let mut entries: Vec<Value> = devices
                .iter()
                .map(|(device, successors)| json!([device.id, successors]))
                .collect();
            entries.sort_by_key(|entry| entry[0].as_str().unwrap_or("").to_owned());
            Some(json!([code, entries]))
        })
        .collect();
    let binding = json!({
        "release": {"id":release.id,"counter":release.counter,"manifest_sha256":release.manifest_sha256},
        "rollout": settings.view(),
        "will_update": will,
        "wont_update": wont,
    });
    db::hash(format!(
        "vectory-agent-update-review-v1\n{}",
        crate::deployment_requests::canonical(&binding)
    ))
}

/// `AgentUpdatePreview` of a review. `canary` is `{size,chosen_by_you,device_ids}`.
pub fn view(release: &Release, review: &Review, canary: Value) -> Value {
    let will_update: Vec<Value> = review
        .will_update
        .iter()
        .map(|device| {
            let report = device.report.clone().unwrap_or(Value::Null);
            json!({
                "device_id": device.id,
                "device_name": device.name,
                "consent": report["consent"],
                "windows": report["windows"],
                "next_window_at": report.get("next_window_at").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let wont_update: Vec<Value> = REVIEW_ORDER
        .iter()
        .filter_map(|code| {
            let devices = review.wont_update.get(code)?;
            let track_hint = *code == "VERSION_NOT_ON_TRACK"
                && devices.iter().any(|(device, _)| {
                    device.report.as_ref().is_some_and(|report| {
                        report["track"] == "patch"
                            && device
                                .agent_version
                                .as_deref()
                                .and_then(parse_version)
                                .is_some_and(|running| {
                                    parse_version(&release.version)
                                        .is_some_and(|offered| running[0] == offered[0])
                                })
                    })
                });
            let (reason, fix) = describe(code, release, track_hint);
            Some(json!({
                "code": code,
                "reason": reason,
                "fix": fix,
                "devices": devices.iter().map(|(device, successors)| json!({
                    "device_id": device.id,
                    "device_name": device.name,
                    "successors": successors,
                })).collect::<Vec<_>>(),
            }))
        })
        .collect();
    let named = |wanted: &dyn Fn(&Facts) -> bool| -> Vec<Value> {
        review
            .will_update
            .iter()
            .filter(|device| wanted(device))
            .map(|device| json!({"device_id":device.id,"device_name":device.name}))
            .collect()
    };
    let mut warnings = Vec::new();
    let mut warn = |code: &str, devices: Vec<Value>, message: String| {
        if !devices.is_empty() {
            warnings.push(json!({"code":code,"message":message,"devices":devices}));
        }
    };
    let offline = named(&|device| !device.online());
    let message = format!(
        "{} checking in. Each updates if it checks in while the rollout runs.",
        plural(offline.len(), "device isn't", "devices aren't")
    );
    warn("OFFLINE", offline, message);
    let waits_host = named(&|device| device.consent() == Some("ask"));
    let message = format!(
        "{} for someone on the host to run sudo vectory update apply.",
        plural(waits_host.len(), "device waits", "devices wait")
    );
    warn("WAITS_FOR_HOST", waits_host, message);
    let waits_window = named(&|device| {
        device.consent() == Some("auto")
            && !device.window_open()
            && device
                .report
                .as_ref()
                .is_some_and(|report| report["windows"].as_array().is_some_and(|w| !w.is_empty()))
    });
    let message = format!(
        "{} for its update window.",
        plural(waits_window.len(), "device waits", "devices wait")
    );
    warn("WAITS_FOR_WINDOW", waits_window, message);
    let paused = named(&|device| device.paused());
    let message = format!(
        "{} paused on the host. Each updates after someone runs vectory update resume.",
        plural(paused.len(), "device is", "devices are")
    );
    warn("PAUSED_ON_HOST", paused, message);
    json!({
        "release": release.brief(),
        "will_update": will_update,
        "wont_update": wont_update,
        "warnings": warnings,
        "canary": canary,
        "review_token": review.token,
    })
}
