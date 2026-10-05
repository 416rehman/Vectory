//! Onboarding: agents shipped with the server, the device-facing installer and
//! downloads, enrollment replay and the reasons administrators see for refusals.
use axum::{
    Extension, Router,
    body::Body,
    extract::ConnectInfo,
    http::{HeaderMap, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{net::SocketAddr, path::Path};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize};

struct Fixture {
    temp: tempfile::TempDir,
    s: State,
    api: Router,
    cookie: String,
    csrf: String,
    admin: String,
}

async fn fixture(configure: impl FnOnce(&mut Settings, &Path)) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("mirror"),
        instance_name: "Onboarding tests".into(),
        validation_url: None,
        ..Default::default()
    };
    configure(&mut settings, temp.path());
    let s = initialize(settings).await.unwrap();
    let admin = db::id();
    let session = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&admin)
    .bind("ada@example.invalid")
    .bind("Ada Admin")
    .bind("admin")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&session))
        .bind(&admin)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    Fixture {
        api: api::router(s.clone()),
        s,
        temp,
        cookie: format!("vectory_session={session}"),
        csrf,
        admin,
    }
}

/// The agent listener as a device at 10.0.4.17 reaches it.
fn agent(s: &State) -> Router {
    device::router(s.clone()).layer(Extension(ConnectInfo(SocketAddr::from((
        [10, 0, 4, 17],
        50123,
    )))))
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}
fn json_of(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}
impl Fixture {
    async fn get(&self, app: &Router, path: &str, host: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        let request = Request::builder()
            .uri(path)
            .header(header::HOST, host)
            .header("cookie", &self.cookie)
            .body(Body::empty())
            .unwrap();
        send(app, request).await
    }
    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .body(Body::from(body.to_string()))
            .unwrap();
        let (status, _, bytes) = send(&self.api, request).await;
        (status, json_of(&bytes))
    }
    /// A token secret and its ID.
    async fn token(&self, body: Value) -> (String, String) {
        let (status, created) = self.post("/api/v1/tokens", body).await;
        assert_eq!(status, StatusCode::OK, "{created}");
        (
            created["token"].as_str().unwrap().to_owned(),
            created["record"]["id"].as_str().unwrap().to_owned(),
        )
    }
    async fn enroll(&self, body: &Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri("/agent/v1/enroll")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let (status, _, bytes) = send(&agent(&self.s), request).await;
        (status, json_of(&bytes))
    }
    async fn activity(&self) -> Vec<Value> {
        let (status, _, bytes) = self
            .get(
                &self.api,
                "/api/v1/agent-install/activity",
                "vectory.example.test",
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        json_of(&bytes)["events"].as_array().unwrap().clone()
    }
}

fn csr() -> String {
    let key = rcgen::KeyPair::generate().unwrap();
    rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap()
}
fn enrollment(token: &str, request: &str, name: &str, csr: &str) -> Value {
    json!({"protocol_version":1,"request_id":request,"token":token,"name":name,"csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"0.1.0","vector_version":"0.58.0","configuration_mode":"restricted"})
}
fn generic_refusal() -> Value {
    json!({"error":{"code":"ENROLLMENT_FAILED","message":"Enrollment could not be authorized"}})
}

#[tokio::test]
async fn a_retry_after_a_lost_response_succeeds_although_the_token_expired_or_was_revoked() {
    let f = fixture(|_, _| {}).await;
    let (token, token_id) = f
        .token(json!({"name":"Replay","expires_hours":1,"max_uses":1}))
        .await;
    let key = csr();
    let request = enrollment(&token, "replay-request-1", "edge-01", &key);
    let (status, first) = f.enroll(&request).await;
    assert_eq!(status, StatusCode::OK, "{first}");

    // The response was lost. Meanwhile the single-use token expired...
    sqlx::query(
        "UPDATE enrollment_tokens SET data=json_set(data,'$.expires_at','2000-01-01T00:00:00Z') WHERE id=?",
    )
    .bind(&token_id)
    .execute(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(f.enroll(&request).await, (StatusCode::OK, first.clone()));
    // ...and was revoked. The enrollment already happened, so the retry finishes.
    let (status, _) = f
        .post(&format!("/api/v1/tokens/{token_id}/revoke"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(f.enroll(&request).await, (StatusCode::OK, first.clone()));
    let devices: i64 = sqlx::query_scalar("SELECT count(*) FROM devices")
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(devices, 1, "a replay must not enroll another device");

    // Replay needs the same key; new requests still meet every token check.
    let other = enrollment(&token, "replay-request-1", "edge-01", &csr());
    assert_eq!(
        f.enroll(&other).await,
        (StatusCode::UNAUTHORIZED, generic_refusal())
    );
    let fresh = enrollment(&token, "replay-request-2", "edge-02", &csr());
    assert_eq!(
        f.enroll(&fresh).await,
        (StatusCode::UNAUTHORIZED, generic_refusal())
    );
    // Revoking the device ends its replay.
    sqlx::query("UPDATE devices SET revoked=1")
        .execute(&f.s.pool)
        .await
        .unwrap();
    assert_eq!(
        f.enroll(&request).await,
        (StatusCode::UNAUTHORIZED, generic_refusal())
    );
    let reasons: Vec<Value> = f
        .activity()
        .await
        .iter()
        .filter(|e| e["outcome"] == "failure")
        .map(|e| e["reason_code"].clone())
        .collect();
    assert_eq!(
        reasons,
        vec![
            json!("DEVICE_REVOKED"),
            json!("TOKEN_REVOKED"),
            json!("REQUEST_MISMATCH")
        ]
    );
}

#[tokio::test]
async fn refusals_stay_generic_for_devices_and_explain_themselves_to_administrators() {
    let f = fixture(|_, _| {}).await;
    let (single, single_id) = f
        .token(json!({"name":"Single","expires_hours":1,"max_uses":1}))
        .await;
    let (reusable, reusable_id) = f
        .token(json!({"name":"Fleet","expires_hours":1,"max_uses":10}))
        .await;
    let (web_only, web_only_id) = f
        .token(json!({"name":"Web","expires_hours":1,"name_prefix":"web-"}))
        .await;
    let (expired, expired_id) = f.token(json!({"name":"Old","expires_hours":1})).await;
    sqlx::query(
        "UPDATE enrollment_tokens SET data=json_set(data,'$.expires_at','2000-01-01T00:00:00Z') WHERE id=?",
    )
    .bind(&expired_id)
    .execute(&f.s.pool)
    .await
    .unwrap();
    let (status, _) = f
        .enroll(&enrollment(&single, "request-ok", "edge-10", &csr()))
        .await;
    assert_eq!(status, StatusCode::OK);
    let unknown = "0".repeat(64);
    let mut malformed = enrollment(&reusable, "request-malformed", "edge-20", &csr());
    malformed.as_object_mut().unwrap().remove("csr_pem");
    let attempts = [
        (
            enrollment(&unknown, "request-a", "edge-11", &csr()),
            "TOKEN_UNKNOWN",
            None,
        ),
        (
            enrollment("pasted-half-a-token", "request-b", "edge-11", &csr()),
            "TOKEN_UNKNOWN",
            None,
        ),
        (
            enrollment(&expired, "request-c", "edge-12", &csr()),
            "TOKEN_EXPIRED",
            Some(&expired_id),
        ),
        (
            enrollment(&single, "request-d", "edge-13", &csr()),
            "TOKEN_EXHAUSTED",
            Some(&single_id),
        ),
        (
            enrollment(&reusable, "request-e", "EDGE-10", &csr()),
            "NAME_TAKEN",
            Some(&reusable_id),
        ),
        (
            enrollment(&web_only, "request-f", "db-01", &csr()),
            "NAME_PREFIX_MISMATCH",
            Some(&web_only_id),
        ),
        (malformed, "MALFORMED", None),
    ];
    for (body, _, _) in &attempts {
        assert_eq!(
            f.enroll(body).await,
            (StatusCode::UNAUTHORIZED, generic_refusal()),
            "{body}"
        );
    }
    let events = f.activity().await;
    let failures: Vec<&Value> = events
        .iter()
        .rev()
        .filter(|e| e["outcome"] == "failure")
        .collect();
    // A second tokenless refusal from the same client within a minute is
    // refused the same way but not audited again.
    let recorded: Vec<_> = attempts
        .iter()
        .enumerate()
        .filter(|(n, _)| *n != 1)
        .map(|(_, attempt)| attempt)
        .collect();
    assert_eq!(failures.len(), recorded.len());
    for (event, (body, reason, token)) in failures.iter().zip(recorded) {
        assert_eq!(event["reason_code"], *reason, "{event}");
        assert_eq!(event["token_id"], json!(token), "{event}");
        assert_eq!(
            event["device_name"],
            json!(body["name"].as_str().unwrap().to_ascii_lowercase())
        );
        assert_eq!(event["agent_os"], "linux");
        assert_eq!(event["agent_arch"], "amd64");
        assert_eq!(event["agent_version"], "0.1.0");
        assert_eq!(event["client_address"], "10.0.4.17");
    }
    let success = events.iter().find(|e| e["outcome"] == "success").unwrap();
    assert_eq!(success["device_name"], "edge-10");
    assert_eq!(success["token_id"], json!(single_id));
    assert_eq!(success["configuration_mode"], "restricted");
    assert!(success["device_id"].is_string());

    // The audit trail shows the same allowlisted details, and never a token.
    let id = failures[1]["id"].as_str().unwrap();
    let (status, _, bytes) = f
        .get(
            &f.api,
            &format!("/api/v1/audit/{id}"),
            "vectory.example.test",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let detail = json_of(&bytes);
    assert_eq!(
        detail["details"],
        json!({"reason_code":"TOKEN_EXPIRED","name":"edge-12","token_id":expired_id,"agent_os":"linux","agent_arch":"amd64","agent_version":"0.1.0","configuration_mode":"restricted","client_address":"10.0.4.17"})
    );

    // Viewers read the same events without where anyone connected from, and
    // the enrollment activity feed is for the people who add devices.
    let viewer = db::id();
    let viewer_session = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&viewer)
    .bind("vic@example.invalid")
    .bind("Vic Viewer")
    .bind("viewer")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&f.s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&viewer_session))
        .bind(&viewer)
        .bind(auth::random_secret())
        .bind("2099-01-01T00:00:00Z")
        .execute(&f.s.pool)
        .await
        .unwrap();
    let as_viewer = |path: String| {
        Request::builder()
            .uri(path)
            .header("cookie", format!("vectory_session={viewer_session}"))
            .body(Body::empty())
            .unwrap()
    };
    let (status, _, _) = send(&f.api, as_viewer("/api/v1/agent-install/activity".into())).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, bytes) = send(&f.api, as_viewer(format!("/api/v1/audit/{id}"))).await;
    assert_eq!(status, StatusCode::OK);
    let mut redacted = detail.clone();
    redacted["details"]
        .as_object_mut()
        .unwrap()
        .remove("client_address");
    assert_eq!(json_of(&bytes), redacted);
    let (status, _, bytes) = send(&f.api, as_viewer("/api/v1/audit".into())).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!String::from_utf8(bytes).unwrap().contains("10.0.4.17"));
    // An encoded offset is an ordinary RFC3339 timestamp.
    let (status, _, _) = f
        .get(
            &f.api,
            "/api/v1/agent-install/activity?since=2026-01-01T00%3A00%3A00%2B00%3A00",
            "vectory.example.test",
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    for secret in [&single, &reusable, &web_only, &expired, &unknown] {
        let leaked: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE instr(data,?)>0")
            .bind(secret)
            .fetch_one(&f.s.pool)
            .await
            .unwrap();
        assert_eq!(leaked, 0, "a token reached a stored record");
    }
}

#[tokio::test]
async fn recovery_tokens_keep_their_stricter_order() {
    // Cancelling an authorized recovery revokes its token, which must also end
    // replay (device_recovery_requests.rs covers the full flow); an expired
    // recovery token likewise refuses a replay.
    let f = fixture(|_, _| {}).await;
    let (token, token_id) = f
        .token(json!({"name":"Original","expires_hours":1,"max_uses":1}))
        .await;
    let (status, credential) = f
        .enroll(&enrollment(&token, "original", "edge-30", &csr()))
        .await;
    assert_eq!(status, StatusCode::OK);
    let device = credential["device_id"].as_str().unwrap();
    let (status, recovery) = f
        .post(
            &format!("/api/v1/devices/{device}/recover"),
            json!({"request_id":db::id(),"expected_name":"edge-30"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{recovery}");
    let secret = recovery["token"].as_str().unwrap();
    let key = csr();
    let request = enrollment(secret, "recovery-1", "edge-30", &key);
    assert_eq!(f.enroll(&request).await.0, StatusCode::OK);
    sqlx::query(
        "UPDATE enrollment_tokens SET data=json_set(data,'$.expires_at','2000-01-01T00:00:00Z') WHERE id<>?",
    )
    .bind(&token_id)
    .execute(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(
        f.enroll(&request).await,
        (StatusCode::UNAUTHORIZED, generic_refusal())
    );
    let events = f.activity().await;
    assert_eq!(events[0]["reason_code"], "TOKEN_EXPIRED");
}

// ---------------------------------------------------------------------------
// Releases, installer and downloads

struct Build {
    name: &'static str,
    os: &'static str,
    arch: &'static str,
    version: &'static str,
    bytes: Vec<u8>,
}
fn write_catalog(dir: &Path, builds: &[Build]) -> Vec<String> {
    std::fs::create_dir_all(dir).unwrap();
    let mut catalog = Vec::new();
    let mut digests = Vec::new();
    for build in builds {
        std::fs::write(dir.join(build.name), &build.bytes).unwrap();
        let sha = db::hash(&build.bytes);
        catalog.push(json!({"name":build.name,"os":build.os,"arch":build.arch,"version":build.version,"sha256":sha,"size":build.bytes.len(),"url":format!("/api/v1/releases/{}",build.name),"signed":false}));
        digests.push(sha);
    }
    std::fs::write(
        dir.join("catalog.json"),
        serde_json::to_vec_pretty(&catalog).unwrap(),
    )
    .unwrap();
    digests
}
/// A stand-in agent: records how the installer ran it and models setup's
/// read-only refusals before the installer may replace an enrolled build.
fn fake_agent(label: &str) -> Vec<u8> {
    let mut script = format!("#!/bin/sh\n# {label}\n");
    script.push_str(
        r#"printf '%s\n' "$@" > "$FAKE_AGENT_ARGS"
if [ -n "${FAKE_AGENT_CALLS:-}" ]; then printf '%s\n' "$*" >> "$FAKE_AGENT_CALLS"; fi
server= next= dry_run= staged=
for arg do
    if [ "$next" = server ]; then server=$arg; next=; continue; fi
    if [ "$next" = preflight ]; then staged=$arg; dry_run=1; next=; continue; fi
    case $arg in
        --server) next=server ;;
        --installer-preflight) next=preflight ;;
        --dry-run | -dry-run | --dry-run=1 | -dry-run=1 | --dry-run=t | -dry-run=t | --dry-run=T | -dry-run=T | --dry-run=true | -dry-run=true | --dry-run=TRUE | -dry-run=TRUE | --dry-run=True | -dry-run=True) dry_run=1 ;;
        --dry-run=0 | -dry-run=0 | --dry-run=f | -dry-run=f | --dry-run=F | -dry-run=F | --dry-run=false | -dry-run=false | --dry-run=FALSE | -dry-run=FALSE | --dry-run=False | -dry-run=False) dry_run= ;;
        --not-a-setup-option) echo 'unknown setup option' >&2; exit 2 ;;
    esac
done
if [ -n "$staged" ]; then
    [ -x "$staged" ] && cmp -s "$0" "$staged" || { echo 'bad staged agent' >&2; exit 7; }
    printf '%s\n' "$staged" > "$FAKE_PREFLIGHT_PATH"
    if [ -f "${FAKE_MUTATE_STAGE_FILE:-/nonexistent}" ]; then echo tampered > "$staged"; fi
fi
if [ -f "${FAKE_ENROLLED_SERVER_FILE:-/nonexistent}" ] && [ "$server" != "$(cat "$FAKE_ENROLLED_SERVER_FILE")" ]; then
    echo 'this host is enrolled with another server' >&2
    exit 1
fi
if [ -n "$dry_run" ] && [ -f "${FAKE_ATTENTION_FILE:-/nonexistent}" ]; then exit 3; fi
if [ -z "$dry_run" ] && [ -n "${FAKE_SETUP_STATE_FILE:-}" ]; then echo 'setup changed state' > "$FAKE_SETUP_STATE_FILE"; fi
if [ -z "$dry_run" ] && [ -f "${FAKE_FINAL_SETUP_SIGNAL_FILE:-/nonexistent}" ]; then
    kill -TERM "$PPID"
    exit 143
fi
if [ -z "$dry_run" ] && [ -f "${FAKE_FINAL_SETUP_FAILURE_FILE:-/nonexistent}" ]; then
    echo 'service start failed after setup changed state' >&2
    exit 9
fi
"#,
    );
    script.into_bytes()
}
/// A private agent CA and a server certificate chain that includes it.
fn chain(host: &str) -> (String, String) {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Onboarding test agent CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec![host.to_owned()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    (format!("{}{}", leaf.pem(), ca.pem()), db::hash(ca.der()))
}

struct Distribution {
    f: Fixture,
    ca_sha256: String,
    mirror_linux: Vec<u8>,
    mirror_linux_sha: String,
    bundled_darwin_sha: String,
}
async fn distribution(configure: impl FnOnce(&mut Settings)) -> Distribution {
    let (pem, ca_sha256) = chain("vectory.example.test");
    let mirror_linux = fake_agent("mirror linux/amd64 0.2.0");
    let mut digests = (Vec::new(), Vec::new());
    let f = fixture(|settings, root| {
        digests.0 = write_catalog(
            &root.join("bundled"),
            &[
                Build {
                    name: "vectory-0.1.0-linux-amd64",
                    os: "linux",
                    arch: "amd64",
                    version: "0.1.0",
                    bytes: fake_agent("bundled linux/amd64"),
                },
                Build {
                    name: "vectory-0.1.0-darwin-arm64",
                    os: "darwin",
                    arch: "arm64",
                    version: "0.1.0",
                    bytes: fake_agent("bundled darwin/arm64"),
                },
                Build {
                    name: "vectory-0.1.0-windows-amd64.exe",
                    os: "windows",
                    arch: "amd64",
                    version: "0.1.0",
                    bytes: b"MZ synthetic windows agent".to_vec(),
                },
            ],
        );
        digests.1 = write_catalog(
            &root.join("mirror"),
            &[Build {
                name: "vectory-0.2.0-linux-amd64",
                os: "linux",
                arch: "amd64",
                version: "0.2.0",
                bytes: mirror_linux.clone(),
            }],
        );
        settings.bundled_releases_dir = Some(root.join("bundled"));
        settings.agent_port = Some(8443);
        settings.agent_certificate_pem = Some(pem);
        settings.public_url = Some("https://vectory.example.test".into());
        configure(settings);
    })
    .await;
    Distribution {
        f,
        ca_sha256,
        mirror_linux,
        mirror_linux_sha: digests.1[0].clone(),
        bundled_darwin_sha: digests.0[1].clone(),
    }
}

#[tokio::test]
async fn the_mirror_overrides_bundled_builds_per_platform_and_downloads_stream_verified_bytes() {
    let d = distribution(|_| {}).await;
    let f = &d.f;
    let (status, _, bytes) = f
        .get(&f.api, "/api/v1/releases", "vectory.example.test")
        .await;
    assert_eq!(status, StatusCode::OK);
    let releases = json_of(&bytes);
    let summary: Vec<(String, String, String)> = releases
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                format!(
                    "{}/{}",
                    r["os"].as_str().unwrap(),
                    r["arch"].as_str().unwrap()
                ),
                r["version"].as_str().unwrap().to_owned(),
                r["source"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("linux/amd64".into(), "0.2.0".into(), "mirror".into()),
            ("darwin/arm64".into(), "0.1.0".into(), "bundled".into()),
            ("windows/amd64".into(), "0.1.0".into(), "bundled".into()),
        ]
    );

    let device = agent(&f.s);
    let (status, headers, body) = f
        .get(
            &device,
            "/agent/v1/downloads/linux/amd64",
            "vectory.example.test:8443",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, d.mirror_linux);
    assert_eq!(headers[header::ETAG], format!("\"{}\"", d.mirror_linux_sha));
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"vectory\""
    );
    assert_eq!(
        headers[header::CONTENT_LENGTH],
        d.mirror_linux.len().to_string()
    );
    let request = Request::builder()
        .uri("/agent/v1/downloads/linux/amd64")
        .header(header::IF_NONE_MATCH, format!("\"{}\"", d.mirror_linux_sha))
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(&device, request).await;
    assert_eq!((status, body.len()), (StatusCode::NOT_MODIFIED, 0));
    let (status, headers, _) = f
        .get(
            &device,
            "/agent/v1/downloads/windows/amd64",
            "vectory.example.test:8443",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"vectory.exe\""
    );
    for missing in [
        "/agent/v1/downloads/linux/arm64",
        "/agent/v1/downloads/plan9/amd64",
    ] {
        let (status, _, _) = f.get(&device, missing, "vectory.example.test:8443").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
    }

    // The dashboard download needs a session.
    let anonymous = Request::builder()
        .uri("/api/v1/releases/vectory-0.1.0-darwin-arm64")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&f.api, anonymous).await.0, StatusCode::UNAUTHORIZED);
    let (status, _, body) = f
        .get(
            &f.api,
            "/api/v1/releases/vectory-0.1.0-darwin-arm64",
            "vectory.example.test",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(db::hash(&body), d.bundled_darwin_sha);

    // A build whose bytes no longer match the catalog is never offered.
    let tampered = f.temp.path().join("bundled/vectory-0.1.0-darwin-arm64");
    let mut bytes = std::fs::read(&tampered).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&tampered, bytes).unwrap();
    let (status, _, _) = f
        .get(
            &device,
            "/agent/v1/downloads/darwin/arm64",
            "vectory.example.test:8443",
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, _, bytes) = f
        .get(&f.api, "/api/v1/agent-install", "vectory.example.test")
        .await;
    let problems = json_of(&bytes)["catalog_problems"].to_string();
    assert!(
        problems.contains("vectory-0.1.0-darwin-arm64"),
        "{problems}"
    );
}

#[tokio::test]
async fn the_installer_embeds_the_pin_and_digests_and_installs_only_verified_agents() {
    let d = distribution(|_| {}).await;
    let f = &d.f;
    let (token, _) = f.token(json!({"name":"Unused","expires_hours":1})).await;
    let (status, _, bytes) = f
        .get(&f.api, "/api/v1/agent-install", "vectory.example.test")
        .await;
    assert_eq!(status, StatusCode::OK);
    let details = json_of(&bytes);
    assert_eq!(details["agent_url"], "https://vectory.example.test:8443");
    assert_eq!(details["certificate"]["ca_sha256"], d.ca_sha256);
    assert_eq!(
        details["certificate"]["ca_name"],
        "Onboarding test agent CA"
    );
    assert_eq!(details["certificate"]["publicly_trusted"], false);
    // The CA certificate itself, for the command that fetches the installer:
    // exactly the certificate the fingerprint names.
    let ca_pem = details["certificate"]["ca_pem"]
        .as_str()
        .unwrap()
        .to_owned();
    {
        use rustls::pki_types::{CertificateDer, pem::PemObject};
        let der = CertificateDer::from_pem_slice(ca_pem.as_bytes()).unwrap();
        assert_eq!(db::hash(der.as_ref()), d.ca_sha256);
    }
    assert!(
        ca_pem.lines().all(|line| line
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=- ".contains(&b))),
        "the PEM must be safe to single-quote in a shell: {ca_pem}"
    );
    assert_eq!(
        details["installer"]["platforms"],
        json!(["linux/amd64", "darwin/arm64"])
    );

    let device = agent(&f.s);
    let (status, headers, script) = f
        .get(&device, "/agent/v1/install.sh", "vectory.example.test:8443")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    // Exactly the bytes whose SHA-256 Add device shows.
    assert_eq!(details["installer"]["sha256"], db::hash(&script));
    let script = String::from_utf8(script).unwrap();
    for expected in [
        "server='https://vectory.example.test:8443'".to_owned(),
        format!("ca_sha256='{}'", d.ca_sha256),
        "-----BEGIN CERTIFICATE-----".to_owned(),
        format!("linux/amd64) version='0.2.0' sha256={}", d.mirror_linux_sha),
        format!(
            "darwin/arm64) version='0.1.0' sha256={}",
            d.bundled_darwin_sha
        ),
        "dashboard='https://vectory.example.test'".to_owned(),
    ] {
        assert!(script.contains(&expected), "installer lacks {expected}");
    }
    assert!(!script.contains("windows/amd64)"));
    assert!(!script.contains(&token), "the installer holds a token");
    assert!(
        script.contains(ca_pem.trim_end()),
        "the installer lacks the CA"
    );
    // Nothing in the installer turns certificate verification off.
    for word in script.split_whitespace() {
        let word = word.trim_matches(|c| c == '\'' || c == '"');
        assert!(
            ![
                "--insecure",
                "--no-check-certificate",
                "-SkipCertificateCheck"
            ]
            .contains(&word),
            "the installer skips certificate checks: {word}"
        );
        // A cluster of short options such as -fsSg, never one with k.
        let short_options = word.len() > 1
            && word.starts_with('-')
            && !word.starts_with("--")
            && word[1..].chars().all(|c| c.is_ascii_alphabetic());
        assert!(
            !(short_options && word.contains('k')),
            "the installer passes a -k option: {word}"
        );
    }
    // HTTP/2 clients name the host in the request URI instead of a Host header.
    let http2 = Request::builder()
        .uri("https://vectory.example.test:8443/agent/v1/install.sh")
        .body(Body::empty())
        .unwrap();
    let (status, _, same) = send(&device, http2).await;
    assert_eq!(
        (status, same),
        (StatusCode::OK, script.clone().into_bytes())
    );

    // The assertions above also run on Windows. The rest executes a POSIX
    // installer using Unix paths and permissions; Linux and macOS CI exercise
    // its install, rejection, and dry-run behavior.
    if !cfg!(unix) {
        return;
    }

    // It is valid POSIX sh and does what it says.
    let root = f.temp.path().join("installer");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let path = root.join("vectory-install.sh");
    std::fs::write(&path, &script).unwrap();
    let help = std::process::Command::new("sh")
        .arg(&path)
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success(), "{help:?}");
    let help_text = String::from_utf8_lossy(&help.stdout);
    assert!(
        help_text.contains("--ca-sha256 changes setup's pin only")
            && help_text.contains("--ca-file PATH so the download can trust the new CA"),
        "{help_text}"
    );
    for shell in ["sh", "dash", "bash"] {
        if let Ok(status) = std::process::Command::new(shell)
            .arg("-n")
            .arg(&path)
            .status()
        {
            assert!(status.success(), "{shell} rejects the installer");
        }
    }
    // Stand-ins for uname and curl: a Linux x86-64 host whose download is
    // served from a local file, recording the URL and the CA it was told to use.
    let fake = |name: &str, body: &str| {
        let file = root.join("bin").join(name);
        std::fs::write(&file, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    };
    fake(
        "uname",
        "#!/bin/sh\ncase $1 in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n",
    );
    fake(
        "curl",
        "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$FAKE_CURL_ARGS\"\nout= ca= url=\nwhile [ $# -gt 0 ]; do case $1 in -o) out=$2; shift ;; --cacert) ca=$2; shift ;; --proto | --connect-timeout | --retry | --retry-max-time) shift ;; -*) ;; *) url=$1 ;; esac; shift; done\nprintf '%s\\n' \"$url\" > \"$FAKE_CURL_URL\"\nif [ -n \"$ca\" ]; then cp \"$ca\" \"$FAKE_CURL_CA\" || exit 60; else echo 'system trust' > \"$FAKE_CURL_CA\"; fi\nif [ -f \"$FAKE_CURL_REFUSE_FILE\" ]; then exit 60; fi\ncp \"$FAKE_DOWNLOAD\" \"$out\"\n",
    );
    let download = root.join("download");
    let run_with = |bytes: &[u8], install_dir: &Path, extra: &[&str]| {
        std::fs::write(&download, bytes).unwrap();
        // A hardened host's root umask must not hide the agent from the
        // service account.
        std::process::Command::new("sh")
            .args(["-c", "umask 077; exec sh \"$0\" \"$@\""])
            .arg(&path)
            .args(["--install-dir"])
            .arg(install_dir)
            .args(["--name", "edge 42", "--service", "none"])
            .args(extra)
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    root.join("bin").display(),
                    std::env::var("PATH").unwrap_or_default()
                ),
            )
            .env("FAKE_DOWNLOAD", &download)
            .env("FAKE_CURL_URL", root.join("curl-url"))
            .env("FAKE_CURL_ARGS", root.join("curl-args"))
            .env("FAKE_CURL_CA", root.join("curl-ca.pem"))
            .env("FAKE_CURL_REFUSE_FILE", root.join("curl-refuse"))
            .env("FAKE_AGENT_ARGS", root.join("agent-args"))
            .env("FAKE_AGENT_CALLS", root.join("agent-calls"))
            .env("FAKE_PREFLIGHT_PATH", root.join("preflight-path"))
            .env("FAKE_MUTATE_STAGE_FILE", root.join("mutate-stage"))
            .env("FAKE_ENROLLED_SERVER_FILE", root.join("enrolled-server"))
            .env("FAKE_ATTENTION_FILE", root.join("attention"))
            .env("FAKE_SETUP_STATE_FILE", root.join("setup-state"))
            .env(
                "FAKE_FINAL_SETUP_FAILURE_FILE",
                root.join("final-setup-failure"),
            )
            .env(
                "FAKE_FINAL_SETUP_SIGNAL_FILE",
                root.join("final-setup-signal"),
            )
            .output()
            .unwrap()
    };
    let run = |bytes: &[u8], install_dir: &Path| run_with(bytes, install_dir, &[]);
    // A download that doesn't match the embedded SHA-256 installs nothing.
    let rejected = root.join("rejected");
    let output = run(b"#!/bin/sh\necho tampered\n", &rejected);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("doesn't match its SHA-256"),
        "{output:?}"
    );
    assert!(!rejected.join("vectory").exists());

    let installed = root.join("installed");
    let output = run(&d.mirror_linux, &installed);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("installed at"), "{stdout}");
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    let calls: Vec<&str> = calls.lines().collect();
    assert_eq!(
        calls.len(),
        2,
        "preflight and real setup must both run: {calls:?}"
    );
    assert!(calls[0].contains(" --installer-preflight "), "{calls:?}");
    assert!(!calls[1].contains("--installer-preflight"), "{calls:?}");
    let staged = std::fs::read_to_string(root.join("preflight-path")).unwrap();
    assert!(
        !Path::new(staged.trim()).exists(),
        "staged file was not removed"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(installed.join("vectory"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755, "installed agent mode under umask 077");
    }
    assert_eq!(
        std::fs::read_to_string(root.join("curl-url"))
            .unwrap()
            .trim(),
        "https://vectory.example.test:8443/agent/v1/downloads/linux/amd64"
    );
    let ca = std::fs::read_to_string(root.join("curl-ca.pem")).unwrap();
    assert!(ca.starts_with("-----BEGIN CERTIFICATE-----"));
    // HTTPS only, and a busy server's Retry-After is waited out.
    let curl = std::fs::read_to_string(root.join("curl-args")).unwrap();
    assert!(
        curl.contains("--proto =https") && curl.contains("--retry 6"),
        "{curl}"
    );
    let args = std::fs::read_to_string(root.join("agent-args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    let agent_path = installed.join("vectory").display().to_string();
    assert_eq!(
        args,
        vec![
            "setup",
            "--server",
            "https://vectory.example.test:8443",
            "--agent-path",
            &agent_path,
            "--ca-sha256",
            &d.ca_sha256,
            "--dashboard-url",
            "https://vectory.example.test",
            "--name",
            "edge 42",
            "--service",
            "none",
        ]
    );
    // Go's boolean flags accept numeric values and the last value wins.
    let false_last = root.join("false-last");
    let output = run_with(
        &d.mirror_linux,
        &false_last,
        &["-dry-run=1", "-dry-run=false"],
    );
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read(false_last.join("vectory")).unwrap(),
        d.mirror_linux
    );
    // The operator's own trust choice replaces the pin, for the download and
    // for setup: a CA certificate file on the host, or its trusted certificates.
    let own_ca = root.join("own-ca.pem");
    std::fs::write(&own_ca, &ca_pem).unwrap();
    let own_ca_path = own_ca.display().to_string();
    let output = run_with(
        &d.mirror_linux,
        &root.join("with-ca-file"),
        &["--ca-file", &own_ca_path],
    );
    assert!(output.status.success(), "{output:?}");
    let curl = std::fs::read_to_string(root.join("curl-args")).unwrap();
    assert!(
        curl.contains(&format!("--cacert {own_ca_path}")),
        "the download must use the named CA: {curl}"
    );
    let args = std::fs::read_to_string(root.join("agent-args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--ca-file", own_ca_path.as_str()])
            && !args.contains(&"--ca-sha256"),
        "{args:?}"
    );
    let output = run_with(&d.mirror_linux, &root.join("system-trust"), &["--ca-file="]);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("curl-ca.pem"))
            .unwrap()
            .trim(),
        "system trust",
        "--ca-file= downloads with this host's trusted certificates"
    );
    let args = std::fs::read_to_string(root.join("agent-args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert!(
        args.contains(&"--ca-file=") && !args.contains(&"--ca-sha256"),
        "{args:?}"
    );
    let missing = root.join("no-such-ca.pem").display().to_string();
    let output = run_with(
        &d.mirror_linux,
        &root.join("missing-ca"),
        &["--ca-file", &missing],
    );
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains(&format!("Can't read the CA certificate {missing}.")),
        "{output:?}"
    );
    assert!(!root.join("missing-ca").join("vectory").exists());
    // A fingerprint alone cannot supply curl with a rotated private CA.
    // The failed download keeps the embedded CA check and explains the
    // certificate the operator must provide for that trust change.
    std::fs::write(root.join("curl-refuse"), "1").unwrap();
    let new_pin = "a".repeat(64);
    let output = run_with(
        &d.mirror_linux,
        &root.join("rotated-ca"),
        &["--ca-sha256", &new_pin],
    );
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("--ca-sha256 alone changes setup trust, not download trust"),
        "{output:?}"
    );
    assert!(
        std::fs::read_to_string(root.join("curl-ca.pem"))
            .unwrap()
            .starts_with("-----BEGIN CERTIFICATE-----"),
        "the SHA-only override bypassed the embedded CA for download"
    );
    assert!(!root.join("rotated-ca").join("vectory").exists());
    std::fs::remove_file(root.join("curl-refuse")).unwrap();
    // A dry run installs nothing and plans for the directory that was chosen,
    // not the default one.
    let planned = root.join("planned");
    let output = run_with(&d.mirror_linux, &planned, &["--dry-run"]);
    assert!(output.status.success(), "{output:?}");
    assert!(!planned.join("vectory").exists());
    let dry = std::fs::read_to_string(root.join("agent-args")).unwrap();
    let dry: Vec<&str> = dry.lines().collect();
    let planned_path = planned.join("vectory").display().to_string();
    assert!(
        dry.windows(2)
            .any(|pair| pair == ["--agent-path", planned_path.as_str()]),
        "{dry:?}"
    );
    assert!(dry.contains(&"--dry-run"), "{dry:?}");
    // The dry run checks, as the real run would, that the directory can be
    // created there, and changes nothing: /proc refuses even root, whose
    // `test -w` would pass.
    #[cfg(target_os = "linux")]
    {
        std::fs::remove_file(root.join("agent-args")).unwrap();
        let nope = Path::new("/proc/vectory-dry-run-nope/bin");
        let output = run_with(&d.mirror_linux, nope, &["--dry-run"]);
        assert!(!output.status.success(), "{output:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("[!!] Agent        Can't write to /proc/vectory-dry-run-nope/bin.")
                && stderr.contains("choose a directory with --install-dir"),
            "{stderr}"
        );
        assert!(
            !root.join("agent-args").exists(),
            "setup ran after a failed check"
        );
        let writable = root.join("dry-run-probe").join("bin");
        let output = run_with(&d.mirror_linux, &writable, &["--dry-run"]);
        assert!(output.status.success(), "{output:?}");
        assert!(
            !root.join("dry-run-probe").exists(),
            "the dry run left its probe behind"
        );
    }
    // Running it again verifies the installed agent instead of downloading.
    std::fs::remove_file(root.join("curl-url")).unwrap();
    let output = run(b"unused", &installed);
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("is already 0.2.0"));
    assert!(!root.join("curl-url").exists());
    // A matching but non-executable target must not be silently chmodded
    // before setup rejects it; its original mode belongs to the host.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let agent = installed.join("vectory");
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o644)).unwrap();
        let output = run(b"unused", &installed);
        assert_eq!(output.status.code(), Some(126), "{output:?}");
        assert_eq!(
            std::fs::metadata(&agent).unwrap().permissions().mode() & 0o777,
            0o644,
            "the same-SHA path changed the existing executable's mode"
        );
        std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Upgrade agent (the device page) runs the same installer with only where
    // the device keeps its state and what keeps it running: an older agent is
    // replaced, and setup, which finds the enrolled state, gets no name, mode
    // or token to change.
    let older = fake_agent("older build");
    std::fs::write(installed.join("vectory"), &older).unwrap();
    std::fs::write(root.join("setup-state"), "existing state").unwrap();
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    let output = run_with(&d.mirror_linux, &installed, &["--dry-run=1"]);
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("would be installed"));
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert_eq!(
        std::fs::read(root.join("setup-state")).unwrap(),
        b"existing state"
    );
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    assert_eq!(
        calls.lines().count(),
        1,
        "dry run invoked real setup: {calls}"
    );
    assert!(calls.contains("--dry-run=1"), "{calls}");
    for option in ["-dry-run=1", "-dry-run=TRUE"] {
        std::fs::remove_file(root.join("agent-calls")).unwrap();
        let output = run_with(&d.mirror_linux, &installed, &[option]);
        assert!(output.status.success(), "{option}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("would be installed"));
        assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
        assert_eq!(
            std::fs::read(root.join("setup-state")).unwrap(),
            b"existing state"
        );
        let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
        assert_eq!(calls.lines().count(), 1, "{option} ran real setup: {calls}");
    }
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    for (option, message) in [
        (
            "-installer-preflight=/tmp/untrusted",
            "reserved for the installer",
        ),
        (
            "--server=https://other.example.test",
            "set by this installer",
        ),
        ("-agent-path=/tmp/untrusted", "set by --install-dir"),
    ] {
        let output = run_with(&d.mirror_linux, &installed, &[option]);
        assert!(!output.status.success(), "{option}: {output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(message),
            "{option}: {output:?}"
        );
    }
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert!(!root.join("agent-calls").exists());
    // A candidate changed after the agent's preflight cannot be promoted.
    std::fs::write(root.join("mutate-stage"), "1").unwrap();
    let output = run(&d.mirror_linux, &installed);
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("staged agent changed"),
        "{output:?}"
    );
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert_eq!(
        std::fs::read(root.join("setup-state")).unwrap(),
        b"existing state"
    );
    let staged = std::fs::read_to_string(root.join("preflight-path")).unwrap();
    assert!(
        !Path::new(staged.trim()).exists(),
        "tampered stage was not removed"
    );
    std::fs::remove_file(root.join("mutate-stage")).unwrap();
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    // An enrolled host's refusal must come from the verified temporary agent
    // while the old executable is still stable. The same applies to a setup
    // option the new agent rejects before it can change state.
    std::fs::write(
        root.join("enrolled-server"),
        "https://old.example.test:8443\n",
    )
    .unwrap();
    let output = run(&d.mirror_linux, &installed);
    assert!(!output.status.success(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("enrolled with another server") && stderr.contains("was not replaced"),
        "{stderr}"
    );
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert_eq!(
        std::fs::read(root.join("setup-state")).unwrap(),
        b"existing state"
    );
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    assert_eq!(calls.lines().count(), 1, "setup ran after refusal: {calls}");
    assert!(calls.contains("--installer-preflight"), "{calls}");
    std::fs::remove_file(root.join("enrolled-server")).unwrap();
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    let output = run_with(&d.mirror_linux, &installed, &["--not-a-setup-option"]);
    assert!(!output.status.success(), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unknown setup option") && stderr.contains("was not replaced"),
        "{stderr}"
    );
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert_eq!(
        std::fs::read(root.join("setup-state")).unwrap(),
        b"existing state"
    );
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    assert_eq!(calls.lines().count(), 1, "setup ran after refusal: {calls}");
    assert!(calls.contains("--installer-preflight"), "{calls}");
    assert!(
        std::fs::read_dir(&installed).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vectory.new.")),
        "a refused preflight left an install candidate behind"
    );
    // A later setup failure can follow partial state/service work. Restore
    // the exact old executable for the next restart, and tell the operator
    // to inspect the state and service instead of claiming they rolled back.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            installed.join("vectory"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    std::fs::write(root.join("final-setup-failure"), "1").unwrap();
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    let output = run(&d.mirror_linux, &installed);
    assert_eq!(output.status.code(), Some(9), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stdout.contains("restored the previous executable"),
        "{output:?}"
    );
    assert!(
        stderr.contains("Setup may have changed host state or service status"),
        "{output:?}"
    );
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(installed.join("vectory"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "rollback did not preserve the previous executable's mode"
        );
    }
    assert_eq!(
        std::fs::read(root.join("setup-state")).unwrap(),
        b"setup changed state\n",
        "the fixture must model the partial mutation this warning describes"
    );
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    assert_eq!(calls.lines().count(), 2, "real setup did not run: {calls}");
    assert!(
        std::fs::read_dir(&installed).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".vectory.")),
        "a failed final setup left a staged agent or rollback file"
    );
    let failed_first = root.join("failed-first-install");
    let output = run(&d.mirror_linux, &failed_first);
    assert_eq!(output.status.code(), Some(9), "{output:?}");
    assert!(!failed_first.join("vectory").exists());
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("removed the newly installed"),
        "{output:?}"
    );
    std::fs::remove_file(root.join("final-setup-failure")).unwrap();
    // An interrupted final setup also restores the old executable through
    // the EXIT trap, after the shell has handled the signal.
    std::fs::write(root.join("final-setup-signal"), "1").unwrap();
    let output = run(&d.mirror_linux, &installed);
    assert_eq!(output.status.code(), Some(130), "{output:?}");
    assert_eq!(std::fs::read(installed.join("vectory")).unwrap(), older);
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("restored the previous executable"),
        "{output:?}"
    );
    std::fs::remove_file(root.join("final-setup-signal")).unwrap();
    // Exit 3 from a dry run means the plan needs a manually managed service;
    // it is not a refusal, so the installer must still run real setup.
    std::fs::write(root.join("attention"), "1").unwrap();
    std::fs::remove_file(root.join("agent-calls")).unwrap();
    let output = run(&d.mirror_linux, &installed);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        std::fs::read(installed.join("vectory")).unwrap(),
        d.mirror_linux
    );
    let calls = std::fs::read_to_string(root.join("agent-calls")).unwrap();
    assert_eq!(
        calls.lines().count(),
        2,
        "exit 3 stopped installation: {calls}"
    );
    std::fs::remove_file(root.join("attention")).unwrap();
    std::fs::write(installed.join("vectory"), &older).unwrap();
    std::fs::write(&download, &d.mirror_linux).unwrap();
    let output = std::process::Command::new("sh")
        .arg(&path)
        .arg("--install-dir")
        .arg(&installed)
        .args(["--state-dir", "/srv/vectory state", "--service", "none"])
        .env(
            "PATH",
            format!(
                "{}:{}",
                root.join("bin").display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        )
        .env("FAKE_DOWNLOAD", &download)
        .env("FAKE_CURL_URL", root.join("curl-url"))
        .env("FAKE_CURL_ARGS", root.join("curl-args"))
        .env("FAKE_CURL_CA", root.join("curl-ca.pem"))
        .env("FAKE_AGENT_ARGS", root.join("agent-args"))
        .env("FAKE_AGENT_CALLS", root.join("agent-calls"))
        .env("FAKE_PREFLIGHT_PATH", root.join("preflight-path"))
        .env("FAKE_MUTATE_STAGE_FILE", root.join("mutate-stage"))
        .env("FAKE_ENROLLED_SERVER_FILE", root.join("enrolled-server"))
        .env("FAKE_ATTENTION_FILE", root.join("attention"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("installed at"));
    assert_eq!(
        std::fs::read(installed.join("vectory")).unwrap(),
        d.mirror_linux,
        "the older agent was not replaced"
    );
    let args = std::fs::read_to_string(root.join("agent-args")).unwrap();
    let args: Vec<&str> = args.lines().collect();
    assert_eq!(
        args,
        vec![
            "setup",
            "--server",
            "https://vectory.example.test:8443",
            "--agent-path",
            &agent_path,
            "--ca-sha256",
            &d.ca_sha256,
            "--dashboard-url",
            "https://vectory.example.test",
            "--state-dir",
            "/srv/vectory state",
            "--service",
            "none",
        ]
    );
}

#[tokio::test]
async fn hardened_sites_can_turn_off_public_downloads() {
    let d = distribution(|settings| {
        settings.disable_public_agent_downloads = true;
        settings.public_agent_url = Some("https://agents.example.test:9443".into());
    })
    .await;
    let f = &d.f;
    let device = agent(&f.s);
    for path in ["/agent/v1/install.sh", "/agent/v1/downloads/linux/amd64"] {
        let (status, _, _) = f.get(&device, path, "agents.example.test:9443").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let (_, _, bytes) = f
        .get(&f.api, "/api/v1/agent-install", "vectory.example.test")
        .await;
    let details = json_of(&bytes);
    assert_eq!(details["downloads_enabled"], false);
    assert_eq!(details["installer"], Value::Null);
    assert_eq!(details["agent_url"], "https://agents.example.test:9443");
    assert_eq!(details["agent_url_configured"], true);
    // Signed-in users can still download builds from the dashboard.
    let (status, _, _) = f
        .get(
            &f.api,
            "/api/v1/releases/vectory-0.2.0-linux-amd64",
            "vectory.example.test",
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn doctor_can_prove_a_credential_and_the_token_list_shows_its_devices() {
    let f = fixture(|_, _| {}).await;
    let (token, token_id) = f
        .token(json!({"name":"Rack 7","expires_hours":1,"max_uses":5}))
        .await;
    let (status, credential) = f
        .enroll(&enrollment(&token, "doctor-1", "rack-7-a", &csr()))
        .await;
    assert_eq!(status, StatusCode::OK);
    let device_id = credential["device_id"].as_str().unwrap();
    let fingerprint: String =
        sqlx::query_scalar("SELECT fingerprint FROM credentials WHERE device_id=?")
            .bind(device_id)
            .fetch_one(&f.s.pool)
            .await
            .unwrap();
    let authenticated =
        device::router(f.s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))));
    let (status, _, bytes) = f
        .get(&authenticated, "/agent/v1/identity", "vectory.example.test")
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        json_of(&bytes),
        json!({"device_id":device_id,"name":"rack-7-a"})
    );
    let anonymous = device::router(f.s.clone()).layer(Extension(device::PeerCertificate(None)));
    let (status, _, _) = f
        .get(&anonymous, "/agent/v1/identity", "vectory.example.test")
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, bytes) = f
        .get(&f.api, "/api/v1/tokens", "vectory.example.test")
        .await;
    assert_eq!(status, StatusCode::OK);
    let tokens = json_of(&bytes);
    let listed = tokens
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == token_id.as_str())
        .unwrap();
    assert_eq!(
        listed["created_by"],
        json!({"id":f.admin,"name":"Ada Admin"})
    );
    assert_eq!(listed["device_count"], 1);
    assert_eq!(listed["devices"][0]["id"], device_id);
    assert_eq!(listed["devices"][0]["name"], "rack-7-a");
    assert_eq!(listed["devices"][0]["revoked"], false);
    assert!(listed["last_used_at"].is_string());
}

#[tokio::test]
async fn one_noisy_client_cannot_block_enrollment_for_the_fleet() {
    let f = fixture(|_, _| {}).await;
    let junk = json!({"protocol_version":1,"token":"0".repeat(64)});
    let post = |router: Router| {
        let junk = junk.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri("/agent/v1/enroll")
                .header("content-type", "application/json")
                .body(Body::from(junk.to_string()))
                .unwrap();
            send(&router, request).await.0
        }
    };
    let noisy = agent(&f.s);
    for _ in 0..60 {
        assert_eq!(post(noisy.clone()).await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(post(noisy.clone()).await, StatusCode::TOO_MANY_REQUESTS);
    let neighbour = device::router(f.s.clone()).layer(Extension(ConnectInfo(SocketAddr::from((
        [10, 0, 4, 18],
        50124,
    )))));
    assert_eq!(post(neighbour).await, StatusCode::UNAUTHORIZED);
    // 61 junk attempts left one audit row, not 61.
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.enroll'",
    )
    .fetch_one(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(audited, 2, "one per client and reason each minute");
}

async fn audited(s: &State, action: &str) -> Vec<Value> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT r.data FROM audit_sequence q JOIN records r ON r.kind='audit' AND r.id=q.audit_id WHERE json_extract(r.data,'$.action')=? ORDER BY q.sequence",
    )
    .bind(action)
    .fetch_all(&s.pool)
    .await
    .unwrap();
    rows.iter().map(|row| json_of(row.as_bytes())).collect()
}

// Refusals from many addresses are each written once a minute, but all clients
// together write at most the shared number of rows: the rest are counted, and
// one row for the minute says how many, once.
#[tokio::test]
async fn refusals_from_many_addresses_write_a_bounded_number_of_rows_and_one_summary() {
    use vectory_server::enrollment_audit::{
        REFUSAL_ROWS_PER_MINUTE, SUMMARY_ACTION, record_at, settle,
    };
    let f = fixture(|_, _| {}).await;
    // A minute long past, so no timer for the current minute is involved.
    let minute = chrono::DateTime::parse_from_rfc3339("2020-02-02T04:06:20Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let refusal = |n: u32| json!({"reason_code":"TOKEN_UNKNOWN","client_address":format!("10.9.{}.{}", n / 250, n % 250)});
    for n in 0..300 {
        record_at(&f.s, refusal(n), minute).await.unwrap();
    }
    assert_eq!(
        audited(&f.s, "device.enroll").await.len(),
        REFUSAL_ROWS_PER_MINUTE as usize,
        "the shared budget of a minute"
    );
    // The row for what was left out is written when the minute is settled,
    // once, and never for a minute that left nothing out.
    assert!(audited(&f.s, SUMMARY_ACTION).await.is_empty());
    let key = minute.timestamp().div_euclid(60);
    settle(&f.s, key).await.unwrap();
    settle(&f.s, key).await.unwrap();
    settle(&f.s, key - 5).await.unwrap();
    let summaries = audited(&f.s, SUMMARY_ACTION).await;
    assert_eq!(summaries.len(), 1);
    assert_eq!(
        summaries[0]["details"]["summary"],
        "240 further refusals in the minute from 04:06 UTC were not written"
    );
    assert_eq!(summaries[0]["actor"], "anonymous");
    // The next minute has its own budget, and settles the one before it only
    // once.
    for n in 0..70 {
        record_at(&f.s, refusal(n), minute + chrono::Duration::seconds(60))
            .await
            .unwrap();
    }
    assert_eq!(
        audited(&f.s, "device.enroll").await.len(),
        2 * REFUSAL_ROWS_PER_MINUTE as usize
    );
    assert_eq!(audited(&f.s, SUMMARY_ACTION).await.len(), 1);
    settle(&f.s, key + 1).await.unwrap();
    let summaries = audited(&f.s, SUMMARY_ACTION).await;
    assert_eq!(summaries.len(), 2);
    assert_eq!(
        summaries[1]["details"]["summary"],
        "10 further refusals in the minute from 04:07 UTC were not written"
    );
    // The log names it for what it is, and shows the sentence.
    let history = f
        .get(
            &f.api,
            &format!("/api/v1/audit/history?action={SUMMARY_ACTION}"),
            "vectory.example.test",
        )
        .await;
    assert_eq!(history.0, StatusCode::OK);
    assert_eq!(json_of(&history.2)["total"], 2);
}

// The route itself: every refusal is either a row or counted in a summary.
#[tokio::test]
async fn every_refusal_from_a_flood_of_addresses_is_a_row_or_in_a_summary() {
    use vectory_server::enrollment_audit::{REFUSAL_ROWS_PER_MINUTE, SUMMARY_ACTION, settle};
    let f = fixture(|_, _| {}).await;
    let device = device::router(f.s.clone());
    let junk = json!({"protocol_version":1,"token":"0".repeat(64)});
    let total = REFUSAL_ROWS_PER_MINUTE + 70;
    for n in 0..total {
        // Every request comes from a different address.
        let [_, a, b, c] = n.to_be_bytes();
        let mut request = Request::builder()
            .method("POST")
            .uri("/agent/v1/enroll")
            .header("content-type", "application/json")
            .body(Body::from(junk.to_string()))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::from(([10, a, b, c], 40000))));
        assert_eq!(send(&device, request).await.0, StatusCode::UNAUTHORIZED);
    }
    let now = chrono::Utc::now().timestamp().div_euclid(60);
    for minute in [now - 1, now] {
        settle(&f.s, minute).await.unwrap();
    }
    let written = audited(&f.s, "device.enroll").await.len();
    let left_out: usize = audited(&f.s, SUMMARY_ACTION)
        .await
        .iter()
        .map(|row| {
            row["details"]["summary"]
                .as_str()
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .parse::<usize>()
                .unwrap()
        })
        .sum();
    assert!(
        written < total as usize,
        "{written} rows for {total} refusals"
    );
    assert_eq!(written + left_out, total as usize);
}

#[tokio::test]
async fn repeated_refusals_for_a_real_token_are_recorded_once_per_reason_and_minute() {
    let f = fixture(|_, _| {}).await;
    let (revoked, revoked_id) = f
        .token(json!({"name":"Revoked","expires_hours":1,"max_uses":5}))
        .await;
    let (status, _) = f
        .post(&format!("/api/v1/tokens/{revoked_id}/revoke"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (single, single_id) = f
        .token(json!({"name":"Single","expires_hours":1,"max_uses":1}))
        .await;
    let (status, _) = f
        .enroll(&enrollment(&single, "request-first", "edge-01", &csr()))
        .await;
    assert_eq!(status, StatusCode::OK);

    // A host that keeps retrying, or someone holding a dead token, is refused
    // every time and recorded once for each reason.
    for n in 0..40 {
        let body = enrollment(&revoked, &format!("revoked-{n}"), "edge-02", &csr());
        assert_eq!(
            f.enroll(&body).await,
            (StatusCode::UNAUTHORIZED, generic_refusal())
        );
    }
    for n in 0..15 {
        let body = enrollment(&single, &format!("exhausted-{n}"), "edge-03", &csr());
        assert_eq!(
            f.enroll(&body).await,
            (StatusCode::UNAUTHORIZED, generic_refusal())
        );
    }
    let failures: Vec<Value> = f
        .activity()
        .await
        .into_iter()
        .filter(|event| event["outcome"] == "failure")
        .collect();
    let mut recorded: Vec<(String, String)> = failures
        .iter()
        .map(|event| {
            (
                event["token_id"].as_str().unwrap().to_owned(),
                event["reason_code"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    recorded.sort();
    let mut expected = vec![
        (revoked_id, "TOKEN_REVOKED".to_owned()),
        (single_id, "TOKEN_EXHAUSTED".to_owned()),
    ];
    expected.sort();
    assert_eq!(recorded, expected);
    let audited: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.enroll'",
    )
    .fetch_one(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(audited, 3, "the enrollment and one refusal for each reason");
}

#[tokio::test]
async fn installer_and_download_floods_from_many_addresses_share_one_budget() {
    let f = fixture(|_, _| {}).await;
    let device = device::router(f.s.clone());
    for path in ["/agent/v1/install.sh", "/agent/v1/downloads/linux/amd64"] {
        let mut refused = None;
        for n in 0..1300u32 {
            // Every request comes from a different address.
            let [_, a, b, c] = n.to_be_bytes();
            let mut request = Request::builder()
                .uri(path)
                .header(header::HOST, "vectory.example.test:8443")
                .body(Body::empty())
                .unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([10, a, b, c], 40000))));
            let (status, headers, _) = send(&device, request).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                refused = Some((n, headers));
                break;
            }
        }
        let (n, headers) = refused.unwrap_or_else(|| panic!("{path} has no global cap"));
        assert_eq!(n, 1200, "{path}: 1200 a minute from every address together");
        assert!(headers.contains_key("retry-after"), "{path}");
    }
    // None of it landed where sign-in keys live.
    assert_eq!(f.s.limits.lock().unwrap().len(), 0);
}

#[tokio::test]
async fn a_token_made_for_a_typed_name_enrolls_only_that_device() {
    let f = fixture(|_, _| {}).await;
    let (status, created) = f
        .post(
            "/api/v1/tokens",
            json!({"name":"Edge-7 install command","expires_hours":1,"max_uses":2,"device_name":" Edge-7 "}),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // Normalized as enrollment normalizes names, and echoed so the page can
    // tell a binding server from one that ignores the field.
    assert_eq!(created["record"]["device_name"], "edge-7");
    let token = created["token"].as_str().unwrap().to_owned();
    let (status, _) = f
        .enroll(&enrollment(&token, "request-other", "edge-8", &csr()))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let refusal = f
        .activity()
        .await
        .into_iter()
        .find(|event| event["device_name"] == "edge-8")
        .unwrap();
    assert_eq!(refusal["reason_code"], "DEVICE_NAME_MISMATCH");
    let (status, enrolled) = f
        .enroll(&enrollment(&token, "request-named", "EDGE-7", &csr()))
        .await;
    assert_eq!(status, StatusCode::OK, "{enrolled}");
    // The token list shows the binding.
    let (_, _, bytes) = f
        .get(&f.api, "/api/v1/tokens", "vectory.example.test")
        .await;
    let listed = json_of(&bytes)
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == created["record"]["id"])
        .cloned()
        .unwrap();
    assert_eq!(listed["device_name"], "edge-7");
    // A name the token could never enroll is refused at creation.
    for bad in [
        json!({"name":"Bad","expires_hours":1,"device_name":"-edge"}),
        json!({"name":"Bad","expires_hours":1,"device_name":"edge 7"}),
        json!({"name":"Bad","expires_hours":1,"device_name":7}),
        json!({"name":"Bad","expires_hours":1,"device_name":"db-1","name_prefix":"web-"}),
    ] {
        let (status, _) = f.post("/api/v1/tokens", bad.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
    }
    // Without a name, a token enrolls any unique name as before.
    let (status, open) = f
        .post("/api/v1/tokens", json!({"name":"Open","expires_hours":1}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(open["record"].get("device_name").is_none());
}

#[tokio::test]
async fn anonymous_agent_mutations_do_not_wait_for_the_writer() {
    let f = fixture(|_, _| {}).await;
    // Enrollment requires anonymous TLS access to the agent listener, but an
    // unauthenticated heartbeat or renewal must not queue behind the shared
    // SQLite writer.
    let held_writer = db::writer(&f.s).await;
    let anonymous = agent(&f.s).layer(Extension(device::PeerCertificate(None)));
    for path in ["/agent/v1/heartbeat", "/agent/v1/renew"] {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), send(&anonymous, request))
                .await;
        let (status, _, _) =
            result.unwrap_or_else(|_| panic!("{path} queued behind the writer lock"));
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
    drop(held_writer);
}

#[tokio::test]
async fn agent_mutations_recheck_revocation_after_waiting_for_the_writer() {
    for (path, budget_prefix) in [
        ("/agent/v1/heartbeat", "heartbeat"),
        ("/agent/v1/renew", "renew"),
    ] {
        let f = fixture(|_, _| {}).await;
        let (token, _) = f
            .token(json!({"name":"Revocation race","expires_hours":1,"max_uses":1}))
            .await;
        let (status, enrolled) = f
            .enroll(&enrollment(&token, "revocation-race", "race-01", &csr()))
            .await;
        assert_eq!(status, StatusCode::OK, "{enrolled}");
        let id = enrolled["device_id"].as_str().unwrap().to_owned();
        let fingerprint: String =
            sqlx::query_scalar("SELECT fingerprint FROM credentials WHERE device_id=?")
                .bind(&id)
                .fetch_one(&f.s.pool)
                .await
                .unwrap();

        let held_writer = db::writer(&f.s).await;
        let authenticated =
            agent(&f.s).layer(Extension(device::PeerCertificate(Some(fingerprint))));
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let pending = tokio::spawn(async move { send(&authenticated, request).await });
        // Observe the pre-lock admission, then simulate a revocation that
        // commits while this request waits. The second read must reject it.
        let budget = format!("{budget_prefix}:{id}");
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while f.s.counted(&budget) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{path} did not authenticate before waiting for the writer"));
        sqlx::query("UPDATE credentials SET revoked=1 WHERE device_id=?")
            .bind(&id)
            .execute(&f.s.pool)
            .await
            .unwrap();
        drop(held_writer);
        let (status, _, _) = pending.await.unwrap();
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }
}
