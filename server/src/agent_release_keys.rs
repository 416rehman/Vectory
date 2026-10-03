//! Release keys: the public keys whose signatures hosts trust to install an
//! agent build, who holds each private half (the custody), and how a key is
//! replaced by another.
//!
//! The server stores public keys, their state (`current`, `retired` or
//! `revoked`) and the rollover statements that led from one to the next, all of
//! it public. With custody `server` the private seed lives sealed in
//! `keys/agent-release-<fingerprint>.sealed`; with `offline` it never reaches
//! this server.
//!
//! A server-held seed exists on disk only while its key is the current one: a
//! rotation, a change of custody while updates are off and a revocation each
//! remove the file of the key they end, and `prune` removes any file that no
//! current server-held key owns.
use crate::{
    State,
    accounts::{reauthenticate, recheck},
    agent_release::{self, ReleaseKey, RolloverEnvelope, RolloverError},
    agent_updates::{self, instant},
    auth, db,
    error::{ApiError, Result},
    maintenance,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State as AppState},
    http::{HeaderMap, StatusCode},
};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::{collections::HashMap, path::PathBuf};

/// Keys one listing, and the bundle, carry.
pub const MAX_LISTED: i64 = 64;
/// Device names one key lists.
const NAMES_LISTED: usize = 20;
/// The most the key bundle may weigh.
const BUNDLE_BYTES: usize = 64 * 1024;

// ---------------------------------------------------------------------------
// Errors

pub(crate) fn custody_required() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "CUSTODY_REQUIRED",
        "There is no release key. Turn agent updates on and choose who holds the key.",
    )
}
pub(crate) fn custody_locked() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "CUSTODY_LOCKED",
        "The custody can't change while agent updates are on and a key is current. Rotate the key, or turn updates off and on again with the other kind.",
    )
}
pub(crate) fn invalid_key(reason: &str) -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "RELEASE_KEY_INVALID",
        format!("That isn't a valid release key: {reason}."),
    )
}
fn in_use() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "RELEASE_KEY_IN_USE",
        "That key is already in use: it is this server's manifest signing key, its device CA's key or a release key it already holds. A release key must be a key of its own.",
    )
}
fn invalid_signature() -> ApiError {
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "RELEASE_SIGNATURE_INVALID",
        "The signature doesn't verify under the current release key.",
    )
}
fn sealed_unavailable() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "The release key's private half can't be read. Restore the keys directory from a backup that holds both the sealed key and the sealing key.",
    )
}

// ---------------------------------------------------------------------------
// The private half of a key the server holds

/// A seed in memory: written over when it goes out of use. It is never logged,
/// copied into a response or kept anywhere else.
pub(crate) struct Seed([u8; 32]);
impl Seed {
    fn generate() -> Self {
        Seed(agent_release::generate_seed())
    }
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}
impl Drop for Seed {
    fn drop(&mut self) {
        self.0.fill(0);
        std::hint::black_box(&mut self.0);
    }
}

fn sealed_file(fingerprint: &str) -> String {
    format!("agent-release-{fingerprint}.sealed")
}
/// Where a key's sealed seed lives.
pub(crate) fn sealed_path(s: &State, fingerprint: &str) -> PathBuf {
    s.settings
        .data_dir
        .join("keys")
        .join(sealed_file(fingerprint))
}
/// What binds a sealed seed to the key it belongs to.
fn aad(fingerprint: &str) -> String {
    format!("agent-release-key:{fingerprint}")
}
/// Seals the seed of a key with the instance's AES-256-GCM key and writes it,
/// private to the server's account, under the keys directory.
fn seal_seed(s: &State, fingerprint: &str, seed: &Seed) -> Result<()> {
    let sealed = s.keys.seal_bytes(&aad(fingerprint), seed.bytes())?;
    maintenance::atomic_private_replace(&sealed_path(s, fingerprint), &sealed).map_err(|error| {
        tracing::error!(%error, "a release key could not be sealed to disk");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "The release key couldn't be written under the keys directory.",
        )
    })
}
/// The seed of a key the server holds.
pub(crate) fn unseal_seed(s: &State, fingerprint: &str) -> Result<Seed> {
    let sealed = std::fs::read(sealed_path(s, fingerprint)).map_err(|error| {
        tracing::error!(%error, "the sealed release key could not be read");
        sealed_unavailable()
    })?;
    let opened = s
        .keys
        .open_bytes(&aad(fingerprint), &sealed)
        .map_err(|_| sealed_unavailable())?;
    <[u8; 32]>::try_from(opened.as_slice())
        .map(Seed)
        .map_err(|_| sealed_unavailable())
}
/// Removes the sealed seed of a key that is no longer current.
pub(crate) fn wipe_seed(s: &State, fingerprint: &str) {
    if let Err(error) = std::fs::remove_file(sealed_path(s, fingerprint))
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::error!(%error, "a retired release key's sealed file could not be removed; the next prune retries");
    }
}
/// Removes a sealed file written for a key that was never registered, unless
/// the request that wrote it reaches `keep`.
struct Written<'a> {
    s: &'a State,
    fingerprint: String,
    kept: bool,
}
impl<'a> Written<'a> {
    fn new(s: &'a State, fingerprint: &str) -> Self {
        Self {
            s,
            fingerprint: fingerprint.to_owned(),
            kept: false,
        }
    }
    fn keep(&mut self) {
        self.kept = true;
    }
}
impl Drop for Written<'_> {
    fn drop(&mut self) {
        if !self.kept {
            wipe_seed(self.s, &self.fingerprint);
        }
    }
}

/// A key the server generated and holds: its name carries the start of its
/// fingerprint, so two of them are told apart in a listing. The name is in the
/// key line the unauthenticated key bundle serves, so it says nothing of who
/// holds the key.
fn generate_key() -> Result<(Seed, ReleaseKey)> {
    let seed = Seed::generate();
    let failed = |error: agent_release::KeyError| {
        tracing::error!(%error, "a release key could not be generated");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "A release key couldn't be generated.",
        )
    };
    let probe = ReleaseKey::from_seed(seed.bytes(), "release").map_err(failed)?;
    let name = format!("release-{}", &probe.fingerprint()[..8]);
    let key = ReleaseKey::from_seed(seed.bytes(), &name).map_err(failed)?;
    Ok((seed, key))
}

// ---------------------------------------------------------------------------
// What is stored

/// A key row without the statement that introduced it.
pub(crate) struct KeyRow {
    pub fingerprint: String,
    pub public_key: String,
    pub custody: String,
    pub state: String,
}
fn row_of(row: &sqlx::sqlite::SqliteRow) -> KeyRow {
    KeyRow {
        fingerprint: row.get("fingerprint"),
        public_key: row.get("public_key"),
        custody: row.get("custody"),
        state: row.get("state"),
    }
}
pub(crate) async fn row(conn: &mut SqliteConnection, fingerprint: &str) -> Result<Option<KeyRow>> {
    Ok(sqlx::query(
        "SELECT fingerprint,public_key,custody,state FROM agent_release_keys WHERE fingerprint=?",
    )
    .bind(fingerprint)
    .fetch_optional(&mut *conn)
    .await?
    .map(|row| row_of(&row)))
}
/// The key new releases are signed with.
pub(crate) async fn current(conn: &mut SqliteConnection) -> Result<Option<KeyRow>> {
    Ok(sqlx::query(
        "SELECT fingerprint,public_key,custody,state FROM agent_release_keys WHERE state='current'",
    )
    .fetch_optional(&mut *conn)
    .await?
    .map(|row| row_of(&row)))
}
impl KeyRow {
    /// The key as the key rule reads it.
    pub(crate) fn key(&self) -> Result<ReleaseKey> {
        ReleaseKey::parse(&self.public_key).map_err(|error| {
            tracing::error!(%error, fingerprint = %self.fingerprint, "a stored release key is not valid");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                "A stored release key is not valid.",
            )
        })
    }
}

/// Refuses a key the server must never register: its own manifest signing key,
/// its device CA's key, or a key it already holds.
pub(crate) async fn check_unused(
    s: &State,
    conn: &mut SqliteConnection,
    key: &ReleaseKey,
) -> Result<()> {
    if s.keys.identity_public_keys().contains(key.public_bytes()) {
        return Err(in_use());
    }
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_release_keys WHERE fingerprint=?")
            .bind(key.fingerprint())
            .fetch_one(&mut *conn)
            .await?;
    if held > 0 {
        return Err(in_use());
    }
    Ok(())
}

/// Where a key came from.
pub(crate) struct Introduced<'a> {
    pub from: &'a str,
    /// The statement and its signature, each in base64.
    pub statement: &'a str,
    pub signature: &'a str,
}
/// Registers a key as the one that signs new releases. The caller has retired
/// the key it replaces, and sets the setting's `current_key`.
pub(crate) async fn insert_current(
    conn: &mut SqliteConnection,
    key: &ReleaseKey,
    custody: &str,
    actor: &Value,
    now: &str,
    introduced: Option<Introduced<'_>>,
) -> Result<()> {
    sqlx::query("INSERT INTO agent_release_keys(fingerprint,public_key,custody,state,created_at,created_by,created_by_name,introduced_from,introduced_statement,introduced_signature) VALUES(?,?,?,'current',?,?,?,?,?,?)")
        .bind(key.fingerprint())
        .bind(key.line())
        .bind(custody)
        .bind(now)
        .bind(actor["id"].as_str())
        .bind(actor["name"].as_str())
        .bind(introduced.as_ref().map(|i| i.from))
        .bind(introduced.as_ref().map(|i| i.statement))
        .bind(introduced.as_ref().map(|i| i.signature))
        .execute(&mut *conn)
        .await?;
    Ok(())
}
/// Ends a key's turn as the current one.
pub(crate) async fn retire(
    conn: &mut SqliteConnection,
    fingerprint: &str,
    now: &str,
) -> Result<()> {
    sqlx::query("UPDATE agent_release_keys SET state='retired',retired_at=? WHERE fingerprint=? AND state='current'")
        .bind(now)
        .bind(fingerprint)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// A key the server generated and sealed. The sealed file is removed again
/// unless the request that wrote it reaches `keep`, once the key is registered
/// and its transaction has committed.
pub(crate) struct Generated<'a> {
    pub key: ReleaseKey,
    written: Written<'a>,
}
/// Generates a key for the server to hold and writes its sealed seed.
pub(crate) fn generate_and_seal(s: &State) -> Result<Generated<'_>> {
    let (seed, key) = generate_key()?;
    seal_seed(s, key.fingerprint(), &seed)?;
    let written = Written::new(s, key.fingerprint());
    Ok(Generated { key, written })
}
impl Generated<'_> {
    /// The key is registered: its sealed file stays.
    pub(crate) fn keep(&mut self) {
        self.written.keep();
    }
}

// ---------------------------------------------------------------------------
// Reading

/// The non-revoked devices whose latest report lists each fingerprint, and the
/// first names among them.
async fn pinning(conn: &mut SqliteConnection) -> Result<HashMap<String, (i64, Vec<String>)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT k.value,d.name FROM agent_update_reports r JOIN devices d ON d.id=r.device_id, json_each(r.report,'$.keys') k WHERE d.revoked=0 ORDER BY d.name COLLATE NOCASE,d.id",
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut pinned: HashMap<String, (i64, Vec<String>)> = HashMap::new();
    for (key, name) in rows {
        let entry = pinned.entry(key).or_default();
        entry.0 += 1;
        if entry.1.len() < NAMES_LISTED {
            entry.1.push(name);
        }
    }
    Ok(pinned)
}

const COLUMNS: &str = "fingerprint,public_key,custody,state,created_at,created_by_name,retired_at,revoked_at,revoked_reason,introduced_statement,introduced_signature";

fn projection(
    row: &sqlx::sqlite::SqliteRow,
    pinned: &HashMap<String, (i64, Vec<String>)>,
) -> Value {
    let fingerprint: String = row.get("fingerprint");
    let (devices, names) = pinned.get(&fingerprint).cloned().unwrap_or_default();
    let introduced = match (
        row.get::<Option<String>, _>("introduced_statement"),
        row.get::<Option<String>, _>("introduced_signature"),
    ) {
        (Some(statement), Some(signature)) => json!({"statement":statement,"signature":signature}),
        _ => Value::Null,
    };
    json!({
        "fingerprint": fingerprint,
        "public_key": row.get::<String, _>("public_key"),
        "custody": row.get::<String, _>("custody"),
        "state": row.get::<String, _>("state"),
        "created_at": row.get::<String, _>("created_at"),
        "created_by_name": row.get::<Option<String>, _>("created_by_name"),
        "retired_at": row.get::<Option<String>, _>("retired_at"),
        "revoked_at": row.get::<Option<String>, _>("revoked_at"),
        "revoked_reason": row.get::<Option<String>, _>("revoked_reason"),
        "introduced_by": introduced,
        "devices_pinning": devices,
        "device_names": names,
    })
}

/// One key as `AgentReleaseKey`.
pub async fn view(conn: &mut SqliteConnection, fingerprint: &str) -> Result<Value> {
    let pinned = pinning(conn).await?;
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM agent_release_keys WHERE fingerprint=?"
    ))
    .bind(fingerprint)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ApiError::missing)?;
    Ok(projection(&row, &pinned))
}

/// Every key, newest first, at most `MAX_LISTED`.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<Value>> {
    let pinned = pinning(conn).await?;
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM agent_release_keys ORDER BY created_at DESC,rowid DESC LIMIT ?"
    ))
    .bind(MAX_LISTED)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.iter().map(|row| projection(row, &pinned)).collect())
}

/// `GET /api/v1/agent-release-keys`: every signed-in role. This is the only
/// place custody is published: the unauthenticated key bundle has none.
pub async fn get(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut tx = s.pool.begin().await?;
    agent_updates::require_on(&mut tx).await?;
    Ok(Json(json!(list(&mut tx).await?)))
}

// ---------------------------------------------------------------------------
// Rotating, rolling over and revoking

/// The password of a request that needs it.
pub(crate) fn password_of(request: &serde_json::Map<String, Value>) -> Result<String> {
    request
        .get("current_password")
        .and_then(Value::as_str)
        .filter(|password| !password.is_empty() && password.len() <= 256)
        .map(str::to_owned)
        .ok_or_else(|| ApiError::invalid("current_password is required"))
}

/// `POST /api/v1/agent-release-keys/rotate {current_password}`: with server
/// custody, the server generates the successor, signs a rollover statement from
/// the current key to it with the current key, makes the successor current and
/// retires the old key, whose sealed seed is removed once this commits.
pub async fn rotate(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    let request = agent_updates::body(&bytes, &["current_password"])?;
    let password = password_of(&request)?;
    let (_, hash) = reauthenticate(&s, &h, &["admin"], &password).await?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    agent_updates::require_on(&mut tx).await?;
    let old = current(&mut tx).await?.ok_or_else(custody_required)?;
    if old.custody != "server" {
        return Err(ApiError::conflict(
            "This key is held offline: sign a rollover statement with it and upload that instead.",
        ));
    }
    let from = unseal_seed(&s, &old.fingerprint)?;
    let mut next = generate_and_seal(&s)?;
    check_unused(&s, &mut tx, &next.key).await?;
    let now = Utc::now();
    let statement = agent_release::build_statement(&old.fingerprint, &next.key, now.timestamp())
        .map_err(|_| ApiError::conflict("The rollover statement couldn't be built."))?;
    let signature = agent_release::sign_rollover(from.bytes(), &statement)
        .map_err(|_| ApiError::conflict("The rollover statement couldn't be signed."))?;
    let envelope = RolloverEnvelope::new(&statement, &signature);
    let at = instant(now);
    retire(&mut tx, &old.fingerprint, &at).await?;
    insert_current(
        &mut tx,
        &next.key,
        "server",
        &actor,
        &at,
        Some(Introduced {
            from: &old.fingerprint,
            statement: &envelope.statement,
            signature: &envelope.signature,
        }),
    )
    .await?;
    switch_current(&mut tx, next.key.fingerprint(), None).await?;
    agent_updates::advance(&mut tx).await?;
    agent_updates::audit(
        &mut tx,
        actor["id"].as_str().unwrap_or(""),
        "agent_release_key.rotate",
        next.key.fingerprint(),
        "success",
        json!({"fingerprint":next.key.fingerprint(),"from_fingerprint":old.fingerprint,"source":"server"}),
    )
    .await?;
    let out = view(&mut tx, next.key.fingerprint()).await?;
    tx.commit().await?;
    next.keep();
    wipe_seed(&s, &old.fingerprint);
    Ok(Json(out))
}

/// Makes `fingerprint` the setting's current key, optionally changing its
/// custody too. The caller advances the revision.
pub(crate) async fn switch_current(
    conn: &mut SqliteConnection,
    fingerprint: &str,
    custody: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE agent_update_settings SET current_key=?,custody=COALESCE(?,custody) WHERE id=1",
    )
    .bind(fingerprint)
    .bind(custody)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `POST /api/v1/agent-release-keys/rollover {statement,signature,current_password}`:
/// with offline custody, the team rotates its key within its custody by
/// uploading the statement the current key signed. The successor becomes
/// current and custody stays offline.
pub async fn rollover(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    let request = agent_updates::body(&bytes, &["statement", "signature", "current_password"])?;
    let password = password_of(&request)?;
    let text = |name: &str| {
        request
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::invalid(format!("{name} is required")))
    };
    let (statement, signature) = (text("statement")?, text("signature")?);
    let rollover =
        agent_release::Rollover::from_base64(statement, signature).map_err(
            |error| match error {
                RolloverError::Malformed(reason) => {
                    ApiError::invalid(format!("The rollover statement is malformed: {reason}."))
                }
                RolloverError::KeyInvalid(reason) => invalid_key(&reason),
            },
        )?;
    let (_, hash) = reauthenticate(&s, &h, &["admin"], &password).await?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    agent_updates::require_on(&mut tx).await?;
    let old = current(&mut tx).await?.ok_or_else(custody_required)?;
    if old.custody != "offline" {
        return Err(ApiError::conflict(
            "This key is held by the server: rotate it instead of uploading a statement.",
        ));
    }
    if rollover.statement.from != old.fingerprint {
        return Err(ApiError::conflict(
            "The statement replaces a key that isn't the current release key.",
        ));
    }
    if !rollover.verify(&old.key()?) {
        return Err(invalid_signature());
    }
    let next = &rollover.statement.to;
    check_unused(&s, &mut tx, next).await?;
    let at = instant(Utc::now());
    let envelope = rollover.envelope();
    retire(&mut tx, &old.fingerprint, &at).await?;
    insert_current(
        &mut tx,
        next,
        "offline",
        &actor,
        &at,
        Some(Introduced {
            from: &old.fingerprint,
            statement: &envelope.statement,
            signature: &envelope.signature,
        }),
    )
    .await?;
    switch_current(&mut tx, next.fingerprint(), None).await?;
    agent_updates::advance(&mut tx).await?;
    agent_updates::audit(
        &mut tx,
        actor["id"].as_str().unwrap_or(""),
        "agent_release_key.rollover",
        next.fingerprint(),
        "success",
        json!({"fingerprint":next.fingerprint(),"from_fingerprint":old.fingerprint,"source":"upload"}),
    )
    .await?;
    let out = view(&mut tx, next.fingerprint()).await?;
    tx.commit().await?;
    Ok(Json(out))
}

/// `POST /api/v1/agent-release-keys/{fingerprint}/revoke {reason,current_password}`:
/// the key stops being trusted by this server. In one transaction the releases
/// it signed are withdrawn, the rollouts that offer them end, and the key and
/// the statements it signed leave the key bundle. Revoking the current key
/// leaves no current key.
pub async fn revoke(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(fingerprint): Path<String>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    agent_updates::guard(&s).await?;
    if !agent_updates::fingerprint(&fingerprint) {
        return Err(ApiError::invalid("The key is named by its fingerprint"));
    }
    let request = agent_updates::body(&bytes, &["reason", "current_password"])?;
    let reason = agent_updates::reason(request.get("reason").unwrap_or(&Value::Null))?;
    let password = password_of(&request)?;
    let (_, hash) = reauthenticate(&s, &h, &["admin"], &password).await?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = recheck(&mut tx, &h, &["admin"], &hash).await?;
    agent_updates::require_on(&mut tx).await?;
    let key = row(&mut tx, &fingerprint)
        .await?
        .ok_or_else(ApiError::missing)?;
    if key.state == "revoked" {
        return Err(ApiError::conflict("This key is already revoked."));
    }
    let at = instant(Utc::now());
    let actor_id = actor["id"].as_str().unwrap_or("");
    sqlx::query("UPDATE agent_release_keys SET state='revoked',revoked_at=?,revoked_by=?,revoked_reason=? WHERE fingerprint=?")
        .bind(&at)
        .bind(actor_id)
        .bind(&reason)
        .bind(&fingerprint)
        .execute(&mut *tx)
        .await?;
    if key.state == "current" {
        sqlx::query("UPDATE agent_update_settings SET current_key=NULL WHERE id=1")
            .execute(&mut *tx)
            .await?;
        agent_updates::advance(&mut tx).await?;
    }
    // What the key signed is withdrawn, and what offers it ends.
    let withdrawn = crate::agent_releases::withdraw_signed_by(
        &mut tx,
        &fingerprint,
        actor_id,
        &at,
        "The key that signed it was revoked",
    )
    .await?;
    let mut cancelled_rollouts = 0;
    let mut asked = Vec::new();
    for release in &withdrawn {
        let ended =
            crate::agent_update_rollouts::cancel_release(&mut tx, release, "key_revoked", &at)
                .await?;
        cancelled_rollouts += ended.rollouts.len();
        asked.extend(ended.devices);
    }
    agent_updates::audit(
        &mut tx,
        actor_id,
        "agent_release_key.revoke",
        &fingerprint,
        "success",
        json!({"fingerprint":fingerprint,"reason":reason,"withdrawn_releases":withdrawn.len(),"cancelled_rollouts":cancelled_rollouts}),
    )
    .await?;
    let freed = crate::agent_releases::release_files(&mut tx).await?;
    let out = view(&mut tx, &fingerprint).await?;
    tx.commit().await?;
    crate::agent_releases::remove_files(&s, &freed);
    // A key that is revoked has no use for its private half.
    if key.custody == "server" {
        wipe_seed(&s, &fingerprint);
    }
    for device in &asked {
        crate::wake::ask(device);
    }
    Ok(Json(out))
}

/// Removes the sealed file of every key that is not the current key of the
/// server's custody: a file left by a request that did not finish, or by a
/// rotation or a revocation whose removal failed. It runs in the prune, under
/// the writer lock, so a file that is being registered is never in its way.
pub(crate) async fn prune_sealed(s: &State, conn: &mut SqliteConnection) -> Result<()> {
    let Ok(entries) = std::fs::read_dir(s.settings.data_dir.join("keys")) else {
        return Ok(());
    };
    let owned: std::collections::BTreeSet<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM agent_release_keys WHERE custody='server' AND state='current'",
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(fingerprint) = name
            .strip_prefix("agent-release-")
            .and_then(|rest| rest.strip_suffix(".sealed"))
        else {
            continue;
        };
        if !owned.contains(fingerprint) {
            wipe_seed(s, fingerprint);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The key bundle

/// `GET /agent/v1/release-keys`: every key that is not revoked and every
/// rollover statement among them, public, no client certificate. A host's
/// setup pins the entry whose fingerprint the operator gave. It carries no
/// custody: whether a server compromise alone would be enough to sign a release
/// is not for an unauthenticated peer to learn.
pub async fn bundle(
    AppState(s): AppState<State>,
    crate::ClientAddress(peer): crate::ClientAddress,
) -> Result<Json<Value>> {
    crate::install::public_limits(&s, "agent-release-keys", peer)?;
    let mut tx = s.pool.begin().await?;
    if !agent_updates::enabled(&mut tx).await? {
        return Err(agent_updates::off_public());
    }
    let rows = sqlx::query("SELECT rowid AS position,fingerprint,public_key,state,introduced_from,introduced_statement,introduced_signature FROM agent_release_keys WHERE state<>'revoked' ORDER BY state='current' DESC,rowid DESC LIMIT ?")
        .bind(MAX_LISTED)
        .fetch_all(&mut *tx)
        .await?;
    // Every entry is checked the way setup checks it, so a bundle that setup
    // would refuse is never served.
    struct Listed {
        position: i64,
        fingerprint: String,
        entry: Value,
        introduced: Option<(String, Value)>,
    }
    let mut keys: Vec<Listed> = Vec::new();
    for row in &rows {
        let (fingerprint, line): (String, String) = (row.get("fingerprint"), row.get("public_key"));
        if agent_release::bundle_entry_matches(&line, &fingerprint).is_err() {
            tracing::error!(%fingerprint, "a stored release key is not served: it does not match its fingerprint");
            continue;
        }
        let introduced = match (
            row.get::<Option<String>, _>("introduced_from"),
            row.get::<Option<String>, _>("introduced_statement"),
            row.get::<Option<String>, _>("introduced_signature"),
        ) {
            (Some(from), Some(statement), Some(signature)) => {
                Some((from, json!({"statement":statement,"signature":signature})))
            }
            _ => None,
        };
        keys.push(Listed {
            position: row.get("position"),
            entry: json!({"public_key":line,"fingerprint":fingerprint,"state":row.get::<String, _>("state")}),
            fingerprint,
            introduced,
        });
    }
    // The oldest keys leave first when the bundle would outgrow its bound.
    loop {
        let listed: std::collections::BTreeSet<&str> =
            keys.iter().map(|key| key.fingerprint.as_str()).collect();
        // The statements among the keys listed, in the order the keys followed
        // one another.
        let mut statements: Vec<(i64, &Value)> = keys
            .iter()
            .filter_map(|key| {
                let (from, envelope) = key.introduced.as_ref()?;
                listed
                    .contains(from.as_str())
                    .then_some((key.position, envelope))
            })
            .collect();
        statements.sort_by_key(|(position, _)| *position);
        let body = json!({
            "schema": "vectory.release-keys.v1",
            "keys": keys.iter().map(|key| &key.entry).collect::<Vec<_>>(),
            "rollovers": statements.iter().map(|(_, envelope)| envelope).collect::<Vec<_>>(),
        });
        if body.to_string().len() <= BUNDLE_BYTES || keys.len() <= 1 {
            return Ok(Json(body));
        }
        keys.pop();
    }
}
