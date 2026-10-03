//! The setting: what it says while updates are off and on, who may read and
//! change it, and Stop all updates.
use super::support::*;
use axum::http::StatusCode;
use serde_json::{Value, json};

const ROUTES_OFF: [(&str, &str); 14] = [
    ("GET", "/api/v1/agent-release-keys"),
    ("GET", "/api/v1/agent-releases"),
    (
        "GET",
        "/api/v1/agent-releases/00000000-0000-4000-8000-000000000001",
    ),
    (
        "GET",
        "/api/v1/agent-releases/00000000-0000-4000-8000-000000000001/manifest",
    ),
    ("GET", "/api/v1/agent-update-rollouts"),
    ("POST", "/api/v1/agent-update-rollouts/preview"),
    ("POST", "/api/v1/agent-update-rollouts"),
    (
        "GET",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001",
    ),
    (
        "GET",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001/targets",
    ),
    (
        "POST",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001/pause",
    ),
    (
        "POST",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001/resume",
    ),
    (
        "POST",
        "/api/v1/agent-update-rollouts/00000000-0000-4000-8000-000000000001/cancel",
    ),
    ("POST", "/api/v1/agent-updates/stop"),
    ("POST", "/api/v1/agent-updates/stop/clear"),
];

#[tokio::test]
async fn while_updates_are_off_only_the_setting_answers() {
    let f = fixture().await;
    for who in [&f.viewer, &f.editor, &f.operator, &f.admin] {
        let value = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, who).await;
        assert_eq!(
            value,
            json!({
                "enabled":false,"custody":null,"revision":0,"current_key":null,"stopped":null,
                "active_rollouts":0,"fleet":null,"catalog":null
            })
        );
    }
    let (status, _, _) = send(&f.app, "GET", "/api/v1/agent-updates", Value::Null, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for (method, path) in ROUTES_OFF {
        // Whatever the body, while updates are off the answer is the same.
        for body in [
            Value::Null,
            json!({}),
            json!({"reason":"x"}),
            json!("not an object"),
        ] {
            let value = refused(
                &f,
                method,
                path,
                body,
                &f.admin,
                StatusCode::NOT_FOUND,
                "AGENT_UPDATES_OFF",
            )
            .await;
            assert!(
                value["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Agent updates are off")
            );
        }
    }
    // A malformed query is the same answer.
    refused(
        &f,
        "GET",
        "/api/v1/agent-update-rollouts?page=zero&page=2",
        Value::Null,
        &f.viewer,
        StatusCode::NOT_FOUND,
        "AGENT_UPDATES_OFF",
    )
    .await;
}

#[tokio::test]
async fn the_setting_keeps_its_key_and_custody_while_off_and_shows_neither_fleet_nor_catalog() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let on = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(on["enabled"], true);
    assert_eq!(on["custody"], "server");
    assert_eq!(on["current_key"]["fingerprint"], team);
    assert_eq!(on["current_key"]["state"], "current");
    assert!(on["fleet"].is_object() && on["catalog"].is_array());
    switch(&f, false).await;
    let off = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    assert_eq!(off["enabled"], false);
    assert_eq!(
        off["custody"], "server",
        "custody stays when updates are turned off"
    );
    assert_eq!(
        off["current_key"]["fingerprint"], team,
        "and so does the key"
    );
    assert_eq!(off["fleet"], Value::Null);
    assert_eq!(off["catalog"], Value::Null);
    // The revision moved with the switches, and only with them.
    assert!(off["revision"].as_i64().unwrap() > on["revision"].as_i64().unwrap());
}

#[tokio::test]
async fn the_fleet_puts_every_device_in_exactly_one_level_and_lists_versions_newest_first() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let pins = [team.as_str()];
    // Not reported.
    device(&f, "a-silent", "0.1.0").await;
    // Cannot update, whatever the level: eligibility comes before consent.
    let blocked = device(&f, "b-blocked", "0.1.0").await;
    store(
        &f,
        &blocked,
        &with(member(&pins), json!({"eligibility":"PACKAGE_MANAGED"})),
    )
    .await;
    let blocked_off = device(&f, "c-blocked-off", "0.1.0").await;
    store(
        &f,
        &blocked_off,
        &with(
            member(&pins),
            json!({"eligibility":"NO_SERVICE","consent":"off","state":"idle"}),
        ),
    )
    .await;
    // Off, ask, automatic.
    let off = device(&f, "d-off", "0.1.1").await;
    store(&f, &off, &with(member(&pins), json!({"consent":"off"}))).await;
    let ask = device(&f, "e-ask", "0.1.1").await;
    store(&f, &ask, &with(member(&pins), json!({"consent":"ask"}))).await;
    let auto = device(&f, "f-auto", "0.10.0").await;
    store(&f, &auto, &member(&pins)).await;
    // A version that is not one counts under "unknown", last; so does none.
    let odd = device(&f, "g-odd", "dev-build").await;
    store(&f, &odd, &member(&pins)).await;
    let none = device(&f, "h-none", "0.1.0").await;
    sqlx::query("UPDATE devices SET data=json_remove(data,'$.agent_version') WHERE id=?")
        .bind(&none)
        .execute(&f.state.pool)
        .await
        .unwrap();
    // A revoked device is in no count.
    let gone = device(&f, "i-gone", "0.0.9").await;
    store(&f, &gone, &member(&pins)).await;
    revoke(&f, &gone).await;
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    let fleet = &view["fleet"];
    assert_eq!(fleet["devices_total"], 8);
    assert_eq!(
        fleet["levels"],
        json!({"automatic":2,"ask":1,"off":1,"cannot_update":2,"not_reported":2})
    );
    let levels: i64 = fleet["levels"]
        .as_object()
        .unwrap()
        .values()
        .map(|n| n.as_i64().unwrap())
        .sum();
    assert_eq!(levels, 8, "the five levels add up to the devices");
    // Versions compare as numbers: 0.10.0 is newer than 0.1.1.
    assert_eq!(
        fleet["versions"],
        json!([
            {"version":"0.10.0","devices":1},
            {"version":"0.1.1","devices":2},
            {"version":"0.1.0","devices":3},
            {"version":"unknown","devices":2},
        ])
    );
}

#[tokio::test]
async fn the_catalog_lists_the_builds_newer_than_a_device_with_their_release() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    mirror(
        &f,
        &[
            ("0.1.0", "linux", "amd64", b"old".to_vec()),
            ("0.1.1", "linux", "amd64", b"one".to_vec()),
            ("0.1.1", "darwin", "arm64", b"two".to_vec()),
            ("0.1.1", "linux", "arm64", b"three".to_vec()),
            ("0.2.0", "linux", "amd64", b"four".to_vec()),
            ("0.3.0-rc1", "linux", "amd64", b"pre".to_vec()),
        ],
    );
    device(&f, "edge-00", "0.1.0").await;
    device(&f, "edge-01", "0.1.1").await;
    let withdrawn = release_with(
        &f,
        "0.1.1",
        1,
        &team,
        &[("linux", "amd64")],
        "withdrawn",
        180,
    )
    .await;
    let newest = release(&f, "0.2.0", 2, &team, &[("linux", "amd64")]).await;
    let view = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    let catalog = view["catalog"].as_array().unwrap();
    // 0.2.0 is ahead of both devices, 0.1.1 of one; 0.1.0 of none, and a
    // pre-release is never a version this feature ships.
    assert_eq!(catalog.len(), 2, "{catalog:?}");
    assert_eq!(catalog[0]["version"], "0.2.0");
    assert_eq!(catalog[0]["devices_behind"], 2);
    assert_eq!(
        catalog[0]["platforms"],
        json!([{"os":"linux","arch":"amd64"}])
    );
    assert_eq!(
        catalog[0]["release"],
        json!({"id":newest.id,"state":"ready"})
    );
    assert_eq!(catalog[1]["version"], "0.1.1");
    assert_eq!(catalog[1]["devices_behind"], 1);
    assert_eq!(
        catalog[1]["platforms"],
        json!([{"os":"linux","arch":"amd64"},{"os":"linux","arch":"arm64"},{"os":"darwin","arch":"arm64"}])
    );
    assert_eq!(
        catalog[1]["release"],
        Value::Null,
        "a withdrawn release is not the release"
    );
    let _ = withdrawn;
}

#[tokio::test]
async fn stop_all_updates_is_for_operators_and_clearing_it_for_administrators() {
    let f = fixture_on().await;
    let before = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    for who in [&f.viewer, &f.editor] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-updates/stop",
            json!({"reason":"x"}),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    // No CSRF token, no change.
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"x"}),
        Some((&f.operator.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for bad in [
        json!({}),
        json!({"reason":""}),
        json!({"reason":"   "}),
        json!({"reason":"two\nlines"}),
        json!({"reason":"x".repeat(501)}),
        json!({"reason":7}),
        json!({"reason":"fine","extra":true}),
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-updates/stop",
            bad,
            &f.operator,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    let unchanged = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    assert_eq!(unchanged, before, "nothing above changed anything");
    assert!(audits(&f, "agent_update.stop").await.is_empty());

    let stopped = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"  Vector 0.59 is out  "}),
        &f.operator,
    )
    .await;
    assert_eq!(stopped["stopped"]["reason"], "Vector 0.59 is out");
    assert_eq!(stopped["stopped"]["by_name"], "Synthetic operator");
    assert!(stopped["stopped"]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        stopped["revision"],
        before["revision"].as_i64().unwrap() + 1
    );
    // Stopping a stopped server changes nothing and keeps the first reason.
    let again = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"another"}),
        &f.admin,
    )
    .await;
    assert_eq!(again, stopped);
    let rows = audits(&f, "agent_update.stop").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["actor"], f.operator.id);
    assert_eq!(rows[0]["target"], "server");
    assert_eq!(rows[0]["details"]["reason"], "Vector 0.59 is out");
    assert_eq!(rows[0]["details"]["cancelled_rollouts"], 0);

    // Clearing: an Administrator, with the current revision, once.
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-updates/stop/clear",
            json!({"revision":stopped["revision"]}),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stopped["revision"].as_i64().unwrap() - 1}),
        &f.admin,
        StatusCode::CONFLICT,
        "STALE_REVISION",
    )
    .await;
    for bad in [
        json!({}),
        json!({"revision":"1"}),
        json!({"revision":-1}),
        json!({"revision":1.5}),
        json!({"revision":1,"extra":1}),
    ] {
        refused(
            &f,
            "POST",
            "/api/v1/agent-updates/stop/clear",
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    let cleared = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stopped["revision"]}),
        &f.admin,
    )
    .await;
    assert_eq!(cleared["stopped"], Value::Null);
    assert_eq!(
        cleared["revision"],
        stopped["revision"].as_i64().unwrap() + 1
    );
    refused(
        &f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":cleared["revision"]}),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    let rows = audits(&f, "agent_update.stop_clear").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["actor"], f.admin.id);
    // The stop can be set again, and keeps its own reason.
    let second = ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Again"}),
        &f.operator,
    )
    .await;
    assert_eq!(second["stopped"]["reason"], "Again");
}
