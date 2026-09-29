//! Device CA rotation over the real agent TLS listener: devices on the old CA
//! keep working through the overlap and renew onto the new CA, retiring waits
//! for them, and afterwards the old CA's certificates are refused at TLS.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use http_body_util::BodyExt;
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, crypto, db, device, device_ca, initialize};

const SECRET: &str = "isolated-test-bootstrap-secret-123456789";

fn settings(root: &std::path::Path) -> Settings {
    Settings {
        data_dir: root.join("state"),
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        cookie,
    )
}
async fn sign_in(s: &State) -> (String, String) {
    let app = api::router(s.clone());
    let body = json!({"email":"admin@example.test","password":"a-long-enough-password"});
    let (status, v, cookie) =
        call(app.clone(), "POST", "/api/v1/login", body.clone(), "", "").await;
    if status == StatusCode::OK {
        return (cookie, v["csrf_token"].as_str().unwrap().into());
    }
    let (status, v, cookie) = call(app, "POST", "/api/v1/bootstrap", json!({"bootstrap_secret":SECRET,"email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}), "", "").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    (cookie, v["csrf_token"].as_str().unwrap().into())
}

/// The agent listener's own certificate, from a private test CA.
struct ServerPki {
    certificate: PathBuf,
    key: PathBuf,
    ca: CertificateDer<'static>,
}
fn server_pki(dir: &std::path::Path) -> ServerPki {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca = CertificateParams::default();
    ca.distinguished_name
        .push(DnType::CommonName, "agent listener test CA");
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_ca_cert_pem(&ca_cert.pem(), ca_key).unwrap();
    let key = KeyPair::generate().unwrap();
    let mut leaf = CertificateParams::default();
    leaf.subject_alt_names = vec![SanType::IpAddress(std::net::Ipv4Addr::LOCALHOST.into())];
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let cert = leaf.signed_by(&key, &issuer).unwrap();
    std::fs::create_dir_all(dir).unwrap();
    let (certificate, key_path) = (dir.join("server.pem"), dir.join("server-key.pem"));
    std::fs::write(&certificate, cert.pem()).unwrap();
    std::fs::write(&key_path, key.serialize_pem()).unwrap();
    ServerPki {
        certificate,
        key: key_path,
        ca: ca_cert.der().clone(),
    }
}

/// The agent TLS listener, exactly as the server runs it.
struct Listener {
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    port: u16,
}
async fn listen(s: &State, pki: &ServerPki) -> Listener {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (state, certificate, key) = (s.clone(), pki.certificate.clone(), pki.key.clone());
    let task = tokio::spawn(async move {
        device::serve_tls(state, &format!("127.0.0.1:{port}"), &certificate, &key).await
    });
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Listener { task, port };
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the agent listener did not start");
}
/// Stop the listener and the server, and start the server again on the same
/// state, as an operator does around `vectory-admin`.
async fn stop(s: State, listener: Listener) -> Settings {
    listener.task.abort();
    let _ = listener.task.await;
    for _ in 0..500 {
        if Arc::strong_count(&s) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        Arc::strong_count(&s),
        1,
        "connections still hold the server"
    );
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    settings
}

/// A device's identity: its key, and the certificate it currently uses.
struct Identity {
    key: KeyPair,
    certificate: String,
}
impl Identity {
    fn fingerprint(&self) -> String {
        db::hash(der(&self.certificate))
    }
}
fn der(pem: &str) -> CertificateDer<'static> {
    CertificateDer::pem_slice_iter(pem.as_bytes())
        .next()
        .unwrap()
        .unwrap()
}
fn csr(key: &KeyPair) -> String {
    CertificateParams::default()
        .serialize_request(key)
        .unwrap()
        .pem()
        .unwrap()
}
/// A TLS 1.3 client that trusts only the listener's CA, with an optional
/// device certificate, like the agent's transport.
fn client(pki: &ServerPki, identity: Option<(&str, &KeyPair)>) -> reqwest::Client {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(pki.ca.clone()).unwrap();
    let builder = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots);
    let config = match identity {
        Some((certificate, key)) => builder
            .with_client_auth_cert(
                vec![der(certificate)],
                PrivateKeyDer::from_pem_slice(key.serialize_pem().as_bytes()).unwrap(),
            )
            .unwrap(),
        None => builder.with_no_client_auth(),
    };
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap()
}
async fn post(
    client: &reqwest::Client,
    port: u16,
    path: &str,
    body: Value,
) -> reqwest::Result<(StatusCode, Value)> {
    let response = client
        .post(format!("https://127.0.0.1:{port}{path}"))
        .json(&body)
        .send()
        .await?;
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
    Ok((status, response.json().await.unwrap_or(Value::Null)))
}
fn heartbeat() -> Value {
    json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":STANDARD.encode([7;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false})
}
/// A check-in with this identity: its status, or the TLS-level refusal.
async fn check_in(
    pki: &ServerPki,
    port: u16,
    identity: &Identity,
) -> reqwest::Result<(StatusCode, Value)> {
    post(
        &client(pki, Some((&identity.certificate, &identity.key))),
        port,
        "/agent/v1/heartbeat",
        heartbeat(),
    )
    .await
}
/// The manifest's signature verifies with this signing key.
fn signed_by(envelope: &Value, signing: &str) -> bool {
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
    key.verify(&payload, &signature).is_ok()
}
fn issuer(certificate: &str) -> String {
    let der = der(certificate);
    let (_, parsed) = x509_parser::parse_x509_certificate(&der).unwrap();
    parsed.issuer().to_string()
}
/// A certificate for `device` signed by a CA key the server may or may not
/// trust. Enrollment never registered its fingerprint.
fn minted(device: &str, ca_pem: &str, ca_key: KeyPair) -> Identity {
    let issuer = Issuer::from_ca_cert_pem(ca_pem, ca_key).unwrap();
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, device);
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    let certificate = params.signed_by(&key, &issuer).unwrap().pem();
    Identity { key, certificate }
}
async fn enroll(s: &State, pki: &ServerPki, port: u16, name: &str) -> (Identity, Value) {
    let (cookie, csrf) = sign_in(s).await;
    let (status, token, _) = call(
        api::router(s.clone()),
        "POST",
        "/api/v1/tokens",
        json!({"name":format!("{name} token"),"expires_hours":1,"max_uses":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{token}");
    let key = KeyPair::generate().unwrap();
    let (status, enrolled) = post(&client(pki, None), port, "/agent/v1/enroll", json!({"protocol_version":1,"request_id":uuid::Uuid::new_v4().to_string(),"token":token["token"],"name":name,"csr_pem":csr(&key),"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"})).await.unwrap();
    assert_eq!(status, StatusCode::OK, "{enrolled}");
    let certificate = enrolled["certificate_pem"].as_str().unwrap().to_owned();
    (Identity { key, certificate }, enrolled)
}
async fn settings_read(s: &State) -> Value {
    let (cookie, csrf) = sign_in(s).await;
    let (status, v, _) = call(
        api::router(s.clone()),
        "GET",
        "/api/v1/settings",
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    v["device_ca"].clone()
}

#[tokio::test]
async fn rotation_keeps_devices_working_moves_them_on_renewal_and_retires_the_old_ca() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let pki = server_pki(&temp.path().join("listener"));
    let s = initialize(settings(temp.path())).await.unwrap();
    let old_ca = s.keys.device_ca().clone();
    let listener = listen(&s, &pki).await;
    let (renews, enrolled) = enroll(&s, &pki, listener.port, "renews").await;
    let (stays, _) = enroll(&s, &pki, listener.port, "stays").await;
    let (revoked, revoked_enrollment) = enroll(&s, &pki, listener.port, "revoked").await;
    let signing = enrolled["signing_public_key"].as_str().unwrap().to_owned();
    let old_ca_pem = enrolled["ca_pem"].as_str().unwrap().to_owned();
    assert_eq!(db::hash(der(&old_ca_pem)), old_ca.sha256);
    let status = settings_read(&s).await;
    assert_eq!(status["current"]["sha256"], old_ca.sha256);
    assert!(status["previous"].is_null());
    // Whoever steals the old CA key later can mint chains, not identities.
    let old_ca_key = KeyPair::from_pem(
        &std::fs::read_to_string(s.settings.data_dir.join("keys/device-ca-key.pem")).unwrap(),
    )
    .unwrap();

    // Rotate, offline: the listener and server stop, as vectory-admin requires.
    let settings = stop(s, listener).await;
    let s = initialize(settings.clone()).await.unwrap();
    let report = device_ca::rotate(&s).await.unwrap();
    assert_eq!(report["previous"]["sha256"], old_ca.sha256);
    assert_eq!(report["previous"]["devices"], 3);
    let new_sha = report["current"]["sha256"].as_str().unwrap().to_owned();
    assert_ne!(new_sha, old_ca.sha256);
    // One overlap at a time.
    let again = device_ca::rotate(&s).await.unwrap_err().to_string();
    assert!(again.contains("Retire it first"), "{again}");
    s.pool.close().await;
    drop(s);
    let s = initialize(settings.clone()).await.unwrap();
    assert_eq!(s.keys.device_ca().sha256, new_sha);
    assert_eq!(s.keys.previous_device_ca().unwrap().sha256, old_ca.sha256);
    // The previous CA's key is not kept.
    assert!(
        !std::fs::read_dir(s.settings.data_dir.join("keys"))
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .contains("next"))
    );
    let listener = listen(&s, &pki).await;

    // Overlap: certificates from the old CA keep working, and the manifest
    // signing trust is unchanged.
    for identity in [&renews, &stays] {
        let (status, envelope) = check_in(&pki, listener.port, identity).await.unwrap();
        assert_eq!(status, StatusCode::OK, "{envelope}");
        assert!(
            signed_by(&envelope, &signing),
            "manifest signing key changed"
        );
    }
    // A chain alone is not an identity: a certificate minted with the old CA
    // key passes TLS during the overlap but is not registered.
    let stolen = minted(
        enrolled["device_id"].as_str().unwrap(),
        &old_ca_pem,
        old_ca_key,
    );
    assert_eq!(
        check_in(&pki, listener.port, &stolen).await.unwrap().0,
        StatusCode::UNAUTHORIZED
    );
    // A forgery chained to neither CA, even one named like the original CA, is
    // refused at TLS.
    let (impostor_key, impostor) = crypto::new_device_ca("Vectory device CA").unwrap();
    let forged = minted(
        enrolled["device_id"].as_str().unwrap(),
        &impostor,
        KeyPair::from_pem(&impostor_key).unwrap(),
    );
    assert!(
        check_in(&pki, listener.port, &forged).await.is_err(),
        "a certificate from an unknown CA passed TLS"
    );
    // Revocation still applies on every request, old CA or not.
    let (cookie, csrf) = sign_in(&s).await;
    let (status, v, _) = call(
        api::router(s.clone()),
        "POST",
        &format!(
            "/api/v1/devices/{}/revoke",
            revoked_enrollment["device_id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(
        check_in(&pki, listener.port, &revoked).await.unwrap().0,
        StatusCode::UNAUTHORIZED
    );

    // Renewal moves a device onto the new CA; signing trust stays the same.
    let next_key = KeyPair::generate().unwrap();
    let (status, renewed) = post(
        &client(&pki, Some((&renews.certificate, &renews.key))),
        listener.port,
        "/agent/v1/renew",
        json!({"csr_pem":csr(&next_key)}),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::OK, "{renewed}");
    assert_eq!(renewed["signing_public_key"], signing);
    let new_ca_pem = renewed["ca_pem"].as_str().unwrap();
    assert_eq!(db::hash(der(new_ca_pem)), new_sha);
    let renewed_identity = Identity {
        key: next_key,
        certificate: renewed["certificate_pem"].as_str().unwrap().to_owned(),
    };
    assert_eq!(
        issuer(&renewed_identity.certificate),
        s.keys.device_ca().subject
    );
    assert_ne!(
        issuer(&renewed_identity.certificate),
        issuer(&renews.certificate)
    );
    let (status, envelope) = check_in(&pki, listener.port, &renewed_identity)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK);
    assert!(signed_by(&envelope, &signing));
    // A device enrolled during the overlap gets a certificate from the new CA.
    let (fresh, fresh_enrollment) = enroll(&s, &pki, listener.port, "fresh").await;
    assert_eq!(
        db::hash(der(fresh_enrollment["ca_pem"].as_str().unwrap())),
        new_sha
    );
    assert_eq!(issuer(&fresh.certificate), s.keys.device_ca().subject);

    // The status says who still holds the old CA's certificates: the renewed
    // device's previous certificate stays valid for its 24-hour fallback.
    let status = settings_read(&s).await;
    assert_eq!(status["current"]["sha256"], new_sha);
    assert_eq!(status["previous"]["sha256"], old_ca.sha256);
    assert_eq!(status["previous"]["devices"], 2);
    assert_eq!(
        status["previous"]["device_names"],
        json!(["renews", "stays"])
    );
    assert!(status["previous"]["last_expires_at"].is_string());

    // Retire refuses while devices remain, and says which.
    let settings = stop(s, listener).await;
    let s = initialize(settings.clone()).await.unwrap();
    for apply in [false, true] {
        let report = device_ca::retire(&s, apply).await.unwrap();
        assert_eq!(report["ready"], false);
        assert_eq!(report["retired"], false);
        assert_eq!(
            report["previous"]["device_names"],
            json!(["renews", "stays"])
        );
    }
    assert!(
        s.settings
            .data_dir
            .join("keys/device-ca-previous.pem")
            .exists()
    );
    // A day later the renewed device's fallback certificate has expired, and
    // the operator revoked the device that never came back.
    sqlx::query("UPDATE credentials SET expires_at=? WHERE fingerprint=?")
        .bind(
            (chrono::Utc::now() - chrono::Duration::minutes(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        )
        .bind(renews.fingerprint())
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET revoked=1 WHERE name='stays'")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(device_ca::retire(&s, false).await.unwrap()["ready"], true);
    assert!(
        s.settings
            .data_dir
            .join("keys/device-ca-previous.pem")
            .exists(),
        "a check changes nothing"
    );
    let report = device_ca::retire(&s, true).await.unwrap();
    assert_eq!(report["retired"], true);
    assert!(
        device_ca::retire(&s, true)
            .await
            .unwrap_err()
            .to_string()
            .contains("nothing to retire")
    );
    let actions: Vec<String> = sqlx::query_scalar("SELECT json_extract(data,'$.action') FROM records WHERE kind='audit' AND json_extract(data,'$.action') LIKE 'signing.device_ca.%' ORDER BY rowid")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        actions,
        [
            "signing.device_ca.rotate.prepare",
            "signing.device_ca.rotate",
            "signing.device_ca.retire"
        ]
    );
    s.pool.close().await;
    drop(s);

    // After retirement the old CA's certificates are refused at TLS, while the
    // renewed and new devices keep working.
    let s = initialize(settings).await.unwrap();
    assert!(s.keys.previous_device_ca().is_none());
    let listener = listen(&s, &pki).await;
    for identity in [&renewed_identity, &fresh] {
        let (status, envelope) = check_in(&pki, listener.port, identity).await.unwrap();
        assert_eq!(status, StatusCode::OK);
        assert!(signed_by(&envelope, &signing));
    }
    for identity in [&renews, &stays, &stolen, &forged] {
        assert!(
            check_in(&pki, listener.port, identity).await.is_err(),
            "a certificate from a retired or unknown CA passed TLS"
        );
    }
    assert!(settings_read(&s).await["previous"].is_null());
    let _ = stop(s, listener).await;
}

#[tokio::test]
async fn an_interrupted_rotation_rolls_back_before_its_commit_and_forward_after_it() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let s = initialize(settings.clone()).await.unwrap();
    let original = s.keys.device_ca().clone();
    let original_pem = s.keys.ca_pem.clone();
    s.pool.close().await;
    drop(s);
    let keys = settings.data_dir.join("keys");
    let (next_key, next) = crypto::new_device_ca("Vectory device CA next").unwrap();
    let next_ca = crypto::DeviceCa::from_pem(&next).unwrap();

    // Staged but not committed: the new files are discarded.
    std::fs::write(keys.join("device-ca-next-key.pem"), &next_key).unwrap();
    std::fs::write(keys.join("device-ca-next.pem"), &next).unwrap();
    let s = initialize(settings.clone()).await.unwrap();
    assert_eq!(s.keys.device_ca(), &original);
    assert!(s.keys.previous_device_ca().is_none());
    assert!(
        !keys.join("device-ca-next.pem").exists() && !keys.join("device-ca-next-key.pem").exists()
    );
    s.pool.close().await;
    drop(s);

    // Committed, stopped before either rename: both are completed.
    std::fs::write(keys.join("device-ca-next-key.pem"), &next_key).unwrap();
    std::fs::write(keys.join("device-ca-next.pem"), &next).unwrap();
    std::fs::write(keys.join("device-ca-previous.pem"), &original_pem).unwrap();
    let s = initialize(settings.clone()).await.unwrap();
    assert_eq!(s.keys.device_ca(), &next_ca);
    assert_eq!(s.keys.previous_device_ca(), Some(&original));
    s.pool.close().await;
    drop(s);

    // Committed, stopped between the key and the certificate renames.
    let (third_key, third) = crypto::new_device_ca("Vectory device CA third").unwrap();
    std::fs::write(keys.join("device-ca-previous.pem"), &next).unwrap();
    std::fs::write(keys.join("device-ca-key.pem"), &third_key).unwrap();
    std::fs::write(keys.join("device-ca-next.pem"), &third).unwrap();
    let s = initialize(settings.clone()).await.unwrap();
    assert_eq!(
        s.keys.device_ca(),
        &crypto::DeviceCa::from_pem(&third).unwrap()
    );
    assert_eq!(s.keys.previous_device_ca(), Some(&next_ca));
    s.pool.close().await;
    drop(s);

    // Files that don't belong together stop the server instead of guessing.
    let (other_key, _) = crypto::new_device_ca("Vectory device CA other").unwrap();
    std::fs::write(keys.join("device-ca-next-key.pem"), &other_key).unwrap();
    std::fs::write(keys.join("device-ca-next.pem"), &next).unwrap();
    for _ in 0..2 {
        let error = format!(
            "{:#}",
            initialize(settings.clone())
                .await
                .err()
                .expect("mismatched rotation files")
        );
        assert!(
            error.contains("rotation stopped midway")
                && error.contains("restore the complete keys directory from backup"),
            "{error}"
        );
    }
    assert!(
        keys.join("device-ca-next.pem").exists(),
        "nothing is guessed or moved"
    );
}

#[tokio::test]
async fn credentials_from_before_issuer_tracking_count_as_the_previous_ca() {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(settings(temp.path())).await.unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    for (name, revoked) in [("legacy", false), ("legacy-revoked", true)] {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO devices(id,name,data,revoked) VALUES(?,?,'{}',?)")
            .bind(&id)
            .bind(name)
            .bind(revoked)
            .execute(&mut *tx)
            .await
            .unwrap();
        // An upgrade leaves ca_id NULL on credentials issued before it.
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(format!("legacy-{name}"))
            .bind(&id)
            .bind(
                (chrono::Utc::now() + chrono::Duration::days(20))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            )
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let report = device_ca::rotate(&s).await.unwrap();
    assert_eq!(report["previous"]["devices"], 1);
    assert_eq!(report["previous"]["device_names"], json!(["legacy"]));
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    assert_eq!(device_ca::retire(&s, true).await.unwrap()["ready"], false);
    sqlx::query("UPDATE credentials SET revoked=1 WHERE fingerprint='legacy-legacy'")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(device_ca::retire(&s, true).await.unwrap()["retired"], true);
}
