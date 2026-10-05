use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

struct Actor {
    id: String,
    cookie: String,
    csrf: String,
}

async fn actor(state: &State, name: &str) -> Actor {
    let id = db::id();
    let session = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.invalid"))
    .bind(name)
    .bind("admin")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&session))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&state.pool)
        .await
        .unwrap();
    Actor {
        id,
        cookie: format!("vectory_session={session}"),
        csrf,
    }
}

async fn fixture() -> (tempfile::TempDir, State, Router, Actor) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Token usage projection tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let reader = actor(&state, "Aster Admin").await;
    let app = api::router(state.clone());
    (temp, state, app, reader)
}

async fn call(app: &Router, method: &str, path: &str, body: Value, actor: &Actor) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{value}");
    value
}

async fn insert_token(state: &State, record: &Value) {
    sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
        .bind(record["id"].as_str().unwrap())
        .bind(db::hash(record["id"].as_str().unwrap()))
        .bind(record.to_string())
        .execute(&state.pool)
        .await
        .unwrap();
}

async fn insert_audit(state: &State, actor: &str, action: &str, target: &str, at: &str) {
    let event = json!({
        "id": db::id(),
        "actor": actor,
        "action": action,
        "target": target,
        "outcome": "success",
        "created_at": at,
    });
    sqlx::query("INSERT INTO records(kind,id,data,created_at) VALUES('audit',?,?,?)")
        .bind(event["id"].as_str().unwrap())
        .bind(event.to_string())
        .bind(at)
        .execute(&state.pool)
        .await
        .unwrap();
}

async fn insert_enrollment(
    state: &State,
    token_id: &str,
    device_id: &str,
    device_name: &str,
    at: &str,
    revoked: bool,
) {
    let device = json!({"id": device_id, "name": device_name, "created_at": at});
    sqlx::query("INSERT INTO devices(id,name,data,revoked) VALUES(?,?,?,?)")
        .bind(device_id)
        .bind(device_name)
        .bind(device.to_string())
        .bind(i64::from(revoked))
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO enrollments(request_id,key_hash,token_id,response) VALUES(?,?,?,?)")
        .bind(format!("request-{device_id}"))
        .bind("unused-test-hash")
        .bind(token_id)
        .bind(json!({"device_id": device_id}).to_string())
        .execute(&state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn token_list_preserves_scope_and_revocation_while_projecting_latest_twenty_devices() {
    let (_temp, state, app, admin) = fixture().await;
    let names: Vec<String> = (0..23).map(|n| format!("edge-{n:02}")).collect();
    let raw_names: Vec<String> = names
        .iter()
        .map(|name| format!(" {name} ").to_uppercase())
        .collect();
    let receipt = call(
        &app,
        "POST",
        "/api/v1/tokens",
        json!({
            "name": "Edge onboarding",
            "expires_hours": 24,
            "max_uses": 23,
            "allowed_names": raw_names,
            "labels": {"site": "Lab"},
        }),
        &admin,
    )
    .await;
    let token_id = receipt["record"]["id"].as_str().unwrap();
    assert_eq!(receipt["record"]["allowed_names"], json!(names));
    let legacy = json!({
        "id": "legacy-without-creator",
        "name": "Legacy token",
        "expires_at": "2099-01-01T00:00:00Z",
        "uses": 0,
        "max_uses": null,
        "name_prefix": null,
        "revoked": false,
        "created_at": "2025-01-01T00:00:00Z",
    });
    insert_token(&state, &legacy).await;

    for n in 0..23 {
        let device_id = format!("usage-device-{n:02}");
        let name = if n == 22 {
            format!("edge-{n:02}#retired-old-identity")
        } else {
            format!("edge-{n:02}")
        };
        // Two devices share a timestamp; ID ascending is the stable tie break.
        let minute = if n == 21 { 20 } else { n };
        let at = format!("2026-02-01T00:{minute:02}:00Z");
        insert_enrollment(&state, token_id, &device_id, &name, &at, n == 20).await;
    }
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/tokens/{token_id}/revoke"),
            json!({}),
            &admin,
        )
        .await,
        json!({"ok": true})
    );

    let list = call(&app, "GET", "/api/v1/tokens", Value::Null, &admin).await;
    let items = list.as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(
        items
            .windows(2)
            .all(|pair| { pair[0]["id"].as_str().unwrap() < pair[1]["id"].as_str().unwrap() })
    );
    let token = items.iter().find(|item| item["id"] == token_id).unwrap();
    assert_eq!(token["name"], receipt["record"]["name"]);
    assert_eq!(token["allowed_names"], json!(names));
    assert_eq!(token["labels"], json!({"site": "Lab"}));
    assert_eq!(token["revoked"], true);
    assert_eq!(token["uses"], 0);
    assert_eq!(
        token["created_by"],
        json!({"id": admin.id, "name": "Aster Admin"})
    );
    assert_eq!(token["device_count"], 23);
    assert_eq!(token["last_used_at"], "2026-02-01T00:22:00Z");
    let devices = token["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 20);
    let expected_ids: Vec<String> = std::iter::once(22)
        .chain([20, 21])
        .chain((3..=19).rev())
        .map(|n| format!("usage-device-{n:02}"))
        .collect();
    let listed_ids: Vec<&str> = devices.iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(
        listed_ids,
        expected_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );
    assert_eq!(
        devices[0],
        json!({
            "id": "usage-device-22",
            "name": "edge-22",
            "revoked": false,
            "enrolled_at": "2026-02-01T00:22:00Z",
        })
    );
    assert_eq!(devices[1]["revoked"], true);
    assert_eq!(devices[19]["id"], "usage-device-03");

    let legacy = items
        .iter()
        .find(|item| item["id"] == legacy["id"])
        .unwrap();
    assert_eq!(legacy["created_by"], Value::Null);
    assert_eq!(legacy["device_count"], 0);
    assert_eq!(legacy["devices"], json!([]));
    assert_eq!(legacy["last_used_at"], Value::Null);
    assert!(legacy.get("allowed_names").is_none());
}

#[tokio::test]
async fn recovery_token_creator_is_latest_authorizer_before_each_token_was_created() {
    let (_temp, state, app, first) = fixture().await;
    let second = actor(&state, "Beryl Admin").await;
    let source = "recovery-source";
    let device =
        json!({"id": source, "name": "source-device", "created_at": "2025-01-01T00:00:00Z"});
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(source)
        .bind("source-device")
        .bind(device.to_string())
        .execute(&state.pool)
        .await
        .unwrap();
    for (id, at) in [
        ("recovery-early", "2026-01-01T10:30:00Z"),
        ("recovery-between", "2026-01-01T10:50:00Z"),
        ("recovery-at-authorization", "2026-01-01T11:00:00Z"),
        ("recovery-late", "2026-01-01T11:30:00Z"),
        ("recovery-before-any-audit", "2026-01-01T09:30:00Z"),
    ] {
        insert_token(
            &state,
            &json!({
                "id": id,
                "name": "Recovery token",
                "expires_at": "2099-01-01T00:00:00Z",
                "uses": 0,
                "max_uses": 1,
                "name_prefix": null,
                "revoked": false,
                "created_at": at,
                "recovery_device_id": source,
                "recovery_name": "source-device",
            }),
        )
        .await;
    }
    insert_audit(
        &state,
        &first.id,
        "device.recovery_authorize",
        source,
        "2026-01-01T10:00:00Z",
    )
    .await;
    insert_audit(
        &state,
        &second.id,
        "device.recovery_authorize",
        source,
        "2026-01-01T10:40:00Z",
    )
    .await;
    insert_audit(
        &state,
        &second.id,
        "device.recovery_authorize",
        source,
        "2026-01-01T11:00:00Z",
    )
    .await;
    // When authorizations share a timestamp, the last row from the ordered
    // audit query wins, just as it did with the previous reverse scan.
    insert_audit(
        &state,
        &first.id,
        "device.recovery_authorize",
        source,
        "2026-01-01T11:00:00Z",
    )
    .await;
    // A newer authorization for another source cannot become this source's actor.
    insert_audit(
        &state,
        &second.id,
        "device.recovery_authorize",
        "another-device",
        "2026-01-01T10:15:00Z",
    )
    .await;
    // A later authorization must not retroactively change either earlier token.
    insert_audit(
        &state,
        &second.id,
        "device.recovery_authorize",
        source,
        "2026-01-01T12:00:00Z",
    )
    .await;

    // Equal timestamps have no SQL tie break. Compare with the audit query's
    // actual final eligible row, which was what the original reverse scan used.
    let ordered: Vec<(Option<String>, Option<String>, String)> = sqlx::query_as(
        "SELECT json_extract(data,'$.target'),json_extract(data,'$.actor'),created_at FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.recovery_authorize' AND json_extract(data,'$.outcome')='success' ORDER BY created_at",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        ordered
            .iter()
            .filter(|(target, _, when)| {
                target.as_deref() == Some(source) && when == "2026-01-01T11:00:00Z"
            })
            .count(),
        2
    );
    let tied_actor = ordered
        .iter()
        .rev()
        .find(|(target, _, when)| {
            target.as_deref() == Some(source) && when.as_str() <= "2026-01-01T11:00:00Z"
        })
        .and_then(|(_, actor, _)| actor.as_deref())
        .unwrap();
    let list = call(&app, "GET", "/api/v1/tokens", Value::Null, &first).await;
    let items = list.as_array().unwrap();
    let find = |id: &str| items.iter().find(|item| item["id"] == id).unwrap();
    assert_eq!(
        find("recovery-early")["created_by"],
        json!({"id": first.id, "name": "Aster Admin"})
    );
    assert_eq!(
        find("recovery-between")["created_by"],
        json!({"id": second.id, "name": "Beryl Admin"})
    );
    assert_eq!(
        find("recovery-at-authorization")["created_by"]["id"],
        tied_actor
    );
    assert_eq!(find("recovery-late")["created_by"]["id"], tied_actor);
    assert_eq!(find("recovery-before-any-audit")["created_by"], Value::Null);
    for item in items {
        assert_eq!(item["device_count"], 0);
        assert_eq!(item["devices"], json!([]));
        assert_eq!(item["last_used_at"], Value::Null);
        assert_eq!(item["recovery_device_id"], source);
    }
}

#[tokio::test]
async fn token_list_projects_a_fleet_sized_history_without_mixing_token_usage() {
    const TOKENS: usize = 2_000;
    let (_temp, state, app, first) = fixture().await;
    let second = actor(&state, "Beryl Admin").await;
    let mut tx = state.pool.begin().await.unwrap();
    for n in 0..TOKENS {
        let token_id = format!("scale-token-{n:04}");
        let device_id = format!("scale-device-{n:04}");
        let device_name = format!("edge-{n:04}");
        let at = "2026-03-01T00:00:00Z";
        let token = json!({
            "id": token_id,
            "name": format!("Scale token {n}"),
            "expires_at": "2099-01-01T00:00:00Z",
            "uses": 1,
            "max_uses": 1,
            "name_prefix": null,
            "revoked": false,
            "created_at": "2026-02-01T00:00:00Z",
        });
        sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
            .bind(&token_id)
            .bind(db::hash(&token_id))
            .bind(token.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        let creator = if n % 2 == 0 { &first.id } else { &second.id };
        let audit = json!({
            "id": db::id(),
            "actor": creator,
            "action": "token.create",
            "target": token_id,
            "outcome": "success",
            "created_at": "2026-02-01T00:00:00Z",
        });
        sqlx::query("INSERT INTO records(kind,id,data,created_at) VALUES('audit',?,?,?)")
            .bind(audit["id"].as_str().unwrap())
            .bind(audit.to_string())
            .bind("2026-02-01T00:00:00Z")
            .execute(&mut *tx)
            .await
            .unwrap();
        let device = json!({"id": device_id, "name": device_name, "created_at": at});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&device_id)
            .bind(&device_name)
            .bind(device.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO enrollments(request_id,key_hash,token_id,response) VALUES(?,?,?,?)",
        )
        .bind(format!("scale-request-{n:04}"))
        .bind("unused-test-hash")
        .bind(&token_id)
        .bind(json!({"device_id": device_id}).to_string())
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();

    let list = call(&app, "GET", "/api/v1/tokens", Value::Null, &first).await;
    let items = list.as_array().unwrap();
    assert_eq!(items.len(), TOKENS);
    for n in [0, 1, 17, TOKENS / 2, TOKENS - 2, TOKENS - 1] {
        let item = &items[n];
        assert_eq!(item["id"], format!("scale-token-{n:04}"));
        assert_eq!(item["device_count"], 1);
        assert_eq!(item["last_used_at"], "2026-03-01T00:00:00Z");
        assert_eq!(
            item["devices"],
            json!([{
                "id": format!("scale-device-{n:04}"),
                "name": format!("edge-{n:04}"),
                "revoked": false,
                "enrolled_at": "2026-03-01T00:00:00Z",
            }])
        );
        let creator = if n % 2 == 0 { &first } else { &second };
        let name = if n % 2 == 0 {
            "Aster Admin"
        } else {
            "Beryl Admin"
        };
        assert_eq!(item["created_by"], json!({"id": creator.id, "name": name}));
    }
    assert!(items.iter().all(|item| item["device_count"] == 1));
}
