//! A restored server stops agent updates until an administrator has looked at
//! what the backup brought back: a key revoked since, rollouts that ended, a
//! release that was withdrawn and a stop that was set all return as they were.
//! `vectory-admin invalidate-restored-access --apply` does the stopping.
use super::{engine::Rig, support::*};
use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{Value, json};
use vectory_server::restored_access;

const REASON: &str = "The server was restored from a backup. Review the release keys, the releases and the rollouts, then clear the stop in Settings → Agent updates.";

async fn stopped_reason(f: &Fixture) -> Option<String> {
    sqlx::query_scalar("SELECT stopped_reason FROM agent_update_settings WHERE id=1")
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn applying_the_restore_stops_all_updates_and_says_what_it_will_stop() {
    let r = Rig::build(4).await;
    // What the backup holds: a rollout with offers out and one that was paused.
    let running = r
        .start(
            &[&r.ids[0], &r.ids[1]],
            json!({"canary_size":2,"failure_threshold":5}),
        )
        .await;
    let held = r.start(&[&r.ids[2]], json!({})).await;
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{held}/pause"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    step(&r.f, Utc::now()).await;
    assert_eq!(r.count(&running, "offered").await, 2);

    // The preview names what it will stop and changes nothing.
    let preview = restored_access::invalidate(&r.f.state, false)
        .await
        .unwrap();
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["counts"]["agent_update_rollouts_to_cancel"], 2);
    assert_eq!(preview["counts"]["agent_update_stop"], 1);
    assert_eq!(stopped_reason(&r.f).await, None);
    assert_eq!(r.status(&running).await, "active");
    assert_eq!(r.status(&held).await, "paused");
    assert!(audits(&r.f, "agent_update.stop").await.is_empty());

    let applied = restored_access::invalidate(&r.f.state, true).await.unwrap();
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["counts"], preview["counts"]);
    // Everyone was signed out: a new session, to read what happened.
    let admin = user(&r.f.state, "admin").await;
    let shown = ok(&r.f, "GET", "/api/v1/agent-updates", Value::Null, &admin).await;
    assert_eq!(shown["enabled"], true, "updates stay on, stopped");
    assert_eq!(shown["stopped"]["reason"], REASON);
    assert_eq!(shown["stopped"]["by_name"], "Local administrator");
    assert!(shown["stopped"]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(shown["active_rollouts"], 0);
    // Every rollout was cancelled as Stop all updates cancels, and every offer
    // withdrawn.
    for rollout in [&running, &held] {
        let shown = ok(
            &r.f,
            "GET",
            &format!("/api/v1/agent-update-rollouts/{rollout}"),
            Value::Null,
            &admin,
        )
        .await;
        assert_eq!(shown["status"], "cancelled");
        assert_eq!(shown["cancel_reason"], "stop");
    }
    assert_eq!(r.count(&running, "cancelled").await, 2);
    assert_eq!(r.count(&held, "cancelled").await, 1);
    assert!(
        r.old(&r.ids[0], &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    // The audit log has the stop, as the route writes it, by the local
    // administrator, and the restore's own row with the counts.
    let stops = audits(&r.f, "agent_update.stop").await;
    assert_eq!(stops.len(), 1);
    assert_eq!(stops[0]["actor"], "local-admin");
    assert_eq!(stops[0]["target"], "server");
    assert_eq!(stops[0]["outcome"], "success");
    assert_eq!(stops[0]["details"]["reason"], REASON);
    assert_eq!(stops[0]["details"]["cancelled_rollouts"], 2);
    let restores = audits(&r.f, "server.restore_access.invalidate").await;
    assert_eq!(restores.len(), 1);
    assert_eq!(restores[0]["actor"], "local-admin");
    assert_eq!(restores[0]["details"]["agent_update_rollouts_to_cancel"], 2);
    assert_eq!(restores[0]["details"]["agent_update_stop"], 1);
    // No new rollout starts until an administrator clears the stop; clearing
    // resumes nothing.
    let review = preview_as(&r, &admin, &r.ids[3]).await;
    let mut body = request(&r.release.id, &[&r.ids[3]], json!({}));
    body["review_token"] = review["review_token"].clone();
    refused(
        &r.f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body,
        &admin,
        StatusCode::CONFLICT,
        "AGENT_UPDATES_STOPPED",
    )
    .await;
    // Applying again finds nothing left to stop.
    let again = restored_access::invalidate(&r.f.state, true).await.unwrap();
    assert_eq!(again["counts"]["agent_update_rollouts_to_cancel"], 0);
    assert_eq!(again["counts"]["agent_update_stop"], 0);
    assert_eq!(audits(&r.f, "agent_update.stop").await.len(), 1);
    let admin = user(&r.f.state, "admin").await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":shown["revision"]}),
        &admin,
    )
    .await;
    assert_eq!(r.status(&running).await, "cancelled");
}

async fn preview_as(r: &Rig, who: &Who, device: &String) -> Value {
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        request(&r.release.id, &[device], json!({})),
        who,
    )
    .await
}

#[tokio::test]
async fn a_stop_the_backup_already_holds_is_kept_as_it_was() {
    let r = Rig::build(2).await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A bad build"}),
        &r.f.operator,
    )
    .await;
    let counts = restored_access::invalidate(&r.f.state, false)
        .await
        .unwrap()["counts"]
        .clone();
    assert_eq!(counts["agent_update_rollouts_to_cancel"], 0);
    assert_eq!(counts["agent_update_stop"], 0);
    restored_access::invalidate(&r.f.state, true).await.unwrap();
    assert_eq!(stopped_reason(&r.f).await.as_deref(), Some("A bad build"));
    assert_eq!(
        audits(&r.f, "agent_update.stop").await.len(),
        1,
        "only the stop somebody made"
    );
}

#[tokio::test]
async fn with_updates_off_the_restore_changes_nothing_about_them() {
    let f = fixture().await;
    let preview = restored_access::invalidate(&f.state, false).await.unwrap();
    for member in ["agent_update_rollouts_to_cancel", "agent_update_stop"] {
        assert!(preview["counts"].get(member).is_none(), "{member}");
    }
    restored_access::invalidate(&f.state, true).await.unwrap();
    assert_eq!(stopped_reason(&f).await, None);
    assert!(audits(&f, "agent_update.stop").await.is_empty());
    let restores = audits(&f, "server.restore_access.invalidate").await;
    assert_eq!(restores.len(), 1);
    assert!(restores[0]["details"].get("agent_update_stop").is_none());
}
