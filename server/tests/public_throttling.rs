//! One address can't use up the budget every address shares: sign-in, password
//! reset, invitations, enrollment and the installer charge the client's own
//! budget first and the shared one only for what the client's let through.
use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{HeaderMap, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::net::SocketAddr;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, device, initialize, ledger::Ledger};

const SECRET: &str = "isolated-throttling-bootstrap-secret-123";
const PASSWORD: &str = "throttling-test-password";
const EMAIL: &str = "admin@example.test";

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}
impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    dashboard: Router,
    agent: Router,
    cookie: String,
    csrf: String,
}

async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Throttling".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let dashboard = api::router(state.clone());
    let agent = device::router(state.clone());
    let mut f = Fixture {
        _temp: temp,
        state,
        dashboard,
        agent,
        cookie: String::new(),
        csrf: String::new(),
    };
    let reply = f
        .call(
            "10.0.0.1",
            "POST",
            "/api/v1/bootstrap",
            json!({"name":"Admin","email":EMAIL,"password":PASSWORD,"bootstrap_secret":SECRET}),
            false,
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);
    f.cookie = reply.headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    f.csrf = reply.body["csrf_token"].as_str().unwrap().to_owned();
    f
}

impl Fixture {
    /// A request as the address `from` makes it. Dashboard paths go to the
    /// dashboard router, `/agent/...` paths to the agent listener's.
    async fn call(
        &self,
        from: &str,
        method: &str,
        path: &str,
        body: Value,
        as_admin: bool,
    ) -> Reply {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json")
            .header(header::HOST, "vectory.example.test:8443");
        if as_admin {
            request = request
                .header("cookie", &self.cookie)
                .header("x-csrf-token", &self.csrf);
        }
        let mut request = request
            .body(if method == "GET" {
                Body::empty()
            } else {
                Body::from(body.to_string())
            })
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(from.parse().unwrap(), 40000)));
        let router = if path.starts_with("/agent/") {
            &self.agent
        } else {
            &self.dashboard
        };
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        Reply {
            status,
            headers,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }
    async fn sign_in(&self, from: &str, password: &str) -> Reply {
        self.call(
            from,
            "POST",
            "/api/v1/login",
            json!({"email":EMAIL,"password":password}),
            false,
        )
        .await
    }
}

/// How much of a budget has been spent: the number of calls it admitted.
fn spent(ledger: &std::sync::Mutex<Ledger>, key: &str) -> usize {
    let mut ledger = ledger.lock().unwrap();
    (1..=5000)
        .take_while(|count| ledger.blocked(key, *count).is_some())
        .count()
}

#[tokio::test]
async fn one_address_cannot_lock_every_other_address_out_of_sign_in() {
    let f = fixture().await;
    let (mut denied, mut account_throttled, mut rate_limited) = (0, 0, 0);
    for _ in 0..700 {
        let reply = f.sign_in("192.0.2.10", "not-the-password").await;
        match (reply.status, reply.code()) {
            (StatusCode::UNAUTHORIZED, _) => denied += 1,
            (StatusCode::TOO_MANY_REQUESTS, "SIGNIN_THROTTLED") => account_throttled += 1,
            (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED") => {
                assert!(reply.headers.contains_key("retry-after"));
                rate_limited += 1
            }
            (status, code) => panic!("unexpected {status} {code}"),
        }
    }
    // Ten wrong passwords spend the account's budget for this address; the
    // rest of its first 60 are turned away for the account; its own budget
    // refuses everything after that.
    assert_eq!((denied, account_throttled, rate_limited), (10, 50, 640));

    // Anyone else still signs in.
    let reply = f.sign_in("192.0.2.20", PASSWORD).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.body);

    // Only what the address's own budget let through reached the shared one:
    // its 60 requests and the other address's one.
    assert_eq!(spent(&f.state.limits, "login-global"), 61);
}

#[tokio::test]
async fn a_known_client_keeps_a_share_of_the_sign_in_budget_when_others_flood_it() {
    let f = fixture().await;
    // The operator signed in before, from their usual address.
    let known = "198.51.100.5";
    assert_eq!(f.sign_in(known, PASSWORD).await.status, StatusCode::OK);

    // A flood from ten addresses, each already turned away for the account so
    // that no request pays for a password hash. Every request still counts
    // against the shared budget, which is what the flood is after.
    let (mut turned_away, mut rate_limited) = (0, 0);
    for address in 0..10 {
        let from = format!("10.9.0.{address}");
        {
            let mut ledger = f.state.sign_in_failures();
            for _ in 0..10 {
                ledger.add(
                    &format!("login-fail:{EMAIL}:{from}"),
                    std::time::Duration::from_secs(900),
                );
            }
        }
        for _ in 0..60 {
            let reply = f.sign_in(&from, "not-the-password").await;
            match (reply.status, reply.code()) {
                (StatusCode::TOO_MANY_REQUESTS, "SIGNIN_THROTTLED") => turned_away += 1,
                (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED") => rate_limited += 1,
                (status, code) => panic!("unexpected {status} {code}"),
            }
        }
    }
    // The ordinary share is 500 a minute and the operator's earlier sign-in
    // used one of them.
    assert_eq!((turned_away, rate_limited), (499, 101));

    // Someone who never signed in is refused; the operator is not.
    let stranger = f.sign_in("203.0.113.9", PASSWORD).await;
    assert_eq!(stranger.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(stranger.code(), "RATE_LIMITED");
    assert_eq!(f.sign_in(known, PASSWORD).await.status, StatusCode::OK);
}

fn csr() -> String {
    let key = rcgen::KeyPair::generate().unwrap();
    rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap()
}

#[tokio::test]
async fn one_address_cannot_block_enrollment_for_everyone_else() {
    let f = fixture().await;
    let created = f
        .call(
            "10.0.0.1",
            "POST",
            "/api/v1/tokens",
            json!({"name":"Fleet","expires_hours":1,"max_uses":5}),
            true,
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.body);
    let token = created.body["token"].as_str().unwrap().to_owned();
    let junk = json!({"protocol_version":1,"token":"0".repeat(64)});
    let (mut refused, mut rate_limited) = (0, 0);
    for _ in 0..700 {
        let reply = f
            .call(
                "192.0.2.10",
                "POST",
                "/agent/v1/enroll",
                junk.clone(),
                false,
            )
            .await;
        match reply.status {
            StatusCode::UNAUTHORIZED => refused += 1,
            StatusCode::TOO_MANY_REQUESTS => rate_limited += 1,
            status => panic!("unexpected {status}"),
        }
    }
    assert_eq!((refused, rate_limited), (60, 640));
    let enrolled = f
        .call(
            "192.0.2.20",
            "POST",
            "/agent/v1/enroll",
            json!({"protocol_version":1,"request_id":"request-1","token":token,"name":"edge-01","csr_pem":csr(),"os":"linux","arch":"amd64","agent_version":"0.1.0","vector_version":"0.58.0"}),
            false,
        )
        .await;
    assert_eq!(enrolled.status, StatusCode::OK, "{}", enrolled.body);
    assert_eq!(spent(&f.state.public_limits, "enrollment"), 61);
}

#[tokio::test]
async fn one_address_cannot_block_the_installer_or_downloads_for_everyone_else() {
    let f = fixture().await;
    let (mut served, mut rate_limited) = (0, 0);
    for _ in 0..1250 {
        let reply = f
            .call(
                "192.0.2.10",
                "GET",
                "/agent/v1/install.sh",
                Value::Null,
                false,
            )
            .await;
        match reply.status {
            StatusCode::OK => served += 1,
            StatusCode::TOO_MANY_REQUESTS => rate_limited += 1,
            status => panic!("unexpected {status}"),
        }
    }
    assert_eq!((served, rate_limited), (300, 950));
    let other = f
        .call(
            "192.0.2.20",
            "GET",
            "/agent/v1/install.sh",
            Value::Null,
            false,
        )
        .await;
    assert_eq!(other.status, StatusCode::OK);
    assert_eq!(spent(&f.state.public_limits, "agent-installer"), 301);

    // Downloads have their own budgets, kept the same way. This server has no
    // agent builds, so the answer is "none for this platform", never a refusal.
    for _ in 0..1250 {
        f.call(
            "192.0.2.10",
            "GET",
            "/agent/v1/downloads/linux/amd64",
            Value::Null,
            false,
        )
        .await;
    }
    let other = f
        .call(
            "192.0.2.20",
            "GET",
            "/agent/v1/downloads/linux/amd64",
            Value::Null,
            false,
        )
        .await;
    assert_ne!(other.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(spent(&f.state.public_limits, "agent-download"), 121);
}

#[tokio::test]
async fn one_address_cannot_block_password_reset_and_invitations_for_everyone_else() {
    let f = fixture().await;
    // A colleague who forgot their password, and a person invited a day ago.
    let created = f
        .call(
            "10.0.0.1",
            "POST",
            "/api/v1/users",
            json!({"name":"Sam","email":"sam@example.test","role":"viewer","password":PASSWORD}),
            true,
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.body);
    let reset = f
        .call(
            "10.0.0.1",
            "POST",
            &format!(
                "/api/v1/users/{}/password-reset",
                created.body["id"].as_str().unwrap()
            ),
            json!({"current_password":PASSWORD,"revision":1}),
            true,
        )
        .await;
    assert_eq!(reset.status, StatusCode::OK, "{}", reset.body);
    let reset_code = reset.body["code"].as_str().unwrap().to_owned();
    let invited = f
        .call(
            "10.0.0.1",
            "POST",
            "/api/v1/users",
            json!({"request_id":uuid::Uuid::new_v4().to_string(),"name":"Jane","email":"jane@example.test","role":"viewer","invite":true}),
            true,
        )
        .await;
    assert_eq!(invited.status, StatusCode::OK, "{}", invited.body);
    let invite_code = invited.body["invite"]["code"].as_str().unwrap().to_owned();

    let (mut refused, mut rate_limited) = (0, 0);
    for n in 0..350u32 {
        let reply = f
            .call(
                "192.0.2.10",
                "POST",
                "/api/v1/password-reset",
                json!({"code":format!("{n:064x}"),"new_password":"another-long-password"}),
                false,
            )
            .await;
        match (reply.status, reply.code()) {
            (StatusCode::UNAUTHORIZED, "RESET_CODE_INVALID") => refused += 1,
            (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED") => rate_limited += 1,
            (status, code) => panic!("unexpected {status} {code}"),
        }
    }
    // A reset code is a rarer thing to present than a password: one address
    // gets 30 tries a minute.
    assert_eq!((refused, rate_limited), (30, 320));

    let other = "192.0.2.20";
    let preview = f
        .call(
            other,
            "POST",
            "/api/v1/invite/preview",
            json!({"code":invite_code}),
            false,
        )
        .await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
    let accepted = f
        .call(
            other,
            "POST",
            "/api/v1/invite/accept",
            json!({"code":invite_code,"new_password":"a-fresh-long-password"}),
            false,
        )
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.body);
    let redeemed = f
        .call(
            other,
            "POST",
            "/api/v1/password-reset",
            json!({"code":reset_code,"new_password":"a-brand-new-long-password"}),
            false,
        )
        .await;
    assert_eq!(redeemed.status, StatusCode::OK, "{}", redeemed.body);
    assert_eq!(spent(&f.state.limits, "password-reset-global"), 33);
}
