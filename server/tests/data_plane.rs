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
    sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.evaluated_at','2000-01-01T00:00:00Z') WHERE device_id=?")
        .bind(device)
        .execute(&f.s.pool)
        .await
        .unwrap();
    let mut sample = telemetry;
    sample["sampled_at"] = json!(
        (chrono::Utc::now() - chrono::Duration::seconds(100 - n))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
    let v = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false,"telemetry":sample,
        "vector_log_summary":[{"fingerprint":"0123456789abcdef","level":"error","component_id":"archive","component_kind":"sink","component_type":"http","reason":"connection_refused","message":"Connection refused (os error 111) to 127.0.0.1:1","count":13,"first_seen":db::now(),"last_seen":db::now()}]});
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
