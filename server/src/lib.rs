pub mod access_requests;
pub mod accounts;
pub mod api;
pub mod assignment_removal;
pub mod audit;
pub mod audit_exports;
pub mod auth;
pub mod canary_gate;
pub mod configuration_attempt;
pub mod crypto;
pub mod db;
pub mod deployment_history;
pub mod deployment_requests;
pub mod device;
pub mod device_recovery_requests;
pub mod device_revocation;
pub mod error;
pub mod group_requests;
pub mod groups;
pub mod issues;
pub mod login_challenges;
pub mod maintenance;
pub mod mfa;
pub mod pipeline_library;
pub mod pipeline_requests;
pub mod pipelines;
pub mod policy_requests;
pub mod publication_requests;
pub mod reset_requests;
pub mod restored_access;
pub mod rollback_review;
pub mod rollout;
pub mod scheduled_refresh;
pub mod token_requests;
pub mod user_requests;
pub mod validation;
pub mod variables;
#[cfg(windows)]
mod windows_acl;

use anyhow::Context;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Clone)]
pub struct Settings {
    pub data_dir: PathBuf,
    pub bootstrap_secret: String,
    pub cookie_secure: bool,
    pub dashboard_dir: PathBuf,
    pub releases_dir: PathBuf,
    pub instance_name: String,
    pub validation_url: Option<String>,
}
pub struct App {
    pub pool: SqlitePool,
    pub writer: Mutex<()>,
    pub settings: Settings,
    pub keys: crypto::Keys,
    pub audit_exports: Arc<audit_exports::Store>,
    pub validation_slots: tokio::sync::Semaphore,
    pub agent_request_slots: tokio::sync::Semaphore,
    pub instance_lock: std::fs::File,
    pub limits: std::sync::Mutex<HashMap<String, (Instant, u32, Duration)>>,
    pub device_limits: std::sync::Mutex<HashMap<String, (Instant, u32, Duration)>>,
}
pub type State = Arc<App>;
pub async fn initialize(settings: Settings) -> anyhow::Result<State> {
    std::fs::create_dir_all(&settings.data_dir)?;
    crypto::restrict_state(&settings.data_dir)
        .context("Cannot protect control-plane state directory")?;
    let instance_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(settings.data_dir.join("instance.lock"))?;
    fs2::FileExt::try_lock_exclusive(&instance_lock)
        .map_err(|_| anyhow::anyhow!("Another control-plane instance holds this data directory"))?;
    let options = SqliteConnectOptions::new()
        .filename(settings.data_dir.join("vectory.db"))
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    sqlx::migrate!().run(&pool).await?;
    // A restart or point-in-time restore must never resume a password-verified
    // pre-session capability. The exclusive instance lock makes this safe.
    sqlx::query("DELETE FROM login_challenges")
        .execute(&pool)
        .await?;
    let mfa_rows: i64 = sqlx::query_scalar("SELECT count(*) FROM user_mfa")
        .fetch_one(&pool)
        .await?;
    if mfa_rows > 0 && !settings.data_dir.join("keys/mfa-sealing.key").exists() {
        anyhow::bail!(
            "MFA records exist but the MFA sealing key is missing; restore the complete matching keys directory before starting"
        )
    }
    let keys = crypto::Keys::load(&settings.data_dir.join("keys"))
        .context("Cannot load protected control-plane keys")?;
    sqlx::query("UPDATE credentials SET signing_key_id=? WHERE signing_key_id IS NULL")
        .bind(keys.active_signing_id())
        .execute(&pool)
        .await?;
    let registered: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT signing_key_id FROM credentials WHERE revoked=0 AND expires_at>?",
    )
    .bind(db::now())
    .fetch_all(&pool)
    .await?;
    if registered.iter().any(|id| !keys.has_signing_id(id)) {
        anyhow::bail!(
            "Active credentials reference missing manifest signing keys; restore the matching keys/signing-history directory"
        )
    }
    let audit_exports = audit_exports::Store::initialize(&settings.data_dir)?;
    Ok(Arc::new(App {
        pool,
        writer: Mutex::new(()),
        settings,
        keys,
        audit_exports,
        limits: Default::default(),
        device_limits: Default::default(),
        agent_request_slots: tokio::sync::Semaphore::new(128),
        validation_slots: tokio::sync::Semaphore::new(2),
        instance_lock,
    }))
}
impl App {
    pub fn limit(&self, key: String, maximum: u32, window: Duration) -> error::Result<()> {
        // These namespaces are called only after mTLS registration/revocation checks.
        // Partition them from attacker-selected login email keys: an enrolled fleet
        // must not exhaust browser authentication's independent memory budget.
        let authenticated_device = key.starts_with("heartbeat:")
            || key.starts_with("artifact:")
            || key.starts_with("renew:");
        let maximum_entries = if authenticated_device { 40000 } else { 4096 };
        let partition = if authenticated_device {
            &self.device_limits
        } else {
            &self.limits
        };
        let mut limits = partition.lock().map_err(|_| {
            error::ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                "Rate limiter unavailable",
            )
        })?;
        // Hard cap makes attacker-controlled keys unable to allocate unbounded state.
        if limits.len() >= maximum_entries {
            limits.retain(|_, (start, _, lifetime)| start.elapsed() < *lifetime);
        }
        if limits.len() >= maximum_entries && !limits.contains_key(&key) {
            return Err(error::ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Retry later",
            ));
        }
        let entry = limits.entry(key).or_insert((Instant::now(), 0, window));
        if entry.0.elapsed() >= window {
            *entry = (Instant::now(), 0, window)
        }
        entry.1 += 1;
        if entry.1 > maximum {
            return Err(error::ApiError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests; retry later",
            ));
        }
        Ok(())
    }
}
