use axum::{
    Extension,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize, rollout};
const DEVICE: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const A: &str = "00000000-0000-4000-8000-00000000000a";
const B: &str = "00000000-0000-4000-8000-00000000000b";
fn artifact(version: &str) -> String {
    json!({"sources":{"in":{"type":"demo_logs","format":"json","interval":if version==A {1}else{2}}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}).to_string()
}
async fn fixture() -> (tempfile::TempDir, State, Value) {
    fixture_with_secrets(false).await
}
async fn fixture_with_secrets(secret: bool) -> (tempfile::TempDir, State, Value) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "synthetic-attempt-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Isolated configuration attempts".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    for (i, id) in [DEVICE, OTHER].iter().enumerate() {
        let data = json!({"id":id,"name":format!("Synthetic {i}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"created_at":db::now(),"apply_state":"unmanaged","reported_generation":0});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for (i, id) in [A, B].iter().enumerate() {
        let body = artifact(id);
        db::insert(&mut tx,"version",&json!({"id":id,"configuration_id":"00000000-0000-4000-8000-000000000100","number":i+1,"artifact":body,"sha256":db::hash(&body),"size":body.len(),"uses_local_secrets":secret && *id==B,"created_at":db::now()})).await.unwrap();
    }
    rollout::create(&mut tx, &request(A, false), "synthetic")
        .await
        .unwrap();
    for id in [DEVICE, OTHER] {
        sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','verified_applied','$.reported_generation',1,'$.actual_sha256',?) WHERE id=?").bind(db::hash(artifact(A))).bind(id).execute(&mut*tx).await.unwrap();
    }
    let candidate = rollout::create(&mut tx, &request(B, true), "synthetic")
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('attempt-test-peer',?,?)",
    )
    .bind(DEVICE)
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (temp, s, candidate)
}
fn request(version: &str, canary: bool) -> Value {
    json!({"version_id":version,"selector":{"device_ids":[DEVICE,OTHER],"group_ids":[],"exclude_ids":[]},"priority":if version==A {10}else{20},"target_mode":"snapshot","rollout":{"kind":if canary{"canary"}else{"all"},"canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}})
}
fn heartbeat(state: &str, attempt: Option<Value>) -> Value {
    let mut v = json!({"protocol_version":1,"request_id":"synthetic-heartbeat","boot_id":"synthetic-boot","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"test","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash(artifact(A)),"apply_state":state,"local_paused":false,"remote_pause_acknowledged":false});
    if let Some(a) = attempt {
        v["configuration_attempt"] = a;
    }
    v
}
fn attempt(generation: i64, state: &str) -> Value {
    json!({"generation":generation,"version_id":B,"sha256":db::hash(artifact(B)),"state":state,"error":{"code":"VALIDATION_FAILED","stage":"validation","message":"synthetic private diagnostic must not be persisted"}})
}
async fn beat(s: &State, body: Value) -> (StatusCode, Value) {
    let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        "attempt-test-peer".into(),
    ))));
    let r = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/v1/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&b).unwrap())
}
async fn target(s: &State, candidate: &Value) -> Value {
    let mut c = s.pool.acquire().await.unwrap();
    rollout::targets(&mut c, candidate["id"].as_str().unwrap())
        .await
        .unwrap()
        .into_iter()
        .find(|x| x["device_id"] == DEVICE)
        .unwrap()
}
#[tokio::test]
async fn failed_new_candidate_counts_without_replacing_last_verified_identity() {
    let (_temp, s, candidate) = fixture().await;
    let (status, result) = beat(&s, heartbeat("failed", Some(attempt(2, "failed")))).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        target(&s, &candidate).await["state"],
        "failed",
        "A failed candidate must update its exact current target despite an older verified generation"
    );
    assert_eq!(
        target(&s, &candidate).await["error"],
        "Vector rejected the configuration. Vector refused this version during validation on the device."
    );
    emit("failed_target", &target(&s, &candidate).await);
    rollout::tick(&s).await.unwrap();
    let mut c = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "failed"
    );
    let d = rollout::devices(&mut c)
        .await
        .unwrap()
        .into_iter()
        .find(|d| d["id"] == DEVICE)
        .unwrap();
    assert_eq!(d["reported_generation"], 1);
    assert_eq!(d["actual_sha256"], db::hash(artifact(A)));
    emit("current_failed_device", &d);
    emit("safe_attempt", &d["configuration_attempt"]);
    assert!(d.get("terminal_configuration_attempt").is_none());
    assert!(d.get("verified_configuration_attempt").is_none());
}
async fn shown(s: &State) -> Value {
    let mut c = s.pool.acquire().await.unwrap();
    rollout::devices(&mut c)
        .await
        .unwrap()
        .into_iter()
        .find(|d| d["id"] == DEVICE)
        .unwrap()
}
async fn snapshot(s: &State) -> Value {
    let d: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id,data,desired_generation FROM devices ORDER BY id")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    let records: Vec<(String, String, String)> =
        sqlx::query_as("SELECT kind,id,data FROM records ORDER BY kind,id")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    let targets:Vec<(String,String,String,i64,Option<String>,Option<String>)>=sqlx::query_as("SELECT deployment_id,device_id,state,generation,verified_at,error FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"devices":d,"records":records,"targets":targets})
}
fn verified(generation: i64, with_attempt: bool) -> Value {
    let mut v = heartbeat(
        "verified_applied",
        with_attempt.then(|| {
            let mut a = attempt(generation, "verified_applied");
            a.as_object_mut().unwrap().remove("error");
            a
        }),
    );
    v["reported_generation"] = json!(generation);
    v["actual_sha256"] = json!(db::hash(artifact(B)));
    v
}
fn emit(name: &str, value: &Value) {
    if std::env::var_os("VECTORY_ATTEMPT_FIXTURES").is_some() {
        println!(
            "VECTORY_ATTEMPT_FIXTURE {}",
            json!({"name":name,"response":value})
        );
    }
}
#[tokio::test]
async fn malformed_and_future_attempts_are_atomic_and_bounded() {
    let (_temp, s, _candidate) = fixture().await;
    let mut cases = vec![Value::Null, json!([])];
    for field in ["generation", "version_id", "sha256", "state"] {
        let mut a = attempt(2, "failed");
        a.as_object_mut().unwrap().remove(field);
        cases.push(a);
    }
    for (field, value) in [
        ("generation", json!(-1)),
        ("generation", json!(0)),
        ("generation", json!(9007199254740992u64)),
        ("generation", json!(2.5)),
        ("version_id", json!("bad")),
        ("sha256", json!("A".repeat(64))),
        ("state", json!("made_up")),
        ("secret_revision", json!(-1)),
        ("secret_revision", json!(null)),
        ("unknown", json!("private")),
        ("error", json!({"code":"x","stage":"y"})),
        (
            "error",
            json!({"code":"x","stage":"y","message":"x".repeat(1001)}),
        ),
        (
            "error",
            json!({"code":"x","stage":"y","message":"x","extra":true}),
        ),
    ] {
        let mut a = attempt(2, "failed");
        a[field] = value;
        cases.push(a);
    }
    for a in cases {
        let before = snapshot(&s).await;
        let (status, e) = beat(&s, heartbeat("failed", Some(a))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
        assert_eq!(snapshot(&s).await, before);
    }
    for field in [
        "secret_revision",
        "reported_generation",
        "policy_generation",
    ] {
        let mut v = heartbeat("failed", None);
        v[field] = json!(9007199254740992u64);
        let before = snapshot(&s).await;
        assert_eq!(beat(&s, v).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(snapshot(&s).await, before);
    }
    let before = snapshot(&s).await;
    assert_eq!(
        beat(&s, heartbeat("failed", Some(attempt(3, "failed"))))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn stale_wrong_and_legacy_failure_reports_do_not_attribute_current_candidate() {
    let (_temp, s, candidate) = fixture().await;
    let mut old = attempt(1, "failed");
    old["version_id"] = json!(A);
    old["sha256"] = json!(db::hash(artifact(A)));
    let mut wrong_version = attempt(2, "failed");
    wrong_version["version_id"] = json!(A);
    let mut wrong_digest = attempt(2, "failed");
    wrong_digest["sha256"] = json!(db::hash("wrong"));
    for a in [Some(old), Some(wrong_version), Some(wrong_digest), None] {
        let (status, envelope) = beat(&s, heartbeat("failed", a)).await;
        assert_eq!(status, StatusCode::OK, "{envelope}");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(envelope["payload"].as_str().unwrap())
            .unwrap();
        let m: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(m["generation"], 2);
        assert_eq!(m["desired"]["version_id"], B);
        let d = shown(&s).await;
        assert!(d.get("configuration_attempt").is_none());
        assert_eq!(d["apply_state"], "desired");
        assert_eq!(d["reported_apply_state"], "failed");
        assert_eq!(target(&s, &candidate).await["state"], "desired");
        assert!(target(&s, &candidate).await["error"].is_null());
        emit("unattributed_device", &d);
    }
    rollout::tick(&s).await.unwrap();
    let mut c = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "active"
    );
}
#[tokio::test]
async fn known_failure_survives_irrelevant_and_late_progress_then_exact_success() {
    let (_temp, s, candidate) = fixture().await;
    assert_eq!(
        beat(&s, heartbeat("failed", Some(attempt(2, "failed"))))
            .await
            .0,
        StatusCode::OK
    );
    for a in [
        None,
        Some(attempt(1, "failed")),
        Some(attempt(2, "downloaded")),
    ] {
        assert_eq!(beat(&s, heartbeat("downloaded", a)).await.0, StatusCode::OK);
        assert_eq!(target(&s, &candidate).await["state"], "failed");
        assert_eq!(
            target(&s, &candidate).await["error"],
            "Vector rejected the configuration. Vector refused this version during validation on the device."
        );
        assert_eq!(shown(&s).await["apply_state"], "failed");
    }
    let data: String = sqlx::query_scalar("SELECT data FROM devices WHERE id=?")
        .bind(DEVICE)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!data.contains("synthetic private diagnostic"));
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert!(!records.join("").contains("synthetic private diagnostic"));
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    assert_eq!(target(&s, &candidate).await["state"], "verified_applied");
    assert!(target(&s, &candidate).await["error"].is_null());
    assert_eq!(shown(&s).await["reported_generation"], 2);
    assert_eq!(
        shown(&s).await["configuration_attempt"]["state"],
        "verified_applied"
    );
}
#[tokio::test]
async fn verified_candidate_never_regresses_to_counted_failure_and_workload_loss_halts_gate() {
    let (_temp, s, candidate) = fixture().await;
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    for state in ["failed", "verification_unknown", "paused"] {
        let mut v = verified(2, true);
        v["apply_state"] = json!(state);
        v["configuration_attempt"] = attempt(2, "failed");
        assert_eq!(beat(&s, v).await.0, StatusCode::OK);
        assert_eq!(
            target(&s, &candidate).await["state"],
            "verification_unknown"
        );
        assert_eq!(
            target(&s, &candidate).await["error"],
            "Current application could not be verified."
        );
        assert_eq!(
            shown(&s).await["configuration_attempt"]["state"],
            "verification_unknown"
        );
        rollout::tick(&s).await.unwrap();
        let mut c = s.pool.acquire().await.unwrap();
        let d = db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(d["status"], "active");
        assert!(d["observation_started_at"].is_null());
        drop(c);
        assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
        assert!(target(&s, &candidate).await["error"].is_null());
    }
    let mut legacy = verified(2, false);
    legacy["apply_state"] = json!("failed");
    legacy["error"] =
        json!({"code":"PROCESS_STOPPED","stage":"startup","message":"private startup path"});
    assert_eq!(beat(&s, legacy).await.0, StatusCode::OK);
    assert_eq!(
        target(&s, &candidate).await["state"],
        "verification_unknown"
    );
}
#[tokio::test]
async fn attempt_cannot_verify_without_generation_digest_and_workload_proof() {
    let (_temp, s, candidate) = fixture().await;
    for mut v in [
        heartbeat("failed", Some(attempt(2, "verified_applied"))),
        heartbeat("verified_applied", Some(attempt(2, "verified_applied"))),
        verified(2, true),
    ] {
        v["actual_sha256"] = json!(db::hash(artifact(A)));
        assert_eq!(beat(&s, v).await.0, StatusCode::OK);
        assert_eq!(
            target(&s, &candidate).await["state"],
            "verification_unknown"
        );
        assert_ne!(shown(&s).await["status"], "verified");
    }
    assert_eq!(beat(&s, verified(2, false)).await.0, StatusCode::OK);
    assert_eq!(
        target(&s, &candidate).await["state"],
        "verified_applied",
        "Legacy verified proof remains supported"
    );
}
#[tokio::test]
async fn secret_attempts_require_revision_and_new_rotation_can_fail_after_verified() {
    let (_temp, s, candidate) = fixture_with_secrets(true).await;
    let mut verified_secret = verified(2, true);
    verified_secret["actual_sha256"] = json!(db::hash("effective-one"));
    verified_secret["applied_template_sha256"] = json!(db::hash(artifact(B)));
    verified_secret["secret_revision"] = json!(1);
    verified_secret["configuration_attempt"]["secret_revision"] = json!(1);
    assert_eq!(beat(&s, verified_secret.clone()).await.0, StatusCode::OK);
    assert_eq!(target(&s, &candidate).await["state"], "verified_applied");
    let mut failed = verified_secret.clone();
    failed["apply_state"] = json!("failed");
    failed["secret_revision"] = json!(2);
    failed["configuration_attempt"] = attempt(2, "failed");
    failed["configuration_attempt"]["secret_revision"] = json!(2);
    assert_eq!(beat(&s, failed.clone()).await.0, StatusCode::OK);
    assert_eq!(target(&s, &candidate).await["state"], "failed");
    assert_eq!(shown(&s).await["verified_secret_revision"], 1);
    verified_secret["actual_sha256"] = json!(db::hash("effective-three"));
    verified_secret["secret_revision"] = json!(3);
    verified_secret["configuration_attempt"]["secret_revision"] = json!(3);
    assert_eq!(beat(&s, verified_secret.clone()).await.0, StatusCode::OK);
    failed["secret_revision"] = json!(3);
    failed["actual_sha256"] = verified_secret["actual_sha256"].clone();
    assert_eq!(beat(&s, failed.clone()).await.0, StatusCode::OK);
    assert_ne!(
        target(&s, &candidate).await["state"],
        "failed",
        "An older rotation failure is not attributed to verified revision3"
    );
    assert_eq!(shown(&s).await["verified_secret_revision"], 3);
    failed["configuration_attempt"]
        .as_object_mut()
        .unwrap()
        .remove("secret_revision");
    assert_eq!(beat(&s, failed).await.0, StatusCode::OK);
    assert_ne!(target(&s, &candidate).await["state"], "failed");
}
async fn dashboard(
    s: &State,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    let r = api::router(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = r.status();
    let cookie = r
        .headers()
        .get("set-cookie")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let b = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&b).unwrap(), cookie)
}
#[tokio::test]
async fn reviewed_retry_supersedes_failure_without_resuming_failed_canary() {
    let (_temp, s, candidate) = fixture().await;
    beat(&s, heartbeat("failed", Some(attempt(2, "failed")))).await;
    rollout::tick(&s).await.unwrap();
    let(status,session,cookie)=dashboard(&s,"POST","/api/v1/bootstrap",json!({"bootstrap_secret":"synthetic-attempt-bootstrap","email":"operator@example.test","name":"Synthetic","password":"synthetic-long-password"}),"","").await;
    assert_eq!(status, StatusCode::OK);
    let csrf = session["csrf_token"].as_str().unwrap();
    let (status, retried, _) = dashboard(
        &s,
        "POST",
        &format!("/api/v1/devices/{DEVICE}/retry"),
        json!({"expected_version_id":B,"expected_generation":2}),
        &cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["apply_state"], "desired");
    assert!(retried.get("configuration_attempt").is_none());
    assert!(target(&s, &candidate).await["error"].is_null());
    beat(&s, heartbeat("failed", Some(attempt(2, "failed")))).await;
    assert_eq!(target(&s, &candidate).await["state"], "desired");
    assert!(target(&s, &candidate).await["error"].is_null());
    assert_eq!(shown(&s).await["apply_state"], "desired");
    assert_eq!(beat(&s, verified(3, true)).await.0, StatusCode::OK);
    assert_eq!(target(&s, &candidate).await["state"], "verified_applied");
    rollout::tick(&s).await.unwrap();
    let mut c = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "failed"
    );
    assert_eq!(
        rollout::targets(&mut c, candidate["id"].as_str().unwrap())
            .await
            .unwrap()
            .into_iter()
            .find(|t| t["device_id"] == OTHER)
            .unwrap()["generation"],
        0
    );
}
#[tokio::test]
async fn attempt_update_and_error_are_atomic_on_audit_failure() {
    let (_temp, s, _) = fixture().await;
    sqlx::query("CREATE TRIGGER fail_attempt BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.apply_state' BEGIN SELECT RAISE(ABORT,'injected'); END").execute(&s.pool).await.unwrap();
    let before = snapshot(&s).await;
    assert_eq!(
        beat(&s, heartbeat("failed", Some(attempt(2, "failed"))))
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn legacy_success_marker_is_not_required_to_halt_unverified_workload() {
    let (_temp, s, candidate) = fixture().await;
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND device_id=?").bind(db::now()).bind(candidate["id"].as_str().unwrap()).bind(DEVICE).execute(&s.pool).await.unwrap();
    let mut v = verified(2, false);
    v["apply_state"] = json!("failed");
    assert_eq!(beat(&s, v).await.0, StatusCode::OK);
    assert_eq!(
        target(&s, &candidate).await["state"],
        "verification_unknown"
    );
    assert_eq!(
        target(&s, &candidate).await["error"],
        "Current application could not be verified."
    );
}
#[tokio::test]
async fn stale_attempt_error_never_binds_issue_to_current_desired_version() {
    let (_temp, s, _) = fixture().await;
    let mut v = verified(2, true);
    let mut old = attempt(1, "failed");
    old["version_id"] = json!(A);
    old["sha256"] = json!(db::hash(artifact(A)));
    v["configuration_attempt"] = old;
    v["apply_state"] = json!("failed");
    v["error"] =
        json!({"code":"VALIDATION_FAILED","stage":"validation","message":"private old attempt"});
    assert_eq!(beat(&s, v).await.0, StatusCode::OK);
    let issues: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue'")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert_eq!(issues.len(), 1);
    let issue: Value = serde_json::from_str(&issues[0]).unwrap();
    assert!(issue["desired_version_id"].is_null());
    assert!(!issues[0].contains("private old attempt"));
}
#[tokio::test]
async fn durable_failure_latch_survives_restart_and_pause_preserves_own_outcome() {
    let (_temp, s, candidate) = fixture().await;
    assert_eq!(
        beat(&s, heartbeat("paused", Some(attempt(2, "rolled_back"))))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(target(&s, &candidate).await["state"], "rolled_back");
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    for a in [
        None,
        Some(attempt(1, "failed")),
        Some(attempt(2, "downloaded")),
    ] {
        assert_eq!(beat(&s, heartbeat("paused", a)).await.0, StatusCode::OK);
        assert_eq!(target(&s, &candidate).await["state"], "rolled_back");
        assert_eq!(
            target(&s, &candidate).await["error"],
            "Vector rejected the configuration. Vector refused this version during validation on the device."
        );
    }
    rollout::tick(&s).await.unwrap();
    let mut c = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "failed"
    );
}
#[tokio::test]
async fn tolerated_failure_or_unknown_never_opens_next_canary_wave() {
    for outcome in ["failed", "verification_unknown"] {
        let (_temp, s, candidate) = fixture().await;
        sqlx::query("UPDATE records SET data=json_set(data,'$.rollout.failure_threshold',1) WHERE kind='deployment' AND id=?").bind(candidate["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
        assert_eq!(
            beat(&s, heartbeat("failed", Some(attempt(2, outcome))))
                .await
                .0,
            StatusCode::OK
        );
        rollout::tick(&s).await.unwrap();
        let mut c = s.pool.acquire().await.unwrap();
        let d = db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(d["status"], "active");
        assert!(d["observation_started_at"].is_null());
        let targets = rollout::targets(&mut c, candidate["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            targets.iter().find(|t| t["device_id"] == OTHER).unwrap()["generation"],
            0
        );
    }
}
#[tokio::test]
async fn early_secret_failure_with_omitted_zero_revision_is_exact_and_useful() {
    let (_temp, s, candidate) = fixture_with_secrets(true).await;
    let mut a = attempt(2, "failed");
    a["error"] = json!({"code":"SECRET_RESOLUTION_FAILED","stage":"materialization","message":"private secret path must never persist"});
    let v = heartbeat("failed", Some(a));
    assert!(v.get("secret_revision").is_none());
    assert_eq!(beat(&s, v).await.0, StatusCode::OK);
    assert_eq!(target(&s, &candidate).await["state"], "failed");
    assert_eq!(
        target(&s, &candidate).await["error"],
        "A local secret couldn't be read. A vectory-secret reference has no readable local file on the device."
    );
    let d = shown(&s).await;
    assert_eq!(d["secret_revision"], 0);
    assert!(d["configuration_attempt"].get("secret_revision").is_none());
    assert_eq!(
        d["configuration_attempt"]["error"]["code"],
        "SECRET_RESOLUTION_FAILED"
    );
    assert_eq!(
        d["configuration_attempt"]["error"]["stage"],
        "materialization"
    );
    assert!(!d.to_string().contains("private secret path"));
    emit("zero_revision_secret_failure", &d);
}

#[tokio::test]
async fn target_errors_are_allowlisted_and_progress_clears_obsolete_messages() {
    let (_temp, s, candidate) = fixture().await;
    sqlx::query("UPDATE deployment_targets SET error='private legacy diagnostic' WHERE deployment_id=? AND device_id=?")
        .bind(candidate["id"].as_str().unwrap()).bind(DEVICE).execute(&s.pool).await.unwrap();
    assert_eq!(
        beat(&s, heartbeat("downloaded", Some(attempt(2, "downloaded"))))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(target(&s, &candidate).await["state"], "downloaded");
    assert!(target(&s, &candidate).await["error"].is_null());
    for error in [
        Some(
            json!({"code":"private code", "stage":"private stage", "message":"private diagnostic"}),
        ),
        None,
    ] {
        let mut a = attempt(2, "failed");
        if let Some(error) = error {
            a["error"] = error;
        } else {
            a.as_object_mut().unwrap().remove("error");
        }
        assert_eq!(
            beat(&s, heartbeat("failed", Some(a))).await.0,
            StatusCode::OK
        );
        assert_eq!(
            target(&s, &candidate).await["error"],
            "The device couldn't apply the configuration. The device reported a failure while applying this version."
        );
        assert!(!target(&s, &candidate).await.to_string().contains("private"));
    }
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    assert!(target(&s, &candidate).await["error"].is_null());
}

fn manifest(envelope: &Value) -> Value {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
async fn deployment(s: &State, candidate: &Value) -> Value {
    let mut c = s.pool.acquire().await.unwrap();
    db::record(&mut c, "deployment", candidate["id"].as_str().unwrap())
        .await
        .unwrap()
}
async fn verified_at(s: &State, candidate: &Value) -> Option<String> {
    sqlx::query_scalar(
        "SELECT verified_at FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(candidate["id"].as_str().unwrap())
    .bind(DEVICE)
    .fetch_one(&s.pool)
    .await
    .unwrap()
}
async fn session(s: &State) -> (String, String) {
    let (status, session, cookie) = dashboard(
        s,
        "POST",
        "/api/v1/bootstrap",
        json!({"bootstrap_secret":"synthetic-attempt-bootstrap","email":"operator@example.test","name":"Synthetic","password":"synthetic-long-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    (cookie, session["csrf_token"].as_str().unwrap().to_owned())
}
async fn read_api(s: &State, path: &str, session: &(String, String)) -> (StatusCode, Value) {
    let (status, body, _) = dashboard(s, "GET", path, Value::Null, &session.0, &session.1).await;
    (status, body)
}
fn data_dir_diagnostic() -> Value {
    json!({"severity":"error","code":"DATA_DIR_MISSING","field":"data_dir","message":"The data directory \"/srv/missing\" does not exist on this device.","hint":"Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device."})
}

#[tokio::test]
async fn local_and_remote_pause_keep_the_verified_generation_and_target() {
    let (_temp, s, candidate) = fixture().await;
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    let at = verified_at(&s, &candidate).await;
    assert!(at.is_some());
    rollout::tick(&s).await.unwrap();
    assert!(deployment(&s, &candidate).await["observation_started_at"].is_string());

    // The agent reports "paused" while its verified workload keeps running.
    let mut paused = verified(2, true);
    paused["apply_state"] = json!("paused");
    paused["local_paused"] = json!(true);
    assert_eq!(beat(&s, paused).await.0, StatusCode::OK);
    let d = shown(&s).await;
    assert_eq!(d["apply_state"], "verified_applied");
    assert_eq!(d["reported_apply_state"], "paused");
    assert_eq!(d["configuration_attempt"]["state"], "verified_applied");
    assert_eq!(d["status"], "paused");
    let t = target(&s, &candidate).await;
    assert_eq!(t["state"], "verified_applied");
    assert!(t["error"].is_null());
    assert_eq!(verified_at(&s, &candidate).await, at);
    // The canary holds (reason "paused") without failing or releasing a wave.
    assert!(deployment(&s, &candidate).await["observation_started_at"].is_null());
    rollout::tick(&s).await.unwrap();
    let d = deployment(&s, &candidate).await;
    assert_eq!(d["status"], "active");
    assert!(d["observation_started_at"].is_null());
    let mut c = s.pool.acquire().await.unwrap();
    let other = rollout::targets(&mut c, candidate["id"].as_str().unwrap())
        .await
        .unwrap()
        .into_iter()
        .find(|t| t["device_id"] == OTHER)
        .unwrap();
    assert_eq!(other["generation"], 0);
    drop(c);

    // Resuming needs no re-apply: the same verified generation is proof again.
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    rollout::tick(&s).await.unwrap();
    assert!(deployment(&s, &candidate).await["observation_started_at"].is_string());
    assert_eq!(verified_at(&s, &candidate).await, at);

    // An acknowledged remote pause behaves the same.
    sqlx::query("UPDATE devices SET policy=json_set(policy,'$.sync_paused',json('true')),policy_generation=policy_generation+1 WHERE id=?")
        .bind(DEVICE)
        .execute(&s.pool)
        .await
        .unwrap();
    let policy_generation: i64 =
        sqlx::query_scalar("SELECT policy_generation FROM devices WHERE id=?")
            .bind(DEVICE)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    let mut remote = verified(2, true);
    remote["apply_state"] = json!("paused");
    remote["remote_pause_acknowledged"] = json!(true);
    remote["policy_generation"] = json!(policy_generation);
    assert_eq!(beat(&s, remote.clone()).await.0, StatusCode::OK);
    let d = shown(&s).await;
    assert_eq!(d["apply_state"], "verified_applied");
    assert_eq!(d["pause_acknowledged"], true);
    assert_eq!(d["configuration_attempt"]["state"], "verified_applied");
    let t = target(&s, &candidate).await;
    assert_eq!(t["state"], "verified_applied");
    assert_eq!(verified_at(&s, &candidate).await, at);

    // Only a changed digest degrades a paused device.
    remote["actual_sha256"] = json!(db::hash("changed on the host"));
    assert_eq!(beat(&s, remote).await.0, StatusCode::OK);
    assert_eq!(
        target(&s, &candidate).await["state"],
        "verification_unknown"
    );
    assert_ne!(shown(&s).await["apply_state"], "verified_applied");
}

#[tokio::test]
async fn diagnostics_explain_the_failure_on_device_issue_and_target() {
    let (_temp, s, candidate) = fixture().await;
    let mut a = attempt(2, "failed");
    a["error"]["diagnostics"] = json!([
        data_dir_diagnostic(),
        {"severity":"warning","code":"OUTPUT_UNUSED","component_id":"in","component_kind":"source","message":"Nothing reads the output of in."}
    ]);
    let (status, envelope) = beat(&s, heartbeat("failed", Some(a.clone()))).await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let features = manifest(&envelope)["features"].clone();
    for feature in [
        "diagnostics",
        "host_runtime",
        "vector_log_summary",
        "telemetry_v2",
    ] {
        assert!(
            features.as_array().unwrap().contains(&json!(feature)),
            "{features}"
        );
    }
    let reason = "The data directory \"/srv/missing\" does not exist on this device.";
    let fix = "Remove data_dir from the pipeline to use the device's own data directory, or create this directory on the device.";
    assert_eq!(
        target(&s, &candidate).await["error"],
        format!("Vector rejected the configuration. {reason} {fix}")
    );
    let d = shown(&s).await;
    let error = &d["configuration_attempt"]["error"];
    assert_eq!(error["code"], "VALIDATION_FAILED");
    assert_eq!(error["message"], reason);
    assert_eq!(error["diagnostics"][0], data_dir_diagnostic());
    assert_eq!(error["diagnostics"][1]["severity"], "warning");
    assert!(!d.to_string().contains("synthetic private diagnostic"));
    emit("diagnosed_failure", &d);

    // A repeated report of the same attempt is a report, not an occurrence.
    assert_eq!(
        beat(&s, heartbeat("failed", Some(a))).await.0,
        StatusCode::OK
    );
    let api = session(&s).await;
    let (status, page) = read_api(&s, "/api/v1/issues/history", &api).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1);
    let issue = &page["items"][0];
    assert_eq!(issue["title"], "Vector rejected the configuration");
    assert_eq!(issue["message"], reason);
    assert_eq!(issue["diagnostics"][0]["hint"], fix);
    assert_eq!(issue["desired_version_id"], B);
    assert_eq!(issue["version_number"], 2);
    assert_eq!(
        issue["configuration_id"],
        "00000000-0000-4000-8000-000000000100"
    );
    assert_eq!(issue["deployment_id"], candidate["id"]);
    assert_eq!(issue["count"], 1);
    assert_eq!(issue["reports"], 2);
    // Titles are searchable; stored free text is not.
    for (query, total) in [("rejected", 1), ("synthetic%20private", 0)] {
        let (_, page) = read_api(&s, &format!("/api/v1/issues/history?search={query}"), &api).await;
        assert_eq!(page["total"], total, "{query}");
    }
    let (status, groups) = read_api(&s, "/api/v1/issues/groups", &api).await;
    assert_eq!(status, StatusCode::OK, "{groups}");
    assert_eq!(groups["total"], 1);
    let group = &groups["items"][0];
    assert_eq!(group["code"], "VALIDATION_FAILED");
    assert_eq!(group["title"], "Vector rejected the configuration");
    assert_eq!(group["message"], reason);
    assert_eq!(group["version_id"], B);
    assert_eq!(group["version_number"], 2);
    assert_eq!(group["device_count"], 1);
    assert_eq!(group["attempts"], 1);
    assert_eq!(group["reports"], 2);
    assert_eq!(group["deployment_ids"], json!([candidate["id"]]));
    assert_eq!(group["devices"][0]["device_id"], DEVICE);
    emit("issue_group", &groups);
    for query in ["state=hidden", "unknown=1", "page=0", "page_size=51"] {
        let (status, _) = read_api(&s, &format!("/api/v1/issues/groups?{query}"), &api).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
    }
}

#[tokio::test]
async fn diagnostics_host_runtime_and_log_summaries_are_bounded_and_atomic() {
    let (_temp, s, _candidate) = fixture().await;
    let failed = |diagnostics: Value| {
        let mut a = attempt(2, "failed");
        a["error"]["diagnostics"] = diagnostics;
        heartbeat("failed", Some(a))
    };
    let with = |key: &str, value: Value| {
        let mut d = data_dir_diagnostic();
        if value.is_null() {
            d.as_object_mut().unwrap().remove(key);
        } else {
            d[key] = value;
        }
        failed(json!([d]))
    };
    let summary = json!({"fingerprint":"0123456789abcdef","level":"error","component_id":"out","component_kind":"sink","component_type":"http","message":"Request failed: the destination refused the connection.","count":3,"first_seen":"2026-09-29T00:00:00Z","last_seen":"2026-09-29T00:01:00Z"});
    let logs = |item: Value| {
        let mut v = verified(2, true);
        v["vector_log_summary"] = item;
        v
    };
    let runtime = |value: Value| {
        let mut v = verified(2, true);
        v["host_runtime"] = value;
        v
    };
    let mut top_level = heartbeat("failed", None);
    top_level["error"] = json!({"code":"PROCESS_EXITED","stage":"startup","message":"x","diagnostics":[{"severity":"error","code":"X","message":"x","raw":"private"}]});
    let mut upper = summary.clone();
    upper["fingerprint"] = json!("0123456789ABCDEF");
    let mut missing_count = summary.clone();
    missing_count.as_object_mut().unwrap().remove("count");
    let mut info = summary.clone();
    info["level"] = json!("info");
    let mut extra = summary.clone();
    extra["raw"] = json!("private");
    for body in [
        failed(json!(vec![data_dir_diagnostic(); 11])),
        failed(json!({"severity":"error"})),
        with("message", json!("é".repeat(300))),
        with("hint", json!("é".repeat(200))),
        with("raw", json!("private")),
        with("message", Value::Null),
        with("code", json!("data_dir_missing")),
        with("severity", json!("fatal")),
        with("message", json!("line\nbreak")),
        with("line", json!(0)),
        with("component_id", json!("has space")),
        top_level,
        runtime(json!({"data_dir":"/var/lib/vector","unknown":true})),
        runtime(json!({"data_dir_source":"somewhere"})),
        runtime(json!({"graceful_shutdown_seconds":0})),
        runtime(json!({"metrics_address":"http://127.0.0.1:9598/metrics"})),
        runtime(json!("host")),
        logs(json!(vec![summary.clone(); 21])),
        logs(json!([upper])),
        logs(json!([missing_count])),
        logs(json!([info])),
        logs(json!([extra])),
        logs(json!({"items":[]})),
    ] {
        let before = snapshot(&s).await;
        let (status, error) = beat(&s, body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {error}");
        assert!(!error.to_string().contains("private"));
        assert_eq!(snapshot(&s).await, before);
    }

    let host = json!({"data_dir":"/var/lib/vectory/vector-data","data_dir_source":"agent_default","graceful_shutdown_seconds":60,"metrics_source":"discovered","metrics_address":"127.0.0.1:9598","activation":"reload"});
    let mut v = verified(2, true);
    v["host_runtime"] = host.clone();
    v["vector_log_summary"] = json!([summary]);
    assert_eq!(beat(&s, v).await.0, StatusCode::OK);
    let d = shown(&s).await;
    assert_eq!(d["host_runtime"], host);
    assert_eq!(d["vector_log_summary"]["items"], json!([summary]));
    assert!(d["vector_log_summary"]["reported_at"].is_string());
    emit("host_runtime_device", &d);
    // An agent with nothing to report sends an empty list; an older agent
    // sends neither field, which clears what it no longer reports.
    let mut v = verified(2, true);
    v["vector_log_summary"] = json!([]);
    assert_eq!(beat(&s, v).await.0, StatusCode::OK);
    assert_eq!(shown(&s).await["vector_log_summary"]["items"], json!([]));
    assert_eq!(beat(&s, verified(2, true)).await.0, StatusCode::OK);
    let d = shown(&s).await;
    assert!(d.get("host_runtime").is_none());
    assert!(d.get("vector_log_summary").is_none());
}

async fn issue_records(s: &State) -> Vec<Value> {
    sqlx::query_scalar::<_, String>("SELECT data FROM records WHERE kind='issue'")
        .fetch_all(&s.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| serde_json::from_str::<Value>(&row).unwrap())
        .collect()
}

#[tokio::test]
async fn unassignment_resolves_issues_without_inventing_failures() {
    let (_temp, s, _candidate) = fixture().await;
    assert_eq!(
        beat(&s, heartbeat("failed", Some(attempt(2, "failed"))))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(issue_records(&s).await.len(), 1);
    // Remove the assignment exactly as rollout resolution does.
    sqlx::query("UPDATE devices SET desired_version_id=NULL,desired_generation=desired_generation+1,assignment_id=NULL,data=json_remove(data,'$.desired_artifact_sha256') WHERE id=?")
        .bind(DEVICE)
        .execute(&s.pool)
        .await
        .unwrap();
    // Reports still in flight describe the old workload and candidate.
    for body in [
        heartbeat("verified_applied", None),
        heartbeat("failed", Some(attempt(2, "failed"))),
        heartbeat("unmanaged", None),
    ] {
        assert_eq!(beat(&s, body).await.0, StatusCode::OK);
        let issues = issue_records(&s).await;
        assert_eq!(issues.len(), 1, "no new issue for an unassigned device");
        assert_eq!(issues[0]["resolved"], true);
        assert_eq!(issues[0]["resolved_reason"], "unassigned");
        assert_eq!(shown(&s).await["apply_state"], "unmanaged");
    }
}

#[tokio::test]
async fn issues_are_keyed_by_version_and_grouped_newest_first() {
    let (_temp, s, _candidate) = fixture().await;
    assert_eq!(
        beat(&s, heartbeat("failed", Some(attempt(2, "failed"))))
            .await
            .0,
        StatusCode::OK
    );
    // The device is later asked to run version A, which fails the same way.
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=3,data=json_remove(data,'$.desired_artifact_sha256') WHERE id=?")
        .bind(A)
        .bind(DEVICE)
        .execute(&s.pool)
        .await
        .unwrap();
    let mut a = attempt(3, "failed");
    a["version_id"] = json!(A);
    a["sha256"] = json!(db::hash(artifact(A)));
    assert_eq!(
        beat(&s, heartbeat("failed", Some(a))).await.0,
        StatusCode::OK
    );
    let issues = issue_records(&s).await;
    assert_eq!(issues.len(), 2);
    let api = session(&s).await;
    let (_, groups) = read_api(&s, "/api/v1/issues/groups", &api).await;
    assert_eq!(groups["total"], 2);
    assert_eq!(groups["items"][0]["version_id"], A);
    assert_eq!(groups["items"][0]["version_number"], 1);
    assert_eq!(groups["items"][1]["version_id"], B);
}
