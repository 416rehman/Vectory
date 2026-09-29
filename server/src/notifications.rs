//! Notification channels, their rules, and the outbox events hooks write.
//!
//! Administrators configure channels (a webhook or an SMTP server) under
//! Settings → Notifications. Each channel says which events it wants, for
//! which pipelines, groups and severities, and when to keep quiet. Secrets
//! (the webhook URL itself, its signing secret and header value, the SMTP
//! password) are sealed with the instance key and are write-only: no
//! response, audit event or log line ever contains one. `notifier` turns
//! outbox events into deliveries and sends them.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
    outbound,
};
use axum::{
    Json,
    extract::{
        Path, Query, RawQuery, State as AppState, rejection::JsonRejection,
        rejection::QueryRejection,
    },
    http::{HeaderMap, StatusCode},
};
use chrono::{DateTime, NaiveTime, TimeZone, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeSet;

/// Event types a channel can ask for, in the order the dashboard lists them.
pub const EVENTS: [&str; 7] = [
    "issue.opened",
    "issue.resolved",
    "rollout.failed",
    "rollout.rolled_back",
    "canary.paused",
    "device.offline",
    "device.recovered",
];
pub const MAX_CHANNELS: usize = 20;
pub const DEFAULT_OFFLINE_MINUTES: u64 = 15;
pub const OFFLINE_MINUTES: std::ops::RangeInclusive<u64> = 5..=1440;
const MAX_FILTER_IDS: usize = 50;
const MAX_RECIPIENTS: usize = 10;
const TEST_SENDS_PER_MINUTE: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Webhook,
    Email,
}
impl Kind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "webhook" => Some(Kind::Webhook),
            "email" => Some(Kind::Email),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Webhook => "webhook",
            Kind::Email => "email",
        }
    }
}

/// Quiet hours in the administrator's time zone.
#[derive(Clone, Debug)]
pub struct Quiet {
    pub start: NaiveTime,
    pub end: NaiveTime,
    pub zone: chrono_tz::Tz,
    pub errors_bypass: bool,
}
impl Quiet {
    pub fn active(&self, now: DateTime<Utc>) -> bool {
        let local = now.with_timezone(&self.zone).time();
        let local = NaiveTime::from_hms_opt(local.hour(), local.minute(), 0).unwrap_or(local);
        if self.start < self.end {
            self.start <= local && local < self.end
        } else {
            local >= self.start || local < self.end
        }
    }
    /// When the current quiet period ends, in UTC.
    pub fn end_after(&self, now: DateTime<Utc>) -> DateTime<Utc> {
        let local = now.with_timezone(&self.zone);
        let mut candidate = local.date_naive().and_time(self.end);
        if candidate <= local.naive_local() {
            candidate += chrono::Duration::days(1);
        }
        // A local time skipped by a daylight-saving change ends at the next
        // representable minute.
        for shift in 0..=120 {
            let at = candidate + chrono::Duration::minutes(shift);
            if let Some(end) = self.zone.from_local_datetime(&at).earliest() {
                return end.with_timezone(&Utc);
            }
        }
        now + chrono::Duration::hours(1)
    }
}

/// What a channel sends. Empty filters mean "all".
#[derive(Clone, Debug)]
pub struct Rules {
    pub events: BTreeSet<String>,
    pub offline_minutes: u64,
    pub errors_only: bool,
    pub pipeline_ids: BTreeSet<String>,
    pub group_ids: BTreeSet<String>,
    pub quiet: Option<Quiet>,
}
fn clock(value: &Value, key: &str) -> std::result::Result<NaiveTime, String> {
    let text = value[key]
        .as_str()
        .ok_or_else(|| format!("Quiet hours {key} must be a time like 22:00"))?;
    let (h, m) = text
        .split_once(':')
        .filter(|(h, m)| h.len() == 2 && m.len() == 2)
        .ok_or_else(|| format!("Quiet hours {key} must be a time like 22:00"))?;
    h.parse::<u32>()
        .ok()
        .zip(m.parse::<u32>().ok())
        .and_then(|(h, m)| NaiveTime::from_hms_opt(h, m, 0))
        .ok_or_else(|| format!("Quiet hours {key} must be a time like 22:00"))
}
fn id_set(value: &Value, key: &str) -> std::result::Result<BTreeSet<String>, String> {
    let list = match &value[key] {
        Value::Null => return Ok(BTreeSet::new()),
        Value::Array(list) => list,
        _ => return Err(format!("{key} must be a list")),
    };
    if list.len() > MAX_FILTER_IDS {
        return Err(format!("Choose at most {MAX_FILTER_IDS} for {key}"));
    }
    list.iter()
        .map(|id| {
            id.as_str()
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .map(|id| id.hyphenated().to_string())
                .ok_or_else(|| format!("{key} must hold IDs"))
        })
        .collect()
}
impl Rules {
    pub fn parse(value: &Value) -> std::result::Result<Self, String> {
        let object = value
            .as_object()
            .ok_or_else(|| "rules must be an object".to_owned())?;
        if let Some(key) = object.keys().find(|k| {
            ![
                "events",
                "offline_minutes",
                "min_severity",
                "pipeline_ids",
                "group_ids",
                "quiet_hours",
            ]
            .contains(&k.as_str())
        }) {
            return Err(format!("Unknown rule {key}"));
        }
        let events = value["events"]
            .as_array()
            .ok_or_else(|| "Choose at least one event".to_owned())?
            .iter()
            .map(|e| {
                e.as_str()
                    .filter(|e| EVENTS.contains(e))
                    .map(str::to_owned)
                    .ok_or_else(|| "Unknown event type".to_owned())
            })
            .collect::<std::result::Result<BTreeSet<_>, _>>()?;
        if events.is_empty() {
            return Err("Choose at least one event".into());
        }
        let offline_minutes = match &value["offline_minutes"] {
            Value::Null => DEFAULT_OFFLINE_MINUTES,
            v => v
                .as_u64()
                .filter(|m| OFFLINE_MINUTES.contains(m))
                .ok_or_else(|| {
                    format!(
                        "Offline minutes must be between {} and {}",
                        OFFLINE_MINUTES.start(),
                        OFFLINE_MINUTES.end()
                    )
                })?,
        };
        let errors_only = match value["min_severity"].as_str() {
            None | Some("warning") => false,
            Some("error") => true,
            Some(_) => return Err("min_severity must be warning or error".into()),
        };
        let quiet = match &value["quiet_hours"] {
            Value::Null => None,
            q @ Value::Object(fields) => {
                if let Some(key) = fields
                    .keys()
                    .find(|k| !["start", "end", "time_zone", "errors_bypass"].contains(&k.as_str()))
                {
                    return Err(format!("Unknown quiet hours setting {key}"));
                }
                let start = clock(q, "start")?;
                let end = clock(q, "end")?;
                if start == end {
                    return Err("Quiet hours need different start and end times".into());
                }
                let zone = q["time_zone"]
                    .as_str()
                    .filter(|z| z.len() <= 64)
                    .and_then(|z| z.parse::<chrono_tz::Tz>().ok())
                    .ok_or_else(|| "Choose a time zone for quiet hours".to_owned())?;
                let errors_bypass = match &q["errors_bypass"] {
                    Value::Null => false,
                    Value::Bool(b) => *b,
                    _ => return Err("errors_bypass must be true or false".into()),
                };
                Some(Quiet {
                    start,
                    end,
                    zone,
                    errors_bypass,
                })
            }
            _ => return Err("quiet_hours must be an object or null".into()),
        };
        Ok(Rules {
            events,
            offline_minutes,
            errors_only,
            pipeline_ids: id_set(value, "pipeline_ids")?,
            group_ids: id_set(value, "group_ids")?,
            quiet,
        })
    }
    pub fn to_json(&self) -> Value {
        json!({
            "events": EVENTS.iter().filter(|e| self.events.contains(**e)).collect::<Vec<_>>(),
            "offline_minutes": self.offline_minutes,
            "min_severity": if self.errors_only { "error" } else { "warning" },
            "pipeline_ids": self.pipeline_ids,
            "group_ids": self.group_ids,
            "quiet_hours": self.quiet.as_ref().map(|q| json!({
                "start": q.start.format("%H:%M").to_string(),
                "end": q.end.format("%H:%M").to_string(),
                "time_zone": q.zone.name(),
                "errors_bypass": q.errors_bypass,
            })),
        })
    }
    /// Does an event, with its pipeline and groups, pass these rules?
    pub fn matches(
        &self,
        kind: &str,
        severity: &str,
        pipeline: Option<&str>,
        groups: &BTreeSet<String>,
    ) -> bool {
        self.events.contains(kind)
            && (!self.errors_only || severity == "error")
            && (self.pipeline_ids.is_empty()
                || pipeline.is_some_and(|p| self.pipeline_ids.contains(p)))
            && (self.group_ids.is_empty() || !self.group_ids.is_disjoint(groups))
    }
}

/// The write-only part of a channel, sealed at rest.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Secrets {
    pub url: Option<String>,
    pub signing_secret: Option<String>,
    pub header_value: Option<String>,
    pub password: Option<String>,
}
impl Secrets {
    /// Every value that must never appear in an error or log line.
    pub fn redactions(&self, destination: Option<&outbound::Destination>) -> Vec<String> {
        let mut out: Vec<String> = [&self.signing_secret, &self.header_value, &self.password]
            .into_iter()
            .flatten()
            .cloned()
            .collect();
        if let Some(d) = destination {
            if d.target != "/" {
                out.push(d.target.clone());
                // The last path segment is the usual token (Slack's is).
                if let Some(last) = d
                    .target
                    .split(['/', '?', '=', '&'])
                    .filter(|s| s.len() >= 8)
                    .last()
                {
                    out.push(last.to_owned());
                }
            }
        }
        out
    }
}
fn aad(id: &str) -> String {
    format!("notification-channel:{id}")
}
fn seal(s: &crate::App, id: &str, secrets: &Secrets) -> Result<String> {
    let plain = serde_json::to_string(secrets).map_err(|_| ApiError::invalid("Invalid secrets"))?;
    s.keys.seal_mfa(&aad(id), &plain)
}
pub(crate) fn open(s: &crate::App, id: &str, sealed: &str) -> Result<Secrets> {
    if sealed.is_empty() {
        return Ok(Secrets::default());
    }
    let plain = s.keys.open_mfa(&aad(id), sealed).map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "SECRETS_UNREADABLE",
            "This channel's saved secrets can't be read with this instance's keys. Replace them.",
        )
    })?;
    serde_json::from_str(&plain).map_err(|_| ApiError::conflict("Saved secrets are invalid"))
}

/// A stored channel, parsed.
#[derive(Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub enabled: bool,
    pub allow_private: bool,
    pub rules: Rules,
    pub created_at: DateTime<Utc>,
    pub data: Value,
    pub sealed: String,
    pub revision: i64,
}
impl Channel {
    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        let data = db::parse(row.get("data"))?;
        let rules = Rules::parse(&data["rules"])
            .map_err(|_| ApiError::conflict("A saved channel has invalid rules"))?;
        Ok(Channel {
            id: row.get("id"),
            name: data["name"].as_str().unwrap_or("Channel").to_owned(),
            kind: Kind::parse(data["kind"].as_str().unwrap_or("")).unwrap_or(Kind::Webhook),
            enabled: data["enabled"] != false,
            allow_private: data["allow_private"] == true,
            rules,
            created_at: DateTime::parse_from_rfc3339(row.get::<&str, _>("created_at"))
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
            sealed: row.get("sealed"),
            revision: row.get("revision"),
            data,
        })
    }
}
pub(crate) async fn channels(db: &mut SqliteConnection) -> Result<Vec<Channel>> {
    let rows = sqlx::query("SELECT id,data,sealed,revision,created_at FROM notification_channels ORDER BY created_at,id")
        .fetch_all(&mut *db)
        .await?;
    // A corrupt row is skipped rather than stopping every other channel.
    Ok(rows
        .iter()
        .filter_map(|row| Channel::from_row(row).ok())
        .collect())
}
async fn channel(db: &mut SqliteConnection, id: &str) -> Result<Channel> {
    let row = sqlx::query(
        "SELECT id,data,sealed,revision,created_at FROM notification_channels WHERE id=?",
    )
    .bind(id)
    .fetch_optional(&mut *db)
    .await?
    .ok_or_else(ApiError::missing)?;
    Channel::from_row(&row)
}

/* ---------- Outbox events ---------- */

/// Whether any channel could want an event. When none is on, hooks write
/// nothing, so an instance without notifications keeps no outbox.
async fn listening(db: &mut SqliteConnection) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM notification_channels WHERE json_extract(data,'$.enabled')=1)",
    )
    .fetch_one(&mut *db)
    .await?)
}
/// Record one event in the caller's transaction. `identity` makes the same
/// fact one event however often it is reported.
pub(crate) async fn emit(
    db: &mut SqliteConnection,
    identity: &str,
    kind: &str,
    channel: Option<&str>,
    data: &Value,
    at: &str,
) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO notification_events(identity,kind,channel_id,data,created_at) VALUES(?,?,?,?,?)")
        .bind(identity)
        .bind(kind)
        .bind(channel)
        .bind(data.to_string())
        .bind(at)
        .execute(&mut *db)
        .await?;
    Ok(())
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
fn issue_event(issue: &Value) -> Value {
    let rendered = crate::issues::render(issue.clone());
    let warning = rendered["diagnostics"][0]["severity"] == "warning";
    json!({
        "issue_id": issue["id"],
        "revision": issue["revision"],
        "device_id": issue["device_id"],
        "code": rendered["code"],
        "version_id": issue["desired_version_id"],
        "deployment_id": issue["deployment_id"],
        "title": bounded(rendered["title"].as_str().unwrap_or("A device reported a problem"), 160),
        "message": bounded(rendered["message"].as_str().unwrap_or(""), 400),
        "severity": if warning { "warning" } else { "error" },
        "resolved_reason": issue["resolved_reason"],
    })
}
/// An issue opened: a new issue, or one that came back after it resolved.
pub(crate) async fn issue_opened(db: &mut SqliteConnection, issue: &Value) -> Result<()> {
    if !listening(db).await? {
        return Ok(());
    }
    let identity = format!(
        "issue.opened:{}:{}",
        issue["id"].as_str().unwrap_or(""),
        issue["revision"].as_u64().unwrap_or(1)
    );
    emit(
        db,
        &identity,
        "issue.opened",
        None,
        &issue_event(issue),
        &db::now(),
    )
    .await
}
/// An issue resolved because the problem went away: the device verified a
/// configuration, or its delivery is healthy again. Issues closed by a
/// change someone made (a new version, a removed assignment, a revoked
/// device, metrics turned off) announce nothing.
pub(crate) async fn issue_resolved(db: &mut SqliteConnection, issue: &Value) -> Result<()> {
    if !matches!(
        issue["resolved_reason"].as_str(),
        Some("verified" | "healthy")
    ) || !listening(db).await?
    {
        return Ok(());
    }
    let identity = format!(
        "issue.resolved:{}:{}",
        issue["id"].as_str().unwrap_or(""),
        issue["revision"].as_u64().unwrap_or(1)
    );
    emit(
        db,
        &identity,
        "issue.resolved",
        None,
        &issue_event(issue),
        &db::now(),
    )
    .await
}

/* ---------- Channel API ---------- */

fn text_field<'a>(v: &'a Value, key: &str, max: usize, label: &str) -> Result<&'a str> {
    let text = v[key]
        .as_str()
        .map(str::trim)
        .ok_or_else(|| ApiError::invalid(format!("Enter {label}")))?;
    if text.is_empty() || text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(ApiError::invalid(format!(
            "Enter {label} of at most {max} characters"
        )));
    }
    Ok(text)
}
/// An optional secret edit: absent keeps, null removes, text replaces.
enum Edit {
    Keep,
    Remove,
    Set(String),
}
fn secret_edit(v: &Value, key: &str, max: usize, label: &str) -> Result<Edit> {
    match v.get(key) {
        None => Ok(Edit::Keep),
        Some(Value::Null) => Ok(Edit::Remove),
        Some(Value::String(s)) if s.is_empty() => Ok(Edit::Remove),
        Some(Value::String(s)) => {
            if s.chars().count() > max || s.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
                return Err(ApiError::invalid(format!(
                    "{label} must be at most {max} characters on one line"
                )));
            }
            Ok(Edit::Set(s.clone()))
        }
        Some(_) => Err(ApiError::invalid(format!("{label} must be text"))),
    }
}
fn apply(edit: Edit, current: &mut Option<String>) {
    match edit {
        Edit::Keep => {}
        Edit::Remove => *current = None,
        Edit::Set(value) => *current = Some(value),
    }
}
const RESERVED_HEADERS: [&str; 11] = [
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "user-agent",
    "expect",
];
fn header_name(value: &str) -> Result<String> {
    let name = value.trim();
    let token = !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
    let lower = name.to_ascii_lowercase();
    if !token {
        return Err(ApiError::invalid(
            "The header name can use letters, digits and - only, up to 64 characters",
        ));
    }
    if RESERVED_HEADERS.contains(&lower.as_str())
        || lower.starts_with("x-vectory-")
        || lower.starts_with("proxy-")
    {
        return Err(ApiError::invalid(format!(
            "Vectory sets {name} itself. Choose another header"
        )));
    }
    Ok(name.to_owned())
}
fn header_value_ok(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b == b'\t' || (0x20..0x7f).contains(&b))
}

/// Validate a create or update body against the current channel (if any)
/// and return the new public data and secrets. Changes are listed for the
/// audit summary, never with a secret value.
struct Proposal {
    data: Value,
    secrets: Secrets,
    changes: Vec<String>,
}
async fn propose(
    db: &mut SqliteConnection,
    body: &Value,
    current: Option<(&Channel, Secrets)>,
) -> Result<Proposal> {
    let fields = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("Send the channel settings"))?;
    if let Some(key) = fields.keys().find(|k| {
        ![
            "name",
            "kind",
            "enabled",
            "allow_private",
            "webhook",
            "email",
            "rules",
            "revision",
        ]
        .contains(&k.as_str())
    }) {
        return Err(ApiError::invalid(format!("Unknown channel setting {key}")));
    }
    let previous = current.as_ref().map(|(c, _)| &c.data);
    let mut secrets = current.as_ref().map(|(_, s)| s.clone()).unwrap_or_default();
    let mut changes = Vec::new();
    let name = text_field(body, "name", 80, "a channel name")?.to_owned();
    let kind = Kind::parse(body["kind"].as_str().unwrap_or(""))
        .ok_or_else(|| ApiError::invalid("Choose webhook or email"))?;
    if let Some((channel, _)) = &current {
        if channel.kind != kind {
            return Err(ApiError::invalid(
                "A channel keeps its type. Add a new channel instead",
            ));
        }
    }
    let enabled = match &body["enabled"] {
        Value::Null => true,
        Value::Bool(b) => *b,
        _ => return Err(ApiError::invalid("enabled must be true or false")),
    };
    let allow_private = match &body["allow_private"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        _ => return Err(ApiError::invalid("allow_private must be true or false")),
    };
    let rules = Rules::parse(&body["rules"]).map_err(ApiError::invalid)?;
    for (ids, kind_name, label) in [
        (&rules.pipeline_ids, "configuration", "pipeline"),
        (&rules.group_ids, "group", "group"),
    ] {
        for id in ids {
            let exists: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM records WHERE kind=? AND id=?)")
                    .bind(kind_name)
                    .bind(id)
                    .fetch_one(&mut *db)
                    .await?;
            if !exists {
                return Err(ApiError::invalid(format!(
                    "A chosen {label} no longer exists"
                )));
            }
        }
    }
    let mut data = json!({
        "name": name,
        "kind": kind.as_str(),
        "enabled": enabled,
        "allow_private": allow_private,
        "rules": rules.to_json(),
        "webhook": Value::Null,
        "email": Value::Null,
    });
    match kind {
        Kind::Webhook => {
            let input = &body["webhook"];
            if !input.is_object() {
                return Err(ApiError::invalid("Enter the webhook settings"));
            }
            if let Some(key) = input.as_object().unwrap().keys().find(|k| {
                !["url", "signing_secret", "header_name", "header_value"].contains(&k.as_str())
            }) {
                return Err(ApiError::invalid(format!("Unknown webhook setting {key}")));
            }
            match input.get("url") {
                Some(Value::String(url)) if !url.trim().is_empty() => {
                    if secrets.url.as_deref() != Some(url.trim()) {
                        changes.push("URL".to_owned());
                    }
                    secrets.url = Some(url.trim().to_owned());
                }
                None if secrets.url.is_some() => {}
                _ => return Err(ApiError::invalid("Enter the webhook URL")),
            }
            let destination =
                outbound::webhook_destination(secrets.url.as_deref().unwrap_or(""), allow_private)
                    .map_err(ApiError::invalid)?;
            let signing = secret_edit(input, "signing_secret", 256, "The signing secret")?;
            if let Edit::Set(secret) = &signing {
                if secret.chars().count() < 16 {
                    return Err(ApiError::invalid(
                        "Use a signing secret of at least 16 characters",
                    ));
                }
            }
            if !matches!(signing, Edit::Keep) {
                changes.push("signing secret".to_owned());
            }
            apply(signing, &mut secrets.signing_secret);
            let header = match input.get("header_name") {
                None => previous
                    .and_then(|p| p["webhook"]["header_name"].as_str())
                    .map(str::to_owned),
                Some(Value::Null) => None,
                Some(Value::String(s)) if s.trim().is_empty() => None,
                Some(Value::String(s)) => Some(header_name(s)?),
                Some(_) => return Err(ApiError::invalid("The header name must be text")),
            };
            let value_edit = secret_edit(input, "header_value", 4096, "The header value")?;
            if let Edit::Set(value) = &value_edit {
                if !header_value_ok(value) {
                    return Err(ApiError::invalid(
                        "The header value can use printable ASCII characters only",
                    ));
                }
            }
            if !matches!(value_edit, Edit::Keep) {
                changes.push("header value".to_owned());
            }
            apply(value_edit, &mut secrets.header_value);
            if header.is_none() {
                secrets.header_value = None;
            } else if secrets.header_value.is_none() {
                return Err(ApiError::invalid("Enter a value for the header"));
            }
            data["webhook"] = json!({
                "url_hint": outbound::url_hint(&destination),
                "host": destination.host,
                "header_name": header,
            });
            secrets.password = None;
        }
        Kind::Email => {
            let input = &body["email"];
            if !input.is_object() {
                return Err(ApiError::invalid("Enter the email settings"));
            }
            if let Some(key) = input.as_object().unwrap().keys().find(|k| {
                ![
                    "host", "port", "security", "username", "password", "from", "to",
                ]
                .contains(&k.as_str())
            }) {
                return Err(ApiError::invalid(format!("Unknown email setting {key}")));
            }
            let host = text_field(input, "host", 253, "the SMTP server")?.to_ascii_lowercase();
            if host.contains(['/', ' ', '@', ':']) && host.parse::<std::net::IpAddr>().is_err() {
                return Err(ApiError::invalid(
                    "Enter the SMTP server's host name, without a port",
                ));
            }
            if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                outbound::permitted(ip, allow_private).map_err(ApiError::invalid)?;
            } else if !allow_private && (host == "localhost" || host.ends_with(".localhost")) {
                return Err(ApiError::invalid(
                    "localhost is this server's loopback address. Turn on Allow private network addresses to send there",
                ));
            }
            let port = input["port"]
                .as_u64()
                .filter(|p| (1..=65535).contains(p))
                .ok_or_else(|| ApiError::invalid("Enter a port between 1 and 65535"))?;
            let security = outbound::SmtpSecurity::parse(input["security"].as_str().unwrap_or(""))
                .ok_or_else(|| ApiError::invalid("Choose STARTTLS, TLS or none"))?;
            if security == outbound::SmtpSecurity::None {
                let loopback = host == "localhost"
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback());
                if !loopback || !allow_private {
                    return Err(ApiError::invalid(
                        "Unencrypted email only goes to a relay on this server (localhost), with Allow private network addresses on",
                    ));
                }
            }
            let username = match &input["username"] {
                Value::Null => None,
                Value::String(s) if s.trim().is_empty() => None,
                Value::String(s)
                    if s.chars().count() <= 256 && !s.chars().any(char::is_control) =>
                {
                    Some(s.trim().to_owned())
                }
                _ => {
                    return Err(ApiError::invalid(
                        "Enter a user name of at most 256 characters",
                    ));
                }
            };
            let password = secret_edit(input, "password", 1024, "The password")?;
            if !matches!(password, Edit::Keep) {
                changes.push("password".to_owned());
            }
            apply(password, &mut secrets.password);
            if username.is_none() {
                secrets.password = None;
            } else if secrets.password.is_none() {
                return Err(ApiError::invalid("Enter the password for this user name"));
            }
            let from = text_field(input, "from", 320, "a from address")?.to_owned();
            if !outbound::valid_mailbox(&from) {
                return Err(ApiError::invalid("Enter a valid from address"));
            }
            let to = input["to"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Enter at least one recipient"))?
                .iter()
                .map(|v| v.as_str().map(|s| s.trim().to_owned()))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| ApiError::invalid("Recipients must be email addresses"))?;
            if to.is_empty() || to.len() > MAX_RECIPIENTS {
                return Err(ApiError::invalid(format!(
                    "Enter 1 to {MAX_RECIPIENTS} recipients"
                )));
            }
            if let Some(bad) = to
                .iter()
                .find(|a| a.chars().count() > 320 || !outbound::valid_mailbox(a))
            {
                return Err(ApiError::invalid(format!(
                    "{} isn't a valid address",
                    bounded(bad, 60)
                )));
            }
            data["email"] = json!({
                "host": host,
                "port": port,
                "security": security.as_str(),
                "username": username,
                "from": from,
                "to": to,
            });
            secrets.url = None;
            secrets.signing_secret = None;
            secrets.header_value = None;
        }
    }
    if let Some(previous) = previous {
        for (key, label) in [
            ("name", "name"),
            ("enabled", "on/off"),
            ("rules", "what it sends"),
            ("webhook", "webhook settings"),
            ("email", "email settings"),
        ] {
            let before = if key == "webhook" {
                json!([
                    previous["webhook"]["host"],
                    previous["webhook"]["header_name"]
                ])
            } else {
                previous[key].clone()
            };
            let after = if key == "webhook" {
                json!([data["webhook"]["host"], data["webhook"]["header_name"]])
            } else {
                data[key].clone()
            };
            if before != after {
                changes.push(label.to_owned());
            }
        }
        if previous["allow_private"] != data["allow_private"] {
            changes.push(if allow_private {
                "private network addresses allowed".to_owned()
            } else {
                "private network addresses no longer allowed".to_owned()
            });
        }
    }
    Ok(Proposal {
        data,
        secrets,
        changes,
    })
}
fn destination_label(data: &Value) -> String {
    match data["kind"].as_str() {
        Some("email") => format!(
            "Email through {}:{}",
            data["email"]["host"].as_str().unwrap_or(""),
            data["email"]["port"]
        ),
        _ => format!(
            "Webhook to {}",
            data["webhook"]["host"].as_str().unwrap_or("")
        ),
    }
}
async fn audit(
    db: &mut SqliteConnection,
    actor: &Value,
    action: &str,
    target: &str,
    outcome: &str,
    name: &str,
    summary: String,
) -> Result<()> {
    db::insert(
        db,
        "audit",
        &json!({
            "id": db::id(),
            "actor": actor["id"],
            "action": action,
            "target": target,
            "outcome": outcome,
            "created_at": db::now(),
            "details": {"name": bounded(name, 100), "summary": bounded(&summary, 500)},
        }),
    )
    .await
}

/// The public view of a channel: settings and delivery status, never a secret.
async fn view(
    db: &mut SqliteConnection,
    channel: &Channel,
    secrets: Option<&Secrets>,
) -> Result<Value> {
    let mut out = channel.data.clone();
    out["id"] = json!(channel.id);
    out["revision"] = json!(channel.revision);
    let row = sqlx::query("SELECT created_at,updated_at FROM notification_channels WHERE id=?")
        .bind(&channel.id)
        .fetch_one(&mut *db)
        .await?;
    out["created_at"] = json!(row.get::<String, _>("created_at"));
    out["updated_at"] = json!(row.get::<String, _>("updated_at"));
    let set = |value: Option<&Option<String>>| value.is_some_and(Option::is_some);
    match channel.kind {
        Kind::Webhook => {
            out["webhook"]["signing_secret_set"] = json!(set(secrets.map(|s| &s.signing_secret)));
            out["webhook"]["header_value_set"] = json!(set(secrets.map(|s| &s.header_value)));
        }
        Kind::Email => {
            out["email"]["password_set"] = json!(set(secrets.map(|s| &s.password)));
        }
    }
    out["secrets_readable"] = json!(secrets.is_some());
    let last = sqlx::query("SELECT at,outcome,error,status_code FROM notification_attempts WHERE channel_id=? ORDER BY at DESC,id DESC LIMIT 1")
        .bind(&channel.id)
        .fetch_optional(&mut *db)
        .await?;
    let delivered: Option<String> = sqlx::query_scalar(
        "SELECT at FROM notification_attempts WHERE channel_id=? AND outcome='delivered' ORDER BY at DESC,id DESC LIMIT 1",
    )
    .bind(&channel.id)
    .fetch_optional(&mut *db)
    .await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_deliveries WHERE channel_id=? AND status IN ('queued','held','sending','retrying')",
    )
    .bind(&channel.id)
    .fetch_one(&mut *db)
    .await?;
    let state = if !channel.enabled {
        "off"
    } else {
        match last.as_ref().map(|r| r.get::<String, _>("outcome")) {
            None => "idle",
            Some(o) if o == "delivered" => "delivering",
            Some(_) => "failing",
        }
    };
    out["status"] = json!({
        "state": state,
        "last_attempt_at": last.as_ref().map(|r| r.get::<String, _>("at")),
        "last_delivered_at": delivered,
        "last_error": last.as_ref().and_then(|r| r.get::<Option<String>, _>("error")),
        "last_status_code": last.as_ref().and_then(|r| r.get::<Option<i64>, _>("status_code")),
        "pending": pending,
    });
    Ok(out)
}
fn readable(s: &crate::App, channel: &Channel) -> Option<Secrets> {
    open(s, &channel.id, &channel.sealed).ok()
}

/// `GET /api/v1/notifications/channels` (administrators).
pub async fn list(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    let mut conn = s.pool.acquire().await?;
    let mut items = Vec::new();
    for channel in channels(&mut conn).await? {
        let secrets = readable(&s, &channel);
        items.push(view(&mut conn, &channel, secrets.as_ref()).await?);
    }
    Ok(Json(json!({"items": items, "max_channels": MAX_CHANNELS})))
}
/// `GET /api/v1/notifications/channels/{id}` (administrators).
pub async fn detail(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    let mut conn = s.pool.acquire().await?;
    let channel = channel(&mut conn, &id).await?;
    let secrets = readable(&s, &channel);
    Ok(Json(view(&mut conn, &channel, secrets.as_ref()).await?))
}
fn body(input: std::result::Result<Json<Value>, JsonRejection>) -> Result<Value> {
    input
        .map(|Json(v)| v)
        .map_err(|_| ApiError::invalid("Send the channel settings as JSON"))
}
/// `POST /api/v1/notifications/channels` (administrators, CSRF, audited).
pub async fn create(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let body = body(input)?;
    if body.get("revision").is_some() {
        return Err(ApiError::invalid("A new channel has no revision"));
    }
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_channels")
        .fetch_one(&mut *tx)
        .await?;
    if count as usize >= MAX_CHANNELS {
        return Err(ApiError::conflict(format!(
            "An instance holds at most {MAX_CHANNELS} channels. Remove one first"
        )));
    }
    let proposal = propose(&mut tx, &body, None).await?;
    unique_name(&mut tx, proposal.data["name"].as_str().unwrap_or(""), None).await?;
    let id = db::id();
    let now = db::now();
    sqlx::query("INSERT INTO notification_channels(id,data,sealed,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)")
        .bind(&id)
        .bind(proposal.data.to_string())
        .bind(seal(&s, &id, &proposal.secrets)?)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    let name = proposal.data["name"].as_str().unwrap_or("").to_owned();
    let mut summary = format!("{}.", destination_label(&proposal.data));
    if proposal.data["allow_private"] == true {
        summary.push_str(" Private network addresses allowed.");
    }
    audit(
        &mut tx,
        &actor,
        "notification.channel.create",
        &id,
        "success",
        &name,
        summary,
    )
    .await?;
    let channel = channel(&mut tx, &id).await?;
    let out = view(&mut tx, &channel, Some(&proposal.secrets)).await?;
    tx.commit().await?;
    Ok(Json(out))
}
async fn unique_name(db: &mut SqliteConnection, name: &str, except: Option<&str>) -> Result<()> {
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM notification_channels WHERE lower(json_extract(data,'$.name'))=lower(?) AND id IS NOT ?)",
    )
    .bind(name)
    .bind(except)
    .fetch_one(&mut *db)
    .await?;
    if taken {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "NAME_TAKEN",
            "Another channel has this name. Choose another",
        ));
    }
    Ok(())
}
/// `PUT /api/v1/notifications/channels/{id}` with `revision` (administrators,
/// CSRF, audited). Secret fields left out keep their saved value.
pub async fn update(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    input: std::result::Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let body = body(input)?;
    let revision = body["revision"]
        .as_i64()
        .ok_or_else(|| ApiError::invalid("Send the channel's revision"))?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let current = channel(&mut tx, &id).await?;
    if current.revision != revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Someone changed this channel. Review it before saving",
        ));
    }
    // Unreadable secrets (restored without the keys) must be replaced, and
    // may be: the edit supplies every secret the channel needs.
    let secrets = open(&s, &id, &current.sealed).unwrap_or_default();
    let proposal = propose(&mut tx, &body, Some((&current, secrets))).await?;
    unique_name(
        &mut tx,
        proposal.data["name"].as_str().unwrap_or(""),
        Some(&id),
    )
    .await?;
    sqlx::query("UPDATE notification_channels SET data=?,sealed=?,revision=revision+1,updated_at=? WHERE id=?")
        .bind(proposal.data.to_string())
        .bind(seal(&s, &id, &proposal.secrets)?)
        .bind(db::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if proposal.data["enabled"] == false {
        drop_pending(&mut tx, &id).await?;
    }
    let name = proposal.data["name"].as_str().unwrap_or("").to_owned();
    let summary = if proposal.changes.is_empty() {
        "No changes.".to_owned()
    } else {
        let mut list = proposal.changes.clone();
        list.dedup();
        format!("Changed {}.", list.join(", "))
    };
    audit(
        &mut tx,
        &actor,
        "notification.channel.update",
        &id,
        "success",
        &name,
        summary,
    )
    .await?;
    let channel = channel(&mut tx, &id).await?;
    let out = view(&mut tx, &channel, Some(&proposal.secrets)).await?;
    tx.commit().await?;
    Ok(Json(out))
}
/// Pending messages of a removed or turned-off channel never go out.
async fn drop_pending(db: &mut SqliteConnection, id: &str) -> Result<()> {
    sqlx::query("UPDATE notification_deliveries SET status='dropped',next_attempt_at=NULL,updated_at=? WHERE channel_id=? AND status IN ('queued','held','retrying')")
        .bind(db::now())
        .bind(id)
        .execute(&mut *db)
        .await?;
    Ok(())
}
/// `DELETE /api/v1/notifications/channels/{id}` (administrators, CSRF,
/// audited). Its delivery log stays until it ages out.
pub async fn remove(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let current = channel(&mut tx, &id).await?;
    sqlx::query("DELETE FROM notification_channels WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    drop_pending(&mut tx, &id).await?;
    audit(
        &mut tx,
        &actor,
        "notification.channel.delete",
        &id,
        "success",
        &current.name,
        format!("{}.", destination_label(&current.data)),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok": true})))
}
/// `POST /api/v1/notifications/channels/{id}/test` (administrators, CSRF,
/// audited): send one clearly marked test message now and answer with what
/// actually happened. The writer lock is never held while it sends.
pub async fn test(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    s.limit(
        format!("notification-test:{id}"),
        TEST_SENDS_PER_MINUTE,
        std::time::Duration::from_secs(60),
    )?;
    let delivery = db::id();
    let now = Utc::now();
    let (channel, secrets, notice) = {
        let (_guard, mut tx) = db::write_tx(&s).await?;
        auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
        let channel = channel(&mut tx, &id).await?;
        let secrets = open(&s, &id, &channel.sealed)?;
        let notice = crate::notifier::test_notice(&channel, now);
        sqlx::query("INSERT INTO notification_deliveries(id,channel_id,event_id,kind,status,attempts,next_attempt_at,data,created_at,updated_at) VALUES(?,?,NULL,'test','sending',1,NULL,?,?,?)")
            .bind(&delivery)
            .bind(&id)
            .bind(json!({"notice": notice}).to_string())
            .bind(db::now())
            .bind(db::now())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        (channel, secrets, notice)
    };
    // The network wait happens here, with no lock and no transaction open.
    let outcome = crate::notifier::send(&s, &channel, &secrets, &delivery, &notice).await;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let attempt = crate::notifier::record(
        &mut tx,
        crate::notifier::Recorded {
            delivery: &delivery,
            channel: &channel,
            attempt: 1,
            at: now,
            outcome: &outcome,
            // A test is sent once and never retried.
            next_attempt_at: None,
            summary: &notice,
        },
    )
    .await?;
    audit(
        &mut tx,
        &actor,
        "notification.channel.test",
        &id,
        // The audit log's own words: the summary says what the receiver did.
        if outcome.delivered {
            "success"
        } else {
            "failed"
        },
        &channel.name,
        match &outcome.error {
            None => format!("Test message delivered in {} ms.", outcome.latency_ms),
            Some(error) => format!("Test message failed: {error}"),
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({
        "attempt_id": attempt,
        "delivered": outcome.delivered,
        "status_code": outcome.status,
        "latency_ms": outcome.latency_ms,
        "error": outcome.error,
        "at": now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    })))
}
/// `POST /api/v1/notifications/preview {kind,type}` (administrators): an
/// example of the message a channel would send, clearly marked as one.
pub async fn preview(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let body = body(input)?;
    let kind = body["type"].as_str().unwrap_or("issue.opened");
    if !EVENTS.contains(&kind) {
        return Err(ApiError::invalid("Unknown event type"));
    }
    let name = body["name"]
        .as_str()
        .map(|n| bounded(n.trim(), 80))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "New channel".to_owned());
    let notice = crate::notifier::example_notice(kind, Utc::now());
    Ok(Json(crate::notifier::preview(&s, &name, &notice)))
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeliveryQuery {
    channel_id: Option<String>,
    outcome: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}
/// `GET /api/v1/notifications/deliveries`: every attempt, newest first,
/// paged (administrators). Kept 30 days.
pub async fn deliveries(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<DeliveryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    let q = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (_, page, size, offset) = crate::deployment_history::bounds(None, q.page, q.page_size)?;
    if let Some(outcome) = q.outcome.as_deref() {
        if !["delivered", "retrying", "failed", "gave_up"].contains(&outcome) {
            return Err(ApiError::invalid(
                "outcome must be delivered, retrying, failed or gave_up",
            ));
        }
    }
    if q.channel_id
        .as_deref()
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err(ApiError::invalid("channel_id must be an ID"));
    }
    // "Retrying" is a failed attempt with a retry scheduled; "failed" is one
    // that won't be retried.
    let filter = |q2: &mut sqlx::QueryBuilder<'_, sqlx::Sqlite>| {
        q2.push(" WHERE 1=1");
        if let Some(channel) = &q.channel_id {
            q2.push(" AND a.channel_id=").push_bind(channel.clone());
        }
        match q.outcome.as_deref() {
            Some("retrying") => {
                q2.push(" AND a.outcome='failed' AND a.next_attempt_at IS NOT NULL");
            }
            Some("failed") => {
                q2.push(" AND a.outcome='failed' AND a.next_attempt_at IS NULL");
            }
            Some(outcome) => {
                q2.push(" AND a.outcome=").push_bind(outcome.to_owned());
            }
            None => {}
        }
    };
    let mut tx = s.pool.begin().await?;
    let mut count = sqlx::QueryBuilder::new("SELECT count(*) FROM notification_attempts a");
    filter(&mut count);
    let total: i64 = count.build_query_scalar().fetch_one(&mut *tx).await?;
    let mut page_query = sqlx::QueryBuilder::new(
        "SELECT a.id,a.delivery_id,a.channel_id,a.attempt,a.at,a.outcome,a.status_code,a.latency_ms,a.error,a.next_attempt_at,a.data,c.data AS channel FROM notification_attempts a LEFT JOIN notification_channels c ON c.id=a.channel_id",
    );
    filter(&mut page_query);
    page_query
        .push(" ORDER BY a.at DESC,a.id DESC LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset);
    let rows = page_query.build().fetch_all(&mut *tx).await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let data = db::parse(row.get("data"))?;
        let current: Option<String> = row.get("channel");
        let current = current.and_then(|c| serde_json::from_str::<Value>(&c).ok());
        let outcome: String = row.get("outcome");
        let next: Option<String> = row.get("next_attempt_at");
        items.push(json!({
            "id": row.get::<i64, _>("id"),
            "delivery_id": row.get::<String, _>("delivery_id"),
            "channel_id": row.get::<String, _>("channel_id"),
            "channel_name": current
                .as_ref()
                .and_then(|c| c["name"].as_str().map(str::to_owned))
                .or_else(|| data["channel_name"].as_str().map(str::to_owned)),
            "channel_exists": current.is_some(),
            "kind": data["kind"],
            "type": data["type"],
            "title": data["title"],
            "attempt": row.get::<i64, _>("attempt"),
            "at": row.get::<String, _>("at"),
            "outcome": if outcome == "failed" && next.is_some() { "retrying".to_owned() } else { outcome },
            "status_code": row.get::<Option<i64>, _>("status_code"),
            "latency_ms": row.get::<i64, _>("latency_ms"),
            "error": row.get::<Option<String>, _>("error"),
            "next_attempt_at": next,
        }));
    }
    Ok(Json(
        json!({"items": items, "total": total, "page": page, "page_size": size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(v: Value) -> std::result::Result<Rules, String> {
        Rules::parse(&v)
    }

    #[test]
    fn rules_validate_events_bounds_and_quiet_hours() {
        assert!(rules(json!({"events":[]})).is_err());
        assert!(rules(json!({"events":["issue.exploded"]})).is_err());
        assert!(rules(json!({"events":["device.offline"],"offline_minutes":4})).is_err());
        assert!(rules(json!({"events":["device.offline"],"offline_minutes":1441})).is_err());
        let r = rules(json!({"events":["device.offline"]})).unwrap();
        assert_eq!(r.offline_minutes, DEFAULT_OFFLINE_MINUTES);
        assert!(rules(json!({"events":["issue.opened"],"quiet_hours":{"start":"22:00","end":"22:00","time_zone":"UTC"}})).is_err());
        assert!(rules(json!({"events":["issue.opened"],"quiet_hours":{"start":"25:00","end":"07:00","time_zone":"UTC"}})).is_err());
        assert!(rules(json!({"events":["issue.opened"],"quiet_hours":{"start":"22:00","end":"07:00","time_zone":"Mars/Base"}})).is_err());
        assert!(rules(json!({"events":["issue.opened"],"surprise":1})).is_err());
        let r = rules(json!({"events":["issue.opened"],"quiet_hours":{"start":"22:00","end":"07:00","time_zone":"Europe/Berlin","errors_bypass":true}})).unwrap();
        assert_eq!(rules(r.to_json()).unwrap().to_json(), r.to_json());
    }

    #[test]
    fn filters_need_every_chosen_dimension() {
        let pipeline = "00000000-0000-4000-8000-000000000001";
        let group = "00000000-0000-4000-8000-000000000002";
        let r = rules(json!({"events":["issue.opened"],"min_severity":"error","pipeline_ids":[pipeline],"group_ids":[group]})).unwrap();
        let groups = BTreeSet::from([group.to_owned()]);
        assert!(r.matches("issue.opened", "error", Some(pipeline), &groups));
        assert!(!r.matches("issue.opened", "warning", Some(pipeline), &groups));
        assert!(!r.matches("issue.resolved", "error", Some(pipeline), &groups));
        assert!(!r.matches("issue.opened", "error", None, &groups));
        assert!(!r.matches("issue.opened", "error", Some(pipeline), &BTreeSet::new()));
        let open = rules(json!({"events":["device.offline"]})).unwrap();
        assert!(open.matches("device.offline", "warning", None, &BTreeSet::new()));
    }

    #[test]
    fn quiet_hours_wrap_midnight_in_the_chosen_zone() {
        let r = rules(json!({"events":["issue.opened"],"quiet_hours":{"start":"22:00","end":"07:00","time_zone":"Europe/Berlin"}})).unwrap();
        let q = r.quiet.unwrap();
        // 21:30 UTC is 23:30 in Berlin in summer.
        let late = DateTime::parse_from_rfc3339("2026-07-01T21:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(q.active(late));
        assert_eq!(q.end_after(late).to_rfc3339(), "2026-07-02T05:00:00+00:00");
        let day = DateTime::parse_from_rfc3339("2026-07-01T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(!q.active(day));
        // Winter time moves the same local hours an hour later in UTC.
        let winter = DateTime::parse_from_rfc3339("2026-01-15T22:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(q.active(winter));
        assert_eq!(
            q.end_after(winter).to_rfc3339(),
            "2026-01-16T06:00:00+00:00"
        );
    }
}
