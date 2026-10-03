//! What moves an update rollout: the check-ins of the devices and the scheduler
//! step. A device counts as updated only from the server's own observation of
//! the new build, a report moves a target only forward and only for the
//! rollout's own release, and silence ends what waited for it.
use super::support::*;
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use vectory_server::db;

const OLD_BOOT: &str = "boot-old";
const NEW_BOOT: &str = "boot-new";

/// A server with updates on, a release of 0.1.1 and devices that run 0.1.0.
pub(super) struct Rig {
    pub(super) f: Fixture,
    pub(super) team: String,
    pub(super) release: Release,
    pub(super) ids: Vec<String>,
}
impl Rig {
    pub(super) async fn build(devices: usize) -> Rig {
        Rig::build_with(devices, |_| {}).await
    }
    /// ... on a server with settings of its own.
    pub(super) async fn build_with(
        devices: usize,
        tune: impl FnOnce(&mut vectory_server::Settings),
    ) -> Rig {
        let f = fixture_on_with(tune).await;
        let team = fingerprint("team");
        let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
        let mut ids = Vec::new();
        for n in 0..devices {
            let id = device(&f, &format!("edge-{n:02}"), "0.1.0").await;
            store(&f, &id, &member(&[&team])).await;
            ids.push(id);
        }
        ids.sort();
        Rig {
            f,
            team,
            release,
            ids,
        }
    }
    pub(super) fn old_sha() -> String {
        db::hash("running 0.1.0 linux amd64")
    }
    pub(super) fn new_sha(&self) -> String {
        self.release.sha256("linux", "amd64")
    }
    pub(super) fn idle(&self) -> Value {
        member(&[&self.team])
    }
    /// A report about this release in `state`.
    pub(super) fn about(&self, state: &str) -> Value {
        with(
            self.idle(),
            json!({"state":state,"release":self.release.manifest_sha256}),
        )
    }
    /// The result of the privileged step for this release.
    pub(super) fn result(&self, outcome: &str, code: Option<&str>) -> Value {
        with(
            self.idle(),
            json!({"last":{
                "release":self.release.manifest_sha256,"outcome":outcome,"code":code,
                "at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1","first_check_in_ms":1200
            }}),
        )
    }
    /// A check-in of the build the device has been running, in its own process.
    pub(super) async fn old(&self, device: &str, report: &Value) -> Value {
        report_in(&self.f, device, "0.1.0", &Self::old_sha(), OLD_BOOT, report).await
    }
    /// A check-in of the new build, in a process of its own.
    pub(super) async fn new(&self, device: &str, report: &Value) -> Value {
        report_in(&self.f, device, "0.1.1", &self.new_sha(), NEW_BOOT, report).await
    }
    pub(super) async fn start(&self, devices: &[&String], rollout: Value) -> String {
        start(&self.f, &self.release.id, devices, rollout).await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    pub(super) async fn state(&self, rollout: &str, device: &str) -> String {
        target(&self.f, rollout, device).await.0
    }
    pub(super) async fn code(&self, rollout: &str, device: &str) -> Option<String> {
        target(&self.f, rollout, device).await.1
    }
    pub(super) async fn states(&self, rollout: &str) -> Vec<(String, String)> {
        sqlx::query_as("SELECT device_id,state FROM agent_update_targets WHERE rollout_id=? ORDER BY device_id")
            .bind(rollout)
            .fetch_all(&self.f.state.pool)
            .await
            .unwrap()
    }
    pub(super) async fn count(&self, rollout: &str, state: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM agent_update_targets WHERE rollout_id=? AND state=?",
        )
        .bind(rollout)
        .bind(state)
        .fetch_one(&self.f.state.pool)
        .await
        .unwrap()
    }
    /// The rollout as the API shows it.
    pub(super) async fn show(&self, rollout: &str) -> Value {
        ok(
            &self.f,
            "GET",
            &format!("/api/v1/agent-update-rollouts/{rollout}"),
            Value::Null,
            &self.f.viewer,
        )
        .await
    }
    pub(super) async fn status(&self, rollout: &str) -> String {
        status(&self.f, rollout).await
    }
    /// A device the rollout released: it takes the offer through every state a
    /// device reports until it is `applying`.
    pub(super) async fn apply(&self, rollout: &str, device: &str) {
        self.old(device, &self.about("downloading")).await;
        self.old(device, &self.about("staged")).await;
        self.old(device, &self.about("applying")).await;
        assert_eq!(self.state(rollout, device).await, "applying");
    }
    /// A device that is verified and runs the new build, without the check-ins
    /// that would get it there: for what a check-in would disturb.
    pub(super) async fn force_verified(&self, rollout: &str, device: &str) {
        sqlx::query("UPDATE agent_update_targets SET state='verified',verified_at=? WHERE rollout_id=? AND device_id=?")
            .bind(db::now())
            .bind(rollout)
            .bind(device)
            .execute(&self.f.state.pool)
            .await
            .unwrap();
        sqlx::query("UPDATE devices SET data=json_set(data,'$.agent_sha256',?,'$.agent_version','0.1.1','$.last_seen',?) WHERE id=?")
            .bind(self.new_sha())
            .bind(db::now())
            .bind(device)
            .execute(&self.f.state.pool)
            .await
            .unwrap();
    }
    /// ... and on to `verified`.
    pub(super) async fn verify(&self, rollout: &str, device: &str) {
        self.apply(rollout, device).await;
        self.new(device, &self.about("trial")).await;
        assert_eq!(self.state(rollout, device).await, "restarted");
        self.new(device, &self.result("committed", None)).await;
        assert_eq!(self.state(rollout, device).await, "verified");
    }
}

async fn report_in(
    f: &Fixture,
    device: &str,
    version: &str,
    sha: &str,
    boot: &str,
    member: &Value,
) -> Value {
    report(f, device, version, sha, boot, member).await
}
fn soon(seconds: i64) -> DateTime<Utc> {
    Utc::now() + Duration::seconds(seconds)
}

#[tokio::test]
async fn the_first_step_releases_the_canary_and_its_offer_arrives_in_the_next_manifest() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":2,"observation_seconds":60}),
        )
        .await;
    // Created: every device pending, and no offer before the step.
    assert_eq!(r.count(&rollout, "pending").await, 3);
    for id in &r.ids {
        let manifest = r.old(id, &r.idle()).await;
        assert!(
            manifest.get("agent_update").is_none(),
            "nothing is offered before a release"
        );
    }
    step(&r.f, soon(0)).await;
    // The canary is released: one device, offered, in stage 0.
    let states = r.states(&rollout).await;
    let released: Vec<&(String, String)> = states
        .iter()
        .filter(|(_, state)| state == "offered")
        .collect();
    assert_eq!(released.len(), 1, "{states:?}");
    assert_eq!(r.count(&rollout, "pending").await, 2);
    let canary = &released[0].0;
    let stage: Option<i64> = sqlx::query_scalar(
        "SELECT stage FROM agent_update_targets WHERE rollout_id=? AND device_id=?",
    )
    .bind(&rollout)
    .bind(canary)
    .fetch_one(&r.f.state.pool)
    .await
    .unwrap();
    assert_eq!(stage, Some(0));
    // One audit row for the release, with the devices.
    let rows = audits(&r.f, "agent_update_rollout.release").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], json!(rollout));
    assert_eq!(rows[0]["details"]["stage"], "0");
    assert_eq!(rows[0]["details"]["device_ids"], json!([canary]));
    assert_eq!(rows[0]["details"]["released_count"], 1);
    // The offer is in the manifest of its next check-in and in no one else's.
    let manifest = r.old(canary, &r.idle()).await;
    let offer = &manifest["agent_update"];
    assert_eq!(offer["rollout_id"], json!(rollout));
    assert_eq!(offer["release_id"], json!(r.release.id));
    assert_eq!(offer["manifest"], STANDARD.encode(&r.release.manifest));
    assert_eq!(offer["signatures"], STANDARD.encode(&r.release.signature));
    assert_eq!(offer["rollovers"], json!([]));
    assert_eq!(offer["artifact"]["sha256"], r.new_sha());
    assert_eq!(offer["artifact"]["size"], 1000);
    assert_eq!(
        offer["artifact"]["path"],
        format!("/agent/v1/agent-releases/{}", r.new_sha())
    );
    assert_eq!(offer.as_object().unwrap().len(), 6);
    for id in r.ids.iter().filter(|id| *id != canary) {
        let manifest = r.old(id, &r.idle()).await;
        assert!(
            manifest.get("agent_update").is_none(),
            "only released devices are offered"
        );
    }
    // The manifest keeps what it carried: the offer is a member beside them.
    assert!(
        manifest["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "agent_update")
    );
    assert!(manifest.get("desired").is_some());
}

#[tokio::test]
async fn an_offer_needs_a_report_that_pins_a_key_that_reaches_the_signer() {
    let f = fixture().await;
    let old = key(&f, "old", "server", "retired").await;
    let signer = key(&f, "team", "server", "current").await;
    introduce(&f, "team", "old").await;
    switch(&f, true).await;
    let release = release(&f, "0.1.1", 7, &signer, &[("linux", "amd64")]).await;
    let behind = device(&f, "behind", "0.1.0").await;
    let current = device(&f, "current", "0.1.0").await;
    store(&f, &behind, &member(&[&old])).await;
    store(&f, &current, &member(&[&signer])).await;
    let rollout = start(
        &f,
        &release.id,
        &[&behind, &current],
        json!({"canary_size":2}),
    )
    .await;
    step(&f, soon(0)).await;
    let id = rollout["id"].as_str().unwrap();
    assert_eq!(target(&f, id, &behind).await.0, "offered");
    // A device a key behind is sent the statement that leads to the signer.
    let manifest = report(
        &f,
        &behind,
        "0.1.0",
        &Rig::old_sha(),
        OLD_BOOT,
        &member(&[&old]),
    )
    .await;
    let rollovers = manifest["agent_update"]["rollovers"].as_array().unwrap();
    assert_eq!(rollovers.len(), 1);
    assert_eq!(
        rollovers[0]["statement"],
        STANDARD.encode("statement old to team")
    );
    assert_eq!(
        rollovers[0]["signature"],
        STANDARD.encode("signature of old over team")
    );
    let manifest = report(
        &f,
        &current,
        "0.1.0",
        &Rig::old_sha(),
        OLD_BOOT,
        &member(&[&signer]),
    )
    .await;
    assert_eq!(manifest["agent_update"]["rollovers"], json!([]));
    // A device that stops reporting is offered nothing: its report is its
    // pins, and the server infers none.
    let (status, manifest) = beat(&f, &current, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(manifest.get("agent_update").is_none());
    // And one that pins a key the signer does not follow is offered nothing.
    let manifest = report(
        &f,
        &current,
        "0.1.0",
        &Rig::old_sha(),
        OLD_BOOT,
        &member(&[&fingerprint("stranger")]),
    )
    .await;
    assert!(manifest.get("agent_update").is_none());
}

#[tokio::test]
async fn the_offer_goes_away_with_a_paused_rollout_a_stop_a_revoked_key_a_withdrawn_or_expired_release()
 {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({})).await;
    step(&r.f, soon(0)).await;
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_some()
    );
    // Paused.
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/pause"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/resume"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    step(&r.f, soon(0)).await;
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_some()
    );
    // A revoked key stops offering what it signed.
    sqlx::query("UPDATE agent_release_keys SET state='revoked' WHERE fingerprint=?")
        .bind(&r.team)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    sqlx::query("UPDATE agent_release_keys SET state='current' WHERE fingerprint=?")
        .bind(&r.team)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_some()
    );
    // An expired release is not offered.
    sqlx::query("UPDATE agent_releases SET expires_at='2020-01-01T00:00:00Z' WHERE id=?")
        .bind(&r.release.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    sqlx::query("UPDATE agent_releases SET expires_at='2099-01-01T00:00:00Z' WHERE id=?")
        .bind(&r.release.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_some()
    );
    // Stop all updates, and updates turned off.
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"hold"}),
        &r.f.operator,
    )
    .await;
    assert!(
        r.old(&device, &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    let manifest = r.old(&device, &r.idle()).await;
    assert!(
        manifest["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "agent_update"),
        "a stopped server still lists the feature, so agents keep reporting"
    );
    switch(&r.f, false).await;
    let manifest = r.old(&device, &r.idle()).await;
    assert!(
        !manifest["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "agent_update")
    );
}

#[tokio::test]
async fn a_device_goes_forward_through_its_states_to_verified_only_by_the_servers_observation() {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({"observation_seconds":60})).await;
    assert_eq!(r.state(&rollout, &device).await, "pending");
    // A report for a rollout that has not released it changes nothing.
    r.old(&device, &r.about("staged")).await;
    assert_eq!(r.state(&rollout, &device).await, "pending");
    step(&r.f, soon(0)).await;
    assert_eq!(r.state(&rollout, &device).await, "offered");
    r.old(&device, &r.idle()).await;
    assert_eq!(
        r.state(&rollout, &device).await,
        "offered",
        "an idle report is not progress"
    );
    r.old(&device, &r.about("downloading")).await;
    assert_eq!(r.state(&rollout, &device).await, "downloading");
    r.old(&device, &r.about("staged")).await;
    assert_eq!(r.state(&rollout, &device).await, "staged");
    // A staged file is not an update, and neither is a swap: it is the new
    // build checking in, in a process of its own.
    r.old(&device, &r.about("waiting_for_window")).await;
    assert_eq!(r.state(&rollout, &device).await, "waiting_for_window");
    r.old(&device, &r.about("applying")).await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
    // An earlier row never replaces a later one.
    r.old(&device, &r.about("downloading")).await;
    r.old(&device, &r.about("staged")).await;
    r.old(&device, &r.about("waiting_for_host")).await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
    // The new build's digest and version, in the process the old build ran in:
    // not a restart.
    report(
        &r.f,
        &device,
        "0.1.1",
        &r.new_sha(),
        OLD_BOOT,
        &r.about("trial"),
    )
    .await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
    // The new version with another build's digest: not the offered file.
    report(
        &r.f,
        &device,
        "0.1.1",
        &db::hash("some other file"),
        "boot-decoy-a",
        &r.about("trial"),
    )
    .await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
    // The offered file under another version.
    report(
        &r.f,
        &device,
        "0.1.2",
        &r.new_sha(),
        "boot-decoy-b",
        &r.about("trial"),
    )
    .await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
    // The new build, in a new process.
    r.new(&device, &r.about("trial")).await;
    assert_eq!(r.state(&rollout, &device).await, "restarted");
    // Checking in is not enough; the step's report that the build passed is.
    r.new(&device, &r.idle()).await;
    assert_eq!(r.state(&rollout, &device).await, "restarted");
    // A result about another release is not this one's.
    let other = with(
        r.idle(),
        json!({"last":{"release":db::hash("another release"),"outcome":"committed","code":null,"at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
    );
    r.new(&device, &other).await;
    assert_eq!(r.state(&rollout, &device).await, "restarted");
    r.new(&device, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &device).await, "verified");
    let (from, verified_at): (Option<String>, Option<String>) = sqlx::query_as("SELECT from_version,verified_at FROM agent_update_targets WHERE rollout_id=? AND device_id=?")
        .bind(&rollout)
        .bind(&device)
        .fetch_one(&r.f.state.pool)
        .await
        .unwrap();
    assert_eq!(from.as_deref(), Some("0.1.0"), "the version it ran before");
    assert!(verified_at.is_some());
    // Final: nothing moves it again, and a report that moves nothing adds no
    // audit row.
    r.old(&device, &r.about("downloading")).await;
    assert_eq!(r.state(&rollout, &device).await, "verified");
    // One audit row for the device, with what it was told.
    let rows = audits(&r.f, "device.agent_update").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["outcome"], "verified");
    assert_eq!(rows[0]["target"], json!(device));
    assert_eq!(rows[0]["details"]["rollout_id"], json!(rollout));
    assert_eq!(rows[0]["details"]["from_version"], "0.1.0");
    assert_eq!(rows[0]["details"]["to_version"], "0.1.1");
    // A rollback it reports afterwards is a result the server records, once,
    // and the target stays verified.
    r.new(&device, &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    assert_eq!(r.state(&rollout, &device).await, "verified");
    let rows = audits(&r.f, "device.agent_update").await;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1]["outcome"], "rolled_back");
    assert_eq!(rows[1]["details"]["code"], "UNHEALTHY");
    assert_eq!(rows[1]["details"]["rollout_id"], json!(rollout));
}

#[tokio::test]
async fn the_new_build_can_report_committed_in_its_first_check_in() {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({})).await;
    step(&r.f, soon(0)).await;
    r.old(&device, &r.about("applying")).await;
    // The restart and the result in one check-in: the new build is verified.
    r.new(&device, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &device).await, "verified");
}

#[tokio::test]
async fn a_committed_result_from_the_build_that_was_already_running_proves_nothing() {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({})).await;
    step(&r.f, soon(0)).await;
    r.old(&device, &r.about("applying")).await;
    // A result of this release in a check-in of the old build: nobody saw the
    // new one run.
    r.old(&device, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &device).await, "applying");
}

#[tokio::test]
async fn a_report_for_another_release_changes_nothing() {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({})).await;
    step(&r.f, soon(0)).await;
    let other = db::hash("another release");
    for state in [
        "downloading",
        "staged",
        "applying",
        "waiting_for_host",
        "failed",
        "refused",
    ] {
        let about = with(
            r.idle(),
            json!({"state":state,"release":other,"code":"DISK_FULL"}),
        );
        r.old(&device, &about).await;
        assert_eq!(r.state(&rollout, &device).await, "offered", "{state}");
    }
    for outcome in ["rolled_back", "failed", "refused", "committed"] {
        let code = (outcome != "committed").then_some("UNHEALTHY");
        let about = with(
            r.idle(),
            json!({"last":{"release":other,"outcome":outcome,"code":code,"at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
        );
        r.old(&device, &about).await;
        assert_eq!(r.state(&rollout, &device).await, "offered", "{outcome}");
    }
    // A device that is in no rollout is not moved by anything.
    let stranger = device_in(&r.f, "stranger").await;
    r.old(&stranger, &r.about("staged")).await;
    r.old(&stranger, &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_update_targets WHERE device_id=?")
        .bind(&stranger)
        .fetch_one(&r.f.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}
async fn device_in(f: &Fixture, name: &str) -> String {
    let id = device(f, name, "0.1.0").await;
    store(f, &id, &member(&[&fingerprint("team")])).await;
    id
}

#[tokio::test]
async fn a_rollback_a_failure_and_a_refusal_end_a_target_with_the_agents_code() {
    let r = Rig::build(4).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // A threshold that tolerates what happens here, so the rollout goes on.
    let rollout = r.start(&refs, json!({"canary_size":4,"batch_size":10,"failure_threshold":100,"observation_seconds":60})).await;
    step(&r.f, soon(0)).await;
    assert_eq!(r.count(&rollout, "offered").await, 4);
    let [a, b, c, d] = [&r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3]];
    // Rolled back: the new build did not stay healthy; the old one reports it.
    r.apply(&rollout, a).await;
    r.old(a, &r.result("rolled_back", Some("UNHEALTHY"))).await;
    assert_eq!(r.state(&rollout, a).await, "rolled_back");
    assert_eq!(r.code(&rollout, a).await.as_deref(), Some("UNHEALTHY"));
    // Rolled back after the new build checked in once.
    r.apply(&rollout, b).await;
    r.new(b, &r.about("trial")).await;
    assert_eq!(r.state(&rollout, b).await, "restarted");
    r.old(b, &r.result("rolled_back", Some("NO_CHECK_IN")))
        .await;
    assert_eq!(r.state(&rollout, b).await, "rolled_back");
    assert_eq!(r.code(&rollout, b).await.as_deref(), Some("NO_CHECK_IN"));
    // Failed: the staged build did not probe.
    r.old(c, &r.about("staged")).await;
    r.old(
        c,
        &with(
            r.idle(),
            json!({"state":"failed","release":r.release.manifest_sha256,"code":"PROBE_FAILED"}),
        ),
    )
    .await;
    assert_eq!(r.state(&rollout, c).await, "failed");
    assert_eq!(r.code(&rollout, c).await.as_deref(), Some("PROBE_FAILED"));
    // Refused by the host's own policy.
    r.old(d, &with(r.idle(), json!({"state":"refused","release":r.release.manifest_sha256,"code":"COUNTER_REPLAYED"}))).await;
    assert_eq!(r.state(&rollout, d).await, "refused");
    assert_eq!(
        r.code(&rollout, d).await.as_deref(),
        Some("COUNTER_REPLAYED")
    );
    // Final: a later report moves none of them.
    for device in [a, b, c, d] {
        r.old(device, &r.about("staged")).await;
        r.new(device, &r.result("committed", None)).await;
    }
    assert_eq!(r.count(&rollout, "verified").await, 0);
    // Each of the four left an audit row; a rollback and a failure each opened
    // an issue, a refusal did not.
    let rows = audits(&r.f, "device.agent_update").await;
    let mut outcomes: Vec<String> = rows
        .iter()
        .map(|row| row["outcome"].as_str().unwrap().to_owned())
        .collect();
    outcomes.sort();
    assert_eq!(
        outcomes,
        ["failed", "refused", "rolled_back", "rolled_back"]
    );
    let rolled = rows.iter().find(|row| row["target"] == json!(a)).unwrap();
    assert_eq!(rolled["details"]["code"], "UNHEALTHY");
    let issues = open_issues(&r.f).await;
    assert_eq!(issues.len(), 3, "{issues:?}");
    let codes: Vec<&str> = issues
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes
            .iter()
            .filter(|code| **code == "AGENT_UPDATE_ROLLED_BACK")
            .count(),
        2
    );
    assert_eq!(
        codes
            .iter()
            .filter(|code| **code == "AGENT_UPDATE_FAILED")
            .count(),
        1
    );
    // The detail groups them by what the agent said.
    let shown = r.show(&rollout).await;
    let failures = shown["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 4);
    let group = |code: &str| {
        failures
            .iter()
            .find(|group| group["code"] == code)
            .unwrap()
            .clone()
    };
    assert_eq!(group("UNHEALTHY")["state"], "rolled_back");
    assert_eq!(group("UNHEALTHY")["count"], 1);
    assert_eq!(group("UNHEALTHY")["device_ids"], json!([a]));
    assert!(
        group("UNHEALTHY")["message"]
            .as_str()
            .unwrap()
            .contains("health check")
    );
    assert_eq!(group("PROBE_FAILED")["state"], "failed");
    assert_eq!(group("COUNTER_REPLAYED")["state"], "refused");
}
async fn open_issues(f: &Fixture) -> Vec<Value> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND COALESCE(json_type(data,'$.resolved')='true',0)=0 ORDER BY created_at,id")
        .fetch_all(&f.state.pool)
        .await
        .unwrap();
    rows.iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}

#[tokio::test]
async fn a_rolled_back_update_opens_an_issue_a_later_verified_update_resolves() {
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({"failure_threshold":5})).await;
    step(&r.f, soon(0)).await;
    r.apply(&rollout, &device).await;
    r.old(&device, &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    let issues = open_issues(&r.f).await;
    assert_eq!(issues.len(), 1);
    let issue = &issues[0];
    assert_eq!(issue["code"], "AGENT_UPDATE_ROLLED_BACK");
    assert_eq!(issue["stage"], "agent_update");
    assert_eq!(issue["device_id"], json!(device));
    assert_eq!(issue["count"], 1);
    // The issue as the API renders it.
    let listed = ok(&r.f, "GET", "/api/v1/issues", Value::Null, &r.f.viewer).await;
    let rows = listed["items"]
        .as_array()
        .or(listed.as_array())
        .expect("issues");
    let row = rows
        .iter()
        .find(|row| row["code"] == "AGENT_UPDATE_ROLLED_BACK")
        .expect("the issue is listed");
    assert_eq!(row["title"], "edge-00 rolled back agent 0.1.1");
    assert!(row["message"].as_str().unwrap().contains("health check"));
    for member in [
        "version_id",
        "version_number",
        "configuration_id",
        "configuration_name",
        "deployment_id",
    ] {
        assert_eq!(row[member], Value::Null, "{member}");
    }
    // Verifying a pipeline, or anything else about the device, does not end it;
    // the device verifying a later update does.
    let next = release_with(
        &r.f,
        "0.1.2",
        8,
        &r.team,
        &[("linux", "amd64")],
        "ready",
        180,
    )
    .await;
    let again = start(&r.f, &next.id, &[&device], json!({})).await;
    let again = again["id"].as_str().unwrap().to_owned();
    step(&r.f, soon(0)).await;
    assert_eq!(r.state(&again, &device).await, "offered");
    assert_eq!(open_issues(&r.f).await.len(), 1);
    let sha = next.sha256("linux", "amd64");
    let about = |state: &str| {
        with(
            r.idle(),
            json!({"state":state,"release":next.manifest_sha256}),
        )
    };
    report(
        &r.f,
        &device,
        "0.1.0",
        &Rig::old_sha(),
        OLD_BOOT,
        &about("applying"),
    )
    .await;
    let committed = with(
        r.idle(),
        json!({"last":{"release":next.manifest_sha256,"outcome":"committed","code":null,"at":"2026-10-06T02:09:41Z","from_version":"0.1.0","to_version":"0.1.2"}}),
    );
    report(&r.f, &device, "0.1.2", &sha, NEW_BOOT, &committed).await;
    assert_eq!(r.state(&again, &device).await, "verified");
    assert!(
        open_issues(&r.f).await.is_empty(),
        "verifying a later update resolves it"
    );
}

#[tokio::test]
async fn the_canary_must_verify_then_the_observation_runs_and_the_next_batch_is_released() {
    let r = Rig::build(5).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":2,"observation_seconds":60}),
        )
        .await;
    let started = Utc::now();
    step(&r.f, started).await;
    let canary = r
        .states(&rollout)
        .await
        .into_iter()
        .find(|(_, state)| state == "offered")
        .unwrap()
        .0;
    // While the canary applies nothing more is released, however long it takes.
    r.apply(&rollout, &canary).await;
    step(&r.f, started + Duration::seconds(10)).await;
    step(&r.f, started + Duration::seconds(600)).await;
    assert_eq!(r.count(&rollout, "pending").await, 4);
    // Verified: the observation starts at the next step, and runs its seconds.
    r.new(&canary, &r.about("trial")).await;
    r.new(&canary, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &canary).await, "verified");
    let at = started + Duration::seconds(700);
    step(&r.f, at).await;
    let shown = r.show(&rollout).await;
    assert!(
        shown["observation_started_at"].is_string(),
        "the observation started"
    );
    assert_eq!(r.count(&rollout, "pending").await, 4);
    step(&r.f, at + Duration::seconds(59)).await;
    assert_eq!(
        r.count(&rollout, "pending").await,
        4,
        "not before its seconds are over"
    );
    step(&r.f, at + Duration::seconds(61)).await;
    // The first batch: two devices, in the order of their IDs.
    assert_eq!(r.count(&rollout, "pending").await, 2);
    assert_eq!(r.count(&rollout, "offered").await, 2);
    let batch: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    let mut want: Vec<String> = r.ids.iter().filter(|id| **id != canary).cloned().collect();
    want.truncate(2);
    assert_eq!(batch, want);
    let stages: Vec<Option<i64>> = sqlx::query_scalar("SELECT stage FROM agent_update_targets WHERE rollout_id=? AND state='offered' ORDER BY device_id").bind(&rollout).fetch_all(&r.f.state.pool).await.unwrap();
    assert_eq!(stages, [Some(1), Some(1)]);
    assert_eq!(audits(&r.f, "agent_update_rollout.release").await.len(), 2);
    // The batch applies and verifies; its observation runs; the last device is
    // released as the last batch; then the rollout completes.
    for device in &batch {
        r.verify(&rollout, device).await;
    }
    let at = at + Duration::seconds(100);
    step(&r.f, at).await;
    step(&r.f, at + Duration::seconds(61)).await;
    assert_eq!(r.count(&rollout, "pending").await, 0);
    let last: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(last.len(), 2, "the last batch");
    assert_eq!(r.status(&rollout).await, "active");
    for device in &last {
        r.verify(&rollout, device).await;
    }
    let at = at + Duration::seconds(200);
    step(&r.f, at).await;
    assert_eq!(
        r.status(&rollout).await,
        "active",
        "the last observation has to pass"
    );
    step(&r.f, at + Duration::seconds(61)).await;
    assert_eq!(r.status(&rollout).await, "completed");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["state_counts"]["verified"], 5);
    assert!(shown["completed_at"].is_string());
    assert_eq!(shown["observation_started_at"], Value::Null);
    // The gate says so in the audit trail, with the count of devices.
    let gate = audits(&r.f, "agent_update_rollout.gate").await;
    assert_eq!(gate.len(), 1);
    assert_eq!(gate[0]["outcome"], "completed");
    assert_eq!(gate[0]["details"]["gate_state"], "completed");
    assert_eq!(gate[0]["details"]["verified_count"], 5);
    // A finished rollout offers nothing and cannot be paused, resumed or cancelled.
    for action in ["pause", "resume", "cancel"] {
        refused(
            &r.f,
            "POST",
            &format!("/api/v1/agent-update-rollouts/{rollout}/{action}"),
            Value::Null,
            &r.f.operator,
            StatusCode::CONFLICT,
            "CONFLICT",
        )
        .await;
    }
}

#[tokio::test]
async fn a_verified_device_that_falls_back_or_goes_silent_restarts_the_observation() {
    let r = Rig::build(2).await;
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
    r.verify(&rollout, &canary).await;
    step(&r.f, at + Duration::seconds(1)).await;
    let first = r.show(&rollout).await["observation_started_at"].clone();
    assert!(first.is_string());
    // It goes silent: no check-in within three intervals.
    seen(&r.f, &canary, "2020-01-01T00:00:00Z").await;
    step(&r.f, at + Duration::seconds(30)).await;
    assert_eq!(
        r.show(&rollout).await["observation_started_at"],
        Value::Null,
        "the observation restarts"
    );
    step(&r.f, at + Duration::seconds(200)).await;
    assert_eq!(
        r.count(&rollout, "pending").await,
        1,
        "nothing is released while it is silent"
    );
    // It checks in again: a new observation, which has to run in full.
    r.new(&canary, &r.idle()).await;
    let back = at + Duration::seconds(300);
    step(&r.f, back).await;
    assert!(r.show(&rollout).await["observation_started_at"].is_string());
    step(&r.f, back + Duration::seconds(30)).await;
    assert_eq!(r.count(&rollout, "pending").await, 1);
    // It falls back to the old build: the observation restarts again.
    report(
        &r.f,
        &canary,
        "0.1.0",
        &Rig::old_sha(),
        "boot-fell-back",
        &r.idle(),
    )
    .await;
    step(&r.f, back + Duration::seconds(40)).await;
    assert_eq!(
        r.show(&rollout).await["observation_started_at"],
        Value::Null
    );
    assert_eq!(r.count(&rollout, "pending").await, 1);
    // On the new build again: observed in full, then the batch is released.
    r.new(&canary, &r.idle()).await;
    let again = back + Duration::seconds(100);
    step(&r.f, again).await;
    step(&r.f, again + Duration::seconds(59)).await;
    assert_eq!(r.count(&rollout, "pending").await, 1);
    step(&r.f, again + Duration::seconds(61)).await;
    assert_eq!(r.count(&rollout, "pending").await, 0);
}

#[tokio::test]
async fn failures_above_the_threshold_fail_the_rollout_and_withdraw_what_was_not_started() {
    let r = Rig::build(5).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // Two devices in the canary stage, a threshold of one.
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":2,"batch_size":2,"failure_threshold":1,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let canary: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(canary.len(), 2);
    // One rollback is within the threshold.
    r.apply(&rollout, &canary[0]).await;
    r.old(&canary[0], &r.result("rolled_back", Some("START_FAILED")))
        .await;
    step(&r.f, at + Duration::seconds(5)).await;
    assert_eq!(r.status(&rollout).await, "active");
    // The second is over it: the rollout fails, what had not started is
    // withdrawn, and the device already applying finishes.
    r.apply(&rollout, &canary[1]).await;
    r.new(&canary[1], &r.about("trial")).await;
    r.old(&canary[1], &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["failure_reason"], "threshold");
    assert!(shown["failed_at"].is_string());
    assert_eq!(shown["state_counts"]["rolled_back"], 2);
    assert_eq!(shown["state_counts"]["cancelled"], 3);
    assert_eq!(shown["state_counts"]["pending"], 0);
    let gate = audits(&r.f, "agent_update_rollout.gate").await;
    assert_eq!(gate.len(), 1);
    assert_eq!(gate[0]["outcome"], "failed");
    assert_eq!(gate[0]["details"]["gate_state"], "failed");
    // The stage that failed says so, and the rest were stopped.
    let stages = shown["stages"].as_array().unwrap();
    assert_eq!(stages[0]["kind"], "canary");
    assert_eq!(stages[0]["state"], "failed");
    assert!(
        stages
            .iter()
            .skip(1)
            .all(|stage| stage["state"] == "stopped"),
        "{stages:?}"
    );
    // A failed rollout is never resumed.
    for action in ["pause", "resume", "cancel"] {
        refused(
            &r.f,
            "POST",
            &format!("/api/v1/agent-update-rollouts/{rollout}/{action}"),
            Value::Null,
            &r.f.operator,
            StatusCode::CONFLICT,
            "CONFLICT",
        )
        .await;
    }
}

#[tokio::test]
async fn refused_skipped_and_cancelled_devices_do_not_count_toward_the_threshold() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":3,"failure_threshold":0,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    r.old(&r.ids[0], &with(r.idle(), json!({"state":"refused","release":r.release.manifest_sha256,"code":"COUNTER_REPLAYED"}))).await;
    r.old(&r.ids[1], &with(r.idle(), json!({"state":"refused","release":r.release.manifest_sha256,"code":"DOWNGRADE_REFUSED"}))).await;
    step(&r.f, at + Duration::seconds(5)).await;
    assert_eq!(
        r.status(&rollout).await,
        "active",
        "two refusals are not failures"
    );
    r.verify(&rollout, &r.ids[2]).await;
    let later = at + Duration::seconds(30);
    step(&r.f, later).await;
    step(&r.f, later + Duration::seconds(61)).await;
    assert_eq!(r.status(&rollout).await, "completed");
}

#[tokio::test]
async fn a_canary_that_never_updates_and_has_nothing_left_to_wait_for_fails_the_rollout() {
    let r = Rig::build(2).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"failure_threshold":5}))
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
    // The canary refuses; nothing of it updated and nothing is left that could.
    r.old(&canary, &with(r.idle(), json!({"state":"refused","release":r.release.manifest_sha256,"code":"UNTRUSTED_LOCATION"}))).await;
    step(&r.f, at + Duration::seconds(5)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.show(&rollout).await["failure_reason"], "threshold");
    assert_eq!(
        r.count(&rollout, "cancelled").await,
        1,
        "the device never released is cancelled"
    );
}

#[tokio::test]
async fn a_canary_that_waits_for_its_host_holds_the_rollout_and_it_goes_on_when_the_canary_applies()
{
    let r = Rig::build(2).await;
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
    let ask = with(r.about("waiting_for_host"), json!({"consent":"ask"}));
    r.old(&canary, &r.about("downloading")).await;
    r.old(&canary, &ask).await;
    assert_eq!(r.state(&rollout, &canary).await, "waiting_for_host");
    // A canary that waits for a person has proved nothing: no observation, no
    // next stage, and the rollout does not fail.
    for seconds in [5, 100, 4000] {
        step(&r.f, at + Duration::seconds(seconds)).await;
    }
    assert_eq!(r.status(&rollout).await, "active");
    assert_eq!(r.count(&rollout, "pending").await, 1);
    assert_eq!(
        r.show(&rollout).await["observation_started_at"],
        Value::Null
    );
    // A waiting device keeps its offer.
    assert!(r.old(&canary, &ask).await.get("agent_update").is_some());
    // Someone runs `sudo vectory update apply`.
    r.old(&canary, &r.about("applying")).await;
    r.new(&canary, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &canary).await, "verified");
    let later = at + Duration::seconds(5000);
    step(&r.f, later).await;
    step(&r.f, later + Duration::seconds(61)).await;
    assert_eq!(r.count(&rollout, "pending").await, 0);
}

#[tokio::test]
async fn a_device_that_waits_for_its_host_does_not_hold_a_later_stage_and_keeps_the_rollout_open() {
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
    // One of them waits for its window, the other updates.
    r.old(&batch[0], &r.about("staged")).await;
    r.old(
        &batch[0],
        &with(
            r.about("waiting_for_window"),
            json!({"windows":["daily 02:00-04:00 UTC"],"window_open":false}),
        ),
    )
    .await;
    r.verify(&rollout, &batch[1]).await;
    let later = at + Duration::seconds(200);
    step(&r.f, later).await;
    step(&r.f, later + Duration::seconds(61)).await;
    // Everything was released; the waiting device keeps its offer, so the
    // rollout stays open until it applies or it is cancelled.
    assert_eq!(r.status(&rollout).await, "active");
    assert_eq!(r.state(&rollout, &batch[0]).await, "waiting_for_window");
    assert!(
        r.old(
            &batch[0],
            &with(
                r.about("waiting_for_window"),
                json!({"windows":["daily 02:00-04:00 UTC"],"window_open":false})
            )
        )
        .await
        .get("agent_update")
        .is_some()
    );
    r.old(&batch[0], &r.about("applying")).await;
    r.new(&batch[0], &r.result("committed", None)).await;
    let end = later + Duration::seconds(300);
    step(&r.f, end).await;
    step(&r.f, end + Duration::seconds(61)).await;
    assert_eq!(r.status(&rollout).await, "completed");
}

#[tokio::test]
async fn silence_ends_what_waited_for_it() {
    let r = Rig::build(4).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":4,"failure_threshold":10,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let [silent, downloading, applying, restarted] = [&r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3]];
    r.old(downloading, &r.about("downloading")).await;
    r.apply(&rollout, applying).await;
    r.apply(&rollout, restarted).await;
    r.new(restarted, &r.about("trial")).await;
    assert_eq!(r.state(&rollout, restarted).await, "restarted");
    // Offered for 59 minutes: still offered. For 61: skipped. A device that
    // started downloading has reported, but one that stays there for an hour is
    // skipped too, with the code of a server that heard nothing more.
    step(&r.f, at + Duration::minutes(59)).await;
    assert_eq!(r.state(&rollout, silent).await, "offered");
    assert_eq!(r.state(&rollout, downloading).await, "downloading");
    step(&r.f, at + Duration::minutes(61)).await;
    assert_eq!(r.state(&rollout, silent).await, "skipped");
    assert_eq!(r.code(&rollout, silent).await, None);
    assert_eq!(r.state(&rollout, downloading).await, "skipped");
    assert_eq!(
        r.code(&rollout, downloading).await.as_deref(),
        Some("NO_REPORT")
    );
    // Applying or restarted and silent for 30 minutes: failed with NO_REPORT.
    assert_eq!(r.state(&rollout, applying).await, "failed");
    assert_eq!(
        r.code(&rollout, applying).await.as_deref(),
        Some("NO_REPORT")
    );
    assert_eq!(r.state(&rollout, restarted).await, "failed");
    assert_eq!(
        r.code(&rollout, restarted).await.as_deref(),
        Some("NO_REPORT")
    );
    // Neither a skipped target nor a failed one is moved again by a late report.
    r.old(silent, &r.about("downloading")).await;
    assert_eq!(r.state(&rollout, silent).await, "skipped");
    r.new(applying, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, applying).await, "failed");
    // The failures opened issues, with a message that says what NO_REPORT means.
    let issues = open_issues(&r.f).await;
    assert_eq!(issues.len(), 2);
    assert!(
        issues
            .iter()
            .all(|issue| issue["code"] == "AGENT_UPDATE_FAILED"
                && issue["update_code"] == "NO_REPORT")
    );
    // Twenty-nine minutes is not thirty.
    let r2 = Rig::build(1).await;
    let device = r2.ids[0].clone();
    let rollout = r2.start(&[&device], json!({"failure_threshold":10})).await;
    let at = Utc::now();
    step(&r2.f, at).await;
    r2.apply(&rollout, &device).await;
    step(&r2.f, at + Duration::minutes(29)).await;
    assert_eq!(r2.state(&rollout, &device).await, "applying");
}

#[tokio::test]
async fn a_revoked_device_ends_what_it_waited_for() {
    let r = Rig::build(2).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"failure_threshold":3}))
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let (canary, other) = {
        let states = r.states(&rollout).await;
        (
            states
                .iter()
                .find(|(_, state)| state == "offered")
                .unwrap()
                .0
                .clone(),
            states
                .iter()
                .find(|(_, state)| state == "pending")
                .unwrap()
                .0
                .clone(),
        )
    };
    // The revocation itself ends what the device was waiting for.
    revoke_through_the_api(&r.f, &canary).await;
    revoke_through_the_api(&r.f, &other).await;
    assert_eq!(r.state(&rollout, &canary).await, "skipped");
    assert_eq!(r.state(&rollout, &other).await, "skipped");
    // Nobody is left to update: the rollout ends.
    step(&r.f, at + Duration::seconds(5)).await;
    assert_ne!(r.status(&rollout).await, "active");
}

#[tokio::test]
async fn a_device_revoked_while_it_updates_is_skipped_and_is_no_failure_of_the_build() {
    let r = Rig::build(4).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":4,"failure_threshold":0,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let [applying, restarted, quiet, other] = [&r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3]];
    r.apply(&rollout, applying).await;
    r.apply(&rollout, restarted).await;
    r.new(restarted, &r.about("trial")).await;
    assert_eq!(r.state(&rollout, restarted).await, "restarted");
    r.apply(&rollout, quiet).await;
    // Its silence says nothing of the build: nothing is counted against a
    // threshold of none, no issue opens that nothing could ever resolve, and the
    // devices still to answer keep the rollout going.
    revoke_through_the_api(&r.f, applying).await;
    revoke_through_the_api(&r.f, restarted).await;
    for device in [applying, restarted] {
        assert_eq!(r.state(&rollout, device).await, "skipped");
        assert_eq!(r.code(&rollout, device).await, None);
    }
    // A device that was revoked without anything following it is not failed for
    // its silence either, when the silence rule finds it half an hour later.
    revoke(&r.f, quiet).await;
    step(&r.f, at + Duration::minutes(31)).await;
    assert_eq!(r.state(&rollout, quiet).await, "skipped");
    assert_eq!(r.code(&rollout, quiet).await, None);
    assert!(open_issues(&r.f).await.is_empty());
    assert_eq!(r.status(&rollout).await, "active");
    assert_eq!(r.state(&rollout, other).await, "offered");
}

#[tokio::test]
async fn a_rollout_with_many_verified_devices_is_advanced_every_ten_seconds_not_every_tick() {
    let r = Rig::build(520).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":100,"failure_threshold":0,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    // Every device verified and running the new build: more than the rollout is
    // advanced for at every tick.
    sqlx::query("UPDATE agent_update_targets SET state='verified',stage=COALESCE(stage,0),released_at=COALESCE(released_at,?),verified_at=? WHERE rollout_id=?")
        .bind(db::now())
        .bind(db::now())
        .bind(&rollout)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.agent_sha256',?,'$.agent_version','0.1.1','$.last_seen',?)")
        .bind(r.new_sha())
        .bind(db::now())
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    step(&r.f, at + Duration::seconds(1)).await;
    assert_eq!(r.status(&rollout).await, "active");
    // A device that rolled back is more than a threshold of none allows, but a
    // step two seconds later does not look yet, and one ten seconds later does.
    sqlx::query("UPDATE agent_update_targets SET state='rolled_back',code='UNHEALTHY' WHERE rollout_id=? AND device_id=?")
        .bind(&rollout)
        .bind(&r.ids[0])
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    step(&r.f, at + Duration::seconds(3)).await;
    assert_eq!(r.status(&rollout).await, "active");
    step(&r.f, at + Duration::seconds(12)).await;
    assert_eq!(r.status(&rollout).await, "failed");
}

#[tokio::test]
async fn the_stages_release_only_devices_that_are_checking_in_and_not_paused_on_the_host() {
    let r = Rig::build(4).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":10,"observation_seconds":60}),
        )
        .await;
    // The three that would be first by ID are late, paused on the host, or no
    // longer pass the review: the fourth is released.
    seen(&r.f, &r.ids[0], "2020-01-01T00:00:00Z").await;
    store(
        &r.f,
        &r.ids[1],
        &with(r.idle(), json!({"paused":true,"code":"UPDATES_PAUSED"})),
    )
    .await;
    store(
        &r.f,
        &r.ids[2],
        &with(r.idle(), json!({"eligibility":"READ_ONLY"})),
    )
    .await;
    let at = Utc::now();
    step(&r.f, at).await;
    let states = r.states(&rollout).await;
    let offered: Vec<&String> = states
        .iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(offered, [&r.ids[3]], "{states:?}");
    // A device that cannot be released now stays pending for a later stage.
    assert_eq!(r.count(&rollout, "pending").await, 3);
}

#[tokio::test]
async fn named_canary_devices_hold_the_canary_stage_until_they_can_take_it() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let named = r.ids[2].clone();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"canary_device_ids":[named]}))
        .await;
    seen(&r.f, &named, "2020-01-01T00:00:00Z").await;
    let at = Utc::now();
    step(&r.f, at).await;
    assert_eq!(
        r.count(&rollout, "offered").await,
        0,
        "the named canary is not checking in: the rollout waits for it"
    );
    seen(&r.f, &named, &db::now()).await;
    step(&r.f, at + Duration::seconds(30)).await;
    assert_eq!(r.state(&rollout, &named).await, "offered");
    assert_eq!(r.count(&rollout, "offered").await, 1);
}

#[tokio::test]
async fn an_unnamed_canary_prefers_devices_whose_window_is_open_and_updates_on_its_own() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // The first two by ID wait for a person or a window; the last is ready.
    store(&r.f, &r.ids[0], &with(r.idle(), json!({"consent":"ask"}))).await;
    store(
        &r.f,
        &r.ids[1],
        &with(
            r.idle(),
            json!({"windows":["daily 02:00-04:00 UTC"],"window_open":false}),
        ),
    )
    .await;
    let rollout = r.start(&refs, json!({"canary_size":1})).await;
    step(&r.f, Utc::now()).await;
    assert_eq!(r.state(&rollout, &r.ids[2]).await, "offered");
}

#[tokio::test]
async fn a_data_plane_issue_that_opens_on_an_updated_device_counts_as_a_failure() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":2,"failure_threshold":0,"observation_seconds":60}),
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
    // The device updates and checks in on the new build; then Vector stops
    // delivering on it: an issue that opens after the release is the build's to
    // answer for.
    r.verify(&rollout, &canary).await;
    assert_eq!(r.show(&rollout).await["degraded"], 0);
    insert_issue(
        &r.f,
        &db::hash("issue after the release"),
        &canary,
        "DATA_PLANE_NOT_DELIVERING",
        3,
    )
    .await;
    assert_eq!(r.show(&rollout).await["degraded"], 1);
    // Above the threshold of zero, with nothing else wrong: the data plane.
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["failure_reason"], "data_plane");
    assert_eq!(shown["degraded"], 1);
    assert_eq!(shown["state_counts"]["verified"], 1);
    assert_eq!(shown["state_counts"]["cancelled"], 2);
    let gate = audits(&r.f, "agent_update_rollout.gate").await;
    assert_eq!(gate[0]["details"]["reason"], "data_plane");
}
async fn insert_issue(f: &Fixture, id: &str, device: &str, code: &str, count: i64) {
    let mut conn = f.state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "issue",
        &json!({"id":id,"device_id":device,"code":code,"stage":"delivery","count":count,"first_seen":db::now(),"last_seen":db::now(),"resolved":false,"revision":1}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn an_issue_that_was_open_when_the_device_was_released_is_not_the_builds() {
    let r = Rig::build(2).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // The data-plane issue is on both devices before anything is released.
    for device in &r.ids {
        insert_issue(
            &r.f,
            &db::hash(format!("old issue {device}")),
            device,
            "DATA_PLANE_NOT_DELIVERING",
            5,
        )
        .await;
    }
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":1,"failure_threshold":0,"observation_seconds":60}),
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
    // (Check-ins of an unassigned device close its data-plane issues, so the
    // update is recorded without them.)
    r.force_verified(&rollout, &canary).await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.show(&rollout).await["degraded"], 0);
    step(&r.f, at + Duration::seconds(80)).await;
    assert_eq!(r.status(&rollout).await, "active");
    assert_eq!(
        r.count(&rollout, "offered").await,
        1,
        "the next batch is released"
    );
    // The same issue recurring since (its count grew) is counted.
    sqlx::query("UPDATE records SET data=json_set(data,'$.count',9) WHERE kind='issue' AND json_extract(data,'$.device_id')=?")
        .bind(&canary)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    assert_eq!(r.show(&rollout).await["degraded"], 1);
}

#[tokio::test]
async fn pause_withdraws_unstarted_offers_and_resume_restarts_the_stage() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":3,"observation_seconds":60}))
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    assert_eq!(r.count(&rollout, "offered").await, 3);
    let [offered, staged, applying] = [&r.ids[0], &r.ids[1], &r.ids[2]];
    r.old(staged, &r.about("downloading")).await;
    r.old(staged, &r.about("staged")).await;
    r.apply(&rollout, applying).await;
    // A pause the viewer cannot make, the operator can; it needs CSRF.
    let path = format!("/api/v1/agent-update-rollouts/{rollout}/pause");
    refused(
        &r.f,
        "POST",
        &path,
        Value::Null,
        &r.f.viewer,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    refused(
        &r.f,
        "POST",
        &path,
        Value::Null,
        &r.f.editor,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let (status, _, _) = send_with(
        &r.f.app,
        "POST",
        &path,
        Value::Null,
        Some((&r.f.operator.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // A body is refused: a transition takes none.
    refused(
        &r.f,
        "POST",
        &path,
        json!({"reason":"x"}),
        &r.f.operator,
        StatusCode::BAD_REQUEST,
        "INVALID_INPUT",
    )
    .await;
    let paused = ok(&r.f, "POST", &path, json!({}), &r.f.operator).await;
    assert_eq!(paused["status"], "paused");
    assert_eq!(paused["revision"], 2);
    assert!(paused["paused_at"].is_string());
    // Unstarted offers are withdrawn and their targets return to pending; the
    // device already applying finishes.
    assert_eq!(r.state(&rollout, offered).await, "pending");
    assert_eq!(r.state(&rollout, staged).await, "pending");
    assert_eq!(r.state(&rollout, applying).await, "applying");
    for device in [offered, staged] {
        assert!(r.old(device, &r.idle()).await.get("agent_update").is_none());
    }
    // A paused rollout releases nothing, and pausing it again is a conflict.
    step(&r.f, at + Duration::seconds(30)).await;
    assert_eq!(r.count(&rollout, "offered").await, 0);
    refused(
        &r.f,
        "POST",
        &path,
        Value::Null,
        &r.f.operator,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    // The device that was applying finishes while the rollout is paused.
    r.new(applying, &r.about("trial")).await;
    r.new(applying, &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, applying).await, "verified");
    // Resume: the same gates release again.
    let resume = format!("/api/v1/agent-update-rollouts/{rollout}/resume");
    refused(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/resume"),
        Value::Null,
        &r.f.viewer,
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
    )
    .await;
    let resumed = ok(&r.f, "POST", &resume, Value::Null, &r.f.admin).await;
    assert_eq!(resumed["status"], "active");
    assert_eq!(resumed["paused_at"], Value::Null);
    assert_eq!(resumed["revision"], 3);
    refused(
        &r.f,
        "POST",
        &resume,
        Value::Null,
        &r.f.operator,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    step(&r.f, at + Duration::seconds(40)).await;
    assert_eq!(
        r.state(&rollout, offered).await,
        "pending",
        "the canary stage is over; its observation runs again first"
    );
    step(&r.f, at + Duration::seconds(110)).await;
    assert_eq!(
        r.count(&rollout, "offered").await,
        2,
        "released again after the observation"
    );
    assert_eq!(audits(&r.f, "agent_update_rollout.pause").await.len(), 1);
    assert_eq!(audits(&r.f, "agent_update_rollout.resume").await.len(), 1);
}

#[tokio::test]
async fn cancel_withdraws_unstarted_offers_and_ends_the_rollout() {
    let r = Rig::build(3).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":2,"failure_threshold":5}))
        .await;
    step(&r.f, Utc::now()).await;
    let canary: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    r.apply(&rollout, &canary[0]).await;
    let path = format!("/api/v1/agent-update-rollouts/{rollout}/cancel");
    let cancelled = ok(&r.f, "POST", &path, Value::Null, &r.f.operator).await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["cancel_reason"], "operator");
    assert!(cancelled["cancelled_at"].is_string());
    assert_eq!(
        cancelled["state_counts"]["applying"], 1,
        "a device already applying finishes"
    );
    assert_eq!(cancelled["state_counts"]["cancelled"], 2);
    assert!(
        r.old(&canary[1], &r.idle())
            .await
            .get("agent_update")
            .is_none()
    );
    // The device that was applying finishes its trial; it is counted as it
    // reports, though the rollout has ended.
    r.new(&canary[0], &r.about("trial")).await;
    r.new(&canary[0], &r.result("committed", None)).await;
    assert_eq!(r.state(&rollout, &canary[0]).await, "verified");
    // Cancelled is never resumed; a second cancel is a conflict.
    for action in ["pause", "resume", "cancel"] {
        refused(
            &r.f,
            "POST",
            &format!("/api/v1/agent-update-rollouts/{rollout}/{action}"),
            Value::Null,
            &r.f.operator,
            StatusCode::CONFLICT,
            "CONFLICT",
        )
        .await;
    }
    assert_eq!(audits(&r.f, "agent_update_rollout.cancel").await.len(), 1);
    refused(
        &r.f,
        "POST",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001/cancel",
        Value::Null,
        &r.f.operator,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    // The devices are free for another rollout.
    let review = preview(&r.f, &r.release.id, &refs, json!({})).await;
    let still: Vec<&str> = review["wont_update"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| g["code"] == "IN_ANOTHER_UPDATE")
        .map(|g| g["code"].as_str().unwrap())
        .collect();
    assert!(still.is_empty(), "a cancelled rollout holds no device");
}

#[tokio::test]
async fn stop_all_updates_cancels_every_rollout_and_withdraws_every_offer() {
    let r = Rig::build(4).await;
    let first_ids = [&r.ids[0], &r.ids[1]];
    let second_ids = [&r.ids[2], &r.ids[3]];
    let first = r.start(&first_ids, json!({"canary_size":2})).await;
    let second = r.start(&second_ids, json!({"canary_size":1})).await;
    step(&r.f, Utc::now()).await;
    r.apply(&first, &r.ids[0]).await;
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{second}/pause"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    let stopped = ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A bad build"}),
        &r.f.operator,
    )
    .await;
    assert_eq!(stopped["active_rollouts"], 0);
    for rollout in [&first, &second] {
        let shown = r.show(rollout).await;
        assert_eq!(shown["status"], "cancelled");
        assert_eq!(shown["cancel_reason"], "stop");
    }
    assert_eq!(
        r.state(&first, &r.ids[0]).await,
        "applying",
        "a device already applying finishes"
    );
    assert_eq!(r.state(&first, &r.ids[1]).await, "cancelled");
    for id in &r.ids[1..] {
        assert!(r.old(id, &r.idle()).await.get("agent_update").is_none());
    }
    let rows = audits(&r.f, "agent_update.stop").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["details"]["cancelled_rollouts"], 2);
    // No new rollout until the stop is cleared; clearing resumes nothing.
    let review = preview(&r.f, &r.release.id, &[&r.ids[1]], json!({})).await;
    let mut body = request(&r.release.id, &[&r.ids[1]], json!({}));
    body["review_token"] = review["review_token"].clone();
    refused(
        &r.f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &r.f.operator,
        StatusCode::CONFLICT,
        "AGENT_UPDATES_STOPPED",
    )
    .await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stopped["revision"]}),
        &r.f.admin,
    )
    .await;
    assert_eq!(r.status(&first).await, "cancelled");
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body,
        &r.f.operator,
    )
    .await;
}

#[tokio::test]
async fn while_updates_are_off_the_step_and_the_check_ins_move_nothing() {
    // A rollout that exists does nothing while updates are off, and a check-in
    // neither moves a target nor is offered anything.
    let r = Rig::build(1).await;
    let device = r.ids[0].clone();
    let rollout = r.start(&[&device], json!({})).await;
    switch(&r.f, false).await;
    // The tick reads the setting itself.
    let mut tx = db::begin_write(&r.f.state.pool).await.unwrap();
    vectory_server::agent_update_rollouts::tick(&r.f.state, &mut tx).await;
    tx.commit().await.unwrap();
    assert_eq!(r.state(&rollout, &device).await, "pending");
    let _ = r.old(&device, &r.about("staged")).await;
    assert_eq!(r.state(&rollout, &device).await, "pending");
}

#[tokio::test]
async fn an_expired_release_ends_its_rollout_without_failing_it() {
    let r = Rig::build(2).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":1,"batch_size":1,"observation_seconds":60}),
        )
        .await;
    sqlx::query("UPDATE agent_releases SET expires_at=? WHERE id=?")
        .bind(
            (Utc::now() + Duration::seconds(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        )
        .bind(&r.release.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    // The release expires before the canary is released: nothing is, and the
    // rollout ends as cancelled, not failed.
    step(&r.f, Utc::now() + Duration::seconds(10)).await;
    assert_eq!(r.count(&rollout, "offered").await, 0);
    assert_eq!(r.status(&rollout).await, "cancelled");
    let shown = r.show(&rollout).await;
    assert_eq!(shown["cancel_reason"], "release_expired");
    assert_eq!(shown["failure_reason"], Value::Null);
    assert_eq!(r.count(&rollout, "cancelled").await, 2);
}
