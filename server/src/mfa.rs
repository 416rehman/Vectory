use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
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
fn authenticated_code_error(error: ApiError) -> ApiError {
    if error.code == "UNAUTHENTICATED" {
        ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "INVALID_MFA_CODE",
            "Authenticator or recovery code is invalid or already used",
        )
    } else {
        error
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
    // Capture the lifecycle generation before password hashing. A second setup
    // may finish hashing and commit first; the older prepared request must not
    // replace the secret and QR code returned by that later request.
    let expected_epoch: i64 = sqlx::query_scalar("SELECT mfa_epoch FROM users WHERE id=?")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    let password_hash = if action == "setup" || action == "disable" {
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
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
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
        return Err(ApiError::conflict(
            "MFA changed while this request was being checked. Review its current state and start again.",
        ));
    }
    let out = match action {
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
            let generator = totp(secret.clone(), actor["email"].as_str().unwrap_or("account"))?;
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
            )
            .map_err(authenticated_code_error)?;
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
            revoke_other_sessions(&mut tx, id, h).await?;
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
            .await
            .map_err(authenticated_code_error)?;
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
        _ => return Err(ApiError::missing()),
    };
    sqlx::query("UPDATE users SET mfa_epoch=mfa_epoch+1 WHERE id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    db::audit(&mut tx, id, &format!("mfa.{action}"), id, "success").await?;
    tx.commit().await?;
    Ok(Json(out))
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
        })
        .await
        .unwrap();
        let password = "a-long-enough-password";
        let (response_headers, Json(bootstrap)) = auth::bootstrap(
            AppState(s.clone()),
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
        assert_eq!(error.code, "CONFLICT");
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
