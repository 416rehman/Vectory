//! Agent wake-ups (`GET /agent/v1/wait`): each writer that changes a device's
//! desired state answers its parked wait promptly, a rolled-back preview
//! answers nothing, and the registry stays bounded. Waits go through the real
//! agent router and changes through the real dashboard API, so the post-commit
//! flush runs exactly as in production.
use axum::{
    Extension, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize, rollout, wake};

const SECRET: &str = "isolated-wake-bootstrap-secret-123456789";
/// A parked wait must answer within this long of the change committing.
const PROMPT: Duration = Duration::from_millis(200);

async fn server(options: wake::Options) -> (tempfile::TempDir, State) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Wake-up tests".into(),
        validation_url: None,
        wake: options,
        ..Default::default()
    })
    .await
    .unwrap();
    (temp, s)
}
fn held(limit: usize, hold: Duration) -> wake::Options {
    wake::Options { limit, hold }
}

/// Synthetic devices, each with a live credential whose fingerprint is
/// `peer-<id>`. Nothing enrolls or runs an agent.
async fn devices(s: &State, count: usize) -> Vec<String> {
    let mut tx = s.pool.begin().await.unwrap();
    let expires = (chrono::Utc::now() + chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut ids = Vec::new();
    for i in 0..count {
        let id = format!("00000000-0000-4000-8000-{i:012}");
        let data = json!({"id":id,"name":format!("wake-{i:05}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","configuration_mode":"restricted","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(format!("peer-{id}"))
            .bind(&id)
            .bind(&expires)
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

fn agent(s: &State, device: &str) -> Router {
    device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(format!(
        "peer-{device}"
    )))))
}
async fn wait_request(router: Router, query: &str) -> (StatusCode, HeaderMap, Body) {
    let response = router
        .oneshot(
            Request::get(format!("/agent/v1/wait?{query}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    (parts.status, parts.headers, body)
}
/// The generations the device's agent would have accepted from its manifest.
async fn accepted(s: &State, device: &str) -> (i64, i64) {
    sqlx::query_as("SELECT desired_generation,policy_generation FROM devices WHERE id=?")
        .bind(device)
        .fetch_one(&s.pool)
        .await
        .unwrap()
}
/// A wait's answer as it completes: the time and the exact JSON. Dropping it
/// drops the body, as an agent that goes away does.
struct Pending {
    answer: oneshot::Receiver<(Instant, Value)>,
    reader: tokio::task::JoinHandle<()>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        self.reader.abort();
    }
}
fn follow(body: Body) -> Pending {
    let (send, answer) = oneshot::channel();
    let reader = tokio::spawn(async move {
        let bytes = body.collect().await.unwrap().to_bytes();
        let _ = send.send((Instant::now(), serde_json::from_slice(&bytes).unwrap()));
    });
    Pending { answer, reader }
}
/// Parks a wait at the device's current generations; fails if it answers.
async fn park(s: &State, device: &str) -> Pending {
    let (generation, policy) = accepted(s, device).await;
    let (status, headers, body) = wait_request(
        agent(s, device),
        &format!("generation={generation}&policy_generation={policy}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(headers["cache-control"], "no-store");
    let mut pending = follow(body);
    assert!(
        answered(&mut pending, Duration::from_millis(30))
            .await
            .is_none(),
        "a wait at the current generations answered at once"
    );
    assert!(s.wake.listening(device));
    pending
}
async fn answered(pending: &mut Pending, within: Duration) -> Option<(Instant, Value)> {
    tokio::time::timeout(within, &mut pending.answer)
        .await
        .ok()
        .map(Result::unwrap)
}

async fn admin(s: &State) -> (String, String) {
    let (status, v, cookie) = call(
        s,
        "POST",
        "/api/v1/bootstrap",
        json!({"bootstrap_secret":SECRET,"email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}),
        ("", ""),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    (cookie, v["csrf_token"].as_str().unwrap().into())
}
async fn call(
    s: &State,
    method: &str,
    path: &str,
    body: Value,
    (cookie, csrf): (&str, &str),
) -> (StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        request = request.header("cookie", cookie);
    }
    if !csrf.is_empty() {
        request = request.header("x-csrf-token", csrf);
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let response = api::router(s.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let out = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, out, cookie)
}
fn pipeline(interval: u64) -> Value {
    json!({"sources":{"sample":{"type":"demo_logs","format":"json","interval":interval}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}}})
}
/// A published version, through the API.
async fn publish(s: &State, session: (&str, &str), name: &str, interval: u64) -> String {
    let (status, created, _) = call(
        s,
        "POST",
        "/api/v1/configurations",
        json!({"name":name,"description":"","graph":{"nodes":[],"edges":[]},"config":pipeline(interval)}),
        session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, version, _) = call(
        s,
        "POST",
        &format!(
            "/api/v1/configurations/{}/publish",
            created["id"].as_str().unwrap()
        ),
        json!({"revision":1,"message":"v1"}),
        session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    version["id"].as_str().unwrap().into()
}
fn deployment(selector: Value, resource: Value, priority: i64) -> Value {
    let mut v = json!({"selector":selector,"priority":priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}});
    for (key, value) in resource.as_object().unwrap() {
        v[key] = value.clone();
    }
    v
}
fn devices_selector(ids: &[String]) -> Value {
    json!({"device_ids":ids,"group_ids":[],"exclude_ids":[]})
}
/// Runs a change through the API and returns when it answered.
async fn change(
    s: &State,
    session: (&str, &str),
    method: &str,
    path: &str,
    body: Value,
) -> (Value, Instant) {
    let (status, out, _) = call(s, method, path, body, session).await;
    assert!(status.is_success(), "{method} {path}: {status} {out}");
    (out, Instant::now())
}
/// The parked wait answered changed:true, at most PROMPT after the change
/// returned (the flush runs once its transaction has committed).
async fn woke(pending: &mut Pending, changed_at: Instant, what: &str) {
    let (at, answer) = answered(pending, PROMPT + Duration::from_secs(1))
        .await
        .unwrap_or_else(|| panic!("{what}: the parked wait never answered"));
    assert_eq!(answer, json!({"changed":true}), "{what}");
    let late = at.saturating_duration_since(changed_at);
    assert!(late <= PROMPT, "{what}: answered {late:?} after the change");
}

#[tokio::test]
async fn every_writer_answers_its_devices_parked_wait_within_200_ms() {
    // A long hold: the bystander's wait must still be parked at the end.
    let (_temp, s) = server(held(100, Duration::from_secs(300))).await;
    let ids = devices(&s, 3).await;
    let (cookie, csrf) = admin(&s).await;
    let session = (cookie.as_str(), csrf.as_str());
    let device = ids[0].clone();
    let bystander = ids[1].clone();
    let mut other = park(&s, &bystander).await;

    // Deployment: an assignment's release.
    let v1 = publish(&s, session, "Wake pipeline", 1).await;
    let mut pending = park(&s, &device).await;
    let (created, at) = change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(
            devices_selector(&[device.clone()]),
            json!({"version_id":v1}),
            10,
        ),
    )
    .await;
    woke(&mut pending, at, "deployment").await;
    assert!(!s.wake.listening(&device), "an answered wait still listens");
    // The answer carried no state: the device's desired generation is only
    // read by the next heartbeat. A wait at stale generations answers at once.
    let (status, _, body) =
        wait_request(agent(&s, &device), "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.collect().await.unwrap().to_bytes(),
        br#"{"changed":true}"#.as_slice()
    );

    // Agent settings (policy generation), including a sync pause.
    let mut pending = park(&s, &device).await;
    let (_, at) = change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(
            devices_selector(&[device.clone()]),
            json!({"policy":{"heartbeat_seconds":30,"sync_paused":true,"telemetry_enabled":true}}),
            10,
        ),
    )
    .await;
    woke(&mut pending, at, "agent settings").await;
    let mut pending = park(&s, &device).await;
    let (_, at) = change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(
            devices_selector(&[device.clone()]),
            json!({"policy":{"heartbeat_seconds":30,"sync_paused":false,"telemetry_enabled":true}}),
            20,
        ),
    )
    .await;
    woke(&mut pending, at, "resume sync").await;

    // Retry of a failed apply (a new desired generation, same version).
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','failed') WHERE id=?")
        .bind(&device)
        .execute(&s.pool)
        .await
        .unwrap();
    let (generation, _) = accepted(&s, &device).await;
    let mut pending = park(&s, &device).await;
    let (_, at) = change(
        &s,
        session,
        "POST",
        &format!("/api/v1/devices/{device}/retry"),
        json!({"expected_version_id":v1,"expected_generation":generation}),
    )
    .await;
    woke(&mut pending, at, "retry").await;

    // Group membership that changes resolution (a persistent assignment).
    let v2 = publish(&s, session, "Group pipeline", 2).await;
    let (status, group, _) = call(
        &s,
        "POST",
        "/api/v1/groups",
        json!({"name":"wake-group","description":"","device_ids":[ids[2]]}),
        session,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let group_id = group["id"].as_str().unwrap().to_owned();
    let mut persistent = deployment(
        json!({"device_ids":[],"group_ids":[group_id],"exclude_ids":[]}),
        json!({"version_id":v2}),
        50,
    );
    persistent["target_mode"] = json!("persistent");
    change(&s, session, "POST", "/api/v1/deployments", persistent).await;
    let mut pending = park(&s, &device).await;
    let (_, at) = change(
        &s,
        session,
        "PUT",
        &format!("/api/v1/groups/{group_id}"),
        json!({"name":"wake-group","description":"","device_ids":[ids[2],device],"revision":group["revision"]}),
    )
    .await;
    woke(&mut pending, at, "group membership").await;

    // The scheduler: a scheduled deployment activates in a tick.
    let v3 = publish(&s, session, "Scheduled pipeline", 3).await;
    let mut scheduled = deployment(
        devices_selector(&[device.clone()]),
        json!({"version_id":v3}),
        100,
    );
    let start = chrono::Utc::now() + chrono::Duration::milliseconds(1500);
    scheduled["scheduled_at"] = json!(start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    let (status, out, _) = call(&s, "POST", "/api/v1/deployments", scheduled, session).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    let mut pending = park(&s, &device).await;
    tokio::time::sleep(Duration::from_millis(1700)).await;
    wake::changes(&s, rollout::tick(&s)).await.unwrap();
    woke(&mut pending, Instant::now(), "scheduled activation").await;

    // Assignment removal: its preview runs the real resolver and rolls it
    // back, so it wakes nobody; the reviewed removal does.
    let source = out["id"].as_str().unwrap().to_owned();
    let mut pending = park(&s, &device).await;
    let woken = s.wake.woken();
    let (preview, _) = change(
        &s,
        session,
        "POST",
        &format!("/api/v1/deployments/{source}/unassign-preview"),
        json!({}),
    )
    .await;
    assert_eq!(preview["ready"], true, "{preview}");
    assert!(
        answered(&mut pending, Duration::from_millis(300))
            .await
            .is_none(),
        "a rolled-back preview woke the device"
    );
    assert_eq!(s.wake.woken(), woken);
    let (_, at) = change(
        &s,
        session,
        "POST",
        &format!("/api/v1/deployments/{source}/unassign"),
        json!({"review_token":preview["review_token"]}),
    )
    .await;
    woke(&mut pending, at, "assignment removal").await;

    // Revocation: the parked wait answers, and the next wait, like a
    // heartbeat, meets the ordinary refusal.
    let mut pending = park(&s, &device).await;
    let (_, at) = change(
        &s,
        session,
        "POST",
        &format!("/api/v1/devices/{device}/revoke"),
        json!({}),
    )
    .await;
    woke(&mut pending, at, "revocation").await;
    let (status, _, body) =
        wait_request(agent(&s, &device), "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let refusal: Value = serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(refusal["error"]["code"], "UNAUTHENTICATED");

    // Nothing else woke the device that none of these changes touched.
    assert!(
        answered(&mut other, Duration::from_millis(50))
            .await
            .is_none()
    );
    assert!(s.wake.listening(&bystander));
    let _ = created;
}

#[tokio::test]
async fn the_hold_ends_unchanged_without_reading_the_database() {
    let (_temp, s) = server(held(10, Duration::from_millis(400))).await;
    let ids = devices(&s, 1).await;
    let started = Instant::now();
    let mut pending = park(&s, &ids[0]).await;
    // Closing the pool makes any read fail: the timeout must not need one.
    s.pool.close().await;
    let (at, answer) = answered(&mut pending, Duration::from_secs(3))
        .await
        .expect("the hold never ended");
    assert_eq!(answer, json!({"changed":false}));
    let held = at.duration_since(started);
    assert!(
        held >= Duration::from_millis(390) && held < Duration::from_millis(1500),
        "held {held:?}"
    );
    assert_eq!(s.wake.parked(), 0);
}

#[tokio::test]
async fn one_wait_per_device_and_a_bounded_registry() {
    let (_temp, s) = server(held(2, Duration::from_secs(25))).await;
    let ids = devices(&s, 3).await;
    let mut first = park(&s, &ids[0]).await;
    let _second = park(&s, &ids[1]).await;
    // The cap: 503 with Retry-After and the same hint in the body.
    let (status, headers, body) =
        wait_request(agent(&s, &ids[2]), "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(headers["retry-after"], "60");
    let refusal: Value = serde_json::from_slice(&body.collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(refusal["error"]["code"], "CAPACITY_BUSY");
    assert_eq!(refusal["retry_after"], 60);
    // A newer wait from the same device replaces the older one, which
    // answers changed:false at once; replacing never needs more room.
    let started = Instant::now();
    let mut replacement = park(&s, &ids[0]).await;
    let (at, answer) = answered(&mut first, Duration::from_secs(1))
        .await
        .expect("the replaced wait never answered");
    assert_eq!(answer, json!({"changed":false}));
    assert!(at.duration_since(started) < PROMPT);
    assert_eq!(s.wake.parked(), 2);
    assert!(
        answered(&mut replacement, Duration::from_millis(50))
            .await
            .is_none()
    );
    // An agent that goes away frees its place.
    drop(replacement);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(s.wake.parked(), 1);
    let _third = park(&s, &ids[2]).await;
}

#[tokio::test]
async fn a_burst_of_1000_changes_answers_each_waiter_once() {
    let (_temp, s) = server(held(20_000, Duration::from_secs(25))).await;
    let ids = devices(&s, 1000).await;
    let (cookie, csrf) = admin(&s).await;
    let session = (cookie.as_str(), csrf.as_str());
    let v1 = publish(&s, session, "Burst v1", 1).await;
    let v2 = publish(&s, session, "Burst v2", 2).await;
    let mut pending = Vec::new();
    for id in &ids {
        let (status, _, body) =
            wait_request(agent(&s, id), "generation=0&policy_generation=0").await;
        assert_eq!(status, StatusCode::OK);
        pending.push(follow(body));
    }
    assert_eq!(s.wake.parked(), 1000);
    let started = Instant::now();
    // One deployment changes all 1,000 devices, and a second, higher-priority
    // one changes them again before any agent waits anew: each waiter is
    // answered exactly once.
    let (_, first) = change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(devices_selector(&ids), json!({"version_id":v1}), 10),
    )
    .await;
    change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(devices_selector(&ids), json!({"version_id":v2}), 20),
    )
    .await;
    let mut latest = first;
    for mut receiver in pending {
        let (at, answer) = answered(&mut receiver, Duration::from_secs(5))
            .await
            .expect("a waiter was never answered");
        assert_eq!(answer, json!({"changed":true}));
        latest = latest.max(at);
    }
    assert!(latest.saturating_duration_since(first) <= PROMPT);
    assert_eq!(s.wake.woken(), 1000, "some waiter was answered twice");
    assert_eq!(s.wake.parked(), 0);
    println!(
        "1,000 parked waits: deployment request to last answer {:?} (last answer {:?} after the response)",
        latest.duration_since(started),
        latest.saturating_duration_since(first)
    );
}

#[tokio::test]
async fn shutdown_answers_every_waiter_and_refuses_new_ones() {
    let (_temp, s) = server(held(100, Duration::from_secs(25))).await;
    let ids = devices(&s, 5).await;
    let mut pending = Vec::new();
    for id in &ids {
        pending.push(park(&s, id).await);
    }
    let started = Instant::now();
    assert_eq!(s.wake.close(), 5);
    for mut receiver in pending {
        let (at, answer) = answered(&mut receiver, Duration::from_secs(1))
            .await
            .expect("a wait outlived shutdown");
        assert_eq!(answer, json!({"changed":false}));
        assert!(at.duration_since(started) < PROMPT);
    }
    assert_eq!(s.wake.parked(), 0);
    let (status, headers, _) =
        wait_request(agent(&s, &ids[0]), "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(headers["retry-after"], "5");
}

#[tokio::test]
async fn features_refusals_and_the_listening_projection() {
    let (_temp, s) = server(held(100, Duration::from_secs(25))).await;
    let ids = devices(&s, 1).await;
    let device = &ids[0];
    // The signed manifest lists wake while the server holds waits.
    let heartbeat = json!({"protocol_version":1,"request_id":"wake-heartbeat","nonce":STANDARD.encode([7u8;32]),"boot_id":"wake-boot","agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false});
    let features = |s: State| {
        let heartbeat = heartbeat.clone();
        let device = device.clone();
        async move {
            let response = agent(&s, &device)
                .oneshot(
                    Request::post("/agent/v1/heartbeat")
                        .header("content-type", "application/json")
                        .body(Body::from(heartbeat.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let envelope: Value =
                serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                    .unwrap();
            let payload: Value = serde_json::from_slice(
                &STANDARD
                    .decode(envelope["payload"].as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
            payload["features"].clone()
        }
    };
    assert!(
        features(s.clone())
            .await
            .as_array()
            .unwrap()
            .contains(&json!("wake"))
    );
    // Refusals: no certificate, an unknown one, and a malformed query.
    let anonymous = device::router(s.clone()).layer(Extension(device::PeerCertificate(None)));
    let (status, _, _) = wait_request(anonymous, "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let stranger = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        "peer-unknown".into(),
    ))));
    let (status, _, _) = wait_request(stranger, "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    for query in [
        "generation=0",
        "generation=0&policy_generation=x",
        "generation=0&policy_generation=0&state=all",
    ] {
        let (status, _, _) = wait_request(agent(&s, device), query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
    }
    // The device page and the rollout's target rows say whether its agent
    // holds a wait right now, and nothing more.
    let (cookie, csrf) = admin(&s).await;
    let session = (cookie.as_str(), csrf.as_str());
    let (_, detail, _) = call(
        &s,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        session,
    )
    .await;
    assert_eq!(detail["wake"], json!({"listening":false}));
    let mut pending = park(&s, device).await;
    let (_, detail, _) = call(
        &s,
        "GET",
        &format!("/api/v1/devices/{device}"),
        Value::Null,
        session,
    )
    .await;
    assert_eq!(detail["wake"], json!({"listening":true}));
    let version = publish(&s, session, "Projection", 1).await;
    let (created, at) = change(
        &s,
        session,
        "POST",
        "/api/v1/deployments",
        deployment(devices_selector(&ids), json!({"version_id":version}), 10),
    )
    .await;
    woke(&mut pending, at, "deployment").await;
    let targets = format!(
        "/api/v1/deployments/{}/targets",
        created["id"].as_str().unwrap()
    );
    let (_, page, _) = call(&s, "GET", &targets, Value::Null, session).await;
    assert_eq!(page["items"][0]["wake"], json!({"listening":false}));
    let _again = park(&s, device).await;
    let (status, page, _) = call(&s, "GET", &targets, Value::Null, session).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["items"][0]["wake"], json!({"listening":true}));
    assert_eq!(page["total"], 1);

    // With wake-ups off the manifest stops listing the feature, the route is
    // gone and no projection claims anything.
    let (_off_temp, off) = server(held(0, Duration::from_secs(25))).await;
    devices(&off, 1).await;
    assert!(
        !features(off.clone())
            .await
            .as_array()
            .unwrap()
            .contains(&json!("wake"))
    );
    let (status, _, _) =
        wait_request(agent(&off, device), "generation=0&policy_generation=0").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(off.wake.projection(device), None);
}
