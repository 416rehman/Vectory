//! Agent distribution for onboarding: the release catalog (agents bundled with
//! the server, optionally overridden per platform by an operator mirror),
//! streamed downloads, the device-facing installer, and the connection details
//! the Add device page shows.
//!
//! Everything served here without authentication is public by nature: agent
//! binaries, their SHA-256 values, the agent listener's CA certificate and the
//! installer that embeds them. Nothing reveals devices, tokens or users, and
//! the installer never contains an enrollment token.
use crate::{
    ClientAddress, Settings, State, auth, db,
    device::PeerCertificate,
    error::{ApiError, Result},
};
use axum::{
    Extension, Json,
    body::{Body, Bytes},
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime, pem::PemObject};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path as FsPath, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;

pub const BUNDLED: &str = "bundled";
pub const MIRROR: &str = "mirror";
/// Default location of the installed agent on Linux and macOS.
pub const INSTALL_DIR: &str = "/usr/local/bin";
const MAX_RELEASE_BYTES: u64 = 128 * 1024 * 1024;
const OPERATING_SYSTEMS: [&str; 3] = ["linux", "darwin", "windows"];
const ARCHITECTURES: [&str; 2] = ["amd64", "arm64"];
/// Concurrent agent downloads across both listeners. A permit lives as long as
/// its response body, so slow clients can't exhaust memory or file handles.
static DOWNLOADS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(32);
/// How long a client turned away by a download cap is asked to wait. Transfers
/// take seconds, and the installer's curl retries after this delay.
const BUSY_RETRY_SECONDS: u64 = 5;
/// Installer fetches, and agent downloads, a minute from every address
/// together, counted ahead of each address's own budget. Twice the rate at
/// which enrollment admits new hosts (600 a minute), so it never paces a
/// fleet install; it bounds how many address keys a flood can create.
const PUBLIC_REQUESTS_PER_MINUTE: u32 = 1200;

/// One verified agent build.
#[derive(Clone, Debug)]
pub struct Release {
    pub name: String,
    pub os: String,
    pub arch: String,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    /// `bundled` (built into the server image) or `mirror` (operator supplied).
    pub source: &'static str,
    path: PathBuf,
}
impl Release {
    pub fn summary(&self) -> Value {
        json!({"name":self.name,"os":self.os,"arch":self.arch,"version":self.version,"sha256":self.sha256,"size":self.size,"url":format!("/api/v1/releases/{}",self.name),"signed":false,"source":self.source})
    }
    pub fn platform(&self) -> String {
        format!("{}/{}", self.os, self.arch)
    }
    /// Where the build's file is.
    pub fn path(&self) -> &FsPath {
        &self.path
    }
    fn file_name(&self) -> &'static str {
        if self.os == "windows" {
            "vectory.exe"
        } else {
            "vectory"
        }
    }
}

/// The effective catalog plus any reasons entries were left out.
pub struct Catalog {
    pub releases: Vec<Release>,
    pub problems: Vec<String>,
}
impl Catalog {
    /// The single build for a platform. Several matches are ambiguous, so none is chosen.
    pub fn for_platform(&self, os: &str, arch: &str) -> Option<&Release> {
        let mut matches = self
            .releases
            .iter()
            .filter(|r| r.os == os && r.arch == arch);
        let first = matches.next()?;
        matches.next().is_none().then_some(first)
    }
    /// Platforms with exactly one build, in display order.
    pub fn platforms(&self) -> Vec<&Release> {
        let mut out = Vec::new();
        for os in OPERATING_SYSTEMS {
            for arch in ARCHITECTURES {
                if let Some(release) = self.for_platform(os, arch) {
                    out.push(release);
                }
            }
        }
        out
    }
}

/// Bundled releases, with every platform the operator mirror provides replaced
/// by the mirror's entries. Each file is size- and SHA-256-checked; digests are
/// cached per file identity so listing doesn't reread every binary.
pub async fn catalog(s: &State) -> Catalog {
    let mut problems = Vec::new();
    let mirror = read_catalog(s, &s.settings.releases_dir, MIRROR, &mut problems).await;
    let mut releases = match &s.settings.bundled_releases_dir {
        Some(dir) if *dir != s.settings.releases_dir => {
            read_catalog(s, dir, BUNDLED, &mut problems).await
        }
        _ => Vec::new(),
    };
    releases.retain(|bundled| {
        !mirror
            .iter()
            .any(|m| m.os == bundled.os && m.arch == bundled.arch)
    });
    releases.extend(mirror);
    let order = |r: &Release| {
        (
            OPERATING_SYSTEMS.iter().position(|os| *os == r.os),
            ARCHITECTURES.iter().position(|arch| *arch == r.arch),
        )
    };
    releases.sort_by_key(order);
    Catalog { releases, problems }
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.len() <= 150
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
pub fn safe_version(version: &str) -> bool {
    let (core, suffix) = version.split_once('-').unwrap_or((version, ""));
    let parts: Vec<&str> = core.split('.').collect();
    version.len() <= 64
        && parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
}
fn sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

async fn read_catalog(
    s: &State,
    dir: &FsPath,
    source: &'static str,
    problems: &mut Vec<String>,
) -> Vec<Release> {
    let label = if source == BUNDLED {
        "bundled agent catalog"
    } else {
        "release mirror"
    };
    let bytes = match tokio::fs::read(dir.join("catalog.json")).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(_) => {
            problems.push(format!("The {label} at {} can't be read.", dir.display()));
            return Vec::new();
        }
    };
    let entries: Vec<Value> = match serde_json::from_slice(&bytes) {
        Ok(entries) if bytes.len() <= 1024 * 1024 => entries,
        _ => {
            problems.push(format!(
                "The {label} catalog at {} isn't a valid release list.",
                dir.join("catalog.json").display()
            ));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for entry in entries.into_iter().take(100) {
        let field = |key: &str| entry[key].as_str().unwrap_or("").to_owned();
        let (name, os, arch, version, sha256) = (
            field("name"),
            field("os"),
            field("arch"),
            field("version"),
            field("sha256"),
        );
        if !safe_name(&name)
            || !OPERATING_SYSTEMS.contains(&os.as_str())
            || !ARCHITECTURES.contains(&arch.as_str())
            || !safe_version(&version)
            || !sha256_hex(&sha256)
        {
            problems.push(format!(
                "An entry in the {label} has invalid metadata and isn't offered."
            ));
            continue;
        }
        let path = dir.join(&name);
        let usable = match tokio::fs::symlink_metadata(&path).await {
            Ok(meta)
                if meta.is_file()
                    && meta.len() <= MAX_RELEASE_BYTES
                    && entry["size"].as_u64() == Some(meta.len()) =>
            {
                digest(s, &path, &meta).await.as_deref() == Some(sha256.as_str())
            }
            _ => false,
        };
        if !usable {
            problems.push(format!(
                "{name} in the {label} is missing or doesn't match its size and SHA-256, so it isn't offered."
            ));
            continue;
        }
        out.push(Release {
            size: entry["size"].as_u64().unwrap_or(0),
            name,
            os,
            arch,
            version,
            sha256,
            source,
            path,
        });
    }
    out
}

/// SHA-256 of a release file, recomputed only when its identity (path, inode,
/// length, modification time) changes.
async fn digest(s: &State, path: &FsPath, meta: &std::fs::Metadata) -> Option<String> {
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(meta);
    #[cfg(not(unix))]
    let inode = 0u64;
    let key = format!("{}\0{inode}", path.display());
    let identity = (meta.len(), meta.modified().ok()?);
    if let Some((len, modified, sha)) = s.release_hashes.lock().ok()?.get(&key)
        && (*len, *modified) == identity
    {
        return Some(sha.clone());
    }
    let owned = path.to_owned();
    let sha = tokio::task::spawn_blocking(move || -> std::io::Result<String> {
        use std::io::Read;
        let mut file = std::fs::File::open(&owned)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .ok()?
    .ok()?;
    let mut cache = s.release_hashes.lock().ok()?;
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, (identity.0, identity.1, sha.clone()));
    Some(sha)
}

/// Unauthenticated downloads in progress per client address, so one address
/// can't hold more than a quarter of the download slots.
static ACTIVE_DOWNLOADS: std::sync::Mutex<std::collections::BTreeMap<String, u32>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());
const DOWNLOADS_PER_ADDRESS: u32 = 8;
/// Held for as long as a download streams; releases its address's slot on drop.
struct AddressSlot(String);
impl AddressSlot {
    fn take(address: String) -> Result<Self> {
        let mut active = ACTIVE_DOWNLOADS
            .lock()
            .map_err(|_| ApiError::conflict("Download tracking is unavailable"))?;
        let count = active.entry(address.clone()).or_insert(0);
        if *count >= DOWNLOADS_PER_ADDRESS {
            return Err(ApiError::throttled(
                "RATE_LIMITED",
                "This address already has several agent downloads in progress. Try again in a few seconds.",
                BUSY_RETRY_SECONDS,
            ));
        }
        *count += 1;
        Ok(Self(address))
    }
}
impl Drop for AddressSlot {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_DOWNLOADS.lock()
            && let Some(count) = active.get_mut(&self.0)
        {
            *count -= 1;
            if *count == 0 {
                active.remove(&self.0);
            }
        }
    }
}

/// A file to stream, and what it must be.
pub(crate) struct Transfer<'a> {
    pub path: &'a FsPath,
    pub size: u64,
    pub sha256: &'a str,
    /// Names the file in the log when it changes on disk.
    pub label: &'a str,
}

/// Stream a public agent build from disk, with the headers of a download: its
/// ETag (a conditional request that matches gets `304`) and its file name.
async fn stream(release: &Release, h: &HeaderMap, slot: Option<AddressSlot>) -> Result<Response> {
    let etag = format!("\"{}\"", release.sha256);
    let matches = h
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|tag| tag.trim() == etag));
    if matches {
        let mut response = StatusCode::NOT_MODIFIED.into_response();
        response
            .headers_mut()
            .insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
        return Ok(response);
    }
    let permit = DOWNLOADS.try_acquire().map_err(|_| {
        ApiError::throttled(
            "CAPACITY_BUSY",
            "Too many agent downloads are in progress. Try again in a few seconds.",
            BUSY_RETRY_SECONDS,
        )
    })?;
    let guard: Option<Box<dyn std::any::Any + Send>> = slot.map(|slot| Box::new(slot) as _);
    let mut response = stream_verified(
        Transfer {
            path: &release.path,
            size: release.size,
            sha256: &release.sha256,
            label: &release.name,
        },
        permit,
        guard,
    )
    .await?;
    let headers = response.headers_mut();
    headers.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{}\"", release.file_name()))
            .unwrap(),
    );
    Ok(response)
}

/// Stream a file from disk. The SHA-256 is recomputed while streaming and the
/// final chunk is withheld unless it matches, so a file that changed after it
/// was listed can never be delivered complete. A client that stops reading for
/// 20 seconds, or takes more than five minutes, is cut off. `permit` and
/// `guard` are held for as long as the transfer runs.
pub(crate) async fn stream_verified(
    file: Transfer<'_>,
    permit: tokio::sync::SemaphorePermit<'static>,
    guard: Option<Box<dyn std::any::Any + Send>>,
) -> Result<Response> {
    let mut open = tokio::fs::File::open(file.path)
        .await
        .map_err(|_| ApiError::missing())?;
    let meta = open.metadata().await.map_err(|_| ApiError::missing())?;
    if !meta.is_file() || meta.len() != file.size {
        return Err(ApiError::conflict(
            "This agent build changed while it was being served. Try again.",
        ));
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<std::io::Result<Bytes>>(4);
    let (expected, size, name) = (file.sha256.to_owned(), file.size, file.label.to_owned());
    tokio::spawn(async move {
        let (_permit, _guard) = (permit, guard);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
        // Every send gives up when the client stops reading for 20 seconds or
        // the transfer passes its deadline; dropping the sender then cuts the
        // response short of its Content-Length.
        let send = |item: std::io::Result<Bytes>| {
            let stalled = tokio::time::Instant::now() + Duration::from_secs(20);
            let sent = tokio::time::timeout_at(deadline.min(stalled), tx.send(item));
            async move { matches!(sent.await, Ok(Ok(()))) }
        };
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let (mut total, mut held) = (0u64, None::<Bytes>);
        let failed = || Err(std::io::Error::other("agent download interrupted"));
        loop {
            let read = match tokio::time::timeout_at(deadline, open.read(&mut buffer)).await {
                Ok(Ok(read)) => read,
                _ => {
                    send(failed()).await;
                    return;
                }
            };
            if read == 0 {
                break;
            }
            total += read as u64;
            if total > size {
                break;
            }
            hasher.update(&buffer[..read]);
            if let Some(chunk) = held.replace(Bytes::copy_from_slice(&buffer[..read]))
                && !send(Ok(chunk)).await
            {
                return;
            }
        }
        if total == size && hex::encode(hasher.finalize()) == expected {
            if let Some(chunk) = held {
                send(Ok(chunk)).await;
            }
        } else {
            tracing::error!(release = %name, "agent release changed on disk; download aborted");
            send(failed()).await;
        }
    });
    let mut response = Response::new(Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(rx),
    ));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(file.size));
    Ok(response)
}

/// `GET /api/v1/releases`: every verified build with its source.
pub async fn list_releases(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let catalog = catalog(&s).await;
    for problem in &catalog.problems {
        tracing::warn!("{problem}");
    }
    Ok(Json(json!(
        catalog
            .releases
            .iter()
            .map(Release::summary)
            .collect::<Vec<_>>()
    )))
}

/// `GET /api/v1/releases/{name}`: download a build as a signed-in user.
pub async fn download_release(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(name): Path<String>,
) -> Result<Response> {
    auth::authorize(&s, &h, &[], false).await?;
    let catalog = catalog(&s).await;
    let release = catalog
        .releases
        .iter()
        .find(|r| r.name == name)
        .ok_or_else(ApiError::missing)?;
    stream(release, &h, None).await
}

fn downloads_disabled() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "Agent downloads are turned off on this server. Install the agent from your own package source, then run vectory setup.",
    )
}
/// Download and installer caps count IPv6 clients per /64, like every throttle.
fn peer_key(peer: Option<std::net::IpAddr>) -> String {
    peer.map_or_else(
        || "unknown".into(),
        |ip| crate::throttle_group(&ip.to_string()),
    )
}

/// `GET /agent/v1/downloads/{os}/{arch}` on the agent listener. Anyone who can
/// reach the listener may download the public agent binary; the installer
/// verifies it against the SHA-256 it embeds.
pub async fn download_platform(
    AppState(s): AppState<State>,
    ClientAddress(peer): ClientAddress,
    h: HeaderMap,
    Path((os, arch)): Path<(String, String)>,
) -> Result<Response> {
    if s.settings.disable_public_agent_downloads {
        return Err(downloads_disabled());
    }
    if !OPERATING_SYSTEMS.contains(&os.as_str()) || !ARCHITECTURES.contains(&arch.as_str()) {
        return Err(ApiError::missing());
    }
    // The agent listener has no proxy in front: always the TCP peer. A fleet
    // behind one NAT address shares these caps, so a client turned away while
    // the address is busy retries shortly without spending its rate limit.
    let address = peer_key(peer);
    let slot = AddressSlot::take(address.clone())?;
    // The address's own budget first; the one every address shares only for
    // what that lets through.
    s.limit(
        format!("agent-download:{address}"),
        120,
        Duration::from_secs(600),
    )?;
    s.limit(
        "agent-download".into(),
        PUBLIC_REQUESTS_PER_MINUTE,
        Duration::from_secs(60),
    )?;
    let catalog = catalog(&s).await;
    let release = catalog.for_platform(&os, &arch).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "NOT_FOUND",
            format!("This server has no agent build for {os}/{arch}."),
        )
    })?;
    stream(release, &h, Some(slot)).await
}

/// `GET /agent/v1/identity`: the device a client certificate belongs to, so
/// `vectory doctor` can prove the credential is accepted.
pub async fn identity(
    AppState(s): AppState<State>,
    Extension(peer): Extension<PeerCertificate>,
) -> Result<Json<Value>> {
    let id = crate::device::authenticated(&s, &peer).await?;
    s.limit(format!("identity:{id}"), 30, Duration::from_secs(60))?;
    let name: String = sqlx::query_scalar("SELECT name FROM devices WHERE id=?")
        .bind(&id)
        .fetch_one(&s.pool)
        .await?;
    Ok(Json(json!({"device_id":id,"name":name})))
}

// ---------------------------------------------------------------------------
// Addresses

/// `scheme://host[:port]` with a lowercase host and no default port, or None
/// when `value` isn't a bare origin (no path, query, fragment or user info).
pub fn origin(value: &str, schemes: &[&str]) -> Option<String> {
    let value = value.trim();
    let value = value.strip_suffix('/').unwrap_or(value);
    let (scheme, authority) = value.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !schemes.contains(&scheme.as_str()) {
        return None;
    }
    let (host, port) = authority_parts(authority)?;
    Some(format_origin(&scheme, &host, port))
}
fn authority_parts(authority: &str) -> Option<(String, Option<u16>)> {
    if authority.is_empty()
        || authority.len() > 300
        || authority.contains(['/', '?', '#', '@', ' ', '\\', '%'])
    {
        return None;
    }
    let authority = authority.to_ascii_lowercase();
    let port = |text: &str| text.parse::<u16>().ok().filter(|p| *p > 0);
    if let Some(rest) = authority.strip_prefix('[') {
        let (inside, after) = rest.split_once(']')?;
        inside.parse::<std::net::Ipv6Addr>().ok()?;
        let port = match after {
            "" => None,
            text => Some(port(text.strip_prefix(':')?)?),
        };
        return Some((format!("[{inside}]"), port));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, text)) => (host, Some(port(text)?)),
        None => (authority.as_str(), None),
    };
    let valid = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['.', '-'])
        && !host.ends_with('-')
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
    valid.then(|| (host.to_owned(), port))
}
fn format_origin(scheme: &str, host: &str, port: Option<u16>) -> String {
    match port {
        Some(p) if !(scheme == "https" && p == 443 || scheme == "http" && p == 80) => {
            format!("{scheme}://{host}:{p}")
        }
        _ => format!("{scheme}://{host}"),
    }
}
fn host_of(origin: &str) -> &str {
    let authority = origin.split_once("://").map_or(origin, |(_, a)| a);
    if authority.starts_with('[') {
        return authority
            .split_once(']')
            .map_or(authority, |(h, _)| &h[1..]);
    }
    authority.rsplit_once(':').map_or(authority, |(h, _)| h)
}

/// The host (and port) a client addressed: the Host header for HTTP/1.1, the
/// request URI's authority for HTTP/2.
fn requested_authority(h: &HeaderMap, uri: &Uri) -> Option<(String, Option<u16>)> {
    let authority = match h.get(header::HOST) {
        Some(host) => host.to_str().ok()?,
        None => uri.authority()?.as_str(),
    };
    authority_parts(authority)
}
/// The agent address to show on Add device: the configured public address, or
/// the host the dashboard was opened with and the agent listener's port.
pub fn dashboard_agent_url(settings: &Settings, h: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(url) = &settings.public_agent_url {
        return Some(url.clone());
    }
    let port = settings.agent_port?;
    let (host, _) = requested_authority(h, uri)?;
    Some(format_origin("https", &host, Some(port)))
}
/// The agent address as a device reached it, for the installer it downloads.
fn device_agent_url(settings: &Settings, h: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(url) = &settings.public_agent_url {
        return Some(url.clone());
    }
    let (host, port) = requested_authority(h, uri)?;
    Some(format_origin("https", &host, port))
}

// ---------------------------------------------------------------------------
// Agent listener certificate

/// The certificate devices pin, taken from the chain the agent listener presents.
#[derive(Clone, Debug)]
pub struct PinnedCa {
    pub sha256: String,
    pub pem: String,
    pub name: String,
    pub issuer: String,
    pub not_after: Option<String>,
}
/// What devices need to trust the agent listener.
pub struct AgentTrust {
    chain: Vec<CertificateDer<'static>>,
    pub pinned: Option<PinnedCa>,
    /// Why no certificate can be pinned, when that's the case.
    pub problem: Option<&'static str>,
}
fn certificate_name(name: &x509_parser::x509::X509Name<'_>) -> String {
    name.iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| name.to_string())
        .chars()
        .filter(|c| !c.is_control())
        .take(200)
        .collect()
}
/// Colon-separated uppercase fingerprint, as `vectory` prints it.
pub fn fingerprint(sha256: &str) -> String {
    sha256
        .as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}
/// "1F:3C:...:9A:B0", the first and last two bytes, exactly as the agent
/// prints it. Deliberately too short to paste as a pin.
pub fn short_fingerprint(sha256: &str) -> String {
    let full = fingerprint(sha256);
    if full.len() < 17 {
        return full;
    }
    format!("{}:...:{}", &full[..5], &full[full.len() - 5..])
}
impl AgentTrust {
    pub fn from_settings(settings: &Settings) -> Option<Self> {
        let pem = settings.agent_certificate_pem.as_deref()?;
        let chain = CertificateDer::pem_slice_iter(pem.as_bytes())
            .collect::<std::result::Result<Vec<_>, _>>()
            .ok()
            .filter(|chain| !chain.is_empty())?;
        let top = chain.last()?;
        let (_, parsed) = x509_parser::parse_x509_certificate(top).ok()?;
        let self_signed = parsed.subject().as_raw() == parsed.issuer().as_raw();
        if chain.len() == 1 && !self_signed {
            return Some(Self {
                chain,
                pinned: None,
                problem: Some(
                    "The agent listener presents only its own certificate. Put the issuing CA certificate after it in the certificate file (a full chain) so devices can pin the CA, or use a publicly trusted certificate.",
                ),
            });
        }
        let pinned = PinnedCa {
            sha256: db::hash(top.as_ref()),
            pem: rustls_pem(top),
            name: certificate_name(parsed.subject()),
            issuer: certificate_name(parsed.issuer()),
            not_after: chrono::DateTime::from_timestamp(parsed.validity().not_after.timestamp(), 0)
                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        };
        Some(Self {
            chain,
            pinned: Some(pinned),
            problem: None,
        })
    }
    /// Whether an ordinary client with the public web PKI roots accepts the
    /// presented chain for `host`, so devices need no pin.
    pub fn publicly_trusted(&self, host: &str) -> bool {
        use rustls::client::danger::ServerCertVerifier;
        static ROOTS: std::sync::OnceLock<std::sync::Arc<rustls::RootCertStore>> =
            std::sync::OnceLock::new();
        let roots = ROOTS.get_or_init(|| {
            std::sync::Arc::new(rustls::RootCertStore::from_iter(
                webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
            ))
        });
        let Ok(verifier) = rustls::client::WebPkiServerVerifier::builder_with_provider(
            roots.clone(),
            std::sync::Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build() else {
            return false;
        };
        let Ok(name) = ServerName::try_from(host.to_owned()) else {
            return false;
        };
        let Some((leaf, intermediates)) = self.chain.split_first() else {
            return false;
        };
        verifier
            .verify_server_cert(leaf, intermediates, &name, &[], UnixTime::now())
            .is_ok()
    }
}
fn rustls_pem(der: &CertificateDer<'_>) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let encoded = STANDARD.encode(der.as_ref());
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for line in encoded.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).unwrap_or(""));
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    pem
}

/// How devices will trust the listener at `agent_url`.
pub struct Trust {
    pub publicly_trusted: bool,
    /// The certificate to pin; None when public trust applies or none is usable.
    pub pin: Option<PinnedCa>,
    pub summary: Value,
}
pub fn trust_for(settings: &Settings, agent_url: &str) -> Trust {
    let Some(trust) = AgentTrust::from_settings(settings) else {
        return Trust {
            publicly_trusted: false,
            pin: None,
            summary: json!({"available":false,"publicly_trusted":false,"ca_sha256":null,"problem":"The agent listener's certificate isn't available to this page."}),
        };
    };
    let public = trust.publicly_trusted(host_of(agent_url));
    let ca = trust.pinned.as_ref();
    Trust {
        publicly_trusted: public,
        pin: if public { None } else { ca.cloned() },
        // The CA certificate itself is public, like its fingerprint: Add
        // device writes it on the host so curl verifies the installer
        // download against it, with no certificate check turned off.
        summary: json!({
            "available":true,
            "publicly_trusted":public,
            "ca_sha256":ca.map(|c|&c.sha256),
            "ca_fingerprint":ca.map(|c|fingerprint(&c.sha256)),
            "ca_pem":ca.map(|c|&c.pem),
            "ca_name":ca.map(|c|&c.name),
            "ca_issuer":ca.map(|c|&c.issuer),
            "ca_not_after":ca.and_then(|c|c.not_after.as_ref()),
            "problem":if public { None } else { trust.problem },
        }),
    }
}

// ---------------------------------------------------------------------------
// Installer

/// Single-quote a value for POSIX sh.
fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The POSIX sh installer for `agent_url`. Deterministic for its inputs, so
/// the dashboard can show the SHA-256 a device will verify before running it.
pub fn render_install_sh(
    agent_url: &str,
    pin: Option<&PinnedCa>,
    dashboard_url: Option<&str>,
    catalog: &Catalog,
) -> String {
    let mut platforms = String::new();
    for release in catalog.platforms() {
        if release.os == "windows" {
            continue;
        }
        platforms.push_str(&format!(
            "\t{}) version={} sha256={} ;;\n",
            release.platform(),
            sh_quote(&release.version),
            release.sha256
        ));
    }
    let (pin_sha, pin_pem) = pin.map_or((String::new(), String::new()), |ca| {
        (ca.sha256.clone(), ca.pem.trim_end().to_owned())
    });
    INSTALL_SH
        .replace("@SERVER@", &sh_quote(agent_url))
        .replace("@CA_SHA256@", &sh_quote(&pin_sha))
        .replace("@CA_PEM@", &sh_quote(&pin_pem))
        .replace("@DASHBOARD@", &sh_quote(dashboard_url.unwrap_or("")))
        .replace("@INSTALL_DIR@", INSTALL_DIR)
        .replace("@PLATFORMS@", &platforms)
        .replace("@COMMENT_SERVER@", agent_url)
}

const INSTALL_SH: &str = r#"#!/bin/sh
# Vectory agent installer for @COMMENT_SERVER@
#
# Rendered by your Vectory server. It contains no secrets: `vectory setup`,
# which runs at the end, asks for the enrollment token on this terminal.
#
#   sh vectory-install.sh [--install-dir DIR] [setup options]
#
# It downloads the agent for this host from the server, checks it against the
# SHA-256 below, installs it as DIR/vectory (default @INSTALL_DIR@) and runs
# `vectory setup` with this server's address and CA pin. Setup options such
# as --name, --mode, --service, --create-user and --dry-run pass through; see
# `vectory help setup`. With --ca-file PATH (a CA certificate on this host)
# or --ca-file= (this host's trusted certificates), the download and setup
# trust the server that way instead of the pin. No option turns off
# certificate verification.
#
# Agent updates are the host's own choice, made here and nowhere else. These
# four setup options pass through too. Without --updates, the other three amend
# what a host that already agreed chose and leave the rest as it was:
#
#   --updates auto|ask|off        auto applies an update the server offers, inside
#                                 the window if there is one; ask waits for
#                                 `sudo vectory update apply`; off takes nothing
#   --update-key-sha256 HEX       the SHA-256 fingerprint of a release key to
#                                 trust (64 hex digits, up to 4); required with
#                                 auto or ask. Setup checks it against the keys
#                                 this server offers and pins only that key
#   --update-track patch|minor    patch (the default) stays on the running
#                                 major.minor; minor stays on the running major
#   --update-window 'DAYS HH:MM-HH:MM [UTC]'
#                                 when an update may start, in this host's time
#                                 unless UTC follows (repeatable, such as
#                                 'Mon-Fri 02:00-04:00'; none means any time)
set -eu

vectory_install() {
	server=@SERVER@
	ca_sha256=@CA_SHA256@
	ca_pem=@CA_PEM@
	dashboard=@DASHBOARD@
	install_dir=@INSTALL_DIR@
	dry_run=
	# The operator's own trust choice (--ca-file or --ca-sha256) replaces the pin.
	own_trust=
	ca_file_set=
	ca_file=

	step() { printf '%-4s %-12s %s\n' "$1" "$2" "$3"; }
	fail() {
		printf '%-4s %-12s %s\n' '[!!]' "$1" "$2" >&2
		if [ -n "${3:-}" ]; then printf '%17s %s\n' '' "$3" >&2; fi
		exit 1
	}
	# can_install DIR: a real run creates DIR (mkdir -p) and writes the agent
	# there. A dry run changes nothing, so it tries that with an empty probe
	# directory, removed at once, in DIR's nearest existing ancestor: root
	# passes `-w` even where nothing can be created (/proc), so only trying
	# tells.
	can_install() {
		probe_dir=$1
		while [ ! -e "$probe_dir" ] && [ ! -L "$probe_dir" ]; do
			probe_dir=$(dirname "$probe_dir")
		done
		[ -d "$probe_dir" ] || return 1
		probe=$(mktemp -d "$probe_dir/.vectory-dry-run.XXXXXX" 2>/dev/null) || return 1
		rmdir "$probe"
	}

	count=$#
	while [ "$count" -gt 0 ]; do
		arg=$1
		shift
		count=$((count - 1))
		case $arg in
		--install-dir)
			[ "$count" -gt 0 ] || fail Installer "--install-dir needs a directory."
			install_dir=$1
			shift
			count=$((count - 1))
			;;
		--install-dir=*) install_dir=${arg#--install-dir=} ;;
		--ca-file)
			[ "$count" -gt 0 ] || fail Installer "--ca-file needs the path of a CA certificate on this host (or --ca-file= for this host's trusted certificates)."
			ca_file=$1
			shift
			count=$((count - 1))
			own_trust=1 ca_file_set=1
			set -- ${1+"$@"} "$arg" "$ca_file"
			;;
		--ca-file=*)
			ca_file=${arg#--ca-file=}
			own_trust=1 ca_file_set=1
			set -- ${1+"$@"} "$arg"
			;;
		--ca-sha256 | --ca-sha256=*)
			own_trust=1
			set -- ${1+"$@"} "$arg"
			;;
		-h | --help)
			printf '%s\n' "Usage: sh vectory-install.sh [--install-dir DIR] [setup options]" \
				"Downloads the Vectory agent from $server, checks its SHA-256, installs it" \
				"as DIR/vectory (default @INSTALL_DIR@) and runs vectory setup. Setup options" \
				"such as --name, --mode, --service, --create-user and --dry-run pass through." \
				"--ca-file PATH (a CA certificate on this host) or --ca-file= (this host's" \
				"trusted certificates) replaces the CA pin for the download and for setup."
			exit 0
			;;
		*)
			case $arg in --dry-run | --dry-run=true) dry_run=1 ;; esac
			set -- ${1+"$@"} "$arg"
			;;
		esac
	done
	case $install_dir in
	/*) ;;
	*) install_dir=$(pwd)/$install_dir ;;
	esac

	printf 'Vectory agent installer for %s\n' "$server"
	case $(uname -s) in
	Linux) os=linux ;;
	Darwin) os=darwin ;;
	*) fail Platform "This installer is for Linux and macOS; this host runs $(uname -s)." "On Windows, use the PowerShell steps on the Add device page." ;;
	esac
	case $(uname -m) in
	x86_64 | amd64) arch=amd64 ;;
	aarch64 | arm64 | armv8*) arch=arm64 ;;
	*) fail Platform "No Vectory agent is built for the $(uname -m) architecture." ;;
	esac
	if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
		arch=arm64 # a Rosetta shell on Apple silicon
	fi
	case $os/$arch in
@PLATFORMS@	*) fail Platform "This server has no agent build for $os/$arch." "Ask your administrator to add one to the server's release mirror." ;;
	esac

	if command -v sha256sum >/dev/null 2>&1; then
		sha_tool='sha256sum'
	elif command -v shasum >/dev/null 2>&1; then
		sha_tool='shasum -a 256'
	elif command -v openssl >/dev/null 2>&1; then
		sha_tool='openssl dgst -sha256 -r'
	else
		fail Agent "No SHA-256 tool is installed (sha256sum, shasum or openssl)." "Install one of them, then run the installer again."
	fi
	digest() { $sha_tool "$1" | { read -r sum _ && printf '%s' "$sum"; }; }
	short=$(printf '%s' "$sha256" | cut -c1-12)

	target=$install_dir/vectory
	if [ -z "$dry_run" ] && [ -f "$target" ] && [ "$(digest "$target")" = "$sha256" ]; then
		# The service account runs this file: keep it executable for everyone.
		chmod 0755 "$target" 2>/dev/null || true
		step '[ok]' Agent "$target is already $version for $os/$arch (SHA-256 $short... verified)"
	else
		tmp=$(mktemp -d 2>/dev/null || mktemp -d -t vectory) || fail Agent "Can't create a temporary directory."
		trap 'rm -rf "$tmp"' EXIT
		trap 'exit 130' INT TERM
		# The download trusts the server the way setup will: the CA file the
		# operator named, this host's trusted certificates (--ca-file=), or
		# the CA embedded above (the pin's certificate).
		tls_ca=
		if [ -n "$ca_file_set" ]; then
			if [ -n "$ca_file" ]; then
				[ -f "$ca_file" ] && [ -r "$ca_file" ] || fail Server "Can't read the CA certificate $ca_file." "Put the server's CA certificate (PEM) there first, or copy the command again from Add device."
				tls_ca=$ca_file
			fi
		elif [ -n "$ca_pem" ]; then
			printf '%s\n' "$ca_pem" >"$tmp/server-ca.pem"
			tls_ca=$tmp/server-ca.pem
		fi
		url=$server/agent/v1/downloads/$os/$arch
		unreachable="Check that this host can reach the server's agent address."
		if command -v curl >/dev/null 2>&1; then
			# A busy server answers 429 with Retry-After; --retry waits it out.
			curl_options='-fsSg --proto =https --connect-timeout 20 --retry 6 --retry-max-time 120'
			if [ -n "$tls_ca" ]; then
				curl $curl_options --cacert "$tls_ca" -o "$tmp/vectory" "$url" || fail Agent "Couldn't download the agent from $server." "$unreachable"
			else
				curl $curl_options -o "$tmp/vectory" "$url" || fail Agent "Couldn't download the agent from $server." "$unreachable"
			fi
		elif command -v wget >/dev/null 2>&1; then
			unreachable="$unreachable On BusyBox systems, install curl: BusyBox wget can't make this connection."
			if [ -n "$tls_ca" ]; then
				wget -q --ca-certificate="$tls_ca" -O "$tmp/vectory" "$url" || fail Agent "Couldn't download the agent from $server." "$unreachable"
			else
				wget -q -O "$tmp/vectory" "$url" || fail Agent "Couldn't download the agent from $server." "$unreachable"
			fi
		else
			fail Agent "Neither curl nor wget is installed." "Install curl, then run the installer again."
		fi
		actual=$(digest "$tmp/vectory")
		[ "$actual" = "$sha256" ] || fail Agent "The downloaded agent doesn't match its SHA-256 (expected $sha256, got $actual)." "Nothing was installed. Copy the command again from Add device; if this repeats, something is altering the download."
		chmod 0755 "$tmp/vectory"
		if [ -n "$dry_run" ]; then
			can_install "$install_dir" || fail Agent "Can't write to $install_dir." "Run the installer with sudo, or choose a directory with --install-dir."
			step '[..]' Agent "$version for $os/$arch would be installed at $target (SHA-256 $short... verified)"
			if [ -n "$dashboard" ]; then set -- --dashboard-url "$dashboard" ${1+"$@"}; fi
			if [ -n "$ca_sha256" ] && [ -z "$own_trust" ]; then set -- --ca-sha256 "$ca_sha256" ${1+"$@"}; fi
			status=0
			# --agent-path names where the real run would put the agent, so the
			# plan shows the --install-dir the person chose.
			"$tmp/vectory" setup --server "$server" --agent-path "$target" ${1+"$@"} || status=$?
			if [ "$status" = 126 ]; then
				fail Agent "This host doesn't allow running programs from $tmp." "Run the dry run again with TMPDIR set to a directory that does, for example TMPDIR=/var/tmp. A real install doesn't need it."
			fi
			exit "$status"
		fi
		if ! mkdir -p "$install_dir" 2>/dev/null || [ ! -w "$install_dir" ]; then
			fail Agent "Can't write to $install_dir." "Run the installer with sudo, or choose a directory with --install-dir."
		fi
		# cp creates the file under the caller's umask (027 or 077 on hardened
		# hosts), which would hide it from the service account: set 0755.
		cp "$tmp/vectory" "$install_dir/.vectory.new.$$" && chmod 0755 "$install_dir/.vectory.new.$$" && mv -f "$install_dir/.vectory.new.$$" "$target" || fail Agent "Couldn't install $target."
		rm -rf "$tmp"
		trap - EXIT INT TERM
		step '[ok]' Agent "$version for $os/$arch installed at $target (SHA-256 $short... verified)"
	fi

	if [ -n "$dashboard" ]; then set -- --dashboard-url "$dashboard" ${1+"$@"}; fi
	if [ -n "$ca_sha256" ] && [ -z "$own_trust" ]; then set -- --ca-sha256 "$ca_sha256" ${1+"$@"}; fi
	# --agent-path: the service runs the agent from where it was installed.
	exec "$target" setup --server "$server" --agent-path "$target" ${1+"$@"}
}

vectory_install ${1+"$@"}
"#;

/// The installer for `agent_url` and its SHA-256.
pub async fn installer(s: &State, agent_url: &str) -> (String, String) {
    let catalog = catalog(s).await;
    let trust = trust_for(&s.settings, agent_url);
    let script = render_install_sh(
        agent_url,
        trust.pin.as_ref(),
        s.settings.public_url.as_deref(),
        &catalog,
    );
    let sha = db::hash(&script);
    (script, sha)
}

/// The limits of a public route of the agent listener (the installer, the key
/// bundle): the address's own budget first; the one every address shares only
/// for what that lets through.
pub(crate) fn public_limits(s: &State, route: &str, peer: Option<std::net::IpAddr>) -> Result<()> {
    s.limit(
        format!("{route}:{}", peer_key(peer)),
        300,
        Duration::from_secs(600),
    )?;
    s.limit(
        route.to_owned(),
        PUBLIC_REQUESTS_PER_MINUTE,
        Duration::from_secs(60),
    )
}

/// `GET /agent/v1/install.sh` on the agent listener.
pub async fn install_sh(
    AppState(s): AppState<State>,
    ClientAddress(peer): ClientAddress,
    h: HeaderMap,
    uri: Uri,
) -> Result<Response> {
    if s.settings.disable_public_agent_downloads {
        return Err(downloads_disabled());
    }
    // The address's own budget first; the one every address shares only for
    // what that lets through.
    s.limit(
        format!("agent-installer:{}", peer_key(peer)),
        300,
        Duration::from_secs(600),
    )?;
    s.limit(
        "agent-installer".into(),
        PUBLIC_REQUESTS_PER_MINUTE,
        Duration::from_secs(60),
    )?;
    let agent_url = device_agent_url(&s.settings, &h, &uri)
        .ok_or_else(|| ApiError::invalid("Request the installer with the server's host name"))?;
    let (script, sha) = installer(&s, &agent_url).await;
    let mut response = script.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&format!("\"{sha}\"")).unwrap(),
    );
    Ok(response)
}

// ---------------------------------------------------------------------------
// Add device

/// `GET /api/v1/agent-install`: what the Add device page needs to build a
/// verified one-command install for this server.
pub async fn details(AppState(s): AppState<State>, h: HeaderMap, uri: Uri) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], false).await?;
    let catalog = catalog(&s).await;
    let agent_url = dashboard_agent_url(&s.settings, &h, &uri);
    let enabled = !s.settings.disable_public_agent_downloads;
    let (trust, installer) = match &agent_url {
        Some(url) => {
            let trust = trust_for(&s.settings, url);
            let script = render_install_sh(
                url,
                trust.pin.as_ref(),
                s.settings.public_url.as_deref(),
                &catalog,
            );
            let installer = enabled.then(|| {
                json!({"url":format!("{url}/agent/v1/install.sh"),"sha256":db::hash(&script),"platforms":catalog.platforms().iter().filter(|r|r.os!="windows").map(|r|r.platform()).collect::<Vec<_>>()})
            });
            (trust.summary, installer)
        }
        None => (Value::Null, None),
    };
    let admin = user["role"] == "admin";
    Ok(Json(json!({
        "agent_url":agent_url,
        "agent_url_configured":s.settings.public_agent_url.is_some(),
        "listener_enabled":s.settings.agent_port.is_some() || s.settings.public_agent_url.is_some(),
        "dashboard_url":s.settings.public_url,
        "certificate":trust,
        "downloads_enabled":enabled,
        "installer":installer,
        "default_install_dir":INSTALL_DIR,
        "releases":catalog.releases.iter().map(Release::summary).collect::<Vec<_>>(),
        "catalog_problems":if admin { json!(catalog.problems) } else { json!([]) },
    })))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityQuery {
    since: Option<String>,
}
/// `GET /api/v1/agent-install/activity?since=RFC3339`: recent enrollment
/// attempts, successful or refused, with their recorded reasons. Devices are
/// only ever told "refused"; this is where an administrator sees why.
pub async fn activity(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<ActivityQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    // Enrollment attempts carry client addresses: for the people who add devices.
    auth::authorize(&s, &h, &["operator"], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let now = chrono::Utc::now();
    let floor = now - chrono::Duration::hours(24);
    let since = match input.since.as_deref() {
        Some(value) => chrono::DateTime::parse_from_rfc3339(value)
            .map_err(|_| ApiError::invalid("since must be an RFC3339 timestamp"))?
            .with_timezone(&chrono::Utc)
            .max(floor),
        None => floor,
    };
    // Newest first, in recorded order within the same second.
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT r.data FROM audit_sequence s JOIN records r ON r.kind='audit' AND r.id=s.audit_id WHERE s.created_at>=? AND json_extract(r.data,'$.action')='device.enroll' ORDER BY s.created_at DESC,s.sequence DESC LIMIT 50",
    )
    .bind(since.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    .fetch_all(&s.pool)
    .await?;
    let mut events = Vec::new();
    for raw in rows {
        let event = db::parse(&raw)?;
        let details = &event["details"];
        let text = |v: &Value, max: usize| {
            v.as_str()
                .filter(|t| t.len() <= max && !t.chars().any(char::is_control))
                .map(str::to_owned)
        };
        let success = event["outcome"] == "success";
        events.push(json!({
            "id":text(&event["id"],128),
            "created_at":text(&event["created_at"],64),
            "outcome":if success {"success"} else {"failure"},
            "reason_code":text(&details["reason_code"],64),
            "device_id":if success { text(&event["target"],128) } else { None },
            "device_name":text(&details["name"],100),
            "token_id":text(&details["token_id"],128),
            "agent_os":text(&details["agent_os"],64),
            "agent_arch":text(&details["agent_arch"],64),
            "agent_version":text(&details["agent_version"],64),
            "configuration_mode":text(&details["configuration_mode"],16),
            "client_address":text(&details["client_address"],64),
        }));
    }
    Ok(Json(
        json!({"events":events,"now":now.to_rfc3339_opts(chrono::SecondsFormat::Secs,true)}),
    ))
}

/// The first lines an operator reads in the server log: where to finish setup
/// (and where the setup secret comes from, never its value), the agent
/// endpoint, the CA devices pin and the agent builds this server offers.
pub async fn startup_banner(s: &State, web_addr: &str, secret_source: &str) -> String {
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&s.pool)
        .await
        .unwrap_or(1);
    let dashboard = s.settings.public_url.clone().unwrap_or_else(|| {
        match web_addr.parse::<std::net::SocketAddr>() {
            Ok(a) if a.ip().is_unspecified() => format!(
                "http://<this host>:{}  (set VECTORY_PUBLIC_URL to the address people use)",
                a.port()
            ),
            _ => format!("http://{web_addr}"),
        }
    });
    let mut lines = vec![format!("Vectory {} is ready", env!("CARGO_PKG_VERSION"))];
    if users == 0 {
        lines.push(format!(
            "  Finish setup:    {dashboard}  (setup secret: {secret_source})"
        ));
    } else {
        lines.push(format!("  Dashboard:       {dashboard}"));
    }
    let agent = s.settings.public_agent_url.clone();
    match (&agent, s.settings.agent_port) {
        (Some(url), _) => lines.push(format!("  Agent endpoint:  {url}")),
        (None, Some(port)) => lines.push(format!(
            "  Agent endpoint:  port {port} on this host  (set VECTORY_PUBLIC_AGENT_URL to the address devices use)"
        )),
        (None, None) => {
            lines.push("  Agent endpoint:  off (no agent TLS certificate is configured)".into())
        }
    }
    if let Some(trust) = AgentTrust::from_settings(&s.settings) {
        match &trust.pinned {
            Some(ca) => {
                let public = agent
                    .as_deref()
                    .is_some_and(|url| trust.publicly_trusted(host_of(url)));
                lines.push(format!(
                    "  Agent CA:        SHA-256 {}  ({})",
                    short_fingerprint(&ca.sha256),
                    if public {
                        "publicly trusted"
                    } else {
                        "private CA; devices pin this"
                    }
                ));
            }
            None => lines.push(format!(
                "  Agent CA:        {}",
                trust.problem.unwrap_or("unavailable")
            )),
        }
    }
    let catalog = catalog(s).await;
    let platforms = |source: &str| {
        catalog
            .releases
            .iter()
            .filter(|r| r.source == source)
            .map(Release::platform)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let bundled = platforms(BUNDLED);
    lines.push(format!(
        "  Bundled agents:  {}",
        if bundled.is_empty() {
            "none (build them with packaging/build-release.py)"
        } else {
            &bundled
        }
    ));
    let mirror = platforms(MIRROR);
    if !mirror.is_empty() {
        lines.push(format!("  Mirror agents:   {mirror}"));
    }
    if s.settings.disable_public_agent_downloads {
        lines.push(
            "  Agent downloads: off for devices (VECTORY_PUBLIC_AGENT_DOWNLOADS=false)".into(),
        );
    }
    for problem in &catalog.problems {
        lines.push(format!("  Note:            {problem}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_are_normalized_and_strict() {
        let https = &["https"];
        assert_eq!(
            origin("HTTPS://Vectory.Example.com:8443/", https).as_deref(),
            Some("https://vectory.example.com:8443")
        );
        assert_eq!(
            origin("https://vectory.example.com:443", https).as_deref(),
            Some("https://vectory.example.com")
        );
        assert_eq!(
            origin("https://[::1]:8113", https).as_deref(),
            Some("https://[::1]:8113")
        );
        for bad in [
            "http://vectory.example.com",
            "https://vectory.example.com/path",
            "https://user@vectory.example.com",
            "https://vectory.example.com:0",
            "https://vectory.example.com:99999",
            "https://-bad.example.com",
            "https://exa mple.com",
            "https://[not-ipv6]:1",
            "https://host?x=1",
            "vectory.example.com:8443",
        ] {
            assert_eq!(origin(bad, https), None, "{bad}");
        }
        assert_eq!(host_of("https://[::1]:8113"), "::1");
        assert_eq!(
            host_of("https://vectory.example.com"),
            "vectory.example.com"
        );
    }

    #[test]
    fn download_caps_count_ipv6_clients_per_64() {
        let ip = |text: &str| Some(text.parse().unwrap());
        let group = peer_key(ip("2001:db8:1:2::1"));
        assert_eq!(group, "2001:db8:1:2::/64");
        assert_eq!(peer_key(ip("2001:db8:1:2:ffff:ffff:ffff:9")), group);
        assert_ne!(peer_key(ip("2001:db8:1:3::1")), group);
        assert_eq!(peer_key(ip("192.0.2.9")), "192.0.2.9");
        assert_eq!(peer_key(ip("::ffff:192.0.2.9")), "192.0.2.9");
        assert_eq!(peer_key(None), "unknown");
    }

    #[test]
    fn one_address_cannot_hold_every_download_slot() {
        let address = "192.0.2.9".to_owned();
        let held: Vec<_> = (0..DOWNLOADS_PER_ADDRESS)
            .map(|_| AddressSlot::take(address.clone()).unwrap())
            .collect();
        assert!(AddressSlot::take(address.clone()).is_err());
        assert!(AddressSlot::take("192.0.2.10".into()).is_ok());
        drop(held);
        assert!(AddressSlot::take(address.clone()).is_ok());
        assert!(!ACTIVE_DOWNLOADS.lock().unwrap().contains_key(&address));
    }

    #[test]
    fn versions_and_fingerprints() {
        assert!(safe_version("0.1.0") && safe_version("1.20.3-dev.4"));
        assert!(!safe_version("1.2") && !safe_version("1.2.3;rm") && !safe_version("v1.2.3"));
        let sha = format!("1f3c{}9ab0", "00".repeat(28));
        assert!(fingerprint(&sha).starts_with("1F:3C:00:00"));
        assert_eq!(fingerprint(&sha).len(), 95);
        assert_eq!(short_fingerprint(&sha), "1F:3C:...:9A:B0");
    }
}
