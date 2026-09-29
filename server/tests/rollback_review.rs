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
        instance_name: "Rollback review tests".into(),
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

async fn scenario(
    ceiling: bool,
) -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
    Value,
    String,
) {
    let (temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            10,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            if ceiling { 1_000_000 } else { 20 },
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    (temp, s, app, ids, cookie, csrf, d, a)
}
fn preview_path(d: &Value) -> String {
    format!(
        "/api/v1/deployments/{}/rollback-preview",
        d["id"].as_str().unwrap()
    )
}
fn commit_path(d: &Value) -> String {
    format!("/api/v1/deployments/{}/rollback", d["id"].as_str().unwrap())
}
async fn review(app: &Router, d: &Value, cookie: &str) -> Value {
    let (status, plan) = call(app, "GET", &preview_path(d), Value::Null, cookie, "").await;
    assert_eq!(status, StatusCode::OK, "{plan}");
    plan
}
async fn mappings(s: &State) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM deployment_requests")
        .fetch_one(&s.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reviewed_rollback_explicitly_excludes_revoked_identity_and_preserves_history() {
    for ceiling in [false, true] {
        let (_temp, s, app, ids, cookie, csrf, d, a) = scenario(ceiling).await;
        call(
            &app,
            "POST",
            &format!("/api/v1/devices/{}/revoke", ids[0]),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        let before = state_snapshot(&s).await;
        let plan = review(&app, &d, &cookie).await;
        assert_eq!(state_snapshot(&s).await, before);
        assert_eq!(plan["ready"], true);
        assert_eq!(plan["previous_version_id"], a);
        assert_eq!(plan["eligible_devices"].as_array().unwrap().len(), 1);
        assert_eq!(plan["eligible_devices"][0]["device_id"], ids[1]);
        assert_eq!(plan["excluded_devices"][0]["device_id"], ids[0]);
        assert_eq!(plan["excluded_devices"][0]["reason"], "revoked");
        assert_eq!(
            plan["source_action"],
            if ceiling { "unassign" } else { "cancel" }
        );
        let legacy = call(
            &app,
            "POST",
            &commit_path(&d),
            json!({"request_id":db::id()}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(legacy.0, StatusCode::BAD_REQUEST);
        assert_eq!(state_snapshot(&s).await, before);
        let body = json!({"request_id":db::id(),"review_token":plan["review_token"]});
        let (status, replacement) =
            call(&app, "POST", &commit_path(&d), body.clone(), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{replacement}");
        assert_eq!(replacement["version_id"], a);
        assert_eq!(replacement["targets"].as_array().unwrap().len(), 1);
        assert_eq!(replacement["targets"][0]["device_id"], ids[1]);
        let original = call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}", d["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            "",
        )
        .await
        .1;
        assert_eq!(original["targets"], d["targets"]);
        assert_eq!(
            original["status"],
            if ceiling { "unassigned" } else { "cancelled" }
        );
        let after = state_snapshot(&s).await;
        assert_eq!(
            call(&app, "POST", &commit_path(&d), body, &cookie, &csrf)
                .await
                .1["id"],
            replacement["id"]
        );
        assert_eq!(state_snapshot(&s).await, after);
        assert_eq!(mappings(&s).await, 1);
        emit(
            if ceiling {
                "rollback_ceiling_preview"
            } else {
                "rollback_preview"
            },
            &plan,
        );
        emit("rollback_review_result", &replacement);
    }
}

#[tokio::test]
async fn review_token_binds_scope_prior_source_and_current_delivery_but_not_names() {
    for change in [
        "revoke",
        "generation",
        "assignment",
        "prior",
        "source_status",
        "source_priority",
        "admission",
        "removed",
    ] {
        let (_temp, s, app, ids, cookie, csrf, d, _) = scenario(false).await;
        let plan = review(&app, &d, &cookie).await;
        match change {
            "revoke" => {
                call(
                    &app,
                    "POST",
                    &format!("/api/v1/devices/{}/revoke", ids[0]),
                    json!({}),
                    &cookie,
                    &csrf,
                )
                .await;
            }
            "generation" => {
                sqlx::query(
                    "UPDATE devices SET desired_generation=desired_generation+1 WHERE id=?",
                )
                .bind(&ids[0])
                .execute(&s.pool)
                .await
                .unwrap();
            }
            "assignment" => {
                sqlx::query("UPDATE devices SET assignment_id=? WHERE id=?")
                    .bind(db::id())
                    .bind(&ids[0])
                    .execute(&s.pool)
                    .await
                    .unwrap();
            }
            "prior" => {
                sqlx::query("UPDATE deployment_targets SET previous_version_id=? WHERE deployment_id=? AND device_id=?").bind(d["version_id"].as_str().unwrap()).bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
            "admission" => {
                sqlx::query("UPDATE deployment_targets SET generation=generation+1 WHERE deployment_id=? AND device_id=?").bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
            "removed" => {
                sqlx::query("UPDATE deployment_targets SET state='removed' WHERE deployment_id=? AND device_id=?").bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
            _ => {
                let mut changed = d.clone();
                if change == "source_status" {
                    changed["status"] = json!("paused");
                } else {
                    changed["priority"] = json!(21);
                }
                let mut conn = s.pool.acquire().await.unwrap();
                db::update(&mut conn, "deployment", &changed).await.unwrap();
            }
        }
        let before = state_snapshot(&s).await;
        let (status, error) = call(
            &app,
            "POST",
            &commit_path(&d),
            json!({"request_id":db::id(),"review_token":plan["review_token"]}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{change}: {error}");
        assert_eq!(error["error"]["code"], "ROLLBACK_REVIEW_CHANGED");
        assert_eq!(state_snapshot(&s).await, before);
        assert_eq!(mappings(&s).await, 0);
    }
    let (_temp, s, app, ids, cookie, _, d, _) = scenario(false).await;
    let before = review(&app, &d, &cookie).await;
    sqlx::query("UPDATE devices SET name=? WHERE id=?")
        .bind("\u{1f600}".repeat(300))
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let after = review(&app, &d, &cookie).await;
    assert_eq!(before["review_token"], after["review_token"]);
    assert!(
        after["eligible_devices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d["device_name"].as_str().unwrap().chars().count() <= 240)
    );
}

#[tokio::test]
async fn blocked_reviews_never_choose_an_arbitrary_prior_subset_or_unsafe_ceiling_scope() {
    for change in [
        "no_live",
        "missing_prior",
        "mixed_prior",
        "missing_version",
        "unreleased_ceiling",
        "removed",
        "unreleased",
        "cancelled_unreleased",
        "failed_unreleased",
    ] {
        let (_temp, s, app, ids, cookie, csrf, d, _) =
            scenario(change == "unreleased_ceiling").await;
        match change {
            "no_live" => {
                for id in &ids[..2] {
                    call(
                        &app,
                        "POST",
                        &format!("/api/v1/devices/{id}/revoke"),
                        json!({}),
                        &cookie,
                        &csrf,
                    )
                    .await;
                }
            }
            "missing_prior" => {
                sqlx::query("UPDATE deployment_targets SET previous_version_id=NULL WHERE deployment_id=? AND device_id=?").bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
            "mixed_prior" | "missing_version" => {
                let prior = if change == "mixed_prior" {
                    d["version_id"].as_str().unwrap().to_owned()
                } else {
                    db::id()
                };
                sqlx::query(if change=="mixed_prior"{"UPDATE deployment_targets SET previous_version_id=? WHERE deployment_id=? AND device_id=?"}else{"UPDATE deployment_targets SET previous_version_id=? WHERE deployment_id=? AND device_id<>?"}).bind(prior).bind(d["id"].as_str().unwrap()).bind(if change=="mixed_prior"{ids[0].clone()}else{db::id()}).execute(&s.pool).await.unwrap();
            }
            _ => {
                sqlx::query("UPDATE deployment_targets SET state=?,generation=? WHERE deployment_id=? AND device_id=?").bind(if change=="removed"{"removed"}else{"pending"}).bind(if change=="removed"{2}else{0}).bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
            }
        }
        if change.ends_with("_unreleased") {
            let mut stopped = d.clone();
            stopped["status"] = json!(if change.starts_with("cancelled") {
                "cancelled"
            } else {
                "failed"
            });
            let mut conn = s.pool.acquire().await.unwrap();
            db::update(&mut conn, "deployment", &stopped).await.unwrap();
        }
        let before = state_snapshot(&s).await;
        let plan = review(&app, &d, &cookie).await;
        let allowed = change == "removed" || change.ends_with("_unreleased");
        assert_eq!(plan["ready"], allowed, "{change}: {plan}");
        assert_eq!(state_snapshot(&s).await, before);
        if !allowed {
            let (status, _) = call(
                &app,
                "POST",
                &commit_path(&d),
                json!({"request_id":db::id(),"review_token":plan["review_token"]}),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(state_snapshot(&s).await, before);
        } else {
            assert_eq!(plan["eligible_devices"].as_array().unwrap().len(), 1);
        }
        emit(&format!("rollback_{change}_preview"), &plan);
    }
}

#[tokio::test]
async fn reviewed_rollback_concurrency_and_late_faults_are_atomic() {
    let (_temp, s, app, _, cookie, csrf, d, _) = scenario(false).await;
    let plan = review(&app, &d, &cookie).await;
    let body = json!({"request_id":db::id(),"review_token":plan["review_token"]});
    let path = commit_path(&d);
    let (a, b) = tokio::join!(
        call(&app, "POST", &path, body.clone(), &cookie, &csrf),
        call(&app, "POST", &path, body.clone(), &cookie, &csrf)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1["id"], b.1["id"]);
    assert_eq!(mappings(&s).await, 1);
    let mut other = body;
    other["review_token"] = json!("0".repeat(64));
    assert_eq!(
        call(&app, "POST", &path, other, &cookie, &csrf).await.1["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
    for fault in ["audit", "mapping"] {
        let (_temp, s, app, _, cookie, csrf, d, _) = scenario(false).await;
        let plan = review(&app, &d, &cookie).await;
        let before = state_snapshot(&s).await;
        sqlx::query(if fault=="audit"{"CREATE TRIGGER reject_rollback BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.rollback' BEGIN SELECT RAISE(ABORT,'fault'); END"}else{"CREATE TRIGGER reject_rollback BEFORE INSERT ON deployment_requests BEGIN SELECT RAISE(ABORT,'fault'); END"}).execute(&s.pool).await.unwrap();
        let body = json!({"request_id":db::id(),"review_token":plan["review_token"]});
        let (status, _) = call(&app, "POST", &commit_path(&d), body.clone(), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(state_snapshot(&s).await, before);
        assert_eq!(mappings(&s).await, 0);
        sqlx::query("DROP TRIGGER reject_rollback")
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "POST", &commit_path(&d), body, &cookie, &csrf)
                .await
                .0,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn review_uses_actual_priority_and_canary_selection_and_rechecks_late_blockers() {
    for case in [
        "higher",
        "equal_same",
        "equal_different",
        "lower",
        "policy",
        "canary",
        "paused_unadmitted",
    ] {
        let (_temp, s, app, ids, cookie, csrf, d, a) = scenario(false).await;
        let old = review(&app, &d, &cookie).await;
        let priority = match case {
            "equal_same" | "equal_different" => 21,
            "lower" => 19,
            _ => 1000,
        };
        let competitor = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                if case == "policy" {
                    "policy"
                } else {
                    "configuration"
                },
                if case == "equal_same" {
                    &a
                } else {
                    d["version_id"].as_str().unwrap()
                },
                180,
                priority,
                "snapshot",
                json!([]),
                json!([ids[0]]),
                json!([]),
                case == "canary",
            ),
        )
        .await;
        if case == "paused_unadmitted" {
            let mut paused = competitor.clone();
            paused["status"] = json!("paused");
            let mut conn = s.pool.acquire().await.unwrap();
            db::update(&mut conn, "deployment", &paused).await.unwrap();
            sqlx::query(
                "UPDATE deployment_targets SET generation=0,state='pending' WHERE deployment_id=?",
            )
            .bind(competitor["id"].as_str().unwrap())
            .execute(&mut *conn)
            .await
            .unwrap();
        }
        let plan = review(&app, &d, &cookie).await;
        let allowed = case == "lower" || case == "policy";
        assert_eq!(plan["ready"], allowed, "{case}: {plan}");
        if !allowed {
            let expected = match case {
                "equal_same" => "ASSIGNMENT_PRECEDENCE",
                "equal_different" => "ASSIGNMENT_CONFLICT",
                "canary" => "ACTIVE_CANARY_OVERLAP",
                _ => "HIGHER_PRIORITY_ASSIGNMENT",
            };
            assert!(
                plan["blockers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|b| b["code"] == expected),
                "{case}: {plan}"
            );
            let before = state_snapshot(&s).await;
            let status = call(
                &app,
                "POST",
                &commit_path(&d),
                json!({"request_id":db::id(),"review_token":old["review_token"]}),
                &cookie,
                &csrf,
            )
            .await
            .0;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(state_snapshot(&s).await, before);
            assert_eq!(mappings(&s).await, 0);
        }
        emit(&format!("rollback_{case}_preview"), &plan);
    }
}

#[tokio::test]
async fn review_and_commit_require_current_authority_and_strict_inputs() {
    let (_temp, s, app, _, cookie, csrf, d, _) = scenario(false).await;
    let plan = review(&app, &d, &cookie).await;
    let body = json!({"request_id":db::id(),"review_token":plan["review_token"]});
    for role in ["viewer", "editor", "operator"] {
        let (_, other, token) = actor(&s, role).await;
        assert_eq!(
            call(&app, "GET", &preview_path(&d), Value::Null, &other, "")
                .await
                .0,
            if role == "operator" {
                StatusCode::OK
            } else {
                StatusCode::FORBIDDEN
            }
        );
        if role != "operator" {
            assert_eq!(
                call(&app, "POST", &commit_path(&d), body.clone(), &other, &token)
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
    }
    assert_eq!(
        call(&app, "GET", &preview_path(&d), Value::Null, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "POST", &commit_path(&d), body.clone(), &cookie, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for suffix in ["?limit=1", "?x=1&x=2", "?%zz=x", "?x=%ff"] {
        assert_eq!(
            call(
                &app,
                "GET",
                &(preview_path(&d) + suffix),
                Value::Null,
                &cookie,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for invalid in [
        json!({"review_token":null}),
        json!({"review_token":"F".repeat(64)}),
        json!({"review_token":"abc"}),
        json!({"review_token":plan["review_token"],"device_ids":[]}),
        json!([]),
    ] {
        assert_eq!(
            call(&app, "POST", &commit_path(&d), invalid, &cookie, &csrf)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (who, other, token) = actor(&s, "operator").await;
    let guard = s.writer.lock().await;
    let app2 = app.clone();
    let path = commit_path(&d);
    let request =
        tokio::spawn(async move { call(&app2, "POST", &path, body, &other, &token).await });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(who)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(request.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(mappings(&s).await, 0);
}

#[tokio::test]
async fn missing_identity_and_complete_scope_limit_are_explicit() {
    let (_temp, s, app, ids, cookie, _, d, _) = scenario(false).await;
    let mut conn = s.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(&ids[0])
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let plan = review(&app, &d, &cookie).await;
    assert_eq!(plan["ready"], true);
    assert_eq!(plan["excluded_devices"][0]["reason"], "missing");
    assert!(plan["excluded_devices"][0]["device_name"].is_null());
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..10000u128 {
        let id = uuid::Uuid::from_u128(n + 100).to_string();
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,'{}')")
            .bind(&id)
            .bind(format!("Bound fixture {n}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO deployment_targets(deployment_id,device_id,state) VALUES(?,?,'pending')",
        )
        .bind(d["id"].as_str().unwrap())
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
    let (status, error) = call(&app, "GET", &preview_path(&d), Value::Null, &cookie, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("10000")
    );
}

#[tokio::test]
async fn replay_precedes_new_scope_guards_but_remains_actor_bound() {
    let (_temp, s, app, ids, cookie, csrf, d, _) = scenario(false).await;
    let plan = review(&app, &d, &cookie).await;
    let key = db::id();
    let body = json!({"request_id":key,"review_token":plan["review_token"]});
    let result = call(&app, "POST", &commit_path(&d), body.clone(), &cookie, &csrf).await;
    assert_eq!(result.0, StatusCode::OK);
    for id in ids {
        call(
            &app,
            "POST",
            &format!("/api/v1/devices/{id}/revoke"),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
    }
    let before = state_snapshot(&s).await;
    assert_eq!(
        call(&app, "POST", &commit_path(&d), body.clone(), &cookie, &csrf)
            .await
            .1["id"],
        result.1["id"]
    );
    assert_eq!(state_snapshot(&s).await, before);
    let (_, other, other_csrf) = actor(&s, "operator").await;
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/deployments/requests/{key}"),
            Value::Null,
            &other,
            ""
        )
        .await
        .1["found"],
        false
    );
    assert_eq!(
        call(&app, "POST", &commit_path(&d), body, &other, &other_csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(mappings(&s).await, 1);
}

#[tokio::test]
async fn cancelling_source_cannot_deliver_an_unreviewed_fallback_to_excluded_identity() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let (a, b) = seed_versions(&s).await;
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
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
            "configuration",
            &b,
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    let action = |name: &str| {
        format!(
            "/api/v1/deployments/{}/{name}",
            source["id"].as_str().unwrap()
        )
    };
    assert_eq!(
        call(&app, "POST", &action("pause"), json!({}), &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
    let fallback = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            50,
            "snapshot",
            json!([]),
            json!([ids[1]]),
            json!([]),
            false,
        ),
    )
    .await;
    assert_eq!(
        call(&app, "POST", &action("resume"), json!({}), &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
    let current: Option<String> =
        sqlx::query_scalar("SELECT desired_version_id FROM devices WHERE id=?")
            .bind(&ids[1])
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(current.as_deref(), Some(a.as_str()));
    let plan = review(&app, &source, &cookie).await;
    assert_eq!(plan["eligible_devices"][0]["device_id"], ids[0]);
    assert_eq!(plan["excluded_devices"][0]["device_id"], ids[1]);
    let before = state_snapshot(&s).await;
    let result = call(
        &app,
        "POST",
        &commit_path(&source),
        json!({"request_id":db::id(),"review_token":plan["review_token"]}),
        &cookie,
        &csrf,
    )
    .await;
    let after: Option<String> =
        sqlx::query_scalar("SELECT desired_version_id FROM devices WHERE id=?")
            .bind(&ids[1])
            .fetch_one(&s.pool)
            .await
            .unwrap();
    emit(
        "rollback_unreleased_cancel_collateral",
        &json!({"preview":plan,"commit_status":result.0.as_u16(),"excluded_desired_before":current,"excluded_desired_after":after,"fallback_id":fallback["id"],"no_state_changes":state_snapshot(&s).await==before}),
    );
    assert_eq!(
        plan["ready"], false,
        "A rollback must not change delivery on an excluded live identity"
    );
    assert!(
        plan["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["code"] == "UNSAFE_SOURCE_REMOVAL")
    );
    assert_eq!(result.0, StatusCode::CONFLICT);
    assert_eq!(state_snapshot(&s).await, before);
}

/// A named pipeline with published versions whose content differs, so reviews
/// name what each device runs.
async fn seed_pipeline(s: &State, name: &str, numbers: &[i64]) -> Vec<String> {
    let configuration = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn,"configuration",&json!({"id":configuration,"name":name,"description":"","revision":1,"archived":false,"archived_at":null,"config":{},"graph":{"nodes":[],"edges":[]},"created_at":db::now(),"updated_at":db::now()})).await.unwrap();
    let mut versions = Vec::new();
    let slug: String = name.chars().filter(char::is_ascii_alphanumeric).collect();
    for number in numbers {
        let id = db::id();
        // Restricted-mode content that differs per pipeline and version.
        let artifact = format!("{{\"data_dir\":\"/var/lib/vector/{slug}-{number}\"}}\n");
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":configuration,"number":number,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
        versions.push(id);
    }
    versions
}
async fn desired(s: &State, device: &str) -> (Option<String>, i64, Option<String>) {
    sqlx::query_as(
        "SELECT desired_version_id,desired_generation,assignment_id FROM devices WHERE id=?",
    )
    .bind(device)
    .fetch_one(&s.pool)
    .await
    .unwrap()
}
async fn device_name(s: &State, device: &str) -> String {
    sqlx::query_scalar("SELECT name FROM devices WHERE id=?")
        .bind(device)
        .fetch_one(&s.pool)
        .await
        .unwrap()
}
async fn get_deployment(app: &Router, cookie: &str, d: &Value) -> Value {
    call(
        app,
        "GET",
        &format!("/api/v1/deployments/{}", d["id"].as_str().unwrap()),
        Value::Null,
        cookie,
        "",
    )
    .await
    .1
}
/// Three devices run "Edge syslog processing" v1 at priority 100; a canary of
/// "r15-demo" v1 released its first device, which verified, and the gate
/// observes. `replaces` makes it replace the running assignment at the same
/// priority (what the dashboard does by default); without it the canary is
/// layered above at `priority`.
struct LiveCanary {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    ids: Vec<String>,
    cookie: String,
    csrf: String,
    base: Value,
    canary: Value,
    edge: Vec<String>,
}
async fn live_canary(priority: i64, replaces: bool) -> LiveCanary {
    let (temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let edge = seed_pipeline(&s, "Edge syslog processing", &[1]).await;
    let demo = seed_pipeline(&s, "r15-demo", &[1]).await;
    let base = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &edge[0],
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids),
            json!([]),
            false,
        ),
    )
    .await;
    let mut request = binding(
        "configuration",
        &demo[0],
        180,
        priority,
        "snapshot",
        json!([]),
        json!(ids),
        json!([]),
        true,
    );
    if replaces {
        request["replaces"] = json!([base["id"]]);
    }
    let canary = create_binding(&app, &cookie, &csrf, request).await;
    let released: Vec<String> = sqlx::query_scalar(
        "SELECT device_id FROM deployment_targets WHERE deployment_id=? AND generation>0",
    )
    .bind(canary["id"].as_str().unwrap())
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        released,
        vec![ids[0].clone()],
        "the canary released one device"
    );
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND generation>0")
        .bind(db::now())
        .bind(canary["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    let mut observing = db::record(&mut conn, "deployment", canary["id"].as_str().unwrap())
        .await
        .unwrap();
    observing["observation_started_at"] = json!(db::now());
    db::update(&mut conn, "deployment", &observing)
        .await
        .unwrap();
    drop(conn);
    assert_eq!(
        desired(&s, &ids[0]).await.0.as_deref(),
        Some(demo[0].as_str())
    );
    for id in &ids[1..] {
        assert_eq!(desired(&s, id).await.0.as_deref(), Some(edge[0].as_str()));
    }
    LiveCanary {
        _temp: temp,
        s,
        app,
        ids,
        cookie,
        csrf,
        base,
        canary,
        edge,
    }
}

/// Round-2 operator review P0-1: Roll back is the safety valve while a canary
/// is watched. Devices it never released keep exactly what they run, so the
/// review includes them as unchanged and one confirmation stops the rollout
/// and returns the released device to its previous version.
#[tokio::test]
async fn a_live_or_paused_canary_rolls_back_in_one_reviewed_step() {
    for (case, priority, replaces) in [
        ("observing", 100, true),
        ("paused", 100, true),
        ("layered", 110, false),
    ] {
        let c = live_canary(priority, replaces).await;
        if case == "paused" {
            let (status, paused) = call(
                &c.app,
                "POST",
                &format!(
                    "/api/v1/deployments/{}/pause",
                    c.canary["id"].as_str().unwrap()
                ),
                json!({}),
                &c.cookie,
                &c.csrf,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{paused}");
        }
        let untouched = [
            desired(&c.s, &c.ids[1]).await,
            desired(&c.s, &c.ids[2]).await,
        ];
        let before = state_snapshot(&c.s).await;
        let plan = review(&c.app, &c.canary, &c.cookie).await;
        assert_eq!(
            state_snapshot(&c.s).await,
            before,
            "{case}: review writes nothing"
        );
        assert_eq!(plan["ready"], true, "{case}: {plan}");
        assert_eq!(plan["blockers"], json!([]), "{case}");
        assert_eq!(plan["source_action"], "cancel");
        assert_eq!(plan["previous_version_id"], c.edge[0]);
        assert_eq!(
            plan["previous_configuration_name"],
            "Edge syslog processing"
        );
        assert_eq!(plan["eligible_devices"].as_array().unwrap().len(), 1);
        assert_eq!(plan["eligible_devices"][0]["device_id"], c.ids[0]);
        let excluded = plan["excluded_devices"].as_array().unwrap();
        assert_eq!(excluded.len(), 2, "{case}");
        for (device, id) in excluded.iter().zip(&c.ids[1..]) {
            assert_eq!(device["device_id"], *id);
            assert_eq!(device["reason"], "not_released");
            assert_eq!(device["effect"], "unchanged", "{case}: {device}");
            assert_eq!(
                device["current"],
                json!({"configuration_name":"Edge syslog processing","version_number":1})
            );
            assert!(device["next"].is_null());
        }
        let (status, rollback) = call(
            &c.app,
            "POST",
            &commit_path(&c.canary),
            json!({"request_id":db::id(),"review_token":plan["review_token"]}),
            &c.cookie,
            &c.csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{case}: {rollback}");
        assert_eq!(rollback["version_id"], c.edge[0]);
        assert_eq!(rollback["priority"], priority + 1);
        assert_eq!(rollback["rollback_of"], c.canary["id"]);
        assert_eq!(rollback["targets"].as_array().unwrap().len(), 1);
        assert_eq!(rollback["targets"][0]["device_id"], c.ids[0]);
        let source = get_deployment(&c.app, &c.cookie, &c.canary).await;
        assert_eq!(
            source["status"], "cancelled",
            "{case}: the rollout stops here"
        );
        assert_eq!(
            source["status_before_rollback"],
            if case == "paused" { "paused" } else { "active" }
        );
        assert!(source["cancelled_at"].is_string(), "{case}: {source}");
        assert_eq!(source["rolled_back_by"], rollback["id"]);
        let released = desired(&c.s, &c.ids[0]).await;
        assert_eq!(released.0.as_deref(), Some(c.edge[0].as_str()));
        assert_eq!(released.2.as_deref(), rollback["id"].as_str());
        // A scheduler pass releases nothing more: the others keep what they ran.
        vectory_server::rollout::tick(&c.s).await.unwrap();
        assert_eq!(
            [
                desired(&c.s, &c.ids[1]).await,
                desired(&c.s, &c.ids[2]).await
            ],
            untouched,
            "{case}"
        );
        let targets: Vec<(String, i64)> = sqlx::query_as(
            "SELECT device_id,generation FROM deployment_targets WHERE deployment_id=? ORDER BY device_id",
        )
        .bind(c.canary["id"].as_str().unwrap())
        .fetch_all(&c.s.pool)
        .await
        .unwrap();
        assert_eq!(
            targets.iter().filter(|(_, g)| *g > 0).count(),
            1,
            "{case}: {targets:?}"
        );
        assert_eq!(untouched[0].2.as_deref(), c.base["id"].as_str());
        assert_eq!(mappings(&c.s).await, 1);
    }
}

/// The same confirmation is one transaction: a late failure leaves the canary
/// running and every device where it was.
#[tokio::test]
async fn a_live_canary_rollback_that_fails_late_changes_nothing() {
    let c = live_canary(100, true).await;
    let plan = review(&c.app, &c.canary, &c.cookie).await;
    assert_eq!(plan["ready"], true, "{plan}");
    let before = state_snapshot(&c.s).await;
    sqlx::query("CREATE TRIGGER reject_rollback BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.rollback' BEGIN SELECT RAISE(ABORT,'fault'); END").execute(&c.s.pool).await.unwrap();
    let body = json!({"request_id":db::id(),"review_token":plan["review_token"]});
    let (status, _) = call(
        &c.app,
        "POST",
        &commit_path(&c.canary),
        body.clone(),
        &c.cookie,
        &c.csrf,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(state_snapshot(&c.s).await, before);
    assert_eq!(
        get_deployment(&c.app, &c.cookie, &c.canary).await["status"],
        "active"
    );
    sqlx::query("DROP TRIGGER reject_rollback")
        .execute(&c.s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &c.app,
            "POST",
            &commit_path(&c.canary),
            body,
            &c.cookie,
            &c.csrf
        )
        .await
        .0,
        StatusCode::OK
    );
}

/// A completed all-at-once rollout rolls back every device it released.
#[tokio::test]
async fn a_completed_rollout_rolls_back_every_released_device() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let edge = seed_pipeline(&s, "Edge syslog processing", &[1]).await;
    let demo = seed_pipeline(&s, "r15-demo", &[1]).await;
    let base = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &edge[0],
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids),
            json!([]),
            false,
        ),
    )
    .await;
    let mut request = binding(
        "configuration",
        &demo[0],
        180,
        100,
        "snapshot",
        json!([]),
        json!(ids),
        json!([]),
        false,
    );
    request["replaces"] = json!([base["id"]]);
    let rollout = create_binding(&app, &cookie, &csrf, request).await;
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=?")
        .bind(db::now())
        .bind(rollout["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    vectory_server::rollout::tick(&s).await.unwrap();
    assert_eq!(
        get_deployment(&app, &cookie, &rollout).await["status"],
        "completed"
    );
    let plan = review(&app, &rollout, &cookie).await;
    assert_eq!(plan["ready"], true, "{plan}");
    assert_eq!(plan["excluded_devices"], json!([]));
    assert_eq!(plan["eligible_devices"].as_array().unwrap().len(), 3);
    let (status, rollback) = call(
        &app,
        "POST",
        &commit_path(&rollout),
        json!({"request_id":db::id(),"review_token":plan["review_token"]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    assert_eq!(rollback["targets"].as_array().unwrap().len(), 3);
    let source = get_deployment(&app, &cookie, &rollout).await;
    assert_eq!(source["status"], "cancelled");
    assert_eq!(source["status_before_rollback"], "completed");
    assert!(
        source["cancelled_at"].is_null(),
        "a finished rollout had nothing left to cancel"
    );
    for id in &ids {
        assert_eq!(desired(&s, id).await.0.as_deref(), Some(edge[0].as_str()));
    }
}

/// Only a device that would switch to something nobody reviewed blocks the
/// rollback, and the review names that device and what it would switch to. A
/// device another rollout is still waiting to release keeps what it runs now.
#[tokio::test]
async fn an_excluded_device_that_would_switch_artifacts_blocks_and_is_named() {
    for case in ["switches", "waits"] {
        let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
        ids.sort();
        let edge = seed_pipeline(&s, "Edge syslog processing", &[1]).await;
        let demo = seed_pipeline(&s, "r15-demo", &[1]).await;
        let web = seed_pipeline(&s, "Web access logs", &[1, 2]).await;
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &edge[0],
                180,
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
                "configuration",
                &demo[0],
                180,
                100,
                "snapshot",
                json!([]),
                json!(ids[..2]),
                json!([]),
                true,
            ),
        )
        .await;
        let action = |name: &str| {
            format!(
                "/api/v1/deployments/{}/{name}",
                source["id"].as_str().unwrap()
            )
        };
        assert_eq!(
            call(&app, "POST", &action("pause"), json!({}), &cookie, &csrf)
                .await
                .0,
            StatusCode::OK
        );
        // Created while the canary was paused; its priority is below the
        // canary's, so it doesn't take the unreleased device yet.
        let other = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &web[1],
                180,
                50,
                "snapshot",
                json!([]),
                json!([ids[1]]),
                json!([]),
                false,
            ),
        )
        .await;
        if case == "waits" {
            // Its rollout hasn't reached the device yet.
            sqlx::query("UPDATE deployment_targets SET generation=0,state='pending',released_at=NULL WHERE deployment_id=?")
                .bind(other["id"].as_str().unwrap())
                .execute(&s.pool)
                .await
                .unwrap();
            let mut conn = s.pool.acquire().await.unwrap();
            let mut paused = db::record(&mut conn, "deployment", other["id"].as_str().unwrap())
                .await
                .unwrap();
            paused["status"] = json!("paused");
            db::update(&mut conn, "deployment", &paused).await.unwrap();
        }
        assert_eq!(
            desired(&s, &ids[1]).await.0.as_deref(),
            Some(edge[0].as_str())
        );
        let plan = review(&app, &source, &cookie).await;
        let excluded = &plan["excluded_devices"][0];
        assert_eq!(excluded["device_id"], ids[1]);
        assert_eq!(
            excluded["current"],
            json!({"configuration_name":"Edge syslog processing","version_number":1})
        );
        assert_eq!(
            excluded["next"],
            json!({"configuration_name":"Web access logs","version_number":2})
        );
        if case == "waits" {
            // The review binds what that device runs after the stop: if the
            // waiting rollout reaches it before confirmation, it's stale.
            let admit = |generation: i64| {
                sqlx::query("UPDATE deployment_targets SET generation=? WHERE deployment_id=?")
                    .bind(generation)
                    .bind(other["id"].as_str().unwrap().to_owned())
            };
            admit(1).execute(&s.pool).await.unwrap();
            let stale = state_snapshot(&s).await;
            let (status, error) = call(
                &app,
                "POST",
                &commit_path(&source),
                json!({"request_id":db::id(),"review_token":plan["review_token"]}),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT, "{error}");
            assert_eq!(error["error"]["code"], "ROLLBACK_REVIEW_CHANGED");
            assert_eq!(state_snapshot(&s).await, stale);
            admit(0).execute(&s.pool).await.unwrap();
        }
        let before = state_snapshot(&s).await;
        let result = call(
            &app,
            "POST",
            &commit_path(&source),
            json!({"request_id":db::id(),"review_token":plan["review_token"]}),
            &cookie,
            &csrf,
        )
        .await;
        if case == "switches" {
            assert_eq!(excluded["effect"], "fallback", "{plan}");
            assert_eq!(plan["ready"], false);
            let blocker = &plan["blockers"][0];
            assert_eq!(blocker["code"], "UNSAFE_SOURCE_REMOVAL");
            let reason = blocker["reason"].as_str().unwrap();
            assert!(
                reason.contains(&device_name(&s, &ids[1]).await),
                "names the device: {reason}"
            );
            assert!(
                reason.contains("Web access logs v2"),
                "names the artifact: {reason}"
            );
            assert_eq!(result.0, StatusCode::CONFLICT);
            assert_eq!(state_snapshot(&s).await, before);
        } else {
            assert_eq!(excluded["effect"], "retained_pending", "{plan}");
            assert_eq!(plan["ready"], true, "{plan}");
            assert_eq!(result.0, StatusCode::OK, "{}", result.1);
            assert_eq!(
                desired(&s, &ids[1]).await.0.as_deref(),
                Some(edge[0].as_str())
            );
        }
    }
}

async fn preview_deployment(app: &Router, cookie: &str, csrf: &str, request: &Value) -> Value {
    let (status, preview) = call(
        app,
        "POST",
        "/api/v1/deployments/preview",
        request.clone(),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    preview
}
fn ids_of(entries: &Value) -> Vec<String> {
    let mut ids: Vec<String> = entries
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["assignment"]["id"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

/// Round-2 operator review P1-3: after rolling a canary back and publishing a
/// fix, redeploying takes one review round and changes every device. The
/// preview suggests replacing the pipeline's own rolled-back rollout and its
/// rollback, at the rollback's priority, as the deploy dialog adopts it.
#[tokio::test]
async fn redeploying_a_fix_after_a_rollback_takes_one_round_and_reaches_every_device() {
    let c = live_canary(100, true).await;
    let plan = review(&c.app, &c.canary, &c.cookie).await;
    let (status, rollback) = call(
        &c.app,
        "POST",
        &commit_path(&c.canary),
        json!({"request_id":db::id(),"review_token":plan["review_token"]}),
        &c.cookie,
        &c.csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    // Publish the fix: version 2 of the rolled-back pipeline.
    let pipeline: String = sqlx::query_scalar(
        "SELECT json_extract(data,'$.configuration_id') FROM records WHERE kind='version' AND id=?",
    )
    .bind(c.canary["version_id"].as_str().unwrap())
    .fetch_one(&c.s.pool)
    .await
    .unwrap();
    let fix = db::id();
    let artifact = "{\"data_dir\":\"/var/lib/vector/r15demo-2\"}\n";
    let mut conn = c.s.pool.acquire().await.unwrap();
    db::insert(&mut conn,"version",&json!({"id":fix,"configuration_id":pipeline,"number":2,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    drop(conn);
    let mut request = binding(
        "configuration",
        &fix,
        180,
        100,
        "snapshot",
        json!([]),
        json!(c.ids),
        json!([]),
        false,
    );
    let first = preview_deployment(&c.app, &c.cookie, &c.csrf, &request).await;
    // The rolled-back canary and its rollback both still bind the canary
    // device; the device the pipeline replaced keeps its own assignment.
    let mut lineage = vec![
        c.canary["id"].as_str().unwrap().to_owned(),
        rollback["id"].as_str().unwrap().to_owned(),
    ];
    lineage.sort();
    assert_eq!(ids_of(&first["suggested_replaces"]), lineage, "{first}");
    assert_eq!(first["suggested_priority"], 101);
    let rollback_suggestion = first["suggested_replaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["assignment"]["id"] == rollback["id"])
        .unwrap();
    assert_eq!(
        rollback_suggestion["assignment"]["rollback_of"],
        c.canary["id"]
    );
    assert_eq!(
        rollback_suggestion["assignment"]["configuration_name"],
        "Edge syslog processing"
    );
    assert_eq!(rollback_suggestion["device_ids"], json!([c.ids[0]]));
    // The canary device's winner is the rollback, not the cancelled rollout.
    let canary_outcome = first["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["device_id"] == c.ids[0])
        .unwrap();
    assert_eq!(canary_outcome["winner"]["id"], rollback["id"]);
    // What the deploy dialog does with a suggestion: adopt it and its priority.
    request["replaces"] = json!(lineage);
    request["priority"] = first["suggested_priority"].clone();
    let second = preview_deployment(&c.app, &c.cookie, &c.csrf, &request).await;
    assert_eq!(second["conflicts"], json!([]), "{second}");
    assert_eq!(second["replacements_needed"], json!([]));
    assert_eq!(second["blockers"], json!([]));
    for outcome in second["outcomes"].as_array().unwrap() {
        assert!(
            matches!(outcome["outcome"].as_str(), Some("replace" | "requested")),
            "every device takes the fix: {outcome}"
        );
    }
    request["expected_device_ids"] = json!(c.ids);
    let created = create_binding(&c.app, &c.cookie, &c.csrf, request).await;
    for id in &c.ids {
        let (version, _, assignment) = desired(&c.s, id).await;
        assert_eq!(version.as_deref(), Some(fix.as_str()), "{id}");
        assert_eq!(assignment.as_deref(), created["id"].as_str());
    }
    // The fix's lineage tells the rollback it replaced apart from the rollout
    // that rollback stopped, though both read "… v1".
    let (status, summary) = call(
        &c.app,
        "GET",
        &format!(
            "/api/v1/deployments/{}/summary",
            created["id"].as_str().unwrap()
        ),
        Value::Null,
        &c.cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    let mut replaces: Vec<(String, bool, String)> = summary["replaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["deployment_id"].as_str().unwrap().to_owned(),
                entry["rollback"].as_bool().unwrap(),
                entry["configuration_name"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    replaces.sort();
    let mut expected = vec![
        (
            c.canary["id"].as_str().unwrap().to_owned(),
            false,
            "r15-demo".to_owned(),
        ),
        (
            rollback["id"].as_str().unwrap().to_owned(),
            true,
            "Edge syslog processing".to_owned(),
        ),
    ];
    expected.sort();
    assert_eq!(replaces, expected);
}

/// Declining the suggestion leaves conflicts and a higher-priority rollback
/// in different tiers; `replacements_needed` names all of them, so one
/// "Replace existing" resolves the review.
#[tokio::test]
async fn one_replace_resolves_every_tier_that_keeps_a_device_from_the_request() {
    let c = live_canary(100, true).await;
    let plan = review(&c.app, &c.canary, &c.cookie).await;
    let (status, rollback) = call(
        &c.app,
        "POST",
        &commit_path(&c.canary),
        json!({"request_id":db::id(),"review_token":plan["review_token"]}),
        &c.cookie,
        &c.csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rollback}");
    // A different pipeline, so nothing is suggested for it.
    let other = seed_pipeline(&c.s, "Web access logs", &[1]).await;
    let mut request = binding(
        "configuration",
        &other[0],
        180,
        100,
        "snapshot",
        json!([]),
        json!(c.ids),
        json!([]),
        false,
    );
    let first = preview_deployment(&c.app, &c.cookie, &c.csrf, &request).await;
    assert_eq!(first["suggested_replaces"], json!([]));
    assert!(!first["conflicts"].as_array().unwrap().is_empty());
    let mut needed = vec![
        c.base["id"].as_str().unwrap().to_owned(),
        c.canary["id"].as_str().unwrap().to_owned(),
        rollback["id"].as_str().unwrap().to_owned(),
    ];
    needed.sort();
    assert_eq!(ids_of(&first["replacements_needed"]), needed, "{first}");
    request["replaces"] = json!(needed);
    let second = preview_deployment(&c.app, &c.cookie, &c.csrf, &request).await;
    assert_eq!(second["conflicts"], json!([]), "{second}");
    assert_eq!(second["replacements_needed"], json!([]));
    for outcome in second["outcomes"].as_array().unwrap() {
        assert_eq!(outcome["outcome"], "replace", "{outcome}");
    }
    request["expected_device_ids"] = json!(c.ids);
    let created = create_binding(&c.app, &c.cookie, &c.csrf, request).await;
    for id in &c.ids {
        assert_eq!(desired(&c.s, id).await.2.as_deref(), created["id"].as_str());
    }
}

/// Promoted from the preserved resume-canary-overlap-observation evidence.
#[tokio::test]
async fn resuming_canary_rejects_overlap_before_admission_and_preserves_state() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let (a, b) = seed_versions(&s).await;
    let first = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    let first_id = first["id"].as_str().unwrap();
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at=? WHERE deployment_id=? AND generation>0").bind(db::now()).bind(first_id).execute(&s.pool).await.unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/deployments/{first_id}/pause"),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let second = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            200,
            "snapshot",
            json!([]),
            json!([ids[1]]),
            json!([]),
            true,
        ),
    )
    .await;
    let candidate = binding(
        "configuration",
        &a,
        180,
        300,
        "snapshot",
        json!([]),
        json!([ids[1]]),
        json!([]),
        true,
    );
    let preview = call(
        &app,
        "POST",
        "/api/v1/deployments/preview",
        candidate.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(preview.0, StatusCode::OK);
    assert!(!preview.1["blockers"].as_array().unwrap().is_empty());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/deployments",
            candidate,
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut conn = s.pool.acquire().await.unwrap();
    let mut paused = db::record(&mut conn, "deployment", first_id).await.unwrap();
    paused["observation_started_at"] =
        json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    db::update(&mut conn, "deployment", &paused).await.unwrap();
    drop(conn);
    let before = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{first_id}"),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    let snapshot = state_snapshot(&s).await;
    let resumed = call(
        &app,
        "POST",
        &format!("/api/v1/deployments/{first_id}/resume"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(resumed.0, StatusCode::CONFLICT);
    assert_eq!(resumed.1["error"]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(state_snapshot(&s).await, snapshot);
    let after = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{first_id}"),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    let target = |d: &Value| {
        d["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["device_id"] == ids[1])
            .unwrap()
            .clone()
    };
    assert_eq!(target(&before)["generation"], 0);
    assert_eq!(target(&after)["generation"], 0);
    assert_eq!(after["status"], "paused");
    let desired: Option<String> =
        sqlx::query_scalar("SELECT desired_version_id FROM devices WHERE id=?")
            .bind(&ids[1])
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(desired.as_deref(), Some(b.as_str()));
    let second_after = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{}", second["id"].as_str().unwrap()),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(second_after["status"], "active");
    emit(
        "resume_active_canary_regression",
        &json!({"source_before":before,"source_after":after,"other_canary":second_after,"direct_create_status":409,"direct_preview":preview.1,"resumed_status":409,"resume_error":resumed.1,"all_state_preserved":true,"overlap_target_before":target(&before),"overlap_target_after":target(&after),"desired_version":desired,"higher_priority_still_wins":true,"activation_claimed":false,"verification_seeded":true}),
    );
}
