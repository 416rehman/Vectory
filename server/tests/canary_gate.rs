use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

async fn actor(s: &State, role: &str) -> (String, String, String) {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.invalid"))
    .bind(role)
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
    (id, format!("vectory_session={token}"), csrf)
}
async fn fixture() -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Canary evidence tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let (_, cookie, csrf) = actor(&s, "admin").await;
    let mut ids = Vec::new();
    for n in 0..3 {
        let id = db::id();
        let d = json!({"id":id,"name":format!("fixture-{n}"),"vector_version":"0.58.0","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(d["name"].as_str().unwrap())
            .bind(d.to_string())
            .execute(&s.pool)
            .await
            .unwrap();
        ids.push(id);
    }
    (temp, s.clone(), api::router(s), ids, cookie, csrf)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value) {
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
    (status, serde_json::from_slice(&bytes).unwrap())
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

async fn seed_versions(s: &State) -> (String, String) {
    let a = db::id();
    let b = db::id();
    let configuration = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    for (id, n) in [(&a, 1), (&b, 2)] {
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":configuration,"number":n,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    }
    (a, b)
}
fn binding(
    resource: &str,
    version: &str,
    seconds: u64,
    priority: i64,
    mode: &str,
    group_ids: Value,
    device_ids: Value,
    exclude_ids: Value,
    canary: bool,
) -> Value {
    let mut v = json!({"selector":{"group_ids":group_ids,"device_ids":device_ids,"exclude_ids":exclude_ids},"priority":priority,"target_mode":mode,"rollout":{"kind":if canary{"canary"}else{"all"},"canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}});
    if resource == "configuration" {
        v["version_id"] = json!(version);
    } else {
        v["policy"] =
            json!({"heartbeat_seconds":seconds,"sync_paused":false,"telemetry_enabled":true});
    }
    v
}
async fn create_binding(app: &Router, cookie: &str, csrf: &str, v: Value) -> Value {
    let (status, d) = call(app, "POST", "/api/v1/deployments", v, cookie, csrf).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}
async fn state_snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,desired_version_id,desired_generation,policy,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let targets:Vec<String>=sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation,error,original,released_at,verified_at) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"records":records,"devices":devices,"targets":targets})
}

async fn agent(s: &State, id: &str) -> Router {
    let peer = db::id();
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
        .bind(&peer)
        .bind(id)
        .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
        .execute(&s.pool)
        .await
        .unwrap();
    vectory_server::device::router(s.clone()).layer(axum::Extension(
        vectory_server::device::PeerCertificate(Some(peer)),
    ))
}
fn beat(generation: i64) -> Value {
    json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":generation,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false})
}
async fn heartbeat(agent: &Router, v: Value) {
    let result = call(agent, "POST", "/agent/v1/heartbeat", v, "", "").await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
}
async fn stored(s: &State, d: &Value) -> Value {
    db::record(
        &mut *s.pool.acquire().await.unwrap(),
        "deployment",
        d["id"].as_str().unwrap(),
    )
    .await
    .unwrap()
}
async fn elapsed(s: &State, d: &Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    let mut v = db::record(&mut conn, "deployment", d["id"].as_str().unwrap())
        .await
        .unwrap();
    v["observation_started_at"] =
        json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    db::update(&mut conn, "deployment", &v).await.unwrap();
}
async fn read_case(app: &Router, cookie: &str, d: &Value, name: &str) -> Value {
    let mut summary = Value::Null;
    for suffix in ["summary", "targets", "deployment", "history"] {
        let path = match suffix {
            "deployment" => format!("/api/v1/deployments/{}", d["id"].as_str().unwrap()),
            "history" => "/api/v1/deployments/history".into(),
            _ => format!(
                "/api/v1/deployments/{}/{}",
                d["id"].as_str().unwrap(),
                suffix
            ),
        };
        let result = call(app, "GET", &path, Value::Null, cookie, "").await;
        assert_eq!(result.0, StatusCode::OK, "{}", result.1);
        assert!(!result.1.to_string().contains("observation_evidence"));
        if suffix == "summary" {
            summary = result.1.clone();
        }
        if suffix == "history" {
            assert!(
                result.1["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|i| i.get("canary_gate").is_none())
            );
        }
        emit(&format!("{name}_{suffix}"), &result.1);
    }
    summary
}
async fn setup() -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
    Value,
    Router,
    String,
) {
    let (temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let (a, b) = seed_versions(&s).await;
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            60,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    let peer = agent(&s, &ids[0]).await;
    (temp, s, app, ids, cookie, csrf, d, peer, b)
}

#[tokio::test]
async fn current_config_proof_starts_full_window_and_private_state_never_leaks() {
    let (_t, s, app, ids, cookie, _csrf, d, peer, _) = setup().await;
    heartbeat(&peer, beat(1)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    let before = state_snapshot(&s).await;
    let summary = read_case(&app, &cookie, &d, "observing").await;
    assert_eq!(summary["canary_gate"]["state"], "observing");
    assert_eq!(summary["canary_gate"]["verified_count"], 1);
    assert_eq!(summary["canary_gate"]["pending_count"], 1);
    assert_eq!(state_snapshot(&s).await, before, "GET must not mutate gate");
    elapsed(&s, &d).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    let generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(d["id"].as_str().unwrap())
    .bind(&ids[1])
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(generation > 0);
}

#[tokio::test]
async fn stale_gap_healed_before_tick_still_restarts_observation() {
    let (_t, s, _app, ids, _cookie, _csrf, d, peer, _) = setup().await;
    heartbeat(&peer, beat(1)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    elapsed(&s, &d).await;
    sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?) WHERE id=?")
        .bind((chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339())
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    heartbeat(&peer, beat(1)).await;
    assert!(stored(&s, &d).await["observation_started_at"].is_null());
    vectory_server::rollout::tick(&s).await.unwrap();
    assert!(stored(&s, &d).await["observation_started_at"].is_string());
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?"
        )
        .bind(d["id"].as_str().unwrap())
        .bind(&ids[1])
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn unverified_and_local_pause_intervals_cannot_heal_into_old_window() {
    for state in ["verification_unknown", "paused", "failed"] {
        let (_t, s, app, _ids, cookie, _csrf, d, peer, _) = setup().await;
        heartbeat(&peer, beat(1)).await;
        vectory_server::rollout::tick(&s).await.unwrap();
        elapsed(&s, &d).await;
        let mut bad = beat(1);
        bad["apply_state"] = json!(state);
        bad["local_paused"] = json!(state == "paused");
        heartbeat(&peer, bad).await;
        let summary = read_case(&app, &cookie, &d, &format!("invalid_{state}")).await;
        assert_eq!(summary["canary_gate"]["state"], "waiting");
        heartbeat(&peer, beat(1)).await;
        assert!(stored(&s, &d).await["observation_started_at"].is_null());
        vectory_server::rollout::tick(&s).await.unwrap();
        assert!(stored(&s, &d).await["observation_started_at"].is_string());
    }
}

#[tokio::test]
async fn supersession_restoration_requires_new_generation_and_window() {
    let (_t, s, app, ids, cookie, csrf, d, peer, b) = setup().await;
    heartbeat(&peer, beat(1)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    elapsed(&s, &d).await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/deployments/{}/pause", d["id"].as_str().unwrap()),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    read_case(&app, &cookie, &d, "paused").await;
    let replacement = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            60,
            200,
            "snapshot",
            json!([]),
            json!([ids[0]]),
            json!([]),
            false,
        ),
    )
    .await;
    heartbeat(&peer, beat(2)).await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/deployments/{}/resume", d["id"].as_str().unwrap()),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let summary = read_case(&app, &cookie, &d, "superseded").await;
    assert_eq!(summary["verified_count"], 1, "recorded proof retained");
    assert_eq!(summary["canary_gate"]["reasons"]["superseded"], 1);
    let (review_status, removal_review) = call(
        &app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/unassign-preview",
            replacement["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(review_status, StatusCode::OK, "{removal_review}");
    assert_eq!(
        call(
            &app,
            "POST",
            &format!(
                "/api/v1/deployments/{}/unassign",
                replacement["id"].as_str().unwrap()
            ),
            json!({"review_token":removal_review["review_token"]}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    heartbeat(&peer, beat(2)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    assert!(stored(&s, &d).await["observation_started_at"].is_null());
    heartbeat(&peer, beat(3)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    assert_eq!(
        read_case(&app, &cookie, &d, "restored").await["canary_gate"]["state"],
        "observing"
    );
}

#[tokio::test]
async fn secret_rotation_requires_current_verified_revision_and_new_window() {
    let (_t, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let version = db::id();
    db::insert(&mut *s.pool.acquire().await.unwrap(),"version",&json!({"id":version,"configuration_id":db::id(),"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now(),"uses_local_secrets":true})).await.unwrap();
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &version,
            60,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    let peer = agent(&s, &ids[0]).await;
    let mut first = beat(1);
    first["actual_sha256"] = json!(db::hash("effective-one"));
    first["applied_template_sha256"] = json!(db::hash("{}\n"));
    first["secret_revision"] = json!(1);
    heartbeat(&peer, first.clone()).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    elapsed(&s, &d).await;
    let mut second = first.clone();
    second["secret_revision"] = json!(2);
    second["actual_sha256"] = json!(db::hash("effective-two"));
    heartbeat(&peer, second.clone()).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    let new = stored(&s, &d).await;
    assert!(
        chrono::DateTime::parse_from_rfc3339(new["observation_started_at"].as_str().unwrap())
            .unwrap()
            > chrono::Utc::now() - chrono::Duration::minutes(1)
    );
    second["secret_revision"] = json!(3);
    second["apply_state"] = json!("verification_unknown");
    heartbeat(&peer, second.clone()).await;
    assert_eq!(
        read_case(&app, &cookie, &d, "secret_unverified").await["canary_gate"]["verified_count"],
        0
    );
    second["apply_state"] = json!("verified_applied");
    heartbeat(&peer, second).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    assert_eq!(
        read_case(&app, &cookie, &d, "secret_restored").await["canary_gate"]["state"],
        "observing"
    );
}

#[tokio::test]
async fn pause_resume_and_fast_retry_cannot_reuse_elapsed_window() {
    let (_t, s, app, ids, cookie, csrf, d, peer, _) = setup().await;
    heartbeat(&peer, beat(1)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    elapsed(&s, &d).await;
    for action in ["pause", "resume"] {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("/api/v1/deployments/{}/{action}", d["id"].as_str().unwrap()),
                json!({}),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert!(
        chrono::DateTime::parse_from_rfc3339(
            stored(&s, &d).await["observation_started_at"]
                .as_str()
                .unwrap()
        )
        .unwrap()
            > chrono::Utc::now() - chrono::Duration::minutes(1)
    );
    elapsed(&s, &d).await;
    // Simulate counter recovery completing between ticks; same content still
    // needs a new generation's full observation interval.
    sqlx::query("UPDATE devices SET desired_generation=desired_generation+1 WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE deployment_targets SET generation=generation+1,state='desired' WHERE deployment_id=? AND device_id=?").bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
    heartbeat(&peer, beat(2)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?"
        )
        .bind(d["id"].as_str().unwrap())
        .bind(&ids[1])
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn all_at_once_completion_keeps_historical_receipt_semantics() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let peer = agent(&s, &ids[0]).await;
    let first = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            60,
            100,
            "snapshot",
            json!([]),
            json!([ids[0]]),
            json!([]),
            false,
        ),
    )
    .await;
    heartbeat(&peer, beat(1)).await;
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            60,
            200,
            "snapshot",
            json!([]),
            json!([ids[0]]),
            json!([]),
            false,
        ),
    )
    .await;
    heartbeat(&peer, beat(2)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    let summary = read_case(&app, &cookie, &first, "all_historical").await;
    assert_eq!(summary["status"], "completed");
    assert!(summary.get("canary_gate").is_none());
}

#[tokio::test]
async fn bounded_page_membership_matches_persistent_selection_and_snapshot_history() {
    use std::collections::BTreeSet;
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let (a, _) = seed_versions(&s).await;
    let group = json!({"id":db::id(),"name":"Synthetic members","revision":1,"device_ids":ids});
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, "group", &group).await.unwrap();
    drop(conn);
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            60,
            100,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([ids[2]]),
            true,
        ),
    )
    .await;
    let released = d["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["generation"] != 0)
        .unwrap()["device_id"]
        .as_str()
        .unwrap();
    let peer = agent(&s, released).await;
    heartbeat(&peer, beat(1)).await;
    vectory_server::rollout::tick(&s).await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    let mut record = stored(&s, &d).await;
    let proof = vectory_server::canary_gate::evaluate(
        &mut conn,
        &record,
        Some(&BTreeSet::from([released.to_owned()])),
    )
    .await
    .unwrap();
    assert_eq!(proof.released, 1);
    assert_eq!(proof.verified, 1);
    assert_eq!(proof.target_reasons.len(), 1);
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(released)
        .execute(&mut *conn)
        .await
        .unwrap();
    let proof = vectory_server::canary_gate::evaluate(&mut conn, &record, None)
        .await
        .unwrap();
    assert_eq!(proof.released, 0, "persistent retired identities excluded");
    record["target_mode"] = json!("snapshot");
    let proof = vectory_server::canary_gate::evaluate(&mut conn, &record, None)
        .await
        .unwrap();
    assert_eq!(
        proof.reasons["unavailable"], 1,
        "snapshot keeps historical unavailable identity"
    );
    db::update(&mut conn, "deployment", &record).await.unwrap();
    drop(conn);
    read_case(&app, &cookie, &d, "unavailable").await;
}

#[tokio::test]
async fn gate_streams_more_than_one_chunk_and_bounds_malformed_observation_time() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let (a, _) = seed_versions(&s).await;
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            60,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    let mut conn = s.pool.acquire().await.unwrap();
    for _ in 0..205 {
        let id = db::id();
        sqlx::query("INSERT INTO devices(id,name,data,revoked) VALUES(?,?,'{}',1)")
            .bind(&id)
            .bind(&id)
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,'verified_applied',1)").bind(d["id"].as_str().unwrap()).bind(&id).execute(&mut *conn).await.unwrap();
    }
    let record = db::record(&mut conn, "deployment", d["id"].as_str().unwrap())
        .await
        .unwrap();
    let proof = vectory_server::canary_gate::evaluate(&mut conn, &record, None)
        .await
        .unwrap();
    assert_eq!(proof.released, 206);
    assert_eq!(proof.pending, 1);
    assert_eq!(proof.reasons["unavailable"], 205);
    assert!(
        proof.target_reasons.is_empty(),
        "aggregate memory must not accumulate target details"
    );
    assert_eq!(
        proof.verified + proof.reasons.values().sum::<i64>(),
        proof.released
    );
    drop(conn);
    let summary = read_case(&app, &cookie, &d, "large_unavailable").await;
    assert_eq!(summary["canary_gate"]["released_count"], 206);
    // The display timer is restricted to the same timestamp as evaluated_at.
    let mut example = record.clone();
    example["observation_started_at"] = json!("9999-01-01T00:00:00Z");
    assert!(proof.projection(&example)["observation_started_at"].is_null());
}
