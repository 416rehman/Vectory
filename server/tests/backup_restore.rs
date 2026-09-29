//! An online backup of a real server database, taken with the shipped
//! `deploy/backup.py` while the server holds it open (WAL included), restores
//! with every row, passes SQLite's integrity checks, opens with the server and
//! keeps devices' credentials and manifest signing trust.
use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use http_body_util::BodyExt;
use rustls::pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use std::{path::Path, process::Command};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize};

const SECRET: &str = "isolated-test-bootstrap-secret-123456789";

fn settings(data_dir: &Path, root: &Path) -> Settings {
    Settings {
        data_dir: data_dir.to_owned(),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: root.join("dist"),
        releases_dir: root.join("releases"),
        instance_name: "Test".into(),
        ..Default::default()
    }
}
async fn call(
    app: Router,
    method: &str,
    path: &str,
    v: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        request = request.header("cookie", cookie)
    }
    if !csrf.is_empty() {
        request = request.header("x-csrf-token", csrf)
    }
    let response = app
        .oneshot(request.body(Body::from(v.to_string())).unwrap())
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
    let out = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, out, cookie)
}
/// The shipped backup tool needs Python 3.11 or later (hashlib.file_digest).
fn python() -> &'static str {
    for candidate in ["python3", "python"] {
        let usable = Command::new(candidate)
            .args(["-c", "import sys, hashlib; sys.exit(0 if sys.version_info >= (3, 11) and hasattr(hashlib, 'file_digest') else 1)"])
            .status()
            .is_ok_and(|status| status.success());
        if usable {
            return candidate;
        }
    }
    panic!(
        "This test runs deploy/backup.py: put Python 3.11 or later on PATH as python3 or python."
    );
}
fn backup_tool(args: &[&str]) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../deploy/backup.py");
    let out = Command::new(python())
        .arg(script)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "backup.py {args:?} failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
/// Rows in every table, by name.
async fn counts(pool: &SqlitePool) -> Vec<(String, i64)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut out = Vec::new();
    for table in tables {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM \"{table}\""))
            .fetch_one(pool)
            .await
            .unwrap();
        out.push((table, count));
    }
    out
}
fn heartbeat() -> Value {
    json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":STANDARD.encode([5;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"desired","local_paused":false,"remote_pause_acknowledged":false,"telemetry":{"sampled_at":db::now(),"events_per_second":12.5,"errors":0,"memory_bytes":52428800}})
}
fn manifest(envelope: &Value, signing: &str) -> Value {
    let key =
        VerifyingKey::from_bytes(&STANDARD.decode(signing).unwrap().try_into().unwrap()).unwrap();
    let payload = STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let signature = Signature::from_slice(
        &STANDARD
            .decode(envelope["signature"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    key.verify(&payload, &signature)
        .expect("manifest signed with the enrolled key");
    serde_json::from_slice(&payload).unwrap()
}
fn as_device(s: &State, fingerprint: &str) -> Router {
    device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        fingerprint.to_owned(),
    ))))
}

#[tokio::test]
async fn an_online_backup_of_a_real_database_restores_whole_and_the_server_opens_it() {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(settings(&temp.path().join("state"), temp.path()))
        .await
        .unwrap();
    let app = api::router(s.clone());
    let (status, v, cookie) = call(app.clone(), "POST", "/api/v1/bootstrap", json!({"bootstrap_secret":SECRET,"email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}), "", "").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let csrf = v["csrf_token"].as_str().unwrap().to_owned();

    // Devices enrolled through the protocol: devices, credentials, enrollments.
    let (status, token, _) = call(
        app.clone(),
        "POST",
        "/api/v1/tokens",
        json!({"name":"backup","expires_hours":1,"max_uses":3,"labels":{"site":"berlin"}}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let mut devices = Vec::new();
    for name in ["edge-01", "edge-02", "edge-03"] {
        let key = rcgen::KeyPair::generate().unwrap();
        let csr = rcgen::CertificateParams::default()
            .serialize_request(&key)
            .unwrap()
            .pem()
            .unwrap();
        let (status, enrolled, _) = call(device::router(s.clone()), "POST", "/agent/v1/enroll", json!({"protocol_version":1,"request_id":uuid::Uuid::new_v4().to_string(),"token":token["token"],"name":name,"csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"}), "", "").await;
        assert_eq!(status, StatusCode::OK, "{enrolled}");
        let der = CertificateDer::pem_slice_iter(
            enrolled["certificate_pem"].as_str().unwrap().as_bytes(),
        )
        .next()
        .unwrap()
        .unwrap();
        devices.push((
            enrolled["device_id"].as_str().unwrap().to_owned(),
            db::hash(der),
            enrolled["signing_public_key"].as_str().unwrap().to_owned(),
        ));
    }
    let ids: Vec<&str> = devices.iter().map(|(id, ..)| id.as_str()).collect();
    // A pipeline, a published version, a group and an assignment.
    let config = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}}});
    let (status, pipeline, _) = call(
        app.clone(),
        "POST",
        "/api/v1/configurations",
        json!({"name":"Backup fixture","graph":{"nodes":[],"edges":[]},"config":config}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pipeline}");
    let (status, version, _) = call(
        app.clone(),
        "POST",
        &format!(
            "/api/v1/configurations/{}/publish",
            pipeline["id"].as_str().unwrap()
        ),
        json!({"revision":pipeline["revision"],"message":"v1"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    let (status, group, _) = call(
        app.clone(),
        "POST",
        "/api/v1/groups",
        json!({"name":"edge","device_ids":ids}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let deployment = json!({"version_id":version["id"],"priority":10,"target_mode":"snapshot","selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}});
    let (status, preview, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments/preview",
        deployment.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let (status, created, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments",
        deployment,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // Check-ins with telemetry: device state and metrics history.
    for (_, fingerprint, signing) in &devices {
        let (status, envelope, _) = call(
            as_device(&s, fingerprint),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat(),
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{envelope}");
        assert_eq!(
            manifest(&envelope, signing)["desired"]["version_id"],
            version["id"]
        );
    }
    drop(app);

    // Every kind of state the backup must carry is present.
    let before = counts(&s.pool).await;
    let rows = |table: &str| {
        before
            .iter()
            .find(|(name, _)| name == table)
            .map_or(0, |(_, n)| *n)
    };
    for (table, at_least) in [
        ("users", 1),
        ("devices", 3),
        ("credentials", 3),
        ("enrollments", 3),
        ("enrollment_tokens", 1),
        ("deployment_targets", 3),
        ("desired_artifacts", 3),
        ("artifact_blobs", 1),
        ("telemetry", 3),
        ("records", 10),
        ("_sqlx_migrations", 20),
    ] {
        assert!(rows(table) >= at_least, "{table}: {} rows", rows(table));
    }
    let data = s.settings.data_dir.clone();
    let wal = std::fs::metadata(data.join("vectory.db-wal")).map_or(0, |m| m.len());
    assert!(
        wal > 0,
        "the backup must be taken while the WAL holds changes"
    );

    // Online backup while the server holds the database, then restore into a
    // new directory.
    let backup = temp.path().join("backup");
    let restored = temp.path().join("restored");
    backup_tool(&[
        "backup",
        "--state",
        data.to_str().unwrap(),
        "--out",
        backup.to_str().unwrap(),
    ]);
    backup_tool(&[
        "restore",
        "--from",
        backup.to_str().unwrap(),
        "--out",
        restored.to_str().unwrap(),
    ]);
    for key in [
        "device-ca.pem",
        "device-ca-key.pem",
        "manifest-signing.key",
        "mfa-sealing.key",
    ] {
        assert_eq!(
            std::fs::read(data.join("keys").join(key)).unwrap(),
            std::fs::read(restored.join("keys").join(key)).unwrap(),
            "{key}"
        );
    }
    let copy = SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(restored.join("vectory.db"))
            .read_only(true),
    )
    .await
    .unwrap();
    assert_eq!(counts(&copy).await, before, "every table restored whole");
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&copy)
        .await
        .unwrap();
    assert_eq!(integrity, ["ok"]);
    let dangling: Vec<(String, i64, String, i64)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&copy)
        .await
        .unwrap();
    assert!(dangling.is_empty(), "{dangling:?}");
    copy.close().await;

    // The server opens the restored state next to the original, and the
    // devices' credentials and signing trust carry over.
    let r = initialize(settings(&restored, temp.path())).await.unwrap();
    assert_eq!(r.keys.active_signing_id(), s.keys.active_signing_id());
    assert_eq!(r.keys.device_ca(), s.keys.device_ca());
    for (id, fingerprint, signing) in &devices {
        let (status, envelope, _) = call(
            as_device(&r, fingerprint),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat(),
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{envelope}");
        let m = manifest(&envelope, signing);
        assert_eq!(
            (m["device_id"].as_str(), &m["desired"]["version_id"]),
            (Some(id.as_str()), &version["id"])
        );
        let (status, _, _) = call(
            as_device(&r, fingerprint),
            "GET",
            &format!(
                "/agent/v1/artifacts/{}",
                version["sha256"].as_str().unwrap()
            ),
            Value::Null,
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    // People and their passwords carry over, and so does what they see.
    let (status, signed_in, cookie) = call(
        api::router(r.clone()),
        "POST",
        "/api/v1/login",
        json!({"email":"admin@example.test","password":"a-long-enough-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{signed_in}");
    let (status, restored_device, _) = call(
        api::router(r.clone()),
        "GET",
        &format!("/api/v1/devices/{}", ids[0]),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{restored_device}");
    assert_eq!(restored_device["desired_version_id"], version["id"]);
    assert_eq!(restored_device["labels"], json!({"site":"berlin"}));
}
