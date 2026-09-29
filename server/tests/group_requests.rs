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
        instance_name: "Group CAS tests".into(),
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

fn body(ids: &[String], key: &str) -> Value {
    json!({"request_id":key,"name":"Synthetic group","description":"Original request","device_ids":ids})
}
fn lookup(key: &str) -> String {
    format!("/api/v1/groups/requests/{key}")
}
fn emit(name: &str, v: &Value) {
    if let Ok(path) = std::env::var("VECTORY_GROUP_REQUEST_FIXTURES") {
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            std::path::Path::new(&path).join(format!("{name}.json")),
            serde_json::to_vec_pretty(v).unwrap(),
        )
        .unwrap();
    }
}
async fn counts(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,payload_sha256,group_id,created_at) FROM group_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,revoked,desired_generation,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let targets:Vec<String>=sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"records":records,"requests":requests,"devices":devices,"targets":targets})
}

#[tokio::test]
async fn retry_and_lookup_recover_current_group_without_reconciling_edited_or_revoked_members() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let key = db::id();
    let request = body(&ids[..1], &key);
    let empty = call(&app, "GET", &lookup(&key), Value::Null, &cookie, "").await;
    assert_eq!(empty.0, StatusCode::OK);
    assert_eq!(empty.1, json!({"request_id":key,"found":false}));
    emit("lookup_absent", &empty.1);
    let created = call(
        &app,
        "POST",
        "/api/v1/groups",
        request.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(created.0, StatusCode::OK);
    emit("keyed_group", &created.1);
    let id = created.1["id"].as_str().unwrap();
    let policy = json!({"policy":{"heartbeat_seconds":180,"sync_paused":false,"telemetry_enabled":true},"selector":{"group_ids":[id],"device_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}});
    assert_eq!(
        call(&app, "POST", "/api/v1/deployments", policy, &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
    let edit = json!({"revision":1,"name":"Edited result","description":"Current details","device_ids":[ids[1]]});
    let edited = call(
        &app,
        "PUT",
        &format!("/api/v1/groups/{id}"),
        edit,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(edited.0, StatusCode::OK);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/devices/{}/revoke", ids[0]),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = counts(&s).await;
    let replay = call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf).await;
    assert_eq!(replay.0, StatusCode::OK);
    let mut expected = edited.1;
    expected["request_id"] = json!(key);
    assert_eq!(replay.1, expected);
    let found = call(&app, "GET", &lookup(&key), Value::Null, &cookie, "").await;
    assert_eq!(
        found.1,
        json!({"request_id":key,"found":true,"group":expected})
    );
    emit("lookup_edited", &found.1);
    assert_eq!(
        counts(&s).await,
        before,
        "replay/read must have zero runtime or audit effects"
    );
    assert!(
        call(
            &app,
            "GET",
            &format!("/api/v1/groups/{id}"),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1
        .get("request_id")
        .is_none()
    );
}

#[tokio::test]
async fn concurrent_retries_create_one_group_mapping_and_audit() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let key = db::id();
    let request = body(&ids, &key);
    let (a, b) = tokio::join!(
        call(
            &app,
            "POST",
            "/api/v1/groups",
            request.clone(),
            &cookie,
            &csrf
        ),
        call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf)
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(a, b);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM group_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM records WHERE kind='group'")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='group.create'").fetch_one(&s.pool).await.unwrap(),1);
}

#[tokio::test]
async fn canonical_payload_rejects_changed_fields_and_array_order_without_state_change() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let key = db::id();
    let mut request = body(&ids[..2], &key);
    request["extension"] = json!({"b":2,"a":1});
    let first = call(
        &app,
        "POST",
        "/api/v1/groups",
        request.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    let before = counts(&s).await;
    let mut reordered = request.clone();
    reordered["extension"] = serde_json::from_str("{\"a\":1,\"b\":2}").unwrap();
    reordered["request_id"] = json!(key.to_uppercase());
    assert_eq!(
        call(&app, "POST", "/api/v1/groups", reordered, &cookie, &csrf).await,
        first
    );
    for (field, value) in [
        ("name", json!("Changed")),
        ("description", Value::Null),
        ("device_ids", json!([ids[1], ids[0]])),
        ("extension", json!({"a":2,"b":2})),
    ] {
        let mut changed = request.clone();
        changed[field] = value;
        let rejected = call(&app, "POST", "/api/v1/groups", changed, &cookie, &csrf).await;
        assert_eq!(rejected.0, StatusCode::CONFLICT);
        assert_eq!(rejected.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
        emit("payload_conflict", &rejected.1);
    }
    assert_eq!(counts(&s).await, before);
}

#[tokio::test]
async fn actor_isolation_live_authorization_and_csrf_cover_replay_and_lookup() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let key = db::id();
    let request = body(&ids, &key);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/groups",
            request.clone(),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "POST", "/api/v1/groups", request.clone(), &cookie, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for role in ["viewer", "editor"] {
        let (_, c, t) = actor(&s, role).await;
        for (method, path, v) in [
            ("POST", "/api/v1/groups".into(), request.clone()),
            ("GET", lookup(&key), Value::Null),
            ("GET", "/api/v1/groups/requests".into(), Value::Null),
        ] {
            assert_eq!(
                call(&app, method, &path, v, &c, &t).await.0,
                StatusCode::FORBIDDEN
            );
        }
    }
    let (id, c, t) = actor(&s, "operator").await;
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &c, "")
            .await
            .1["found"],
        false
    );
    assert_eq!(
        call(&app, "GET", "/api/v1/groups/requests", Value::Null, &c, "")
            .await
            .1["total"],
        0
    );
    let other = call(&app, "POST", "/api/v1/groups", request.clone(), &c, &t).await;
    assert_eq!(other.0, StatusCode::OK);
    let lock = s.writer.lock().await;
    let router = app.clone();
    let cc = c.clone();
    let tt = t.clone();
    let pending =
        tokio::spawn(
            async move { call(&router, "POST", "/api/v1/groups", request, &cc, &tt).await },
        );
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(lock);
    assert_eq!(pending.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &c, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn late_audit_or_registry_failure_rolls_back_every_creation_effect() {
    for registry in [false, true] {
        let (_t, s, app, ids, cookie, csrf) = fixture().await;
        let trigger = if registry {
            "CREATE TRIGGER fail_group BEFORE INSERT ON group_requests BEGIN SELECT RAISE(ABORT,'fixture'); END"
        } else {
            "CREATE TRIGGER fail_group BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='group.create' BEGIN SELECT RAISE(ABORT,'fixture'); END"
        };
        sqlx::query(trigger).execute(&s.pool).await.unwrap();
        let before = counts(&s).await;
        let request = body(&ids, &db::id());
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/v1/groups",
                request.clone(),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(counts(&s).await, before);
        sqlx::query("DROP TRIGGER fail_group")
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf)
                .await
                .0,
            StatusCode::OK
        );
    }
}

#[tokio::test]
async fn registry_failure_also_rolls_back_reconciliation_of_existing_assignment() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let assignment = json!({"policy":{"heartbeat_seconds":180,"sync_paused":false,"telemetry_enabled":true},"selector":{"group_ids":[],"device_ids":[ids[0]],"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}});
    let result = call(
        &app,
        "POST",
        "/api/v1/deployments",
        assignment,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(result.0, StatusCode::OK);
    sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=?")
        .bind(result.1["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_group BEFORE INSERT ON group_requests BEGIN SELECT RAISE(ABORT,'fixture'); END").execute(&s.pool).await.unwrap();
    let before = counts(&s).await;
    let request = body(&[], &db::id());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/groups",
            request.clone(),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        counts(&s).await,
        before,
        "Existing assignment completion must roll back too"
    );
    sqlx::query("DROP TRIGGER fail_group")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
    let current = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{}", result.1["id"].as_str().unwrap()),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(
        current["status"], "completed",
        "Success proves reconcile had a real effect to roll back"
    );
}

#[tokio::test]
async fn unavailable_result_keeps_tombstone_and_never_recreates_group() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let key = db::id();
    let request = body(&ids, &key);
    let created = call(
        &app,
        "POST",
        "/api/v1/groups",
        request.clone(),
        &cookie,
        &csrf,
    )
    .await
    .1;
    sqlx::query("DELETE FROM records WHERE kind='group' AND id=?")
        .bind(created["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    let before = counts(&s).await;
    for (method, path, v) in [
        ("POST", "/api/v1/groups".into(), request),
        ("GET", lookup(&key), Value::Null),
    ] {
        let rejected = call(&app, method, &path, v, &cookie, &csrf).await;
        assert_eq!(rejected.0, StatusCode::CONFLICT);
        assert_eq!(rejected.1["error"]["code"], "CONFLICT");
        emit("unavailable_result", &rejected.1);
    }
    let history = call(
        &app,
        "GET",
        "/api/v1/groups/requests",
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(history["items"][0]["group_name"], Value::Null);
    assert_eq!(counts(&s).await, before);
    emit("unavailable_history", &history);
}

#[tokio::test]
async fn invalid_request_ids_do_not_write_and_unkeyed_legacy_calls_still_create() {
    let (_t, s, app, ids, cookie, csrf) = fixture().await;
    let before = counts(&s).await;
    for bad in [
        Value::Null,
        json!(true),
        json!(1),
        json!("bad"),
        json!(db::id().replace('-', "")),
    ] {
        let mut request = body(&ids, &db::id());
        request["request_id"] = bad;
        assert_eq!(
            call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(counts(&s).await, before);
    let mut request = body(&ids, &db::id());
    request.as_object_mut().unwrap().remove("request_id");
    let a = call(
        &app,
        "POST",
        "/api/v1/groups",
        request.clone(),
        &cookie,
        &csrf,
    )
    .await;
    let b = call(&app, "POST", "/api/v1/groups", request, &cookie, &csrf).await;
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_ne!(a.1["id"], b.1["id"]);
    assert!(a.1.get("request_id").is_none());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM group_requests")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn request_history_is_bounded_actor_only_and_never_reads_members_or_extensions() {
    let (_t, s, app, _ids, cookie, _csrf) = fixture().await;
    let owner: String = sqlx::query_scalar("SELECT id FROM users WHERE role='admin'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    let (other, _, _) = actor(&s, "operator").await;
    let marker = "PRIVATE_BODY_MARKER".repeat(5000);
    let mut conn = s.pool.acquire().await.unwrap();
    let mut expected = Vec::new();
    for n in 0..61 {
        let key = format!("00000000-0000-4000-8000-{n:012}");
        let id = db::id();
        let g = json!({"id":id,"name":if n==60 {json!("ðŸ˜€".repeat(300))}else if n==59{json!({"private":marker})}else{json!(format!("Group {n}"))},"revision":1,"device_ids":[marker],"private":marker});
        db::insert(&mut conn, "group", &g).await.unwrap();
        sqlx::query("INSERT INTO group_requests VALUES(?,?,?,?,?)")
            .bind(if n == 0 { &other } else { &owner })
            .bind(&key)
            .bind("a".repeat(64))
            .bind(&id)
            .bind("2026-01-01T00:00:00Z")
            .execute(&mut *conn)
            .await
            .unwrap();
        if n > 0 {
            expected.push(key);
        }
    }
    expected.reverse();
    drop(conn);
    let before = counts(&s).await;
    let first = call(
        &app,
        "GET",
        "/api/v1/groups/requests?page=1&page_size=50",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(first.1["total"], 60);
    assert_eq!(first.1["items"].as_array().unwrap().len(), 50);
    assert_eq!(
        first.1["items"][0]["group_name"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        240
    );
    assert!(first.1["items"][1]["group_name"].is_null());
    assert!(!first.1.to_string().contains("PRIVATE_BODY_MARKER"));
    let second = call(
        &app,
        "GET",
        "/api/v1/groups/requests?page=2&page_size=50",
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    let actual: Vec<_> = first.1["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .map(|v| v["request_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(counts(&s).await, before);
    emit("request_history", &first.1);
}

#[tokio::test]
async fn discovery_queries_are_strict_bounded_and_authenticated() {
    let (_t, _s, app, _ids, cookie, _csrf) = fixture().await;
    for suffix in [
        "?page=0",
        "?page_size=0",
        "?page_size=51",
        "?page=9007199254740992",
        "?page=1&page=2",
        "?search=x",
        "?page=%GG",
        "?page=%FF",
        "?page=-1",
    ] {
        let result = call(
            &app,
            "GET",
            &format!("/api/v1/groups/requests{suffix}"),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(result.0, StatusCode::BAD_REQUEST, "{suffix}");
        assert_eq!(result.1["error"]["code"], "INVALID_INPUT");
    }
    for suffix in ["?foo=x", "?page=1", "?x=%GG"] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{}{suffix}", lookup(&db::id())),
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
        call(&app, "GET", &lookup("invalid"), Value::Null, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", &lookup("invalid"), Value::Null, &cookie, "")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}
