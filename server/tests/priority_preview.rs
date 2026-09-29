use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, initialize, rollout};

const VERSION_A: &str = "00000000-0000-4000-8000-000000000100";
const VERSION_B: &str = "00000000-0000-4000-8000-000000000101";

async fn fixture(count: usize) -> (tempfile::TempDir, State, Vec<String>) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-priority-preview-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Isolated priority preview".into(),
        validation_url: None,
    })
    .await
    .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for i in 0..count {
        let id = format!("00000000-0000-4000-8000-{i:012}");
        let name = format!("Synthetic preview device {i}");
        let data = json!({"id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&name)
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    for id in [VERSION_A, VERSION_B] {
        db::insert(&mut tx,"version",&json!({"id":id,"configuration_id":"00000000-0000-4000-8000-000000000200","number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    }
    tx.commit().await.unwrap();
    (temp, state, ids)
}
fn policy(ids: &[String], priority: i64, paused: bool) -> Value {
    json!({"policy":{"heartbeat_seconds":60,"sync_paused":paused,"telemetry_enabled":true},"selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}})
}
fn configuration(ids: &[String], priority: i64, version: &str) -> Value {
    let mut request = policy(ids, priority, false);
    request.as_object_mut().unwrap().remove("policy");
    request["version_id"] = json!(version);
    request
}
fn emit_fixture(name: &str, response: &Value) {
    if std::env::var_os("VECTORY_PREVIEW_FIXTURES").is_some() {
        // Only synthetic device/assignment data; never authentication responses.
        println!(
            "VECTORY_PREVIEW_FIXTURE {}",
            json!({"name":name,"response":response})
        );
    }
}
async fn snapshot(db: &mut SqliteConnection) -> Value {
    let records: Vec<(String, String, String)> =
        sqlx::query_as("SELECT kind,id,data FROM records ORDER BY kind,id")
            .fetch_all(&mut *db)
            .await
            .unwrap();
    let devices: Vec<String> = sqlx::query_scalar("SELECT json_object('id',id,'data',data,'assignment_id',assignment_id,'policy_assignment_id',policy_assignment_id,'desired_version_id',desired_version_id,'desired_generation',desired_generation,'policy',policy,'policy_generation',policy_generation) FROM devices ORDER BY id").fetch_all(&mut *db).await.unwrap();
    let targets: Vec<String> = sqlx::query_scalar("SELECT json_object('deployment_id',deployment_id,'device_id',device_id,'state',state,'generation',generation,'error',error,'original',original,'released_at',released_at,'verified_at',verified_at) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&mut *db).await.unwrap();
    json!({"records":records,"devices":devices,"targets":targets})
}

#[tokio::test]
async fn preview_policy_priorities_match_resolution_and_are_independent_of_configuration() {
    let (_temp, s, ids) = fixture(1).await;
    let mut tx = s.pool.begin().await.unwrap();
    let config = rollout::create(&mut tx, &configuration(&ids, 900, VERSION_A), "operator")
        .await
        .unwrap();
    let current = rollout::create(&mut tx, &policy(&ids, 200, false), "operator")
        .await
        .unwrap();
    let before = snapshot(&mut tx).await;
    let proposed = policy(&ids, 100, true);
    let preview = rollout::preview(&mut tx, &proposed).await.unwrap();
    emit_fixture(
        "higher_policy_priority_with_independent_configuration",
        &preview,
    );
    assert_eq!(
        snapshot(&mut tx).await,
        before,
        "Preview cannot write records, audits, targets or desired state"
    );
    let device = &preview["devices"][0];
    assert_eq!(device["assignment"]["id"], config["id"]);
    assert_eq!(device["assignment"]["priority"], 900);
    assert_eq!(device["policy_assignment"]["id"], current["id"]);
    assert_eq!(device["policy_assignment"]["priority"], 200);
    assert_eq!(preview["outcomes"][0]["resource"], "policy");
    assert_eq!(preview["outcomes"][0]["outcome"], "higher_priority");
    assert_eq!(preview["outcomes"][0]["assignment"]["id"], current["id"]);
    assert_eq!(preview["outcomes"][0]["assignment"]["priority"], 200);
    let generation: i64 = sqlx::query_scalar("SELECT policy_generation FROM devices")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    rollout::create(&mut tx, &proposed, "operator")
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut tx).await.unwrap()[0]["sync_paused"],
        false
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT policy_generation FROM devices")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        generation
    );

    // Lower configuration priority must not suppress a higher policy priority,
    // and a higher policy priority must not suppress a configuration request.
    let requested = policy(&ids, 1000, true);
    let preview = rollout::preview(&mut tx, &requested).await.unwrap();
    emit_fixture("requested_policy_has_higher_priority", &preview);
    assert_eq!(preview["outcomes"][0]["outcome"], "requested");
    let winning_policy = rollout::create(&mut tx, &requested, "operator")
        .await
        .unwrap();
    let requested_config = configuration(&ids, 950, VERSION_B);
    assert_eq!(
        rollout::preview(&mut tx, &requested_config).await.unwrap()["outcomes"][0]["outcome"],
        "requested"
    );
    rollout::create(&mut tx, &requested_config, "operator")
        .await
        .unwrap();
    let device = &rollout::devices(&mut tx).await.unwrap()[0];
    assert_eq!(device["desired_version_id"], VERSION_B);
    assert_eq!(device["sync_paused"], true);
    assert_eq!(device["policy_assignment"]["id"], winning_policy["id"]);
}

#[tokio::test]
async fn preview_equal_policy_payload_is_allowed_but_equal_different_payload_conflicts() {
    let (_temp, s, ids) = fixture(1).await;
    let mut tx = s.pool.begin().await.unwrap();
    // Device JSON cannot spoof server assignment metadata when no binding exists.
    sqlx::query("UPDATE devices SET data=json_set(data,'$.assignment',json('{\"id\":\"reported\",\"priority\":999}'),'$.policy_assignment',json('{\"id\":\"reported\",\"priority\":999}'))").execute(&mut *tx).await.unwrap();
    let requested = policy(&ids, 200, false);
    let first = rollout::preview(&mut tx, &requested).await.unwrap();
    emit_fixture("no_existing_policy_binding", &first);
    assert!(first["devices"][0].get("assignment").is_none());
    assert!(first["devices"][0].get("policy_assignment").is_none());
    assert_eq!(first["outcomes"][0]["outcome"], "requested");
    rollout::create(&mut tx, &requested, "operator")
        .await
        .unwrap();
    let before = snapshot(&mut tx).await;
    let same = rollout::preview(&mut tx, &requested).await.unwrap();
    emit_fixture("equal_priority_same_policy_payload", &same);
    assert_eq!(same["outcomes"][0]["outcome"], "requested");
    assert!(same["conflicts"].as_array().unwrap().is_empty());
    assert_eq!(snapshot(&mut tx).await, before);
    let different = policy(&ids, 200, true);
    let conflict = rollout::preview(&mut tx, &different).await.unwrap();
    emit_fixture("equal_priority_different_policy_payload", &conflict);
    assert_eq!(conflict["outcomes"][0]["outcome"], "conflict");
    assert_eq!(conflict["conflicts"][0]["resource"], "policy");
    assert!(
        rollout::create(&mut tx, &different, "operator")
            .await
            .is_err()
    );
    assert_eq!(snapshot(&mut tx).await, before);
    rollout::create(&mut tx, &requested, "operator")
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut tx).await.unwrap()[0]["sync_paused"],
        false
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT policy_generation FROM devices")
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn preview_reports_pending_canary_winner_instead_of_current_policy_binding() {
    let (_temp, s, ids) = fixture(2).await;
    let mut tx = s.pool.begin().await.unwrap();
    let baseline = rollout::create(&mut tx, &policy(&ids, 50, false), "operator")
        .await
        .unwrap();
    let mut canary = policy(&ids, 200, true);
    canary["rollout"]["kind"] = json!("canary");
    let canary = rollout::create(&mut tx, &canary, "operator").await.unwrap();
    assert_eq!(canary["targets"][1]["generation"], 0);
    let before = snapshot(&mut tx).await;
    let mut requested = policy(&ids, 100, false);
    requested["scheduled_at"] =
        json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let preview = rollout::preview(&mut tx, &requested).await.unwrap();
    emit_fixture("pending_canary_winner_current_binding_differs", &preview);
    assert_eq!(
        preview["devices"][1]["policy_assignment"]["id"],
        baseline["id"]
    );
    assert_eq!(preview["devices"][1]["policy_assignment"]["priority"], 50);
    assert_eq!(preview["devices"][1]["sync_paused"], false);
    for outcome in preview["outcomes"].as_array().unwrap() {
        assert_eq!(outcome["outcome"], "higher_priority");
        assert_eq!(outcome["assignment"]["id"], canary["id"]);
        assert_eq!(outcome["assignment"]["priority"], 200);
        assert!(
            outcome["assignment"]["reason"]
                .as_str()
                .unwrap()
                .contains("admission may still be pending")
        );
    }
    assert!(preview["warnings"].as_array().unwrap().iter().any(|w| {
        w.as_str()
            .unwrap()
            .contains("may change before scheduled activation")
    }));
    assert_eq!(snapshot(&mut tx).await, before);
    rollout::resolve(&mut tx).await.unwrap();
    assert_eq!(
        snapshot(&mut tx).await,
        before,
        "Sharing winner selection cannot bypass admission or alter existing resolution"
    );
}

#[tokio::test]
async fn preview_cancelled_or_failed_canary_retains_only_admitted_priority() {
    for status in ["cancelled", "failed"] {
        let (_temp, s, ids) = fixture(2).await;
        let mut tx = s.pool.begin().await.unwrap();
        rollout::create(&mut tx, &policy(&ids, 50, false), "operator")
            .await
            .unwrap();
        let mut request = policy(&ids, 200, true);
        request["rollout"]["kind"] = json!("canary");
        let canary = rollout::create(&mut tx, &request, "operator")
            .await
            .unwrap();
        let id = canary["id"].as_str().unwrap();
        if status == "cancelled" {
            rollout::action(&mut tx, id, "cancel", "operator")
                .await
                .unwrap();
        } else {
            // Model a persisted failed gate without changing its historical targets.
            let mut record = db::record(&mut tx, "deployment", id).await.unwrap();
            record["status"] = json!("failed");
            db::update(&mut tx, "deployment", &record).await.unwrap();
            rollout::resolve(&mut tx).await.unwrap();
        }
        let targets = rollout::targets(&mut tx, id).await.unwrap();
        assert!(targets[0]["generation"].as_i64().unwrap() > 0);
        assert_eq!(targets[1]["generation"], 0);
        let before = snapshot(&mut tx).await;
        let request = policy(&ids, 100, false);
        let preview = rollout::preview(&mut tx, &request).await.unwrap();
        emit_fixture(
            &format!("{status}_canary_retains_admitted_priority"),
            &preview,
        );
        assert_eq!(preview["outcomes"][0]["outcome"], "higher_priority");
        assert_eq!(preview["outcomes"][0]["assignment"]["id"], canary["id"]);
        assert_eq!(preview["outcomes"][1]["outcome"], "requested");
        assert_eq!(snapshot(&mut tx).await, before);
        let created = rollout::create(&mut tx, &request, "operator")
            .await
            .unwrap();
        let devices = rollout::devices(&mut tx).await.unwrap();
        assert_eq!(devices[0]["policy_assignment"]["id"], canary["id"]);
        assert_eq!(devices[0]["sync_paused"], true);
        assert_eq!(devices[1]["policy_assignment"]["id"], created["id"]);
        assert_eq!(devices[1]["sync_paused"], false);
    }
}

async fn call(
    app: Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    let response = app
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
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}

#[tokio::test]
async fn preview_http_exposes_policy_outcome_only_after_authentication_and_csrf() {
    let (_temp, s, ids) = fixture(1).await;
    let app = api::router(s.clone());
    let (status,session,cookie) = call(app.clone(),"POST","/api/v1/bootstrap",json!({"bootstrap_secret":"isolated-priority-preview-bootstrap-secret","email":"admin@example.test","name":"Synthetic administrator","password":"isolated-priority-test-password"}),"","").await;
    assert_eq!(status, StatusCode::OK);
    let csrf = session["csrf_token"].as_str().unwrap();
    let (status, existing, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments",
        policy(&ids, 200, false),
        &cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{existing}");
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/deployments/preview",
            policy(&ids, 100, true),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/deployments/preview",
            policy(&ids, 100, true),
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, preview, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments/preview",
        policy(&ids, 100, true),
        &cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    emit_fixture("authenticated_http_policy_preview", &preview);
    assert_eq!(preview["outcomes"][0]["assignment"]["id"], existing["id"]);
    assert_eq!(preview["outcomes"][0]["outcome"], "higher_priority");
    let (status, fleet, _) = call(app, "GET", "/api/v1/devices", Value::Null, &cookie, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fleet[0]["policy_assignment"]["id"], existing["id"]);
    assert!(fleet[0].get("assignment").is_none());
}
