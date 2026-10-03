//! A host that had already started applying when its rollout was paused,
//! cancelled, stopped or failed still reports how it went. A rollback or a
//! failure of a release this server prepared is recorded whatever became of the
//! device's target: one issue and one audit row per device and result, and a
//! count toward the failure threshold only while the target is still in the
//! rollout.
use super::{engine::Rig, support::*};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use vectory_server::db;

/// The old build checks in after the privileged step took the new one back.
async fn rolled_back(r: &Rig, device: &str) {
    r.old(device, &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
}
/// ... or after it dropped the update before it changed anything.
async fn failed(r: &Rig, device: &str) {
    r.old(device, &r.result("failed", Some("PROBE_FAILED")))
        .await;
}

/// The `device.agent_update` audit rows of one device.
async fn rows(r: &Rig, device: &str) -> Vec<Value> {
    audits(&r.f, "device.agent_update")
        .await
        .into_iter()
        .filter(|row| row["target"] == json!(device))
        .collect()
}
/// The agent update issues of one device.
async fn issues(r: &Rig, device: &str) -> Vec<Value> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.device_id')=? AND json_extract(data,'$.stage')='agent_update' ORDER BY id",
    )
    .bind(device)
    .fetch_all(&r.f.state.pool)
    .await
    .unwrap();
    rows.iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}

async fn transition(r: &Rig, rollout: &str, action: &str) {
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/{action}"),
        Value::Null,
        &r.f.operator,
    )
    .await;
}

/// What a rollout of `devices` looks like once its first stage is out and one
/// host has staged the build.
async fn released(devices: usize, threshold: i64) -> (Rig, String, chrono::DateTime<Utc>) {
    let r = Rig::build(devices).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":devices,"failure_threshold":threshold,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    assert_eq!(r.count(&rollout, "offered").await, devices as i64);
    r.old(&r.ids[0], &r.about("staged")).await;
    (r, rollout, at)
}

#[tokio::test]
async fn a_rollback_after_a_pause_is_recorded_and_counts_toward_the_threshold() {
    let (r, rollout, at) = released(2, 0).await;
    let [started, other] = [&r.ids[0], &r.ids[1]];
    // Someone ran `sudo vectory update apply` as the rollout was paused: the
    // server withdrew an offer the host had already started on.
    transition(&r, &rollout, "pause").await;
    assert_eq!(r.state(&rollout, started).await, "pending");
    rolled_back(&r, started).await;
    assert_eq!(r.state(&rollout, started).await, "rolled_back");
    assert_eq!(
        r.code(&rollout, started).await.as_deref(),
        Some("UNHEALTHY")
    );
    let audited = rows(&r, started).await;
    assert_eq!(audited.len(), 1);
    assert_eq!(audited[0]["outcome"], "rolled_back");
    assert_eq!(audited[0]["details"]["state"], "rolled_back");
    assert_eq!(audited[0]["details"]["code"], "UNHEALTHY");
    assert_eq!(audited[0]["details"]["rollout_id"], json!(rollout));
    assert_eq!(audited[0]["details"]["version"], "0.1.1");
    assert_eq!(audited[0]["details"]["from_version"], "0.1.0");
    let opened = issues(&r, started).await;
    assert_eq!(opened.len(), 1);
    assert_eq!(opened[0]["code"], "AGENT_UPDATE_ROLLED_BACK");
    assert_eq!(opened[0]["update_code"], "UNHEALTHY");
    assert_eq!(opened[0]["resolved"], false);
    // The same report again records nothing more.
    rolled_back(&r, started).await;
    rolled_back(&r, started).await;
    assert_eq!(rows(&r, started).await.len(), 1);
    let again = issues(&r, started).await;
    assert_eq!(again.len(), 1);
    assert_eq!(again[0]["reports"], opened[0]["reports"]);
    assert_eq!(again[0]["count"], opened[0]["count"]);
    // Resumed, the rollout counts it: with a threshold of none, it stops, and the
    // device that never started is withdrawn.
    transition(&r, &rollout, "resume").await;
    step(&r.f, at + Duration::seconds(5)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.show(&rollout).await["failure_reason"], "threshold");
    assert_eq!(r.state(&rollout, other).await, "cancelled");
    // It is no longer a device the rollout can skip as already tried.
    assert_eq!(r.count(&rollout, "skipped").await, 0);
}

#[tokio::test]
async fn a_rollback_or_a_failure_after_a_cancel_is_recorded_once_and_ends_nothing() {
    let (r, rollout, _) = released(3, 100).await;
    let [rolled, dropped, quiet] = [&r.ids[0], &r.ids[1], &r.ids[2]];
    transition(&r, &rollout, "cancel").await;
    for device in [rolled, dropped, quiet] {
        assert_eq!(r.state(&rollout, device).await, "cancelled");
    }
    rolled_back(&r, rolled).await;
    failed(&r, dropped).await;
    for _ in 0..2 {
        // ... and again, as every check-in repeats it.
        rolled_back(&r, rolled).await;
        failed(&r, dropped).await;
    }
    // The targets are final: a cancelled target stays cancelled.
    assert_eq!(r.state(&rollout, rolled).await, "cancelled");
    assert_eq!(r.state(&rollout, dropped).await, "cancelled");
    let first = rows(&r, rolled).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["outcome"], "rolled_back");
    let second = rows(&r, dropped).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0]["outcome"], "failed");
    assert_eq!(second[0]["details"]["code"], "PROBE_FAILED");
    assert_eq!(rows(&r, quiet).await.len(), 0, "it reported nothing");
    let first = issues(&r, rolled).await;
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["code"], "AGENT_UPDATE_ROLLED_BACK");
    let second = issues(&r, dropped).await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0]["code"], "AGENT_UPDATE_FAILED");
    assert_eq!(second[0]["update_code"], "PROBE_FAILED");
    // A release this server never prepared, and a device that was never in a
    // rollout of the release, record nothing.
    let other = with(
        r.idle(),
        json!({"last":{"release":db::hash("another release"),"outcome":"rolled_back","code":"UNHEALTHY","at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
    );
    r.old(quiet, &other).await;
    let stranger = device(&r.f, "stranger", "0.1.0").await;
    store(&r.f, &stranger, &r.idle()).await;
    rolled_back(&r, &stranger).await;
    assert!(rows(&r, quiet).await.is_empty());
    assert!(rows(&r, &stranger).await.is_empty());
    assert!(issues(&r, &stranger).await.is_empty());
    assert_eq!(audits(&r.f, "device.agent_update").await.len(), 2);
}

#[tokio::test]
async fn a_rollback_after_stop_all_updates_is_recorded_once() {
    let (r, rollout, _) = released(2, 100).await;
    let [started, other] = [&r.ids[0], &r.ids[1]];
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A bad build"}),
        &r.f.operator,
    )
    .await;
    assert_eq!(r.state(&rollout, started).await, "cancelled");
    rolled_back(&r, started).await;
    rolled_back(&r, started).await;
    assert_eq!(r.state(&rollout, started).await, "cancelled");
    assert_eq!(rows(&r, started).await.len(), 1);
    assert_eq!(issues(&r, started).await.len(), 1);
    assert!(rows(&r, other).await.is_empty());
}

#[tokio::test]
async fn a_rollback_after_the_threshold_failed_the_rollout_is_recorded_once() {
    let (r, rollout, at) = released(3, 0).await;
    let [first, started, other] = [&r.ids[1], &r.ids[0], &r.ids[2]];
    // One device rolls back inside the rollout and the threshold is passed: what
    // had not started is withdrawn.
    r.apply(&rollout, first).await;
    rolled_back(&r, first).await;
    step(&r.f, at + Duration::seconds(5)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.state(&rollout, started).await, "cancelled");
    // The host that had staged the build, and one that never reported, finish
    // what they had begun.
    rolled_back(&r, started).await;
    failed(&r, other).await;
    for _ in 0..2 {
        rolled_back(&r, started).await;
        failed(&r, other).await;
    }
    assert_eq!(rows(&r, first).await.len(), 1, "counted once, as it ended");
    assert_eq!(rows(&r, started).await.len(), 1);
    assert_eq!(rows(&r, other).await.len(), 1);
    assert_eq!(issues(&r, started).await.len(), 1);
    assert_eq!(issues(&r, other).await.len(), 1);
    assert_eq!(r.state(&rollout, started).await, "cancelled");
    assert_eq!(r.show(&rollout).await["failure_reason"], "threshold");
}

#[tokio::test]
async fn a_new_result_after_an_earlier_one_is_a_new_record() {
    let (r, rollout, _) = released(2, 100).await;
    let started = &r.ids[0];
    transition(&r, &rollout, "cancel").await;
    rolled_back(&r, started).await;
    assert_eq!(rows(&r, started).await.len(), 1);
    // The step wrote another result for the same release.
    let later = with(
        r.idle(),
        json!({"last":{"release":r.release.manifest_sha256,"outcome":"failed","code":"DISK_FULL","at":"2026-10-06T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
    );
    r.old(started, &later).await;
    let all = rows(&r, started).await;
    assert_eq!(all.len(), 2);
    assert_eq!(all[1]["outcome"], "failed");
    assert_eq!(all[1]["details"]["code"], "DISK_FULL");
}
