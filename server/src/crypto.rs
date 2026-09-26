use crate::{
    db,
    error::{ApiError, Result},
};
use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use rcgen::{
    BasicConstraints, CertificateParams, CertificateSigningRequestParams, DistinguishedName,
    DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, PublicKeyData,
};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub struct Keys {
    pub ca_pem: String,
    pub issuer: Issuer<'static, KeyPair>,
    pub signing: SigningKey,
    previous_signing: std::collections::HashMap<String, SigningKey>,
    mfa_sealing: [u8; 32],
}
pub struct Issued {
    pub response: Value,
    pub fingerprint: String,
    pub key_hash: String,
    pub expires: String,
}
fn private_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
pub fn restrict_dir(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        crate::windows_acl::protect(path, true)?;
    }
    Ok(())
}
pub fn restrict_tree(path: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("State directory must not contain reparse points")
        }
    }
    if metadata.file_type().is_symlink() {
        bail!("State directory must not contain symbolic links")
    }
    if metadata.is_dir() {
        restrict_dir(path)?;
        for child in fs::read_dir(path)? {
            restrict_tree(&child?.path())?;
        }
    } else if metadata.is_file() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(windows)]
        crate::windows_acl::protect(path, false)?;
    } else {
        bail!("State directory contains an unsupported special file")
    }
    Ok(())
}
pub fn restrict_state(path: &Path) -> anyhow::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("State root cannot be a reparse point")
        }
    }
    if metadata.file_type().is_symlink() {
        bail!("State root cannot be a symbolic link")
    }
    restrict_dir(path)?;
    for name in [
        "vectory.db",
        "vectory.db-wal",
        "vectory.db-shm",
        "instance.lock",
        "keys",
    ] {
        let owned = path.join(name);
        let volatile_sidecar = matches!(name, "vectory.db-wal" | "vectory.db-shm");
        for attempt in 0..=5 {
            let outcome = match fs::symlink_metadata(&owned) {
                Ok(_) => restrict_tree(&owned),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.into()),
            };
            match outcome {
                Ok(()) => break,
                Err(error) => {
                    // SQLite closes/removes its optional sidecars asynchronously. On
                    // Windows delete-pending files can briefly report AccessDenied.
                    // Retry only these transient I/O errors; a persistent denial or
                    // any reparse-point validation error remains a startup failure.
                    let transient = error
                        .chain()
                        .filter_map(|e| e.downcast_ref::<std::io::Error>())
                        .any(|e| {
                            matches!(
                                e.kind(),
                                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
                            )
                        });
                    if volatile_sidecar && transient && attempt < 5 {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        continue;
                    }
                    return Err(error).with_context(|| {
                        format!("Cannot protect owned state path {}", owned.display())
                    });
                }
            }
        }
    }
    Ok(())
}
impl Keys {
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        fs::create_dir_all(path)?;
        restrict_dir(path)?;
        let ca_file = path.join("device-ca.pem");
        let ca_key = path.join("device-ca-key.pem");
        let signing_file = path.join("manifest-signing.key");
        let count = [&ca_file, &ca_key, &signing_file]
            .iter()
            .filter(|p| p.exists())
            .count();
        if count != 0 && count != 3 {
            bail!("Incomplete key material; restore the complete keys directory from backup")
        }
        if count == 0 {
            let key = KeyPair::generate()?;
            let mut params = CertificateParams::default();
            params.distinguished_name = DistinguishedName::new();
            params
                .distinguished_name
                .push(DnType::CommonName, "Vectory device CA");
            params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            params.not_before = time::OffsetDateTime::now_utc() - time::Duration::minutes(5);
            params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(3650);
            let cert = params.self_signed(&key)?;
            let mut secret = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut secret);
            private_write(&ca_key, key.serialize_pem().as_bytes())?;
            private_write(&ca_file, cert.pem().as_bytes())?;
            private_write(&signing_file, &secret)?;
        }
        let ca_pem = fs::read_to_string(ca_file)?;
        let ca_key = KeyPair::from_pem(&fs::read_to_string(ca_key)?)?;
        let der = CertificateDer::pem_slice_iter(ca_pem.as_bytes())
            .next()
            .context("Device CA certificate missing")??;
        let (_, parsed) = x509_parser::parse_x509_certificate(&der)
            .map_err(|_| anyhow::anyhow!("Device CA certificate is invalid"))?;
        if parsed.public_key().subject_public_key.data.as_ref() != ca_key.public_key_raw()
            || !parsed.is_ca()
        {
            bail!(
                "Device CA certificate and private key do not match, or certificate is not a CA; restore a complete matching key set"
            )
        }
        let issuer = Issuer::from_ca_cert_pem(&ca_pem, ca_key)?;
        let raw: [u8; 32] = fs::read(signing_file)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid manifest signing key length"))?;
        let mfa_file = path.join("mfa-sealing.key");
        if !mfa_file.exists() {
            let mut key = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            private_write(&mfa_file, &key)?;
        }
        let mfa_sealing: [u8; 32] = fs::read(mfa_file)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid MFA sealing key length"))?;
        let history = path.join("signing-history");
        let mut previous_signing = std::collections::HashMap::new();
        if history.exists() {
            for entry in fs::read_dir(&history)? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    bail!("Signing history must contain only regular key files")
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let Some(id) = name.strip_suffix(".key") else {
                    bail!("Invalid signing history filename")
                };
                let bytes: [u8; 32] = fs::read(entry.path())?
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("Invalid previous signing key"))?;
                let key = SigningKey::from_bytes(&bytes);
                if db::hash(key.verifying_key().as_bytes()) != id {
                    bail!("Signing history key identity mismatch")
                }
                previous_signing.insert(id.to_owned(), key);
                if previous_signing.len() > 4 {
                    bail!("Signing history exceeds the four-key overlap bound")
                }
            }
        }
        Ok(Self {
            ca_pem,
            issuer,
            signing: SigningKey::from_bytes(&raw),
            previous_signing,
            mfa_sealing,
        })
    }
    pub fn active_signing_id(&self) -> String {
        db::hash(self.signing.verifying_key().as_bytes())
    }
    pub fn has_signing_id(&self, id: &str) -> bool {
        self.active_signing_id() == id || self.previous_signing.contains_key(id)
    }
    pub fn previous_signing_ids(&self) -> Vec<String> {
        self.previous_signing.keys().cloned().collect()
    }
    pub fn envelope_for(&self, id: &str, payload: &Value) -> Result<Value> {
        let key = if id == self.active_signing_id() {
            &self.signing
        } else {
            self.previous_signing.get(id).ok_or_else(|| {
                ApiError::conflict(
                    "Registered signing key unavailable; restore matching key material",
                )
            })?
        };
        let bytes = serde_json::to_vec(payload).expect("JSON value serializes");
        let signature = key.sign(&bytes);
        Ok(
            json!({"payload":STANDARD.encode(bytes),"signature":STANDARD.encode(signature.to_bytes())}),
        )
    }
    pub fn seal_mfa(&self, user: &str, secret: &str) -> Result<String> {
        use aes_gcm::{
            Aes256Gcm, KeyInit, Nonce,
            aead::{Aead, Payload},
        };
        let mut nonce = [0u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher =
            Aes256Gcm::new_from_slice(&self.mfa_sealing).map_err(|_| ApiError::forbidden())?;
        let encrypted = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: user.as_bytes(),
                },
            )
            .map_err(|_| ApiError::forbidden())?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&encrypted);
        Ok(STANDARD.encode(out))
    }
    pub fn open_mfa(&self, user: &str, value: &str) -> Result<String> {
        use aes_gcm::{
            Aes256Gcm, KeyInit, Nonce,
            aead::{Aead, Payload},
        };
        let data = STANDARD.decode(value).map_err(|_| ApiError::forbidden())?;
        if data.len() < 28 {
            return Err(ApiError::forbidden());
        }
        let cipher =
            Aes256Gcm::new_from_slice(&self.mfa_sealing).map_err(|_| ApiError::forbidden())?;
        let decrypted = cipher
            .decrypt(
                Nonce::from_slice(&data[..12]),
                Payload {
                    msg: &data[12..],
                    aad: user.as_bytes(),
                },
            )
            .map_err(|_| ApiError::forbidden())?;
        String::from_utf8(decrypted).map_err(|_| ApiError::forbidden())
    }
    pub fn csr_key_hash(csr: &str) -> Result<String> {
        let request =
            CertificateSigningRequestParams::from_pem(csr).map_err(|_| ApiError::enrollment())?;
        Ok(db::hash(request.public_key.der_bytes()))
    }
    pub fn issue(&self, device: &str, csr: &str) -> Result<Issued> {
        let mut request =
            CertificateSigningRequestParams::from_pem(csr).map_err(|_| ApiError::enrollment())?;
        let key_hash = db::hash(request.public_key.der_bytes());
        // Discard every caller-selected extension, subject, serial and privilege.
        let mut params = CertificateParams::default();
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, device);
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
        let issued = chrono::Utc::now().timestamp();
        let expires_seconds = issued + 30 * 24 * 60 * 60;
        params.not_before = time::OffsetDateTime::from_unix_timestamp(issued - 60)
            .map_err(|_| ApiError::enrollment())?;
        params.not_after = time::OffsetDateTime::from_unix_timestamp(expires_seconds)
            .map_err(|_| ApiError::enrollment())?;
        params.serial_number = Some(uuid::Uuid::new_v4().as_bytes().to_vec().into());
        request.params = params;
        let cert = request
            .signed_by(&self.issuer)
            .map_err(|_| ApiError::enrollment())?;
        let expires = chrono::DateTime::from_timestamp(expires_seconds, 0)
            .ok_or_else(ApiError::enrollment)?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let response = json!({"device_id":device,"certificate_pem":cert.pem(),"ca_pem":self.ca_pem,"signing_public_key":STANDARD.encode(self.signing.verifying_key().as_bytes()),"certificate_expires_at":expires});
        Ok(Issued {
            response,
            fingerprint: db::hash(cert.der()),
            key_hash,
            expires,
        })
    }
    pub fn envelope(&self, payload: &Value) -> Value {
        let bytes = serde_json::to_vec(payload).expect("JSON value serializes");
        let signature = self.signing.sign(&bytes);
        json!({"payload":STANDARD.encode(bytes),"signature":STANDARD.encode(signature.to_bytes())})
    }
    pub fn tls_config(
        &self,
        certificate: &Path,
        key: &Path,
    ) -> anyhow::Result<rustls::ServerConfig> {
        let certs = CertificateDer::pem_file_iter(certificate)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let key = PrivateKeyDer::from_pem_file(key)?;
        let mut roots = rustls::RootCertStore::empty();
        for cert in CertificateDer::pem_slice_iter(self.ca_pem.as_bytes()) {
            roots.add(cert?)?;
        }
        // Explicit host-admin supplied trust overlap permits old registered clients
        // to renew into a replacement dedicated device CA. Registry/revocation
        // authorization is still checked on every request, including pooled TLS.
        if let Ok(path) = std::env::var("VECTORY_PREVIOUS_DEVICE_CA") {
            let previous = fs::read(path)?;
            if previous.len() > 65536 {
                bail!("Previous device CA bundle is too large")
            }
            for cert in CertificateDer::pem_slice_iter(&previous) {
                roots.add(cert?)?;
            }
        }
        let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
        let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
            std::sync::Arc::new(roots),
            provider.clone(),
        )
        .allow_unauthenticated()
        .build()?;
        let mut config = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_client_cert_verifier(verifier)
            .with_single_cert(certs, key)?;
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        Ok(config)
    }
}
