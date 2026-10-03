//! The release keys: who holds them, how one replaces another, what the
//! unauthenticated bundle says, and what a revocation takes with it.
use super::support::*;
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use serde_json::{Value, json};
use vectory_server::{
    agent_release::{self, ReleaseKey, Rollover},
    device,
};

const SETTINGS: &str = "/api/v1/agent-updates/settings";

fn sealed(f: &Fixture, fingerprint: &str) -> std::path::PathBuf {
    f.temp
        .path()
        .join("state/keys")
        .join(format!("agent-release-{fingerprint}.sealed"))
}
fn aad(fingerprint: &str) -> String {
    format!("agent-release-key:{fingerprint}")
}
async fn settings(f: &Fixture, who: &Who, body: Value) -> (StatusCode, Value) {
    let (status, _, value) = send(&f.app, "PUT", SETTINGS, body, Some(who)).await;
    (status, value)
}
/// How many keys the server holds, whether or not updates are on.
async fn key_count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_release_keys")
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}
async fn revision(f: &Fixture) -> i64 {
    ok(f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await["revision"]
        .as_i64()
        .unwrap()
}
async fn keys(f: &Fixture) -> Vec<Value> {
    ok(
        f,
        "GET",
        "/api/v1/agent-release-keys",
        Value::Null,
        &f.viewer,
    )
    .await
    .as_array()
    .unwrap()
    .clone()
}
/// A change of the setting, as the request body says it.
fn change(revision: i64, enabled: bool, custody: Option<Value>) -> Value {
    let mut body = json!({"enabled":enabled,"current_password":PASSWORD,"revision":revision});
    if let Some(custody) = custody {
        body["custody"] = custody;
    }
    body
}
async fn bundle(f: &Fixture) -> (StatusCode, axum::http::HeaderMap, Value) {
    send(
        &device::router(f.state.clone()),
        "GET",
        "/agent/v1/release-keys",
        Value::Null,
        None,
    )
    .await
}

#[tokio::test]
async fn turning_updates_on_with_server_custody_makes_one_key_and_seals_its_seed() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    assert_eq!(on["enabled"], true);
    assert_eq!(on["custody"], "server");
    assert_eq!(on["revision"], 1);
    assert_eq!(on["stopped"], Value::Null);
    let key = &on["current_key"];
    let fingerprint = key["fingerprint"].as_str().unwrap().to_owned();
    let parsed = ReleaseKey::parse(key["public_key"].as_str().unwrap()).unwrap();
    assert_eq!(
        parsed.fingerprint(),
        fingerprint,
        "computed from the key's bytes"
    );
    assert_eq!(
        parsed.name(),
        format!("release-{}", &fingerprint[..8]),
        "a key the server made is named like any other, by the start of its fingerprint"
    );
    assert_eq!(key["state"], "current");
    assert_eq!(key["custody"], "server");
    assert_eq!(key["created_by_name"], "Synthetic admin");
    assert_eq!(key["introduced_by"], Value::Null);
    assert_eq!(key["devices_pinning"], 0);

    // The seed is sealed to the key it belongs to, in a file only the server
    // reads.
    let path = sealed(&f, &fingerprint);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.len(), 12 + 32 + 16, "a nonce, the seed and its tag");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let seed = f.state.keys.open_bytes(&aad(&fingerprint), &bytes).unwrap();
    assert_eq!(
        ReleaseKey::from_seed(&seed.clone().try_into().unwrap(), parsed.name()).unwrap(),
        parsed
    );
    assert!(
        f.state
            .keys
            .open_bytes(&aad("another key"), &bytes)
            .is_err()
    );
    let mut changed = bytes.clone();
    changed[20] ^= 1;
    assert!(
        f.state
            .keys
            .open_bytes(&aad(&fingerprint), &changed)
            .is_err()
    );

    // Nothing the server says holds the seed.
    let rows = audits(&f, "agent_update.enable").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], "server");
    assert_eq!(
        rows[0]["details"],
        json!({"custody":"server","fingerprint":fingerprint})
    );
    for text in [
        on.to_string(),
        rows[0].to_string(),
        json!(keys(&f).await).to_string(),
    ] {
        for form in [STANDARD.encode(&seed), hex::encode(&seed)] {
            assert!(!text.contains(&form), "the seed is never published");
        }
    }
    let listed = keys(&f).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["fingerprint"], json!(fingerprint));
}

#[tokio::test]
async fn the_setting_is_changed_by_an_administrator_with_the_password_and_the_current_revision() {
    let f = fixture().await;
    let body = change(0, true, Some(json!({"kind":"server"})));
    for who in [&f.viewer, &f.editor, &f.operator] {
        let (status, value) = settings(&f, who, body.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{value}");
    }
    let (status, _, _) = send_with(
        &f.app,
        "PUT",
        SETTINGS,
        body.clone(),
        Some((&f.admin.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no CSRF token");
    let (status, _, _) = send(&f.app, "PUT", SETTINGS, body.clone(), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut wrong = body.clone();
    wrong["current_password"] = json!("not the password at all");
    let (status, value) = settings(&f, &f.admin, wrong).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"]["code"], "WRONG_PASSWORD");
    let (status, value) = settings(
        &f,
        &f.admin,
        change(5, true, Some(json!({"kind":"server"}))),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("STALE_REVISION"))
    );
    for bad in [
        json!({}),
        json!({"enabled":true,"revision":0}),
        json!({"enabled":true,"current_password":PASSWORD}),
        json!({"enabled":"yes","current_password":PASSWORD,"revision":0}),
        json!({"enabled":true,"current_password":PASSWORD,"revision":-1}),
        json!({"enabled":true,"current_password":PASSWORD,"revision":"0"}),
        json!({"enabled":true,"current_password":"","revision":0}),
        json!({"enabled":true,"current_password":PASSWORD,"revision":0,"surprise":1}),
        json!({"enabled":true,"custody":"server","current_password":PASSWORD,"revision":0}),
        json!({"enabled":true,"custody":{},"current_password":PASSWORD,"revision":0}),
        json!({"enabled":true,"custody":{"kind":"cloud"},"current_password":PASSWORD,"revision":0}),
        json!({"enabled":true,"custody":{"kind":"server","extra":1},"current_password":PASSWORD,"revision":0}),
        // A key is only offered with the kind that takes one.
        json!({"enabled":true,"custody":{"kind":"server","public_key":"vectory-release-key ed25519 x y"},"current_password":PASSWORD,"revision":0}),
        json!({"enabled":true,"custody":{"kind":"offline","public_key":7},"current_password":PASSWORD,"revision":0}),
        // ... and a custody is chosen only when turning updates on.
        json!({"enabled":false,"custody":{"kind":"server"},"current_password":PASSWORD,"revision":0}),
        // No key was given where one is needed.
        change(0, true, Some(json!({"kind":"offline"}))),
    ] {
        let (status, value) = settings(&f, &f.admin, bad.clone()).await;
        assert_eq!(
            (status, value["error"]["code"].as_str()),
            (StatusCode::BAD_REQUEST, Some("INVALID_INPUT")),
            "{bad}"
        );
    }
    // Updates have no key to be turned on with.
    let (status, value) = settings(&f, &f.admin, change(0, true, None)).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("CUSTODY_REQUIRED"))
    );
    // Nothing above changed anything.
    let unchanged = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    assert_eq!(unchanged["revision"], 0);
    assert_eq!(unchanged["enabled"], false);
    assert_eq!(key_count(&f).await, 0);
    assert!(audits(&f, "agent_update.enable").await.is_empty());
}

#[tokio::test]
async fn the_custody_is_fixed_while_updates_are_on_and_a_repeated_request_changes_nothing() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let fingerprint = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let team = team("team");
    let revision = on["revision"].as_i64().unwrap();
    // Another kind, and the same kind with a key, are refused.
    for custody in [
        json!({"kind":"offline","public_key":team.line()}),
        json!({"kind":"offline"}),
    ] {
        let (status, value) = settings(&f, &f.admin, change(revision, true, Some(custody))).await;
        assert_eq!(
            (status, value["error"]["code"].as_str()),
            (StatusCode::CONFLICT, Some("CUSTODY_LOCKED"))
        );
    }
    // Repeating the request, with or without the custody, changes nothing: no
    // revision, no audit row, the same key.
    for custody in [None, Some(json!({"kind":"server"}))] {
        let (status, value) = settings(&f, &f.admin, change(revision, true, custody)).await;
        assert_eq!(status, StatusCode::OK, "{value}");
        assert_eq!(value["revision"], revision);
        assert_eq!(value["current_key"]["fingerprint"], json!(fingerprint));
    }
    assert_eq!(audits(&f, "agent_update.enable").await.len(), 1);
    assert_eq!(keys(&f).await.len(), 1);
    // Turning updates off that are off changes nothing either.
    let (_, off) = settings(&f, &f.admin, change(revision, false, None)).await;
    let (status, again) = settings(
        &f,
        &f.admin,
        change(off["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["revision"], off["revision"]);
    assert_eq!(audits(&f, "agent_update.disable").await.len(), 1);
}

#[tokio::test]
async fn turning_updates_off_keeps_the_key_the_custody_and_the_stop_and_waits_for_the_rollouts() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let fingerprint = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let release = release(&f, "0.1.1", 1, &fingerprint, &[("linux", "amd64")]).await;
    let device = device(&f, "edge-00", "0.1.0").await;
    store(&f, &device, &member(&[&fingerprint])).await;
    let rollout = start(&f, &release.id, &[&device], json!({})).await;
    // An update rollout that has not ended keeps updates on.
    let (status, value) = settings(
        &f,
        &f.admin,
        change(on["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("AGENT_UPDATE_ROLLOUTS_ACTIVE"))
    );
    ok(
        &f,
        "POST",
        &format!(
            "/api/v1/agent-update-rollouts/{}/pause",
            rollout["id"].as_str().unwrap()
        ),
        Value::Null,
        &f.operator,
    )
    .await;
    let (status, _) = settings(
        &f,
        &f.admin,
        change(on["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a paused rollout has not ended"
    );
    ok(
        &f,
        "POST",
        &format!(
            "/api/v1/agent-update-rollouts/{}/cancel",
            rollout["id"].as_str().unwrap()
        ),
        Value::Null,
        &f.operator,
    )
    .await;
    // A stop is kept while off.
    let stopped = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Holding"}),
        &f.operator,
    )
    .await;
    let (status, off) = settings(
        &f,
        &f.admin,
        change(stopped["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{off}");
    assert_eq!(off["enabled"], false);
    assert_eq!(off["custody"], "server", "the custody stays");
    assert_eq!(
        off["current_key"]["fingerprint"],
        json!(fingerprint),
        "and so does the key"
    );
    assert_eq!(off["stopped"]["reason"], "Holding");
    assert_eq!(off["fleet"], Value::Null);
    let rows = audits(&f, "agent_update.disable").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], "server");
    // Turned on again without a custody: the key it had, with no new file.
    let before = std::fs::read(sealed(&f, &fingerprint)).unwrap();
    let (status, back) = settings(
        &f,
        &f.admin,
        change(off["revision"].as_i64().unwrap(), true, None),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["enabled"], true);
    assert_eq!(back["current_key"]["fingerprint"], json!(fingerprint));
    assert_eq!(back["revision"], off["revision"].as_i64().unwrap() + 1);
    assert_eq!(
        back["stopped"]["reason"], "Holding",
        "turning updates on clears no stop"
    );
    assert_eq!(std::fs::read(sealed(&f, &fingerprint)).unwrap(), before);
    assert_eq!(keys(&f).await.len(), 1);
    let enabled = audits(&f, "agent_update.enable").await;
    assert_eq!(enabled.len(), 2);
    assert_eq!(enabled[1]["details"]["fingerprint"], json!(fingerprint));
    // The same custody again, with its kind, is the same key.
    let (_, off) = settings(
        &f,
        &f.admin,
        change(back["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    let (status, again) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"server"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["current_key"]["fingerprint"], json!(fingerprint));
    assert_eq!(keys(&f).await.len(), 1);
}

#[tokio::test]
async fn while_updates_are_off_another_custody_replaces_the_key_without_a_statement() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let first = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, off) = settings(
        &f,
        &f.admin,
        change(on["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    // The server's key is replaced by the team's: the old key is retired, its
    // private half is wiped, and no statement leads from one to the other.
    let owner = team("team");
    let (status, on) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"offline","public_key":owner.line()})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{on}");
    assert_eq!(on["custody"], "offline");
    assert_eq!(on["current_key"]["fingerprint"], json!(owner.fingerprint()));
    assert_eq!(on["current_key"]["custody"], "offline");
    assert_eq!(on["current_key"]["introduced_by"], Value::Null);
    assert!(
        !sealed(&f, &first).exists(),
        "a retired key's seed is wiped"
    );
    assert!(
        !sealed(&f, &owner.fingerprint()).exists(),
        "the team's seed never reaches the server"
    );
    let listed = keys(&f).await;
    assert_eq!(listed.len(), 2);
    assert_eq!(
        listed[0]["fingerprint"],
        json!(owner.fingerprint()),
        "newest first"
    );
    assert_eq!(listed[1]["fingerprint"], json!(first));
    assert_eq!(listed[1]["state"], "retired");
    assert!(listed[1]["retired_at"].is_string());
    assert_eq!(
        audits(&f, "agent_update.enable").await.last().unwrap()["details"],
        json!({"custody":"offline","fingerprint":owner.fingerprint()})
    );
    // Back to a key the server holds: the team's key is retired.
    let (_, off) = settings(
        &f,
        &f.admin,
        change(on["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    let (status, back) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"server"})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{back}");
    assert_eq!(back["custody"], "server");
    let third = back["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(third, first);
    assert!(sealed(&f, &third).exists());
    assert_eq!(keys(&f).await.len(), 3);
    assert_eq!(
        keys(&f)
            .await
            .iter()
            .filter(|key| key["state"] == "current")
            .count(),
        1
    );
    // A new key of the same kind replaces the old one too; an offline key needs
    // its key line.
    let (_, off) = settings(
        &f,
        &f.admin,
        change(back["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    let (status, value) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"offline"})),
        ),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::BAD_REQUEST, Some("INVALID_INPUT"))
    );
    let next = team("next");
    let (status, replaced) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"offline","public_key":next.line()})),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert!(!sealed(&f, &third).exists());
    // The second offline key replaces the first by key line while updates are
    // off, and the first is refused as already held.
    let (_, off) = settings(
        &f,
        &f.admin,
        change(replaced["revision"].as_i64().unwrap(), false, None),
    )
    .await;
    let (status, value) = settings(
        &f,
        &f.admin,
        change(
            off["revision"].as_i64().unwrap(),
            true,
            Some(json!({"kind":"offline","public_key":owner.line()})),
        ),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("RELEASE_KEY_IN_USE")),
        "a retired key stays registered"
    );
}

#[tokio::test]
async fn the_teams_key_must_be_a_valid_key_the_server_does_not_already_use() {
    let f = fixture().await;
    let good = team("team");
    let line = good.line();
    let identity = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let invalid = [
        "not a key line".to_owned(),
        String::new(),
        format!("{line}\n"),
        line.replace("vectory-release-key", "ssh-ed25519"),
        line.replace("ed25519", "rsa"),
        line.replacen(' ', "  ", 1),
        format!("vectory-release-key ed25519 {identity} identity"),
        "vectory-release-key ed25519 AAAA short".to_owned(),
        format!("{line} \"quoted\""),
        format!(
            "vectory-release-key ed25519 {} {}",
            STANDARD.encode([7u8; 31]),
            "short key"
        ),
    ];
    for public_key in invalid {
        let (status, value) = settings(
            &f,
            &f.admin,
            change(
                0,
                true,
                Some(json!({"kind":"offline","public_key":public_key})),
            ),
        )
        .await;
        assert_eq!(
            (status, value["error"]["code"].as_str()),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Some("RELEASE_KEY_INVALID")
            ),
            "{public_key:?}: {value}"
        );
    }
    // The server's own manifest signing key is a valid key and never a release key.
    let signing =
        ReleaseKey::from_public_bytes(&f.state.keys.signing.verifying_key().to_bytes(), "manifest")
            .unwrap();
    let (status, value) = settings(
        &f,
        &f.admin,
        change(
            0,
            true,
            Some(json!({"kind":"offline","public_key":signing.line()})),
        ),
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("RELEASE_KEY_IN_USE"))
    );
    assert!(
        f.state
            .keys
            .identity_public_keys()
            .contains(signing.public_bytes())
    );
    assert_eq!(key_count(&f).await, 0);
    assert_eq!(revision(&f).await, 0);
    // The team's key is taken as it is.
    let on = enable_offline(&f, &good).await;
    assert_eq!(on["custody"], "offline");
    assert_eq!(on["current_key"]["public_key"], json!(line));
    assert_eq!(on["current_key"]["created_by_name"], "Synthetic admin");
}

#[tokio::test]
async fn rotating_a_key_the_server_holds_signs_a_statement_with_the_old_key() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let old = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let old_key = ReleaseKey::parse(on["current_key"]["public_key"].as_str().unwrap()).unwrap();
    let path = "/api/v1/agent-release-keys/rotate";
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            path,
            json!({"current_password":PASSWORD}),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        path,
        json!({"current_password":"wrong wrong wrong"}),
        &f.admin,
        StatusCode::FORBIDDEN,
        "WRONG_PASSWORD",
    )
    .await;
    for bad in [
        json!({}),
        json!({"current_password":PASSWORD,"extra":1}),
        json!({"current_password":""}),
    ] {
        refused(
            &f,
            "POST",
            path,
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    let revision = revision(&f).await;
    let rotated = ok(
        &f,
        "POST",
        path,
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let new = rotated["fingerprint"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    assert_eq!(rotated["state"], "current");
    assert_eq!(rotated["custody"], "server");
    // The statement leads from the old key to the new one, and the old key
    // signed it.
    let envelope = &rotated["introduced_by"];
    let rollover = Rollover::from_base64(
        envelope["statement"].as_str().unwrap(),
        envelope["signature"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(rollover.statement.from, old);
    assert_eq!(rollover.statement.to.fingerprint(), new);
    assert_eq!(
        rollover.statement.to.line(),
        rotated["public_key"].as_str().unwrap()
    );
    assert!(rollover.verify(&old_key), "signed by the old key");
    assert!(
        rollover.statement.issued_at <= Utc::now().timestamp()
            && rollover.statement.issued_at > Utc::now().timestamp() - 60
    );
    // The setting follows: the new key signs, the old one is history.
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(view["current_key"]["fingerprint"], json!(new));
    assert_eq!(view["revision"], revision + 1);
    let listed = keys(&f).await;
    assert_eq!(listed[0]["fingerprint"], json!(new));
    assert_eq!(listed[1]["fingerprint"], json!(old));
    assert_eq!(listed[1]["state"], "retired");
    assert!(listed[1]["retired_at"].is_string());
    // The old seed is wiped, the new one is sealed to the new key.
    assert!(!sealed(&f, &old).exists());
    let bytes = std::fs::read(sealed(&f, &new)).unwrap();
    assert!(f.state.keys.open_bytes(&aad(&new), &bytes).is_ok());
    assert!(f.state.keys.open_bytes(&aad(&old), &bytes).is_err());
    let rows = audits(&f, "agent_release_key.rotate").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], json!(new));
    assert_eq!(
        rows[0]["details"],
        json!({"fingerprint":new,"from_fingerprint":old,"source":"server"})
    );
    // Rotating again follows the statement chain.
    let again = ok(
        &f,
        "POST",
        path,
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let (_, _, bundled) = bundle(&f).await;
    assert_eq!(bundled["keys"].as_array().unwrap().len(), 3);
    assert_eq!(bundled["rollovers"].as_array().unwrap().len(), 2);
    assert_eq!(
        again["introduced_by"]["statement"], bundled["rollovers"][1]["statement"],
        "in the order the keys followed one another"
    );
}

#[tokio::test]
async fn a_key_the_team_holds_is_rotated_by_uploading_a_statement_it_signed() {
    let f = fixture().await;
    let first = team("team");
    enable_offline(&f, &first).await;
    let second = team("team-next");
    let path = "/api/v1/agent-release-keys/rollover";
    let statement =
        agent_release::build_statement(&first.fingerprint(), &second.key, Utc::now().timestamp())
            .unwrap();
    let signature = agent_release::sign_rollover(&first.seed, &statement).unwrap();
    let body = |statement: &[u8], signature: &[u8]| json!({"statement":STANDARD.encode(statement),"signature":STANDARD.encode(signature),"current_password":PASSWORD});
    // The server holds no key to rotate for the team: rotate is for server custody.
    refused(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            path,
            body(&statement, &signature),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    let mut wrong = body(&statement, &signature);
    wrong["current_password"] = json!("wrong wrong wrong");
    refused(
        &f,
        "POST",
        path,
        wrong,
        &f.admin,
        StatusCode::FORBIDDEN,
        "WRONG_PASSWORD",
    )
    .await;
    // Malformed requests.
    for bad in [
        json!({"current_password":PASSWORD}),
        json!({"statement":"!!!","signature":STANDARD.encode(&signature),"current_password":PASSWORD}),
        json!({"statement":STANDARD.encode(&statement),"signature":"AAAA","current_password":PASSWORD}),
        json!({"statement":STANDARD.encode(b"{}"),"signature":STANDARD.encode(&signature),"current_password":PASSWORD}),
        json!({"statement":STANDARD.encode(vec![b'a'; 2000]),"signature":STANDARD.encode(&signature),"current_password":PASSWORD}),
        {
            let mut b = body(&statement, &signature);
            b["surprise"] = json!(1);
            b
        },
    ] {
        refused(
            &f,
            "POST",
            path,
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    // A successor that is not a valid key line.
    let invalid = format!(
        r#"{{"schema":"vectory.release-key-rollover.v1","from":"{}","to":"vectory-release-key ed25519 AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= next","issued_at":"2026-11-02T09:00:00Z"}}"#,
        first.fingerprint()
    );
    refused(
        &f,
        "POST",
        path,
        body(invalid.as_bytes(), &signature),
        &f.admin,
        StatusCode::UNPROCESSABLE_ENTITY,
        "RELEASE_KEY_INVALID",
    )
    .await;
    // A signature that does not verify under the key it names.
    let stranger = team("stranger");
    let forged = agent_release::sign_rollover(&stranger.seed, &statement).unwrap();
    refused(
        &f,
        "POST",
        path,
        body(&statement, &forged),
        &f.admin,
        StatusCode::UNPROCESSABLE_ENTITY,
        "RELEASE_SIGNATURE_INVALID",
    )
    .await;
    // A statement from a key that is not the current one.
    let from_stranger = agent_release::build_statement(
        &stranger.fingerprint(),
        &second.key,
        Utc::now().timestamp(),
    )
    .unwrap();
    let signed = agent_release::sign_rollover(&stranger.seed, &from_stranger).unwrap();
    refused(
        &f,
        "POST",
        path,
        body(&from_stranger, &signed),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    // A successor the server's own key is.
    let own =
        ReleaseKey::from_public_bytes(&f.state.keys.signing.verifying_key().to_bytes(), "own")
            .unwrap();
    let to_own =
        agent_release::build_statement(&first.fingerprint(), &own, Utc::now().timestamp()).unwrap();
    let signed = agent_release::sign_rollover(&first.seed, &to_own).unwrap();
    refused(
        &f,
        "POST",
        path,
        body(&to_own, &signed),
        &f.admin,
        StatusCode::CONFLICT,
        "RELEASE_KEY_IN_USE",
    )
    .await;
    assert_eq!(keys(&f).await.len(), 1, "nothing was registered");
    assert!(audits(&f, "agent_release_key.rollover").await.is_empty());

    let revision = revision(&f).await;
    let rotated = ok(&f, "POST", path, body(&statement, &signature), &f.admin).await;
    assert_eq!(rotated["fingerprint"], json!(second.fingerprint()));
    assert_eq!(rotated["state"], "current");
    assert_eq!(
        rotated["custody"], "offline",
        "custody never changes by a statement"
    );
    assert_eq!(
        rotated["introduced_by"]["statement"],
        STANDARD.encode(&statement)
    );
    assert_eq!(
        rotated["introduced_by"]["signature"],
        STANDARD.encode(signature)
    );
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(view["custody"], "offline");
    assert_eq!(
        view["current_key"]["fingerprint"],
        json!(second.fingerprint())
    );
    assert_eq!(view["revision"], revision + 1);
    let listed = keys(&f).await;
    assert_eq!(listed[1]["fingerprint"], json!(first.fingerprint()));
    assert_eq!(listed[1]["state"], "retired");
    let rows = audits(&f, "agent_release_key.rollover").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["details"],
        json!({"fingerprint":second.fingerprint(),"from_fingerprint":first.fingerprint(),"source":"upload"})
    );
    // The old key is no longer current, so a statement from it is a conflict; and
    // the key it replaced is a key the server holds.
    refused(
        &f,
        "POST",
        path,
        body(&statement, &signature),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    let back =
        agent_release::build_statement(&second.fingerprint(), &first.key, Utc::now().timestamp())
            .unwrap();
    let signed = agent_release::sign_rollover(&second.seed, &back).unwrap();
    refused(
        &f,
        "POST",
        path,
        body(&back, &signed),
        &f.admin,
        StatusCode::CONFLICT,
        "RELEASE_KEY_IN_USE",
    )
    .await;
}

#[tokio::test]
async fn rolling_over_is_for_offline_custody() {
    let f = fixture().await;
    enable_server(&f).await;
    let next = team("next");
    let statement =
        agent_release::build_statement(&fingerprint("x"), &next.key, Utc::now().timestamp())
            .unwrap();
    refused(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rollover",
        json!({"statement":STANDARD.encode(&statement),"signature":STANDARD.encode([1u8; 64]),"current_password":PASSWORD}),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
}

#[tokio::test]
async fn revoking_a_key_withdraws_what_it_signed_ends_the_rollouts_that_offer_it_and_leaves_the_bundle()
 {
    let f = fixture().await;
    let first = enable_server(&f).await;
    let key = first["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let release = release(&f, "0.1.1", 1, &key, &[("linux", "amd64")]).await;
    let other = release_with(
        &f,
        "0.1.2",
        2,
        &key,
        &[("linux", "amd64")],
        "awaiting_signature",
        180,
    )
    .await;
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[&key])).await;
    let rollout = start(&f, &release.id, &[&edge], json!({})).await;
    let rollout = rollout["id"].as_str().unwrap().to_owned();
    step(&f, Utc::now()).await;
    assert!(
        report(&f, &edge, "0.1.0", &db_sha(), "boot", &member(&[&key]))
            .await
            .get("agent_update")
            .is_some()
    );
    let path = format!("/api/v1/agent-release-keys/{key}/revoke");
    let body = json!({"reason":"The laptop that held it was lost","current_password":PASSWORD});
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            &path,
            body.clone(),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    let mut wrong = body.clone();
    wrong["current_password"] = json!("wrong wrong wrong");
    refused(
        &f,
        "POST",
        &path,
        wrong,
        &f.admin,
        StatusCode::FORBIDDEN,
        "WRONG_PASSWORD",
    )
    .await;
    for bad in [
        json!({"current_password":PASSWORD}),
        json!({"reason":"","current_password":PASSWORD}),
        json!({"reason":"two\nlines","current_password":PASSWORD}),
        json!({"reason":"x".repeat(501),"current_password":PASSWORD}),
        json!({"reason":"fine"}),
    ] {
        refused(
            &f,
            "POST",
            &path,
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        "/api/v1/agent-release-keys/not-a-fingerprint/revoke",
        body.clone(),
        &f.admin,
        StatusCode::BAD_REQUEST,
        "INVALID_INPUT",
    )
    .await;
    refused(
        &f,
        "POST",
        &format!("/api/v1/agent-release-keys/{}/revoke", "0".repeat(64)),
        body.clone(),
        &f.admin,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    let revoked = ok(&f, "POST", &path, body.clone(), &f.admin).await;
    assert_eq!(revoked["state"], "revoked");
    assert_eq!(
        revoked["revoked_reason"],
        "The laptop that held it was lost"
    );
    assert!(revoked["revoked_at"].is_string());
    // No key is current, and the custody must be chosen again.
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(view["current_key"], Value::Null);
    assert_eq!(view["custody"], "server", "the custody stays what it was");
    assert_eq!(view["enabled"], true);
    // What it signed is withdrawn; what offered it ended; the device is offered nothing.
    let withdrawn = ok(
        &f,
        "GET",
        &format!("/api/v1/agent-releases/{}", release.id),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(withdrawn["state"], "withdrawn");
    assert!(
        withdrawn["withdrawn_reason"]
            .as_str()
            .unwrap()
            .contains("revoked")
    );
    let untouched = ok(
        &f,
        "GET",
        &format!("/api/v1/agent-releases/{}", other.id),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(
        untouched["state"], "awaiting_signature",
        "a release no key signed is not withdrawn"
    );
    let ended = ok(
        &f,
        "GET",
        &format!("/api/v1/agent-update-rollouts/{rollout}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(ended["status"], "cancelled");
    assert_eq!(ended["cancel_reason"], "key_revoked");
    assert_eq!(ended["state_counts"]["cancelled"], 1);
    assert!(
        report(&f, &edge, "0.1.0", &db_sha(), "boot", &member(&[&key]))
            .await
            .get("agent_update")
            .is_none()
    );
    assert!(!sealed(&f, &key).exists(), "the private half is wiped");
    // It leaves the bundle.
    let (status, _, bundled) = bundle(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bundled["keys"], json!([]));
    let rows = audits(&f, "agent_release_key.revoke").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], json!(key));
    assert_eq!(
        rows[0]["details"],
        json!({"fingerprint":key,"reason":"The laptop that held it was lost","withdrawn_releases":1,"cancelled_rollouts":1})
    );
    // A release cannot be prepared until a key is chosen again.
    mirror(&f, &[("0.1.3", "linux", "amd64", b"build".to_vec())]);
    refused(
        &f,
        "POST",
        "/api/v1/agent-releases",
        json!({"version":"0.1.3"}),
        &f.admin,
        StatusCode::CONFLICT,
        "CUSTODY_REQUIRED",
    )
    .await;
    refused(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
        StatusCode::CONFLICT,
        "CUSTODY_REQUIRED",
    )
    .await;
    // Already revoked.
    refused(
        &f,
        "POST",
        &path,
        body,
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    // Updates are on with no key: a custody has to be chosen, and a new key is made.
    let revision = view["revision"].as_i64().unwrap();
    let (status, value) = settings(&f, &f.admin, change(revision, true, None)).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("CUSTODY_REQUIRED"))
    );
    let (status, again) = settings(
        &f,
        &f.admin,
        change(revision, true, Some(json!({"kind":"server"}))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_ne!(again["current_key"]["fingerprint"], json!(key));
    assert_eq!(again["revision"], revision + 1);
    prepare(&f, "0.1.3").await;
}
fn db_sha() -> String {
    vectory_server::db::hash("running 0.1.0 linux amd64")
}

#[tokio::test]
async fn revoking_a_retired_key_removes_the_statements_it_signed_from_the_bundle() {
    let f = fixture().await;
    let first = enable_server(&f).await;
    let old = first["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let rotated = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let (_, _, before) = bundle(&f).await;
    assert_eq!(before["keys"].as_array().unwrap().len(), 2);
    assert_eq!(before["rollovers"].as_array().unwrap().len(), 1);
    ok(
        &f,
        "POST",
        &format!("/api/v1/agent-release-keys/{old}/revoke"),
        json!({"reason":"Retired and then lost","current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let (_, _, after) = bundle(&f).await;
    assert_eq!(after["keys"].as_array().unwrap().len(), 1);
    assert_eq!(after["keys"][0]["fingerprint"], rotated["fingerprint"]);
    assert_eq!(
        after["rollovers"],
        json!([]),
        "a statement the revoked key signed is gone"
    );
    // The key that replaced it is untouched: it is still current and signs.
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(view["current_key"]["fingerprint"], rotated["fingerprint"]);
    assert_eq!(
        view["revision"],
        first["revision"].as_i64().unwrap() + 1,
        "only the rotation advanced it"
    );
}

#[tokio::test]
async fn the_key_bundle_is_public_lists_what_is_not_revoked_and_says_nothing_of_custody() {
    let f = fixture().await;
    // Off: the route is not there.
    let (status, _, value) = bundle(&f).await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("NOT_FOUND"))
    );
    let owner = team("team");
    enable_offline(&f, &owner).await;
    let (status, headers, bundled) = bundle(&f).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(
        bundled,
        json!({
            "schema":"vectory.release-keys.v1",
            "keys":[{"public_key":owner.line(),"fingerprint":owner.fingerprint(),"state":"current"}],
            "rollovers":[],
        })
    );
    // Setup checks every entry, and so does the server before it serves one.
    for entry in bundled["keys"].as_array().unwrap() {
        agent_release::bundle_entry_matches(
            entry["public_key"].as_str().unwrap(),
            entry["fingerprint"].as_str().unwrap(),
        )
        .unwrap();
    }
    // A rollover adds the key and its statement; the old key stays, retired.
    let next = team("team-next");
    let statement =
        agent_release::build_statement(&owner.fingerprint(), &next.key, Utc::now().timestamp())
            .unwrap();
    let signature = agent_release::sign_rollover(&owner.seed, &statement).unwrap();
    ok(&f, "POST", "/api/v1/agent-release-keys/rollover", json!({"statement":STANDARD.encode(&statement),"signature":STANDARD.encode(signature),"current_password":PASSWORD}), &f.admin).await;
    let (_, _, bundled) = bundle(&f).await;
    assert_eq!(
        bundled["keys"],
        json!([
            {"public_key":next.line(),"fingerprint":next.fingerprint(),"state":"current"},
            {"public_key":owner.line(),"fingerprint":owner.fingerprint(),"state":"retired"},
        ])
    );
    assert_eq!(
        bundled["rollovers"],
        json!([{"statement":STANDARD.encode(&statement),"signature":STANDARD.encode(signature)}])
    );
    // Nothing in it tells who holds a key, who created it or what it signed.
    let text = bundled.to_string();
    for word in [
        "custody",
        "server",
        "offline",
        "created",
        "Synthetic",
        "admin",
    ] {
        assert!(!text.contains(word), "{word}");
    }
    // Public: no session, no client certificate. Turned off, it is gone again.
    switch(&f, false).await;
    let (status, _, _) = bundle(&f).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_key_bundle_does_not_tell_that_the_server_holds_a_key_it_made() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let first = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let rotated = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let second = rotated["fingerprint"].as_str().unwrap().to_owned();
    let (status, _, bundled) = bundle(&f).await;
    assert_eq!(status, StatusCode::OK);
    let lines: Vec<&str> = bundled["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key["public_key"].as_str().unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    // Each key is named by the start of its fingerprint: a name that says nothing
    // of who made it, to a peer that has no client certificate.
    for fingerprint in [&first, &second] {
        let line = lines
            .iter()
            .find(|line| ReleaseKey::parse(line).is_ok_and(|key| key.fingerprint() == fingerprint))
            .expect("the bundle lists the key");
        assert!(
            line.ends_with(&format!(" release-{}", &fingerprint[..8])),
            "{line}"
        );
    }
    let text = bundled.to_string();
    for word in ["server", "custody", "offline"] {
        assert!(!text.contains(word), "{word}: {text}");
    }
    // The signed-in view still says who holds each key.
    for key in keys(&f).await {
        assert_eq!(key["custody"], "server");
    }
}

#[tokio::test]
async fn the_key_bundle_is_rate_limited_like_the_installer() {
    let f = fixture_on().await;
    let router = device::router(f.state.clone());
    let mut last = StatusCode::OK;
    for _ in 0..301 {
        let (status, headers, _) =
            send(&router, "GET", "/agent/v1/release-keys", Value::Null, None).await;
        last = status;
        if status == StatusCode::TOO_MANY_REQUESTS {
            assert!(headers.contains_key("retry-after"));
            break;
        }
    }
    assert_eq!(
        last,
        StatusCode::TOO_MANY_REQUESTS,
        "an address gets 300 in ten minutes"
    );
}

#[tokio::test]
async fn a_key_lists_the_devices_that_pin_it_by_name() {
    let f = fixture_on().await;
    let key = fingerprint("team");
    for n in 0..25 {
        let id = device(&f, &format!("edge-{n:02}"), "0.1.0").await;
        store(&f, &id, &member(&[&key])).await;
    }
    let revoked = device(&f, "edge-zz", "0.1.0").await;
    store(&f, &revoked, &member(&[&key])).await;
    revoke(&f, &revoked).await;
    let unrelated = device(&f, "edge-yy", "0.1.0").await;
    store(&f, &unrelated, &member(&[&fingerprint("someone")])).await;
    let listed = keys(&f).await;
    assert_eq!(
        listed[0]["devices_pinning"], 25,
        "a revoked device is not counted"
    );
    let names = listed[0]["device_names"].as_array().unwrap();
    assert_eq!(names.len(), 20, "at most twenty names");
    assert_eq!(names[0], "edge-00");
    assert_eq!(names[19], "edge-19");
    // A device that sends no report pins nothing: the report is gone.
    let first = ok(&f, "GET", "/api/v1/devices", Value::Null, &f.viewer).await;
    let rows = first["items"].as_array().or(first.as_array()).unwrap();
    let gone = rows.iter().find(|row| row["name"] == "edge-00").unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    beat(&f, &gone, json!({})).await;
    assert_eq!(keys(&f).await[0]["devices_pinning"], 24);
}

#[tokio::test]
async fn the_prune_removes_sealed_files_that_no_current_key_of_the_server_owns() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let stray = sealed(&f, &fingerprint("a key that was never registered"));
    std::fs::write(&stray, b"left behind").unwrap();
    // A key retired by a rotation whose wipe failed.
    let rotated = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    std::fs::write(sealed(&f, &key), b"not wiped").unwrap();
    let other = std::path::Path::new(&f.temp.path()).join("state/keys/mfa-sealing.key");
    assert!(other.exists());
    vectory_server::rollout::prune(&f.state).await.unwrap();
    assert!(!stray.exists());
    assert!(!sealed(&f, &key).exists());
    assert!(
        sealed(&f, rotated["fingerprint"].as_str().unwrap()).exists(),
        "the current key keeps its file"
    );
    assert!(
        other.exists(),
        "nothing else under the keys directory is touched"
    );
}
