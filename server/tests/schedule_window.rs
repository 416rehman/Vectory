//! Scheduled activation: the configurable late-start window, and what happens
//! when a cancellation races an activation of the same schedule.
//!
//! Cancellation and the scheduler tick are both serialized writer
//! transactions, so a race resolves into one of two commit orders. Each test
//! forces one order deterministically with the writer lock (tokio's mutex is
//! first-in, first-out) while the other operation is already waiting for it.
use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize, rollout};

async fn state(window: Option<u64>) -> (tempfile::TempDir, State) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Test".into(),
        schedule_late_start_seconds: window,
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
) -> (StatusCode, Value, String) {
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
    let out = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, out, cookie)
}
async fn admin(s: &State) -> (String, String) {
    let (status, v, cookie) = call(api::router(s.clone()), "POST", "/api/v1/bootstrap", json!({"bootstrap_secret":"isolated-test-bootstrap-secret-123456789","email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}), "", "").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    (cookie, v["csrf_token"].as_str().unwrap().into())
}
/// Devices that can check in, each with a registered credential fingerprint
/// `credential-<name>`, and one published version.
async fn seed(s: &State, names: &[&str]) -> Vec<String> {
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        let d = json!({"id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"labels":{},"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(name)
            .bind(d.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)")
            .bind(format!("credential-{name}"))
            .bind(&id)
            .bind((chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339())
            .bind(s.keys.active_signing_id())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    let artifact = "{}\n";
    db::insert(&mut tx,"version",&json!({"id":"version-a","configuration_id":"config","number":1,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    tx.commit().await.unwrap();
    ids
}
/// A schedule created for the future, then made due `late` seconds ago, as a
/// server that was down at its time would find it.
async fn due_schedule(s: &State, ids: &[String], canary: bool, late: i64) -> String {
    let mut tx = s.pool.begin().await.unwrap();
    let request = json!({"version_id":"version-a","selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":10,"target_mode":"snapshot","rollout":{"kind":if canary {"canary"} else {"all"},"canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0},"scheduled_at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()});
    let created = rollout::create(&mut tx, &request, "operator")
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    let mut stored = db::record(&mut tx, "deployment", &id).await.unwrap();
    stored["scheduled_at"] =
        json!((chrono::Utc::now() - chrono::Duration::seconds(late)).to_rfc3339());
    db::update(&mut tx, "deployment", &stored).await.unwrap();
    tx.commit().await.unwrap();
    id
}
async fn deployment(s: &State, id: &str) -> Value {
    let mut conn = s.pool.acquire().await.unwrap();
    rollout::deployment(&mut conn, id).await.unwrap()
}
fn released(d: &Value) -> Vec<String> {
    d["targets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|t| t["generation"].as_i64().unwrap() > 0)
        .map(|t| t["device_id"].as_str().unwrap().to_owned())
        .collect()
}
async fn desired(s: &State, id: &str) -> (Option<String>, i64) {
    sqlx::query_as("SELECT desired_version_id,desired_generation FROM devices WHERE id=?")
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .unwrap()
}
/// (action, outcome) of the audit events about one deployment, oldest first.
async fn history(s: &State, id: &str) -> Vec<(String, String)> {
    sqlx::query_as("SELECT json_extract(data,'$.action'),json_extract(data,'$.outcome') FROM records WHERE kind='audit' AND (json_extract(data,'$.target')=?1 OR json_extract(data,'$.target') LIKE ?1||':%') ORDER BY rowid")
        .bind(id)
        .fetch_all(&s.pool)
        .await
        .unwrap()
}
/// The manifest a device receives at its next check-in.
async fn manifest(s: &State, name: &str) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(format!(
        "credential-{name}"
    )))));
    let heartbeat = json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":STANDARD.encode([42;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false});
    let (status, envelope, _) = call(app, "POST", "/agent/v1/heartbeat", heartbeat, "", "").await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    serde_json::from_slice(
        &STANDARD
            .decode(envelope["payload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}
/// Let spawned tasks run until each waits on something.
async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn the_late_start_window_is_configured_and_shown() {
    // A two-minute window: one minute late still starts, ten minutes late is missed.
    let (_temp, s) = state(Some(120)).await;
    let ids = seed(&s, &["within-window", "past-window"]).await;
    let within = due_schedule(&s, &ids[..1], false, 60).await;
    let past = due_schedule(&s, &ids[1..], false, 600).await;
    rollout::tick(&s).await.unwrap();
    assert_eq!(deployment(&s, &within).await["status"], "active");
    assert_eq!(released(&deployment(&s, &within).await), ids[..1]);
    let missed = deployment(&s, &past).await;
    assert_eq!(missed["status"], "missed");
    assert!(released(&missed).is_empty());
    assert_eq!(desired(&s, &ids[1]).await, (None, 0));
    assert_eq!(
        history(&s, &past).await.last().unwrap(),
        &("deployment.missed".to_owned(), "missed".to_owned())
    );
    // A missed schedule never starts later, whatever the window.
    rollout::tick(&s).await.unwrap();
    assert_eq!(deployment(&s, &past).await["status"], "missed");
    let (cookie, csrf) = admin(&s).await;
    let (status, settings, _) = call(
        api::router(s.clone()),
        "GET",
        "/api/v1/settings",
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["schedule_late_start_seconds"], 120);

    // Without the setting the window is one hour: ten minutes late starts.
    let (_temp, s) = state(None).await;
    let ids = seed(&s, &["default-window"]).await;
    let late = due_schedule(&s, &ids, false, 600).await;
    rollout::tick(&s).await.unwrap();
    assert_eq!(deployment(&s, &late).await["status"], "active");
    let (cookie, csrf) = admin(&s).await;
    let (_, settings, _) = call(
        api::router(s.clone()),
        "GET",
        "/api/v1/settings",
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(settings["schedule_late_start_seconds"], 3600);
}

#[tokio::test]
async fn a_cancellation_that_commits_first_means_the_schedule_never_activates() {
    let (_temp, s) = state(None).await;
    let ids = seed(&s, &["edge-01", "edge-02"]).await;
    let schedule = due_schedule(&s, &ids, true, 5).await;
    let before: Vec<_> = desired_all(&s, &ids).await;

    // The cancel holds the writer transaction while the due tick waits for it.
    let (guard, mut tx) = db::write_tx(&s).await.unwrap();
    let cancelled = rollout::action(&mut tx, &schedule, "cancel", "operator")
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    let scheduler = {
        let s = s.clone();
        tokio::spawn(async move { rollout::tick(&s).await })
    };
    settle().await;
    assert!(
        !scheduler.is_finished(),
        "the scheduler tick waits for the cancel to commit"
    );
    tx.commit().await.unwrap();
    drop(guard);
    scheduler.await.unwrap().unwrap();

    let d = deployment(&s, &schedule).await;
    assert_eq!(d["status"], "cancelled");
    assert!(released(&d).is_empty(), "no target was released: {d}");
    assert!(
        d["targets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["released_at"].is_null())
    );
    assert_eq!(
        desired_all(&s, &ids).await,
        before,
        "no device received a generation"
    );
    let actions: Vec<_> = history(&s, &schedule)
        .await
        .into_iter()
        .map(|(action, _)| action)
        .collect();
    assert_eq!(actions, ["deployment.schedule", "deployment.cancel"]);
    for name in ["edge-01", "edge-02"] {
        assert!(manifest(&s, name).await["desired"].is_null());
    }
    // It stays cancelled: neither a later tick nor the passing of the late-start
    // window activates it or turns it into a missed schedule.
    let mut stored = db::record(
        &mut s.pool.acquire().await.unwrap(),
        "deployment",
        &schedule,
    )
    .await
    .unwrap();
    stored["scheduled_at"] = json!((chrono::Utc::now() - chrono::Duration::hours(3)).to_rfc3339());
    db::update(&mut s.pool.acquire().await.unwrap(), "deployment", &stored)
        .await
        .unwrap();
    rollout::tick(&s).await.unwrap();
    assert_eq!(deployment(&s, &schedule).await["status"], "cancelled");

    // The same through the API: a due schedule cancelled before the tick.
    let ids = seed_more(&s, &["edge-03"]).await;
    let schedule = due_schedule(&s, &ids, false, 5).await;
    let (cookie, csrf) = admin(&s).await;
    let (status, body, _) = call(
        api::router(s.clone()),
        "POST",
        &format!("/api/v1/deployments/{schedule}/cancel"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "cancelled");
    rollout::tick(&s).await.unwrap();
    assert_eq!(deployment(&s, &schedule).await["status"], "cancelled");
    assert_eq!(desired(&s, &ids[0]).await, (None, 0));
}

#[tokio::test]
async fn an_activation_that_commits_first_keeps_its_released_devices_and_cancel_stops_the_rest() {
    let (_temp, s) = state(None).await;
    let ids = seed(&s, &["edge-01", "edge-02", "edge-03"]).await;
    let (cookie, csrf) = admin(&s).await;
    // A canary of one: the activation releases exactly one device.
    let schedule = due_schedule(&s, &ids, true, 5).await;

    // Hold the writer lock, queue the due tick first and the cancel second.
    let guard = s.writer.lock().await;
    let scheduler = {
        let s = s.clone();
        tokio::spawn(async move { rollout::tick(&s).await })
    };
    settle().await;
    let canceller = {
        let app = api::router(s.clone());
        let path = format!("/api/v1/deployments/{schedule}/cancel");
        tokio::spawn(async move { call(app, "POST", &path, json!({}), &cookie, &csrf).await })
    };
    settle().await;
    assert!(!scheduler.is_finished() && !canceller.is_finished());
    drop(guard);
    scheduler.await.unwrap().unwrap();
    let (status, cancelled, _) = canceller.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{cancelled}");
    assert_eq!(cancelled["status"], "cancelled");

    // The activation committed first: it released the canary device, and the
    // cancel that followed kept that release.
    let d = deployment(&s, &schedule).await;
    let first = released(&d);
    assert_eq!(first.len(), 1, "{d}");
    let actions: Vec<_> = history(&s, &schedule)
        .await
        .into_iter()
        .map(|(action, outcome)| format!("{action}:{outcome}"))
        .collect();
    assert_eq!(
        actions,
        [
            "deployment.schedule:success",
            "deployment.activate:success",
            "deployment.release:success",
            "deployment.cancel:success"
        ]
    );
    let (version, generation) = desired(&s, &first[0]).await;
    assert_eq!((version.as_deref(), generation), (Some("version-a"), 1));
    // The released device may still apply: its next check-in delivers the version.
    let names: std::collections::BTreeMap<String, &str> = ids
        .iter()
        .cloned()
        .zip(["edge-01", "edge-02", "edge-03"])
        .collect();
    let delivered = manifest(&s, names[&first[0]]).await;
    assert_eq!(delivered["desired"]["version_id"], "version-a");
    assert_eq!(delivered["generation"], 1);

    // Cancel stops further admissions, even once the canary has proven itself.
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND generation>0")
        .bind(db::now())
        .bind(&schedule)
        .execute(&s.pool)
        .await
        .unwrap();
    for _ in 0..3 {
        rollout::tick(&s).await.unwrap();
    }
    let d = deployment(&s, &schedule).await;
    assert_eq!(d["status"], "cancelled");
    assert_eq!(released(&d), first);
    for id in ids.iter().filter(|id| **id != first[0]) {
        assert_eq!(desired(&s, id).await, (None, 0), "{id} was never admitted");
        assert!(manifest(&s, names[id]).await["desired"].is_null());
    }
    // The released device keeps its version until something supersedes it.
    assert_eq!(
        desired(&s, &first[0]).await,
        (Some("version-a".to_owned()), 1)
    );
}

async fn desired_all(s: &State, ids: &[String]) -> Vec<(Option<String>, i64)> {
    let mut out = Vec::new();
    for id in ids {
        out.push(desired(s, id).await);
    }
    out
}
async fn seed_more(s: &State, names: &[&str]) -> Vec<String> {
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for name in names {
        let id = uuid::Uuid::new_v4().to_string();
        let d = json!({"id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"labels":{},"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(name)
            .bind(d.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}
