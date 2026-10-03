use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize};

#[derive(Clone)]
struct Actor {
    id: String,
    cookie: String,
    csrf: String,
}
async fn actor(s: &State, role: &str) -> Actor {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Original {role}"))
    .bind(role)
    .bind("unused-test-login")
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
    Actor {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn fixture() -> (tempfile::TempDir, State, Router, Actor) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-test-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Issue tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = actor(&s, "admin").await;
    (temp, s.clone(), api::router(s), admin)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    actor: Option<&Actor>,
    csrf: bool,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(actor) = actor {
        request = request.header("cookie", &actor.cookie);
        if csrf {
            request = request.header("x-csrf-token", &actor.csrf);
        }
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn get(app: &Router, path: &str, actor: &Actor) -> Value {
    let (status, value) = call(app, "GET", path, Value::Null, Some(actor), false).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}
async fn insert(s: &State, kind: &str, value: &Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, kind, value).await.unwrap();
}
async fn device_record(s: &State, n: u64, name: &str, revoked: bool) -> String {
    let id = format!("10000000-0000-4000-8000-{n:012}");
    sqlx::query("INSERT INTO devices(id,name,data,revoked,desired_generation,policy_generation) VALUES(?,?,?,?,7,4)").bind(&id).bind(name).bind(json!({"id":id,"name":"UNTRUSTED_JSON_NAME","private":"PRIVATE_DEVICE","apply_state":"failed","reported_generation":3,"configuration_mode":"restricted"}).to_string()).bind(revoked).execute(&s.pool).await.unwrap();
    id
}
fn issue(n: u64, device: &str) -> Value {
    json!({"id":db::hash(format!("issue-{n}")),"device_id":device,"code":"APPLY_FAILED","stage":"apply","message":"PRIVATE_DIAGNOSTIC","count":3,"first_seen":"2026-01-01T00:00:00Z","last_seen":"2026-01-02T00:00:00Z","desired_version_id":null,"resolved":false})
}
fn path(issue: &Value, action: &str) -> String {
    format!(
        "/api/v1/issues/{}{}",
        issue["id"].as_str().unwrap(),
        if action.is_empty() {
            String::new()
        } else {
            format!("/{action}")
        }
    )
}
async fn runtime(s: &State) -> Vec<String> {
    sqlx::query_scalar("SELECT json_object('id',id,'name',name,'data',data,'revoked',revoked,'desired_version_id',desired_version_id,'desired_generation',desired_generation,'policy',policy,'policy_generation',policy_generation,'assignment_id',assignment_id,'policy_assignment_id',policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap()
}
async fn audits(s: &State) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit'")
        .fetch_one(&s.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn issue_permissions_reasons_and_exact_revoked_identity_are_enforced() {
    let (_temp, s, app, admin) = fixture().await;
    let revoked = device_record(&s, 1, "old-device#retired-original", true).await;
    let active = device_record(&s, 2, "old-device", false).await;
    let old = issue(1, &revoked);
    let current = issue(2, &active);
    let absent = issue(3, "10000000-0000-4000-8000-000000009999");
    let mut resolved = issue(4, &revoked);
    resolved["resolved"] = json!(true);
    for record in [&old, &current, &absent, &resolved] {
        insert(&s, "issue", record).await;
    }
    for endpoint in [
        "/api/v1/issues/history".to_owned(),
        "/api/v1/issues".to_owned(),
        path(&old, ""),
    ] {
        assert_eq!(
            call(&app, "GET", &endpoint, Value::Null, None, false)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        for role in ["viewer", "editor", "operator", "admin"] {
            let actor = actor(&s, role).await;
            assert!(!get(&app, &endpoint, &actor).await.is_null());
        }
    }
    for role in ["viewer", "editor"] {
        let actor = actor(&s, role).await;
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&old, "acknowledge"),
                json!({"revision":1,"reason":"Retired device"}),
                Some(&actor),
                true
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&old, "acknowledge"),
            json!({"revision":1,"reason":"Retired device"}),
            Some(&admin),
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for (action, reason) in [
        ("acknowledge", json!("bad\u{0}reason")),
        ("acknowledge", json!("🌐".repeat(1001))),
        ("acknowledge", json!(false)),
        // Reopening states why; an acknowledgement note is optional.
        ("reopen", json!("")),
        ("reopen", json!(" \n\t ")),
        ("reopen", Value::Null),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&old, action),
                json!({"revision":1,"reason":reason}),
                Some(&admin),
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
            "{action} {reason}"
        );
    }
    for body in [
        json!({"revision":0,"reason":"x"}),
        json!({"revision":9007199254740992u64,"reason":"x"}),
        json!({"revision":1,"reason":"x","device_revoked":true}),
        json!({"reason":"x"}),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&old, "acknowledge"),
                body,
                Some(&admin),
                true
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for record in [&absent, &resolved] {
        for action in ["acknowledge", "reopen"] {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &path(record, action),
                    json!({"revision":1,"reason":"x"}),
                    Some(&admin),
                    true
                )
                .await
                .0,
                StatusCode::CONFLICT
            );
        }
    }
    // Not acknowledged yet, so there is nothing to reopen.
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&current, "reopen"),
            json!({"revision":1,"reason":"x"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let before = runtime(&s).await;
    // Live devices can be acknowledged, and the note is optional.
    let (status, live) = call(
        &app,
        "POST",
        &path(&current, "acknowledge"),
        json!({"revision":1}),
        Some(&admin),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{live}");
    assert_eq!(live["acknowledged"], true);
    assert!(live["acknowledgement_reason"].is_null());
    assert_eq!(live["device_revoked"], false);
    assert_eq!(live["revision"], 2);
    let operator = actor(&s, "operator").await;
    let (status, ack) = call(
        &app,
        "POST",
        &path(&old, "acknowledge"),
        json!({"revision":1,"reason":format!(" {} ","🌐".repeat(1000))}),
        Some(&operator),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ack}");
    assert_eq!(ack["resolved"], false);
    assert_eq!(ack["acknowledged"], true);
    assert_eq!(ack["revision"], 2);
    assert_eq!(ack["acknowledgement_reason"], "🌐".repeat(1000));
    assert_eq!(ack["acknowledged_by"], operator.id);
    assert_eq!(ack["device_id"], revoked);
    assert_eq!(ack["device_name"], "old-device#retired-original");
    assert_eq!(ack["device_revoked"], true);
    sqlx::query("UPDATE users SET name='Renamed operator' WHERE id=?")
        .bind(&operator.id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        get(&app, &path(&old, ""), &admin).await["acknowledged_by_name"],
        "Original operator"
    );
    assert_eq!(
        get(&app, &path(&current, ""), &admin).await["acknowledged"],
        true
    );
    assert_eq!(runtime(&s).await, before);
    let overview = get(&app, "/api/v1/overview", &admin).await;
    assert_eq!(overview["issues_open"], 1);
    assert_eq!(
        get(&app, "/api/v1/issues/history?state=acknowledged", &admin).await["total"],
        2
    );
    let (status, reopened) = call(
        &app,
        "POST",
        &path(&current, "reopen"),
        json!({"revision":2,"reason":"Still failing after the fix"}),
        Some(&admin),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reopened}");
    assert_eq!(reopened["disposition"], "open");
    assert_eq!(reopened["revision"], 3);
    assert_eq!(
        get(&app, "/api/v1/issues/history?state=resolved", &admin).await["total"],
        1
    );
}

#[tokio::test]
async fn acknowledgement_cas_aba_and_late_audit_failure_are_atomic() {
    let (_temp, s, app, admin) = fixture().await;
    let device = device_record(&s, 1, "retired", true).await;
    let record = issue(1, &device);
    insert(&s, "issue", &record).await;
    let before = runtime(&s).await;
    let endpoint = path(&record, "acknowledge");
    let (a, b) = tokio::join!(
        call(
            &app,
            "POST",
            &endpoint,
            json!({"revision":1,"reason":"First"}),
            Some(&admin),
            true
        ),
        call(
            &app,
            "POST",
            &endpoint,
            json!({"revision":1,"reason":"Concurrent"}),
            Some(&admin),
            true
        )
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    assert_eq!(audits(&s).await, 1);
    assert_eq!(
        call(
            &app,
            "POST",
            &endpoint,
            json!({"revision":2,"reason":"Repeated"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, reopened) = call(
        &app,
        "POST",
        &path(&record, "reopen"),
        json!({"revision":2,"reason":"Needs review again"}),
        Some(&admin),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reopened["revision"], 3);
    assert_eq!(reopened["count"], 3);
    assert_eq!(reopened["resolved"], false);
    assert_eq!(reopened["acknowledged"], false);
    assert!(reopened["acknowledgement_reason"].is_null());
    assert_eq!(
        call(
            &app,
            "POST",
            &endpoint,
            json!({"revision":3,"reason":"Reviewed again"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&record, "reopen"),
            json!({"revision":2,"reason":"Stale before ABA"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let prior = get(&app, &path(&record, ""), &admin).await;
    assert_eq!(prior["revision"], 4);
    assert_eq!(audits(&s).await, 3);
    let entries = get(&app, "/api/v1/audit", &admin).await;
    assert!(
        entries
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["device_id"] == device
                && event["target"] == record["id"]
                && event["actor_id"] == admin.id)
    );
    assert_eq!(entries[1]["reason"], "Needs review again");
    sqlx::query("CREATE TRIGGER reject_issue_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='issue.reopen' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").execute(&s.pool).await.unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&record, "reopen"),
            json!({"revision":4,"reason":"Must roll back"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(get(&app, &path(&record, ""), &admin).await, prior);
    assert_eq!(audits(&s).await, 3);
    assert_eq!(runtime(&s).await, before);
    let sequences: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_sequence")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(sequences, 3);
}

#[tokio::test]
async fn queued_issue_mutation_rechecks_live_authorization() {
    let (_temp, s, app, _admin) = fixture().await;
    let device = device_record(&s, 1, "revoked", true).await;
    let record = issue(1, &device);
    insert(&s, "issue", &record).await;
    for disable in [false, true] {
        let operator = actor(&s, "operator").await;
        let gate = s.writer.lock().await;
        let route = path(&record, "acknowledge");
        let cloned = app.clone();
        let actor_clone = operator.clone();
        let task = tokio::spawn(async move {
            call(
                &cloned,
                "POST",
                &route,
                json!({"revision":1,"reason":"Queued mutation"}),
                Some(&actor_clone),
                true,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(!task.is_finished());
        if disable {
            sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
                .bind(&operator.id)
                .execute(&s.pool)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
                .bind(&operator.id)
                .execute(&s.pool)
                .await
                .unwrap();
        }
        drop(gate);
        assert_eq!(
            task.await.unwrap().0,
            if disable {
                StatusCode::UNAUTHORIZED
            } else {
                StatusCode::FORBIDDEN
            }
        );
        assert_eq!(audits(&s).await, 0);
    }
}

#[tokio::test]
async fn bounded_issue_history_filters_exact_identity_and_never_searches_private_payloads() {
    let (_temp, s, app, admin) = fixture().await;
    let one = device_record(&s, 1, "Literal 100%_ [name]", true).await;
    let two = device_record(&s, 2, "Other device", true).await;
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..1000 {
        let mut v = issue(n, if n % 2 == 0 { &one } else { &two });
        v["opaque"] = json!("PRIVATE_EXTENSION".repeat(2000));
        v["resolved"] = json!(n % 5 == 0);
        v["acknowledged"] = json!(n % 5 == 1);
        v["acknowledgement_reason"] = json!("PRIVATE_REASON");
        db::insert(&mut tx, "issue", &v).await.unwrap();
    }
    tx.commit().await.unwrap();
    let page = get(&app, "/api/v1/issues/history", &admin).await;
    assert_eq!(page["total"], 600);
    assert_eq!(page["items"].as_array().unwrap().len(), 12);
    assert_eq!(page["page_size"], 12);
    assert!(page.to_string().len() < 16000);
    assert!(!page.to_string().contains("PRIVATE_EXTENSION"));
    assert!(!page.to_string().contains("PRIVATE_DIAGNOSTIC"));
    assert!(!page.to_string().contains("PRIVATE_DEVICE"));
    let first_ids = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(first_ids.windows(2).all(|pair| pair[0] < pair[1]));
    let second = get(&app, "/api/v1/issues/history?page=2", &admin).await;
    assert!(first_ids.last().unwrap() < &second["items"][0]["id"].as_str().unwrap());
    for (query, total) in [
        ("state=all", 1000),
        ("state=resolved", 200),
        ("state=acknowledged", 200),
        ("search=PRIVATE_EXTENSION", 0),
        ("search=PRIVATE_DIAGNOSTIC", 0),
        ("search=PRIVATE_REASON", 0),
        ("search=100%25_%20%5Bname%5D", 300),
    ] {
        assert_eq!(
            get(&app, &format!("/api/v1/issues/history?{query}"), &admin).await["total"],
            total,
            "{query}"
        );
    }
    assert_eq!(
        get(
            &app,
            &format!("/api/v1/issues/history?device_id={one}&page_size=5"),
            &admin
        )
        .await["total"],
        300
    );
    assert_eq!(
        get(
            &app,
            "/api/v1/issues/history?device_id=10000000-0000-4000-8000-000000999999",
            &admin
        )
        .await["total"],
        0
    );
    let legacy = get(&app, "/api/v1/issues", &admin).await;
    assert_eq!(legacy.as_array().unwrap().len(), 1000);
    assert_eq!(
        legacy[0],
        get(
            &app,
            &format!("/api/v1/issues/{}", legacy[0]["id"].as_str().unwrap()),
            &admin
        )
        .await
    );
    for query in [
        "state=hidden",
        "page=0",
        "page=1&page=2",
        "page_size=51",
        "page=-1",
        "page=9007199254740992",
        "unknown=QUERY_SECRET",
        "search=%FF",
        "search=%GG",
        "search=%",
        "device_id=not-a-uuid",
        "device_id=10000000000040008000000000000001",
        "device_id=10000000-0000-4000-8000-000000000001&device_id=10000000-0000-4000-8000-000000000002",
    ] {
        let (status, error) = call(
            &app,
            "GET",
            &format!("/api/v1/issues/history?{query}"),
            Value::Null,
            Some(&admin),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {error}");
        assert!(!error.to_string().contains("QUERY_SECRET"));
    }
    for (n, status) in [(200, StatusCode::OK), (201, StatusCode::BAD_REQUEST)] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/api/v1/issues/history?search={}", "%F0%9F%8C%90".repeat(n)),
                Value::Null,
                Some(&admin),
                false
            )
            .await
            .0,
            status
        );
    }
    assert_eq!(
        get(&app, "/api/v1/overview", &admin).await["issues_open"],
        600
    );
    assert_eq!(audits(&s).await, 0);
}

#[tokio::test]
async fn malformed_legacy_timestamps_and_extensions_cannot_poison_the_page() {
    let (_temp, s, app, admin) = fixture().await;
    let device = device_record(&s, 1, "Historical device", true).await;
    let mut v = issue(1, &device);
    v["first_seen"] = json!({"secret":"PRIVATE_TIMESTAMP"});
    v["last_seen"] = json!("PRIVATE_TIMESTAMP".repeat(1000));
    v["acknowledged_at"] = json!({"secret":"PRIVATE_TIMESTAMP"});
    v["created_at"] = json!("2026-01-03T01:02:03Z");
    v["acknowledged_by_name"] = json!({"private":"PRIVATE_NAME"});
    insert(&s, "issue", &v).await;
    let out = get(&app, &path(&v, ""), &admin).await;
    assert_eq!(out["first_seen"], "2026-01-03T01:02:03.000Z");
    assert_eq!(out["last_seen"], out["first_seen"]);
    assert!(out["acknowledged_at"].is_null());
    assert!(out["acknowledged_by_name"].is_null());
    assert!(!out.to_string().contains("PRIVATE_"));
    assert_eq!(out["revision"], 1);
    sqlx::query("UPDATE records SET created_at='PRIVATE_BAD_DATE' WHERE kind='issue'")
        .execute(&s.pool)
        .await
        .unwrap();
    let out = get(&app, &path(&v, ""), &admin).await;
    assert!(out["first_seen"].is_null());
    assert!(out["last_seen"].is_null());
    assert!(!out.to_string().contains("PRIVATE_"));
}

#[tokio::test]
async fn heartbeat_occurrence_and_verified_resolution_advance_revision_and_recurrence_clears_acknowledgement()
 {
    let (_temp, s, app, admin) = fixture().await;
    let id = device_record(&s, 1, "Agent", false).await;
    let sha = db::hash("{}\n");
    let version = db::id();
    insert(
        &s,
        "version",
        &json!({"id":version,"sha256":sha,"size":3,"artifact":"{}\n"}),
    )
    .await;
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=1,policy_generation=0 WHERE id=?").bind(&version).bind(&id).execute(&s.pool).await.unwrap();
    let fingerprint = db::hash("issue-test-credential");
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(&fingerprint)
    .bind(&id)
    .bind("2099-01-01T00:00:00Z")
    .bind(s.keys.active_signing_id())
    .execute(&s.pool)
    .await
    .unwrap();
    let agent =
        device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))));
    let mut heartbeat = json!({"protocol_version":1,"request_id":"issue-test","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","boot_id":"issue-boot","agent_version":"test","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":null,"apply_state":"failed","local_paused":false,"remote_pause_acknowledged":false,"error":{"code":"APPLY_FAILED","stage":"apply","message":"PRIVATE_AGENT_DIAGNOSTIC"}});
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let issue_id = db::hash(format!("{id}:{version}:APPLY_FAILED:apply"));
    let endpoint = format!("/api/v1/issues/{issue_id}");
    let first = get(&app, &endpoint, &admin).await;
    assert_eq!(first["revision"], 1);
    assert_eq!(first["count"], 1);
    assert_eq!(first["reports"], 1);
    assert_eq!(first["desired_version_id"], version);
    assert_eq!(
        first["title"],
        "The device couldn't apply the configuration"
    );
    assert_eq!(
        first["message"],
        "The device reported a failure while applying this version."
    );
    assert!(!first.to_string().contains("PRIVATE_AGENT"));
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{endpoint}/acknowledge"),
            json!({"revision":1,"reason":"Retired"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(get(&app, &endpoint, &admin).await["revision"], 2);
    // Deliberately re-enable the fixture identity to exercise recurrence after
    // acknowledgement; the production API does not silently revive identities.
    sqlx::query("UPDATE devices SET revoked=0 WHERE id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    // Check-ins about the same failed attempt are reports, not occurrences:
    // they never undo the operator's acknowledgement.
    let repeated = get(&app, &endpoint, &admin).await;
    assert_eq!(repeated["revision"], 2);
    assert_eq!(repeated["count"], 1);
    assert_eq!(repeated["reports"], 2);
    assert_eq!(repeated["disposition"], "acknowledged");
    // A new attempt (generation) is a new occurrence and clears it.
    sqlx::query("UPDATE devices SET desired_generation=2 WHERE id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    heartbeat["reported_generation"] = json!(2);
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let repeated = get(&app, &endpoint, &admin).await;
    assert_eq!(repeated["revision"], 3);
    assert_eq!(repeated["count"], 2);
    assert_eq!(repeated["reports"], 3);
    assert_eq!(repeated["disposition"], "open");
    assert!(repeated["acknowledged_by"].is_null());
    assert!(repeated["acknowledgement_reason"].is_null());
    heartbeat["error"] = Value::Null;
    heartbeat["apply_state"] = json!("written");
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(get(&app, &endpoint, &admin).await["revision"], 3);
    heartbeat["apply_state"] = json!("verified_applied");
    heartbeat["actual_sha256"] = json!("0".repeat(64));
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let bad = get(&app, &endpoint, &admin).await;
    assert_eq!(bad["resolved"], false);
    assert_eq!(bad["revision"], 3);
    assert_eq!(bad["count"], 2);
    heartbeat["actual_sha256"] = json!(sha);
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let resolved = get(&app, &endpoint, &admin).await;
    assert_eq!(resolved["resolved"], true);
    assert_eq!(resolved["resolved_reason"], "verified");
    assert_eq!(resolved["revision"], 4);
    assert_eq!(resolved["disposition"], "resolved");
    assert_eq!(resolved["count"], 2);
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(get(&app, &endpoint, &admin).await["revision"], 4);
    heartbeat["apply_state"] = json!("failed");
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat,
            None,
            false
        )
        .await
        .0,
        StatusCode::OK
    );
    let recurrence = get(&app, &endpoint, &admin).await;
    assert_eq!(recurrence["revision"], 5);
    assert_eq!(recurrence["count"], 3);
    assert_eq!(recurrence["resolved"], false);
    assert!(recurrence["resolved_reason"].is_null());
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{endpoint}/acknowledge"),
            json!({"revision":3,"reason":"Stale occurrence"}),
            Some(&admin),
            true
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn issue_migration_preserves_resolution_and_runtime_metadata() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
        .execute(&pool)
        .await
        .unwrap();
    for resolved in [false, true] {
        let value = json!({"id":resolved.to_string(),"resolved":resolved,"count":8,"device_id":"original-id","desired_version_id":"original-version"});
        sqlx::query("INSERT INTO records VALUES('issue',?,?,'2026-01-01T00:00:00Z')")
            .bind(resolved.to_string())
            .bind(value.to_string())
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::raw_sql(include_str!("../migrations/0011_issue_acknowledgement.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let rows: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    for row in rows {
        let value: Value = serde_json::from_str(&row).unwrap();
        assert_eq!(value["revision"], 1);
        assert_eq!(value["acknowledged"], false);
        assert_eq!(value["count"], 8);
        assert_eq!(value["device_id"], "original-id");
        assert_eq!(value["desired_version_id"], "original-version");
        assert_eq!(
            value["resolved"].as_bool().unwrap().to_string(),
            value["id"].as_str().unwrap()
        );
    }
}

#[tokio::test]
async fn issue_sort_is_global_bounded_and_retains_strict_query_validation() {
    let (_temp, s, app, admin) = fixture().await;
    for (n, id, name, code, count, date, state) in [
        (1, "a", "Zulu", "ALPHA", 9, "2026-01-01T00:00:00Z", "open"),
        (
            2,
            "b",
            "Alpha",
            "ZULU",
            1,
            "2026-01-03T00:00:00Z",
            "resolved",
        ),
        (
            3,
            "c",
            "Bravo",
            "BRAVO",
            4,
            "2026-01-02T00:00:00Z",
            "acknowledged",
        ),
    ] {
        let device = device_record(&s, n, name, true).await;
        let mut v = issue(n, &device);
        v["id"] = json!(id);
        v["code"] = json!(code);
        v["count"] = json!(count);
        v["last_seen"] = json!(date);
        v["resolved"] = json!(state == "resolved");
        v["acknowledged"] = json!(state == "acknowledged");
        insert(&s, "issue", &v).await;
    }
    for (sort, ascending) in [
        ("code", vec!["a", "c", "b"]),
        ("device", vec!["b", "c", "a"]),
        ("count", vec!["b", "c", "a"]),
        ("last_seen", vec!["a", "c", "b"]),
        ("disposition", vec!["c", "a", "b"]),
    ] {
        for direction in ["asc", "desc"] {
            let mut actual = Vec::new();
            for page in 1..=3 {
                let body=get(&app,&format!("/api/v1/issues/history?state=all&sort={sort}&direction={direction}&page={page}&page_size=1"),&admin).await;
                assert_eq!(body["total"], 3);
                assert!(!body.to_string().contains("PRIVATE_"));
                actual.push(body["items"][0]["id"].as_str().unwrap().to_owned());
            }
            let mut expected = ascending.clone();
            if direction == "desc" {
                expected.reverse();
            }
            assert_eq!(actual, expected, "{sort} {direction}");
        }
    }
    for query in [
        "sort=message",
        "direction=sideways",
        "sort=count&sort=device",
        "direction=asc&direction=desc",
        "sort=",
        "sort=count%3BDROP%20TABLE%20records",
    ] {
        let (status, body) = call(
            &app,
            "GET",
            &format!("/api/v1/issues/history?{query}"),
            Value::Null,
            Some(&admin),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["code"], "INVALID_INPUT");
    }
}

#[tokio::test]
async fn issue_groups_list_each_groups_newest_fifty_members_in_one_page() {
    let (_temp, s, app, admin) = fixture().await;
    let device = device_record(&s, 1, "edge-01", false).await;
    // 60 apply failures on no version and three data_dir failures on v1.
    for n in 0..63u64 {
        let mut item = issue(n, &device);
        item["last_seen"] = json!(format!("2026-01-02T00:{:02}:00Z", n % 60));
        if n >= 60 {
            item["code"] = json!("DATA_DIR_MISSING");
            item["desired_version_id"] = json!("20000000-0000-4000-8000-000000000001");
            item["last_seen"] = json!(format!("2026-01-03T00:00:0{}Z", n - 60));
        }
        insert(&s, "issue", &item).await;
    }
    let page = get(&app, "/api/v1/issues/groups?page_size=5", &admin).await;
    assert_eq!(page["total"], 2);
    let items = page["items"].as_array().unwrap();
    assert_eq!(items[0]["code"], "DATA_DIR_MISSING");
    assert_eq!(items[0]["issue_count"], 3);
    assert_eq!(items[0]["devices"].as_array().unwrap().len(), 3);
    assert_eq!(items[0]["devices"][0]["id"], db::hash("issue-62"));
    assert_eq!(items[1]["code"], "APPLY_FAILED");
    assert_eq!(items[1]["issue_count"], 60);
    let members = items[1]["devices"].as_array().unwrap();
    assert_eq!(members.len(), 50);
    assert_eq!(members[0]["id"], db::hash("issue-59"));
    assert!(members.iter().all(|m| m["code"] == "APPLY_FAILED"));
    let second = get(&app, "/api/v1/issues/groups?page_size=1&page=2", &admin).await;
    assert_eq!(second["items"][0]["code"], "APPLY_FAILED");
    assert_eq!(second["items"][0]["devices"].as_array().unwrap().len(), 50);
    let searched = get(&app, "/api/v1/issues/groups?search=edge-01", &admin).await;
    assert_eq!(searched["total"], 2);
}

/// A device's failed check-in, as the heartbeat route records it: the real
/// writer of an issue, which keeps a code and no title.
async fn fail_with(agent: &Router, code: &str, stage: &str) {
    let heartbeat = json!({"protocol_version":1,"request_id":"issue-title-test","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","boot_id":"issue-boot","agent_version":"test","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":null,"apply_state":"failed","local_paused":false,"remote_pause_acknowledged":false,"error":{"code":code,"stage":stage,"message":"PRIVATE_AGENT_DIAGNOSTIC"}});
    let (status, body) = call(agent, "POST", "/agent/v1/heartbeat", heartbeat, None, false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

// An issue record keeps its code, not its title, so the audit log builds the
// name of an issue event from the code, as the issue list does. Every role
// that reads the log reads issues, and sees the same name.
#[tokio::test]
async fn issue_events_are_named_by_their_title_on_their_device_for_every_role() {
    let (_temp, s, app, admin) = fixture().await;
    let operator = actor(&s, "operator").await;
    let viewer = actor(&s, "viewer").await;
    let id = device_record(&s, 1, "edge-nyc-02", false).await;
    let version = db::id();
    insert(
        &s,
        "version",
        &json!({"id":version,"sha256":db::hash("{}\n"),"size":3,"artifact":"{}\n"}),
    )
    .await;
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=1,policy_generation=0 WHERE id=?").bind(&version).bind(&id).execute(&s.pool).await.unwrap();
    let fingerprint = db::hash("issue-title-credential");
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(&fingerprint)
    .bind(&id)
    .bind("2099-01-01T00:00:00Z")
    .bind(s.keys.active_signing_id())
    .execute(&s.pool)
    .await
    .unwrap();
    let agent =
        device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))));
    fail_with(&agent, "APPLY_FAILED", "apply").await;
    fail_with(&agent, "VALIDATION_FAILED", "validation").await;
    let apply = db::hash(format!("{id}:{version}:APPLY_FAILED:apply"));
    let validation = db::hash(format!("{id}:{version}:VALIDATION_FAILED:validation"));
    // The record the writer made holds a code and no title.
    let stored: String = sqlx::query_scalar("SELECT data FROM records WHERE kind='issue' AND id=?")
        .bind(&apply)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!stored.contains("\"title\""), "{stored}");
    // An operator acknowledges one issue and reopens it, and acknowledges the
    // other.
    for (issue, action, revision, reason) in [
        (&apply, "acknowledge", 1, "Looking into it"),
        (&apply, "reopen", 2, "It failed again"),
        (&validation, "acknowledge", 1, ""),
    ] {
        let (status, body) = call(
            &app,
            "POST",
            &format!("/api/v1/issues/{issue}/{action}"),
            json!({"revision":revision,"reason":reason}),
            Some(&operator),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{action}: {body}");
    }
    for (role, reader) in [
        ("viewer", &viewer),
        ("operator", &operator),
        ("admin", &admin),
    ] {
        let history = get(&app, "/api/v1/audit/history?page_size=50", reader).await;
        let rows = |action: &str, issue: &str| -> Vec<Value> {
            history["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|row| row["action"] == action && row["target"] == issue)
                .cloned()
                .collect()
        };
        for (action, issue, title) in [
            (
                "issue.acknowledge",
                &apply,
                "The device couldn't apply the configuration on edge-nyc-02",
            ),
            (
                "issue.reopen",
                &apply,
                "The device couldn't apply the configuration on edge-nyc-02",
            ),
            (
                "issue.acknowledge",
                &validation,
                "Vector rejected the configuration on edge-nyc-02",
            ),
        ] {
            let found = rows(action, issue);
            assert_eq!(found.len(), 1, "{role} {action}");
            assert_eq!(found[0]["target_name"], title, "{role} {action}");
            assert_eq!(found[0]["target_kind"], "issue", "{role} {action}");
            assert_eq!(found[0]["target_exists"], true, "{role} {action}");
            assert_eq!(found[0]["device_name"], "edge-nyc-02", "{role} {action}");
        }
        // The log is searchable by the name it now carries.
        let found = get(
            &app,
            "/api/v1/audit/history?search=rejected%20the%20configuration",
            reader,
        )
        .await;
        assert_eq!(found["total"], 1, "{role}");
    }
    // The name is what the issue list shows, to the same readers.
    let shown = get(&app, &format!("/api/v1/issues/{validation}"), &viewer).await;
    assert_eq!(shown["title"], "Vector rejected the configuration");
}
