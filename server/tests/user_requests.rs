use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, initialize};

const KEY: &str = "a1111111-1111-4111-8111-111111111111";
const PASSWORD: &str = "synthetic-user-password";

#[tokio::test]
async fn migration_preserves_existing_user_and_session_without_inventing_a_request() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0005_account_lifecycle.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('old-admin','old@example.invalid','Old','admin','old-hash','2020-01-01T00:00:00Z')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO sessions(verifier,user_id,csrf,expires_at) VALUES('old-session','old-admin','old-csrf','2099-01-01T00:00:00Z')")
        .execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0024_user_requests.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let user_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users WHERE id='old-admin' AND password_hash='old-hash'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let session_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sessions WHERE verifier='old-session'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let request_count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((user_count, session_count, request_count), (1, 1, 0));
}

#[derive(Clone)]
struct Session {
    id: String,
    cookie: String,
    csrf: String,
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<&Session>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(session) = session {
        builder = builder
            .header("cookie", &session.cookie)
            .header("x-csrf-token", &session.csrf);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn login(app: &Router, email: &str) -> Session {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/login")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":PASSWORD}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&body).unwrap();
    Session {
        id: value["user"]["id"].as_str().unwrap().to_owned(),
        cookie,
        csrf: value["csrf_token"].as_str().unwrap().to_owned(),
    }
}

async fn fixture() -> (tempfile::TempDir, State, Router, Session) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "synthetic-user-request-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Tests".into(),
        validation_url: None,
    })
    .await
    .unwrap();
    let app = api::router(state.clone());
    let response = app.clone().oneshot(Request::builder().method("POST").uri("/api/v1/bootstrap").header("content-type","application/json").body(Body::from(json!({"name":"Admin","email":"admin@example.invalid","password":PASSWORD,"bootstrap_secret":state.settings.bootstrap_secret}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    let admin = Session {
        id: value["user"]["id"].as_str().unwrap().to_owned(),
        cookie,
        csrf: value["csrf_token"].as_str().unwrap().to_owned(),
    };
    (temp, state, app, admin)
}

fn create_body(key: &str, email: &str) -> Value {
    json!({"request_id":key,"name":"Synthetic colleague","email":email,"password":PASSWORD,"role":"viewer"})
}

fn path(key: &str) -> String {
    format!("/api/v1/users/requests/{key}")
}

async fn audit_count(state: &State, action: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=?",
    )
    .bind(action)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn keyed_create_is_one_shot_and_lost_reply_recovers_only_current_user() {
    let (_temp, state, app, admin) = fixture().await;
    let endpoint = path(KEY);
    assert_eq!(
        request(&app, "GET", &endpoint, Value::Null, Some(&admin)).await,
        (
            StatusCode::OK,
            json!({"request_id":KEY,"status":"not_found"})
        )
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/users")
                .header("content-type", "application/json")
                .header("cookie", &admin.cookie)
                .header("x-csrf-token", &admin.csrf)
                .body(Body::from(
                    create_body(KEY, "colleague@example.invalid").to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // Deliberately discard the committed body as an unread-response fixture.
    drop(response);
    let (status, found) = request(&app, "GET", &endpoint, Value::Null, Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(found["status"], "created");
    assert_eq!(found["request_id"], KEY);
    let user_id = found["user"]["id"].as_str().unwrap();
    assert_eq!(found["user"]["email"], "colleague@example.invalid");
    assert!(!found.to_string().contains(PASSWORD));
    for body in [
        create_body(KEY, "colleague@example.invalid"),
        create_body(KEY, "another@example.invalid"),
        json!({"request_id":KEY}),
    ] {
        let (status, _) = request(&app, "POST", "/api/v1/users", body, Some(&admin)).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
    assert_eq!(audit_count(&state, "user.create").await, 1);
    let ledger: String = sqlx::query_scalar("SELECT json_object('actor_id',actor_id,'request_id',request_id,'state',state,'user_id',user_id,'created_at',created_at) FROM user_requests WHERE actor_id=? AND request_id=?")
        .bind(&admin.id)
        .bind(KEY)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert!(!ledger.contains(PASSWORD));
    let stored_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_ne!(stored_hash, PASSWORD);
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"colleague@example.invalid","password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, listed) = request(&app, "GET", "/api/v1/users", Value::Null, Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .filter(|u| u["email"] == "colleague@example.invalid")
            .count(),
        1
    );
    sqlx::query("UPDATE users SET name='Updated later',revision=revision+1 WHERE id=?")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .unwrap();
    let (_, later) = request(&app, "GET", &endpoint, Value::Null, Some(&admin)).await;
    assert_eq!(later["user"]["name"], "Updated later");
    assert_eq!(later["user"]["revision"], 2);
}

#[tokio::test]
async fn cancel_tombstone_fences_later_create_without_changing_any_account() {
    let (_temp, state, app, admin) = fixture().await;
    let endpoint = format!("{}/cancel", path(KEY));
    let (status, cancelled) = request(&app, "POST", &endpoint, json!({}), Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled, json!({"request_id":KEY,"status":"cancelled"}));
    assert_eq!(
        request(&app, "POST", &endpoint, json!({}), Some(&admin))
            .await
            .1,
        cancelled
    );
    let (status, _) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "late@example.invalid"),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(audit_count(&state, "user.request.cancel").await, 1);
    assert_eq!(audit_count(&state, "user.create").await, 0);
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE email='late@example.invalid'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn cancellation_after_create_reports_existing_user_without_disabling_it() {
    let (_temp, state, app, admin) = fixture().await;
    let (status, created) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "kept@example.invalid"),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, current) = request(
        &app,
        "POST",
        &format!("{}/cancel", path(KEY)),
        json!({}),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        current,
        json!({"request_id":KEY,"status":"created","user":created["user"]})
    );
    assert_eq!(audit_count(&state, "user.request.cancel").await, 0);
    assert_eq!(audit_count(&state, "user.create").await, 1);
    assert_eq!(current["user"]["enabled"], true);
}

#[tokio::test]
async fn live_authority_and_malformed_keys_do_not_mutate_registry() {
    let (_temp, state, app, admin) = fixture().await;
    for bad in [
        json!({"request_id":null}),
        json!({"request_id":"not-a-uuid"}),
    ] {
        assert_eq!(
            request(&app, "POST", "/api/v1/users", bad, Some(&admin))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let bad_path = "/api/v1/users/requests/not-a-uuid";
    assert_eq!(
        request(&app, "GET", bad_path, Value::Null, Some(&admin))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/users",
            create_body(KEY, "forbidden@example.invalid"),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let no_csrf = Session {
        csrf: String::new(),
        ..admin.clone()
    };
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/users",
            create_body(KEY, "forbidden@example.invalid"),
            Some(&no_csrf)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("{}/cancel", path(KEY)),
            json!({}),
            Some(&no_csrf)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(audit_count(&state, "user.create").await, 0);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_requests")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn audit_failure_rolls_back_created_user_and_request_mapping() {
    let (_temp, state, app, admin) = fixture().await;
    sqlx::query("CREATE TRIGGER fail_user_create_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='user.create' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END")
        .execute(&state.pool).await.unwrap();
    let (status, _) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "rollback@example.invalid"),
        Some(&admin),
    )
    .await;
    assert!(status.is_server_error());
    let users: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE email='rollback@example.invalid'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    let mappings: i64 = sqlx::query_scalar("SELECT count(*) FROM user_requests")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!((users, mappings), (0, 0));
}

#[tokio::test]
async fn legacy_create_retains_plain_user_receipt_and_uniqueness() {
    let (_temp, state, app, admin) = fixture().await;
    let body = json!({"name":"Legacy","email":"  LEGACY@example.invalid  ","password":PASSWORD,"role":"viewer"});
    let (status, created) =
        request(&app, "POST", "/api/v1/users", body.clone(), Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["email"], "legacy@example.invalid");
    assert!(created.get("request_id").is_none());
    assert_eq!(
        request(&app, "POST", "/api/v1/users", body, Some(&admin))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(audit_count(&state, "user.create").await, 1);
}

#[tokio::test]
async fn identical_request_ids_are_private_to_each_administrator() {
    let (_temp, state, app, admin) = fixture().await;
    let (status, _) = request(&app,"POST","/api/v1/users",json!({"name":"Second admin","email":"second-admin@example.invalid","password":PASSWORD,"role":"admin"}),Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    let second = login(&app, "second-admin@example.invalid").await;
    let (status, first) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "first-owned@example.invalid"),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        request(&app, "GET", &path(KEY), Value::Null, Some(&second))
            .await
            .1["status"],
        "not_found"
    );
    let (status, other) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "second-owned@example.invalid"),
        Some(&second),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(first["user"]["id"], other["user"]["id"]);
    assert_eq!(
        request(&app, "GET", &path(KEY), Value::Null, Some(&admin))
            .await
            .1["user"]["id"],
        first["user"]["id"]
    );
    assert_eq!(
        request(&app, "GET", &path(KEY), Value::Null, Some(&second))
            .await
            .1["user"]["id"],
        other["user"]["id"]
    );
    let mappings: i64 = sqlx::query_scalar("SELECT count(*) FROM user_requests WHERE request_id=?")
        .bind(KEY)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(mappings, 2);
}

#[tokio::test]
async fn queued_creation_rechecks_admin_role_and_session_before_commit() {
    for invalidate in [
        "UPDATE users SET role='viewer' WHERE email='admin@example.invalid'",
        "DELETE FROM sessions",
    ] {
        let (_temp, state, app, admin) = fixture().await;
        let held = state.writer.lock().await;
        let app = app.clone();
        let actor = admin.clone();
        let task = tokio::spawn(async move {
            request(
                &app,
                "POST",
                "/api/v1/users",
                create_body(KEY, "queued@example.invalid"),
                Some(&actor),
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        sqlx::query(invalidate).execute(&state.pool).await.unwrap();
        drop(held);
        let (status, _) = task.await.unwrap();
        assert!(status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM user_requests")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(audit_count(&state, "user.create").await, 0);
    }
}

#[tokio::test]
async fn concurrent_create_and_cancel_serialize_to_one_terminal_result() {
    let (_temp, state, app, admin) = fixture().await;
    let held = state.writer.lock().await;
    let create_app = app.clone();
    let cancel_app = app.clone();
    let create_actor = admin.clone();
    let cancel_actor = admin.clone();
    let create = tokio::spawn(async move {
        request(
            &create_app,
            "POST",
            "/api/v1/users",
            create_body(KEY, "race@example.invalid"),
            Some(&create_actor),
        )
        .await
    });
    let cancel = tokio::spawn(async move {
        request(
            &cancel_app,
            "POST",
            &format!("{}/cancel", path(KEY)),
            json!({}),
            Some(&cancel_actor),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    drop(held);
    let (create_status, created) = create.await.unwrap();
    let (cancel_status, cancelled) = cancel.await.unwrap();
    assert_eq!(cancel_status, StatusCode::OK);
    let (_, final_state) = request(&app, "GET", &path(KEY), Value::Null, Some(&admin)).await;
    assert_eq!(cancelled, final_state);
    match create_status {
        StatusCode::OK => {
            assert_eq!(final_state["status"], "created");
            assert_eq!(created["user"], final_state["user"]);
            assert_eq!(audit_count(&state, "user.create").await, 1);
            assert_eq!(audit_count(&state, "user.request.cancel").await, 0);
        }
        StatusCode::CONFLICT => {
            assert_eq!(final_state["status"], "cancelled");
            assert_eq!(audit_count(&state, "user.create").await, 0);
            assert_eq!(audit_count(&state, "user.request.cancel").await, 1);
        }
        unexpected => panic!("unexpected create status: {unexpected}"),
    }
    let mappings: i64 =
        sqlx::query_scalar("SELECT count(*) FROM user_requests WHERE actor_id=? AND request_id=?")
            .bind(&admin.id)
            .bind(KEY)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(mappings, 1);
}

#[tokio::test]
async fn created_and_cancelled_request_status_survive_restart() {
    let (temp, state, app, admin) = fixture().await;
    let key2 = "b2222222-2222-4222-8222-222222222222";
    let (status, created) = request(
        &app,
        "POST",
        "/api/v1/users",
        create_body(KEY, "persistent@example.invalid"),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, cancelled) = request(
        &app,
        "POST",
        &format!("{}/cancel", path(key2)),
        json!({}),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let settings = state.settings.clone();
    drop(app);
    drop(state);
    let restarted = initialize(settings).await.unwrap();
    let app = api::router(restarted);
    assert_eq!(
        request(&app, "GET", &path(KEY), Value::Null, Some(&admin))
            .await
            .1,
        json!({"request_id":KEY,"status":"created","user":created["user"]})
    );
    assert_eq!(
        request(&app, "GET", &path(key2), Value::Null, Some(&admin))
            .await
            .1,
        cancelled
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/v1/users",
            create_body(key2, "late-after-restart@example.invalid"),
            Some(&admin)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    drop(temp);
}
