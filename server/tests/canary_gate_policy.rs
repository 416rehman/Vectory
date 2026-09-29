//! Isolated policy/configuration gate integration. Heartbeats use the real handler
//! with a synthetic authenticated peer; no native Vector activation is claimed.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, canary_gate, db, device, initialize, rollout};

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    app: Router,
    ids: Vec<String>,
    cookie: String,
    csrf: String,
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> Value {
    let response = app
        .clone()
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
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{method} {path}: {result}");
    result
}
impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let state = initialize(Settings {
            data_dir: temp.path().join("state"),
            bootstrap_secret: "unused-synthetic-bootstrap".into(),
            cookie_secure: false,
            dashboard_dir: temp.path().join("dist"),
            releases_dir: temp.path().join("releases"),
            instance_name: "Policy gate tests".into(),
            validation_url: None,
            ..Default::default()
        })
        .await
        .unwrap();
        let actor = db::id();
        let token = auth::random_secret();
        let csrf = auth::random_secret();
        sqlx::query(
            "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
        )
        .bind(&actor)
        .bind(format!("{actor}@example.invalid"))
        .bind("Synthetic admin")
        .bind("admin")
        .bind("unused-test-hash")
        .bind(db::now())
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
            .bind(db::hash(&token))
            .bind(&actor)
            .bind(&csrf)
            .bind("2099-01-01T00:00:00Z")
            .execute(&state.pool)
            .await
            .unwrap();
        let mut ids = vec![db::id(), db::id()];
        ids.sort();
        for (i, id) in ids.iter().enumerate() {
            let data = json!({"id":id,"name":format!("policy-fixture-{i}"),"vector_version":"0.58.0","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
            sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
                .bind(id)
                .bind(format!("policy-fixture-{i}"))
                .bind(data.to_string())
                .execute(&state.pool)
                .await
                .unwrap();
        }
        Self {
            _temp: temp,
            app: api::router(state.clone()),
            state,
            ids,
            cookie: format!("vectory_session={token}"),
            csrf,
        }
    }
    async fn request(&self, method: &str, path: &str, body: Value) -> Value {
        call(&self.app, method, path, body, &self.cookie, &self.csrf).await
    }
    async fn create(&self, resource: Value, canary: bool, priority: i64, ids: &[String]) -> Value {
        let mut body = json!({"selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":if canary {"canary"} else {"all"},"canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}});
        body.as_object_mut()
            .unwrap()
            .extend(resource.as_object().unwrap().clone());
        self.request("POST", "/api/v1/deployments", body).await
    }
    async fn action(&self, d: &Value, action: &str) -> Value {
        let id = d["id"].as_str().unwrap();
        let body = if action == "unassign" {
            let review = self
                .request(
                    "POST",
                    &format!("/api/v1/deployments/{id}/unassign-preview"),
                    json!({}),
                )
                .await;
            assert_eq!(review["ready"], true);
            json!({"review_token":review["review_token"]})
        } else {
            json!({})
        };
        self.request("POST", &format!("/api/v1/deployments/{id}/{action}"), body)
            .await
    }
    async fn summary(&self, d: &Value) -> Value {
        self.request(
            "GET",
            &format!("/api/v1/deployments/{}/summary", d["id"].as_str().unwrap()),
            Value::Null,
        )
        .await
    }
    async fn stored(&self, d: &Value) -> Value {
        let mut conn = self.state.pool.acquire().await.unwrap();
        db::record(&mut conn, "deployment", d["id"].as_str().unwrap())
            .await
            .unwrap()
    }
    async fn targets(&self, d: &Value) -> Value {
        self.request(
            "GET",
            &format!("/api/v1/deployments/{}", d["id"].as_str().unwrap()),
            Value::Null,
        )
        .await["targets"]
            .clone()
    }
    async fn age_window(&self, d: &Value) {
        let mut stored = self.stored(d).await;
        assert!(
            stored["observation_started_at"].is_string(),
            "A real accepted heartbeat must establish a window before test time is advanced"
        );
        assert!(stored["observation_evidence"].is_string());
        stored["observation_started_at"] =
            json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
        let mut conn = self.state.pool.acquire().await.unwrap();
        db::update(&mut conn, "deployment", &stored).await.unwrap();
    }
    async fn tick(&self) {
        rollout::tick(&self.state).await.unwrap();
    }
    async fn peer(&self, id: &str) -> Router {
        let fingerprint = db::id();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(&fingerprint)
            .bind(id)
            .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
            .execute(&self.state.pool)
            .await
            .unwrap();
        device::router(self.state.clone())
            .layer(axum::Extension(device::PeerCertificate(Some(fingerprint))))
    }
    async fn version(&self) -> String {
        let id = db::id();
        let mut conn = self.state.pool.acquire().await.unwrap();
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":db::id(),"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
        id
    }
}
fn policy(seconds: u64, paused: bool) -> Value {
    json!({"policy":{"heartbeat_seconds":seconds,"sync_paused":paused,"telemetry_enabled":true}})
}
fn emit(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("VECTORY_GROUP_FIXTURES") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{name}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}
async fn heartbeat(
    peer: &Router,
    configuration: i64,
    policy: i64,
    state: &str,
    local_paused: bool,
    ack: bool,
) {
    call(peer, "POST", "/agent/v1/heartbeat", json!({
        "protocol_version":1,"request_id":db::id(),"boot_id":"synthetic-policy-test",
        "nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0",
        "reported_generation":configuration,"policy_generation":policy,"apply_state":state,
        "actual_sha256":if configuration>0 {db::hash("{}\n")}else{String::new()},
        "local_paused":local_paused,"remote_pause_acknowledged":ack
    }), "", "").await;
}
fn target<'a>(targets: &'a Value, id: &str) -> &'a Value {
    targets
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["device_id"] == id)
        .unwrap()
}

#[tokio::test]
async fn policy_invalidation_handles_omitted_and_null_version_without_erasing_config_window() {
    for explicit_null in [false, true] {
        let f = Fixture::new().await;
        let peer = f.peer(&f.ids[0]).await;
        let version = f.version().await;
        let config = f
            .create(json!({"version_id":version}), true, 100, &f.ids)
            .await;
        let mut resource = policy(60, false);
        if explicit_null {
            resource["version_id"] = Value::Null;
        }
        let p = f.create(resource, true, 100, &f.ids).await;
        heartbeat(&peer, 1, 1, "verified_applied", false, false).await;
        f.tick().await;
        assert_eq!(f.summary(&p).await["canary_gate"]["state"], "observing");
        assert_eq!(
            f.summary(&config).await["canary_gate"]["state"],
            "observing"
        );
        let before_targets = f.targets(&p).await;
        let config_before = f.stored(&config).await;
        let mut tx = f.state.pool.begin().await.unwrap();
        canary_gate::invalidate_resource(&mut tx, &f.ids[0], false)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let stored = f.stored(&p).await;
        assert!(
            stored["observation_started_at"].is_null(),
            "policy discriminator explicit_null={explicit_null}"
        );
        assert!(stored.get("observation_evidence").is_none());
        assert_eq!(
            f.targets(&p).await,
            before_targets,
            "Invalidation must not rewrite target history"
        );
        assert_eq!(
            f.stored(&config).await,
            config_before,
            "Independent config proof is unchanged"
        );
    }
}

#[tokio::test]
async fn policy_pause_and_interval_transitions_reset_config_window_without_waiting_for_a_tick() {
    for change in [policy(60, true), policy(10, false)] {
        let f = Fixture::new().await;
        let peer = f.peer(&f.ids[0]).await;
        let version = f.version().await;
        let source = f
            .create(json!({"version_id":version}), true, 100, &f.ids)
            .await;
        heartbeat(&peer, 1, 0, "verified_applied", false, false).await;
        f.tick().await;
        f.age_window(&source).await;
        let before_targets = f.targets(&source).await;
        let setting = f.create(change, false, 200, &f.ids[..1]).await;
        assert!(
            f.stored(&source).await["observation_started_at"].is_null(),
            "Known effective policy change must immediately invalidate config observation"
        );
        // Both writes complete between scheduler checks and before any agent ack.
        f.action(&setting, "unassign").await;
        assert!(f.stored(&source).await["observation_started_at"].is_null());
        assert_eq!(f.targets(&source).await, before_targets);
        f.tick().await;
        assert_eq!(
            target(&f.targets(&source).await, &f.ids[1])["generation"],
            0,
            "Old elapsed time must not release a new wave"
        );
        let current = f.summary(&source).await;
        assert_eq!(current["canary_gate"]["state"], "observing");
        assert_eq!(current["canary_gate"]["verified_count"], 1);
    }
}

#[tokio::test]
async fn policy_gate_is_independent_of_failed_configuration_and_local_pause() {
    let f = Fixture::new().await;
    let peer = f.peer(&f.ids[0]).await;
    let source = f.create(policy(120, false), true, 100, &f.ids).await;
    heartbeat(&peer, 0, 1, "failed", true, false).await;
    f.tick().await;
    let gate = f.summary(&source).await["canary_gate"].clone();
    assert_eq!(gate["state"], "observing");
    assert_eq!(gate["verified_count"], 1);
    assert_eq!(gate["reasons"]["paused"], 0);
    f.age_window(&source).await;
    f.tick().await;
    assert!(
        target(&f.targets(&source).await, &f.ids[1])["generation"]
            .as_i64()
            .unwrap()
            > 0
    );
}

#[tokio::test]
async fn paused_policy_requires_current_generation_and_remote_pause_acknowledgement() {
    let f = Fixture::new().await;
    let peer = f.peer(&f.ids[0]).await;
    let source = f.create(policy(60, true), true, 100, &f.ids).await;
    for (generation, ack) in [(0, true), (1, false)] {
        heartbeat(&peer, 0, generation, "paused", true, ack).await;
        f.tick().await;
        let gate = f.summary(&source).await["canary_gate"].clone();
        assert_eq!(gate["verified_count"], 0);
        assert_eq!(gate["reasons"]["unverified"], 1);
        assert!(f.stored(&source).await["observation_started_at"].is_null());
        assert_eq!(
            target(&f.targets(&source).await, &f.ids[1])["generation"],
            0
        );
    }
    heartbeat(&peer, 0, 1, "paused", true, true).await;
    f.tick().await;
    let accepted = f.summary(&source).await;
    assert_eq!(accepted["canary_gate"]["state"], "observing");
    emit("policy_pause_summary", &accepted);
    let page = f
        .request(
            "GET",
            &format!(
                "/api/v1/deployments/{}/targets?page=1&page_size=12",
                source["id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await;
    emit("policy_pause_targets", &page);
    f.age_window(&source).await;
    f.tick().await;
    assert!(
        target(&f.targets(&source).await, &f.ids[1])["generation"]
            .as_i64()
            .unwrap()
            > 0
    );
}

#[tokio::test]
async fn restored_policy_requires_new_generation_ack_and_a_new_complete_observation_window() {
    let f = Fixture::new().await;
    let peer = f.peer(&f.ids[0]).await;
    let source = f.create(policy(60, false), true, 100, &f.ids).await;
    heartbeat(&peer, 0, 1, "unmanaged", false, false).await;
    f.tick().await;
    f.age_window(&source).await;
    f.action(&source, "pause").await;
    let replacement = f.create(policy(120, false), false, 200, &f.ids[..1]).await;
    heartbeat(&peer, 0, 2, "unmanaged", false, false).await;
    f.action(&source, "resume").await;
    assert_eq!(
        f.summary(&source).await["canary_gate"]["reasons"]["superseded"],
        1
    );
    f.action(&replacement, "unassign").await;
    let targets = f.targets(&source).await;
    assert_eq!(target(&targets, &f.ids[0])["generation"], 3);
    assert_eq!(
        target(&targets, &f.ids[0])["state"],
        "verified_applied",
        "Historical success remains retained"
    );
    heartbeat(&peer, 0, 1, "unmanaged", false, false).await;
    f.tick().await;
    assert_eq!(
        f.summary(&source).await["canary_gate"]["reasons"]["unverified"],
        1
    );
    assert_eq!(
        target(&f.targets(&source).await, &f.ids[1])["generation"],
        0
    );
    heartbeat(&peer, 0, 3, "unmanaged", false, false).await;
    f.tick().await;
    assert_eq!(
        f.summary(&source).await["canary_gate"]["state"],
        "observing"
    );
    f.tick().await;
    assert_eq!(
        target(&f.targets(&source).await, &f.ids[1])["generation"],
        0,
        "New acknowledgement cannot inherit old observation time"
    );
    f.age_window(&source).await;
    f.tick().await;
    assert!(
        target(&f.targets(&source).await, &f.ids[1])["generation"]
            .as_i64()
            .unwrap()
            > 0
    );
}
