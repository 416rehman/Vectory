//! First-run truth: what keeps an agent running, whether Vector runs,
//! a first version that couldn't start, and delivery health measured from
//! Vector's log when a device reports no metrics.
use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize, rollout};

async fn state() -> (tempfile::TempDir, State) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "First-run truth".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    (temp, s)
}
async fn call(
    app: Router,
    method: &str,
    path: &str,
    v: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        request = request.header("cookie", cookie)
    }
    if !csrf.is_empty() {
        request = request.header("x-csrf-token", csrf)
    }
    let response = app
        .oneshot(request.body(Body::from(v.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn admin(s: &State) -> (String, String) {
    let response = api::router(s.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/bootstrap")
                .header("content-type", "application/json")
                .body(Body::from(json!({"bootstrap_secret":"isolated-test-bootstrap-secret-123456789","email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    (cookie, v["csrf_token"].as_str().unwrap().to_owned())
}
async fn enroll(s: &State, cookie: &str, csrf: &str, name: &str, extra: Value) -> String {
    let (status, token) = call(
        api::router(s.clone()),
        "POST",
        "/api/v1/tokens",
        json!({"name":format!("{name} install command"),"expires_hours":1}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let key = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    let mut request = json!({"protocol_version":1,"request_id":format!("request-{name}"),"token":token["token"],"name":name,"csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"0.1.0-dev","vector_version":"0.58.0"});
    for (key, value) in extra.as_object().unwrap() {
        request[key] = value.clone();
    }
    let (status, credential) = call(
        device::router(s.clone()),
        "POST",
        "/agent/v1/enroll",
        request,
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{credential}");
    credential["device_id"].as_str().unwrap().to_owned()
}
async fn agent(s: &State, id: &str) -> Router {
    let fingerprint: String =
        sqlx::query_scalar("SELECT fingerprint FROM credentials WHERE device_id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))))
}
fn heartbeat(generation: i64, actual: &str, state: &str, extra: Value) -> Value {
    let mut v = json!({"protocol_version":1,"request_id":db::id(),"nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","boot_id":"boot","agent_version":"0.1.0-dev","vector_version":"0.58.0","reported_generation":generation,"policy_generation":0,"actual_sha256":actual,"apply_state":state,"local_paused":false,"remote_pause_acknowledged":false});
    for (key, value) in extra.as_object().unwrap() {
        v[key] = value.clone();
    }
    v
}
async fn beat(agent: &Router, body: Value) -> (StatusCode, Value) {
    call(agent.clone(), "POST", "/agent/v1/heartbeat", body, "", "").await
}
async fn shown(s: &State, id: &str) -> (Value, Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    let device = rollout::devices(&mut conn)
        .await
        .unwrap()
        .into_iter()
        .find(|d| d["id"] == id)
        .unwrap();
    (rollout::list_row(device.clone()), device)
}
fn manifest(envelope: &Value) -> Value {
    use base64::Engine;
    let payload = base64::engine::general_purpose::STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    serde_json::from_slice(&payload).unwrap()
}

/// Deploys a published first version of `name` to `device` and returns its
/// version ID. The artifact is "{}\n".
async fn first_version(s: &State, device: &str, name: &str) -> String {
    let version = db::id();
    let configuration = db::id();
    let mut tx = s.pool.begin().await.unwrap();
    db::insert(
        &mut tx,
        "configuration",
        &json!({"id":configuration,"name":name,"created_at":db::now()}),
    )
    .await
    .unwrap();
    db::insert(&mut tx,"version",&json!({"id":version,"configuration_id":configuration,"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    rollout::create(&mut tx, &json!({"version_id":version,"selector":{"device_ids":[device],"group_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}}), "operator").await.unwrap();
    tx.commit().await.unwrap();
    version
}

#[tokio::test]
async fn devices_report_what_keeps_the_agent_running_and_whether_vector_runs() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    // Setup names the service manager it chose; a value this server doesn't
    // know never refuses an enrollment.
    let auto = enroll(
        &s,
        &cookie,
        &csrf,
        "edge-auto",
        json!({"service_manager":"none"}),
    )
    .await;
    let future = enroll(
        &s,
        &cookie,
        &csrf,
        "edge-future",
        json!({"service_manager":"openrc"}),
    )
    .await;
    let (row, _) = shown(&s, &auto).await;
    assert_eq!(
        row["service_manager"], "none",
        "list rows carry it for Add device"
    );
    assert!(shown(&s, &future).await.0.get("service_manager").is_none());

    // The manifest lists both fields; heartbeats that carry them update the
    // device.
    let peer = agent(&s, &auto).await;
    let (status, envelope) = beat(
        &peer,
        heartbeat(
            0,
            "",
            "unmanaged",
            json!({"service_manager":"systemd","vector_running":false}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let features = manifest(&envelope)["features"].clone();
    for feature in ["service_manager", "vector_running"] {
        assert!(
            features.as_array().unwrap().contains(&json!(feature)),
            "{features}"
        );
    }
    let (row, full) = shown(&s, &auto).await;
    assert_eq!(
        (
            row["service_manager"].clone(),
            row["vector_running"].clone()
        ),
        (json!("systemd"), json!(false))
    );
    assert_eq!(full["vector_running"], false);

    // A check-in without them keeps what keeps the agent running and
    // forgets whether Vector runs: that is current or unknown, never stale.
    assert_eq!(
        beat(&peer, heartbeat(0, "", "unmanaged", json!({})))
            .await
            .0,
        StatusCode::OK
    );
    let (row, _) = shown(&s, &auto).await;
    assert_eq!(row["service_manager"], "systemd");
    assert!(row.get("vector_running").is_none());

    // Values outside the contract reject the heartbeat and change nothing.
    for bad in [
        json!({"service_manager":"openrc"}),
        json!({"service_manager":7}),
        json!({"vector_running":"yes"}),
    ] {
        let (status, _) = beat(&peer, heartbeat(0, "", "unmanaged", bad.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    assert_eq!(shown(&s, &auto).await.0["service_manager"], "systemd");
}

#[tokio::test]
async fn a_first_version_that_could_not_start_says_so_and_nothing_claims_to_run() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let id = enroll(
        &s,
        &cookie,
        &csrf,
        "r16-full",
        json!({"service_manager":"none"}),
    )
    .await;
    let version = first_version(&s, &id, "r16-lowport").await;
    let peer = agent(&s, &id).await;
    let reason = "Vector can't listen on 127.0.0.1:514: ports below 1024 need a privilege the service account lacks.";
    let attempt = json!({"generation":1,"version_id":version,"sha256":db::hash("{}\n"),"state":"failed","error":{"code":"ROLLBACK_UNAVAILABLE","stage":"rollback","message":"agent text","diagnostics":[{"severity":"error","code":"PRIVILEGED_PORT","component_kind":"source","component_id":"syslog","message":reason,"hint":"Use a port of 1024 or above, or grant the service CAP_NET_BIND_SERVICE."}]}});
    let body = heartbeat(
        0,
        "",
        "failed",
        json!({"configuration_attempt":attempt,"error":attempt["error"],"vector_running":false}),
    );
    let (status, envelope) = beat(&peer, body).await;
    assert_eq!(status, StatusCode::OK, "{envelope}");

    let (_, device) = shown(&s, &id).await;
    assert_eq!(device["status"], "failed");
    assert_eq!(device["actual_sha256"], Value::Null);
    assert_eq!(device["vector_running"], false);
    assert_eq!(device["running_version"], Value::Null);

    let app = api::router(s.clone());
    let (_, page) = call(
        app.clone(),
        "GET",
        "/api/v1/issues/history",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(page["total"], 1, "{page}");
    let issue = &page["items"][0];
    assert_eq!(issue["code"], "ROLLBACK_UNAVAILABLE");
    assert_eq!(issue["title"], "r16-full couldn't start r16-lowport v1");
    assert_eq!(
        issue["message"],
        format!("{} (syslog).", reason.trim_end_matches('.'))
    );
    let (_, groups) = call(
        app.clone(),
        "GET",
        "/api/v1/issues/groups",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(
        groups["items"][0]["title"],
        "r16-full couldn't start r16-lowport v1"
    );
    // Search finds the plain words.
    let (_, found) = call(
        app,
        "GET",
        "/api/v1/issues/history?search=couldn't%20start",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(found["total"], 1);
    // The rollout target explains it without claiming a restore.
    let mut conn = s.pool.acquire().await.unwrap();
    let error: String =
        sqlx::query_scalar("SELECT error FROM deployment_targets WHERE device_id=?")
            .bind(&id)
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    assert!(
        error.starts_with("The first version couldn't start. "),
        "{error}"
    );
    assert!(!error.contains("couldn't be undone"), "{error}");
}

fn log_summary(count: u64) -> Value {
    json!([
        {"fingerprint":"0123456789abcdef","level":"warn","component_id":"out","component_kind":"sink","component_type":"http","error_type":"request_failed","stage":"processing","reason":"connection_refused","message":"HTTP error. error trying to connect: tcp connect error: Connection refused (os error 111)","count":count,"first_seen":"2026-09-29T17:00:00Z","last_seen":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)},
        {"fingerprint":"fedcba9876543210","level":"warn","component_id":"out","component_kind":"sink","component_type":"http","reason":"connection_refused","message":"Retrying after error. Connection refused (os error 111)","count":count,"first_seen":"2026-09-29T17:00:00Z","last_seen":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)}
    ])
}
/// A verified check-in with no metrics, carrying Vector's log summary.
/// Evaluations are coalesced by server time, so the stored evaluation time
/// moves back first: this stands in for the heartbeat interval passing.
async fn logged(s: &State, peer: &Router, id: &str, metrics_source: &str, count: u64) {
    sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.evaluated_at','2000-01-01T00:00:00Z','$.log_evaluated_at',?) WHERE device_id=?")
        .bind((chrono::Utc::now() - chrono::Duration::seconds(60)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    let body = heartbeat(
        1,
        &db::hash("{}\n"),
        "verified_applied",
        json!({"host_runtime":{"metrics_source":metrics_source},"vector_log_summary":log_summary(count)}),
    );
    let (status, envelope) = beat(peer, body).await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
}
async fn open_delivery(s: &State, cookie: &str) -> Value {
    let (_, page) = call(
        api::router(s.clone()),
        "GET",
        "/api/v1/issues/history?state=all",
        Value::Null,
        cookie,
        "",
    )
    .await;
    page
}

#[tokio::test]
async fn without_metrics_vectors_log_opens_and_resolves_delivery_issues() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let id = enroll(&s, &cookie, &csrf, "r16-host", json!({})).await;
    first_version(&s, &id, "r16-http-sink").await;
    let peer = agent(&s, &id).await;

    // One check-in with failures is not yet a verdict.
    logged(&s, &peer, &id, "none", 13).await;
    let (_, device) = shown(&s, &id).await;
    assert_eq!(device["status"], "verified");
    assert_eq!(device["data_plane"]["issues"], json!([]));
    assert_eq!(
        device["data_plane"]["evaluations"], 0,
        "the log doesn't measure delivery"
    );
    assert_eq!(open_delivery(&s, &cookie).await["total"], 0);

    // Failures still growing at the next check-in open the issue.
    logged(&s, &peer, &id, "none", 40).await;
    let (row, device) = shown(&s, &id).await;
    let issue = &device["data_plane"]["issues"][0];
    assert_eq!(issue["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(issue["title"], "out can't deliver events");
    assert_eq!(
        issue["message"],
        "The http sink out is failing about 27 requests a minute (connection refused), measured from Vector's log (no metrics)."
    );
    assert_eq!(
        row["data_plane"]["issue_count"], 1,
        "Overview and lists see it"
    );
    let page = open_delivery(&s, &cookie).await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["diagnostics"][1]["code"], "VECTOR_LOG");

    // The log stops reporting new failures: three clean check-ins resolve it.
    for _ in 0..3 {
        logged(&s, &peer, &id, "none", 40).await;
    }
    let (_, device) = shown(&s, &id).await;
    assert_eq!(device["data_plane"]["issues"], json!([]));
    let page = open_delivery(&s, &cookie).await;
    assert_eq!(page["items"][0]["resolved"], true);
    assert_eq!(page["items"][0]["resolved_reason"], "healthy");
}

#[tokio::test]
async fn a_device_with_metrics_is_never_judged_from_its_log() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let id = enroll(&s, &cookie, &csrf, "r16-full", json!({})).await;
    first_version(&s, &id, "r16-http-monitored").await;
    let peer = agent(&s, &id).await;
    // The exporter is known but this check-in carried no sample: nothing is
    // judged, from the log or otherwise.
    for count in [13, 40, 90] {
        logged(&s, &peer, &id, "discovered", count).await;
    }
    let (_, device) = shown(&s, &id).await;
    assert!(
        device["data_plane"]["issues"]
            .as_array()
            .is_none_or(Vec::is_empty),
        "{device}"
    );
    assert_eq!(open_delivery(&s, &cookie).await["total"], 0);
}

#[tokio::test]
async fn devices_report_the_running_agent_build_and_their_state_directory() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let id = enroll(&s, &cookie, &csrf, "edge-build", json!({})).await;
    let peer = agent(&s, &id).await;
    let sha = "97".repeat(32);
    let (status, envelope) = beat(
        &peer,
        heartbeat(
            0,
            "",
            "unmanaged",
            json!({"agent_sha256":sha,"state_dir":"/srv/vectory agent/state"}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let features = manifest(&envelope)["features"].clone();
    for feature in ["agent_sha256", "state_dir"] {
        assert!(
            features.as_array().unwrap().contains(&json!(feature)),
            "{features}"
        );
    }
    // List rows carry both: the deploy dialog writes host commands from them.
    let (row, full) = shown(&s, &id).await;
    assert_eq!(row["agent_sha256"], sha);
    assert_eq!(row["state_dir"], "/srv/vectory agent/state");
    assert_eq!(full["agent_sha256"], sha);
    // Windows drive paths are absolute too.
    let windows = json!({"state_dir":"C:\\ProgramData\\Vectory\\agent"});
    assert_eq!(
        beat(&peer, heartbeat(0, "", "unmanaged", windows)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        shown(&s, &id).await.0["state_dir"],
        "C:\\ProgramData\\Vectory\\agent"
    );
    // An older agent doesn't say: both are unknown, never stale.
    assert_eq!(
        beat(&peer, heartbeat(0, "", "unmanaged", json!({})))
            .await
            .0,
        StatusCode::OK
    );
    let (row, _) = shown(&s, &id).await;
    assert!(row.get("agent_sha256").is_none() && row.get("state_dir").is_none());
    for bad in [
        json!({"agent_sha256":"ABCD"}),
        json!({"agent_sha256":"G".repeat(64)}),
        json!({"state_dir":"relative/state"}),
        json!({"state_dir":"/tmp/line\nbreak"}),
        json!({"state_dir":format!("/{}", "a".repeat(4096))}),
        json!({"state_dir":7}),
    ] {
        let (status, _) = beat(&peer, heartbeat(0, "", "unmanaged", bad.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
}
