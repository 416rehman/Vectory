use axum::Extension;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{
    Settings, State, api, auth, canary_gate, db, device, initialize, rollout, validation,
};

const VARIABLE_VERSION: &str = "00000000-0000-4000-8000-000000000803";

async fn variable_version(state: &State) {
    let config = json!({"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"max_events":500,"type":"memory"}}}});
    assert_eq!(validation::validate(&config)["valid"], true);
    let artifact = validation::render(&config).unwrap();
    let mut conn = state.pool.acquire().await.unwrap();
    db::insert(&mut conn,"version",&json!({"id":VARIABLE_VERSION,"configuration_id":"00000000-0000-4000-8000-000000000800","number":3,"config":config,"variables":[{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}],"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
}

#[tokio::test]
async fn variable_targets_get_distinct_signed_digests_and_cannot_cross_fetch() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    variable_version(&state).await;
    let selected = vec![ids[0].clone(), ids[2].clone()];
    let body = variable_request(&selected, 100, 600, Some((&ids[2], 700)));
    let (status, preview) = call(
        &app,
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let artifacts = preview["artifact_previews"].as_array().unwrap();
    assert_eq!(artifacts.len(), 2);
    assert_ne!(artifacts[0]["sha256"], artifacts[1]["sha256"]);
    let (status, deployment) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    assert!(
        deployment.get("variable_bindings").is_none(),
        "binding values must not appear in deployment reads"
    );
    let mut delivered = Vec::new();
    for (index, id) in selected.iter().enumerate() {
        let fingerprint = format!("variable-peer-{index}");
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(&fingerprint)
            .bind(id)
            .bind("2099-01-01T00:00:00Z")
            .execute(&state.pool)
            .await
            .unwrap();
        let agent = device::router(state.clone())
            .layer(Extension(device::PeerCertificate(Some(fingerprint))));
        let heartbeat = json!({"protocol_version":1,"request_id":format!("variable-request-{index}"),"boot_id":"variable-boot","nonce":STANDARD.encode([index as u8 + 1;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"desired","local_paused":false,"remote_pause_acknowledged":false,"configuration_mode":"full"});
        let (status, envelope) = call(&agent, "/agent/v1/heartbeat", heartbeat, "", "").await;
        assert_eq!(status, StatusCode::OK, "{envelope}");
        let payload: Value = serde_json::from_slice(
            &STANDARD
                .decode(envelope["payload"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["generation"], 1);
        let desired = &payload["desired"];
        let sha = desired["sha256"].as_str().unwrap();
        let (status, artifact) = call_method(
            &agent,
            "GET",
            desired["artifact_path"].as_str().unwrap(),
            Value::Null,
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{artifact}");
        assert_eq!(
            artifact["sinks"]["out"]["buffer"]["max_events"],
            if index == 0 { 600 } else { 700 }
        );
        let bytes = validation::render(&artifact).unwrap();
        assert_eq!(db::hash(bytes), sha);
        delivered.push((agent, sha.to_owned()));
    }
    for index in 0..2 {
        let other = 1 - index;
        let (status, _) = call_method(
            &delivered[index].0,
            "GET",
            &format!("/agent/v1/artifacts/{}", delivered[other].1),
            Value::Null,
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let blobs: i64 = sqlx::query_scalar("SELECT count(*) FROM artifact_blobs")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(blobs, 2);
}

#[tokio::test]
async fn binding_only_redeploy_advances_generation_and_rollback_restores_exact_bytes() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    variable_version(&state).await;
    let selected = vec![ids[0].clone()];
    let first = variable_request(&selected, 100, 600, None);
    let (status, first_deployment) = call(&app, "/api/v1/deployments", first, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{first_deployment}");
    let first_sha: String = sqlx::query_scalar(
        "SELECT sha256 FROM desired_artifacts WHERE device_id=? AND generation=1",
    )
    .bind(&ids[0])
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let same_priority = variable_request(&selected, 100, 700, None);
    let (status, conflict) = call(
        &app,
        "/api/v1/deployments/preview",
        same_priority,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{conflict}");
    assert!(!conflict["conflicts"].as_array().unwrap().is_empty());
    let second = variable_request(&selected, 101, 700, None);
    let (status, second_deployment) =
        call(&app, "/api/v1/deployments", second, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{second_deployment}");
    let row = sqlx::query("SELECT desired_generation,data FROM devices WHERE id=?")
        .bind(&ids[0])
        .fetch_one(&state.pool)
        .await
        .unwrap();
    use sqlx::Row;
    assert_eq!(row.get::<i64, _>("desired_generation"), 2);
    let device_data: Value = serde_json::from_str(row.get("data")).unwrap();
    let second_sha = device_data["desired_artifact_sha256"].as_str().unwrap();
    assert_ne!(second_sha, first_sha);

    // Current canary proof must use the immutable rendered SHA, not the
    // published version's baseline template SHA or a mutable device field.
    let mut conn = state.pool.acquire().await.unwrap();
    let deployment = db::record(
        &mut conn,
        "deployment",
        second_deployment["id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=? AND device_id=?")
        .bind(second_deployment["id"].as_str().unwrap()).bind(&ids[0]).execute(&state.pool).await.unwrap();
    let base_sha: String = sqlx::query_scalar(
        "SELECT json_extract(data,'$.sha256') FROM records WHERE kind='version' AND id=?",
    )
    .bind(VARIABLE_VERSION)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?,'$.apply_state','verified_applied','$.reported_apply_state','verified_applied','$.reported_generation',2,'$.actual_sha256',?) WHERE id=?")
        .bind(db::now()).bind(&base_sha).bind(&ids[0]).execute(&state.pool).await.unwrap();
    let scope = std::collections::BTreeSet::from([ids[0].clone()]);
    assert_eq!(
        canary_gate::evaluate(&mut conn, &deployment, Some(&scope))
            .await
            .unwrap()
            .verified,
        0
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.actual_sha256',?) WHERE id=?")
        .bind(second_sha)
        .bind(&ids[0])
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        canary_gate::evaluate(&mut conn, &deployment, Some(&scope))
            .await
            .unwrap()
            .verified,
        1
    );
    drop(conn);

    let path = format!(
        "/api/v1/deployments/{}/rollback",
        second_deployment["id"].as_str().unwrap()
    );
    let (status, rolled) = call(&app, &path, json!({}), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{rolled}");
    let third_sha: String = sqlx::query_scalar(
        "SELECT sha256 FROM desired_artifacts WHERE device_id=? AND generation=3",
    )
    .bind(&ids[0])
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        third_sha, first_sha,
        "rollback restores the exact prior per-device bytes"
    );
    let next = variable_request(&selected, 103, 800, None);
    let (status, next_deployment) = call(&app, "/api/v1/deployments", next, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{next_deployment}");
    let next_generation: i64 =
        sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        next_generation, 4,
        "a rollback assignment can be superseded safely"
    );
}

fn variable_request(
    devices: &[String],
    priority: i64,
    base: i64,
    override_device: Option<(&str, i64)>,
) -> Value {
    let mut body = request(VARIABLE_VERSION, devices, "snapshot");
    body["priority"] = json!(priority);
    let mut overrides = serde_json::Map::new();
    if let Some((id, value)) = override_device {
        overrides.insert(id.to_owned(), json!({"max_events":value}));
    }
    body["variable_bindings"] = json!({"defaults":{"max_events":base},"devices":overrides});
    body
}

const FULL_VERSION: &str = "00000000-0000-4000-8000-000000000801";
const RESTRICTED_VERSION: &str = "00000000-0000-4000-8000-000000000802";

async fn fixture() -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-compatibility-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Synthetic compatibility fixture".into(),
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
    .bind("operator@example.invalid")
    .bind("Synthetic operator")
    .bind("operator")
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
    let mut ids = Vec::new();
    let mut tx = state.pool.begin().await.unwrap();
    for index in 0..3 {
        let id = db::id();
        let name = format!("Synthetic compatibility device {index}");
        let device = json!({
            "id":id,"name":name,"os":"windows","arch":"amd64",
            "vector_version":"0.58.0","configuration_mode":if index == 1 {"restricted"} else {"full"},
            "last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()
        });
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&name)
            .bind(device.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    for (id, config) in [
        (
            FULL_VERSION,
            json!({"sources":{"in":{"type":"demo_logs"}},"sinks":{"out":{"type":"aws_s3","inputs":["in"],"bucket":"synthetic-only"}}}),
        ),
        (
            RESTRICTED_VERSION,
            // Unit tests add no capability: restricted devices accept them,
            // sample data included.
            json!({"sources":{"in":{"type":"demo_logs"}},"transforms":{"t":{"type":"remap","inputs":["in"],"source":".x = 1"}},"sinks":{"out":{"type":"blackhole","inputs":["t"]}},
                "tests":[{"name":"sets x","inputs":[{"insert_at":"t","type":"log","log_fields":{"message":"GET https://example.com/$HOME"}}],
                    "outputs":[{"extract_from":"t","conditions":[{"type":"vrl","source":"assert_eq!(.x, 1)"}]}]}]}),
        ),
    ] {
        let artifact = format!("{}\n", serde_json::to_string_pretty(&config).unwrap());
        db::insert(
            &mut tx,
            "version",
            &json!({
                "id":id,"configuration_id":"00000000-0000-4000-8000-000000000800",
                "number":1,"config":config,"artifact":artifact,"sha256":db::hash(&artifact),
                "size":artifact.len(),"created_at":db::now()
            }),
        )
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    (
        temp,
        state.clone(),
        api::router(state),
        ids,
        format!("vectory_session={token}"),
        csrf,
    )
}

fn request(version: &str, devices: &[String], target_mode: &str) -> Value {
    json!({
        "version_id":version,
        "selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},
        "priority":100,"target_mode":target_mode,
        "rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}
    })
}

async fn call(
    app: &Router,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value) {
    call_method(app, "POST", path, body, cookie, csrf).await
}

async fn call_method(
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

#[tokio::test]
async fn persistent_group_cannot_admit_a_restricted_member_to_full_mode_configuration() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    let (status, group) = call(
        &app,
        "/api/v1/groups",
        json!({"name":"Synthetic compatibility group","description":"","device_ids":[ids[0]]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let mut body = request(FULL_VERSION, &[], "persistent");
    body["selector"]["group_ids"] = json!([group["id"]]);
    let (status, deployment) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let path = format!("/api/v1/groups/{}", group["id"].as_str().unwrap());
    let (status, rejected) = call_method(
        &app,
        "PUT",
        &path,
        json!({
            "name":group["name"],"description":group["description"],
            "device_ids":[ids[0],ids[1]],"revision":group["revision"]
        }),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    let (status, unchanged) = call_method(&app, "GET", &path, Value::Null, &cookie, "").await;
    assert_eq!(status, StatusCode::OK, "{unchanged}");
    assert_eq!(unchanged["revision"], group["revision"]);
    assert_eq!(unchanged["device_ids"], group["device_ids"]);
    let desired: i64 = sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
        .bind(&ids[1])
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(desired, 0);
}

async fn set_device(state: &State, id: &str, mode: &str, version: &str) {
    sqlx::query("UPDATE devices SET data=json_set(data,'$.configuration_mode',?,'$.vector_version',?) WHERE id=?")
        .bind(mode).bind(version).bind(id).execute(&state.pool).await.unwrap();
}

async fn deployment_count(state: &State) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='deployment'")
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn direct_api_preview_and_create_block_mixed_incompatible_targets_without_writes() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    set_device(&state, &ids[2], "full", "0.57.0").await;
    let body = request(FULL_VERSION, &ids, "snapshot");
    let (status, preview) = call(
        &app,
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let blockers = preview["blockers"].as_array().unwrap();
    assert!(blockers.iter().any(|b| b["code"] == "FULL_VECTOR_MODE_REQUIRED" && b["device_ids"] == json!([ids[1]])), "{preview}");
    assert!(
        blockers
            .iter()
            .any(|b| b["code"] == "VECTOR_VERSION_INCOMPATIBLE"
                && b["device_ids"] == json!([ids[2]])),
        "{preview}"
    );
    let (status, rejected) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::CONFLICT, "{rejected}");
    assert_eq!(deployment_count(&state).await, 0);
    let desired: i64 = sqlx::query_scalar("SELECT sum(desired_generation) FROM devices")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(desired, 0);
}

#[tokio::test]
async fn preview_reports_both_version_and_mode_repairs_for_one_device() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    set_device(&state, &ids[1], "restricted", "0.57.0").await;
    let body = request(FULL_VERSION, &[ids[1].clone()], "snapshot");
    let (status, preview) = call(&app, "/api/v1/deployments/preview", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let blockers = preview["blockers"].as_array().unwrap();
    assert_eq!(blockers.len(), 2, "{preview}");
    for code in ["FULL_VECTOR_MODE_REQUIRED", "VECTOR_VERSION_INCOMPATIBLE"] {
        assert!(
            blockers
                .iter()
                .any(|blocker| blocker["code"] == code && blocker["device_ids"] == json!([ids[1]])),
            "{preview}"
        );
    }
}

#[tokio::test]
async fn preview_blocker_device_ids_are_stable_and_sorted_for_shared_failure() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    set_device(&state, &ids[0], "restricted", "0.58.0").await;
    set_device(&state, &ids[2], "restricted", "0.58.0").await;
    let body = request(
        FULL_VERSION,
        &[ids[2].clone(), ids[1].clone(), ids[0].clone()],
        "snapshot",
    );
    let (status, first) = call(
        &app,
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(first["blockers"].as_array().unwrap().len(), 1, "{first}");
    assert_eq!(first["blockers"][0]["code"], "FULL_VECTOR_MODE_REQUIRED");
    assert_eq!(first["blockers"][0]["device_ids"], json!(expected));
    let (status, second) = call(&app, "/api/v1/deployments/preview", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(first["blockers"], second["blockers"]);
}

#[tokio::test]
async fn creation_rechecks_mode_and_version_after_a_clean_preview() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    let body = request(FULL_VERSION, &[ids[0].clone()], "snapshot");
    let (status, preview) = call(
        &app,
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["blockers"], json!([]));
    set_device(&state, &ids[0], "restricted", "0.58.0").await;
    assert_eq!(
        call(&app, "/api/v1/deployments", body.clone(), &cookie, &csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    set_device(&state, &ids[0], "full", "0.57.0").await;
    assert_eq!(
        call(&app, "/api/v1/deployments", body, &cookie, &csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    set_device(&state, &ids[0], "full", "0.59.0").await;
    assert_eq!(
        call(
            &app,
            "/api/v1/deployments",
            request(FULL_VERSION, &[ids[0].clone()], "snapshot"),
            &cookie,
            &csrf,
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(deployment_count(&state).await, 0);
}

#[tokio::test]
async fn restricted_safe_configuration_can_be_admitted_on_restricted_device() {
    let (_temp, _state, app, ids, cookie, csrf) = fixture().await;
    let body = request(RESTRICTED_VERSION, &[ids[1].clone()], "snapshot");
    let (status, preview) = call(
        &app,
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["blockers"], json!([]));
    let (status, saved) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
}

#[tokio::test]
async fn scheduled_activation_rechecks_mode_before_admitting_any_target() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    let mut body = request(FULL_VERSION, &[ids[0].clone(), ids[2].clone()], "snapshot");
    body["scheduled_at"] = json!((Utc::now() + Duration::minutes(10)).to_rfc3339());
    let (status, saved) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let deployment_id = saved["id"].as_str().unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let mut deployment = db::record(&mut tx, "deployment", deployment_id)
        .await
        .unwrap();
    deployment["scheduled_at"] = json!((Utc::now() - Duration::seconds(1)).to_rfc3339());
    db::update(&mut tx, "deployment", &deployment)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    set_device(&state, &ids[2], "restricted", "0.58.0").await;
    rollout::tick(&state).await.unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let current = rollout::deployment(&mut tx, deployment_id).await.unwrap();
    assert_eq!(current["status"], "failed");
    assert!(
        current["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["device_id"] == ids[2] && target["state"] == "incompatible"),
        "{current}"
    );
    assert!(
        current["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["device_id"] == ids[0] && target["state"] == "blocked"),
        "{current}"
    );
    let desired: i64 = sqlx::query_scalar("SELECT sum(desired_generation) FROM devices")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(desired, 0);
}

#[tokio::test]
async fn later_canary_wave_rechecks_version_before_releasing_pending_target() {
    let (_temp, state, app, ids, cookie, csrf) = fixture().await;
    let mut body = request(FULL_VERSION, &[ids[0].clone(), ids[2].clone()], "snapshot");
    body["rollout"]["kind"] = json!("canary");
    body["rollout"]["batch_size"] = json!(1);
    let (status, saved) = call(&app, "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let deployment_id = saved["id"].as_str().unwrap();
    let released: String = sqlx::query_scalar(
        "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation>0",
    )
    .bind(deployment_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let pending: String = sqlx::query_scalar(
        "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation=0",
    )
    .bind(deployment_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let sha: String = sqlx::query_scalar(
        "SELECT json_extract(data,'$.sha256') FROM records WHERE kind='version' AND id=?",
    )
    .bind(FULL_VERSION)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=? AND device_id=?")
        .bind(deployment_id).bind(&released).execute(&state.pool).await.unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.reported_generation',desired_generation,'$.apply_state','verified_applied','$.actual_sha256',?) WHERE id=?")
        .bind(sha).bind(&released).execute(&state.pool).await.unwrap();
    set_device(&state, &pending, "full", "0.59.0").await;
    rollout::tick(&state).await.unwrap();
    rollout::tick(&state).await.unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let current = rollout::deployment(&mut tx, deployment_id).await.unwrap();
    assert_eq!(current["status"], "failed", "{current}");
    assert!(
        current["targets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|target| target["device_id"] == pending && target["state"] == "incompatible"),
        "{current}"
    );
    let pending_generation: i64 =
        sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
            .bind(&pending)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(pending_generation, 0);
}
