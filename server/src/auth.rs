use crate::{
    State, db,
    error::{ApiError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::{Path, State as AppState},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{Duration, SecondsFormat, Utc};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use subtle::ConstantTimeEq;

/// Browser sessions last this long from sign-in; there is no sliding renewal.
pub const SESSION_HOURS: i64 = 12;
/// How long a browser that held an ended session can learn why it ended.
const ENDING_RETENTION_DAYS: i64 = 7;
/// "Last active" precision. Bounds session-detail writes to one per session per window.
const LAST_SEEN_SECONDS: i64 = 300;

/// Why a browser session ended. Stored per session verifier; never a secret.
pub mod ending {
    pub const EXPIRED: &str = "expired";
    pub const SIGNED_OUT: &str = "signed_out";
    pub const SIGNED_OUT_ELSEWHERE: &str = "signed_out_elsewhere";
    pub const PASSWORD_CHANGED: &str = "password_changed";
    pub const ACCESS_CHANGED: &str = "access_changed";
    pub const MFA_CHANGED: &str = "mfa_changed";
    pub const MFA_RESET: &str = "mfa_reset";
    pub const REPLACED: &str = "replaced";
}

pub fn random_secret() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}
pub(crate) fn public_user(row: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"email":row.get::<String,_>("email"),"name":row.get::<String,_>("name"),"role":row.get::<String,_>("role"),"enabled":row.get::<bool,_>("enabled"),"revision":row.get::<i64,_>("revision")})
}
pub(crate) fn session_token(h: &HeaderMap) -> Result<&str> {
    let cookie = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = cookie
        .split(';')
        .find_map(|p| p.trim().strip_prefix("vectory_session="))
        .ok_or_else(ApiError::unauthorized)?;
    if token.len() != 64 {
        return Err(ApiError::unauthorized());
    }
    Ok(token)
}
pub async fn authorize(s: &State, h: &HeaderMap, roles: &[&str], mutation: bool) -> Result<Value> {
    let mut conn = s.pool.acquire().await?;
    let user = authorize_in(&mut conn, h, roles, mutation).await?;
    if let Ok(token) = session_token(h) {
        touch_session(s, &mut conn, &db::hash(token)).await;
    }
    Ok(user)
}
// Call again inside the serialized writer transaction. Password work and native
// validation can take time; authorization before them is not a commit permit.
pub(crate) async fn authorize_in(
    conn: &mut sqlx::SqliteConnection,
    h: &HeaderMap,
    roles: &[&str],
    mutation: bool,
) -> Result<Value> {
    let token = session_token(h)?;
    let row=sqlx::query("SELECT u.*,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.verifier=? AND s.expires_at>? AND u.enabled=1").bind(db::hash(token)).bind(db::now()).fetch_optional(conn).await?.ok_or_else(ApiError::unauthorized)?;
    if mutation {
        let actual = h
            .get("x-csrf-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let expected: String = row.get("csrf");
        if !bool::from(actual.as_bytes().ct_eq(expected.as_bytes())) {
            return Err(ApiError::csrf());
        }
        if h.get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v == "cross-site")
        {
            return Err(ApiError::forbidden());
        }
    }
    let user = public_user(&row);
    if user["role"] != "admin"
        && !roles.is_empty()
        && !roles.contains(&user["role"].as_str().unwrap_or(""))
    {
        return Err(ApiError::forbidden());
    }
    Ok(user)
}
/// Best effort: refresh a session's coarse last-active time. A read first keeps
/// ordinary requests from taking SQLite's write lock. The write happens only
/// when the writer lock is free: every other write holds it, and last-active
/// is not worth making a heartbeat, deploy or scheduler tick wait or fail.
async fn touch_session(s: &crate::App, conn: &mut SqliteConnection, verifier: &str) {
    let now = Utc::now();
    let stale =
        (now - Duration::seconds(LAST_SEEN_SECONDS)).to_rfc3339_opts(SecondsFormat::Secs, true);
    let last: Option<String> =
        sqlx::query_scalar("SELECT last_seen_at FROM session_details WHERE verifier=?")
            .bind(verifier)
            .fetch_optional(&mut *conn)
            .await
            .ok()
            .flatten();
    if !last.is_some_and(|last| last < stale) {
        return;
    }
    if let Ok(_guard) = s.writer.try_lock() {
        let _ = sqlx::query("UPDATE session_details SET last_seen_at=? WHERE verifier=?")
            .bind(now.to_rfc3339_opts(SecondsFormat::Secs, true))
            .bind(verifier)
            .execute(&mut *conn)
            .await;
    }
}
pub(crate) async fn password_hash(password: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|x| x.to_string())
            .map_err(|_| ApiError::invalid("Password could not be hashed"))
    })
    .await
    .map_err(|_| ApiError::invalid("Password worker unavailable"))?
}

fn weak(message: &str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "PASSWORD_TOO_WEAK", message)
}
/// Frequently breached passwords that meet the length rule. Compared after
/// lowercasing; the dashboard strength meter uses the same list.
const COMMON_PASSWORDS: &[&str] = &[
    "000000000000",
    "111111111111",
    "123123123123",
    "123456123456",
    "123456789012",
    "1234567890123",
    "12345678901234",
    "123456789123",
    "1234567891011",
    "123456789abc",
    "1q2w3e4r5t6y",
    "1qaz2wsx3edc",
    "abc123abc123",
    "abcd1234abcd",
    "admin1234567",
    "administrator",
    "asdfghjkl123",
    "baseball1234",
    "changeme1234",
    "changemenow!",
    "correcthorsebatterystaple",
    "dragon123456",
    "football1234",
    "iloveyou1234",
    "letmein12345",
    "master123456",
    "monkey123456",
    "mypassword123",
    "p@ssw0rd1234",
    "p@ssword1234",
    "passw0rd1234",
    "password1234",
    "password123!",
    "password12345",
    "passwordpassword",
    "princess1234",
    "qazwsxedcrfv",
    "qwerty123456",
    "qwertyuiop12",
    "qwertyuiop123",
    "qwertyuiopas",
    "secretpassword",
    "starwars1234",
    "sunshine1234",
    "superman1234",
    "trustno11234",
    "vectory12345",
    "vectory123456",
    "vectorypassword",
    "welcome12345",
    "welcome123456",
    "whatever1234",
    "zaq12wsxcde3",
    "zxcvbnm12345",
];
/// Straight keyboard or alphabet runs such as "abcdefghijkl" or "987654321098".
fn is_run(password: &str) -> bool {
    const SEQUENCES: [&str; 3] = [
        "abcdefghijklmnopqrstuvwxyz",
        "01234567890123456789",
        "qwertyuiopasdfghjklzxcvbnm",
    ];
    let reversed: String = password.chars().rev().collect();
    SEQUENCES
        .iter()
        .any(|sequence| sequence.contains(password) || sequence.contains(reversed.as_str()))
}
/// A short unit repeated to fill the whole password, such as "abcabcabcabc".
fn is_repetition(password: &str) -> bool {
    let characters: Vec<char> = password.chars().collect();
    (1..=4).any(|unit| {
        characters.len() >= unit * 3
            && characters
                .iter()
                .enumerate()
                .all(|(index, character)| *character == characters[index % unit])
    })
}
/// The server's floor for a new password. It rejects short, trivially guessed
/// and identity-derived choices; the dashboard adds guidance above this floor.
pub(crate) fn check_new_password(password: &str, identity: &[&str]) -> Result<()> {
    if password.chars().count() < 12 {
        return Err(weak(
            "Use at least 12 characters. A short phrase of 3–4 words works well.",
        ));
    }
    if password.len() > 256 {
        return Err(weak("Use at most 256 characters."));
    }
    let lowered = password.to_lowercase();
    let compact: String = lowered.chars().filter(|c| !c.is_whitespace()).collect();
    if COMMON_PASSWORDS.contains(&compact.as_str()) || is_run(&compact) || is_repetition(&compact) {
        return Err(weak(
            "That password is easy to guess. Try a short phrase of 3–4 unrelated words.",
        ));
    }
    // The account's own name or email, alone or with trailing digits/symbols.
    let base = compact.trim_end_matches(|c: char| !c.is_alphabetic());
    let own = identity.iter().any(|part| {
        let part: String = part
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        let local = part.split('@').next().unwrap_or("");
        !part.is_empty() && (compact == part || base == part || (local.len() >= 4 && base == local))
    });
    if own {
        return Err(weak(
            "Don't use your name or email address as your password.",
        ));
    }
    Ok(())
}
/// A new-password field. Length and strength are judged by `check_new_password`.
pub(crate) fn password_field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    let password = v.get(key).and_then(Value::as_str).unwrap_or("");
    if password.contains('\0') {
        return Err(ApiError::invalid(format!("{key} has invalid characters")));
    }
    Ok(password)
}
pub(crate) fn user_email(v: &Value) -> Result<String> {
    let invalid = || {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "EMAIL_INVALID",
            "Enter a valid email address.",
        )
    };
    let e = v
        .get("email")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .trim()
        .to_ascii_lowercase();
    let (local, domain) = e.split_once('@').ok_or_else(invalid)?;
    if e.len() > 254
        || local.is_empty()
        || domain.is_empty()
        || e.chars()
            .any(|c| c.is_whitespace() || c.is_control() || c == '\0')
    {
        return Err(invalid());
    }
    Ok(e)
}
pub(crate) fn user_name(v: &Value) -> Result<String> {
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "NAME_INVALID",
            "Enter a name of up to 100 characters.",
        ));
    }
    Ok(name.to_owned())
}
pub(crate) fn email_taken(email: &str) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "EMAIL_TAKEN",
        format!("Someone already uses {email}."),
    )
}
fn user_agent(h: &HeaderMap) -> Option<String> {
    let agent: String = h
        .get(header::USER_AGENT)?
        .to_str()
        .ok()?
        .chars()
        .filter(|c| !c.is_control())
        .take(256)
        .collect();
    (!agent.trim().is_empty()).then_some(agent)
}
pub(crate) async fn create_session(
    s: &State,
    db: &mut sqlx::SqliteConnection,
    user: Value,
    h: &HeaderMap,
    client: &str,
) -> Result<(HeaderMap, Json<Value>)> {
    let token = random_secret();
    let csrf = random_secret();
    let verifier = db::hash(&token);
    let now = Utc::now();
    let created_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
    let expires_at =
        (now + Duration::hours(SESSION_HOURS)).to_rfc3339_opts(SecondsFormat::Secs, true);
    sqlx::query("INSERT INTO sessions(verifier,user_id,csrf,expires_at) VALUES(?,?,?,?)")
        .bind(&verifier)
        .bind(user["id"].as_str().unwrap_or(""))
        .bind(&csrf)
        .bind(&expires_at)
        .execute(&mut *db)
        .await?;
    sqlx::query("INSERT INTO session_details(verifier,created_at,last_seen_at,user_agent,client_address) VALUES(?,?,?,?,?)")
        .bind(&verifier)
        .bind(&created_at)
        .bind(&created_at)
        .bind(user_agent(h))
        .bind(client)
        .execute(&mut *db)
        .await?;
    sqlx::query("DELETE FROM session_endings WHERE ended_at<?")
        .bind(
            (now - Duration::days(ENDING_RETENTION_DAYS))
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        )
        .execute(&mut *db)
        .await?;
    let mut headers = HeaderMap::new();
    let secure = if s.settings.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "vectory_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{secure}",
            SESSION_HOURS * 3600
        ))
        .map_err(|_| ApiError::invalid("Invalid session"))?,
    );
    Ok((
        headers,
        Json(json!({"user":user,"csrf_token":csrf,"expires_at":expires_at})),
    ))
}
/// Record why a user's sessions end, then delete them. `keep` spares one
/// session verifier (the caller's own browser). Runs in the caller's transaction.
pub(crate) async fn end_sessions(
    conn: &mut SqliteConnection,
    user_id: &str,
    keep: Option<&str>,
    reason: &str,
) -> Result<()> {
    let keep = keep.unwrap_or("");
    sqlx::query("INSERT OR REPLACE INTO session_endings(verifier,user_id,reason,ended_at) SELECT verifier,user_id,?,? FROM sessions WHERE user_id=? AND verifier<>?")
        .bind(reason)
        .bind(db::now())
        .bind(user_id)
        .bind(keep)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=? AND verifier<>?")
        .bind(user_id)
        .bind(keep)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
/// End one session by verifier with a reason. Returns whether it existed.
pub(crate) async fn end_session(
    conn: &mut SqliteConnection,
    verifier: &str,
    reason: &str,
) -> Result<bool> {
    sqlx::query("INSERT OR REPLACE INTO session_endings(verifier,user_id,reason,ended_at) SELECT verifier,user_id,?,? FROM sessions WHERE verifier=?")
        .bind(reason)
        .bind(db::now())
        .bind(verifier)
        .execute(&mut *conn)
        .await?;
    Ok(sqlx::query("DELETE FROM sessions WHERE verifier=?")
        .bind(verifier)
        .execute(&mut *conn)
        .await?
        .rows_affected()
        > 0)
}

/// Where this server read its one-time setup secret. Names and paths only, never
/// the value. Shown on the setup screen until the first administrator exists.
pub fn describe_secret_source(file: Option<&str>, environment: bool, container: bool) -> Value {
    match file.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => {
            let path: String = path.chars().filter(|c| !c.is_control()).take(512).collect();
            json!({
                "source":"file",
                "variable":"VECTORY_BOOTSTRAP_SECRET_FILE",
                "container":container || path.starts_with("/run/secrets/"),
                "path":path
            })
        }
        None if environment => json!({
            "source":"environment",
            "variable":"VECTORY_BOOTSTRAP_SECRET",
            "container":container,
            "path":null
        }),
        None => json!({"source":"unknown","variable":null,"container":container,"path":null}),
    }
}
fn setup_hint() -> Value {
    static HINT: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    HINT.get_or_init(|| {
        describe_secret_source(
            std::env::var("VECTORY_BOOTSTRAP_SECRET_FILE")
                .ok()
                .as_deref(),
            std::env::var_os("VECTORY_BOOTSTRAP_SECRET").is_some(),
            std::path::Path::new("/.dockerenv").exists()
                || std::path::Path::new("/run/.containerenv").exists(),
        )
    })
    .clone()
}
async fn initialized(s: &State) -> Result<bool> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&s.pool)
        .await?;
    Ok(n > 0)
}
pub async fn status(AppState(s): AppState<State>) -> Result<Json<Value>> {
    let initialized = initialized(&s).await?;
    let mut out = json!({
        "initialized":initialized,
        "version":env!("CARGO_PKG_VERSION"),
        "instance_name":s.settings.instance_name,
    });
    if !initialized {
        out["setup_hint"] = setup_hint();
    }
    Ok(Json(out))
}
pub async fn bootstrap(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    s.limit("bootstrap".into(), 10, std::time::Duration::from_secs(60))?;
    let already = || {
        ApiError::new(
            StatusCode::CONFLICT,
            "ALREADY_INITIALIZED",
            "This workspace is already set up. Sign in instead.",
        )
    };
    if initialized(&s).await? {
        return Err(already());
    }
    let configured = s.settings.bootstrap_secret.trim();
    if configured.len() < 24 {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "SETUP_UNAVAILABLE",
            "This server has no setup secret. Set VECTORY_BOOTSTRAP_SECRET_FILE and restart it.",
        ));
    }
    let supplied = v["bootstrap_secret"].as_str().unwrap_or("").trim();
    if !bool::from(
        db::hash(supplied)
            .as_bytes()
            .ct_eq(db::hash(configured).as_bytes()),
    ) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "SETUP_SECRET_INVALID",
            "That setup secret doesn't match this server's. Copy it again and check for extra characters.",
        ));
    }
    let name = user_name(&v)?;
    let email = user_email(&v)?;
    let password = password_field(&v, "password")?;
    check_new_password(password, &[&email, &name])?;
    let hash = password_hash(password.to_owned()).await?;
    let client = s.client_key(&h, peer);
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if n != 0 {
        return Err(already());
    }
    let user =
        json!({"id":db::id(),"email":email,"name":name,"role":"admin","enabled":true,"revision":1});
    let now = db::now();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at,last_login_at) VALUES(?,?,?,'admin',?,?,?)",
    )
    .bind(user["id"].as_str().unwrap())
    .bind(&email)
    .bind(&name)
    .bind(hash)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    db::audit(
        &mut tx,
        user["id"].as_str().unwrap(),
        "bootstrap",
        user["id"].as_str().unwrap(),
        "success",
    )
    .await?;
    let response = create_session(&s, &mut tx, user, &h, &client).await?;
    tx.commit().await?;
    Ok(response)
}
/// Failed sign-ins allowed per account from one client, and per account from
/// clients that have not signed in to it before, within their windows.
const ACCOUNT_CLIENT_FAILURES: u32 = 10;
const ACCOUNT_FAILURES: u32 = 100;
const CLIENT_WINDOW: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const ACCOUNT_WINDOW: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// How long a client that signed in stays exempt from the account-wide budget.
const KNOWN_CLIENT_WINDOW: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);
/// Attempts a minute one client may make on a sign-in step.
pub(crate) const CLIENT_ATTEMPTS: u32 = 60;
/// Attempts a minute the whole instance allows on a sign-in step. They bound
/// the password hashing a flood can ask for and the failure ledger's growth.
const SHARED_ATTEMPTS: u32 = 600;
/// The part of the shared budget only clients that have signed in can use, so
/// a flood from other addresses can't lock out the people who would answer it.
const KNOWN_CLIENT_RESERVE: u32 = 100;
/// Wrong second factors one account takes on the combined password-and-code
/// form in `FACTOR_WINDOW`, from any addresses, before that form refuses
/// every code, right or wrong, until the window ends.
const FACTOR_FAILURES: u32 = 5;
const FACTOR_WINDOW: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// The marker for a client (an address, or an IPv6 /64) that has completed a
/// sign-in to any account within `KNOWN_CLIENT_WINDOW`.
fn known_client_key(group: &str) -> String {
    format!("login-known-client:{group}")
}
/// Charge one attempt on a sign-in step to the budget every client shares,
/// after the client's own budget let it through. A client that has signed in
/// can use the reserved part as well.
pub(crate) fn charge_shared_attempt(s: &crate::App, key: &str, group: &str) -> Result<()> {
    let known = s.sign_in_failures().seen(&known_client_key(group));
    let ceiling = if known {
        SHARED_ATTEMPTS
    } else {
        SHARED_ATTEMPTS - KNOWN_CLIENT_RESERVE
    };
    s.limit(key.to_owned(), ceiling, std::time::Duration::from_secs(60))
}

/// Sign-in failure keys for one attempt. Every key uses the client's throttle
/// group, so one IPv6 host cannot multiply its budget across its /64.
struct SignInKeys {
    account_client: String,
    account: String,
    known_client: String,
    known_anywhere: String,
}
impl SignInKeys {
    fn new(email: &str, group: &str) -> Self {
        Self {
            account_client: format!("login-fail:{email}:{group}"),
            account: format!("login-fail:{email}"),
            known_client: format!("login-known:{email}:{group}"),
            known_anywhere: known_client_key(group),
        }
    }
    /// Refuse when the budget is spent; otherwise reserve one failure before
    /// the password is checked, so parallel attempts cannot all pass the check.
    /// A client that recently signed in to this account keeps working while
    /// someone elsewhere fails against it; others share the account budget.
    fn reserve(&self, s: &crate::App) -> std::result::Result<(), u64> {
        let mut ledger = s.sign_in_failures();
        let blocked = ledger
            .blocked(&self.account_client, ACCOUNT_CLIENT_FAILURES)
            .or_else(|| {
                (!ledger.seen(&self.known_client))
                    .then(|| ledger.blocked(&self.account, ACCOUNT_FAILURES))
                    .flatten()
            });
        if let Some(wait) = blocked {
            return Err(wait);
        }
        ledger.add(&self.account_client, CLIENT_WINDOW);
        ledger.add(&self.account, ACCOUNT_WINDOW);
        Ok(())
    }
    /// The sign-in is complete: the password was right and, when the account
    /// has a second factor, the factor verified. Return the reservation,
    /// clear this client's failures and remember it as a client of this
    /// account. Nothing earlier may call this: whoever holds only the
    /// password is not a client of the account.
    fn succeeded(&self, s: &crate::App) {
        let mut ledger = s.sign_in_failures();
        ledger.remove(&self.account_client);
        ledger.refund(&self.account);
        ledger.add(&self.known_client, KNOWN_CLIENT_WINDOW);
        ledger.add(&self.known_anywhere, KNOWN_CLIENT_WINDOW);
    }
}
/// A sign-in that finished in the second step (`login_challenges::complete`):
/// the same completion `login` records when the account has no second factor.
pub(crate) fn signed_in(s: &crate::App, email: &str, client: &str) {
    SignInKeys::new(email, &crate::throttle_group(client)).succeeded(s);
}
/// Sign-in audit with the matched account (never the attempted email) and the
/// client address. Credentials and factors never enter audit records.
async fn audit_signin(
    conn: &mut SqliteConnection,
    actor: &str,
    target: &str,
    outcome: &str,
    details: Value,
) -> Result<()> {
    db::insert(
        conn,
        "audit",
        &json!({"id":db::id(),"actor":actor,"action":"login","target":target,"outcome":outcome,"created_at":db::now(),"details":details}),
    )
    .await
}
/// Record a throttled account at most once per window for each client.
async fn audit_throttled(s: &State, email: &str, client: &str, group: &str) {
    let key = format!("login-throttle-audit:{email}:{group}");
    {
        let mut ledger = s.sign_in_failures();
        if ledger.seen(&key) {
            return;
        }
        ledger.add(&key, CLIENT_WINDOW);
    }
    let _guard = s.writer.lock().await;
    let Ok(mut tx) = db::begin_write(&s.pool).await else {
        return;
    };
    let target: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email=?")
        .bind(email)
        .fetch_optional(&mut *tx)
        .await
        .ok()
        .flatten();
    if audit_signin(
        &mut tx,
        "anonymous",
        target.as_deref().unwrap_or(""),
        "throttled",
        json!({"client_address":client}),
    )
    .await
    .is_ok()
    {
        let _ = tx.commit().await;
    }
}
pub(crate) fn signin_throttled(wait: u64) -> ApiError {
    ApiError::throttled(
        "SIGNIN_THROTTLED",
        format!(
            "Too many failed sign-in attempts for this account. Try again in {}, or ask an administrator for a password reset.",
            crate::wait_text(wait)
        ),
        wait,
    )
}
pub async fn login(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden());
    }
    // The client's own budget comes first, and only an attempt it lets through
    // is charged to the budget every client shares. That one bounds password
    // hashing, so one address can never spend what the others need. Only
    // failures count toward an account's lockout, so signing in successfully
    // never locks anyone out.
    let client = s.client_key(&h, peer);
    let group = crate::throttle_group(&client);
    s.limit(
        format!("login-client:{group}"),
        CLIENT_ATTEMPTS,
        std::time::Duration::from_secs(60),
    )?;
    let email = user_email(&v)?;
    let password = db::string(&v, "password", 256)?.to_owned();
    charge_shared_attempt(&s, "login-global", &group)?;
    let keys = SignInKeys::new(&email, &group);
    if let Err(wait) = keys.reserve(&s) {
        audit_throttled(&s, &email, &client, &group).await;
        return Err(signin_throttled(wait));
    }
    let row = sqlx::query("SELECT * FROM users WHERE email=?")
        .bind(&email)
        .fetch_optional(&s.pool)
        .await?;
    let stored = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    let valid = verify_password(password, stored.clone()).await;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let fresh = sqlx::query("SELECT * FROM users WHERE email=? AND enabled=1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let unchanged = fresh
        .as_ref()
        .is_some_and(|r| Some(r.get::<String, _>("password_hash")) == stored);
    if !valid || !unchanged {
        let reason = if row.is_none() {
            "unknown_account"
        } else if !valid {
            "wrong_password"
        } else if fresh.is_none() {
            "account_disabled"
        } else {
            "password_changed"
        };
        audit_signin(
            &mut tx,
            "anonymous",
            row.as_ref()
                .map(|r| r.get::<String, _>("id"))
                .as_deref()
                .unwrap_or(""),
            "denied",
            json!({"client_address":client,"reason":reason}),
        )
        .await?;
        tx.commit().await?;
        return Err(ApiError::unauthorized());
    }
    let fresh = fresh.unwrap();
    let user = public_user(&fresh);
    let user_id = user["id"].as_str().unwrap();
    let factor_sent = [v["totp_code"].as_str(), v["recovery_code"].as_str()]
        .into_iter()
        .any(|code| code.is_some_and(|code| !code.is_empty()));
    // Reveal MFA only after the password and live account have been verified.
    let cipher: Option<String> =
        sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa WHERE user_id=? AND enabled=1")
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(cipher) = cipher else {
        // No second factor: the password is the whole sign-in. (A factor sent
        // anyway is ignored, as it always was.)
        let response = finish_login(&s, &mut tx, &h, &client, user).await?;
        tx.commit().await?;
        keys.succeeded(&s);
        return Ok(response);
    };
    if !factor_sent {
        // A password alone is not a sign-in. Its reservation stays and the
        // client is not remembered until the factor verifies in
        // `login_challenges::complete`.
        let challenge = crate::login_challenges::issue(&mut tx, &fresh, &cipher).await?;
        tx.commit().await?;
        return Ok((HeaderMap::new(), Json(challenge)));
    }
    // The combined form, kept for existing clients: the factor arrives with
    // the password and meets the limits the two-step form has. All of the
    // account's attempts, from either form, share one budget, and five wrong
    // codes lock this form for the account, whichever address guessed them.
    let failures = format!("login-mfa-fail:{user_id}");
    if let Some(wait) = s.sign_in_failures().blocked(&failures, FACTOR_FAILURES) {
        return Err(signin_throttled(wait));
    }
    crate::login_challenges::charge_factor_attempt(&s, user_id)?;
    if let Err(error) = crate::mfa::verify_login(
        &s,
        &mut tx,
        user_id,
        v["totp_code"].as_str(),
        v["recovery_code"].as_str(),
    )
    .await
    {
        // A recovery code may already have been deleted before its audit write
        // failed. Only rejected factors commit a denial; all other failures must
        // roll back factor consumption together with the missing session.
        if error.code != "UNAUTHENTICATED" {
            return Err(error);
        }
        let locked = {
            let mut ledger = s.sign_in_failures();
            ledger.add(&failures, FACTOR_WINDOW);
            ledger.blocked(&failures, FACTOR_FAILURES)
        };
        db::audit(&mut tx, user_id, "login.mfa", "", "denied").await?;
        tx.commit().await?;
        return Err(locked.map_or(error, signin_throttled));
    }
    let response = finish_login(&s, &mut tx, &h, &client, user).await?;
    tx.commit().await?;
    keys.succeeded(&s);
    Ok(response)
}
pub(crate) async fn finish_login(
    s: &State,
    conn: &mut sqlx::SqliteConnection,
    h: &HeaderMap,
    client: &str,
    user: Value,
) -> Result<(HeaderMap, Json<Value>)> {
    let id = user["id"].as_str().unwrap();
    crate::login_challenges::clear(conn, id).await?;
    // Only full authentication rotates the existing browser session.
    if let Ok(token) = session_token(h) {
        end_session(conn, &db::hash(token), ending::REPLACED).await?;
    }
    sqlx::query("UPDATE users SET last_login_at=? WHERE id=?")
        .bind(db::now())
        .bind(id)
        .execute(&mut *conn)
        .await?;
    db::audit(conn, id, "login", id, "success").await?;
    create_session(s, conn, user, h, client).await
}
pub(crate) async fn verify_password(password: String, stored: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || {
        // An account without a usable verifier (unknown email, or an invited
        // account that has not chosen a password yet) costs the same hashing work.
        match stored.as_deref().map(PasswordHash::new) {
            Some(Ok(hash)) => Argon2::default()
                .verify_password(password.as_bytes(), &hash)
                .is_ok(),
            _ => {
                let salt = SaltString::generate(&mut rand::rngs::OsRng);
                let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
                false
            }
        }
    })
    .await
    .unwrap_or(false)
}
fn ending_message(reason: Option<&str>) -> &'static str {
    match reason {
        Some(ending::EXPIRED) => "Your session expired. Sign in again to continue.",
        Some(ending::SIGNED_OUT) => "You signed out in another tab.",
        Some(ending::SIGNED_OUT_ELSEWHERE) => "You were signed out from another browser.",
        Some(ending::PASSWORD_CHANGED) => {
            "Your password was changed. Sign in with your new password."
        }
        Some(ending::ACCESS_CHANGED) => "An administrator changed your access. Sign in again.",
        Some(ending::MFA_CHANGED) => "Your two-factor settings changed. Sign in again.",
        Some(ending::MFA_RESET) => "An administrator reset your two-factor authentication.",
        _ => "Authentication required",
    }
}
/// 401 for a missing session, with the recorded reason when this browser's
/// cookie belongs to a session that ended recently.
async fn session_ended(s: &State, h: &HeaderMap) -> Response {
    // A session that expired moments ago may not have been cleaned up yet.
    let reason: Option<String> = match session_token(h) {
        Ok(token) => sqlx::query_scalar(
            "SELECT reason FROM session_endings WHERE verifier=?1 AND ended_at>?2 UNION ALL SELECT 'expired' FROM sessions WHERE verifier=?1 AND expires_at<=?3 LIMIT 1",
        )
        .bind(db::hash(token))
        .bind(
            (Utc::now() - Duration::days(ENDING_RETENTION_DAYS))
                .to_rfc3339_opts(SecondsFormat::Secs, true),
        )
        .bind(db::now())
        .fetch_optional(&s.pool)
        .await
        .ok()
        .flatten(),
        Err(_) => None,
    };
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":{
            "code":"UNAUTHENTICATED",
            "message":ending_message(reason.as_deref()),
            "reason":reason
        }})),
    )
        .into_response()
}
pub async fn session(AppState(s): AppState<State>, h: HeaderMap) -> Response {
    // A read snapshot avoids a revoke between the authorization and CSRF reads
    // turning an ordinary session-expiry race into an internal error.
    let current = async {
        let mut tx = s.pool.begin().await?;
        let user = authorize_in(&mut tx, &h, &[], false).await?;
        let token = session_token(&h)?;
        let row = sqlx::query("SELECT csrf,expires_at FROM sessions WHERE verifier=?")
            .bind(db::hash(token))
            .fetch_one(&mut *tx)
            .await?;
        drop(tx);
        Ok::<_, ApiError>(json!({
            "user":user,
            "csrf_token":row.get::<String,_>("csrf"),
            "expires_at":row.get::<String,_>("expires_at")
        }))
    };
    match current.await {
        Ok(value) => {
            if let (Ok(token), Ok(mut conn)) = (session_token(&h), s.pool.acquire().await) {
                touch_session(&s, &mut conn, &db::hash(token)).await;
            }
            Json(value).into_response()
        }
        Err(error) if error.code == "UNAUTHENTICATED" => session_ended(&s, &h).await,
        Err(error) => error.into_response(),
    }
}
pub async fn logout(
    AppState(s): AppState<State>,
    h: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    authorize(&s, &h, &[], true).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let user = authorize_in(&mut tx, &h, &[], true).await?;
    crate::login_challenges::clear(&mut tx, user["id"].as_str().unwrap()).await?;
    end_session(&mut tx, &db::hash(session_token(&h)?), ending::SIGNED_OUT).await?;
    db::audit(
        &mut tx,
        user["id"].as_str().unwrap(),
        "logout",
        "",
        "success",
    )
    .await?;
    tx.commit().await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static("vectory_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"),
    );
    Ok((headers, Json(json!({"ok":true}))))
}
/// Stable public identifier for a session. It never reveals the verifier, and
/// the verifier never reveals the cookie token.
fn public_session_id(verifier: &str) -> String {
    db::hash(format!("vectory-session-id:{verifier}"))[..32].to_owned()
}
/// The caller's own active browser sessions, current first.
pub async fn sessions(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let user = authorize(&s, &h, &[], false).await?;
    let current = db::hash(session_token(&h)?);
    let rows = sqlx::query("SELECT s.verifier,s.expires_at,d.created_at,d.last_seen_at,d.user_agent,d.client_address FROM sessions s LEFT JOIN session_details d ON d.verifier=s.verifier WHERE s.user_id=? AND s.expires_at>? ORDER BY d.last_seen_at DESC")
        .bind(user["id"].as_str().unwrap())
        .bind(db::now())
        .fetch_all(&s.pool)
        .await?;
    let mut sessions: Vec<Value> = rows
        .iter()
        .map(|row| {
            let verifier: String = row.get("verifier");
            json!({
                "id":public_session_id(&verifier),
                "current":verifier == current,
                "created_at":row.get::<Option<String>,_>("created_at"),
                "last_seen_at":row.get::<Option<String>,_>("last_seen_at"),
                "expires_at":row.get::<String,_>("expires_at"),
                "user_agent":row.get::<Option<String>,_>("user_agent"),
                "client_address":row.get::<Option<String>,_>("client_address"),
            })
        })
        .collect();
    sessions.sort_by_key(|session| session["current"] != true);
    Ok(Json(json!({"sessions":sessions})))
}
/// Sign out one of the caller's other sessions. Revoking only removes access,
/// so it needs the session and CSRF token but not the password.
pub async fn revoke_session(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    authorize(&s, &h, &[], true).await?;
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ApiError::missing());
    }
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let user = authorize_in(&mut tx, &h, &[], true).await?;
    let user_id = user["id"].as_str().unwrap();
    let current = db::hash(session_token(&h)?);
    let verifiers: Vec<String> =
        sqlx::query_scalar("SELECT verifier FROM sessions WHERE user_id=?")
            .bind(user_id)
            .fetch_all(&mut *tx)
            .await?;
    let target = verifiers
        .into_iter()
        .find(|verifier| public_session_id(verifier) == id)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "SESSION_NOT_FOUND",
                "That session already ended.",
            )
        })?;
    if target == current {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "CURRENT_SESSION",
            "This is the browser you're using. Use Sign out instead.",
        ));
    }
    end_session(&mut tx, &target, ending::SIGNED_OUT_ELSEWHERE).await?;
    db::audit(
        &mut tx,
        user_id,
        "account.revoke_session",
        user_id,
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn users(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    authorize(&s, &h, &["admin"], false).await?;
    // One snapshot: the account list with each person's sign-in security state.
    let rows = sqlx::query("SELECT u.*,EXISTS(SELECT 1 FROM user_mfa m WHERE m.user_id=u.id AND m.enabled=1) AS mfa_enabled,(SELECT r.expires_at FROM password_reset_codes r WHERE r.user_id=u.id AND r.purpose='invite' AND r.expires_at>?) AS invite_expires_at FROM users u ORDER BY u.created_at")
        .bind(db::now())
        .fetch_all(&s.pool)
        .await?;
    Ok(Json(json!(
        rows.iter()
            .map(|row| {
                let mut user = public_user(row);
                let invited = row.get::<String, _>("password_hash").is_empty();
                user["status"] = json!(if !row.get::<bool, _>("enabled") {
                    "disabled"
                } else if invited {
                    "invited"
                } else {
                    "active"
                });
                user["mfa_enabled"] = json!(row.get::<bool, _>("mfa_enabled"));
                user["last_login_at"] = json!(row.get::<Option<String>, _>("last_login_at"));
                user["invite_expires_at"] =
                    json!(row.get::<Option<String>, _>("invite_expires_at"));
                user
            })
            .collect::<Vec<_>>()
    )))
}
pub async fn create_user(
    AppState(s): AppState<State>,
    h: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    authorize(&s, &h, &["admin"], true).await?;
    let v = crate::token_requests::parse(&body)?;
    if let Some(key) = crate::deployment_requests::request_id(&v)? {
        return crate::user_requests::create(&s, &h, &v, &key).await;
    }
    let email = user_email(&v)?;
    let name = user_name(&v)?;
    let password = password_field(&v, "password")?;
    check_new_password(password, &[&email, &name])?;
    let role = db::string(&v, "role", 20)?;
    if !["viewer", "editor", "operator", "admin"].contains(&role) {
        return Err(ApiError::invalid("Invalid role"));
    }
    let hash = password_hash(password.to_owned()).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = authorize_in(&mut tx, &h, &["admin"], true).await?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email=?")
        .bind(&email)
        .fetch_one(&mut *tx)
        .await?;
    if exists > 0 {
        return Err(email_taken(&email));
    }
    let user =
        json!({"id":db::id(),"email":email,"name":name,"role":role,"enabled":true,"revision":1});
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(user["id"].as_str().unwrap())
    .bind(email)
    .bind(name)
    .bind(role)
    .bind(hash)
    .bind(db::now())
    .execute(&mut *tx)
    .await?;
    db::audit(
        &mut tx,
        actor["id"].as_str().unwrap(),
        "user.create",
        user["id"].as_str().unwrap(),
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(user))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_floor_rejects_short_common_patterned_and_identity_choices() {
        for password in [
            "short-one",
            "password1234",
            "Password 1234",
            "aaaaaaaaaaaa",
            "abababababab",
            "abcabcabcabc",
            "abcdefghijklm",
            "987654321098",
            "qwertyuiopas",
            "jane@example.test",
        ] {
            let error = check_new_password(password, &["jane@example.test", "Jane Doe"])
                .expect_err(password);
            assert_eq!(error.code, "PASSWORD_TOO_WEAK", "{password}");
        }
        assert!(check_new_password("Jonathan Livingston", &["Jonathan Livingston"]).is_err());
        assert!(check_new_password("jonathanlivingston", &["jonathanlivingston@x.io"]).is_err());
        assert!(check_new_password("janedoe12345", &["jane@example.test", "Jane Doe"]).is_err());
        assert!(check_new_password("jane doe 2026!", &["jane@example.test", "Jane Doe"]).is_err());
        assert!(check_new_password("janedoe hikes often", &["Jane Doe"]).is_ok());
        for password in [
            "correct horse battery",
            "original-test-password",
            "Tidal-Lantern-42-Orbit",
            "a-long-enough-password",
        ] {
            check_new_password(password, &["jane@example.test", "Jane Doe"]).expect(password);
        }
        assert_eq!(
            check_new_password(&"é".repeat(129), &[])
                .unwrap_err()
                .message,
            "Use at most 256 characters."
        );
    }

    #[test]
    fn setup_hint_names_the_source_but_never_a_value() {
        let file = describe_secret_source(Some("/run/secrets/bootstrap"), true, false);
        assert_eq!(file["source"], "file");
        assert_eq!(file["path"], "/run/secrets/bootstrap");
        assert_eq!(file["container"], true);
        assert_eq!(file["variable"], "VECTORY_BOOTSTRAP_SECRET_FILE");
        let host = describe_secret_source(Some(" /srv/vectory/bootstrap "), false, false);
        assert_eq!(host["path"], "/srv/vectory/bootstrap");
        assert_eq!(host["container"], false);
        let environment = describe_secret_source(Some("  "), true, true);
        assert_eq!(environment["source"], "environment");
        assert_eq!(environment["variable"], "VECTORY_BOOTSTRAP_SECRET");
        assert_eq!(environment["path"], Value::Null);
        assert_eq!(
            describe_secret_source(None, false, false)["source"],
            "unknown"
        );
    }

    #[test]
    fn email_and_name_validation_is_field_specific() {
        assert_eq!(
            user_email(&json!({"email":" Jane@Example.Test "})).unwrap(),
            "jane@example.test"
        );
        for email in ["", "jane", "@example.test", "jane@", "ja ne@example.test"] {
            assert_eq!(
                user_email(&json!({"email":email})).unwrap_err().code,
                "EMAIL_INVALID"
            );
        }
        assert_eq!(user_name(&json!({"name":"  Jane  "})).unwrap(), "Jane");
        assert_eq!(
            user_name(&json!({"name":" "})).unwrap_err().code,
            "NAME_INVALID"
        );
    }
}
