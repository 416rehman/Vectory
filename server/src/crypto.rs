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
    device_ca: DeviceCa,
    /// The device CA a rotation replaced, with its PEM: still trusted for
    /// client certificates until `retire-device-ca` removes it.
    previous_device_ca: Option<(String, DeviceCa)>,
}
pub struct Issued {
    pub response: Value,
    pub fingerprint: String,
    pub key_hash: String,
    pub expires: String,
    /// SHA-256 of the DER of the device CA that signed the certificate.
    pub ca_id: String,
}
/// Files of the dedicated device CA inside the keys directory.
pub const DEVICE_CA: &str = "device-ca.pem";
pub const DEVICE_CA_KEY: &str = "device-ca-key.pem";
/// The CA a rotation replaced (certificate only; its key is not kept).
pub const PREVIOUS_DEVICE_CA: &str = "device-ca-previous.pem";
/// A rotation's new CA before it becomes current (see `settle_device_ca_rotation`).
pub const NEXT_DEVICE_CA: &str = "device-ca-next.pem";
pub const NEXT_DEVICE_CA_KEY: &str = "device-ca-next-key.pem";
/// Public facts about a device CA certificate, for status and audit.
#[derive(Clone, Debug, PartialEq)]
pub struct DeviceCa {
    /// SHA-256 of the certificate DER, lowercase hex: the fingerprint devices
    /// and operators compare, and the issuer ID recorded on each credential.
    pub sha256: String,
    pub subject: String,
    pub not_before: String,
    pub not_after: String,
}
impl DeviceCa {
    /// Parse the first certificate of a PEM file, which must be a CA.
    pub fn from_pem(pem: &str) -> anyhow::Result<Self> {
        let der = CertificateDer::pem_slice_iter(pem.as_bytes())
            .next()
            .context("Device CA certificate missing")??;
        let (_, parsed) = x509_parser::parse_x509_certificate(&der)
            .map_err(|_| anyhow::anyhow!("Device CA certificate is invalid"))?;
        if !parsed.is_ca() {
            bail!("Device CA certificate is not a CA certificate")
        }
        let time = |seconds: i64| {
            chrono::DateTime::from_timestamp(seconds, 0)
                .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .context("Device CA validity is out of range")
        };
        Ok(Self {
            sha256: db::hash(&der),
            subject: parsed.subject().to_string(),
            not_before: time(parsed.validity().not_before.timestamp())?,
            not_after: time(parsed.validity().not_after.timestamp())?,
        })
    }
    pub fn summary(&self) -> Value {
        json!({"sha256":self.sha256,"subject":self.subject,"not_before":self.not_before,"not_after":self.not_after})
    }
}
/// A new self-signed device CA valid for ten years: (key PEM, certificate PEM).
pub fn new_device_ca(common_name: &str) -> anyhow::Result<(String, String)> {
    let key = KeyPair::generate()?;
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params
        .distinguished_name
        .push(DnType::CommonName, common_name);
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.not_before = time::OffsetDateTime::now_utc() - time::Duration::minutes(5);
    params.not_after = time::OffsetDateTime::now_utc() + time::Duration::days(3650);
    let cert = params.self_signed(&key)?;
    Ok((key.serialize_pem(), cert.pem()))
}
/// Whether a certificate PEM's public key is the private key's.
fn key_matches(certificate_pem: &str, key: &KeyPair) -> anyhow::Result<bool> {
    let der = CertificateDer::pem_slice_iter(certificate_pem.as_bytes())
        .next()
        .context("Device CA certificate missing")??;
    let (_, parsed) = x509_parser::parse_x509_certificate(&der)
        .map_err(|_| anyhow::anyhow!("Device CA certificate is invalid"))?;
    Ok(parsed.public_key().subject_public_key.data.as_ref() == key.public_key_raw())
}
fn sync_directory(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
/// Finish or undo a device CA rotation that stopped midway. A rotation writes
/// the new CA as `device-ca-next*.pem`, commits by writing
/// `device-ca-previous.pem` (a copy of the current certificate), then renames
/// the new key and certificate over the current ones, key first. Before the
/// commit the new files are discarded; after it the renames are completed.
/// Only `vectory-admin` writes these files, under the data directory lock.
pub fn settle_device_ca_rotation(dir: &Path) -> anyhow::Result<()> {
    let next = dir.join(NEXT_DEVICE_CA);
    let next_key = dir.join(NEXT_DEVICE_CA_KEY);
    if !next.exists() && !next_key.exists() {
        return Ok(());
    }
    if !dir.join(PREVIOUS_DEVICE_CA).exists() {
        for file in [&next_key, &next] {
            if file.exists() {
                fs::remove_file(file)?;
            }
        }
        return sync_directory(dir);
    }
    let incomplete = || {
        anyhow::anyhow!(
            "A device CA rotation stopped midway and its files don't match; restore the complete keys directory from backup"
        )
    };
    if next_key.exists() {
        let certificate = fs::read_to_string(&next).map_err(|_| incomplete())?;
        let key = KeyPair::from_pem(&fs::read_to_string(&next_key)?).map_err(|_| incomplete())?;
        if !key_matches(&certificate, &key).map_err(|_| incomplete())? {
            return Err(incomplete());
        }
        fs::rename(&next_key, dir.join(DEVICE_CA_KEY))?;
        sync_directory(dir)?;
    }
    if next.exists() {
        let certificate = fs::read_to_string(&next)?;
        let key = KeyPair::from_pem(&fs::read_to_string(dir.join(DEVICE_CA_KEY))?)?;
        if !key_matches(&certificate, &key).map_err(|_| incomplete())? {
            return Err(incomplete());
        }
        fs::rename(&next, dir.join(DEVICE_CA))?;
        sync_directory(dir)?;
    }
    Ok(())
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
        settle_device_ca_rotation(path)?;
        let ca_file = path.join(DEVICE_CA);
        let ca_key = path.join(DEVICE_CA_KEY);
        let signing_file = path.join("manifest-signing.key");
        let count = [&ca_file, &ca_key, &signing_file]
            .iter()
            .filter(|p| p.exists())
            .count();
        if count != 0 && count != 3 {
            bail!("Incomplete key material; restore the complete keys directory from backup")
        }
        if count == 0 {
            let (key, cert) = new_device_ca("Vectory device CA")?;
            let mut secret = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut secret);
            private_write(&ca_key, key.as_bytes())?;
            private_write(&ca_file, cert.as_bytes())?;
            private_write(&signing_file, &secret)?;
        }
        let ca_pem = fs::read_to_string(ca_file)?;
        let ca_key = KeyPair::from_pem(&fs::read_to_string(ca_key)?)?;
        let device_ca = DeviceCa::from_pem(&ca_pem)
            .context("Restore a complete matching key set from backup")?;
        if !key_matches(&ca_pem, &ca_key)? {
            bail!(
                "Device CA certificate and private key do not match, or certificate is not a CA; restore a complete matching key set"
            )
        }
        let previous_file = path.join(PREVIOUS_DEVICE_CA);
        let previous_device_ca = if previous_file.exists() {
            if fs::metadata(&previous_file)?.len() > 65536 {
                bail!("The previous device CA file is larger than 64 KiB")
            }
            let pem = fs::read_to_string(&previous_file)?;
            let previous = DeviceCa::from_pem(&pem).context(
                "The previous device CA is unreadable; restore the complete keys directory from backup",
            )?;
            if previous.sha256 == device_ca.sha256 {
                bail!(
                    "The previous device CA is the current one; restore the complete keys directory from backup"
                )
            }
            Some((pem, previous))
        } else {
            None
        };
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
            device_ca,
            previous_device_ca,
        })
    }
    /// The device CA that issues every new and renewed certificate.
    pub fn device_ca(&self) -> &DeviceCa {
        &self.device_ca
    }
    /// The CA a rotation replaced, while it is still trusted.
    pub fn previous_device_ca(&self) -> Option<&DeviceCa> {
        self.previous_device_ca.as_ref().map(|(_, ca)| ca)
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
            ca_id: self.device_ca.sha256.clone(),
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
        // During a rotation's overlap, certificates the previous device CA
        // issued keep working until `retire-device-ca`, so devices can renew
        // onto the new CA. A chain alone never authenticates: the certificate's
        // fingerprint must still be registered, active and unrevoked on every
        // request (`device::authenticated`), including pooled connections.
        if let Some((pem, _)) = &self.previous_device_ca {
            for cert in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                roots.add(cert?)?;
            }
        }
        // The older manual overlap: a bundle an administrator installs, trusted
        // for as long as the variable is set.
        if let Ok(path) = std::env::var("VECTORY_PREVIOUS_DEVICE_CA") {
            tracing::warn!(
                %path,
                "VECTORY_PREVIOUS_DEVICE_CA is set: device certificates from this bundle are trusted for as long as it stays set. vectory-admin rotate-device-ca tracks and retires a previous device CA instead"
            );
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
