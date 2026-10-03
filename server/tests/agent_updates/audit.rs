//! The audit trail of agent updates: each action names what it acted on, shows
//! only the facts the contract allows (versions, digests, counters,
//! fingerprints, codes, counts), and a device's rows are bounded.
use super::support::*;
use chrono::Utc;
use serde_json::{Value, json};
use vectory_server::db;

/// The events of one action as the audit detail shows them, oldest first.
async fn events(f: &Fixture, action: &str) -> Vec<Value> {
    let page = ok(
        f,
        "GET",
        &format!(
            "/api/v1/audit/history?action={action}&page_size=50&sort=created_at&direction=asc"
        ),
        Value::Null,
        &f.viewer,
    )
    .await;
    let mut out = Vec::new();
    for item in page["items"].as_array().unwrap() {
        out.push(
            ok(
                f,
                "GET",
                &format!("/api/v1/audit/{}", item["id"].as_str().unwrap()),
                Value::Null,
                &f.viewer,
            )
            .await,
        );
    }
    out.sort_by_key(|event| event["created_at"].as_str().unwrap().to_owned());
    out
}
fn keys(value: &Value) -> Vec<&str> {
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    keys
}

#[tokio::test]
async fn every_action_names_its_target_and_shows_only_what_the_contract_allows() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    mirror(
        &f,
        &[
            ("0.1.1", "linux", "amd64", vec![1u8; 4000]),
            ("0.1.2", "linux", "amd64", vec![2u8; 4000]),
        ],
    );
    let first = prepare(&f, "0.1.1").await;
    let rotated = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let second = prepare(&f, "0.1.2").await;
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[&key])).await;
    let old_sha = db::hash("running 0.1.0 linux amd64");

    // A rollout whose canary rolls back: the gate fails it.
    let rollout = start(
        &f,
        first["id"].as_str().unwrap(),
        &[&edge],
        json!({"canary_size":1}),
    )
    .await;
    let rollout_id = rollout["id"].as_str().unwrap().to_owned();
    step(&f, Utc::now()).await;
    let about = |release: &Value, state: &str| {
        with(
            member(&[&key]),
            json!({"state":state,"release":release["manifest_sha256"]}),
        )
    };
    report(
        &f,
        &edge,
        "0.1.0",
        &old_sha,
        "boot",
        &about(&first, "applying"),
    )
    .await;
    let rolled_back = with(
        member(&[&key]),
        json!({"last":{"release":first["manifest_sha256"],"outcome":"rolled_back","code":"UNHEALTHY","at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
    );
    report(&f, &edge, "0.1.0", &old_sha, "boot", &rolled_back).await;
    step(&f, Utc::now()).await;
    // A rollout that is paused, resumed and cancelled.
    let named = {
        let review = preview(&f, second["id"].as_str().unwrap(), &[&edge], json!({})).await;
        let mut body = request(second["id"].as_str().unwrap(), &[&edge], json!({}));
        body["review_token"] = review["review_token"].clone();
        body["name"] = json!("Spring update");
        ok(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts",
            body,
            &f.operator,
        )
        .await
    };
    let named_id = named["id"].as_str().unwrap().to_owned();
    for action in ["pause", "resume", "cancel"] {
        ok(
            &f,
            "POST",
            &format!("/api/v1/agent-update-rollouts/{named_id}/{action}"),
            Value::Null,
            &f.operator,
        )
        .await;
    }
    ok(
        &f,
        "POST",
        &format!(
            "/api/v1/agent-releases/{}/withdraw",
            first["id"].as_str().unwrap()
        ),
        json!({"reason":"Rolled back at the canary"}),
        &f.admin,
    )
    .await;
    let stopped = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Hold"}),
        &f.operator,
    )
    .await;
    ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stopped["revision"]}),
        &f.admin,
    )
    .await;
    ok(
        &f,
        "POST",
        &format!("/api/v1/agent-release-keys/{key}/revoke"),
        json!({"reason":"Retired and lost","current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    ok(
        &f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":false,"current_password":PASSWORD,"revision":view["revision"]}),
        &f.admin,
    )
    .await;

    let kind = |event: &Value| event["target_kind"].as_str().unwrap().to_owned();
    // The setting.
    let enable = events(&f, "agent_update.enable").await;
    assert_eq!(enable.len(), 1);
    assert_eq!(
        (kind(&enable[0]), enable[0]["target"].as_str()),
        ("server".to_owned(), Some("server"))
    );
    assert_eq!(enable[0]["actor"], "Synthetic admin");
    assert_eq!(enable[0]["actor_kind"], "user");
    assert_eq!(enable[0]["outcome"], "success");
    assert_eq!(
        enable[0]["details"],
        json!({"custody":"server","fingerprint":key})
    );
    let disable = events(&f, "agent_update.disable").await;
    assert_eq!(disable.len(), 1);
    assert_eq!(disable[0]["details"], json!({}));
    let stop = events(&f, "agent_update.stop").await;
    assert_eq!(
        stop[0]["details"],
        json!({"reason":"Hold","cancelled_rollouts":0})
    );
    assert_eq!(kind(&stop[0]), "server");
    assert_eq!(events(&f, "agent_update.stop_clear").await.len(), 1);
    // The keys.
    let rotate = events(&f, "agent_release_key.rotate").await;
    assert_eq!(rotate.len(), 1);
    assert_eq!(kind(&rotate[0]), "agent_release_key");
    assert_eq!(rotate[0]["target_id"], rotated["fingerprint"]);
    assert_eq!(rotate[0]["target_exists"], true);
    assert_eq!(
        rotate[0]["target_name"],
        format!(
            "Release key {}",
            &rotated["fingerprint"].as_str().unwrap()[..16]
        )
    );
    assert_eq!(
        rotate[0]["details"],
        json!({"fingerprint":rotated["fingerprint"],"from_fingerprint":key,"source":"server"})
    );
    let revoke = events(&f, "agent_release_key.revoke").await;
    assert_eq!(revoke[0]["target_id"], json!(key));
    assert_eq!(
        revoke[0]["details"],
        json!({"fingerprint":key,"reason":"Retired and lost","withdrawn_releases":0,"cancelled_rollouts":0})
    );
    // The releases.
    let prepared = events(&f, "agent_release.prepare").await;
    assert_eq!(prepared.len(), 2);
    assert_eq!(kind(&prepared[0]), "agent_release");
    assert_eq!(prepared[0]["target_id"], first["id"]);
    assert_eq!(prepared[0]["target_name"], "Agent 0.1.1");
    assert_eq!(prepared[0]["target_exists"], true);
    assert_eq!(
        prepared[0]["details"],
        json!({"release_id":first["id"],"version":"0.1.1","counter":1,"manifest_sha256":first["manifest_sha256"]})
    );
    let signed = events(&f, "agent_release.sign").await;
    assert_eq!(signed.len(), 2);
    assert_eq!(
        keys(&signed[0]["details"]),
        [
            "counter",
            "fingerprint",
            "manifest_sha256",
            "release_id",
            "version"
        ]
    );
    assert_eq!(signed[0]["details"]["fingerprint"], json!(key));
    assert_eq!(signed[1]["details"]["fingerprint"], rotated["fingerprint"]);
    let withdrawn = events(&f, "agent_release.withdraw").await;
    assert_eq!(withdrawn.len(), 1);
    assert_eq!(
        withdrawn[0]["details"]["reason"],
        "Rolled back at the canary"
    );
    assert_eq!(withdrawn[0]["details"]["cancelled_rollouts"], 0);
    assert_eq!(withdrawn[0]["details"]["version"], "0.1.1");
    // The rollouts.
    let created = events(&f, "agent_update_rollout.create").await;
    assert_eq!(created.len(), 2);
    assert_eq!(kind(&created[0]), "agent_update_rollout");
    assert_eq!(created[0]["target_id"], json!(rollout_id));
    assert_eq!(created[0]["target_name"], "Update to 0.1.1");
    assert_eq!(
        created[1]["target_name"], "Spring update",
        "a rollout is named as it was"
    );
    assert_eq!(created[0]["details"]["release_id"], first["id"]);
    let released = events(&f, "agent_update_rollout.release").await;
    assert_eq!(released.len(), 1);
    assert_eq!(released[0]["actor"], "scheduler");
    assert_eq!(released[0]["actor_kind"], "system");
    assert_eq!(
        released[0]["details"],
        json!({"stage":"0","device_ids":[edge],"released_count":1})
    );
    let gate = events(&f, "agent_update_rollout.gate").await;
    assert_eq!(gate.len(), 1);
    assert_eq!(gate[0]["outcome"], "failed");
    assert_eq!(
        gate[0]["details"],
        json!({"gate_state":"failed","reason":"threshold","verified_count":0})
    );
    for action in ["pause", "resume", "cancel"] {
        let rows = events(&f, &format!("agent_update_rollout.{action}")).await;
        assert_eq!(rows.len(), 1, "{action}");
        assert_eq!(rows[0]["target_id"], json!(named_id));
        assert_eq!(rows[0]["details"], json!({}));
    }
    // A device that went back to its previous build.
    let device_rows = events(&f, "device.agent_update").await;
    assert_eq!(device_rows.len(), 1);
    assert_eq!(kind(&device_rows[0]), "device");
    assert_eq!(device_rows[0]["target_id"], json!(edge));
    assert_eq!(device_rows[0]["device_name"], "edge-00");
    assert_eq!(device_rows[0]["outcome"], "rolled_back");
    assert_eq!(
        device_rows[0]["details"],
        json!({
            "rollout_id":rollout_id,"release_id":first["id"],"version":"0.1.1",
            "manifest_sha256":first["manifest_sha256"],"from_version":"0.1.0","to_version":"0.1.1",
            "code":"UNHEALTHY","state":"rolled_back"
        })
    );
    // A family finds them all, and the history of a device lists its own.
    let family = ok(
        &f,
        "GET",
        "/api/v1/audit/history?family=agent_release&page_size=50",
        Value::Null,
        &f.viewer,
    )
    .await;
    assert!(
        family["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["action"].as_str().unwrap().starts_with("agent_release."))
    );
    assert_eq!(
        family["total"], 5,
        "two prepared, two signed and one withdrawn: no key event"
    );
}

#[tokio::test]
async fn a_refused_signature_upload_keeps_its_reason_and_no_key_material_is_ever_shown() {
    let f = fixture().await;
    let team = team("team");
    enable_offline(&f, &team).await;
    mirror(&f, &[("0.1.1", "linux", "amd64", vec![1u8; 3000])]);
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap();
    let (status, _, _) = send_bytes(
        &f.app,
        "PUT",
        &format!("/api/v1/agent-releases/{id}/signature"),
        b"not a signature file".to_vec(),
        "application/octet-stream",
        Some((&f.admin.cookie, Some(&f.admin.csrf))),
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    let rows = events(&f, "agent_release.signature_upload").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["outcome"], "refused");
    assert_eq!(rows[0]["target_id"], json!(id));
    assert!(rows[0]["details"]["reason"].as_str().unwrap().len() > 3);
    assert_eq!(rows[0]["details"]["fingerprint"], json!(team.fingerprint()));
    // Over every event of agent updates, nothing that looks like a seed, a
    // private key or a signature appears.
    let everything = ok(
        &f,
        "GET",
        "/api/v1/audit/history?page_size=50",
        Value::Null,
        &f.viewer,
    )
    .await;
    for item in everything["items"].as_array().unwrap() {
        let detail = ok(
            &f,
            "GET",
            &format!("/api/v1/audit/{}", item["id"].as_str().unwrap()),
            Value::Null,
            &f.viewer,
        )
        .await;
        let text = detail.to_string();
        assert!(!text.contains("private"), "{text}");
        assert!(!text.contains("seed"), "{text}");
        assert!(!text.contains("vectory-release-private-key"), "{text}");
    }
}

#[tokio::test]
async fn a_device_adds_at_most_four_rows_a_minute_of_its_updates() {
    let f = fixture_on().await;
    let key = fingerprint("team");
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[&key])).await;
    let old_sha = db::hash("running 0.1.0 linux amd64");
    // Six rollouts of six releases, each rolled back: the device's rows stop at four.
    for n in 0..6 {
        let release = release(
            &f,
            &format!("0.1.{}", n + 1),
            (n + 1) as i64,
            &key,
            &[("linux", "amd64")],
        )
        .await;
        // The host reports a floor that keeps each release above it.
        store(&f, &edge, &member(&[&key])).await;
        let rollout = start(&f, &release.id, &[&edge], json!({"failure_threshold":100})).await;
        let _ = rollout;
        step(&f, Utc::now()).await;
        let applying = with(
            member(&[&key]),
            json!({"state":"applying","release":release.manifest_sha256}),
        );
        report(&f, &edge, "0.1.0", &old_sha, "boot", &applying).await;
        let back = with(
            member(&[&key]),
            json!({"last":{"release":release.manifest_sha256,"outcome":"rolled_back","code":"UNHEALTHY","at":"2026-10-05T02:09:41Z","from_version":"0.1.0","to_version":"0.1.1"}}),
        );
        report(&f, &edge, "0.1.0", &old_sha, "boot", &back).await;
    }
    let rows = events(&f, "device.agent_update").await;
    assert_eq!(rows.len(), 4, "the per-device limit of audit rows");
    // What the limit left out is still in the rollout: its target says so.
    let ended: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_update_targets WHERE state='rolled_back'")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(ended, 6);
}
