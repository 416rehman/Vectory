use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

type Identity = (String, String, String);
async fn actor(s: &State, role: &str) -> Identity {
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
async fn fixture(url: Option<String>) -> (tempfile::TempDir, State, Router, Identity, Value) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Publication recovery fixture".into(),
        validation_url: url,
    })
    .await
    .unwrap();
    let a = actor(&s, "admin").await;
    let app = api::router(s.clone());
    let c = create(&app, &a).await;
    (temp, s, app, a, c)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    a: &Identity,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", &a.1)
                .header("x-csrf-token", &a.2)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
async fn create(app: &Router, a: &Identity) -> Value {
    let result=call(app,"POST","/api/v1/configurations",json!({"name":"Synthetic pipeline","description":"Fixture","config":{"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}},"graph":{"nodes":[],"edges":[]}}),a).await;
    assert_eq!(result.0, StatusCode::OK, "{}", result.1);
    result.1
}
fn path(c: &Value) -> String {
    format!(
        "/api/v1/configurations/{}/publish",
        c["id"].as_str().unwrap()
    )
}
fn lookup(key: &str) -> String {
    format!("/api/v1/configurations/publish-requests/{key}")
}
fn request(key: &str) -> Value {
    json!({"revision":1,"message":"Reviewed publication","request_id":key})
}
fn emit(name: &str, value: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_PUBLICATION_FIXTURES") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{name}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}
async fn snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,configuration_id,payload_sha256,version_id,number,source_revision,created_at) FROM publication_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let sequence: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(sequence,audit_id) FROM audit_sequence ORDER BY sequence",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    json!({"records":records,"requests":requests,"sequence":sequence})
}
async fn published(s: &State) -> (i64, i64, i64) {
    let versions = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='version'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    let audits=sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='configuration.publish'").fetch_one(&s.pool).await.unwrap();
    let keys = sqlx::query_scalar("SELECT count(*) FROM publication_requests")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    (versions, audits, keys)
}

#[tokio::test]
async fn immutable_replay_survives_draft_edits_archive_and_preserves_exact_original_result() {
    let (_t, s, app, a, c) = fixture(None).await;
    let key = db::id();
    let req = request(&key);
    let absent = call(&app, "GET", &lookup(&key), Value::Null, &a).await;
    assert_eq!(absent.1, json!({"request_id":key,"found":false}));
    emit("absent_lookup", &absent.1);
    let first = call(&app, "POST", &path(&c), req.clone(), &a).await;
    assert_eq!(first.0, StatusCode::OK, "{}", first.1);
    emit("created_receipt", &first.1);
    let draft=call(&app,"PUT",&format!("/api/v1/configurations/{}/draft",c["id"].as_str().unwrap()),json!({"revision":1,"config":{"sources":{"other":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["other"]}}},"graph":{"nodes":[],"edges":[]}}),&a).await;
    assert_eq!(draft.0, StatusCode::OK);
    let archive = call(
        &app,
        "POST",
        &format!(
            "/api/v1/configurations/{}/archive",
            c["id"].as_str().unwrap()
        ),
        json!({"revision":2}),
        &a,
    )
    .await;
    assert_eq!(archive.0, StatusCode::OK);
    let before = snapshot(&s).await;
    let replay = call(&app, "POST", &path(&c), req, &a).await;
    assert_eq!(replay, first);
    emit("archived_replay_receipt", &replay.1);
    let found = call(&app, "GET", &lookup(&key.to_uppercase()), Value::Null, &a).await;
    assert_eq!(
        found.1,
        json!({"request_id":key,"found":true,"version":first.1})
    );
    emit("found_lookup", &found.1);
    let stored = call(
        &app,
        "GET",
        &format!("/api/v1/versions/{}", first.1["id"].as_str().unwrap()),
        Value::Null,
        &a,
    )
    .await;
    let mut expected = first.1.clone();
    expected.as_object_mut().unwrap().remove("request_id");
    assert_eq!(stored.1, expected);
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(published(&s).await, (1, 1, 1));
}

#[tokio::test]
async fn concurrent_same_key_commits_once_and_payload_or_pipeline_change_conflicts() {
    let (_t, s, app, a, c) = fixture(None).await;
    let key = db::id();
    let mut req = request(&key);
    req["extension"] = json!({"b":[1,2],"a":null});
    let publish_path = path(&c);
    let (one, two) = tokio::join!(
        call(&app, "POST", &publish_path, req.clone(), &a),
        call(&app, "POST", &publish_path, req.clone(), &a)
    );
    assert_eq!(one.0, StatusCode::OK);
    assert_eq!(one, two);
    assert_eq!(published(&s).await, (1, 1, 1));
    let reordered:Value=serde_json::from_str(&format!(r#"{{"extension":{{"a":null,"b":[1,2]}},"request_id":"{key}","message":"Reviewed publication","revision":1}}"#)).unwrap();
    assert_eq!(call(&app, "POST", &path(&c), reordered, &a).await, one);
    let c2 = create(&app, &a).await;
    let before = snapshot(&s).await;
    for changed in [
        json!({"revision":1,"message":"Different","request_id":key}),
        json!({"revision":1,"message":null,"request_id":key}),
        json!({"revision":0,"request_id":key}),
        json!({"revision":1,"message":"Reviewed publication","request_id":key,"extension":{"a":null,"b":[2,1]}}),
    ] {
        let denied = call(&app, "POST", &path(&c), changed, &a).await;
        assert_eq!(denied.0, StatusCode::CONFLICT);
        assert_eq!(denied.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
        emit("payload_conflict_error", &denied.1);
    }
    let other = call(&app, "POST", &path(&c2), req, &a).await;
    assert_eq!(other.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn live_roles_csrf_and_actor_namespace_apply_to_replay_lookup_and_history() {
    let (_t, s, app, a, c) = fixture(None).await;
    let key = db::id();
    let req = request(&key);
    let original = call(&app, "POST", &path(&c), req.clone(), &a).await;
    assert_eq!(original.0, StatusCode::OK);
    let history = format!(
        "/api/v1/configurations/publish-requests?configuration_id={}",
        c["id"].as_str().unwrap()
    );
    for role in ["viewer", "editor"] {
        let other = actor(&s, role).await;
        for (method, url, body) in [
            ("POST", path(&c), req.clone()),
            ("GET", lookup(&key), Value::Null),
            ("GET", history.clone(), Value::Null),
        ] {
            assert_eq!(
                call(&app, method, &url, body, &other).await.0,
                StatusCode::FORBIDDEN
            );
        }
    }
    let mut wrong = a.clone();
    wrong.2 = "wrong".into();
    assert_eq!(
        call(&app, "POST", &path(&c), req.clone(), &wrong).await.0,
        StatusCode::FORBIDDEN
    );
    let other = actor(&s, "operator").await;
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &other)
            .await
            .1,
        json!({"request_id":key,"found":false})
    );
    assert_eq!(
        call(&app, "GET", &history, Value::Null, &other).await.1["total"],
        0
    );
    let independent = call(&app, "POST", &path(&c), req.clone(), &other).await;
    assert_eq!(independent.0, StatusCode::OK);
    assert_ne!(independent.1["id"], original.1["id"]);
    assert_eq!(published(&s).await, (2, 2, 2));
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(&a.0)
        .execute(&s.pool)
        .await
        .unwrap();
    for (method, url, body) in [
        ("POST", path(&c), req),
        ("GET", lookup(&key), Value::Null),
        ("GET", history, Value::Null),
    ] {
        assert_eq!(
            call(&app, method, &url, body, &a).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn first_keyed_request_validates_safe_revision_and_utf8_message_but_legacy_stays_compatible()
{
    let (_t, s, app, a, c) = fixture(None).await;
    let before = snapshot(&s).await;
    let mut invalid = vec![
        Value::Null,
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9007199254740992u64),
        json!("1"),
    ];
    for revision in invalid.drain(..) {
        let denied = call(
            &app,
            "POST",
            &path(&c),
            json!({"revision":revision,"request_id":db::id()}),
            &a,
        )
        .await;
        assert_eq!(denied.0, StatusCode::BAD_REQUEST);
    }
    for message in [Value::Null, json!(true), json!("🌍".repeat(501))] {
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&c),
                json!({"revision":1,"message":message,"request_id":db::id()}),
                &a
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for key in [Value::Null, json!(true), json!("not-a-uuid")] {
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&c),
                json!({"revision":1,"request_id":key}),
                &a
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&c),
            json!({"revision":1,"message":"🌍".repeat(500),"request_id":db::id()}),
            &a
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&c),
            json!({"revision":1,"request_id":db::id()}),
            &a
        )
        .await
        .0,
        StatusCode::OK
    );
    for _ in 0..2 {
        let old = call(&app, "POST", &path(&c), json!({"revision":1}), &a).await;
        assert_eq!(old.0, StatusCode::OK);
        assert!(old.1.get("request_id").is_none());
    }
    assert_eq!(published(&s).await, (4, 4, 2));
}

#[tokio::test]
async fn version_audit_and_registry_failures_roll_back_whole_publication_and_allow_same_key_retry()
{
    for point in ["version", "audit", "registry"] {
        let (_t, s, app, a, c) = fixture(None).await;
        let key = db::id();
        let before = snapshot(&s).await;
        let sql = match point {
            "version" => {
                "CREATE TRIGGER publication_fault BEFORE INSERT ON records WHEN NEW.kind='version' BEGIN SELECT RAISE(ABORT,'fixture'); END"
            }
            "audit" => {
                "CREATE TRIGGER publication_fault BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='configuration.publish' BEGIN SELECT RAISE(ABORT,'fixture'); END"
            }
            _ => {
                "CREATE TRIGGER publication_fault BEFORE INSERT ON publication_requests BEGIN SELECT RAISE(ABORT,'fixture'); END"
            }
        };
        sqlx::query(sql).execute(&s.pool).await.unwrap();
        assert_eq!(
            call(&app, "POST", &path(&c), request(&key), &a).await.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{point}"
        );
        assert_eq!(snapshot(&s).await, before, "{point}");
        sqlx::query("DROP TRIGGER publication_fault")
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            call(&app, "POST", &path(&c), request(&key), &a).await.0,
            StatusCode::OK
        );
        assert_eq!(published(&s).await, (1, 1, 1));
    }
}

#[tokio::test]
async fn missing_original_result_is_a_tombstone_not_permission_to_publish_again() {
    let (_t, s, app, a, c) = fixture(None).await;
    let key = db::id();
    let req = request(&key);
    assert_eq!(
        call(&app, "POST", &path(&c), req.clone(), &a).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE publication_requests SET version_id=? WHERE actor_id=? AND request_id=?")
        .bind(db::id())
        .bind(&a.0)
        .bind(&key)
        .execute(&s.pool)
        .await
        .unwrap();
    let before = snapshot(&s).await;
    for (method, url, body) in [("GET", lookup(&key), Value::Null), ("POST", path(&c), req)] {
        let missing = call(&app, method, &url, body, &a).await;
        assert_eq!(missing.0, StatusCode::CONFLICT);
        assert_eq!(missing.1["error"]["code"], "CONFLICT");
        emit("unavailable_error", &missing.1);
    }
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn history_is_actor_pipeline_bound_strict_bounded_and_metadata_only() {
    let (_t, s, app, a, c) = fixture(None).await;
    let other = actor(&s, "operator").await;
    let c2 = create(&app, &a).await;
    for i in 0..105 {
        let key = format!("00000000-0000-4000-8000-{i:012}");
        sqlx::query("INSERT INTO publication_requests VALUES(?,?,?,?,?,?,?,?)")
            .bind(if i == 104 { &other.0 } else { &a.0 })
            .bind(&key)
            .bind(if i == 103 {
                c2["id"].as_str().unwrap()
            } else {
                c["id"].as_str().unwrap()
            })
            .bind("a".repeat(64))
            .bind(db::id())
            .bind(i + 1)
            .bind(1)
            .bind("2026-01-01T00:00:00Z")
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let url = format!(
        "/api/v1/configurations/publish-requests?configuration_id={}",
        c["id"].as_str().unwrap()
    );
    let before = snapshot(&s).await;
    let page = call(
        &app,
        "GET",
        &format!("{url}&page=2&page_size=50"),
        Value::Null,
        &a,
    )
    .await;
    assert_eq!(page.0, StatusCode::OK);
    assert_eq!(page.1["total"], 103);
    assert_eq!(page.1["items"].as_array().unwrap().len(), 50);
    assert_eq!(
        page.1["items"][0]["request_id"],
        "00000000-0000-4000-8000-000000000052"
    );
    for row in page.1["items"].as_array().unwrap() {
        assert_eq!(row.as_object().unwrap().len(), 6);
        assert_eq!(row["configuration_id"], c["id"]);
    }
    emit("discovery_history", &page.1);
    for query in [
        "page=0",
        "page=-1",
        "page_size=0",
        "page_size=51",
        "page=9007199254740992&page_size=1",
        "page=1&page=2",
        "unknown=private-marker",
        "page=%FF",
        "page=%",
        "page=1.5",
        "configuration_id=bad",
    ] {
        let denied = call(&app, "GET", &format!("{url}&{query}"), Value::Null, &a).await;
        assert_eq!(denied.0, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(denied.1["error"]["code"], "INVALID_INPUT");
        assert!(!denied.1.to_string().contains("private-marker"));
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/configurations/publish-requests",
            Value::Null,
            &a
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for suffix in ["?page=1", "?unknown=yes", "?x=%FF"] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("{}{suffix}", lookup(&db::id())),
                Value::Null,
                &a
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(snapshot(&s).await, before);
}

async fn validator() -> (
    String,
    std::sync::Arc<tokio::sync::Semaphore>,
    std::sync::Arc<tokio::sync::Semaphore>,
    tokio::task::JoinHandle<()>,
) {
    let entered = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let release = std::sync::Arc::new(tokio::sync::Semaphore::new(0));
    let e = entered.clone();
    let r = release.clone();
    let app = Router::new().route(
        "/validate",
        axum::routing::post(move || {
            let e = e.clone();
            let r = r.clone();
            async move {
                e.add_permits(1);
                r.acquire().await.unwrap().forget();
                axum::Json(json!({"valid":true,"vector_validated":true,"vector_version":"0.58.0"}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, entered, release, task)
}

#[tokio::test]
async fn committed_replay_does_not_invoke_worker_again_even_when_validation_capacity_is_busy() {
    let (url, entered, release, worker) = validator().await;
    let (_t, s, app, a, c) = fixture(Some(url)).await;
    let req = request(&db::id());
    let task = tokio::spawn({
        let app = app.clone();
        let a = a.clone();
        let path = path(&c);
        let req = req.clone();
        async move { call(&app, "POST", &path, req, &a).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    release.add_permits(1);
    let first = task.await.unwrap();
    assert_eq!(first.0, StatusCode::OK);
    worker.abort();
    let _all = s
        .validation_slots
        .acquire_many(s.validation_slots.available_permits() as u32)
        .await
        .unwrap();
    let before = snapshot(&s).await;
    let replay = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        call(&app, "POST", &path(&c), req, &a),
    )
    .await
    .unwrap();
    assert_eq!(replay, first);
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn concurrent_validator_misses_recheck_mapping_before_archived_draft_and_failed_commit_guards()
 {
    let (url, entered, release, worker) = validator().await;
    let (_t, s, app, a, c) = fixture(Some(url)).await;
    let req = request(&db::id());
    let spawn = || {
        let app = app.clone();
        let a = a.clone();
        let path = path(&c);
        let req = req.clone();
        tokio::spawn(async move { call(&app, "POST", &path, req, &a).await })
    };
    let one = spawn();
    let two = spawn();
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.acquire_many(2))
        .await
        .unwrap()
        .unwrap()
        .forget();
    release.add_permits(1);
    for _ in 0..100 {
        if published(&s).await.0 == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(published(&s).await, (1, 1, 1));
    assert_eq!(
        call(
            &app,
            "POST",
            &format!(
                "/api/v1/configurations/{}/archive",
                c["id"].as_str().unwrap()
            ),
            json!({"revision":1}),
            &a
        )
        .await
        .0,
        StatusCode::OK
    );
    release.add_permits(1);
    let (one, two) = (one.await.unwrap(), two.await.unwrap());
    assert_eq!(one.0, StatusCode::OK);
    assert_eq!(one, two);
    assert_eq!(published(&s).await, (1, 1, 1));
    worker.abort();
}

#[tokio::test]
async fn offboarding_during_external_validation_prevents_commit_and_registry_creation() {
    let (url, entered, release, worker) = validator().await;
    let (_t, s, app, _admin, c) = fixture(Some(url)).await;
    let a = actor(&s, "operator").await;
    let req = request(&db::id());
    let before = snapshot(&s).await;
    let task = tokio::spawn({
        let app = app.clone();
        let a = a.clone();
        let path = path(&c);
        async move { call(&app, "POST", &path, req, &a).await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    {
        let _guard = s.writer.lock().await;
        sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
            .bind(&a.0)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    release.add_permits(1);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(published(&s).await, (0, 0, 0));
    worker.abort();
}
