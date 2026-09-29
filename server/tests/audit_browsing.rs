use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

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

fn event(n: usize, actor: &str, target: &str) -> Value {
    json!({"id":format!("30000000-0000-4000-8000-{:012}",10000-n),"actor":actor,"action":"device.apply_state","target":target,"outcome":"verified_applied","created_at":"2026-09-26T12:00:00Z","private":"PRIVATE_AUDIT_PAYLOAD".repeat(2048),"details":{"secret":"PRIVATE_AUDIT_DETAIL"}})
}
async fn add_device(s: &State, id: &str, name: &str) {
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(id)
        .bind(name)
        .bind(json!({"private":"PRIVATE_DEVICE"}).to_string())
        .execute(&s.pool)
        .await
        .unwrap();
}
async fn raw(
    app: &Router,
    method: &str,
    path: &str,
    body: &str,
    actor: Option<&Actor>,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(a) = actor {
        request = request
            .header("cookie", &a.cookie)
            .header("x-csrf-token", &a.csrf)
    }
    app.clone()
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap()
}
async fn json_response(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn history_column_sorting_is_global_bounded_and_does_not_change_export_order_contract() {
    let (_temp, s, app, admin) = fixture().await;
    let viewer = actor(&s, "viewer").await;
    let mut identities = Vec::new();
    for name in ["Zulu", "alpha", "Mu"] {
        let person = actor(&s, "viewer").await;
        sqlx::query("UPDATE users SET name=? WHERE id=?")
            .bind(name)
            .bind(&person.id)
            .execute(&s.pool)
            .await
            .unwrap();
        identities.push((person.id, name));
    }
    let mut events = Vec::new();
    for n in 0..31usize {
        let mut value = event(n, &identities[n % 3].0, "");
        value["action"] = json!(["user.login", "device.enroll", "configuration.publish"][n % 3]);
        value["outcome"] = json!(["success", "unknown", "failure"][n % 3]);
        value["created_at"] = json!(format!("2026-09-26T12:00:{:02}Z", n % 4));
        insert(&s, "audit", &value).await;
        events.push((n, value, identities[n % 3].1));
    }
    for sort in ["action", "actor", "outcome", "created_at"] {
        for direction in ["asc", "desc"] {
            let mut expected = events.clone();
            expected.sort_by(|a, b| {
                let key = |v: &(usize, Value, &str)| {
                    if sort == "actor" {
                        v.2.to_ascii_lowercase()
                    } else {
                        v.1[sort].as_str().unwrap().to_ascii_lowercase()
                    }
                };
                let primary = key(a).cmp(&key(b));
                let primary = if direction == "desc" {
                    primary.reverse()
                } else {
                    primary
                };
                primary.then_with(|| {
                    if sort == "created_at" && direction == "asc" {
                        a.0.cmp(&b.0)
                    } else {
                        b.0.cmp(&a.0)
                    }
                })
            });
            let path = format!(
                "/api/v1/audit/history?sort={sort}&direction={direction}&page=3&page_size=7"
            );
            let page = get(&app, &path, &viewer).await;
            assert_eq!(page["total"], 31);
            let ids: Vec<_> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].clone())
                .collect();
            assert_eq!(
                ids,
                expected[14..21]
                    .iter()
                    .map(|v| v.1["id"].clone())
                    .collect::<Vec<_>>(),
                "{path}"
            );
            assert!(!page.to_string().contains("PRIVATE"));
            assert!(page["items"][0].get("details").is_none());
        }
    }
    for query in [
        "sort=secret",
        "sort=actor&sort=action",
        "direction=ASC",
        "direction=asc%3BDROP",
        "sort=",
        "direction=",
    ] {
        let (status, _) = call(
            &app,
            "GET",
            &format!("/api/v1/audit/history?{query}"),
            Value::Null,
            Some(&admin),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}");
    }
    let default = get(&app, "/api/v1/audit/history", &viewer).await;
    let explicit = get(
        &app,
        "/api/v1/audit/history?sort=created_at&direction=desc",
        &viewer,
    )
    .await;
    assert_eq!(default, explicit);
    let (status, _) = call(
        &app,
        "POST",
        "/api/v1/audit/exports",
        json!({"sort":"actor"}),
        Some(&admin),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn history_is_bounded_stable_searchable_and_payload_free() {
    let (_temp, s, app, admin) = fixture().await;
    let device = db::id();
    add_device(&s, &device, "Device Literal, %_😀").await;
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..240 {
        db::insert(&mut tx, "audit", &event(n, &admin.id, &device))
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let page = get(&app, "/api/v1/audit/history", &admin).await;
    assert_eq!(page["total"], 240);
    assert_eq!(page["items"].as_array().unwrap().len(), 12);
    assert_eq!(page["items"][0]["id"], event(239, "", "")["id"]);
    assert!(page.to_string().len() < 14000);
    assert!(!page.to_string().contains("PRIVATE"));
    assert!(page["items"][0].get("details").is_none());
    assert_eq!(page["items"][0]["actor_kind"], "user");
    assert_eq!(page["items"][0]["target_name"], "Device Literal, %_😀");
    let last = get(&app, "/api/v1/audit/history?page=20", &admin).await;
    assert_eq!(last["items"][11]["id"], event(0, "", "")["id"]);
    for query in [
        "search=PRIVATE",
        "search=Literal%20%25_",
        "outcome=failed",
        "action=device.enroll",
        "from=2026-09-26T12%3A00%3A00.001Z",
    ] {
        assert_eq!(
            get(&app, &format!("/api/v1/audit/history?{query}"), &admin).await["total"],
            0,
            "{query}"
        );
    }
    for query in [
        "search=Literal%2C%20%25_",
        "family=device",
        "action=device.apply_state",
        "outcome=verified_applied",
        "from=2026-09-26T12%3A00%3A00Z&to=2026-09-26T12%3A00%3A00Z",
    ] {
        assert_eq!(
            get(&app, &format!("/api/v1/audit/history?{query}"), &admin).await["total"],
            240,
            "{query}"
        );
    }
    for role in ["viewer", "editor", "operator"] {
        let user = actor(&s, role).await;
        assert_eq!(
            get(&app, "/api/v1/audit/history", &user).await["total"],
            240
        );
    }
    let detail = get(
        &app,
        &format!(
            "/api/v1/audit/{}",
            event(10, "", "")["id"].as_str().unwrap()
        ),
        &admin,
    )
    .await;
    assert_eq!(detail["details"], json!({}));
    assert!(!detail.to_string().contains("PRIVATE"));
    sqlx::query("VACUUM").execute(&s.pool).await.unwrap();
    assert_eq!(get(&app, "/api/v1/audit/history", &admin).await, page);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_sequence")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        240
    );
}

#[tokio::test]
async fn exact_device_scope_uses_only_persisted_identity_relations() {
    let (_temp, s, app, a) = fixture().await;
    let old = db::id();
    let new = db::id();
    let dep = db::id();
    add_device(&s, &old, "Retired original").await;
    add_device(&s, &new, "Replacement").await;
    let values = [
        json!({"actor":"scheduler","action":"deployment.release","target":format!("{dep}:{old}")}),
        json!({"actor":old,"action":"other.event","target":"elsewhere"}),
        json!({"actor":a.id,"action":"issue.acknowledge","target":db::hash("issue"),"device_id":old,"reason":"Reviewed retirement","issue_revision":2}),
        json!({"actor":"enrollment-token","action":"device.recovery_complete","target":format!("{old}:{new}")}),
        json!({"actor":"local-admin","action":"server.restore_generation_fence","target":"legacy","details":{"device_id":old,"generation":4}}),
        json!({"actor":a.id,"action":"other.event","target":format!("{dep}:{old}"),"details":{"device_id":old}}),
        json!({"actor":"scheduler","action":"deployment.release","target":format!("{}:{}{}",&dep[..5],&dep[6..],old)}),
    ];
    for (n, v) in values.iter().enumerate() {
        let mut e = event(n, "", "");
        e.as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        insert(&s, "audit", &e).await;
    }
    let page = get(&app, &format!("/api/v1/audit/history?device_id={old}"), &a).await;
    assert_eq!(page["total"], 5, "{page}");
    assert_eq!(
        get(&app, &format!("/api/v1/audit/history?device_id={new}"), &a).await["total"],
        1
    );
    let release = get(
        &app,
        &format!("/api/v1/audit/{}", event(0, "", "")["id"].as_str().unwrap()),
        &a,
    )
    .await;
    assert_eq!(release["target_id"], dep);
    assert_eq!(
        release["details"],
        json!({"deployment_id":dep,"device_id":old})
    );
    let issue = get(
        &app,
        &format!("/api/v1/audit/{}", event(2, "", "")["id"].as_str().unwrap()),
        &a,
    )
    .await;
    assert_eq!(
        issue["details"],
        json!({"reason":"Reviewed retirement","issue_revision":2})
    );
}

#[tokio::test]
async fn malformed_queries_and_export_bodies_are_safe_and_authorized_first() {
    let (_temp, s, app, a) = fixture().await;
    for query in [
        "unknown=x",
        "page=0",
        "page=9007199254740992",
        "page_size=51",
        "page=1&page=2",
        "search=%GG",
        "search=%FF",
        "device_id=x",
        "action=login&family=user",
        "from=2026-09-26",
        "from=2026-09-26T01:00:00%2B01:00",
        "from=2026-09-27T00:00:00Z&to=2026-09-26T00:00:00Z",
        "action=x%00secret",
    ] {
        let path = format!("/api/v1/audit/history?{query}");
        let (status, body) = call(&app, "GET", &path, Value::Null, Some(&a), false).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert!(!body.to_string().contains("secret"));
        assert_eq!(
            call(&app, "GET", &path, Value::Null, None, false).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
    for body in [
        r#"{"search":"first","search":"second"}"#,
        r#"{"page":1}"#,
        r#"{"search":3}"#,
        r#"{"unknown":"PRIVATE"}"#,
    ] {
        assert_eq!(
            raw(&app, "POST", "/api/v1/audit/exports", body, Some(&a))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/audit/exports",
            json!({}),
            Some(&a),
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        raw(
            &app,
            "POST",
            "/api/v1/audit/exports?unknown=1",
            "{}",
            Some(&a)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert!(
        std::fs::read_dir(&s.audit_exports.directory)
            .unwrap()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn prepared_export_has_consistent_counts_hashes_and_session_bound_lifecycle() {
    let (_temp, s, app, a) = fixture().await;
    for n in 0..225 {
        insert(&s, "audit", &event(n, &a.id, "")).await;
    }
    let response = raw(
        &app,
        "POST",
        "/api/v1/audit/exports",
        r#"{"family":"device"}"#,
        Some(&a),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let ready = json_response(response).await;
    assert_eq!(ready["row_count"], 225);
    let path = ready["download_path"].as_str().unwrap();
    insert(&s, "audit", &event(300, &a.id, "")).await;
    sqlx::query("UPDATE users SET name='Changed later' WHERE id=?")
        .bind(&a.id)
        .execute(&s.pool)
        .await
        .unwrap();
    let response = raw(&app, "GET", path, "", Some(&a)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()["content-length"].to_str().unwrap(),
        ready["byte_count"].to_string()
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(db::hash(&bytes), ready["sha256"]);
    assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE"));
    assert!(!String::from_utf8_lossy(&bytes).contains("Changed later"));
    let lines = bytes
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 227);
    let meta: Value = serde_json::from_slice(lines[0]).unwrap();
    let trailer: Value = serde_json::from_slice(lines[226]).unwrap();
    assert_eq!(meta["row_count"], 225);
    assert_eq!(trailer["complete"], true);
    let event_bytes = lines[1..226]
        .iter()
        .flat_map(|l| l.iter().copied().chain(std::iter::once(b'\n')))
        .collect::<Vec<_>>();
    assert_eq!(db::hash(event_bytes), trailer["events_sha256"]);
    let other = actor(&s, "admin").await;
    assert_eq!(
        raw(&app, "GET", path, "", Some(&other)).await.status(),
        StatusCode::NOT_FOUND
    );
    let token = auth::random_secret();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&a.id)
        .bind("new-csrf")
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    let another = Actor {
        id: a.id.clone(),
        cookie: format!("vectory_session={token}"),
        csrf: "new-csrf".into(),
    };
    assert_eq!(
        raw(&app, "GET", path, "", Some(&another)).await.status(),
        StatusCode::NOT_FOUND
    );
    let remove = format!("/api/v1/audit/exports/{}", ready["id"].as_str().unwrap());
    assert_eq!(
        call(&app, "DELETE", &remove, Value::Null, Some(&a), false)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        raw(&app, "DELETE", &remove, "", Some(&a)).await.status(),
        StatusCode::OK
    );
    assert_eq!(
        raw(&app, "GET", path, "", Some(&a)).await.status(),
        StatusCode::NOT_FOUND
    );
    assert!(
        std::fs::read_dir(&s.audit_exports.directory)
            .unwrap()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn retained_capacity_and_active_discarded_downloads_stay_bounded() {
    let (_temp, s, app, a) = fixture().await;
    for n in 0..900 {
        insert(&s, "audit", &event(n, &a.id, "")).await;
    }
    let first =
        json_response(raw(&app, "POST", "/api/v1/audit/exports", "{}", Some(&a)).await).await;
    let second =
        json_response(raw(&app, "POST", "/api/v1/audit/exports", "{}", Some(&a)).await).await;
    assert_eq!(
        raw(&app, "POST", "/api/v1/audit/exports", "{}", Some(&a))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let download = raw(
        &app,
        "GET",
        first["download_path"].as_str().unwrap(),
        "",
        Some(&a),
    )
    .await;
    assert_eq!(
        raw(
            &app,
            "DELETE",
            &format!("/api/v1/audit/exports/{}", first["id"].as_str().unwrap()),
            "",
            Some(&a)
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        std::fs::read_dir(&s.audit_exports.directory)
            .unwrap()
            .count(),
        2
    );
    assert_eq!(
        raw(&app, "POST", "/api/v1/audit/exports", "{}", Some(&a))
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    drop(download);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(
        raw(
            &app,
            "DELETE",
            &format!("/api/v1/audit/exports/{}", second["id"].as_str().unwrap()),
            "",
            Some(&a)
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert!(
        std::fs::read_dir(&s.audit_exports.directory)
            .unwrap()
            .next()
            .is_none()
    );
}

#[tokio::test]
async fn action_details_are_allowlisted_and_typed_with_immutable_target_mapping() {
    let (_temp, s, app, a) = fixture().await;
    let config = db::id();
    let version = db::id();
    insert(
        &s,
        "configuration",
        &json!({"id":config,"name":"Parent pipeline","config":{"secret":"PRIVATE_CONFIG"}}),
    )
    .await;
    insert(
        &s,
        "version",
        &json!({"id":version,"configuration_id":config,"artifact":"PRIVATE_ARTIFACT"}),
    )
    .await;
    let data = [
        json!({"action":"configuration.publish","target":version}),
        json!({"action":"device.secret_reconciliation","actual_sha256":"a".repeat(64),"applied_template_sha256":"b".repeat(64),"secret_revision":4,"previous_secret_revision":3,"generation":999,"reason":"PRIVATE_REASON"}),
        json!({"action":"server.restore_access.invalidate","details":{"browser_sessions":2,"password_reset_codes":3,"enrollment_tokens_to_revoke":4,"mfa_recovery_codes":5,"private":"PRIVATE_DETAILS"}}),
        json!({"action":"issue.reopen","reason":"x".repeat(2000),"issue_revision":5,"secret_revision":123,"created_at":"INVALID_PRIVATE_TIME"}),
        json!({"action":"other.unknown","reason":"PRIVATE_REASON","actual_sha256":"a".repeat(64),"details":{"browser_sessions":1}}),
    ];
    for (n, v) in data.iter().enumerate() {
        let mut value = event(n, &a.id, "");
        value
            .as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        insert(&s, "audit", &value).await;
    }
    let history = get(
        &app,
        &format!("/api/v1/audit/history?target_id={config}"),
        &a,
    )
    .await;
    assert_eq!(history["total"], 1);
    assert_eq!(history["items"][0]["target_id"], config);
    assert_eq!(history["items"][0]["target_name"], "Parent pipeline");
    for n in 0..5 {
        let v = get(
            &app,
            &format!("/api/v1/audit/{}", event(n, "", "")["id"].as_str().unwrap()),
            &a,
        )
        .await;
        assert!(!v.to_string().contains("PRIVATE"));
        match n {
            1 => assert_eq!(v["details"].as_object().unwrap().len(), 4),
            2 => assert_eq!(v["details"].as_object().unwrap().len(), 4),
            3 => {
                assert_eq!(v["created_at"], Value::Null);
                assert_eq!(v["details"]["reason"].as_str().unwrap().len(), 1000);
                assert!(v["details"].get("secret_revision").is_none());
            }
            _ => assert_eq!(v["details"], json!({})),
        }
    }
    let legacy = get(&app, "/api/v1/audit", &a).await;
    assert!(!legacy.to_string().contains("PRIVATE"));
    assert_eq!(legacy.as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn oversized_export_refuses_without_a_ready_file_or_database_mutation() {
    let (_temp, s, app, a) = fixture().await;
    sqlx::query("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100001) INSERT INTO records(kind,id,data,created_at) SELECT 'audit',printf('audit-%08d',x),json_object('id',printf('audit-%08d',x),'actor','scheduler','action','deployment.release','target','','outcome','success'),'2026-09-26T12:00:00Z' FROM n").execute(&s.pool).await.unwrap();
    let response = raw(&app, "POST", "/api/v1/audit/exports", "{}", Some(&a)).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        json_response(response).await["error"]["code"],
        "EXPORT_TOO_LARGE"
    );
    assert!(
        std::fs::read_dir(&s.audit_exports.directory)
            .unwrap()
            .next()
            .is_none()
    );
    assert_eq!(get(&app, "/api/v1/audit/exports", &a).await, json!([]));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM audit_sequence")
            .fetch_one(&s.pool)
            .await
            .unwrap(),
        100001
    );
}

#[tokio::test]
async fn activity_links_use_existing_typed_identity_and_immutable_pipeline_parents() {
    let (_temp, s, app, a) = fixture().await;
    let config = db::id();
    let version = db::id();
    let revision = db::id();
    let orphan = db::id();
    let missing_parent = db::id();
    let invalid = db::id();
    let deployment = db::id();
    let old = db::id();
    let replacement = db::id();
    insert(&s,"configuration",&json!({"id":config,"name":"Archived pipeline","archived":true,"config":{"private":"PRIVATE_CONFIG".repeat(32000)},"graph":{"private":"PRIVATE_GRAPH"}})).await;
    for (kind, id, parent) in [
        ("version", &version, json!(config)),
        ("revision", &revision, json!(config)),
        ("revision", &orphan, json!(missing_parent)),
        (
            "version",
            &invalid,
            json!({"private":"PRIVATE_INVALID_PARENT"}),
        ),
    ] {
        insert(&s,kind,&json!({"id":id,"configuration_id":parent,"config":{"private":"PRIVATE_CONFIG"},"artifact":"PRIVATE_ARTIFACT"})).await;
    }
    insert(&s,"deployment",&json!({"id":deployment,"name":"Deployment","selector":{"private":"PRIVATE_SELECTOR"},"status":"completed"})).await;
    add_device(&s, &old, "Retired identity").await;
    add_device(&s, &replacement, "Replacement identity").await;
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&old)
        .execute(&s.pool)
        .await
        .unwrap();
    let entries = [
        (
            "configuration.create",
            config.clone(),
            a.id.clone(),
            Some(config.clone()),
            true,
        ),
        (
            "configuration.save",
            config.clone(),
            a.id.clone(),
            Some(config.clone()),
            true,
        ),
        (
            "configuration.publish",
            version.clone(),
            a.id.clone(),
            Some(config.clone()),
            true,
        ),
        (
            "configuration.restore",
            revision.clone(),
            a.id.clone(),
            Some(config.clone()),
            true,
        ),
        (
            "configuration.restore",
            orphan.clone(),
            a.id.clone(),
            Some(missing_parent.clone()),
            false,
        ),
        (
            "configuration.publish",
            invalid.clone(),
            a.id.clone(),
            None,
            false,
        ),
        (
            "deployment.release",
            format!("{deployment}:{old}"),
            "scheduler".into(),
            Some(deployment.clone()),
            true,
        ),
        (
            "device.recovery_complete",
            format!("{old}:{replacement}"),
            a.id.clone(),
            Some(replacement.clone()),
            true,
        ),
        (
            "device.apply_state",
            old.clone(),
            old.clone(),
            Some(old.clone()),
            true,
        ),
        (
            "future.unknown",
            config.clone(),
            "missing-actor".into(),
            None,
            false,
        ),
        // Finding some object with this ID cannot override the event's type.
        (
            "device.revoke",
            config.clone(),
            a.id.clone(),
            Some(config.clone()),
            false,
        ),
    ];
    let mut ids = Vec::new();
    for (n, (action, target, actor, _, _)) in entries.iter().enumerate() {
        let mut value = event(n, actor, target);
        value["action"] = json!(action);
        ids.push(value["id"].as_str().unwrap().to_owned());
        insert(&s, "audit", &value).await;
    }
    let history = get(&app, "/api/v1/audit/history?page_size=50", &a).await;
    let overview = get(&app, "/api/v1/overview", &a).await;
    let recent = overview["recent_activity"].as_array().unwrap();
    assert_eq!(recent.len(), entries.len());
    for (index, (_, target, _, expected_id, exists)) in entries.iter().enumerate() {
        let item = history["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == ids[index])
            .unwrap();
        let current = recent.iter().find(|v| v["id"] == ids[index]).unwrap();
        assert_eq!(
            current, item,
            "Overview uses the same bounded summary without detail fields"
        );
        assert_eq!(item["target"], *target);
        assert_eq!(item["target_id"], json!(expected_id));
        assert_eq!(item["target_exists"], *exists);
        assert!(!item.to_string().contains("PRIVATE"));
        assert!(item.get("details").is_none());
        if index <= 3 {
            assert_eq!(item["target_name"], "Archived pipeline");
            assert_eq!(item["actor_kind"], "user");
        }
        if index == 8 {
            assert_eq!(item["actor_kind"], "device");
            assert_eq!(item["actor_id"], old);
        }
        if index == 9 {
            assert_eq!(item["actor_kind"], "unknown");
            assert_eq!(item["target_kind"], "unknown");
        }
    }
    let scope = get(
        &app,
        &format!("/api/v1/audit/history?target_id={config}"),
        &a,
    )
    .await;
    assert_eq!(scope["total"], 6); // four pipeline events plus two exact raw targets
    // Removing current metadata never rewrites historical audit identities or
    // infers that a similarly named replacement owns the historical progress.
    sqlx::query(
        "DELETE FROM records WHERE (kind='configuration' AND id=?) OR (kind='deployment' AND id=?)",
    )
    .bind(&config)
    .bind(&deployment)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM devices WHERE id=?")
        .bind(&replacement)
        .execute(&s.pool)
        .await
        .unwrap();
    for index in [2usize, 3, 6, 7] {
        let item = get(&app, &format!("/api/v1/audit/{}", ids[index]), &a).await;
        assert_eq!(item["target_exists"], false);
        assert_eq!(item["target_id"], json!(entries[index].3));
    }
    assert_eq!(
        get(
            &app,
            &format!("/api/v1/audit/history?target_id={config}"),
            &a
        )
        .await["total"],
        6
    );
    let legacy = get(&app, "/api/v1/audit", &a).await;
    assert!(
        legacy
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["target_exists"].is_boolean())
    );
}
