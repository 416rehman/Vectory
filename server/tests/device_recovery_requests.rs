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

fn body(key: &str) -> Value {
    json!({"request_id":key,"expected_name":"fixture-0"})
}
fn lookup(id: &str, key: &str) -> String {
    format!("/api/v1/devices/{id}/recovery-requests/{key}")
}
async fn create(app: &Router, id: &str, v: Value, c: &str, t: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("/api/v1/devices/{id}/recover"),
        v,
        c,
        t,
    )
    .await
}
async fn cancel(app: &Router, id: &str, key: &str, c: &str, t: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("{}/cancel", lookup(id, key)),
        json!({}),
        c,
        t,
    )
    .await
}
async fn read(app: &Router, id: &str, key: &str, c: &str) -> (StatusCode, Value) {
    call(app, "GET", &lookup(id, key), Value::Null, c, "").await
}
fn emit(name: &str, schema: &str, v: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_DEVICE_RECOVERY_FIXTURES") {
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
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,device_id,payload_sha256,token_id,state,created_at,cancelled_at) FROM device_recovery_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let tokens: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(id,verifier,data) FROM enrollment_tokens ORDER BY id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,revoked,desired_generation,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let credentials:Vec<String>=sqlx::query_scalar("SELECT json_array(fingerprint,device_id,revoked,expires_at,signing_key_id) FROM credentials ORDER BY fingerprint").fetch_all(&s.pool).await.unwrap();
    let sessions: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(verifier,user_id,csrf,expires_at) FROM sessions ORDER BY verifier",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    json!({"records":records,"requests":requests,"tokens":tokens,"devices":devices,"credentials":credentials,"sessions":sessions})
}
async fn audits(s: &State, action: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",
    )
    .bind(action)
    .fetch_one(&s.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn receipt_and_replay_bind_exact_source_and_name_without_persisting_secret() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let before = snapshot(&s).await;
    let (code, absent) = read(&app, id, &key, &c).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        absent,
        json!({"request_id":key,"request_correlation":true,"device_id":id,"found":false})
    );
    assert_eq!(snapshot(&s).await, before);
    emit("absent", "DeviceRecoveryRequestStatus", &absent);
    let (code, receipt) = create(&app, id, body(&key), &c, &t).await;
    assert_eq!(code, StatusCode::OK, "{receipt}");
    assert_eq!(receipt.as_object().unwrap().len(), 5);
    assert_eq!(receipt["request_id"], key);
    assert_eq!(receipt["device_id"], *id);
    assert_eq!(receipt["request_correlation"], true);
    assert_eq!(receipt["record"]["recovery_device_id"], *id);
    assert_eq!(receipt["record"]["recovery_name"], "fixture-0");
    assert_eq!(receipt["record"]["max_uses"], 1);
    assert_eq!(receipt["record"]["name_prefix"], Value::Null);
    let secret = receipt["token"].as_str().unwrap();
    assert_eq!(secret.len(), 64);
    let stable = snapshot(&s).await;
    assert!(!stable.to_string().contains(secret));
    for k in ["devices", "credentials", "sessions"] {
        assert_eq!(stable[k], before[k])
    }
    let stored: String = sqlx::query_scalar("SELECT data FROM enrollment_tokens")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!stored.contains("request_id"));
    assert!(!stored.contains("request_correlation"));
    let verifier: String = sqlx::query_scalar("SELECT verifier FROM enrollment_tokens")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(verifier, db::hash(secret));
    let mut req = body(&key);
    req["request_id"] = json!(key.to_uppercase());
    let (code, replay) = create(&app, &id.to_uppercase(), req, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        replay,
        json!({"request_id":key,"request_correlation":true,"device_id":id,"found":true,"state":"created","record":receipt["record"]})
    );
    assert_eq!(read(&app, id, &key, &c).await.1, replay);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "device.recovery_authorize").await, 1);
    emit("initial_receipt", "DeviceRecoveryTokenReceipt", &receipt);
    emit("created", "DeviceRecoveryRequestStatus", &replay);
    sqlx::query("UPDATE devices SET name=name||'#retired-'||id WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE enrollment_tokens SET data=json_set(data,'$.uses',1,'$.expires_at','2000-01-01T00:00:00Z','$.private','DO_NOT_EXPOSE')").execute(&s.pool).await.unwrap();
    let (code, replay) = create(&app, id, body(&key), &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(replay["record"]["uses"], 1);
    assert!(!replay.to_string().contains("DO_NOT_EXPOSE"));
    assert!(replay.get("token").is_none());
    assert_eq!(audits(&s, "device.recovery_authorize").await, 1);
}
#[tokio::test]
async fn current_name_retirement_and_payload_source_binding_are_atomic() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let stable = snapshot(&s).await;
    let (code, error) = create(
        &app,
        id,
        json!({"request_id":key,"expected_name":"not-reviewed"}),
        &c,
        &t,
    )
    .await;
    assert_eq!(code, StatusCode::CONFLICT);
    assert_eq!(snapshot(&s).await, stable);
    emit("name_changed", "Error", &error);
    create(&app, id, body(&key), &c, &t).await;
    let stable = snapshot(&s).await;
    for target in [&ids[1], &db::id()] {
        assert_eq!(
            read(&app, target, &key, &c).await.1["error"]["code"],
            "IDEMPOTENCY_CONFLICT"
        );
        assert_eq!(
            cancel(&app, target, &key, &c, &t).await.1["error"]["code"],
            "IDEMPOTENCY_CONFLICT"
        );
        assert_eq!(
            create(&app, target, body(&key), &c, &t).await.1["error"]["code"],
            "IDEMPOTENCY_CONFLICT"
        )
    }
    for name in [json!("fixture-1"), json!("different")] {
        let (code, error) = create(
            &app,
            id,
            json!({"request_id":key,"expected_name":name}),
            &c,
            &t,
        )
        .await;
        assert_eq!(code, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "IDEMPOTENCY_CONFLICT");
        emit("payload_conflict", "Error", &error)
    }
    assert_eq!(snapshot(&s).await, stable);
    sqlx::query("UPDATE devices SET name=name||'#retired-'||id WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    assert_eq!(
        create(&app, id, body(&db::id()), &c, &t).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn cancel_before_late_creation_retains_source_fence_across_restart() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let (code, closed) = cancel(&app, id, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        closed,
        json!({"request_id":key,"request_correlation":true,"device_id":id,"found":true,"state":"cancelled","record":null})
    );
    emit("cancelled_before", "DeviceRecoveryRequestStatus", &closed);
    let before_invalid = snapshot(&s).await;
    for request in [
        json!({"request_id":key}),
        json!({"request_id":key,"expected_name":null}),
        json!({"request_id":key,"expected_name":""}),
    ] {
        assert_eq!(
            create(&app, id, request, &c, &t).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(snapshot(&s).await, before_invalid);
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    assert_eq!(create(&app, id, body(&key), &c, &t).await.1, closed);
    assert_eq!(cancel(&app, id, &key, &c, &t).await.1, closed);
    assert_eq!(snapshot(&s).await, stable);
    let settings = s.settings.clone();
    drop(app);
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let app = api::router(s.clone());
    assert_eq!(create(&app, id, body(&key), &c, &t).await.1, closed);
    assert_eq!(read(&app, id, &key, &c).await.1, closed);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "device.recovery_authorize").await, 0);
    assert_eq!(audits(&s, "device.recovery_request.cancel").await, 1);
}
#[tokio::test]
async fn cancelled_authorization_preserves_already_issued_replacement_and_replay_history() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let (_, receipt) = create(&app, id, body(&key), &c, &t).await;
    let device_api = vectory_server::device::router(s.clone());
    let pair = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&pair)
        .unwrap()
        .pem()
        .unwrap();
    let req = json!({"protocol_version":1,"request_id":"synthetic-device-recovery","token":receipt["token"],"name":"fixture-0","csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"});
    let (code, replacement) =
        call(&device_api, "POST", "/agent/v1/enroll", req.clone(), "", "").await;
    assert_eq!(code, StatusCode::OK, "{replacement}");
    assert_ne!(replacement["device_id"], *id);
    assert_eq!(
        call(&device_api, "POST", "/agent/v1/enroll", req.clone(), "", "")
            .await
            .1,
        replacement
    );
    let (code, status) = create(&app, id, body(&key), &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(status["record"]["uses"], 1);
    assert!(status.get("token").is_none());
    emit("used_created", "DeviceRecoveryRequestStatus", &status);
    let stable = snapshot(&s).await;
    let (code, closed) = cancel(&app, id, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(closed["record"]["revoked"], true);
    assert_eq!(closed["record"]["uses"], 1);
    emit("used_cancelled", "DeviceRecoveryRequestStatus", &closed);
    let after = snapshot(&s).await;
    for k in ["devices", "credentials", "sessions"] {
        assert_eq!(after[k], stable[k])
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM credentials WHERE device_id=? AND revoked=0"
        )
        .bind(replacement["device_id"].as_str().unwrap())
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        call(&device_api, "POST", "/agent/v1/enroll", req, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let after_rejected_replay = snapshot(&s).await;
    for k in ["devices", "credentials", "sessions", "tokens", "requests"] {
        assert_eq!(after_rejected_replay[k], after[k]);
    }
    assert_eq!(cancel(&app, id, &key, &c, &t).await.1, closed);
    assert_eq!(snapshot(&s).await, after_rejected_replay);
    assert_eq!(audits(&s, "token.revoke").await, 1);
    assert_eq!(audits(&s, "device.recovery_request.cancel").await, 1);
}
#[tokio::test]
async fn concurrent_initials_reveal_secret_once_and_cancel_races_leave_no_active_token() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let (a, b) = tokio::join!(
        create(&app, id, body(&key), &c, &t),
        create(&app, id, body(&key), &c, &t)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_ne!(a.1.get("token").is_some(), b.1.get("token").is_some());
    assert_eq!(a.1["record"]["id"], b.1["record"]["id"]);
    assert_eq!(audits(&s, "device.recovery_authorize").await, 1);
    cancel(&app, id, &key, &c, &t).await;
    for _ in 0..5 {
        let key = db::id();
        let (made, closed) = tokio::join!(
            create(&app, id, body(&key), &c, &t),
            cancel(&app, id, &key, &c, &t)
        );
        assert_eq!(made.0, StatusCode::OK);
        assert_eq!(closed.0, StatusCode::OK);
        assert_eq!(closed.1["state"], "cancelled");
        assert_eq!(read(&app, id, &key, &c).await.1, closed.1);
        assert_eq!(create(&app, id, body(&key), &c, &t).await.1, closed.1)
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM enrollment_tokens WHERE json_extract(data,'$.revoked')=0"
        )
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        0
    );
}
#[tokio::test]
async fn actor_isolation_admin_only_and_ordinary_token_namespace_are_preserved() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let (_, first) = create(&app, id, body(&key), &c, &t).await;
    let (_, other, csrf) = actor(&s, "admin").await;
    assert_eq!(read(&app, id, &key, &other).await.1["found"], false);
    assert_eq!(
        cancel(&app, id, &key, &other, &csrf).await.1["record"],
        Value::Null
    );
    assert_eq!(read(&app, id, &key, &c).await.1["record"], first["record"]);
    for role in ["operator", "editor", "viewer"] {
        let (_, user, csrf) = actor(&s, role).await;
        let stable = snapshot(&s).await;
        assert_eq!(read(&app, id, &key, &user).await.0, StatusCode::FORBIDDEN);
        assert_eq!(
            create(&app, id, body(&key), &user, &csrf).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            cancel(&app, id, &key, &user, &csrf).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(snapshot(&s).await, stable)
    }
    for who in ["", &c] {
        let expected = if who.is_empty() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(create(&app, id, body(&key), who, "").await.0, expected);
        assert_eq!(cancel(&app, id, &key, who, "").await.0, expected)
    }
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/tokens/requests/{key}"),
            Value::Null,
            &c,
            ""
        )
        .await
        .1["found"],
        false
    );
    let (_, ordinary) = call(
        &app,
        "POST",
        "/api/v1/tokens",
        json!({"request_id":key,"name":"Ordinary","expires_hours":1}),
        &c,
        &t,
    )
    .await;
    assert_ne!(ordinary["record"]["id"], first["record"]["id"]);
    call(
        &app,
        "POST",
        &format!("/api/v1/tokens/requests/{key}/cancel"),
        json!({}),
        &c,
        &t,
    )
    .await;
    assert_eq!(read(&app, id, &key, &c).await.1["record"]["revoked"], false);
}
#[tokio::test]
async fn queued_live_authorization_rechecked_before_create_lookup_and_cancel() {
    let (_temp, s, app, ids, _, _) = fixture().await;
    for action in ["create", "lookup", "cancel"] {
        let (uid, c, t) = actor(&s, "admin").await;
        let guard = s.writer.lock().await;
        let app2 = app.clone();
        let id = ids[0].clone();
        let key = db::id();
        let task = tokio::spawn(async move {
            match action {
                "create" => create(&app2, &id, body(&key), &c, &t).await,
                "lookup" => read(&app2, &id, &key, &c).await,
                _ => cancel(&app2, &id, &key, &c, &t).await,
            }
        });
        tokio::task::yield_now().await;
        sqlx::query("UPDATE users SET role='operator' WHERE id=?")
            .bind(uid)
            .execute(&s.pool)
            .await
            .unwrap();
        let stable = snapshot(&s).await;
        drop(guard);
        assert_eq!(task.await.unwrap().0, StatusCode::FORBIDDEN);
        assert_eq!(snapshot(&s).await, stable)
    }
}
#[tokio::test]
async fn issuance_and_cancellation_audit_registry_faults_roll_back_all_effects() {
    for sql in [
        "CREATE TRIGGER fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.recovery_authorize' BEGIN SELECT RAISE(ABORT,'audit fault'); END",
        "CREATE TRIGGER fault BEFORE INSERT ON device_recovery_requests BEGIN SELECT RAISE(ABORT,'mapping fault'); END",
    ] {
        let (_temp, s, app, ids, c, t) = fixture().await;
        sqlx::query(sql).execute(&s.pool).await.unwrap();
        let stable = snapshot(&s).await;
        assert_eq!(
            create(&app, &ids[0], body(&db::id()), &c, &t).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&s).await, stable)
    }
    for created in [true, false] {
        for sql in [
            "CREATE TRIGGER fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.recovery_request.cancel' BEGIN SELECT RAISE(ABORT,'audit fault'); END",
            "CREATE TRIGGER fault BEFORE INSERT ON device_recovery_requests BEGIN SELECT RAISE(ABORT,'mapping fault'); END",
        ] {
            let (_temp, s, app, ids, c, t) = fixture().await;
            let key = db::id();
            if created {
                create(&app, &ids[0], body(&key), &c, &t).await;
            }
            sqlx::query(sql).execute(&s.pool).await.unwrap();
            let stable = snapshot(&s).await;
            assert_eq!(
                cancel(&app, &ids[0], &key, &c, &t).await.0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(snapshot(&s).await, stable)
        }
    }
}
#[tokio::test]
async fn missing_token_is_never_recreated_and_source_deletion_does_not_hide_status() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let key = db::id();
    let (_, first) = create(&app, id, body(&key), &c, &t).await;
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(read(&app, id, &key, &c).await.1["record"], first["record"]);
    assert_eq!(
        create(&app, id, body(&key), &c, &t).await.1["record"],
        first["record"]
    );
    sqlx::query("DELETE FROM enrollment_tokens WHERE id=?")
        .bind(first["record"]["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    let (code, error) = read(&app, id, &key, &c).await;
    assert_eq!(code, StatusCode::CONFLICT);
    emit("missing_result", "Error", &error);
    assert_eq!(
        create(&app, id, body(&key), &c, &t).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, stable);
    let (code, closed) = cancel(&app, id, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(closed["record"], Value::Null);
    assert_eq!(closed["state"], "cancelled");
    assert_eq!(create(&app, id, body(&key), &c, &t).await.1, closed);
}
#[tokio::test]
async fn strict_bodies_duplicates_queries_and_uuids_cannot_bypass_canonical_route() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let stable = snapshot(&s).await;
    for v in [
        Value::Null,
        json!([]),
        json!({"unknown":true}),
        json!({"request_id":null}),
        json!({"request_id":db::id()}),
        json!({"expected_name":"fixture-0"}),
        json!({"request_id":db::id(),"expected_name":""}),
        json!({"request_id":db::id(),"expected_name":"a".repeat(101)}),
        json!({"request_id":db::id(),"expected_name":"a\u{0}b"}),
        json!({"request_id":db::id(),"expected_name":1}),
        json!({"request_id":db::id().replace("-",""),"expected_name":"fixture-0"}),
    ] {
        let (code, error) = create(&app, id, v, &c, &t).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{error}");
        emit("invalid_input", "Error", &error)
    }
    let raw = format!(
        r#"{{"request_id":"{}","expected_name":"fixture-0","expected_\u006eame":"fixture-1"}}"#,
        db::id()
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/devices/{id}/recover"))
                .header("content-type", "application/json")
                .header("cookie", &c)
                .header("x-csrf-token", &t)
                .body(Body::from(raw))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    for suffix in ["?unknown=1", "?x=1&x=2", "?x=%FF", "?x=%GG"] {
        let key = db::id();
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{}{suffix}", lookup(id, &key)),
                Value::Null,
                &c,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{}/cancel{suffix}", lookup(id, &key)),
                json!({}),
                &c,
                &t
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("/api/v1/devices/{id}/recover{suffix}"),
                body(&key),
                &c,
                &t
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        )
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/%64evices/{id}/recover"),
            json!({}),
            &c,
            &t
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for bad in ["bad".to_owned(), db::id().replace("-", "")] {
        assert_eq!(read(&app, id, &bad, &c).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(
            cancel(&app, id, &bad, &c, &t).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            create(&app, &bad, body(&db::id()), &c, &t).await.0,
            StatusCode::BAD_REQUEST
        )
    }
    for v in [Value::Null, json!([]), json!({"expected_name":"fixture-0"})] {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{}/cancel", lookup(id, &db::id())),
                v,
                &c,
                &t
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        )
    }
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn legacy_creation_compatibility_and_migration_do_not_invent_request_keys() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let id = &ids[0];
    let (code, a) = create(&app, id, json!({}), &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    let (code, b) = create(&app, id, json!({}), &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_ne!(a["record"]["id"], b["record"]["id"]);
    assert_eq!(a.as_object().unwrap().len(), 2);
    emit("legacy", "TokenCreated", &a);
    let before = snapshot(&s).await;
    sqlx::query("DROP TABLE device_recovery_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=22")
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
    assert_eq!(read(&app, id, &db::id(), &c).await.1["found"], false);
    assert_eq!(audits(&s, "device.recovery_authorize").await, 2);
}
