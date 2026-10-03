//! What a channel hears about agent updates: four events, read from the audit
//! trail through the notifier's cursor, each announced once, with what it is
//! about, under the rules a channel has (events, severity, groups, pipelines and
//! quiet hours). Every receiver is a listener on this machine.
use super::{engine::Rig, support::*};
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use vectory_server::{agent_release, db, notifications, notifier};

const ORIGIN: &str = "https://vectory.example.test";
const FOUR: [&str; 4] = [
    "agent_update.failed",
    "agent_update.rolled_back",
    "agent_update.stopped",
    "agent_update.key_changed",
];

/// A receiver of webhooks that says yes to everything and keeps what it was
/// sent.
#[derive(Clone)]
struct Hook {
    address: std::net::SocketAddr,
    seen: Arc<Mutex<Vec<(String, Value)>>>,
}
impl Hook {
    async fn new() -> Hook {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hook = Hook {
            address: listener.local_addr().unwrap(),
            seen: Arc::default(),
        };
        let log = hook.seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && head.len() < 65536 {
                        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let head = String::from_utf8_lossy(&head).to_string();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    let mut body = vec![0u8; length];
                    if stream.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                    log.lock()
                        .unwrap()
                        .push((path, serde_json::from_slice(&body).unwrap_or(Value::Null)));
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                        )
                        .await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        hook
    }
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
    /// The `event` of every webhook that reached `path`, in the order they came.
    fn events(&self, path: &str) -> Vec<Value> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(at, _)| at == path)
            .map(|(_, body)| body["event"].clone())
            .collect()
    }
    /// The type and headline of each, in alphabetical order: what a rule let
    /// through, whatever order the sends happened in.
    fn headlines(&self, path: &str) -> Vec<String> {
        let mut out: Vec<String> = self
            .events(path)
            .iter()
            .map(|event| {
                format!(
                    "{} | {}",
                    event["type"].as_str().unwrap(),
                    event["headline"].as_str().unwrap()
                )
            })
            .collect();
        out.sort();
        out
    }
    /// The events of one type.
    fn of(&self, path: &str, kind: &str) -> Vec<Value> {
        self.events(path)
            .into_iter()
            .filter(|event| event["type"] == kind)
            .collect()
    }
}

/// A channel to the hook at `path` with these rules.
async fn channel(f: &Fixture, hook: &Hook, path: &str, rules: Value) -> Value {
    ok(
        f,
        "POST",
        "/api/v1/notifications/channels",
        json!({
            "name": format!("Hook {path}"),
            "kind": "webhook",
            "allow_private": true,
            "webhook": {"url": hook.url(path)},
            "rules": rules,
        }),
        &f.admin,
    )
    .await
}

/// Ticks of the notifier at `now` until nothing more starts, waiting for the
/// sends.
async fn drain(f: &Fixture, now: DateTime<Utc>) {
    for _ in 0..40 {
        let tasks = notifier::tick(&f.state, now).await.unwrap();
        if tasks.is_empty() {
            return;
        }
        for task in tasks {
            task.await.unwrap();
        }
    }
    panic!("the notifier kept sending at {now}");
}
fn later() -> DateTime<Utc> {
    Utc::now() + Duration::seconds(5)
}

async fn name_of(f: &Fixture, device: &str) -> String {
    sqlx::query_scalar("SELECT name FROM devices WHERE id=?")
        .bind(device)
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}
async fn group(f: &Fixture, name: &str, devices: &[&String]) -> String {
    let id = db::id();
    let mut conn = f.state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "group",
        &json!({"id":id,"name":name,"device_ids":devices,"created_at":db::now(),"revision":1}),
    )
    .await
    .unwrap();
    id
}
/// A rollout of the devices of a group, reviewed and started.
async fn start_group(f: &Fixture, release: &str, group: &str, rollout: Value) -> String {
    let body = json!({
        "release_id":release,
        "selector":{"device_ids":[],"group_ids":[group],"exclude_ids":[]},
        "rollout":rollout,
    });
    let review = ok(
        f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        body.clone(),
        &f.operator,
    )
    .await;
    let mut body = body;
    body["review_token"] = review["review_token"].clone();
    ok(
        f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body,
        &f.operator,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
/// The canary of a rollout: released by the first step, taken up to `applying`,
/// and rolled back by the agent with `code`.
async fn roll_back(r: &Rig, rollout: &str, device: &str, code: &str) {
    r.apply(rollout, device).await;
    r.old(device, &r.result("rolled_back", Some(code))).await;
    assert_eq!(r.state(rollout, device).await, "rolled_back");
}
/// What the one-line rule makes of a hostile name.
fn hostile_free(event: &Value) {
    fn strings(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
            Value::Object(members) => members.values().for_each(|item| strings(item, out)),
            _ => {}
        }
    }
    let mut all = Vec::new();
    strings(event, &mut all);
    for text in all {
        assert!(
            !text.chars().any(db::hostile_display_char),
            "a message holds a character that is not safe in one line: {text:?}"
        );
    }
}

#[tokio::test]
async fn a_failed_rollout_and_its_rollbacks_are_announced_once_with_what_they_are_about() {
    let r = Rig::build_with(5, |s| s.public_url = Some(ORIGIN.into())).await;
    let hook = Hook::new().await;
    channel(&r.f, &hook, "/all", json!({"events":FOUR})).await;
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(
            &refs,
            json!({"canary_size":2,"batch_size":2,"failure_threshold":1,"observation_seconds":60}),
        )
        .await;
    // A name as nothing refuses to store today, and a person could once read it
    // as several lines: it reaches a message as one.
    sqlx::query("UPDATE agent_update_rollouts SET name=? WHERE id=?")
        .bind("Edge fleet\n\nResolved everywhere\u{202e} now")
        .bind(&rollout)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    let name = "Edge fleet Resolved everywhere now";
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
    // Nothing happened yet that a channel hears.
    drain(&r.f, later()).await;
    assert!(hook.events("/all").is_empty());

    // The first rollback is within the threshold: announced, and the rollout
    // goes on.
    roll_back(&r, &rollout, &canary[0], "START_FAILED").await;
    drain(&r.f, later()).await;
    let first = hook.events("/all");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["type"], "agent_update.rolled_back");
    assert_eq!(first[0]["severity"], "warning");
    assert_eq!(first[0]["recovery"], false);
    assert_eq!(first[0]["test"], false);
    assert_eq!(
        first[0]["headline"],
        format!("Agent rolled back on {}", name_of(&r.f, &canary[0]).await)
    );
    assert_eq!(
        first[0]["message"],
        format!(
            "{} went back to 0.1.0 after trying 0.1.1. The new agent didn't start, so the previous build was put back.",
            name_of(&r.f, &canary[0]).await
        )
    );
    assert_eq!(
        first[0]["device"],
        json!({"id":canary[0],"name":name_of(&r.f, &canary[0]).await})
    );
    for none in ["pipeline", "deployment", "issue"] {
        assert_eq!(first[0][none], Value::Null, "{none}");
    }
    assert_eq!(
        first[0]["agent_update"],
        json!({"release_version":"0.1.1","rollout":{"id":rollout,"name":name},"code":"START_FAILED","key":null})
    );
    assert_eq!(
        first[0]["url"],
        format!("{ORIGIN}/#/agent-updates/{rollout}")
    );

    // The second is over it: the rollout fails, and what had not started is
    // withdrawn.
    r.apply(&rollout, &canary[1]).await;
    r.new(&canary[1], &r.about("trial")).await;
    r.old(&canary[1], &r.result("rolled_back", Some("UNHEALTHY")))
        .await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    drain(&r.f, later()).await;
    let all = hook.events("/all");
    assert_eq!(all.len(), 3, "{all:?}");
    let failed = hook.of("/all", "agent_update.failed");
    assert_eq!(failed.len(), 1);
    let failed = &failed[0];
    assert_eq!(failed["severity"], "error");
    assert_eq!(failed["headline"], format!("Agent update failed: {name}"));
    assert_eq!(
        failed["message"],
        "More devices rolled back or failed than its failure threshold allows, so it stopped."
    );
    assert_eq!(failed["device"], Value::Null);
    assert_eq!(
        failed["agent_update"],
        json!({"release_version":"0.1.1","rollout":{"id":rollout,"name":name},"code":null,"key":null})
    );
    assert_eq!(failed["url"], format!("{ORIGIN}/#/agent-updates/{rollout}"));
    let second = hook
        .of("/all", "agent_update.rolled_back")
        .into_iter()
        .find(|event| event["device"]["id"] == json!(canary[1]))
        .unwrap();
    assert!(
        second["message"]
            .as_str()
            .unwrap()
            .ends_with("The new agent started but didn't pass its health check, so the previous build was put back.")
    );
    assert_eq!(second["agent_update"]["code"], "UNHEALTHY");
    for event in &all {
        hostile_free(event);
        assert_eq!(event["schema"], "vectory.notification.v1");
        assert!(
            event["id"].as_str().is_some_and(|id| id.len() == 32),
            "a stable ID per event"
        );
    }
    // Each audit row is announced once, however many ticks follow.
    drain(&r.f, later() + Duration::minutes(10)).await;
    assert_eq!(hook.events("/all").len(), 3);
}

#[tokio::test]
async fn a_rollout_that_failed_for_delivery_health_says_so() {
    let r = Rig::build(2).await;
    let hook = Hook::new().await;
    channel(
        &r.f,
        &hook,
        "/all",
        json!({"events":["agent_update.failed"]}),
    )
    .await;
    let refs: Vec<&String> = r.ids.iter().collect();
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
    roll_back(&r, &rollout, &canary, "UNHEALTHY").await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    // The reason the rollout recorded is what the message says.
    sqlx::query("UPDATE agent_update_rollouts SET failure_reason='data_plane' WHERE id=?")
        .bind(&rollout)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    drain(&r.f, later()).await;
    let events = hook.events("/all");
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["message"],
        "Devices that took it stopped delivering events, so it stopped before the next stage."
    );
    // With no name given the release names it.
    assert_eq!(
        events[0]["headline"],
        "Agent update failed: Update to 0.1.1"
    );
}

#[tokio::test]
async fn stopping_all_updates_is_announced_with_who_why_and_how_many_rollouts_ended() {
    let r = Rig::build_with(3, |s| s.public_url = Some(ORIGIN.into())).await;
    let hook = Hook::new().await;
    channel(&r.f, &hook, "/all", json!({"events":FOUR})).await;
    let first = r
        .start(&[&r.ids[0], &r.ids[1]], json!({"canary_size":2}))
        .await;
    let second = r.start(&[&r.ids[2]], json!({"canary_size":1})).await;
    step(&r.f, Utc::now()).await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A bad build"}),
        &r.f.operator,
    )
    .await;
    // The cancellations are not events: only the stop is.
    drain(&r.f, later()).await;
    let events = hook.events("/all");
    assert_eq!(events.len(), 1, "{events:?}");
    let stop = &events[0];
    assert_eq!(stop["type"], "agent_update.stopped");
    assert_eq!(stop["severity"], "warning");
    assert_eq!(stop["headline"], "Agent updates stopped");
    assert_eq!(
        stop["message"],
        "Synthetic operator stopped all agent updates. Reason: “A bad build”. No host is offered a build until an administrator ends the stop. 2 update rollouts were cancelled."
    );
    assert_eq!(
        stop["agent_update"],
        json!({"release_version":null,"rollout":null,"code":null,"key":null})
    );
    assert_eq!(stop["device"], Value::Null);
    assert_eq!(stop["url"], format!("{ORIGIN}/#/agent-updates"));
    for rollout in [&first, &second] {
        assert_eq!(status(&r.f, rollout).await, "cancelled");
    }
    // Stopping a stopped server, and ending the stop, say nothing more.
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Again"}),
        &r.f.operator,
    )
    .await;
    let setting = ok(
        &r.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":setting["revision"]}),
        &r.f.admin,
    )
    .await;
    drain(&r.f, later() + Duration::minutes(10)).await;
    assert_eq!(hook.events("/all").len(), 1);
    // A stop that cancels nothing says so by saying nothing about rollouts, and
    // a person who is gone is "Someone".
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"A second stop"}),
        &r.f.operator,
    )
    .await;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&r.f.operator.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=?")
        .bind(&r.f.operator.id)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    drain(&r.f, later() + Duration::minutes(20)).await;
    let events = hook.events("/all");
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[1]["message"],
        "Someone stopped all agent updates. Reason: “A second stop”. No host is offered a build until an administrator ends the stop."
    );
}

#[tokio::test]
async fn every_change_of_the_key_is_announced_with_the_key_that_became_current() {
    let f = fixture_with(|s| s.public_url = Some(ORIGIN.into())).await;
    let hook = Hook::new().await;
    channel(
        &f,
        &hook,
        "/all",
        json!({"events":["agent_update.key_changed"]}),
    )
    .await;
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
    // The key that was current is history; revoking it changes no current key.
    ok(
        &f,
        "POST",
        &format!("/api/v1/agent-release-keys/{first}/revoke"),
        json!({"reason":"The laptop that held it was lost","current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let setting = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    ok(
        &f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":false,"current_password":PASSWORD,"revision":setting["revision"]}),
        &f.admin,
    )
    .await;
    let setting = ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await;
    ok(
        &f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":true,"current_password":PASSWORD,"revision":setting["revision"]}),
        &f.admin,
    )
    .await;
    drain(&f, later()).await;
    let events = hook.events("/all");
    assert_eq!(events.len(), 5, "{events:?}");
    let by = |headline: &str| -> Vec<Value> {
        events
            .iter()
            .filter(|event| event["headline"] == headline)
            .cloned()
            .collect()
    };
    for event in &events {
        assert_eq!(event["type"], "agent_update.key_changed");
        assert_eq!(event["severity"], "warning");
        assert_eq!(event["url"], format!("{ORIGIN}/#/agent-updates-settings"));
        assert_eq!(event["device"], Value::Null);
        assert_eq!(event["agent_update"]["rollout"], Value::Null);
        assert_eq!(event["agent_update"]["release_version"], Value::Null);
        assert_eq!(event["agent_update"]["code"], Value::Null);
    }
    // Turned on: the key it was turned on with is the one that became current.
    let on = by("Agent updates turned on");
    assert_eq!(on.len(), 2);
    let keys: Vec<&Value> = on
        .iter()
        .map(|event| &event["agent_update"]["key"])
        .collect();
    assert!(keys.contains(&&json!(&first[..16])));
    assert!(keys.contains(&&json!(&second[..16])));
    for event in &on {
        assert!(event["message"].as_str().unwrap().starts_with(
            "Synthetic admin turned agent updates on. Hosts that enroll now pin release key "
        ));
    }
    let rotate = by("Release key rotated");
    assert_eq!(rotate.len(), 1);
    assert_eq!(rotate[0]["agent_update"]["key"], json!(&second[..16]));
    assert_eq!(
        rotate[0]["message"],
        format!(
            "Synthetic admin rotated the release key. Hosts that enroll now pin {}; hosts that pin the previous key follow the statement it signed.",
            &second[..16]
        )
    );
    // Revoked: no key became current. The message names the key that went.
    let revoked = by("Release key revoked");
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0]["agent_update"]["key"], Value::Null);
    assert_eq!(
        revoked[0]["message"],
        format!("Synthetic admin revoked release key {}.", &first[..16])
    );
    // Turned off: none either.
    let off = by("Agent updates turned off");
    assert_eq!(off.len(), 1);
    assert_eq!(off[0]["agent_update"]["key"], Value::Null);
    assert_eq!(
        off[0]["message"],
        "Synthetic admin turned agent updates off. Hosts that enroll now pin no release key, until they are turned on again."
    );
    // Nothing a key is made of is in any of them.
    let text = serde_json::to_string(&events).unwrap();
    assert!(!text.contains(&first), "a whole fingerprint");
    assert!(!text.contains("vectory-release-key"), "a key line");
}

#[tokio::test]
async fn a_rollover_the_team_signed_and_a_revocation_that_ends_rollouts_are_announced() {
    let f = fixture().await;
    let hook = Hook::new().await;
    channel(
        &f,
        &hook,
        "/all",
        json!({"events":["agent_update.key_changed"]}),
    )
    .await;
    let first = team("team");
    enable_offline(&f, &first).await;
    let second = team("team-next");
    let statement =
        agent_release::build_statement(&first.fingerprint(), &second.key, Utc::now().timestamp())
            .unwrap();
    let signature = agent_release::sign_rollover(&first.seed, &statement).unwrap();
    ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rollover",
        json!({"statement":STANDARD.encode(&statement),"signature":STANDARD.encode(&signature),"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    // A release the new key signed, in a rollout of a device; revoking the key
    // withdraws the release and ends the rollout.
    let key = second.fingerprint();
    let release = release(&f, "0.1.1", 7, &key, &[("linux", "amd64")]).await;
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[&key])).await;
    start(&f, &release.id, &[&edge], json!({})).await;
    ok(
        &f,
        "POST",
        &format!("/api/v1/agent-release-keys/{key}/revoke"),
        json!({"reason":"Lost","current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    drain(&f, later()).await;
    let events = hook.events("/all");
    let headlines = hook.headlines("/all");
    assert_eq!(
        headlines,
        [
            "agent_update.key_changed | Agent updates turned on",
            "agent_update.key_changed | Release key revoked",
            "agent_update.key_changed | Release key rolled over",
        ],
        "{events:?}"
    );
    let find = |headline: &str| {
        events
            .iter()
            .find(|event| event["headline"] == headline)
            .unwrap()
            .clone()
    };
    let on = find("Agent updates turned on");
    assert_eq!(on["agent_update"]["key"], json!(&first.fingerprint()[..16]));
    let rolled = find("Release key rolled over");
    assert_eq!(rolled["agent_update"]["key"], json!(&key[..16]));
    assert_eq!(
        rolled["message"],
        format!(
            "Synthetic admin rolled the release key over to {} with a statement the previous key signed.",
            &key[..16]
        )
    );
    let revoked = find("Release key revoked");
    assert_eq!(revoked["agent_update"]["key"], Value::Null);
    assert_eq!(
        revoked["message"],
        format!(
            "Synthetic admin revoked release key {}. 1 release it signed was withdrawn and 1 update rollout ended.",
            &key[..16]
        )
    );
}

#[tokio::test]
async fn rules_decide_who_hears_which_event() {
    let r = Rig::build(8).await;
    let hook = Hook::new().await;
    // The devices of the first rollout, and of the second.
    let (a, b, c, d) = (&r.ids[0], &r.ids[1], &r.ids[2], &r.ids[3]);
    let others: Vec<&String> = r.ids[4..].iter().collect();
    let eu = group(&r.f, "EU", &[a]).await;
    let na = group(&r.f, "NA", &others).await;
    channel(&r.f, &hook, "/all", json!({"events":FOUR})).await;
    channel(&r.f, &hook, "/eu", json!({"events":FOUR,"group_ids":[eu]})).await;
    channel(&r.f, &hook, "/na", json!({"events":FOUR,"group_ids":[na]})).await;
    let pipeline = db::id();
    {
        let mut conn = r.f.state.pool.acquire().await.unwrap();
        db::insert(
            &mut conn,
            "configuration",
            &json!({"id":pipeline,"name":"Web access logs","created_at":db::now()}),
        )
        .await
        .unwrap();
    }
    channel(
        &r.f,
        &hook,
        "/pipeline",
        json!({"events":FOUR,"pipeline_ids":[pipeline]}),
    )
    .await;
    channel(
        &r.f,
        &hook,
        "/errors",
        json!({"events":FOUR,"min_severity":"error"}),
    )
    .await;
    channel(
        &r.f,
        &hook,
        "/only-failed",
        json!({"events":["agent_update.failed"]}),
    )
    .await;

    // The first rollout holds a device of EU, which rolls back: a rollback of a
    // device in the group, and a failure of a rollout with a target in it.
    let one = r
        .start(
            &[a, b, c, d],
            json!({"canary_size":1,"canary_device_ids":[a],"failure_threshold":0,"batch_size":10,"observation_seconds":60}),
        )
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    roll_back(&r, &one, a, "UNHEALTHY").await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&one).await, "failed");
    // The second names a group in its selector and has no device in EU.
    let two = start_group(
        &r.f,
        &r.release.id,
        &na,
        json!({"canary_size":1,"canary_device_ids":[others[0]],"failure_threshold":0,"batch_size":10,"observation_seconds":60}),
    )
    .await;
    step(&r.f, at + Duration::seconds(20)).await;
    roll_back(&r, &two, others[0], "START_FAILED").await;
    step(&r.f, at + Duration::seconds(30)).await;
    assert_eq!(r.status(&two).await, "failed");
    // The group is emptied before the events are read: what a group filter
    // matches is the membership when the message is made. The rollout still
    // names the group in its selector, and that alone matches.
    sqlx::query("UPDATE records SET data=json_set(data,'$.device_ids',json('[]')) WHERE id=?")
        .bind(&na)
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    // A stop and a change of the key.
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Enough"}),
        &r.f.operator,
    )
    .await;
    let setting = ok(
        &r.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":setting["revision"]}),
        &r.f.admin,
    )
    .await;
    let setting = ok(
        &r.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    ok(
        &r.f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":false,"current_password":PASSWORD,"revision":setting["revision"]}),
        &r.f.admin,
    )
    .await;
    drain(&r.f, later()).await;

    let name_a = name_of(&r.f, a).await;
    let first_other = name_of(&r.f, others[0]).await;
    let failed_one = "agent_update.failed | Agent update failed: Update to 0.1.1";
    // Everything, with no filter.
    let all = hook.headlines("/all");
    assert_eq!(all.len(), 6, "{all:?}");
    assert_eq!(
        all.iter()
            .filter(|h| h.starts_with("agent_update.failed"))
            .count(),
        2
    );
    assert!(all.contains(&format!(
        "agent_update.rolled_back | Agent rolled back on {name_a}"
    )));
    assert!(all.contains(&format!(
        "agent_update.rolled_back | Agent rolled back on {first_other}"
    )));
    assert!(all.contains(&"agent_update.stopped | Agent updates stopped".to_owned()));
    assert!(all.contains(&"agent_update.key_changed | Agent updates turned off".to_owned()));
    // A group: the rollback of its device, and the failure of the rollout that
    // has a target in it. Neither a stop nor a change of the key has a group.
    let in_eu = hook.headlines("/eu");
    assert_eq!(
        in_eu,
        [
            failed_one.to_owned(),
            format!("agent_update.rolled_back | Agent rolled back on {name_a}"),
        ]
    );
    let eu_failed = &hook.of("/eu", "agent_update.failed")[0];
    assert_eq!(eu_failed["agent_update"]["rollout"]["id"], json!(one));
    // A group the second rollout's selector names, which holds no device now:
    // the failure only. Its device's rollback is in no group.
    let in_na = hook.headlines("/na");
    assert_eq!(in_na, [failed_one.to_owned()]);
    assert_eq!(
        hook.of("/na", "agent_update.failed")[0]["agent_update"]["rollout"]["id"],
        json!(two)
    );
    // A pipeline filter matches none of them.
    assert!(hook.events("/pipeline").is_empty());
    // Only errors: the failures, and nothing a warning is.
    let errors = hook.headlines("/errors");
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(errors.iter().all(|h| h.starts_with("agent_update.failed")));
    // Only the events a channel asked for.
    assert_eq!(hook.headlines("/only-failed").len(), 2);
}

#[tokio::test]
async fn quiet_hours_hold_what_is_not_an_error_and_send_it_as_a_digest() {
    let r = Rig::build(2).await;
    let hook = Hook::new().await;
    let now = DateTime::parse_from_rfc3339("2026-10-04T02:10:00Z")
        .unwrap()
        .with_timezone(&Utc);
    channel(
        &r.f,
        &hook,
        "/quiet",
        json!({
            "events": FOUR,
            "quiet_hours": {"start":"22:00","end":"07:00","time_zone":"UTC","errors_bypass":true},
        }),
    )
    .await;
    // The channel is older than everything it hears.
    sqlx::query("UPDATE notification_channels SET created_at='2020-01-01T00:00:00Z'")
        .execute(&r.f.state.pool)
        .await
        .unwrap();
    let refs: Vec<&String> = r.ids.iter().collect();
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
    roll_back(&r, &rollout, &canary, "UNHEALTHY").await;
    step(&r.f, at + Duration::seconds(10)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    ok(
        &r.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Quiet"}),
        &r.f.operator,
    )
    .await;
    drain(&r.f, now).await;
    // The failure is an error and passes; the rollback and the stop are warnings
    // and wait for the morning.
    let sent = hook.events("/quiet");
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["type"], "agent_update.failed");
    let held: Vec<String> = sqlx::query_scalar(
        "SELECT next_attempt_at FROM notification_deliveries WHERE status='held'",
    )
    .fetch_all(&r.f.state.pool)
    .await
    .unwrap();
    assert_eq!(held, ["2026-10-04T07:00:00Z", "2026-10-04T07:00:00Z"]);
    drain(&r.f, now + Duration::hours(2)).await;
    assert_eq!(hook.events("/quiet").len(), 1, "still quiet");
    drain(
        &r.f,
        DateTime::parse_from_rfc3339("2026-10-04T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;
    let sent = hook.events("/quiet");
    assert_eq!(sent.len(), 2, "the held ones arrive as one digest");
    assert_eq!(sent[1]["type"], "digest");
    assert_eq!(sent[1]["count"], 2);
    let digest = sent[1]["message"].as_str().unwrap();
    assert!(digest.contains("Agent updates stopped"), "{digest}");
    assert!(digest.contains("Agent rolled back on"), "{digest}");
}

#[tokio::test]
async fn previews_are_marked_as_examples_and_a_channel_can_ask_for_the_four_events() {
    let f = fixture_with(|s| s.public_url = Some(ORIGIN.into())).await;
    for kind in FOUR {
        let preview = ok(
            &f,
            "POST",
            "/api/v1/notifications/preview",
            json!({"type":kind,"name":"On-call"}),
            &f.admin,
        )
        .await;
        assert_eq!(preview["example"], true, "{kind}");
        let event = &preview["webhook"]["event"];
        assert_eq!(event["type"], kind);
        assert_eq!(event["schema"], "vectory.notification.v1");
        assert_eq!(event["headline"], preview["headline"]);
        assert!(event["agent_update"].is_object(), "{kind}");
        for member in ["release_version", "rollout", "code", "key"] {
            assert!(
                event["agent_update"].get(member).is_some(),
                "{kind}: {member}"
            );
        }
        assert!(
            preview["link"]
                .as_str()
                .is_some_and(|link| link.starts_with(ORIGIN)),
            "{kind}"
        );
        assert!(
            preview["email"]["body"]
                .as_str()
                .unwrap()
                .contains("Sent by the “On-call” channel"),
            "{kind}"
        );
        hostile_free(event);
    }
    // The key's short ID is 16 lowercase hex digits, as the contract says.
    let key = ok(
        &f,
        "POST",
        "/api/v1/notifications/preview",
        json!({"type":"agent_update.key_changed"}),
        &f.admin,
    )
    .await;
    let short = key["webhook"]["event"]["agent_update"]["key"]
        .as_str()
        .unwrap();
    assert!(
        short.len() == 16
            && short
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    );
    // An event that is not one of agent updates has no such member.
    let other = ok(
        &f,
        "POST",
        "/api/v1/notifications/preview",
        json!({"type":"rollout.failed"}),
        &f.admin,
    )
    .await;
    assert!(other["webhook"]["event"].get("agent_update").is_none());
    // A channel may ask for any of the eleven events and lists them in the order
    // the dashboard shows them.
    let hook = Hook::new().await;
    let mut all: Vec<&str> = notifications::EVENTS.to_vec();
    all.reverse();
    assert_eq!(all.len(), 11);
    let created = channel(&f, &hook, "/everything", json!({"events":all})).await;
    assert_eq!(
        created["rules"]["events"],
        json!(notifications::EVENTS),
        "{created}"
    );
    let (status, _, refusal) = send(
        &f.app,
        "POST",
        "/api/v1/notifications/channels",
        json!({
            "name":"Unknown",
            "kind":"webhook",
            "allow_private":true,
            "webhook":{"url":hook.url("/x")},
            "rules":{"events":["agent_update.started"]},
        }),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refusal}");
}

#[tokio::test]
async fn a_rollout_that_stalled_says_it_made_no_progress_for_a_day() {
    let r = Rig::build(2).await;
    let hook = Hook::new().await;
    channel(
        &r.f,
        &hook,
        "/all",
        json!({"events":["agent_update.failed"]}),
    )
    .await;
    for id in &r.ids {
        seen(&r.f, id, "2020-01-01T00:00:00Z").await;
    }
    let refs: Vec<&String> = r.ids.iter().collect();
    let rollout = r
        .start(&refs, json!({"canary_size":1,"failure_threshold":5}))
        .await;
    let at = Utc::now();
    step(&r.f, at).await;
    step(&r.f, at + Duration::hours(25)).await;
    assert_eq!(r.status(&rollout).await, "failed");
    assert_eq!(r.show(&rollout).await["failure_reason"], "stalled");
    drain(&r.f, later()).await;
    let events = hook.events("/all");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "agent_update.failed");
    assert_eq!(events[0]["severity"], "error");
    assert_eq!(
        events[0]["headline"],
        "Agent update failed: Update to 0.1.1"
    );
    assert_eq!(
        events[0]["message"],
        "It made no progress for 24 hours, so it stopped."
    );
}
