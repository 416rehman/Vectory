//! Explicit access invalidation after a point-in-time restore, never an HTTP operation.
//! The maintenance caller holds the exclusive state-directory lock for its lifetime.
use crate::{State, agent_update_rollouts, agent_updates, db, error::ApiError};
use serde_json::{Value, json};

/// Why a server stops agent updates when its state is restored. A backup brings
/// back what was decided before it was taken: a release key revoked since is
/// current again, a stop that was set is gone, rollouts that ended are active
/// and releases that were withdrawn are ready. Nothing is offered to a host
/// until an administrator has looked.
pub const RESTORED_STOP_REASON: &str = "The server was restored from a backup. Review the release keys, the releases and the rollouts, then clear the stop in Settings → Agent updates.";
const ACTOR: &str = "local-admin";
/// What the stop shows as the one who made it: the name the dashboard gives this
/// actor in the audit log.
const ACTOR_NAME: &str = "Local administrator";

fn message(error: ApiError) -> anyhow::Error {
    anyhow::anyhow!(error.message)
}

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
    let mut counts = json!({
        "browser_sessions":sessions,
        "password_reset_codes":resets,
        "enrollment_tokens_to_revoke":tokens,
        "mfa_recovery_codes":recovery
    });
    // With agent updates on, a restore stops them (Stop all updates, as an
    // operator would): the counts say what it will cancel and whether it sets the
    // stop. A server where they are off, or already stopped, has nothing to stop.
    let updates = agent_updates::setting(&mut tx).await.map_err(message)?;
    if updates.enabled {
        let rollouts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agent_update_rollouts WHERE status IN ('active','paused')",
        )
        .fetch_one(&mut *tx)
        .await?;
        counts["agent_update_rollouts_to_cancel"] = json!(rollouts);
        counts["agent_update_stop"] = json!(i64::from(updates.stopped.is_none()));
    }
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
        if updates.enabled && updates.stopped.is_none() {
            let now = agent_updates::instant(chrono::Utc::now());
            sqlx::query("UPDATE agent_update_settings SET stopped_reason=?,stopped_by=?,stopped_by_name=?,stopped_at=? WHERE id=1")
                .bind(RESTORED_STOP_REASON)
                .bind(ACTOR)
                .bind(ACTOR_NAME)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
            agent_updates::advance(&mut tx).await.map_err(message)?;
            let cancelled = agent_update_rollouts::cancel_all(&mut tx, "stop", &now)
                .await
                .map_err(message)?;
            agent_updates::audit(
                &mut tx,
                ACTOR,
                "agent_update.stop",
                agent_updates::SERVER_TARGET,
                "success",
                json!({"reason":RESTORED_STOP_REASON,"cancelled_rollouts":cancelled.rollouts.len()}),
            )
            .await
            .map_err(message)?;
        }
        db::insert(
            &mut tx,
            "audit",
            &json!({
                "id":db::id(),"actor":ACTOR,"action":"server.restore_access.invalidate",
                "target":"control-plane","outcome":"success","created_at":db::now(),"details":counts
            }),
        )
        .await
        .map_err(message)?;
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    let mut notice = "This does not reconcile restored passwords, account roles/access, MFA enrollments, or device revocations. Keep the instance isolated until those decisions and device generation floors are reviewed. MFA authenticators remain required; all saved MFA recovery codes become unusable when applied.".to_owned();
    if updates.enabled {
        notice.push_str(" Applying also stops all agent updates until an administrator reviews the release keys, the releases and the rollouts and clears the stop in Settings → Agent updates.");
    }
    Ok(json!({
        "applied":apply,
        "counts":counts,
        "notice":notice
    }))
}
