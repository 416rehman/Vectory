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
        instance_name: "Assignment removal review tests".into(),
        validation_url: None,
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

async fn plan(app: &Router, d: &Value, cookie: &str, csrf: &str) -> Value {
    let (status, p) = call(
        app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/unassign-preview",
            d["id"].as_str().unwrap()
        ),
        json!({}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{p}");
    p
}
async fn remove(
    app: &Router,
    d: &Value,
    p: &Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/v1/deployments/{}/unassign", d["id"].as_str().unwrap()),
        json!({"review_token":p["review_token"]}),
        cookie,
        csrf,
    )
    .await
}
async fn basic(
    resource: &str,
) -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
    Value,
    Value,
) {
    let (t, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let old = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            resource,
            &a,
            120,
            10,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    let source = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            resource,
            &b,
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    (t, s, app, ids, cookie, csrf, source, old)
}

#[tokio::test]
async fn native_before_membership_and_fallback_races_are_rejected_without_effects() {
    for resource in ["configuration", "policy"] {
        let (_t, s, app, ids, cookie, csrf, _, old) = basic(resource).await;
        let (_, g) = call(
            &app,
            "POST",
            "/api/v1/groups",
            json!({"name":"Group","device_ids":ids[..1]}),
            &cookie,
            &csrf,
        )
        .await;
        let source = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                resource,
                old["version_id"].as_str().unwrap_or(""),
                240,
                200,
                "persistent",
                json!([g["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        let review = plan(&app, &source, &cookie, &csrf).await;
        assert_eq!(review["devices"].as_array().unwrap().len(), 1);
        let (status, _) = call(
            &app,
            "PUT",
            &format!("/api/v1/groups/{}", g["id"].as_str().unwrap()),
            json!({"name":"Group","device_ids":ids[..2],"revision":g["revision"]}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let before = state_snapshot(&s).await;
        let (status, error) = remove(&app, &source, &review, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT, "{error}");
        assert_eq!(error["error"]["code"], "ASSIGNMENT_REMOVAL_REVIEW_CHANGED");
        assert_eq!(state_snapshot(&s).await, before);
        let fresh = plan(&app, &source, &cookie, &csrf).await;
        assert_eq!(fresh["devices"].as_array().unwrap().len(), 2);
        // A metadata-only group revision does not change effective membership.
        let(status,_) = call(&app,"PUT",&format!("/api/v1/groups/{}",g["id"].as_str().unwrap()),json!({"name":"Renamed group","description":"Harmless metadata","device_ids":ids[..2],"revision":g["revision"].as_u64().unwrap()+1}),&cookie,&csrf).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            plan(&app, &source, &cookie, &csrf).await["review_token"],
            fresh["review_token"]
        );
        assert_eq!(
            remove(&app, &source, &fresh, &cookie, &csrf).await.0,
            StatusCode::OK
        );
        emit(&format!("{resource}_membership_preview"), &fresh);
        emit("stale_removal_error", &error);
    }
    let (_t, s, app, ids, cookie, csrf, source, old) = basic("configuration").await;
    let review = plan(&app, &source, &cookie, &csrf).await;
    let new = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            old["version_id"].as_str().unwrap(),
            120,
            50,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    let before = state_snapshot(&s).await;
    assert_eq!(
        remove(&app, &source, &review, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(state_snapshot(&s).await, before);
    let fresh = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(fresh["devices"][0]["after"]["assignment_id"], new["id"]);
}

#[tokio::test]
async fn preview_has_no_writes_and_names_telemetry_progress_do_not_invalidate() {
    let (_t, s, app, ids, cookie, csrf, source, old) = basic("configuration").await;
    let before = state_snapshot(&s).await;
    let review = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(state_snapshot(&s).await, before);
    assert_eq!(review["devices"][0]["effect"], "fallback");
    sqlx::query("UPDATE devices SET name='Renamed',data=json_set(data,'$.last_seen','2099-01-01T00:00:00Z','$.apply_state','verified_applied') WHERE id=?").bind(&ids[0]).execute(&s.pool).await.unwrap();
    sqlx::query(
        "UPDATE deployment_targets SET state='verified_applied',error=NULL WHERE deployment_id=?",
    )
    .bind(source["id"].as_str().unwrap())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE records SET data=json_set(data,'$.name','Renamed assignment') WHERE kind='deployment' AND id=?").bind(old["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
    let renamed = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(review["review_token"], renamed["review_token"]);
    assert_eq!(
        remove(&app, &source, &review, &cookie, &csrf).await.0,
        StatusCode::OK
    );
    let tables: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_temp_master WHERE name LIKE 'removal_%'")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(tables, 0);
}

#[tokio::test]
async fn defaults_and_shadowed_members_are_resource_specific() {
    for resource in ["configuration", "policy"] {
        let (_t, s, app, ids, cookie, csrf, source, old) = basic(resource).await;
        let old_plan = plan(&app, &old, &cookie, &csrf).await;
        assert!(
            old_plan["devices"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| d["effect"] == "unchanged")
        );
        assert_eq!(
            remove(&app, &old, &old_plan, &cookie, &csrf).await.0,
            StatusCode::OK
        );
        let review = plan(&app, &source, &cookie, &csrf).await;
        assert_eq!(
            review["devices"][0]["effect"],
            if resource == "configuration" {
                "unmanaged"
            } else {
                "default_policy"
            }
        );
        let prior_report: i64 = sqlx::query_scalar(
            "SELECT json_extract(data,'$.reported_generation') FROM devices WHERE id=?",
        )
        .bind(&ids[0])
        .fetch_one(&s.pool)
        .await
        .unwrap();
        let (status, result) = remove(&app, &source, &review, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["status"], "unassigned");
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT json_extract(data,'$.reported_generation') FROM devices WHERE id=?"
            )
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap(),
            prior_report
        );
        emit(&format!("{resource}_default_preview"), &review);
        emit(&format!("{resource}_removal_result"), &result);
    }
}

#[tokio::test]
async fn pending_highest_candidate_retains_actual_delivery_and_admission_changes_stale_review() {
    let (_t, s, app, ids, cookie, csrf, source, old) = basic("configuration").await;
    let next = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            old["version_id"].as_str().unwrap(),
            120,
            50,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    sqlx::query("UPDATE deployment_targets SET generation=0,state='pending' WHERE deployment_id=?")
        .bind(next["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let review = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(review["devices"][0]["effect"], "retained_pending");
    assert_eq!(review["devices"][0]["pending_assignment_id"], next["id"]);
    assert_eq!(
        review["devices"][0]["before"],
        review["devices"][0]["after"]
    );
    sqlx::query("UPDATE deployment_targets SET generation=1,state='desired' WHERE deployment_id=?")
        .bind(next["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let before = state_snapshot(&s).await;
    assert_eq!(
        remove(&app, &source, &review, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(state_snapshot(&s).await, before);
    emit("pending_fallback_preview", &review);
}

#[tokio::test]
async fn missing_revoked_removed_and_zero_target_history_are_explicit() {
    let (_t, s, app, ids, cookie, csrf, source, _) = basic("configuration").await;
    let revoked = ids[0].clone();
    let missing = ids[1].clone();
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&revoked)
        .execute(&s.pool)
        .await
        .unwrap();
    let mut connection = s.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(&missing)
        .execute(&mut *connection)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *connection)
        .await
        .unwrap();
    drop(connection);
    let review = plan(&app, &source, &cookie, &csrf).await;
    for d in review["devices"].as_array().unwrap() {
        assert_eq!(
            d["effect"],
            if d["device_id"] == revoked {
                "revoked"
            } else {
                "missing"
            }
        );
    }
    assert_eq!(
        remove(&app, &source, &review, &cookie, &csrf).await.0,
        StatusCode::OK
    );
    let empty = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "policy",
            "",
            180,
            200,
            "snapshot",
            json!([]),
            json!([ids[2]]),
            json!([]),
            false,
        ),
    )
    .await;
    sqlx::query("DELETE FROM deployment_targets WHERE deployment_id=?")
        .bind(empty["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET policy_assignment_id=NULL WHERE id=?")
        .bind(&ids[2])
        .execute(&s.pool)
        .await
        .unwrap();
    let p = plan(&app, &empty, &cookie, &csrf).await;
    assert_eq!(p["ready"], true);
    assert_eq!(p["devices"], json!([]));
    assert_eq!(
        remove(&app, &empty, &p, &cookie, &csrf).await.0,
        StatusCode::OK
    );
    emit("retired_removal_preview", &review);
    emit("empty_removal_preview", &p);
}

#[tokio::test]
async fn authentication_csrf_actor_binding_and_strict_required_token() {
    let (_t, s, app, _, cookie, csrf, source, _) = basic("configuration").await;
    let path = format!(
        "/api/v1/deployments/{}/unassign",
        source["id"].as_str().unwrap()
    );
    let review = plan(&app, &source, &cookie, &csrf).await;
    let before = state_snapshot(&s).await;
    for body in [
        json!({}),
        json!(null),
        json!({"review_token":null}),
        json!({"review_token":"F".repeat(64)}),
        json!({"review_token":review["review_token"],"device_ids":[]}),
    ] {
        assert_eq!(
            call(&app, "POST", &path, body, &cookie, &csrf).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &path,
            json!({"review_token":review["review_token"]}),
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(state_snapshot(&s).await, before);
    for role in ["viewer", "editor"] {
        let (_, c, k) = actor(&s, role).await;
        assert_eq!(
            remove(&app, &source, &review, &c, &k).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let (_, c, k) = actor(&s, "operator").await;
    assert_eq!(
        remove(&app, &source, &review, &c, &k).await.0,
        StatusCode::CONFLICT
    );
    let own = plan(&app, &source, &c, &k).await;
    assert_eq!(remove(&app, &source, &own, &c, &k).await.0, StatusCode::OK);
}

#[tokio::test]
async fn concurrent_confirmations_commit_once_and_late_audit_failure_is_atomic() {
    for inject in [false, true] {
        let (_t, s, app, _, cookie, csrf, source, _) = basic("configuration").await;
        let review = plan(&app, &source, &cookie, &csrf).await;
        let before = state_snapshot(&s).await;
        if inject {
            sqlx::query("CREATE TRIGGER fail_removal BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.unassign' BEGIN SELECT RAISE(ABORT,'injected failure'); END").execute(&s.pool).await.unwrap();
            assert_eq!(
                remove(&app, &source, &review, &cookie, &csrf).await.0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(state_snapshot(&s).await, before);
        } else {
            let (a, b) = tokio::join!(
                remove(&app, &source, &review, &cookie, &csrf),
                remove(&app, &source, &review, &cookie, &csrf)
            );
            assert!(
                (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
                    || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
            );
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.unassign'").fetch_one(&s.pool).await.unwrap(),1);
        }
    }
}

#[tokio::test]
async fn unrelated_resolver_collateral_blocks_instead_of_silently_changing_other_resource() {
    let (_t, s, app, ids, cookie, csrf, source, _) = basic("configuration").await;
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "policy",
            "",
            180,
            200,
            "snapshot",
            json!([]),
            json!([ids[2]]),
            json!([]),
            false,
        ),
    )
    .await;
    sqlx::query("UPDATE devices SET policy_assignment_id=NULL WHERE id=?")
        .bind(&ids[2])
        .execute(&s.pool)
        .await
        .unwrap();
    let before = state_snapshot(&s).await;
    let p = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(p["ready"], false);
    assert_eq!(p["blockers"][0]["code"], "UNRELATED_DELIVERY_CHANGE");
    assert_eq!(
        remove(&app, &source, &p, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(state_snapshot(&s).await, before);
    emit("collateral_blocked_preview", &p);
}

#[tokio::test]
async fn current_delivery_eligibility_source_status_and_priority_changes_require_fresh_review() {
    for change in ["generation", "revoked", "removed", "status", "priority"] {
        let (_t, s, app, ids, cookie, csrf, source, _) = basic("configuration").await;
        let review = plan(&app, &source, &cookie, &csrf).await;
        match change {
            "generation" => {
                sqlx::query(
                    "UPDATE devices SET desired_generation=desired_generation+1 WHERE id=?",
                )
                .bind(&ids[0])
                .execute(&s.pool)
                .await
                .unwrap();
            }
            "revoked" => {
                sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
                    .bind(&ids[0])
                    .execute(&s.pool)
                    .await
                    .unwrap();
            }
            "removed" => {
                sqlx::query("UPDATE deployment_targets SET state='removed' WHERE deployment_id=? AND device_id=?").bind(source["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
            "status" => {
                call(
                    &app,
                    "POST",
                    &format!(
                        "/api/v1/deployments/{}/pause",
                        source["id"].as_str().unwrap()
                    ),
                    json!({}),
                    &cookie,
                    &csrf,
                )
                .await;
            }
            _ => {
                sqlx::query("UPDATE records SET data=json_set(data,'$.priority',101) WHERE kind='deployment' AND id=?").bind(source["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
            }
        }
        let before = state_snapshot(&s).await;
        let (status, error) = remove(&app, &source, &review, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::CONFLICT, "{change}: {error}");
        assert_eq!(error["error"]["code"], "ASSIGNMENT_REMOVAL_REVIEW_CHANGED");
        assert_eq!(state_snapshot(&s).await, before);
    }
}

#[tokio::test]
async fn queued_account_offboarding_is_rechecked_inside_writer() {
    let (_t, s, app, _, _, _, source, _) = basic("configuration").await;
    let (id, cookie, csrf) = actor(&s, "operator").await;
    let review = plan(&app, &source, &cookie, &csrf).await;
    let before = state_snapshot(&s).await;
    let guard = s.writer.lock().await;
    let task = tokio::spawn(async move { remove(&app, &source, &review, &cookie, &csrf).await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(state_snapshot(&s).await, before);
}

#[tokio::test]
async fn duplicate_fields_unknown_queries_and_encoded_action_paths_cannot_bypass_review() {
    let (_t, s, app, _, cookie, csrf, source, _) = basic("configuration").await;
    let review = plan(&app, &source, &cookie, &csrf).await;
    let path = format!(
        "/api/v1/deployments/{}/unassign",
        source["id"].as_str().unwrap()
    );
    let before = state_snapshot(&s).await;
    let duplicate = format!(
        "{{\"review_token\":{},\"review_token\":{}}}",
        review["review_token"], review["review_token"]
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&path)
                .header("content-type", "application/json")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .body(Body::from(duplicate))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    for suffix in [
        "unassign?review_token=x",
        "unassign-preview?unused=1",
        "%75nassign",
    ] {
        let (status, _) = call(
            &app,
            "POST",
            &format!(
                "/api/v1/deployments/{}/{suffix}",
                source["id"].as_str().unwrap()
            ),
            json!({"review_token":review["review_token"]}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{suffix}");
    }
    assert_eq!(state_snapshot(&s).await, before);
}

#[tokio::test]
async fn unrelated_large_fleet_does_not_inflate_review_and_oversized_scope_is_explicit() {
    let (_t, s, app, _, cookie, csrf, source, _) = basic("configuration").await;
    sqlx::query("WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO devices(id,name,data) SELECT printf('00000000-0000-4000-8000-%012d',i),printf('Unrelated-%d',i),json_object('id',printf('00000000-0000-4000-8000-%012d',i)) FROM n").execute(&s.pool).await.unwrap();
    let p = plan(&app, &source, &cookie, &csrf).await;
    assert_eq!(p["devices"].as_array().unwrap().len(), 2);
    assert_eq!(p["ready"], true);
    sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id) SELECT ?,id FROM devices WHERE name LIKE 'Unrelated-%'").bind(source["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
    let before = state_snapshot(&s).await;
    let (status, error) = call(
        &app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/unassign-preview",
            source["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(state_snapshot(&s).await, before);
}
