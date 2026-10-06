//! Renew the listener certificate without dropping enrolled connections.
//! A certificate/key pair is parsed and matched before the shared snapshot
//! changes. The dashboard uses that same accepted chain, never a half-written
//! certificate file. Invalid replacements retain the previous configuration.
use crate::{State, db};
use anyhow::{Context, bail};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const MAX_PEM_BYTES: u64 = 65_536;
#[derive(Clone)]
pub struct Snapshot {
    pub config: Arc<rustls::ServerConfig>,
    pub certificate_pem: String,
    source_sha256: String,
}

fn read_pem(path: &Path) -> anyhow::Result<Vec<u8>> {
    let metadata = std::fs::symlink_metadata(path).context("Cannot inspect agent TLS file")?;
    if !metadata.is_file() || metadata.len() > MAX_PEM_BYTES {
        bail!("Agent TLS PEM must be a regular file of at most 65536 bytes");
    }
    let file = std::fs::File::open(path).context("Cannot open agent TLS file")?;
    if !file.metadata()?.is_file() {
        bail!("Agent TLS PEM must be a regular file");
    }
    let mut bytes = Vec::new();
    file.take(MAX_PEM_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PEM_BYTES {
        bail!("Agent TLS PEM exceeds 65536 bytes");
    }
    Ok(bytes)
}

pub fn load(state: &State, cert: &Path, key: &Path) -> anyhow::Result<Snapshot> {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    let certificate = read_pem(cert)?;
    let private_key = read_pem(key)?;
    let config = state.keys.tls_config_from_pem(&certificate, &private_key)?;
    let leaf = CertificateDer::from_pem_slice(&certificate)?;
    let (_, leaf) = x509_parser::parse_x509_certificate(&leaf)
        .map_err(|_| anyhow::anyhow!("Cannot parse agent TLS leaf certificate"))?;
    if !leaf.validity().is_valid() {
        bail!("Agent TLS leaf certificate is not valid now");
    }
    // Hashes are internal change detection only, never logged or sent to clients.
    let source_sha256 = db::hash(format!(
        "{}:{}",
        db::hash(&certificate),
        db::hash(&private_key)
    ));
    Ok(Snapshot {
        config: Arc::new(config),
        certificate_pem: String::from_utf8(certificate).context("Agent TLS PEM is not UTF-8")?,
        source_sha256,
    })
}

pub fn refresh(state: &State, cert: &Path, key: &Path) -> anyhow::Result<bool> {
    let replacement = load(state, cert, key)?;
    let mut current = state
        .agent_tls
        .write()
        .map_err(|_| anyhow::anyhow!("Agent TLS state unavailable"))?;
    if current
        .as_ref()
        .is_some_and(|old| old.source_sha256 == replacement.source_sha256)
    {
        return Ok(false);
    }
    *current = Some(replacement);
    Ok(true)
}

pub struct Watch(tokio::task::JoinHandle<()>);
impl Drop for Watch {
    fn drop(&mut self) {
        self.0.abort();
    }
}
pub fn watch(state: &State, cert: PathBuf, key: PathBuf) -> Watch {
    let weak = Arc::downgrade(state);
    Watch(tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut warned = false;
        loop {
            interval.tick().await;
            let Some(state) = weak.upgrade() else { break };
            let cert = cert.clone();
            let key = key.clone();
            let result = tokio::task::spawn_blocking(move || refresh(&state, &cert, &key)).await;
            match result {
                Ok(Ok(changed)) => {
                    if changed {
                        tracing::info!("Agent TLS certificate renewed for new connections");
                    }
                    warned = false;
                }
                _ if !warned => {
                    tracing::warn!(
                        "Cannot accept the replacement agent TLS certificate and key; retaining the last validated certificate"
                    );
                    warned = true;
                }
                _ => {}
            }
        }
    }))
}
