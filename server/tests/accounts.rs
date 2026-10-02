use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, initialize};

const PASSWORD: &str = "original-test-password";
const NEXT: &str = "replacement-test-password";

#[tokio::test]
async fn migration_keeps_existing_accounts_and_sessions_enabled() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../migrations/0001_initial.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('legacy','legacy@example.test','Legacy','admin','existing-verifier','2020-01-01T00:00:00Z')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO sessions VALUES('existing-session','legacy','existing-csrf','2099-01-01T00:00:00Z')").execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!("../migrations/0005_account_lifecycle.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let row = sqlx::query("SELECT enabled,revision,password_hash FROM users WHERE id='legacy'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(row.get::<bool, _>("enabled"));
    assert_eq!(row.get::<i64, _>("revision"), 1);
    assert_eq!(row.get::<String, _>("password_hash"), "existing-verifier");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id='legacy'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn reset_request_migration_invalidates_unattributed_codes() {
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
    sqlx::query("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('legacy','legacy@example.test','Legacy','admin','existing-verifier','2020-01-01T00:00:00Z')")
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO password_reset_codes(verifier,user_id,expires_at) VALUES(?,?,?)")
        .bind("a".repeat(64))
        .bind("legacy")
        .bind("2099-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../migrations/0025_password_reset_requests.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let old_codes: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(old_codes, 0);
    let requests: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_requests")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(requests, 0);
}

struct Session {
    user: Value,
    cookie: String,
    csrf: String,
}
impl Session {
    fn from(value: Value, cookie: String) -> Self {
        Self {
            user: value["user"].clone(),
            csrf: value["csrf_token"].as_str().unwrap().into(),
            cookie,
        }
    }
    fn id(&self) -> &str {
        self.user["id"].as_str().unwrap()
    }
}
async fn fixture() -> (tempfile::TempDir, State, Router, Session) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "account-test-bootstrap-secret-123456".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let app = api::router(state.clone());
    let (status, body, cookie) = call(&app, "POST", "/api/v1/bootstrap", json!({"name":"Admin","email":"admin@example.test","password":PASSWORD,"bootstrap_secret":state.settings.bootstrap_secret}), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (temp, state, app, Session::from(body, cookie))
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<&Session>,
) -> (StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(session) = session {
        request = request
            .header("cookie", &session.cookie)
            .header("x-csrf-token", &session.csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), cookie)
}
async fn create(app: &Router, admin: &Session, role: &str, email: &str) -> Session {
    let (status, user, _) = call(
        app,
        "POST",
        "/api/v1/users",
        json!({"name":"Colleague","email":email,"role":role,"password":PASSWORD}),
        Some(admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{user}");
    assert_eq!(user["enabled"], true);
    assert_eq!(user["revision"], 1);
    let (status, body, cookie) = call(
        app,
        "POST",
        "/api/v1/login",
        json!({"email":email,"password":PASSWORD}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    Session::from(body, cookie)
}
fn edit_body(user: &Value, role: &str, enabled: bool) -> Value {
    json!({"name":user["name"],"role":role,"enabled":enabled,"revision":user["revision"],"current_password":PASSWORD})
}
async fn get_user(app: &Router, admin: &Session, id: &str) -> Value {
    let (status, list, _) = call(app, "GET", "/api/v1/users", Value::Null, Some(admin)).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    list.as_array()
        .unwrap()
        .iter()
        .find(|u| u["id"] == id)
        .unwrap()
        .clone()
}
async fn issue(app: &Router, admin: &Session, target: &Value) -> Value {
    let (status, body, _) = call(
        app,
        "POST",
        &format!(
            "/api/v1/users/{}/password-reset",
            target["id"].as_str().unwrap()
        ),
        json!({"current_password":PASSWORD,"revision":target["revision"]}),
        Some(admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

#[tokio::test]
async fn account_administration_authenticates_before_it_reads_the_body() {
    let (_temp, _s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let target = format!("/api/v1/users/{}", viewer.id());
    for (method, path) in [
        ("PUT", target.clone()),
        ("POST", format!("{target}/password-reset")),
        ("POST", format!("{target}/two-factor-reset")),
    ] {
        // A body that would fail validation must never be judged for someone
        // who is not allowed to send it.
        let junk = json!({"unexpected": true});
        let (status, body, _) = call(&app, method, &path, junk.clone(), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path} {body}");
        let (status, body, _) = call(&app, method, &path, junk, Some(&viewer)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path} {body}");
        // Nor may a body that isn't JSON at all, or isn't declared as JSON,
        // tell an anonymous caller anything before authentication.
        for (content_type, raw) in [
            ("application/json", "{not json"),
            ("text/plain", "{\"unexpected\":true}"),
        ] {
            let (status, body) = send_raw(&app, method, &path, content_type, raw, None).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {path} {content_type}: {body}"
            );
            let (status, body) =
                send_raw(&app, method, &path, content_type, raw, Some(&viewer)).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "{method} {path} {content_type}: {body}"
            );
        }
        let (status, body) = send_raw(
            &app,
            method,
            &path,
            "application/json",
            "{not json",
            Some(&admin),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path} {body}");
    }
}
#[tokio::test]
async fn own_account_routes_authenticate_before_they_read_the_body() {
    let (_temp, _s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let without_csrf = Session {
        user: viewer.user.clone(),
        cookie: viewer.cookie.clone(),
        csrf: String::new(),
    };
    for (path, well_formed) in [
        (
            "/api/v1/account/password",
            r#"{"current_password":"anything","new_password":"a-long-enough-replacement"}"#,
        ),
        (
            "/api/v1/account/revoke-sessions",
            r#"{"current_password":"anything"}"#,
        ),
    ] {
        // Nobody signed in learns anything from the body: a well-formed one,
        // one the route would refuse, one that isn't JSON and one that isn't
        // declared as JSON all answer 401.
        for (content_type, raw) in [
            ("application/json", well_formed),
            ("application/json", "{}"),
            ("application/json", r#"{"current_password":7}"#),
            ("application/json", "{not json"),
            ("application/json", ""),
            ("text/plain", well_formed),
            (
                "application/x-www-form-urlencoded",
                "current_password=anything",
            ),
        ] {
            let (status, body) = send_raw(&app, "POST", path, content_type, raw, None).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{path} {content_type} {raw:?}: {body}"
            );
            assert_eq!(body["error"]["code"], "UNAUTHENTICATED", "{path} {raw:?}");
        }
        // A session without the matching CSRF token is refused before the body
        // is judged too.
        for raw in [well_formed, "{not json", "{}"] {
            let (status, body) = send_raw(
                &app,
                "POST",
                path,
                "application/json",
                raw,
                Some(&without_csrf),
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{path} {raw:?}: {body}");
        }
        // Signed in with the token, a body the route cannot read is the
        // caller's mistake: 400, whatever the role.
        for session in [&viewer, &admin] {
            for raw in ["{not json", "", "{}", r#"{"current_password":7}"#] {
                let (status, body) =
                    send_raw(&app, "POST", path, "application/json", raw, Some(session)).await;
                assert_eq!(
                    status,
                    StatusCode::BAD_REQUEST,
                    "{path} {raw:?} as {}: {body}",
                    session.user["role"]
                );
                assert_eq!(body["error"]["code"], "INVALID_INPUT", "{path} {raw:?}");
            }
        }
    }
}
async fn send_raw(
    app: &Router,
    method: &str,
    path: &str,
    content_type: &str,
    body: &str,
    session: Option<&Session>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type);
    if let Some(session) = session {
        request = request
            .header("cookie", &session.cookie)
            .header("x-csrf-token", &session.csrf);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn user_edit_requires_reauth_csrf_role_and_current_revision() {
    let (_temp, _s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let path = format!("/api/v1/users/{}", viewer.id());
    let body = edit_body(&viewer.user, "operator", true);
    assert_eq!(
        call(&app, "PUT", &path, body.clone(), Some(&viewer))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let mut no_csrf = Session {
        user: admin.user.clone(),
        cookie: admin.cookie.clone(),
        csrf: String::new(),
    };
    assert_eq!(
        call(&app, "PUT", &path, body.clone(), Some(&no_csrf))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    no_csrf.csrf = admin.csrf.clone();
    let mut wrong = body.clone();
    wrong["current_password"] = json!("incorrect-password");
    let (status, error, _) = call(&app, "PUT", &path, wrong, Some(&admin)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(error["error"]["code"], "WRONG_PASSWORD");
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&admin))
            .await
            .0,
        StatusCode::OK
    );
    let (status, updated, _) = call(&app, "PUT", &path, body.clone(), Some(&admin)).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["revision"], 2);
    let (status, error, _) = call(&app, "PUT", &path, body, Some(&admin)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "STALE_REVISION");
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert!(updated.get("password_hash").is_none());
}

#[tokio::test]
async fn keyed_access_edit_has_exact_immutable_status_and_cancellation_fence() {
    const KEY: &str = "ac111111-1111-4111-8111-111111111111";
    const LATE: &str = "ac222222-2222-4222-8222-222222222222";
    let (_temp, state, app, admin) = fixture().await;
    let target = create(&app, &admin, "viewer", "access-target@example.test").await;
    let path = format!("/api/v1/users/{}", target.id());
    let exact = format!("{path}/access-requests/{KEY}");
    let absent = json!({"request_id":KEY,"user_id":target.id(),"status":"not_found"});
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&admin)).await.1,
        absent
    );
    let mut change = edit_body(&target.user, "operator", true);
    change["request_id"] = json!(KEY);
    change["name"] = json!("First reviewed edit");
    let (status, applied, _) = call(&app, "PUT", &path, change.clone(), Some(&admin)).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["request_id"], KEY);
    assert_eq!(applied["user"]["name"], "First reviewed edit");
    assert_eq!(applied["user"]["role"], "operator");
    assert_eq!(applied["user"]["revision"], 2);
    assert!(applied["user"].get("password_hash").is_none());
    let original_status =
        json!({"request_id":KEY,"user_id":target.id(),"status":"applied","user":applied["user"]});
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&admin)).await.1,
        original_status
    );
    change["current_password"] = json!("wrong-later-password");
    assert_eq!(
        call(&app, "PUT", &path, change, Some(&admin)).await.0,
        StatusCode::CONFLICT
    );
    let second_admin = create(&app, &admin, "admin", "access-admin2@example.test").await;
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&second_admin))
            .await
            .1,
        absent
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{exact}/cancel"),
            json!({}),
            Some(&second_admin)
        )
        .await
        .1,
        json!({"request_id":KEY,"user_id":target.id(),"status":"cancelled"})
    );
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&admin)).await.1,
        original_status
    );
    let wrong_target = second_admin.id();
    let wrong_path = format!("/api/v1/users/{wrong_target}/access-requests/{KEY}");
    assert_eq!(
        call(&app, "GET", &wrong_path, Value::Null, Some(&admin))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{wrong_path}/cancel"),
            json!({}),
            Some(&admin)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let mut later = edit_body(&applied["user"], "operator", true);
    later["name"] = json!("Later unrelated edit");
    assert_eq!(
        call(&app, "PUT", &path, later, Some(&admin)).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&admin)).await.1,
        original_status
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{exact}/cancel"),
            json!({}),
            Some(&admin)
        )
        .await
        .1,
        original_status
    );
    assert_eq!(
        get_user(&app, &admin, target.id()).await["name"],
        "Later unrelated edit"
    );
    let late_path = format!("{path}/access-requests/{LATE}");
    let cancelled = json!({"request_id":LATE,"user_id":target.id(),"status":"cancelled"});
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{late_path}/cancel"),
            json!({}),
            Some(&admin)
        )
        .await
        .1,
        cancelled
    );
    let mut late = edit_body(&get_user(&app, &admin, target.id()).await, "viewer", true);
    late["request_id"] = json!(LATE);
    assert_eq!(
        call(&app, "PUT", &path, late, Some(&admin)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", &late_path, Value::Null, Some(&admin))
            .await
            .1,
        cancelled
    );
    let success: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.update'")
        .fetch_one(&state.pool).await.unwrap();
    assert_eq!(success, 2);
    let ledger: String = sqlx::query_scalar(
        "SELECT user_json FROM access_edit_requests WHERE request_id=? AND actor_id=?",
    )
    .bind(KEY)
    .bind(admin.id())
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(!ledger.contains(PASSWORD));
    assert!(!ledger.contains("password_hash"));
}

#[tokio::test]
async fn queued_keyed_access_edit_rechecks_current_admin_role_before_commit() {
    const KEY: &str = "ac333333-3333-4333-8333-333333333333";
    let (_temp, state, app, admin) = fixture().await;
    let target = create(&app, &admin, "viewer", "access-queued@example.test").await;
    let target_id = target.id().to_owned();
    let admin_id = admin.id().to_owned();
    let mut body = edit_body(&target.user, "operator", true);
    body["request_id"] = json!(KEY);
    let guard = state.writer.lock().await;
    let request_app = app.clone();
    let pending = tokio::spawn(async move {
        call(
            &request_app,
            "PUT",
            &format!("/api/v1/users/{target_id}"),
            body,
            Some(&admin),
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    sqlx::query("UPDATE users SET role='viewer' WHERE id=?")
        .bind(admin_id)
        .execute(&state.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(pending.await.unwrap().0, StatusCode::FORBIDDEN);
    let requests: i64 = sqlx::query_scalar("SELECT count(*) FROM access_edit_requests")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(requests, 0);
    let updates: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.update'")
        .fetch_one(&state.pool).await.unwrap();
    assert_eq!(updates, 0);
}

#[tokio::test]
async fn name_only_preserves_sessions_disable_blocks_login_and_reset_then_enable() {
    let (_temp, s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let reset = issue(&app, &admin, &viewer.user).await;
    let target = get_user(&app, &admin, viewer.id()).await;
    let mut body = edit_body(&target, "viewer", true);
    body["name"] = json!("Renamed");
    let path = format!("/api/v1/users/{}", viewer.id());
    let (status, renamed, _) = call(&app, "PUT", &path, body, Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .1["user"]["name"],
        "Renamed"
    );
    let (status, disabled, _) = call(
        &app,
        "PUT",
        &path,
        edit_body(&renamed, "viewer", false),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"viewer@example.test","password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/password-reset",
            json!({"code":reset["code"],"new_password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{path}/password-reset"),
            json!({"current_password":PASSWORD,"revision":disabled["revision"]}),
            Some(&admin)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_codes")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(pending, 0);
    assert_eq!(
        call(
            &app,
            "PUT",
            &path,
            edit_body(&disabled, "viewer", true),
            Some(&admin)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"viewer@example.test","password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_admin_removals_leave_one_enabled_admin() {
    let (_temp, s, app, admin) = fixture().await;
    let second = create(&app, &admin, "admin", "second@example.test").await;
    let a_path = format!("/api/v1/users/{}", admin.id());
    let b_path = format!("/api/v1/users/{}", second.id());
    // Distinct admins concurrently remove their own access. Neither request may
    // observe the pre-edit count and allow both removals.
    let (a, b) = tokio::join!(
        call(
            &app,
            "PUT",
            &a_path,
            edit_body(&admin.user, "viewer", true),
            Some(&admin)
        ),
        call(
            &app,
            "PUT",
            &b_path,
            edit_body(&second.user, "admin", false),
            Some(&second)
        )
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1,
        "{a:?} {b:?}"
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE role='admin' AND enabled=1")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn unread_account_action_receipts_preserve_session_scope_and_atomicity() {
    async fn login(app: &Router) -> Session {
        let (status, value, cookie) = call(
            app,
            "POST",
            "/api/v1/login",
            json!({"email":"admin@example.test","password":PASSWORD}),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        Session::from(value, cookie)
    }
    async fn unread(app: &Router, path: &str, body: Value, session: &Session) -> String {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("cookie", &session.cookie)
                    .header("x-csrf-token", &session.csrf)
                    .header("sec-fetch-site", "same-origin")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let cookie = response
            .headers()
            .get("set-cookie")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        // Genuinely unpolled JSON. Cookie receipt/loss is modeled explicitly;
        // this is a handler fixture, not a browser or network-delivery proof.
        drop(response);
        cookie
    }
    async fn snapshot(s: &State) -> Value {
        let mut value = json!({});
        for (name, query) in [
            (
                "users",
                "SELECT json_array(id,email,name,role,password_hash,created_at,enabled,revision) FROM users ORDER BY id",
            ),
            (
                "sessions",
                "SELECT json_array(verifier,user_id,csrf,expires_at) FROM sessions ORDER BY verifier",
            ),
            (
                "records",
                "SELECT json_array(kind,id,data,created_at) FROM records ORDER BY kind,id",
            ),
            (
                "reset",
                "SELECT json_array(verifier,user_id,expires_at) FROM password_reset_codes ORDER BY user_id",
            ),
            (
                "challenges",
                "SELECT json_array(verifier,user_id,user_revision,password_fingerprint,mfa_fingerprint,expires_at,attempts) FROM login_challenges ORDER BY verifier",
            ),
            (
                "mfa",
                "SELECT json_array(user_id,secret_ciphertext,enabled,last_used_step) FROM user_mfa ORDER BY user_id",
            ),
            (
                "recovery",
                "SELECT json_array(user_id,verifier) FROM mfa_recovery_codes ORDER BY user_id,verifier",
            ),
        ] {
            let rows: Vec<String> = sqlx::query_scalar(query).fetch_all(&s.pool).await.unwrap();
            value[name] = json!(rows);
        }
        value
    }
    async fn audits(s: &State, action: &str) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')=? AND json_extract(data,'$.outcome')='success'")
            .bind(action).fetch_one(&s.pool).await.unwrap()
    }
    let (_temp, s, app, original) = fixture().await;
    let other_account = create(&app, &original, "viewer", "independent@example.test").await;
    let other_account_before = call(
        &app,
        "GET",
        "/api/v1/session",
        Value::Null,
        Some(&other_account),
    )
    .await;
    let same_account = login(&app).await;
    let _reset = issue(&app, &original, &original.user).await;
    let body = json!({"current_password":PASSWORD,"new_password":NEXT});
    let before = snapshot(&s).await;
    sqlx::raw_sql("CREATE TRIGGER fail_password_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='account.password' BEGIN SELECT RAISE(ABORT,'injected password audit failure'); END;")
        .execute(&s.pool).await.unwrap();
    let failed = call(
        &app,
        "POST",
        "/api/v1/account/password",
        body.clone(),
        Some(&original),
    )
    .await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(failed.2.is_empty());
    assert_eq!(snapshot(&s).await, before);
    sqlx::query("DROP TRIGGER fail_password_audit")
        .execute(&s.pool)
        .await
        .unwrap();
    let cookie = unread(&app, "/api/v1/account/password", body.clone(), &original).await;
    assert!(!cookie.is_empty());
    assert_ne!(cookie, original.cookie);
    let committed = snapshot(&s).await;
    let cookie_only = Session {
        user: original.user.clone(),
        cookie,
        csrf: String::new(),
    };
    let (status, current, read_cookie) = call(
        &app,
        "GET",
        "/api/v1/session",
        Value::Null,
        Some(&cookie_only),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(read_cookie.is_empty());
    assert_eq!(current["user"]["id"], original.user["id"]);
    assert_eq!(current["user"]["revision"], 3);
    // The original displayed revision was1: reset-code issuance had already
    // advanced it without invalidating that session. Password POST has no CAS.
    assert_eq!(original.user["revision"], 1);
    assert_ne!(current["csrf_token"], original.csrf);
    for old in [Some(&original), Some(&same_account), None] {
        assert_eq!(
            call(&app, "GET", "/api/v1/session", Value::Null, old)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&other_account)
        )
        .await,
        other_account_before
    );
    assert_eq!(committed["reset"].as_array().unwrap().len(), 0);
    assert_eq!(committed["sessions"].as_array().unwrap().len(), 2);
    assert_eq!(audits(&s, "account.password").await, 1);
    assert_eq!(snapshot(&s).await, committed);
    let duplicate = call(
        &app,
        "POST",
        "/api/v1/account/password",
        body.clone(),
        Some(&original),
    )
    .await;
    assert_eq!(duplicate.0, StatusCode::UNAUTHORIZED);
    assert!(duplicate.2.is_empty());
    let stale_csrf = Session {
        user: current["user"].clone(),
        cookie: cookie_only.cookie.clone(),
        csrf: original.csrf.clone(),
    };
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/account/password",
            body,
            Some(&stale_csrf)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&s).await, committed);

    let (_temp2, s, app, original) = fixture().await;
    let other_account = create(&app, &original, "viewer", "independent@example.test").await;
    let other_account_before = call(
        &app,
        "GET",
        "/api/v1/session",
        Value::Null,
        Some(&other_account),
    )
    .await;
    let same_account = login(&app).await;
    let current_before = call(&app, "GET", "/api/v1/session", Value::Null, Some(&original)).await;
    let before = snapshot(&s).await;
    let body = json!({"current_password":PASSWORD});
    sqlx::raw_sql("CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='account.revoke_sessions' BEGIN SELECT RAISE(ABORT,'injected session revocation audit failure'); END;")
        .execute(&s.pool).await.unwrap();
    let failed = call(
        &app,
        "POST",
        "/api/v1/account/revoke-sessions",
        body.clone(),
        Some(&original),
    )
    .await;
    assert_eq!(failed.0, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(failed.2.is_empty());
    assert_eq!(snapshot(&s).await, before);
    sqlx::query("DROP TRIGGER fail_revoke_audit")
        .execute(&s.pool)
        .await
        .unwrap();
    assert!(
        unread(
            &app,
            "/api/v1/account/revoke-sessions",
            body.clone(),
            &original
        )
        .await
        .is_empty()
    );
    let committed = snapshot(&s).await;
    assert_eq!(committed["users"], before["users"]);
    assert_eq!(audits(&s, "account.revoke_sessions").await, 1);
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&original)).await,
        current_before
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&same_account)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&other_account)
        )
        .await,
        other_account_before
    );
    assert_eq!(snapshot(&s).await, committed);

    // This deliberate repeated action is NOT idempotent replay: it also removes
    // another session created since the unread first receipt, and audits again.
    let later_session = login(&app).await;
    let repeated = call(
        &app,
        "POST",
        "/api/v1/account/revoke-sessions",
        body.clone(),
        Some(&original),
    )
    .await;
    assert_eq!(repeated.0, StatusCode::OK);
    assert_eq!(repeated.1, json!({"ok":true}));
    assert!(repeated.2.is_empty());
    assert_eq!(audits(&s, "account.revoke_sessions").await, 2);
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&later_session)
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&original)).await,
        current_before
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&other_account)
        )
        .await,
        other_account_before
    );

    let surviving = login(&app).await;
    let guard = s.writer.lock().await;
    let request_app = app.clone();
    let queued_session = Session {
        user: original.user.clone(),
        cookie: original.cookie.clone(),
        csrf: original.csrf.clone(),
    };
    let task = tokio::spawn(async move {
        call(
            &request_app,
            "POST",
            "/api/v1/account/revoke-sessions",
            body,
            Some(&queued_session),
        )
        .await
    });
    // Fixture-only authority change while the application writer is held. The
    // delay gives preauthentication work a queue opportunity, not a TCP proof.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    sqlx::query("DELETE FROM sessions WHERE verifier=?")
        .bind(db::hash(
            original.cookie.strip_prefix("vectory_session=").unwrap(),
        ))
        .execute(&s.pool)
        .await
        .unwrap();
    let changed_authority = snapshot(&s).await;
    drop(guard);
    let rejected = task.await.unwrap();
    assert_eq!(rejected.0, StatusCode::UNAUTHORIZED);
    assert!(rejected.2.is_empty());
    assert_eq!(snapshot(&s).await, changed_authority);
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&surviving)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/v1/session",
            Value::Null,
            Some(&other_account)
        )
        .await,
        other_account_before
    );
    assert_eq!(snapshot(&s).await, changed_authority);
}

#[tokio::test]
async fn self_password_rotates_every_session_but_revoke_others_keeps_current() {
    let (_temp, s, app, admin) = fixture().await;
    let (_, login, cookie) = call(
        &app,
        "POST",
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
        None,
    )
    .await;
    let other = Session::from(login, cookie);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/account/revoke-sessions",
            json!({"current_password":PASSWORD}),
            Some(&admin)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&other))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&admin))
            .await
            .0,
        StatusCode::OK
    );
    let reset = issue(&app, &admin, &admin.user).await;
    let (status, response, cookie) = call(
        &app,
        "POST",
        "/api/v1/account/password",
        json!({"current_password":PASSWORD,"new_password":NEXT}),
        Some(&admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_ne!(cookie, admin.cookie);
    assert_ne!(response["csrf_token"], admin.csrf);
    let fresh = Session::from(response, cookie);
    assert_eq!(fresh.user["revision"], 3);
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&admin))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&fresh))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"admin@example.test","password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"admin@example.test","password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/password-reset",
            json!({"code":reset["code"],"new_password":PASSWORD}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id=?")
        .bind(admin.id())
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(hash.starts_with("$argon2"));
    assert!(!hash.contains(NEXT));
}

#[tokio::test]
async fn reset_codes_are_hash_only_expiring_replaced_and_concurrently_single_use() {
    let (_temp, s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let first = issue(&app, &admin, &viewer.user).await;
    assert_eq!(first["code"].as_str().unwrap().len(), 64);
    let stored = sqlx::query("SELECT * FROM password_reset_codes")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        stored.get::<String, _>("verifier"),
        db::hash(first["code"].as_str().unwrap())
    );
    let target = get_user(&app, &admin, viewer.id()).await;
    let second = issue(&app, &admin, &target).await;
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/password-reset",
            json!({"code":first["code"],"new_password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE password_reset_codes SET expires_at='2000-01-01T00:00:00Z'")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/password-reset",
            json!({"code":second["code"],"new_password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let target = get_user(&app, &admin, viewer.id()).await;
    let third = issue(&app, &admin, &target).await;
    let body = json!({"code":third["code"],"new_password":NEXT});
    let (a, b) = tokio::join!(
        call(&app, "POST", "/api/v1/password-reset", body.clone(), None),
        call(&app, "POST", "/api/v1/password-reset", body, None)
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::UNAUTHORIZED)
            .count(),
        1
    );
    assert!(a.2.is_empty() && b.2.is_empty(), "Reset must not log in");
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, audit, _) = call(&app, "GET", "/api/v1/audit", Value::Null, Some(&admin)).await;
    for secret in [
        PASSWORD,
        NEXT,
        first["code"].as_str().unwrap(),
        second["code"].as_str().unwrap(),
        third["code"].as_str().unwrap(),
    ] {
        assert!(!audit.to_string().contains(secret));
    }
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/login",
            json!({"email":"viewer@example.test","password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn password_reset_preserves_mfa_and_cannot_replace_it() {
    use totp_rs::{Algorithm, Secret, TOTP};
    let (_temp, s, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "viewer@example.test").await;
    let (status, setup, _) = call(
        &app,
        "POST",
        "/api/v1/mfa/setup",
        json!({"password":PASSWORD}),
        Some(&viewer),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let (status, rejected, _) = call(
        &app,
        "POST",
        "/api/v1/mfa/confirm",
        json!({"code":"badbad"}),
        Some(&viewer),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(rejected["error"]["code"], "INVALID_MFA_CODE");
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .0,
        StatusCode::OK
    );
    let generator = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        Secret::Encoded(setup["secret"].as_str().unwrap().into())
            .to_bytes()
            .unwrap(),
        Some("Vectory".into()),
        "viewer@example.test".into(),
    )
    .unwrap();
    let code = generator.generate_current().unwrap();
    let (status, confirmed, _) = call(
        &app,
        "POST",
        "/api/v1/mfa/confirm",
        json!({"code":code}),
        Some(&viewer),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for body in [
        json!({"password":PASSWORD,"code":"badbad"}),
        json!({"password":PASSWORD,"recovery_code":"not-a-recovery-code"}),
    ] {
        let (status, rejected, _) =
            call(&app, "POST", "/api/v1/mfa/disable", body, Some(&viewer)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(rejected["error"]["code"], "INVALID_MFA_CODE");
    }
    assert_eq!(
        call(&app, "GET", "/api/v1/session", Value::Null, Some(&viewer))
            .await
            .0,
        StatusCode::OK
    );
    let (status, rejected, _) = call(
        &app,
        "POST",
        "/api/v1/login",
        json!({"email":"viewer@example.test","password":PASSWORD,"totp_code":"badbad"}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(rejected["error"]["code"], "UNAUTHENTICATED");
    let reset = issue(&app, &admin, &viewer.user).await;
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/v1/password-reset",
            json!({"code":reset["code"],"new_password":NEXT}),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, challenge, cookie) = call(
        &app,
        "POST",
        "/api/v1/login",
        json!({"email":"viewer@example.test","password":NEXT}),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(challenge["mfa_required"], true);
    assert!(challenge.get("user").is_none());
    assert!(cookie.is_empty());
    assert_eq!(call(&app,"POST","/api/v1/login",json!({"email":"viewer@example.test","password":NEXT,"recovery_code":confirmed["recovery_codes"][0]}),None).await.0,StatusCode::OK);
    let enabled: bool = sqlx::query_scalar("SELECT enabled FROM user_mfa WHERE user_id=?")
        .bind(viewer.id())
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(enabled);
}

#[tokio::test]
async fn pending_mutation_rechecks_actor_after_session_revocation() {
    let (_temp, s, app, admin) = fixture().await;
    let guard = s.writer.lock().await;
    let request_app = app.clone();
    let task = tokio::spawn(async move {
        call(
            &request_app,
            "POST",
            "/api/v1/groups",
            json!({"name":"Queued forbidden group","description":"","device_ids":[]}),
            Some(&admin),
        )
        .await
    });
    // Wait for the route's initial read to finish and queue on the held writer.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    sqlx::query("DELETE FROM sessions")
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    let groups: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='group'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(groups, 0);
}

#[tokio::test]
async fn queued_keyed_reset_issue_rechecks_session_and_admin_role_before_commit() {
    const KEY: &str = "ca111111-1111-4111-8111-111111111111";
    for (change, expected) in [
        ("DELETE FROM sessions", StatusCode::UNAUTHORIZED),
        (
            "UPDATE users SET role='viewer' WHERE role='admin'",
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (_temp, state, app, admin) = fixture().await;
        let viewer = create(&app, &admin, "viewer", "queued-reset@example.test").await;
        let target = viewer.id().to_owned();
        let guard = state.writer.lock().await;
        let request_app = app.clone();
        let request_path = format!("/api/v1/users/{target}/password-reset");
        let pending = tokio::spawn(async move {
            call(
                &request_app,
                "POST",
                &request_path,
                json!({"request_id":KEY,"current_password":PASSWORD,"revision":1}),
                Some(&admin),
            )
            .await
        });
        // Argon2 work and authorization can finish while the transaction is
        // held. Neither a revoked session nor a downgraded role may acquire a
        // commit permit from an earlier preflight read.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        sqlx::query(change).execute(&state.pool).await.unwrap();
        drop(guard);
        let (status, _, _) = pending.await.unwrap();
        assert_eq!(status, expected);
        let codes: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_codes")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let requests: i64 = sqlx::query_scalar("SELECT count(*) FROM password_reset_requests")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.password_reset.issue'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!((codes, requests, audits), (0, 0, 0));
    }
}

#[tokio::test]
async fn keyed_reset_issue_and_cancel_have_one_terminal_outcome_under_race() {
    const KEY: &str = "ca222222-2222-4222-8222-222222222222";
    let (_temp, state, app, admin) = fixture().await;
    let viewer = create(&app, &admin, "viewer", "race-reset@example.test").await;
    let target = viewer.id();
    let path = format!("/api/v1/users/{target}/password-reset");
    let exact = format!("{path}/requests/{KEY}");
    let cancel_path = format!("{exact}/cancel");
    let (issue, cancel) = tokio::join!(
        call(
            &app,
            "POST",
            &path,
            json!({"request_id":KEY,"current_password":PASSWORD,"revision":1}),
            Some(&admin)
        ),
        call(&app, "POST", &cancel_path, json!({}), Some(&admin))
    );
    assert_eq!(cancel.0, StatusCode::OK);
    assert_eq!(cancel.1["status"], "cancelled");
    assert_eq!(cancel.1["request_id"], KEY);
    assert_eq!(cancel.1["user_id"], target);
    assert!(matches!(issue.0, StatusCode::OK | StatusCode::CONFLICT));
    assert_eq!(cancel.1["was_issued"], issue.0 == StatusCode::OK);
    assert_eq!(
        call(&app, "GET", &exact, Value::Null, Some(&admin)).await.1,
        cancel.1
    );
    let active: i64 =
        sqlx::query_scalar("SELECT count(*) FROM password_reset_codes WHERE user_id=?")
            .bind(target)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(active, 0);
    let issue_audits: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.password_reset.issue'")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(issue_audits, if issue.0 == StatusCode::OK { 1 } else { 0 });
}

#[tokio::test]
async fn login_cannot_mint_session_from_a_disabled_or_changed_password_snapshot() {
    for change in [
        "UPDATE users SET enabled=0",
        "UPDATE users SET password_hash='replaced-hash'",
    ] {
        let (_temp, s, app, _admin) = fixture().await;
        let guard = s.writer.lock().await;
        let request_app = app.clone();
        let task = tokio::spawn(async move {
            call(
                &request_app,
                "POST",
                "/api/v1/login",
                json!({"email":"admin@example.test","password":PASSWORD}),
                None,
            )
            .await
        });
        // The live request is forced to wait before its commit. Even a successful
        // password check against the old row may not create a fresh session.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        sqlx::query(change).execute(&s.pool).await.unwrap();
        sqlx::query("DELETE FROM sessions")
            .execute(&s.pool)
            .await
            .unwrap();
        drop(guard);
        assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
        let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(sessions, 0);
    }
}
