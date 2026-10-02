use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, initialize};

const PASSWORD: &str = "challenge-test-password";
struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    app: Router,
    session: Value,
    cookie: String,
    recovery: Value,
    secret: String,
}
async fn raw(
    app: &Router,
    path: &str,
    body: String,
    cookie: &str,
    csrf: &str,
    site: &str,
) -> (StatusCode, Value, HeaderMap) {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", cookie)
        .header("x-csrf-token", csrf)
        .header("sec-fetch-site", site)
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    assert_eq!(headers["cache-control"], "no-store");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), headers)
}
async fn post(app: &Router, path: &str, body: Value) -> (StatusCode, Value, HeaderMap) {
    raw(app, path, body.to_string(), "", "", "same-origin").await
}
async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "challenge-test-bootstrap-secret-123".into(),
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
    let (status,session,h) = post(&app,"/api/v1/bootstrap",json!({"name":"Admin","email":"admin@example.test","password":PASSWORD,"bootstrap_secret":state.settings.bootstrap_secret})).await;
    assert_eq!(status, StatusCode::OK, "{session}");
    let cookie = h["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (_, setup, _) = raw(
        &app,
        "/api/v1/mfa/setup",
        json!({"password":PASSWORD}).to_string(),
        &cookie,
        session["csrf_token"].as_str().unwrap(),
        "same-origin",
    )
    .await;
    let secret = setup["secret"].as_str().unwrap().to_owned();
    let code = generator(&secret).generate_current().unwrap();
    let (status, recovery, _) = raw(
        &app,
        "/api/v1/mfa/confirm",
        json!({"code":code}).to_string(),
        &cookie,
        session["csrf_token"].as_str().unwrap(),
        "same-origin",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recovery}");
    Fixture {
        _temp: temp,
        state,
        app,
        session,
        cookie,
        recovery,
        secret,
    }
}
fn generator(secret: &str) -> totp_rs::TOTP {
    totp_rs::TOTP::new(
        totp_rs::Algorithm::SHA1,
        6,
        1,
        30,
        totp_rs::Secret::Encoded(secret.into()).to_bytes().unwrap(),
        Some("Vectory".into()),
        "admin@example.test".into(),
    )
    .unwrap()
}
async fn challenge(f: &Fixture) -> String {
    let (status, body, h) = post(
        &f.app,
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mfa_required"], true);
    assert_eq!(body.as_object().unwrap().len(), 3);
    assert!(!h.contains_key("set-cookie"));
    let expiry =
        chrono::DateTime::parse_from_rfc3339(body["expires_at"].as_str().unwrap()).unwrap();
    assert!((295..=300).contains(&(expiry.timestamp() - chrono::Utc::now().timestamp())));
    body["challenge_token"].as_str().unwrap().to_owned()
}
async fn count(f: &Fixture, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}
fn recovery(f: &Fixture, token: &str, index: usize) -> Value {
    json!({"challenge_token":token,"recovery_code":f.recovery["recovery_codes"][index]})
}

#[tokio::test]
async fn unread_logout_preserves_other_sessions_and_rechecks_the_exact_session() {
    async fn read(app: &Router, cookie: &str) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/session")
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(!response.headers().contains_key("set-cookie"));
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
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
    let f = fixture().await;
    let token = challenge(&f).await;
    // No existing cookie is sent: this is an independent same-account session,
    // not replacement of the first browser session.
    let (status, other, headers) = post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0)).await;
    assert_eq!(status, StatusCode::OK);
    let other_cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_ne!(other_cookie, f.cookie);
    assert_eq!(other["user"]["id"], f.session["user"]["id"]);
    assert_ne!(other["csrf_token"], f.session["csrf_token"]);
    let _pending = challenge(&f).await;
    assert_eq!(count(&f, "sessions").await, 2);
    assert_eq!(count(&f, "login_challenges").await, 1);
    let before = snapshot(&f.state).await;
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/logout")
                .header("content-type", "application/json")
                .header("cookie", &f.cookie)
                .header("x-csrf-token", f.session["csrf_token"].as_str().unwrap())
                .header("sec-fetch-site", "same-origin")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    // Never poll the successful body. Cookie deletion is modeled below both as
    // delivered (no cookie) and lost (the old cookie), not as a browser/TCP run.
    drop(response);
    assert_eq!(count(&f, "sessions").await, 1);
    assert_eq!(count(&f, "login_challenges").await, 0);
    let committed = snapshot(&f.state).await;
    for unchanged in ["users", "mfa", "recovery"] {
        assert_eq!(committed[unchanged], before[unchanged]);
    }
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='logout' AND json_extract(data,'$.outcome')='success'")
        .fetch_one(&f.state.pool).await.unwrap();
    assert_eq!(audits, 1);
    assert_eq!(read(&f.app, &f.cookie).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(read(&f.app, "").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        read(&f.app, &other_cookie).await,
        (StatusCode::OK, other.clone())
    );
    for (cookie, csrf, expected) in [
        (
            &f.cookie,
            f.session["csrf_token"].as_str().unwrap(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            &other_cookie,
            f.session["csrf_token"].as_str().unwrap(),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let (status, _, headers) = raw(
            &f.app,
            "/api/v1/logout",
            "{}".into(),
            cookie,
            csrf,
            "same-origin",
        )
        .await;
        assert_eq!(status, expected);
        assert!(!headers.contains_key("set-cookie"));
        assert_eq!(snapshot(&f.state).await, committed);
    }

    // A failure after session/challenge deletion must roll them back together.
    let _pending = challenge(&f).await;
    let before_failure = snapshot(&f.state).await;
    sqlx::raw_sql("CREATE TRIGGER fail_logout_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='logout' BEGIN SELECT RAISE(ABORT,'injected logout audit failure'); END;")
        .execute(&f.state.pool).await.unwrap();
    let (status, _, headers) = raw(
        &f.app,
        "/api/v1/logout",
        "{}".into(),
        &other_cookie,
        other["csrf_token"].as_str().unwrap(),
        "same-origin",
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!headers.contains_key("set-cookie"));
    assert_eq!(snapshot(&f.state).await, before_failure);
    assert_eq!(
        read(&f.app, &other_cookie).await,
        (StatusCode::OK, other.clone())
    );
    sqlx::query("DROP TRIGGER fail_logout_audit")
        .execute(&f.state.pool)
        .await
        .unwrap();

    // Isolate the live recheck with fixture SQL under the held application
    // writer. The request has a queue opportunity; this is not a browser race.
    let guard = f.state.writer.lock().await;
    let app = f.app.clone();
    let queued_cookie = other_cookie.clone();
    let queued_csrf = other["csrf_token"].as_str().unwrap().to_owned();
    let queued = tokio::spawn(async move {
        raw(
            &app,
            "/api/v1/logout",
            "{}".into(),
            &queued_cookie,
            &queued_csrf,
            "same-origin",
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let replacement_token = db::hash("isolated replacement browser session");
    let replacement_csrf = db::hash("isolated replacement csrf");
    let replacement_cookie = format!("vectory_session={replacement_token}");
    let mut tx = f.state.pool.begin().await.unwrap();
    sqlx::query("DELETE FROM sessions WHERE verifier=?")
        .bind(db::hash(
            other_cookie.strip_prefix("vectory_session=").unwrap(),
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO sessions(verifier,user_id,csrf,expires_at) VALUES(?,?,?,'2099-01-01T00:00:00Z')")
        .bind(db::hash(&replacement_token)).bind(other["user"]["id"].as_str().unwrap())
        .bind(&replacement_csrf).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let after_rotation = snapshot(&f.state).await;
    drop(guard);
    let (status, _, headers) = queued.await.unwrap();
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(!headers.contains_key("set-cookie"));
    assert_eq!(snapshot(&f.state).await, after_rotation);
    let replacement = read(&f.app, &replacement_cookie).await;
    assert_eq!(replacement.0, StatusCode::OK);
    assert_eq!(replacement.1["user"], other["user"]);
    assert_eq!(replacement.1["csrf_token"], replacement_csrf);
    assert_eq!(snapshot(&f.state).await, after_rotation);
}

#[tokio::test]
async fn unread_auth_bodies_recover_only_through_current_cookie_without_replaying_mutation() {
    async fn read(app: &Router, path: &str, cookie: &str) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("cookie", cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(!response.headers().contains_key("set-cookie"));
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }
    async fn unread(app: &Router, path: &str, body: Value, old_cookie: &str) -> String {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("content-type", "application/json")
                    .header("sec-fetch-site", "same-origin")
                    .header("cookie", old_cookie)
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        // Deliberately never poll or collect the successful response body.
        // Cookie transfer is modeled explicitly; this is not a browser/TCP test.
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
                "challenges",
                "SELECT json_array(verifier,user_id,user_revision,password_fingerprint,mfa_fingerprint,expires_at,attempts) FROM login_challenges ORDER BY verifier",
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
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unread-auth-body-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Isolated unread authentication bodies".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let app = api::router(state.clone());
    assert_eq!(
        read(&app, "/api/v1/status", "").await.1["initialized"],
        false
    );
    let bootstrap = json!({"name":"Synthetic administrator","email":" ADMIN@example.test ","password":PASSWORD,"bootstrap_secret":state.settings.bootstrap_secret});
    let cookie = unread(&app, "/api/v1/bootstrap", bootstrap.clone(), "").await;
    let committed = snapshot(&state).await;
    let (status, session) = read(&app, "/api/v1/session", &cookie).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["user"]["email"], "admin@example.test");
    assert!(
        session["csrf_token"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
    );
    assert_eq!(
        read(&app, "/api/v1/session", "").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        read(&app, "/api/v1/status", "").await.1["initialized"],
        true
    );
    assert_eq!(snapshot(&state).await, committed);
    // A deliberate duplicate proves setup is monotonic; recovery reads above
    // did not repeat the mutation or need its unread JSON/CSRF field.
    assert_eq!(
        post(&app, "/api/v1/bootstrap", bootstrap).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(snapshot(&state).await, committed);
    assert_eq!(committed["users"].as_array().unwrap().len(), 1);
    assert_eq!(committed["sessions"].as_array().unwrap().len(), 1);

    let login_cookie = unread(
        &app,
        "/api/v1/login",
        json!({"email":"ADMIN@example.test","password":PASSWORD}),
        &cookie,
    )
    .await;
    assert_ne!(login_cookie, cookie);
    let committed_login = snapshot(&state).await;
    assert_eq!(
        read(&app, "/api/v1/session", &cookie).await.0,
        StatusCode::UNAUTHORIZED
    );
    let login = read(&app, "/api/v1/session", &login_cookie).await;
    assert_eq!(login.0, StatusCode::OK);
    assert_eq!(login.1["user"]["id"], session["user"]["id"]);
    assert_eq!(snapshot(&state).await, committed_login);

    let f = fixture().await;
    let token = challenge(&f).await;
    let factor = recovery(&f, &token, 0);
    let mfa_cookie = unread(&f.app, "/api/v1/login/mfa", factor.clone(), &f.cookie).await;
    assert_eq!(count(&f, "login_challenges").await, 0);
    assert_eq!(count(&f, "mfa_recovery_codes").await, 7);
    assert_eq!(count(&f, "sessions").await, 1);
    let committed_mfa = snapshot(&f.state).await;
    assert_eq!(
        read(&f.app, "/api/v1/session", &f.cookie).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        read(&f.app, "/api/v1/session", "").await.0,
        StatusCode::UNAUTHORIZED
    );
    let recovered = read(&f.app, "/api/v1/session", &mfa_cookie).await;
    assert_eq!(recovered.0, StatusCode::OK);
    assert_eq!(recovered.1["user"]["id"], f.session["user"]["id"]);
    assert_eq!(
        read(&f.app, "/api/v1/status", "").await.1["initialized"],
        true
    );
    assert_eq!(snapshot(&f.state).await, committed_mfa);
    let (status, error, headers) = post(&f.app, "/api/v1/login/mfa", factor).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(error["error"]["code"], "MFA_CHALLENGE_EXPIRED");
    assert!(!headers.contains_key("set-cookie"));
    assert_eq!(snapshot(&f.state).await, committed_mfa);
}

#[tokio::test]
async fn credentials_first_hash_only_challenge_and_cookie_rotation_only_after_mfa() {
    let f = fixture().await;
    let mut denied = None;
    for email in ["admin@example.test", "missing@example.test"] {
        let (status, body, h) = post(
            &f.app,
            "/api/v1/login",
            json!({"email":email,"password":"incorrect-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!h.contains_key("set-cookie"));
        if let Some(expected) = &denied {
            assert_eq!(expected, &body);
        }
        denied = Some(body);
    }
    let before = count(&f, "sessions").await;
    let token = challenge(&f).await;
    assert_eq!(token.len(), 64);
    assert_eq!(count(&f, "sessions").await, before);
    let row = sqlx::query("SELECT * FROM login_challenges")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("verifier"), db::hash(&token));
    assert_ne!(row.get::<String, _>("password_fingerprint"), PASSWORD);
    assert_ne!(row.get::<String, _>("mfa_fingerprint"), f.secret);
    let fake = Request::builder()
        .uri("/api/v1/session")
        .header("cookie", format!("vectory_session={token}"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        f.app.clone().oneshot(fake).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    // A challenge with a valid current browser cookie must not rotate it early.
    let (_, body, h) = raw(
        &f.app,
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}).to_string(),
        &f.cookie,
        "",
        "same-origin",
    )
    .await;
    assert!(!h.contains_key("set-cookie"));
    assert_eq!(count(&f, "sessions").await, before);
    let token2 = body["challenge_token"].as_str().unwrap();
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
            .await
            .1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    let (status, session, h) = raw(
        &f.app,
        "/api/v1/login/mfa",
        recovery(&f, token2, 0).to_string(),
        &f.cookie,
        "",
        "same-origin",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert!(session["csrf_token"].is_string());
    assert!(h.contains_key("set-cookie"));
    assert!(!h["set-cookie"].to_str().unwrap().starts_with(&f.cookie));
    assert_eq!(count(&f, "sessions").await, before);
    assert_eq!(count(&f, "login_challenges").await, 0);
    assert_eq!(count(&f, "mfa_recovery_codes").await, 7);
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, token2, 1))
            .await
            .1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    let audits: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='audit'")
        .fetch_all(&f.state.pool)
        .await
        .unwrap();
    assert!(audits.iter().all(|a| !a.contains(token2)
        && !a.contains(&token)
        && !a.contains(PASSWORD)
        && !a.contains(&f.secret)));
}

#[tokio::test]
async fn strict_factor_shape_cross_site_expiry_and_durable_attempt_budget() {
    let f = fixture().await;
    let token = challenge(&f).await;
    for body in [
        json!({"challenge_token":token}),
        json!({"challenge_token":token,"totp_code":"123456","recovery_code":"x"}),
        json!({"challenge_token":token,"totp_code":"123456","extra":"private"}),
        json!({"challenge_token":token,"totp_code":null,"recovery_code":"value"}),
    ] {
        assert_eq!(
            post(&f.app, "/api/v1/login/mfa", body).await.0,
            StatusCode::BAD_REQUEST
        );
    }
    let duplicate = format!(
        r#"{{"challenge_token":"{token}","challenge_token":"{token}","totp_code":"123456"}}"#
    );
    assert_eq!(
        raw(
            &f.app,
            "/api/v1/login/mfa",
            duplicate,
            "",
            "",
            "same-origin"
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        raw(
            &f.app,
            "/api/v1/login/mfa",
            recovery(&f, &token, 0).to_string(),
            "",
            "",
            "cross-site"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let attempts: i64 = sqlx::query_scalar("SELECT attempts FROM login_challenges")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(attempts, 0);
    for attempt in 1..=5 {
        let (status, error, h) = post(
            &f.app,
            "/api/v1/login/mfa",
            json!({"challenge_token":token,"totp_code":"invalid"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!h.contains_key("set-cookie"));
        assert_eq!(
            error["error"]["code"],
            if attempt == 5 {
                "MFA_TOO_MANY_ATTEMPTS"
            } else {
                "INVALID_MFA_CODE"
            }
        );
    }
    assert_eq!(count(&f, "login_challenges").await, 0);
    assert_eq!(count(&f, "mfa_recovery_codes").await, 8);
    let token = challenge(&f).await;
    sqlx::query("UPDATE login_challenges SET expires_at='2000-01-01T00:00:00Z'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
            .await
            .1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    assert_eq!(count(&f, "login_challenges").await, 0);
}

#[tokio::test]
async fn concurrent_completion_and_late_audit_failure_keep_recovery_atomic() {
    let f = fixture().await;
    let token = challenge(&f).await;
    let body = recovery(&f, &token, 0);
    let (a, b) = tokio::join!(
        post(&f.app, "/api/v1/login/mfa", body.clone()),
        post(&f.app, "/api/v1/login/mfa", body)
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(count(&f, "mfa_recovery_codes").await, 7);
    let token = challenge(&f).await;
    let before = count(&f, "sessions").await;
    sqlx::raw_sql("CREATE TRIGGER fail_login_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='login' AND json_extract(NEW.data,'$.outcome')='success' BEGIN SELECT RAISE(ABORT,'injected login audit failure'); END;").execute(&f.state.pool).await.unwrap();
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 1))
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(count(&f, "sessions").await, before);
    assert_eq!(count(&f, "mfa_recovery_codes").await, 7);
    assert_eq!(count(&f, "login_challenges").await, 1);
    sqlx::query("DROP TRIGGER fail_login_audit")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 1))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(count(&f, "mfa_recovery_codes").await, 6);
}

#[tokio::test]
async fn account_and_mfa_changes_invalidate_and_queued_completion_rechecks() {
    let f = fixture().await;
    for change in [
        "UPDATE users SET name='Renamed'",
        "UPDATE users SET revision=revision+1",
        "UPDATE user_mfa SET secret_ciphertext=secret_ciphertext",
        "UPDATE users SET enabled=0",
        "UPDATE users SET enabled=1",
    ] {
        if change.ends_with("enabled=1") {
            sqlx::query(change).execute(&f.state.pool).await.unwrap();
            continue;
        }
        let token = challenge(&f).await;
        sqlx::query(change).execute(&f.state.pool).await.unwrap();
        assert_eq!(
            post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
                .await
                .1["error"]["code"],
            "MFA_CHALLENGE_EXPIRED"
        );
    }
    // Even if an out-of-band writer does not run invalidation triggers, compare
    // the live snapshots under the writer before consuming a valid factor.
    let token = challenge(&f).await;
    sqlx::query("DROP TRIGGER login_challenges_user_change")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let guard = f.state.writer.lock().await;
    let app = f.app.clone();
    let body = recovery(&f, &token, 0);
    let task = tokio::spawn(async move { post(&app, "/api/v1/login/mfa", body).await });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    sqlx::query("UPDATE users SET password_hash='replaced-hash'")
        .execute(&f.state.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(
        task.await.unwrap().1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    assert_eq!(count(&f, "mfa_recovery_codes").await, 8);
}

#[tokio::test]
async fn revoke_logout_and_restart_invalidate_pending_authentication() {
    let f = fixture().await;
    let token = challenge(&f).await;
    assert_eq!(
        raw(
            &f.app,
            "/api/v1/account/revoke-sessions",
            json!({"current_password":PASSWORD}).to_string(),
            &f.cookie,
            f.session["csrf_token"].as_str().unwrap(),
            "same-origin"
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
            .await
            .1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    let token = challenge(&f).await;
    assert_eq!(
        raw(
            &f.app,
            "/api/v1/logout",
            "{}".into(),
            &f.cookie,
            f.session["csrf_token"].as_str().unwrap(),
            "same-origin"
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
            .await
            .1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
    let token = challenge(&f).await;
    let settings = f.state.settings.clone();
    let body = recovery(&f, &token, 0);
    f.state.pool.close().await;
    drop(f.app);
    drop(f.state);
    let state = initialize(settings).await.unwrap();
    let app = api::router(state.clone());
    assert_eq!(
        post(&app, "/api/v1/login/mfa", body).await.1["error"]["code"],
        "MFA_CHALLENGE_EXPIRED"
    );
}

#[tokio::test]
async fn totp_replay_prevention_and_combined_login_compatibility() {
    let f = fixture().await;
    sqlx::query("UPDATE user_mfa SET last_used_step=-1")
        .execute(&f.state.pool)
        .await
        .unwrap();
    let code = generator(&f.secret).generate_current().unwrap();
    let token = challenge(&f).await;
    assert_eq!(
        post(
            &f.app,
            "/api/v1/login/mfa",
            json!({"challenge_token":token,"totp_code":code})
        )
        .await
        .0,
        StatusCode::OK
    );
    let token = challenge(&f).await;
    assert_eq!(
        post(
            &f.app,
            "/api/v1/login/mfa",
            json!({"challenge_token":token,"totp_code":code})
        )
        .await
        .1["error"]["code"],
        "INVALID_MFA_CODE"
    );
    assert_eq!(post(&f.app,"/api/v1/login",json!({"email":"admin@example.test","password":PASSWORD,"recovery_code":f.recovery["recovery_codes"][0]})).await.0,StatusCode::OK);
    assert_eq!(count(&f, "login_challenges").await, 0);
    assert_eq!(post(&f.app,"/api/v1/login",json!({"email":"admin@example.test","password":PASSWORD,"recovery_code":f.recovery["recovery_codes"][0]})).await.0,StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn recovery_audit_failure_rolls_back_both_completion_paths() {
    let f = fixture().await;
    let token = challenge(&f).await;
    let before = count(&f, "sessions").await;
    sqlx::raw_sql("CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='mfa.recovery_code' BEGIN SELECT RAISE(ABORT,'injected recovery audit failure'); END;").execute(&f.state.pool).await.unwrap();
    for (path, body) in [
        ("/api/v1/login/mfa", recovery(&f, &token, 0)),
        (
            "/api/v1/login",
            json!({"email":"admin@example.test","password":PASSWORD,"recovery_code":f.recovery["recovery_codes"][0]}),
        ),
    ] {
        let (status, _, h) = post(&f.app, path, body).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!h.contains_key("set-cookie"));
        assert_eq!(count(&f, "sessions").await, before);
        assert_eq!(count(&f, "mfa_recovery_codes").await, 8);
        assert_eq!(count(&f, "login_challenges").await, 1);
    }
    sqlx::query("DROP TRIGGER fail_recovery_audit")
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn concurrent_failures_cannot_exceed_challenge_budget_or_bypass_user_rate() {
    let f = fixture().await;
    let token = challenge(&f).await;
    let mut requests = Vec::new();
    for _ in 0..7 {
        let app = f.app.clone();
        let body = json!({"challenge_token":token,"totp_code":"invalid"});
        requests.push(tokio::spawn(async move {
            post(&app, "/api/v1/login/mfa", body).await
        }));
    }
    let (mut retryable, mut exhausted) = (0, 0);
    for task in requests {
        let (status, error, h) = task.await.unwrap();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!h.contains_key("set-cookie"));
        match error["error"]["code"].as_str() {
            Some("INVALID_MFA_CODE") => retryable += 1,
            // The fifth wrong code exhausts the challenge; later racers find it gone.
            Some("MFA_TOO_MANY_ATTEMPTS") => exhausted += 1,
            code => assert_eq!(code, Some("MFA_CHALLENGE_EXPIRED")),
        }
    }
    assert_eq!((retryable, exhausted), (4, 1));
    assert_eq!(count(&f, "login_challenges").await, 0);
    let token = challenge(&f).await;
    for _ in 0..5 {
        assert_eq!(
            post(
                &f.app,
                "/api/v1/login/mfa",
                json!({"challenge_token":token,"totp_code":"invalid"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    let token = challenge(&f).await;
    let (status, _, h) = post(&f.app, "/api/v1/login/mfa", recovery(&f, &token, 0)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(!h.contains_key("set-cookie"));
    assert_eq!(count(&f, "mfa_recovery_codes").await, 8);
}

/// A request as the address `address` makes it.
async fn from(
    app: &Router,
    address: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value, HeaderMap) {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("sec-fetch-site", "same-origin")
        .body(Body::from(body.to_string()))
        .unwrap();
    request
        .extensions_mut()
        .insert(axum::extract::ConnectInfo(std::net::SocketAddr::new(
            address.parse().unwrap(),
            443,
        )));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap(), headers)
}
fn code_of(body: &Value) -> &str {
    body["error"]["code"].as_str().unwrap_or("")
}
/// How much of a budget has been spent: the number of calls it admitted.
fn spent(ledger: &std::sync::Mutex<vectory_server::ledger::Ledger>, key: &str) -> usize {
    let mut ledger = ledger.lock().unwrap();
    (1..=5000)
        .take_while(|count| ledger.blocked(key, *count).is_some())
        .count()
}
fn combined(code: &str) -> Value {
    json!({"email":"admin@example.test","password":PASSWORD,"totp_code":code})
}

#[tokio::test]
async fn a_combined_sign_in_counts_wrong_codes_against_the_account() {
    let f = fixture().await;
    // The account's authenticator is in step with the server's clock.
    sqlx::query("UPDATE user_mfa SET last_used_step=-1")
        .execute(&f.state.pool)
        .await
        .unwrap();
    // The password is right and the code is guessed, from two addresses.
    let mut outcomes = Vec::new();
    for address in ["192.0.2.1", "198.51.100.2"].iter().cycle().take(6) {
        let (status, body, headers) =
            from(&f.app, address, "/api/v1/login", combined("000000")).await;
        assert!(!headers.contains_key("set-cookie"));
        outcomes.push((
            status,
            code_of(&body).to_owned(),
            headers.contains_key("retry-after"),
        ));
    }
    // Four wrong codes are plain refusals. The fifth spends the account's
    // budget, and from then on the account's second factor is locked, for
    // every address.
    for outcome in &outcomes[..4] {
        assert_eq!(
            outcome,
            &(
                StatusCode::UNAUTHORIZED,
                "UNAUTHENTICATED".to_owned(),
                false
            )
        );
    }
    for outcome in &outcomes[4..] {
        assert_eq!(
            outcome,
            &(
                StatusCode::TOO_MANY_REQUESTS,
                "SIGNIN_THROTTLED".to_owned(),
                true
            )
        );
    }
    // A correct code inside the lock is refused too, from either address.
    let right = generator(&f.secret).generate_current().unwrap();
    for address in ["192.0.2.1", "198.51.100.2", "203.0.113.50"] {
        let (status, body, headers) =
            from(&f.app, address, "/api/v1/login", combined(&right)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(code_of(&body), "SIGNIN_THROTTLED");
        assert!(headers.contains_key("retry-after") && !headers.contains_key("set-cookie"));
    }
    assert_eq!(
        count(&f, "sessions").await,
        1,
        "only the setup session exists"
    );
    // Every wrong code is on the record, and none of them is a code.
    let denied: Vec<String> = sqlx::query_scalar(
        "SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')='login.mfa'",
    )
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(denied.len(), 5);
    assert!(
        denied
            .iter()
            .all(|row| !row.contains("000000") && !row.contains(&right))
    );
}

#[tokio::test]
async fn a_combined_sign_in_with_the_right_code_still_works_after_a_few_wrong_ones() {
    let f = fixture().await;
    sqlx::query("UPDATE user_mfa SET last_used_step=-1")
        .execute(&f.state.pool)
        .await
        .unwrap();
    for _ in 0..4 {
        let (status, body, _) =
            from(&f.app, "192.0.2.1", "/api/v1/login", combined("000000")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    let right = generator(&f.secret).generate_current().unwrap();
    let (status, body, headers) =
        from(&f.app, "198.51.100.2", "/api/v1/login", combined(&right)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(headers.contains_key("set-cookie"));
}

#[tokio::test]
async fn a_password_alone_neither_returns_its_failure_nor_marks_the_client_known() {
    let f = fixture().await;
    let address = "192.0.2.77";
    let known = format!("login-known:admin@example.test:{address}");
    let failures = format!("login-fail:admin@example.test:{address}");
    let (status, challenge, _) = from(
        &f.app,
        address,
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    assert_eq!(challenge["mfa_required"], true);
    {
        // Whoever holds only the password is not a client of this account yet,
        // and the attempt still counts against it.
        let mut ledger = f.state.sign_in_failures();
        assert!(
            !ledger.seen(&known),
            "a password alone marked the client as known"
        );
        assert!(
            ledger.seen(&failures),
            "the attempt was refunded before the factor"
        );
    }
    // The factor completes the sign-in: now the client is known and the attempt
    // is returned.
    let token = challenge["challenge_token"].as_str().unwrap();
    let (status, body, _) =
        from(&f.app, address, "/api/v1/login/mfa", recovery(&f, token, 0)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mut ledger = f.state.sign_in_failures();
    assert!(ledger.seen(&known));
    assert!(!ledger.seen(&failures));
}

#[tokio::test]
async fn one_address_cannot_block_second_factor_completion_for_everyone_else() {
    let f = fixture().await;
    let (status, challenge, _) = from(
        &f.app,
        "198.51.100.20",
        "/api/v1/login",
        json!({"email":"admin@example.test","password":PASSWORD}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{challenge}");
    let token = challenge["challenge_token"].as_str().unwrap().to_owned();
    let (mut expired, mut rate_limited) = (0, 0);
    for _ in 0..700 {
        let (status, body, _) = from(
            &f.app,
            "192.0.2.10",
            "/api/v1/login/mfa",
            json!({"challenge_token":"0".repeat(64),"totp_code":"123456"}),
        )
        .await;
        match (status, code_of(&body)) {
            (StatusCode::UNAUTHORIZED, "MFA_CHALLENGE_EXPIRED") => expired += 1,
            (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED") => rate_limited += 1,
            (status, code) => panic!("unexpected {status} {code}"),
        }
    }
    assert_eq!((expired, rate_limited), (60, 640));
    let (status, body, _) = from(
        &f.app,
        "198.51.100.20",
        "/api/v1/login/mfa",
        recovery(&f, &token, 0),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(spent(&f.state.limits, "login-mfa-global"), 61);
}

#[tokio::test]
async fn a_known_client_completes_the_second_factor_while_others_flood_it() {
    let f = fixture().await;
    let known = "198.51.100.30";
    let password_step = |address: &'static str| {
        let f = &f;
        async move {
            let (status, challenge, _) = from(
                &f.app,
                address,
                "/api/v1/login",
                json!({"email":"admin@example.test","password":PASSWORD}),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{challenge}");
            challenge["challenge_token"].as_str().unwrap().to_owned()
        }
    };
    // The operator has signed in from here before.
    let earlier = password_step("198.51.100.30").await;
    assert_eq!(
        from(
            &f.app,
            known,
            "/api/v1/login/mfa",
            recovery(&f, &earlier, 0)
        )
        .await
        .0,
        StatusCode::OK
    );

    // Ten addresses flood the second step with made-up challenges.
    let (mut expired, mut rate_limited) = (0, 0);
    for address in 0..10 {
        for _ in 0..60 {
            let (status, body, _) = from(
                &f.app,
                &format!("10.9.0.{address}"),
                "/api/v1/login/mfa",
                json!({"challenge_token":"0".repeat(64),"totp_code":"123456"}),
            )
            .await;
            match (status, code_of(&body)) {
                (StatusCode::UNAUTHORIZED, "MFA_CHALLENGE_EXPIRED") => expired += 1,
                (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED") => rate_limited += 1,
                (status, code) => panic!("unexpected {status} {code}"),
            }
        }
    }
    // The ordinary share is 500 a minute; the operator's earlier completion
    // used one of them.
    assert_eq!((expired, rate_limited), (499, 101));
    // Someone who has never signed in is refused, whatever they hold.
    let (status, body, _) = from(
        &f.app,
        "203.0.113.30",
        "/api/v1/login/mfa",
        json!({"challenge_token":"1".repeat(64),"recovery_code":"abcd-abcd"}),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(code_of(&body), "RATE_LIMITED");
    // The operator signs in again from their usual address.
    let token = password_step("198.51.100.30").await;
    let (status, body, _) = from(&f.app, known, "/api/v1/login/mfa", recovery(&f, &token, 2)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
