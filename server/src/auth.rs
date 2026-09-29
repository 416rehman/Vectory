use crate::{
    State, db,
    error::{ApiError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    extract::State as AppState,
    http::{HeaderMap, HeaderValue, header},
};
use chrono::{Duration, Utc};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::Row;
use subtle::ConstantTimeEq;

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
    authorize_in(&mut conn, h, roles, mutation).await
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
            return Err(ApiError::forbidden());
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
pub(crate) fn check_password(password: &str) -> Result<()> {
    if password.len() < 12 || password.len() > 256 {
        return Err(ApiError::invalid("Password must be 12–256 bytes"));
    }
    Ok(())
}
pub(crate) fn user_email(v: &Value) -> Result<String> {
    let e = db::string(v, "email", 254)?.trim().to_ascii_lowercase();
    if !e.contains('@') || e.contains(char::is_whitespace) {
        return Err(ApiError::invalid("A valid email is required"));
    }
    Ok(e)
}
pub(crate) async fn create_session(
    s: &State,
    db: &mut sqlx::SqliteConnection,
    user: Value,
) -> Result<(HeaderMap, Json<Value>)> {
    let token = random_secret();
    let csrf = random_secret();
    sqlx::query("INSERT INTO sessions(verifier,user_id,csrf,expires_at) VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(user["id"].as_str().unwrap_or(""))
        .bind(&csrf)
        .bind((Utc::now() + Duration::hours(12)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .execute(db)
        .await?;
    let mut h = HeaderMap::new();
    let secure = if s.settings.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    h.insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "vectory_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200{secure}"
        ))
        .map_err(|_| ApiError::invalid("Invalid session"))?,
    );
    Ok((h, Json(json!({"user":user,"csrf_token":csrf}))))
}
pub async fn status(AppState(s): AppState<State>) -> Result<Json<Value>> {
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&s.pool)
        .await?;
    Ok(Json(
        json!({"initialized":n>0,"version":env!("CARGO_PKG_VERSION")}),
    ))
}
pub async fn bootstrap(
    AppState(s): AppState<State>,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    s.limit("bootstrap".into(), 10, std::time::Duration::from_secs(60))?;
    let supplied = v["bootstrap_secret"].as_str().unwrap_or("");
    if s.settings.bootstrap_secret.len() < 24
        || !bool::from(
            db::hash(supplied)
                .as_bytes()
                .ct_eq(db::hash(&s.settings.bootstrap_secret).as_bytes()),
        )
    {
        return Err(ApiError::forbidden());
    }
    let email = user_email(&v)?;
    let name = db::string(&v, "name", 100)?.to_owned();
    let password = db::string(&v, "password", 256)?;
    check_password(password)?;
    let hash = password_hash(password.to_owned()).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await?;
    if n != 0 {
        return Err(ApiError::conflict("Instance is already initialized"));
    }
    let user =
        json!({"id":db::id(),"email":email,"name":name,"role":"admin","enabled":true,"revision":1});
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,'admin',?,?)",
    )
    .bind(user["id"].as_str().unwrap())
    .bind(&email)
    .bind(&name)
    .bind(hash)
    .bind(db::now())
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
    let response = create_session(&s, &mut tx, user).await?;
    tx.commit().await?;
    Ok(response)
}
/// Failed sign-ins allowed per account from one client, and per account from
/// clients that have not signed in to it before, within their windows.
const ACCOUNT_CLIENT_FAILURES: u32 = 10;
const ACCOUNT_FAILURES: u32 = 100;
pub async fn login(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden());
    }
    // Coarse flood guards bound password-hashing work. They count attempts, but
    // only failures count toward an account's lockout, so signing in
    // successfully never locks anyone out.
    let client = s.client_key(&h, peer);
    s.limit(
        "login-global".into(),
        600,
        std::time::Duration::from_secs(60),
    )?;
    s.limit(
        format!("login-client:{client}"),
        60,
        std::time::Duration::from_secs(60),
    )?;
    let email = user_email(&v)?;
    let account_client = format!("login-fail:{email}:{client}");
    let account = format!("login-fail:{email}");
    let known_client = format!("login-known:{email}:{client}");
    // A client that recently signed in to this account keeps working while
    // someone elsewhere fails against it; others share the account-wide budget.
    let blocked = s
        .failures_block(&account_client, ACCOUNT_CLIENT_FAILURES)
        .or_else(|| {
            (!s.seen(&known_client))
                .then(|| s.failures_block(&account, ACCOUNT_FAILURES))
                .flatten()
        });
    if let Some(wait) = blocked {
        return Err(ApiError::throttled(
            "SIGNIN_THROTTLED",
            format!(
                "Too many failed sign-in attempts for this account. Try again in {}, or ask an administrator for a password reset code.",
                crate::wait_text(wait)
            ),
            wait,
        ));
    }
    let password = db::string(&v, "password", 256)?.to_owned();
    let row = sqlx::query("SELECT * FROM users WHERE email=?")
        .bind(&email)
        .fetch_optional(&s.pool)
        .await?;
    let stored = row.as_ref().map(|r| r.get::<String, _>("password_hash"));
    let valid = verify_password(password, stored.clone()).await;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let fresh = sqlx::query("SELECT * FROM users WHERE email=? AND enabled=1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?;
    let unchanged = fresh
        .as_ref()
        .is_some_and(|r| Some(r.get::<String, _>("password_hash")) == stored);
    if !valid || !unchanged {
        s.record_failure(account_client, std::time::Duration::from_secs(15 * 60));
        s.record_failure(account, std::time::Duration::from_secs(60 * 60));
        db::audit(&mut tx, "anonymous", "login", "", "denied").await?;
        tx.commit().await?;
        return Err(ApiError::unauthorized());
    }
    s.clear_limit(&account_client);
    s.record_failure(
        known_client,
        std::time::Duration::from_secs(30 * 24 * 60 * 60),
    );
    let fresh = fresh.unwrap();
    let user = public_user(&fresh);
    // Reveal MFA only after the password and live account have been verified.
    // Combined credentials+factor requests remain supported for existing clients.
    if v["totp_code"].as_str().is_none_or(str::is_empty)
        && v["recovery_code"].as_str().is_none_or(str::is_empty)
    {
        let cipher: Option<String> = sqlx::query_scalar(
            "SELECT secret_ciphertext FROM user_mfa WHERE user_id=? AND enabled=1",
        )
        .bind(user["id"].as_str().unwrap())
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(cipher) = cipher {
            let challenge = crate::login_challenges::issue(&mut tx, &fresh, &cipher).await?;
            tx.commit().await?;
            return Ok((HeaderMap::new(), Json(challenge)));
        }
    }
    if let Err(error) = crate::mfa::verify_login(
        &s,
        &mut tx,
        user["id"].as_str().unwrap(),
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
        db::audit(
            &mut tx,
            user["id"].as_str().unwrap(),
            "login.mfa",
            "",
            "denied",
        )
        .await?;
        tx.commit().await?;
        return Err(error);
    }
    let response = finish_login(&s, &mut tx, &h, user).await?;
    tx.commit().await?;
    Ok(response)
}
pub(crate) async fn finish_login(
    s: &State,
    conn: &mut sqlx::SqliteConnection,
    h: &HeaderMap,
    user: Value,
) -> Result<(HeaderMap, Json<Value>)> {
    crate::login_challenges::clear(conn, user["id"].as_str().unwrap()).await?;
    // Only full authentication rotates the existing browser session.
    if let Ok(token) = session_token(&h) {
        sqlx::query("DELETE FROM sessions WHERE verifier=?")
            .bind(db::hash(token))
            .execute(&mut *conn)
            .await?;
    }
    db::audit(
        conn,
        user["id"].as_str().unwrap(),
        "login",
        user["id"].as_str().unwrap(),
        "success",
    )
    .await?;
    create_session(s, conn, user).await
}
pub(crate) async fn verify_password(password: String, stored: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || {
        if let Some(stored) = stored {
            PasswordHash::new(&stored).ok().is_some_and(|hash| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &hash)
                    .is_ok()
            })
        } else {
            let salt = SaltString::generate(&mut rand::rngs::OsRng);
            let _ = Argon2::default().hash_password(password.as_bytes(), &salt);
            false
        }
    })
    .await
    .unwrap_or(false)
}
pub async fn session(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    // A read snapshot avoids a revoke between the authorization and CSRF reads
    // turning an ordinary session-expiry race into an internal error.
    let mut tx = s.pool.begin().await?;
    let user = authorize_in(&mut tx, &h, &[], false).await?;
    let token = session_token(&h)?;
    let csrf: String = sqlx::query_scalar("SELECT csrf FROM sessions WHERE verifier=?")
        .bind(db::hash(token))
        .fetch_one(&mut *tx)
        .await?;
    Ok(Json(json!({"user":user,"csrf_token":csrf})))
}
pub async fn logout(
    AppState(s): AppState<State>,
    h: HeaderMap,
) -> Result<(HeaderMap, Json<Value>)> {
    authorize(&s, &h, &[], true).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let user = authorize_in(&mut tx, &h, &[], true).await?;
    crate::login_challenges::clear(&mut tx, user["id"].as_str().unwrap()).await?;
    let token = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .find_map(|x| x.trim().strip_prefix("vectory_session="))
        })
        .unwrap_or("");
    sqlx::query("DELETE FROM sessions WHERE verifier=?")
        .bind(db::hash(token))
        .execute(&mut *tx)
        .await?;
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
pub async fn users(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    authorize(&s, &h, &["admin"], false).await?;
    let rows = sqlx::query("SELECT * FROM users ORDER BY created_at")
        .fetch_all(&s.pool)
        .await?;
    Ok(Json(json!(
        rows.iter().map(public_user).collect::<Vec<_>>()
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
    let name = db::string(&v, "name", 100)?;
    let password = db::string(&v, "password", 256)?;
    check_password(password)?;
    let role = db::string(&v, "role", 20)?;
    if !["viewer", "editor", "operator", "admin"].contains(&role) {
        return Err(ApiError::invalid("Invalid role"));
    }
    let hash = password_hash(password.to_owned()).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = authorize_in(&mut tx, &h, &["admin"], true).await?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email=?")
        .bind(&email)
        .fetch_one(&mut *tx)
        .await?;
    if exists > 0 {
        return Err(ApiError::conflict("Email is already registered"));
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
