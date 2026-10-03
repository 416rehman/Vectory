//! What the rest of the product shows of agent updates: the Overview's list of
//! what needs a person, and the two filters of the device inventory.
use super::{engine::Rig, support::*};
use axum::http::StatusCode;
use chrono::Utc;
use serde_json::{Value, json};
use vectory_server::db;

async fn overview(f: &Fixture) -> Value {
    // The projection is shared for a moment; a check-in is not a change made
    // through the API, so this read asks for a new one.
    f.state.fleet.invalidate();
    ok(f, "GET", "/api/v1/overview", Value::Null, &f.viewer).await
}
fn group<'a>(overview: &'a Value, state: &str) -> Option<&'a Value> {
    overview["attention"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["cause"] == "agent_update" && group["state"] == state)
}
fn sorted(ids: &Value) -> Vec<String> {
    let mut ids: Vec<String> = ids
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn the_overview_says_where_an_update_rolled_back_or_failed_while_updates_are_on() {
    let r = Rig::build(7).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    // A rollout that tolerates what happens here, so it goes on.
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":7,"batch_size":10,"failure_threshold":100,"observation_seconds":60}),
        )
        .await;
    step(&r.f, Utc::now()).await;
    let [a, b, c, d, e, g, h] = [
        &r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3], &r.ids[4], &r.ids[5], &r.ids[6],
    ];
    // Nothing has gone wrong yet.
    let calm = overview(&r.f).await;
    assert!(group(&calm, "rolled_back").is_none() && group(&calm, "failed").is_none());
    // Three rolled back (two of them for the same reason), one failed, one was
    // refused by its host, two did nothing.
    for (device, code) in [(a, "UNHEALTHY"), (b, "UNHEALTHY"), (c, "START_FAILED")] {
        r.apply(&rollout, device).await;
        r.old(device, &r.result("rolled_back", Some(code))).await;
    }
    r.old(d, &r.about("staged")).await;
    r.old(
        d,
        &with(
            r.idle(),
            json!({"state":"failed","release":r.release.manifest_sha256,"code":"PROBE_FAILED"}),
        ),
    )
    .await;
    r.old(
        e,
        &with(
            r.idle(),
            json!({"state":"refused","release":r.release.manifest_sha256,"code":"COUNTER_REPLAYED"}),
        ),
    )
    .await;
    let shown = overview(&r.f).await;
    let rolled = group(&shown, "rolled_back").expect("a group for the rollbacks");
    assert_eq!(rolled["severity"], "warning");
    assert_eq!(rolled["count"], 3);
    assert_eq!(rolled["reason"], "UNHEALTHY", "the most common code");
    let mut want = vec![a.clone(), b.clone(), c.clone()];
    want.sort();
    assert_eq!(sorted(&rolled["device_ids"]), want);
    assert_eq!(rolled["device_names"].as_array().unwrap().len(), 3);
    for none in [
        "version_id",
        "version_number",
        "configuration_id",
        "configuration_name",
        "deployment_id",
        "fix",
        "title",
    ] {
        assert!(
            rolled.get(none).is_none_or(Value::is_null),
            "{none}: {rolled}"
        );
    }
    assert_eq!(rolled["rollback_available"], false);
    assert!(rolled["since"].is_string());
    let failed = group(&shown, "failed").expect("a group for the failure");
    assert_eq!(failed["count"], 1);
    assert_eq!(failed["reason"], "PROBE_FAILED");
    assert_eq!(failed["device_ids"], json!([d]));
    // A refusal is not a failure, and a device that did nothing is in none.
    let all: Vec<&Value> = shown["attention"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|group| group["cause"] == "agent_update")
        .collect();
    assert_eq!(all.len(), 2);
    for group in all {
        for quiet in [e, g, h] {
            assert!(
                !group["device_ids"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(quiet))
            );
        }
    }
    // Everything else the Overview says is as it was: the devices that need a
    // person are the ones it always lists.
    assert!(
        shown["attention_devices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|device| device["cause"] != "agent_update")
    );

    // A device with an older open issue of the other kind is in the group of the
    // later one, once.
    let mut conn = r.f.state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "issue",
        &json!({
            "id": db::hash("an older issue"), "device_id": a, "code": "AGENT_UPDATE_FAILED",
            "stage": "agent_update", "count": 1, "reports": 1, "resolved": false, "revision": 1,
            "first_seen": "2020-01-01T00:00:00Z", "last_seen": "2020-01-01T00:00:00Z",
            "update_version": "0.0.9", "update_code": "DISK_FULL",
        }),
    )
    .await
    .unwrap();
    drop(conn);
    let shown = overview(&r.f).await;
    assert_eq!(group(&shown, "rolled_back").unwrap()["count"], 3);
    assert_eq!(group(&shown, "failed").unwrap()["count"], 1);

    // A revoked device is not one that needs a person, whatever its issue says.
    revoke(&r.f, c).await;
    let shown = overview(&r.f).await;
    let rolled = group(&shown, "rolled_back").unwrap();
    assert_eq!(rolled["count"], 2);
    assert_eq!(rolled["reason"], "UNHEALTHY");

    // With updates off the issues stay open and the Overview says nothing of them.
    switch(&r.f, false).await;
    let off = overview(&r.f).await;
    assert!(group(&off, "rolled_back").is_none() && group(&off, "failed").is_none());
    let open: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='issue' AND json_extract(data,'$.stage')='agent_update' AND COALESCE(json_type(data,'$.resolved')='true',0)=0")
        .fetch_one(&r.f.state.pool)
        .await
        .unwrap();
    assert!(open >= 3);
    switch(&r.f, true).await;
    assert!(group(&overview(&r.f).await, "rolled_back").is_some());
}

/// The devices of the inventory tests: one at each level, a device that is
/// revoked, and devices that run versions of every shape.
struct Fleet {
    f: Fixture,
    ids: std::collections::BTreeMap<&'static str, String>,
}
async fn fleet() -> Fleet {
    let f = fixture_on().await;
    let team = fingerprint("team");
    let mut ids = std::collections::BTreeMap::new();
    for (name, version, report) in [
        ("auto-a", "0.1.0", Some(member(&[&team]))),
        ("auto-b", "0.1.1", Some(member(&[&team]))),
        (
            "ask-a",
            "0.1.0",
            Some(with(member(&[&team]), json!({"consent":"ask"}))),
        ),
        (
            "off-a",
            "0.1.0-dev",
            Some(with(member(&[&team]), json!({"consent":"off"}))),
        ),
        (
            "cannot-a",
            "0.1.0",
            Some(with(
                member(&[&team]),
                // An eligibility that is not `eligible` wins over the host's consent.
                json!({"eligibility":"NO_SERVICE","consent":"off"}),
            )),
        ),
        ("silent-a", "0.1.0", None),
        ("gone-a", "0.1.0", Some(member(&[&team]))),
    ] {
        let id = device(&f, name, version).await;
        if let Some(report) = report {
            store(&f, &id, &report).await;
        }
        ids.insert(name, id);
    }
    revoke(&f, &ids["gone-a"]).await;
    Fleet { f, ids }
}
impl Fleet {
    async fn get(&self, route: &str, query: &str) -> (StatusCode, Value) {
        let (status, _, value) = send(
            &self.f.app,
            "GET",
            &format!("/api/v1/devices/inventory{route}?{query}"),
            Value::Null,
            Some(&self.f.viewer),
        )
        .await;
        (status, value)
    }
    /// The names of the devices the inventory lists for `query`, in its order.
    async fn names(&self, query: &str) -> Vec<String> {
        let (status, page) = self.get("", query).await;
        assert_eq!(status, StatusCode::OK, "{query}: {page}");
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["name"].as_str().unwrap().to_owned())
            .collect()
    }
    /// ... and what the ids route lists.
    async fn named_ids(&self, query: &str) -> Vec<String> {
        let (status, page) = self.get("/ids", query).await;
        assert_eq!(status, StatusCode::OK, "{query}: {page}");
        let by_id: std::collections::BTreeMap<&String, &str> =
            self.ids.iter().map(|(name, id)| (id, *name)).collect();
        page["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| by_id[&id.as_str().unwrap().to_owned()].to_owned())
            .collect()
    }
}

#[tokio::test]
async fn the_inventory_filters_by_how_a_device_takes_updates() {
    let fleet = fleet().await;
    for (level, names) in [
        ("automatic", vec!["auto-a", "auto-b"]),
        ("ask", vec!["ask-a"]),
        ("off", vec!["off-a"]),
        ("cannot_update", vec!["cannot-a"]),
        ("not_reported", vec!["silent-a"]),
    ] {
        let query = format!("agent_update={level}");
        assert_eq!(fleet.names(&query).await, names, "{level}");
        assert_eq!(fleet.named_ids(&query).await, names, "{level}");
    }
    // The levels are the ones the fleet counts: every non-revoked device is at
    // exactly one, and the inventory agrees with the count.
    let setting = ok(
        &fleet.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &fleet.f.viewer,
    )
    .await;
    assert_eq!(
        setting["fleet"]["levels"],
        json!({"automatic":2,"ask":1,"off":1,"cannot_update":1,"not_reported":1})
    );
    // A revoked device is at none, whatever it last reported.
    let (_, listed) = fleet.get("", "status=revoked&agent_update=automatic").await;
    assert_eq!(listed["total"], 0);
    // An empty value is no filter.
    assert_eq!(fleet.names("agent_update=").await.len(), 6);
    // The filter and the page agree on the total, and the counts follow it.
    let (_, page) = fleet.get("", "agent_update=automatic").await;
    assert_eq!(page["total"], 2);
    let counted: u64 = page["counts"]["status"]
        .as_object()
        .unwrap()
        .values()
        .map(|count| count.as_u64().unwrap())
        .sum();
    assert_eq!(counted, 2, "the counts follow the scope: {page}");
    // It combines with the other filters.
    assert_eq!(
        fleet.names("agent_update=automatic&q=auto-b").await,
        ["auto-b"]
    );
    assert!(fleet.names("agent_update=automatic&q=ask").await.is_empty());
    // A report that changes moves the device at once: the level is read when the
    // request is made.
    store(
        &fleet.f,
        &fleet.ids["silent-a"],
        &with(member(&[fingerprint("team")]), json!({"consent":"ask"})),
    )
    .await;
    assert_eq!(
        fleet.named_ids("agent_update=ask").await,
        ["ask-a", "silent-a"]
    );
}

#[tokio::test]
async fn the_inventory_filters_by_the_agent_version_exactly_as_reported() {
    let fleet = fleet().await;
    assert_eq!(
        fleet.names("agent_version=0.1.0").await,
        ["ask-a", "auto-a", "cannot-a", "silent-a"]
    );
    assert_eq!(fleet.names("agent_version=0.1.1").await, ["auto-b"]);
    // Exact: not a prefix, not a number, not another case.
    assert_eq!(fleet.names("agent_version=0.1.0-dev").await, ["off-a"]);
    for miss in ["0.1", "0.1.", "0.1.0-DEV", "v0.1.0", "0.1.00", "0.1.0%20"] {
        assert!(
            fleet
                .names(&format!("agent_version={miss}"))
                .await
                .is_empty(),
            "{miss}"
        );
    }
    assert_eq!(
        fleet.named_ids("agent_version=0.1.1").await,
        ["auto-b"],
        "the ids route reads it too"
    );
    assert_eq!(
        fleet
            .names("agent_version=0.1.0&agent_update=not_reported")
            .await,
        ["silent-a"]
    );
    // It needs no updates to be on: the version is what the device reported.
    switch(&fleet.f, false).await;
    assert_eq!(fleet.names("agent_version=0.1.1").await, ["auto-b"]);
    // 128 bytes are a version, more are not, and an empty value is no filter.
    let long = "9".repeat(128);
    assert!(
        fleet
            .names(&format!("agent_version={long}"))
            .await
            .is_empty()
    );
    let (status, refusal) = fleet
        .get("", &format!("agent_version={}", "9".repeat(129)))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refusal}");
    assert_eq!(refusal["error"]["code"], "INVALID_INPUT");
    assert_eq!(fleet.names("agent_version=").await.len(), 6);
}

#[tokio::test]
async fn the_level_filter_is_not_found_while_updates_are_off_and_refuses_what_it_does_not_know() {
    let fleet = fleet().await;
    for (query, why) in [
        ("agent_update=Automatic", "case"),
        ("agent_update=on", "not a level"),
        ("agent_update=automatic&agent_update=ask", "repeated"),
        ("agent_version=0.1.0&agent_version=0.1.1", "repeated"),
        ("agent_updates=ask", "an unknown parameter"),
    ] {
        for route in ["", "/ids"] {
            let (status, refusal) = fleet.get(route, query).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{route}?{query} ({why}): {refusal}"
            );
            assert_eq!(refusal["error"]["code"], "INVALID_INPUT", "{why}");
        }
    }
    switch(&fleet.f, false).await;
    for route in ["", "/ids"] {
        for level in levels() {
            let (status, refusal) = fleet.get(route, &format!("agent_update={level}")).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{route} {level}: {refusal}");
            assert_eq!(refusal["error"]["code"], "AGENT_UPDATES_OFF");
        }
        // A value that is not one is refused as malformed, not as off.
        let (status, refusal) = fleet.get(route, "agent_update=bogus").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refusal}");
    }
    // Every other query reads as before.
    assert_eq!(fleet.names("").await.len(), 6);
    // Turned on again, the filter answers again.
    switch(&fleet.f, true).await;
    assert_eq!(fleet.names("agent_update=off").await, ["off-a"]);
}
fn levels() -> [&'static str; 5] {
    ["automatic", "ask", "off", "cannot_update", "not_reported"]
}
