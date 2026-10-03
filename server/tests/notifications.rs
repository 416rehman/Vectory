//! Notifications end to end: channel administration, write-only secrets,
//! SSRF refusals, rules, quiet hours, de-duplication, flap control, the rate
//! cap, retries on a fake clock, retention, a hanging receiver, email, and the
//! editable detection thresholds. Every receiver is a local listener; the
//! scripted dialer maps "public" answers onto 127.0.0.1, so nothing leaves
//! the machine.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize, notifier, outbound};

/* ---------- Fixture ---------- */

struct Who {
    cookie: String,
    csrf: String,
}
struct Fixture {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    admin: Who,
    operator: Who,
    viewer: Who,
}
async fn person(s: &State, role: &str) -> Who {
    let user = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&user)
    .bind(format!("{user}@example.invalid"))
    .bind(format!("Synthetic {role}"))
    .bind(role)
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&user)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    Who {
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn fixture_with(outbound: outbound::Options) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Notification tests".into(),
        public_url: Some("https://vectory.example.test".into()),
        outbound,
        ..Default::default()
    })
    .await
    .unwrap();
    Fixture {
        admin: person(&s, "admin").await,
        operator: person(&s, "operator").await,
        viewer: person(&s, "viewer").await,
        app: api::router(s.clone()),
        s,
        _temp: temp,
    }
}
async fn fixture() -> Fixture {
    fixture_with(Default::default()).await
}
async fn request(
    f: &Fixture,
    who: &Who,
    csrf: bool,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", &who.cookie);
    if csrf {
        builder = builder.header("x-csrf-token", &who.csrf);
    }
    let response = f
        .app
        .clone()
        .oneshot(
            builder
                .body(Body::from(if body.is_null() {
                    String::new()
                } else {
                    body.to_string()
                }))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn call(f: &Fixture, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    request(f, &f.admin, true, method, path, body).await
}
async fn ok(f: &Fixture, method: &str, path: &str, body: Value) -> Value {
    let (status, value) = call(f, method, path, body).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}
fn webhook(url: &str, allow_private: bool, events: &[&str]) -> Value {
    json!({
        "name": format!("Hook {}", db::id()),
        "kind": "webhook",
        "allow_private": allow_private,
        "webhook": {"url": url},
        "rules": {"events": events},
    })
}
async fn channel(f: &Fixture, body: Value) -> Value {
    ok(f, "POST", "/api/v1/notifications/channels", body).await
}
/// Run notifier ticks at `now` until nothing more starts, waiting for sends.
async fn drain(f: &Fixture, now: DateTime<Utc>) {
    for _ in 0..40 {
        let tasks = notifier::tick(&f.s, now).await.unwrap();
        if tasks.is_empty() {
            return;
        }
        for task in tasks {
            task.await.unwrap();
        }
    }
    panic!("notifier kept sending at {now}");
}
fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}
async fn attempts(f: &Fixture) -> Vec<Value> {
    ok(
        f,
        "GET",
        "/api/v1/notifications/deliveries?page_size=50",
        Value::Null,
    )
    .await["items"]
        .as_array()
        .unwrap()
        .clone()
}

/* ---------- Receivers ---------- */

#[derive(Clone)]
enum Reply {
    Status(u16, String),
    Redirect,
    Hang,
    Large,
}
#[derive(Clone, Debug)]
struct Captured {
    head: String,
    body: Vec<u8>,
}
impl Captured {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_owned())
        })
    }
}
#[derive(Clone)]
struct Receiver {
    address: SocketAddr,
    captured: Arc<Mutex<Vec<Captured>>>,
    connections: Arc<AtomicUsize>,
    replies: Arc<Mutex<VecDeque<Reply>>>,
}
impl Receiver {
    fn requests(&self) -> Vec<Captured> {
        self.captured.lock().unwrap().clone()
    }
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }
}
async fn serve_http<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: S,
    receiver: Receiver,
    fallback: Reply,
) {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < 65536 {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let length = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
        })
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await.unwrap();
    receiver
        .captured
        .lock()
        .unwrap()
        .push(Captured { head, body });
    let reply = receiver
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or(fallback);
    let _ = match reply {
        Reply::Status(code, text) => {
            stream
                .write_all(format!("HTTP/1.1 {code} Reply\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).as_bytes())
                .await
        }
        Reply::Redirect => {
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await
        }
        Reply::Hang => {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            Ok(())
        }
        Reply::Large => {
            let _ = stream
                .write_all(b"HTTP/1.1 500 Server Error\r\ncontent-length: 1048576\r\nconnection: close\r\n\r\n")
                .await;
            let chunk = vec![b'x'; 16384];
            for _ in 0..64 {
                if stream.write_all(&chunk).await.is_err() {
                    break;
                }
            }
            Ok(())
        }
    };
    let _ = stream.shutdown().await;
}
async fn receiver(fallback: Reply) -> Receiver {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let r = Receiver {
        address: listener.local_addr().unwrap(),
        captured: Default::default(),
        connections: Default::default(),
        replies: Default::default(),
    };
    let state = r.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            state.connections.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(serve_http(stream, state.clone(), fallback.clone()));
        }
    });
    r
}
/// An HTTPS receiver for `name`, with a throwaway CA trusted only through
/// the test seam. Returns the receiver and the CA certificate (DER).
async fn tls_receiver(name: &str, fallback: Reply) -> (Receiver, Vec<u8>) {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::DigitalSignature,
    ];
    let ca = rcgen::CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
    let key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec![name.to_owned()])
        .unwrap()
        .signed_by(&key, &ca)
        .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![leaf.der().clone()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()),
    )
    .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let r = Receiver {
        address: listener.local_addr().unwrap(),
        captured: Default::default(),
        connections: Default::default(),
        replies: Default::default(),
    };
    let state = r.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            state.connections.fetch_add(1, Ordering::SeqCst);
            let (acceptor, state, fallback) = (acceptor.clone(), state.clone(), fallback.clone());
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(stream).await {
                    serve_http(tls, state, fallback).await;
                }
            });
        }
    });
    (r, ca.der().to_vec())
}

/// Scripted name resolution: answers pop in order (then the fallback), and
/// every connection lands on `target`, so "public" addresses stay local.
struct Script {
    answers: Mutex<VecDeque<Vec<IpAddr>>>,
    fallback: Vec<IpAddr>,
    target: SocketAddr,
    resolved: Mutex<Vec<String>>,
    dialed: Mutex<Vec<SocketAddr>>,
    /// Connections to this address never complete.
    hang: Option<IpAddr>,
}
impl Script {
    fn new(target: SocketAddr, fallback: &[&str]) -> Arc<Self> {
        Arc::new(Script {
            answers: Default::default(),
            fallback: fallback.iter().map(|ip| ip.parse().unwrap()).collect(),
            target,
            resolved: Default::default(),
            dialed: Default::default(),
            hang: None,
        })
    }
    fn answer(&self, ips: &[&str]) {
        self.answers
            .lock()
            .unwrap()
            .push_back(ips.iter().map(|ip| ip.parse().unwrap()).collect());
    }
    fn dialed(&self) -> Vec<SocketAddr> {
        self.dialed.lock().unwrap().clone()
    }
}
impl outbound::Dialer for Script {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> outbound::BoxFuture<'a, std::io::Result<Vec<SocketAddr>>> {
        Box::pin(async move {
            self.resolved.lock().unwrap().push(host.to_owned());
            let ips = self
                .answers
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| self.fallback.clone());
            Ok(ips
                .into_iter()
                .map(|ip| SocketAddr::new(ip, port))
                .collect())
        })
    }
    fn connect(&self, address: SocketAddr) -> outbound::BoxFuture<'_, std::io::Result<TcpStream>> {
        Box::pin(async move {
            self.dialed.lock().unwrap().push(address);
            if self.hang == Some(address.ip()) {
                std::future::pending::<()>().await;
            }
            TcpStream::connect(self.target).await
        })
    }
}
fn seam(script: &Arc<Script>, roots: Vec<Vec<u8>>) -> outbound::Options {
    outbound::Options {
        dialer: Some(script.clone()),
        extra_roots: roots,
    }
}

/* ---------- Administration and secrets ---------- */

#[tokio::test]
async fn channels_are_for_administrators_with_csrf() {
    let f = fixture().await;
    let body = webhook(
        "https://hooks.example.test/services/T1/B2/abc",
        false,
        &["issue.opened"],
    );
    for who in [&f.viewer, &f.operator] {
        let (status, _) = request(
            &f,
            who,
            true,
            "GET",
            "/api/v1/notifications/channels",
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = request(
            &f,
            who,
            true,
            "POST",
            "/api/v1/notifications/channels",
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, _) = request(
        &f,
        &f.admin,
        false,
        "POST",
        "/api/v1/notifications/channels",
        body.clone(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "mutations need the CSRF token"
    );
    let created = channel(&f, body).await;
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["revision"], 1);
    assert_eq!(created["status"]["state"], "idle");
    let path = format!("/api/v1/notifications/channels/{id}");
    for (method, target) in [("DELETE", path.clone()), ("POST", format!("{path}/test"))] {
        let (status, _) = request(&f, &f.operator, true, method, &target, json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {target}");
    }
    // A stale revision can't overwrite a newer edit.
    let edit = json!({"name":"Renamed","kind":"webhook","revision":1,"webhook":{},"rules":{"events":["issue.opened","issue.resolved"]}});
    let renamed = ok(&f, "PUT", &path, edit.clone()).await;
    assert_eq!(renamed["name"], "Renamed");
    assert_eq!(renamed["revision"], 2);
    let (status, error) = call(&f, "PUT", &path, edit).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["error"]["code"], "STALE_REVISION");
    ok(&f, "DELETE", &path, json!({})).await;
    let list = ok(&f, "GET", "/api/v1/notifications/channels", Value::Null).await;
    assert_eq!(list["items"], json!([]));
    let actions: Vec<String> = sqlx::query_scalar("SELECT json_extract(r.data,'$.action') FROM audit_sequence s JOIN records r ON r.kind='audit' AND r.id=s.audit_id WHERE json_extract(r.data,'$.action') LIKE 'notification.%' ORDER BY s.sequence")
        .fetch_all(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(
        actions,
        [
            "notification.channel.create",
            "notification.channel.update",
            "notification.channel.delete"
        ]
    );
    // The audit log names the channel as it was called at the time.
    let history = ok(
        &f,
        "GET",
        "/api/v1/audit/history?family=notification&sort=created_at&direction=asc",
        Value::Null,
    )
    .await;
    let names: Vec<&str> = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["target_name"].as_str().unwrap_or("(none)"))
        .collect();
    assert_eq!(
        names,
        [created["name"].as_str().unwrap(), "Renamed", "Renamed"]
    );
}

/// A writer that keeps everything logged while it is the default subscriber.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn secrets_never_leave_the_server() {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    let hook = receiver(Reply::Status(403, "token-in-path-9f8e7d6c rejected".into())).await;
    let f = fixture().await;
    let url = hook.url("/services/token-in-path-9f8e7d6c");
    let signing = "signing-secret-5a4b3c2d1e";
    let header = "Bearer header-secret-0f1e2d3c";
    let mut body = webhook(&url, true, &["issue.opened"]);
    body["webhook"]["signing_secret"] = json!(signing);
    body["webhook"]["header_name"] = json!("Authorization");
    body["webhook"]["header_value"] = json!(header);
    let mut responses = vec![channel(&f, body).await];
    let id = responses[0]["id"].as_str().unwrap().to_owned();
    let path = format!("/api/v1/notifications/channels/{id}");
    assert_eq!(
        responses[0]["webhook"]["url_hint"],
        format!("http://{}/…", hook.address)
    );
    assert_eq!(responses[0]["webhook"]["signing_secret_set"], true);
    assert_eq!(responses[0]["webhook"]["header_value_set"], true);
    responses.push(ok(&f, "GET", &path, Value::Null).await);
    responses.push(ok(&f, "GET", "/api/v1/notifications/channels", Value::Null).await);
    // An edit without secrets keeps them; the test proves they are still used.
    let kept = ok(&f, "PUT", &path, json!({"name":"Kept","kind":"webhook","allow_private":true,"revision":1,"webhook":{"header_name":"Authorization"},"rules":{"events":["issue.opened"]}})).await;
    assert_eq!(kept["webhook"]["signing_secret_set"], true);
    assert_eq!(kept["webhook"]["header_value_set"], true);
    responses.push(kept);
    let tested = ok(&f, "POST", &format!("{path}/test"), json!({})).await;
    assert_eq!(tested["delivered"], false);
    assert_eq!(tested["status_code"], 403);
    responses.push(tested);
    let sent = &hook.requests()[0];
    assert_eq!(sent.header("authorization").as_deref(), Some(header));
    assert!(
        sent.head
            .starts_with("POST /services/token-in-path-9f8e7d6c HTTP/1.1")
    );
    // Removing a secret takes it off the next message.
    let removed = ok(&f, "PUT", &path, json!({"name":"Kept","kind":"webhook","allow_private":true,"revision":2,"webhook":{"signing_secret":null,"header_name":null},"rules":{"events":["issue.opened"]}})).await;
    assert_eq!(removed["webhook"]["signing_secret_set"], false);
    assert_eq!(removed["webhook"]["header_value_set"], false);
    responses.push(removed);
    responses.push(ok(&f, "GET", "/api/v1/notifications/deliveries", Value::Null).await);
    let audit = ok(
        &f,
        "GET",
        "/api/v1/audit/history?family=notification",
        Value::Null,
    )
    .await;
    for event in audit["items"].as_array().unwrap() {
        responses.push(
            ok(
                &f,
                "GET",
                &format!("/api/v1/audit/{}", event["id"].as_str().unwrap()),
                Value::Null,
            )
            .await,
        );
    }
    responses.push(audit.clone());
    let raw_audit: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='audit'")
        .fetch_all(&f.s.pool)
        .await
        .unwrap();
    let stored: Vec<String> = sqlx::query_scalar("SELECT data||sealed FROM notification_channels")
        .fetch_all(&f.s.pool)
        .await
        .unwrap();
    let log = String::from_utf8_lossy(&logs.0.lock().unwrap()).to_string();
    let everything = format!(
        "{}\n{}\n{}\n{log}",
        json!(responses),
        raw_audit.join("\n"),
        stored.join("\n")
    );
    for secret in ["token-in-path-9f8e7d6c", signing, "header-secret-0f1e2d3c"] {
        assert!(!everything.contains(secret), "{secret} leaked");
    }
    // The receiver's echo of the path token is struck from the delivery log.
    let first = &attempts(&f).await[0];
    assert!(
        first["error"].as_str().unwrap().contains("«redacted»"),
        "{first}"
    );
    let details = ok(
        &f,
        "GET",
        &format!(
            "/api/v1/audit/{}",
            audit["items"][0]["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert!(details["details"]["summary"].is_string(), "{details}");
    // A refused test is a failure in the audit log's own words.
    let tests: Vec<&Value> = audit["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["action"] == "notification.channel.test")
        .collect();
    assert_eq!(tests.len(), 1, "{audit}");
    assert_eq!(tests[0]["outcome"], "failed");
    assert_eq!(tests[0]["target_name"], "Kept");
}

/* ---------- Where a channel may send ---------- */

#[tokio::test]
async fn private_receivers_need_the_explicit_allow() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    for url in [
        hook.url("/hook"),
        format!("https://{}/hook", hook.address),
        "https://localhost/hook".into(),
    ] {
        let (status, error) = call(
            &f,
            "POST",
            "/api/v1/notifications/channels",
            webhook(&url, false, &["issue.opened"]),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{url}: {error}");
    }
    let (status, error) = call(
        &f,
        "POST",
        "/api/v1/notifications/channels",
        webhook(
            "https://user:pass@hooks.example.test/x",
            false,
            &["issue.opened"],
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("user name and password")
    );
    let mut body = webhook(&hook.url("/hook?team=ops"), true, &["issue.opened"]);
    body["webhook"]["signing_secret"] = json!("0123456789abcdef0123");
    let created = channel(&f, body).await;
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            created["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(result["delivered"], true, "{result}");
    assert_eq!(result["status_code"], 200);
    let sent = &hook.requests()[0];
    assert!(sent.head.starts_with("POST /hook?team=ops HTTP/1.1"));
    assert_eq!(sent.header("x-vectory-event").as_deref(), Some("test"));
    let payload = sent.json();
    assert_eq!(payload["text"], "Test message from Vectory");
    assert_eq!(payload["event"]["schema"], "vectory.notification.v1");
    assert_eq!(payload["event"]["test"], true);
    assert_eq!(
        payload["event"]["url"],
        "https://vectory.example.test/#/notifications"
    );
    assert!(payload["blocks"].as_array().unwrap().len() >= 2);
    // The signature is HMAC-SHA256 over "<timestamp>.<body>".
    let signature = sent.header("x-vectory-signature").unwrap();
    let (t, v1) = signature.split_once(',').unwrap();
    let t = t.strip_prefix("t=").unwrap();
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(b"0123456789abcdef0123").unwrap();
    mac.update(format!("{t}.").as_bytes());
    mac.update(&sent.body);
    assert_eq!(
        v1.strip_prefix("v1=").unwrap(),
        hex::encode(mac.finalize().into_bytes())
    );
    let audit: String = sqlx::query_scalar("SELECT json_extract(data,'$.details.summary') FROM records WHERE kind='audit' AND json_extract(data,'$.action')='notification.channel.create'")
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    assert!(
        audit.contains("Private network addresses allowed"),
        "{audit}"
    );
}

#[tokio::test]
async fn every_blocked_address_is_refused_before_connecting() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let script = Script::new(hook.address, &["127.0.0.1"]);
    let f = fixture_with(seam(&script, Vec::new())).await;
    let public = channel(
        &f,
        webhook("https://hooks.example.test/x", false, &["issue.opened"]),
    )
    .await;
    let private = channel(
        &f,
        webhook("https://hooks.example.test/y", true, &["issue.opened"]),
    )
    .await;
    for (channel, answer, reason) in [
        (&public, "127.0.0.1", "a loopback address"),
        (&public, "10.0.0.7", "a private address"),
        (&public, "fe80::1", "a link-local address"),
        (&public, "0.0.0.0", "an unspecified address"),
        (&public, "224.0.0.1", "a multicast address"),
        (&private, "169.254.169.254", "a cloud metadata address"),
        (&private, "fd00:ec2::254", "a cloud metadata address"),
        (
            &private,
            "::ffff:169.254.169.254",
            "a cloud metadata address",
        ),
    ] {
        script.answer(&[answer]);
        let result = ok(
            &f,
            "POST",
            &format!(
                "/api/v1/notifications/channels/{}/test",
                channel["id"].as_str().unwrap()
            ),
            json!({}),
        )
        .await;
        assert_eq!(result["delivered"], false, "{answer}");
        let error = result["error"].as_str().unwrap();
        assert!(error.contains(reason), "{answer}: {error}");
        assert!(error.contains("hooks.example.test resolves to"), "{error}");
    }
    // One allowed and one forbidden answer still refuse the whole send.
    script.answer(&["93.184.215.14", "169.254.169.254"]);
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            private["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(result["delivered"], false);
    assert!(
        script.dialed().is_empty(),
        "nothing blocked was dialed: {:?}",
        script.dialed()
    );
    assert_eq!(hook.connections.load(Ordering::SeqCst), 0);
    // Plain http:// never goes to a public address.
    let plain = channel(
        &f,
        webhook("http://hooks.example.test/z", true, &["issue.opened"]),
    )
    .await;
    script.answer(&["93.184.215.14"]);
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            plain["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("Plain http:// only reaches private addresses"),
        "{result}"
    );
    assert!(script.dialed().is_empty());
}

#[tokio::test]
async fn dns_rebinding_is_judged_on_every_attempt() {
    let (hook, ca) = tls_receiver("hooks.example.test", Reply::Status(200, "ok".into())).await;
    let script = Script::new(hook.address, &["93.184.215.14"]);
    let f = fixture_with(seam(&script, vec![ca])).await;
    let created = channel(
        &f,
        webhook(
            "https://hooks.example.test/services/rebind",
            false,
            &["issue.opened"],
        ),
    )
    .await;
    let test = format!(
        "/api/v1/notifications/channels/{}/test",
        created["id"].as_str().unwrap()
    );
    // First the name answers with a public address: delivered over verified TLS.
    script.answer(&["93.184.215.14"]);
    let first = ok(&f, "POST", &test, json!({})).await;
    assert_eq!(first["delivered"], true, "{first}");
    // Then it rebinds to loopback: refused at connect time, never dialed.
    script.answer(&["127.0.0.1"]);
    let second = ok(&f, "POST", &test, json!({})).await;
    assert_eq!(second["delivered"], false);
    assert!(
        second["error"]
            .as_str()
            .unwrap()
            .contains("a loopback address")
    );
    assert_eq!(
        script.dialed(),
        vec!["93.184.215.14:443".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(hook.requests().len(), 1);
    assert_eq!(
        *script.resolved.lock().unwrap(),
        ["hooks.example.test", "hooks.example.test"]
    );
    // A certificate for another name fails verification.
    let other = channel(
        &f,
        webhook("https://other.example.test/x", false, &["issue.opened"]),
    )
    .await;
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            other["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(result["delivered"], false);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("TLS handshake with other.example.test failed"),
        "{result}"
    );
}

#[tokio::test]
async fn redirects_are_not_followed_and_responses_are_capped() {
    let hook = receiver(Reply::Redirect).await;
    let f = fixture().await;
    let created = channel(&f, webhook(&hook.url("/hook"), true, &["issue.opened"])).await;
    let test = format!(
        "/api/v1/notifications/channels/{}/test",
        created["id"].as_str().unwrap()
    );
    let result = ok(&f, "POST", &test, json!({})).await;
    assert_eq!(result["delivered"], false);
    assert_eq!(result["status_code"], 302);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("doesn't follow redirects")
    );
    assert_eq!(
        hook.requests().len(),
        1,
        "the redirect target was never requested"
    );
    hook.replies.lock().unwrap().push_back(Reply::Large);
    let started = std::time::Instant::now();
    let result = ok(&f, "POST", &test, json!({})).await;
    assert_eq!(result["status_code"], 500);
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    let error = result["error"].as_str().unwrap();
    assert!(error.len() < 300 && error.contains("xxxx"), "{error}");
}

#[tokio::test]
async fn a_hanging_receiver_never_blocks_a_heartbeat() {
    let hook = receiver(Reply::Hang).await;
    let mut script = Arc::try_unwrap(Script::new(hook.address, &["93.184.215.14"]))
        .ok()
        .unwrap();
    script.hang = Some("93.184.215.14".parse().unwrap());
    let script = Arc::new(script);
    let f = fixture_with(seam(&script, Vec::new())).await;
    let hanging = channel(&f, webhook(&hook.url("/hook"), true, &["issue.opened"])).await;
    let unreachable = channel(
        &f,
        webhook("https://slow.example.test/x", false, &["issue.opened"]),
    )
    .await;
    let device = db::id();
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&device)
        .bind("edge-hang")
        .bind(json!({"id":device,"name":"edge-hang","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0}).to_string())
        .execute(&f.s.pool)
        .await
        .unwrap();
    let peer = db::id();
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
        .bind(&peer)
        .bind(&device)
        .bind((Utc::now() + Duration::days(1)).to_rfc3339())
        .execute(&f.s.pool)
        .await
        .unwrap();
    let agent = vectory_server::device::router(f.s.clone()).layer(axum::Extension(
        vectory_server::device::PeerCertificate(Some(peer)),
    ));
    let send = |id: String| {
        let app = f.app.clone();
        let admin = (f.admin.cookie.clone(), f.admin.csrf.clone());
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let response = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/api/v1/notifications/channels/{id}/test"))
                        .header("cookie", admin.0)
                        .header("x-csrf-token", admin.1)
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            (
                serde_json::from_slice::<Value>(&bytes).unwrap(),
                started.elapsed(),
            )
        })
    };
    let slow = send(hanging["id"].as_str().unwrap().to_owned());
    let stuck = send(unreachable["id"].as_str().unwrap().to_owned());
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    // Both sends are waiting on the network. Heartbeats go through at once.
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let heartbeat = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false});
        let response = agent
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/agent/v1/heartbeat")
                    .header("content-type", "application/json")
                    .body(Body::from(heartbeat.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "heartbeat waited {:?}",
            started.elapsed()
        );
    }
    let (result, took) = slow.await.unwrap();
    assert_eq!(result["delivered"], false);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("didn't answer within 10 s"),
        "{result}"
    );
    assert!(
        took >= std::time::Duration::from_secs(9) && took < std::time::Duration::from_secs(13),
        "{took:?}"
    );
    let (result, took) = stuck.await.unwrap();
    assert!(
        result["error"].as_str().unwrap().contains("after 5 s"),
        "{result}"
    );
    assert!(took < std::time::Duration::from_secs(8), "{took:?}");
}

/* ---------- Rules, quiet hours, de-duplication and rate ---------- */

async fn device(f: &Fixture, name: &str, last_seen: DateTime<Utc>) -> String {
    let id = db::id();
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(json!({"id":id,"name":name,"vector_version":"0.58.0","last_seen":stamp(last_seen),"apply_state":"unmanaged","reported_generation":0}).to_string())
        .execute(&f.s.pool)
        .await
        .unwrap();
    id
}
/// An outbox event as the issue hooks write it.
async fn issue_event(
    f: &Fixture,
    identity: &str,
    device: &str,
    severity: &str,
    version: Option<&str>,
    at: DateTime<Utc>,
) {
    sqlx::query("INSERT OR IGNORE INTO notification_events(identity,kind,data,created_at) VALUES(?,?,?,?)")
        .bind(identity)
        .bind("issue.opened")
        .bind(json!({"issue_id":db::hash(identity),"revision":1,"device_id":device,"code":"DATA_PLANE_SINK_ERRORS","version_id":version,"title":format!("problem {identity}"),"message":"The sink is failing.","severity":severity}).to_string())
        .bind(stamp(at))
        .execute(&f.s.pool)
        .await
        .unwrap();
}
async fn version(f: &Fixture, name: &str) -> (String, String) {
    let configuration = db::id();
    let version = db::id();
    let mut conn = f.s.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "configuration",
        &json!({"id":configuration,"name":name,"created_at":db::now()}),
    )
    .await
    .unwrap();
    db::insert(&mut conn, "version", &json!({"id":version,"configuration_id":configuration,"number":4,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    (configuration, version)
}

#[tokio::test]
async fn rules_filter_by_event_severity_pipeline_and_group() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let now = Utc::now() + Duration::seconds(5);
    let edge = device(&f, "edge-1", now).await;
    let other = device(&f, "edge-2", now).await;
    let (pipeline, v1) = version(&f, "Web access logs").await;
    let (_, v2) = version(&f, "Metrics").await;
    let group = db::id();
    let mut conn = f.s.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "group",
        &json!({"id":group,"name":"EU","device_ids":[edge],"created_at":db::now(),"revision":1}),
    )
    .await
    .unwrap();
    drop(conn);
    let everything = channel(&f, webhook(&hook.url("/all"), true, &["issue.opened"])).await;
    let mut body = webhook(&hook.url("/errors-web-eu"), true, &["issue.opened"]);
    body["rules"] = json!({"events":["issue.opened"],"min_severity":"error","pipeline_ids":[pipeline],"group_ids":[group]});
    channel(&f, body).await;
    let mut body = webhook(&hook.url("/resolved-only"), true, &["issue.resolved"]);
    body["rules"]["events"] = json!(["issue.resolved"]);
    channel(&f, body).await;
    // Earlier than both channels: never announced.
    issue_event(
        &f,
        "before",
        &edge,
        "error",
        Some(&v1),
        now - Duration::minutes(5),
    )
    .await;
    issue_event(&f, "match", &edge, "error", Some(&v1), now).await;
    issue_event(&f, "warning", &edge, "warning", Some(&v1), now).await;
    issue_event(&f, "other-pipeline", &edge, "error", Some(&v2), now).await;
    issue_event(&f, "other-group", &other, "error", Some(&v1), now).await;
    // The same fact reported again is still one event.
    issue_event(&f, "match", &edge, "error", Some(&v1), now).await;
    drain(&f, now).await;
    let mut paths: Vec<String> = hook
        .requests()
        .iter()
        .map(|r| {
            format!(
                "{} {}",
                r.head.split_whitespace().nth(1).unwrap(),
                r.json()["event"]["headline"].as_str().unwrap()
            )
        })
        .collect();
    paths.sort();
    assert_eq!(
        paths,
        [
            "/all Issue on edge-1: problem match",
            "/all Issue on edge-1: problem other-pipeline",
            "/all Issue on edge-1: problem warning",
            "/all Issue on edge-2: problem other-group",
            "/errors-web-eu Issue on edge-1: problem match",
        ]
    );
    let first = hook
        .requests()
        .into_iter()
        .find(|r| r.head.contains("/errors-web-eu"))
        .unwrap()
        .json();
    assert_eq!(first["event"]["pipeline"]["name"], "Web access logs");
    assert_eq!(first["event"]["pipeline"]["version_number"], 4);
    assert_eq!(first["event"]["device"]["name"], "edge-1");
    assert_eq!(
        first["event"]["url"],
        format!("https://vectory.example.test/#/issues?device={edge}")
    );
    let status = ok(
        &f,
        "GET",
        &format!(
            "/api/v1/notifications/channels/{}",
            everything["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status["status"]["state"], "delivering");
    assert!(status["status"]["last_delivered_at"].is_string());
}

#[tokio::test]
async fn quiet_hours_hold_messages_and_let_errors_through() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let now = DateTime::parse_from_rfc3339("2026-09-29T02:10:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let edge = device(&f, "edge-q", now).await;
    let mut body = webhook(&hook.url("/q"), true, &["issue.opened"]);
    body["rules"]["quiet_hours"] =
        json!({"start":"22:00","end":"07:00","time_zone":"UTC","errors_bypass":true});
    let created = channel(&f, body).await;
    sqlx::query("UPDATE notification_channels SET created_at=?")
        .bind(stamp(now - Duration::days(1)))
        .execute(&f.s.pool)
        .await
        .unwrap();
    issue_event(&f, "night-error", &edge, "error", None, now).await;
    issue_event(&f, "night-warning-1", &edge, "warning", None, now).await;
    issue_event(&f, "night-warning-2", &edge, "warning", None, now).await;
    drain(&f, now).await;
    let sent: Vec<String> = hook
        .requests()
        .iter()
        .map(|r| r.json()["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        sent,
        ["Issue on edge-q: problem night-error"],
        "errors may bypass quiet hours"
    );
    let held: Vec<String> = sqlx::query_scalar(
        "SELECT next_attempt_at FROM notification_deliveries WHERE status='held'",
    )
    .fetch_all(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(held, ["2026-09-29T07:00:00Z", "2026-09-29T07:00:00Z"]);
    drain(&f, now + Duration::hours(2)).await;
    assert_eq!(hook.requests().len(), 1, "still quiet");
    drain(
        &f,
        DateTime::parse_from_rfc3339("2026-09-29T07:00:00Z")
            .unwrap()
            .with_timezone(&Utc),
    )
    .await;
    let requests = hook.requests();
    assert_eq!(requests.len(), 2, "the held messages arrive as one digest");
    let digest = requests[1].json();
    assert_eq!(digest["event"]["type"], "digest");
    assert_eq!(digest["text"], "2 notifications from quiet hours");
    assert!(
        digest["event"]["message"]
            .as_str()
            .unwrap()
            .contains("problem night-warning-2")
    );
    let log = attempts(&f).await;
    assert_eq!(log.len(), 2);
    assert_eq!(log[0]["kind"], "digest");
    let _ = created;
}

#[tokio::test]
async fn a_burst_is_capped_and_the_rest_summarised() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let now = Utc::now() + Duration::seconds(5);
    let edge = device(&f, "edge-b", now).await;
    channel(&f, webhook(&hook.url("/b"), true, &["issue.opened"])).await;
    for n in 0..40 {
        issue_event(&f, &format!("burst-{n:02}"), &edge, "error", None, now).await;
    }
    drain(&f, now).await;
    let requests = hook.requests();
    assert_eq!(
        requests.len(),
        notifier::RATE_LIMIT,
        "at most 30 in a minute"
    );
    let digest = requests.last().unwrap().json();
    assert_eq!(digest["event"]["type"], "digest");
    assert_eq!(digest["event"]["count"], 11);
    assert_eq!(
        digest["text"],
        "11 more notifications, summarised to avoid flooding this channel"
    );
    // More events inside the same minute wait for the window, then go out.
    for n in 40..43 {
        issue_event(&f, &format!("burst-{n:02}"), &edge, "error", None, now).await;
    }
    drain(&f, now + Duration::seconds(10)).await;
    assert_eq!(hook.requests().len(), notifier::RATE_LIMIT);
    drain(&f, now + Duration::seconds(62)).await;
    let late = hook.requests();
    assert_eq!(late.len(), notifier::RATE_LIMIT + 1);
    assert_eq!(late.last().unwrap().json()["event"]["count"], 3);
}

#[tokio::test]
async fn failed_sends_retry_after_one_five_and_thirty_minutes_then_give_up() {
    let hook = receiver(Reply::Status(503, "busy".into())).await;
    let f = fixture().await;
    let t0 = Utc::now() + Duration::seconds(5);
    let edge = device(&f, "edge-r", t0).await;
    channel(&f, webhook(&hook.url("/r"), true, &["issue.opened"])).await;
    issue_event(&f, "retry", &edge, "error", None, t0).await;
    for (at, sent) in [
        (0, 1),
        (59, 1),
        (60, 2),
        (359, 2),
        (360, 3),
        (2159, 3),
        (2160, 4),
        (99999, 4),
    ] {
        drain(&f, t0 + Duration::seconds(at)).await;
        assert_eq!(hook.requests().len(), sent, "after {at} s");
    }
    let log = attempts(&f).await;
    let outcomes: Vec<&str> = log
        .iter()
        .rev()
        .map(|a| a["outcome"].as_str().unwrap())
        .collect();
    assert_eq!(outcomes, ["retrying", "retrying", "retrying", "gave_up"]);
    let nexts: Vec<Value> = log
        .iter()
        .rev()
        .map(|a| a["next_attempt_at"].clone())
        .collect();
    assert_eq!(
        nexts,
        [
            json!(stamp(t0 + Duration::seconds(60))),
            json!(stamp(t0 + Duration::seconds(360))),
            json!(stamp(t0 + Duration::seconds(2160))),
            Value::Null
        ]
    );
    assert_eq!(log[0]["attempt"], 4);
    assert_eq!(
        log[0]["error"],
        "The receiver answered 503 Service Unavailable: busy"
    );
    // A refusal that won't change is not retried.
    let refused = receiver(Reply::Status(404, "no_service".into())).await;
    channel(&f, webhook(&refused.url("/gone"), true, &["issue.opened"])).await;
    issue_event(&f, "gone", &edge, "error", None, t0 + Duration::days(1)).await;
    drain(&f, t0 + Duration::days(1)).await;
    drain(&f, t0 + Duration::days(2)).await;
    assert_eq!(refused.requests().len(), 1);
    let filtered = ok(
        &f,
        "GET",
        "/api/v1/notifications/deliveries?outcome=failed",
        Value::Null,
    )
    .await;
    assert_eq!(filtered["total"], 1);
    assert_eq!(filtered["items"][0]["status_code"], 404);
    let (status, _) = call(
        &f,
        "GET",
        "/api/v1/notifications/deliveries?outcome=lost",
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn offline_alerts_go_out_once_per_outage_and_back_online_once() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let t0 = Utc::now() + Duration::seconds(5);
    // Gone long before the channel existed: never announced.
    let ancient = device(&f, "edge-ancient", t0 - Duration::days(3)).await;
    let mut body = webhook(
        &hook.url("/o"),
        true,
        &["device.offline", "device.recovered"],
    );
    body["rules"]["offline_minutes"] = json!(15);
    channel(&f, body).await;
    let edge = device(&f, "edge-flap", t0).await;
    let seen = |at: DateTime<Utc>| {
        let pool = f.s.pool.clone();
        let edge = edge.clone();
        async move {
            sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?) WHERE id=?")
                .bind(stamp(at))
                .bind(edge)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let texts = || {
        hook.requests()
            .iter()
            .map(|r| r.json()["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    drain(&f, t0 + Duration::minutes(10)).await;
    assert!(texts().is_empty(), "offline, but not for 15 minutes yet");
    drain(&f, t0 + Duration::minutes(16)).await;
    assert_eq!(texts(), ["edge-flap is offline"]);
    drain(&f, t0 + Duration::minutes(30)).await;
    assert_eq!(texts().len(), 1, "once per outage");
    // One check-in is not back yet; going quiet again is the same outage.
    seen(t0 + Duration::minutes(31)).await;
    drain(&f, t0 + Duration::minutes(32)).await;
    drain(&f, t0 + Duration::minutes(60)).await;
    assert_eq!(texts().len(), 1, "a flap sends nothing new");
    // Two check-ins in a row: back online, once.
    seen(t0 + Duration::minutes(61)).await;
    drain(&f, t0 + Duration::minutes(62)).await;
    seen(t0 + Duration::minutes(63)).await;
    drain(&f, t0 + Duration::minutes(64)).await;
    drain(&f, t0 + Duration::minutes(66)).await;
    assert_eq!(
        texts(),
        ["edge-flap is offline", "edge-flap is back online"]
    );
    let back = hook.requests()[1].json();
    assert_eq!(back["event"]["device"]["name"], "edge-flap");
    assert!(
        back["event"]["message"]
            .as_str()
            .unwrap()
            .starts_with("It checked in again after")
    );
    let outages: i64 = sqlx::query_scalar("SELECT count(*) FROM notification_outages")
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(outages, 0);
    let _ = ancient;
}

async fn checked_in(f: &Fixture, device: &str, at: DateTime<Utc>) {
    sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?) WHERE id=?")
        .bind(stamp(at))
        .bind(device)
        .execute(&f.s.pool)
        .await
        .unwrap();
}
fn texts_of(hook: &Receiver) -> Vec<String> {
    hook.requests()
        .iter()
        .map(|r| r.json()["text"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn devices_get_time_to_reconnect_after_the_server_starts_before_any_offline_alert() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    // Both devices last checked in just before the server went down for seven
    // minutes. Agents back off for up to five minutes after refused
    // connections, so neither can have been back at the moment of the start.
    let went_down = Utc::now();
    let started = went_down + Duration::minutes(7);
    let mut body = webhook(
        &hook.url("/o"),
        true,
        &["device.offline", "device.recovered"],
    );
    body["rules"]["offline_minutes"] = json!(5);
    channel(&f, body).await;
    let back = device(&f, "edge-back", went_down).await;
    let gone = device(&f, "edge-gone", went_down).await;
    f.s.notifier.begin_recovery_window(started);
    drain(&f, started).await;
    drain(&f, started + Duration::minutes(2)).await;
    assert!(
        texts_of(&hook).is_empty(),
        "stale check-ins from before the start are not silence: {:?}",
        texts_of(&hook)
    );
    // One device reconnects after its backoff and keeps checking in.
    let half_past = |minute: i64| started + Duration::minutes(minute) + Duration::seconds(30);
    for minute in 3..=9 {
        checked_in(&f, &back, started + Duration::minutes(minute)).await;
        drain(&f, half_past(minute)).await;
    }
    assert!(
        texts_of(&hook).is_empty(),
        "the other device is past the window but not yet silent for the channel's five minutes: {:?}",
        texts_of(&hook)
    );
    // The other stays silent after the window: reported once the channel's
    // minutes have passed, counted from the end of the window.
    checked_in(&f, &back, started + Duration::minutes(10)).await;
    drain(&f, half_past(10)).await;
    assert_eq!(texts_of(&hook), ["edge-gone is offline"]);
    let offline = hook.requests()[0].json();
    assert_eq!(offline["event"]["device"]["id"], gone);
    assert!(
        offline["event"]["message"]
            .as_str()
            .unwrap()
            .starts_with("No check-in for 17 min"),
        "the message still counts from the last check-in: {offline}"
    );
    checked_in(&f, &back, started + Duration::minutes(39)).await;
    drain(&f, started + Duration::minutes(40)).await;
    assert_eq!(texts_of(&hook), ["edge-gone is offline"], "once per outage");
}

#[tokio::test]
async fn a_device_reported_offline_before_a_restart_is_not_reported_again() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let t0 = Utc::now() + Duration::seconds(5);
    let mut body = webhook(
        &hook.url("/o"),
        true,
        &["device.offline", "device.recovered"],
    );
    body["rules"]["offline_minutes"] = json!(5);
    channel(&f, body).await;
    let returns = device(&f, "edge-returns", t0).await;
    let silent = device(&f, "edge-silent", t0).await;
    drain(&f, t0 + Duration::minutes(6)).await;
    let mut paged = texts_of(&hook);
    paged.sort();
    assert_eq!(paged, ["edge-returns is offline", "edge-silent is offline"]);
    // The server restarts while both are still gone.
    let started = t0 + Duration::minutes(20);
    f.s.notifier.begin_recovery_window(started);
    drain(&f, started).await;
    drain(&f, started + Duration::minutes(2)).await;
    // The first check-in after the outage is not "back online" yet, even
    // though nothing in the window counted the device as silent.
    checked_in(&f, &returns, started + Duration::minutes(3)).await;
    drain(&f, started + Duration::minutes(4)).await;
    assert_eq!(texts_of(&hook).len(), 2, "one check-in is not back yet");
    checked_in(&f, &returns, started + Duration::minutes(5)).await;
    drain(&f, started + Duration::minutes(6)).await;
    // The silent device stays silent through and after the window.
    checked_in(&f, &returns, started + Duration::minutes(29)).await;
    drain(&f, started + Duration::minutes(30)).await;
    let all = texts_of(&hook);
    assert_eq!(all.len(), 3, "{all:?}");
    assert_eq!(all[2], "edge-returns is back online");
    let mut first_two = all[..2].to_vec();
    first_two.sort();
    assert_eq!(first_two, paged);
    let _ = silent;
}

#[tokio::test]
async fn rollout_failures_come_from_the_audit_trail() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    let (_, v) = version(&f, "Web access logs").await;
    channel(
        &f,
        webhook(&hook.url("/d"), true, &["rollout.failed", "canary.paused"]),
    )
    .await;
    let deployment = db::id();
    let mut conn = f.s.pool.acquire().await.unwrap();
    db::insert(&mut conn, "deployment", &json!({"id":deployment,"version_id":v,"status":"failed","failure_reason":"threshold","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"created_at":db::now()})).await.unwrap();
    db::audit(
        &mut conn,
        "scheduler",
        "deployment.gate",
        &deployment,
        "failed",
    )
    .await
    .unwrap();
    db::audit(
        &mut conn,
        "scheduler",
        "deployment.gate",
        &deployment,
        "paused",
    )
    .await
    .unwrap();
    // Not a notification: an ordinary release.
    db::audit(
        &mut conn,
        "scheduler",
        "deployment.release",
        &deployment,
        "success",
    )
    .await
    .unwrap();
    drop(conn);
    let now = Utc::now() + Duration::seconds(5);
    drain(&f, now).await;
    let texts: Vec<String> = hook
        .requests()
        .iter()
        .map(|r| r.json()["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        texts,
        [
            "Rollout failed: Web access logs v4",
            "Canary paused: Web access logs v4"
        ]
    );
    let failed = hook.requests()[0].json();
    assert_eq!(failed["event"]["deployment"]["id"], deployment.as_str());
    assert!(
        failed["event"]["message"]
            .as_str()
            .unwrap()
            .contains("failure threshold")
    );
    drain(&f, now + Duration::minutes(5)).await;
    assert_eq!(
        hook.requests().len(),
        2,
        "each audit event is announced once"
    );
}

#[tokio::test]
async fn old_log_entries_are_pruned_after_thirty_days() {
    let f = fixture().await;
    let now = Utc::now();
    let old = stamp(now - Duration::days(31));
    let recent = stamp(now - Duration::days(29));
    for (id, at) in [("old", &old), ("recent", &recent)] {
        sqlx::query("INSERT INTO notification_attempts(delivery_id,channel_id,attempt,at,outcome,latency_ms,data) VALUES(?,?,1,?,'delivered',5,'{}')")
            .bind(id)
            .bind("channel")
            .bind(at)
            .execute(&f.s.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO notification_deliveries(id,channel_id,kind,status,data,created_at,updated_at) VALUES(?,?,'event','delivered','{}',?,?)")
            .bind(id)
            .bind("channel")
            .bind(at)
            .bind(at)
            .execute(&f.s.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO notification_events(identity,kind,data,created_at,processed) VALUES(?,'issue.opened','{}',?,1)")
            .bind(id)
            .bind(at)
            .execute(&f.s.pool)
            .await
            .unwrap();
    }
    notifier::tick(&f.s, now).await.unwrap();
    for table in [
        "notification_attempts",
        "notification_deliveries",
        "notification_events",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&f.s.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "{table}");
    }
}

/* ---------- Email ---------- */

async fn smtp_server() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let transcript: Arc<Mutex<Vec<String>>> = Default::default();
    let log = transcript.clone();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read);
                write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
                let mut line = String::new();
                loop {
                    line.clear();
                    if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    log.lock().unwrap().push(line.trim_end().to_owned());
                    let upper = line.to_ascii_uppercase();
                    let reply: &[u8] = if upper.starts_with("EHLO") {
                        b"250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n"
                    } else if upper.starts_with("AUTH") {
                        b"235 2.7.0 Authenticated\r\n"
                    } else if upper.starts_with("DATA") {
                        write.write_all(b"354 go ahead\r\n").await.unwrap();
                        let mut message = String::new();
                        loop {
                            let mut part = String::new();
                            lines.read_line(&mut part).await.unwrap();
                            if part == ".\r\n" {
                                break;
                            }
                            message.push_str(&part);
                        }
                        log.lock().unwrap().push(message);
                        b"250 2.0.0 queued\r\n"
                    } else if upper.starts_with("QUIT") {
                        write.write_all(b"221 bye\r\n").await.unwrap();
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    write.write_all(reply).await.unwrap();
                }
            });
        }
    });
    (address, transcript)
}

#[tokio::test]
async fn email_goes_out_through_smtp_and_its_password_stays_secret() {
    let (smtp, transcript) = smtp_server().await;
    let f = fixture().await;
    let password = "smtp-password-7c6b5a49";
    let body = |security: &str, allow: bool| {
        json!({
            "name": format!("Mail {}", db::id()),
            "kind": "email",
            "allow_private": allow,
            "email": {"host":"127.0.0.1","port":smtp.port(),"security":security,"username":"alerts","password":password,"from":"Vectory <alerts@example.test>","to":["oncall@example.test","lead@example.test"]},
            "rules": {"events":["issue.opened"]},
        })
    };
    let (status, _) = call(
        &f,
        "POST",
        "/api/v1/notifications/channels",
        body("none", false),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "loopback needs the explicit allow"
    );
    let mut public = body("none", true);
    public["email"]["host"] = json!("smtp.example.test");
    let (status, error) = call(&f, "POST", "/api/v1/notifications/channels", public).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        error["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Unencrypted email only goes to a relay on this server")
    );
    let created = channel(&f, body("none", true)).await;
    assert_eq!(created["email"]["password_set"], true);
    assert!(!created.to_string().contains(password));
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            created["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(result["delivered"], true, "{result}");
    assert_eq!(result["status_code"], 250);
    let transcript = transcript.lock().unwrap().join("\n");
    assert!(
        transcript.contains("MAIL FROM:<alerts@example.test>"),
        "{transcript}"
    );
    assert!(
        transcript.contains("RCPT TO:<oncall@example.test>")
            && transcript.contains("RCPT TO:<lead@example.test>")
    );
    assert!(
        transcript.contains("Subject: [Notification tests] Test message from Vectory"),
        "{transcript}"
    );
    assert!(transcript.contains("AUTH PLAIN"));
    let audit: Vec<String> = sqlx::query_scalar("SELECT data FROM records WHERE kind='audit'")
        .fetch_all(&f.s.pool)
        .await
        .unwrap();
    assert!(!audit.join("\n").contains(password));
    // Encrypted modes refuse a server that can't encrypt.
    let starttls = channel(&f, body("starttls", true)).await;
    let result = ok(
        &f,
        "POST",
        &format!(
            "/api/v1/notifications/channels/{}/test",
            starttls["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(result["delivered"], false);
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("doesn't offer STARTTLS"),
        "{result}"
    );
}

#[tokio::test]
async fn previews_are_marked_as_examples() {
    let f = fixture().await;
    let preview = ok(
        &f,
        "POST",
        "/api/v1/notifications/preview",
        json!({"type":"device.offline","name":"On-call"}),
    )
    .await;
    assert_eq!(preview["example"], true);
    assert_eq!(preview["headline"], "example-device is offline");
    assert_eq!(preview["webhook"]["text"], "example-device is offline");
    assert!(
        preview["email"]["body"]
            .as_str()
            .unwrap()
            .contains("Sent by the “On-call” channel")
    );
    let (status, _) = request(
        &f,
        &f.operator,
        true,
        "POST",
        "/api/v1/notifications/preview",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

/* ---------- Issues end to end, and detection thresholds ---------- */

struct Fleet {
    device: String,
    agent: Router,
}
async fn deployed(f: &Fixture) -> Fleet {
    let device = device(f, "web-1", Utc::now()).await;
    let (_, version) = version(f, "Web access logs").await;
    let d = ok(f, "POST", "/api/v1/deployments", json!({"version_id":version,"selector":{"group_ids":[],"device_ids":[device],"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}})).await;
    assert_eq!(d["status"], "active");
    vectory_server::rollout::tick(&f.s).await.unwrap();
    let peer = db::id();
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
        .bind(&peer)
        .bind(&device)
        .bind((Utc::now() + Duration::days(1)).to_rfc3339())
        .execute(&f.s.pool)
        .await
        .unwrap();
    Fleet {
        agent: vectory_server::device::router(f.s.clone()).layer(axum::Extension(
            vectory_server::device::PeerCertificate(Some(peer)),
        )),
        device,
    }
}
async fn beat(f: &Fixture, fleet: &Fleet, n: i64, errors: f64) {
    sqlx::query("UPDATE data_plane_state SET data=json_set(data,'$.evaluated_at','2000-01-01T00:00:00Z') WHERE device_id=?")
        .bind(&fleet.device)
        .execute(&f.s.pool)
        .await
        .unwrap();
    let sample = json!({"sampled_at":stamp(Utc::now() - Duration::seconds(100 - n)),"events_per_second":5.0,"events_out_per_second":5.0,"errors_per_minute":errors,"components":[
        {"id":"demo","kind":"source","type":"demo_logs","events_per_second":5.0},
        {"id":"archive","kind":"sink","type":"http","received_events_per_second":5.0,"events_per_second":if errors > 0.0 { 0.0 } else { 5.0 },"errors_per_minute":errors,"dropped_per_minute":0.0,"buffer_utilization":0.01}
    ]});
    let v = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false,"telemetry":sample});
    let response = fleet
        .agent
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/v1/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(v.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
async fn open_sink_issues(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='issue' AND json_extract(data,'$.code')='DATA_PLANE_SINK_ERRORS' AND json_extract(data,'$.resolved')=0")
        .fetch_one(&f.s.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn issues_announce_opening_and_recovery_once_and_a_reopening_again() {
    let hook = receiver(Reply::Status(200, "ok".into())).await;
    let f = fixture().await;
    channel(
        &f,
        webhook(&hook.url("/i"), true, &["issue.opened", "issue.resolved"]),
    )
    .await;
    let fleet = deployed(&f).await;
    let texts = || {
        hook.requests()
            .iter()
            .map(|r| r.json()["text"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };
    for n in 1..=4 {
        beat(&f, &fleet, n, 12.0).await;
    }
    drain(&f, Utc::now() + Duration::seconds(5)).await;
    assert_eq!(
        texts(),
        ["Issue on web-1: archive can't deliver events"],
        "repeated reports are one event"
    );
    for n in 5..=8 {
        beat(&f, &fleet, n, 0.0).await;
    }
    drain(&f, Utc::now() + Duration::seconds(10)).await;
    assert_eq!(
        texts()[1],
        "Resolved on web-1: archive can't deliver events"
    );
    // Back after it resolved: a new occurrence, announced again.
    for n in 9..=10 {
        beat(&f, &fleet, n, 12.0).await;
    }
    drain(&f, Utc::now() + Duration::seconds(15)).await;
    assert_eq!(texts().len(), 3);
    assert_eq!(texts()[2], "Issue on web-1: archive can't deliver events");
    let first = hook.requests()[0].json();
    assert_eq!(first["event"]["issue"]["code"], "DATA_PLANE_SINK_ERRORS");
    assert_eq!(first["event"]["severity"], "error");
    assert!(
        first["event"]["message"]
            .as_str()
            .unwrap()
            .contains("failing about 12 requests a minute")
    );
}

#[tokio::test]
async fn detection_thresholds_are_bounded_audited_and_drive_evaluation() {
    let f = fixture().await;
    let current = ok(&f, "GET", "/api/v1/detection", Value::Null).await;
    assert_eq!(current["revision"], 0);
    assert_eq!(
        current["thresholds"],
        json!({"sink_errors_per_minute":1,"error_drops_per_minute":1,"buffer_full_percent":95,"stall_checks":3,"canary_checks":3})
    );
    assert_eq!(current["thresholds"], current["defaults"]);
    let (status, _) = request(
        &f,
        &f.viewer,
        false,
        "GET",
        "/api/v1/detection",
        Value::Null,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "everyone can read what drives issues"
    );
    let raised = json!({"sink_errors_per_minute":20,"error_drops_per_minute":1,"buffer_full_percent":90,"stall_checks":3,"canary_checks":3});
    let (status, _) = request(
        &f,
        &f.operator,
        true,
        "PUT",
        "/api/v1/detection",
        json!({"thresholds":raised,"revision":0}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for bad in [
        json!({"thresholds":{"sink_errors_per_minute":0,"error_drops_per_minute":1,"buffer_full_percent":95,"stall_checks":3,"canary_checks":3},"revision":0}),
        json!({"thresholds":{"sink_errors_per_minute":1,"error_drops_per_minute":1,"buffer_full_percent":40,"stall_checks":3,"canary_checks":3},"revision":0}),
        json!({"thresholds":{"sink_errors_per_minute":1,"error_drops_per_minute":1,"buffer_full_percent":95,"stall_checks":3},"revision":0}),
        json!({"thresholds":{"sink_errors_per_minute":1,"error_drops_per_minute":1,"buffer_full_percent":95,"stall_checks":3,"canary_checks":3,"refresh_seconds":60},"revision":0}),
        json!({"thresholds":raised,"revision":0,"extra":true}),
    ] {
        let (status, error) = call(&f, "PUT", "/api/v1/detection", bad.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {error}");
    }
    let saved = ok(
        &f,
        "PUT",
        "/api/v1/detection",
        json!({"thresholds":raised,"revision":0}),
    )
    .await;
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["thresholds"]["sink_errors_per_minute"], 20);
    assert_eq!(saved["updated_by_name"], "Synthetic admin");
    let (status, error) = call(
        &f,
        "PUT",
        "/api/v1/detection",
        json!({"thresholds":raised,"revision":0}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "STALE_REVISION");
    let audit = ok(
        &f,
        "GET",
        "/api/v1/audit/history?action=detection.update",
        Value::Null,
    )
    .await;
    assert_eq!(audit["total"], 1);
    assert_eq!(audit["items"][0]["target_name"], "Detection thresholds");
    let detail = ok(
        &f,
        "GET",
        &format!(
            "/api/v1/audit/{}",
            audit["items"][0]["id"].as_str().unwrap()
        ),
        Value::Null,
    )
    .await;
    assert_eq!(
        detail["details"]["summary"],
        "Failing destination: 1 failed request a minute → 20 failed requests a minute. Full buffer: 95% → 90%."
    );
    // Twelve failed requests a minute no longer count as failing.
    let fleet = deployed(&f).await;
    for n in 1..=4 {
        beat(&f, &fleet, n, 12.0).await;
    }
    assert_eq!(open_sink_issues(&f).await, 0);
    // Back to the defaults, the same numbers open the issue again.
    let reset = ok(
        &f,
        "PUT",
        "/api/v1/detection",
        json!({"thresholds":current["defaults"],"revision":1}),
    )
    .await;
    assert_eq!(reset["thresholds"], reset["defaults"]);
    for n in 5..=6 {
        beat(&f, &fleet, n, 12.0).await;
    }
    assert_eq!(open_sink_issues(&f).await, 1);
    // Saving the same values changes nothing and audits nothing.
    let same = ok(
        &f,
        "PUT",
        "/api/v1/detection",
        json!({"thresholds":current["defaults"],"revision":2}),
    )
    .await;
    assert_eq!(same["revision"], 2);
    let audit = ok(
        &f,
        "GET",
        "/api/v1/audit/history?action=detection.update",
        Value::Null,
    )
    .await;
    assert_eq!(audit["total"], 2);
}
