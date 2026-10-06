//! A renewed listener certificate is used for new handshakes while an existing
//! connection and the agent CA pin remain valid. Broken replacements fail closed
//! to the last validated snapshot, including the Add device certificate hint.
use rcgen::{BasicConstraints, CertificateParams, IsCa, Issuer, KeyPair, KeyUsagePurpose, SanType};
use rustls::pki_types::{CertificateDer, ServerName};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vectory_server::{Settings, device, initialize, install, tls_reload};

fn write_leaf(
    dir: &Path,
    issuer: &Issuer<'static, KeyPair>,
    ca_pem: &str,
) -> CertificateDer<'static> {
    let key = KeyPair::generate().unwrap();
    let mut leaf = CertificateParams::default();
    leaf.subject_alt_names = vec![SanType::IpAddress(std::net::Ipv4Addr::LOCALHOST.into())];
    let certificate = leaf.signed_by(&key, issuer).unwrap();
    std::fs::write(
        dir.join("server.pem"),
        format!("{}{}", certificate.pem(), ca_pem),
    )
    .unwrap();
    std::fs::write(dir.join("key.pem"), key.serialize_pem()).unwrap();
    certificate.der().clone()
}

#[tokio::test]
async fn new_handshakes_renew_existing_connection_and_trust_survive_bad_pair_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let mut ca = CertificateParams::default();
    ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let ca_key = KeyPair::generate().unwrap();
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let ca_pem = ca_cert.pem();
    let issuer = Issuer::from_ca_cert_pem(&ca_pem, ca_key).unwrap();
    let first = write_leaf(temp.path(), &issuer, &ca_pem);
    let cert = temp.path().join("server.pem");
    let key = temp.path().join("key.pem");
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        agent_certificate_pem: Some(std::fs::read_to_string(&cert).unwrap()),
        ..Default::default()
    })
    .await
    .unwrap();
    assert!(tls_reload::refresh(&state, &cert, &key).unwrap());
    assert!(!tls_reload::refresh(&state, &cert, &key).unwrap());
    let pin = install::trust_for_state(&state, "https://127.0.0.1:8443")
        .pin
        .unwrap()
        .sha256;
    let initial_config = state
        .agent_tls
        .read()
        .unwrap()
        .as_ref()
        .unwrap()
        .config
        .as_ref()
        .clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let service = tokio::spawn(device::serve_tls_on(
        state.clone(),
        listener,
        initial_config,
    ));
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca_cert.der().clone()).unwrap();
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])
    .unwrap()
    .with_root_certificates(roots)
    .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let connect = || async {
        connector
            .connect(
                ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into()),
                tokio::net::TcpStream::connect(address).await.unwrap(),
            )
            .await
            .unwrap()
    };
    let mut existing = connect().await;
    assert_eq!(existing.get_ref().1.peer_certificates().unwrap()[0], first);
    let second = write_leaf(temp.path(), &issuer, &ca_pem);
    assert!(tls_reload::refresh(&state, &cert, &key).unwrap());
    let renewed = connect().await;
    assert_eq!(renewed.get_ref().1.peer_certificates().unwrap()[0], second);
    assert_ne!(first, second);
    assert_eq!(
        install::trust_for_state(&state, "https://127.0.0.1:8443")
            .pin
            .unwrap()
            .sha256,
        pin
    );
    {
        use rustls::pki_types::pem::PemObject;
        let snapshot = state.agent_tls.read().unwrap();
        let chain = &snapshot.as_ref().unwrap().certificate_pem;
        assert_eq!(
            CertificateDer::from_pem_slice(chain.as_bytes()).unwrap(),
            second
        );
    }

    // The old connection still serves requests without a disconnect/restart.
    existing
        .write_all(
            b"GET /agent/v1/install.sh HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), existing.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200"));

    // A half-written key cannot be accepted or change the public CA hint.
    std::fs::write(&key, "not a private key").unwrap();
    assert!(tls_reload::refresh(&state, &cert, &key).is_err());
    let retained = connect().await;
    assert_eq!(retained.get_ref().1.peer_certificates().unwrap()[0], second);
    assert_eq!(
        install::trust_for_state(&state, "https://127.0.0.1:8443")
            .pin
            .unwrap()
            .sha256,
        pin
    );
    std::fs::write(&cert, vec![b'x'; 65_537]).unwrap();
    assert!(tls_reload::refresh(&state, &cert, &key).is_err());
    service.abort();
    let _ = service.await;
}
