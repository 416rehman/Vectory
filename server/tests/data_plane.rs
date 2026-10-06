//! Data-plane health end to end: telemetry heartbeats open and resolve
//! DATA_PLANE_* issues, the canary gate fails on them, and the rollout page,
//! issues and overview explain it.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

struct Fixture {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    ids: Vec<String>,
    cookie: String,
    csrf: String,
    version: String,
}

async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Data-plane tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let user = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&user)
    .bind(format!("{user}@example.invalid"))
    .bind("admin")
    .bind("admin")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&user)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for n in 0..2 {
        let id = db::id();
        let d = json!({"id":id,"name":format!("web-{n}"),"vector_version":"0.58.0","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(d["name"].as_str().unwrap())
            .bind(d.to_string())
            .execute(&s.pool)
            .await
            .unwrap();
        ids.push(id);
    }
    ids.sort();
    let version = db::id();
    let configuration = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "configuration",
        &json!({"id":configuration,"name":"Web access logs","created_at":db::now()}),
    )
    .await
    .unwrap();
    db::insert(&mut conn,"version",&json!({"id":version,"configuration_id":configuration,"number":2,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    drop(conn);
    Fixture {
        _temp: temp,
        app: api::router(s.clone()),
        s,
        ids,
        cookie: format!("vectory_session={token}"),
        csrf,
        version,
    }
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    f: &Fixture,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", &f.cookie)
                .header("x-csrf-token", &f.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn get(f: &Fixture, path: &str) -> Value {
    let (status, body) = call(&f.app, "GET", path, Value::Null, f).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}
async fn canary(f: &Fixture) -> Value {
    let (status, d) = call(&f.app, "POST", "/api/v1/deployments", json!({"version_id":f.version,"selector":{"group_ids":[],"device_ids":f.ids,"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":{"kind":"canary","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}}), f).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}
async fn agent(f: &Fixture, id: &str) -> Router {
    let peer = db::id();
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
        .bind(&peer)
        .bind(id)
        .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
        .execute(&f.s.pool)
        .await
        .unwrap();
    vectory_server::device::router(f.s.clone()).layer(axum::Extension(
        vectory_server::device::PeerCertificate(Some(peer)),
    ))
}

/// One heartbeat carrying a telemetry sample. Evaluations are coalesced by
/// server time, so the stored evaluation time is moved back first: this
/// stands in for the heartbeat interval passing.
async fn beat(f: &Fixture, agent: &Router, device: &str, n: i64, telemetry: Value) {
    let at = chrono::Utc::now() - chrono::Duration::seconds(100 - n);
    beat_at(f, agent, device, at, telemetry).await;
}
/// Like `beat`, with the sample stamped by the device's own clock at `at`.
async fn beat_at(
    f: &Fixture,
    agent: &Router,
    device: &str,
    at: chrono::DateTime<chrono::Utc>,
    telemetry: Value,
) {
    sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.evaluated_at','2000-01-01T00:00:00Z') WHERE device_id=?")
        .bind(device)
        .execute(&f.s.pool)
        .await
        .unwrap();
    let mut sample = telemetry;
    sample["sampled_at"] = json!(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let logs = json!([{"fingerprint":"0123456789abcdef","level":"error","component_id":"archive","component_kind":"sink","component_type":"http","reason":"connection_refused","message":"Connection refused (os error 111) to 127.0.0.1:1","count":13,"first_seen":db::now(),"last_seen":db::now()}]);
    heartbeat(agent, sample, json!({"vector_log_summary":logs})).await;
}
/// A verified heartbeat carrying `sample` plus any `extra` heartbeat fields.
async fn heartbeat(agent: &Router, sample: Value, extra: Value) {
    let mut v = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false,"telemetry":sample});
    for (key, value) in extra.as_object().unwrap() {
        v[key] = value.clone();
    }
    let response = agent
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/v1/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
fn failing() -> Value {
    json!({"events_per_second":5.0,"events_out_per_second":0.0,"errors_per_minute":12.0,"components":[
        {"id":"demo","kind":"source","type":"demo_logs","events_per_second":5.0},
        {"id":"archive","kind":"sink","type":"http","received_events_per_second":0.0,"events_per_second":0.0,"errors_per_minute":12.0,"dropped_per_minute":0.0,"buffer_utilization":0.42}
    ]})
}
fn healthy() -> Value {
    json!({"events_per_second":5.0,"events_out_per_second":5.0,"errors_per_minute":0.0,"components":[
        {"id":"demo","kind":"source","type":"demo_logs","events_per_second":5.0},
        {"id":"archive","kind":"sink","type":"http","received_events_per_second":5.0,"events_per_second":5.0,"errors_per_minute":0.0,"dropped_per_minute":0.0,"buffer_utilization":0.01}
    ]})
}
async fn generation(f: &Fixture, d: &Value, device: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(d["id"].as_str().unwrap())
    .bind(device)
    .fetch_one(&f.s.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn failing_sink_fails_the_canary_explains_why_and_resolves_when_fixed() {
    let f = fixture().await;
    let d = canary(&f).await;
    let id = d["id"].as_str().unwrap();
    let canary_device = f.ids[0].clone();
    let peer = agent(&f, &canary_device).await;

    // Applied and verified, but the first sample is not yet a verdict.
    beat(&f, &peer, &canary_device, 1, failing()).await;
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    assert_eq!(summary["status"], "active");
    assert_eq!(summary["canary_gate"]["state"], "waiting");
    assert_eq!(summary["canary_gate"]["reasons"]["measuring"], 1);
    let device = get(&f, &format!("/api/v1/devices/{canary_device}")).await;
    assert_eq!(device["status"], "verified");
    assert_eq!(device["data_plane"]["issues"], json!([]));
    assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 0);

    // The second consecutive failing sample opens the issue.
    beat(&f, &peer, &canary_device, 2, failing()).await;
    let device = get(&f, &format!("/api/v1/devices/{canary_device}")).await;
    assert_eq!(device["status"], "verified", "apply state stays separate");
    let open = &device["data_plane"]["issues"][0];
    assert_eq!(open["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(open["component_id"], "archive");
    assert_eq!(open["title"], "archive can't deliver events");
    assert_eq!(
        open["message"],
        "The http sink archive is failing about 12 requests a minute (connection refused)."
    );
    assert!(open["hint"].as_str().unwrap().contains("reachable"));

    let targets = get(&f, &format!("/api/v1/deployments/{id}/targets")).await;
    let gate = targets["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["device_id"] == canary_device.as_str())
        .unwrap();
    assert_eq!(gate["gate_reason"], "degraded");

    // The scheduler fails the rollout like an apply failure over threshold 0.
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    assert_eq!(summary["status"], "failed");
    assert_eq!(summary["failure_reason"], "data_plane");
    assert_eq!(generation(&f, &d, &f.ids[1]).await, 0, "no batch released");
    // The targets page keeps the recorded state and adds the delivery reason.
    let targets = get(&f, &format!("/api/v1/deployments/{id}/targets")).await;
    let row = targets["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["device_id"] == canary_device.as_str())
        .unwrap();
    assert_eq!(row["state"], "verified_applied");
    assert_eq!(row["delivery"]["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(row["delivery"]["title"], "archive can't deliver events");
    assert!(
        row["delivery"]["hint"]
            .as_str()
            .unwrap()
            .contains("reachable")
    );
    let other = targets["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["device_id"] == f.ids[1].as_str())
        .unwrap();
    assert!(
        other.get("delivery").is_none(),
        "only degraded rows carry it"
    );

    let lanes = get(&f, &format!("/api/v1/deployments/{id}/rollout")).await;
    assert_eq!(lanes["stages"][0]["state"], "failed");
    assert_eq!(lanes["stages"][0]["devices"][0]["state"], "degraded");
    let failure = &lanes["failures"][0];
    assert_eq!(failure["state"], "degraded");
    assert_eq!(failure["message"], "archive can't deliver events");
    assert!(
        failure["diagnostic"]
            .as_str()
            .unwrap()
            .contains("connection refused")
    );
    assert!(failure["fix"].as_str().unwrap().contains("reachable"));

    let issues = get(&f, "/api/v1/issues/history").await;
    assert_eq!(issues["total"], 1);
    let issue = &issues["items"][0];
    assert_eq!(issue["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(issue["title"], "archive can't deliver events");
    assert_eq!(issue["stage"], "delivery");
    assert_eq!(issue["configuration_name"], "Web access logs");
    assert_eq!(issue["diagnostics"][1]["code"], "VECTOR_LOG");
    let groups = get(&f, "/api/v1/issues/groups").await;
    assert_eq!(groups["items"][0]["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(
        get(&f, "/api/v1/issues/history?search=can't%20deliver").await["total"],
        1
    );

    let overview = get(&f, "/api/v1/overview").await;
    assert_eq!(overview["devices_degraded"], 1);
    let degraded = overview["attention"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["cause"] == "degraded")
        .expect("Needs you lists the degraded device");
    assert_eq!(degraded["count"], 1);
    assert_eq!(degraded["title"], "archive can't deliver events");
    assert_eq!(degraded["configuration_name"], "Web access logs");
    assert!(degraded["fix"].as_str().unwrap().contains("reachable"));

    // Three clean samples resolve it (hysteresis), not the first one.
    for n in 3..5 {
        beat(&f, &peer, &canary_device, n, healthy()).await;
        assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 1);
    }
    beat(&f, &peer, &canary_device, 5, healthy()).await;
    assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 0);
    let resolved = get(&f, "/api/v1/issues/history?state=resolved").await;
    assert_eq!(resolved["items"][0]["resolved_reason"], "healthy");
    let device = get(&f, &format!("/api/v1/devices/{canary_device}")).await;
    assert_eq!(device["data_plane"]["issues"], json!([]));
    let overview = get(&f, "/api/v1/overview").await;
    assert_eq!(overview["devices_degraded"], 0);
    assert!(
        overview["attention"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["cause"] != "degraded")
    );
    // A recurrence reopens the same issue as a new occurrence.
    beat(&f, &peer, &canary_device, 6, failing()).await;
    beat(&f, &peer, &canary_device, 7, failing()).await;
    let reopened = get(&f, "/api/v1/issues/history").await;
    assert_eq!(reopened["total"], 1);
    assert_eq!(reopened["items"][0]["count"], 2);
}

#[tokio::test]
async fn healthy_canary_is_measured_then_admits_the_next_batch() {
    let f = fixture().await;
    let d = canary(&f).await;
    let id = d["id"].as_str().unwrap();
    let canary_device = f.ids[0].clone();
    let peer = agent(&f, &canary_device).await;
    for n in 1..=2 {
        beat(&f, &peer, &canary_device, n, healthy()).await;
        vectory_server::rollout::tick(&f.s).await.unwrap();
        let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
        assert_eq!(summary["canary_gate"]["reasons"]["measuring"], 1, "{n}");
        assert!(summary["canary_gate"]["observation_started_at"].is_null());
    }
    beat(&f, &peer, &canary_device, 3, healthy()).await;
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    assert_eq!(summary["canary_gate"]["state"], "observing");
    assert_eq!(summary["canary_gate"]["reasons"]["measuring"], 0);
    assert_eq!(summary["canary_gate"]["reasons"]["degraded"], 0);
    let mut conn = f.s.pool.acquire().await.unwrap();
    let mut stored = db::record(&mut conn, "deployment", id).await.unwrap();
    stored["observation_started_at"] =
        json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    db::update(&mut conn, "deployment", &stored).await.unwrap();
    drop(conn);
    vectory_server::rollout::tick(&f.s).await.unwrap();
    assert!(
        generation(&f, &d, &f.ids[1]).await > 0,
        "next batch released"
    );
    assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 0);
    let lanes = get(&f, &format!("/api/v1/deployments/{id}/rollout")).await;
    assert_eq!(lanes["failures"], json!([]));
}

#[tokio::test]
async fn stalled_pipeline_with_a_full_buffer_opens_a_stall_after_three_samples() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    // The stuck sink backed off: no errors any more, but nothing moves.
    let stuck = json!({"events_per_second":5.0,"events_out_per_second":0.0,"components":[
        {"id":"archive","kind":"sink","type":"http","received_events_per_second":0.0,"events_per_second":0.0,"errors_per_minute":0.0,"dropped_per_minute":0.0,"buffer_utilization":1.0}
    ]});
    for n in 1..=3 {
        beat(&f, &peer, &device, n, stuck.clone()).await;
    }
    let codes: Vec<String> =
        get(&f, &format!("/api/v1/devices/{device}")).await["data_plane"]["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["code"].as_str().unwrap().to_owned())
            .collect();
    assert_eq!(codes, ["DATA_PLANE_STALLED", "DATA_PLANE_BUFFER_FULL"]);
    let stall = get(&f, "/api/v1/issues/history?search=stopped%20delivering").await;
    assert_eq!(stall["total"], 1);
    assert_eq!(
        stall["items"][0]["title"],
        "The pipeline stopped delivering"
    );
    assert!(
        stall["items"][0]["message"]
            .as_str()
            .unwrap()
            .contains("archive's buffer is 100% full")
    );
}

#[tokio::test]
async fn verification_and_coalescing_never_resolve_or_double_count_delivery_issues() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    beat(&f, &peer, &device, 1, failing()).await;
    beat(&f, &peer, &device, 2, failing()).await;
    let issue = get(&f, "/api/v1/issues/history").await["items"][0].clone();
    assert_eq!(issue["reports"], 1);
    // A heartbeat inside the evaluation interval is not evaluated again, and
    // a verified configuration does not resolve a delivery problem.
    let mut sample = healthy();
    sample["sampled_at"] = json!(db::now());
    let v = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false,"telemetry":sample});
    let (status, _) = call(&peer, "POST", "/agent/v1/heartbeat", v, &f).await;
    assert_eq!(status, StatusCode::OK);
    let after = get(&f, "/api/v1/issues/history").await;
    assert_eq!(after["total"], 1);
    assert_eq!(after["items"][0]["reports"], 1);
    let state: String = sqlx::query_scalar("SELECT data FROM data_plane_state WHERE device_id=?")
        .bind(&device)
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(db::parse(&state).unwrap()["evaluations"], 2);
}

#[tokio::test]
async fn turning_metrics_off_closes_delivery_issues_instead_of_leaving_a_stale_flag() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    beat(&f, &peer, &device, 1, failing()).await;
    beat(&f, &peer, &device, 2, failing()).await;
    assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 1);
    let flagged = get(&f, &format!("/api/v1/devices/{device}")).await;
    assert_eq!(
        flagged["data_plane"]["issues"][0]["code"],
        "DATA_PLANE_SINK_ERRORS"
    );
    // The operator turns metrics off: delivery can't be judged any more.
    sqlx::query(
        "UPDATE devices SET policy=json_set(policy,'$.telemetry_enabled',json('false')) WHERE id=?",
    )
    .bind(&device)
    .execute(&f.s.pool)
    .await
    .unwrap();
    beat(&f, &peer, &device, 3, failing()).await;
    assert_eq!(get(&f, "/api/v1/issues/history").await["total"], 0);
    let resolved = get(&f, "/api/v1/issues/history?state=resolved").await;
    assert_eq!(resolved["items"][0]["resolved_reason"], "unmonitored");
    let record = get(&f, &format!("/api/v1/devices/{device}")).await;
    assert!(record.get("data_plane").is_none(), "{record}");
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM data_plane_state WHERE device_id=?")
        .bind(&device)
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    assert_eq!(get(&f, "/api/v1/overview").await["devices_degraded"], 0);
}

#[tokio::test]
async fn the_longest_component_names_never_fail_a_heartbeat() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    let id = "s".repeat(100);
    let long = json!({"events_per_second":5.0,"events_out_per_second":0.0,"components":[
        {"id":id,"kind":"sink","type":"t".repeat(64),"received_events_per_second":0.0,"events_per_second":0.0,"errors_per_minute":123456789.0,"dropped_per_minute":123456789.0,"buffer_utilization":1.0}
    ]});
    // beat() asserts that every heartbeat is accepted.
    for n in 1..=3 {
        beat(&f, &peer, &device, n, long.clone()).await;
    }
    let record = get(&f, &format!("/api/v1/devices/{device}")).await;
    let codes: Vec<&str> = record["data_plane"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["code"].as_str().unwrap())
        .collect();
    assert_eq!(
        codes,
        [
            "DATA_PLANE_STALLED",
            "DATA_PLANE_SINK_ERRORS",
            "DATA_PLANE_BUFFER_FULL",
            "DATA_PLANE_ERROR_DROPS"
        ]
    );
    // Every stored issue kept its diagnostics: they fit the stored bound.
    let listed = get(&f, "/api/v1/issues/history").await;
    assert_eq!(listed["total"], 4);
    for item in listed["items"].as_array().unwrap() {
        assert!(
            !item["diagnostics"].as_array().unwrap().is_empty(),
            "{item}"
        );
    }
}

async fn group_of(f: &Fixture, ids: &[String]) -> String {
    let group = db::id();
    let mut conn = f.s.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "group",
        &json!({"id":group,"name":"web","description":"","device_ids":ids,"created_at":db::now(),"revision":1}),
    )
    .await
    .unwrap();
    group
}
async fn persistent(f: &Fixture, group: &str, rollout: Value) -> Value {
    let (status, d) = call(
        &f.app,
        "POST",
        "/api/v1/deployments",
        json!({"version_id":f.version,"selector":{"group_ids":[group],"device_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":rollout}),
        f,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}

#[tokio::test]
async fn a_finished_persistent_assignment_keeps_following_its_group_while_a_member_is_not_delivering()
 {
    let f = fixture().await;
    let group = group_of(&f, &f.ids).await;
    let d = persistent(
        &f,
        &group,
        json!({"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}),
    )
    .await;
    let id = d["id"].as_str().unwrap();
    let first = agent(&f, &f.ids[0]).await;
    let second = agent(&f, &f.ids[1]).await;
    beat(&f, &first, &f.ids[0], 1, healthy()).await;
    beat(&f, &second, &f.ids[1], 1, healthy()).await;
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    assert_eq!(summary["status"], "completed", "{summary}");

    // One member's destination goes down: two evaluations open its issues.
    beat(&f, &first, &f.ids[0], 2, failing()).await;
    beat(&f, &first, &f.ids[0], 3, failing()).await;
    let device = get(&f, &format!("/api/v1/devices/{}", f.ids[0])).await;
    assert_eq!(
        device["data_plane"]["issues"][0]["code"],
        "DATA_PLANE_SINK_ERRORS"
    );

    // The group gains a member. That must release the new device, and the
    // assignment must not turn into a configuration failure.
    let extra = db::id();
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&extra)
        .bind("web-new")
        .bind(json!({"id":extra,"name":"web-new","vector_version":"0.58.0","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0}).to_string())
        .execute(&f.s.pool)
        .await
        .unwrap();
    let mut members = f.ids.clone();
    members.push(extra.clone());
    sqlx::query("UPDATE records SET data=json_set(data,'$.device_ids',json(?),'$.revision',2) WHERE kind='group' AND id=?")
        .bind(json!(members).to_string())
        .bind(&group)
        .execute(&f.s.pool)
        .await
        .unwrap();
    let mut conn = f.s.pool.acquire().await.unwrap();
    vectory_server::rollout::reconcile_membership(&mut conn)
        .await
        .unwrap();
    drop(conn);
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    assert_ne!(summary["status"], "failed", "{summary}");
    assert!(summary["failure_reason"].is_null(), "{summary}");
    assert!(
        generation(&f, &d, &extra).await > 0,
        "the new member was not released: {summary}"
    );
}

#[tokio::test]
async fn a_persistent_canary_that_is_not_delivering_pauses_instead_of_failing() {
    let f = fixture().await;
    let group = group_of(&f, &f.ids).await;
    let d = persistent(
        &f,
        &group,
        json!({"kind":"canary","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}),
    )
    .await;
    let id = d["id"].as_str().unwrap();
    let canary_device = f.ids[0].clone();
    let peer = agent(&f, &canary_device).await;
    beat(&f, &peer, &canary_device, 1, failing()).await;
    beat(&f, &peer, &canary_device, 2, failing()).await;
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let summary = get(&f, &format!("/api/v1/deployments/{id}/summary")).await;
    // The next wave is held back, and the assignment still follows its group.
    assert_eq!(summary["status"], "paused", "{summary}");
    assert_eq!(summary["failure_reason"], "data_plane", "{summary}");
    assert_eq!(generation(&f, &d, &f.ids[1]).await, 0, "no batch released");
}

fn many_failing(sinks: usize) -> Value {
    let mut components =
        vec![json!({"id":"demo","kind":"source","type":"demo_logs","events_per_second":5.0})];
    for n in 0..sinks {
        components.push(json!({"id":format!("sink_{n}"),"kind":"sink","type":"http","received_events_per_second":1.0,"events_per_second":1.0,"errors_per_minute":12.0,"dropped_per_minute":0.0,"buffer_utilization":0.1}));
    }
    json!({"events_per_second":5.0,"events_out_per_second":5.0,"errors_per_minute":12.0,"components":components})
}
async fn open_delivery_issues(f: &Fixture, code: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='issue' AND json_extract(data,'$.code')=? AND COALESCE(json_type(data,'$.resolved')='true',0)=0")
        .bind(code)
        .fetch_one(&f.s.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_steady_outage_refreshes_its_issue_every_few_minutes_not_every_evaluation() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    let reports = |f: &Fixture| {
        let pool = f.s.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>("SELECT json_extract(data,'$.reports') FROM records WHERE kind='issue' AND json_extract(data,'$.code')='DATA_PLANE_SINK_ERRORS'")
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    beat(&f, &peer, &device, 1, failing()).await;
    beat(&f, &peer, &device, 2, failing()).await;
    assert_eq!(reports(&f).await, 1, "opening writes the issue once");
    // Three more evaluations of the same outage write nothing.
    for n in 3..=5 {
        beat(&f, &peer, &device, n, failing()).await;
    }
    assert_eq!(
        reports(&f).await,
        1,
        "a refresh inside five minutes is not written"
    );
    // Once the last write is old enough, the next evaluation flushes what it
    // counted, so `reports` still counts every evaluation.
    sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.keys.\"DATA_PLANE_SINK_ERRORS:archive\".written_at','2000-01-01T00:00:00Z') WHERE device_id=?")
        .bind(&device)
        .execute(&f.s.pool)
        .await
        .unwrap();
    beat(&f, &peer, &device, 6, failing()).await;
    assert_eq!(reports(&f).await, 5);
}

#[tokio::test]
async fn one_evaluation_writes_at_most_three_issues_and_the_rest_follow() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    beat(&f, &peer, &device, 1, many_failing(5)).await;
    beat(&f, &peer, &device, 2, many_failing(5)).await;
    assert_eq!(
        open_delivery_issues(&f, "DATA_PLANE_SINK_ERRORS").await,
        3,
        "the write budget of one evaluation"
    );
    beat(&f, &peer, &device, 3, many_failing(5)).await;
    assert_eq!(open_delivery_issues(&f, "DATA_PLANE_SINK_ERRORS").await, 5);
}

#[tokio::test]
async fn healthy_devices_keep_no_streak_entries_and_a_steady_summary() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    for n in 1..=4 {
        beat(&f, &peer, &device, n, healthy()).await;
    }
    let state: String = sqlx::query_scalar(
        "SELECT json_extract(data,'$.keys') FROM data_plane_state WHERE device_id=?",
    )
    .bind(&device)
    .fetch_one(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(
        state, "{}",
        "nothing is worth remembering about a healthy device"
    );
    let one = get(&f, &format!("/api/v1/devices/{device}")).await["data_plane"].clone();
    beat(&f, &peer, &device, 5, healthy()).await;
    let two = get(&f, &format!("/api/v1/devices/{device}")).await["data_plane"].clone();
    assert_eq!(
        one, two,
        "the public summary carries no timestamps or growing counts"
    );
    assert_eq!(one["evaluations"], 3, "counts stop at what the gate needs");
}

async fn evaluation_state(f: &Fixture, device: &str) -> Value {
    let raw: String = sqlx::query_scalar("SELECT data FROM data_plane_state WHERE device_id=?")
        .bind(device)
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    db::parse(&raw).unwrap()
}

#[tokio::test]
async fn a_clock_running_ahead_never_freezes_evaluation() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    let now = chrono::Utc::now();
    // A wrong time at boot: an hour ahead. That sample is not evaluated, and
    // its time is not remembered.
    beat_at(
        &f,
        &peer,
        &device,
        now + chrono::Duration::hours(1),
        failing(),
    )
    .await;
    let state = evaluation_state(&f, &device).await;
    assert_eq!(state["evaluations"], 0, "{state}");
    assert!(state["sampled_at"].is_null(), "{state}");
    // NTP corrects the clock: the next two failing samples open the issue.
    beat(&f, &peer, &device, 1, failing()).await;
    beat(&f, &peer, &device, 2, failing()).await;
    assert_eq!(open_delivery_issues(&f, "DATA_PLANE_SINK_ERRORS").await, 1);
    assert_eq!(evaluation_state(&f, &device).await["evaluations"], 2);
}

#[tokio::test]
async fn a_sample_a_few_minutes_ahead_counts_but_is_remembered_at_server_time() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    let ahead = chrono::Utc::now() + chrono::Duration::seconds(200);
    beat_at(&f, &peer, &device, ahead, failing()).await;
    let state = evaluation_state(&f, &device).await;
    assert_eq!(state["evaluations"], 1, "{state}");
    let remembered =
        chrono::DateTime::parse_from_rfc3339(state["sampled_at"].as_str().unwrap()).unwrap();
    assert!(remembered <= chrono::Utc::now(), "{state}");
    // The clock is corrected to a time before the first sample's stamp: the
    // next sample is still newer than what was remembered, so it counts.
    beat_at(
        &f,
        &peer,
        &device,
        chrono::Utc::now() + chrono::Duration::seconds(5),
        failing(),
    )
    .await;
    assert_eq!(evaluation_state(&f, &device).await["evaluations"], 2);
    assert_eq!(open_delivery_issues(&f, "DATA_PLANE_SINK_ERRORS").await, 1);
}

/// What an agent reports for a ten-component pipeline (two sources, three
/// transforms, five sinks), with every metric it can send and the last
/// three sinks failing.
fn ten_components(at: chrono::DateTime<chrono::Utc>) -> Value {
    let mut components = Vec::new();
    for n in 0..10 {
        let (kind, component_type) = match n {
            0 | 1 => ("source", "http_server"),
            2..=4 => ("transform", "remap"),
            _ => ("sink", "http"),
        };
        let failing = n >= 7;
        let mut component = json!({
            "id": format!("component_{n:02}"), "kind": kind, "type": component_type,
            "events_per_second": if failing { 0.0 } else { 124.83 },
            "received_events_per_second": 124.83, "received_bytes_per_second": 48122.5,
            "sent_bytes_per_second": if failing { 0.0 } else { 47905.25 },
            "errors": 3.0, "errors_per_minute": if failing { 12.0 } else { 0.0 },
            "discarded_events": 0.0, "discarded_intentional": 0.0, "discarded_error": 0.0,
            "filtered_per_minute": 0.0, "dropped_per_minute": 0.0,
            "utilization": 0.0213, "latency_mean_seconds": 0.000183,
        });
        if kind == "sink" {
            for (key, value) in [
                ("buffer_bytes", 1048576.0),
                ("buffer_events", 2048.0),
                ("buffer_max_events", 50000.0),
                ("buffer_max_bytes", 268435456.0),
                ("buffer_utilization", if failing { 0.62 } else { 0.04 }),
            ] {
                component[key] = json!(value);
            }
        } else {
            component["sent_by_output"] = json!({"_default": 124.83});
        }
        components.push(component);
    }
    json!({"sampled_at": at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "events_per_second": 249.66, "events_out_per_second": 249.66,
        "bytes_in_per_second": 96245.0, "bytes_out_per_second": 95810.5,
        "errors": 30.0, "errors_per_minute": 36.0, "uptime_seconds": 86412.0,
        "memory_bytes": 187432960.0, "cpu_seconds": 5123.25, "discarded_events": 0.0,
        "discarded_intentional": 0.0, "discarded_error": 0.0, "filtered_per_minute": 0.0,
        "dropped_per_minute": 0.0, "buffer_bytes": 5242880.0, "buffer_events": 10240.0,
        "buffer_utilization": 0.62, "components": components})
}

#[tokio::test]
async fn lists_leave_out_what_only_the_device_page_shows() {
    let f = fixture().await;
    canary(&f).await;
    let device = f.ids[0].clone();
    let peer = agent(&f, &device).await;
    let logs: Vec<Value> = (0..10)
        .map(|n| json!({"fingerprint":format!("{n:016x}"),"level":"error","component_id":format!("component_{:02}",7+n%3),"component_kind":"sink","component_type":"http","error_type":"request_failed","stage":"sending","reason":"connection_refused","message":format!("Service call failed. No retries or retries exhausted. error=Some(CallRequest {{ source: hyper::Error(Connect, ConnectError(\"tcp connect error\", Os {{ code: 111, kind: ConnectionRefused }})) }}) attempt={n}"),"count":120+n,"first_seen":db::now(),"last_seen":db::now()}))
        .collect();
    let extra = json!({"vector_log_summary":logs,"host_runtime":{"data_dir":"/var/lib/vector","data_dir_source":"pipeline","graceful_shutdown_seconds":60,"metrics_source":"explicit","metrics_address":"127.0.0.1:9598","activation":"reload"}});
    for n in 1..=3 {
        sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.evaluated_at','2000-01-01T00:00:00Z') WHERE device_id=?")
            .bind(&device)
            .execute(&f.s.pool)
            .await
            .unwrap();
        let at = chrono::Utc::now() - chrono::Duration::seconds(100 - n);
        heartbeat(&peer, ten_components(at), extra.clone()).await;
    }
    // The device page keeps everything.
    let full = get(&f, &format!("/api/v1/devices/{device}")).await;
    assert_eq!(
        full["telemetry"]["components"].as_array().unwrap().len(),
        10
    );
    assert_eq!(
        full["vector_log_summary"]["items"]
            .as_array()
            .unwrap()
            .len(),
        10
    );
    assert_eq!(full["host_runtime"]["activation"], "reload");
    let open = full["data_plane"]["issues"].as_array().unwrap().len();
    assert!(open > 1, "{}", full["data_plane"]);
    assert_eq!(full["data_plane"]["issue_count"], open);
    // Lists keep the first delivery issue and the count, and nothing heavy.
    let find = |rows: Value| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == device.as_str())
            .unwrap()
            .clone()
    };
    let listed = find(get(&f, "/api/v1/devices").await);
    let overview = find(get(&f, "/api/v1/overview").await["devices"].clone());
    for row in [&listed, &overview] {
        assert!(row.get("vector_log_summary").is_none(), "{row}");
        assert!(row.get("host_runtime").is_none(), "{row}");
        assert!(row["telemetry"].get("components").is_none(), "{row}");
        assert_eq!(row["telemetry"]["events_per_second"], 249.66);
        assert_eq!(
            row["data_plane"]["issues"],
            json!([full["data_plane"]["issues"][0]])
        );
        assert_eq!(row["data_plane"]["issue_count"], open);
    }
    // Otherwise a list row is the device page's row, field for field, except
    // the page's live wake-up projection, which only the device page reads.
    let mut page = full.clone();
    assert_eq!(
        page.as_object_mut().unwrap().remove("wake"),
        Some(json!({"listening": false}))
    );
    assert_eq!(listed, vectory_server::rollout::list_row(page));
    let (full_bytes, list_bytes) = (full.to_string().len(), listed.to_string().len());
    eprintln!(
        "device with 10 components: full row {full_bytes} bytes, list row {list_bytes} bytes"
    );
    assert!(
        list_bytes * 3 < full_bytes,
        "full {full_bytes}, list {list_bytes}"
    );
}
