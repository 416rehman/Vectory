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
async fn fixture() -> (tempfile::TempDir, State, Router, Identity) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-private-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Pipeline request fixture".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let a = actor(&s, "admin").await;
    (temp, s.clone(), api::router(s), a)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    a: &Identity,
) -> (StatusCode, Value) {
    let r = app
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
    let status = r.status();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn request(key: Option<&str>) -> Value {
    let mut v = json!({"name":"Original requested name","description":"Original description","config":{"sources":{"in":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}},"opaque_extension":{"retain":true}},"graph":{"nodes":[],"edges":[]}});
    if let Some(key) = key {
        v["request_id"] = json!(key);
    }
    v
}
async fn source(app: &Router, a: &Identity) -> Value {
    let r = call(app, "POST", "/api/v1/configurations", request(None), a).await;
    assert_eq!(r.0, StatusCode::OK);
    r.1
}
fn path(c: &Value, action: &str) -> String {
    format!(
        "/api/v1/configurations/{}/{action}",
        c["id"].as_str().unwrap()
    )
}
fn lookup(key: &str) -> String {
    format!("/api/v1/configurations/requests/{key}")
}
fn duplicate(key: Option<&str>) -> Value {
    let mut v = json!({"revision":1,"name":"Requested copy"});
    if let Some(key) = key {
        v["request_id"] = json!(key);
    }
    v
}
fn emit(name: &str, v: &Value) {
    if let Ok(dir) = std::env::var("VECTORY_PIPELINE_REQUEST_FIXTURES") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            std::path::Path::new(&dir).join(format!("{name}.json")),
            serde_json::to_vec_pretty(v).unwrap(),
        )
        .unwrap();
    }
}
async fn snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let requests:Vec<String>=sqlx::query_scalar("SELECT json_array(actor_id,request_id,operation,source_configuration_id,source_revision,payload_sha256,configuration_id,created_at) FROM pipeline_requests ORDER BY actor_id,request_id").fetch_all(&s.pool).await.unwrap();
    let sequence: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(sequence,audit_id) FROM audit_sequence ORDER BY sequence",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    json!({"records":records,"requests":requests,"sequence":sequence})
}
async fn counts(s: &State) -> (i64, i64, i64, i64) {
    (sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='configuration'").fetch_one(&s.pool).await.unwrap(),sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='revision'").fetch_one(&s.pool).await.unwrap(),sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action') IN ('configuration.create','configuration.duplicate')").fetch_one(&s.pool).await.unwrap(),sqlx::query_scalar("SELECT count(*) FROM pipeline_requests").fetch_one(&s.pool).await.unwrap())
}
async fn change_and_archive(app: &Router, a: &Identity, c: &Value) -> Value {
    let changed=call(app,"PUT",&path(c,"draft"),json!({"revision":c["revision"],"name":"Later edited result","description":"Later description","config":{"sources":{},"sinks":{},"later_unknown":{"retained":true}},"graph":{"nodes":[],"edges":[]}}),a).await;
    assert_eq!(changed.0, StatusCode::OK, "{}", changed.1);
    let archived = call(
        app,
        "POST",
        &path(c, "archive"),
        json!({"revision":changed.1["revision"]}),
        a,
    )
    .await;
    assert_eq!(archived.0, StatusCode::OK);
    archived.1
}

#[tokio::test]
async fn create_replay_returns_current_edited_archived_original_without_reapplying_input() {
    let (_t, s, app, a) = fixture().await;
    let key = db::id();
    let absent = call(&app, "GET", &lookup(&key), Value::Null, &a).await;
    assert_eq!(absent.1, json!({"request_id":key,"found":false}));
    emit("absent_lookup", &absent.1);
    let req = request(Some(&key));
    let created = call(&app, "POST", "/api/v1/configurations", req.clone(), &a).await;
    assert_eq!(created.0, StatusCode::OK);
    emit("created_receipt", &created.1);
    let changed = change_and_archive(&app, &a, &created.1).await;
    let mut expected = changed.clone();
    expected["request_id"] = json!(key);
    let before = snapshot(&s).await;
    let replay = call(&app, "POST", "/api/v1/configurations", req, &a).await;
    assert_eq!(replay.1, expected);
    assert_eq!(replay.0, StatusCode::OK);
    emit("current_create_receipt", &replay.1);
    let found = call(&app, "GET", &lookup(&key.to_uppercase()), Value::Null, &a).await;
    assert_eq!(
        found.1,
        json!({"request_id":key,"found":true,"operation":"create","source_configuration_id":null,"source_revision":null,"configuration":expected})
    );
    emit("create_lookup", &found.1);
    let ordinary = call(
        &app,
        "GET",
        &format!("/api/v1/configurations/{}", changed["id"].as_str().unwrap()),
        Value::Null,
        &a,
    )
    .await;
    assert_eq!(ordinary.1, changed);
    assert!(ordinary.1.get("request_id").is_none());
    let stored_keys:i64=sqlx::query_scalar("SELECT count(*) FROM records WHERE kind IN ('configuration','revision') AND json_type(data,'$.request_id') IS NOT NULL").fetch_one(&s.pool).await.unwrap();
    assert_eq!(
        stored_keys, 0,
        "correlation must not enter draft or revision metadata"
    );
    assert_eq!(snapshot(&s).await, before);
    assert_eq!(counts(&s).await, (1, 3, 1, 1));
}

#[tokio::test]
async fn duplicate_replay_survives_source_edit_archive_removal_and_preserves_current_clone() {
    let (_t, s, app, a) = fixture().await;
    let original = source(&app, &a).await;
    let key = db::id();
    let req = duplicate(Some(&key));
    let copy = call(&app, "POST", &path(&original, "duplicate"), req.clone(), &a).await;
    assert_eq!(copy.0, StatusCode::OK);
    assert_eq!(copy.1["description"], original["description"]);
    emit("duplicate_receipt", &copy.1);
    let edited = change_and_archive(&app, &a, &copy.1).await;
    change_and_archive(&app, &a, &original).await;
    let mut expected = edited.clone();
    expected["request_id"] = json!(key);
    for remove in [false, true] {
        if remove {
            sqlx::query("DELETE FROM records WHERE kind='configuration' AND id=?")
                .bind(original["id"].as_str().unwrap())
                .execute(&s.pool)
                .await
                .unwrap();
        }
        let before = snapshot(&s).await;
        let replay = call(&app, "POST", &path(&original, "duplicate"), req.clone(), &a).await;
        assert_eq!(replay, (StatusCode::OK, expected.clone()));
        assert_eq!(snapshot(&s).await, before);
    }
    let found = call(&app, "GET", &lookup(&key), Value::Null, &a).await;
    assert_eq!(
        found.1,
        json!({"request_id":key,"found":true,"operation":"duplicate","source_configuration_id":original["id"],"source_revision":1,"configuration":expected})
    );
    emit("duplicate_missing_source_lookup", &found.1);
    let history = call(
        &app,
        "GET",
        "/api/v1/configurations/requests",
        Value::Null,
        &a,
    )
    .await;
    assert_eq!(
        history.1["items"][0]["source_configuration_id"],
        original["id"]
    );
    assert_eq!(history.1["items"][0]["source_revision"], 1);
    assert_eq!(history.1["items"][0]["configuration_name"], edited["name"]);
    emit("duplicate_history", &history.1);
}

#[tokio::test]
async fn concurrent_create_and_duplicate_retries_each_commit_one_initial_revision_and_audit() {
    for copying in [false, true] {
        let (_t, s, app, a) = fixture().await;
        let original = source(&app, &a).await;
        let key = db::id();
        let req = if copying {
            duplicate(Some(&key))
        } else {
            request(Some(&key))
        };
        let url = if copying {
            path(&original, "duplicate")
        } else {
            "/api/v1/configurations".into()
        };
        let (one, two) = tokio::join!(
            call(&app, "POST", &url, req.clone(), &a),
            call(&app, "POST", &url, req, &a)
        );
        assert_eq!(one.0, StatusCode::OK);
        assert_eq!(one, two);
        assert_eq!(counts(&s).await, (2, 2, 2, 1));
    }
}

#[tokio::test]
async fn shared_namespace_rejects_changed_operation_source_or_exact_supplied_body() {
    let (_t, s, app, a) = fixture().await;
    let original = source(&app, &a).await;
    let other = source(&app, &a).await;
    let key = db::id();
    let req = duplicate(Some(&key));
    assert_eq!(
        call(&app, "POST", &path(&original, "duplicate"), req.clone(), &a)
            .await
            .0,
        StatusCode::OK
    );
    let before = snapshot(&s).await;
    for (url, body) in [
        ("/api/v1/configurations".to_owned(), request(Some(&key))),
        (path(&other, "duplicate"), req.clone()),
        (
            path(&original, "duplicate"),
            json!({"request_id":key,"revision":1,"name":"Changed"}),
        ),
        (
            path(&original, "duplicate"),
            json!({"request_id":key,"revision":1,"name":"Requested copy","description":null}),
        ),
        (
            path(&original, "duplicate"),
            json!({"request_id":key,"revision":0,"name":"Requested copy"}),
        ),
    ] {
        let conflict = call(&app, "POST", &url, body, &a).await;
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(conflict.1["error"]["code"], "IDEMPOTENCY_CONFLICT");
        emit("binding_conflict_error", &conflict.1);
    }
    assert_eq!(snapshot(&s).await, before);
    let key = db::id();
    let mut req = request(Some(&key));
    req["unknown"] = json!({"z":[1,2],"a":null});
    let first = call(&app, "POST", "/api/v1/configurations", req.clone(), &a).await;
    assert_eq!(first.0, StatusCode::OK);
    let mut reordered = req.clone();
    reordered["unknown"] = serde_json::from_str(r#"{"a":null,"z":[1,2]}"#).unwrap();
    reordered["request_id"] = json!(key.to_uppercase());
    assert_eq!(
        call(&app, "POST", "/api/v1/configurations", reordered, &a).await,
        first
    );
    req["unknown"]["z"] = json!([2, 1]);
    assert_eq!(
        call(&app, "POST", "/api/v1/configurations", req, &a)
            .await
            .1["error"]["code"],
        "IDEMPOTENCY_CONFLICT"
    );
}

#[tokio::test]
async fn live_editor_authorization_csrf_actor_isolation_and_queued_demotion_guard_replays() {
    let (_t, s, app, a) = fixture().await;
    let key = db::id();
    let req = request(Some(&key));
    let first = call(&app, "POST", "/api/v1/configurations", req.clone(), &a).await;
    assert_eq!(first.0, StatusCode::OK);
    let editor = actor(&s, "editor").await;
    assert_eq!(
        call(&app, "GET", &lookup(&key), Value::Null, &editor)
            .await
            .1,
        json!({"request_id":key,"found":false})
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/configurations/requests",
            Value::Null,
            &editor
        )
        .await
        .1["total"],
        0
    );
    let second = call(&app, "POST", "/api/v1/configurations", req.clone(), &editor).await;
    assert_eq!(second.0, StatusCode::OK);
    assert_ne!(second.1["id"], first.1["id"]);
    for role in ["viewer", "operator"] {
        let denied = actor(&s, role).await;
        for (method, url, body) in [
            ("POST", "/api/v1/configurations".into(), req.clone()),
            (
                "POST",
                path(&first.1, "duplicate"),
                duplicate(Some(&db::id())),
            ),
            ("GET", lookup(&key), Value::Null),
            ("GET", "/api/v1/configurations/requests".into(), Value::Null),
        ] {
            let response = call(&app, method, &url, body, &denied).await;
            assert_eq!(response.0, StatusCode::FORBIDDEN);
            assert_eq!(response.1.as_object().unwrap().len(), 1);
            assert!(response.1.get("error").is_some());
            assert!(
                !response
                    .1
                    .to_string()
                    .contains(first.1["id"].as_str().unwrap())
            );
        }
    }
    let mut wrong = a.clone();
    wrong.2 = "wrong".into();
    assert_eq!(
        call(&app, "POST", "/api/v1/configurations", req.clone(), &wrong)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let before = snapshot(&s).await;
    let guard = s.writer.lock().await;
    let task = tokio::spawn({
        let app = app.clone();
        let a = editor.clone();
        let req = req.clone();
        async move { call(&app, "POST", "/api/v1/configurations", req, &a).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
        .bind(&editor.0)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::FORBIDDEN);
    assert_eq!(snapshot(&s).await, before);
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(&a.0)
        .execute(&s.pool)
        .await
        .unwrap();
    for (method, url, body) in [
        ("POST", "/api/v1/configurations".into(), req),
        ("GET", lookup(&key), Value::Null),
        ("GET", "/api/v1/configurations/requests".into(), Value::Null),
    ] {
        assert_eq!(
            call(&app, method, &url, body, &a).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn malformed_keys_new_revisions_and_payloads_never_allocate_but_unkeyed_legacy_still_works() {
    let (_t, s, app, a) = fixture().await;
    let original = source(&app, &a).await;
    let before = snapshot(&s).await;
    for key in [Value::Null, json!(12), json!("bad")] {
        for copying in [false, true] {
            let mut req = if copying {
                duplicate(None)
            } else {
                request(None)
            };
            req["request_id"] = key.clone();
            let url = if copying {
                path(&original, "duplicate")
            } else {
                "/api/v1/configurations".into()
            };
            assert_eq!(
                call(&app, "POST", &url, req, &a).await.0,
                StatusCode::BAD_REQUEST
            );
        }
    }
    for revision in [
        Value::Null,
        json!(0),
        json!(-1),
        json!(1.5),
        json!(9007199254740992u64),
    ] {
        let mut req = duplicate(Some(&db::id()));
        req["revision"] = revision;
        assert_eq!(
            call(&app, "POST", &path(&original, "duplicate"), req, &a)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    for bad in [
        json!({"request_id":db::id()}),
        json!({"request_id":db::id(),"name":"Incomplete","config":[],"graph":{"nodes":[],"edges":[]}}),
    ] {
        assert_eq!(
            call(&app, "POST", "/api/v1/configurations", bad, &a)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(snapshot(&s).await, before);
    for _ in 0..2 {
        for (url, body) in [
            ("/api/v1/configurations".into(), request(None)),
            (path(&original, "duplicate"), duplicate(None)),
        ] {
            let result = call(&app, "POST", &url, body, &a).await;
            assert_eq!(result.0, StatusCode::OK);
            assert!(result.1.get("request_id").is_none());
        }
    }
    assert_eq!(counts(&s).await, (5, 5, 5, 0));
}

#[tokio::test]
async fn both_operations_rollback_configuration_revision_audit_and_registry_on_each_write_failure()
{
    for copying in [false, true] {
        for point in ["configuration", "revision", "audit", "registry"] {
            let (_t, s, app, a) = fixture().await;
            let original = source(&app, &a).await;
            let key = db::id();
            let req = if copying {
                duplicate(Some(&key))
            } else {
                request(Some(&key))
            };
            let url = if copying {
                path(&original, "duplicate")
            } else {
                "/api/v1/configurations".into()
            };
            let before = snapshot(&s).await;
            let sql = if point == "registry" {
                "CREATE TRIGGER pipeline_fault BEFORE INSERT ON pipeline_requests BEGIN SELECT RAISE(ABORT,'fixture'); END".to_owned()
            } else {
                format!(
                    "CREATE TRIGGER pipeline_fault BEFORE INSERT ON records WHEN NEW.kind='{point}' BEGIN SELECT RAISE(ABORT,'fixture'); END"
                )
            };
            sqlx::query(&sql).execute(&s.pool).await.unwrap();
            assert_eq!(
                call(&app, "POST", &url, req.clone(), &a).await.0,
                StatusCode::INTERNAL_SERVER_ERROR,
                "{copying}/{point}"
            );
            assert_eq!(snapshot(&s).await, before);
            sqlx::query("DROP TRIGGER pipeline_fault")
                .execute(&s.pool)
                .await
                .unwrap();
            assert_eq!(call(&app, "POST", &url, req, &a).await.0, StatusCode::OK);
            assert_eq!(counts(&s).await, (2, 2, 2, 1));
        }
    }
}

#[tokio::test]
async fn missing_result_tombstone_survives_and_discovery_does_not_recreate_it() {
    for copying in [false, true] {
        let (_t, s, app, a) = fixture().await;
        let original = source(&app, &a).await;
        let key = db::id();
        let req = if copying {
            duplicate(Some(&key))
        } else {
            request(Some(&key))
        };
        let url = if copying {
            path(&original, "duplicate")
        } else {
            "/api/v1/configurations".into()
        };
        let result = call(&app, "POST", &url, req.clone(), &a).await;
        assert_eq!(result.0, StatusCode::OK);
        sqlx::query("DELETE FROM records WHERE kind='configuration' AND id=?")
            .bind(result.1["id"].as_str().unwrap())
            .execute(&s.pool)
            .await
            .unwrap();
        let before = snapshot(&s).await;
        for (method, url, body) in [("GET", lookup(&key), Value::Null), ("POST", url, req)] {
            let missing = call(&app, method, &url, body, &a).await;
            assert_eq!(missing.0, StatusCode::CONFLICT);
            assert_eq!(missing.1["error"]["code"], "CONFLICT");
            emit("missing_result_error", &missing.1);
        }
        let history = call(
            &app,
            "GET",
            "/api/v1/configurations/requests",
            Value::Null,
            &a,
        )
        .await;
        assert_eq!(history.1["total"], 1);
        assert_eq!(history.1["items"][0]["configuration_name"], Value::Null);
        emit("missing_result_history", &history.1);
        assert_eq!(snapshot(&s).await, before);
    }
}

#[tokio::test]
async fn discovery_strict_actor_paging_has_bounded_current_names_and_no_body_or_digest() {
    let (_t, s, app, a) = fixture().await;
    let other = actor(&s, "editor").await;
    let mut tx = s.pool.begin().await.unwrap();
    for i in 0..105 {
        let key = format!("00000000-0000-4000-8000-{i:012}");
        let id = db::id();
        let name = if i == 102 {
            json!("🌍".repeat(260))
        } else if i == 101 {
            json!({"private":"name-object-marker"})
        } else {
            json!(format!("Current {i}"))
        };
        db::insert(&mut tx,"configuration",&json!({"id":id,"name":name,"config":{"private":"private-config-marker".repeat(1500)},"graph":{"private":"private-graph-marker"},"extension":"private-extension-marker"})).await.unwrap();
        sqlx::query("INSERT INTO pipeline_requests VALUES(?,?,?,?,?,?,?,?)")
            .bind(if i == 104 { &other.0 } else { &a.0 })
            .bind(key)
            .bind("create")
            .bind(Option::<&str>::None)
            .bind(Option::<i64>::None)
            .bind("a".repeat(64))
            .bind(id)
            .bind("2026-01-01T00:00:00Z")
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let before = snapshot(&s).await;
    let page = call(
        &app,
        "GET",
        "/api/v1/configurations/requests?page=1&page_size=3",
        Value::Null,
        &a,
    )
    .await;
    assert_eq!(page.0, StatusCode::OK);
    assert_eq!(page.1["total"], 104);
    assert_eq!(
        page.1["items"][0]["request_id"],
        "00000000-0000-4000-8000-000000000103"
    );
    assert_eq!(
        page.1["items"][1]["configuration_name"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        240
    );
    assert!(page.1["items"][2]["configuration_name"].is_null());
    assert!(!page.1.to_string().contains("private-"));
    for item in page.1["items"].as_array().unwrap() {
        assert_eq!(item.as_object().unwrap().len(), 7);
    }
    emit("bounded_history", &page.1);
    let page2 = call(
        &app,
        "GET",
        "/api/v1/configurations/requests?page=3&page_size=50",
        Value::Null,
        &a,
    )
    .await;
    assert_eq!(page2.1["items"].as_array().unwrap().len(), 4);
    assert_eq!(
        page2.1["items"][0]["request_id"],
        "00000000-0000-4000-8000-000000000003"
    );
    for query in [
        "page=0",
        "page=-1",
        "page=1.5",
        "page_size=0",
        "page_size=51",
        "page=9007199254740992&page_size=1",
        "page=1&page=2",
        "unknown=private-query-marker",
        "page=%",
        "page=%FF",
    ] {
        let invalid = call(
            &app,
            "GET",
            &format!("/api/v1/configurations/requests?{query}"),
            Value::Null,
            &a,
        )
        .await;
        assert_eq!(invalid.0, StatusCode::BAD_REQUEST, "{query}");
        assert_eq!(invalid.1["error"]["code"], "INVALID_INPUT");
        assert!(!invalid.1.to_string().contains("private-query-marker"));
        assert_eq!(invalid.1.as_object().unwrap().len(), 1);
    }
    for suffix in ["?unknown=yes", "?page=1", "?page=%FF"] {
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
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/configurations/requests/bad",
            Value::Null,
            &a
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(snapshot(&s).await, before);
}

#[tokio::test]
async fn new_duplicate_respects_reviewed_source_and_missing_source_without_allocating() {
    let (_t, s, app, a) = fixture().await;
    let original = source(&app, &a).await;
    let archived = change_and_archive(&app, &a, &original).await;
    let before = snapshot(&s).await;
    let key = db::id();
    let stale = call(
        &app,
        "POST",
        &path(&original, "duplicate"),
        duplicate(Some(&key)),
        &a,
    )
    .await;
    assert_eq!(stale.1["error"]["code"], "STALE_REVISION");
    assert_eq!(snapshot(&s).await, before);
    let mut reviewed = duplicate(Some(&key));
    reviewed["revision"] = archived["revision"].clone();
    let copy = call(&app, "POST", &path(&original, "duplicate"), reviewed, &a).await;
    assert_eq!(copy.0, StatusCode::OK);
    assert_eq!(copy.1["archived"], false);
    assert_eq!(copy.1["config"], archived["config"]);
    let before = snapshot(&s).await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/configurations/{}/duplicate", db::id()),
            duplicate(Some(&db::id())),
            &a
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(snapshot(&s).await, before);
}
