//! What the server does with the heartbeat member `agent_update`: the shared
//! cases decide what it accepts, a refusal changes nothing, and what it stores
//! is exactly what the host sent.
use super::support::*;
use axum::http::StatusCode;
use serde_json::{Value, json};
use vectory_server::agent_updates;

fn shared() -> Value {
    serde_json::from_str(include_str!(
        "../../../contracts/fixtures/agent-release/report.json"
    ))
    .expect("the fixture is JSON")
}

#[test]
fn every_shared_case_is_decided_as_the_fixture_says() {
    let fixture = shared();
    let cases = fixture["members"].as_array().expect("members");
    assert!(cases.len() > 60, "the fixture holds the shared cases");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let heartbeat = json!({"agent_update": case["member"]});
        let verdict = agent_updates::parse(&heartbeat);
        match case["accepted"].as_bool().unwrap() {
            true => {
                let report = verdict
                    .unwrap_or_else(|e| panic!("{name} is refused: {}", e.message))
                    .unwrap_or_else(|| panic!("{name} is read as absent"));
                // What is kept is what the host sent, without the members it
                // left null.
                let sent = case["member"].as_object().unwrap();
                let kept = report.member().as_object().unwrap();
                for (key, value) in sent {
                    assert_eq!(
                        kept.get(key),
                        (!value.is_null()).then_some(value),
                        "{name}: {key}"
                    );
                }
            }
            false => {
                let error = verdict
                    .err()
                    .unwrap_or_else(|| panic!("{name} is accepted"));
                assert_eq!(error.status, StatusCode::BAD_REQUEST, "{name}");
                assert_eq!(error.code, "INVALID_INPUT", "{name}");
            }
        }
    }
}

#[test]
fn the_bounds_are_the_fixtures() {
    let fixture = shared();
    let bounds = &fixture["bounds"];
    let base = |extra: Value| {
        let mut member = member::<&str>(&[]);
        member["service_definition"] = json!(1);
        with(member, extra)
    };
    let accepts = |member: Value| agent_updates::parse(&json!({"agent_update": member})).is_ok();
    let key = |n: usize| db_hash(n);
    let keys = |count: usize| (0..count).map(key).collect::<Vec<_>>();
    let most = bounds["keys"].as_u64().unwrap() as usize;
    assert!(accepts(base(json!({"keys": keys(most)}))));
    assert!(!accepts(base(json!({"keys": keys(most + 1)}))));
    let windows = bounds["windows"].as_u64().unwrap() as usize;
    assert!(accepts(base(
        json!({"windows": vec!["daily 01:00-02:00"; windows]})
    )));
    assert!(!accepts(base(
        json!({"windows": vec!["daily 01:00-02:00"; windows + 1]})
    )));
    let longest = bounds["window_characters"].as_u64().unwrap() as usize;
    assert!(accepts(base(json!({"windows": ["x".repeat(longest)]}))));
    assert!(!accepts(base(
        json!({"windows": ["x".repeat(longest + 1)]})
    )));
    let counter = bounds["highest_counter"].as_u64().unwrap();
    assert!(accepts(base(json!({"highest_counter": counter}))));
    assert!(!accepts(base(json!({"highest_counter": counter + 1}))));
    let definition = bounds["service_definition"].as_u64().unwrap();
    assert!(accepts(base(json!({"service_definition": definition}))));
    assert!(!accepts(base(
        json!({"service_definition": definition + 1})
    )));
    assert!(!accepts(base(json!({"service_definition": 0}))));
}
fn db_hash(n: usize) -> String {
    vectory_server::db::hash(format!("key {n}"))
}

#[test]
fn an_absent_or_null_member_is_no_report() {
    assert!(agent_updates::parse(&json!({})).unwrap().is_none());
    assert!(
        agent_updates::parse(&json!({"agent_update": null}))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_refused_member_refuses_the_whole_check_in_and_changes_nothing() {
    let f = fixture_on().await;
    let device = device(&f, "edge-00", "0.1.0").await;
    let key = fingerprint("team");
    let good = member(&[&key]);
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &good).await;
    let stored = |f: &Fixture| {
        let pool = f.state.pool.clone();
        let device = device.clone();
        async move {
            sqlx::query_as::<_, (String, String)>(
                "SELECT report,reported_at FROM agent_update_reports WHERE device_id=?",
            )
            .bind(device)
            .fetch_optional(&pool)
            .await
            .unwrap()
        }
    };
    let before = stored(&f).await.expect("a stored report");
    let record: String = sqlx::query_scalar("SELECT data FROM devices WHERE id=?")
        .bind(&device)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    for bad in [
        with(good.clone(), json!({"consent": "sometimes"})),
        with(good.clone(), json!({"track": "major"})),
        with(good.clone(), json!({"surprise": true})),
        with(good.clone(), json!({"state": "staged"})),
        json!([]),
        json!("auto"),
        json!(7),
    ] {
        let (status, body) = beat(
            &f,
            &device,
            json!({"agent_version":"0.2.0","boot_id":"boot-b","agent_update":bad}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {body}");
        assert_eq!(body["error"]["code"], "INVALID_INPUT");
        assert_eq!(stored(&f).await, Some(before.clone()), "{bad}");
        let after: String = sqlx::query_scalar("SELECT data FROM devices WHERE id=?")
            .bind(&device)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
        assert_eq!(after, record, "a refused check-in leaves the device alone");
    }
}

#[tokio::test]
async fn a_check_in_without_the_member_removes_the_stored_report() {
    let f = fixture_on().await;
    let device = device(&f, "edge-00", "0.1.0").await;
    let good = member(&[&fingerprint("team")]);
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &good).await;
    let count = |f: &Fixture| {
        let pool = f.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM agent_update_reports")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(count(&f).await, 1);
    let (status, _) = beat(&f, &device, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&f).await, 0, "never inferred, never stale");
    // A null member counts as absent.
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &good).await;
    let (status, _) = beat(&f, &device, json!({"agent_update": null})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(count(&f).await, 0);
}

#[tokio::test]
async fn the_member_is_stored_as_the_device_sent_it_and_shown_while_updates_are_on() {
    let f = fixture_on().await;
    let device = device(&f, "edge-00", "0.1.0").await;
    let key = fingerprint("team");
    let sent = with(
        member(&[&key]),
        json!({"windows":["Mon-Fri 02:00-04:00 UTC"],"window_open":false,"next_window_at":"2026-10-05T02:00:00Z","highest_counter":6}),
    );
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &sent).await;
    let shown = ok(
        &f,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    let update = &shown["agent_update"];
    assert_eq!(update["consent"], "auto");
    assert_eq!(update["windows"], json!(["Mon-Fri 02:00-04:00 UTC"]));
    assert_eq!(update["window_open"], false);
    assert_eq!(update["next_window_at"], "2026-10-05T02:00:00Z");
    assert_eq!(update["keys"], json!([key]));
    assert_eq!(update["eligibility"], "eligible");
    assert_eq!(update["state"], "idle");
    assert_eq!(update["release_version"], Value::Null);
    assert_eq!(update["code"], Value::Null);
    assert_eq!(update["rollover_conflict"], Value::Null);
    assert_eq!(update["last"], Value::Null);
    assert!(update["reported_at"].is_string());
    // Exactly the members the contract lists.
    let mut names: Vec<&String> = update.as_object().unwrap().keys().collect();
    names.sort();
    assert_eq!(
        names,
        [
            "code",
            "consent",
            "eligibility",
            "keys",
            "last",
            "next_window_at",
            "paused",
            "release_version",
            "reported_at",
            "rollover_conflict",
            "state",
            "track",
            "window_open",
            "windows"
        ]
    );
    // Off: the member is not shown, and a report is not even asked for.
    switch(&f, false).await;
    let shown = ok(
        &f,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert!(shown.get("agent_update").is_none());
    // The list rows never carry it.
    switch(&f, true).await;
    let list = ok(&f, "GET", "/api/v1/devices", Value::Null, &f.viewer).await;
    let rows = list["items"].as_array().or(list.as_array()).expect("rows");
    assert!(rows.iter().all(|row| row.get("agent_update").is_none()));
}

#[tokio::test]
async fn the_release_version_names_the_release_a_report_is_about() {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let release = release(&f, "0.1.1", 7, &team, &[("linux", "amd64")]).await;
    let device = device(&f, "edge-00", "0.1.0").await;
    let sent = with(
        member(&[&team]),
        json!({"state":"downloading","release":release.manifest_sha256}),
    );
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &sent).await;
    let shown = ok(
        &f,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(shown["agent_update"]["release_version"], "0.1.1");
    // A digest this server never prepared names no version.
    let sent = with(
        member(&[&team]),
        json!({"state":"downloading","release":db_hash(99)}),
    );
    report(&f, &device, "0.1.0", &db_hash(0), "boot-a", &sent).await;
    let shown = ok(
        &f,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(shown["agent_update"]["release_version"], Value::Null);
}

#[tokio::test]
async fn while_updates_are_off_the_manifest_lists_nothing_and_offers_nothing() {
    let f = fixture().await;
    let device = device(&f, "edge-00", "0.1.0").await;
    let (status, manifest) = beat(&f, &device, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let features = manifest["features"].as_array().unwrap();
    assert!(!features.iter().any(|name| name == "agent_update"));
    assert!(manifest.get("agent_update").is_none());
    switch(&f, true).await;
    let (_, manifest) = beat(&f, &device, json!({})).await;
    assert!(
        manifest["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "agent_update")
    );
    assert!(
        manifest.get("agent_update").is_none(),
        "no rollout, no offer"
    );
}

/// The reports the server keeps.
async fn kept(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM agent_update_reports")
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn while_updates_are_off_the_member_is_ignored_and_the_stored_reports_go() {
    let f = fixture_on().await;
    let key = fingerprint("team");
    let first = device(&f, "edge-00", "0.1.0").await;
    let second = device(&f, "edge-01", "0.1.0").await;
    report(&f, &first, "0.1.0", &db_hash(0), "boot-a", &member(&[&key])).await;
    report(
        &f,
        &second,
        "0.1.0",
        &db_hash(1),
        "boot-b",
        &member(&[&key]),
    )
    .await;
    assert_eq!(kept(&f).await, 2);
    // Turning updates off keeps no report of what hosts said about them.
    let current = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    ok(
        &f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":false,"current_password":PASSWORD,"revision":current["revision"]}),
        &f.admin,
    )
    .await;
    assert_eq!(kept(&f).await, 0);
    // While they are off, a member is not read: a malformed one is no reason to
    // refuse a check-in, and neither it nor a valid one is stored.
    for sent in [
        with(member(&[&key]), json!({"consent":"sometimes"})),
        json!({"surprise":true}),
        json!([]),
        with(member(&[&key]), json!({"highest_counter":4242})),
    ] {
        let (status, manifest) = beat(
            &f,
            &first,
            json!({"agent_version":"0.1.0","boot_id":"boot-a","agent_update":sent}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{sent}: {manifest}");
        assert!(manifest.get("agent_update").is_none());
        assert_eq!(kept(&f).await, 0, "{sent}");
    }
    // The check-in's own handling keeps nothing while they are off either,
    // whoever hands it a report.
    let handed = agent_updates::parse(&json!({"agent_update": member(&[&key])}))
        .unwrap()
        .unwrap();
    let mut conn = f.state.pool.acquire().await.unwrap();
    let outcome = agent_updates::heartbeat(
        &mut conn,
        &f.state,
        "2026-10-03T12:00:00Z",
        &agent_updates::Build {
            device_id: &first,
            agent_version: "0.1.0",
            agent_sha256: None,
            boot_id: "boot-a",
        },
        Some(&handed),
    )
    .await
    .unwrap();
    drop(conn);
    assert!(!outcome.enabled && outcome.offer.is_none());
    assert_eq!(kept(&f).await, 0);
    // What a host said while they were off moves nothing when they are on: the
    // next release counter is one more than the sequence.
    switch(&f, true).await;
    let mut conn = f.state.pool.acquire().await.unwrap();
    assert_eq!(
        agent_updates::next_counter(&mut conn, 0).await.unwrap(),
        1,
        "a counter a host sent while updates were off is not heard"
    );
    drop(conn);
    // On, the member is read again, strictly; a stop doesn't change that.
    ok(
        &f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"hold"}),
        &f.operator,
    )
    .await;
    let (status, _) = beat(
        &f,
        &first,
        json!({"agent_update": with(member(&[&key]), json!({"consent":"sometimes"}))}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    report(&f, &first, "0.1.0", &db_hash(0), "boot-a", &member(&[&key])).await;
    assert_eq!(kept(&f).await, 1);
}
