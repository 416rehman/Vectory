use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    Json,
    extract::{Path, State as AppState},
    http::HeaderMap,
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use subtle::ConstantTimeEq;
use totp_rs::{Algorithm, Secret, TOTP};

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
        let normalized = code.replace('-', "").to_ascii_lowercase();
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
            axum::http::StatusCode::UNAUTHORIZED,
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
async fn password(s: &State, user: &str, value: &Value) -> Result<()> {
    let password = db::string(value, "password", 256)?.to_owned();
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(user)
        .fetch_one(&s.pool)
        .await?;
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}
async fn revoke_other_sessions(
    conn: &mut SqliteConnection,
    user: &str,
    h: &HeaderMap,
) -> Result<()> {
    let token = h
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .find_map(|p| p.trim().strip_prefix("vectory_session="))
        })
        .unwrap_or("");
    sqlx::query("DELETE FROM sessions WHERE user_id=? AND verifier<>?")
        .bind(user)
        .bind(db::hash(token))
        .execute(conn)
        .await?;
    Ok(())
}
pub async fn status(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], false).await?;
    let enabled: Option<bool> = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(user["id"].as_str().unwrap())
        .fetch_optional(&s.pool)
        .await?;
    Ok(Json(json!({"enabled":enabled.unwrap_or(false)})))
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
    if action == "setup" || action == "disable" {
        password(&s, id, &v).await?;
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let out = match action.as_str() {
        "setup" => {
            let enabled: Option<bool> =
                sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            if enabled == Some(true) {
                return Err(ApiError::conflict(
                    "Disable existing MFA before replacing its authenticator",
                ));
            }
            let secret = Secret::generate_secret().to_encoded().to_string();
            let generator = totp(secret.clone(), user["email"].as_str().unwrap_or("account"))?;
            let ciphertext = s.keys.seal_mfa(id, &secret)?;
            sqlx::query("INSERT INTO user_mfa(user_id,secret_ciphertext,pending_expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,pending_expires_at=excluded.pending_expires_at,last_used_step=-1").bind(id).bind(ciphertext).bind((Utc::now()+Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true)).execute(&mut *tx).await?;
            json!({"secret":secret,"otpauth_url":generator.get_url()})
        }
        "confirm" => {
            let row = sqlx::query(
                "SELECT * FROM user_mfa WHERE user_id=? AND enabled=0 AND pending_expires_at>?",
            )
            .bind(id)
            .bind(db::now())
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| ApiError::conflict("Start a new MFA setup"))?;
            let secret = s.keys.open_mfa(id, row.get("secret_ciphertext"))?;
            let step = verify_code(
                &secret,
                db::string(&v, "code", 6)?,
                row.get("last_used_step"),
            )?;
            sqlx::query("UPDATE user_mfa SET enabled=1,last_used_step=? WHERE user_id=?")
                .bind(step)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            let mut codes = Vec::new();
            for _ in 0..8 {
                let raw = auth::random_secret()[..32].to_owned();
                sqlx::query("INSERT INTO mfa_recovery_codes(user_id,verifier) VALUES(?,?)")
                    .bind(id)
                    .bind(db::hash(&raw))
                    .execute(&mut *tx)
                    .await?;
                codes.push(
                    raw.as_bytes()
                        .chunks(8)
                        .map(|c| std::str::from_utf8(c).unwrap())
                        .collect::<Vec<_>>()
                        .join("-"),
                );
            }
            revoke_other_sessions(&mut tx, id, &h).await?;
            json!({"enabled":true,"recovery_codes":codes})
        }
        "disable" => {
            verify_login(
                &s,
                &mut tx,
                id,
                v["code"].as_str(),
                v["recovery_code"].as_str(),
            )
            .await?;
            sqlx::query("DELETE FROM user_mfa WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id=?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
            revoke_other_sessions(&mut tx, id, &h).await?;
            json!({"enabled":false})
        }
        _ => return Err(ApiError::missing()),
    };
    db::audit(&mut tx, id, &format!("mfa.{action}"), id, "success").await?;
    tx.commit().await?;
    Ok(Json(out))
}
