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
    assert_eq!(failures.len(), attempts.len());
    for (event, (body, reason, token)) in failures.iter().zip(&attempts) {
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
    let id = failures[2]["id"].as_str().unwrap();
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
/// A stand-in agent: records how the installer ran it.
fn fake_agent(label: &str) -> Vec<u8> {
    format!("#!/bin/sh\n# {label}\nprintf '%s\\n' \"$@\" > \"$FAKE_AGENT_ARGS\"\n").into_bytes()
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

    // It is valid POSIX sh and does what it says.
    let root = f.temp.path().join("installer");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    let path = root.join("vectory-install.sh");
    std::fs::write(&path, &script).unwrap();
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
        "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$FAKE_CURL_ARGS\"\nout= ca= url=\nwhile [ $# -gt 0 ]; do case $1 in -o) out=$2; shift ;; --cacert) ca=$2; shift ;; --proto | --connect-timeout | --retry | --retry-max-time) shift ;; -*) ;; *) url=$1 ;; esac; shift; done\nprintf '%s\\n' \"$url\" > \"$FAKE_CURL_URL\"\ncp \"$ca\" \"$FAKE_CURL_CA\" || exit 60\ncp \"$FAKE_DOWNLOAD\" \"$out\"\n",
    );
    let download = root.join("download");
    let run = |bytes: &[u8], install_dir: &Path| {
        std::fs::write(&download, bytes).unwrap();
        // A hardened host's root umask must not hide the agent from the
        // service account.
        std::process::Command::new("sh")
            .args(["-c", "umask 077; exec sh \"$0\" \"$@\""])
            .arg(&path)
            .args(["--install-dir"])
            .arg(install_dir)
            .args(["--name", "edge 42", "--service", "none"])
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
            .output()
            .unwrap()
    };
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
    // Running it again verifies the installed agent instead of downloading.
    std::fs::remove_file(root.join("curl-url")).unwrap();
    let output = run(b"unused", &installed);
    assert!(output.status.success(), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stdout).contains("is already 0.2.0"));
    assert!(!root.join("curl-url").exists());
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
