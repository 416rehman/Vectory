use crate::error::{ApiError, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
tokio::task_local! { pub static REQUEST_ID: String; }
pub type WriteTransaction = sqlx::Transaction<'static, sqlx::Sqlite>;
/// Open a write transaction on a connection that already holds the writer lock.
/// `BEGIN IMMEDIATE` takes SQLite's write lock before the first read, so a write
/// made elsewhere waits out `busy_timeout` instead of failing this transaction
/// with a stale snapshot ("database is locked") after it has read.
pub async fn begin_write(pool: &sqlx::SqlitePool) -> sqlx::Result<WriteTransaction> {
    pool.begin_with("BEGIN IMMEDIATE").await
}
/// Every serialized writer: the process-wide writer lock plus an immediate
/// transaction. Bind as `let (_guard, mut tx)` so the transaction ends first.
pub async fn write_tx(s: &crate::App) -> sqlx::Result<(WriterGuard<'_>, WriteTransaction)> {
    let guard = writer(s).await;
    Ok((guard, begin_write(&s.pool).await?))
}
/// The process-wide writer lock. How long each writer waited for it and held
/// it is counted for the once-a-minute `vectory_server::sqlite` debug line.
pub async fn writer(s: &crate::App) -> WriterGuard<'_> {
    let asked = std::time::Instant::now();
    let guard = s.writer.lock().await;
    let since = std::time::Instant::now();
    WRITER.waited(since - asked);
    WriterGuard {
        _guard: guard,
        since,
    }
}
pub struct WriterGuard<'a> {
    _guard: tokio::sync::MutexGuard<'a, ()>,
    since: std::time::Instant,
}
impl Drop for WriterGuard<'_> {
    fn drop(&mut self) {
        WRITER.held(self.since.elapsed());
    }
}
/// Writer-lock bookkeeping since the last report: fixed-size counters, read
/// and reset once a minute. SQLite has one writer, so the share of time the
/// lock is held says how close the server is to its write capacity.
struct WriterStats {
    writes: std::sync::atomic::AtomicU64,
    wait_micros: std::sync::atomic::AtomicU64,
    wait_max_micros: std::sync::atomic::AtomicU64,
    held_micros: std::sync::atomic::AtomicU64,
    held_max_micros: std::sync::atomic::AtomicU64,
    reported: std::sync::Mutex<Option<std::time::Instant>>,
}
static WRITER: WriterStats = WriterStats {
    writes: std::sync::atomic::AtomicU64::new(0),
    wait_micros: std::sync::atomic::AtomicU64::new(0),
    wait_max_micros: std::sync::atomic::AtomicU64::new(0),
    held_micros: std::sync::atomic::AtomicU64::new(0),
    held_max_micros: std::sync::atomic::AtomicU64::new(0),
    reported: std::sync::Mutex::new(None),
};
fn micros(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}
impl WriterStats {
    fn waited(&self, wait: std::time::Duration) {
        use std::sync::atomic::Ordering::Relaxed;
        self.writes.fetch_add(1, Relaxed);
        self.wait_micros.fetch_add(micros(wait), Relaxed);
        self.wait_max_micros.fetch_max(micros(wait), Relaxed);
    }
    fn held(&self, held: std::time::Duration) {
        use std::sync::atomic::Ordering::Relaxed;
        self.held_micros.fetch_add(micros(held), Relaxed);
        self.held_max_micros.fetch_max(micros(held), Relaxed);
    }
}
/// Log, at debug level on the `vectory_server::sqlite` target, how busy the
/// writer lock was since the last call and how large the WAL is, then reset
/// the counters. The scheduler calls this once a minute.
pub fn report_writer(data_dir: &std::path::Path) {
    use std::sync::atomic::Ordering::Relaxed;
    let now = std::time::Instant::now();
    let since = WRITER
        .reported
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .replace(now);
    let writes = WRITER.writes.swap(0, Relaxed);
    let wait = WRITER.wait_micros.swap(0, Relaxed);
    let wait_max = WRITER.wait_max_micros.swap(0, Relaxed);
    let held = WRITER.held_micros.swap(0, Relaxed);
    let held_max = WRITER.held_max_micros.swap(0, Relaxed);
    let Some(since) = since else {
        return;
    };
    let window = micros(now - since).max(1);
    let wal_bytes = std::fs::metadata(data_dir.join("vectory.db-wal")).map_or(0, |m| m.len());
    let ms = |us: u64| (us as f64 / 1000.0 * 10.0).round() / 10.0;
    tracing::debug!(
        target: "vectory_server::sqlite",
        window_seconds = (window as f64 / 1e6).round(),
        writes,
        busy_percent = (held as f64 / window as f64 * 1000.0).round() / 10.0,
        held_max_ms = ms(held_max),
        wait_mean_ms = ms(wait / writes.max(1)),
        wait_max_ms = ms(wait_max),
        wal_bytes,
        "writer lock since the last report"
    );
}
/// Bring the database to this server's schema. Each migration commits with
/// its bookkeeping row in one transaction, so a failure keeps nothing of that
/// migration. The error says where the database stands and what to do.
pub async fn migrate(
    pool: &sqlx::SqlitePool,
    migrator: &sqlx::migrate::Migrator,
) -> anyhow::Result<()> {
    use sqlx::migrate::MigrateError;
    let Err(error) = migrator.run(pool).await else {
        return Ok(());
    };
    let applied: Option<i64> =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
            .fetch_one(pool)
            .await
            .ok()
            .flatten();
    let at = applied.map_or_else(
        || "an empty schema".to_owned(),
        |version| format!("migration {version}"),
    );
    let named = |version: i64| {
        migrator.iter().find(|m| m.version == version).map_or_else(
            || version.to_string(),
            |m| format!("{version} ({})", m.description),
        )
    };
    let pending = migrator
        .iter()
        .find(|m| applied.is_none_or(|last| m.version > last))
        .map(|m| named(m.version));
    let failed = |version: Option<String>, cause: &dyn std::fmt::Display| {
        anyhow::anyhow!(
            "Vectory could not upgrade its database: migration {} failed: {cause}. Nothing from that migration was kept; the database is still at {at}. Fix the cause and start the server again, or restore the backup you took before upgrading.",
            version.unwrap_or_else(|| "(unknown)".into())
        )
    };
    Err(match error {
        MigrateError::ExecuteMigration(cause, version) => failed(Some(named(version)), &cause),
        MigrateError::Execute(cause) => failed(pending, &cause),
        MigrateError::VersionMissing(version) => anyhow::anyhow!(
            "This database was upgraded by a newer Vectory: it has migration {version}, which this server doesn't include. Migrations only move forward. Run that newer version, or restore a backup taken before the upgrade."
        ),
        MigrateError::VersionMismatch(version) => anyhow::anyhow!(
            "Migration {} in this database differs from the one this server ships. Run the Vectory version that migrated it, or restore a backup.",
            named(version)
        ),
        MigrateError::Dirty(version) => anyhow::anyhow!(
            "Migration {} is marked as partly applied. Restore the backup you took before upgrading.",
            named(version)
        ),
        other => anyhow::anyhow!(
            "Vectory could not upgrade its database: {other}. The database is still at {at}."
        ),
    })
}
pub const TELEMETRY_RETENTION_VARIABLE: &str = "VECTORY_TELEMETRY_RETENTION_DAYS";
const TELEMETRY_RETENTION_DEFAULT_DAYS: i64 = 7;
const TELEMETRY_RETENTION_RANGE: std::ops::RangeInclusive<i64> = 1..=30;
/// Days of device metrics history to keep for the value the variable holds
/// (`None` when it is unset). Unset or empty is the default; anything that is
/// not a whole number of days in the range is an error that names the
/// variable, the value and the range, never a different retention.
fn telemetry_retention(value: Option<&str>) -> std::result::Result<i64, String> {
    let Some(given) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(TELEMETRY_RETENTION_DEFAULT_DAYS);
    };
    given
        .parse::<i64>()
        .ok()
        .filter(|days| TELEMETRY_RETENTION_RANGE.contains(days))
        .ok_or_else(|| {
            format!(
                "{TELEMETRY_RETENTION_VARIABLE} must be a whole number of days from {} to {}, not {:?}",
                TELEMETRY_RETENTION_RANGE.start(),
                TELEMETRY_RETENTION_RANGE.end(),
                given.chars().take(40).collect::<String>()
            )
        })
}
/// Stops the server at startup, before it opens anything, when the variable
/// holds a retention it would otherwise have to replace.
pub fn check_telemetry_retention(value: Option<&str>) -> anyhow::Result<()> {
    telemetry_retention(value)
        .map(|_| ())
        .map_err(anyhow::Error::msg)
}
pub fn telemetry_retention_days() -> i64 {
    // A server that started has checked the variable already.
    telemetry_retention(std::env::var(TELEMETRY_RETENTION_VARIABLE).ok().as_deref())
        .unwrap_or(TELEMETRY_RETENTION_DEFAULT_DAYS)
}
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
pub fn parse(s: &str) -> Result<Value> {
    serde_json::from_str(s).map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Stored record is invalid",
        )
    })
}
pub fn normalize_variables(kind: &str, mut value: Value) -> Value {
    if ["configuration", "revision", "version"].contains(&kind) && value.get("variables").is_none()
    {
        value["variables"] = json!([]);
    }
    value
}
pub async fn records(db: &mut SqliteConnection, kind: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT data FROM records WHERE kind=? ORDER BY created_at DESC,id")
        .bind(kind)
        .fetch_all(db)
        .await?;
    rows.iter()
        .map(|r| parse(r.get::<&str, _>(0)).map(|v| normalize_variables(kind, v)))
        .collect()
}
pub async fn record(db: &mut SqliteConnection, kind: &str, id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT data FROM records WHERE kind=? AND id=?")
        .bind(kind)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::missing)?;
    parse(row.get(0)).map(|v| normalize_variables(kind, v))
}
pub async fn insert(db: &mut SqliteConnection, kind: &str, v: &Value) -> Result<()> {
    let audit = if kind == "audit" {
        let mut event = v.clone();
        event["request_id"] = json!(REQUEST_ID.try_with(Clone::clone).unwrap_or_else(|_| id()));
        Some(event)
    } else {
        None
    };
    let v = audit.as_ref().unwrap_or(v);
    sqlx::query("INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)")
        .bind(kind)
        .bind(
            v["id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("Missing ID"))?,
        )
        .bind(v.to_string())
        .bind(v["created_at"].as_str().unwrap_or(&now()))
        .execute(db)
        .await?;
    Ok(())
}
pub async fn update(db: &mut SqliteConnection, kind: &str, v: &Value) -> Result<()> {
    sqlx::query("UPDATE records SET data=? WHERE kind=? AND id=?")
        .bind(v.to_string())
        .bind(kind)
        .bind(
            v["id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("Missing ID"))?,
        )
        .execute(db)
        .await?;
    Ok(())
}
pub async fn audit(
    db: &mut SqliteConnection,
    actor: &str,
    action: &str,
    target: &str,
    outcome: &str,
) -> Result<()> {
    insert(db,"audit",&json!({"id":id(),"actor":actor,"action":action,"target":target,"outcome":outcome,"created_at":now()})).await
}
pub fn string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let x = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid(format!("{key} must be a string")))?;
    if x.is_empty() || x.len() > max || x.chars().any(|c| c == '\0') {
        return Err(ApiError::invalid(format!(
            "{key} has invalid length or characters"
        )));
    }
    Ok(x)
}
/// A character that can't be shown safely in one line of text: a control
/// character (C0, DEL or C1), a line or paragraph separator, or a bidirectional
/// embedding, override or isolate control, which reorders the text after it.
/// The agent holds pipeline names and its own reports to the same rule.
pub fn hostile_display_char(c: char) -> bool {
    c.is_control() || matches!(u32::from(c), 0x2028 | 0x2029 | 0x202a..=0x202e | 0x2066..=0x2069)
}

/// A character a member that names or identifies something may not hold: what
/// `hostile_display_char` refuses, and the byte order mark, which is invisible
/// and has no place inside a name, a version or a path. Display text is
/// forgiving (`display_text` replaces such a character); a member the server
/// acts on or shows as a name is not, so one rule judges them all: component
/// IDs and output names, versions, request and boot IDs, and directories.
pub fn refused_in_name(c: char) -> bool {
    hostile_display_char(c) || c == '\u{feff}'
}

/// `string`, for a member that names or identifies something: the same bounds
/// (not empty, at most `max` bytes) and no character `refused_in_name`.
pub fn name_string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let x = string(v, key, max)?;
    if x.chars().any(refused_in_name) {
        return Err(ApiError::invalid(format!(
            "{key} has invalid length or characters"
        )));
    }
    Ok(x)
}

/// Text a device reports for people to read: a log message, or a diagnostic's
/// message, hint or field. It is best effort, so a character that can't be
/// shown safely is replaced and never a reason to refuse the check-in: each one
/// becomes a space, runs of white space collapse and the ends are trimmed. Text
/// without such a character is kept exactly as sent. The result is empty when
/// nothing printable is left. `None` when the value isn't a string or has no
/// characters or more than `max`, counted as sent: those are a malformed report.
pub fn display_text(value: &Value, max: usize) -> Option<String> {
    let text = value.as_str()?;
    if !(1..=max).contains(&text.chars().count()) {
        return None;
    }
    if !text.chars().any(hostile_display_char) {
        return Some(text.to_owned());
    }
    let spaced: String = text
        .chars()
        .map(|c| if hostile_display_char(c) { ' ' } else { c })
        .collect();
    Some(spaced.split_whitespace().collect::<Vec<_>>().join(" "))
}
pub fn default_policy() -> Value {
    json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true})
}
pub fn validate_policy(v: &Value) -> Result<()> {
    let interval = v["heartbeat_seconds"]
        .as_u64()
        .ok_or_else(|| ApiError::invalid("heartbeat_seconds must be an integer"))?;
    if !(10..=3600).contains(&interval)
        || !v["sync_paused"].is_boolean()
        || !v["telemetry_enabled"].is_boolean()
        || v.as_object().is_none_or(|o| o.len() != 3)
    {
        return Err(ApiError::invalid(
            "Policy requires heartbeat_seconds 10..3600 and sync_paused/telemetry_enabled booleans",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod telemetry_retention_tests {
    use super::{check_telemetry_retention, telemetry_retention};

    #[test]
    fn unset_empty_or_in_range_values_are_used() {
        for (given, days) in [
            (None, 7),
            (Some(""), 7),
            (Some("  "), 7),
            (Some("1"), 1),
            (Some(" 14 "), 14),
            (Some("30"), 30),
        ] {
            assert_eq!(telemetry_retention(given), Ok(days), "{given:?}");
            assert!(check_telemetry_retention(given).is_ok(), "{given:?}");
        }
    }

    #[test]
    fn anything_else_stops_the_server_with_the_variable_the_value_and_the_range() {
        for given in ["x", "30d", "7.5", "1e1", "0", "31", "90", "-5", "many"] {
            let error = check_telemetry_retention(Some(given))
                .unwrap_err()
                .to_string();
            assert_eq!(
                error,
                format!(
                    "VECTORY_TELEMETRY_RETENTION_DAYS must be a whole number of days from 1 to 30, not {given:?}"
                )
            );
        }
    }

    #[test]
    fn a_long_or_multi_line_value_is_cut_and_escaped_in_the_sentence() {
        let error = telemetry_retention(Some(
            "7\nINJECTED log line, and a very long tail 0123456789 0123456789 0123456789",
        ))
        .unwrap_err();
        assert!(!error.contains('\n'), "{error}");
        assert!(error.len() < 200, "{error}");
    }
}

#[cfg(test)]
mod name_tests {
    use super::*;

    fn refused(text: &str) -> bool {
        name_string(&json!({"v": text}), "v", 128).is_err()
    }

    #[test]
    fn a_name_refuses_what_display_text_replaces_and_the_byte_order_mark() {
        // Built from code points: C0 and C1 controls, DEL, the line and
        // paragraph separators, the embedding, override and isolate controls,
        // and the byte order mark.
        for code in [
            0x00, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0x202a, 0x202b,
            0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
        ] {
            let c = char::from_u32(code).unwrap();
            assert!(refused_in_name(c), "U+{code:04X}");
            assert!(refused(&format!("0.1{c}")), "U+{code:04X} at the end");
            assert!(refused(&format!("{c}0.1")), "U+{code:04X} at the start");
        }
    }

    #[test]
    fn real_versions_and_paths_are_names() {
        for text in [
            "0.1.0",
            "0.58.1-rc.1",
            "0.58.0+build.20260926",
            "linux",
            "amd64",
            "C:\\Program Files\\Vectory Agent",
            "D:\\Données Müller\\Vectory Agent",
            "/var/lib/vectory agent/état",
            "日本語のディレクトリ",
            // Marks and joiners that scripts use inside words stay.
            "a\u{200c}b\u{200d}c\u{200e}d\u{200f}e\u{061c}f",
        ] {
            assert!(!refused(text), "{text}");
        }
    }

    #[test]
    fn the_bounds_are_the_same_as_for_any_string() {
        assert!(refused(""));
        assert!(refused(&"x".repeat(129)));
        assert!(!refused(&"x".repeat(128)));
        assert!(name_string(&json!({}), "v", 128).is_err());
        assert!(name_string(&json!({"v": 7}), "v", 128).is_err());
    }
}

#[cfg(test)]
mod display_text_tests {
    use super::*;

    fn shown(text: &str) -> Option<String> {
        display_text(&json!(text), 300)
    }

    #[test]
    fn text_that_can_be_shown_is_kept_exactly() {
        for text in [
            "Request failed: the destination refused the connection.",
            "  spaced   out  ",
            "émoji 🙂 and 日本語",
        ] {
            assert_eq!(shown(text).as_deref(), Some(text));
        }
    }

    #[test]
    fn hostile_characters_become_one_space_each_run() {
        // Built from code points: C0 and C1 controls, DEL, line and paragraph
        // separators, and the embedding, override and isolate controls.
        for code in [
            0x00, 0x01, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0x202a,
            0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
        ] {
            let c = char::from_u32(code).unwrap();
            assert!(hostile_display_char(c) || c.is_whitespace(), "U+{code:04X}");
            assert_eq!(
                shown(&format!("a{c}b")).as_deref(),
                Some("a b"),
                "U+{code:04X}"
            );
            assert_eq!(
                shown(&format!("{c}{c} a {c}{c}b{c}")).as_deref(),
                Some("a b"),
                "U+{code:04X}"
            );
        }
        assert_eq!(shown("one\r\ntwo\nthree").as_deref(), Some("one two three"));
        // Nothing printable is left: the caller decides what to say.
        assert_eq!(shown("\u{7}\u{1b}").as_deref(), Some(""));
    }

    #[test]
    fn bounds_and_types_are_the_reports_not_the_text() {
        assert_eq!(display_text(&json!(""), 300), None);
        assert_eq!(display_text(&json!(7), 300), None);
        assert_eq!(display_text(&Value::Null, 300), None);
        // Counted as sent: 301 bell characters are too long though they leave
        // nothing, and 300 are accepted.
        assert_eq!(display_text(&json!("\u{7}".repeat(301)), 300), None);
        assert_eq!(
            display_text(&json!("\u{7}".repeat(300)), 300).as_deref(),
            Some("")
        );
        assert_eq!(
            display_text(&json!("é".repeat(300)), 300).map(|t| t.chars().count()),
            Some(300)
        );
        assert_eq!(display_text(&json!("é".repeat(301)), 300), None);
    }

    #[test]
    fn marks_that_do_not_reorder_text_stay() {
        let marks = format!(
            "a{}b{}c",
            char::from_u32(0x200e).unwrap(),
            char::from_u32(0x200f).unwrap()
        );
        assert_eq!(shown(&marks).as_deref(), Some(marks.as_str()));
    }
}
