//! The review of an update rollout: who will update and who will not and why,
//! in the contract's order, the token that binds what the person saw to what
//! is created, and how a rollout is created from it.
use super::support::*;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The reasons in the order the contract tries them, as the groups are listed.
const ORDER: [&str; 18] = [
    "DEVICE_REVOKED",
    "AGENT_TOO_OLD",
    "PACKAGE_MANAGED",
    "NO_SERVICE",
    "UNTRUSTED_LOCATION",
    "READ_ONLY",
    "HELPER_NOT_RUNNING",
    "SERVICE_DEFINITION_OUTDATED",
    "PLATFORM_NOT_IN_RELEASE",
    "UPDATES_OFF",
    "KEY_ROLLOVER_CONFLICT",
    "KEY_NOT_PINNED",
    "RELEASE_ALREADY_TRIED",
    "COUNTER_REPLAYED",
    "ALREADY_RUNNING",
    "DOWNGRADE_REFUSED",
    "VERSION_NOT_ON_TRACK",
    "IN_ANOTHER_UPDATE",
];

/// Where each device of a review is: its name to the reason it will not update,
/// or none when it will.
fn places(review: &Value) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();
    for device in review["will_update"].as_array().unwrap() {
        let name = device["device_name"].as_str().unwrap().to_owned();
        assert!(out.insert(name.clone(), None).is_none(), "{name} twice");
    }
    for group in review["wont_update"].as_array().unwrap() {
        let code = group["code"].as_str().unwrap();
        for device in group["devices"].as_array().unwrap() {
            let name = device["device_name"].as_str().unwrap().to_owned();
            assert!(
                out.insert(name.clone(), Some(code.to_owned())).is_none(),
                "{name} twice"
            );
        }
    }
    out
}
fn names(devices: &Value) -> Vec<String> {
    devices
        .as_array()
        .unwrap()
        .iter()
        .map(|device| device["device_name"].as_str().unwrap().to_owned())
        .collect()
}

/// A device that stored `report` (none: it sent no `agent_update` member).
async fn host(f: &Fixture, name: &str, version: &str, report: Option<Value>) -> String {
    let id = device(f, name, version).await;
    if let Some(report) = report {
        store(f, &id, &report).await;
    }
    id
}

#[tokio::test]
async fn every_device_is_in_one_place_and_the_first_reason_in_the_contracts_order_wins() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let other = fingerprint("someone-else");
    let pins = [team.as_str()];
    let release = release(
        &f,
        "0.1.1",
        7,
        &team,
        &[("linux", "amd64"), ("windows", "amd64")],
    )
    .await;
    let good = member(&pins);
    let rolled_back = |digest: &str| json!({"release":digest,"outcome":"rolled_back","code":"UNHEALTHY","at":"2026-10-04T01:00:00Z","from_version":"0.1.0","to_version":"0.1.1"});

    let mut expected: BTreeMap<String, Option<&str>> = BTreeMap::new();
    let mut ids = Vec::new();
    // 2. no report: its agent does not speak updates.
    ids.push(host(&f, "silent", "0.1.0", None).await);
    expected.insert("silent".into(), Some("AGENT_TOO_OLD"));
    // 3. the device's own eligibility, whatever else is wrong with it.
    for (name, code) in [
        ("package", "PACKAGE_MANAGED"),
        ("service", "NO_SERVICE"),
        ("location", "UNTRUSTED_LOCATION"),
        ("readonly", "READ_ONLY"),
        ("helper", "HELPER_NOT_RUNNING"),
        ("definition", "SERVICE_DEFINITION_OUTDATED"),
        ("platform-reported", "PLATFORM_NOT_IN_RELEASE"),
    ] {
        let report = with(good.clone(), json!({"eligibility":code,"consent":"off"}));
        ids.push(host(&f, name, "0.1.0", Some(report)).await);
        expected.insert(name.into(), Some(code));
    }
    // 4. consent off.
    ids.push(
        host(
            &f,
            "consent-off",
            "0.1.0",
            Some(with(good.clone(), json!({"consent":"off"}))),
        )
        .await,
    );
    expected.insert("consent-off".into(), Some("UPDATES_OFF"));
    // 5. a fork in the chain, with an unpinned key besides.
    let fork = with(
        good.clone(),
        json!({
            "state":"refused","code":"KEY_ROLLOVER_CONFLICT",
            "rollover_conflict":{"from":team,"to":[fingerprint("fork-b"), fingerprint("fork-a")]},
            "keys":[other]
        }),
    );
    ids.push(host(&f, "fork", "0.1.0", Some(fork)).await);
    expected.insert("fork".into(), Some("KEY_ROLLOVER_CONFLICT"));
    // 6. the release has no file for this platform, and no key reaches it.
    let mac = device_on(&f, "mac", "0.1.0", "darwin", "arm64").await;
    store(&f, &mac, &with(good.clone(), json!({"keys":[other]}))).await;
    ids.push(mac);
    expected.insert("mac".into(), Some("PLATFORM_NOT_IN_RELEASE"));
    // 7. no pinned key reaches the signer, with a counter that replays besides.
    ids.push(
        host(
            &f,
            "unpinned",
            "0.1.0",
            Some(with(
                good.clone(),
                json!({"keys":[other],"highest_counter":9}),
            )),
        )
        .await,
    );
    expected.insert("unpinned".into(), Some("KEY_NOT_PINNED"));
    // 8. tried here and rolled back, and the counter is at the floor.
    let tried = with(
        good.clone(),
        json!({"highest_counter":7,"last":rolled_back(&release.manifest_sha256)}),
    );
    ids.push(host(&f, "tried", "0.1.0", Some(tried)).await);
    expected.insert("tried".into(), Some("RELEASE_ALREADY_TRIED"));
    // 9. a counter at or above this one; a rollback of another release changes
    // nothing about this one.
    ids.push(
        host(
            &f,
            "replayed",
            "0.1.0",
            Some(with(good.clone(), json!({"highest_counter":8}))),
        )
        .await,
    );
    expected.insert("replayed".into(), Some("COUNTER_REPLAYED"));
    let other_rollback = with(
        good.clone(),
        json!({"highest_counter":7,"last":rolled_back(&fingerprint("another-release"))}),
    );
    ids.push(host(&f, "tried-another", "0.1.0", Some(other_rollback)).await);
    expected.insert("tried-another".into(), Some("COUNTER_REPLAYED"));
    // The rollback of this release below the floor is not "tried": the floor
    // is what the host keeps.
    let below = with(
        good.clone(),
        json!({"highest_counter":6,"last":rolled_back(&release.manifest_sha256)}),
    );
    ids.push(host(&f, "tried-below", "0.1.0", Some(below)).await);
    expected.insert("tried-below".into(), None);
    // 10. already running, or newer.
    ids.push(host(&f, "running", "0.1.1", Some(good.clone())).await);
    expected.insert("running".into(), Some("ALREADY_RUNNING"));
    ids.push(host(&f, "newer", "0.1.2", Some(good.clone())).await);
    expected.insert("newer".into(), Some("DOWNGRADE_REFUSED"));
    ids.push(host(&f, "much-newer", "0.10.0", Some(good.clone())).await);
    expected.insert("much-newer".into(), Some("DOWNGRADE_REFUSED"));
    // 11. the track: `patch` keeps the running major and minor, `minor` the major.
    ids.push(host(&f, "off-track", "0.0.9", Some(good.clone())).await);
    expected.insert("off-track".into(), Some("VERSION_NOT_ON_TRACK"));
    ids.push(
        host(
            &f,
            "minor-track",
            "0.0.9",
            Some(with(good.clone(), json!({"track":"minor"}))),
        )
        .await,
    );
    expected.insert("minor-track".into(), None);
    ids.push(
        host(
            &f,
            "other-major",
            "1.0.0",
            Some(with(good.clone(), json!({"track":"minor"}))),
        )
        .await,
    );
    expected.insert("other-major".into(), Some("DOWNGRADE_REFUSED"));
    // Will update.
    ids.push(host(&f, "will-auto", "0.1.0", Some(good.clone())).await);
    expected.insert("will-auto".into(), None);
    ids.push(
        host(
            &f,
            "will-ask",
            "0.1.0",
            Some(with(good.clone(), json!({"consent":"ask"}))),
        )
        .await,
    );
    expected.insert("will-ask".into(), None);
    // 14. in another update rollout already.
    let busy = host(&f, "busy", "0.1.0", Some(good.clone())).await;
    let elsewhere = release_with(&f, "0.1.2", 8, &team, &[("linux", "amd64")], "ready", 180).await;
    start(&f, &elsewhere.id, &[&busy], json!({})).await;
    ids.push(busy);
    expected.insert("busy".into(), Some("IN_ANOTHER_UPDATE"));

    let refs: Vec<&String> = ids.iter().collect();
    let review = preview(&f, &release.id, &refs, json!({})).await;
    let got = places(&review);
    assert_eq!(got.len(), ids.len(), "every device appears exactly once");
    for (name, want) in &expected {
        assert_eq!(got.get(name), Some(&want.map(String::from)), "{name}");
    }

    // The groups are listed in the contract's order; a group holds its devices
    // by name.
    let listed: Vec<&str> = review["wont_update"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["code"].as_str().unwrap())
        .collect();
    let mut sorted = listed.clone();
    sorted.sort_by_key(|code| ORDER.iter().position(|known| known == code).unwrap());
    assert_eq!(listed, sorted);
    assert_eq!(listed.first(), Some(&"AGENT_TOO_OLD"));
    assert_eq!(
        names(&review["will_update"]),
        ["minor-track", "tried-below", "will-ask", "will-auto"]
    );
    let group = |code: &str| {
        review["wont_update"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["code"] == code)
            .unwrap_or_else(|| panic!("no group {code}"))
            .clone()
    };
    assert_eq!(
        names(&group("PLATFORM_NOT_IN_RELEASE")["devices"]),
        ["mac", "platform-reported"]
    );
    // Each group says why, and what to do on the host where something would help.
    for code in listed {
        let group = group(code);
        assert!(
            group["reason"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty()),
            "{code}"
        );
        assert!(
            group["fix"].is_null() || group["fix"].as_str().is_some(),
            "{code}"
        );
    }
    assert_eq!(
        group("UPDATES_OFF")["fix"],
        "Run the Upgrade agent command with updates on, once."
    );
    assert_eq!(group("ALREADY_RUNNING")["fix"], Value::Null);
    // A fork names its two successors, in ascending order; no other group does.
    let mut successors = vec![fingerprint("fork-a"), fingerprint("fork-b")];
    successors.sort();
    assert_eq!(
        group("KEY_ROLLOVER_CONFLICT")["devices"][0]["successors"],
        json!(successors)
    );
    assert_eq!(
        group("AGENT_TOO_OLD")["devices"][0]["successors"],
        Value::Null
    );

    // Each device who will update says how it takes an update.
    let by_name = |name: &str| {
        review["will_update"]
            .as_array()
            .unwrap()
            .iter()
            .find(|device| device["device_name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(by_name("will-auto")["consent"], "auto");
    assert_eq!(by_name("will-ask")["consent"], "ask");
    assert_eq!(by_name("will-auto")["windows"], json!([]));
    assert_eq!(by_name("will-auto")["next_window_at"], Value::Null);
    assert_eq!(
        review["release"],
        json!({"id":release.id,"version":"0.1.1","counter":7,"manifest_sha256":release.manifest_sha256})
    );
    assert!(
        review["review_token"]
            .as_str()
            .is_some_and(|token| token.len() == 64)
    );
}

#[tokio::test]
async fn the_release_decides_the_rest_of_the_reasons() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    // A release that needs agents of 0.2.3 or later, and a newer service
    // definition than 1.
    let release = release(&f, "0.2.5", 3, &team, &[("linux", "amd64")]).await;
    sqlx::query("UPDATE agent_releases SET min_from='0.2.3',service_definition=2 WHERE id=?")
        .bind(&release.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let too_old = host(&f, "too-old", "0.2.1", Some(member(&pins))).await;
    let outdated = host(
        &f,
        "outdated",
        "0.2.4",
        Some(with(member(&pins), json!({"service_definition":1}))),
    )
    .await;
    let current = host(
        &f,
        "current",
        "0.2.4",
        Some(with(member(&pins), json!({"service_definition":2}))),
    )
    .await;
    let review = preview(&f, &release.id, &[&too_old, &outdated, &current], json!({})).await;
    let got = places(&review);
    assert_eq!(got["too-old"].as_deref(), Some("AGENT_TOO_OLD"));
    assert_eq!(
        got["outdated"].as_deref(),
        Some("SERVICE_DEFINITION_OUTDATED")
    );
    assert_eq!(got["current"], None);
}

#[tokio::test]
async fn a_key_reaches_the_signer_by_itself_or_through_the_stored_statements() {
    let f = fixture().await;
    let old = key(&f, "old", "server", "retired").await;
    let middle = key(&f, "middle", "server", "retired").await;
    let signer = key(&f, "team", "server", "current").await;
    introduce(&f, "middle", "old").await;
    introduce(&f, "team", "middle").await;
    switch(&f, true).await;
    let release = release(&f, "0.1.1", 7, &signer, &[("linux", "amd64")]).await;
    let on_old = host(&f, "on-old", "0.1.0", Some(member(&[&old]))).await;
    let on_middle = host(&f, "on-middle", "0.1.0", Some(member(&[&middle]))).await;
    let on_signer = host(&f, "on-signer", "0.1.0", Some(member(&[&signer]))).await;
    let stranger = host(
        &f,
        "stranger",
        "0.1.0",
        Some(member(&[&fingerprint("nobody")])),
    )
    .await;
    let none = host(&f, "no-pins", "0.1.0", Some(member::<&str>(&[]))).await;
    let review = preview(
        &f,
        &release.id,
        &[&on_old, &on_middle, &on_signer, &stranger, &none],
        json!({}),
    )
    .await;
    let got = places(&review);
    for name in ["on-old", "on-middle", "on-signer"] {
        assert_eq!(got[name], None, "{name} reaches the signer");
    }
    for name in ["stranger", "no-pins"] {
        assert_eq!(got[name].as_deref(), Some("KEY_NOT_PINNED"), "{name}");
    }
    // A revoked key's statements are not followed.
    sqlx::query("UPDATE agent_release_keys SET state='revoked',revoked_at=? WHERE fingerprint=?")
        .bind("2026-10-04T00:00:00Z")
        .bind(&middle)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let review = preview(
        &f,
        &release.id,
        &[&on_old, &on_middle, &on_signer],
        json!({}),
    )
    .await;
    let got = places(&review);
    assert_eq!(got["on-old"].as_deref(), Some("KEY_NOT_PINNED"));
    assert_eq!(got["on-middle"].as_deref(), Some("KEY_NOT_PINNED"));
    assert_eq!(got["on-signer"], None);
}

#[tokio::test]
async fn a_device_more_than_eight_statements_behind_is_not_offered_the_release() {
    let f = fixture().await;
    // A chain of ten keys, each introduced by the one before.
    let labels: Vec<String> = (0..10).map(|n| format!("k{n}")).collect();
    for (n, label) in labels.iter().enumerate() {
        key(
            &f,
            label,
            "server",
            if n == 9 { "current" } else { "retired" },
        )
        .await;
        if n > 0 {
            introduce(&f, label, &labels[n - 1]).await;
        }
    }
    switch(&f, true).await;
    let signer = fingerprint("k9");
    let release = release(&f, "0.1.1", 7, &signer, &[("linux", "amd64")]).await;
    // k1 is eight statements from k9; k0 is nine.
    let near = host(&f, "near", "0.1.0", Some(member(&[&fingerprint("k1")]))).await;
    let far = host(&f, "far", "0.1.0", Some(member(&[&fingerprint("k0")]))).await;
    let review = preview(&f, &release.id, &[&near, &far], json!({})).await;
    let got = places(&review);
    assert_eq!(got["near"], None);
    assert_eq!(got["far"].as_deref(), Some("KEY_NOT_PINNED"));
}

#[tokio::test]
async fn warnings_name_the_devices_that_will_wait_or_are_not_checking_in() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let online = host(&f, "online", "0.1.0", Some(member(&pins))).await;
    let late = host(&f, "late", "0.1.0", Some(member(&pins))).await;
    seen(&f, &late, "2020-01-01T00:00:00Z").await;
    let ask = host(
        &f,
        "ask",
        "0.1.0",
        Some(with(member(&pins), json!({"consent":"ask"}))),
    )
    .await;
    let windowed = host(&f, "windowed", "0.1.0", Some(with(member(&pins), json!({"windows":["Mon-Fri 02:00-04:00 UTC"],"window_open":false,"next_window_at":"2026-10-05T02:00:00Z"})))).await;
    let in_window = host(
        &f,
        "in-window",
        "0.1.0",
        Some(with(
            member(&pins),
            json!({"windows":["daily 00:00-23:59 UTC"],"window_open":true}),
        )),
    )
    .await;
    let paused = host(
        &f,
        "paused",
        "0.1.0",
        Some(with(
            member(&pins),
            json!({"paused":true,"state":"idle","code":"UPDATES_PAUSED"}),
        )),
    )
    .await;
    let review = preview(
        &f,
        &release.id,
        &[&online, &late, &ask, &windowed, &in_window, &paused],
        json!({}),
    )
    .await;
    let warning = |code: &str| {
        review["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|warning| warning["code"] == code)
            .map(|warning| {
                assert!(warning["message"].as_str().is_some_and(|m| !m.is_empty()));
                names(&warning["devices"])
            })
    };
    assert_eq!(warning("OFFLINE"), Some(vec!["late".to_owned()]));
    assert_eq!(warning("WAITS_FOR_HOST"), Some(vec!["ask".to_owned()]));
    assert_eq!(
        warning("WAITS_FOR_WINDOW"),
        Some(vec!["windowed".to_owned()])
    );
    assert_eq!(warning("PAUSED_ON_HOST"), Some(vec!["paused".to_owned()]));
    // Every one of them is still a device that will update.
    let got = places(&review);
    for name in ["online", "late", "ask", "windowed", "in-window", "paused"] {
        assert_eq!(got[name], None, "{name}");
    }
    let windowed = review["will_update"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["device_name"] == "windowed")
        .unwrap()
        .clone();
    assert_eq!(windowed["windows"], json!(["Mon-Fri 02:00-04:00 UTC"]));
    assert_eq!(windowed["next_window_at"], "2026-10-05T02:00:00Z");
    // With nobody to warn about there is no warning.
    let calm = preview(&f, &release.id, &[&online], json!({})).await;
    assert_eq!(calm["warnings"], json!([]));
}

#[tokio::test]
async fn the_canary_is_the_devices_the_request_named_then_the_best_of_the_rest() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let b = host(&f, "b", "0.1.0", Some(member(&pins))).await;
    let c = host(&f, "c", "0.1.0", Some(member(&pins))).await;
    let review = preview(&f, &release.id, &[&a, &b, &c], json!({"canary_size":2})).await;
    assert_eq!(review["canary"]["size"], 2);
    assert_eq!(review["canary"]["chosen_by_you"], false);
    assert_eq!(review["canary"]["device_ids"].as_array().unwrap().len(), 2);
    // Named devices go first, in the order given; the best fill the rest.
    let named = preview(
        &f,
        &release.id,
        &[&a, &b, &c],
        json!({"canary_size":2,"canary_device_ids":[c]}),
    )
    .await;
    assert_eq!(named["canary"]["chosen_by_you"], true);
    assert_eq!(named["canary"]["device_ids"][0], json!(c));
    assert_eq!(named["canary"]["device_ids"].as_array().unwrap().len(), 2);
    // A canary that is not a target, or is named twice, or too many, is refused.
    let stranger = host(&f, "stranger", "0.1.0", Some(member(&pins))).await;
    for rollout in [
        json!({"canary_device_ids":[stranger]}),
        json!({"canary_device_ids":[a,a],"canary_size":2}),
        json!({"canary_device_ids":[a,b],"canary_size":1}),
        json!({"canary_device_ids":["not-a-uuid"]}),
        json!({"canary_device_ids":[a.to_uppercase()]}),
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            request(&release.id, &[&a, &b, &c], rollout.clone()),
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
}

#[tokio::test]
async fn the_settings_of_a_rollout_take_their_defaults_and_refuse_what_is_out_of_range() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let started = start(&f, &release.id, &[&a], json!({})).await;
    assert_eq!(
        started["rollout"],
        json!({"canary_size":1,"batch_size":10,"observation_seconds":300,"failure_threshold":0})
    );
    for rollout in [
        json!({"canary_size":0}),
        json!({"canary_size":101}),
        json!({"batch_size":0}),
        json!({"batch_size":51}),
        json!({"observation_seconds":59}),
        json!({"observation_seconds":86401}),
        json!({"failure_threshold":-1}),
        json!({"failure_threshold":101}),
        json!({"canary_size":"1"}),
        json!({"canary_size":1.5}),
        json!({"surprise":1}),
        json!([]),
        json!(null),
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            request(&release.id, &[&a], rollout.clone()),
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    let edges = json!({"canary_size":100,"batch_size":50,"observation_seconds":86400,"failure_threshold":100});
    let review = preview(&f, &release.id, &[&a], edges).await;
    assert!(review["review_token"].is_string());
}

#[tokio::test]
async fn previewing_is_for_operators_writes_nothing_and_needs_a_release_that_can_roll_out() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let ready = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let body = request(&ready.id, &[&a], json!({}));
    for who in [&f.viewer, &f.editor] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            body.clone(),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        body.clone(),
        Some((&f.operator.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no CSRF token");
    ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        body.clone(),
        &f.admin,
    )
    .await;
    ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        body.clone(),
        &f.operator,
    )
    .await;
    for count in [
        "SELECT count(*) FROM agent_update_rollouts",
        "SELECT count(*) FROM agent_update_targets",
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action') LIKE 'agent_update_rollout.%'",
    ] {
        let n: i64 = sqlx::query_scalar(count)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{count}");
    }
    // A release that is not ready cannot be reviewed for a rollout.
    let waiting = release_with(
        &f,
        "0.1.2",
        8,
        &team,
        &[("linux", "amd64")],
        "awaiting_signature",
        180,
    )
    .await;
    let withdrawn = release_with(
        &f,
        "0.1.3",
        9,
        &team,
        &[("linux", "amd64")],
        "withdrawn",
        180,
    )
    .await;
    let expired = release_with(&f, "0.1.4", 10, &team, &[("linux", "amd64")], "ready", -1).await;
    for release in [&waiting, &withdrawn, &expired] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            request(&release.id, &[&a], json!({})),
            &f.operator,
            StatusCode::CONFLICT,
            "RELEASE_NOT_READY",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        request("00000000-0000-4000-8000-000000000009", &[&a], json!({})),
        &f.operator,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    // Malformed requests.
    for bad in [
        json!({}),
        json!({"release_id":ready.id}),
        json!({"release_id":ready.id,"selector":{"device_ids":[a],"group_ids":[],"exclude_ids":[]}}),
        json!({"release_id":ready.id,"selector":"all","rollout":{}}),
        json!({"release_id":ready.id.to_uppercase(),"selector":{"device_ids":[a],"group_ids":[],"exclude_ids":[]},"rollout":{}}),
        json!({"release_id":ready.id,"selector":{"device_ids":[a],"group_ids":[],"exclude_ids":[],"everyone":true},"rollout":{}}),
        json!({"release_id":ready.id,"selector":{"device_ids":[a],"group_ids":[],"exclude_ids":[]},"rollout":{},"review_token":"x"}),
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            bad,
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
}

#[tokio::test]
async fn the_token_binds_the_release_the_settings_and_who_will_and_will_not_update() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let b = host(&f, "b", "0.1.0", Some(with(member(&pins), json!({"windows":["daily 01:00-02:00 UTC"],"window_open":false,"next_window_at":"2026-10-05T01:00:00Z"})))).await;
    let c = host(&f, "c", "0.1.1", Some(member(&pins))).await;
    let token = |review: &Value| review["review_token"].as_str().unwrap().to_owned();
    let base = token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await);
    // The same request gives the same token, whatever the order of the lists.
    assert_eq!(
        token(&preview(&f, &release.id, &[&c, &b, &a], json!({})).await),
        base
    );
    // What changes with the clock is not in it: the next window, the check-in.
    store(&f, &b, &with(member(&pins), json!({"windows":["daily 01:00-02:00 UTC"],"window_open":false,"next_window_at":"2026-10-06T01:00:00Z"}))).await;
    seen(&f, &a, "2026-10-04T00:00:00Z").await;
    seen(&f, &a, &db_now()).await;
    assert_eq!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await),
        base
    );
    // The settings are.
    assert_ne!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({"batch_size":5})).await),
        base
    );
    assert_ne!(
        token(
            &preview(
                &f,
                &release.id,
                &[&a, &b, &c],
                json!({"canary_device_ids":[a]})
            )
            .await
        ),
        base
    );
    // So is who will update: a device that leaves the sets, and one that moves
    // from one to the other.
    assert_ne!(
        token(&preview(&f, &release.id, &[&a, &b], json!({})).await),
        base
    );
    store(&f, &a, &with(member(&pins), json!({"consent":"off"}))).await;
    assert_ne!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await),
        base
    );
    store(&f, &a, &member(&pins)).await;
    assert_eq!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await),
        base
    );
    // And the level and windows a device applies under.
    store(&f, &a, &with(member(&pins), json!({"consent":"ask"}))).await;
    assert_ne!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await),
        base
    );
    store(
        &f,
        &a,
        &with(member(&pins), json!({"windows":["daily 03:00-04:00 UTC"]})),
    )
    .await;
    assert_ne!(
        token(&preview(&f, &release.id, &[&a, &b, &c], json!({})).await),
        base
    );
    store(&f, &a, &member(&pins)).await;
    // Another release gives another token.
    let next = release_with(&f, "0.1.2", 8, &team, &[("linux", "amd64")], "ready", 180).await;
    assert_ne!(
        token(&preview(&f, &next.id, &[&a, &b, &c], json!({})).await),
        base
    );
}
fn db_now() -> String {
    vectory_server::db::now()
}

#[tokio::test]
async fn creating_rechecks_the_review_in_the_writer_and_creates_exactly_what_was_reviewed() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let b = host(&f, "b", "0.1.0", Some(member(&pins))).await;
    let c = host(&f, "c", "0.1.1", Some(member(&pins))).await;
    let review = preview(&f, &release.id, &[&a, &b, &c], json!({})).await;
    let body = |token: &Value| {
        let mut body = request(&release.id, &[&a, &b, &c], json!({}));
        body["review_token"] = token.clone();
        body
    };
    // Only operators and administrators; CSRF; the members, exactly.
    for who in [&f.viewer, &f.editor] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts",
            body(&review["review_token"]),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        "/api/v1/agent-update-rollouts",
        body(&review["review_token"]),
        Some((&f.operator.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for bad in [
        {
            let mut b = body(&review["review_token"]);
            b.as_object_mut().unwrap().remove("review_token");
            b
        },
        body(&json!("not-a-token")),
        body(&json!(db_hash_of("x").to_uppercase())),
        {
            let mut b = body(&review["review_token"]);
            b["surprise"] = json!(1);
            b
        },
        {
            let mut b = body(&review["review_token"]);
            b["name"] = json!("");
            b
        },
        {
            let mut b = body(&review["review_token"]);
            b["name"] = json!("x".repeat(121));
            b
        },
        {
            let mut b = body(&review["review_token"]);
            b["name"] = json!("two\nlines");
            b
        },
        {
            let mut b = body(&review["review_token"]);
            b["request_id"] = json!("not-a-uuid");
            b
        },
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts",
            bad,
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    // A token of another review creates nothing.
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body(&json!(db_hash_of("another review"))),
        &f.operator,
        StatusCode::CONFLICT,
        "UPDATE_REVIEW_CHANGED",
    )
    .await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_update_rollouts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    let mut ask = body(&review["review_token"]);
    ask["name"] = json!("  Spring update  ");
    let created = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        ask,
        &f.operator,
    )
    .await;
    assert_eq!(
        created["name"], "  Spring update  ",
        "a name is kept as it was sent"
    );
    assert_eq!(created["status"], "active");
    assert_eq!(
        created["release"],
        json!({"id":release.id,"version":"0.1.1","counter":7,"manifest_sha256":release.manifest_sha256})
    );
    assert_eq!(
        created["selector"],
        json!({"device_ids":[a,b,c],"group_ids":[],"exclude_ids":[]})
    );
    assert_eq!(
        created["target_count"], 2,
        "only the devices that will update are targets"
    );
    assert_eq!(created["state_counts"]["pending"], 2);
    assert_eq!(created["state_counts"].as_object().unwrap().len(), 14);
    assert_eq!(created["degraded"], 0);
    assert_eq!(created["created_by_name"], "Synthetic operator");
    for member in [
        "failure_reason",
        "cancel_reason",
        "paused_at",
        "completed_at",
        "failed_at",
        "cancelled_at",
        "observation_started_at",
    ] {
        assert_eq!(created[member], Value::Null, "{member}");
    }
    assert_eq!(created["revision"], 1);
    // The device that already runs the release is not a target.
    let targets: Vec<String> = sqlx::query_scalar(
        "SELECT device_id FROM agent_update_targets WHERE rollout_id=? ORDER BY device_id",
    )
    .bind(created["id"].as_str().unwrap())
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    let mut want = vec![a.clone(), b.clone()];
    want.sort();
    assert_eq!(targets, want);
    let rows = audits(&f, "agent_update_rollout.create").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], created["id"]);
    assert_eq!(rows[0]["details"]["release_id"], json!(release.id));
    assert_eq!(rows[0]["details"]["version"], "0.1.1");

    // The same review again: both devices are in the rollout now, so the review
    // is another one, and the rollout that overlaps this one is not created.
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body(&review["review_token"]),
        &f.operator,
        StatusCode::CONFLICT,
        "UPDATE_ROLLOUT_OVERLAP",
    )
    .await;
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_update_rollouts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // A fresh review of them has nobody left.
    let fresh = preview(&f, &release.id, &[&a, &b, &c], json!({})).await;
    assert_eq!(fresh["will_update"], json!([]));
    let mut again = request(&release.id, &[&a, &b, &c], json!({}));
    again["review_token"] = fresh["review_token"].clone();
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        again,
        &f.operator,
        StatusCode::CONFLICT,
        "NOTHING_TO_UPDATE",
    )
    .await;
}
fn db_hash_of(text: &str) -> String {
    vectory_server::db::hash(text)
}

#[tokio::test]
async fn a_review_that_changed_is_refused_and_a_stopped_server_or_a_release_that_cannot_roll_out_starts_nothing()
 {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let b = host(&f, "b", "0.1.0", Some(member(&pins))).await;
    let review = preview(&f, &release.id, &[&a, &b], json!({})).await;
    let mut body = request(&release.id, &[&a, &b], json!({}));
    body["review_token"] = review["review_token"].clone();
    let count = |f: &Fixture| {
        let pool = f.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM agent_update_rollouts")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    // A device's report changed since: the review is another.
    store(&f, &b, &with(member(&pins), json!({"consent":"off"}))).await;
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
        StatusCode::CONFLICT,
        "UPDATE_REVIEW_CHANGED",
    )
    .await;
    store(&f, &b, &member(&pins)).await;
    // A device checked in later than the review: nothing it is bound to changed.
    seen(&f, &b, &db_now()).await;
    // Stopped: no new rollout.
    ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"hold"}),
        &f.operator,
    )
    .await;
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
        StatusCode::CONFLICT,
        "AGENT_UPDATES_STOPPED",
    )
    .await;
    assert_eq!(count(&f).await, 0);
    let stop = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stop["revision"]}),
        &f.admin,
    )
    .await;
    // The release was withdrawn since the review.
    sqlx::query("UPDATE agent_releases SET state='withdrawn' WHERE id=?")
        .bind(&release.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
        StatusCode::CONFLICT,
        "RELEASE_NOT_READY",
    )
    .await;
    sqlx::query("UPDATE agent_releases SET state='ready' WHERE id=?")
        .bind(&release.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    // And an unknown release is not found.
    let mut unknown = body.clone();
    unknown["release_id"] = json!("00000000-0000-4000-8000-000000000009");
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        unknown,
        &f.operator,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    assert_eq!(count(&f).await, 0);
    // Everything restored, the same token starts it.
    ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body,
        &f.operator,
    )
    .await;
    assert_eq!(count(&f).await, 1);
}

#[tokio::test]
async fn a_request_id_makes_a_retry_return_the_original_rollout() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&pins))).await;
    let b = host(&f, "b", "0.1.0", Some(member(&pins))).await;
    let review = preview(&f, &release.id, &[&a, &b], json!({})).await;
    let id = "6f1f0cc6-2b9f-4a52-8d2d-8f3d5b1f9a10";
    let mut body = request(&release.id, &[&a, &b], json!({}));
    body["review_token"] = review["review_token"].clone();
    body["request_id"] = json!(id);
    let first = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
    )
    .await;
    assert_eq!(first["request_id"], id);
    // The identical retry returns the original, before the token is rechecked
    // (the rollout it made has changed the review) and before any fresh
    // validation of the release or the selector.
    let retry = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
    )
    .await;
    assert_eq!(retry["id"], first["id"]);
    assert_eq!(retry["request_id"], id);
    sqlx::query("UPDATE agent_releases SET state='withdrawn' WHERE id=?")
        .bind(&release.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let retry = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        &f.operator,
    )
    .await;
    assert_eq!(retry["id"], first["id"]);
    sqlx::query("UPDATE agent_releases SET state='ready' WHERE id=?")
        .bind(&release.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_update_rollouts")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // The digest sorts keys and keeps null apart from omission: a different
    // body with the same request ID is a conflict, a re-ordered one is not.
    let mut other = body.clone();
    other["rollout"] = json!({"batch_size":3});
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        other,
        &f.operator,
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
    )
    .await;
    let mut named = body.clone();
    named["name"] = json!("A name");
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        named,
        &f.operator,
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
    )
    .await;
    let mut nulled = body.clone();
    nulled["name"] = Value::Null;
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        nulled,
        &f.operator,
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
    )
    .await;
    let reordered: Value = serde_json::from_str(&format!(
        r#"{{"request_id":"{id}","review_token":{},"rollout":{{}},"selector":{{"exclude_ids":[],"group_ids":[],"device_ids":{}}},"release_id":"{}"}}"#,
        review["review_token"], json!([a, b]), release.id
    ))
    .unwrap();
    let retry = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        reordered,
        &f.operator,
    )
    .await;
    assert_eq!(retry["id"], first["id"]);
    // The identity is the actor's: another actor with the same ID makes its own.
    let c = host(&f, "c", "0.1.0", Some(member(&pins))).await;
    let mut theirs = request(&release.id, &[&c], json!({}));
    theirs["review_token"] =
        preview(&f, &release.id, &[&c], json!({})).await["review_token"].clone();
    theirs["request_id"] = json!(id);
    let made = ok(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts",
        theirs,
        &f.admin,
    )
    .await;
    assert_ne!(made["id"], first["id"]);
}

#[tokio::test]
async fn a_selector_that_names_a_revoked_or_unknown_device_is_refused_as_deployments_do() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let a = host(&f, "a", "0.1.0", Some(member(&[&team]))).await;
    let gone = host(&f, "gone", "0.1.0", Some(member(&[&team]))).await;
    revoke(&f, &gone).await;
    for devices in [
        vec![&a, &gone],
        vec![&"00000000-0000-4000-8000-0000000000aa".to_owned()],
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-update-rollouts/preview",
            request(&release.id, &devices, json!({})),
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
}

#[test]
fn a_revoked_device_is_refused_before_anything_else_is_asked() {
    use vectory_server::{
        agent_releases::Release,
        agent_updates::{Facts, Statements, review::refusal},
    };
    let release = Release {
        id: "r".into(),
        version: "0.1.1".into(),
        counter: 7,
        manifest_sha256: "m".into(),
        state: "ready".into(),
        issued_at: "2026-10-03T12:00:00Z".into(),
        expires_at: "2027-04-01T12:00:00Z".into(),
        min_from: None,
        service_definition: 1,
        signer: Some("s".into()),
        prepared_by_name: None,
        prepared_at: "2026-10-03T12:00:00Z".into(),
        withdrawn_at: None,
        withdrawn_reason: None,
        artifacts: Vec::new(),
    };
    let facts = |revoked: bool, report: Option<Value>| Facts {
        id: "d".into(),
        name: "d".into(),
        revoked,
        os: "linux".into(),
        arch: "amd64".into(),
        agent_version: Some("0.1.0".into()),
        agent_sha256: None,
        last_seen: None,
        interval: 60,
        report,
        elsewhere: true,
    };
    let none = Statements::default();
    // Revoked, with no report and in another rollout: the first reason is it.
    assert_eq!(
        refusal(&facts(true, None), &release, &none).unwrap().code,
        "DEVICE_REVOKED"
    );
    // The same device, not revoked, is not a device that speaks updates.
    assert_eq!(
        refusal(&facts(false, None), &release, &none).unwrap().code,
        "AGENT_TOO_OLD"
    );
}
