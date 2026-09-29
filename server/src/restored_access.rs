//! Explicit access invalidation after a point-in-time restore, never an HTTP operation.
//! The maintenance caller holds the exclusive state-directory lock for its lifetime.
use crate::{State, db};
use serde_json::{Value, json};

pub async fn invalidate(s: &State, apply: bool) -> anyhow::Result<Value> {
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let malformed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM enrollment_tokens WHERE json_type(data) != 'object'",
    )
    .fetch_one(&mut *tx)
    .await?;
    if malformed != 0 {
        anyhow::bail!(
            "Enrollment-token records are malformed; repair the restored state before invalidating access"
        )
    }
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&mut *tx)
        .await?;
    let resets: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_codes")
        .fetch_one(&mut *tx)
        .await?;
    let recovery: i64 = sqlx::query_scalar("SELECT count(*) FROM mfa_recovery_codes")
        .fetch_one(&mut *tx)
        .await?;
    let tokens: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM enrollment_tokens WHERE json_type(data,'$.revoked') IS NOT 'true'",
    )
    .fetch_one(&mut *tx)
    .await?;
    let counts = json!({
        "browser_sessions":sessions,
        "password_reset_codes":resets,
        "enrollment_tokens_to_revoke":tokens,
        "mfa_recovery_codes":recovery
    });
    if apply {
        sqlx::query("DELETE FROM sessions")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM password_reset_codes")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM mfa_recovery_codes")
            .execute(&mut *tx)
            .await?;
        // Keep token records and enrollment replay history, including their FK links.
        // JSON true is required: numeric 1 is not a revoked token in the API model.
        sqlx::query("UPDATE enrollment_tokens SET data=json_set(data,'$.revoked',json('true')) WHERE json_type(data,'$.revoked') IS NOT 'true'")
            .execute(&mut *tx).await?;
        db::insert(
            &mut tx,
            "audit",
            &json!({
                "id":db::id(),"actor":"local-admin","action":"server.restore_access.invalidate",
                "target":"control-plane","outcome":"success","created_at":db::now(),"details":counts
            }),
        )
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(json!({
        "applied":apply,
        "counts":counts,
        "notice":"This does not reconcile restored passwords, account roles/access, MFA enrollments, or device revocations. Keep the instance isolated until those decisions and device generation floors are reviewed. MFA authenticators remain required; all saved MFA recovery codes become unusable when applied."
    }))
}
