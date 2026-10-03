//! A rollout never stays open for ever. What a target waits for ends, a device
//! that will not come back is not waited for, a release that expired ends its
//! rollouts, and a rollout that can't go on is ended by the safety net after a
//! day. Updates turned off and on again don't count the time they were off as
//! silence.
use super::{engine::Rig, support::*};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use vectory_server::db;

const LONG_AGO: &str = "2020-01-01T00:00:00Z";

fn instant(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// A rollout of every device of the rig, all of them in the canary.
async fn all_canary(r: &Rig) -> String {
    let refs: Vec<&String> = r.ids.iter().collect();
    r.start(
        &refs,
        json!({"canary_size":r.ids.len(),"failure_threshold":100,"observation_seconds":60}),
    )
    .await
}

async fn issue_count(f: &Fixture) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='issue' AND COALESCE(json_type(data,'$.resolved')='true',0)=0",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap()
}

async fn data_plane_issue(f: &Fixture, device: &str) {
    let mut conn = f.state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "issue",
        &json!({"id":db::hash(format!("data plane {device}")),"device_id":device,"code":"DATA_PLANE_NOT_DELIVERING","stage":"delivery","count":3,"first_seen":db::now(),"last_seen":db::now(),"resolved":false,"revision":1}),
    )
    .await
    .unwrap();
}

/// A turn of the setting through its route, as an administrator makes it.
async fn turn(f: &Fixture, enabled: bool) -> Value {
    let current = ok(f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    ok(
        f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":enabled,"current_password":PASSWORD,"revision":current["revision"]}),
        &f.admin,
    )
    .await
}

async fn target_age(f: &Fixture, rollout: &str, device: &str, minutes: i64) {
    sqlx::query("UPDATE agent_update_targets SET updated_at=? WHERE rollout_id=? AND device_id=?")
        .bind(instant(Utc::now() - Duration::minutes(minutes)))
        .bind(rollout)
        .bind(device)
        .execute(&f.state.pool)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Targets that wait for the host

#[tokio::test]
async fn a_target_that_downloads_or_has_the_build_staged_for_an_hour_is_skipped_with_the_agents_code()
 {
    let r = Rig::build(3).await;
    let rollout = all_canary(&r).await;
    let at = Utc::now();
    step(&r.f, at).await;
    let [downloading, staged, coded] = [&r.ids[0], &r.ids[1], &r.ids[2]];
    r.old(downloading, &r.about("downloading")).await;
    r.old(staged, &r.about("downloading")).await;
    r.old(staged, &r.about("staged")).await;
    r.old(coded, &r.about("downloading")).await;
    // The last thing this host said carried a code.
    store(
        &r.f,
        coded,
        &with(r.about("downloading"), json!({"code":"DISK_FULL"})),
    )
    .await;
    step(&r.f, at + Duration::minutes(59)).await;
    assert_eq!(r.state(&rollout, downloading).await, "downloading");
    assert_eq!(r.state(&rollout, staged).await, "staged");
    assert_eq!(r.state(&rollout, coded).await, "downloading");
    step(&r.f, at + Duration::minutes(61)).await;
    for device in [downloading, staged, coded] {
        assert_eq!(r.state(&rollout, device).await, "skipped");
    }
    assert_eq!(
        r.code(&rollout, downloading).await.as_deref(),
        Some("NO_REPORT"),
        "a host that said nothing more"
    );
    assert_eq!(r.code(&rollout, staged).await.as_deref(), Some("NO_REPORT"));
    assert_eq!(
        r.code(&rollout, coded).await.as_deref(),
        Some("DISK_FULL"),
        "the agent's last code"
    );
    // It is not a failure of the build: no issue opens, nothing counts.
    assert_eq!(issue_count(&r.f).await, 0);
    assert!(
        audits(&r.f, "device.agent_update").await.is_empty(),
        "a skipped target is not a result"
    );
    // Final: a late report moves none of them.
    r.old(downloading, &r.about("staged")).await;
    assert_eq!(r.state(&rollout, downloading).await, "skipped");
}

#[tokio::test]
async fn a_host_that_drops_the_offer_ends_its_target_skipped_with_what_it_reported() {
    let r = Rig::build(6).await;
    let rollout = all_canary(&r).await;
    step(&r.f, Utc::now()).await;
    let [paused, off, silent, other, offered, finished] = [
        &r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3], &r.ids[4], &r.ids[5],
    ];
    let ask = json!({"consent":"ask"});
    let closed = json!({"windows":["daily 02:00-04:00 UTC"],"window_open":false});
    r.old(paused, &r.about("downloading")).await;
    r.old(off, &r.about("staged")).await;
    r.old(silent, &with(r.about("waiting_for_host"), ask)).await;
    r.old(other, &with(r.about("waiting_for_window"), closed))
        .await;
    r.old(finished, &r.about("staged")).await;
    for (device, state) in [
        (paused, "downloading"),
        (off, "staged"),
        (silent, "waiting_for_host"),
        (other, "waiting_for_window"),
        (offered, "offered"),
        (finished, "staged"),
    ] {
        assert_eq!(r.state(&rollout, device).await, state);
    }

    // The host was paused: it reports idle with its code.
    r.old(
        paused,
        &with(r.idle(), json!({"paused":true,"code":"UPDATES_PAUSED"})),
    )
    .await;
    // The host turned updates off.
    r.old(
        off,
        &with(r.idle(), json!({"consent":"off","code":"UPDATES_OFF"})),
    )
    .await;
    // Idle with no code, and a report about another release.
    r.old(silent, &r.idle()).await;
    r.old(
        other,
        &with(
            r.idle(),
            json!({"state":"downloading","release":db::hash("another release")}),
        ),
    )
    .await;
    // An offer not yet taken is not dropped by an idle report: reports lag by
    // one check-in.
    r.old(
        offered,
        &with(r.idle(), json!({"paused":true,"code":"UPDATES_PAUSED"})),
    )
    .await;
    // A result of this release in a report that waits for nothing is the
    // step's to prove, not a dropped offer.
    r.old(
        finished,
        &with(
            r.idle(),
            json!({"last":{"release":r.release.manifest_sha256,"outcome":"committed","code":null,"at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
        ),
    )
    .await;

    for (device, code) in [
        (paused, Some("UPDATES_PAUSED")),
        (off, Some("UPDATES_OFF")),
        (silent, Some("NO_REPORT")),
        (other, Some("NO_REPORT")),
    ] {
        assert_eq!(r.state(&rollout, device).await, "skipped", "{device}");
        assert_eq!(r.code(&rollout, device).await.as_deref(), code, "{device}");
        assert!(
            r.old(device, &r.idle()).await.get("agent_update").is_none(),
            "a skipped target holds no offer"
        );
    }
    assert_eq!(r.state(&rollout, offered).await, "offered");
    assert_eq!(r.state(&rollout, finished).await, "staged");
    assert_eq!(
        issue_count(&r.f).await,
        0,
        "a dropped offer is nobody's failure"
    );
}

// ---------------------------------------------------------------------------
// Verified devices that will not come back

/// A rollout whose canary is the first `canary` devices, verified, with the rest
/// pending behind it.
async fn verified_canary(canary: usize, devices: usize, observation: i64) -> (Rig, String) {
    let r = Rig::build(devices).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":canary,"batch_size":1,"failure_threshold":0,"observation_seconds":observation}),
        )
        .await;
    step(&r.f, Utc::now()).await;
    let released: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(released.len(), canary);
    for device in &released {
        r.verify(&rollout, device).await;
    }
    (r, rollout)
}

async fn released(r: &Rig, rollout: &str) -> Vec<String> {
    r.states(rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "verified")
        .map(|(id, _)| id)
        .collect()
}

#[tokio::test]
async fn a_verified_device_that_is_revoked_or_gone_for_good_does_not_hold_the_observation() {
    let (r, rollout) = verified_canary(3, 4, 60).await;
    let verified = released(&r, &rollout).await;
    let (gone, revoked) = (&verified[0], &verified[1]);
    let at = Utc::now();
    step(&r.f, at).await;
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    // One never checks in again; another's access was revoked after it updated.
    seen(&r.f, gone, LONG_AGO).await;
    revoke(&r.f, revoked).await;
    step(&r.f, at + Duration::seconds(10)).await;
    // The observation watches the one device left, in full, and then the next
    // batch is released.
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    assert_eq!(r.count(&rollout, "pending").await, 1);
    step(&r.f, at + Duration::seconds(60)).await;
    assert_eq!(r.count(&rollout, "pending").await, 1, "not yet");
    step(&r.f, at + Duration::seconds(71)).await;
    assert_eq!(r.count(&rollout, "pending").await, 0);
    assert_eq!(r.count(&rollout, "offered").await, 1);
    assert_eq!(r.status(&rollout).await, "active");
}

#[tokio::test]
async fn a_device_that_is_late_but_not_gone_still_holds_the_observation() {
    // Gone is later than three intervals and than the observation's own length.
    let (r, rollout) = verified_canary(2, 3, 600).await;
    let verified = released(&r, &rollout).await;
    let late = &verified[0];
    let at = Utc::now();
    step(&r.f, at).await;
    seen(&r.f, late, &instant(Utc::now() - Duration::seconds(300))).await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(
        r.show(&rollout).await["observation_started_at"],
        Value::Null,
        "it may still return, so the observation waits for it"
    );
    step(&r.f, at + Duration::seconds(2000)).await;
    assert_eq!(r.count(&rollout, "pending").await, 1);
    // Once it has been silent for the observation's length it is gone.
    seen(&r.f, late, &instant(Utc::now() - Duration::seconds(700))).await;
    step(&r.f, at + Duration::seconds(2010)).await;
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    step(&r.f, at + Duration::seconds(2700)).await;
    assert_eq!(r.count(&rollout, "pending").await, 0);
}

#[tokio::test]
async fn the_canary_needs_a_verified_device_it_can_still_watch() {
    let (r, rollout) = verified_canary(1, 2, 60).await;
    let canary = released(&r, &rollout).await.remove(0);
    let at = Utc::now();
    step(&r.f, at).await;
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    seen(&r.f, &canary, LONG_AGO).await;
    for seconds in [10, 100, 5000] {
        step(&r.f, at + Duration::seconds(seconds)).await;
    }
    let shown = r.show(&rollout).await;
    assert_eq!(
        shown["observation_started_at"],
        Value::Null,
        "nothing the canary proved can be watched"
    );
    assert_eq!(r.count(&rollout, "pending").await, 1, "nothing is released");
    assert_eq!(r.status(&rollout).await, "active");
}

#[tokio::test]
async fn a_device_that_is_gone_or_revoked_does_not_count_as_degraded() {
    let (r, rollout) = verified_canary(2, 3, 60).await;
    let verified = released(&r, &rollout).await;
    let (gone, revoked) = (&verified[0], &verified[1]);
    for device in [gone, revoked] {
        data_plane_issue(&r.f, device).await;
    }
    assert_eq!(r.show(&rollout).await["degraded"], 2);
    seen(&r.f, gone, LONG_AGO).await;
    revoke(&r.f, revoked).await;
    assert_eq!(
        r.show(&rollout).await["degraded"],
        0,
        "a device nobody will hear from again is not a build's problem"
    );
    step(&r.f, Utc::now() + Duration::seconds(10)).await;
    assert_eq!(
        r.status(&rollout).await,
        "active",
        "with a failure threshold of none, they are not what fails it"
    );
    assert_eq!(r.count(&rollout, "rolled_back").await, 0);
}

// ---------------------------------------------------------------------------
// A release that expired

#[tokio::test]
async fn an_expired_release_ends_its_rollouts_as_cancelled_and_says_so_in_the_audit_log() {
    let r = Rig::build(3).await;
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
    let at = Utc::now();
    step(&r.f, at).await;
    let [applying, offered] = [&r.ids[0], &r.ids[1]];
    r.apply(&running, applying).await;
    assert_eq!(r.state(&running, offered).await, "offered");
    sqlx::query("UPDATE agent_releases SET expires_at=? WHERE id=?")
        .bind(instant(at + Duration::seconds(5)))
        .bind(&r.release.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    step(&r.f, at + Duration::seconds(3)).await;
    assert_eq!(r.status(&running).await, "active", "not yet expired");
    step(&r.f, at + Duration::seconds(10)).await;
    for rollout in [&running, &held] {
        let shown = r.show(rollout).await;
        assert_eq!(shown["status"], "cancelled");
        assert_eq!(shown["cancel_reason"], "release_expired");
        assert!(shown["cancelled_at"].is_string());
        assert_eq!(shown["failure_reason"], Value::Null);
    }
    // As a withdrawal does: what was not started is withdrawn, and a device that
    // is applying finishes.
    assert_eq!(r.state(&running, offered).await, "cancelled");
    assert_eq!(r.state(&running, applying).await, "applying");
    assert_eq!(r.state(&held, &r.ids[2]).await, "cancelled");
    assert!(
        r.old(offered, &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    r.new(applying, &r.about("trial")).await;
    r.new(applying, &r.result("committed", None)).await;
    assert_eq!(r.state(&running, applying).await, "verified");
    // One row for the release, written by the scheduler.
    let rows = audits(&r.f, "agent_release.expire").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["actor"], "scheduler");
    assert_eq!(rows[0]["target"], json!(r.release.id));
    assert_eq!(rows[0]["outcome"], "success");
    assert_eq!(rows[0]["details"]["release_id"], json!(r.release.id));
    assert_eq!(rows[0]["details"]["version"], "0.1.1");
    assert_eq!(rows[0]["details"]["cancelled_rollouts"], 2);
    // Nothing more to end: later steps write nothing.
    step(&r.f, at + Duration::seconds(20)).await;
    assert_eq!(audits(&r.f, "agent_release.expire").await.len(), 1);
}

// ---------------------------------------------------------------------------
// The safety net

#[tokio::test]
async fn a_rollout_that_cannot_go_on_for_a_day_fails_as_stalled() {
    let r = Rig::build(3).await;
    for id in &r.ids {
        seen(&r.f, id, LONG_AGO).await;
    }
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"failure_threshold":5}))
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    assert_eq!(
        r.count(&rollout, "offered").await,
        0,
        "none of them checks in, so nothing is released"
    );
    step(&r.f, at + Duration::hours(23)).await;
    assert_eq!(r.status(&rollout).await, "active");
    step(&r.f, at + Duration::hours(25)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["failure_reason"], "stalled");
    assert!(shown["failed_at"].is_string());
    assert_eq!(shown["state_counts"]["cancelled"], 3);
    assert_eq!(shown["state_counts"]["pending"], 0);
    let gate = audits(&r.f, "agent_update_rollout.gate").await;
    assert_eq!(gate.len(), 1);
    assert_eq!(gate[0]["outcome"], "failed");
    assert_eq!(gate[0]["details"]["gate_state"], "failed");
    assert_eq!(gate[0]["details"]["reason"], "stalled");
    assert_eq!(gate[0]["target"], json!(rollout));
    // A failed rollout is never resumed, and its devices are free again.
    refused(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/resume"),
        Value::Null,
        &r.f.operator,
        axum::http::StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
}

#[tokio::test]
async fn a_rollout_that_waits_only_for_its_hosts_is_never_stalled() {
    // The canary waits for a person: nothing is stuck, and the devices behind it
    // are queued, not stranded.
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":1,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let canary = r
        .states(&rollout)
        .await
        .into_iter()
        .find(|(_, state)| state == "offered")
        .unwrap()
        .0;
    r.old(
        &canary,
        &with(r.about("waiting_for_host"), json!({"consent":"ask"})),
    )
    .await;
    for hours in [25, 49, 200] {
        step(&r.f, at + Duration::hours(hours)).await;
        assert_eq!(r.status(&rollout).await, "active", "{hours} hours");
    }
    assert_eq!(r.state(&rollout, &canary).await, "waiting_for_host");

    // Later stages released, and one device waits for its window: the rollout
    // stays open for it, as it always has.
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":2,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let canary = r
        .states(&rollout)
        .await
        .into_iter()
        .find(|(_, state)| state == "offered")
        .unwrap()
        .0;
    r.verify(&rollout, &canary).await;
    step(&r.f, at + Duration::seconds(10)).await;
    step(&r.f, at + Duration::seconds(80)).await;
    let batch: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(batch.len(), 2);
    r.old(
        &batch[0],
        &with(
            r.about("waiting_for_window"),
            json!({"windows":["daily 02:00-04:00 UTC"],"window_open":false}),
        ),
    )
    .await;
    r.verify(&rollout, &batch[1]).await;
    for hours in [1, 30, 100] {
        step(&r.f, at + Duration::hours(hours)).await;
        assert_eq!(r.status(&rollout).await, "active", "{hours} hours");
    }
    assert_eq!(r.state(&rollout, &batch[0]).await, "waiting_for_window");
}

#[tokio::test]
async fn a_verified_device_that_stays_on_the_old_build_ends_the_rollout_stalled_after_a_day() {
    let (r, rollout) = verified_canary(1, 2, 60).await;
    let canary = released(&r, &rollout).await.remove(0);
    let at = Utc::now();
    step(&r.f, at + Duration::seconds(1)).await;
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    // It falls back to the old build and keeps checking in there.
    report(
        &r.f,
        &canary,
        "0.1.0",
        &Rig::old_sha(),
        "boot-fell-back",
        &r.idle(),
    )
    .await;
    step(&r.f, at + Duration::seconds(30)).await;
    assert_eq!(
        r.show(&rollout).await["observation_started_at"],
        Value::Null
    );
    step(&r.f, at + Duration::hours(23)).await;
    assert_eq!(r.status(&rollout).await, "active");
    step(&r.f, at + Duration::hours(25)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["failure_reason"], "stalled");
    assert_eq!(shown["state_counts"]["verified"], 1);
    assert_eq!(
        shown["state_counts"]["cancelled"], 1,
        "what was not started"
    );
}

#[tokio::test]
async fn a_canary_whose_only_verified_device_is_gone_ends_the_rollout_stalled() {
    let (r, rollout) = verified_canary(1, 2, 60).await;
    let canary = released(&r, &rollout).await.remove(0);
    seen(&r.f, &canary, LONG_AGO).await;
    let at = Utc::now();
    step(&r.f, at).await;
    step(&r.f, at + Duration::hours(23)).await;
    assert_eq!(r.status(&rollout).await, "active");
    step(&r.f, at + Duration::hours(25)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.show(&rollout).await["failure_reason"], "stalled");
}

#[tokio::test]
async fn any_change_of_a_target_is_progress_and_the_net_looks_once_an_hour() {
    let r = Rig::build(2).await;
    for id in &r.ids {
        seen(&r.f, id, LONG_AGO).await;
    }
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"failure_threshold":5}))
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    // A target changed an hour and a quarter after the rollout began.
    sqlx::query("UPDATE agent_update_targets SET updated_at=? WHERE rollout_id=?")
        .bind(instant(at + Duration::minutes(75)))
        .bind(&rollout)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    // At 25 hours the last progress is 23 hours 45 minutes old: not stalled. The
    // net has looked.
    step(&r.f, at + Duration::hours(25)).await;
    assert_eq!(r.status(&rollout).await, "active");
    // Half an hour later it would be stalled, but the net looks at most once an
    // hour for a rollout.
    step(&r.f, at + Duration::minutes(25 * 60 + 30)).await;
    assert_eq!(r.status(&rollout).await, "active");
    step(&r.f, at + Duration::minutes(26 * 60 + 5)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.show(&rollout).await["failure_reason"], "stalled");
}

// ---------------------------------------------------------------------------
// Updates turned off and on again

#[tokio::test]
async fn turning_updates_off_and_on_again_does_not_count_the_time_they_were_off_as_silence() {
    let r = Rig::build(2).await;
    let rollout = all_canary(&r).await;
    step(&r.f, Utc::now()).await;
    let [finished, quiet] = [&r.ids[0], &r.ids[1]];
    r.apply(&rollout, finished).await;
    r.apply(&rollout, quiet).await;
    // The documented order: Stop all updates, then turn updates off.
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A bad build"}),
        &r.f.operator,
    )
    .await;
    assert_eq!(r.state(&rollout, finished).await, "applying");
    turn(&r.f, false).await;
    // The trial commits while updates are off: nothing is heard of it.
    r.new(finished, &r.about("trial")).await;
    r.new(finished, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, finished).await, "applying");
    // Half an hour and more passes before they are turned on again.
    for device in [finished, quiet] {
        target_age(&r.f, &rollout, device, 31).await;
    }
    turn(&r.f, true).await;
    let age: String = sqlx::query_scalar(
        "SELECT updated_at FROM agent_update_targets WHERE rollout_id=? AND device_id=?",
    )
    .bind(&rollout)
    .bind(finished)
    .fetch_one(&r.f.state.pool)
    .await
    .unwrap();
    assert!(
        age > instant(Utc::now() - Duration::minutes(1)),
        "the silence starts again when updates are turned on: {age}"
    );
    step(&r.f, Utc::now()).await;
    assert_eq!(
        r.state(&rollout, finished).await,
        "applying",
        "the device that committed meanwhile is not failed for its silence"
    );
    assert_eq!(issue_count(&r.f).await, 0);
    // Its next check-in tells the server what happened.
    r.new(finished, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, finished).await, "verified");
    // The silence still ends a device that says nothing after that.
    step(&r.f, Utc::now() + Duration::minutes(31)).await;
    assert_eq!(r.state(&rollout, quiet).await, "failed");
    assert_eq!(r.code(&rollout, quiet).await.as_deref(), Some("NO_REPORT"));
}
