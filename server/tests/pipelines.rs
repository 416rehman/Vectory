use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

#[tokio::test]
async fn library_requires_authentication_and_rejects_unbounded_queries() {
    let (_temp, s, app, _actor) = fixture(None).await;
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/configurations/library",
            Value::Null,
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for role in ["viewer", "editor", "operator", "admin"] {
        let actor = identity(&s, role).await;
        let (status, page) = call(
            &app,
            "GET",
            "/api/v1/configurations/library",
            Value::Null,
            Some(&actor),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page, json!({"items":[],"total":0,"page":1,"page_size":12}));
        for query in [
            "page=0",
            "page=-1",
            "page=1.5",
            "page_size=0",
            "page_size=51",
            "page=9007199254740992&page_size=1",
            "page=18446744073709551615&page_size=50",
            "state=hidden",
            "sort=random",
            "direction=sideways",
            "direction=asc&direction=desc",
            "unknown=yes",
            "page=1&page=2",
        ] {
            assert_eq!(
                call(
                    &app,
                    "GET",
                    &format!("/api/v1/configurations/library?{query}"),
                    Value::Null,
                    Some(&actor)
                )
                .await
                .0,
                StatusCode::BAD_REQUEST,
                "{role} {query}"
            );
        }
    }
    let actor = identity(&s, "viewer").await;
    for query in [
        "page=RAW_QUERY_SENTINEL",
        "RAW_QUERY_SENTINEL=yes",
        "page=1&page=RAW_QUERY_SENTINEL",
    ] {
        let (status, error) = call(
            &app,
            "GET",
            &format!("/api/v1/configurations/library?{query}"),
            Value::Null,
            Some(&actor),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["code"], "INVALID_INPUT");
        assert!(!error.to_string().contains("RAW_QUERY_SENTINEL"));
    }
    for (search, status) in [
        ("a".repeat(201), StatusCode::BAD_REQUEST),
        ("%F0%9F%8C%90".repeat(200), StatusCode::OK),
        ("%F0%9F%8C%90".repeat(201), StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &format!("/api/v1/configurations/library?search={search}"),
                Value::Null,
                Some(&actor)
            )
            .await
            .0,
            status
        );
    }
}

#[tokio::test]
async fn library_pages_large_drafts_without_payloads_and_preserves_order_and_counts() {
    let (_temp, s, app, actor) = fixture(None).await;
    let mut tx = s.pool.begin().await.unwrap();
    let payload = "payload-must-stay-in-sqlite".repeat(1400);
    for n in 1..=1000 {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let time = (chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z").unwrap()
            + chrono::Duration::seconds(n))
        .to_rfc3339();
        let mut config = json!({"id":id,"name":format!("Pipeline {:04}",1000-n),"description":if n==999 {"Literal 100%_ [test]"} else {"Ordinary pipeline"},"revision":1,"created_at":time,"updated_at":time,"config":{"sources":{"a":{"type":"demo_logs"},"b":{"type":"internal_metrics"}},"transforms":{"opaque":{"type":"custom","payload":payload}},"sinks":{"out":{"type":"blackhole","inputs":["a"]}}},"graph":{"nodes":[{"payload":payload}],"edges":[]},"archived":n%5==0,"archived_at":null});
        if n == 999 {
            config.as_object_mut().unwrap().remove("archived");
            config.as_object_mut().unwrap().remove("archived_at");
        }
        db::insert(&mut tx, "configuration", &config).await.unwrap();
    }
    let selected = "00000000-0000-4000-8000-000000000999";
    for n in [2, 10, 3] {
        db::insert(&mut tx,"version",&json!({"id":format!("10000000-0000-4000-8000-{n:012}"),"configuration_id":selected,"number":n,"created_at":"2026-01-01T00:00:00Z","config":{"payload":payload},"graph":{"payload":payload},"artifact":payload,"validation":{"payload":payload}})).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (status, page) = call(
        &app,
        "GET",
        "/api/v1/configurations/library",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 800);
    assert_eq!(page["items"].as_array().unwrap().len(), 12);
    assert_eq!(page["items"][0]["id"], selected);
    assert_eq!(page["items"][0]["archived"], false);
    assert!(page["items"][0]["archived_at"].is_null());
    assert_eq!(
        page["items"][0]["component_counts"],
        json!({"sources":2,"transforms":1,"sinks":1})
    );
    assert_eq!(page["items"][0]["latest_version"]["number"], 10);
    assert!(page["items"][1]["latest_version"].is_null());
    assert!(page.to_string().len() < 12000);
    assert!(!page.to_string().contains("payload-must-stay-in-sqlite"));
    for item in page["items"].as_array().unwrap() {
        for field in ["config", "graph", "artifact", "validation"] {
            assert!(item.get(field).is_none());
            assert!(item["latest_version"].get(field).is_none());
        }
    }
    let (_, second) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?page=2",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(
        second["items"][0]["id"],
        "00000000-0000-4000-8000-000000000984"
    );
    let (_, archived) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?state=archived&sort=name&page_size=50",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(archived["total"], 200);
    assert_eq!(archived["items"].as_array().unwrap().len(), 50);
    assert_eq!(archived["items"][0]["name"], "Pipeline 0000");
    let (_, all) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?state=all&page=10000",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(all["total"], 1000);
    assert_eq!(all["items"], json!([]));
    for search in ["%20literal%20", "100%25_", "%5Btest%5D"] {
        let (_, filtered) = call(
            &app,
            "GET",
            &format!("/api/v1/configurations/library?search={search}"),
            Value::Null,
            Some(&actor),
        )
        .await;
        assert_eq!(filtered["total"], 1, "{search}");
        assert_eq!(filtered["items"][0]["id"], selected);
    }
    let (_, not_wildcard) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?search=%25%25",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(not_wildcard["total"], 0);
    let (_, full) = call(
        &app,
        "GET",
        &format!("/api/v1/configurations/{selected}"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(full["config"]["transforms"]["opaque"]["payload"], payload);
}

#[tokio::test]
async fn library_metadata_tracks_edits_archive_versions_and_malformed_draft_sections() {
    let (_temp, s, app, actor) = fixture(None).await;
    let original = create(&app, &actor, "Zulu").await;
    let original = save(
        &app,
        &actor,
        &original,
        json!({"sources":null,"transforms":[],"sinks":"unfinished"}),
    )
    .await;
    let (_, page) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?sort=name",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(page["items"][0]["name"], "Current pipeline name");
    assert_eq!(
        page["items"][0]["component_counts"],
        json!({"sources":0,"transforms":0,"sinks":0})
    );
    let original = save(&app, &actor, &original, base()).await;
    let version = command(&app, &actor, &original, "publish", json!({})).await;
    let archived = command(&app, &actor, &original, "archive", json!({})).await;
    let (_, page) = call(
        &app,
        "GET",
        "/api/v1/configurations/library",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(page["total"], 0);
    let (_, page) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?state=archived",
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(page["items"][0]["revision"], archived["revision"]);
    assert_eq!(page["items"][0]["latest_version"]["id"], version["id"]);
    let mut other = archived.clone();
    other["id"] = json!(db::id());
    db::insert(
        &mut *s.pool.acquire().await.unwrap(),
        "configuration",
        &other,
    )
    .await
    .unwrap();
    let (_, page) = call(
        &app,
        "GET",
        "/api/v1/configurations/library?state=all&sort=name",
        Value::Null,
        Some(&actor),
    )
    .await;
    let ids = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
}

#[tokio::test]
async fn overview_activity_projects_bounded_current_names_without_pipeline_payloads() {
    let (_temp, s, app, actor) = fixture(None).await;
    let pipeline = create(&app, &actor, "Readable pipeline").await;
    let version = command(&app, &actor, &pipeline, "publish", json!({})).await;
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..25 {
        db::insert(&mut tx,"audit",&json!({"id":db::id(),"actor":actor.id,"target":if n%3==0 {pipeline["id"].as_str().unwrap()} else if n%3==1 {version["id"].as_str().unwrap()} else {"missing-target"},"action":"test.activity","outcome":"success","created_at":format!("2099-01-01T00:00:{n:02}Z")})).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (status, page) = call(&app, "GET", "/api/v1/overview", Value::Null, Some(&actor)).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["configurations_total"], 1);
    assert_eq!(page["recent_activity"].as_array().unwrap().len(), 20);
    for entry in page["recent_activity"].as_array().unwrap() {
        assert_eq!(entry["actor_id"], actor.id);
        assert_eq!(entry["actor"], "Test admin");
        if entry["target"] == "missing-target" {
            assert!(entry["target_name"].is_null());
        } else {
            assert_eq!(entry["target_name"], "Readable pipeline");
        }
        for field in ["config", "graph", "artifact"] {
            assert!(entry.get(field).is_none());
        }
    }
}

#[tokio::test]
async fn audit_recency_uses_insertion_order_with_same_second_timestamps_and_identity_names() {
    let (_temp, s, app, actor) = fixture(None).await;
    let pipeline = create(&app, &actor, "Same-second pipeline").await;
    let version = command(&app, &actor, &pipeline, "publish", json!({})).await;
    let device_id = "aaaaaaaa-0000-4000-8000-000000000001";
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(device_id)
        .bind("Same-second device")
        .bind(json!({"id":device_id,"name":"Same-second device"}).to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    let newer = "ffffffff-0000-4000-8000-000000000001";
    db::insert(&mut tx,"audit",&json!({"id":newer,"actor":actor.id,"target":actor.id,"action":"test.newer","outcome":"success","created_at":"2099-01-01T00:00:01Z"})).await.unwrap();
    let mut inserted = Vec::new();
    // Ascending IDs deliberately put the oldest events first under the former
    // UUID tie-break, opposing the required newest-inserted-first order.
    for n in 0..30 {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let actor_id = if n % 2 == 0 {
            actor.id.as_str()
        } else {
            device_id
        };
        let target = match n % 5 {
            0 => pipeline["id"].as_str().unwrap(),
            1 => version["id"].as_str().unwrap(),
            2 => device_id,
            3 => actor.id.as_str(),
            _ => "missing-target",
        };
        db::insert(&mut tx,"audit",&json!({"id":id,"actor":actor_id,"target":target,"action":"test.same_second","outcome":"success","created_at":"2099-01-01T00:00:00Z"})).await.unwrap();
        inserted.push((id, actor_id.to_string(), target.to_string()));
    }
    db::insert(&mut tx,"audit",&json!({"id":"ffffffff-0000-4000-8000-000000000002","actor":actor.id,"target":pipeline["id"],"action":"test.older","outcome":"success","created_at":"2098-12-31T23:59:59Z"})).await.unwrap();
    tx.commit().await.unwrap();
    let (status, overview) = call(&app, "GET", "/api/v1/overview", Value::Null, Some(&actor)).await;
    assert_eq!(status, StatusCode::OK, "{overview}");
    let recent = overview["recent_activity"].as_array().unwrap();
    assert_eq!(recent.len(), 20);
    assert_eq!(recent[0]["id"], newer);
    let (status, audit) = call(&app, "GET", "/api/v1/audit", Value::Null, Some(&actor)).await;
    assert_eq!(status, StatusCode::OK, "{audit}");
    let audit = audit.as_array().unwrap();
    assert_eq!(audit[0]["id"], newer);
    for (position, (id, actor_id, target)) in inserted.iter().rev().enumerate() {
        let event = &audit[position + 1];
        assert_eq!(event["id"], *id);
        assert_eq!(event["actor_id"], *actor_id);
        let name = if actor_id == device_id {
            "Same-second device"
        } else {
            "Test admin"
        };
        assert_eq!(event["actor"], name);
        if position < 19 {
            let event = &recent[position + 1];
            assert_eq!(event["id"], *id);
            assert_eq!(event["actor_id"], *actor_id);
            assert_eq!(event["actor"], name);
            let target_name = if target == device_id {
                json!("Same-second device")
            } else if target == &actor.id {
                json!("Test admin")
            } else if target == "missing-target" {
                Value::Null
            } else {
                json!("Same-second pipeline")
            };
            assert_eq!(event["target_name"], target_name);
        }
    }
    assert_eq!(audit[31]["action"], "test.older");
    // The sequence tie-break is internal; the public audit/event wire stays intact.
    assert!(
        recent
            .iter()
            .chain(audit.iter())
            .all(|event| event.get("insertion_order").is_none() && event.get("rowid").is_none())
    );
    let sequences_before: Vec<(i64, String)> =
        sqlx::query_as("SELECT sequence,audit_id FROM audit_sequence ORDER BY sequence")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    // The trigger participates in the caller's transaction. A failed operation
    // must leave neither an audit record nor a committed ordering entry.
    let rolled_back = db::id();
    let mut tx = s.pool.begin().await.unwrap();
    db::insert(&mut tx,"audit",&json!({"id":rolled_back,"actor":actor.id,"target":pipeline["id"],"action":"test.rollback","created_at":"2100-01-01T00:00:00Z"})).await.unwrap();
    let mapped: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_sequence WHERE audit_id=?")
        .bind(&rolled_back)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(mapped, 1);
    tx.rollback().await.unwrap();
    let records: i64 =
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND id=?")
            .bind(&rolled_back)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(records, 0);
    sqlx::query("VACUUM").execute(&s.pool).await.unwrap();
    let sequences_after: Vec<(i64, String)> =
        sqlx::query_as("SELECT sequence,audit_id FROM audit_sequence ORDER BY sequence")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(sequences_before, sequences_after);
    let (_, after) = call(&app, "GET", "/api/v1/overview", Value::Null, Some(&actor)).await;
    assert_eq!(after["recent_activity"], overview["recent_activity"]);
    let (_, after) = call(&app, "GET", "/api/v1/audit", Value::Null, Some(&actor)).await;
    assert_eq!(after.as_array().unwrap(), audit);
}

#[tokio::test]
async fn audit_sequence_migration_backfills_existing_events_and_indexes_new_inserts_atomically() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
        .execute(&pool)
        .await
        .unwrap();
    for (kind, id, time) in [
        ("audit", "newer", "2026-01-02"),
        ("audit", "same-a", "2026-01-01"),
        ("configuration", "not-audit", "2026-01-01"),
        ("audit", "same-z", "2026-01-01"),
        ("audit", "older", "2025-12-31"),
    ] {
        sqlx::query("INSERT INTO records VALUES(?,?,?,?)")
            .bind(kind)
            .bind(id)
            .bind(json!({"id":id,"created_at":time}).to_string())
            .bind(time)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::raw_sql(include_str!("../migrations/0010_audit_sequence.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT audit_id FROM audit_sequence ORDER BY sequence")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ids, vec!["older", "same-a", "same-z", "newer"]);
    let latest: i64 = sqlx::query_scalar("SELECT max(sequence) FROM audit_sequence")
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO records VALUES('audit','new','{\"id\":\"new\"}','2026-01-01')")
        .execute(&pool)
        .await
        .unwrap();
    let sequence: i64 =
        sqlx::query_scalar("SELECT sequence FROM audit_sequence WHERE audit_id='new'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(sequence > latest);
    // If sequence insertion fails, SQLite must reject the audit insert too.
    sqlx::query("CREATE TRIGGER reject_ordering BEFORE INSERT ON audit_sequence WHEN new.audit_id='rejected' BEGIN SELECT RAISE(ABORT,'injected failure'); END").execute(&pool).await.unwrap();
    assert!(
        sqlx::query(
            "INSERT INTO records VALUES('audit','rejected','{\"id\":\"rejected\"}','2026-01-01')"
        )
        .execute(&pool)
        .await
        .is_err()
    );
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND id='rejected'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0);
}

struct Identity {
    id: String,
    cookie: String,
    csrf: String,
}
async fn identity(s: &State, role: &str) -> Identity {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Test {role}"))
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
    Identity {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn fixture(validation_url: Option<String>) -> (tempfile::TempDir, State, Router, Identity) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-test-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Pipeline tests".into(),
        validation_url,
        ..Default::default()
    })
    .await
    .unwrap();
    let actor = identity(&state, "admin").await;
    let app = api::router(state.clone());
    (temp, state, app, actor)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    value: Value,
    actor: Option<&Identity>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(actor) = actor {
        request = request
            .header("cookie", &actor.cookie)
            .header("x-csrf-token", &actor.csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn base() -> Value {
    json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}}})
}

#[tokio::test]
async fn public_validation_and_test_routes_never_forward_worker_diagnostics() {
    use axum::{Json, routing::post};
    let hostile = "SECRET_VALUE /private/host/path";
    let worker = Router::new()
        .route(
            "/validate",
            post(move || async move {
                Json(json!({"valid":false,"vector_validated":false,"vector_version":"0.58.0","errors":[hostile],"warnings":[hostile],"native_issue":{"code":"REQUIRED_FIELD","section":"sources","component":"sample","field":"SECRET_VALUE","message":hostile}}))
            }),
        )
        .route(
            "/tests",
            post(move |Json(input): Json<Value>| async move {
                let has_tests = input["config"]["tests"]
                    .as_array()
                    .is_some_and(|tests| !tests.is_empty());
                Json(json!({"valid":false,"tests_run":has_tests,"vector_version":"0.58.0","errors":[hostile],"warnings":[hostile],"output":hostile,"native_issue":{"code":"PIPELINE_TEST_FAILED"}}))
            }),
        )
        .route(
            "/vrl-test",
            post(move |Json(input): Json<Value>| async move {
                if input["program"] == "fail" {
                    Json(json!({"valid":false,"output":hostile,"errors":[hostile]}))
                } else {
                    Json(json!({"valid":true,"output":{"ok":true},"errors":[]}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let worker_task = tokio::spawn(async move { axum::serve(listener, worker).await.unwrap() });
    let (_temp, _state, app, actor) = fixture(Some(format!("http://{address}"))).await;
    let pipeline = create(&app, &actor, "Sanitized diagnostics").await;
    let (status, checked) = call(
        &app,
        "POST",
        &path(&pipeline, "validate"),
        json!({"config":base()}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{checked}");
    assert_eq!(checked["valid"], false);
    assert!(!checked.to_string().contains(hostile));
    assert!(!checked.to_string().contains("native_issue"));

    let mut with_tests = base();
    with_tests["tests"] = json!([{"name":"synthetic","inputs":[{"insert_at":"sample","type":"log","log_fields":{"message":"example"}}],"outputs":[{"extract_from":"sample","conditions":["true"]}]}]);
    let (status, tested) = call(
        &app,
        "POST",
        "/api/v1/configurations/test",
        json!({"config":with_tests}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{tested}");
    assert_eq!(tested["tests_run"], true);
    assert_eq!(tested["valid"], false);
    assert!(!tested.to_string().contains(hostile));
    assert!(!tested.to_string().contains("native_issue"));

    let (status, empty) = call(
        &app,
        "POST",
        "/api/v1/configurations/test",
        json!({"config":base()}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty["valid"], false);
    assert_eq!(empty["tests_run"], false);
    assert!(empty["errors"].to_string().contains("Add at least one"));
    assert!(!empty.to_string().contains(hostile));

    for (program, expected_valid) in [("fail", false), (".ok = true", true)] {
        let (status, tested) = call(
            &app,
            "POST",
            "/api/v1/vrl/test",
            json!({"program":program,"sample":{"message":"example"}}),
            Some(&actor),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{tested}");
        assert_eq!(tested["valid"], expected_valid);
        assert!(!tested.to_string().contains(hostile));
        if expected_valid {
            assert_eq!(tested["output"], json!({"ok":true}));
        } else {
            assert_eq!(tested["output"], Value::Null);
        }
    }
    worker_task.abort();
}
async fn create(app: &Router, actor: &Identity, name: &str) -> Value {
    let (status,configuration)=call(app,"POST","/api/v1/configurations",json!({"name":name,"description":"Original description","config":base(),"graph":{"nodes":[],"edges":[]}}),Some(actor)).await;
    assert_eq!(status, StatusCode::OK, "{configuration}");
    configuration
}
fn path(configuration: &Value, action: &str) -> String {
    format!(
        "/api/v1/configurations/{}/{action}",
        configuration["id"].as_str().unwrap()
    )
}
async fn command(
    app: &Router,
    actor: &Identity,
    configuration: &Value,
    action: &str,
    mut body: Value,
) -> Value {
    body["revision"] = configuration["revision"].clone();
    let (status, out) = call(app, "POST", &path(configuration, action), body, Some(actor)).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    out
}
async fn save(app: &Router, actor: &Identity, configuration: &Value, config: Value) -> Value {
    let(status,out)=call(app,"PUT",&path(configuration,"draft"),json!({"revision":configuration["revision"],"config":config,"graph":configuration["graph"],"name":"Current pipeline name","description":"Current description"}),Some(actor)).await;
    assert_eq!(status, StatusCode::OK, "{out}");
    out
}

#[tokio::test]
async fn configured_worker_outage_blocks_device_deferred_publication() {
    use std::sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    };

    let response_mode = Arc::new(AtomicU8::new(0));
    let worker_mode = response_mode.clone();
    let worker = Router::new().route(
        "/validate",
        axum::routing::post(move || {
            let mode = worker_mode.load(Ordering::SeqCst);
            async move {
                match mode {
                    0 => (StatusCode::SERVICE_UNAVAILABLE, axum::Json(json!({}))),
                    1 => (
                        StatusCode::OK,
                        axum::Json(json!({"valid":true,"deferred":false,"vector_validated":true,"vector_version":"0.58.0"})),
                    ),
                    2 => (
                        StatusCode::OK,
                        axum::Json(json!({"valid":true,"deferred":true,"deferred_reasons":["unrelated resource"],"vector_validated":false,"vector_version":"0.58.0"})),
                    ),
                    3 => (
                        StatusCode::OK,
                        axum::Json(json!({"valid":false,"vector_validated":false,"vector_version":"0.58.0"})),
                    ),
                    _ => (
                        StatusCode::OK,
                        axum::Json(json!({"valid":true,"deferred":true,"deferred_reasons":["platform-specific source journald"],"vector_validated":false,"vector_version":"0.58.0"})),
                    ),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let worker_task = tokio::spawn(async move { axum::serve(listener, worker).await.unwrap() });
    let (_temp, _state, app, actor) = fixture(Some(format!("http://{address}"))).await;
    let created = create(&app, &actor, "Device-deferred validation").await;
    let config = json!({"sources":{"input":{"type":"journald"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}});
    assert_eq!(vectory_server::validation::validate(&config)["valid"], true);
    let draft = save(&app, &actor, &created, config.clone()).await;

    let (status, check) = call(
        &app,
        "POST",
        &path(&draft, "validate"),
        json!({"config":config}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["valid"], false, "{check}");
    assert_eq!(check["deferred"], true);
    assert_eq!(check["vector_validated"], false);
    assert!(
        check["errors"]
            .to_string()
            .contains("publication is blocked")
    );
    for mode in [0, 1, 2, 3] {
        response_mode.store(mode, Ordering::SeqCst);
        let (status, rejection) = call(
            &app,
            "POST",
            &path(&draft, "publish"),
            json!({"revision":draft["revision"]}),
            Some(&actor),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "mode {mode}: {rejection}"
        );
        assert_eq!(rejection["error"]["code"], "VALIDATION_FAILED");
        if mode == 3 {
            assert!(
                rejection
                    .to_string()
                    .contains("Isolated validator rejected")
            );
            assert!(!rejection.to_string().contains("Vector rejected"));
        }
    }
    let (_, versions) = call(
        &app,
        "GET",
        &path(&draft, "versions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(versions, json!([]));

    response_mode.store(4, Ordering::SeqCst);
    let version = command(&app, &actor, &draft, "publish", json!({})).await;
    assert_eq!(version["validation"]["valid"], true);
    assert_eq!(version["validation"]["deferred"], true);
    assert_eq!(version["validation"]["vector_validated"], false);
    assert!(
        version["validation"]["deferred_reasons"]
            .to_string()
            .contains("journald")
    );
    assert!(
        version["validation"]["warnings"]
            .to_string()
            .contains("Native validation is deferred")
    );
    worker_task.abort();

    let (_local_temp, local_state, _local_app, _local_actor) = fixture(None).await;
    let local = vectory_server::validation::validate_isolated(&local_state, &config)
        .await
        .unwrap();
    assert_eq!(local["valid"], true);
    assert_eq!(local["deferred"], true);
    assert_eq!(local["vector_validated"], false);
}

#[tokio::test]
async fn structural_only_preview_blocks_known_option_errors_at_publish() {
    let (_temp, _state, app, actor) = fixture(None).await;
    let created = create(&app, &actor, "Validate options before publishing").await;
    let mut invalid = base();
    invalid["transforms"] = json!({"pick":{"type":"sample","inputs":["sample"]}});
    invalid["sinks"]["out"]["inputs"] = json!(["pick"]);
    let edited = save(&app, &actor, &created, invalid.clone()).await;
    let (check_status, check) = call(
        &app,
        "POST",
        &path(&edited, "validate"),
        json!({"config":invalid}),
        Some(&actor),
    )
    .await;
    assert_eq!(check_status, StatusCode::OK, "{check}");
    assert_eq!(check["valid"], false, "{check}");
    assert_eq!(check["vector_validated"], false);
    assert!(
        check["errors"]
            .to_string()
            .contains("exactly one of rate or ratio")
    );
    let (status, rejected) = call(
        &app,
        "POST",
        &path(&edited, "publish"),
        json!({"revision":edited["revision"]}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    let (_, versions) = call(
        &app,
        "GET",
        &path(&edited, "versions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(versions, json!([]));

    let mut repaired = invalid;
    repaired["transforms"]["pick"]["rate"] = json!(10);
    repaired["sinks"]["out"]["buffer"] = json!({"type":"memory","max_events":0});
    let edited = save(&app, &actor, &edited, repaired.clone()).await;
    let (status, rejected) = call(
        &app,
        "POST",
        &path(&edited, "publish"),
        json!({"revision":edited["revision"]}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert!(rejected.to_string().contains("max_events"));

    repaired["sinks"]["out"]["buffer"] =
        json!({"type":"memory","max_events":500,"max_size":"${DEVICE_BUFFER_SIZE}"});
    let edited = save(&app, &actor, &edited, repaired.clone()).await;
    let (status, rejected) = call(
        &app,
        "POST",
        &path(&edited, "publish"),
        json!({"revision":edited["revision"]}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{rejected}");
    assert!(
        rejected
            .to_string()
            .contains("cannot combine max_events and max_size")
    );

    repaired["sinks"]["out"]["buffer"] = json!({"type":"memory","max_events":500});
    let edited = save(&app, &actor, &edited, repaired).await;
    let version = command(&app, &actor, &edited, "publish", json!({})).await;
    assert_eq!(version["validation"]["valid"], true);
    assert_eq!(version["validation"]["vector_validated"], false);
}

#[tokio::test]
async fn duplicate_copies_saved_unknown_fields_into_independent_unassigned_draft() {
    let (_temp, s, app, actor) = fixture(None).await;
    let original = create(&app, &actor, "Original").await;
    let version = command(&app, &actor, &original, "publish", json!({})).await;
    assert_eq!(version["author_id"], actor.id);
    assert_eq!(version["source_revision"], 1);
    let mut config = base();
    config["opaque_extension"] = json!({"nested":[1,{"unknown":true}]});
    let source = save(&app, &actor, &original, config).await;
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&source, "duplicate"),
            json!({"revision":1,"name":"Stale copy"}),
            Some(&actor)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let archived = command(&app, &actor, &source, "archive", json!({})).await;
    let copy = command(
        &app,
        &actor,
        &archived,
        "duplicate",
        json!({"name":"Independent"}),
    )
    .await;
    assert_ne!(copy["id"], source["id"]);
    assert_eq!(copy["revision"], 1);
    assert_eq!(copy["archived"], false);
    assert!(copy["archived_at"].is_null());
    assert_eq!(copy["config"], source["config"]);
    assert_eq!(copy["graph"], source["graph"]);
    assert_eq!(copy["description"], source["description"]);
    let (_, versions) = call(
        &app,
        "GET",
        &path(&copy, "versions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(versions, json!([]));
    let (_, revisions) = call(
        &app,
        "GET",
        &path(&copy, "revisions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(revisions.as_array().unwrap().len(), 1);
    assert_eq!(
        revisions[0]["source"],
        json!({"kind":"draft","id":source["id"],"revision":archived["revision"]})
    );
    let edited = save(&app, &actor, &copy, json!({"sources":{},"sinks":{}})).await;
    assert_ne!(edited["config"], source["config"]);
    let saved_source = db::record(
        &mut s.pool.acquire().await.unwrap(),
        "configuration",
        source["id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(saved_source, archived);
    let deployments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='deployment'")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(deployments, 0);
}

#[tokio::test]
async fn restore_appends_revision_preserves_current_metadata_and_immutable_source() {
    let (_temp, s, app, actor) = fixture(None).await;
    let original = create(&app, &actor, "Original").await;
    let version = command(
        &app,
        &actor,
        &original,
        "publish",
        json!({"message":"Initial immutable version"}),
    )
    .await;
    let (_, revisions) = call(
        &app,
        "GET",
        &path(&original, "revisions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    let old = revisions[0].clone();
    let current = save(
        &app,
        &actor,
        &original,
        json!({"sources":{},"sinks":{},"opaque":[1,2,3]}),
    )
    .await;
    let restored = command(
        &app,
        &actor,
        &current,
        "restore",
        json!({"revision_id":old["id"],"message":"Recover original content"}),
    )
    .await;
    assert_eq!(restored["revision"], 3);
    assert_eq!(restored["config"], original["config"]);
    assert_eq!(restored["graph"], original["graph"]);
    assert_eq!(restored["name"], current["name"]);
    assert_eq!(restored["description"], current["description"]);
    let again = command(
        &app,
        &actor,
        &restored,
        "restore",
        json!({"version_id":version["id"]}),
    )
    .await;
    assert_eq!(again["revision"], 4);
    let (_, history) = call(
        &app,
        "GET",
        &path(&again, "revisions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(
        history
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["revision"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![4, 3, 2, 1]
    );
    assert_eq!(
        history[0]["source"],
        json!({"kind":"version","id":version["id"]})
    );
    assert_eq!(
        history[1]["source"],
        json!({"kind":"revision","id":old["id"]})
    );
    assert_eq!(history[3], old);
    let immutable = db::record(
        &mut s.pool.acquire().await.unwrap(),
        "version",
        version["id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(immutable, version);
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&again, "restore"),
            json!({"revision":3,"revision_id":old["id"]}),
            Some(&actor)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn restore_requires_same_pipeline_one_source_and_safe_stored_fields() {
    let (_temp, s, app, actor) = fixture(None).await;
    let original = create(&app, &actor, "First").await;
    let foreign = create(&app, &actor, "Other").await;
    let foreign_version = command(&app, &actor, &foreign, "publish", json!({})).await;
    let (_, history) = call(
        &app,
        "GET",
        &path(&foreign, "revisions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    for body in [
        json!({}),
        json!({"revision_id":history[0]["id"],"version_id":foreign_version["id"]}),
        json!({"revision_id":history[0]["id"]}),
        json!({"version_id":foreign_version["id"]}),
        json!({"revision_id":null}),
    ] {
        let mut body = body;
        body["revision"] = original["revision"].clone();
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&original, "restore"),
                body,
                Some(&actor)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (mut unsafe_snapshot, secret) =
        (history[0].clone(), "SYNTHETIC_FORBIDDEN_STORED_CREDENTIAL");
    unsafe_snapshot["id"] = json!(db::id());
    unsafe_snapshot["configuration_id"] = original["id"].clone();
    unsafe_snapshot["config"]["sinks"]["out"]["password"] = json!(secret);
    db::insert(
        &mut s.pool.acquire().await.unwrap(),
        "revision",
        &unsafe_snapshot,
    )
    .await
    .unwrap();
    let (status, error) = call(
        &app,
        "POST",
        &path(&original, "restore"),
        json!({"revision":1,"revision_id":unsafe_snapshot["id"]}),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!error.to_string().contains(secret));
    let current = db::record(
        &mut s.pool.acquire().await.unwrap(),
        "configuration",
        original["id"].as_str().unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(current, original);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!(
                "{}/{}",
                path(&original, "revisions"),
                history[0]["id"].as_str().unwrap()
            ),
            Value::Null,
            Some(&actor)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn lifecycle_requires_editor_or_admin_with_csrf_and_readers_can_inspect() {
    let (_temp, s, app, admin) = fixture(None).await;
    let c = create(&app, &admin, "Permissions").await;
    for role in ["viewer", "operator"] {
        let actor = identity(&s, role).await;
        for action in ["duplicate", "restore", "archive", "unarchive"] {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &path(&c, action),
                    json!({"revision":1,"name":"Copy"}),
                    Some(&actor)
                )
                .await
                .0,
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            call(&app, "GET", &path(&c, "history"), Value::Null, Some(&actor))
                .await
                .0,
            StatusCode::OK
        );
    }
    let mut editor = identity(&s, "editor").await;
    let csrf = editor.csrf.clone();
    editor.csrf.clear();
    assert_eq!(
        call(
            &app,
            "POST",
            &path(&c, "archive"),
            json!({"revision":1}),
            Some(&editor)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    editor.csrf = csrf;
    let archived = command(&app, &editor, &c, "archive", json!({})).await;
    assert_eq!(
        command(&app, &editor, &archived, "unarchive", json!({})).await["archived"],
        false
    );
    assert_eq!(
        call(&app, "GET", &path(&c, "history"), Value::Null, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn archive_blocks_draft_writes_but_preserves_and_allows_version_deployments() {
    let (_temp, s, app, actor) = fixture(None).await;
    let c = create(&app, &actor, "Running").await;
    let version = command(&app, &actor, &c, "publish", json!({})).await;
    let device = db::id();
    let data = json!({"id":device,"name":"Lifecycle synthetic device","last_seen":db::now(),"vector_version":"0.58.0","agent_version":"test","apply_state":"unmanaged","reported_generation":0});
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&device)
        .bind("Lifecycle synthetic device")
        .bind(data.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    let deployment = json!({"version_id":version["id"],"priority":100,"target_mode":"snapshot","selector":{"device_ids":[device],"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}});
    let (status, assigned) = call(
        &app,
        "POST",
        "/api/v1/deployments",
        deployment.clone(),
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{assigned}");
    let before = sqlx::query(
        "SELECT desired_generation,desired_version_id,assignment_id FROM devices WHERE id=?",
    )
    .bind(&device)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    let archived = command(&app, &actor, &c, "archive", json!({})).await;
    assert_eq!(archived["archived"], true);
    assert!(archived["archived_at"].is_string());
    for action in ["publish", "restore"] {
        assert_eq!(
            call(
                &app,
                "POST",
                &path(&archived, action),
                json!({"revision":archived["revision"],"version_id":version["id"]}),
                Some(&actor)
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    assert_eq!(call(&app,"PUT",&path(&archived,"draft"),json!({"revision":archived["revision"],"config":base(),"graph":{"nodes":[],"edges":[]}}),Some(&actor)).await.0,StatusCode::CONFLICT);
    let after = sqlx::query(
        "SELECT desired_generation,desired_version_id,assignment_id FROM devices WHERE id=?",
    )
    .bind(&device)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(before.get::<i64, _>(0), after.get::<i64, _>(0));
    assert_eq!(before.get::<String, _>(1), after.get::<String, _>(1));
    assert_eq!(before.get::<String, _>(2), after.get::<String, _>(2));
    let (_, unchanged) = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{}", assigned["id"].as_str().unwrap()),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(unchanged, assigned);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/versions/{}", version["id"].as_str().unwrap()),
            Value::Null,
            Some(&actor)
        )
        .await
        .1,
        version
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/deployments",
            deployment,
            Some(&actor)
        )
        .await
        .0,
        StatusCode::OK
    );
    let unarchived = command(&app, &actor, &archived, "unarchive", json!({})).await;
    assert_eq!(unarchived["archived"], false);
    assert!(unarchived["archived_at"].is_null());
    assert_eq!(
        command(&app, &actor, &unarchived, "publish", json!({})).await["number"],
        2
    );
}

#[tokio::test]
async fn concurrent_archive_and_save_cannot_overwrite_each_other() {
    let (_temp, _s, app, actor) = fixture(None).await;
    let c = create(&app, &actor, "Concurrent").await;
    let archive_path = path(&c, "archive");
    let draft_path = path(&c, "draft");
    let (archive, save) = tokio::join!(
        call(
            &app,
            "POST",
            &archive_path,
            json!({"revision":1}),
            Some(&actor)
        ),
        call(
            &app,
            "PUT",
            &draft_path,
            json!({"revision":1,"config":base(),"graph":c["graph"]}),
            Some(&actor)
        )
    );
    assert_eq!(
        [archive.0, save.0]
            .iter()
            .filter(|s| **s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [archive.0, save.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
}

#[tokio::test]
async fn publication_rechecks_archive_after_delayed_validation() {
    use std::sync::Arc;
    use tokio::sync::Notify;
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let (signal, wait) = (entered.clone(), release.clone());
    let worker=Router::new().route("/validate",axum::routing::post(move || {let signal=signal.clone();let wait=wait.clone();async move {signal.notify_one();wait.notified().await;axum::Json(json!({"valid":true,"vector_validated":true,"errors":[],"warnings":[],"vector_version":"0.58.0"}))}}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let worker_task = tokio::spawn(async move { axum::serve(listener, worker).await.unwrap() });
    let (_temp, _s, app, actor) = fixture(Some(format!("http://{address}"))).await;
    let c = create(&app, &actor, "Race").await;
    let publish_app = app.clone();
    let publish_c = c.clone();
    let publisher = Identity {
        id: actor.id.clone(),
        cookie: actor.cookie.clone(),
        csrf: actor.csrf.clone(),
    };
    let publish = tokio::spawn(async move {
        call(
            &publish_app,
            "POST",
            &path(&publish_c, "publish"),
            json!({"revision":1}),
            Some(&publisher),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    command(&app, &actor, &c, "archive", json!({})).await;
    release.notify_one();
    assert_eq!(publish.await.unwrap().0, StatusCode::CONFLICT);
    assert_eq!(
        call(
            &app,
            "GET",
            &path(&c, "versions"),
            Value::Null,
            Some(&actor)
        )
        .await
        .1,
        json!([])
    );
    worker_task.abort();
}

#[tokio::test]
async fn history_is_sql_filtered_bounded_metadata_with_full_snapshot_on_demand() {
    let (_temp, s, app, actor) = fixture(None).await;
    let c = create(&app, &actor, "Long history").await;
    let other = create(&app, &actor, "Other history").await;
    let mut tx = s.pool.begin().await.unwrap();
    for n in 2..=1000 {
        db::insert(&mut tx,"revision",&json!({"id":db::id(),"configuration_id":c["id"],"revision":n,"config":{"large":"x".repeat(8192)},"graph":{"nodes":[],"edges":[]},"created_at":"2020-01-01T00:00:00Z","message":format!("Revision {n}")})).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (status, metadata) = call(
        &app,
        "GET",
        &path(&c, "history?kind=revisions&page=2&page_size=12"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{metadata}");
    assert_eq!(metadata["total"], 1000);
    assert_eq!(metadata["page"], 2);
    assert_eq!(metadata["page_size"], 12);
    assert_eq!(metadata["items"][0]["revision"], 988);
    assert_eq!(metadata["items"][11]["revision"], 977);
    assert!(metadata.to_string().len() < 12000);
    for item in metadata["items"].as_array().unwrap() {
        for key in ["config", "graph", "artifact", "validation"] {
            assert!(item.get(key).is_none());
        }
    }
    let revision_id = metadata["items"][0]["id"].as_str().unwrap();
    let (status, full) = call(
        &app,
        "GET",
        &format!("{}/{revision_id}", path(&c, "revisions")),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(full["config"]["large"].as_str().unwrap().len(), 8192);
    assert_eq!(
        call(
            &app,
            "GET",
            &path(&other, "history"),
            Value::Null,
            Some(&actor)
        )
        .await
        .1["total"],
        1
    );
    for query in [
        "kind=wrong",
        "page=0",
        "page_size=0",
        "page_size=51",
        "page=9007199254740992&page_size=1",
        "page=18446744073709551615&page_size=50",
    ] {
        assert_eq!(
            call(
                &app,
                "GET",
                &path(&c, &format!("history?{query}")),
                Value::Null,
                Some(&actor)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let version = command(&app, &actor, &c, "publish", json!({})).await;
    let (_, versions) = call(
        &app,
        "GET",
        &path(&c, "history?kind=versions"),
        Value::Null,
        Some(&actor),
    )
    .await;
    assert_eq!(versions["total"], 1);
    assert_eq!(versions["items"][0]["id"], version["id"]);
    assert!(versions["items"][0].get("artifact").is_none());
    assert!(versions["items"][0].get("validation").is_none());
    let plan=sqlx::query("EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind='revision' AND json_extract(data,'$.configuration_id')=? ORDER BY CAST(json_extract(data,'$.revision') AS INTEGER) DESC LIMIT 12").bind(c["id"].as_str().unwrap()).fetch_all(&s.pool).await.unwrap();
    assert!(plan.iter().any(|r| {
        r.get::<String, _>("detail")
            .contains("revision_pipeline_sequence")
    }));
}
