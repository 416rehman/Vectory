//! Which devices a canary releases first, what it watches while it waits, and
//! releasing the next stage early.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

#[derive(Clone)]
struct Identity {
    id: String,
    cookie: String,
    csrf: String,
}
async fn identity(s: &State, role: &str) -> Identity {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.invalid"))
    .bind(format!("Test {role}"))
    .bind(role)
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    Identity {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    who: &Identity,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", &who.cookie)
                .header("x-csrf-token", &who.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn agent_call(app: &Router, body: Value) {
    let response = app
        .clone()
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
    assert_eq!(response.status(), StatusCode::OK);
}

struct Env {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    admin: Identity,
    operator: Identity,
    version: String,
}
async fn env() -> Env {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Canary choice tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = identity(&s, "admin").await;
    let operator = identity(&s, "operator").await;
    let version = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn,"version",&json!({"id":version,"configuration_id":db::id(),"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    drop(conn);
    let app = api::router(s.clone());
    Env {
        _temp: temp,
        s,
        app,
        admin,
        operator,
        version,
    }
}

#[derive(Clone, Copy)]
enum Kind {
    Ready,
    NoMetrics,
    Failing,
    Paused,
    Away,
}
fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}
fn sample(events: f64) -> Value {
    json!({"sampled_at":db::now(),"events_per_second":events,"events_out_per_second":events - 0.1,"errors_per_minute":0.0,"buffer_utilization":0.02})
}
impl Env {
    /// A device whose ID sorts by `n`, in the given readiness.
    async fn device(&self, n: u32, kind: Kind) -> String {
        let mut data = json!({"id":id(n),"name":format!("device-{n}"),"vector_version":"0.58.0",
            "last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
        match kind {
            Kind::Ready => data["telemetry"] = sample(5.0),
            Kind::NoMetrics => {}
            Kind::Failing => data["apply_state"] = json!("failed"),
            Kind::Paused => data["local_paused"] = json!(true),
            Kind::Away => data["last_seen"] = json!((Utc::now() - Duration::hours(2)).to_rfc3339()),
        }
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(id(n))
            .bind(format!("device-{n}"))
            .bind(data.to_string())
            .execute(&self.s.pool)
            .await
            .unwrap();
        id(n)
    }
    fn body(&self, ids: &[String], rollout: Value) -> Value {
        json!({"version_id":self.version,
            "selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},
            "priority":100,"target_mode":"snapshot","rollout":rollout})
    }
    async fn preview(&self, body: Value) -> (StatusCode, Value) {
        call(
            &self.app,
            "POST",
            "/api/v1/deployments/preview",
            body,
            &self.admin,
        )
        .await
    }
    async fn create(&self, body: Value) -> (StatusCode, Value) {
        call(&self.app, "POST", "/api/v1/deployments", body, &self.admin).await
    }
    async fn released(&self, deployment: &str) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation>0 ORDER BY device_id",
        )
        .bind(deployment)
        .fetch_all(&self.s.pool)
        .await
        .unwrap()
    }
    async fn get(&self, path: &str) -> Value {
        let (status, body) = call(&self.app, "GET", path, Value::Null, &self.admin).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }
    async fn release(&self, deployment: &str, who: &Identity) -> (StatusCode, Value) {
        call(
            &self.app,
            "POST",
            &format!("/api/v1/deployments/{deployment}/release-next-stage"),
            Value::Null,
            who,
        )
        .await
    }
    /// The agent of `device` reports the current generation applied.
    async fn applied(&self, device: &str) {
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(db::id())
            .bind(device)
            .bind((Utc::now() + Duration::days(1)).to_rfc3339())
            .execute(&self.s.pool)
            .await
            .unwrap();
        let peer: String = sqlx::query_scalar(
            "SELECT fingerprint FROM credentials WHERE device_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .bind(device)
        .fetch_one(&self.s.pool)
        .await
        .unwrap();
        let router = vectory_server::device::router(self.s.clone()).layer(axum::Extension(
            vectory_server::device::PeerCertificate(Some(peer)),
        ));
        let generation: i64 =
            sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
                .bind(device)
                .fetch_one(&self.s.pool)
                .await
                .unwrap();
        agent_call(
            &router,
            json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":generation,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false}),
        )
        .await;
    }
    async fn reports(&self, device: &str, events: f64) {
        sqlx::query("UPDATE devices SET data=json_set(data,'$.telemetry',json(?)) WHERE id=?")
            .bind(sample(events).to_string())
            .bind(device)
            .execute(&self.s.pool)
            .await
            .unwrap();
    }
    async fn snapshot(&self) -> Value {
        let targets: Vec<String> = sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation,released_at) FROM deployment_targets ORDER BY deployment_id,device_id")
            .fetch_all(&self.s.pool)
            .await
            .unwrap();
        let records: Vec<String> = sqlx::query_scalar(
            "SELECT data FROM records WHERE kind IN ('deployment','audit') ORDER BY kind,id",
        )
        .fetch_all(&self.s.pool)
        .await
        .unwrap();
        json!({"targets":targets,"records":records})
    }
    async fn audits(&self, action: &str) -> Vec<Value> {
        sqlx::query_scalar::<_, String>(
            "SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",
        )
        .bind(action)
        .fetch_all(&self.s.pool)
        .await
        .unwrap()
        .iter()
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
    }
}
fn canary(size: u64, chosen: Option<Vec<String>>) -> Value {
    let mut rollout = json!({"kind":"canary","canary_size":size,"batch_size":1,"observation_seconds":3600,"failure_threshold":0});
    if let Some(chosen) = chosen {
        rollout["canary_device_ids"] = json!(chosen);
    }
    rollout
}

#[tokio::test]
async fn the_default_canary_is_the_most_ready_device_and_the_review_says_why() {
    let env = env().await;
    // Lowest ID first, so the old rule (first by ID) would have picked the
    // device that is offline.
    let ids = [
        env.device(1, Kind::Away).await,
        env.device(2, Kind::Paused).await,
        env.device(3, Kind::Failing).await,
        env.device(4, Kind::NoMetrics).await,
        env.device(5, Kind::Ready).await,
        env.device(6, Kind::Ready).await,
    ];
    let (status, review) = env.preview(env.body(&ids, canary(1, None))).await;
    assert_eq!(status, StatusCode::OK, "{review}");
    let plan = &review["canary"];
    assert_eq!(plan["device_ids"], json!([id(5)]), "{plan}");
    assert_eq!(plan["size"], 1);
    assert_eq!(plan["chosen_by_you"], false);
    assert_eq!(plan["devices"][0]["device_name"], "device-5");
    assert_eq!(plan["devices"][0]["chosen"], false);
    assert_eq!(plan["devices"][0]["readiness"], "ready");
    assert_eq!(
        plan["devices"][0]["reason"],
        "Online and healthy, and it reports metrics"
    );
    // Several: the most ready first, ID order among equals.
    let (_, review) = env.preview(env.body(&ids, canary(3, None))).await;
    assert_eq!(
        review["canary"]["device_ids"],
        json!([id(5), id(6), id(4)]),
        "{review}"
    );
    assert_eq!(review["canary"]["devices"][2]["readiness"], "no_metrics");
    // Nothing chosen for a rollout that is not a canary.
    let all = json!({"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":60,"failure_threshold":0});
    let (_, review) = env.preview(env.body(&ids, all)).await;
    assert!(review["canary"].is_null(), "{review}");
    // The rollout releases the canary the review named, and the rollout page
    // lists it first before anything is released.
    let (status, deployment) = env.create(env.body(&ids, canary(1, None))).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    assert_eq!(
        env.released(deployment["id"].as_str().unwrap()).await,
        [id(5)]
    );
}

#[tokio::test]
async fn a_chosen_canary_is_released_first_and_named_in_the_review() {
    let env = env().await;
    let ids = [
        env.device(1, Kind::Ready).await,
        env.device(2, Kind::Ready).await,
        env.device(3, Kind::Away).await,
    ];
    // The chosen device is offline: still the canary, with a warning.
    let chosen = vec![ids[2].clone()];
    let body = env.body(&ids, canary(1, Some(chosen.clone())));
    let (status, review) = env.preview(body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{review}");
    let plan = &review["canary"];
    assert_eq!(plan["device_ids"], json!(chosen));
    assert_eq!(plan["chosen_by_you"], true);
    assert_eq!(plan["devices"][0]["chosen"], true);
    assert_eq!(plan["devices"][0]["reason"], "You chose it");
    assert_eq!(plan["devices"][0]["readiness"], "away");
    assert!(
        review["warnings"]
            .to_string()
            .contains("device-3 is a canary but isn't checking in. The rollout waits for it."),
        "{review}"
    );
    let (status, deployment) = env.create(body).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let deployment_id = deployment["id"].as_str().unwrap();
    assert_eq!(env.released(deployment_id).await, [ids[2].clone()]);
    // The summary names the chosen devices, and the queued waves follow.
    let summary = env
        .get(&format!("/api/v1/deployments/{deployment_id}/summary"))
        .await;
    assert_eq!(summary["rollout"]["canary_device_ids"], json!(chosen));
    // Fewer named than the size: the best of the rest fill in.
    let (_, review) = env
        .preview(env.body(&ids, canary(2, Some(vec![ids[2].clone()]))))
        .await;
    assert_eq!(
        review["canary"]["device_ids"],
        json!([id(3), id(1)]),
        "{review}"
    );
    assert_eq!(review["canary"]["devices"][1]["chosen"], false);
}

#[tokio::test]
async fn the_rollout_page_lists_the_chosen_canary_before_it_is_released() {
    let env = env().await;
    let ids = [
        env.device(1, Kind::Ready).await,
        env.device(2, Kind::Ready).await,
        env.device(3, Kind::Ready).await,
    ];
    // A scheduled rollout releases nothing yet, but its queue is the plan.
    let mut body = env.body(&ids, canary(1, Some(vec![ids[2].clone()])));
    body["scheduled_at"] = json!((Utc::now() + Duration::hours(2)).to_rfc3339());
    let (status, deployment) = env.create(body).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let lanes = env
        .get(&format!(
            "/api/v1/deployments/{}/rollout",
            deployment["id"].as_str().unwrap()
        ))
        .await;
    let first = &lanes["stages"][0];
    assert_eq!(first["kind"], "canary");
    assert_eq!(first["state"], "queued");
    assert_eq!(first["devices"][0]["device_id"], json!(ids[2]), "{lanes}");
    assert_eq!(first["size"], 1);
    assert!(lanes["canary_watch"].is_null());
}

#[tokio::test]
async fn canary_devices_are_bounded_and_must_be_targets() {
    let env = env().await;
    let ids = [
        env.device(1, Kind::Ready).await,
        env.device(2, Kind::Ready).await,
    ];
    let stranger = env.device(9, Kind::Ready).await;
    let mut cases: Vec<(Value, &str)> = vec![
        (canary(1, Some(vec![stranger.clone()])), "target"),
        (
            canary(1, Some(vec![ids[0].clone(), ids[0].clone()])),
            "distinct",
        ),
        (
            canary(1, Some(vec!["AAAAAAAA-0000-4000-8000-000000000001".into()])),
            "distinct",
        ),
        (canary(1, Some(vec!["not-a-device".into()])), "device IDs"),
        (
            canary(1, Some(vec![ids[0].clone(), ids[1].clone()])),
            "more devices than",
        ),
        (
            canary(200, Some((0..101).map(|n| id(1000 + n)).collect())),
            "at most 100",
        ),
    ];
    let mut wrong_kind = canary(1, Some(vec![ids[0].clone()]));
    wrong_kind["kind"] = json!("all");
    cases.push((wrong_kind, "canary rollouts only"));
    let mut not_a_list = canary(1, None);
    not_a_list["canary_device_ids"] = json!(ids[0]);
    cases.push((not_a_list, "at most 100"));
    for (rollout, words) in cases {
        for preview in [true, false] {
            let body = env.body(&ids, rollout.clone());
            let (status, error) = if preview {
                env.preview(body).await
            } else {
                env.create(body).await
            };
            assert_eq!(status, StatusCode::BAD_REQUEST, "{words}: {error}");
            assert_eq!(error["error"]["code"], "INVALID_INPUT");
            assert!(
                error["error"]["message"].as_str().unwrap().contains(words),
                "{words}: {error}"
            );
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='deployment'")
        .fetch_one(&env.s.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    // An empty list and a null list are no choice at all.
    for none in [json!([]), Value::Null] {
        let mut rollout = canary(1, None);
        rollout["canary_device_ids"] = none;
        let (status, review) = env.preview(env.body(&ids, rollout)).await;
        assert_eq!(status, StatusCode::OK, "{review}");
        assert_eq!(review["canary"]["chosen_by_you"], false);
    }
}

/// A canary deployment over three ready devices whose first stage has applied.
async fn observing(env: &Env) -> (Vec<String>, String) {
    let ids = vec![
        env.device(1, Kind::Ready).await,
        env.device(2, Kind::Ready).await,
        env.device(3, Kind::Ready).await,
    ];
    let (status, deployment) = env.create(env.body(&ids, canary(1, None))).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let deployment = deployment["id"].as_str().unwrap().to_owned();
    assert_eq!(env.released(&deployment).await, [ids[0].clone()]);
    // The canary went out a while ago, so a later release is a stage of its own.
    sqlx::query(
        "UPDATE deployment_targets SET released_at=? WHERE deployment_id=? AND generation>0",
    )
    .bind(
        (Utc::now() - Duration::minutes(30))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string(),
    )
    .bind(&deployment)
    .execute(&env.s.pool)
    .await
    .unwrap();
    (ids, deployment)
}

#[tokio::test]
async fn the_next_stage_can_be_released_early_while_the_canary_is_observed() {
    let env = env().await;
    let (ids, deployment) = observing(&env).await;
    env.applied(&ids[0]).await;
    vectory_server::rollout::tick(&env.s).await.unwrap();
    let summary = env
        .get(&format!("/api/v1/deployments/{deployment}/summary"))
        .await;
    assert_eq!(summary["canary_gate"]["state"], "observing", "{summary}");
    // The watched canary is counted as verified: no reason holds it back.
    let watched = env
        .get(&format!("/api/v1/deployments/{deployment}/rollout"))
        .await;
    assert!(
        watched["canary_watch"]["devices"][0]["gate_reason"].is_null(),
        "{watched}"
    );
    let (status, released) = env.release(&deployment, &env.operator).await;
    assert_eq!(status, StatusCode::OK, "{released}");
    assert_eq!(
        env.released(&deployment).await,
        [ids[0].clone(), ids[1].clone()]
    );
    assert_eq!(released["status"], "active");
    // The audit row says what was skipped, with the gate as it stood.
    let audit = env.audits("deployment.stage_released_early").await;
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["actor"], env.operator.id);
    assert_eq!(audit[0]["target"], json!(deployment));
    assert_eq!(audit[0]["outcome"], "success");
    let details = &audit[0]["details"];
    assert_eq!(details["stage"], "canary");
    assert_eq!(details["gate_state"], "observing");
    assert_eq!(details["released_count"], 1);
    assert_eq!(details["verified_count"], 1);
    assert_eq!(details["next_released_count"], 1);
    assert!(
        details["summary"]
            .as_str()
            .unwrap()
            .starts_with("Released the next stage early"),
        "{details}"
    );
    // The audit page shows it too.
    let page = env
        .get(&format!(
            "/api/v1/audit/{}",
            audit[0]["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(page["details"]["stage"], "canary");
    assert_eq!(page["details"]["gate_state"], "observing");
    assert_eq!(page["details"]["next_released_count"], 1);
    // The rollout records who released that stage.
    let lanes = env
        .get(&format!("/api/v1/deployments/{deployment}/rollout"))
        .await;
    let stages = lanes["stages"].as_array().unwrap();
    assert!(stages[0]["released_early"].is_null(), "{lanes}");
    assert_eq!(stages[1]["kind"], "batch");
    assert_eq!(stages[1]["released_early"]["by_name"], "Test operator");
    // The stage just released has not applied yet, so the one after it waits.
    let (status, error) = env.release(&deployment, &env.operator).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("hasn't applied"),
        "{error}"
    );
    // Once it has, the last stage can go early too, and then nothing is left.
    env.applied(&ids[1]).await;
    let (status, released) = env.release(&deployment, &env.operator).await;
    assert_eq!(status, StatusCode::OK, "{released}");
    assert_eq!(env.released(&deployment).await, ids);
    let audit = env.audits("deployment.stage_released_early").await;
    assert_eq!(audit.len(), 2);
    assert!(
        audit.iter().any(|row| row["details"]["stage"] == "batch 1"),
        "{audit:?}"
    );
    env.applied(&ids[2]).await;
    let (status, error) = env.release(&deployment, &env.operator).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no next stage"),
        "{error}"
    );
}

#[tokio::test]
async fn the_next_stage_can_be_released_early_while_delivery_is_still_measured() {
    let env = env().await;
    let (ids, deployment) = observing(&env).await;
    env.applied(&ids[0]).await;
    // Applied, and reporting metrics, but too few delivery checks yet.
    env.reports(&ids[0], 5.0).await;
    let summary = env
        .get(&format!("/api/v1/deployments/{deployment}/summary"))
        .await;
    assert_eq!(
        summary["canary_gate"]["reasons"]["measuring"], 1,
        "{summary}"
    );
    assert_eq!(summary["canary_gate"]["state"], "waiting");
    // The rollout page names the same reason for that device.
    let watched = env
        .get(&format!("/api/v1/deployments/{deployment}/rollout"))
        .await;
    assert_eq!(
        watched["canary_watch"]["devices"][0]["gate_reason"], "measuring",
        "{watched}"
    );
    let (status, released) = env.release(&deployment, &env.admin).await;
    assert_eq!(status, StatusCode::OK, "{released}");
    assert_eq!(env.released(&deployment).await.len(), 2);
    let audit = env.audits("deployment.stage_released_early").await;
    assert_eq!(audit[0]["details"]["gate_state"], "measuring");
    assert_eq!(audit[0]["details"]["measuring_count"], 1);
    assert!(
        audit[0]["details"]["summary"]
            .as_str()
            .unwrap()
            .contains("delivery on the canary was still being measured")
    );
}

#[tokio::test]
async fn releasing_early_is_refused_unless_the_rollout_is_waiting_on_a_stage() {
    let env = env().await;
    let (ids, deployment) = observing(&env).await;
    let before = env.snapshot().await;
    let refuse = |deployment: String, what: &'static str, words: &'static str| {
        let env = &env;
        async move {
            let (status, error) = env.release(&deployment, &env.admin).await;
            assert_eq!(status, StatusCode::CONFLICT, "{what}: {error}");
            assert_eq!(error["error"]["code"], "CONFLICT");
            assert!(
                error["error"]["message"].as_str().unwrap().contains(words),
                "{what}: {error}"
            );
        }
    };
    // The canary has not applied yet.
    refuse(deployment.clone(), "not applied", "hasn't applied").await;
    assert_eq!(env.snapshot().await, before, "a refusal changes nothing");
    // Roles: only operators and administrators.
    for role in ["viewer", "editor"] {
        let who = identity(&env.s, role).await;
        let (status, error) = env.release(&deployment, &who).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{role}: {error}");
    }
    assert_eq!(env.snapshot().await, before);
    // Paused.
    env.applied(&ids[0]).await;
    let (status, _) = call(
        &env.app,
        "POST",
        &format!("/api/v1/deployments/{deployment}/pause"),
        Value::Null,
        &env.operator,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    refuse(deployment.clone(), "paused", "paused").await;
    // Failed and finished rollouts are not waiting on a stage.
    for (state, words) in [
        ("failed", "failed"),
        ("completed", "isn't waiting"),
        ("cancelled", "isn't waiting"),
    ] {
        let mut conn = env.s.pool.acquire().await.unwrap();
        let mut record = db::record(&mut conn, "deployment", &deployment)
            .await
            .unwrap();
        record["status"] = json!(state);
        db::update(&mut conn, "deployment", &record).await.unwrap();
        drop(conn);
        refuse(deployment.clone(), state, words).await;
    }
    assert_eq!(env.audits("deployment.stage_released_early").await.len(), 0);
    // An all-at-once rollout has no stages.
    let all = json!({"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":60,"failure_threshold":0});
    let single = env.device(20, Kind::Ready).await;
    let (status, plain) = env.create(env.body(&[single], all)).await;
    assert_eq!(status, StatusCode::OK, "{plain}");
    let plain = plain["id"].as_str().unwrap().to_owned();
    refuse(plain, "all at once", "canary rollout").await;
    // Unknown rollouts are 404.
    let (status, _) = env.release(&db::id(), &env.admin).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_canary_that_is_not_delivering_or_has_gone_quiet_holds_the_next_stage() {
    let env = env().await;
    let (ids, deployment) = observing(&env).await;
    env.applied(&ids[0]).await;
    // Applied, but its data plane says events are not being delivered.
    sqlx::query("UPDATE devices SET data=json_set(data,'$.data_plane',json(?)) WHERE id=?")
        .bind(
            json!({"version_id":env.version,"issues":[{"code":"DATA_PLANE_STALLED"}],"evaluations":5})
                .to_string(),
        )
        .bind(&ids[0])
        .execute(&env.s.pool)
        .await
        .unwrap();
    let before = env.snapshot().await;
    let (status, error) = env.release(&deployment, &env.admin).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("isn't delivering"),
        "{error}"
    );
    // Healthy again, but it stopped checking in.
    sqlx::query(
        "UPDATE devices SET data=json_set(json_remove(data,'$.data_plane'),'$.last_seen',?) WHERE id=?",
    )
    .bind((Utc::now() - Duration::hours(2)).to_rfc3339())
    .bind(&ids[0])
    .execute(&env.s.pool)
    .await
    .unwrap();
    let (status, error) = env.release(&deployment, &env.admin).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("hasn't checked in"),
        "{error}"
    );
    assert_eq!(env.released(&deployment).await, [ids[0].clone()]);
    assert_eq!(env.audits("deployment.stage_released_early").await.len(), 0);
    assert_eq!(env.snapshot().await, before, "a refusal changes nothing");
}

#[tokio::test]
async fn a_canary_that_covers_every_device_has_no_next_stage() {
    let env = env().await;
    let only = env.device(1, Kind::Ready).await;
    let (_, deployment) = env.create(env.body(&[only.clone()], canary(1, None))).await;
    let deployment = deployment["id"].as_str().unwrap().to_owned();
    env.applied(&only).await;
    let (status, error) = env.release(&deployment, &env.admin).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no next stage"),
        "{error}"
    );
}

#[tokio::test]
async fn the_canary_is_watched_against_the_minutes_before_its_release() {
    let env = env().await;
    let ids = vec![
        env.device(1, Kind::Ready).await,
        env.device(2, Kind::Ready).await,
        env.device(3, Kind::Ready).await,
        env.device(4, Kind::Ready).await,
    ];
    let (status, deployment) = env.create(env.body(&ids, canary(2, None))).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let deployment = deployment["id"].as_str().unwrap().to_owned();
    // Device 1 has four minutes of history before the release; device 2 is new.
    let released: String = sqlx::query_scalar(
        "SELECT min(released_at) FROM deployment_targets WHERE deployment_id=? AND generation>0",
    )
    .bind(&deployment)
    .fetch_one(&env.s.pool)
    .await
    .unwrap();
    let minute = chrono::DateTime::parse_from_rfc3339(&released)
        .unwrap()
        .timestamp()
        .div_euclid(60);
    for (offset, events) in [(1, 8.0), (2, 7.0), (3, 6.0), (4, 5.0)] {
        // The minute of the release itself and the one after are not baseline.
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?)")
            .bind(&ids[0])
            .bind(minute - offset)
            .bind(json!({"sampled_at":db::now(),"events_per_second":events,"events_out_per_second":events - 1.0,"errors_per_minute":offset as f64 - 1.0,"buffer_utilization":0.1 * offset as f64}).to_string())
            .execute(&env.s.pool)
            .await
            .unwrap();
    }
    for bucket in [minute, minute + 1, minute - 11] {
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?)")
            .bind(&ids[0])
            .bind(bucket)
            .bind(json!({"sampled_at":db::now(),"events_per_second":1000.0}).to_string())
            .execute(&env.s.pool)
            .await
            .unwrap();
    }
    env.reports(&ids[0], 9.0).await;
    let lanes = env
        .get(&format!("/api/v1/deployments/{deployment}/rollout"))
        .await;
    let watch = &lanes["canary_watch"];
    assert_eq!(watch["window_seconds"], 600);
    assert_eq!(watch["more"], 0);
    let devices = watch["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 2, "{watch}");
    let first = &devices[0];
    assert_eq!(first["device_id"], json!(ids[0]));
    assert_eq!(first["device_name"], "device-1");
    assert_eq!(first["released_at"], json!(released));
    assert_eq!(first["now"]["events_in_per_second"], 9.0);
    assert_eq!(first["now"]["events_out_per_second"], 8.9);
    let baseline = &first["baseline"];
    assert_eq!(baseline["minutes"], 4, "{first}");
    assert_eq!(baseline["events_in_per_second"], 6.5);
    assert_eq!(baseline["events_out_per_second"], 5.5);
    assert_eq!(baseline["errors_per_minute"], 1.5);
    assert!((baseline["buffer_utilization"].as_f64().unwrap() - 0.25).abs() < 1e-9);
    assert_eq!(first["samples"], json!({"measured":0,"needed":3}));
    // Released but not applied: the gate is waiting for it to confirm.
    assert_eq!(first["gate_reason"], "unverified");
    // No history is no baseline, never a zero.
    let second = &devices[1];
    assert_eq!(second["device_id"], json!(ids[1]));
    assert!(second["baseline"].is_null(), "{second}");
    assert_eq!(second["now"]["events_in_per_second"], 5.0);
    // A device that stopped reporting has no current reading.
    sqlx::query("UPDATE devices SET data=json_set(data,'$.telemetry.sampled_at',?) WHERE id=?")
        .bind((Utc::now() - Duration::hours(1)).to_rfc3339())
        .bind(&ids[1])
        .execute(&env.s.pool)
        .await
        .unwrap();
    let lanes = env
        .get(&format!("/api/v1/deployments/{deployment}/rollout"))
        .await;
    assert!(lanes["canary_watch"]["devices"][1]["now"].is_null());
    // Only running canaries carry it.
    let all = json!({"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":60,"failure_threshold":0});
    let single = env.device(30, Kind::Ready).await;
    let (_, plain) = env.create(env.body(&[single], all)).await;
    let lanes = env
        .get(&format!(
            "/api/v1/deployments/{}/rollout",
            plain["id"].as_str().unwrap()
        ))
        .await;
    assert!(lanes["canary_watch"].is_null());
}

#[tokio::test]
async fn the_watch_is_bounded_and_counts_the_rest() {
    let env = env().await;
    let mut ids = Vec::new();
    for n in 1..=8 {
        ids.push(env.device(n, Kind::Ready).await);
    }
    let (status, deployment) = env.create(env.body(&ids, canary(7, None))).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let lanes = env
        .get(&format!(
            "/api/v1/deployments/{}/rollout",
            deployment["id"].as_str().unwrap()
        ))
        .await;
    assert_eq!(
        lanes["canary_watch"]["devices"].as_array().unwrap().len(),
        5
    );
    assert_eq!(lanes["canary_watch"]["more"], 2);
    assert_eq!(lanes["stages"][0]["size"], 7);
}
