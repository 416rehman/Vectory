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
pub mod install;
pub mod issues;
pub mod login_challenges;
pub mod maintenance;
pub mod mfa;
pub mod overview;
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
pub mod sign_in_failures;
pub mod telemetry;
pub mod token_requests;
pub mod user_requests;
pub mod validation;
pub mod variables;
pub mod vector_diagnostics;
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

#[derive(Clone, Default)]
pub struct Settings {
    pub data_dir: PathBuf,
    pub bootstrap_secret: String,
    pub cookie_secure: bool,
    pub dashboard_dir: PathBuf,
    pub releases_dir: PathBuf,
    pub instance_name: String,
    pub validation_url: Option<String>,
    /// Take the client address from the last X-Forwarded-For hop. Enable only
    /// when the HTTP listener is reachable solely through a trusted proxy.
    pub trust_proxy_headers: bool,
    /// Agent builds shipped inside the server image. Entries in the operator
    /// mirror (`releases_dir`) replace the bundled build for their platform.
    pub bundled_releases_dir: Option<PathBuf>,
    /// Public HTTPS origin of the agent listener as devices reach it. When
    /// unset, Add device derives it from the dashboard's host and `agent_port`.
    pub public_agent_url: Option<String>,
    /// Public origin of the dashboard, for device links and the startup banner.
    pub public_url: Option<String>,
    /// Refuse the unauthenticated installer and agent downloads on the agent listener.
    pub disable_public_agent_downloads: bool,
    /// Port of the agent TLS listener; None when the listener is off.
    pub agent_port: Option<u16>,
    /// The certificate chain (PEM) the agent listener presents, read at startup.
    pub agent_certificate_pem: Option<String>,
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
    /// Sign-in failure counts and recently successful clients, per account.
    pub sign_in_failures: std::sync::Mutex<sign_in_failures::Ledger>,
    /// Release file SHA-256 keyed by name and the (length, modified) pair it was computed for.
    pub release_hashes: std::sync::Mutex<HashMap<String, (u64, std::time::SystemTime, String)>>,
}
pub type State = Arc<App>;
/// Tracked rate-limit keys for browser/anonymous callers and for authenticated devices.
pub const ANONYMOUS_LIMIT_KEYS: usize = 32768;
pub const DEVICE_LIMIT_KEYS: usize = 40000;
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
        sign_in_failures: Default::default(),
        release_hashes: Default::default(),
        agent_request_slots: tokio::sync::Semaphore::new(128),
        validation_slots: tokio::sync::Semaphore::new(2),
        instance_lock,
    }))
}
impl App {
    fn limit_partition(
        &self,
        key: &str,
    ) -> error::Result<(
        std::sync::MutexGuard<'_, HashMap<String, (Instant, u32, Duration)>>,
        usize,
    )> {
        // These namespaces are called only after mTLS registration/revocation checks.
        // Partition them from attacker-selected login email keys: an enrolled fleet
        // must not exhaust browser authentication's independent memory budget.
        let authenticated_device = key.starts_with("heartbeat:")
            || key.starts_with("artifact:")
            || key.starts_with("renew:")
            || key.starts_with("identity:");
        let maximum_entries = if authenticated_device {
            DEVICE_LIMIT_KEYS
        } else {
            ANONYMOUS_LIMIT_KEYS
        };
        let partition = if authenticated_device {
            &self.device_limits
        } else {
            &self.limits
        };
        let limits = partition.lock().map_err(|_| {
            error::ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                "Rate limiter unavailable",
            )
        })?;
        Ok((limits, maximum_entries))
    }
    /// Count an attempt against a fixed window and refuse once `maximum` is exceeded.
    pub fn limit(&self, key: String, maximum: u32, window: Duration) -> error::Result<()> {
        let (mut limits, maximum_entries) = self.limit_partition(&key)?;
        // Hard cap makes attacker-controlled keys unable to allocate unbounded state.
        if limits.len() >= maximum_entries {
            limits.retain(|_, (start, _, lifetime)| start.elapsed() < *lifetime);
        }
        if limits.len() >= maximum_entries && !limits.contains_key(&key) {
            return Err(error::ApiError::throttled(
                "RATE_LIMITED",
                "The server is busy. Try again in a minute.",
                60,
            ));
        }
        let entry = limits.entry(key).or_insert((Instant::now(), 0, window));
        if entry.0.elapsed() >= window {
            *entry = (Instant::now(), 0, window)
        }
        entry.1 += 1;
        if entry.1 > maximum {
            let remaining = window.saturating_sub(entry.0.elapsed()).as_secs() + 1;
            return Err(error::ApiError::throttled(
                "RATE_LIMITED",
                format!("Too many requests. Try again in {}.", wait_text(remaining)),
                remaining,
            ));
        }
        Ok(())
    }
    /// The sign-in failure ledger. A poisoned lock still yields the ledger:
    /// failure accounting must never fail open.
    pub fn sign_in_failures(&self) -> std::sync::MutexGuard<'_, sign_in_failures::Ledger> {
        self.sign_in_failures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
/// The TCP peer address, when the listener was served with connect info.
pub struct ClientAddress(pub Option<std::net::IpAddr>);
impl<S: Send + Sync> axum::extract::FromRequestParts<S> for ClientAddress {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        Ok(ClientAddress(
            parts
                .extensions
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                .map(|info| info.0.ip()),
        ))
    }
}
impl App {
    /// Best-effort client address, as audits and sessions record it. Behind a
    /// trusted proxy the last X-Forwarded-For hop is the address the proxy
    /// saw; otherwise the peer. Throttles count it through `throttle_group`.
    pub fn client_key(
        &self,
        headers: &axum::http::HeaderMap,
        peer: Option<std::net::IpAddr>,
    ) -> String {
        let forwarded = self
            .settings
            .trust_proxy_headers
            .then(|| headers.get("x-forwarded-for")?.to_str().ok())
            .flatten()
            .and_then(|value| value.rsplit(',').next())
            .and_then(|hop| hop.trim().parse::<std::net::IpAddr>().ok());
        forwarded
            .or(peer)
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "unknown".into())
    }
}
/// The identity a client address is throttled under. One IPv6 host usually
/// holds a whole /64, so IPv6 counts per /64 prefix; IPv4 and IPv4-mapped
/// addresses count individually. Anything else passes through unchanged.
pub fn throttle_group(client: &str) -> String {
    match client.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let [a, b, c, d, ..] = v6.segments();
                format!("{}/64", std::net::Ipv6Addr::new(a, b, c, d, 0, 0, 0, 0))
            }
        },
        _ => client.to_owned(),
    }
}
/// "45 seconds", "1 minute", "12 minutes".
pub fn wait_text(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds} second{}", if seconds == 1 { "" } else { "s" })
    } else {
        let minutes = seconds.div_ceil(60);
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    }
}
