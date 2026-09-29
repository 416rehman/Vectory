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
        instance_name: "Scheduled refresh before proof".into(),
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

async fn group_members(app: &Router, group: &mut Value, ids: Value, cookie: &str, csrf: &str) {
    let (status, updated) = call(
        app,
        "PUT",
        &format!("/api/v1/groups/{}", group["id"].as_str().unwrap()),
        json!({"name":"Scheduled group","device_ids":ids,"revision":group["revision"]}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    *group = updated;
}
async fn scheduled(app: &Router, group: &Value, cookie: &str, csrf: &str) -> Value {
    let request = json!({"name":"Refresh fixture","selector":{"device_ids":[],"group_ids":[group["id"]],"exclude_ids":[]},"policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true},"priority":100,"target_mode":"snapshot","scheduled_at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339(),"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}});
    let (status, d) = call(app, "POST", "/api/v1/deployments", request, cookie, csrf).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}
async fn audit_count(s: &State, id: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.refresh_targets' AND json_extract(data,'$.target')=?").bind(id).fetch_one(&s.pool).await.unwrap()
}
async fn generations(s: &State) -> Vec<String> {
    sqlx::query_scalar("SELECT json_array(id,desired_generation,policy_generation,json_extract(data,'$.reported_generation')) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap()
}

async fn plan(app: &Router, d: &Value, cookie: &str, csrf: &str) -> Value {
    let (status, p) = call(
        app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/refresh-preview",
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
fn payload(p: &Value) -> Value {
    json!({"review_token":p["review_token"],"expected_device_ids":p["devices"].as_array().unwrap().iter().map(|d|d["id"].clone()).collect::<Vec<_>>()})
}
async fn send(app: &Router, d: &Value, p: &Value, cookie: &str, csrf: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/v1/deployments/{}/refresh", d["id"].as_str().unwrap()),
        payload(p),
        cookie,
        csrf,
    )
    .await
}
async fn group(app: &Router, ids: Value, cookie: &str, csrf: &str) -> Value {
    let (status, g) = call(
        app,
        "POST",
        "/api/v1/groups",
        json!({"name":"Scheduled group","device_ids":ids}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    g
}
async fn snapshot(s: &State) -> Value {
    let r: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let t:Vec<String>=sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation,previous_version_id,released_at,verified_at,error,original) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"records":r,"targets":t,"generations":generations(s).await})
}
fn fixture_body(name: &str, schema: &str, value: &Value) {
    emit(name, value);
    if let Ok(dir) = std::env::var("VECTORY_GROUP_FIXTURES") {
        let path = std::path::Path::new(&dir).join(format!("{name}.schema"));
        std::fs::write(path, schema).unwrap();
    }
}
#[tokio::test]
async fn late_reviewed_refresh_cannot_overwrite_newer_saved_snapshot() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let id = d["id"].as_str().unwrap();
    let original_generations = generations(&s).await;
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let a = plan(&app, &d, &cookie, &csrf).await;
    fixture_body("ready_policy_preview", "ScheduledRefreshPreview", &a);
    let (release, held) = tokio::sync::oneshot::channel::<()>();
    let app_a = app.clone();
    let d_a = d.clone();
    let cookie_a = cookie.clone();
    let csrf_a = csrf.clone();
    let a_copy = a.clone();
    let old = tokio::spawn(async move {
        held.await.unwrap();
        send(&app_a, &d_a, &a_copy, &cookie_a, &csrf_a).await
    });
    group_members(&app, &mut g, json!([ids[0], ids[2]]), &cookie, &csrf).await;
    let b = plan(&app, &d, &cookie, &csrf).await;
    let (status, b) = send(&app, &d, &b, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{b}");
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let before = snapshot(&s).await;
    release.send(()).unwrap();
    let (status, error) = old.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "SCHEDULE_REFRESH_REVIEW_CHANGED");
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(audit_count(&s, id).await, 1);
    assert_eq!(generations(&s).await, original_generations);
    fixture_body("late_refresh_error", "Error", &error);
    fixture_body("changed_receipt", "Deployment", &b);
}
#[tokio::test]
async fn no_op_and_metadata_refresh_leave_all_bytes_audit_and_revision_unchanged() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let a = plan(&app, &d, &cookie, &csrf).await;
    sqlx::query("UPDATE devices SET name=?,data=json_set(data,'$.last_seen',?,'$.private_blob',?) WHERE id=?").bind("??".repeat(250)).bind(db::now()).bind("never expose this private extension").bind(&ids[0]).execute(&s.pool).await.unwrap();
    group_members(&app, &mut g, json!([ids[0]]), &cookie, &csrf).await;
    let b = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(a["review_token"], b["review_token"]);
    assert_eq!(
        b["devices"][0]["name"].as_str().unwrap().chars().count(),
        240
    );
    assert!(!b.to_string().contains("private_blob"));
    let before = snapshot(&s).await;
    for _ in 0..2 {
        let (status, out) = send(&app, &d, &a, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{out}");
        assert_eq!(snapshot(&s).await, before);
        assert!(out.get("target_refresh_revision").is_none());
    }
    assert_eq!(audit_count(&s, d["id"].as_str().unwrap()).await, 0);
    fixture_body("noop_preview", "ScheduledRefreshPreview", &b);
}
#[tokio::test]
async fn monotonic_revision_prevents_aba_after_snapshot_returns_to_old_set() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let old = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(send(&app, &d, &old, &cookie, &csrf).await.0, StatusCode::OK);
    group_members(&app, &mut g, json!([ids[0]]), &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(send(&app, &d, &p, &cookie, &csrf).await.0, StatusCode::OK);
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    assert_ne!(old["review_token"], p["review_token"]);
    let before = snapshot(&s).await;
    assert_eq!(
        send(&app, &d, &old, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn source_changes_and_activation_invalidate_review_without_releasing_on_refresh() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let id = d["id"].as_str().unwrap();
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    for (field, new) in [
        ("priority", json!(101)),
        ("target_mode", json!("persistent")),
        (
            "policy",
            json!({"heartbeat_seconds":70,"sync_paused":false,"telemetry_enabled":true}),
        ),
        (
            "scheduled_at",
            json!((chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339()),
        ),
    ] {
        let mut c = s.pool.acquire().await.unwrap();
        let mut stored = db::record(&mut c, "deployment", id).await.unwrap();
        let original = stored[field].clone();
        stored[field] = new;
        db::update(&mut c, "deployment", &stored).await.unwrap();
        drop(c);
        let before = snapshot(&s).await;
        assert_eq!(
            send(&app, &d, &p, &cookie, &csrf).await.0,
            StatusCode::CONFLICT
        );
        assert_eq!(snapshot(&s).await, before);
        let mut c = s.pool.acquire().await.unwrap();
        stored[field] = original;
        db::update(&mut c, "deployment", &stored).await.unwrap();
    }
    sqlx::query("UPDATE records SET data=json_set(data,'$.scheduled_at',?) WHERE kind='deployment' AND id=?").bind((chrono::Utc::now()-chrono::Duration::seconds(1)).to_rfc3339()).bind(id).execute(&s.pool).await.unwrap();
    vectory_server::rollout::tick(&s).await.unwrap();
    let before = snapshot(&s).await;
    assert_eq!(
        send(&app, &d, &p, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, before);
    let inactive = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(inactive["ready"], false);
    assert_ne!(inactive["source_status"], "scheduled");
    assert_eq!(inactive["devices"], json!([]));
    assert_eq!(inactive["saved_devices"].as_array().unwrap().len(), 1);
    fixture_body("inactive_preview", "ScheduledRefreshPreview", &inactive);
}
#[tokio::test]
async fn auth_csrf_actor_binding_and_strict_body_query_and_encoded_route() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    let path = format!("/api/v1/deployments/{}/refresh", d["id"].as_str().unwrap());
    for role in ["viewer", "editor"] {
        let (_, c, t) = actor(&s, role).await;
        assert_eq!(
            call(&app, "POST", &path, payload(&p), &c, &t).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(&app, "POST", &path, payload(&p), &cookie, "").await.0,
        StatusCode::FORBIDDEN
    );
    let (_, other, other_csrf) = actor(&s, "operator").await;
    assert_eq!(
        call(&app, "POST", &path, payload(&p), &other, &other_csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let before = snapshot(&s).await;
    for body in [
        json!({}),
        json!({"expected_device_ids":[ids[0]]}),
        json!({"review_token":"x","expected_device_ids":[ids[0]]}),
        json!({"review_token":p["review_token"],"expected_device_ids":[ids[0],ids[0]]}),
        json!({"review_token":p["review_token"],"expected_device_ids":[]}),
        json!({"review_token":p["review_token"],"expected_device_ids":["not-uuid"]}),
        json!({"review_token":p["review_token"],"expected_device_ids":[ids[0]],"unknown":true}),
    ] {
        assert_eq!(
            call(&app, "POST", &path, body, &cookie, &csrf).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for suffix in ["?unknown=x", "?a=x&a=y"] {
        assert_eq!(
            call(
                &app,
                "POST",
                &(path.clone() + suffix),
                payload(&p),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let raw = format!(
        "{{\"review_token\":\"{}\",\"review_token\":\"{}\",\"expected_device_ids\":[\"{}\"]}}",
        p["review_token"].as_str().unwrap(),
        p["review_token"].as_str().unwrap(),
        ids[0]
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
                .body(Body::from(raw))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        call(
            &app,
            "POST",
            &path.replace("/refresh", "/%72efresh"),
            payload(&p),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&s).await, before);
}
#[tokio::test]
async fn concurrent_changed_commits_have_one_audit_and_late_audit_failure_rolls_back() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    group_members(&app, &mut g, json!([ids[0], ids[1]]), &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    sqlx::query("CREATE TRIGGER reject_refresh_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.refresh_targets' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END").execute(&s.pool).await.unwrap();
    let before = snapshot(&s).await;
    assert_eq!(
        send(&app, &d, &p, &cookie, &csrf).await.0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(snapshot(&s).await, before);
    sqlx::query("DROP TRIGGER reject_refresh_audit")
        .execute(&s.pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        send(&app, &d, &p, &cookie, &csrf),
        send(&app, &d, &p, &cookie, &csrf)
    );
    assert!(
        (a.0 == StatusCode::OK && b.0 == StatusCode::CONFLICT)
            || (b.0 == StatusCode::OK && a.0 == StatusCode::CONFLICT)
    );
    assert_eq!(audit_count(&s, d["id"].as_str().unwrap()).await, 1);
    let (list_status, list) =
        call(&app, "GET", "/api/v1/deployments", Value::Null, &cookie, "").await;
    assert_eq!(list_status, StatusCode::OK);
    assert!(!list.to_string().contains("target_refresh_revision"));
}
#[tokio::test]
async fn empty_revoked_missing_and_configuration_projections_are_bounded_and_read_only() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    group_members(&app, &mut g, json!([]), &cookie, &csrf).await;
    let before = snapshot(&s).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(p["blockers"][0]["code"], "NO_TARGETS");
    assert_eq!(snapshot(&s).await, before);
    fixture_body("empty_preview", "ScheduledRefreshPreview", &p);
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let p = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(p["saved_devices"][0]["status"], "revoked");
    fixture_body("revoked_saved_preview", "ScheduledRefreshPreview", &p);
    let mut c = s.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(&ids[0])
        .execute(&mut *c)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *c)
        .await
        .unwrap();
    drop(c);
    let missing = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(missing["saved_devices"][0]["status"], "missing");
    assert_eq!(missing["saved_devices"][0]["name"], Value::Null);
    fixture_body("missing_saved_preview", "ScheduledRefreshPreview", &missing);
    let version = db::id();
    let mut c = s.pool.acquire().await.unwrap();
    db::insert(&mut c,"version",&json!({"id":version,"configuration_id":db::id(),"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    let mut source = db::record(&mut c, "deployment", d["id"].as_str().unwrap())
        .await
        .unwrap();
    source.as_object_mut().unwrap().remove("policy");
    source["version_id"] = json!(version);
    db::update(&mut c, "deployment", &source).await.unwrap();
    drop(c);
    group_members(&app, &mut g, json!([ids[1]]), &cookie, &csrf).await;
    let p = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(p["resource"], "configuration");
    assert_eq!(p["ready"], true);
    fixture_body("configuration_preview", "ScheduledRefreshPreview", &p);
    let (status, receipt) = send(&app, &d, &p, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK);
    fixture_body("configuration_receipt", "Deployment", &receipt);
}

#[tokio::test]
async fn queued_actor_offboarding_and_target_admission_are_rechecked() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let (uid, c, t) = actor(&s, "operator").await;
    let p = plan(&app, &d, &c, &t).await;
    let guard = s.writer.lock().await;
    let app2 = app.clone();
    let d2 = d.clone();
    let p2 = p.clone();
    let task = tokio::spawn(async move { send(&app2, &d2, &p2, &c, &t).await });
    tokio::task::yield_now().await;
    sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
        .bind(uid)
        .execute(&s.pool)
        .await
        .unwrap();
    let before = snapshot(&s).await;
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::FORBIDDEN);
    assert_eq!(snapshot(&s).await, before);
    let p = plan(&app, &d, &cookie, &csrf).await;
    sqlx::query("UPDATE deployment_targets SET generation=1,state='desired',released_at=? WHERE deployment_id=?").bind(db::now()).bind(d["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
    let before = snapshot(&s).await;
    assert_eq!(
        send(&app, &d, &p, &cookie, &csrf).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, before);
    let blocked = plan(&app, &d, &cookie, &csrf).await;
    assert_eq!(blocked["ready"], false);
    fixture_body(
        "admitted_blocked_preview",
        "ScheduledRefreshPreview",
        &blocked,
    );
}
#[tokio::test]
async fn oversized_union_rejects_without_truncation_and_private_revision_cannot_be_injected() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let g = group(&app, json!([ids[0]]), &cookie, &csrf).await;
    let d = scheduled(&app, &g, &cookie, &csrf).await;
    let mut body = d.clone();
    body["target_refresh_revision"] = json!(MAX_SAFE_TEST);
    body.as_object_mut().unwrap().remove("id");
    let (status, new) = call(&app, "POST", "/api/v1/deployments", body, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{new}");
    let mut c = s.pool.acquire().await.unwrap();
    let stored = db::records(&mut c, "deployment").await.unwrap();
    assert_eq!(stored.len(), 1);
    drop(c);
    let mut tx = s.pool.begin().await.unwrap();
    sqlx::query("WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x WHERE n<10000) INSERT INTO devices(id,name,data) SELECT printf('10000000-0000-4000-8000-%012d',n),printf('Bounded fixture %d',n),'{}' FROM x").execute(&mut *tx).await.unwrap();
    sqlx::query("DELETE FROM deployment_targets WHERE deployment_id=?")
        .bind(d["id"].as_str().unwrap())
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id) SELECT ?,id FROM devices WHERE id LIKE '10000000-%'").bind(d["id"].as_str().unwrap()).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let before = snapshot(&s).await;
    let (status, error) = call(
        &app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/refresh-preview",
            d["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(snapshot(&s).await, before);
}
const MAX_SAFE_TEST: u64 = 9_007_199_254_740_991;
