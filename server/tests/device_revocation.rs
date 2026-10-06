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

fn emit(name: &str, schema: &str, v: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_DEVICE_REVOCATION_FIXTURES") {
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
    let targets:Vec<String>=sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation,previous_version_id,released_at,verified_at,error,original) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"targets":targets,"records":records,"requests":requests,"tokens":tokens,"devices":devices,"credentials":credentials,"sessions":sessions})
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

fn path(id: &str) -> String {
    format!("/api/v1/devices/{id}/revoke")
}
fn status_path(id: &str) -> String {
    format!("/api/v1/devices/{id}/revocation")
}
async fn revoke(app: &Router, id: &str, c: &str, t: &str) -> (StatusCode, Value) {
    call(app, "POST", &path(id), json!({}), c, t).await
}
async fn read(app: &Router, id: &str, c: &str) -> (StatusCode, Value) {
    call(app, "GET", &status_path(id), Value::Null, c, "").await
}
async fn seeded(s: &State, ids: &[String]) -> (String, Vec<(String, String, String)>) {
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)")
            .bind(format!("{i:064x}"))
            .bind(id)
            .bind("2099-01-01T00:00:00Z")
            .bind(s.keys.active_signing_id())
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let group = db::id();
    let v = json!({"id":group,"name":"Synthetic group","description":"","device_ids":[ids[0],ids[1]],"revision":7,"created_at":db::now()});
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, "group", &v).await.unwrap();
    let mut targets = Vec::new();
    for (mode, state) in [
        ("persistent", "active"),
        ("persistent", "paused"),
        ("persistent", "completed"),
        ("persistent", "failed"),
        ("persistent", "cancelled"),
        ("snapshot", "active"),
        ("snapshot", "completed"),
    ] {
        let id = db::id();
        let d = json!({"id":id,"name":"Historical evidence","status":state,"target_mode":mode,"created_at":db::now()});
        db::insert(&mut conn, "deployment", &d).await.unwrap();
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,previous_version_id,released_at,verified_at,error,original) VALUES(?,?,'verified',7,'old-version','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z','Historical reason',1)").bind(&id).bind(&ids[0]).execute(&mut *conn).await.unwrap();
        targets.push((id, mode.into(), state.into()));
    }
    (group, targets)
}
#[tokio::test]
async fn exact_transition_preserves_history_and_repeated_revoke_writes_nothing() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let (group, targets) = seeded(&s, &ids).await;
    let before = snapshot(&s).await;
    let (code, initial) = read(&app, &ids[0].to_uppercase(), &c).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        initial,
        json!({"device_id":ids[0],"revocation_status":true,"revoked":false})
    );
    assert_eq!(snapshot(&s).await, before);
    emit("active", "DeviceRevocationStatus", &initial);
    let (code, receipt) = revoke(&app, &ids[0].to_uppercase(), &c, &t).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(
        receipt,
        json!({"device_id":ids[0],"revocation_status":true,"revoked":true,"ok":true})
    );
    emit("receipt", "DeviceRevocationReceipt", &receipt);
    let group: Value = db::parse(
        &sqlx::query_scalar::<_, String>("SELECT data FROM records WHERE kind='group' AND id=?")
            .bind(group)
            .fetch_one(&s.pool)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(group["device_ids"], json!([ids[1]]));
    assert_eq!(group["revision"], 8);
    for (dep, mode, state) in targets {
        let row:(String,i64,String,String,String,String,i64)=sqlx::query_as("SELECT state,generation,previous_version_id,released_at,verified_at,error,original FROM deployment_targets WHERE deployment_id=?").bind(dep).fetch_one(&s.pool).await.unwrap();
        assert_eq!(
            row.0,
            if mode == "persistent" && ["active", "paused", "completed"].contains(&state.as_str()) {
                "removed"
            } else {
                "verified"
            }
        );
        assert_eq!(
            (row.1, row.2, row.3, row.4, row.5, row.6),
            (
                7,
                "old-version".into(),
                "2026-01-01T00:00:00Z".into(),
                "2026-01-01T00:00:01Z".into(),
                "Historical reason".into(),
                1
            )
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT revoked FROM credentials WHERE device_id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT revoked FROM credentials WHERE device_id=?")
            .bind(&ids[1])
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
    let stable = snapshot(&s).await;
    assert_eq!(revoke(&app, &ids[0], &c, &t).await.1, receipt);
    let current = read(&app, &ids[0], &c).await.1;
    emit("revoked", "DeviceRevocationStatus", &current);
    assert_eq!(current["revoked"], true);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "device.revoke").await, 1);
    for k in ["sessions", "tokens", "requests"] {
        assert_eq!(stable[k], before[k]);
    }
}
#[tokio::test]
async fn simultaneous_revocations_and_restart_have_one_transition_audit() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    seeded(&s, &ids).await;
    let (a, b) = tokio::join!(revoke(&app, &ids[0], &c, &t), revoke(&app, &ids[0], &c, &t));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a, b);
    assert_eq!(audits(&s, "device.revoke").await, 1);
    let stable = snapshot(&s).await;
    let settings = s.settings.clone();
    drop(app);
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    let app = api::router(s.clone());
    assert_eq!(read(&app, &ids[0], &c).await.1["revoked"], true);
    assert_eq!(revoke(&app, &ids[0], &c, &t).await, a);
    assert_eq!(snapshot(&s).await, stable);
}
#[tokio::test]
async fn operator_admin_and_csrf_roles_apply_to_status_and_repeat() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    for role in ["viewer", "editor"] {
        let (_, cookie, csrf) = actor(&s, role).await;
        let stable = snapshot(&s).await;
        assert_eq!(read(&app, &ids[0], &cookie).await.0, StatusCode::FORBIDDEN);
        assert_eq!(
            revoke(&app, &ids[0], &cookie, &csrf).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(snapshot(&s).await, stable);
    }
    let stable = snapshot(&s).await;
    assert_eq!(read(&app, &ids[0], "").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(revoke(&app, &ids[0], &c, "").await.0, StatusCode::FORBIDDEN);
    assert_eq!(snapshot(&s).await, stable);
    let (_, op, csrf) = actor(&s, "operator").await;
    assert_eq!(read(&app, &ids[0], &op).await.0, StatusCode::OK);
    assert_eq!(revoke(&app, &ids[0], &op, &csrf).await.0, StatusCode::OK);
    assert_eq!(revoke(&app, &ids[0], &c, &t).await.0, StatusCode::OK);
    assert_eq!(audits(&s, "device.revoke").await, 1);
}
#[tokio::test]
async fn queued_reads_and_writes_recheck_live_role_under_writer() {
    for method in ["GET", "POST"] {
        let (_temp, s, app, ids, _, _) = fixture().await;
        let (actor, c, t) = actor(&s, "operator").await;
        let guard = s.writer.lock().await;
        let p = if method == "GET" {
            status_path(&ids[0])
        } else {
            path(&ids[0])
        };
        let job = tokio::spawn(async move { call(&app, method, &p, json!({}), &c, &t).await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
            .bind(actor)
            .execute(&s.pool)
            .await
            .unwrap();
        let stable = snapshot(&s).await;
        drop(guard);
        assert_eq!(job.await.unwrap().0, StatusCode::FORBIDDEN);
        assert_eq!(snapshot(&s).await, stable);
    }
}
#[tokio::test]
async fn late_audit_or_cleanup_failure_rolls_every_revocation_effect_back() {
    for fault in [
        "CREATE TRIGGER refuse BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.revoke' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;",
        "CREATE TRIGGER refuse BEFORE UPDATE ON deployment_targets BEGIN SELECT RAISE(ABORT,'synthetic target failure'); END;",
        "CREATE TRIGGER refuse BEFORE UPDATE ON records WHEN OLD.kind='group' BEGIN SELECT RAISE(ABORT,'synthetic group failure'); END;",
    ] {
        let (_temp, s, app, ids, c, t) = fixture().await;
        seeded(&s, &ids).await;
        sqlx::query(fault).execute(&s.pool).await.unwrap();
        let before = snapshot(&s).await;
        assert_eq!(
            revoke(&app, &ids[0], &c, &t).await.0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(snapshot(&s).await, before);
        assert_eq!(read(&app, &ids[0], &c).await.1["revoked"], false);
    }
}
#[tokio::test]
async fn strict_body_query_identity_and_canonical_route_guard() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let stable = snapshot(&s).await;
    for v in [
        Value::Null,
        json!([]),
        json!({"request_id":db::id()}),
        json!({"device_id":ids[1]}),
        json!({"revoked":false}),
    ] {
        assert_eq!(
            call(&app, "POST", &path(&ids[0]), v, &c, &t).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    for id in ["bad".to_owned(), ids[0].replace("-", "")] {
        assert_eq!(read(&app, &id, &c).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(revoke(&app, &id, &c, &t).await.0, StatusCode::BAD_REQUEST);
    }
    for query in ["?x=1", "?x=1&x=2", "?x=%FF"] {
        assert_eq!(
            call(
                &app,
                "GET",
                &(status_path(&ids[0]) + query),
                Value::Null,
                &c,
                ""
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            call(&app, "POST", &(path(&ids[0]) + query), json!({}), &c, &t)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    for route in [
        format!("/api/v1/%64evices/{}/revoke", ids[0]),
        format!("/api/v1/devices/{}/%72evoke", ids[0]),
    ] {
        assert_eq!(
            call(&app, "POST", &route, json!({}), &c, &t).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let raw = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path(&ids[0]))
                .header("content-type", "application/json")
                .header("cookie", &c)
                .header("x-csrf-token", &t)
                .body(Body::from("{\"a\":1,\"\\u0061\":2}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::BAD_REQUEST);
    let (code, error) = read(&app, &db::id(), &c).await;
    assert_eq!(code, StatusCode::NOT_FOUND);
    emit("missing", "Error", &error);
    assert_eq!(
        revoke(&app, &db::id(), &c, &t).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(snapshot(&s).await, stable);
    // Existing clients may omit the body and still consume the preserved ok field.
    let raw = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path(&ids[0]))
                .header("cookie", &c)
                .header("x-csrf-token", &t)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(raw.status(), StatusCode::OK);
}
#[tokio::test]
async fn revoked_retired_source_does_not_touch_replacement_identity() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let (_, token) = call(
        &app,
        "POST",
        &format!("/api/v1/devices/{}/recover", ids[0]),
        json!({}),
        &c,
        &t,
    )
    .await;
    let pair = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&pair)
        .unwrap()
        .pem()
        .unwrap();
    let agent = vectory_server::device::router(s.clone());
    let(code,replacement)=call(&agent,"POST","/agent/v1/enroll",json!({"protocol_version":1,"request_id":"revocation-fixture-recovery","token":token["token"],"name":"fixture-0","csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"}),"","").await;
    assert_eq!(code, StatusCode::OK);
    let stable = snapshot(&s).await;
    let receipt = revoke(&app, &ids[0], &c, &t).await;
    assert_eq!(receipt.0, StatusCode::OK);
    assert_eq!(receipt.1["device_id"], ids[0]);
    assert_eq!(snapshot(&s).await, stable);
    assert_eq!(audits(&s, "device.revoke").await, 0);
    assert_eq!(
        read(&app, replacement["device_id"].as_str().unwrap(), &c)
            .await
            .1["revoked"],
        false
    );
}
#[tokio::test]
async fn exact_status_is_bounded_and_does_not_depend_on_device_projection() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    sqlx::query("UPDATE devices SET data='[]' WHERE id=?")
        .bind(&ids[1])
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    assert_eq!(
        read(&app, &ids[0], &c).await.1,
        json!({"device_id":ids[0],"revocation_status":true,"revoked":false})
    );
    assert_eq!(snapshot(&s).await, stable);
    let plan: Vec<(i64, i64, i64, String)> =
        sqlx::query_as("EXPLAIN QUERY PLAN SELECT revoked FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert!(
        plan.iter()
            .any(|row| row.3.contains("SEARCH devices USING INDEX"))
    );
    assert_eq!(revoke(&app, &ids[0], &c, &t).await.0, StatusCode::OK);
}
#[tokio::test]
async fn renewal_and_revocation_serialize_and_no_current_credential_survives() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    seeded(&s, &ids).await;
    let pair = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&pair)
        .unwrap()
        .pem()
        .unwrap();
    let agent = vectory_server::device::router(s.clone()).layer(axum::Extension(
        vectory_server::device::PeerCertificate(Some(format!("{:064x}", 0))),
    ));
    let (a, b) = tokio::join!(
        revoke(&app, &ids[0], &c, &t),
        call(
            &agent,
            "POST",
            "/agent/v1/renew",
            json!({"csr_pem":csr}),
            "",
            ""
        )
    );
    assert_eq!(a.0, StatusCode::OK);
    assert!([StatusCode::OK, StatusCode::UNAUTHORIZED].contains(&b.0));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM credentials WHERE device_id=? AND revoked=0"
        )
        .bind(&ids[0])
        .fetch_one(&s.pool)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/renew",
            json!({"csr_pem":csr}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(audits(&s, "device.revoke").await, 1);
}
#[tokio::test]
async fn revocation_resolves_the_devices_open_issues_and_overview_stops_counting_them() {
    let (_temp, s, app, ids, c, t) = fixture().await;
    let issue = |device: &str, code: &str, stage: &str, acknowledged: bool| json!({"id":db::hash(format!("{device}:{code}")),"device_id":device,"code":code,"stage":stage,"count":1,"reports":1,"first_seen":db::now(),"last_seen":db::now(),"resolved":false,"acknowledged":acknowledged,"revision":1});
    let revoked = &ids[0];
    let mut conn = s.pool.acquire().await.unwrap();
    for record in [
        issue(revoked, "VALIDATION_FAILED", "validate", false),
        issue(revoked, "DATA_PLANE_SINK_ERRORS", "delivery", false),
        issue(revoked, "APPLY_FAILED", "apply", true),
        issue(&ids[1], "VALIDATION_FAILED", "validate", false),
    ] {
        db::insert(&mut conn, "issue", &record).await.unwrap();
    }
    sqlx::query("INSERT INTO data_plane_state(device_id,data) VALUES(?,'{}')")
        .bind(revoked)
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.data_plane',json('{\"version_id\":\"v\",\"evaluations\":3,\"issues\":[]}')) WHERE id=?")
        .bind(revoked)
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let (code, before) = call(&app, "GET", "/api/v1/overview", Value::Null, &c, &t).await;
    assert_eq!(code, StatusCode::OK, "{before}");
    assert_eq!(before["issues_open"], 3, "acknowledged issues never count");

    assert_eq!(revoke(&app, revoked, &c, &t).await.0, StatusCode::OK);
    let (_, after) = call(&app, "GET", "/api/v1/overview", Value::Null, &c, &t).await;
    assert_eq!(
        after["issues_open"], 1,
        "only the live device's issue is open"
    );
    let (code, resolved) = call(
        &app,
        "GET",
        &format!("/api/v1/issues/history?state=resolved&device_id={revoked}"),
        Value::Null,
        &c,
        &t,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["total"], 3, "{resolved}");
    for item in resolved["items"].as_array().unwrap() {
        assert_eq!(item["resolved_reason"], "revoked", "{item}");
        assert_eq!(item["revision"], 2, "{item}");
        assert_eq!(item["device_revoked"], true, "{item}");
    }
    let (_, open) = call(
        &app,
        "GET",
        "/api/v1/issues/history?state=open",
        Value::Null,
        &c,
        &t,
    )
    .await;
    assert_eq!(open["total"], 1, "{open}");
    assert_eq!(open["items"][0]["device_id"], ids[1].as_str());
    // Nothing is left to evaluate for an identity that can't check in.
    let state: i64 = sqlx::query_scalar("SELECT count(*) FROM data_plane_state WHERE device_id=?")
        .bind(revoked)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(state, 0);
    let summary: Option<String> =
        sqlx::query_scalar("SELECT json_extract(data,'$.data_plane') FROM devices WHERE id=?")
            .bind(revoked)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(summary, None);
}
