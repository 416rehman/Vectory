//! What the agent update tests share: a server with people of every role,
//! devices that check in the way agents do, release keys and releases a rollout
//! can offer, and a clock the scheduler step can be given.
#![allow(dead_code)]

use axum::{
    Extension, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{
    Settings, State,
    agent_release::{self, ReleaseKey, SignatureEntry},
    agent_update_rollouts::engine,
    api, auth, db, device, initialize,
};

/// The password every synthetic person has.
pub const PASSWORD: &str = "a long passphrase that only the tests know";
/// Its hash, made once: hashing is slow and every person shares the password.
fn hashed() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| {
        use argon2::{Argon2, PasswordHasher, password_hash::SaltString};
        let salt = SaltString::generate(&mut rand::rngs::OsRng);
        Argon2::default()
            .hash_password(PASSWORD.as_bytes(), &salt)
            .expect("the password hashes")
            .to_string()
    })
}

pub struct Who {
    pub id: String,
    pub cookie: String,
    pub csrf: String,
}

pub struct Fixture {
    pub temp: tempfile::TempDir,
    pub state: State,
    pub app: Router,
    pub admin: Who,
    pub operator: Who,
    pub editor: Who,
    pub viewer: Who,
}

pub async fn user(state: &State, role: &str) -> Who {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Synthetic {role}"))
    .bind(role)
    .bind(hashed())
    .bind(db::now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&state.pool)
        .await
        .unwrap();
    Who {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}

/// A server with updates off (the default).
pub async fn fixture() -> Fixture {
    fixture_with(|_| {}).await
}
/// ... with settings of its own.
pub async fn fixture_with(tune: impl FnOnce(&mut Settings)) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let mut settings = Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-agent-update-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Synthetic agent update fixture".into(),
        validation_url: None,
        ..Default::default()
    };
    tune(&mut settings);
    let state = initialize(settings).await.unwrap();
    let admin = user(&state, "admin").await;
    let operator = user(&state, "operator").await;
    let editor = user(&state, "editor").await;
    let viewer = user(&state, "viewer").await;
    Fixture {
        app: api::router(state.clone()),
        state,
        temp,
        admin,
        operator,
        editor,
        viewer,
    }
}

/// A server with updates on and one current key, held by the server.
pub async fn fixture_on() -> Fixture {
    let f = fixture().await;
    key(&f, "team", "server", "current").await;
    switch(&f, true).await;
    f
}

/// Turns updates on or off as the setting stores it, without going through the
/// route.
pub async fn switch(f: &Fixture, on: bool) {
    let current: Option<String> =
        sqlx::query_scalar("SELECT fingerprint FROM agent_release_keys WHERE state='current'")
            .fetch_optional(&f.state.pool)
            .await
            .unwrap();
    let custody: Option<String> =
        sqlx::query_scalar("SELECT custody FROM agent_release_keys WHERE state='current'")
            .fetch_optional(&f.state.pool)
            .await
            .unwrap();
    sqlx::query("UPDATE agent_update_settings SET enabled=?,custody=COALESCE(?,custody),current_key=COALESCE(?,current_key),revision=revision+1 WHERE id=1")
        .bind(on)
        .bind(custody)
        .bind(current)
        .execute(&f.state.pool)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Keys and releases

/// A fingerprint a test names a key by; it is not the fingerprint of a real key.
pub fn fingerprint(label: &str) -> String {
    db::hash(format!("test release key {label}"))
}

/// A key row, as registering one stores it. Nothing here signs or verifies: the
/// stand-in key line only has to look like one.
pub async fn key(f: &Fixture, label: &str, custody: &str, state: &str) -> String {
    let fingerprint = fingerprint(label);
    let public = STANDARD.encode(hex::decode(&fingerprint).unwrap());
    sqlx::query("INSERT INTO agent_release_keys(fingerprint,public_key,custody,state,created_at,created_by_name) VALUES(?,?,?,?,?,?)")
        .bind(&fingerprint)
        .bind(format!("vectory-release-key ed25519 {public} {label}"))
        .bind(custody)
        .bind(state)
        .bind(db::now())
        .bind("Synthetic admin")
        .execute(&f.state.pool)
        .await
        .unwrap();
    fingerprint
}

/// The rollover that made `to` current in place of `from`: stand-in bytes in
/// the envelope, which the server only relays.
pub async fn introduce(f: &Fixture, to: &str, from: &str) {
    sqlx::query("UPDATE agent_release_keys SET introduced_from=?,introduced_statement=?,introduced_signature=? WHERE fingerprint=?")
        .bind(fingerprint(from))
        .bind(STANDARD.encode(format!("statement {from} to {to}")))
        .bind(STANDARD.encode(format!("signature of {from} over {to}")))
        .bind(fingerprint(to))
        .execute(&f.state.pool)
        .await
        .unwrap();
}

/// A key the team holds: its seed never reaches the server.
pub struct Team {
    pub seed: [u8; 32],
    pub key: ReleaseKey,
}
pub fn team(name: &str) -> Team {
    let seed = agent_release::generate_seed();
    let key = ReleaseKey::from_seed(&seed, name).expect("a generated key passes the key rule");
    Team { seed, key }
}
impl Team {
    pub fn line(&self) -> String {
        self.key.line()
    }
    pub fn fingerprint(&self) -> String {
        self.key.fingerprint().to_owned()
    }
    /// A `release.json.sig` of this key over a manifest.
    pub fn sign(&self, manifest: &[u8]) -> Vec<u8> {
        agent_release::build_signature_file(&[SignatureEntry {
            key: self.fingerprint(),
            signature: agent_release::sign(&self.seed, manifest).expect("a valid manifest"),
        }])
        .expect("a valid signature file")
    }
}

/// Turns updates on through the route, with a key the server holds; returns the
/// setting.
pub async fn enable_server(f: &Fixture) -> Value {
    let current = ok(f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    ok(
        f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":true,"custody":{"kind":"server"},"current_password":PASSWORD,"revision":current["revision"]}),
        &f.admin,
    )
    .await
}
/// ... with the team's key, held offline.
pub async fn enable_offline(f: &Fixture, team: &Team) -> Value {
    let current = ok(f, "GET", "/api/v1/agent-updates", Value::Null, &f.admin).await;
    ok(
        f,
        "PUT",
        "/api/v1/agent-updates/settings",
        json!({"enabled":true,"custody":{"kind":"offline","public_key":team.line()},"current_password":PASSWORD,"revision":current["revision"]}),
        &f.admin,
    )
    .await
}
/// Prepares the release of a version of the catalog through the route.
pub async fn prepare(f: &Fixture, version: &str) -> Value {
    ok(
        f,
        "POST",
        "/api/v1/agent-releases",
        json!({"version":version}),
        &f.admin,
    )
    .await
}

#[derive(Clone, Debug)]
pub struct Release {
    pub id: String,
    pub version: String,
    pub counter: i64,
    pub manifest: String,
    pub manifest_sha256: String,
    pub signature: String,
    pub artifacts: Vec<(String, String, String)>,
}
impl Release {
    /// The file digest of a platform.
    pub fn sha256(&self, os: &str, arch: &str) -> String {
        self.artifacts
            .iter()
            .find(|(o, a, _)| o == os && a == arch)
            .map(|(_, _, sha)| sha.clone())
            .unwrap()
    }
}

/// A release that is ready: signed by `signer`, with a file for each platform.
pub async fn release(
    f: &Fixture,
    version: &str,
    counter: i64,
    signer: &str,
    platforms: &[(&str, &str)],
) -> Release {
    release_with(f, version, counter, signer, platforms, "ready", 180).await
}

pub async fn release_with(
    f: &Fixture,
    version: &str,
    counter: i64,
    signer: &str,
    platforms: &[(&str, &str)],
    state: &str,
    valid_days: i64,
) -> Release {
    let id = db::id();
    // The sequence of counters has handed this one out.
    sqlx::query(
        "UPDATE agent_update_settings SET counter_sequence=MAX(counter_sequence,?) WHERE id=1",
    )
    .bind(counter)
    .execute(&f.state.pool)
    .await
    .unwrap();
    let issued = Utc::now();
    let expires = issued + chrono::Duration::days(valid_days);
    let artifacts: Vec<(String, String, String)> = platforms
        .iter()
        .map(|(os, arch)| {
            (
                (*os).to_owned(),
                (*arch).to_owned(),
                db::hash(format!("build {version} {os} {arch}")),
            )
        })
        .collect();
    let manifest = json!({
        "schema":"vectory.agent-release.v1","version":version,"counter":counter,
        "issued_at":issued.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "expires_at":expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "service_definition":1,
        "artifacts":artifacts.iter().map(|(os, arch, sha)| json!({"os":os,"arch":arch,"format":"executable","file":format!("vectory-{version}-{os}-{arch}"),"size":1000,"sha256":sha})).collect::<Vec<_>>(),
    })
    .to_string();
    let signature = json!({"schema":"vectory.agent-release-signatures.v1","signatures":[{"key":signer,"signature":STANDARD.encode([7u8; 64])}]}).to_string();
    let signed = state != "awaiting_signature";
    sqlx::query("INSERT INTO agent_releases(id,version,counter,manifest,manifest_sha256,signature,signer,issued_at,expires_at,service_definition,state,prepared_by_name,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)")
        .bind(&id)
        .bind(version)
        .bind(counter)
        .bind(manifest.as_bytes())
        .bind(db::hash(&manifest))
        .bind(signed.then(|| signature.clone().into_bytes()))
        .bind(signed.then(|| signer.to_owned()))
        .bind(issued.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .bind(state)
        .bind("Synthetic admin")
        .bind(db::now())
        .execute(&f.state.pool)
        .await
        .unwrap();
    for (os, arch, sha) in &artifacts {
        sqlx::query("INSERT INTO agent_release_artifacts(release_id,os,arch,file,size,sha256) VALUES(?,?,?,?,1000,?)")
            .bind(&id)
            .bind(os)
            .bind(arch)
            .bind(format!("vectory-{version}-{os}-{arch}"))
            .bind(sha)
            .execute(&f.state.pool)
            .await
            .unwrap();
    }
    Release {
        id,
        version: version.to_owned(),
        counter,
        manifest_sha256: db::hash(&manifest),
        manifest,
        signature,
        artifacts,
    }
}

/// Puts builds in the release mirror, the catalog this server ships agents
/// from: `(version, os, arch, bytes)`. Returns the catalog entries.
pub fn mirror(f: &Fixture, builds: &[(&str, &str, &str, Vec<u8>)]) -> Vec<Value> {
    let dir = f.temp.path().join("releases");
    std::fs::create_dir_all(&dir).unwrap();
    let mut entries = Vec::new();
    for (version, os, arch, bytes) in builds {
        let name = format!("vectory-{version}-{os}-{arch}");
        std::fs::write(dir.join(&name), bytes).unwrap();
        entries.push(json!({"name":name,"os":os,"arch":arch,"version":version,"sha256":db::hash(bytes),"size":bytes.len()}));
    }
    std::fs::write(
        dir.join("catalog.json"),
        serde_json::to_vec(&entries).unwrap(),
    )
    .unwrap();
    entries
}

// ---------------------------------------------------------------------------
// Devices

/// An enrolled device that checked in just now, running agent `version`.
pub async fn device(f: &Fixture, name: &str, version: &str) -> String {
    device_on(f, name, version, "linux", "amd64").await
}
pub async fn device_on(f: &Fixture, name: &str, version: &str, os: &str, arch: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let data = json!({
        "id":id,"name":name,"os":os,"arch":arch,"vector_version":"0.58.0",
        "agent_version":version,"agent_sha256":db::hash(format!("running {version} {os} {arch}")),
        "configuration_mode":"full","last_seen":db::now(),"apply_state":"unmanaged",
        "reported_generation":0,"actual_sha256":null,"labels":{},"created_at":db::now()
    });
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(data.to_string())
        .execute(&f.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(format!("credential-{id}"))
    .bind(&id)
    .bind("2099-01-01T00:00:00Z")
    .bind(f.state.keys.active_signing_id())
    .execute(&f.state.pool)
    .await
    .unwrap();
    id
}

/// What a device last checked in at, as the review reads it.
pub async fn seen(f: &Fixture, device: &str, at: &str) {
    sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?) WHERE id=?")
        .bind(at)
        .bind(device)
        .execute(&f.state.pool)
        .await
        .unwrap();
}

pub async fn revoke(f: &Fixture, device: &str) {
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(device)
        .execute(&f.state.pool)
        .await
        .unwrap();
}

/// A report as an eligible, consenting host sends it: `auto`, no window, pinning
/// the given keys, with nothing to do.
pub fn member<S: AsRef<str>>(pins: &[S]) -> Value {
    let keys: Vec<&str> = pins.iter().map(AsRef::as_ref).collect();
    json!({
        "consent":"auto","paused":false,"track":"patch","windows":[],"window_open":true,
        "keys":keys,"highest_counter":0,"eligibility":"eligible","service_definition":1,
        "state":"idle"
    })
}
/// `base` with the members of `extra` replaced (a null removes one).
pub fn with(mut base: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().into_iter().flatten() {
        if value.is_null() {
            base.as_object_mut().unwrap().remove(key);
        } else {
            base[key] = value.clone();
        }
    }
    base
}
/// Stores a report for a device as its latest check-in would, without a check-in.
pub async fn store(f: &Fixture, device: &str, report: &Value) {
    sqlx::query("INSERT INTO agent_update_reports(device_id,report,reported_at) VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET report=excluded.report,reported_at=excluded.reported_at")
        .bind(device)
        .bind(report.to_string())
        .bind(db::now())
        .execute(&f.state.pool)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Requests

pub async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    who: Option<&Who>,
) -> (StatusCode, HeaderMap, Value) {
    send_with(
        app,
        method,
        path,
        body,
        who.map(|w| (w.cookie.as_str(), Some(w.csrf.as_str()))),
    )
    .await
}

/// Like `send`, with the cookie and the CSRF token given separately so a test
/// can leave one out.
pub async fn send_with(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<(&str, Option<&str>)>,
) -> (StatusCode, HeaderMap, Value) {
    let (status, headers, bytes) = send_bytes(
        app,
        method,
        path,
        if body.is_null() {
            Vec::new()
        } else {
            body.to_string().into_bytes()
        },
        "application/json",
        session,
    )
    .await;
    (
        status,
        headers,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)})),
    )
}

pub async fn send_bytes(
    app: &Router,
    method: &str,
    path: &str,
    body: Vec<u8>,
    content_type: &str,
    session: Option<(&str, Option<&str>)>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", content_type);
    if let Some((cookie, csrf)) = session {
        request = request.header("cookie", cookie);
        if let Some(csrf) = csrf {
            request = request.header("x-csrf-token", csrf);
        }
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, headers, bytes.to_vec())
}

/// A request that must succeed; returns its body.
pub async fn ok(f: &Fixture, method: &str, path: &str, body: Value, who: &Who) -> Value {
    let (status, _, value) = send(&f.app, method, path, body, Some(who)).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}

/// A request that must fail with `status` and the API error `code`.
pub async fn refused(
    f: &Fixture,
    method: &str,
    path: &str,
    body: Value,
    who: &Who,
    status: StatusCode,
    code: &str,
) -> Value {
    let (got, _, value) = send(&f.app, method, path, body, Some(who)).await;
    assert_eq!(got, status, "{method} {path}: {value}");
    if !code.is_empty() {
        assert_eq!(value["error"]["code"], code, "{method} {path}: {value}");
    }
    value
}

// ---------------------------------------------------------------------------
// Check-ins

pub fn agent(f: &Fixture, device: &str) -> Router {
    device::router(f.state.clone()).layer(Extension(device::PeerCertificate(Some(format!(
        "credential-{device}"
    )))))
}

/// A check-in as an agent sends it. `extra` replaces or adds members; the
/// answer is the status and the decoded manifest (or the error).
pub async fn beat(f: &Fixture, device: &str, extra: Value) -> (StatusCode, Value) {
    let mut body = json!({
        "protocol_version":1,"request_id":"r","boot_id":"boot-1","nonce":STANDARD.encode([3; 32]),
        "agent_version":"0.1.0","vector_version":"0.58.0","reported_generation":0,
        "policy_generation":0,"actual_sha256":"","apply_state":"unmanaged",
        "local_paused":false,"remote_pause_acknowledged":false,"configuration_mode":"full"
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        if value.is_null() {
            body.as_object_mut().unwrap().remove(key);
        } else {
            body[key] = value.clone();
        }
    }
    let (status, _, envelope) =
        send(&agent(f, device), "POST", "/agent/v1/heartbeat", body, None).await;
    if status != StatusCode::OK {
        return (status, envelope);
    }
    let payload = STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    (status, serde_json::from_slice(&payload).unwrap())
}

/// A check-in that carries a report, from a build running as `version` in the
/// process `boot`.
pub async fn report(
    f: &Fixture,
    device: &str,
    version: &str,
    sha256: &str,
    boot: &str,
    member: &Value,
) -> Value {
    let (status, manifest) = beat(
        f,
        device,
        json!({"agent_version":version,"agent_sha256":sha256,"boot_id":boot,"agent_update":member}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    manifest
}

// ---------------------------------------------------------------------------
// The scheduler step

/// One scheduler step of the update rollouts at the given clock.
pub async fn step(f: &Fixture, at: DateTime<Utc>) {
    let mut tx = db::begin_write(&f.state.pool).await.unwrap();
    engine::step(&mut tx, &f.state, at).await.unwrap();
    tx.commit().await.unwrap();
}

/// A target's state.
pub async fn target(f: &Fixture, rollout: &str, device: &str) -> (String, Option<String>) {
    sqlx::query_as("SELECT state,code FROM agent_update_targets WHERE rollout_id=? AND device_id=?")
        .bind(rollout)
        .bind(device)
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}
pub async fn status(f: &Fixture, rollout: &str) -> String {
    sqlx::query_scalar("SELECT status FROM agent_update_rollouts WHERE id=?")
        .bind(rollout)
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}

/// What the review says about these devices, and the rollout the token of that
/// review starts.
pub fn request(release: &str, devices: &[&String], rollout: Value) -> Value {
    json!({
        "release_id":release,
        "selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},
        "rollout":rollout,
    })
}
pub async fn preview(f: &Fixture, release: &str, devices: &[&String], rollout: Value) -> Value {
    ok(
        f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        request(release, devices, rollout),
        &f.operator,
    )
    .await
}
/// Reviews and starts a rollout of `devices`; returns the rollout.
pub async fn start(f: &Fixture, release: &str, devices: &[&String], rollout: Value) -> Value {
    let review = preview(f, release, devices, rollout.clone()).await;
    let mut body = request(release, devices, rollout);
    body["review_token"] = review["review_token"].clone();
    ok(
        f,
        "POST",
        "/api/v1/agent-update-rollouts",
        body,
        &f.operator,
    )
    .await
}

/// The audit rows of one action, oldest first.
pub async fn audits(f: &Fixture, action: &str) -> Vec<Value> {
    let rows: Vec<String> = sqlx::query_scalar("SELECT r.data FROM records r JOIN audit_sequence q ON q.audit_id=r.id WHERE r.kind='audit' AND json_extract(r.data,'$.action')=? ORDER BY q.sequence")
        .bind(action)
        .fetch_all(&f.state.pool)
        .await
        .unwrap();
    rows.iter()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}
