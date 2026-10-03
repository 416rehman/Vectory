//! The issues a rolled back or failed update opens: counted when it happens
//! again, acknowledged and reopened like the others, and ended only by a later
//! update the device verified or by the device going away. The notifier names
//! these events itself, so no issue alert is made for them.
use super::{engine::Rig, support::*};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use vectory_server::notifications;

/// The issue records of agent updates, open or not, by device.
async fn issues_of(f: &Fixture, device: &str) -> Vec<Value> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND json_extract(data,'$.stage')='agent_update' AND json_extract(data,'$.device_id')=? ORDER BY created_at,id")
        .bind(device)
        .fetch_all(&f.state.pool)
        .await
        .unwrap();
    rows.iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}
async fn issue(f: &Fixture, device: &str) -> Value {
    let mut all = issues_of(f, device).await;
    assert_eq!(all.len(), 1, "{all:?}");
    all.remove(0)
}
async fn read(f: &Fixture, id: &str) -> Value {
    ok(
        f,
        "GET",
        &format!("/api/v1/issues/{id}"),
        Value::Null,
        &f.viewer,
    )
    .await
}

#[tokio::test]
async fn an_update_issue_is_counted_acknowledged_reopened_and_ended_like_the_others() {
    let r = Rig::build(2).await;
    let (a, b) = (r.ids[0].clone(), r.ids[1].clone());
    // A channel that listens to every event, so that an issue alert the update
    // issues should not make would be recorded for it. Nothing is sent: the
    // notifier does not run here.
    ok(
        &r.f,
        "POST",
        "/api/v1/notifications/channels",
        json!({
            "name": "Everything",
            "kind": "webhook",
            "allow_private": true,
            "webhook": {"url": "http://127.0.0.1:9/never"},
            "rules": {"events": notifications::EVENTS},
        }),
        &r.f.admin,
    )
    .await;
    let first = r
        .start(&[&a, &b], json!({"canary_size":2,"failure_threshold":100}))
        .await;
    step(&r.f, Utc::now()).await;
    for device in [&a, &b] {
        r.apply(&first, device).await;
        r.old(device, &r.result("rolled_back", Some("UNHEALTHY")))
            .await;
    }
    let (ia, ib) = (issue(&r.f, &a).await, issue(&r.f, &b).await);
    assert_eq!(ia["code"], "AGENT_UPDATE_ROLLED_BACK");
    assert_eq!(
        (ia["count"].clone(), ib["count"].clone()),
        (json!(1), json!(1))
    );
    let (id_a, id_b) = (ia["id"].as_str().unwrap(), ib["id"].as_str().unwrap());
    // Each is titled by its device and version, a search finds them by what
    // happened, and a group of them says how many devices without naming one.
    let shown = read(&r.f, id_a).await;
    assert_eq!(
        shown["title"],
        json!(format!(
            "{} rolled back agent 0.1.1",
            shown["device_name"].as_str().unwrap()
        ))
    );
    let found = ok(
        &r.f,
        "GET",
        "/api/v1/issues/history?state=all&search=rolled%20back",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    assert_eq!(found["total"], 2, "{found}");
    let none = ok(
        &r.f,
        "GET",
        "/api/v1/issues/history?state=all&search=couldn%27t%20update",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    assert_eq!(none["total"], 0, "{none}");
    let groups = ok(
        &r.f,
        "GET",
        "/api/v1/issues/groups?state=open",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    assert_eq!(groups["total"], 1, "{groups}");
    let group = &groups["items"][0];
    assert_eq!(group["code"], "AGENT_UPDATE_ROLLED_BACK");
    assert_eq!(group["device_count"], 2);
    assert_eq!(group["version_id"], Value::Null);
    assert_eq!(group["title"], "2 devices rolled back an agent update");

    // An operator acknowledges it, as for any issue.
    let acknowledged = ok(
        &r.f,
        "POST",
        &format!("/api/v1/issues/{id_a}/acknowledge"),
        json!({"revision":ia["revision"],"reason":"A known bad build"}),
        &r.f.operator,
    )
    .await;
    assert_eq!(acknowledged["acknowledged"], true);
    assert_eq!(read(&r.f, id_a).await["acknowledged"], true);
    // The audit trail names the issue by what happened.
    let trail = ok(
        &r.f,
        "GET",
        "/api/v1/audit/history?action=issue.acknowledge",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    assert_eq!(
        trail["items"][0]["target_name"],
        json!(format!(
            "Agent update rolled back on {}",
            shown["device_name"].as_str().unwrap()
        )),
        "{trail}"
    );
    // Acknowledging keeps it open, and another device's issue is its own.
    assert_eq!(issue(&r.f, &a).await["resolved"], false);
    assert_eq!(read(&r.f, id_b).await["acknowledged"], false);
    // It can be reopened with a reason, which the issue's own history keeps.
    let reopened = ok(
        &r.f,
        "POST",
        &format!("/api/v1/issues/{id_a}/reopen"),
        json!({"revision":acknowledged["revision"],"reason":"It is not known after all"}),
        &r.f.operator,
    )
    .await;
    assert_eq!(reopened["acknowledged"], false);
    let acknowledged = ok(
        &r.f,
        "POST",
        &format!("/api/v1/issues/{id_a}/acknowledge"),
        json!({"revision":reopened["revision"]}),
        &r.f.operator,
    )
    .await;
    assert_eq!(acknowledged["acknowledged"], true);

    // The same release rolls back on the same device in a rollout of its own: a
    // second occurrence of the issue, which clears the acknowledgement.
    let second = r.start(&[&a], json!({"canary_size":1})).await;
    step(&r.f, Utc::now() + Duration::seconds(10)).await;
    r.apply(&second, &a).await;
    r.old(&a, &r.result("rolled_back", Some("UNHEALTHY"))).await;
    let again = issue(&r.f, &a).await;
    assert_eq!(
        again["id"],
        json!(id_a),
        "one issue for the same release and code"
    );
    assert_eq!(again["count"], 2);
    assert_eq!(
        again["acknowledged"], false,
        "a new occurrence is not acknowledged"
    );
    assert_eq!(again["resolved"], false);
    assert!(
        again["revision"].as_i64().unwrap() > acknowledged["revision"].as_i64().unwrap(),
        "a new occurrence is a new revision"
    );
    assert_eq!(issue(&r.f, &b).await["count"], 1);
    // Another release failing on the device is another issue, of the other kind.
    let next = release(&r.f, "0.1.2", 8, &r.team, &[("linux", "amd64")]).await;
    let third = start(&r.f, &next.id, &[&a], json!({})).await;
    let third = third["id"].as_str().unwrap().to_owned();
    step(&r.f, Utc::now() + Duration::seconds(20)).await;
    assert_eq!(r.state(&third, &a).await, "offered");
    let about_next = |state: &str, code: Option<&str>| {
        let mut member = with(
            r.idle(),
            json!({"state":state,"release":next.manifest_sha256}),
        );
        if let Some(code) = code {
            member["code"] = json!(code);
        }
        member
    };
    r.old(&a, &about_next("staged", None)).await;
    r.old(&a, &about_next("failed", Some("PROBE_FAILED"))).await;
    assert_eq!(r.state(&third, &a).await, "failed");
    let all = issues_of(&r.f, &a).await;
    assert_eq!(all.len(), 2, "{all:?}");
    let mut codes: Vec<&str> = all
        .iter()
        .map(|issue| issue["code"].as_str().unwrap())
        .collect();
    codes.sort_unstable();
    assert_eq!(codes, ["AGENT_UPDATE_FAILED", "AGENT_UPDATE_ROLLED_BACK"]);
    assert_eq!(
        all.iter()
            .find(|issue| issue["code"] == "AGENT_UPDATE_ROLLED_BACK")
            .unwrap()["count"],
        2
    );
    assert_eq!(
        all.iter()
            .find(|issue| issue["code"] == "AGENT_UPDATE_FAILED")
            .unwrap()["update_version"],
        "0.1.2"
    );

    // Nothing of an update is an issue alert: the notifier names these events
    // itself, and an issue that ends with its device sends nothing.
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/devices/{b}/revoke"),
        json!({}),
        &r.f.operator,
    )
    .await;
    let ended = issue(&r.f, &b).await;
    assert_eq!(ended["resolved"], true);
    assert_eq!(ended["resolved_reason"], "revoked");
    assert!(
        issues_of(&r.f, &a)
            .await
            .iter()
            .all(|issue| issue["resolved"] == false),
        "only its own device's"
    );
    // What is left is one device's: its groups are titled by it.
    let groups = ok(
        &r.f,
        "GET",
        "/api/v1/issues/groups?state=open",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    let name = shown["device_name"].as_str().unwrap();
    let mut titles: Vec<&str> = groups["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|group| group["title"].as_str().unwrap())
        .collect();
    titles.sort_unstable();
    assert_eq!(
        titles,
        [
            format!("{name} couldn't update to agent 0.1.2"),
            format!("{name} rolled back agent 0.1.1"),
        ]
    );
    let listening: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_channels WHERE json_extract(data,'$.enabled')=1",
    )
    .fetch_one(&r.f.state.pool)
    .await
    .unwrap();
    assert_eq!(listening, 1, "the alert would have had a channel to go to");
    let alerts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM notification_events WHERE kind IN ('issue.opened','issue.resolved')",
    )
    .fetch_one(&r.f.state.pool)
    .await
    .unwrap();
    assert_eq!(alerts, 0);
}
