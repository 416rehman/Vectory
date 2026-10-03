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
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    body::Body,
    extract::{Path, State as AppState},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;

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
