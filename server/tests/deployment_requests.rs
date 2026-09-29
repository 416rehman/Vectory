use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, initialize};

const DEVICE: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_DEVICE: &str = "00000000-0000-4000-8000-000000000002";
const VERSION: &str = "00000000-0000-4000-8000-000000000101";
const VERSION_B: &str = "00000000-0000-4000-8000-00000000010b";
const KEY: &str = "a0000000-0000-4000-8000-000000000001";

#[tokio::test]
async fn request_history_discovers_committed_operation_after_lost_local_key() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let (status, created, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        request(Some(KEY), 100),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let before = snapshot(&s).await;
    let (status, history, _) = call(
        &s,
        "GET",
        "/api/v1/deployments/requests",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "A new tab must discover its account's committed operations without knowing the lost request key: {history}"
    );
    assert_eq!(history["total"], 1);
    assert_eq!(history["items"][0]["request_id"], KEY);
    assert_eq!(history["items"][0]["deployment_id"], created["id"]);
    assert_eq!(history["items"][0]["operation"], "create");
    assert_eq!(snapshot(&s).await, before);
    fixture("request_history_policy", &history);
}

async fn state() -> (tempfile::TempDir, State) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-deployment-request-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Isolated deployment requests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    for (index, id) in [DEVICE, OTHER_DEVICE].into_iter().enumerate() {
        let data = json!({"id":id,"name":format!("Synthetic device {index}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    db::insert(&mut tx,"version",&json!({"id":VERSION,"configuration_id":"00000000-0000-4000-8000-000000000201","number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    db::insert(&mut tx,"version",&json!({"id":VERSION_B,"configuration_id":"00000000-0000-4000-8000-000000000201","number":2,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    tx.commit().await.unwrap();
    (temp, s)
}
fn request(key: Option<&str>, priority: i64) -> Value {
    let mut value = json!({"policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true},"selector":{"device_ids":[DEVICE],"group_ids":[],"exclude_ids":[]},"expected_device_ids":[DEVICE],"priority":priority,"target_mode":"snapshot","scheduled_at":null,"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}});
    if let Some(key) = key {
        value["request_id"] = json!(key)
    }
    value
}
fn configuration(priority: i64, version: &str) -> Value {
    let mut value = request(None, priority);
    value.as_object_mut().unwrap().remove("policy");
    value["version_id"] = json!(version);
    value
}
async fn call(
    s: &State,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    call_raw(s, method, path, body.to_string(), cookie, csrf).await
}
async fn call_raw(
    s: &State,
    method: &str,
    path: &str,
    body: String,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    let response = api::router(s.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}
async fn admin(s: &State) -> (Value, String, String) {
    let (status,session,cookie)=call(s,"POST","/api/v1/bootstrap",json!({"bootstrap_secret":"isolated-deployment-request-bootstrap","email":"admin@example.test","name":"Synthetic admin","password":"isolated-long-admin-password"}),"","").await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let csrf = session["csrf_token"].as_str().unwrap().to_owned();
    (session["user"].clone(), cookie, csrf)
}
async fn user(
    s: &State,
    admin_cookie: &str,
    admin_csrf: &str,
    role: &str,
) -> (Value, String, String) {
    let email = format!("{role}@example.test");
    let (status, created, _) = call(
        s,
        "POST",
        "/api/v1/users",
        json!({"name":role,"email":email,"password":"isolated-user-password","role":role}),
        admin_cookie,
        admin_csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let (status, session, cookie) = call(
        s,
        "POST",
        "/api/v1/login",
        json!({"email":email,"password":"isolated-user-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    (
        session["user"].clone(),
        cookie,
        session["csrf_token"].as_str().unwrap().into(),
    )
}
async fn snapshot(s: &State) -> Value {
    let records: Vec<(String, String, String)> =
        sqlx::query_as("SELECT kind,id,data FROM records ORDER BY kind,id")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_object('id',id,'data',data,'revoked',revoked,'policy',policy,'policy_generation',policy_generation,'policy_assignment_id',policy_assignment_id,'desired_version_id',desired_version_id,'desired_generation',desired_generation,'assignment_id',assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let targets:Vec<(String,String,i64,String)>=sqlx::query_as("SELECT deployment_id,device_id,generation,state FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    let requests:Vec<(String,String,String,String,String,Option<String>)>=sqlx::query_as("SELECT actor_id,request_id,payload_sha256,deployment_id,operation_kind,source_deployment_id FROM deployment_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    json!({"records":records,"devices":devices,"targets":targets,"requests":requests})
}
fn fixture(name: &str, response: &Value) {
    if let Some(directory) = std::env::var_os("VECTORY_DEPLOYMENT_CORRELATION_FIXTURES") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{name}.json")),
            serde_json::to_vec_pretty(response).unwrap(),
        )
        .unwrap();
    }
    if std::env::var_os("VECTORY_REQUEST_FIXTURES").is_some() {
        println!(
            "VECTORY_REQUEST_FIXTURE {}",
            json!({"name":name,"response":response})
        );
    }
}
fn correlation(value: &Value, key: &str, operation: &str, source: Option<&str>) {
    assert_eq!(value["request_id"], key);
    assert_eq!(value["operation"], operation);
    assert_eq!(value["source_deployment_id"], json!(source));
    assert_eq!(value["request_correlation"], true);
}

#[tokio::test]
async fn receipts_bind_registry_identity_while_returning_current_result_without_persisting_metadata()
 {
    for operation in ["create", "rollback"] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        let (path, payload, source) = if operation == "create" {
            let mut payload = request(Some(KEY), 100);
            payload["target_mode"] = json!("persistent");
            ("/api/v1/deployments".to_owned(), payload, None)
        } else {
            assert_eq!(
                call(
                    &s,
                    "POST",
                    "/api/v1/deployments",
                    configuration(10, VERSION),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
            let (status, source, _) = call(
                &s,
                "POST",
                "/api/v1/deployments",
                configuration(20, VERSION_B),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let source = source["id"].as_str().unwrap().to_owned();
            (
                format!("/api/v1/deployments/{source}/rollback"),
                json!({"request_id":KEY}),
                Some(source),
            )
        };
        let (status, first, _) = call(&s, "POST", &path, payload.clone(), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        correlation(&first, KEY, operation, source.as_deref());
        let result_id = first["id"].as_str().unwrap();
        let stored: String =
            sqlx::query_scalar("SELECT data FROM records WHERE kind='deployment' AND id=?")
                .bind(result_id)
                .fetch_one(&s.pool)
                .await
                .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        for field in [
            "request_id",
            "operation",
            "source_deployment_id",
            "request_correlation",
        ] {
            assert!(
                stored.get(field).is_none(),
                "Response-only {field} was stored"
            );
        }
        for suffix in ["", "/summary"] {
            let (status, read, _) = call(
                &s,
                "GET",
                &format!("/api/v1/deployments/{result_id}{suffix}"),
                Value::Null,
                &cookie,
                "",
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(read["request_correlation"], true);
            assert!(read.get("request_id").is_none());
            fixture(
                &format!(
                    "{operation}_ordinary{}",
                    if suffix.is_empty() {
                        "_deployment"
                    } else {
                        "_summary"
                    }
                ),
                &read,
            );
        }
        let (_, preview, _) = call(
            &s,
            "POST",
            "/api/v1/deployments/preview",
            request(None, 200),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(preview["request_correlation"], true);
        fixture("correlation_preview", &preview);
        let (_, history, _) = call(
            &s,
            "GET",
            "/api/v1/deployments/history",
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert!(
            history["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row["request_correlation"] == true && row.get("request_id").is_none())
        );
        fixture(&format!("{operation}_ordinary_history"), &history);
        assert_eq!(
            call(
                &s,
                "POST",
                &format!("/api/v1/devices/{DEVICE}/revoke"),
                json!({}),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            call(
                &s,
                "POST",
                &format!("/api/v1/deployments/{result_id}/cancel"),
                json!({}),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::OK
        );
        let before = snapshot(&s).await;
        let (status, replay, _) = call(&s, "POST", &path, payload, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        correlation(&replay, KEY, operation, source.as_deref());
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["status"], "cancelled");
        if operation == "create" {
            assert_eq!(replay["targets"][0]["state"], "removed");
        }
        let (status, found, _) = call(
            &s,
            "GET",
            &format!("/api/v1/deployments/requests/{}", KEY.to_uppercase()),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            found,
            json!({"request_id":KEY,"found":true,"operation":operation,"source_deployment_id":source,"deployment":replay})
        );
        assert_eq!(snapshot(&s).await, before);
        fixture(&format!("{operation}_current_receipt"), &replay);
        fixture(&format!("{operation}_current_lookup"), &found);
    }
}

#[tokio::test]
async fn missing_mapped_results_return_conflict_without_releasing_identity() {
    for operation in ["create", "rollback"] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        let (path, payload) = if operation == "create" {
            ("/api/v1/deployments".to_owned(), request(Some(KEY), 100))
        } else {
            assert_eq!(
                call(
                    &s,
                    "POST",
                    "/api/v1/deployments",
                    configuration(10, VERSION),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
            let (_, source, _) = call(
                &s,
                "POST",
                "/api/v1/deployments",
                configuration(20, VERSION_B),
                &cookie,
                &csrf,
            )
            .await;
            (
                format!(
                    "/api/v1/deployments/{}/rollback",
                    source["id"].as_str().unwrap()
                ),
                json!({"request_id":KEY}),
            )
        };
        let (status, first, _) = call(&s, "POST", &path, payload.clone(), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK);
        // Ordinary deletion is FK-restricted. Model a damaged imported store
        // explicitly on this private connection, without freeing its mapping.
        let mut conn = s.pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys=OFF")
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM records WHERE kind='deployment' AND id=?")
            .bind(first["id"].as_str().unwrap())
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys=ON")
            .execute(&mut *conn)
            .await
            .unwrap();
        drop(conn);
        let before = snapshot(&s).await;
        for (method, route, body) in [
            (
                "GET",
                format!("/api/v1/deployments/requests/{KEY}"),
                Value::Null,
            ),
            ("POST", path, payload),
        ] {
            let (status, error, _) = call(&s, method, &route, body, &cookie, &csrf).await;
            assert_eq!(status, StatusCode::CONFLICT, "{error}");
            assert_eq!(error["error"]["code"], "CONFLICT");
            assert!(
                error["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("original deployment is unavailable")
            );
            assert_eq!(snapshot(&s).await, before);
            fixture(
                &format!("{operation}_missing_result_{}_error", method.to_lowercase()),
                &error,
            );
        }
    }
}

#[tokio::test]
async fn lost_response_canonical_retry_and_lookup_return_one_original_deployment() {
    let (_temp, s) = state().await;
    let (_actor, cookie, csrf) = admin(&s).await;
    let mut payload = request(Some(KEY), 100);
    payload["rollout"]["kind"] = json!("canary");
    // The handler commits successfully, but the client never consumes its body.
    let response = api::router(s.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/deployments")
                .header("content-type", "application/json")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    let before = snapshot(&s).await;
    let mut reordered = payload.clone();
    reordered["request_id"] = json!(KEY.to_uppercase());
    let pairs = reordered
        .as_object()
        .unwrap()
        .iter()
        .rev()
        .map(|(key, value)| format!("{}:{}", json!(key), value))
        .collect::<Vec<_>>();
    let (status, replayed, _) = call_raw(
        &s,
        "POST",
        "/api/v1/deployments",
        format!("{{{}}}", pairs.join(",")),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(
        snapshot(&s).await,
        before,
        "Replay must not mutate records, audit, targets, desired state or mapping"
    );
    correlation(&replayed, KEY, "create", None);
    fixture("create_replay_receipt", &replayed);
    let (status, found, _) = call(
        &s,
        "GET",
        &format!("/api/v1/deployments/requests/{KEY}"),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found["found"], true);
    assert_eq!(found["request_id"], KEY);
    assert_eq!(found["operation"], "create");
    assert_eq!(found["source_deployment_id"], Value::Null);
    assert_eq!(found["deployment"], replayed);
    assert_eq!(found["deployment"]["id"], replayed["id"]);
    assert_eq!(snapshot(&s).await, before, "Lookup is read only");
    fixture("request_lookup_found", &found);
    assert!(
        sqlx::query("DELETE FROM records WHERE kind='deployment' AND id=?")
            .bind(replayed["id"].as_str().unwrap())
            .execute(&s.pool)
            .await
            .is_err(),
        "A retained request must prevent deleting its result and silently freeing the operation identity"
    );
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records WHERE kind='deployment'")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.create'").fetch_one(&s.pool).await.unwrap(),1);
}

#[tokio::test]
async fn changed_payload_conflicts_without_effects_and_lookup_reports_current_original_state() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let mut payload = request(Some(KEY), 100);
    payload["selector"]["device_ids"] = json!([DEVICE, OTHER_DEVICE]);
    payload["expected_device_ids"] = json!([DEVICE, OTHER_DEVICE]);
    let (_, created, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        payload.clone(),
        &cookie,
        &csrf,
    )
    .await;
    let before = snapshot(&s).await;
    for change in [
        json!({"priority":101}),
        json!({"policy":{"heartbeat_seconds":61,"sync_paused":false,"telemetry_enabled":true}}),
        json!({"name":null}),
        json!({"expected_device_ids":[OTHER_DEVICE,DEVICE]}),
    ] {
        let mut changed = payload.clone();
        for (key, value) in change.as_object().unwrap() {
            changed[key] = value.clone();
        }
        let (status, error, _) =
            call(&s, "POST", "/api/v1/deployments", changed, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "IDEMPOTENCY_CONFLICT");
        assert_eq!(snapshot(&s).await, before);
    }
    let path = format!(
        "/api/v1/deployments/{}/cancel",
        created["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&s, "POST", &path, json!({}), &cookie, &csrf).await.0,
        StatusCode::OK
    );
    let before = snapshot(&s).await;
    let (status, replayed, _) =
        call(&s, "POST", "/api/v1/deployments", payload, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replayed["status"], "cancelled");
    assert_eq!(replayed["id"], created["id"]);
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn concurrent_retries_are_one_atomic_creation() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (s, cookie, csrf) = (s.clone(), cookie.clone(), csrf.clone());
        tasks.push(tokio::spawn(async move {
            call(
                &s,
                "POST",
                "/api/v1/deployments",
                request(Some(KEY), 100),
                &cookie,
                &csrf,
            )
            .await
        }));
    }
    let mut ids = std::collections::BTreeSet::new();
    for task in tasks {
        let (status, result, _) = task.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{result}");
        ids.insert(result["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids.len(), 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT policy_generation FROM devices WHERE id=?")
            .bind(DEVICE)
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.create'").fetch_one(&s.pool).await.unwrap(),1);
}

#[tokio::test]
async fn actor_scope_roles_csrf_and_live_access_are_checked_on_replay_and_lookup() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let (operator, other_cookie, other_csrf) = user(&s, &cookie, &csrf, "operator").await;
    let (_, created, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        request(Some(KEY), 100),
        &cookie,
        &csrf,
    )
    .await;
    let path = format!("/api/v1/deployments/requests/{KEY}");
    let (status, missing, _) = call(&s, "GET", &path, Value::Null, &other_cookie, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(missing, json!({"request_id":KEY,"found":false}));
    fixture("request_lookup_not_found", &missing);
    let (status, other, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        request(Some(KEY), 101),
        &other_cookie,
        &other_csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(other["id"], created["id"]);
    assert_eq!(
        call(&s, "GET", &path, Value::Null, "", "").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            request(Some(KEY), 101),
            &other_cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for role in ["viewer", "editor"] {
        let (_, c, token) = user(&s, &cookie, &csrf, role).await;
        assert_eq!(
            call(&s, "GET", &path, Value::Null, &c, "").await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/deployments",
                request(Some(KEY), 100),
                &c,
                &token
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    // Revoke access while a request waits for the writer after its first auth check.
    let guard = s.writer.lock().await;
    let task = {
        let (s, cookie, csrf) = (s.clone(), other_cookie.clone(), other_csrf.clone());
        tokio::spawn(async move {
            call(
                &s,
                "POST",
                "/api/v1/deployments",
                request(Some(KEY), 101),
                &cookie,
                &csrf,
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(operator["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(&s, "GET", &path, Value::Null, &other_cookie, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        2
    );
}

#[tokio::test]
async fn schedule_retry_survives_restart_past_activation_and_changed_devices() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let mut payload = request(Some(KEY), 100);
    payload["scheduled_at"] =
        json!((chrono::Utc::now() + chrono::Duration::seconds(2)).to_rfc3339());
    let (status, created, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        payload.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(DEVICE)
        .execute(&s.pool)
        .await
        .unwrap();
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    let s = initialize(settings).await.unwrap();
    let before = snapshot(&s).await;
    let (status, replayed, _) =
        call(&s, "POST", "/api/v1/deployments", payload, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["id"], created["id"]);
    assert_eq!(snapshot(&s).await, before);
    let (status, found, _) = call(
        &s,
        "GET",
        &format!("/api/v1/deployments/requests/{KEY}"),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found["deployment"]["id"], created["id"]);
}

#[tokio::test]
async fn late_audit_or_mapping_failure_rolls_back_creation_and_allows_same_key_retry() {
    for stage in ["audit", "mapping"] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        let trigger = if stage == "audit" {
            "CREATE TRIGGER fail_request BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.release' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END"
        } else {
            "CREATE TRIGGER fail_request BEFORE INSERT ON deployment_requests BEGIN SELECT RAISE(ABORT,'injected mapping failure'); END"
        };
        sqlx::query(trigger).execute(&s.pool).await.unwrap();
        let before = snapshot(&s).await;
        assert_eq!(
            call(
                &s,
                "POST",
                "/api/v1/deployments",
                request(Some(KEY), 100),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&s).await, before);
        sqlx::query("DROP TRIGGER fail_request")
            .execute(&s.pool)
            .await
            .unwrap();
        let (status, created, _) = call(
            &s,
            "POST",
            "/api/v1/deployments",
            request(Some(KEY), 100),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
                .fetch_one(&s.pool)
                .await
                .unwrap(),
            1
        );
    }
}

#[tokio::test]
async fn preview_canary_blockers_match_final_creation_and_resource_scope() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let candidate = request(Some(KEY), 1000);
    let (_, first, _) = call(
        &s,
        "POST",
        "/api/v1/deployments/preview",
        candidate.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(first["create_idempotency"], true);
    assert_eq!(first["blockers"], json!([]));
    let mut canary = request(None, 200);
    canary["rollout"]["kind"] = json!("canary");
    canary["selector"]["device_ids"] = json!([DEVICE, OTHER_DEVICE]);
    canary["expected_device_ids"] = json!([DEVICE, OTHER_DEVICE]);
    let (status, created, _) =
        call(&s, "POST", "/api/v1/deployments", canary, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let before = snapshot(&s).await;
    let (status, preview, _) = call(
        &s,
        "POST",
        "/api/v1/deployments/preview",
        candidate.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["outcomes"][0]["outcome"], "requested");
    assert_eq!(preview["conflicts"], json!([]));
    assert_eq!(preview["blockers"][0]["deployment_id"], created["id"]);
    assert_eq!(preview["blockers"][0]["device_ids"], json!([DEVICE]));
    assert_eq!(preview["blockers"][0]["resource"], "policy");
    assert_eq!(preview["blockers"][0]["code"], "ACTIVE_CANARY_OVERLAP");
    fixture("active_canary_preview_blocker", &preview);
    assert_eq!(snapshot(&s).await, before);
    // A create based on the earlier clear preview must recheck the new canary.
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            candidate.clone(),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
    let mut configuration = candidate.clone();
    configuration.as_object_mut().unwrap().remove("policy");
    configuration["version_id"] = json!(VERSION);
    let (_, preview, _) = call(
        &s,
        "POST",
        "/api/v1/deployments/preview",
        configuration,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(preview["blockers"], json!([]));
    let pause = format!(
        "/api/v1/deployments/{}/pause",
        created["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&s, "POST", &pause, json!({}), &cookie, &csrf).await.0,
        StatusCode::OK
    );
    let (_, preview, _) = call(
        &s,
        "POST",
        "/api/v1/deployments/preview",
        candidate.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(preview["blockers"], json!([]));
    assert_eq!(
        call(&s, "POST", "/api/v1/deployments", candidate, &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn legacy_creation_and_strict_request_lookup_inputs_remain_compatible() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let mut ids = std::collections::BTreeSet::new();
    for _ in 0..2 {
        let (status, created, _) = call(
            &s,
            "POST",
            "/api/v1/deployments",
            request(None, 100),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(created["request_correlation"], true);
        for field in ["request_id", "operation", "source_deployment_id"] {
            assert!(
                created.get(field).is_none(),
                "legacy response leaked {field}"
            );
        }
        ids.insert(created["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids.len(), 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
    let before = snapshot(&s).await;
    for value in [
        Value::Null,
        json!(1),
        json!("bad"),
        json!(KEY.replace('-', "")),
    ] {
        let mut payload = request(None, 100);
        payload["request_id"] = value;
        assert_eq!(
            call(&s, "POST", "/api/v1/deployments", payload, &cookie, &csrf)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    for suffix in [
        "?unknown=x",
        "?request_id=x&request_id=y",
        "?bad=%FF",
        "?bad=%",
        "?bad=%GG",
    ] {
        assert_eq!(
            call(
                &s,
                "GET",
                &format!("/api/v1/deployments/requests/{KEY}{suffix}"),
                Value::Null,
                &cookie,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests/not-a-uuid",
            Value::Null,
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn rollback_key_replay_returns_one_replacement() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            configuration(10, VERSION),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, original, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        configuration(20, VERSION_B),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let path = format!(
        "/api/v1/deployments/{}/rollback",
        original["id"].as_str().unwrap()
    );
    let body = json!({"request_id":KEY});
    let (status, first, _) = call(&s, "POST", &path, body.clone(), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    correlation(&first, KEY, "rollback", original["id"].as_str());
    fixture("rollback_create_receipt", &first);
    let before = snapshot(&s).await;
    let (status, replayed, _) = call(&s, "POST", &path, body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    correlation(&replayed, KEY, "rollback", original["id"].as_str());
    assert_eq!(
        replayed["id"], first["id"],
        "A matching rollback retry must return the exact original replacement"
    );
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn device_retry_rejects_a_superseded_review() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            configuration(10, VERSION),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','failed','$.reported_generation',1) WHERE id=?").bind(DEVICE).execute(&s.pool).await.unwrap();
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            configuration(20, VERSION_B),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = snapshot(&s).await;
    let (status, error, _) = call(
        &s,
        "POST",
        &format!("/api/v1/devices/{DEVICE}/retry"),
        json!({"expected_version_id":VERSION,"expected_generation":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "Superseded review must not advance a different version: {error}"
    );
    assert_eq!(error["error"]["code"], "STALE_DEVICE_REVIEW");
    assert_eq!(snapshot(&s).await, before);
}
async fn managed_pair(s: &State, cookie: &str, csrf: &str, priority: i64) -> Value {
    let (status, a, _) = call(
        s,
        "POST",
        "/api/v1/deployments",
        configuration(10, VERSION),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{a}");
    let (status, b, _) = call(
        s,
        "POST",
        "/api/v1/deployments",
        configuration(priority, VERSION_B),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{b}");
    b
}
async fn failure(s: &State, state: &str, reported: i64) {
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state',?,'$.reported_generation',?) WHERE id=?").bind(state).bind(reported).bind(DEVICE).execute(&s.pool).await.unwrap();
}
fn retry_body(generation: i64) -> Value {
    json!({"expected_version_id":VERSION_B,"expected_generation":generation})
}

#[tokio::test]
async fn rollback_concurrent_duplicates_and_restart_keep_exact_ceiling_result() {
    for priority in [20, 1_000_000] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        let original = managed_pair(&s, &cookie, &csrf, priority).await;
        let path = format!(
            "/api/v1/deployments/{}/rollback",
            original["id"].as_str().unwrap()
        );
        let mut tasks = Vec::new();
        for _ in 0..6 {
            let (s, c, t, p) = (s.clone(), cookie.clone(), csrf.clone(), path.clone());
            tasks.push(tokio::spawn(async move {
                call(&s, "POST", &p, json!({"request_id":KEY}), &c, &t).await
            }));
        }
        let mut ids = std::collections::BTreeSet::new();
        for task in tasks {
            let (status, result, _) = task.await.unwrap();
            assert_eq!(status, StatusCode::OK, "{result}");
            assert_eq!(result["rollback_idempotency"], true);
            ids.insert(result["id"].as_str().unwrap().to_owned());
        }
        assert_eq!(ids.len(), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records WHERE kind='deployment'")
                .fetch_one(&s.pool)
                .await
                .unwrap(),
            3
        );
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.rollback'").fetch_one(&s.pool).await.unwrap(),1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT desired_generation FROM devices WHERE id=?")
                .bind(DEVICE)
                .fetch_one(&s.pool)
                .await
                .unwrap(),
            3
        );
        let settings = s.settings.clone();
        s.pool.close().await;
        drop(s);
        let s = initialize(settings).await.unwrap();
        let before = snapshot(&s).await;
        let (status, result, _) =
            call(&s, "POST", &path, json!({"request_id":KEY}), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["id"], json!(ids.first().unwrap()));
        assert_eq!(snapshot(&s).await, before);
        let (_, found, _) = call(
            &s,
            "GET",
            &format!("/api/v1/deployments/requests/{KEY}"),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(found["deployment"]["id"], result["id"]);
        fixture("rollback_lookup", &found);
        let (_, summary, _) = call(
            &s,
            "GET",
            &format!(
                "/api/v1/deployments/{}/summary",
                original["id"].as_str().unwrap()
            ),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(summary["rollback_idempotency"], true);
        fixture("rollback_summary", &summary);
    }
}
#[tokio::test]
async fn rollback_keys_bind_operation_original_actor_and_legacy_create_hash() {
    let (_temp, s) = state().await;
    let (actor, cookie, csrf) = admin(&s).await;
    let original = managed_pair(&s, &cookie, &csrf, 20).await;
    let path = format!(
        "/api/v1/deployments/{}/rollback",
        original["id"].as_str().unwrap()
    );
    let (status, result, _) =
        call(&s, "POST", &path, json!({"request_id":KEY}), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK);
    let before = snapshot(&s).await;
    for (p, body) in [
        ("/api/v1/deployments".to_string(), request(Some(KEY), 100)),
        (
            format!(
                "/api/v1/deployments/{}/rollback",
                result["id"].as_str().unwrap()
            ),
            json!({"request_id":KEY}),
        ),
    ] {
        let (status, e, _) = call(&s, "POST", &p, body, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT, "{e}");
        assert_eq!(e["error"]["code"], "IDEMPOTENCY_CONFLICT");
        assert_eq!(snapshot(&s).await, before);
    }
    let key2 = "a0000000-0000-4000-8000-000000000002";
    let create = request(Some(key2), 100);
    let (status, _, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        create.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut canonical = create.clone();
    canonical.as_object_mut().unwrap().remove("request_id");
    let old_digest = db::hash(format!("vectory-deployment-create-v1\n{}", canonical));
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT payload_sha256 FROM deployment_requests WHERE actor_id=? AND request_id=?"
        )
        .bind(actor["id"].as_str().unwrap())
        .bind(key2)
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        old_digest
    );
    let before = snapshot(&s).await;
    let (status, e, _) = call(
        &s,
        "POST",
        &path,
        json!({"request_id":key2}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "IDEMPOTENCY_CONFLICT");
    assert_eq!(snapshot(&s).await, before);
    let (_, c, t) = user(&s, &cookie, &csrf, "operator").await;
    assert_eq!(
        call(
            &s,
            "GET",
            &format!("/api/v1/deployments/requests/{KEY}"),
            Value::Null,
            &c,
            ""
        )
        .await
        .1,
        json!({"request_id":KEY,"found":false})
    );
    let before = snapshot(&s).await;
    let (status, other, _) = call(&s, "POST", &path, json!({"request_id":KEY}), &c, &t).await;
    assert_eq!(status, StatusCode::CONFLICT, "{other}");
    assert_eq!(other["error"]["code"], "CONFLICT");
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn rollback_late_failures_are_atomic_and_legacy_body_is_supported() {
    for stage in ["audit", "mapping", "ceiling_conflict"] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        let original = managed_pair(
            &s,
            &cookie,
            &csrf,
            if stage == "ceiling_conflict" {
                1_000_000
            } else {
                20
            },
        )
        .await;
        if stage == "ceiling_conflict" {
            assert_eq!(
                call(
                    &s,
                    "POST",
                    "/api/v1/deployments",
                    configuration(1_000_000, VERSION_B),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
        } else {
            sqlx::query(if stage=="audit" {"CREATE TRIGGER fail_rollback BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.rollback' BEGIN SELECT RAISE(ABORT,'injected failure'); END"} else {"CREATE TRIGGER fail_rollback BEFORE INSERT ON deployment_requests BEGIN SELECT RAISE(ABORT,'injected failure'); END"}).execute(&s.pool).await.unwrap();
        }
        let path = format!(
            "/api/v1/deployments/{}/rollback",
            original["id"].as_str().unwrap()
        );
        let before = snapshot(&s).await;
        assert_eq!(
            call(&s, "POST", &path, json!({"request_id":KEY}), &cookie, &csrf)
                .await
                .0,
            if stage == "ceiling_conflict" {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        );
        assert_eq!(snapshot(&s).await, before);
        if stage != "ceiling_conflict" {
            sqlx::query("DROP TRIGGER fail_rollback")
                .execute(&s.pool)
                .await
                .unwrap();
            assert_eq!(
                call(&s, "POST", &path, json!({}), &cookie, &csrf).await.0,
                StatusCode::OK
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT count(*) FROM deployment_requests")
                    .fetch_one(&s.pool)
                    .await
                    .unwrap(),
                0
            );
        }
    }
}
#[tokio::test]
async fn rollback_replay_still_checks_roles_csrf_live_authorization_and_body() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let original = managed_pair(&s, &cookie, &csrf, 20).await;
    let path = format!(
        "/api/v1/deployments/{}/rollback",
        original["id"].as_str().unwrap()
    );
    let (operator, c, t) = user(&s, &cookie, &csrf, "operator").await;
    assert_eq!(
        call(&s, "POST", &path, json!({"request_id":KEY}), &c, &t)
            .await
            .0,
        StatusCode::OK
    );
    for (body, status) in [
        (Value::Null, StatusCode::BAD_REQUEST),
        (json!({"request_id":null}), StatusCode::BAD_REQUEST),
        (
            json!({"request_id":KEY,"priority":30}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(call(&s, "POST", &path, body, &c, &t).await.0, status);
    }
    assert_eq!(
        call(&s, "POST", &path, json!({"request_id":KEY}), &c, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for role in ["viewer", "editor"] {
        let (_, c, t) = user(&s, &cookie, &csrf, role).await;
        assert_eq!(
            call(&s, "POST", &path, json!({"request_id":KEY}), &c, &t)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let guard = s.writer.lock().await;
    let task = {
        let (s, c, t, p) = (s.clone(), c.clone(), t.clone(), path.clone());
        tokio::spawn(async move { call(&s, "POST", &p, json!({"request_id":KEY}), &c, &t).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(operator["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(
            &s,
            "GET",
            &format!("/api/v1/deployments/requests/{KEY}"),
            Value::Null,
            &c,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn retry_accepts_each_real_failure_with_older_verified_generation_once() {
    for failed in [
        "failed",
        "rolled_back",
        "verification_unknown",
        "incompatible",
        "drift",
        "drift_detected",
    ] {
        let (_temp, s) = state().await;
        let (_, cookie, csrf) = admin(&s).await;
        managed_pair(&s, &cookie, &csrf, 20).await;
        failure(&s, failed, 1).await;
        let path = format!("/api/v1/devices/{DEVICE}/retry");
        let mut review = retry_body(2);
        review["expected_version_id"] = json!(VERSION_B.to_uppercase());
        let (status, result, _) = call(&s, "POST", &path, review, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{failed}: {result}");
        assert_eq!(result["desired_generation"], 3);
        assert_eq!(result["reported_generation"], 1);
        assert_eq!(result["apply_state"], "desired");
        assert_eq!(result["retry_preconditions"], true);
        fixture("retry_result", &result);
        let before = snapshot(&s).await;
        let (status, e, _) = call(&s, "POST", &path, retry_body(2), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(e["error"]["code"], "STALE_DEVICE_REVIEW");
        assert_eq!(snapshot(&s).await, before);
        let (status, e, _) = call(&s, "POST", &path, retry_body(3), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(e["error"]["code"], "DEVICE_NOT_RETRYABLE");
        assert_eq!(snapshot(&s).await, before);
    }
}
#[tokio::test]
async fn retry_pause_health_and_strict_review_guards_do_not_consume_rate_limit() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    managed_pair(&s, &cookie, &csrf, 20).await;
    failure(&s, "failed", 1).await;
    let path = format!("/api/v1/devices/{DEVICE}/retry");
    for bad in [
        json!({}),
        json!({"expected_version_id":VERSION_B}),
        json!({"expected_version_id":VERSION_B,"expected_generation":0}),
        json!({"expected_version_id":VERSION_B,"expected_generation":9007199254740992u64}),
        json!({"expected_version_id":"version-b","expected_generation":2}),
        json!({"expected_version_id":VERSION_B,"expected_generation":2,"force":true}),
    ] {
        let before = snapshot(&s).await;
        assert_eq!(
            call(&s, "POST", &path, bad, &cookie, &csrf).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(snapshot(&s).await, before);
    }
    for (sql, code) in [
        (
            "UPDATE devices SET data=json_set(data,'$.local_paused',json('true')) WHERE id=?",
            "DEVICE_SYNC_PAUSED",
        ),
        (
            "UPDATE devices SET data=json_set(data,'$.local_paused',json('false')),policy=json_set(policy,'$.sync_paused',json('true')) WHERE id=?",
            "DEVICE_SYNC_PAUSED",
        ),
        (
            "UPDATE devices SET policy=json_set(policy,'$.sync_paused',json('false')),data=json_set(data,'$.apply_state','verified_applied') WHERE id=?",
            "DEVICE_NOT_RETRYABLE",
        ),
        (
            "UPDATE devices SET data=json_set(data,'$.apply_state','failed'),revoked=1 WHERE id=?",
            "DEVICE_NOT_RETRYABLE",
        ),
        (
            "UPDATE devices SET revoked=0,desired_generation=3 WHERE id=?",
            "STALE_DEVICE_REVIEW",
        ),
    ] {
        sqlx::query(sql)
            .bind(DEVICE)
            .execute(&s.pool)
            .await
            .unwrap();
        let before = snapshot(&s).await;
        let (status, e, _) = call(&s, "POST", &path, retry_body(2), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT, "{e}");
        assert_eq!(e["error"]["code"], code);
        assert_eq!(snapshot(&s).await, before);
    }
    // All rejected reviews leave the retry budget available.
    assert_eq!(
        call(&s, "POST", &path, retry_body(3), &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
    failure(&s, "failed", 1).await;
    assert_eq!(
        call(&s, "POST", &path, retry_body(4), &cookie, &csrf)
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}
#[tokio::test]
async fn concurrent_device_retries_advance_only_one_reviewed_generation() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    managed_pair(&s, &cookie, &csrf, 20).await;
    failure(&s, "rolled_back", 1).await;
    let mut tasks = Vec::new();
    for _ in 0..6 {
        let (s, c, t) = (s.clone(), cookie.clone(), csrf.clone());
        tasks.push(tokio::spawn(async move {
            call(
                &s,
                "POST",
                &format!("/api/v1/devices/{DEVICE}/retry"),
                retry_body(2),
                &c,
                &t,
            )
            .await
        }));
    }
    let (mut ok, mut stale) = (0, 0);
    for task in tasks {
        let (status, e, _) = task.await.unwrap();
        if status == StatusCode::OK {
            ok += 1;
        } else {
            assert_eq!(status, StatusCode::CONFLICT, "{e}");
            assert_eq!(e["error"]["code"], "STALE_DEVICE_REVIEW");
            stale += 1;
        }
    }
    assert_eq!((ok, stale), (1, 5));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.retry'").fetch_one(&s.pool).await.unwrap(),1);
}
#[tokio::test]
async fn retry_authentication_recheck_and_late_audit_failure_preserve_state() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    managed_pair(&s, &cookie, &csrf, 20).await;
    failure(&s, "failed", 1).await;
    let path = format!("/api/v1/devices/{DEVICE}/retry");
    for role in ["viewer", "editor"] {
        let (_, c, t) = user(&s, &cookie, &csrf, role).await;
        assert_eq!(
            call(&s, "POST", &path, retry_body(2), &c, &t).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(&s, "POST", &path, retry_body(2), &cookie, "").await.0,
        StatusCode::FORBIDDEN
    );
    for (change, expected_status) in [
        (
            "UPDATE users SET enabled=0 WHERE id=?",
            StatusCode::UNAUTHORIZED,
        ),
        (
            "UPDATE users SET role='viewer' WHERE id=?",
            StatusCode::FORBIDDEN,
        ),
        (
            "DELETE FROM sessions WHERE user_id=?",
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let (_temp, queued) = state().await;
        let (_, administrator, administrator_csrf) = admin(&queued).await;
        managed_pair(&queued, &administrator, &administrator_csrf, 20).await;
        failure(&queued, "failed", 1).await;
        let (operator, c, t) = user(&queued, &administrator, &administrator_csrf, "operator").await;
        let guard = queued.writer.lock().await;
        let task = {
            let (queued, p) = (queued.clone(), path.clone());
            tokio::spawn(async move { call(&queued, "POST", &p, retry_body(2), &c, &t).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // The fixture changes authority while the application writer is held.
        // Real account role changes also delete sessions; the role-only case
        // independently exercises the live role guard rather than that deletion.
        sqlx::query(change)
            .bind(operator["id"].as_str().unwrap())
            .execute(&queued.pool)
            .await
            .unwrap();
        let before = retry_authority_snapshot(&queued).await;
        drop(guard);
        let (status, error, _) = task.await.unwrap();
        assert_eq!(status, expected_status, "{change}: {error}");
        assert_eq!(retry_authority_snapshot(&queued).await, before, "{change}");
    }
    sqlx::query("CREATE TRIGGER fail_retry BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.retry' BEGIN SELECT RAISE(ABORT,'injected retry audit failure'); END").execute(&s.pool).await.unwrap();
    let before = snapshot(&s).await;
    assert_eq!(
        call(&s, "POST", &path, retry_body(2), &cookie, &csrf)
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&s).await, before);
}
async fn retry_authority_snapshot(s: &State) -> Value {
    let mut value = snapshot(s).await;
    // Include every target column, not just current generation/state, and the
    // authority rows so a denied retry cannot erase proof or mutate its session.
    for (name, query) in [
        (
            "complete_targets",
            "SELECT json_array(deployment_id,device_id,state,generation,previous_version_id,released_at,verified_at,error,original) FROM deployment_targets ORDER BY deployment_id,device_id",
        ),
        (
            "users",
            "SELECT json_array(id,email,name,role,password_hash,created_at,enabled,revision) FROM users ORDER BY id",
        ),
        (
            "sessions",
            "SELECT json_array(verifier,user_id,csrf,expires_at) FROM sessions ORDER BY verifier",
        ),
    ] {
        let rows: Vec<String> = sqlx::query_scalar(query).fetch_all(&s.pool).await.unwrap();
        value[name] = json!(rows);
    }
    value
}
#[tokio::test]
async fn retry_refuses_unmanaged_device_and_safe_integer_exhaustion() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let path = format!("/api/v1/devices/{DEVICE}/retry");
    let (status, e, _) = call(&s, "POST", &path, retry_body(1), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "DEVICE_NOT_RETRYABLE");
    managed_pair(&s, &cookie, &csrf, 20).await;
    failure(&s, "failed", 1).await;
    sqlx::query("UPDATE devices SET desired_generation=9007199254740991 WHERE id=?")
        .bind(DEVICE)
        .execute(&s.pool)
        .await
        .unwrap();
    let before = snapshot(&s).await;
    let (status, e, _) = call(
        &s,
        "POST",
        &path,
        retry_body(9007199254740991),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(e["error"]["code"], "DEVICE_NOT_RETRYABLE");
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn upgrading_existing_create_registry_preserves_key_and_digest() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    let payload = request(Some(KEY), 100);
    let (status, created, _) = call(
        &s,
        "POST",
        "/api/v1/deployments",
        payload.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let digest: String = sqlx::query_scalar("SELECT payload_sha256 FROM deployment_requests")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    // Reconstruct the exact pre-0015 table shape while retaining a real create mapping.
    sqlx::query("DROP TABLE access_edit_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE password_reset_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP INDEX password_reset_codes_issuer")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE password_reset_codes DROP COLUMN issuer_id")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE user_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE users DROP COLUMN mfa_epoch")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE device_recovery_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE token_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE policy_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE pipeline_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE publication_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE group_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP INDEX deployment_requests_recent")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP INDEX deployment_requests_operation_recent")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE deployment_requests DROP COLUMN source_deployment_id")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE deployment_requests DROP COLUMN operation_kind")
        .execute(&s.pool)
        .await
        .unwrap();
    // Reconstruct a pre-migration database, including the newer immutable
    // artifact tables introduced after the request-registry migration.
    for trigger in [
        "artifact_blobs_no_update",
        "artifact_blobs_no_delete",
        "desired_artifacts_no_update",
        "desired_artifacts_no_delete",
    ] {
        sqlx::query(&format!("DROP TRIGGER {trigger}"))
            .execute(&s.pool)
            .await
            .unwrap();
    }
    sqlx::query("DROP TABLE desired_artifacts")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DROP TABLE artifact_blobs")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE deployment_targets DROP COLUMN previous_artifact_sha256")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE deployment_targets DROP COLUMN previous_generation")
        .execute(&s.pool)
        .await
        .unwrap();
    // Rewind exactly the migrations reconstructed above; later, unrelated
    // migrations stay applied and must not run twice.
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version BETWEEN 15 AND 27")
        .execute(&s.pool)
        .await
        .unwrap();
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let mapping: (String, String, Option<String>) = sqlx::query_as(
        "SELECT payload_sha256,operation_kind,source_deployment_id FROM deployment_requests",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(mapping, (digest, "create".into(), None));
    let before = snapshot(&s).await;
    let (status, replayed, _) =
        call(&s, "POST", "/api/v1/deployments", payload, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{replayed}");
    assert_eq!(replayed["id"], created["id"]);
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn request_history_recovers_exact_rollback_across_sessions_and_restart() {
    let (_temp, s) = state().await;
    let (owner, cookie, csrf) = admin(&s).await;
    let mut c = s.pool.acquire().await.unwrap();
    db::insert(&mut c,"configuration",&json!({"id":"00000000-0000-4000-8000-000000000201","name":"Synthetic pipeline","config":{"private":"must not be exposed"},"created_at":db::now()})).await.unwrap();
    drop(c);
    let original = managed_pair(&s, &cookie, &csrf, 20).await;
    let (status, replacement, _) = call(
        &s,
        "POST",
        &format!(
            "/api/v1/deployments/{}/rollback",
            original["id"].as_str().unwrap()
        ),
        json!({"request_id":KEY}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replacement}");
    let (_, other_cookie, other_csrf) = user(&s, &cookie, &csrf, "operator").await;
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests",
            Value::Null,
            &other_cookie,
            ""
        )
        .await
        .1["total"],
        0
    );
    assert_eq!(
        call(
            &s,
            "POST",
            "/api/v1/deployments",
            request(Some(KEY), 100),
            &other_cookie,
            &other_csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    // Closing the old browser/session and losing the key does not lose registry discovery.
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(owner["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests",
            Value::Null,
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let (status, _, new_cookie) = call(
        &s,
        "POST",
        "/api/v1/login",
        json!({"email":"admin@example.test","password":"isolated-long-admin-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let before = snapshot(&s).await;
    let (status, page, _) = call(
        &s,
        "GET",
        "/api/v1/deployments/requests?operation=rollback",
        Value::Null,
        &new_cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1);
    let row = &page["items"][0];
    assert_eq!(row["deployment_id"], replacement["id"]);
    assert_eq!(row["source_deployment_id"], original["id"]);
    assert_eq!(row["operation"], "rollback");
    assert_eq!(row["configuration_name"], "Synthetic pipeline");
    assert_eq!(row["version_number"], 1);
    assert_eq!(row["resource"], "configuration");
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests?operation=create",
            Value::Null,
            &new_cookie,
            ""
        )
        .await
        .1["total"],
        0,
        "Legacy unkeyed creations are not invented as recoverable requests"
    );
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests",
            Value::Null,
            &other_cookie,
            ""
        )
        .await
        .1["items"][0]["operation"],
        "create"
    );
    assert_eq!(snapshot(&s).await, before);
    fixture("request_history_rollback", &page);
    let (_, history, _) = call(
        &s,
        "GET",
        "/api/v1/deployments/history?page_size=1",
        Value::Null,
        &new_cookie,
        "",
    )
    .await;
    assert_eq!(history["request_history"], true);
    fixture("request_history_capability", &history);
}

#[tokio::test]
async fn request_history_strict_queries_and_live_actor_authorization() {
    let (_temp, s) = state().await;
    let (_, cookie, csrf) = admin(&s).await;
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests?unknown=private",
            Value::Null,
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for role in ["viewer", "editor"] {
        let (_, c, _) = user(&s, &cookie, &csrf, role).await;
        assert_eq!(
            call(
                &s,
                "GET",
                "/api/v1/deployments/requests?unknown=private",
                Value::Null,
                &c,
                ""
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    for q in [
        "unknown=PRIVATE_QUERY",
        "actor_id=someone",
        "operation=pending",
        "operation=all&operation=create",
        "operation=%FF",
        "operation=%",
        "operation=%GG",
        "page=0",
        "page=-1",
        "page=1.5",
        "page=9007199254740992",
        "page=18446744073709551615",
        "page_size=0",
        "page_size=51",
        "page_size=12&page_size=12",
        "page=1&page=1",
    ] {
        let (status, error, _) = call(
            &s,
            "GET",
            &format!("/api/v1/deployments/requests?{q}"),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{q}: {error}");
        assert_eq!(error["error"]["code"], "INVALID_INPUT");
        assert!(!error.to_string().contains("PRIVATE_QUERY"));
    }
    let (status, empty, _) = call(
        &s,
        "GET",
        "/api/v1/deployments/requests?page=9007199254740991&page_size=1",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["items"], json!([]));
    let (operator, c, _) = user(&s, &cookie, &csrf, "operator").await;
    assert_eq!(
        call(
            &s,
            "GET",
            "/api/v1/deployments/requests",
            Value::Null,
            &c,
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    let guard = s.writer.lock().await;
    let task = {
        let (s, c) = (s.clone(), c.clone());
        tokio::spawn(async move {
            call(
                &s,
                "GET",
                "/api/v1/deployments/requests",
                Value::Null,
                &c,
                "",
            )
            .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(operator["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
}

async fn seed_history(
    s: &State,
    actor: &str,
    n: u64,
    operation: &str,
    extra: Value,
) -> (String, String) {
    let id = format!("d0000000-0000-4000-8000-{n:012x}");
    let key = format!("b0000000-0000-4000-8000-{n:012x}");
    let mut d = json!({"id":id,"name":format!("Synthetic {n}"),"status":"active","version_id":VERSION,"created_at":"2026-01-01T00:00:00Z"});
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    let mut tx = s.pool.begin().await.unwrap();
    db::insert(&mut tx, "deployment", &d).await.unwrap();
    sqlx::query("INSERT INTO deployment_requests(actor_id,request_id,payload_sha256,deployment_id,created_at,operation_kind,source_deployment_id) VALUES(?,?,?,?,?,?,?)")
        .bind(actor).bind(&key).bind(db::hash("private reviewed payload digest")).bind(&id).bind("2026-01-01T00:00:00Z").bind(operation)
        .bind(if operation=="rollback" {Some("00000000-0000-4000-8000-000000000777")}else{None}).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    (id, key)
}

#[tokio::test]
async fn request_history_pages_global_stable_results_without_private_bodies() {
    let (_temp, s) = state().await;
    let (owner, cookie, csrf) = admin(&s).await;
    let (other, _, _) = user(&s, &cookie, &csrf, "operator").await;
    for n in 0..144 {
        seed_history(&s,owner["id"].as_str().unwrap(),n,if n%2==0 {"create"}else{"rollback"},json!({"private_extension":"PRIVATE_BODY".repeat(3000),"selector":{"device_ids":vec![DEVICE;1000]},"targets":vec![json!({"private":"PRIVATE_TARGET"});100]})).await;
    }
    seed_history(&s, other["id"].as_str().unwrap(), 999, "create", json!({})).await;
    let before = snapshot(&s).await;
    for operation in ["all", "create", "rollback"] {
        let expected = (0..144)
            .rev()
            .filter(|n| {
                operation == "all"
                    || if operation == "create" {
                        n % 2 == 0
                    } else {
                        n % 2 == 1
                    }
            })
            .map(|n| format!("b0000000-0000-4000-8000-{n:012x}"))
            .collect::<Vec<_>>();
        let mut keys = Vec::new();
        for page in 1..=4 {
            let (status, rows, _) = call(
                &s,
                "GET",
                &format!(
                    "/api/v1/deployments/requests?operation={operation}&page={page}&page_size=50"
                ),
                Value::Null,
                &cookie,
                "",
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{rows}");
            assert_eq!(rows["total"], expected.len());
            assert_eq!(rows["page"], page);
            assert_eq!(rows["page_size"], 50);
            assert!(rows.to_string().len() < 40_000);
            assert!(!rows.to_string().contains("PRIVATE_"));
            for row in rows["items"].as_array().unwrap() {
                assert_eq!(
                    row.as_object().unwrap().len(),
                    11,
                    "Only allowlisted metadata is exposed: {row}"
                );
                keys.push(row["request_id"].as_str().unwrap().to_owned());
            }
        }
        assert_eq!(keys, expected);
    }
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn request_history_metadata_is_typed_bounded_and_parent_bound() {
    let (_temp, s) = state().await;
    let (owner, cookie, _) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    db::insert(&mut tx,"configuration",&json!({"id":"00000000-0000-4000-8000-000000000201","name":"🌐".repeat(241),"private":"PRIVATE_CONFIG","created_at":db::now()})).await.unwrap();
    for (n, number) in [
        json!(0),
        json!(9007199254740992u64),
        json!(2.5),
        json!({"private":"PRIVATE_VERSION"}),
        json!(9007199254740991u64),
    ]
    .into_iter()
    .enumerate()
    {
        db::insert(&mut tx,"version",&json!({"id":format!("f0000000-0000-4000-8000-{n:012x}"),"configuration_id":"00000000-0000-4000-8000-000000000201","number":number,"created_at":db::now()})).await.unwrap();
    }
    tx.commit().await.unwrap();
    seed_history(&s,owner["id"].as_str().unwrap(),1,"create",json!({"name":"🌐".repeat(121),"status":"s".repeat(65),"scheduled_at":"2030-01-01T00:00:00Z"})).await;
    seed_history(&s,owner["id"].as_str().unwrap(),2,"create",json!({"name":{"private":"PRIVATE_NAME"},"status":["PRIVATE_STATUS"],"scheduled_at":{"private":"PRIVATE_DATE"},"version_id":"missing"})).await;
    seed_history(&s,owner["id"].as_str().unwrap(),3,"create",json!({"policy":{"heartbeat_seconds":60},"version_id":VERSION,"scheduled_at":"invalid PRIVATE_DATE"})).await;
    for n in 0..5 {
        seed_history(&s,owner["id"].as_str().unwrap(),10+n,"create",json!({"version_id":format!("f0000000-0000-4000-8000-{n:012x}"),"scheduled_at":"PRIVATE_DATE".repeat(100)})).await;
    }
    let (status, page, _) = call(
        &s,
        "GET",
        "/api/v1/deployments/requests",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!page.to_string().contains("PRIVATE_"));
    let find = |n: u64| {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["request_id"] == format!("b0000000-0000-4000-8000-{n:012x}"))
            .unwrap()
    };
    assert_eq!(
        find(1)["deployment_name"].as_str().unwrap().chars().count(),
        120
    );
    assert_eq!(
        find(1)["configuration_name"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        240
    );
    assert_eq!(find(1)["deployment_status"].as_str().unwrap().len(), 64);
    assert_eq!(find(1)["scheduled_at"], "2030-01-01T00:00:00Z");
    for key in [
        "deployment_name",
        "deployment_status",
        "configuration_name",
        "version_number",
        "scheduled_at",
    ] {
        assert!(find(2)[key].is_null(), "{key}");
    }
    assert_eq!(find(3)["resource"], "policy");
    assert!(find(3)["configuration_name"].is_null());
    assert!(find(3)["version_number"].is_null());
    assert!(find(3)["scheduled_at"].is_null());
    for n in 10..14 {
        assert!(find(n)["version_number"].is_null());
    }
    assert_eq!(find(14)["version_number"], 9007199254740991u64);
    fixture("request_history_bounded_metadata", &page);
}
