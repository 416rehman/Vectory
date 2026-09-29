use crate::{
    State,
    auth::{self, ending},
    db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, State as AppState},
    http::{HeaderMap, StatusCode},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use subtle::ConstantTimeEq;
use totp_rs::{Algorithm, Secret, TOTP};

/// A scanned setup must be confirmed within this window.
pub const SETUP_MINUTES: i64 = 10;
const RECOVERY_CODES: usize = 8;

fn totp(secret: String, email: &str) -> Result<TOTP> {
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        Secret::Encoded(secret)
            .to_bytes()
            .map_err(|_| ApiError::forbidden())?,
        Some("Vectory".into()),
        email.replace(':', "_"),
    )
    .map_err(|_| ApiError::forbidden())
}
pub async fn verify_login(
    s: &State,
    conn: &mut SqliteConnection,
    user: &str,
    code: Option<&str>,
    recovery: Option<&str>,
) -> Result<()> {
    let row = sqlx::query("SELECT * FROM user_mfa WHERE user_id=? AND enabled=1")
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(()) };
    if let Some(code) = recovery {
        if code.len() > 80 {
            return Err(ApiError::unauthorized());
        }
        let normalized: String = code
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .collect::<String>()
            .to_ascii_lowercase();
        let result = sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=? AND verifier=?")
            .bind(user)
            .bind(db::hash(normalized))
            .execute(&mut *conn)
            .await?;
        if result.rows_affected() == 1 {
            db::audit(conn, user, "mfa.recovery_code", user, "success").await?;
            return Ok(());
        }
        return Err(ApiError::unauthorized());
    }
    let code = code.ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "UNAUTHENTICATED",
            "Authenticator code required",
        )
    })?;
    let secret = s.keys.open_mfa(user, row.get("secret_ciphertext"))?;
    let step = verify_code(&secret, code, row.get("last_used_step"))?;
    sqlx::query("UPDATE user_mfa SET last_used_step=? WHERE user_id=?")
        .bind(step)
        .bind(user)
        .execute(conn)
        .await?;
    Ok(())
}
fn verify_code(secret: &str, code: &str, last: i64) -> Result<i64> {
    // Accept a pasted "123 456" or "123-456"; only six digits are compared.
    let code: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ApiError::unauthorized());
    }
    let generator = totp(secret.into(), "account")?;
    let current = Utc::now().timestamp() / 30;
    for step in [current - 1, current, current + 1] {
        if step > last
            && bool::from(
                generator
                    .generate((step * 30) as u64)
                    .as_bytes()
                    .ct_eq(code.as_bytes()),
            )
        {
            return Ok(step);
        }
    }
    Err(ApiError::unauthorized())
}
fn authenticated_code_error(message: &'static str) -> impl Fn(ApiError) -> ApiError {
    move |error| {
        if error.code == "UNAUTHENTICATED" {
            ApiError::new(StatusCode::FORBIDDEN, "INVALID_MFA_CODE", message)
        } else {
            error
        }
    }
}
const SETUP_CODE_MISMATCH: &str =
    "That code didn't match. Enter the current 6-digit code from your authenticator app.";
const FACTOR_MISMATCH: &str =
    "That code didn't match. Enter a current authenticator code or an unused recovery code.";
async fn revoke_other_sessions(
    conn: &mut SqliteConnection,
    user: &str,
    h: &HeaderMap,
) -> Result<()> {
    let current = auth::session_token(h).map(db::hash).unwrap_or_default();
    auth::end_sessions(conn, user, Some(&current), ending::MFA_CHANGED).await
}
async fn replace_recovery_codes(conn: &mut SqliteConnection, id: &str) -> Result<Vec<String>> {
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    let mut codes = Vec::with_capacity(RECOVERY_CODES);
    for _ in 0..RECOVERY_CODES {
        let raw = auth::random_secret()[..32].to_owned();
        sqlx::query("INSERT INTO mfa_recovery_codes(user_id,verifier) VALUES(?,?)")
            .bind(id)
            .bind(db::hash(&raw))
            .execute(&mut *conn)
            .await?;
        codes.push(
            raw.as_bytes()
                .chunks(8)
                .map(|c| std::str::from_utf8(c).unwrap())
                .collect::<Vec<_>>()
                .join("-"),
        );
    }
    Ok(codes)
}
fn not_enabled() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "MFA_NOT_ENABLED",
        "Two-factor authentication is off for this account.",
    )
}
pub async fn status(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], false).await?;
    let id = user["id"].as_str().unwrap();
    let mut tx = s.pool.begin().await?;
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let enabled = enabled.unwrap_or(false);
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM mfa_recovery_codes WHERE user_id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    Ok(Json(json!({
        "enabled":enabled,
        "recovery_codes_remaining":if enabled { json!(remaining) } else { Value::Null }
    })))
}
pub async fn manage(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(action): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], true).await?;
    let id = user["id"].as_str().unwrap();
    s.limit(format!("mfa:{id}"), 10, std::time::Duration::from_secs(300))?;
    // Capture the lifecycle generation before password hashing. A second setup
    // may finish hashing and commit first; the older prepared request must not
    // replace the secret and QR code returned by that later request.
    let expected_epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let password_hash = if matches!(action.as_str(), "setup" | "disable" | "recovery-codes") {
        Some(
            crate::accounts::reauthenticate(&s, &h, &[], db::string(&v, "password", 256)?)
                .await?
                .1,
        )
    } else {
        None
    };
    commit_prepared(&s, &h, &action, &v, id, expected_epoch, password_hash).await
}

async fn commit_prepared(
    s: &State,
    h: &HeaderMap,
    action: &str,
    v: &Value,
    id: &str,
    expected_epoch: i64,
    password_hash: Option<String>,
) -> Result<Json<Value>> {
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = if let Some(hash) = password_hash {
        crate::accounts::recheck(&mut tx, h, &[], &hash).await?
    } else {
        auth::authorize_in(&mut tx, h, &[], true).await?
    };
    let current_epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if current_epoch != expected_epoch {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "MFA_CHANGED",
            "Your two-factor settings changed in another window. Check them and try again.",
        ));
    }
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let out = match action {
        "setup" => {
            if enabled == Some(true) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "MFA_ALREADY_ENABLED",
                    "Two-factor authentication is already on. Turn it off before connecting a new authenticator.",
                ));
            }
            let secret = Secret::generate_secret().to_encoded().to_string();
            let generator = totp(secret.clone(), actor["email"].as_str().unwrap_or("account"))?;
            let ciphertext = s.keys.seal_mfa(id, &secret)?;
            let expires_at = (Utc::now() + Duration::minutes(SETUP_MINUTES))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            sqlx::query("INSERT INTO user_mfa(user_id,secret_ciphertext,pending_expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,pending_expires_at=excluded.pending_expires_at,last_used_step=-1").bind(id).bind(ciphertext).bind(&expires_at).execute(&mut *tx).await?;
            json!({"secret":secret,"otpauth_url":generator.get_url(),"expires_at":expires_at})
        }
        "confirm" => {
            let row = sqlx::query(
                "SELECT * FROM user_mfa WHERE user_id=? AND enabled=0 AND pending_expires_at>?",
            )
            .bind(id)
            .bind(db::now())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                if enabled == Some(true) {
                    ApiError::new(
                        StatusCode::CONFLICT,
                        "MFA_ALREADY_ENABLED",
                        "Two-factor authentication is already on for your account.",
                    )
                } else {
                    ApiError::new(
                        StatusCode::CONFLICT,
                        "MFA_SETUP_EXPIRED",
                        "This setup expired. Start a new one to get a fresh QR code.",
                    )
                }
            })?;
            let secret = s.keys.open_mfa(id, row.get("secret_ciphertext"))?;
            let step = verify_code(
                &secret,
                db::string(v, "code", 16)?,
                row.get("last_used_step"),
            )
            .map_err(authenticated_code_error(SETUP_CODE_MISMATCH))?;
            sqlx::query("UPDATE user_mfa SET enabled=1,last_used_step=? WHERE user_id=?")
                .bind(step)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            let codes = replace_recovery_codes(&mut tx, id).await?;
            revoke_other_sessions(&mut tx, id, h).await?;
            json!({"enabled":true,"recovery_codes":codes})
        }
        "disable" => {
            verify_login(
                s,
                &mut tx,
                id,
                v["code"].as_str(),
                v["recovery_code"].as_str(),
            )
            .await
            .map_err(authenticated_code_error(FACTOR_MISMATCH))?;
            sqlx::query("DELETE FROM user_mfa WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            revoke_other_sessions(&mut tx, id, h).await?;
            json!({"enabled":false})
        }
        "recovery-codes" => {
            if enabled != Some(true) {
                return Err(not_enabled());
            }
            if v["code"].as_str().is_none_or(str::is_empty)
                && v["recovery_code"].as_str().is_none_or(str::is_empty)
            {
                return Err(ApiError::invalid(
                    "Enter a current authenticator code or an unused recovery code.",
                ));
            }
            verify_login(
                s,
                &mut tx,
                id,
                v["code"].as_str(),
                v["recovery_code"].as_str(),
            )
            .await
            .map_err(authenticated_code_error(FACTOR_MISMATCH))?;
            let codes = replace_recovery_codes(&mut tx, id).await?;
            json!({"enabled":true,"recovery_codes":codes})
        }
        _ => return Err(ApiError::missing()),
    };
    sqlx::query("UPDATE users SET mfa_epoch=mfa_epoch+1 WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    db::audit(
        &mut tx,
        id,
        &format!("mfa.{}", action.replace('-', "_")),
        id,
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(out))
}

/// Remove every second factor from one person's account. Shared by the
/// administrator action and the offline break-glass command; the caller holds
/// the writer transaction. Every session of that person ends.
async fn remove_factors(conn: &mut SqliteConnection, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM user_mfa WHERE user_id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE users SET mfa_epoch=mfa_epoch+1,revision=revision+1 WHERE id=?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    auth::end_sessions(conn, id, None, ending::MFA_RESET).await
}

/// Administrator break-glass for someone who lost their authenticator and
/// recovery codes. Needs the administrator's password and the reviewed account
/// revision. The person signs in with their password and can set up again.
pub async fn admin_reset(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    // Authenticate before the body is judged at all, so an anonymous caller
    // learns nothing from a malformed or undeclared one.
    crate::auth::authorize(&s, &h, &["admin"], true).await?;
    let v = crate::token_requests::parse(&body)?;
    let id = crate::deployment_requests::parse_id(&id)?;
    let (_, hash) = crate::accounts::reauthenticate(
        &s,
        &h,
        &["admin"],
        db::string(&v, "current_password", 256)?,
    )
    .await?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = crate::accounts::recheck(&mut tx, &h, &["admin"], &hash).await?;
    let actor_id = actor["id"].as_str().unwrap();
    if actor_id == id {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "OWN_MFA",
            "Change your own two-factor authentication from Your account.",
        ));
    }
    let target = crate::accounts::user(&mut tx, &id).await?;
    crate::accounts::revision(&v, target.get("revision"))?;
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    if enabled != Some(true) {
        return Err(not_enabled());
    }
    remove_factors(&mut tx, &id).await?;
    db::audit(&mut tx, actor_id, "user.mfa_reset", &id, "success").await?;
    let out = auth::public_user(&crate::accounts::user(&mut tx, &id).await?);
    tx.commit().await?;
    Ok(Json(json!({"user":out})))
}

/// Offline break-glass from `vectory-admin disable-mfa` on a stopped server.
pub async fn local_disable(s: &State, email: &str) -> anyhow::Result<String> {
    let email = email.trim().to_ascii_lowercase();
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let row = sqlx::query("SELECT id,name FROM users WHERE email=?")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No account uses {email}."))?;
    let id: String = row.get("id");
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    if enabled != Some(true) {
        anyhow::bail!("Two-factor authentication is already off for {email}.");
    }
    let fail = |error: ApiError| anyhow::anyhow!(error.message);
    remove_factors(&mut tx, &id).await.map_err(fail)?;
    db::audit(&mut tx, "local-admin", "user.mfa_reset", &id, "success")
        .await
        .map_err(fail)?;
    tx.commit().await?;
    Ok(row.get("name"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Settings, initialize};
    use axum::http::{HeaderValue, StatusCode};

    #[tokio::test]
    async fn epoch_migration_preserves_existing_account_session_and_mfa() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in [
            include_str!("../migrations/0001_initial.sql"),
            include_str!("../migrations/0002_mfa.sql"),
            include_str!("../migrations/0005_account_lifecycle.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('legacy','legacy@example.test','Legacy','admin','existing-verifier','2020-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sessions(verifier,user_id,csrf,expires_at) VALUES('session','legacy','csrf','2099-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO user_mfa(user_id,secret_ciphertext,pending_expires_at) VALUES('legacy','sealed-secret','2099-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!("../migrations/0023_mfa_epoch.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let (epoch, hash, revision): (i64, String, i64) =
            sqlx::query_as("SELECT mfa_epoch,password_hash,revision FROM users WHERE id='legacy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            (epoch, hash.as_str(), revision),
            (0, "existing-verifier", 1)
        );
        let sessions: i64 =
            sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id='legacy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let mfa: i64 = sqlx::query_scalar("SELECT count(*) FROM user_mfa WHERE user_id='legacy'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((sessions, mfa), (1, 1));
    }

    #[tokio::test]
    async fn older_prepared_setup_cannot_replace_a_newer_setup_or_repeat_audit() {
        let temp = tempfile::tempdir().unwrap();
        let s = initialize(Settings {
            data_dir: temp.path().join("state"),
            bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
            cookie_secure: false,
            dashboard_dir: temp.path().join("dist"),
            releases_dir: temp.path().join("releases"),
            instance_name: "Test".into(),
            validation_url: None,
            ..Default::default()
        })
        .await
        .unwrap();
        let password = "a-long-enough-password";
        let (response_headers, Json(bootstrap)) = auth::bootstrap(
            AppState(s.clone()),
            HeaderMap::new(),
            crate::ClientAddress(None),
            Json(json!({
                "bootstrap_secret": "isolated-test-bootstrap-secret-123456789",
                "email": "admin@example.test",
                "name": "Administrator",
                "password": password
            })),
        )
        .await
        .unwrap();
        let id = bootstrap["user"]["id"].as_str().unwrap();
        let mut headers = HeaderMap::new();
        let cookie = response_headers["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        headers.insert("cookie", HeaderValue::from_str(cookie).unwrap());
        headers.insert(
            "x-csrf-token",
            HeaderValue::from_str(bootstrap["csrf_token"].as_str().unwrap()).unwrap(),
        );

        // Model the older request after its initial authorization and before
        // its slow password proof completes. The next explicit setup commits
        // first, so the older prepared request must reject under the writer.
        let old_epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        let password_hash: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
                .bind(id)
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert!(auth::verify_password(password.into(), Some(password_hash.clone())).await);
        let Json(newer) = manage(
            AppState(s.clone()),
            headers.clone(),
            Path("setup".into()),
            Json(json!({"password":password})),
        )
        .await
        .unwrap();
        let ciphertext: String =
            sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa WHERE user_id=?")
                .bind(id)
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert_eq!(s.keys.open_mfa(id, &ciphertext).unwrap(), newer["secret"]);

        let error = commit_prepared(
            &s,
            &headers,
            "setup",
            &json!({"password":password}),
            id,
            old_epoch,
            Some(password_hash),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "MFA_CHANGED");
        let unchanged: String =
            sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa WHERE user_id=?")
                .bind(id)
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert_eq!(unchanged, ciphertext);
        let epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(epoch, old_epoch + 1);
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='mfa.setup'",
        )
        .fetch_one(&s.pool)
        .await
        .unwrap();
        assert_eq!(audit_count, 1);

        // Confirmation and disable also advance the private generation. In
        // particular, deleting the MFA row cannot recreate the original
        // row-absent state for an older prepared setup (an ABA race).
        let generator = TOTP::from_url(newer["otpauth_url"].as_str().unwrap()).unwrap();
        let Json(confirmed) = manage(
            AppState(s.clone()),
            headers.clone(),
            Path("confirm".into()),
            Json(json!({"code":generator.generate_current().unwrap()})),
        )
        .await
        .unwrap();
        assert_eq!(confirmed["enabled"], true);
        let next_step = Utc::now().timestamp() / 30 + 1;
        let Json(disabled) = manage(
            AppState(s.clone()),
            headers.clone(),
            Path("disable".into()),
            Json(json!({
                "password":password,
                "code":generator.generate((next_step * 30) as u64)
            })),
        )
        .await
        .unwrap();
        assert_eq!(disabled["enabled"], false);
        let epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(epoch, old_epoch + 3);
        let row_count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_mfa WHERE user_id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(row_count, 0);
        let stale_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        let error = commit_prepared(
            &s,
            &headers,
            "setup",
            &json!({"password":password}),
            id,
            old_epoch,
            Some(stale_hash),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        let row_count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_mfa WHERE user_id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(row_count, 0);
        let mfa_audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action') LIKE 'mfa.%'",
        )
        .fetch_one(&s.pool)
        .await
        .unwrap();
        assert_eq!(mfa_audits, 3);

        // A late audit failure must roll the secret and generation back in
        // the same transaction, leaving a retry at the current generation.
        sqlx::query("CREATE TRIGGER fail_mfa_setup_audit BEFORE INSERT ON records WHEN new.kind='audit' AND json_extract(new.data,'$.action')='mfa.setup' BEGIN SELECT RAISE(ABORT,'injected late failure'); END")
            .execute(&s.pool)
            .await
            .unwrap();
        let error = manage(
            AppState(s.clone()),
            headers,
            Path("setup".into()),
            Json(json!({"password":password})),
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        let epoch_after_failure: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(epoch_after_failure, epoch);
        let row_count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_mfa WHERE user_id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(row_count, 0);
    }
}
