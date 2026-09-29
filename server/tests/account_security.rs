//! First run, humane account errors, session endings and inventory, invitations,
//! recovery codes and administrator/offline break-glass recovery.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, initialize};

const SECRET: &str = "account-security-bootstrap-secret-1234";
const PASSWORD: &str = "original-test-password";
const NEXT: &str = "replacement-test-password";

#[derive(Clone)]
struct Session {
    user: Value,
    cookie: String,
    csrf: String,
}
impl Session {
    fn id(&self) -> String {
        self.user["id"].as_str().unwrap().to_owned()
    }
}
struct Reply {
    status: StatusCode,
    body: Value,
    cookie: String,
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<&Session>,
    agent: &str,
) -> Reply {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("user-agent", agent);
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
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    }
}
async fn get(app: &Router, path: &str, session: Option<&Session>) -> Reply {
    call(app, "GET", path, Value::Null, session, "Test browser").await
}
async fn post(app: &Router, path: &str, body: Value, session: Option<&Session>) -> Reply {
    call(app, "POST", path, body, session, "Test browser").await
}
fn session(reply: Reply) -> Session {
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    Session {
        user: reply.body["user"].clone(),
        csrf: reply.body["csrf_token"].as_str().unwrap().to_owned(),
        cookie: reply.cookie,
    }
}
fn code(reply: &Reply) -> &str {
    reply.body["error"]["code"].as_str().unwrap_or("")
}
async fn fresh() -> (tempfile::TempDir, State, Router) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Acme Production".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let app = api::router(state.clone());
    (temp, state, app)
}
async fn fixture() -> (tempfile::TempDir, State, Router, Session) {
    let (temp, state, app) = fresh().await;
    let admin = session(
        post(
            &app,
            "/api/v1/bootstrap",
            json!({"name":"Admin","email":"admin@example.test","password":PASSWORD,"bootstrap_secret":SECRET}),
            None,
        )
        .await,
    );
    (temp, state, app, admin)
}
async fn sign_in(app: &Router, email: &str, password: &str, agent: &str) -> Session {
    session(
        call(
            app,
            "POST",
            "/api/v1/login",
            json!({"email":email,"password":password}),
            None,
            agent,
        )
        .await,
    )
}
async fn person(app: &Router, admin: &Session, email: &str, role: &str) -> Session {
    let reply = post(
        app,
        "/api/v1/users",
        json!({"name":"Colleague","email":email,"role":role,"password":PASSWORD}),
        Some(admin),
    )
    .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    sign_in(app, email, PASSWORD, "Colleague browser").await
}
async fn people(app: &Router, admin: &Session) -> Vec<Value> {
    let reply = get(app, "/api/v1/users", Some(admin)).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    reply.body.as_array().unwrap().clone()
}
async fn ended(app: &Router, session: &Session) -> Value {
    let reply = get(app, "/api/v1/session", Some(session)).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{}", reply.body);
    assert_eq!(code(&reply), "UNAUTHENTICATED");
    reply.body["error"]["reason"].clone()
}
async fn totp_setup(app: &Router, who: &Session) -> totp_rs::TOTP {
    let setup = post(
        app,
        "/api/v1/mfa/setup",
        json!({"password":PASSWORD}),
        Some(who),
    )
    .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    totp_rs::TOTP::from_url(setup.body["otpauth_url"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn first_run_status_names_the_secret_source_and_setup_errors_are_humane() {
    let (_temp, state, app) = fresh().await;
    let status = get(&app, "/api/v1/status", None).await;
    assert_eq!(status.body["initialized"], false);
    assert_eq!(status.body["instance_name"], "Acme Production");
    let hint = &status.body["setup_hint"];
    assert!(hint.is_object(), "{}", status.body);
    assert!(!status.body.to_string().contains(SECRET));

    let setup = |secret: &str, password: &str| json!({"name":"Jane Admin","email":"jane@example.test","password":password,"bootstrap_secret":secret});
    let wrong = post(
        &app,
        "/api/v1/bootstrap",
        setup("not-the-secret", NEXT),
        None,
    )
    .await;
    assert_eq!(wrong.status, StatusCode::FORBIDDEN);
    assert_eq!(code(&wrong), "SETUP_SECRET_INVALID");
    let weak = post(
        &app,
        "/api/v1/bootstrap",
        setup(SECRET, "password1234"),
        None,
    )
    .await;
    assert_eq!(weak.status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&weak), "PASSWORD_TOO_WEAK");
    let bad_email = post(
        &app,
        "/api/v1/bootstrap",
        json!({"name":"Jane","email":"jane","password":NEXT,"bootstrap_secret":SECRET}),
        None,
    )
    .await;
    assert_eq!(code(&bad_email), "EMAIL_INVALID");
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(users, 0);

    // A pasted secret with surrounding whitespace or a newline still matches.
    let admin = session(
        post(
            &app,
            "/api/v1/bootstrap",
            setup(&format!("  {SECRET}\n"), NEXT),
            None,
        )
        .await,
    );
    assert!(admin.csrf.len() == 64);
    let status = get(&app, "/api/v1/status", None).await;
    assert_eq!(status.body["initialized"], true);
    assert!(status.body.get("setup_hint").is_none());
    let again = post(&app, "/api/v1/bootstrap", setup(SECRET, NEXT), None).await;
    assert_eq!(again.status, StatusCode::CONFLICT);
    assert_eq!(code(&again), "ALREADY_INITIALIZED");
    let listed = people(&app, &admin).await;
    assert_eq!(listed[0]["status"], "active");
    assert!(listed[0]["last_login_at"].is_string());
}

#[tokio::test]
async fn ordinary_rejections_have_distinct_codes() {
    let (_temp, _state, app, admin) = fixture().await;
    let colleague = person(&app, &admin, "colleague@example.test", "viewer").await;
    let duplicate = post(
        &app,
        "/api/v1/users",
        json!({"name":"Twin","email":"Colleague@example.test","role":"viewer","password":NEXT}),
        Some(&admin),
    )
    .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);
    assert_eq!(code(&duplicate), "EMAIL_TAKEN");
    let key = uuid::Uuid::new_v4().to_string();
    let keyed = |email: &str| json!({"request_id":key,"name":"Keyed","email":email,"role":"viewer","password":NEXT});
    let taken = post(
        &app,
        "/api/v1/users",
        keyed("colleague@example.test"),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&taken), "EMAIL_TAKEN");
    let created = post(
        &app,
        "/api/v1/users",
        keyed("keyed@example.test"),
        Some(&admin),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.body);
    let reused = post(
        &app,
        "/api/v1/users",
        keyed("other@example.test"),
        Some(&admin),
    )
    .await;
    assert_eq!(reused.status, StatusCode::CONFLICT);
    assert_eq!(code(&reused), "REQUEST_ALREADY_USED");

    let me = admin.user.clone();
    let last_admin = call(
        &app,
        "PUT",
        &format!("/api/v1/users/{}", admin.id()),
        json!({"name":"Admin","role":"viewer","enabled":true,"revision":me["revision"],"current_password":PASSWORD}),
        Some(&admin),
        "Test browser",
    )
    .await;
    assert_eq!(code(&last_admin), "LAST_ADMIN");
    let stale = call(
        &app,
        "PUT",
        &format!("/api/v1/users/{}", colleague.id()),
        json!({"name":"Renamed","role":"viewer","enabled":true,"revision":99,"current_password":PASSWORD}),
        Some(&admin),
        "Test browser",
    )
    .await;
    assert_eq!(code(&stale), "STALE_REVISION");
    let wrong = call(
        &app,
        "PUT",
        &format!("/api/v1/users/{}", colleague.id()),
        json!({"name":"Renamed","role":"viewer","enabled":false,"revision":1,"current_password":"not-my-password"}),
        Some(&admin),
        "Test browser",
    )
    .await;
    assert_eq!(code(&wrong), "WRONG_PASSWORD");
    let disabled = call(
        &app,
        "PUT",
        &format!("/api/v1/users/{}", colleague.id()),
        json!({"name":"Colleague","role":"viewer","enabled":false,"revision":1,"current_password":PASSWORD}),
        Some(&admin),
        "Test browser",
    )
    .await;
    assert_eq!(disabled.status, StatusCode::OK, "{}", disabled.body);
    let reset = post(
        &app,
        &format!("/api/v1/users/{}/password-reset", colleague.id()),
        json!({"current_password":PASSWORD,"revision":2}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&reset), "ACCOUNT_DISABLED");
    let unchanged = post(
        &app,
        "/api/v1/account/password",
        json!({"current_password":PASSWORD,"new_password":PASSWORD}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&unchanged), "PASSWORD_UNCHANGED");
    let weak = post(
        &app,
        "/api/v1/account/password",
        json!({"current_password":PASSWORD,"new_password":"aaaaaaaaaaaaaaaa"}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&weak), "PASSWORD_TOO_WEAK");
}

#[tokio::test]
async fn session_endings_explain_themselves_to_the_browser_that_held_them() {
    let (_temp, state, app, admin) = fixture().await;
    let colleague = person(&app, &admin, "colleague@example.test", "editor").await;

    // Another browser changes the password: this browser learns why it ended.
    let other = sign_in(&app, "colleague@example.test", PASSWORD, "Laptop").await;
    let changed = session(
        post(
            &app,
            "/api/v1/account/password",
            json!({"current_password":PASSWORD,"new_password":NEXT}),
            Some(&other),
        )
        .await,
    );
    assert_eq!(ended(&app, &colleague).await, "password_changed");
    assert!(get(&app, "/api/v1/session", Some(&changed)).await.body["expires_at"].is_string());

    let second = sign_in(&app, "colleague@example.test", NEXT, "Phone").await;
    let revoked = post(
        &app,
        "/api/v1/account/revoke-sessions",
        json!({"current_password":NEXT}),
        Some(&changed),
    )
    .await;
    assert_eq!(revoked.status, StatusCode::OK);
    assert_eq!(ended(&app, &second).await, "signed_out_elsewhere");

    let tab = sign_in(&app, "colleague@example.test", NEXT, "Tablet").await;
    let out = post(&app, "/api/v1/logout", json!({}), Some(&tab)).await;
    assert_eq!(out.status, StatusCode::OK);
    assert_eq!(ended(&app, &tab).await, "signed_out");

    let role = call(
        &app,
        "PUT",
        &format!("/api/v1/users/{}", changed.id()),
        json!({"name":"Colleague","role":"viewer","enabled":true,"revision":2,"current_password":PASSWORD}),
        Some(&admin),
        "Test browser",
    )
    .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.body);
    assert_eq!(ended(&app, &changed).await, "access_changed");

    // Expiry is explained both before and after the scheduler removes the row.
    let expiring = sign_in(&app, "colleague@example.test", NEXT, "Kiosk").await;
    sqlx::query("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z' WHERE user_id=?")
        .bind(changed.id())
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(ended(&app, &expiring).await, "expired");
    sqlx::query("DELETE FROM sessions WHERE expires_at<'2001-01-01T00:00:00Z'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(ended(&app, &expiring).await, "expired");

    // No cookie, or an unknown one, carries no reason.
    assert_eq!(
        get(&app, "/api/v1/session", None).await.body["error"]["reason"],
        Value::Null
    );
}

#[tokio::test]
async fn session_inventory_lists_this_browser_and_revokes_one_other() {
    let (_temp, state, app, admin) = fixture().await;
    let laptop = sign_in(&app, "admin@example.test", PASSWORD, "Mozilla/5.0 Laptop").await;
    let listed = get(&app, "/api/v1/account/sessions", Some(&laptop)).await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.body);
    let sessions = listed.body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["current"], true);
    assert_eq!(sessions[0]["user_agent"], "Mozilla/5.0 Laptop");
    assert_eq!(sessions[0]["client_address"], "unknown");
    for key in ["created_at", "last_seen_at", "expires_at"] {
        assert!(sessions[0][key].is_string(), "{key}");
    }
    let raw = listed.body.to_string();
    let verifiers: Vec<String> = sqlx::query_scalar("SELECT verifier FROM sessions")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert!(verifiers.iter().all(|v| !raw.contains(v.as_str())));
    assert!(!raw.contains(&laptop.cookie[16..]));

    let current = sessions[0]["id"].as_str().unwrap();
    let other = sessions[1]["id"].as_str().unwrap();
    let own = post(
        &app,
        &format!("/api/v1/account/sessions/{current}/revoke"),
        json!({}),
        Some(&laptop),
    )
    .await;
    assert_eq!(own.status, StatusCode::CONFLICT);
    assert_eq!(code(&own), "CURRENT_SESSION");
    let no_csrf = Session {
        csrf: "wrong".into(),
        ..laptop.clone()
    };
    let forged = post(
        &app,
        &format!("/api/v1/account/sessions/{other}/revoke"),
        json!({}),
        Some(&no_csrf),
    )
    .await;
    assert_eq!(forged.status, StatusCode::FORBIDDEN);
    let done = post(
        &app,
        &format!("/api/v1/account/sessions/{other}/revoke"),
        json!({}),
        Some(&laptop),
    )
    .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(ended(&app, &admin).await, "signed_out_elsewhere");
    let again = post(
        &app,
        &format!("/api/v1/account/sessions/{other}/revoke"),
        json!({}),
        Some(&laptop),
    )
    .await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);
    assert_eq!(code(&again), "SESSION_NOT_FOUND");

    // One person's session identifiers never reach another account.
    let colleague = person(&app, &admin_again(&app).await, "c@example.test", "viewer").await;
    let theirs = post(
        &app,
        &format!("/api/v1/account/sessions/{current}/revoke"),
        json!({}),
        Some(&colleague),
    )
    .await;
    assert_eq!(theirs.status, StatusCode::NOT_FOUND);
    assert_eq!(
        get(&app, "/api/v1/session", Some(&laptop)).await.status,
        StatusCode::OK
    );
}
async fn admin_again(app: &Router) -> Session {
    sign_in(app, "admin@example.test", PASSWORD, "Desk").await
}

async fn last_seen(state: &State) -> String {
    sqlx::query_scalar("SELECT last_seen_at FROM session_details")
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn last_active_updates_never_break_or_wait_on_a_writer() {
    let (_temp, state, app, admin) = fixture().await;
    let stale = "2000-01-01T00:00:00Z";
    sqlx::query("UPDATE session_details SET last_seen_at=?")
        .bind(stale)
        .execute(&state.pool)
        .await
        .unwrap();

    // Why writers begin immediately: a deferred transaction that has read
    // cannot write after another connection commits (SQLITE_BUSY_SNAPSHOT).
    let mut deferred = state.pool.begin().await.unwrap();
    sqlx::query("SELECT count(*) FROM users")
        .execute(&mut *deferred)
        .await
        .unwrap();
    sqlx::query("UPDATE session_details SET last_seen_at='2000-01-01T00:00:01Z'")
        .execute(&state.pool)
        .await
        .unwrap();
    let stale_snapshot = sqlx::query("UPDATE users SET name=name")
        .execute(&mut *deferred)
        .await
        .unwrap_err();
    assert!(
        stale_snapshot.to_string().contains("locked"),
        "{stale_snapshot}"
    );
    drop(deferred);
    sqlx::query("UPDATE session_details SET last_seen_at=?")
        .bind(stale)
        .execute(&state.pool)
        .await
        .unwrap();

    // An authenticated request during a writer transaction skips its
    // best-effort last-active write instead of queueing behind or breaking it.
    let (guard, mut tx) = vectory_server::db::write_tx(&state).await.unwrap();
    sqlx::query("SELECT count(*) FROM users")
        .execute(&mut *tx)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    let (current, members) = tokio::join!(
        get(&app, "/api/v1/session", Some(&admin)),
        get(&app, "/api/v1/users", Some(&admin)),
    );
    assert_eq!(current.status, StatusCode::OK, "{}", current.body);
    assert_eq!(members.status, StatusCode::OK, "{}", members.body);
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    sqlx::query("UPDATE users SET name=name")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    drop(guard);
    assert_eq!(last_seen(&state).await, stale);

    // A write made outside the writer lock waits for an immediate writer to
    // commit rather than invalidating the writer's snapshot.
    let (guard, mut tx) = vectory_server::db::write_tx(&state).await.unwrap();
    sqlx::query("SELECT count(*) FROM users")
        .execute(&mut *tx)
        .await
        .unwrap();
    let pool = state.pool.clone();
    let outside = tokio::spawn(async move {
        sqlx::query("UPDATE session_details SET user_agent='Outside writer'")
            .execute(&pool)
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    sqlx::query("UPDATE users SET name=name")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    drop(guard);
    outside.await.unwrap().unwrap();

    // With the writer free, the next request records activity.
    assert_eq!(
        get(&app, "/api/v1/session", Some(&admin)).await.status,
        StatusCode::OK
    );
    assert_ne!(last_seen(&state).await, stale);
}

async fn sign_in_from(app: &Router, address: &str, password: &str) -> StatusCode {
    let peer: std::net::IpAddr = address.parse().unwrap();
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/v1/login")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"email":"admin@example.test","password":password}).to_string(),
        ))
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::new(
            peer, 443,
        )));
    app.clone().oneshot(request).await.unwrap().status()
}

#[tokio::test]
async fn parallel_wrong_passwords_get_exactly_the_failure_budget() {
    let (_temp, state, app, _admin) = fixture().await;
    let mut burst = tokio::task::JoinSet::new();
    for _ in 0..40 {
        let app = app.clone();
        burst.spawn(async move { sign_in_from(&app, "192.0.2.7", "not-the-password").await });
    }
    let mut denied = 0;
    let mut throttled = 0;
    while let Some(status) = burst.join_next().await {
        match status.unwrap() {
            StatusCode::UNAUTHORIZED => denied += 1,
            StatusCode::TOO_MANY_REQUESTS => throttled += 1,
            other => panic!("unexpected {other}"),
        }
    }
    assert_eq!((denied, throttled), (10, 30));
    // The same budget covers the client's whole IPv6 /64, but only that /64.
    for _ in 0..10 {
        let status = sign_in_from(&app, "2001:db8:5:6::1", "not-the-password").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        sign_in_from(&app, "2001:db8:5:6:ffff::2", PASSWORD).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        sign_in_from(&app, "2001:db8:5:7::1", PASSWORD).await,
        StatusCode::OK
    );
    // A successful sign-in refunds its reservation: signing in correctly
    // never spends the account budget. 20 failures so far.
    for _ in 0..3 {
        assert_eq!(
            sign_in_from(&app, "198.51.100.4", PASSWORD).await,
            StatusCode::OK
        );
    }
    let mut ledger = state.sign_in_failures();
    assert!(
        ledger
            .blocked("login-fail:admin@example.test", 20)
            .is_some()
    );
    assert!(
        ledger
            .blocked("login-fail:admin@example.test", 21)
            .is_none()
    );
}

#[tokio::test]
async fn failed_and_throttled_sign_ins_are_audited_with_account_and_client() {
    let (_temp, state, app, admin) = fixture().await;
    for _ in 0..10 {
        let reply = post(
            &app,
            "/api/v1/login",
            json!({"email":"admin@example.test","password":"not-the-password"}),
            None,
        )
        .await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    }
    let throttled = post(
        &app,
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
        None,
    )
    .await;
    assert_eq!(throttled.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(code(&throttled), "SIGNIN_THROTTLED");
    post(
        &app,
        "/api/v1/login",
        json!({"email":"nobody@example.test","password":"not-the-password"}),
        None,
    )
    .await;
    let rows = sqlx::query("SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')='login' AND json_extract(data,'$.outcome')<>'success'")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    let events: Vec<Value> = rows
        .iter()
        .map(|row| serde_json::from_str(row.get::<&str, _>(0)).unwrap())
        .collect();
    let denied: Vec<_> = events.iter().filter(|e| e["outcome"] == "denied").collect();
    assert_eq!(denied.len(), 11);
    assert!(
        denied
            .iter()
            .filter(|e| e["target"] == admin.id().as_str())
            .all(|e| e["details"]["reason"] == "wrong_password"
                && e["details"]["client_address"] == "unknown")
    );
    assert!(
        denied
            .iter()
            .any(|e| e["target"] == "" && e["details"]["reason"] == "unknown_account")
    );
    let throttled: Vec<_> = events
        .iter()
        .filter(|e| e["outcome"] == "throttled")
        .collect();
    assert_eq!(throttled.len(), 1);
    assert_eq!(throttled[0]["target"], admin.id().as_str());
    assert!(
        !events
            .iter()
            .any(|e| e.to_string().contains("not-the-password"))
    );
}

#[tokio::test]
async fn invitations_let_people_choose_their_own_password_once() {
    let (_temp, _state, app, admin) = fixture().await;
    let key = uuid::Uuid::new_v4().to_string();
    let created = post(
        &app,
        "/api/v1/users",
        json!({"request_id":key,"name":"Jane Doe","email":"jane@example.test","role":"editor","invite":true}),
        Some(&admin),
    )
    .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.body);
    let invite = created.body["invite"]["code"].as_str().unwrap().to_owned();
    assert_eq!(invite.len(), 64);
    let expires = chrono::DateTime::parse_from_rfc3339(
        created.body["invite"]["expires_at"].as_str().unwrap(),
    )
    .unwrap();
    let hours = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours();
    assert!((23..=24).contains(&hours), "{hours}");
    let listed = people(&app, &admin).await;
    let jane = listed
        .iter()
        .find(|p| p["email"] == "jane@example.test")
        .unwrap();
    assert_eq!(jane["status"], "invited");
    assert!(jane["invite_expires_at"].is_string());
    assert_eq!(jane["last_login_at"], Value::Null);
    assert_eq!(jane["mfa_enabled"], false);

    // Nothing signs in before the person chooses a password.
    let nothing = post(
        &app,
        "/api/v1/login",
        json!({"email":"jane@example.test","password":"any-guess-at-all"}),
        None,
    )
    .await;
    assert_eq!(nothing.status, StatusCode::UNAUTHORIZED);
    let preview = post(&app, "/api/v1/invite/preview", json!({"code":invite}), None).await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
    assert_eq!(preview.body["email"], "jane@example.test");
    assert_eq!(preview.body["name"], "Jane Doe");
    assert_eq!(preview.body["instance_name"], "Acme Production");
    let bogus = post(
        &app,
        "/api/v1/invite/preview",
        json!({"code":"0".repeat(64)}),
        None,
    )
    .await;
    assert_eq!(code(&bogus), "INVITE_INVALID");
    let weak = post(
        &app,
        "/api/v1/invite/accept",
        json!({"code":invite,"new_password":"janedoe12345"}),
        None,
    )
    .await;
    assert_eq!(code(&weak), "PASSWORD_TOO_WEAK", "{}", weak.body);
    let jane_session = session(
        post(
            &app,
            "/api/v1/invite/accept",
            json!({"code":invite.to_uppercase(),"new_password":NEXT}),
            None,
        )
        .await,
    );
    assert_eq!(jane_session.user["email"], "jane@example.test");
    assert_eq!(
        get(&app, "/api/v1/session", Some(&jane_session))
            .await
            .status,
        StatusCode::OK
    );
    let reused = post(
        &app,
        "/api/v1/invite/accept",
        json!({"code":invite,"new_password":"another-fine-password"}),
        None,
    )
    .await;
    assert_eq!(code(&reused), "INVITE_INVALID");
    sign_in(&app, "jane@example.test", NEXT, "Jane").await;
    let jane = people(&app, &admin)
        .await
        .into_iter()
        .find(|p| p["email"] == "jane@example.test")
        .unwrap();
    assert_eq!(jane["status"], "active");
    assert!(jane["last_login_at"].is_string());

    // An expired or lost invitation is replaced by the reset action.
    let key = uuid::Uuid::new_v4().to_string();
    let second = post(
        &app,
        "/api/v1/users",
        json!({"request_id":key,"name":"Sam","email":"sam@example.test","role":"viewer","invite":true}),
        Some(&admin),
    )
    .await;
    let first_code = second.body["invite"]["code"].as_str().unwrap().to_owned();
    let sam = second.body["user"].clone();
    let renewed = post(
        &app,
        &format!(
            "/api/v1/users/{}/password-reset",
            sam["id"].as_str().unwrap()
        ),
        json!({"current_password":PASSWORD,"revision":1}),
        Some(&admin),
    )
    .await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
    assert_eq!(renewed.body["purpose"], "invite");
    let old = post(
        &app,
        "/api/v1/invite/preview",
        json!({"code":first_code}),
        None,
    )
    .await;
    assert_eq!(code(&old), "INVITE_INVALID");
    let fresh_code = renewed.body["code"].as_str().unwrap();
    assert_eq!(
        post(
            &app,
            "/api/v1/invite/preview",
            json!({"code":fresh_code}),
            None
        )
        .await
        .status,
        StatusCode::OK
    );
    // Invitations are shaped strictly: never both a password and an invite.
    let both = post(
        &app,
        "/api/v1/users",
        json!({"request_id":uuid::Uuid::new_v4().to_string(),"name":"X","email":"x@example.test","role":"viewer","invite":true,"password":NEXT}),
        Some(&admin),
    )
    .await;
    assert_eq!(both.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn reset_codes_keep_their_window_and_return_the_email() {
    let (_temp, _state, app, admin) = fixture().await;
    let colleague = person(&app, &admin, "colleague@example.test", "viewer").await;
    let issued = post(
        &app,
        &format!("/api/v1/users/{}/password-reset", colleague.id()),
        json!({"current_password":PASSWORD,"revision":1}),
        Some(&admin),
    )
    .await;
    assert_eq!(issued.status, StatusCode::OK, "{}", issued.body);
    assert_eq!(issued.body["purpose"], "reset");
    let expires =
        chrono::DateTime::parse_from_rfc3339(issued.body["expires_at"].as_str().unwrap()).unwrap();
    let minutes = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_minutes();
    assert!((14..=15).contains(&minutes), "{minutes}");
    let reset_code = issued.body["code"].as_str().unwrap();
    let invalid = post(
        &app,
        "/api/v1/password-reset",
        json!({"code":"f".repeat(64),"new_password":NEXT}),
        None,
    )
    .await;
    assert_eq!(code(&invalid), "RESET_CODE_INVALID");
    let redeemed = post(
        &app,
        "/api/v1/password-reset",
        json!({"code":reset_code,"new_password":NEXT}),
        None,
    )
    .await;
    assert_eq!(redeemed.status, StatusCode::OK, "{}", redeemed.body);
    assert_eq!(
        redeemed.body,
        json!({"ok":true,"email":"colleague@example.test"})
    );
    assert_eq!(ended(&app, &colleague).await, "password_changed");
    sign_in(&app, "colleague@example.test", NEXT, "Back").await;
}

#[tokio::test]
async fn recovery_codes_are_counted_and_regenerated_with_a_current_factor() {
    let (_temp, _state, app, admin) = fixture().await;
    let generator = totp_setup(&app, &admin).await;
    let status = get(&app, "/api/v1/mfa", Some(&admin)).await;
    assert_eq!(
        status.body,
        json!({"enabled":false,"recovery_codes_remaining":null})
    );
    let confirmed = post(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":generator.generate_current().unwrap()}),
        Some(&admin),
    )
    .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    let first: Vec<String> =
        serde_json::from_value(confirmed.body["recovery_codes"].clone()).unwrap();
    assert_eq!(
        get(&app, "/api/v1/mfa", Some(&admin)).await.body["recovery_codes_remaining"],
        8
    );
    let wrong = post(
        &app,
        "/api/v1/mfa/recovery-codes",
        json!({"password":PASSWORD,"code":"000000"}),
        Some(&admin),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::FORBIDDEN);
    assert_eq!(code(&wrong), "INVALID_MFA_CODE");
    let missing = post(
        &app,
        "/api/v1/mfa/recovery-codes",
        json!({"password":PASSWORD}),
        Some(&admin),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);
    // A recovery code with pasted spacing authorizes a fresh set.
    let spaced = first[0].replace('-', " ");
    let renewed = post(
        &app,
        "/api/v1/mfa/recovery-codes",
        json!({"password":PASSWORD,"recovery_code":spaced}),
        Some(&admin),
    )
    .await;
    assert_eq!(renewed.status, StatusCode::OK, "{}", renewed.body);
    let second: Vec<String> =
        serde_json::from_value(renewed.body["recovery_codes"].clone()).unwrap();
    assert_eq!(second.len(), 8);
    assert!(second.iter().all(|c| !first.contains(c)));
    // Old codes stopped working; the session that regenerated stays signed in.
    let challenge = post(
        &app,
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
        None,
    )
    .await;
    let token = challenge.body["challenge_token"].as_str().unwrap();
    let old = post(
        &app,
        "/api/v1/login/mfa",
        json!({"challenge_token":token,"recovery_code":first[1]}),
        None,
    )
    .await;
    assert_eq!(code(&old), "INVALID_MFA_CODE");
    let fresh = post(
        &app,
        "/api/v1/login/mfa",
        json!({"challenge_token":token,"recovery_code":second[0]}),
        None,
    )
    .await;
    assert_eq!(fresh.status, StatusCode::OK, "{}", fresh.body);
    assert_eq!(
        get(&app, "/api/v1/mfa", Some(&admin)).await.body["recovery_codes_remaining"],
        7
    );
    // Connecting another authenticator needs a deliberate disable first.
    let status = post(
        &app,
        "/api/v1/mfa/setup",
        json!({"password":PASSWORD}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&status), "MFA_ALREADY_ENABLED");
}

#[tokio::test]
async fn expired_setup_and_wrong_setup_codes_are_distinct() {
    let (_temp, state, app, admin) = fixture().await;
    let generator = totp_setup(&app, &admin).await;
    let wrong = post(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":"000000"}),
        Some(&admin),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::FORBIDDEN);
    assert_eq!(code(&wrong), "INVALID_MFA_CODE");
    assert!(!wrong.body.to_string().contains("recovery"));
    sqlx::query("UPDATE user_mfa SET pending_expires_at='2000-01-01T00:00:00Z'")
        .execute(&state.pool)
        .await
        .unwrap();
    let expired = post(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":generator.generate_current().unwrap()}),
        Some(&admin),
    )
    .await;
    assert_eq!(expired.status, StatusCode::CONFLICT);
    assert_eq!(code(&expired), "MFA_SETUP_EXPIRED");
    let fresh = post(
        &app,
        "/api/v1/mfa/setup",
        json!({"password":PASSWORD}),
        Some(&admin),
    )
    .await;
    assert!(fresh.body["expires_at"].is_string(), "{}", fresh.body);
}

#[tokio::test]
async fn administrators_can_reset_someone_elses_two_factor() {
    let (_temp, state, app, admin) = fixture().await;
    let colleague = person(&app, &admin, "colleague@example.test", "operator").await;
    let generator = totp_setup(&app, &colleague).await;
    let confirmed = post(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":generator.generate_current().unwrap()}),
        Some(&colleague),
    )
    .await;
    assert_eq!(confirmed.status, StatusCode::OK, "{}", confirmed.body);
    let listed = people(&app, &admin).await;
    let target = listed
        .iter()
        .find(|p| p["id"] == colleague.id().as_str())
        .unwrap();
    assert_eq!(target["mfa_enabled"], true);
    let path = format!("/api/v1/users/{}/two-factor-reset", colleague.id());
    let revision = target["revision"].clone();
    let forbidden = post(
        &app,
        &path,
        json!({"current_password":PASSWORD,"revision":revision}),
        Some(&colleague),
    )
    .await;
    assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
    let wrong = post(
        &app,
        &path,
        json!({"current_password":"wrong-password","revision":revision}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&wrong), "WRONG_PASSWORD");
    let stale = post(
        &app,
        &path,
        json!({"current_password":PASSWORD,"revision":99}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&stale), "STALE_REVISION");
    let own = post(
        &app,
        &format!("/api/v1/users/{}/two-factor-reset", admin.id()),
        json!({"current_password":PASSWORD,"revision":1}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&own), "OWN_MFA");
    let done = post(
        &app,
        &path,
        json!({"current_password":PASSWORD,"revision":revision}),
        Some(&admin),
    )
    .await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    assert_eq!(done.body["user"]["id"], colleague.id().as_str());
    assert_eq!(ended(&app, &colleague).await, "mfa_reset");
    let again = post(
        &app,
        &path,
        json!({"current_password":PASSWORD,"revision":done.body["user"]["revision"]}),
        Some(&admin),
    )
    .await;
    assert_eq!(code(&again), "MFA_NOT_ENABLED");
    // Password alone signs in now; no challenge is issued.
    let back = sign_in(&app, "colleague@example.test", PASSWORD, "Recovered").await;
    assert_eq!(back.user["email"], "colleague@example.test");
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='user.mfa_reset'")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(audits, 1);
}

#[tokio::test]
async fn offline_break_glass_resets_a_password_and_disables_two_factor() {
    let (temp, state, app, admin) = fixture().await;
    let generator = totp_setup(&app, &admin).await;
    post(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":generator.generate_current().unwrap()}),
        Some(&admin),
    )
    .await;
    drop(app);
    state.pool.close().await;
    drop(state);
    let binary = env!("CARGO_BIN_EXE_vectory-admin");
    let data = temp.path().join("state");
    let run = |args: &[&str]| {
        std::process::Command::new(binary)
            .args(args)
            .env("RUST_BACKTRACE", "1")
            .env_remove("VECTORY_DATA_DIR")
            .output()
            .unwrap()
    };
    let help = run(&["--help"]);
    assert!(help.status.success());
    let text = String::from_utf8_lossy(&help.stdout);
    assert!(text.contains("reset-password --email EMAIL") && text.contains("disable-mfa"));
    let bare = run(&[]);
    assert_eq!(bare.status.code(), Some(2));
    let missing = run(&["--data-dir", data.to_str().unwrap(), "reset-password"]);
    assert_eq!(missing.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("needs --email"));
    let unknown = run(&[
        "--data-dir",
        data.to_str().unwrap(),
        "reset-password",
        "--email",
        "nobody@example.test",
    ]);
    assert_eq!(unknown.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&unknown.stderr);
    assert!(
        stderr.contains("No account uses nobody@example.test"),
        "{stderr}"
    );
    assert!(!stderr.contains("backtrace"));

    let reset = run(&[
        "--data-dir",
        data.to_str().unwrap(),
        "reset-password",
        "--email",
        "Admin@Example.test",
        "--url",
        "https://vectory.example.com/",
    ]);
    assert!(
        reset.status.success(),
        "{}",
        String::from_utf8_lossy(&reset.stderr)
    );
    let output = String::from_utf8_lossy(&reset.stdout).to_string();
    let link = output
        .lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("https://vectory.example.com/#/reset?code=")
        })
        .unwrap()
        .to_owned();
    assert_eq!(link.len(), 64);
    let disable = run(&[
        "--data-dir",
        data.to_str().unwrap(),
        "disable-mfa",
        "--email",
        "admin@example.test",
    ]);
    assert!(
        disable.status.success(),
        "{}",
        String::from_utf8_lossy(&disable.stderr)
    );
    let again = run(&[
        "--data-dir",
        data.to_str().unwrap(),
        "disable-mfa",
        "--email",
        "admin@example.test",
    ]);
    assert_eq!(again.status.code(), Some(1));

    // Start the server again: the host-issued code works without an issuer.
    let state = initialize(Settings {
        data_dir: data.clone(),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Acme Production".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let app = api::router(state.clone());
    assert_eq!(ended(&app, &admin).await, "mfa_reset");
    let redeemed = post(
        &app,
        "/api/v1/password-reset",
        json!({"code":link,"new_password":NEXT}),
        None,
    )
    .await;
    assert_eq!(redeemed.status, StatusCode::OK, "{}", redeemed.body);
    let signed_in = sign_in(&app, "admin@example.test", NEXT, "Recovered").await;
    assert_eq!(signed_in.user["role"], "admin");
    let actions: Vec<String> = sqlx::query_scalar("SELECT json_extract(r.data,'$.action') FROM audit_sequence s JOIN records r ON r.kind='audit' AND r.id=s.audit_id WHERE json_extract(r.data,'$.actor')='local-admin' ORDER BY s.sequence")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(actions, ["user.password_reset.issue", "user.mfa_reset"]);
}
