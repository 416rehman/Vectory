//! Update rollouts: an agent build released to a reviewed set of devices, a
//! canary first, then batches, with an observation period after each stage and
//! a failure threshold that stops the rollout.
//!
//! An update rollout is its own object with its own tables. It never touches
//! deployments, desired generations, policy generations or deployment targets,
//! so a pipeline rollout and an update rollout cannot gate, supersede or roll
//! back each other. It targets a fixed set of at most 10,000 devices that the
//! review resolved, and it counts a device as updated only from the server's own
//! observation of the new build (`engine`).
use crate::{
    State, agent_releases,
    agent_updates::{self, RolloutSettings, instant, review},
    auth, canary_choice, db,
    error::{ApiError, Result},
    rollout,
};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row as _, SqliteConnection};
use std::collections::BTreeSet;

pub mod detail;
pub mod engine;
pub use engine::{
    Cancelled, cancel_all, cancel_release, cancel_rollout, device_revoked, observe, tick,
};

/// Devices one rollout targets.
pub const MAX_TARGETS: usize = 10_000;
/// The fourteen states of a target.
pub const STATES: [&str; 14] = [
    "pending",
    "offered",
    "downloading",
    "staged",
    "waiting_for_host",
    "waiting_for_window",
    "applying",
    "restarted",
    "verified",
    "rolled_back",
    "refused",
    "failed",
    "cancelled",
    "skipped",
];
const STATUSES: [&str; 5] = ["active", "paused", "completed", "cancelled", "failed"];

// ---------------------------------------------------------------------------
// Errors

fn overlap() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "UPDATE_ROLLOUT_OVERLAP",
        "Some of these devices are already in an update rollout that hasn't ended. Review again to see which.",
    )
}
fn not_ready() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "RELEASE_NOT_READY",
        "This release isn't ready to roll out: it is awaiting its signature, withdrawn or expired.",
    )
}
fn nothing() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "NOTHING_TO_UPDATE",
        "No device in this review will update. Fix what the review lists, then review again.",
    )
}
fn changed() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "UPDATE_REVIEW_CHANGED",
        "The review changed since you made it. Review the update rollout again before you start it.",
    )
}
fn conflicting_request() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
        "This request ID already belongs to a different update rollout request. Use a new request ID for a different rollout.",
    )
}

// ---------------------------------------------------------------------------
// A rollout

/// A stored rollout.
pub struct Row {
    pub id: String,
    pub name: Option<String>,
    pub release_id: String,
    pub selector: Value,
    pub settings: RolloutSettings,
    pub status: String,
    pub failure_reason: Option<String>,
    pub cancel_reason: Option<String>,
    pub observation_started_at: Option<String>,
    pub observation_evidence: Option<String>,
    /// When the rollout last made progress of its own: it resumed, released a
    /// stage, or an observation started or ended. Null until then.
    pub progressed_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub created_by_name: Option<String>,
    pub paused_at: Option<String>,
    pub completed_at: Option<String>,
    pub failed_at: Option<String>,
    pub cancelled_at: Option<String>,
}
const COLUMNS: &str = "id,name,release_id,selector,canary_device_ids,canary_size,batch_size,observation_seconds,failure_threshold,status,failure_reason,cancel_reason,observation_started_at,observation_evidence,progressed_at,revision,created_at,created_by_name,paused_at,completed_at,failed_at,cancelled_at";
fn row_of(row: &sqlx::sqlite::SqliteRow) -> Result<Row> {
    let named: Vec<String> =
        serde_json::from_str(&row.get::<String, _>("canary_device_ids")).unwrap_or_default();
    Ok(Row {
        id: row.get("id"),
        name: row.get("name"),
        release_id: row.get("release_id"),
        selector: db::parse(&row.get::<String, _>("selector"))?,
        settings: RolloutSettings {
            canary_size: row.get("canary_size"),
            batch_size: row.get("batch_size"),
            observation_seconds: row.get("observation_seconds"),
            failure_threshold: row.get("failure_threshold"),
            canary_device_ids: named,
        },
        status: row.get("status"),
        failure_reason: row.get("failure_reason"),
        cancel_reason: row.get("cancel_reason"),
        observation_started_at: row.get("observation_started_at"),
        observation_evidence: row.get("observation_evidence"),
        progressed_at: row.get("progressed_at"),
        revision: row.get("revision"),
        created_at: row.get("created_at"),
        created_by_name: row.get("created_by_name"),
        paused_at: row.get("paused_at"),
        completed_at: row.get("completed_at"),
        failed_at: row.get("failed_at"),
        cancelled_at: row.get("cancelled_at"),
    })
}
/// One rollout by ID; `404 NOT_FOUND` when there is none.
pub async fn load(conn: &mut SqliteConnection, id: &str) -> Result<Row> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM agent_update_rollouts WHERE id=?"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ApiError::missing)?;
    row_of(&row)
}
/// Every active rollout, oldest first: what a scheduler step advances.
pub async fn active(conn: &mut SqliteConnection) -> Result<Vec<Row>> {
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM agent_update_rollouts WHERE status='active' ORDER BY created_at,id"
    ))
    .fetch_all(&mut *conn)
    .await?;
    rows.iter().map(row_of).collect()
}

/// `{id,version,counter,manifest_sha256}` of a release.
async fn release_brief(conn: &mut SqliteConnection, id: &str) -> Result<Value> {
    let row =
        sqlx::query("SELECT id,version,counter,manifest_sha256 FROM agent_releases WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .ok_or_else(ApiError::missing)?;
    Ok(json!({
        "id": row.get::<String, _>("id"),
        "version": row.get::<String, _>("version"),
        "counter": row.get::<i64, _>("counter"),
        "manifest_sha256": row.get::<String, _>("manifest_sha256"),
    }))
}

/// `AgentUpdateRollout`.
pub async fn view(conn: &mut SqliteConnection, row: &Row) -> Result<Value> {
    let counts = engine::counts(conn, &row.id).await?;
    let mut state_counts = serde_json::Map::new();
    for state in STATES {
        state_counts.insert(
            state.to_owned(),
            json!(counts.get(state).copied().unwrap_or(0)),
        );
    }
    let degraded = if counts.get("verified").copied().unwrap_or(0) > 0 {
        engine::degraded(conn, row).await?
    } else {
        0
    };
    Ok(json!({
        "id": row.id,
        "name": row.name,
        "release": release_brief(conn, &row.release_id).await?,
        "selector": row.selector,
        "rollout": row.settings.view(),
        "status": row.status,
        "failure_reason": row.failure_reason,
        "cancel_reason": row.cancel_reason,
        "revision": row.revision,
        "created_at": row.created_at,
        "created_by_name": row.created_by_name,
        "paused_at": row.paused_at,
        "completed_at": row.completed_at,
        "failed_at": row.failed_at,
        "cancelled_at": row.cancelled_at,
        "observation_started_at": row.observation_started_at,
        "target_count": counts.values().sum::<i64>(),
        "state_counts": state_counts,
        "degraded": degraded,
    }))
}

// ---------------------------------------------------------------------------
// Reading

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    search: Option<String>,
    status: Option<String>,
    release_id: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}

/// `GET /api/v1/agent-update-rollouts`: newest first, any signed-in role.
pub async fn list(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    agent_updates::guard(&s).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (search, page, size, offset) =
        crate::deployment_history::bounds(input.search.as_deref(), input.page, input.page_size)?;
    let status = match input.status.as_deref() {
        None => None,
        Some(status) if STATUSES.contains(&status) => Some(status),
        Some(_) => {
            return Err(ApiError::invalid(
                "status must be active, paused, completed, cancelled or failed",
            ));
        }
    };
    let release = match input.release_id.as_deref() {
        None => None,
        Some(id) => Some(
            uuid::Uuid::parse_str(id)
                .ok()
                .map(|parsed| parsed.hyphenated().to_string())
                .filter(|parsed| parsed == id)
                .ok_or_else(|| ApiError::invalid("release_id must be a lowercase UUID"))?,
        ),
    };
    let needle = search.to_ascii_lowercase();
    let mut tx = s.pool.begin().await?;
    agent_updates::require_on(&mut tx).await?;
    let filter = "FROM agent_update_rollouts r JOIN agent_releases rel ON rel.id=r.release_id WHERE (?1='' OR instr(lower(COALESCE(r.name,'')),?1)>0 OR instr(rel.version,?1)>0) AND (?2 IS NULL OR r.status=?2) AND (?3 IS NULL OR r.release_id=?3)";
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) {filter}"))
        .bind(&needle)
        .bind(status)
        .bind(release.as_deref())
        .fetch_one(&mut *tx)
        .await?;
    let ids: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT r.id {filter} ORDER BY r.created_at DESC,r.id LIMIT ?4 OFFSET ?5"
    ))
    .bind(&needle)
    .bind(status)
    .bind(release.as_deref())
    .bind(size)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    let mut items = Vec::with_capacity(ids.len());
    for id in &ids {
        let row = load(&mut tx, id).await?;
        items.push(view(&mut tx, &row).await?);
    }
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

// ---------------------------------------------------------------------------
// The review and creation

/// The members the review and creation bodies share, checked before anything
/// is read.
struct Request {
    release_id: String,
    selector: Value,
    rollout: Value,
}
fn lowercase_uuid(value: &Value, label: &str) -> Result<String> {
    value
        .as_str()
        .and_then(|id| uuid::Uuid::parse_str(id).ok().map(|parsed| (id, parsed)))
        .filter(|(id, parsed)| parsed.hyphenated().to_string() == *id)
        .map(|(id, _)| id.to_owned())
        .ok_or_else(|| ApiError::invalid(format!("{label} must be a lowercase UUID")))
}
fn request_of(body: &serde_json::Map<String, Value>) -> Result<Request> {
    let selector = body
        .get("selector")
        .filter(|selector| selector.is_object())
        .ok_or_else(|| ApiError::invalid("selector must be an object"))?;
    // Only the three lists mean anything; the stored selector holds only them.
    let lists = ["device_ids", "group_ids", "exclude_ids"];
    if let Some(unknown) = selector
        .as_object()
        .and_then(|fields| fields.keys().find(|key| !lists.contains(&key.as_str())))
    {
        return Err(ApiError::invalid(format!(
            "Unknown selector member {unknown}"
        )));
    }
    Ok(Request {
        release_id: lowercase_uuid(body.get("release_id").unwrap_or(&Value::Null), "release_id")?,
        selector: json!({
            "device_ids": selector["device_ids"],
            "group_ids": selector["group_ids"],
            "exclude_ids": selector["exclude_ids"],
        }),
        rollout: body
            .get("rollout")
            .filter(|rollout| rollout.is_object())
            .cloned()
            .ok_or_else(|| ApiError::invalid("rollout must be an object"))?,
    })
}

/// The devices a request targets and the review of them. The selector resolves
/// as it does for deployments (`rollout::select`), so one that names an unknown
/// or revoked device is refused instead of reviewed: `DEVICE_REVOKED` is what
/// the stages find when a target's device is revoked after the rollout began.
async fn reviewed(
    conn: &mut SqliteConnection,
    release: &agent_releases::Release,
    request: &Request,
) -> Result<(RolloutSettings, BTreeSet<String>, review::Review)> {
    let settings = RolloutSettings::parse(&request.rollout)?;
    let selected = rollout::select(conn, &request.selector).await?;
    if selected.len() > MAX_TARGETS {
        return Err(ApiError::invalid(
            "An update rollout targets at most 10,000 devices",
        ));
    }
    canary_choice::check_members(
        &json!({"canary_device_ids":settings.canary_device_ids}),
        &selected,
    )?;
    let review = review::review(conn, release, &selected, &settings).await?;
    Ok((settings, selected, review))
}

/// The canary of a review: how many devices go first, whether the request named
/// them, and which they are, in release order.
async fn canary(
    conn: &mut SqliteConnection,
    settings: &RolloutSettings,
    review: &review::Review,
) -> Result<Value> {
    let will: Vec<&agent_updates::Facts> = review.will_update.iter().collect();
    let ranked = engine::canary_order(conn, &will).await?;
    let size = usize::try_from(settings.canary_size).unwrap_or(1);
    let picked = canary_choice::pick(&settings.canary_device_ids, &ranked, size);
    Ok(json!({
        "size": picked.len(),
        "chosen_by_you": !settings.canary_device_ids.is_empty(),
        "device_ids": picked,
    }))
}

/// `POST /api/v1/agent-update-rollouts/preview {release_id,selector,rollout}`:
/// who will update and who will not, and why. It writes nothing.
pub async fn preview(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    agent_updates::guard(&s).await?;
    let body = agent_updates::body(&bytes, &["release_id", "selector", "rollout"])?;
    let request = request_of(&body)?;
    let mut tx = s.pool.begin().await?;
    auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    agent_updates::require_on(&mut tx).await?;
    let release = agent_releases::load(&mut tx, &request.release_id).await?;
    if !release.offerable(&db::now()) {
        return Err(not_ready());
    }
    let (settings, _, review) = reviewed(&mut tx, &release, &request).await?;
    let canary = canary(&mut tx, &settings, &review).await?;
    Ok(Json(review::view(&release, &review, canary)))
}

fn payload_digest(body: &serde_json::Map<String, Value>) -> String {
    let mut payload = body.clone();
    payload.remove("request_id");
    db::hash(format!(
        "vectory-agent-update-rollout-create-v1\n{}",
        crate::deployment_requests::canonical(&Value::Object(payload))
    ))
}
/// A rollout a retry names, when its request ID already made one.
async fn replay(
    conn: &mut SqliteConnection,
    actor: &str,
    request_id: &str,
    digest: &str,
) -> Result<Option<Value>> {
    let prior: Option<(String, String)> = sqlx::query_as(
        "SELECT payload_sha256,rollout_id FROM agent_update_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor)
    .bind(request_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((prior_digest, id)) = prior else {
        // The request IDs of this actor are one namespace across deployment
        // operations and update rollouts.
        let used: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM deployment_requests WHERE actor_id=? AND request_id=?",
        )
        .bind(actor)
        .bind(request_id)
        .fetch_one(&mut *conn)
        .await?;
        if used > 0 {
            return Err(conflicting_request());
        }
        return Ok(None);
    };
    if prior_digest != digest {
        return Err(conflicting_request());
    }
    let row = load(conn, &id).await?;
    let mut out = view(conn, &row).await?;
    out["request_id"] = json!(request_id);
    Ok(Some(out))
}

/// `POST /api/v1/agent-update-rollouts`: start the rollout a review described.
pub async fn create(
    AppState(s): AppState<State>,
    h: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    agent_updates::guard(&s).await?;
    let body = agent_updates::body(
        &bytes,
        &[
            "release_id",
            "selector",
            "rollout",
            "name",
            "review_token",
            "request_id",
        ],
    )?;
    let request = request_of(&body)?;
    let token = body
        .get("review_token")
        .and_then(Value::as_str)
        .filter(|token| agent_updates::fingerprint(token))
        .ok_or_else(|| ApiError::invalid("review_token must be the token of a review"))?
        .to_owned();
    let name = match body.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) if (1..=120).contains(&name.chars().count()) => {
            db::refuse_hostile(name, "a name")?;
            Some(name.clone())
        }
        Some(_) => {
            return Err(ApiError::invalid(
                "name must be null or 1 to 120 characters",
            ));
        }
    };
    let key = match body.get("request_id") {
        None => None,
        Some(id) => Some(lowercase_uuid(id, "request_id")?),
    };
    let digest = payload_digest(&body);
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let actor_id = actor["id"].as_str().unwrap_or("").to_owned();
    let setting = agent_updates::require_on(&mut tx).await?;
    if let Some(key) = &key
        && let Some(original) = replay(&mut tx, &actor_id, key, &digest).await?
    {
        return Ok(Json(original));
    }
    if setting.stopped.is_some() {
        return Err(agent_updates::stopped());
    }
    let release = agent_releases::load(&mut tx, &request.release_id).await?;
    let now = db::now();
    if !release.offerable(&now) {
        return Err(not_ready());
    }
    let (settings, selected, review) = reviewed(&mut tx, &release, &request).await?;
    if review.token != token {
        // A review that differs only by devices another update rollout took
        // since is a rollout that overlaps this one.
        let without =
            review::review_ignoring_other_rollouts(&mut tx, &release, &selected, &settings).await?;
        return Err(if without.token == token {
            overlap()
        } else {
            changed()
        });
    }
    if review.will_update.is_empty() {
        return Err(nothing());
    }
    let id = db::id();
    sqlx::query("INSERT INTO agent_update_rollouts(id,name,release_id,selector,canary_device_ids,canary_size,batch_size,observation_seconds,failure_threshold,status,created_at,created_by,created_by_name) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?)")
        .bind(&id)
        .bind(name.as_deref())
        .bind(&release.id)
        .bind(request.selector.to_string())
        .bind(json!(settings.canary_device_ids).to_string())
        .bind(settings.canary_size)
        .bind(settings.batch_size)
        .bind(settings.observation_seconds)
        .bind(settings.failure_threshold)
        .bind(&now)
        .bind(&actor_id)
        .bind(actor["name"].as_str())
        .execute(&mut *tx)
        .await?;
    let ids: Vec<&str> = review
        .will_update
        .iter()
        .map(|device| device.id.as_str())
        .collect();
    sqlx::query("INSERT INTO agent_update_targets(rollout_id,device_id,device_name,state,created_at,updated_at) SELECT ?,d.id,d.name,'pending',?,? FROM devices d WHERE d.id IN (SELECT value FROM json_each(?))")
        .bind(&id)
        .bind(&now)
        .bind(&now)
        .bind(json!(ids).to_string())
        .execute(&mut *tx)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(failure) if failure.is_unique_violation() => overlap(),
            _ => error.into(),
        })?;
    if let Some(key) = &key {
        sqlx::query("INSERT INTO agent_update_requests(actor_id,request_id,payload_sha256,rollout_id,created_at) VALUES(?,?,?,?,?)")
            .bind(&actor_id)
            .bind(key)
            .bind(&digest)
            .bind(&id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
    }
    agent_updates::audit(
        &mut tx,
        &actor_id,
        "agent_update_rollout.create",
        &id,
        "success",
        json!({"release_id":release.id,"version":release.version,"counter":release.counter,"manifest_sha256":release.manifest_sha256}),
    )
    .await?;
    let row = load(&mut tx, &id).await?;
    let mut out = view(&mut tx, &row).await?;
    if let Some(key) = &key {
        out["request_id"] = json!(key);
    }
    tx.commit().await?;
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// Pause, resume, cancel

/// What a transition takes: nothing. An empty body, or `{}`.
fn empty(bytes: &Bytes) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }
    agent_updates::body(bytes, &[]).map(|_| ())
}

#[derive(Clone, Copy)]
enum Transition {
    Pause,
    Resume,
    Cancel,
}
async fn transition(
    s: State,
    h: HeaderMap,
    id: String,
    bytes: Bytes,
    how: Transition,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    agent_updates::guard(&s).await?;
    empty(&bytes)?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    agent_updates::require_on(&mut tx).await?;
    let row = load(&mut tx, &id).await?;
    let now = instant(Utc::now());
    let (action, held) = match how {
        Transition::Pause => {
            if row.status != "active" {
                return Err(ApiError::conflict(
                    "Only an active update rollout can be paused.",
                ));
            }
            (
                "agent_update_rollout.pause",
                engine::pause_rollout(&mut tx, &id, &now).await?,
            )
        }
        Transition::Resume => {
            if row.status != "paused" {
                return Err(ApiError::conflict(
                    "Only a paused update rollout can be resumed.",
                ));
            }
            sqlx::query("UPDATE agent_update_rollouts SET status='active',paused_at=NULL,observation_started_at=NULL,observation_evidence=NULL,progressed_at=?,revision=revision+1 WHERE id=?")
                .bind(&now)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            ("agent_update_rollout.resume", Vec::new())
        }
        Transition::Cancel => {
            if !matches!(row.status.as_str(), "active" | "paused") {
                return Err(ApiError::conflict(
                    "An update rollout that has ended can't be cancelled.",
                ));
            }
            (
                "agent_update_rollout.cancel",
                engine::cancel_rollout(&mut tx, &id, "operator", &now).await?,
            )
        }
    };
    agent_updates::audit(
        &mut tx,
        actor["id"].as_str().unwrap_or(""),
        action,
        &id,
        "success",
        json!({}),
    )
    .await?;
    let row = load(&mut tx, &id).await?;
    let out = view(&mut tx, &row).await?;
    tx.commit().await?;
    // The devices that held an offer learn of its withdrawal in seconds.
    for device in &held {
        crate::wake::ask(device);
    }
    Ok(Json(out))
}
/// `POST /api/v1/agent-update-rollouts/{id}/pause`.
pub async fn pause(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    transition(s, h, id, bytes, Transition::Pause).await
}
/// `POST /api/v1/agent-update-rollouts/{id}/resume`.
pub async fn resume(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    transition(s, h, id, bytes, Transition::Resume).await
}
/// `POST /api/v1/agent-update-rollouts/{id}/cancel`.
pub async fn cancel(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    bytes: Bytes,
) -> Result<Json<Value>> {
    transition(s, h, id, bytes, Transition::Cancel).await
}
