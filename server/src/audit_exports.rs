//! Prepared audit downloads: a complete private file, finite snapshot and quotas.
use crate::{
    State, audit, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{
        Path, Query, RawQuery, State as AppState,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Write,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ROWS: i64 = 100_000;
const PREPARE_SECONDS: u64 = 120;
const TTL_SECONDS: u64 = 600;
const CHUNK_ROWS: i64 = 100;
const DOWNLOAD_CHUNK: usize = 256 * 1024;

pub struct Store {
    pub directory: PathBuf,
    entries: Mutex<HashMap<String, Entry>>,
    pub preparing: Arc<tokio::sync::Semaphore>,
    pub downloading: Arc<tokio::sync::Semaphore>,
}
struct Entry {
    user: String,
    session: String,
    ready: Option<Arc<Ready>>,
    discarded: bool,
    cleanup_path: Option<PathBuf>,
    cleanup_warned: bool,
}
struct Ready {
    file: tempfile::NamedTempFile,
    metadata: Value,
    expires: Instant,
}
struct Reservation {
    store: Arc<Store>,
    id: String,
    keep: bool,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.keep {
            if let Ok(mut entries) = self.store.entries.lock() {
                if let Some(entry) = entries.get_mut(&self.id) {
                    entry.discarded = true;
                }
            }
            self.store.prune();
        }
    }
}
impl Store {
    pub fn initialize(data_dir: &FsPath) -> anyhow::Result<Arc<Self>> {
        let directory = data_dir.join("audit-exports");
        if let Ok(metadata) = std::fs::symlink_metadata(&directory) {
            if metadata.file_type().is_symlink() {
                anyhow::bail!("Audit export directory must not be a link")
            }
        }
        std::fs::create_dir_all(&directory)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if std::fs::symlink_metadata(&directory)?.file_attributes() & 0x400 != 0 {
                anyhow::bail!("Audit export directory must not be a reparse point")
            }
        }
        crate::crypto::restrict_dir(&directory)?;
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("audit-") && name.ends_with(".jsonl") {
                let metadata = std::fs::symlink_metadata(entry.path())?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    anyhow::bail!("Unexpected audit export file type")
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        anyhow::bail!("Audit export file must not be a reparse point")
                    }
                }
                std::fs::remove_file(entry.path())?;
            }
        }
        let store = Arc::new(Self {
            directory,
            entries: Mutex::new(HashMap::new()),
            preparing: Arc::new(tokio::sync::Semaphore::new(2)),
            downloading: Arc::new(tokio::sync::Semaphore::new(4)),
        });
        let weak = Arc::downgrade(&store);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Some(store) = weak.upgrade() else { break };
                store.prune();
            }
        });
        Ok(store)
    }
    fn prune(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, e| {
                if let Some(ready) = &e.ready {
                    if ready.expires <= Instant::now() {
                        e.discarded = true;
                    }
                    if !e.discarded || Arc::strong_count(ready) > 1 {
                        return true;
                    }
                    // Tempfile's Drop ignores unlink errors. Explicitly close,
                    // and retain the quota/path when an OS lock prevents removal.
                    let ready = Arc::try_unwrap(e.ready.take().unwrap()).ok().unwrap();
                    e.cleanup_path = Some(ready.file.path().to_owned());
                    if ready.file.close().is_ok() {
                        return false;
                    }
                }
                if e.discarded {
                    let Some(path) = &e.cleanup_path else {
                        return false;
                    };
                    match std::fs::remove_file(path) {
                        Ok(()) => return false,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
                        Err(_) => {if !e.cleanup_warned {tracing::warn!("Cannot remove a private audit export; retaining its capacity reservation and retrying cleanup");e.cleanup_warned=true;}}
                    }
                }
                true
            });
        }
    }
    fn reserve(self: &Arc<Self>, user: String, session: String) -> Result<Reservation> {
        self.prune();
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| ApiError::conflict("Export registry unavailable"))?;
        if entries.len() >= 4 || entries.values().filter(|e| e.user == user).count() >= 2 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "EXPORT_CAPACITY",
                "Discard an earlier export or wait for it to expire",
            ));
        }
        let id = db::id();
        entries.insert(
            id.clone(),
            Entry {
                user,
                session,
                ready: None,
                discarded: false,
                cleanup_path: None,
                cleanup_warned: false,
            },
        );
        Ok(Reservation {
            store: self.clone(),
            id,
            keep: false,
        })
    }
    fn ready(&self, id: &str, user: &str, session: &str) -> Result<Arc<Ready>> {
        self.prune();
        let entries = self.entries.lock().map_err(|_| ApiError::missing())?;
        let e = entries
            .get(id)
            .filter(|e| e.user == user && e.session == session && !e.discarded)
            .ok_or_else(ApiError::missing)?;
        e.ready.clone().ok_or_else(ApiError::missing)
    }
}
fn timed_out() -> ApiError {
    ApiError::new(
        StatusCode::REQUEST_TIMEOUT,
        "EXPORT_TIMEOUT",
        "Export exceeded its preparation time limit; narrow the filters",
    )
}
fn encode_line(v: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(v).expect("JSON value");
    bytes.push(b'\n');
    bytes
}
fn append(
    file: &mut tempfile::NamedTempFile,
    bytes: &[u8],
    length: &mut u64,
    hash: &mut Sha256,
) -> Result<()> {
    if bytes.len() > 64 * 1024 || length.saturating_add(bytes.len() as u64) > MAX_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EXPORT_TOO_LARGE",
            "Export exceeds its file size limit; narrow the filters",
        ));
    }
    file.write_all(bytes).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXPORT_STORAGE",
            "Cannot prepare the audit export",
        )
    })?;
    *length += bytes.len() as u64;
    hash.update(bytes);
    Ok(())
}
pub async fn prepare(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
    input: std::result::Result<Json<audit::Filters>, JsonRejection>,
) -> Result<Json<Value>> {
    tokio::time::timeout(
        Duration::from_secs(PREPARE_SECONDS),
        prepare_inner(s, h, raw, parsed, input),
    )
    .await
    .map_err(|_| timed_out())?
}
async fn prepare_inner(
    s: State,
    h: HeaderMap,
    raw: Option<String>,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
    input: std::result::Result<Json<audit::Filters>, JsonRejection>,
) -> Result<Json<Value>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(PREPARE_SECONDS);
    let actor = auth::authorize(&s, &h, &[], true).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let Json(input) = input.map_err(|_| ApiError::invalid("Invalid audit export filters"))?;
    let filters = input.validate()?;
    let user = actor["id"].as_str().unwrap().to_owned();
    let session = db::hash(auth::session_token(&h)?);
    s.limit(format!("audit-export:{user}"), 6, Duration::from_secs(60))?;
    let _slot = s
        .audit_exports
        .preparing
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "EXPORT_BUSY",
                "Two audit exports are already preparing",
            )
        })?;
    let mut reservation = s.audit_exports.reserve(user, session)?;
    let result = tokio::time::timeout_at(deadline, build(&s, &h, &filters, &reservation.id))
        .await
        .map_err(|_| timed_out())??;
    let metadata = result.metadata.clone();
    {
        let mut entries = s
            .audit_exports
            .entries
            .lock()
            .map_err(|_| ApiError::conflict("Export registry unavailable"))?;
        let e = entries
            .get_mut(&reservation.id)
            .ok_or_else(ApiError::missing)?;
        e.ready = Some(Arc::new(result));
    }
    reservation.keep = true;
    Ok(Json(metadata))
}
async fn build(s: &State, h: &HeaderMap, filters: &audit::Filters, id: &str) -> Result<Ready> {
    let mut file = tempfile::Builder::new()
        .prefix("audit-")
        .suffix(".jsonl")
        .tempfile_in(&s.audit_exports.directory)
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "EXPORT_STORAGE",
                "Cannot create private audit export",
            )
        })?;
    // Record the private generated path before any fallible write. On failed or
    // cancelled preparation the reservation retries deletion rather than freeing
    // disk quota while an unlinked file still occupies storage.
    {
        let mut entries = s
            .audit_exports
            .entries
            .lock()
            .map_err(|_| ApiError::conflict("Export registry unavailable"))?;
        entries
            .get_mut(id)
            .ok_or_else(ApiError::missing)?
            .cleanup_path = Some(file.path().to_owned());
    }
    crate::crypto::restrict_tree(file.path()).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXPORT_STORAGE",
            "Cannot protect audit export",
        )
    })?;
    let mut tx = s.pool.begin().await?;
    let cutoff: i64 = sqlx::query_scalar("SELECT COALESCE(max(sequence),0) FROM audit_sequence")
        .fetch_one(&mut *tx)
        .await?;
    let total = audit::count(&mut tx, filters, Some(cutoff)).await?;
    if total > MAX_ROWS {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "EXPORT_TOO_LARGE",
            "Export exceeds 100000 events; narrow the filters",
        ));
    }
    let snapshot_at = db::now();
    let mut bytes = 0;
    let mut whole = Sha256::new();
    let mut events = Sha256::new();
    let mut written = 0i64;
    let mut cursor = None;
    append(
        &mut file,
        &encode_line(
            &json!({"type":"metadata","format":"vectory.audit.jsonl.v1","snapshot_at":snapshot_at,"snapshot_sequence":cutoff,"row_count":total,"filters":filters,"order":"created_at_desc,sequence_desc","names":"current_at_snapshot","limits":{"rows":MAX_ROWS,"bytes":MAX_BYTES,"preparation_seconds":PREPARE_SECONDS}}),
        ),
        &mut bytes,
        &mut whole,
    )?;
    loop {
        let reader = auth::authorize(s, h, &[], false).await?;
        let rows = audit::rows(
            &mut tx,
            filters,
            CHUNK_ROWS,
            0,
            Some(cutoff),
            cursor.as_ref(),
            true,
        )
        .await?;
        if rows.is_empty() {
            break;
        }
        for (event, next) in rows {
            let event = audit::for_reader(event, &reader);
            let line = encode_line(&json!({"type":"audit","event":event}));
            append(&mut file, &line, &mut bytes, &mut whole)?;
            events.update(&line);
            written += 1;
            cursor = Some(next);
        }
    }
    if written != total {
        return Err(ApiError::conflict(
            "Audit snapshot count changed unexpectedly",
        ));
    }
    auth::authorize(s, h, &[], false).await?;
    append(
        &mut file,
        &encode_line(
            &json!({"type":"complete","complete":true,"row_count":written,"events_sha256":hex::encode(events.finalize())}),
        ),
        &mut bytes,
        &mut whole,
    )?;
    tx.rollback().await?;
    file.flush().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXPORT_STORAGE",
            "Cannot flush audit export",
        )
    })?;
    file.as_file().sync_all().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "EXPORT_STORAGE",
            "Cannot finalize audit export",
        )
    })?;
    let created = chrono::Utc::now();
    let expires = created + chrono::Duration::seconds(TTL_SECONDS as i64);
    Ok(Ready {
        file,
        expires: Instant::now() + Duration::from_secs(TTL_SECONDS),
        metadata: json!({"id":id,"filters":filters,"row_count":written,"byte_count":bytes,"sha256":hex::encode(whole.finalize()),"created_at":created.to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"expires_at":expires.to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"download_path":format!("/api/v1/audit/exports/{id}/download")}),
    })
}
pub async fn discard(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &[], true).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let session = db::hash(auth::session_token(&h)?);
    {
        let mut entries = s
            .audit_exports
            .entries
            .lock()
            .map_err(|_| ApiError::missing())?;
        let e = entries
            .get_mut(&id)
            .filter(|e| e.user == actor["id"].as_str().unwrap() && e.session == session)
            .ok_or_else(ApiError::missing)?;
        e.discarded = true;
    }
    s.audit_exports.prune();
    Ok(Json(json!({"ok":true})))
}
pub async fn list(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &[], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let session = db::hash(auth::session_token(&h)?);
    s.audit_exports.prune();
    let entries = s
        .audit_exports
        .entries
        .lock()
        .map_err(|_| ApiError::conflict("Export registry unavailable"))?;
    let mut ready = entries
        .values()
        .filter(|e| e.user == actor["id"].as_str().unwrap() && e.session == session && !e.discarded)
        .filter_map(|e| e.ready.as_ref().map(|r| r.metadata.clone()))
        .collect::<Vec<_>>();
    ready.sort_by(|a, b| {
        b["created_at"]
            .as_str()
            .cmp(&a["created_at"].as_str())
            .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
    });
    Ok(Json(json!(ready)))
}
pub async fn download(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Response> {
    let actor = auth::authorize(&s, &h, &[], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let session = db::hash(auth::session_token(&h)?);
    let ready = s
        .audit_exports
        .ready(&id, actor["id"].as_str().unwrap(), &session)?;
    let permit = s
        .audit_exports
        .downloading
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "EXPORT_BUSY",
                "Four audit downloads are already active",
            )
        })?;
    let file = ready.file.reopen().map_err(|_| ApiError::missing())?;
    let length = ready.metadata["byte_count"].as_u64().unwrap();
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<std::result::Result<Bytes, std::io::Error>>(1);
    tokio::spawn(async move {
        let _permit = permit;
        let _ready = ready;
        let mut file = tokio::fs::File::from_std(file);
        let stream = async {
            let mut sent = 0;
            loop {
                auth::authorize(&s, &h, &[], false).await?;
                let mut buffer = vec![0; DOWNLOAD_CHUNK];
                let n = file
                    .read(&mut buffer)
                    .await
                    .map_err(|_| ApiError::missing())?;
                if n == 0 {
                    if sent != length {
                        return Err(ApiError::conflict("Export file length changed"));
                    }
                    break;
                }
                buffer.truncate(n);
                sent += n as u64;
                if sender.send(Ok(Bytes::from(buffer))).await.is_err() {
                    return Ok(());
                }
            }
            Ok::<(), ApiError>(())
        };
        let result = tokio::select! {_ = sender.closed()=>return,result=tokio::time::timeout(Duration::from_secs(120),stream)=>result};
        if !matches!(result, Ok(Ok(()))) {
            let _ = sender.try_send(Err(std::io::Error::other("Audit download interrupted")));
        }
        // Content-Length prevents a partial transfer from looking like a complete file.
    });
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson".to_owned()),
            (header::CONTENT_LENGTH, length.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"vectory-audit-{id}.jsonl\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(receiver)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn expiry_discard_and_reservation_failure_keep_disk_quota_until_handles_close() {
        let temp = tempfile::tempdir().unwrap();
        let store = Store::initialize(temp.path()).unwrap();
        {
            let _reservation = store.reserve("user".into(), "session".into()).unwrap();
            assert_eq!(store.entries.lock().unwrap().len(), 1);
        }
        assert!(store.entries.lock().unwrap().is_empty());
        let mut reservation = store.reserve("user".into(), "session".into()).unwrap();
        let file = tempfile::Builder::new()
            .prefix("audit-")
            .suffix(".jsonl")
            .tempfile_in(&store.directory)
            .unwrap();
        let path = file.path().to_owned();
        let ready = Arc::new(Ready {
            file,
            metadata: json!({}),
            expires: Instant::now() - Duration::from_secs(1),
        });
        store
            .entries
            .lock()
            .unwrap()
            .get_mut(&reservation.id)
            .unwrap()
            .ready = Some(ready.clone());
        reservation.keep = true;
        store.prune();
        assert!(path.exists());
        assert!(store.ready(&reservation.id, "user", "session").is_err());
        assert_eq!(store.entries.lock().unwrap().len(), 1);
        drop(ready);
        store.prune();
        assert!(!path.exists());
        assert!(store.entries.lock().unwrap().is_empty());
        let mut reservations = Vec::new();
        for n in 0..4 {
            reservations.push(store.reserve(format!("user{n}"), "session".into()).unwrap());
        }
        assert!(store.reserve("extra".into(), "session".into()).is_err());
        drop(reservations);
        assert!(store.entries.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn startup_removes_only_owned_stale_regular_files() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("audit-exports");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("audit-stale.jsonl"), "stale").unwrap();
        std::fs::write(dir.join("operator-note.txt"), "keep").unwrap();
        let store = Store::initialize(temp.path()).unwrap();
        assert!(!dir.join("audit-stale.jsonl").exists());
        assert!(dir.join("operator-note.txt").exists());
        drop(store);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_unlink_failure_retains_ready_and_failed_preparation_quota() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let store = Store::initialize(temp.path()).unwrap();
        for prepared in [false, true] {
            let mut reservation = store.reserve("user".into(), "session".into()).unwrap();
            let file = tempfile::Builder::new()
                .prefix("audit-")
                .suffix(".jsonl")
                .tempfile_in(&store.directory)
                .unwrap();
            let path = file.path().to_owned();
            let blocker = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(3)
                .open(&path)
                .unwrap();
            {
                let mut entries = store.entries.lock().unwrap();
                let e = entries.get_mut(&reservation.id).unwrap();
                e.cleanup_path = Some(path.clone());
                if prepared {
                    e.ready = Some(Arc::new(Ready {
                        file,
                        metadata: json!({}),
                        expires: Instant::now() - Duration::from_secs(1),
                    }));
                    reservation.keep = true;
                } else {
                    drop(file);
                }
            }
            let id = reservation.id.clone();
            drop(reservation);
            store.prune();
            assert!(path.exists());
            assert!(store.entries.lock().unwrap().contains_key(&id));
            assert!(store.ready(&id, "user", "session").is_err());
            drop(blocker);
            store.prune();
            assert!(!path.exists());
            assert!(!store.entries.lock().unwrap().contains_key(&id));
        }
    }
}
