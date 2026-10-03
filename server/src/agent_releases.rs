//! Agent releases: a build this server ships, prepared as one manifest that a
//! key signs, and the store that serves its files to the devices an update
//! rollout releases it to.
//!
//! The unit of release is a build in this server's own catalog
//! (`install::catalog`). Preparing a release copies each platform's file,
//! re-hashed, into `artifacts/agent-releases/<sha256>`, so a later server
//! upgrade, which replaces the catalog, never changes what a running rollout
//! serves. The manifest bytes are built once and stored exactly; the signature
//! file is stored exactly as it was made or uploaded.
use crate::{
    State,
    agent_release::{self, ArtifactInput, SignatureEntry},
    agent_release_keys, agent_update_rollouts,
    agent_updates::{self, instant},
    auth, db,
    error::{ApiError, Result},
    install,
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Extension, Path, State as AppState},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Read, Write},
    path::PathBuf,
};

/// Releases one listing carries.
pub const MAX_LISTED: i64 = 100;
/// Update rollouts one release lists.
const ROLLOUTS_LISTED: usize = 50;

/// One platform's file of a release.
#[derive(Clone, Debug)]
pub struct Artifact {
    pub os: String,
    pub arch: String,
    pub file: String,
    pub size: i64,
    pub sha256: String,
}
impl Artifact {
    pub fn view(&self) -> Value {
        json!({"os":self.os,"arch":self.arch,"file":self.file,"size":self.size,"sha256":self.sha256})
    }
}

/// A prepared release, without the bytes.
#[derive(Clone, Debug)]
pub struct Release {
    pub id: String,
    pub version: String,
    pub counter: i64,
    pub manifest_sha256: String,
    pub state: String,
    pub issued_at: String,
    pub expires_at: String,
    pub min_from: Option<String>,
    pub service_definition: i64,
    pub signer: Option<String>,
    pub prepared_by_name: Option<String>,
    pub prepared_at: String,
    pub withdrawn_at: Option<String>,
    pub withdrawn_reason: Option<String>,
    pub artifacts: Vec<Artifact>,
}
impl Release {
    /// `expires_at` is not in the future.
    pub fn expired(&self, now: &str) -> bool {
        self.expires_at.as_str() <= now
    }
    /// The file for a platform.
    pub fn artifact_for(&self, os: &str, arch: &str) -> Option<&Artifact> {
        self.artifacts.iter().find(|a| a.os == os && a.arch == arch)
    }
    /// Ready, and not expired: what a rollout may offer.
    pub fn offerable(&self, now: &str) -> bool {
        self.state == "ready" && !self.expired(now)
    }
    /// `{id,version,counter,manifest_sha256}`, as a rollout and a review name it.
    pub fn brief(&self) -> Value {
        json!({"id":self.id,"version":self.version,"counter":self.counter,"manifest_sha256":self.manifest_sha256})
    }
}

const COLUMNS: &str = "id,version,counter,manifest_sha256,state,issued_at,expires_at,min_from,service_definition,signer,prepared_by_name,prepared_at,withdrawn_at,withdrawn_reason";

fn release_of(row: &sqlx::sqlite::SqliteRow, artifacts: Vec<Artifact>) -> Release {
    Release {
        id: row.get("id"),
        version: row.get("version"),
        counter: row.get("counter"),
        manifest_sha256: row.get("manifest_sha256"),
        state: row.get("state"),
        issued_at: row.get("issued_at"),
        expires_at: row.get("expires_at"),
        min_from: row.get("min_from"),
        service_definition: row.get("service_definition"),
        signer: row.get("signer"),
        prepared_by_name: row.get("prepared_by_name"),
        prepared_at: row.get("prepared_at"),
        withdrawn_at: row.get("withdrawn_at"),
        withdrawn_reason: row.get("withdrawn_reason"),
        artifacts,
    }
}
async fn artifacts_of(conn: &mut SqliteConnection, release: &str) -> Result<Vec<Artifact>> {
    let rows = sqlx::query(
        "SELECT os,arch,file,size,sha256 FROM agent_release_artifacts WHERE release_id=? ORDER BY CASE os WHEN 'linux' THEN 0 WHEN 'darwin' THEN 1 ELSE 2 END,CASE arch WHEN 'amd64' THEN 0 ELSE 1 END",
    )
    .bind(release)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .map(|row| Artifact {
            os: row.get("os"),
            arch: row.get("arch"),
            file: row.get("file"),
            size: row.get("size"),
            sha256: row.get("sha256"),
        })
        .collect())
}

/// One release by ID; `404 NOT_FOUND` when there is none.
pub async fn load(conn: &mut SqliteConnection, id: &str) -> Result<Release> {
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM agent_releases WHERE id=?"))
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(ApiError::missing)?;
    let artifacts = artifacts_of(conn, id).await?;
    Ok(release_of(&row, artifacts))
}
/// The release whose manifest has this SHA-256, if this server prepared one.
pub async fn load_by_digest(conn: &mut SqliteConnection, digest: &str) -> Result<Option<Release>> {
    let id: Option<String> =
        sqlx::query_scalar("SELECT id FROM agent_releases WHERE manifest_sha256=?")
            .bind(digest)
            .fetch_optional(&mut *conn)
            .await?;
    match id {
        Some(id) => Ok(Some(load(conn, &id).await?)),
        None => Ok(None),
    }
}

/// `AgentRelease` of releases, newest first as given: the signer with its
/// custody, and the update rollouts of each.
pub async fn views(conn: &mut SqliteConnection, releases: &[Release]) -> Result<Vec<Value>> {
    if releases.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<&str> = releases.iter().map(|r| r.id.as_str()).collect();
    let signers: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT fingerprint,custody FROM agent_release_keys")
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let mut rollouts: HashMap<String, Vec<Value>> = HashMap::new();
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT release_id,id,status FROM agent_update_rollouts WHERE release_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id",
    )
    .bind(json!(ids).to_string())
    .fetch_all(&mut *conn)
    .await?;
    for (release, id, status) in rows {
        let list = rollouts.entry(release).or_default();
        if list.len() < ROLLOUTS_LISTED {
            list.push(json!({"id":id,"status":status}));
        }
    }
    let now = db::now();
    Ok(releases
        .iter()
        .map(|release| {
            json!({
                "id": release.id,
                "version": release.version,
                "counter": release.counter,
                "state": release.state,
                "expired": release.expired(&now),
                "manifest_sha256": release.manifest_sha256,
                "issued_at": release.issued_at,
                "expires_at": release.expires_at,
                "signer": release.signer.as_ref().map(|fingerprint| json!({
                    "fingerprint": fingerprint,
                    "custody": signers.get(fingerprint),
                })),
                "artifacts": release.artifacts.iter().map(Artifact::view).collect::<Vec<_>>(),
                "prepared_by_name": release.prepared_by_name,
                "prepared_at": release.prepared_at,
                "withdrawn_at": release.withdrawn_at,
                "withdrawn_reason": release.withdrawn_reason,
                "rollouts": rollouts.remove(&release.id).unwrap_or_default(),
            })
        })
        .collect())
}
pub async fn view(conn: &mut SqliteConnection, release: &Release) -> Result<Value> {
    Ok(views(conn, std::slice::from_ref(release))
        .await?
        .pop()
        .unwrap_or(Value::Null))
}

/// `GET /api/v1/agent-releases`: newest first, at most 100. Any signed-in role.
pub async fn list(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    crate::agent_updates::require_on(&mut tx).await?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM agent_releases ORDER BY prepared_at DESC,rowid DESC LIMIT ?",
    )
    .bind(MAX_LISTED)
    .fetch_all(&mut *tx)
    .await?;
    let mut releases = Vec::with_capacity(ids.len());
    for id in &ids {
        releases.push(load(&mut tx, id).await?);
    }
    Ok(Json(json!(views(&mut tx, &releases).await?)))
}

/// `GET /api/v1/agent-releases/{id}`.
pub async fn get(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    crate::agent_updates::require_on(&mut tx).await?;
    let release = load(&mut tx, &id).await?;
    Ok(Json(view(&mut tx, &release).await?))
}

/// `GET /api/v1/agent-releases/{id}/manifest`: the stored bytes exactly, in any
/// state, for an offline signer to sign.
pub async fn manifest(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    crate::agent_updates::require_on(&mut tx).await?;
    let row = sqlx::query("SELECT manifest,manifest_sha256 FROM agent_releases WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::missing)?;
    let bytes: Vec<u8> = row.get("manifest");
    let digest: String = row.get("manifest_sha256");
    let mut response = Response::new(Body::from(bytes.clone()));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"release.json\""),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
    if let Ok(etag) = HeaderValue::from_str(&format!("\"{digest}\"")) {
        headers.insert(header::ETAG, etag);
    }
    Ok(response.into_response())
}

// ---------------------------------------------------------------------------
// The release store

/// How long a release is valid: the contract writes 180 days.
const VALIDITY_DAYS: i64 = 180;
/// Releases that are not withdrawn at once.
const MAX_LIVE: i64 = 20;
/// The generation of the service definition the builds of this server need.
/// 0.1 builds say 1.
pub const SERVICE_DEFINITION: u64 = 1;
/// A file of the store nobody references is removed after this long: long
/// enough for the request that wrote it to commit.
const ORPHAN_SECONDS: u64 = 3600;

pub const STORAGE_VARIABLE: &str = "VECTORY_AGENT_RELEASE_STORAGE_BYTES";
pub const DEFAULT_STORAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const STORAGE_RANGE: std::ops::RangeInclusive<u64> = (128 * 1024 * 1024)..=(1 << 40);
/// The most the release store may hold, for the value the variable holds (`None`
/// when it is unset). Unset or empty is the default; anything that is not a
/// whole number in the range is an error that names the variable, the value and
/// the range, never a different limit.
pub fn storage_limit(value: Option<&str>) -> anyhow::Result<u64> {
    let Some(given) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(DEFAULT_STORAGE_BYTES);
    };
    given
        .parse::<u64>()
        .ok()
        .filter(|bytes| STORAGE_RANGE.contains(bytes))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "{STORAGE_VARIABLE} must be a whole number of bytes from {} to {}, not {:?}",
                STORAGE_RANGE.start(),
                STORAGE_RANGE.end(),
                given.chars().take(40).collect::<String>()
            )
        })
}

/// Where the files of releases live: `artifacts/agent-releases`.
pub fn store_dir(s: &State) -> PathBuf {
    s.settings.data_dir.join("artifacts").join("agent-releases")
}
/// A file of the store, by its SHA-256.
pub fn store_path(s: &State, sha256: &str) -> PathBuf {
    store_dir(s).join(sha256)
}

fn storage_full(message: &str) -> ApiError {
    ApiError::new(
        StatusCode::INSUFFICIENT_STORAGE,
        "RELEASE_STORAGE_FULL",
        message,
    )
}
fn not_in_catalog(version: &str) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "RELEASE_NOT_IN_CATALOG",
        format!(
            "This server's catalog holds no build of {version}. Add the build to the catalog first."
        ),
    )
}
fn exists(version: &str) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "RELEASE_EXISTS",
        format!("A release of {version} already exists. Withdraw it to prepare another."),
    )
}
fn invalid_signature(reason: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "RELEASE_SIGNATURE_INVALID",
        format!("The signature file isn't accepted: {reason}."),
    )
}
fn internal(message: &str) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", message)
}

/// What the catalog holds of a version: one build per platform. A platform with
/// several builds of the version that differ is ambiguous and left out, as the
/// catalog itself leaves out a platform with several builds.
fn builds_of<'a>(catalog: &'a install::Catalog, version: &str) -> Vec<&'a install::Release> {
    let mut by_platform: BTreeMap<(usize, usize), Vec<&install::Release>> = BTreeMap::new();
    for build in catalog
        .releases
        .iter()
        .filter(|build| build.version == version)
    {
        let rank = |names: &[&str], name: &str| {
            names.iter().position(|n| *n == name).unwrap_or(names.len())
        };
        let key = (
            rank(&["linux", "darwin", "windows"], &build.os),
            rank(&["amd64", "arm64"], &build.arch),
        );
        by_platform.entry(key).or_default().push(build);
    }
    by_platform
        .into_values()
        .filter(|builds| builds.iter().all(|build| build.sha256 == builds[0].sha256))
        .map(|builds| builds[0])
        .collect()
}

/// Why a build could not be copied into the store.
enum CopyError {
    /// The file in the catalog is not the one the catalog described.
    Changed,
    Io(std::io::Error),
}
impl From<std::io::Error> for CopyError {
    fn from(error: std::io::Error) -> Self {
        CopyError::Io(error)
    }
}

/// A build as the release will list it.
struct Stored {
    os: String,
    arch: String,
    size: u64,
    sha256: String,
}

/// Copies a catalog file into the store, hashing it as it goes. The copy is
/// written under a temporary name and renamed to its digest only when the bytes
/// are the size and digest the catalog gave, so the store never holds a file
/// under a name it does not match.
fn copy_verified(
    store: &std::path::Path,
    source: &std::path::Path,
    sha256: &str,
    size: u64,
) -> std::result::Result<(), CopyError> {
    let mut input = std::fs::File::open(source)?;
    let meta = input.metadata()?;
    if !meta.is_file() || meta.len() != size {
        return Err(CopyError::Changed);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(store)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > size {
            break;
        }
        hasher.update(&buffer[..read]);
        temporary.write_all(&buffer[..read])?;
    }
    if total != size || hex::encode(hasher.finalize()) != sha256 {
        return Err(CopyError::Changed);
    }
    temporary.as_file().sync_all()?;
    temporary
        .persist(store.join(sha256))
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    std::fs::File::open(store)?.sync_all()?;
    Ok(())
}

/// What the store holds, as the database counts it: the bytes of every file a
/// release that still has its files names, each file once.
async fn stored_bytes(conn: &mut SqliteConnection) -> Result<(u64, HashSet<String>)> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT DISTINCT a.sha256,a.size FROM agent_release_artifacts a JOIN agent_releases r ON r.id=a.release_id WHERE r.files_removed=0",
    )
    .fetch_all(&mut *conn)
    .await?;
    let total = rows
        .iter()
        .map(|(_, size)| u64::try_from(*size).unwrap_or(0))
        .sum();
    Ok((total, rows.into_iter().map(|(sha, _)| sha).collect()))
}

/// What stops a release of `version` that needs `incoming` bytes in the store:
/// a release of the version that is not withdrawn, no current key, twenty
/// releases that are not withdrawn, or a store that would outgrow its limit.
async fn room_for(
    s: &State,
    conn: &mut SqliteConnection,
    version: &str,
    builds: &[(String, u64)],
) -> Result<()> {
    let live: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_releases WHERE state<>'withdrawn'")
            .fetch_one(&mut *conn)
            .await?;
    let same: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_releases WHERE version=? AND state<>'withdrawn'",
    )
    .bind(version)
    .fetch_one(&mut *conn)
    .await?;
    if same > 0 {
        return Err(exists(version));
    }
    if agent_release_keys::current(conn).await?.is_none() {
        return Err(agent_release_keys::custody_required());
    }
    if live >= MAX_LIVE {
        return Err(storage_full(
            "Twenty releases that aren't withdrawn exist. Withdraw one to prepare another.",
        ));
    }
    let (used, held) = stored_bytes(conn).await?;
    let incoming: u64 = builds
        .iter()
        .filter(|(sha, _)| !held.contains(sha))
        .map(|(_, size)| *size)
        .sum();
    let limit = s
        .settings
        .agent_release_storage_bytes
        .unwrap_or(DEFAULT_STORAGE_BYTES);
    if used.saturating_add(incoming) > limit {
        return Err(storage_full(
            "The release store is full. Withdraw a release to free room, or raise VECTORY_AGENT_RELEASE_STORAGE_BYTES.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Preparing, signing and withdrawing

/// `POST /api/v1/agent-releases {version}`: prepares the release of a version in
/// this server's catalog. Each platform's file is copied, re-hashed, into the
/// release store, the next counter is taken and the manifest is built and stored
/// exactly. With server custody the release is signed at once; with offline
/// custody it waits for its signature.
///
/// The files are copied before the writer is taken, so heartbeats never wait
/// for a copy; everything the copy depended on is checked again in the writer.
pub async fn prepare(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    let request = agent_updates::body(&bytes, &["version"])?;
    let version = request
        .get("version")
        .and_then(Value::as_str)
        .filter(|version| agent_release::Version::parse(version).is_some())
        .ok_or_else(|| ApiError::invalid("version must be major.minor.patch"))?
        .to_owned();
    let catalog = install::catalog(&s).await;
    let builds = builds_of(&catalog, &version);
    if builds.is_empty() {
        return Err(not_in_catalog(&version));
    }
    let wanted: Vec<(String, u64)> = builds
        .iter()
        .map(|build| (build.sha256.clone(), build.size))
        .collect();
    {
        let mut tx = s.pool.begin().await?;
        agent_updates::require_on(&mut tx).await?;
        room_for(&s, &mut tx, &version, &wanted).await?;
    }
    let store = store_dir(&s);
    let copied = {
        let (store, files): (PathBuf, Vec<(PathBuf, String, u64)>) = (
            store.clone(),
            builds
                .iter()
                .map(|build| (build.path().to_owned(), build.sha256.clone(), build.size))
                .collect(),
        );
        tokio::task::spawn_blocking(move || -> std::result::Result<(), CopyError> {
            std::fs::create_dir_all(&store)?;
            let _ = crate::crypto::restrict_dir(store.parent().unwrap_or(&store));
            let _ = crate::crypto::restrict_dir(&store);
            for (source, sha256, size) in &files {
                copy_verified(&store, source, sha256, *size)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| internal("The release files couldn't be copied."))?
    };
    copied.map_err(|error| match error {
        CopyError::Changed => {
            ApiError::conflict("A build in the catalog changed while it was copied. Try again.")
        }
        CopyError::Io(error) if error.kind() == std::io::ErrorKind::StorageFull => {
            storage_full("The disk that holds the release store is full.")
        }
        CopyError::Io(error) => {
            tracing::error!(%error, "release files could not be copied into the store");
            internal("The release files couldn't be copied into the release store.")
        }
    })?;
    let stored: Vec<Stored> = builds
        .iter()
        .map(|build| Stored {
            os: build.os.clone(),
            arch: build.arch.clone(),
            size: build.size,
            sha256: build.sha256.clone(),
        })
        .collect();

    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let setting = agent_updates::require_on(&mut tx).await?;
    room_for(&s, &mut tx, &version, &wanted).await?;
    let key = agent_release_keys::current(&mut tx)
        .await?
        .ok_or_else(agent_release_keys::custody_required)?;
    let counter = agent_updates::next_counter(&mut tx, setting.counter_sequence).await?;
    sqlx::query("UPDATE agent_update_settings SET counter_sequence=? WHERE id=1")
        .bind(counter)
        .execute(&mut *tx)
        .await?;
    let now = Utc::now();
    let (issued, expires) = (
        now.timestamp(),
        (now + Duration::days(VALIDITY_DAYS)).timestamp(),
    );
    let inputs: Vec<ArtifactInput<'_>> = stored
        .iter()
        .map(|build| ArtifactInput {
            os: &build.os,
            arch: &build.arch,
            size: build.size,
            sha256: &build.sha256,
        })
        .collect();
    let manifest = agent_release::build_manifest(
        &version,
        u64::try_from(counter).unwrap_or(0),
        issued,
        expires,
        None,
        SERVICE_DEFINITION,
        &inputs,
    )
    .map_err(|error| {
        tracing::error!(%error, "a release manifest could not be built");
        internal("The release manifest couldn't be built.")
    })?;
    let manifest_sha256 = agent_release::manifest_sha256(&manifest);
    let signed = if key.custody == "server" {
        let seed = agent_release_keys::unseal_seed(&s, &key.fingerprint)?;
        let signature = agent_release::sign(seed.bytes(), &manifest)
            .map_err(|_| internal("The release couldn't be signed."))?;
        Some(
            agent_release::build_signature_file(&[SignatureEntry {
                key: key.fingerprint.clone(),
                signature,
            }])
            .map_err(|_| internal("The signature file couldn't be built."))?,
        )
    } else {
        None
    };
    let id = db::id();
    let (issued_at, expires_at) = (
        agent_release::format_instant(issued).unwrap_or_default(),
        agent_release::format_instant(expires).unwrap_or_default(),
    );
    let prepared_at = instant(now);
    sqlx::query("INSERT INTO agent_releases(id,version,counter,manifest,manifest_sha256,signature,signer,issued_at,expires_at,min_from,service_definition,state,prepared_by,prepared_by_name,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?)")
        .bind(&id)
        .bind(&version)
        .bind(counter)
        .bind(&manifest)
        .bind(&manifest_sha256)
        .bind(signed.as_deref())
        .bind(signed.as_ref().map(|_| key.fingerprint.as_str()))
        .bind(&issued_at)
        .bind(&expires_at)
        .bind(i64::try_from(SERVICE_DEFINITION).unwrap_or(1))
        .bind(if signed.is_some() { "ready" } else { "awaiting_signature" })
        .bind(actor["id"].as_str())
        .bind(actor["name"].as_str())
        .bind(&prepared_at)
        .execute(&mut *tx)
        .await
        .map_err(|error| match &error {
            // One release of a version at a time; a counter is used once.
            sqlx::Error::Database(failure)
                if failure.is_unique_violation() && failure.message().contains("version") =>
            {
                exists(&version)
            }
            sqlx::Error::Database(failure) if failure.is_unique_violation() => {
                ApiError::conflict("That release counter was already used. Try again.")
            }
            _ => error.into(),
        })?;
    let parsed = agent_release::Version::parse(&version)
        .ok_or_else(|| internal("The version isn't valid."))?;
    for build in &stored {
        sqlx::query("INSERT INTO agent_release_artifacts(release_id,os,arch,file,size,sha256) VALUES(?,?,?,?,?,?)")
            .bind(&id)
            .bind(&build.os)
            .bind(&build.arch)
            .bind(agent_release::artifact_file_name(&parsed, &build.os, &build.arch))
            .bind(i64::try_from(build.size).unwrap_or(0))
            .bind(&build.sha256)
            .execute(&mut *tx)
            .await?;
    }
    let actor_id = actor["id"].as_str().unwrap_or("");
    let details = json!({"release_id":id,"version":version,"counter":counter,"manifest_sha256":manifest_sha256});
    agent_updates::audit(
        &mut tx,
        actor_id,
        "agent_release.prepare",
        &id,
        "success",
        details.clone(),
    )
    .await?;
    if signed.is_some() {
        let mut signing = details;
        signing["fingerprint"] = json!(key.fingerprint);
        agent_updates::audit(
            &mut tx,
            actor_id,
            "agent_release.sign",
            &id,
            "success",
            signing,
        )
        .await?;
    }
    let release = load(&mut tx, &id).await?;
    let out = view(&mut tx, &release).await?;
    tx.commit().await?;
    Ok(Json(out))
}

/// `PUT /api/v1/agent-releases/{id}/signature`: the raw bytes of a
/// `release.json.sig`, at most 4 KiB, whatever the content type. Only a release
/// that awaits its signature takes one, and only a file that is a valid
/// signature file one of whose entries names the current key and verifies over
/// the stored manifest. A refusal is audited with its reason.
pub async fn signature(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    body: Body,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    let bytes = axum::body::to_bytes(body, agent_release::MAX_SIGNATURE_FILE_BYTES + 1)
        .await
        .map_err(|_| too_large())?;
    if bytes.len() > agent_release::MAX_SIGNATURE_FILE_BYTES {
        return Err(too_large());
    }
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    agent_updates::require_on(&mut tx).await?;
    let row = sqlx::query(
        "SELECT version,counter,manifest,manifest_sha256,state FROM agent_releases WHERE id=?",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::missing)?;
    if row.get::<String, _>("state") != "awaiting_signature" {
        return Err(ApiError::conflict(
            "Only a release that is awaiting its signature takes one.",
        ));
    }
    let key = agent_release_keys::current(&mut tx)
        .await?
        .ok_or_else(agent_release_keys::custody_required)?;
    let (version, counter, manifest, digest): (String, i64, Vec<u8>, String) = (
        row.get("version"),
        row.get("counter"),
        row.get("manifest"),
        row.get("manifest_sha256"),
    );
    let actor_id = actor["id"].as_str().unwrap_or("");
    let details = json!({"release_id":id,"version":version,"counter":counter,"manifest_sha256":digest,"fingerprint":key.fingerprint});
    if let Err(refusal) = agent_release::check_signature_file(&manifest, &bytes, &key.key()?) {
        // The refusal is kept: it is in the audit trail with its reason.
        let mut refused = details;
        refused["reason"] = json!(refusal.detail);
        agent_updates::audit(
            &mut tx,
            actor_id,
            "agent_release.signature_upload",
            &id,
            "refused",
            refused,
        )
        .await?;
        tx.commit().await?;
        return Err(invalid_signature(&refusal.detail));
    }
    sqlx::query("UPDATE agent_releases SET signature=?,signer=?,state='ready' WHERE id=? AND state='awaiting_signature'")
        .bind(bytes.as_ref())
        .bind(&key.fingerprint)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    agent_updates::audit(
        &mut tx,
        actor_id,
        "agent_release.signature_upload",
        &id,
        "success",
        details,
    )
    .await?;
    let release = load(&mut tx, &id).await?;
    let out = view(&mut tx, &release).await?;
    tx.commit().await?;
    Ok(Json(out))
}
fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "PAYLOAD_TOO_LARGE",
        "A signature file is at most 4 KiB.",
    )
}

/// Withdraws every release a key signed, for the revocation of that key. The
/// caller ends the rollouts that offer them. Returns the releases withdrawn.
pub(crate) async fn withdraw_signed_by(
    conn: &mut SqliteConnection,
    fingerprint: &str,
    actor: &str,
    at: &str,
    reason: &str,
) -> Result<Vec<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM agent_releases WHERE signer=? AND state<>'withdrawn' ORDER BY prepared_at,id",
    )
    .bind(fingerprint)
    .fetch_all(&mut *conn)
    .await?;
    for id in &ids {
        sqlx::query("UPDATE agent_releases SET state='withdrawn',withdrawn_by=?,withdrawn_at=?,withdrawn_reason=? WHERE id=?")
            .bind(actor)
            .bind(at)
            .bind(reason)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(ids)
}

/// `POST /api/v1/agent-releases/{id}/withdraw {reason}`: the release is no
/// longer offered and the rollouts that offer it end, devices already applying
/// finish. Its files leave the store once no rollout needs them (`prune`); its
/// row and manifest stay.
pub async fn withdraw(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    let request = agent_updates::body(&bytes, &["reason"])?;
    let reason = agent_updates::reason(request.get("reason").unwrap_or(&Value::Null))?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    agent_updates::require_on(&mut tx).await?;
    let release = load(&mut tx, &id).await?;
    if release.state == "withdrawn" {
        return Err(ApiError::conflict("This release is already withdrawn."));
    }
    let at = instant(Utc::now());
    let actor_id = actor["id"].as_str().unwrap_or("");
    sqlx::query("UPDATE agent_releases SET state='withdrawn',withdrawn_by=?,withdrawn_at=?,withdrawn_reason=? WHERE id=?")
        .bind(actor_id)
        .bind(&at)
        .bind(&reason)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let ended =
        agent_update_rollouts::cancel_release(&mut tx, &id, "release_withdrawn", &at).await?;
    // With its rollouts ended nothing needs its files: they stop counting
    // against the store now and are deleted once this commits.
    let freed = release_files(&mut tx).await?;
    agent_updates::audit(
        &mut tx,
        actor_id,
        "agent_release.withdraw",
        &id,
        "success",
        json!({"release_id":id,"version":release.version,"counter":release.counter,"manifest_sha256":release.manifest_sha256,"reason":reason,"cancelled_rollouts":ended.rollouts.len()}),
    )
    .await?;
    let release = load(&mut tx, &id).await?;
    let out = view(&mut tx, &release).await?;
    tx.commit().await?;
    remove_files(&s, &freed);
    for device in &ended.devices {
        crate::wake::ask(device);
    }
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Retention

fn is_digest(name: &str) -> bool {
    agent_updates::fingerprint(name)
}

/// Marks the files of withdrawn releases that no rollout still needs as removed
/// (they no longer count against the store) and returns the digests no release
/// names any more: the files to delete once the transaction has committed.
pub(crate) async fn release_files(conn: &mut SqliteConnection) -> Result<Vec<String>> {
    let finished: Vec<String> = sqlx::query_scalar(
        "SELECT r.id FROM agent_releases r WHERE r.state='withdrawn' AND r.files_removed=0 AND NOT EXISTS (SELECT 1 FROM agent_update_rollouts ro WHERE ro.release_id=r.id AND ro.status IN ('active','paused'))",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut digests = BTreeSet::new();
    for id in &finished {
        let named: Vec<String> =
            sqlx::query_scalar("SELECT sha256 FROM agent_release_artifacts WHERE release_id=?")
                .bind(id)
                .fetch_all(&mut *conn)
                .await?;
        digests.extend(named);
        sqlx::query("UPDATE agent_releases SET files_removed=1 WHERE id=?")
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    let (_, referenced) = stored_bytes(conn).await?;
    Ok(digests
        .into_iter()
        .filter(|digest| !referenced.contains(digest))
        .collect())
}
/// Deletes files of the store, after the transaction that stopped naming them
/// has committed. A file that cannot be removed now is an orphan the prune
/// removes later.
pub(crate) fn remove_files(s: &State, digests: &[String]) {
    for digest in digests.iter().filter(|digest| is_digest(digest)) {
        if let Err(error) = std::fs::remove_file(store_path(s, digest))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%error, "a release file could not be removed; the next prune retries");
        }
    }
}

/// Removes what no rollout needs: the files of withdrawn releases, files of the
/// store no release names (left by a request that did not finish) and sealed
/// release keys that no current key of the server owns. It runs in the
/// minute-by-minute prune, under the writer lock, so nothing it removes can be
/// in the middle of being registered.
pub async fn prune(s: &State, conn: &mut SqliteConnection) -> Result<()> {
    let store = store_dir(s);
    // The files of a withdrawn release go once no rollout of it can still be
    // served and no other release names the same file.
    remove_files(s, &release_files(conn).await?);
    let (_, referenced) = stored_bytes(conn).await?;
    if let Ok(entries) = std::fs::read_dir(&store) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let wanted = is_digest(&name) && referenced.contains(&name);
            let old = meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age.as_secs() >= ORPHAN_SECONDS);
            // A released digest's file goes at once; a stray file, or a partial
            // copy, only when it is old enough not to belong to a request.
            let released = is_digest(&name) && !referenced.contains(&name) && old;
            let stray = !is_digest(&name) && old;
            if !wanted && (released || stray) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    agent_release_keys::prune_sealed(s, conn).await
}

// ---------------------------------------------------------------------------
// The download

/// Transfers of release files on the agent listener at once.
static DOWNLOADS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(16);
/// The devices that have a transfer running: one at a time each.
static ACTIVE: std::sync::Mutex<BTreeSet<String>> = std::sync::Mutex::new(BTreeSet::new());
/// Requests a device may make in an hour: a build is fetched once, and a
/// device that fetches again is retrying.
const DOWNLOADS_PER_HOUR: u32 = 6;
const BUSY_RETRY_SECONDS: u64 = 5;

/// The device's one transfer, held for as long as it streams.
struct DeviceSlot(String);
impl DeviceSlot {
    fn take(device: &str) -> Result<Self> {
        let mut active = ACTIVE
            .lock()
            .map_err(|_| ApiError::conflict("Download tracking is unavailable"))?;
        if !active.insert(device.to_owned()) {
            return Err(ApiError::throttled(
                "RATE_LIMITED",
                "This device already has a download in progress.",
                BUSY_RETRY_SECONDS,
            ));
        }
        Ok(Self(device.to_owned()))
    }
}
impl Drop for DeviceSlot {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&self.0);
        }
    }
}

/// `GET /agent/v1/agent-releases/{sha256}` on the agent listener, mutual TLS,
/// authenticated like `GET /agent/v1/artifacts/{sha256}`. It answers only when
/// updates are on and not stopped and the device holds a current offer whose
/// artifact has that digest: `404` while updates are off or for a digest no
/// release names, `403` otherwise. The file is streamed from the release store,
/// hashed as it goes, with no redirect, no range and no resume.
pub async fn download(
    AppState(s): AppState<State>,
    Extension(peer): Extension<crate::device::PeerCertificate>,
    Path(sha256): Path<String>,
) -> Result<Response> {
    let device = crate::device::authenticated(&s, &peer).await?;
    // Every request is counted, generously; only a request for a build the device
    // holds an offer for spends the hourly budget of a transfer.
    s.limit(
        format!("agent-release:probe:{device}"),
        60,
        std::time::Duration::from_secs(60),
    )?;
    let mut tx = s.pool.begin().await?;
    if !agent_updates::enabled(&mut tx).await? {
        return Err(agent_updates::off_public());
    }
    if !is_digest(&sha256) {
        return Err(ApiError::missing());
    }
    let named: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_release_artifacts WHERE sha256=?")
            .bind(&sha256)
            .fetch_one(&mut *tx)
            .await?;
    if named == 0 {
        return Err(ApiError::missing());
    }
    let offer = crate::agent_updates::offer::for_device(&mut tx, &device, &db::now()).await?;
    let artifact = offer
        .map(|offer| offer.artifact)
        .filter(|artifact| artifact.sha256 == sha256)
        .ok_or_else(ApiError::forbidden)?;
    drop(tx);
    // Room for another transfer comes before the hourly budget, so a busy
    // server never spends a device's.
    let slot = DeviceSlot::take(&device)?;
    let permit = DOWNLOADS.try_acquire().map_err(|_| {
        ApiError::throttled(
            "CAPACITY_BUSY",
            "Too many agent builds are downloading. Try again in a few seconds.",
            BUSY_RETRY_SECONDS,
        )
    })?;
    s.limit(
        format!("agent-release:{device}"),
        DOWNLOADS_PER_HOUR,
        std::time::Duration::from_secs(3600),
    )?;
    let path = store_path(&s, &sha256);
    install::stream_verified(
        install::Transfer {
            path: &path,
            size: u64::try_from(artifact.size).unwrap_or(0),
            sha256: &sha256,
            label: &artifact.file,
        },
        permit,
        Some(Box::new(slot)),
    )
    .await
}
