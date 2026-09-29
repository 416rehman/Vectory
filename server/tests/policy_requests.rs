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
        instance_name: "Saved settings request tests".into(),
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

fn body(key: Option<&str>) -> Value {
    let mut v = json!({"name":"Synthetic saved settings","policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}});
    if let Some(key) = key {
        v["request_id"] = json!(key);
    }
    v
}
fn lookup(key: &str) -> String {
    format!("/api/v1/policies/requests/{key}")
}
async fn create(app: &Router, v: Value, c: &str, t: &str) -> (StatusCode, Value) {
    call(app, "POST", "/api/v1/policies", v, c, t).await
}
fn emit(name: &str, schema: &str, v: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_POLICY_REQUEST_FIXTURES") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{name}.json")),
            serde_json::to_vec_pretty(v).unwrap(),
        )
        .unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{name}.schema")),
            schema,
        )
        .unwrap();
    }
}
async fn snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,payload_sha256,policy_id,created_at) FROM policy_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,revoked,desired_generation,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    json!({"records":records,"requests":requests,"devices":devices})
}
async fn audits(s: &State) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='policy.create'").fetch_one(&s.pool).await.unwrap()
}
#[tokio::test]
async fn keyed_replay_and_exact_lookup_are_response_correlated_and_read_only() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let key = db::id();
    let before = snapshot(&s).await;
    let (status, missing) = call(&app, "GET", &lookup(&key), Value::Null, &c, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        missing,
        json!({"create_idempotency":true,"request_id":key,"found":false})
    );
    assert_eq!(snapshot(&s).await, before);
    emit("lookup_absent", "PolicyRequestLookup", &missing);
    let req = body(Some(&key));
    let (status, record) = create(&app, req.clone(), &c, &t).await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["request_id"], key);
    assert_eq!(record["create_idempotency"], true);
    assert_eq!(record.as_object().unwrap().len(), 6);
    assert_eq!(snapshot(&s).await["devices"], before["devices"]);
    let persisted: String =
        sqlx::query_scalar("SELECT data FROM records WHERE kind='policy' AND id=?")
            .bind(record["id"].as_str().unwrap())
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert!(!persisted.contains("request_id"));
    assert!(!persisted.contains("create_idempotency"));
    emit("keyed_receipt", "PolicyCreateReceipt", &record);
    sqlx::query("UPDATE records SET data=json_set(data,'$.private_extension',?,'$.request_id',?,'$.create_idempotency',0) WHERE kind='policy' AND id=?").bind("PRIVATE_MARKER").bind(db::id()).bind(record["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
    let stable = snapshot(&s).await;
    let (status, replay) = create(&app, req, &c, &t).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay, record);
    let (status, found) = call(
        &app,
        "GET",
        &lookup(&key.to_uppercase()),
        Value::Null,
        &c,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        found,
        json!({"create_idempotency":true,"request_id":key,"found":true,"policy":record})
    );
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s).await, 1);
    emit("lookup_found", "PolicyRequestLookup", &found);
}
#[tokio::test]
async fn concurrent_retries_commit_one_record_mapping_and_audit() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let key = db::id();
    let req = body(Some(&key));
    let (a, b) = tokio::join!(create(&app, req.clone(), &c, &t), create(&app, req, &c, &t));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a, b);
    assert_eq!(audits(&s).await, 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM policy_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records WHERE kind='deployment'")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn canonical_supplied_body_binding_preserves_unknown_null_and_array_differences() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let key = db::id();
    let mut req = body(Some(&key));
    req["extension"] = json!({"b":[1,2],"a":null});
    let (status, first) = create(&app, req.clone(), &c, &t).await;
    assert_eq!(status, StatusCode::OK);
    let stable = snapshot(&s).await;
    let mut canonical = req.clone();
    canonical["extension"] = serde_json::from_str(r#"{"a":null,"b":[1,2]}"#).unwrap();
    canonical["request_id"] = json!(key.to_uppercase());
    assert_eq!(create(&app, canonical, &c, &t).await.1, first);
    for patch in [
        json!({"name":"Other"}),
        json!({"policy":{"heartbeat_seconds":61,"sync_paused":false,"telemetry_enabled":true}}),
        json!({"policy":null}),
        json!({"extra":null}),
        json!({"extension":{"b":[2,1],"a":null}}),
    ] {
        let mut changed = req.clone();
        for (k, v) in patch.as_object().unwrap() {
            changed[k] = v.clone();
        }
        let (status, error) = create(&app, changed, &c, &t).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "IDEMPOTENCY_CONFLICT");
        assert_eq!(snapshot(&s).await, stable);
        emit("payload_conflict", "Error", &error);
    }
    let mut absent = req;
    absent.as_object_mut().unwrap().remove("extension");
    assert_eq!(create(&app, absent, &c, &t).await.0, StatusCode::CONFLICT);
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn legacy_and_name_policy_validation_remain_compatible() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let (status, a) = create(&app, body(None), &c, &t).await;
    assert_eq!(status, StatusCode::OK);
    let (status, b) = create(&app, body(None), &c, &t).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(a["id"], b["id"]);
    assert!(a.get("request_id").is_none());
    assert!(a.get("create_idempotency").is_none());
    emit("legacy_record", "SavedPolicy", &a);
    let mut good = body(Some(&db::id()));
    good["name"] = json!("\u{1f642}".repeat(30));
    assert_eq!(create(&app, good, &c, &t).await.0, StatusCode::OK);
    let mut blank = body(Some(&db::id()));
    blank["name"] = json!(" ");
    assert_eq!(create(&app, blank, &c, &t).await.0, StatusCode::OK);
    let stable = snapshot(&s).await;
    for name in [
        json!(""),
        json!("\u{1f642}".repeat(31)),
        json!("a\u{0}b"),
        Value::Null,
    ] {
        let mut bad = body(Some(&db::id()));
        bad["name"] = name;
        assert_eq!(create(&app, bad, &c, &t).await.0, StatusCode::BAD_REQUEST);
    }
    for policy in [
        json!({"heartbeat_seconds":9,"sync_paused":false,"telemetry_enabled":true}),
        json!({"heartbeat_seconds":3601,"sync_paused":false,"telemetry_enabled":true}),
        json!({"heartbeat_seconds":60,"sync_paused":false}),
        json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true,"unknown":true}),
        json!({"heartbeat_seconds":60,"sync_paused":"false","telemetry_enabled":true}),
    ] {
        let mut bad = body(Some(&db::id()));
        bad["policy"] = policy;
        assert_eq!(create(&app, bad, &c, &t).await.0, StatusCode::BAD_REQUEST);
    }
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn audit_and_registry_failure_rollback_template_and_mapping() {
    for sql in [
        "CREATE TRIGGER policy_fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='policy.create' BEGIN SELECT RAISE(ABORT,'audit fault'); END",
        "CREATE TRIGGER policy_fault BEFORE INSERT ON policy_requests BEGIN SELECT RAISE(ABORT,'mapping fault'); END",
    ] {
        let (_temp, s, app, _ids, c, t) = fixture().await;
        sqlx::query(sql).execute(&s.pool).await.unwrap();
        let stable = snapshot(&s).await;
        assert_eq!(
            create(&app, body(Some(&db::id())), &c, &t).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&s).await, stable);
        assert_eq!(audits(&s).await, 0);
    }
}
#[tokio::test]
async fn missing_original_is_a_retained_tombstone_never_recreated() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let key = db::id();
    let req = body(Some(&key));
    let (_, p) = create(&app, req.clone(), &c, &t).await;
    sqlx::query("DELETE FROM records WHERE kind='policy' AND id=?")
        .bind(p["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    let (status, error) = create(&app, req, &c, &t).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "CONFLICT");
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &c, "")
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, stable);
    let (_, history) = call(
        &app,
        "GET",
        "/api/v1/policies/requests",
        Value::Null,
        &c,
        "",
    )
    .await;
    assert_eq!(history["items"][0]["policy_id"], p["id"]);
    assert!(history["items"][0]["policy_name"].is_null());
    emit("missing_result_error", "Error", &error);
    emit("missing_result_history", "PolicyRequestPage", &history);
}
#[tokio::test]
async fn actor_isolation_roles_csrf_and_live_offboarding_apply_on_replay_and_reads() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let key = db::id();
    let req = body(Some(&key));
    let (_, p) = create(&app, req.clone(), &c, &t).await;
    let (uid, other, other_csrf) = actor(&s, "operator").await;
    let (status, absent) = call(&app, "GET", &lookup(&key), Value::Null, &other, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(absent["found"], false);
    let (_, other_p) = create(&app, req.clone(), &other, &other_csrf).await;
    assert_ne!(p["id"], other_p["id"]);
    for role in ["viewer", "editor"] {
        let (_, user, token) = actor(&s, role).await;
        assert_eq!(
            create(&app, req.clone(), &user, &token).await.0,
            StatusCode::FORBIDDEN
        );
        for path in [lookup(&key), "/api/v1/policies/requests".into()] {
            assert_eq!(
                call(&app, "GET", &path, Value::Null, &user, "").await.0,
                StatusCode::FORBIDDEN
            );
        }
    }
    assert_eq!(
        create(&app, req.clone(), &c, "").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        create(&app, req.clone(), "", "").await.0,
        StatusCode::UNAUTHORIZED
    );
    let guard = s.writer.lock().await;
    let app2 = app.clone();
    let other2 = other.clone();
    let csrf2 = other_csrf.clone();
    let task = tokio::spawn(async move { create(&app2, req, &other2, &csrf2).await });
    tokio::task::yield_now().await;
    sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
        .bind(uid)
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::FORBIDDEN);
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &other, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn strict_duplicate_json_queries_ids_and_canonical_route_prevent_bypass() {
    let (_t, s, app, _ids, c, t) = fixture().await;
    let stable = snapshot(&s).await;
    for raw in [r#"{"name":"a","name":"b","policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}}"#.to_owned(),r#"{"name":"a","policy":{"heartbeat_seconds":60,"heartbeat_seconds":70,"sync_paused":false,"telemetry_enabled":true}}"#.to_owned(),r#"{"name":"a","policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true},"unknown":{"x":1,"x":1}}"#.to_owned(),format!(r#"{{"request_id":"{}","request_id":"{}","name":"a","policy":{{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}}}}"#,db::id(),db::id())]{let response=app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/policies").header("content-type","application/json").header("cookie",&c).header("x-csrf-token",&t).body(Body::from(raw)).unwrap()).await.unwrap();assert_eq!(response.status(),StatusCode::BAD_REQUEST);}
    for key in [
        Value::Null,
        json!(1),
        json!(""),
        json!("not-uuid"),
        json!(db::id().replace("-", "")),
    ] {
        let mut v = body(None);
        v["request_id"] = key;
        assert_eq!(create(&app, v, &c, &t).await.0, StatusCode::BAD_REQUEST);
    }
    for v in [json!([]), Value::Null, json!(1)] {
        assert_eq!(create(&app, v, &c, &t).await.0, StatusCode::BAD_REQUEST);
    }
    for path in ["/api/v1/%70olicies", "/api/v1/policies?unknown=1"] {
        assert_eq!(
            call(&app, "POST", path, body(None), &c, &t).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for suffix in [
        "?page=0",
        "?page_size=0",
        "?page_size=51",
        "?page=9007199254740992",
        "?page=1&page=2",
        "?actor_id=other",
        "?page=%GG",
        "?page=%FF",
        "?page=-1",
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/api/v1/policies/requests{suffix}"),
                Value::Null,
                &c,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for suffix in ["?foo=x", "?page=1", "?x=%GG"] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{}{suffix}", lookup(&db::id())),
                Value::Null,
                &c,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn bounded_actor_history_excludes_request_policy_and_private_extensions() {
    let (_t, s, app, _ids, c, _tkn) = fixture().await;
    let owner: String = sqlx::query_scalar("SELECT id FROM users WHERE role='admin'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    let (other, _, _) = actor(&s, "operator").await;
    let mut expected = vec![];
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..61 {
        let key = format!("00000000-0000-4000-8000-{n:012}");
        let id = db::id();
        let p = json!({"id":id,"name":if n==60{json!("\u{1f642}".repeat(130))}else if n==59{json!({"private":"PRIVATE_MARKER"})}else{json!(format!("Saved {n}"))},"policy":{"private":"PRIVATE_MARKER"},"private":"PRIVATE_MARKER","created_at":"2026-01-01T00:00:00Z"});
        db::insert(&mut tx, "policy", &p).await.unwrap();
        sqlx::query("INSERT INTO policy_requests VALUES(?,?,?,?,?)")
            .bind(if n == 0 { &other } else { &owner })
            .bind(&key)
            .bind("a".repeat(64))
            .bind(id)
            .bind("2026-01-01T00:00:00Z")
            .execute(&mut *tx)
            .await
            .unwrap();
        if n > 0 {
            expected.push(key);
        }
    }
    tx.commit().await.unwrap();
    expected.reverse();
    let stable = snapshot(&s).await;
    let (status, a) = call(
        &app,
        "GET",
        "/api/v1/policies/requests?page_size=50",
        Value::Null,
        &c,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(a["create_idempotency"], true);
    assert_eq!(a["total"], 60);
    assert_eq!(a["items"].as_array().unwrap().len(), 50);
    assert_eq!(
        a["items"][0]["policy_name"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        120
    );
    assert!(a["items"][1]["policy_name"].is_null());
    assert!(!a.to_string().contains("PRIVATE_MARKER"));
    assert!(!a.to_string().contains("payload_sha256"));
    let (_, b) = call(
        &app,
        "GET",
        "/api/v1/policies/requests?page=2&page_size=50",
        Value::Null,
        &c,
        "",
    )
    .await;
    let actual: Vec<String> = a["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(b["items"].as_array().unwrap())
        .map(|r| r["request_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(snapshot(&s).await, stable);
    emit("metadata_history", "PolicyRequestPage", &a);
}

#[tokio::test]
async fn migration_from_pre_registry_retains_existing_templates_without_inventing_requests() {
    let (_temp, s, app, _ids, c, t) = fixture().await;
    let (_, legacy) = create(&app, body(None), &c, &t).await;
    let before = snapshot(&s).await;
    sqlx::query("DROP TABLE policy_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=20")
        .execute(&s.pool)
        .await
        .unwrap();
    let settings = s.settings.clone();
    drop(app);
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let app = api::router(s.clone());
    assert_eq!(snapshot(&s).await, before);
    let (status, all) = call(&app, "GET", "/api/v1/policies", Value::Null, &c, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all, json!([legacy]));
    let (_, page) = call(
        &app,
        "GET",
        "/api/v1/policies/requests",
        Value::Null,
        &c,
        "",
    )
    .await;
    assert_eq!(page["total"], 0);
    let key = db::id();
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &c, "")
            .await
            .1["found"],
        false
    );
    assert_eq!(
        create(&app, body(Some(&key)), &c, &t).await.0,
        StatusCode::OK
    );
    assert_eq!(audits(&s).await, 2);
}
