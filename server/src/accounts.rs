//! Local account maintenance. All commits recheck the live session and password
//! verifier under the same writer lock as account changes and session revocation.
use crate::{
    State,
    auth::{self, ending},
    db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, RawQuery, State as AppState},
    http::{HeaderMap, StatusCode},
};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

/// Every code works once. Administrator resets keep their reviewed 15-minute
/// window; invitations wait a day for someone new; a host-issued break-glass
/// code allows time to restart the server first.
pub const RESET_MINUTES: i64 = 15;
pub const INVITE_MINUTES: i64 = 24 * 60;
pub const LOCAL_RESET_MINUTES: i64 = 60;
fn code_minutes(purpose: &str) -> i64 {
    match purpose {
        "invite" => INVITE_MINUTES,
        "local" => LOCAL_RESET_MINUTES,
        _ => RESET_MINUTES,
    }
}

pub(crate) async fn reauthenticate(
    s: &State,
    h: &HeaderMap,
    roles: &[&str],
    password: &str,
) -> Result<(Value, String)> {
    let actor = auth::authorize(s, h, roles, true).await?;
    let id = actor["id"].as_str().unwrap();
    s.limit(
        format!("account-reauth:{id}"),
        20,
        std::time::Duration::from_secs(300),
    )?;
    let hash: String =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id=? AND enabled=1")
            .bind(id)
            .fetch_optional(&s.pool)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
    if !auth::verify_password(password.to_owned(), Some(hash.clone())).await {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "WRONG_PASSWORD",
            "Your current password didn't match.",
        ));
    }
    Ok((actor, hash))
}

pub(crate) async fn recheck(
    conn: &mut SqliteConnection,
    h: &HeaderMap,
    roles: &[&str],
    expected_hash: &str,
) -> Result<Value> {
    let actor = auth::authorize_in(conn, h, roles, true).await?;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(actor["id"].as_str().unwrap())
        .fetch_one(conn)
        .await?;
    if hash != expected_hash {
        return Err(ApiError::unauthorized());
    }
    Ok(actor)
}

pub(crate) fn revision(v: &Value, current: i64) -> Result<()> {
    let expected = v["revision"]
        .as_i64()
        .filter(|r| *r > 0)
        .ok_or_else(|| ApiError::invalid("revision must be a positive integer"))?;
    if expected != current {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "This account changed since you opened it. Load the latest details and try again.",
        ));
    }
    Ok(())
}

pub(crate) async fn user(conn: &mut SqliteConnection, id: &str) -> Result<sqlx::sqlite::SqliteRow> {
    sqlx::query("SELECT * FROM users WHERE id=?")
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::missing)
}

pub async fn edit(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: Bytes,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &["admin"], true).await?;
    let v = crate::token_requests::parse(&body)?;
    let key = crate::deployment_requests::request_id(&v)?;
    if let Some(key) = key.as_deref() {
        crate::access_requests::no_query(raw.as_deref())?;
        crate::deployment_requests::parse_id(&id)?;
        let mut conn = s.pool.acquire().await?;
        if crate::access_requests::entry(&mut conn, actor["id"].as_str().unwrap(), key, &id)
            .await?
            .is_some()
        {
            return Err(crate::access_requests::already_used());
        }
        if v.as_object().is_none_or(|fields| {
            fields.len() != 6
                || fields.keys().any(|field| {
                    !matches!(
                        field.as_str(),
                        "request_id"
                            | "name"
                            | "role"
                            | "enabled"
                            | "revision"
                            | "current_password"
                    )
                })
        }) {
            return Err(ApiError::invalid(
                "A keyed access edit requires request_id, name, role, enabled, revision, and current_password",
            ));
        }
    }
    let name = auth::user_name(&v)?;
    let role = db::string(&v, "role", 20)?;
    if !["viewer", "editor", "operator", "admin"].contains(&role) {
        return Err(ApiError::invalid("Invalid role"));
    }
    let enabled = v["enabled"]
        .as_bool()
        .ok_or_else(|| ApiError::invalid("enabled must be a boolean"))?;
    let (_, hash) =
        reauthenticate(&s, &h, &["admin"], db::string(&v, "current_password", 256)?).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    let actor_id = actor["id"].as_str().unwrap();
    if let Some(key) = key.as_deref() {
        if crate::access_requests::entry(&mut tx, actor_id, key, &id)
            .await?
            .is_some()
        {
            return Err(crate::access_requests::already_used());
        }
    }
    let before = user(&mut tx, &id).await?;
    revision(&v, before.get("revision"))?;
    if before.get::<bool, _>("enabled")
        && before.get::<String, _>("role") == "admin"
        && (!enabled || role != "admin")
    {
        let admins: i64 =
            sqlx::query_scalar("SELECT count(*) FROM users WHERE enabled=1 AND role='admin'")
                .fetch_one(&mut *tx)
                .await?;
        if admins <= 1 {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "LAST_ADMIN",
                "Make someone else an administrator first. A workspace needs at least one active administrator.",
            ));
        }
    }
    let access_changed =
        before.get::<bool, _>("enabled") != enabled || before.get::<String, _>("role") != role;
    sqlx::query("UPDATE users SET name=?,role=?,enabled=?,revision=revision+1 WHERE id=?")
        .bind(&name)
        .bind(role)
        .bind(enabled)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if access_changed {
        auth::end_sessions(&mut tx, &id, None, ending::ACCESS_CHANGED).await?;
        sqlx::query("DELETE FROM password_reset_codes WHERE user_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        revoke_issued_codes(&mut tx, &id).await?;
    }
    db::audit(&mut tx, actor_id, "user.update", &id, "success").await?;
    let out = auth::public_user(&user(&mut tx, &id).await?);
    if let Some(key) = key.as_deref() {
        sqlx::query("INSERT INTO access_edit_requests(actor_id,request_id,user_id,state,user_json,created_at) VALUES(?,?,?,'applied',?,?)")
            .bind(actor_id)
            .bind(key)
            .bind(&id)
            .bind(out.to_string())
            .bind(db::now())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(match key {
        Some(key) => json!({"request_id":key,"user":out}),
        None => out,
    }))
}

/// A caller who is signed in and sent the session's CSRF token. A handler that
/// takes it ahead of its body extractor refuses everyone else before any of the
/// body is read or judged, so an anonymous caller learns nothing from it.
pub struct SignedIn;
impl axum::extract::FromRequestParts<State> for SignedIn {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut axum::http::request::Parts, s: &State) -> Result<Self> {
        auth::authorize(s, &parts.headers, &[], true).await?;
        Ok(SignedIn)
    }
}

pub async fn change_password(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    _: SignedIn,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    let password = auth::password_field(&v, "new_password")?;
    let current = db::string(&v, "current_password", 256)?;
    let (actor, current_hash) = reauthenticate(&s, &h, &[], current).await?;
    if password == current {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "PASSWORD_UNCHANGED",
            "Choose a password that's different from your current one.",
        ));
    }
    auth::check_new_password(
        password,
        &[
            actor["email"].as_str().unwrap_or(""),
            actor["name"].as_str().unwrap_or(""),
        ],
    )?;
    let next_hash = auth::password_hash(password.to_owned()).await?;
    let client = s.client_key(&h, peer);
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &[], &current_hash).await?;
    let id = actor["id"].as_str().unwrap();
    replace_password(&mut tx, id, &next_hash).await?;
    db::audit(&mut tx, id, "account.password", id, "success").await?;
    let updated = auth::public_user(&user(&mut tx, id).await?);
    let out = auth::create_session(&s, &mut tx, updated, &h, &client).await?;
    tx.commit().await?;
    Ok(out)
}

async fn replace_password(conn: &mut SqliteConnection, id: &str, hash: &str) -> Result<()> {
    sqlx::query("UPDATE users SET password_hash=?,revision=revision+1 WHERE id=?")
        .bind(hash)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    auth::end_sessions(conn, id, None, ending::PASSWORD_CHANGED).await?;
    sqlx::query("DELETE FROM password_reset_codes WHERE user_id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    revoke_issued_codes(conn, id).await?;
    Ok(())
}

async fn revoke_issued_codes(conn: &mut SqliteConnection, issuer_id: &str) -> Result<()> {
    // Called only from an access or credential change under the writer. A
    // bearer code issued before that change cannot outlive the issuer's
    // authority; invalidate target revision only for still-active codes.
    sqlx::query("UPDATE users SET revision=revision+1 WHERE id<>? AND id IN (SELECT user_id FROM password_reset_codes WHERE issuer_id=? AND expires_at>?)")
        .bind(issuer_id)
        .bind(issuer_id)
        .bind(db::now())
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM password_reset_codes WHERE issuer_id=?")
        .bind(issuer_id)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn revoke_sessions(
    AppState(s): AppState<State>,
    h: HeaderMap,
    _: SignedIn,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let (_, hash) = reauthenticate(&s, &h, &[], db::string(&v, "current_password", 256)?).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &[], &hash).await?;
    let id = actor["id"].as_str().unwrap();
    crate::login_challenges::clear(&mut tx, id).await?;
    let current = db::hash(auth::session_token(&h)?);
    auth::end_sessions(&mut tx, id, Some(&current), ending::SIGNED_OUT_ELSEWHERE).await?;
    db::audit(&mut tx, id, "account.revoke_sessions", id, "success").await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

/// Replace any live code for `user_id` with a new single-use code. `purpose`
/// is `reset`, `invite` or `local`; administrator codes carry their issuer.
pub(crate) async fn issue_code(
    conn: &mut SqliteConnection,
    user_id: &str,
    issuer: Option<&str>,
    purpose: &str,
) -> Result<(String, String, String)> {
    let code = auth::random_secret();
    let verifier = db::hash(&code);
    let expires_at = (Utc::now() + Duration::minutes(code_minutes(purpose)))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    sqlx::query("DELETE FROM password_reset_codes WHERE user_id=? OR expires_at<=?")
        .bind(user_id)
        .bind(db::now())
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO password_reset_codes(verifier,user_id,expires_at,issuer_id,purpose) VALUES(?,?,?,?,?)",
    )
    .bind(&verifier)
    .bind(user_id)
    .bind(&expires_at)
    .bind(issuer)
    .bind(purpose)
    .execute(&mut *conn)
    .await?;
    Ok((code, verifier, expires_at))
}

pub async fn issue_reset(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &["admin"], true).await?;
    let v = crate::token_requests::parse(&body)?;
    let key = crate::deployment_requests::request_id(&v)?;
    let id = if key.is_some() {
        if raw.as_deref().is_some_and(|query| !query.is_empty()) {
            return Err(ApiError::invalid(
                "Password reset requests do not accept query parameters",
            ));
        }
        if v.as_object().is_none_or(|fields| {
            fields.len() != 3
                || fields.keys().any(|field| {
                    !matches!(
                        field.as_str(),
                        "request_id" | "current_password" | "revision"
                    )
                })
        }) {
            return Err(ApiError::invalid(
                "A keyed password reset requires request_id, current_password, and revision",
            ));
        }
        crate::deployment_requests::parse_id(&id)?
    } else {
        id
    };
    if let Some(key) = key.as_deref() {
        let already_seen: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM password_reset_requests WHERE actor_id=? AND request_id=?",
        )
        .bind(actor["id"].as_str().unwrap())
        .bind(key)
        .fetch_one(&s.pool)
        .await?;
        if already_seen > 0 {
            return Err(crate::reset_requests::already_used());
        }
    }
    let (_, hash) =
        reauthenticate(&s, &h, &["admin"], db::string(&v, "current_password", 256)?).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    let actor_id = actor["id"].as_str().unwrap();
    if let Some(key) = key.as_deref() {
        if crate::reset_requests::entry(&mut tx, actor_id, key, &id)
            .await?
            .is_some()
        {
            return Err(crate::reset_requests::already_used());
        }
    }
    let target = user(&mut tx, &id).await?;
    revision(&v, target.get("revision"))?;
    if !target.get::<bool, _>("enabled") {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ACCOUNT_DISABLED",
            "Turn this person's access back on before resetting their password.",
        ));
    }
    // Someone who has never chosen a password gets a fresh invitation instead.
    let purpose = if target.get::<String, _>("password_hash").is_empty() {
        "invite"
    } else {
        "reset"
    };
    let (code, verifier, expires_at) = issue_code(&mut tx, &id, Some(actor_id), purpose).await?;
    if let Some(key) = key.as_deref() {
        sqlx::query("INSERT INTO password_reset_requests(actor_id,request_id,user_id,state,was_issued,verifier,expires_at,created_at) VALUES(?,?,?,'issued',1,?,?,?)")
            .bind(actor_id)
            .bind(key)
            .bind(&id)
            .bind(&verifier)
            .bind(&expires_at)
            .bind(db::now())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE users SET revision=revision+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    db::audit(
        &mut tx,
        actor_id,
        if purpose == "invite" {
            "user.invite.issue"
        } else {
            "user.password_reset.issue"
        },
        &id,
        "success",
    )
    .await?;
    tx.commit().await?;
    let response = match key {
        Some(key) => {
            json!({"request_id":key,"user_id":id,"code":code,"expires_at":expires_at,"purpose":purpose})
        }
        None => json!({"code":code,"expires_at":expires_at,"purpose":purpose}),
    };
    Ok(Json(response))
}

fn code_invalid(invite: bool) -> ApiError {
    if invite {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVITE_INVALID",
            "This invite link is invalid, expired or already used. Ask your administrator for a new one.",
        )
    } else {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "RESET_CODE_INVALID",
            "This reset code is invalid, expired or already used. Ask your administrator for a new one.",
        )
    }
}
/// Public code checks: same-site only, bounded per client, globally and per
/// code. The client's own budget is charged first (30 tries a minute, far
/// more than anyone redeeming a code needs), and the budget every client
/// shares only for what that lets through, so one address can't use up
/// everyone's chance to reset a password or accept an invitation.
fn public_code(
    s: &State,
    h: &HeaderMap,
    peer: Option<std::net::IpAddr>,
    v: &Value,
    invite: bool,
) -> Result<String> {
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden());
    }
    s.limit(
        format!(
            "password-reset-client:{}",
            crate::throttle_group(&s.client_key(h, peer))
        ),
        30,
        std::time::Duration::from_secs(60),
    )?;
    s.limit(
        "password-reset-global".into(),
        300,
        std::time::Duration::from_secs(60),
    )?;
    let code = v["code"]
        .as_str()
        .map(str::trim)
        .filter(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| code_invalid(invite))?
        .to_ascii_lowercase();
    let verifier = db::hash(&code);
    s.limit(
        format!("password-reset:{verifier}"),
        8,
        std::time::Duration::from_secs(300),
    )?;
    Ok(verifier)
}

pub async fn redeem_reset(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let verifier = public_code(&s, &h, peer, &v, false)?;
    let password = auth::password_field(&v, "new_password")?;
    // Reject unknown/expired codes before starting expensive password work, then
    // check again transactionally.
    let mut conn = s.pool.acquire().await?;
    let target = reset_target(&mut conn, &verifier)
        .await?
        .ok_or_else(|| code_invalid(false))?;
    drop(conn);
    auth::check_new_password(password, &[&target.email, &target.name])?;
    let hash = auth::password_hash(password.to_owned()).await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let target = reset_target(&mut tx, &verifier)
        .await?
        .ok_or_else(|| code_invalid(false))?;
    replace_password(&mut tx, &target.id, &hash).await?;
    db::audit(
        &mut tx,
        &target.id,
        if target.purpose == "invite" {
            "user.invite.accept"
        } else {
            "user.password_reset.redeem"
        },
        &target.id,
        "success",
    )
    .await?;
    tx.commit().await?;
    // The code proved control of this account; its email lets the sign-in form
    // and password managers continue without retyping.
    Ok(Json(json!({"ok":true,"email":target.email})))
}

pub(crate) struct CodeTarget {
    id: String,
    email: String,
    name: String,
    purpose: String,
    expires_at: String,
    unactivated: bool,
}
async fn reset_target(conn: &mut SqliteConnection, verifier: &str) -> Result<Option<CodeTarget>> {
    // Administrator codes need an issuer who is still an enabled administrator.
    // Host-issued break-glass codes have no issuer by design.
    let row = sqlx::query("SELECT u.id,u.email,u.name,u.password_hash,r.purpose,r.expires_at FROM password_reset_codes r JOIN users u ON u.id=r.user_id LEFT JOIN users issuer ON issuer.id=r.issuer_id WHERE r.verifier=? AND r.expires_at>? AND u.enabled=1 AND ((r.purpose='local' AND r.issuer_id IS NULL) OR (r.purpose<>'local' AND issuer.enabled=1 AND issuer.role='admin'))")
        .bind(verifier)
        .bind(db::now())
        .fetch_optional(conn)
        .await?;
    Ok(row.map(|row| CodeTarget {
        id: row.get("id"),
        email: row.get("email"),
        name: row.get("name"),
        purpose: row.get("purpose"),
        expires_at: row.get("expires_at"),
        unactivated: row.get::<String, _>("password_hash").is_empty(),
    }))
}
async fn invite_target(conn: &mut SqliteConnection, verifier: &str) -> Result<CodeTarget> {
    reset_target(conn, verifier)
        .await?
        .filter(|target| target.purpose == "invite" && target.unactivated)
        .ok_or_else(|| code_invalid(true))
}

/// Who an invitation is for, so the invited person can confirm before choosing
/// a password. Possession of the code is the authorization.
pub async fn preview_invite(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    // The client's own budget first, then the budget every client shares for
    // what it lets through, like enrollment, so a flood from one address
    // can't use up everyone's.
    s.limit(
        format!(
            "invite-preview:{}",
            crate::throttle_group(&s.client_key(&h, peer))
        ),
        30,
        std::time::Duration::from_secs(60),
    )?;
    s.limit(
        "invite-preview".into(),
        600,
        std::time::Duration::from_secs(60),
    )?;
    let verifier = public_code(&s, &h, peer, &v, true)?;
    let mut conn = s.pool.acquire().await?;
    let target = invite_target(&mut conn, &verifier).await?;
    Ok(Json(json!({
        "email":target.email,
        "name":target.name,
        "expires_at":target.expires_at,
        "instance_name":s.settings.instance_name
    })))
}

/// Accept an invitation: choose the first password and start a session. The
/// account has no password or second factor yet, so nothing is bypassed.
pub async fn accept_invite(
    AppState(s): AppState<State>,
    h: HeaderMap,
    crate::ClientAddress(peer): crate::ClientAddress,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    let verifier = public_code(&s, &h, peer, &v, true)?;
    let password = auth::password_field(&v, "new_password")?;
    let mut conn = s.pool.acquire().await?;
    let target = invite_target(&mut conn, &verifier).await?;
    drop(conn);
    auth::check_new_password(password, &[&target.email, &target.name])?;
    let hash = auth::password_hash(password.to_owned()).await?;
    let client = s.client_key(&h, peer);
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let target = invite_target(&mut tx, &verifier).await?;
    replace_password(&mut tx, &target.id, &hash).await?;
    sqlx::query("UPDATE users SET last_login_at=? WHERE id=?")
        .bind(db::now())
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    db::audit(
        &mut tx,
        &target.id,
        "user.invite.accept",
        &target.id,
        "success",
    )
    .await?;
    let account = auth::public_user(&user(&mut tx, &target.id).await?);
    let response = auth::create_session(&s, &mut tx, account, &h, &client).await?;
    tx.commit().await?;
    Ok(response)
}

/// Break-glass reset from `vectory-admin` on a stopped server: a single-use code
/// with no administrator issuer. Changes nothing until the code is redeemed.
pub async fn local_reset(s: &State, email: &str) -> anyhow::Result<(String, String, String)> {
    let email = email.trim().to_ascii_lowercase();
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let row = sqlx::query("SELECT id,name,enabled FROM users WHERE email=?")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No account uses {email}."))?;
    if !row.get::<bool, _>("enabled") {
        anyhow::bail!(
            "The account {email} is disabled. Another administrator must turn its access back on first."
        );
    }
    let id: String = row.get("id");
    let (code, _, expires_at) = issue_code(&mut tx, &id, None, "local")
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    sqlx::query("UPDATE users SET revision=revision+1 WHERE id=?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    db::audit(
        &mut tx,
        "local-admin",
        "user.password_reset.issue",
        &id,
        "success",
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    tx.commit().await?;
    Ok((code, expires_at, row.get("name")))
}
