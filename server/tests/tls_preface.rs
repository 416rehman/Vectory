//! A completed agent TLS handshake cannot park a connection forever before
//! hyper-util selects HTTP/1 or HTTP/2.
use http_body_util::{BodyExt, Empty};
use hyper::{Request, body::Bytes};
use hyper_util::rt::{TokioExecutor, TokioIo};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType,
};
use rustls::pki_types::{CertificateDer, ServerName};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use vectory_server::{Settings, device, initialize};

fn server_certificate(dir: &std::path::Path) -> (PathBuf, PathBuf, CertificateDer<'static>) {
    let ca_key = KeyPair::generate().unwrap();
    let mut ca = CertificateParams::default();
    ca.distinguished_name
        .push(DnType::CommonName, "preface test CA");
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let issuer = Issuer::from_ca_cert_pem(&ca_cert.pem(), ca_key).unwrap();
    let key = KeyPair::generate().unwrap();
    let mut leaf = CertificateParams::default();
    leaf.subject_alt_names = vec![SanType::IpAddress(std::net::Ipv4Addr::LOCALHOST.into())];
    let certificate = leaf.signed_by(&key, &issuer).unwrap();
    let cert_path = dir.join("server.pem");
    let key_path = dir.join("server-key.pem");
    std::fs::write(&cert_path, certificate.pem()).unwrap();
    std::fs::write(&key_path, key.serialize_pem()).unwrap();
    (cert_path, key_path, ca_cert.der().clone())
}

fn connector(ca: CertificateDer<'static>, alpn: &[u8]) -> tokio_rustls::TlsConnector {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca).unwrap();
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    config.alpn_protocols = vec![alpn.to_vec()];
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

async fn connect(
    connector: &tokio_rustls::TlsConnector,
    address: std::net::SocketAddr,
) -> tokio_rustls::client::TlsStream<TcpStream> {
    let tcp = TcpStream::connect(address).await.unwrap();
    connector
        .connect(
            ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into()),
            tcp,
        )
        .await
        .unwrap()
}

async fn until_closed(reader: &mut (impl AsyncRead + Unpin)) {
    let mut bytes = [0u8; 1024];
    loop {
        match reader.read(&mut bytes).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

#[tokio::test]
async fn incomplete_first_requests_expire_while_http1_and_http2_still_work() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let temp = tempfile::tempdir().unwrap();
    let (cert, key, ca) = server_certificate(temp.path());
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "preface-test-bootstrap-secret-12345".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Preface test".into(),
        ..Default::default()
    })
    .await
    .unwrap();
    let server_config = state.keys.tls_config(&cert, &key).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(device::serve_tls_on(state, listener, server_config));

    let h1 = connector(ca.clone(), b"http/1.1");
    let h2 = connector(ca, b"h2");
    let (mut idle, mut partial_h2, mut complete_h2, mut partial_h1) = tokio::join!(
        connect(&h1, address),
        connect(&h2, address),
        connect(&h2, address),
        connect(&h1, address),
    );
    partial_h2.write_all(b"PRI * HTTP/2.0\r\n").await.unwrap();
    complete_h2
        .write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
        .await
        .unwrap();
    partial_h1
        .write_all(b"GET /agent/v1/identity HTTP/1.1\r\nHost: ")
        .await
        .unwrap();
    let opened = Instant::now();

    // The server may send its own HTTP/2 SETTINGS after a complete preface;
    // read through any such frames while waiting for the connection to end.
    let (idle_early, partial_h2_early, complete_h2_early, partial_h1_early) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(1), until_closed(&mut idle)),
        tokio::time::timeout(Duration::from_secs(1), until_closed(&mut partial_h2)),
        tokio::time::timeout(Duration::from_secs(1), until_closed(&mut complete_h2)),
        tokio::time::timeout(Duration::from_secs(1), until_closed(&mut partial_h1)),
    );
    assert!(idle_early.is_err(), "idle TLS closed before its deadline");
    assert!(
        partial_h2_early.is_err(),
        "partial HTTP/2 preface closed early"
    );
    assert!(
        complete_h2_early.is_err(),
        "complete HTTP/2 preface closed early"
    );
    assert!(
        partial_h1_early.is_err(),
        "partial HTTP/1 header closed early"
    );

    let (mut h1_sender, h1_connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(connect(&h1, address).await))
            .await
            .unwrap();
    tokio::spawn(h1_connection);
    let h1_request = || {
        Request::builder()
            .uri("/agent/v1/identity")
            .header("host", "vectory.test")
            .body(Empty::<Bytes>::new())
            .unwrap()
    };
    let response = h1_sender.send_request(h1_request()).await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(response.version(), hyper::Version::HTTP_11);
    response.into_body().collect().await.unwrap();

    let (mut h2_sender, h2_connection) = hyper::client::conn::http2::handshake(
        TokioExecutor::new(),
        TokioIo::new(connect(&h2, address).await),
    )
    .await
    .unwrap();
    tokio::spawn(h2_connection);
    let h2_request = || {
        Request::builder()
            .uri("https://vectory.test/agent/v1/identity")
            .body(Empty::<Bytes>::new())
            .unwrap()
    };
    let response = h2_sender.send_request(h2_request()).await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(response.version(), hyper::Version::HTTP_2);
    response.into_body().collect().await.unwrap();

    let (idle_closed, partial_h2_closed, complete_h2_closed, partial_h1_closed) = tokio::join!(
        tokio::time::timeout(Duration::from_secs(17), until_closed(&mut idle)),
        tokio::time::timeout(Duration::from_secs(17), until_closed(&mut partial_h2)),
        tokio::time::timeout(Duration::from_secs(17), until_closed(&mut complete_h2)),
        tokio::time::timeout(Duration::from_secs(17), until_closed(&mut partial_h1)),
    );
    assert!(
        idle_closed.is_ok(),
        "idle TLS remained open after the deadline"
    );
    assert!(
        partial_h2_closed.is_ok(),
        "partial HTTP/2 preface remained open"
    );
    assert!(
        complete_h2_closed.is_ok(),
        "complete HTTP/2 preface remained open"
    );
    assert!(
        partial_h1_closed.is_ok(),
        "partial HTTP/1 header remained open"
    );
    assert!(opened.elapsed() >= Duration::from_secs(14));

    // The first-request deadline no longer applies to an established
    // keep-alive connection, even when it has been idle past that deadline.
    let response = h1_sender.send_request(h1_request()).await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(response.version(), hyper::Version::HTTP_11);
    response.into_body().collect().await.unwrap();
    let response = h2_sender.send_request(h2_request()).await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(response.version(), hyper::Version::HTTP_2);
    response.into_body().collect().await.unwrap();
    server.abort();
}
