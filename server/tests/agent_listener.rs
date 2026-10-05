//! The agent TLS listener under pressure: running out of descriptors never ends
//! the server, and connections that never speak never hold up a real device.
use axum::{Router, body::Body, http::Request};
use http_body_util::BodyExt;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, device, initialize};

const SECRET: &str = "isolated-listener-bootstrap-secret-12345";

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
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
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
                vec![
                    CertificateDer::pem_slice_iter(certificate.as_bytes())
                        .next()
                        .unwrap()
                        .unwrap(),
                ],
                PrivateKeyDer::from_pem_slice(key.serialize_pem().as_bytes()).unwrap(),
            )
            .unwrap(),
        None => builder.with_no_client_auth(),
    };
    reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap()
}

async fn dashboard(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (axum::http::StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        request = request
            .header("cookie", cookie)
            .header("x-csrf-token", csrf);
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
        .and_then(|value| value.to_str().ok())
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

/// A device enrolled through the listener, as the agent does it: the identity
/// it then presents on every request.
struct Identity {
    key: KeyPair,
    certificate: String,
}
async fn enroll_device(state: &State, pki: &ServerPki, port: u16) -> Identity {
    let app = api::router(state.clone());
    let (status, session, cookie) = dashboard(
        &app,
        "POST",
        "/api/v1/bootstrap",
        json!({"bootstrap_secret":SECRET,"email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{session}");
    let csrf = session["csrf_token"].as_str().unwrap();
    let (status, token, _) = dashboard(
        &app,
        "POST",
        "/api/v1/tokens",
        json!({"name":"listener test","expires_hours":1,"max_uses":1}),
        &cookie,
        csrf,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{token}");
    let key = KeyPair::generate().unwrap();
    let csr = CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    let response = client(pki, None)
        .post(format!("https://127.0.0.1:{port}/agent/v1/enroll"))
        .json(&json!({"protocol_version":1,"request_id":uuid::Uuid::new_v4().to_string(),"token":token["token"],"name":"listener-device","csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    let enrolled: Value = response.json().await.unwrap();
    Identity {
        key,
        certificate: enrolled["certificate_pem"].as_str().unwrap().to_owned(),
    }
}

/// The agent TLS listener, exactly as the server runs it.
struct Listener {
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    port: u16,
}
async fn listen(state: &State, pki: &ServerPki) -> Listener {
    let port = free_port();
    let (state, certificate, key) = (state.clone(), pki.certificate.clone(), pki.key.clone());
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
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the agent listener did not start");
}
async fn state(root: &std::path::Path) -> State {
    initialize(Settings {
        data_dir: root.join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: root.join("dist"),
        releases_dir: root.join("releases"),
        instance_name: "Test".into(),
        ..Default::default()
    })
    .await
    .unwrap()
}

/// Connections that complete TCP and then say nothing, as a flood of idle
/// sockets does: up to `count`, fewer where the descriptor limit is low (each
/// one takes a descriptor here and another in the listener).
async fn silent(port: u16, count: usize) -> Vec<tokio::net::TcpStream> {
    let mut held = Vec::with_capacity(count);
    for _ in 0..count {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(socket) => held.push(socket),
            Err(_) => break,
        }
    }
    held
}

#[tokio::test]
async fn silent_connections_do_not_hold_up_a_real_device() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let pki = server_pki(&temp.path().join("listener"));
    let state = state(temp.path()).await;
    let listener = listen(&state, &pki).await;
    let device = enroll_device(&state, &pki, listener.port).await;

    // More silent sockets than the handshake slots there used to be: if they
    // held slots, a real device's handshake would wait behind them.
    let mut idle = silent(listener.port, 300).await;
    if idle.len() < 140 {
        eprintln!(
            "skipped: only {} silent sockets fit this machine's descriptor limit, \
             fewer than the 128 handshake slots there used to be",
            idle.len()
        );
        return;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;

    let started = std::time::Instant::now();
    let identity = client(&pki, Some((&device.certificate, &device.key)));
    let answered = tokio::time::timeout(
        Duration::from_secs(2),
        identity
            .get(format!(
                "https://127.0.0.1:{}/agent/v1/identity",
                listener.port
            ))
            .send(),
    )
    .await;
    let response = answered
        .unwrap_or_else(|_| {
            panic!(
                "a mutually authenticated request waited {:?} behind silent connections",
                started.elapsed()
            )
        })
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.json::<Value>().await.unwrap()["name"],
        "listener-device"
    );

    // A connection that sends nothing is closed long before the ten seconds a
    // handshake may take.
    let mut byte = [0u8; 1];
    let closed = tokio::time::timeout(Duration::from_secs(6), idle[0].read(&mut byte)).await;
    assert!(
        matches!(closed, Ok(Ok(0)) | Ok(Err(_))),
        "a silent connection was still open after six seconds"
    );
    drop(idle);
    listener.task.abort();
}

/// A listener whose first accepts fail with the errors it is given, as when a
/// descriptor limit is reached or a connection is aborted.
struct Failing {
    listener: tokio::net::TcpListener,
    errors: std::collections::VecDeque<std::io::Error>,
}
impl device::Accept for Failing {
    fn accept(
        &mut self,
    ) -> impl std::future::Future<
        Output = std::io::Result<(tokio::net::TcpStream, std::net::SocketAddr)>,
    > + Send {
        async move {
            if let Some(error) = self.errors.pop_front() {
                return Err(error);
            }
            self.listener.accept().await
        }
    }
}
fn too_many_open_files() -> std::io::Error {
    #[cfg(unix)]
    {
        std::io::Error::from_raw_os_error(24)
    }
    #[cfg(not(unix))]
    {
        std::io::Error::other("too many open files")
    }
}

#[tokio::test]
async fn failed_accepts_are_waited_out_and_the_listener_keeps_serving() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let pki = server_pki(&temp.path().join("listener"));
    let state = state(temp.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = state.keys.tls_config(&pki.certificate, &pki.key).unwrap();
    let errors = [
        too_many_open_files(),
        std::io::Error::from(std::io::ErrorKind::ConnectionAborted),
        too_many_open_files(),
        too_many_open_files(),
    ];
    let task = tokio::spawn(device::serve_tls_on(
        state.clone(),
        Failing {
            listener,
            errors: errors.into(),
        },
        config,
    ));

    // The connection made while accept was failing is served once it recovers.
    let response = client(&pki, None)
        .get(format!("https://127.0.0.1:{port}/agent/v1/identity"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);
    assert!(
        !task.is_finished(),
        "the listener ended after a failed accept"
    );
    // And it goes on serving.
    let response = client(&pki, None)
        .get(format!("https://127.0.0.1:{port}/agent/v1/identity"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 401);
    task.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn a_listener_that_can_never_accept_again_ends_with_its_reason() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let pki = server_pki(&temp.path().join("listener"));
    let state = state(temp.path()).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = state.keys.tls_config(&pki.certificate, &pki.key).unwrap();
    // EBADF: the descriptor is not an open socket.
    let task = tokio::spawn(device::serve_tls_on(
        state.clone(),
        Failing {
            listener,
            errors: [too_many_open_files(), std::io::Error::from_raw_os_error(9)].into(),
        },
        config,
    ));
    let ended = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("an unusable listener kept running")
        .unwrap();
    let error = ended.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("the agent listener cannot accept connections"),
        "{error:#}"
    );
}

/// A server process with a small descriptor limit, started as an operator's
/// service manager could start it.
#[cfg(unix)]
struct Server {
    child: std::process::Child,
    log: PathBuf,
}
#[cfg(unix)]
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[cfg(unix)]
impl Server {
    fn log(&self) -> String {
        std::fs::read_to_string(&self.log).unwrap_or_default()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn running_out_of_descriptors_never_ends_the_server() {
    let temp = tempfile::tempdir().unwrap();
    let pki = server_pki(temp.path());
    let secret = temp.path().join("bootstrap");
    std::fs::write(&secret, SECRET).unwrap();
    // Keep both ephemeral ports reserved together while choosing them. Calling
    // free_port twice can return the same port after the first socket closes.
    let web_reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let agent_reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let web = web_reservation.local_addr().unwrap().port();
    let agent = agent_reservation.local_addr().unwrap().port();
    drop((web_reservation, agent_reservation));
    let log = temp.path().join("server.log");
    let output = std::fs::File::create(&log).unwrap();
    let child = std::process::Command::new("sh")
        .args([
            "-c",
            "ulimit -n 80 && exec \"$0\"",
            env!("CARGO_BIN_EXE_vectory-server"),
        ])
        .env("VECTORY_DATA_DIR", temp.path().join("state"))
        .env("VECTORY_HTTP_ADDR", format!("127.0.0.1:{web}"))
        .env("VECTORY_AGENT_ADDR", format!("127.0.0.1:{agent}"))
        .env("VECTORY_TLS_CERT", &pki.certificate)
        .env("VECTORY_TLS_KEY", &pki.key)
        .env("VECTORY_BOOTSTRAP_SECRET_FILE", &secret)
        .env("VECTORY_COOKIE_SECURE", "false")
        .env("VECTORY_DEVELOPMENT", "true")
        .env("VECTORY_DASHBOARD_DIR", temp.path())
        .env("VECTORY_RELEASES_DIR", temp.path().join("releases"))
        .stdout(output.try_clone().unwrap())
        .stderr(output)
        .spawn()
        .unwrap();
    let mut server = Server { child, log };
    let probe = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();
    let status = || async {
        probe
            .get(format!("http://127.0.0.1:{web}/api/v1/status"))
            .header(reqwest::header::CONNECTION, "close")
            .send()
            .await
            .map(|response| response.status().as_u16())
    };
    // This process migrates a fresh database. On a heavily loaded CI host,
    // startup can take longer than the descriptor-pressure phase itself.
    let startup = std::time::Instant::now();
    loop {
        if let Ok(200) = status().await {
            break;
        }
        assert!(
            server.child.try_wait().unwrap().is_none(),
            "the server exited during startup: {}",
            server.log()
        );
        assert!(
            startup.elapsed() < Duration::from_secs(90),
            "the server did not start within 90 seconds: {}",
            server.log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The dashboard starts just before the agent listener. Wait for both so a
    // scheduler pause at that boundary cannot turn the flood into refusals.
    let agent_probe = client(&pki, None);
    let agent_startup = std::time::Instant::now();
    loop {
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            agent_probe
                .get(format!("https://127.0.0.1:{agent}/agent/v1/identity"))
                .header(reqwest::header::CONNECTION, "close")
                .send(),
        )
        .await;
        if let Ok(Ok(response)) = response {
            if response.status().as_u16() == 401 {
                break;
            }
        }
        assert!(
            server.child.try_wait().unwrap().is_none(),
            "the server exited before the agent listener was ready: {}",
            server.log()
        );
        assert!(
            agent_startup.elapsed() < Duration::from_secs(10),
            "the agent listener did not start: {}",
            server.log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // A silent TCP peer is dropped at the client-hello deadline. Complete TLS
    // without sending an HTTP request so the server keeps each accepted socket
    // open while the burst exhausts its descriptor limit.
    let mut roots = rustls::RootCertStore::empty();
    roots.add(pki.ca.clone()).unwrap();
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(tls));
    let name = rustls::pki_types::ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into());
    let address: std::net::SocketAddr = ([127, 0, 0, 1], agent).into();
    let started = std::time::Instant::now();
    let mut attempts = tokio::task::JoinSet::new();
    for _ in 0..300 {
        let connector = connector.clone();
        let name = name.clone();
        attempts.spawn(async move {
            tokio::time::timeout(Duration::from_secs(2), async {
                let socket = tokio::net::TcpStream::connect(address).await?;
                connector.connect(name, socket).await
            })
            .await
        });
    }
    let mut held = Vec::new();
    while let Some(result) = attempts.join_next().await {
        if let Ok(Ok(Ok(connection))) = result {
            held.push(connection);
        }
    }
    let mut exhausted = false;
    for _ in 0..100 {
        if server.log().contains("os error 24") {
            exhausted = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        exhausted,
        "the test held {} TLS connections over {:?} but never ran the server out of descriptors: {}",
        held.len(),
        started.elapsed(),
        server.log()
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        server.child.try_wait().unwrap().is_none(),
        "the server exited when accept failed: {}",
        server.log()
    );
    assert!(
        server
            .log()
            .contains("the agent listener could not accept a connection"),
        "the agent listener said nothing about the failed accept: {}",
        server.log()
    );

    // Once the connections go, the dashboard listener answers again.
    drop(held);
    let recovery = std::time::Instant::now();
    loop {
        if let Ok(200) = status().await {
            break;
        }
        assert!(
            recovery.elapsed() < Duration::from_secs(20),
            "/api/v1/status never answered again: {}",
            server.log()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(server.child.try_wait().unwrap().is_none());
}
