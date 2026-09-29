//! Local account maintenance. All commits recheck the live session and password
//! verifier under the same writer lock as account changes and session revocation.
use crate::{
    State, auth, db,
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
            "Current password is incorrect",
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

fn revision(v: &Value, current: i64) -> Result<()> {
    let expected = v["revision"]
        .as_i64()
        .filter(|r| *r > 0)
        .ok_or_else(|| ApiError::invalid("revision must be a positive integer"))?;
    if expected != current {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Account changed; refresh before trying again",
        ));
    }
    Ok(())
}

async fn user(conn: &mut SqliteConnection, id: &str) -> Result<sqlx::sqlite::SqliteRow> {
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
    let v = crate::token_requests::parse(&body)?;
    let key = crate::deployment_requests::request_id(&v)?;
    if let Some(key) = key.as_deref() {
        crate::access_requests::no_query(raw.as_deref())?;
        crate::deployment_requests::parse_id(&id)?;
        let actor = auth::authorize(&s, &h, &["admin"], true).await?;
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
    let name = db::string(&v, "name", 100)?;
    let role = db::string(&v, "role", 20)?;
    if !["viewer", "editor", "operator", "admin"].contains(&role) {
        return Err(ApiError::invalid("Invalid role"));
    }
    let enabled = v["enabled"]
        .as_bool()
        .ok_or_else(|| ApiError::invalid("enabled must be a boolean"))?;
    let (_, hash) =
        reauthenticate(&s, &h, &["admin"], db::string(&v, "current_password", 256)?).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
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
            return Err(ApiError::conflict(
                "At least one enabled administrator is required",
            ));
        }
    }
    let access_changed =
        before.get::<bool, _>("enabled") != enabled || before.get::<String, _>("role") != role;
    sqlx::query("UPDATE users SET name=?,role=?,enabled=?,revision=revision+1 WHERE id=?")
        .bind(name)
        .bind(role)
        .bind(enabled)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if access_changed {
        sqlx::query("DELETE FROM sessions WHERE user_id=?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
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

pub async fn change_password(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<(HeaderMap, Json<Value>)> {
    let password = db::string(&v, "new_password", 256)?;
    auth::check_password(password)?;
    let (_, current_hash) =
        reauthenticate(&s, &h, &[], db::string(&v, "current_password", 256)?).await?;
    let next_hash = auth::password_hash(password.to_owned()).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = recheck(&mut tx, &h, &[], &current_hash).await?;
    let id = actor["id"].as_str().unwrap();
    replace_password(&mut tx, id, &next_hash).await?;
    db::audit(&mut tx, id, "account.password", id, "success").await?;
    let updated = auth::public_user(&user(&mut tx, id).await?);
    let out = auth::create_session(&s, &mut tx, updated).await?;
    tx.commit().await?;
    Ok(out)
}

async fn replace_password(conn: &mut SqliteConnection, id: &str, hash: &str) -> Result<()> {
    sqlx::query("UPDATE users SET password_hash=?,revision=revision+1 WHERE id=?")
        .bind(hash)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
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
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let (_, hash) = reauthenticate(&s, &h, &[], db::string(&v, "current_password", 256)?).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = recheck(&mut tx, &h, &[], &hash).await?;
    let id = actor["id"].as_str().unwrap();
    crate::login_challenges::clear(&mut tx, id).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id=? AND verifier<>?")
        .bind(id)
        .bind(db::hash(auth::session_token(&h)?))
        .execute(&mut *tx)
        .await?;
    db::audit(&mut tx, id, "account.revoke_sessions", id, "success").await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

pub async fn issue_reset(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
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
        let actor = auth::authorize(&s, &h, &["admin"], true).await?;
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
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
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
        return Err(ApiError::conflict(
            "Enable the account before issuing a password reset",
        ));
    }
    let code = auth::random_secret();
    let verifier = db::hash(&code);
    let expires_at =
        (Utc::now() + Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Secs, true);
    sqlx::query("DELETE FROM password_reset_codes WHERE user_id=? OR expires_at<=?")
        .bind(&id)
        .bind(db::now())
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO password_reset_codes(verifier,user_id,expires_at,issuer_id) VALUES(?,?,?,?)",
    )
    .bind(&verifier)
    .bind(&id)
    .bind(&expires_at)
    .bind(actor_id)
    .execute(&mut *tx)
    .await?;
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
        "user.password_reset.issue",
        &id,
        "success",
    )
    .await?;
    tx.commit().await?;
    let response = match key {
        Some(key) => json!({"request_id":key,"user_id":id,"code":code,"expires_at":expires_at}),
        None => json!({"code":code,"expires_at":expires_at}),
    };
    Ok(Json(response))
}

pub async fn redeem_reset(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden());
    }
    s.limit(
        "password-reset-global".into(),
        30,
        std::time::Duration::from_secs(60),
    )?;
    let code = v["code"]
        .as_str()
        .filter(|c| c.len() == 64 && c.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(ApiError::unauthorized)?;
    let verifier = db::hash(code);
    s.limit(
        format!("password-reset:{verifier}"),
        8,
        std::time::Duration::from_secs(300),
    )?;
    let password = db::string(&v, "new_password", 256)?;
    auth::check_password(password)?;
    // Reject unknown/expired codes before starting expensive password work, then
    // check again transactionally. No read of account details is returned.
    let mut conn = s.pool.acquire().await?;
    if reset_target(&mut conn, &verifier).await?.is_none() {
        return Err(ApiError::unauthorized());
    }
    drop(conn);
    let hash = auth::password_hash(password.to_owned()).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let id = reset_target(&mut tx, &verifier)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    replace_password(&mut tx, &id, &hash).await?;
    db::audit(&mut tx, &id, "user.password_reset.redeem", &id, "success").await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}

async fn reset_target(conn: &mut SqliteConnection, verifier: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT r.user_id FROM password_reset_codes r JOIN users u ON u.id=r.user_id JOIN users issuer ON issuer.id=r.issuer_id WHERE r.verifier=? AND r.expires_at>? AND u.enabled=1 AND issuer.enabled=1 AND issuer.role='admin'")
        .bind(verifier).bind(db::now()).fetch_optional(conn).await?)
}
