//! A password-verified capability can complete MFA, but authorizes no other API.
//! Every factor attempt and session commit is serialized with account changes.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{State as AppState, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::{Duration, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

fn expired() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "MFA_CHALLENGE_EXPIRED",
        "Sign in again to request a new verification challenge",
    )
}

pub(crate) async fn clear(conn: &mut SqliteConnection, user: &str) -> Result<()> {
    sqlx::query("DELETE FROM login_challenges WHERE user_id=?")
        .bind(user)
        .execute(conn)
        .await?;
    Ok(())
}

pub(crate) async fn issue(
    conn: &mut SqliteConnection,
    user: &sqlx::sqlite::SqliteRow,
    mfa_ciphertext: &str,
) -> Result<Value> {
    let id: &str = user.get("id");
    sqlx::query("DELETE FROM login_challenges WHERE user_id=? OR expires_at<=?")
        .bind(id)
        .bind(db::now())
        .execute(&mut *conn)
        .await?;
    let token = auth::random_secret();
    let expires_at = (Utc::now() + Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true);
    sqlx::query("INSERT INTO login_challenges(verifier,user_id,user_revision,password_fingerprint,mfa_fingerprint,expires_at) VALUES(?,?,?,?,?,?)")
        .bind(db::hash(&token)).bind(id).bind(user.get::<i64,_>("revision"))
        .bind(db::hash(user.get::<String,_>("password_hash"))).bind(db::hash(mfa_ciphertext))
        .bind(&expires_at).execute(conn).await?;
    Ok(json!({"mfa_required":true,"challenge_token":token,"expires_at":expires_at}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Completion {
    challenge_token: String,
    #[serde(default, deserialize_with = "non_null_factor")]
    totp_code: Option<String>,
    #[serde(default, deserialize_with = "non_null_factor")]
    recovery_code: Option<String>,
}

fn non_null_factor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

pub async fn complete(
    AppState(s): AppState<State>,
    h: HeaderMap,
    body: std::result::Result<Json<Completion>, JsonRejection>,
) -> Result<(HeaderMap, Json<Value>)> {
    if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return Err(ApiError::forbidden());
    }
    s.limit(
        "login-mfa-global".into(),
        60,
        std::time::Duration::from_secs(60),
    )?;
    let Json(v) = body.map_err(|_| {
        ApiError::invalid(
            "Provide a challenge token and exactly one authenticator or recovery code",
        )
    })?;
    if v.totp_code.is_some() == v.recovery_code.is_some() {
        return Err(ApiError::invalid(
            "Provide exactly one authenticator or recovery code",
        ));
    }
    if v.challenge_token.len() != 64
        || !v
            .challenge_token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(expired());
    }
    let verifier = db::hash(&v.challenge_token);
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let challenge = sqlx::query("SELECT * FROM login_challenges WHERE verifier=?")
        .bind(&verifier)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(expired)?;
    let id: String = challenge.get("user_id");
    let user = sqlx::query("SELECT * FROM users WHERE id=? AND enabled=1")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    let mfa: Option<String> =
        sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa WHERE user_id=? AND enabled=1")
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let valid = challenge.get::<String, _>("expires_at") > db::now()
        && challenge.get::<i64, _>("attempts") < 5
        && user.as_ref().is_some_and(|u| {
            u.get::<i64, _>("revision") == challenge.get::<i64, _>("user_revision")
                && db::hash(u.get::<String, _>("password_hash"))
                    == challenge.get::<String, _>("password_fingerprint")
        })
        && mfa.is_some_and(|cipher| {
            db::hash(cipher) == challenge.get::<String, _>("mfa_fingerprint")
        });
    if !valid {
        clear(&mut tx, &id).await?;
        tx.commit().await?;
        return Err(expired());
    }
    s.limit(
        format!("login-mfa:{id}"),
        10,
        std::time::Duration::from_secs(300),
    )?;
    if let Err(error) = crate::mfa::verify_login(
        &s,
        &mut tx,
        &id,
        v.totp_code.as_deref(),
        v.recovery_code.as_deref(),
    )
    .await
    {
        // Infrastructure failures roll back. A rejected factor consumes a durable
        // attempt even if requests race; no factor/challenge value enters audit.
        if error.code != "UNAUTHENTICATED" {
            return Err(error);
        }
        let attempts = challenge.get::<i64, _>("attempts") + 1;
        if attempts >= 5 {
            clear(&mut tx, &id).await?;
        } else {
            sqlx::query("UPDATE login_challenges SET attempts=? WHERE verifier=?")
                .bind(attempts)
                .bind(&verifier)
                .execute(&mut *tx)
                .await?;
        }
        db::audit(&mut tx, &id, "login.mfa", "", "denied").await?;
        tx.commit().await?;
        return Err(if attempts >= 5 {
            expired()
        } else {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "INVALID_MFA_CODE",
                "Authenticator or recovery code is invalid or already used",
            )
        });
    }
    let response = auth::finish_login(&s, &mut tx, &h, auth::public_user(&user.unwrap())).await?;
    tx.commit().await?;
    Ok(response)
}
