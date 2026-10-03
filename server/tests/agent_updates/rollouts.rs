//! Reading update rollouts: the list and the targets of one, with the query
//! rules of the deployment history (a trimmed literal search, an exact status or
//! state, bounded pages, and a refusal of what the route does not take).
use super::{engine::Rig, support::*};
use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{Value, json};

const LIST: &str = "/api/v1/agent-update-rollouts";

/// A rollout of `devices`, reviewed and started, with the name given.
async fn start_named(
    f: &Fixture,
    release: &str,
    devices: &[&String],
    name: Option<&str>,
    rollout: Value,
) -> String {
    let review = preview(f, release, devices, rollout.clone()).await;
    let mut body = request(release, devices, rollout);
    body["review_token"] = review["review_token"].clone();
    if let Some(name) = name {
        body["name"] = json!(name);
    }
    ok(f, "POST", LIST, body, &f.operator).await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
async fn page(f: &Fixture, path: &str, query: &str) -> Value {
    ok(f, "GET", &format!("{path}?{query}"), Value::Null, &f.viewer).await
}
async fn refusal(f: &Fixture, path: &str, query: &str) -> Value {
    refused(
        f,
        "GET",
        &format!("{path}?{query}"),
        Value::Null,
        &f.viewer,
        StatusCode::BAD_REQUEST,
        "INVALID_INPUT",
    )
    .await
}
fn ids_of(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_owned())
        .collect()
}
/// The IDs a page is expected to hold, in order.
fn ids(want: &[&String]) -> Vec<String> {
    want.iter().map(|id| (*id).clone()).collect()
}
fn names_of(page: &Value) -> Vec<String> {
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["device_name"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_list_pages_searches_and_filters_by_the_rules_of_the_deployment_history() {
    let r = Rig::build(5).await;
    let second = release(&r.f, "0.1.2", 8, &r.team, &[("linux", "amd64")]).await;
    let devices = &r.ids;
    let one = start_named(
        &r.f,
        &r.release.id,
        &[&devices[0], &devices[1]],
        Some("Edge fleet"),
        json!({}),
    )
    .await;
    let two = start_named(
        &r.f,
        &r.release.id,
        &[&devices[2], &devices[3]],
        None,
        json!({}),
    )
    .await;
    let three = start_named(
        &r.f,
        &second.id,
        &[&devices[4]],
        Some("Canary of 0.1.2"),
        json!({}),
    )
    .await;
    // Creation times a second apart would make the order depend on the clock:
    // give each its own day.
    for (id, at) in [
        (&one, "2026-10-01T10:00:00Z"),
        (&two, "2026-10-02T10:00:00Z"),
        (&three, "2026-10-03T10:00:00Z"),
    ] {
        sqlx::query("UPDATE agent_update_rollouts SET created_at=? WHERE id=?")
            .bind(at)
            .bind(id)
            .execute(&r.f.state.pool)
            .await
            .unwrap();
    }
    ok(
        &r.f,
        "POST",
        &format!("{LIST}/{two}/cancel"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    ok(
        &r.f,
        "POST",
        &format!("{LIST}/{three}/pause"),
        Value::Null,
        &r.f.operator,
    )
    .await;

    // Newest first, with the members the contract names.
    let all = page(&r.f, LIST, "").await;
    assert_eq!(all["total"], 3);
    assert_eq!(all["page"], 1);
    assert_eq!(all["page_size"], 12);
    assert_eq!(ids_of(&all), ids(&[&three, &two, &one]));
    let first = all["items"][0].as_object().unwrap();
    let mut members: Vec<&str> = first.keys().map(String::as_str).collect();
    members.sort_unstable();
    let mut wanted = [
        "id",
        "name",
        "release",
        "selector",
        "rollout",
        "status",
        "failure_reason",
        "cancel_reason",
        "revision",
        "created_at",
        "created_by_name",
        "paused_at",
        "completed_at",
        "failed_at",
        "cancelled_at",
        "observation_started_at",
        "target_count",
        "state_counts",
        "degraded",
    ];
    wanted.sort_unstable();
    assert_eq!(members, wanted);
    assert_eq!(all["items"][0]["status"], "paused");
    assert_eq!(all["items"][1]["status"], "cancelled");
    assert_eq!(all["items"][1]["cancel_reason"], "operator");
    assert_eq!(all["items"][1]["name"], Value::Null);
    assert_eq!(all["items"][2]["name"], "Edge fleet");
    assert_eq!(all["items"][2]["release"]["version"], "0.1.1");
    assert_eq!(all["items"][2]["target_count"], 2);

    // The status is exact.
    for (status, want) in [
        ("active", vec![&one]),
        ("paused", vec![&three]),
        ("cancelled", vec![&two]),
        ("completed", vec![]),
        ("failed", vec![]),
    ] {
        assert_eq!(
            ids_of(&page(&r.f, LIST, &format!("status={status}")).await),
            ids(&want),
            "{status}"
        );
    }
    for bad in ["bogus", "Active", "", "active%20"] {
        refusal(&r.f, LIST, &format!("status={bad}")).await;
    }

    // The search is a literal substring of the name or of the release's version,
    // trimmed and ASCII case-insensitive; a wildcard is a character.
    for (search, want) in [
        ("EDGE", vec![&one]),
        ("fleet", vec![&one]),
        ("%20edge%20", vec![&one]),
        ("canary", vec![&three]),
        ("0.1.2", vec![&three]),
        ("0.1.1", vec![&two, &one]),
        ("0.1", vec![&three, &two, &one]),
        ("nothing", vec![]),
        ("%25", vec![]),
        ("_", vec![]),
        ("e%25", vec![]),
    ] {
        assert_eq!(
            ids_of(&page(&r.f, LIST, &format!("search={search}")).await),
            ids(&want),
            "{search}"
        );
    }
    assert_eq!(
        page(&r.f, LIST, &format!("search={}", "a".repeat(200))).await["total"],
        0
    );
    refusal(&r.f, LIST, &format!("search={}", "a".repeat(201))).await;

    // A release is a lowercase UUID.
    assert_eq!(
        ids_of(&page(&r.f, LIST, &format!("release_id={}", r.release.id)).await),
        ids(&[&two, &one])
    );
    assert_eq!(
        ids_of(&page(&r.f, LIST, &format!("release_id={}", second.id)).await),
        ids(&[&three])
    );
    assert_eq!(
        page(
            &r.f,
            LIST,
            "release_id=00000000-0000-4000-8000-000000000001"
        )
        .await["total"],
        0
    );
    for bad in [
        r.release.id.to_uppercase(),
        "not-a-uuid".to_owned(),
        String::new(),
    ] {
        refusal(&r.f, LIST, &format!("release_id={bad}")).await;
    }

    // Pages of 1 to 50, and the total is the same whichever page is read.
    let first = page(&r.f, LIST, "page_size=1").await;
    assert_eq!(
        (first["total"].clone(), ids_of(&first)),
        (json!(3), vec![three.clone()])
    );
    let second_page = page(&r.f, LIST, "page=2&page_size=1").await;
    assert_eq!(second_page["page"], 2);
    assert_eq!(second_page["total"], 3);
    assert_eq!(ids_of(&second_page), ids(&[&two]));
    let beyond = page(&r.f, LIST, "page=4&page_size=1").await;
    assert_eq!(
        (beyond["total"].clone(), ids_of(&beyond)),
        (json!(3), vec![])
    );
    assert_eq!(page(&r.f, LIST, "page_size=50").await["page_size"], 50);
    for bad in [
        "page_size=0",
        "page_size=51",
        "page=0",
        "page=-1",
        "page=1.5",
        "page=one",
    ] {
        refusal(&r.f, LIST, bad).await;
    }

    // What the route does not take, or takes twice, or cannot decode, is refused.
    for bad in [
        "page=1&page=2",
        "status=active&status=paused",
        "unknown=1",
        "sort=name",
        "search=%zz",
        "search=%ff",
        "search=%",
    ] {
        refusal(&r.f, LIST, bad).await;
    }
    // Every signed-in role reads; nobody else does.
    for who in [&r.f.viewer, &r.f.editor, &r.f.operator, &r.f.admin] {
        assert_eq!(ok(&r.f, "GET", LIST, Value::Null, who).await["total"], 3);
    }
    let (status, _, _) = send(&r.f.app, "GET", LIST, Value::Null, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_targets_page_by_the_name_a_device_had_and_say_where_each_one_is() {
    let r = Rig::build(5).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // The names the rollout will keep: edge-00 to edge-04, as the rig made them.
    let mut by_name = std::collections::BTreeMap::new();
    for id in &r.ids {
        let name: String = sqlx::query_scalar("SELECT name FROM devices WHERE id=?")
            .bind(id)
            .fetch_one(&r.f.state.pool)
            .await
            .unwrap();
        by_name.insert(name, id.clone());
    }
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":2,"batch_size":2,"observation_seconds":60,"failure_threshold":10}),
        )
        .await;
    let path = format!("{LIST}/{rollout}/targets");
    // Before a stage is released every target is pending, with no stage, no
    // version it updates from and no time.
    let waiting = page(&r.f, &path, "").await;
    assert_eq!(waiting["total"], 5);
    assert_eq!(waiting["page"], 1);
    assert_eq!(waiting["page_size"], 12);
    for item in waiting["items"].as_array().unwrap() {
        assert_eq!(item["state"], "pending");
        for none in [
            "stage",
            "code",
            "from_version",
            "released_at",
            "verified_at",
        ] {
            assert_eq!(item[none], Value::Null, "{none}");
        }
        assert_eq!(item["to_version"], "0.1.1");
    }
    step(&r.f, Utc::now()).await;
    let released: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    assert_eq!(released.len(), 2);
    r.apply(&rollout, &released[0]).await;
    // A device that is renamed afterwards is still the name it had when the
    // rollout was made.
    let renamed = &by_name["edge-00"];
    sqlx::query("UPDATE devices SET name='renamed-later',data=json_set(data,'$.name','renamed-later') WHERE id=?")
        .bind(renamed)
        .execute(&r.f.state.pool)
        .await
        .unwrap();

    let all = page(&r.f, &path, "").await;
    assert_eq!(
        names_of(&all),
        ["edge-00", "edge-01", "edge-02", "edge-03", "edge-04"],
        "by name, as it was"
    );
    let mut members: Vec<&str> = all["items"][0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    members.sort_unstable();
    let mut wanted = [
        "device_id",
        "device_name",
        "stage",
        "state",
        "code",
        "from_version",
        "to_version",
        "released_at",
        "updated_at",
        "verified_at",
    ];
    wanted.sort_unstable();
    assert_eq!(members, wanted);
    for item in all["items"].as_array().unwrap() {
        let id = item["device_id"].as_str().unwrap();
        assert_eq!(by_name[item["device_name"].as_str().unwrap()], id);
        if released.iter().any(|released| released == id) {
            // The canary stage has index 0, and the version it ran when it was
            // released is where the update goes from.
            assert_eq!(item["stage"], 0);
            assert_eq!(item["from_version"], "0.1.0");
            assert!(item["released_at"].is_string());
            assert!(item["state"] == "offered" || item["state"] == "applying");
        } else {
            assert_eq!(item["stage"], Value::Null);
            assert_eq!(item["state"], "pending");
            assert_eq!(item["from_version"], Value::Null);
        }
        assert!(item["updated_at"].is_string());
        assert_eq!(item["verified_at"], Value::Null);
    }

    // The state is exact, and the search is a literal of the name it had.
    assert_eq!(page(&r.f, &path, "state=pending").await["total"], 3);
    assert_eq!(page(&r.f, &path, "state=applying").await["total"], 1);
    assert_eq!(page(&r.f, &path, "state=offered").await["total"], 1);
    assert_eq!(page(&r.f, &path, "state=verified").await["total"], 0);
    assert_eq!(page(&r.f, &path, "state=").await["total"], 5);
    for bad in ["bogus", "Pending", "pending%20"] {
        refusal(&r.f, &path, &format!("state={bad}")).await;
    }
    assert_eq!(
        names_of(&page(&r.f, &path, "search=EDGE-03").await),
        ["edge-03"]
    );
    assert_eq!(
        names_of(&page(&r.f, &path, "search=%20edge-03%20").await),
        ["edge-03"],
        "trimmed"
    );
    assert_eq!(
        names_of(&page(&r.f, &path, "search=edge-00").await),
        ["edge-00"],
        "the name it had"
    );
    assert_eq!(page(&r.f, &path, "search=renamed").await["total"], 0);
    assert_eq!(page(&r.f, &path, "search=%25").await["total"], 0);
    assert_eq!(
        page(&r.f, &path, "search=edge&state=pending").await["total"],
        3
    );

    // The order is by name unless another is asked for; ties keep the device ID.
    assert_eq!(
        names_of(&page(&r.f, &path, "sort=device_name&direction=desc").await),
        ["edge-04", "edge-03", "edge-02", "edge-01", "edge-00"]
    );
    let by_state = page(&r.f, &path, "sort=state&direction=asc").await;
    let states: Vec<&str> = by_state["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["state"].as_str().unwrap())
        .collect();
    let mut sorted = states.clone();
    sorted.sort_unstable();
    assert_eq!(states, sorted, "by state");
    let latest = page(&r.f, &path, "sort=updated_at&direction=desc").await;
    let times: Vec<&str> = latest["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["updated_at"].as_str().unwrap())
        .collect();
    let mut descending = times.clone();
    descending.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(times, descending, "newest change first");

    // Pages, the total and what the route refuses.
    let second_page = page(&r.f, &path, "page=2&page_size=2&sort=device_name").await;
    assert_eq!(names_of(&second_page), ["edge-02", "edge-03"]);
    assert_eq!(second_page["total"], 5);
    assert_eq!(second_page["page"], 2);
    assert_eq!(
        names_of(&page(&r.f, &path, "page=3&page_size=2").await),
        ["edge-04"]
    );
    assert_eq!(page(&r.f, &path, "page=9&page_size=2").await["total"], 5);
    assert_eq!(page(&r.f, &path, "page_size=50").await["page_size"], 50);
    let long = format!("search={}", "a".repeat(201));
    for bad in [
        "page_size=0",
        "page_size=51",
        "page=0",
        "sort=name",
        "sort=",
        "direction=up",
        "direction=ASC",
        "state=pending&state=offered",
        "page=1&page=2",
        "unknown=1",
        "search=%ff",
        long.as_str(),
    ] {
        refusal(&r.f, &path, bad).await;
    }
    // An unknown rollout is not found, whatever the query; every role reads.
    refused(
        &r.f,
        "GET",
        &format!("{LIST}/00000000-0000-4000-8000-000000000001/targets"),
        Value::Null,
        &r.f.viewer,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    for who in [&r.f.viewer, &r.f.editor, &r.f.operator, &r.f.admin] {
        assert_eq!(ok(&r.f, "GET", &path, Value::Null, who).await["total"], 5);
    }
    let (status, _, _) = send(&r.f.app, "GET", &path, Value::Null, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// What a stage of a rollout page says, as one comparable row: kind, index,
/// state, size, devices listed and the ones that are not.
fn shape(stage: &Value) -> (String, i64, String, i64, usize, i64) {
    (
        stage["kind"].as_str().unwrap().to_owned(),
        stage["index"].as_i64().unwrap(),
        stage["state"].as_str().unwrap().to_owned(),
        stage["size"].as_i64().unwrap(),
        stage["devices"].as_array().unwrap().len(),
        stage["more"].as_i64().unwrap(),
    )
}
fn row(
    kind: &str,
    index: i64,
    state: &str,
    size: i64,
    listed: usize,
    more: i64,
) -> (String, i64, String, i64, usize, i64) {
    (kind.to_owned(), index, state.to_owned(), size, listed, more)
}

#[tokio::test]
async fn the_rollout_page_lists_every_stage_in_release_order_with_what_waits_and_what_stopped() {
    let r = Rig::build(9).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":2,"batch_size":3,"observation_seconds":60,"failure_threshold":100}),
        )
        .await;
    // Nothing is released: the stages it will make, 2 and 3 and 3 and 1, are
    // queued, each with its devices still to be chosen.
    let detail = r.show(&rollout).await;
    let stages = detail["stages"].as_array().unwrap();
    assert_eq!(
        stages.iter().map(shape).collect::<Vec<_>>(),
        [
            row("canary", 0, "queued", 2, 0, 2),
            row("batch", 1, "queued", 3, 0, 3),
            row("batch", 2, "queued", 3, 0, 3),
            row("batch", 3, "queued", 1, 0, 1),
        ]
    );
    for stage in stages {
        assert_eq!(stage["released_at"], Value::Null);
        assert_eq!(stage["counts"], json!({"pending": stage["size"]}));
    }
    assert_eq!(detail["failures"], json!([]));
    assert_eq!(
        detail["check_in_seconds"], 60,
        "the interval a device has when its settings name none"
    );
    let evaluated = chrono::DateTime::parse_from_rfc3339(detail["evaluated_at"].as_str().unwrap())
        .unwrap()
        .with_timezone(&Utc);
    assert!(
        (Utc::now() - evaluated).num_seconds().abs() < 30,
        "{detail}"
    );
    // The longest check-in interval among the targets that have one.
    for (device, seconds) in [(&r.ids[0], 45), (&r.ids[1], 120), (&r.ids[2], 30)] {
        sqlx::query("UPDATE devices SET policy=? WHERE id=?")
            .bind(json!({"heartbeat_seconds":seconds}).to_string())
            .bind(device)
            .execute(&r.f.state.pool)
            .await
            .unwrap();
    }
    assert_eq!(r.show(&rollout).await["check_in_seconds"], 120);

    // The canary is released: its devices are listed with their states, and the
    // rest wait.
    step(&r.f, Utc::now()).await;
    let detail = r.show(&rollout).await;
    let stages = detail["stages"].as_array().unwrap();
    assert_eq!(
        stages.iter().map(shape).collect::<Vec<_>>(),
        [
            row("canary", 0, "in_progress", 2, 2, 0),
            row("batch", 1, "queued", 3, 0, 3),
            row("batch", 2, "queued", 3, 0, 3),
            row("batch", 3, "queued", 1, 0, 1),
        ]
    );
    assert_eq!(stages[0]["counts"], json!({"offered": 2}));
    assert!(stages[0]["released_at"].is_string());
    for device in stages[0]["devices"].as_array().unwrap() {
        assert_eq!(device["state"], "offered");
        assert_eq!(device["code"], Value::Null);
        assert!(device["device_name"].as_str().unwrap().starts_with("edge-"));
    }

    // Both canary devices end badly and none verified: the rollout fails there,
    // and the stages that were never released say they stopped.
    let canary: Vec<String> = r
        .states(&rollout)
        .await
        .into_iter()
        .filter(|(_, state)| state == "offered")
        .map(|(id, _)| id)
        .collect();
    r.apply(&rollout, &canary[0]).await;
    r.old(&canary[0], &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    r.old(&canary[1], &r.about("staged")).await;
    r.old(
        &canary[1],
        &with(
            r.idle(),
            json!({"state":"failed","release":r.release.manifest_sha256,"code":"PROBE_FAILED"}),
        ),
    )
    .await;
    step(&r.f, Utc::now() + chrono::Duration::seconds(5)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    let detail = r.show(&rollout).await;
    let stages = detail["stages"].as_array().unwrap();
    assert_eq!(
        stages.iter().map(shape).collect::<Vec<_>>(),
        [
            row("canary", 0, "failed", 2, 2, 0),
            row("batch", 1, "stopped", 3, 0, 3),
            row("batch", 2, "stopped", 3, 0, 3),
            row("batch", 3, "stopped", 1, 0, 1),
        ]
    );
    assert_eq!(stages[0]["counts"], json!({"rolled_back": 1, "failed": 1}));
    // What was never released is cancelled, and says so.
    for stage in &stages[1..] {
        assert_eq!(stage["counts"], json!({"cancelled": stage["size"]}));
    }
    let failures = detail["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 2);
    let group = |code: &str| {
        failures
            .iter()
            .find(|group| group["code"] == code)
            .unwrap_or_else(|| panic!("no group {code}"))
    };
    assert_eq!(group("UNHEALTHY")["state"], "rolled_back");
    assert_eq!(group("UNHEALTHY")["count"], 1);
    assert_eq!(group("UNHEALTHY")["device_ids"], json!([canary[0]]));
    assert_eq!(group("PROBE_FAILED")["state"], "failed");
    assert_eq!(
        group("PROBE_FAILED")["devices"][0]["device_id"],
        json!(canary[1])
    );
    // The list shows the same rollout by the same words.
    let listed = page(&r.f, LIST, "").await;
    assert_eq!(listed["items"][0]["status"], "failed");
    assert_eq!(listed["items"][0]["state_counts"]["cancelled"], 7);
}

#[tokio::test]
async fn a_stage_lists_sixty_devices_and_a_failure_names_eight() {
    let r = Rig::build(65).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":65,"batch_size":10,"observation_seconds":60,"failure_threshold":100}),
        )
        .await;
    step(&r.f, Utc::now()).await;
    let detail = r.show(&rollout).await;
    let canary = &detail["stages"][0];
    assert_eq!(detail["stages"].as_array().unwrap().len(), 1);
    assert_eq!(canary["size"], 65);
    assert_eq!(canary["counts"], json!({"offered": 65}));
    assert_eq!(canary["devices"].as_array().unwrap().len(), 60);
    assert_eq!(canary["more"], 5);
    // The sixty are the first by name.
    let named: Vec<&str> = canary["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|device| device["device_name"].as_str().unwrap())
        .collect();
    let mut sorted = named.clone();
    sorted.sort_unstable_by_key(|name| name.to_ascii_lowercase());
    assert_eq!(named, sorted);
    assert_eq!(named[0], "edge-00");
    assert_eq!(named[59], "edge-59");
    // Twelve of them roll back for one reason: the group counts and lists all of
    // them by ID, and names eight.
    for id in &r.ids[..12] {
        r.apply(&rollout, id).await;
        r.old(id, &r.result("rolled_back", Some("UNHEALTHY"))).await;
    }
    let detail = r.show(&rollout).await;
    let failures = detail["failures"].as_array().unwrap();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0]["count"], 12);
    assert_eq!(failures[0]["device_ids"].as_array().unwrap().len(), 12);
    assert_eq!(failures[0]["devices"].as_array().unwrap().len(), 8);
    assert_eq!(
        failures[0]["message"],
        "The new agent started but didn't pass its health check, so the previous build was put back."
    );
}
