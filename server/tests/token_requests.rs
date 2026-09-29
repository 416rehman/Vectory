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

fn body(key: Option<&str>) -> Value {
    let mut v = json!({"name":"Synthetic enrollment request","expires_hours":24,"max_uses":2,"name_prefix":"synthetic-"});
    if let Some(key) = key {
        v["request_id"] = json!(key)
    }
    v
}
fn lookup(key: &str) -> String {
    format!("/api/v1/tokens/requests/{key}")
}
async fn create(app: &Router, v: Value, c: &str, t: &str) -> (StatusCode, Value) {
    call(app, "POST", "/api/v1/tokens", v, c, t).await
}
async fn cancel(app: &Router, key: &str, c: &str, t: &str) -> (StatusCode, Value) {
    call(
        app,
        "POST",
        &format!("{}/cancel", lookup(key)),
        json!({}),
        c,
        t,
    )
    .await
}
async fn read(app: &Router, key: &str, c: &str) -> (StatusCode, Value) {
    call(app, "GET", &lookup(key), Value::Null, c, "").await
}
fn emit(name: &str, schema: &str, v: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_TOKEN_REQUEST_FIXTURES") {
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
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,payload_sha256,token_id,state,created_at,cancelled_at) FROM token_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let tokens: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(id,verifier,data) FROM enrollment_tokens ORDER BY id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,revoked,desired_generation,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let sessions: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(verifier,user_id,csrf,expires_at) FROM sessions ORDER BY verifier",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    json!({"records":records,"requests":requests,"tokens":tokens,"devices":devices,"sessions":sessions})
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
async fn one_time_receipt_replay_and_lookup_never_persist_or_redisplay_secret() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let before = snapshot(&s).await;
    let (code, absent) = read(&app, &key, &c).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        absent,
        json!({"request_id":key,"request_correlation":true,"found":false})
    );
    assert_eq!(before, snapshot(&s).await);
    emit("lookup_absent", "TokenRequestStatus", &absent);
    let req = body(Some(&key));
    let (code, receipt) = create(&app, req.clone(), &c, &t).await;
    assert_eq!(code, StatusCode::OK, "{receipt}");
    assert_eq!(receipt.as_object().unwrap().len(), 4);
    assert_eq!(receipt["request_id"], key);
    assert_eq!(receipt["request_correlation"], true);
    let secret = receipt["token"].as_str().unwrap();
    assert_eq!(secret.len(), 64);
    let stable = snapshot(&s).await;
    assert!(!stable.to_string().contains(secret));
    assert_eq!(stable["devices"], before["devices"]);
    assert_eq!(stable["sessions"], before["sessions"]);
    let verifier: String = sqlx::query_scalar("SELECT verifier FROM enrollment_tokens")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(verifier, db::hash(secret));
    let stored: String = sqlx::query_scalar("SELECT data FROM enrollment_tokens")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!stored.contains("request_id"));
    assert!(!stored.contains("request_correlation"));
    let mut upper = req.clone();
    upper["request_id"] = json!(key.to_uppercase());
    let (code, replay) = create(&app, upper, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert!(replay.get("token").is_none());
    assert_eq!(
        replay,
        json!({"request_id":key,"request_correlation":true,"found":true,"state":"created","record":receipt["record"]})
    );
    assert_eq!(read(&app, &key.to_uppercase(), &c).await.1, replay);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "token.create").await, 1);
    emit("created_receipt", "TokenCreateReceipt", &receipt);
    emit("created_lookup", "TokenRequestStatus", &replay);
    // Expiry and use counts are current record state, not permission to reissue.
    sqlx::query("UPDATE enrollment_tokens SET data=json_set(data,'$.expires_at','2000-01-01T00:00:00Z','$.uses',2,'$.private_extension','PRIVATE_MARKER')").execute(&s.pool).await.unwrap();
    let current = create(&app, req, &c, &t).await.1;
    assert_eq!(current["record"]["uses"], 2);
    assert!(!current.to_string().contains("PRIVATE_MARKER"));
    assert!(current.get("token").is_none());
    assert_eq!(audits(&s, "token.create").await, 1);
}
#[tokio::test]
async fn cancel_before_create_is_durable_even_for_late_original_and_repeat() {
    let (temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let initial = snapshot(&s).await;
    let (code, closed) = cancel(&app, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        closed,
        json!({"request_id":key,"request_correlation":true,"found":true,"state":"cancelled","record":null})
    );
    emit("cancelled_before_create", "TokenRequestStatus", &closed);
    let stable = snapshot(&s).await;
    assert_eq!(stable["devices"], initial["devices"]);
    assert_eq!(stable["sessions"], initial["sessions"]);
    assert_eq!(cancel(&app, &key, &c, &t).await.1, closed);
    assert_eq!(create(&app, body(Some(&key)), &c, &t).await.1, closed);
    assert_eq!(snapshot(&s).await, stable);
    let mut malformed = body(Some(&key));
    malformed["expires_hours"] = json!(0);
    assert_eq!(create(&app, malformed, &c, &t).await.1, closed);
    let settings = s.settings.clone();
    drop(app);
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let app = api::router(s.clone());
    assert_eq!(create(&app, body(Some(&key)), &c, &t).await.1, closed);
    assert_eq!(read(&app, &key, &c).await.1, closed);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "token.create").await, 0);
    assert_eq!(audits(&s, "token.request.cancel").await, 1);
    drop(temp);
}
#[tokio::test]
async fn cancel_after_create_revokes_only_exact_token_and_is_noop_on_repeat() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let req = body(Some(&key));
    let (_, first) = create(&app, req.clone(), &c, &t).await;
    let (_, other) = create(&app, body(None), &c, &t).await;
    let before = snapshot(&s).await;
    let (code, closed) = cancel(&app, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(closed["state"], "cancelled");
    assert_eq!(closed["record"]["id"], first["record"]["id"]);
    assert_eq!(closed["record"]["revoked"], true);
    assert!(closed.get("token").is_none());
    let all = call(&app, "GET", "/api/v1/tokens", Value::Null, &c, "")
        .await
        .1;
    assert_eq!(
        all.as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == other["record"]["id"])
            .unwrap()["revoked"],
        false
    );
    let stable = snapshot(&s).await;
    assert_eq!(stable["devices"], before["devices"]);
    assert_eq!(stable["sessions"], before["sessions"]);
    assert_eq!(cancel(&app, &key, &c, &t).await.1, closed);
    assert_eq!(create(&app, req, &c, &t).await.1, closed);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "token.revoke").await, 1);
    assert_eq!(audits(&s, "token.request.cancel").await, 1);
    emit("cancelled_created", "TokenRequestStatus", &closed);
}
#[tokio::test]
async fn simultaneous_create_create_and_create_cancel_serialize_without_usable_orphans() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let (a, b) = tokio::join!(
        create(&app, body(Some(&key)), &c, &t),
        create(&app, body(Some(&key)), &c, &t)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_ne!(a.1.get("token").is_some(), b.1.get("token").is_some());
    assert_eq!(a.1["record"]["id"], b.1["record"]["id"]);
    assert_eq!(audits(&s, "token.create").await, 1);
    cancel(&app, &key, &c, &t).await;
    for _ in 0..6 {
        let key = db::id();
        let (made, closed) = tokio::join!(
            create(&app, body(Some(&key)), &c, &t),
            cancel(&app, &key, &c, &t)
        );
        assert_eq!(made.0, StatusCode::OK);
        assert_eq!(closed.0, StatusCode::OK);
        assert_eq!(closed.1["state"], "cancelled");
        assert_eq!(read(&app, &key, &c).await.1, closed.1);
        assert_eq!(create(&app, body(Some(&key)), &c, &t).await.1, closed.1);
    }
    let live: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM enrollment_tokens WHERE json_extract(data,'$.revoked')=0",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(live, 0);
}
#[tokio::test]
async fn payload_binding_is_canonical_and_preserves_unknown_null_array_differences() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let mut req = body(Some(&key));
    req["extension"] = json!({"b":[1,2],"a":null});
    create(&app, req.clone(), &c, &t).await;
    let stable = snapshot(&s).await;
    let mut same = req.clone();
    same["extension"] = serde_json::from_str(r#"{"a":null,"b":[1,2]}"#).unwrap();
    assert_eq!(create(&app, same, &c, &t).await.0, StatusCode::OK);
    for patch in [
        json!({"name":"Other"}),
        json!({"expires_hours":25}),
        json!({"max_uses":null}),
        json!({"name_prefix":null}),
        json!({"extension":{"a":null,"b":[2,1]}}),
        json!({"extra":null}),
    ] {
        let mut changed = req.clone();
        for (k, v) in patch.as_object().unwrap() {
            changed[k] = v.clone()
        }
        let (code, error) = create(&app, changed, &c, &t).await;
        assert_eq!(code, StatusCode::CONFLICT);
        assert_eq!(error["error"]["code"], "IDEMPOTENCY_CONFLICT");
        emit("payload_conflict", "Error", &error)
    }
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn missing_original_never_recreates_and_can_be_closed_without_secret() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let req = body(Some(&key));
    let (_, first) = create(&app, req.clone(), &c, &t).await;
    sqlx::query("DELETE FROM enrollment_tokens WHERE id=?")
        .bind(first["record"]["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    assert_eq!(read(&app, &key, &c).await.0, StatusCode::CONFLICT);
    assert_eq!(
        create(&app, req.clone(), &c, &t).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&s).await, stable);
    let (code, closed) = cancel(&app, &key, &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(closed["record"], Value::Null);
    assert_eq!(closed["state"], "cancelled");
    assert_eq!(create(&app, req, &c, &t).await.1, closed);
}
#[tokio::test]
async fn legacy_unkeyed_creation_and_ordinary_revoke_remain_compatible() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let (_, a) = create(&app, body(None), &c, &t).await;
    let (_, b) = create(&app, body(None), &c, &t).await;
    assert_ne!(a["record"]["id"], b["record"]["id"]);
    assert_ne!(a["token"], b["token"]);
    assert_eq!(a.as_object().unwrap().len(), 2);
    let path = format!(
        "/api/v1/tokens/{}/revoke",
        a["record"]["id"].as_str().unwrap()
    );
    assert_eq!(
        call(&app, "POST", &path, json!({}), &c, &t).await.1,
        json!({"ok":true})
    );
    assert_eq!(
        call(&app, "POST", &path, json!({}), &c, &t).await.0,
        StatusCode::OK
    );
    assert_eq!(audits(&s, "token.revoke").await, 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM token_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
    let key = db::id();
    let (_, keyed) = create(&app, body(Some(&key)), &c, &t).await;
    call(
        &app,
        "POST",
        &format!(
            "/api/v1/tokens/{}/revoke",
            keyed["record"]["id"].as_str().unwrap()
        ),
        json!({}),
        &c,
        &t,
    )
    .await;
    let found = read(&app, &key, &c).await.1;
    assert_eq!(found["state"], "created");
    assert_eq!(found["record"]["revoked"], true);
    cancel(&app, &key, &c, &t).await;
    assert_eq!(audits(&s, "token.revoke").await, 3);
}
#[tokio::test]
async fn create_audit_mapping_and_cancel_failures_roll_back_every_write() {
    for sql in [
        "CREATE TRIGGER fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='token.create' BEGIN SELECT RAISE(ABORT,'audit fault'); END",
        "CREATE TRIGGER fault BEFORE INSERT ON token_requests BEGIN SELECT RAISE(ABORT,'mapping fault'); END",
    ] {
        let (_temp, s, app, _, c, t) = fixture().await;
        sqlx::query(sql).execute(&s.pool).await.unwrap();
        let stable = snapshot(&s).await;
        assert_eq!(
            create(&app, body(Some(&db::id())), &c, &t).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&s).await, stable);
    }
    for created in [false, true] {
        for sql in [
            "CREATE TRIGGER fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='token.request.cancel' BEGIN SELECT RAISE(ABORT,'cancel audit fault'); END",
            "CREATE TRIGGER fault BEFORE INSERT ON token_requests BEGIN SELECT RAISE(ABORT,'cancel mapping fault'); END",
        ] {
            let (_temp, s, app, _, c, t) = fixture().await;
            let key = db::id();
            if created {
                create(&app, body(Some(&key)), &c, &t).await;
            }
            sqlx::query(sql).execute(&s.pool).await.unwrap();
            let stable = snapshot(&s).await;
            assert_eq!(
                cancel(&app, &key, &c, &t).await.0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(snapshot(&s).await, stable);
        }
    }
}
#[tokio::test]
async fn actor_scoping_live_roles_sessions_and_csrf_apply_to_lookup_replay_cancel() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let (_, original) = create(&app, body(Some(&key)), &c, &t).await;
    let (_, other, csrf) = actor(&s, "operator").await;
    assert_eq!(read(&app, &key, &other).await.1["found"], false);
    let (_, closed) = cancel(&app, &key, &other, &csrf).await;
    assert_eq!(closed["record"], Value::Null);
    assert_eq!(read(&app, &key, &c).await.1["record"], original["record"]);
    for role in ["viewer", "editor"] {
        let (_, user, token) = actor(&s, role).await;
        for (method, path, v) in [
            ("GET", lookup(&key), Value::Null),
            ("POST", format!("{}/cancel", lookup(&key)), json!({})),
            ("POST", "/api/v1/tokens".into(), body(Some(&key))),
        ] {
            assert_eq!(
                call(&app, method, &path, v, &user, &token).await.0,
                StatusCode::FORBIDDEN
            )
        }
    }
    for user in ["", &c] {
        let expected = if user.is_empty() {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::FORBIDDEN
        };
        assert_eq!(create(&app, body(Some(&key)), user, "").await.0, expected);
        assert_eq!(cancel(&app, &key, user, "").await.0, expected)
    }
    for method in ["GET", "POST"] {
        let (uid, user, token) = actor(&s, "operator").await;
        let guard = s.writer.lock().await;
        let app2 = app.clone();
        let key2 = key.clone();
        let task = tokio::spawn(async move {
            if method == "GET" {
                read(&app2, &key2, &user).await
            } else {
                cancel(&app2, &key2, &user, &token).await
            }
        });
        tokio::task::yield_now().await;
        sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
            .bind(uid)
            .execute(&s.pool)
            .await
            .unwrap();
        let stable = snapshot(&s).await;
        drop(guard);
        assert_eq!(task.await.unwrap().0, StatusCode::FORBIDDEN);
        assert_eq!(snapshot(&s).await, stable);
    }
    let (uid, user, token) = actor(&s, "operator").await;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(uid)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        create(&app, body(Some(&key)), &user, &token).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(read(&app, &key, &user).await.0, StatusCode::UNAUTHORIZED);
}
#[tokio::test]
async fn strict_json_query_identity_and_bounds_fail_without_effects() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let stable = snapshot(&s).await;
    for raw in [
        r#"{"name":"a","name":"b","expires_hours":1}"#,
        r#"{"name":"a","expires_hours":1,"unknown":{"x":1,"\u0078":2}}"#,
        r#"{"name":"a","expires_hours":1,"request_id":null}"#,
        r#"null"#,
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/tokens")
                    .header("content-type", "application/json")
                    .header("cookie", &c)
                    .header("x-csrf-token", &t)
                    .body(Body::from(raw))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST)
    }
    for patch in [
        json!({"expires_hours":0}),
        json!({"expires_hours":721}),
        json!({"expires_hours":1.5}),
        json!({"max_uses":0}),
        json!({"max_uses":100001}),
        json!({"max_uses":"1"}),
        json!({"name":""}),
        json!({"name":"x".repeat(121)}),
        json!({"name":"a\u{0}b"}),
        json!({"name_prefix":"UPPER"}),
        json!({"name_prefix":1}),
        json!({"name_prefix":"a".repeat(81)}),
        json!({"request_id":null}),
        json!({"request_id":db::id().replace("-","")}),
    ] {
        let mut req = body(Some(&db::id()));
        for (k, v) in patch.as_object().unwrap() {
            req[k] = v.clone()
        }
        let (code, error) = create(&app, req, &c, &t).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{error}");
        emit("invalid_input", "Error", &error)
    }
    for path in ["/api/v1/%74okens", "/api/v1/tokens?unknown=1"] {
        assert_eq!(
            call(&app, "POST", path, body(None), &c, &t).await.0,
            StatusCode::BAD_REQUEST
        )
    }
    for suffix in ["?unknown=1", "?a=1&a=2", "?actor_id=x", "?x=%FF", "?x=%GG"] {
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
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{}/cancel{suffix}", lookup(&db::id())),
                json!({}),
                &c,
                &t
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        )
    }
    for v in [Value::Null, json!([]), json!({"request_id":db::id()})] {
        assert_eq!(
            call(
                &app,
                "POST",
                &format!("{}/cancel", lookup(&db::id())),
                v,
                &c,
                &t
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        )
    }
    for key in ["bad".to_owned(), db::id().replace("-", "")] {
        assert_eq!(read(&app, &key, &c).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(cancel(&app, &key, &c, &t).await.0, StatusCode::BAD_REQUEST)
    }
    assert_eq!(snapshot(&s).await, stable);
}

#[tokio::test]
async fn cancellation_blocks_new_enrollment_and_replay_without_revoking_issued_identity() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let key = db::id();
    let (_, receipt) = create(&app, body(Some(&key)), &c, &t).await;
    let device_api = vectory_server::device::router(s.clone());
    let pair = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&pair)
        .unwrap()
        .pem()
        .unwrap();
    let mut request = json!({"protocol_version":1,"request_id":"synthetic-token-cancel-enrollment","token":receipt["token"],"name":"synthetic-device","csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"});
    let (code, enrolled) = call(
        &device_api,
        "POST",
        "/agent/v1/enroll",
        request.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{enrolled}");
    let before = snapshot(&s).await;
    let credentials: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT fingerprint,device_id,revoked FROM credentials ORDER BY fingerprint",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(credentials.len(), 1);
    assert_eq!(cancel(&app, &key, &c, &t).await.0, StatusCode::OK);
    assert_eq!(
        call(
            &device_api,
            "POST",
            "/agent/v1/enroll",
            request.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    request["request_id"] = json!("different-enrollment");
    request["name"] = json!("synthetic-other");
    assert_eq!(
        call(&device_api, "POST", "/agent/v1/enroll", request, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(snapshot(&s).await["devices"], before["devices"]);
    assert_eq!(snapshot(&s).await["sessions"], before["sessions"]);
    assert_eq!(
        sqlx::query_as::<_, (String, String, i64)>(
            "SELECT fingerprint,device_id,revoked FROM credentials ORDER BY fingerprint"
        )
        .fetch_all(&s.pool)
        .await
        .unwrap(),
        credentials
    );
}

#[tokio::test]
async fn migration_adds_empty_registry_without_inventing_request_identity() {
    let (_temp, s, app, _, c, t) = fixture().await;
    let (_, legacy) = create(&app, body(None), &c, &t).await;
    let before = snapshot(&s).await;
    sqlx::query("DROP TABLE token_requests")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version=21")
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
    let list = call(&app, "GET", "/api/v1/tokens", Value::Null, &c, "")
        .await
        .1;
    assert_eq!(list, json!([legacy["record"]]));
    let key = db::id();
    assert_eq!(read(&app, &key, &c).await.1["found"], false);
    assert_eq!(
        create(&app, body(Some(&key)), &c, &t).await.0,
        StatusCode::OK
    );
}
