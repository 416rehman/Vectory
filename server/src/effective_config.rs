//! The configuration each device was offered, read-only.
//!
//! `GET /devices/{id}/configuration` answers what a device was offered at its
//! current (or an earlier) desired generation: the artifact exactly as stored
//! in `artifact_blobs`, so a device secret is still a `vectory-secret:NAME`
//! reference (the server never sees what a host resolves it to), the values
//! the version's variables took for this device, and whether what the agent
//! last reported running is that artifact. `GET .../configuration/diff`
//! compares two offered generations as a bounded unified diff. Both read one
//! SQLite snapshot, take no writer lock, write nothing and add no audit row.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
    variables,
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeSet, HashMap};

const MAX_GENERATION: i64 = 9_007_199_254_740_991;
/// Offered generations a read lists, newest first.
const LISTED_GENERATIONS: i64 = 50;
/// Lines of one diff, its headers and the truncation marker included.
pub const MAX_DIFF_LINES: usize = 2_000;

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationQuery {
    generation: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiffQuery {
    from: Option<String>,
    to: Option<String>,
}

/// A generation is a positive whole number, written without a sign or a
/// leading zero.
fn generation(text: &str) -> Result<i64> {
    let plain = !text.is_empty()
        && text.len() <= 16
        && !text.starts_with('0')
        && text.bytes().all(|b| b.is_ascii_digit());
    text.parse::<i64>()
        .ok()
        .filter(|n| plain && *n <= MAX_GENERATION)
        .ok_or_else(|| ApiError::invalid("A generation is a positive whole number"))
}

/// Reads a minute, per account. A page reads once per generation chosen, so a
/// person never comes near these; a script that loops does.
const READS_PER_MINUTE: u32 = 240;
/// Comparisons a minute, per account: each one is bounded work, but work.
const DIFFS_PER_MINUTE: u32 = 60;

fn throttled(s: &State, user: &Value, route: &str, maximum: u32) -> Result<()> {
    s.limit(
        format!("{route}:{}", user["id"].as_str().unwrap_or("")),
        maximum,
        std::time::Duration::from_secs(60),
    )
}

fn never_offered() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "This device was never offered that generation",
    )
}

fn nothing_offered() -> ApiError {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        "Nothing is offered to this device now",
    )
}

/// A stored artifact that cannot be read back is a server fault, never a
/// statement about the device.
fn unreadable<E>(_: E) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL",
        "The stored configuration could not be read",
    )
}

fn digest(value: Option<String>) -> Option<String> {
    value.filter(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// What a read needs of the device row. The agent's report is read out of its
/// record with `json_extract`, not by parsing the whole record.
struct Device {
    revoked: bool,
    version_id: Option<String>,
    generation: i64,
    actual: Option<String>,
    template: Option<String>,
    verified: Option<String>,
    last_seen: Option<String>,
}

async fn device(tx: &mut SqliteConnection, id: &str) -> Result<Device> {
    let text = |key: &str| {
        format!("CASE WHEN json_type(data,'$.{key}')='text' THEN json_extract(data,'$.{key}') END")
    };
    let row = sqlx::query(&format!(
        "SELECT revoked,desired_version_id,desired_generation,{} AS actual,{} AS template,{} AS verified,{} AS last_seen FROM devices WHERE id=?",
        text("actual_sha256"),
        text("applied_template_sha256"),
        text("verified_effective_sha256"),
        text("last_seen"),
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::missing)?;
    Ok(Device {
        revoked: row.get("revoked"),
        version_id: row.get("desired_version_id"),
        generation: row.get("desired_generation"),
        actual: digest(row.get("actual")),
        template: digest(row.get("template")),
        verified: digest(row.get("verified")),
        last_seen: row.get("last_seen"),
    })
}

/// One row of `desired_artifacts`: which bytes the device was offered.
struct Stored {
    generation: i64,
    version_id: String,
    sha256: String,
    offered_at: String,
}

fn stored_row(row: sqlx::sqlite::SqliteRow) -> Stored {
    Stored {
        generation: row.get("generation"),
        version_id: row.get("version_id"),
        sha256: row.get("sha256"),
        offered_at: row.get("created_at"),
    }
}

const STORED: &str =
    "SELECT generation,version_id,sha256,created_at FROM desired_artifacts WHERE device_id=?";

async fn stored_at(tx: &mut SqliteConnection, id: &str, generation: i64) -> Result<Option<Stored>> {
    Ok(sqlx::query(&format!("{STORED} AND generation=?"))
        .bind(id)
        .bind(generation)
        .fetch_optional(&mut *tx)
        .await?
        .map(stored_row))
}

async fn stored_before(
    tx: &mut SqliteConnection,
    id: &str,
    generation: i64,
) -> Result<Option<Stored>> {
    Ok(sqlx::query(&format!(
        "{STORED} AND generation<? ORDER BY generation DESC LIMIT 1"
    ))
    .bind(id)
    .bind(generation)
    .fetch_optional(&mut *tx)
    .await?
    .map(stored_row))
}

/// The newest generation whose offered bytes have this digest.
async fn newest_with(tx: &mut SqliteConnection, id: &str, sha256: &str) -> Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(generation) FROM desired_artifacts WHERE device_id=? AND sha256=?",
    )
    .bind(id)
    .bind(sha256)
    .fetch_one(&mut *tx)
    .await?)
}

/// What the device was offered at one generation, bytes included.
struct Offer {
    generation: i64,
    version_id: String,
    sha256: String,
    offered_at: Option<String>,
    content: String,
}

/// The artifact offered at `generation`, or nothing when the device never had
/// that generation. A generation assigned before artifacts were stored per
/// generation offered its version's own artifact, which is what check-ins
/// still serve for it.
async fn offer(
    tx: &mut SqliteConnection,
    id: &str,
    device: &Device,
    generation: i64,
) -> Result<Option<Offer>> {
    if let Some(stored) = stored_at(tx, id, generation).await? {
        let artifact = variables::blob(tx, &stored.sha256)
            .await
            .map_err(unreadable)?;
        return Ok(Some(Offer {
            generation,
            version_id: stored.version_id,
            sha256: artifact.sha256,
            offered_at: Some(stored.offered_at),
            content: artifact.bytes,
        }));
    }
    let Some(version_id) = device
        .version_id
        .as_ref()
        .filter(|_| device.generation == generation)
    else {
        return Ok(None);
    };
    let version = db::record(tx, "version", version_id)
        .await
        .map_err(unreadable)?;
    if version["variables"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(ApiError::conflict(
            "The configuration offered to this device is not stored. Deploy again to offer a new one.",
        ));
    }
    let artifact = variables::render(&version, &Value::Null, id).map_err(unreadable)?;
    Ok(Some(Offer {
        generation,
        version_id: version_id.clone(),
        sha256: artifact.sha256,
        offered_at: None,
        content: artifact.bytes,
    }))
}

/// `{id, number, configuration_id, configuration_name}` for each version,
/// read in one statement.
async fn labels(
    tx: &mut SqliteConnection,
    versions: BTreeSet<&str>,
) -> Result<HashMap<String, Value>> {
    if versions.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query(
        "SELECT v.id AS id,\
         CASE WHEN json_type(v.data,'$.number')='integer' THEN json_extract(v.data,'$.number') END AS number,\
         CASE WHEN json_type(v.data,'$.configuration_id')='text' THEN json_extract(v.data,'$.configuration_id') END AS configuration_id,\
         (SELECT CASE WHEN json_type(c.data,'$.name')='text' THEN substr(json_extract(c.data,'$.name'),1,240) END FROM records c WHERE c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')) AS configuration_name \
         FROM records v WHERE v.kind='version' AND v.id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(versions).to_string())
    .fetch_all(&mut *tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let id: String = row.get("id");
            let label = json!({
                "id": id,
                "number": row.get::<Option<i64>, _>("number"),
                "configuration_id": row.get::<Option<String>, _>("configuration_id"),
                "configuration_name": row.get::<Option<String>, _>("configuration_name"),
            });
            (id, label)
        })
        .collect())
}

fn label(labels: &HashMap<String, Value>, id: &str) -> Value {
    labels.get(id).cloned().unwrap_or_else(
        || json!({"id": id, "number": null, "configuration_id": null, "configuration_name": null}),
    )
}

/// What a published version says about its variables and its secrets.
struct Facts {
    declarations: Vec<Value>,
    uses_local_secrets: bool,
}

async fn facts(tx: &mut SqliteConnection, version_id: &str) -> Result<Facts> {
    let row = sqlx::query(
        "SELECT json_extract(data,'$.variables') AS variables,COALESCE(json_extract(data,'$.uses_local_secrets')=1,0) AS secrets FROM records WHERE kind='version' AND id=?",
    )
    .bind(version_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(Facts {
            declarations: Vec::new(),
            uses_local_secrets: false,
        });
    };
    let declarations = match row.get::<Option<String>, _>("variables") {
        Some(text) => db::parse(&text)?.as_array().cloned().unwrap_or_default(),
        None => Vec::new(),
    };
    Ok(Facts {
        declarations,
        uses_local_secrets: row.get("secrets"),
    })
}

/// Where each variable's value came from, when a deployment of this device
/// explains the offered bytes. A deployment explains them only if, for every
/// shown variable, its bindings hold exactly the value the artifact carries:
/// a deployment that merely touched this generation is not credited with it.
async fn sources(
    tx: &mut SqliteConnection,
    id: &str,
    offer: &Offer,
    shown: &[variables::OfferedVariable],
) -> Result<HashMap<String, &'static str>> {
    // Only a UUID is ever placed in a JSON path below.
    if shown.is_empty() || uuid::Uuid::parse_str(id).is_err() {
        return Ok(HashMap::new());
    }
    let candidates: Vec<String> = sqlx::query_scalar(
        "SELECT deployment_id FROM deployment_targets WHERE device_id=? AND generation IN (SELECT generation FROM desired_artifacts WHERE device_id=? AND sha256=?) ORDER BY (generation=?) DESC,generation DESC,deployment_id LIMIT 20",
    )
    .bind(id)
    .bind(id)
    .bind(&offer.sha256)
    .bind(offer.generation)
    .fetch_all(&mut *tx)
    .await?;
    for deployment in candidates {
        let Some(row) = sqlx::query(
            "SELECT json_extract(data,'$.version_id') AS version_id,json_extract(data,'$.variable_bindings.defaults') AS defaults,json_extract(data,'$.variable_bindings.devices.\"' || ? || '\"') AS overrides FROM records WHERE kind='deployment' AND id=?",
        )
        .bind(id)
        .bind(&deployment)
        .fetch_optional(&mut *tx)
        .await?
        else {
            continue;
        };
        if row.get::<Option<String>, _>("version_id").as_deref() != Some(&offer.version_id) {
            continue;
        }
        let defaults = row.get::<Option<String>, _>("defaults");
        let overrides = row.get::<Option<String>, _>("overrides");
        if defaults.is_none() && overrides.is_none() {
            continue;
        }
        let parse = |text: Option<String>| {
            text.and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .unwrap_or_else(|| json!({}))
        };
        let bindings = json!({"defaults": parse(defaults), "devices": {id: parse(overrides)}});
        let mut found = HashMap::new();
        let explained = shown.iter().all(|variable| {
            let Some(value) = &variable.value else {
                return true;
            };
            match variables::binding_source(&bindings, id, &variable.name) {
                Some((source, bound)) if bound == value => {
                    found.insert(variable.name.clone(), source);
                    true
                }
                _ => false,
            }
        });
        if explained {
            return Ok(found);
        }
    }
    Ok(HashMap::new())
}

/// The variables the version declares, with the values this device was
/// offered. A value is read out of the offered bytes, so it is what the
/// device received; a value that could be a credential is withheld.
async fn variable_rows(
    tx: &mut SqliteConnection,
    id: &str,
    offer: &Offer,
    declarations: &[Value],
    artifact: Option<&Value>,
) -> Result<Vec<Value>> {
    if declarations.is_empty() {
        return Ok(Vec::new());
    }
    let shown = variables::offered(declarations, artifact.unwrap_or(&Value::Null));
    let sources = sources(tx, id, offer, &shown).await?;
    Ok(shown
        .into_iter()
        .map(|variable| {
            json!({
                "name": variable.name,
                "path": variable.path,
                "type": variable.typ,
                "value": variable.value,
                "source": sources.get(&variable.name),
            })
        })
        .collect())
}

/// `json` when the offered bytes are JSON, which is what the server renders.
fn format_of(content: &str) -> &'static str {
    if serde_json::from_str::<serde::de::IgnoredAny>(content).is_ok() {
        "json"
    } else {
        "yaml"
    }
}

/// What the agent last reported about its managed file.
struct Evidence<'a> {
    actual: Option<&'a str>,
    template: Option<&'a str>,
    verified: Option<&'a str>,
    revoked: bool,
}

/// Whether the file the agent runs is the offered artifact, and which offered
/// generation it is otherwise. `by_actual` and `by_template` are the newest
/// generations offered with the reported file or template digest.
///
/// A version that reads device secrets is written to the host with the host's
/// own values in place of its references, so the file's digest can never be
/// the offered one. For those the evidence is the template digest the agent
/// applied, and that its file is unchanged since the server verified it.
/// Nothing here claims what a file the server has never seen contains.
fn verdict(
    evidence: &Evidence,
    offered: Option<&str>,
    secrets: bool,
    by_actual: Option<i64>,
    by_template: Option<i64>,
) -> (Option<bool>, Option<i64>) {
    let Some(actual) = evidence.actual.filter(|_| !evidence.revoked) else {
        return (None, None);
    };
    let running_generation = evidence.template.and(by_template).or(by_actual);
    let Some(offered) = offered else {
        return (None, running_generation);
    };
    let same_template = secrets && evidence.template == Some(offered);
    let matches = if actual == offered {
        Some(true)
    } else if !secrets {
        Some(false)
    } else {
        match evidence.template {
            Some(template) if template == offered => evidence.verified.map(|v| v == actual),
            Some(_) => Some(false),
            None => by_actual.map(|_| false),
        }
    };
    let generation = (matches == Some(false) && !same_template)
        .then_some(running_generation)
        .flatten();
    (matches, generation)
}

fn offered_json(offer: &Offer, labels: &HashMap<String, Value>) -> Value {
    json!({
        "generation": offer.generation,
        "version": label(labels, &offer.version_id),
        "sha256": offer.sha256,
        "size": offer.content.len(),
        "offered_at": offer.offered_at,
    })
}

/// `GET /devices/{id}/configuration[?generation=N]`
pub async fn configuration(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<ConfigurationQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], false).await?;
    throttled(&s, &user, "configuration-read", READS_PER_MINUTE)?;
    let query = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let requested = query.generation.as_deref().map(generation).transpose()?;
    // One snapshot: the device row, its offers and the version facts agree.
    let mut tx = s.pool.begin().await?;
    let device = device(&mut tx, &id).await?;
    let target = requested.unwrap_or(device.generation);
    let offer = match (requested, &device.version_id) {
        (None, None) => None,
        _ => match offer(&mut tx, &id, &device, target).await? {
            Some(offer) => Some(offer),
            None if requested.is_some() => return Err(never_offered()),
            None => None,
        },
    };
    let (listed, total) = {
        let rows = sqlx::query(&format!(
            "{STORED} ORDER BY generation DESC LIMIT {LISTED_GENERATIONS}"
        ))
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?;
        let total: i64 =
            sqlx::query_scalar("SELECT count(*) FROM desired_artifacts WHERE device_id=?")
                .bind(&id)
                .fetch_one(&mut *tx)
                .await?;
        (rows.into_iter().map(stored_row).collect::<Vec<_>>(), total)
    };
    let previous = stored_before(&mut tx, &id, target).await?;
    let mut wanted: BTreeSet<&str> = listed.iter().map(|g| g.version_id.as_str()).collect();
    wanted.extend(previous.iter().map(|p| p.version_id.as_str()));
    wanted.extend(offer.iter().map(|o| o.version_id.as_str()));
    let labels = labels(&mut tx, wanted).await?;

    let facts = match &offer {
        Some(offer) => facts(&mut tx, &offer.version_id).await?,
        None => Facts {
            declarations: Vec::new(),
            uses_local_secrets: false,
        },
    };
    let artifact = offer
        .as_ref()
        .and_then(|offer| serde_json::from_str::<Value>(&offer.content).ok());
    let rows = match &offer {
        Some(offer) => {
            variable_rows(&mut tx, &id, offer, &facts.declarations, artifact.as_ref()).await?
        }
        None => Vec::new(),
    };
    let by_actual = match &device.actual {
        Some(actual) => newest_with(&mut tx, &id, actual).await?,
        None => None,
    };
    let by_template = match &device.template {
        Some(template) => newest_with(&mut tx, &id, template).await?,
        None => None,
    };
    drop(tx);

    let (matches, matches_generation) = verdict(
        &Evidence {
            actual: device.actual.as_deref(),
            template: device.template.as_deref(),
            verified: device.verified.as_deref(),
            revoked: device.revoked,
        },
        offer.as_ref().map(|offer| offer.sha256.as_str()),
        facts.uses_local_secrets,
        by_actual,
        by_template,
    );
    let mut items: Vec<Value> = listed
        .iter()
        .map(|g| {
            json!({
                "generation": g.generation,
                "version": label(&labels, &g.version_id),
                "sha256": g.sha256,
                "offered_at": g.offered_at,
            })
        })
        .collect();
    // A generation served from its version's own artifact has no stored row.
    if let Some(offer) = offer
        .as_ref()
        .filter(|o| o.offered_at.is_none() && !listed.iter().any(|g| g.generation == o.generation))
    {
        items.insert(
            0,
            json!({
                "generation": offer.generation,
                "version": label(&labels, &offer.version_id),
                "sha256": offer.sha256,
                "offered_at": null,
            }),
        );
    }
    let current = target == device.generation;
    let running = json!({
        "sha256": device.actual,
        "template_sha256": device.template,
        "matches": matches,
        "matches_generation": matches_generation,
        "reported_at": device.last_seen,
    });
    let previous = previous.map(|p| {
        json!({
            "generation": p.generation,
            "version": label(&labels, &p.version_id),
            "sha256": p.sha256,
        })
    });
    let generations = json!({"total": total.max(items.len() as i64), "items": items});
    Ok(Json(match offer {
        Some(offer) => json!({
            "device_id": id,
            "generation": offer.generation,
            "current": current,
            "offered_at": offer.offered_at,
            "version": label(&labels, &offer.version_id),
            "sha256": offer.sha256,
            "size": offer.content.len(),
            "format": format_of(&offer.content),
            "content": offer.content,
            "uses_local_secrets": facts.uses_local_secrets,
            "variables": rows,
            "running": running,
            "previous": previous,
            "generations": generations,
        }),
        None => json!({
            "device_id": id,
            "generation": target,
            "current": current,
            "offered_at": null,
            "version": null,
            "sha256": null,
            "size": null,
            "format": null,
            "content": null,
            "uses_local_secrets": false,
            "variables": [],
            "running": running,
            "previous": previous,
            "generations": generations,
        }),
    }))
}

/// `GET /devices/{id}/configuration/diff[?from=N][&to=M]`
pub async fn diff(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<DiffQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &[], false).await?;
    throttled(&s, &user, "configuration-diff", DIFFS_PER_MINUTE)?;
    let query = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let from = query.from.as_deref().map(generation).transpose()?;
    let to = query.to.as_deref().map(generation).transpose()?;
    let mut tx = s.pool.begin().await?;
    let device = device(&mut tx, &id).await?;
    let newer = match to {
        Some(generation) => offer(&mut tx, &id, &device, generation)
            .await?
            .ok_or_else(never_offered)?,
        None if device.version_id.is_some() => offer(&mut tx, &id, &device, device.generation)
            .await?
            .ok_or_else(nothing_offered)?,
        None => return Err(nothing_offered()),
    };
    let older = match from {
        Some(generation) => Some(
            offer(&mut tx, &id, &device, generation)
                .await?
                .ok_or_else(never_offered)?,
        ),
        None => match stored_before(&mut tx, &id, newer.generation).await? {
            Some(previous) => offer(&mut tx, &id, &device, previous.generation).await?,
            None => None,
        },
    };
    let mut wanted = BTreeSet::from([newer.version_id.as_str()]);
    wanted.extend(older.iter().map(|o| o.version_id.as_str()));
    let labels = labels(&mut tx, wanted).await?;
    drop(tx);

    let to_json = offered_json(&newer, &labels);
    let Some(older) = older else {
        // The first thing this device was offered has nothing to be compared with.
        return Ok(Json(json!({
            "device_id": id,
            "from": null,
            "to": to_json,
            "identical": false,
            "counts": {"added": 0, "removed": 0, "changed": 0},
            "hunks": [],
            "unified": "",
            "truncated": false,
            "total_lines": 0,
            "approximate": false,
        })));
    };
    let from_json = offered_json(&older, &labels);
    let identical = older.sha256 == newer.sha256;
    let (before, after) = (older.generation, newer.generation);
    let compared = if identical {
        diff::Diff::default()
    } else {
        let json_text = format_of(&newer.content) == "json" && format_of(&older.content) == "json";
        // Comparing is bounded work, but it is work: keep it off the async threads.
        tokio::task::spawn_blocking(move || {
            diff::compare(&older.content, &newer.content, json_text)
        })
        .await
        .map_err(unreadable)?
    };
    let rendered = compared.render(before, after);
    Ok(Json(json!({
        "device_id": id,
        "from": from_json,
        "to": to_json,
        "identical": identical,
        "counts": rendered.counts,
        "hunks": rendered.hunks,
        "unified": rendered.unified,
        "truncated": rendered.truncated,
        "total_lines": rendered.total_lines,
        "approximate": compared.approximate,
    })))
}

/// A line diff of two artifacts. Both are the server's pretty-printed JSON,
/// so a changed setting is a changed line and a hunk can say which component
/// it is in.
pub mod diff {
    use super::MAX_DIFF_LINES;
    use serde_json::{Value, json};
    use std::collections::{BTreeSet, HashMap, HashSet};

    /// Unchanged lines kept around each change.
    const CONTEXT: usize = 3;
    /// The most edits (changed lines) looked for. A bigger difference is
    /// shown as one replaced region instead.
    const MAX_EDIT_DISTANCE: usize = 2_000;
    /// Work done comparing lines before giving up on a minimal diff.
    const MAX_STEPS: usize = 50_000_000;
    /// Two documents with more lines than this are shown as replaced.
    const MAX_LINES: usize = 500_000;
    /// Characters of a hunk's section label.
    const MAX_SECTION: usize = 200;

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    pub enum Kind {
        Context,
        Removed,
        Added,
    }

    /// A line of the diff: which side(s) it is on, by zero-based index.
    #[derive(Clone, Copy, Debug)]
    pub struct Row {
        pub kind: Kind,
        pub old: Option<usize>,
        pub new: Option<usize>,
    }

    #[derive(Default)]
    pub struct Diff {
        pub rows: Vec<Row>,
        /// Whether the change was too large to match line by line, so the
        /// region between the unchanged start and end is shown as replaced
        /// although some lines in it are the same on both sides.
        pub approximate: bool,
        old: Vec<String>,
        new: Vec<String>,
        sections: bool,
    }

    pub struct Rendered {
        pub counts: Value,
        pub hunks: Vec<Value>,
        pub unified: String,
        pub truncated: bool,
        pub total_lines: usize,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Op {
        Equal,
        Delete,
        Insert,
    }

    fn split(text: &str) -> Vec<&str> {
        let mut lines: Vec<&str> = text.split('\n').collect();
        if lines.last() == Some(&"") {
            lines.pop();
        }
        lines
    }

    /// Every line of the old side deleted, then every line of the new inserted.
    fn replace(old: usize, new: usize) -> Vec<Op> {
        std::iter::repeat_n(Op::Delete, old)
            .chain(std::iter::repeat_n(Op::Insert, new))
            .collect()
    }

    fn intern<'a>(ids: &mut HashMap<&'a str, u32>, line: &'a str) -> u32 {
        let next = ids.len() as u32;
        *ids.entry(line).or_insert(next)
    }

    /// The shortest edit script of two sequences, or nothing when it takes
    /// more than `MAX_EDIT_DISTANCE` edits or `MAX_STEPS` steps.
    fn myers(a: &[u32], b: &[u32]) -> Option<Vec<Op>> {
        let (n, m) = (a.len() as isize, b.len() as isize);
        let limit = (n + m).min(MAX_EDIT_DISTANCE as isize);
        let offset = limit + 1;
        let at = |k: isize| (k + offset) as usize;
        let mut v = vec![0isize; (2 * limit + 3) as usize];
        // trace[d]: the furthest x of every diagonal -d..=d reached by d edits.
        let mut trace: Vec<Vec<isize>> = Vec::new();
        let mut steps = 0usize;
        let mut found = None;
        'search: for d in 0..=limit {
            for k in (-d..=d).step_by(2) {
                let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) {
                    v[at(k + 1)]
                } else {
                    v[at(k - 1)] + 1
                };
                let mut y = x - k;
                while x < n && y < m && a[x as usize] == b[y as usize] {
                    x += 1;
                    y += 1;
                    steps += 1;
                }
                steps += 1;
                if steps > MAX_STEPS {
                    return None;
                }
                v[at(k)] = x;
                if x >= n && y >= m {
                    found = Some(d);
                    break 'search;
                }
            }
            trace.push((-d..=d).step_by(2).map(|k| v[at(k)]).collect());
        }
        let distance = found?;
        let mut ops = Vec::new();
        let (mut x, mut y) = (n, m);
        for d in (1..=distance).rev() {
            let earlier = &trace[(d - 1) as usize];
            let reached = |k: isize| earlier[((k + d - 1) / 2) as usize];
            let k = x - y;
            let previous_k = if k == -d || (k != d && reached(k - 1) < reached(k + 1)) {
                k + 1
            } else {
                k - 1
            };
            let (previous_x, previous_y) = (reached(previous_k), reached(previous_k) - previous_k);
            while x > previous_x && y > previous_y {
                ops.push(Op::Equal);
                x -= 1;
                y -= 1;
            }
            ops.push(if x == previous_x {
                Op::Insert
            } else {
                Op::Delete
            });
            x = previous_x;
            y = previous_y;
        }
        for _ in 0..x.min(y) {
            ops.push(Op::Equal);
        }
        ops.reverse();
        Some(ops)
    }

    /// Compare two artifacts. `json` says whether both are the server's
    /// pretty-printed JSON, so hunks can be labelled with their component.
    pub fn compare(old: &str, new: &str, json: bool) -> Diff {
        let (old_lines, new_lines) = (split(old), split(new));
        let mut prefix = 0;
        while prefix < old_lines.len()
            && prefix < new_lines.len()
            && old_lines[prefix] == new_lines[prefix]
        {
            prefix += 1;
        }
        let mut suffix = 0;
        while suffix < old_lines.len() - prefix
            && suffix < new_lines.len() - prefix
            && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
        {
            suffix += 1;
        }
        let a = &old_lines[prefix..old_lines.len() - suffix];
        let b = &new_lines[prefix..new_lines.len() - suffix];
        let (ops, approximate) = if a.is_empty() || b.is_empty() {
            // A plain insertion or deletion.
            (replace(a.len(), b.len()), false)
        } else if a.len() + b.len() > MAX_LINES {
            (replace(a.len(), b.len()), true)
        } else {
            // Equal lines share a number, so comparing them is comparing integers.
            let mut ids: HashMap<&str, u32> = HashMap::new();
            let x: Vec<u32> = a.iter().map(|line| intern(&mut ids, line)).collect();
            let y: Vec<u32> = b.iter().map(|line| intern(&mut ids, line)).collect();
            match myers(&x, &y) {
                Some(ops) => (ops, false),
                None => {
                    // Showing the whole region as replaced is the exact diff
                    // when the two sides have no line in common, and only then.
                    let ours: HashSet<u32> = x.iter().copied().collect();
                    (
                        replace(a.len(), b.len()),
                        y.iter().any(|line| ours.contains(line)),
                    )
                }
            }
        };
        let mut rows = Vec::with_capacity(old_lines.len() + new_lines.len() - prefix - suffix);
        rows.extend((0..prefix).map(|i| Row {
            kind: Kind::Context,
            old: Some(i),
            new: Some(i),
        }));
        let (mut oi, mut ni) = (prefix, prefix);
        let (mut removed, mut added) = (Vec::new(), Vec::new());
        let flush = |rows: &mut Vec<Row>, removed: &mut Vec<Row>, added: &mut Vec<Row>| {
            rows.append(removed);
            rows.append(added);
        };
        for op in ops {
            match op {
                Op::Equal => {
                    flush(&mut rows, &mut removed, &mut added);
                    rows.push(Row {
                        kind: Kind::Context,
                        old: Some(oi),
                        new: Some(ni),
                    });
                    oi += 1;
                    ni += 1;
                }
                Op::Delete => {
                    removed.push(Row {
                        kind: Kind::Removed,
                        old: Some(oi),
                        new: None,
                    });
                    oi += 1;
                }
                Op::Insert => {
                    added.push(Row {
                        kind: Kind::Added,
                        old: None,
                        new: Some(ni),
                    });
                    ni += 1;
                }
            }
        }
        flush(&mut rows, &mut removed, &mut added);
        rows.extend((0..suffix).map(|i| Row {
            kind: Kind::Context,
            old: Some(oi + i),
            new: Some(ni + i),
        }));
        Diff {
            rows,
            approximate,
            old: old_lines.iter().map(|line| (*line).to_owned()).collect(),
            new: new_lines.iter().map(|line| (*line).to_owned()).collect(),
            sections: json,
        }
    }

    /// The keys of the objects enclosing each wanted line of a pretty-printed
    /// JSON document, joined with dots: `sinks.out.buffer`. A document that
    /// is not shaped like the server's rendering gets no label.
    fn section_paths(lines: &[String], wanted: &BTreeSet<usize>) -> HashMap<usize, String> {
        let mut found = HashMap::new();
        let Some(&last) = wanted.iter().next_back() else {
            return found;
        };
        let mut open: Vec<Option<&str>> = Vec::new();
        for (index, line) in lines.iter().enumerate().take(last + 1) {
            if wanted.contains(&index) {
                let path: Vec<&str> = open.iter().flatten().copied().collect();
                found.insert(index, path.join("."));
            }
            let text = line.trim_start();
            if text.starts_with('}') || text.starts_with(']') {
                if open.pop().is_none() {
                    break;
                }
            } else if text.ends_with('{') || text.ends_with('[') {
                open.push(key(text));
            }
        }
        found
    }

    /// `"name": {` is the key `name`; a bare `{` (an array element) has none.
    fn key(text: &str) -> Option<&str> {
        let rest = text.strip_prefix('"')?;
        let mut escaped = false;
        for (index, ch) in rest.char_indices() {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                return rest[index + 1..].starts_with(": ").then(|| &rest[..index]);
            }
        }
        None
    }

    struct Hunk {
        start: usize,
        end: usize,
        old_start: usize,
        old_lines: usize,
        new_start: usize,
        new_lines: usize,
    }

    impl Diff {
        /// Added, removed and changed lines. A removed line that a added line
        /// replaces in place is one changed line, not one of each.
        fn counts(&self) -> (usize, usize, usize) {
            let (mut added, mut removed, mut changed) = (0, 0, 0);
            let mut index = 0;
            while index < self.rows.len() {
                if self.rows[index].kind == Kind::Context {
                    index += 1;
                    continue;
                }
                let (mut gone, mut came) = (0, 0);
                while index < self.rows.len() && self.rows[index].kind != Kind::Context {
                    match self.rows[index].kind {
                        Kind::Removed => gone += 1,
                        _ => came += 1,
                    }
                    index += 1;
                }
                let pairs = gone.min(came);
                changed += pairs;
                removed += gone - pairs;
                added += came - pairs;
            }
            (added, removed, changed)
        }

        /// Groups of changes with `CONTEXT` unchanged lines around them; two
        /// changes closer than twice that share a group.
        fn hunks(&self) -> Vec<Hunk> {
            let changes: Vec<usize> = (0..self.rows.len())
                .filter(|&i| self.rows[i].kind != Kind::Context)
                .collect();
            // Lines of each side before each row.
            let (mut before_old, mut before_new) = (Vec::new(), Vec::new());
            let (mut old, mut new) = (0, 0);
            for row in &self.rows {
                before_old.push(old);
                before_new.push(new);
                old += usize::from(row.old.is_some());
                new += usize::from(row.new.is_some());
            }
            let mut hunks = Vec::new();
            let mut i = 0;
            while i < changes.len() {
                let start = changes[i].saturating_sub(CONTEXT);
                let mut last = changes[i];
                i += 1;
                while i < changes.len() && changes[i] - last <= 2 * CONTEXT + 1 {
                    last = changes[i];
                    i += 1;
                }
                let end = (last + CONTEXT + 1).min(self.rows.len());
                let old_lines = self.rows[start..end]
                    .iter()
                    .filter(|r| r.old.is_some())
                    .count();
                let new_lines = self.rows[start..end]
                    .iter()
                    .filter(|r| r.new.is_some())
                    .count();
                // An empty range starts at the line before it, as `diff -u` writes it.
                hunks.push(Hunk {
                    start,
                    end,
                    old_start: before_old[start] + usize::from(old_lines > 0),
                    old_lines,
                    new_start: before_new[start] + usize::from(new_lines > 0),
                    new_lines,
                });
            }
            hunks
        }

        /// The diff as a unified diff of at most `MAX_DIFF_LINES` lines and as
        /// hunks of the same lines for a viewer.
        pub fn render(&self, from: i64, to: i64) -> Rendered {
            let (added, removed, changed) = self.counts();
            let counts = json!({"added": added, "removed": removed, "changed": changed});
            let hunks = self.hunks();
            if hunks.is_empty() {
                return Rendered {
                    counts,
                    hunks: Vec::new(),
                    unified: String::new(),
                    truncated: false,
                    total_lines: 0,
                };
            }
            let total_lines =
                2 + hunks.len() + hunks.iter().map(|h| h.end - h.start).sum::<usize>();
            let truncated = total_lines > MAX_DIFF_LINES;
            // The marker takes the last of the lines.
            let mut room = if truncated {
                MAX_DIFF_LINES - 1
            } else {
                total_lines
            };
            let mut text = vec![
                format!("--- generation {from}"),
                format!("+++ generation {to}"),
            ];
            room -= 2;
            let mut shown: Vec<(&Hunk, usize)> = Vec::new();
            for hunk in &hunks {
                if room < 2 {
                    break;
                }
                let lines = (hunk.end - hunk.start).min(room - 1);
                room -= 1 + lines;
                shown.push((hunk, lines));
            }
            let (mut old_wanted, mut new_wanted) = (BTreeSet::new(), BTreeSet::new());
            let first_changes: Vec<Option<Row>> = shown
                .iter()
                .map(|(hunk, _)| {
                    self.rows[hunk.start..hunk.end]
                        .iter()
                        .find(|row| row.kind != Kind::Context)
                        .copied()
                })
                .collect();
            if self.sections {
                for row in first_changes.iter().flatten() {
                    match (row.kind, row.old, row.new) {
                        (Kind::Added, _, Some(i)) => new_wanted.insert(i),
                        (_, Some(i), _) => old_wanted.insert(i),
                        _ => false,
                    };
                }
            }
            let old_paths = section_paths(&self.old, &old_wanted);
            let new_paths = section_paths(&self.new, &new_wanted);
            let mut rendered = Vec::with_capacity(shown.len());
            for ((hunk, lines), first) in shown.into_iter().zip(first_changes) {
                let section = first
                    .and_then(|row| match (row.kind, row.old, row.new) {
                        (Kind::Added, _, Some(i)) => new_paths.get(&i),
                        (_, Some(i), _) => old_paths.get(&i),
                        _ => None,
                    })
                    .filter(|path| !path.is_empty())
                    .map(|path| path.chars().take(MAX_SECTION).collect::<String>());
                let range = |start: usize, count: usize| {
                    if count == 1 {
                        start.to_string()
                    } else {
                        format!("{start},{count}")
                    }
                };
                text.push(format!(
                    "@@ -{} +{} @@{}",
                    range(hunk.old_start, hunk.old_lines),
                    range(hunk.new_start, hunk.new_lines),
                    section
                        .as_ref()
                        .map(|path| format!(" {path}"))
                        .unwrap_or_default()
                ));
                let mut body = Vec::with_capacity(lines);
                for row in &self.rows[hunk.start..hunk.start + lines] {
                    let (mark, kind, line) = match row.kind {
                        Kind::Context => (' ', "context", &self.new[row.new.unwrap()]),
                        Kind::Removed => ('-', "removed", &self.old[row.old.unwrap()]),
                        Kind::Added => ('+', "added", &self.new[row.new.unwrap()]),
                    };
                    text.push(format!("{mark}{line}"));
                    body.push(json!({
                        "kind": kind,
                        "old_line": row.old.map(|i| i + 1),
                        "new_line": row.new.map(|i| i + 1),
                        "text": line,
                    }));
                }
                rendered.push(json!({
                    "old_start": hunk.old_start,
                    "old_lines": hunk.old_lines,
                    "new_start": hunk.new_start,
                    "new_lines": hunk.new_lines,
                    "section": section,
                    "lines": body,
                }));
            }
            if truncated {
                text.push(format!(
                    "\\ Diff truncated: showing {} of {total_lines} lines",
                    text.len()
                ));
            }
            let mut unified = text.join("\n");
            unified.push('\n');
            Rendered {
                counts,
                hunks: rendered,
                unified,
                truncated,
                total_lines,
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn run(old: &str, new: &str) -> Rendered {
            compare(old, new, true).render(1, 2)
        }

        /// Replays the rows over the old text and checks it gives the new one.
        fn replays(old: &str, new: &str) {
            let diff = compare(old, new, false);
            let (a, b) = (split(old), split(new));
            let (mut x, mut y) = (0, 0);
            for row in &diff.rows {
                match row.kind {
                    Kind::Context => {
                        assert_eq!(a[row.old.unwrap()], b[row.new.unwrap()]);
                        assert_eq!((row.old, row.new), (Some(x), Some(y)));
                        x += 1;
                        y += 1;
                    }
                    Kind::Removed => {
                        assert_eq!(row.old, Some(x));
                        x += 1;
                    }
                    Kind::Added => {
                        assert_eq!(row.new, Some(y));
                        y += 1;
                    }
                }
            }
            assert_eq!((x, y), (a.len(), b.len()), "every line is accounted for");
        }

        /// The length of the longest common subsequence, by the textbook table.
        fn lcs(a: &[u32], b: &[u32]) -> usize {
            let mut table = vec![vec![0; b.len() + 1]; a.len() + 1];
            for i in 0..a.len() {
                for j in 0..b.len() {
                    table[i + 1][j + 1] = if a[i] == b[j] {
                        table[i][j] + 1
                    } else {
                        table[i][j + 1].max(table[i + 1][j])
                    };
                }
            }
            table[a.len()][b.len()]
        }

        #[test]
        fn the_script_is_a_shortest_one_for_any_small_input() {
            // A fixed generator keeps the cases reproducible.
            let mut state = 0x2545_f491_4f6c_dd1du64;
            let mut next = move |bound: u64| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state % bound
            };
            for _ in 0..600 {
                let a: Vec<u32> = (0..next(14)).map(|_| next(3) as u32).collect();
                let b: Vec<u32> = (0..next(14)).map(|_| next(3) as u32).collect();
                if a.is_empty() || b.is_empty() {
                    continue;
                }
                let ops = myers(&a, &b).expect("small inputs always finish");
                let (mut x, mut y, mut edits) = (0, 0, 0);
                for op in ops {
                    match op {
                        Op::Equal => {
                            assert_eq!(a[x], b[y]);
                            x += 1;
                            y += 1;
                        }
                        Op::Delete => {
                            x += 1;
                            edits += 1;
                        }
                        Op::Insert => {
                            y += 1;
                            edits += 1;
                        }
                    }
                }
                assert_eq!((x, y), (a.len(), b.len()), "{a:?} {b:?}");
                assert_eq!(edits, a.len() + b.len() - 2 * lcs(&a, &b), "{a:?} {b:?}");
            }
        }

        #[test]
        fn identical_text_has_no_hunks() {
            let result = run("a\nb\nc\n", "a\nb\nc\n");
            assert!(result.hunks.is_empty());
            assert_eq!(result.unified, "");
            assert_eq!(result.counts, json!({"added":0,"removed":0,"changed":0}));
        }

        #[test]
        fn a_replaced_line_is_one_changed_line_with_context() {
            let old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
            let new = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
            let result = run(old, new);
            assert_eq!(result.counts, json!({"added":0,"removed":0,"changed":1}));
            assert_eq!(
                result.unified,
                "--- generation 1\n+++ generation 2\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n"
            );
            replays(old, new);
        }

        #[test]
        fn additions_and_removals_are_counted_apart_from_replacements() {
            let result = run("a\nb\nc\nd\n", "a\nc\nd\ne\nf\n");
            // b is removed; e and f are added.
            assert_eq!(result.counts, json!({"added":2,"removed":1,"changed":0}));
            let result = run("a\nb\nc\n", "a\nx\ny\nz\nc\n");
            // b is replaced by x, and y and z are added.
            assert_eq!(result.counts, json!({"added":2,"removed":0,"changed":1}));
        }

        #[test]
        fn hunks_use_the_line_before_an_empty_range() {
            // Added at the very start: the old range is empty at 0.
            let result = run("a\nb\n", "new\na\nb\n");
            assert!(
                result.unified.contains("@@ -1,2 +1,3 @@"),
                "{}",
                result.unified
            );
            let result = run("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\ne\nf\ng\nh\ni\n");
            assert!(
                result.unified.contains("@@ -6,3 +6,4 @@"),
                "{}",
                result.unified
            );
            let result = run("x\n", "x\ny\n");
            assert!(
                result.unified.contains("@@ -1 +1,2 @@"),
                "{}",
                result.unified
            );
            // Everything removed: the new range is empty.
            let result = run("a\nb\n", "");
            assert!(
                result.unified.contains("@@ -1,2 +0,0 @@"),
                "{}",
                result.unified
            );
        }

        #[test]
        fn nearby_changes_share_a_hunk_and_distant_ones_do_not() {
            let lines = |changed: &[usize]| {
                (1..=40)
                    .map(|n| {
                        if changed.contains(&n) {
                            format!("changed {n}\n")
                        } else {
                            format!("line {n}\n")
                        }
                    })
                    .collect::<String>()
            };
            let base = lines(&[]);
            // Six unchanged lines between them (twice the context): one hunk.
            assert_eq!(run(&base, &lines(&[10, 17])).hunks.len(), 1);
            // Seven between them: two hunks.
            assert_eq!(run(&base, &lines(&[10, 18])).hunks.len(), 2);
            // The first and last lines have less context on one side.
            let result = run(&base, &lines(&[1, 40]));
            assert_eq!(result.hunks.len(), 2);
            assert_eq!(result.hunks[0]["old_start"], 1);
            assert_eq!(result.hunks[1]["old_lines"], 4);
        }

        #[test]
        fn structured_lines_match_the_text_and_carry_line_numbers() {
            let result = run("a\nb\nc\n", "a\nB\nc\n");
            let lines = result.hunks[0]["lines"].as_array().unwrap();
            let kinds: Vec<_> = lines.iter().map(|l| l["kind"].as_str().unwrap()).collect();
            assert_eq!(kinds, ["context", "removed", "added", "context"]);
            assert_eq!(lines[1]["old_line"], 2);
            assert_eq!(lines[1]["new_line"], Value::Null);
            assert_eq!(lines[2]["old_line"], Value::Null);
            assert_eq!(lines[2]["new_line"], 2);
            assert_eq!(lines[2]["text"], "B");
        }

        #[test]
        fn a_hunk_names_the_component_it_is_in() {
            let old = "{\n  \"sinks\": {\n    \"out\": {\n      \"buffer\": {\n        \"max_events\": 600\n      },\n      \"type\": \"blackhole\"\n    }\n  },\n  \"sources\": {}\n}\n";
            let new = old.replace("600", "700");
            let result = run(old, &new);
            assert_eq!(result.hunks[0]["section"], "sinks.out.buffer");
            assert!(
                result
                    .unified
                    .contains("@@ -2,7 +2,7 @@ sinks.out.buffer\n"),
                "{}",
                result.unified
            );
            // A change at the top level has no section; text that is not
            // shaped like the rendering gets none either.
            assert_eq!(
                run("{\n  \"a\": 1\n}\n", "{\n  \"a\": 2\n}\n").hunks[0]["section"],
                Value::Null
            );
            let plain = compare("a:\n  b: 1\n", "a:\n  b: 2\n", false).render(1, 2);
            assert_eq!(plain.hunks[0]["section"], Value::Null);
        }

        #[test]
        fn a_removed_line_keeps_the_section_of_the_old_text() {
            let old = "{\n  \"sinks\": {\n    \"out\": {\n      \"a\": 1,\n      \"b\": 2\n    }\n  }\n}\n";
            let new = "{\n  \"sinks\": {\n    \"out\": {\n      \"a\": 1\n    }\n  }\n}\n";
            let result = run(old, new);
            assert_eq!(result.hunks[0]["section"], "sinks.out");
        }

        #[test]
        fn a_long_diff_stops_at_the_cap_and_says_so() {
            let old: String = (0..5_000).map(|n| format!("old {n}\n")).collect();
            let new: String = (0..5_000).map(|n| format!("new {n}\n")).collect();
            let result = run(&old, &new);
            assert!(result.truncated);
            let lines: Vec<&str> = result.unified.lines().collect();
            assert_eq!(lines.len(), MAX_DIFF_LINES);
            assert!(lines[lines.len() - 1].starts_with("\\ Diff truncated: showing 1999 of "));
            assert_eq!(result.total_lines, 2 + 1 + 10_000);
            // The structured lines are the same lines as the text, minus headers.
            let shown: usize = result
                .hunks
                .iter()
                .map(|h| h["lines"].as_array().unwrap().len())
                .sum();
            assert_eq!(shown, MAX_DIFF_LINES - 2 - 1 - 1);
            // The counts describe the whole change, not what was shown.
            assert_eq!(result.counts, json!({"added":0,"removed":0,"changed":5000}));
        }

        #[test]
        fn a_diff_that_fits_is_never_marked_truncated() {
            let old: String = (0..900).map(|n| format!("old {n}\n")).collect();
            let new: String = (0..900).map(|n| format!("new {n}\n")).collect();
            let result = run(&old, &new);
            assert!(!result.truncated);
            assert_eq!(result.unified.lines().count(), result.total_lines);
            assert!(!result.unified.contains("truncated"));
        }

        #[test]
        fn an_enormous_difference_is_replaced_as_a_region_and_flagged() {
            // Half the lines are unchanged and the rest differ: more edits
            // than are looked for, so the region is shown as replaced.
            let side = |changed: &str| -> String {
                (0..1_500)
                    .map(|n| format!("keep {n}\n{changed} {n}\n"))
                    .collect()
            };
            let old = format!("head\n{}tail\n", side("old"));
            let new = format!("head\n{}tail\n", side("new"));
            let diff = compare(&old, &new, false);
            assert!(diff.approximate);
            replays(&old, &new);
            // The unchanged first and last lines are still unchanged.
            assert_eq!(diff.rows[0].kind, Kind::Context);
            assert_eq!(diff.rows[diff.rows.len() - 1].kind, Kind::Context);
            // Nothing in common: replacing the region is the exact diff.
            let all_old: String = (0..3_000).map(|n| format!("old {n}\n")).collect();
            let all_new: String = (0..3_000).map(|n| format!("new {n}\n")).collect();
            let exact = compare(&all_old, &all_new, false);
            assert!(!exact.approximate);
            assert_eq!(exact.counts(), (0, 0, 3_000));
            replays(&all_old, &all_new);
            // A change that fits is exact.
            assert!(!compare("a\nb\n", "a\nc\n", false).approximate);
            // A pure insertion or deletion is exact, however large.
            assert!(!compare("a\n", &format!("a\n{all_new}"), false).approximate);
            assert!(!compare(&format!("a\n{all_new}"), "a\n", false).approximate);
        }

        #[test]
        fn a_large_document_with_one_change_is_fast_and_exact() {
            let lines = |tweak: bool| {
                (0..20_000)
                    .map(|n| {
                        if tweak && n == 9_000 {
                            "changed\n".to_owned()
                        } else {
                            format!("    \"key_{n}\": {n},\n")
                        }
                    })
                    .collect::<String>()
            };
            let started = std::time::Instant::now();
            let result = run(&lines(false), &lines(true));
            assert!(started.elapsed() < std::time::Duration::from_secs(5));
            assert_eq!(result.counts, json!({"added":0,"removed":0,"changed":1}));
            assert_eq!(result.hunks.len(), 1);
            assert!(!result.truncated);
        }

        #[test]
        fn lines_are_compared_as_written() {
            // Trailing whitespace and case are changes; a final newline is not
            // part of the last line.
            assert_eq!(
                run("a \n", "a\n").counts,
                json!({"added":0,"removed":0,"changed":1})
            );
            assert_eq!(
                run("A\n", "a\n").counts,
                json!({"added":0,"removed":0,"changed":1})
            );
            assert!(run("a\nb", "a\nb\n").hunks.is_empty());
            replays("x\ny\nz\nx\ny\nz\n", "y\nz\nx\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn evidence<'a>(
        actual: Option<&'a str>,
        template: Option<&'a str>,
        verified: Option<&'a str>,
    ) -> Evidence<'a> {
        Evidence {
            actual,
            template,
            verified,
            revoked: false,
        }
    }

    #[test]
    fn a_file_with_the_offered_digest_matches() {
        assert_eq!(
            verdict(
                &evidence(Some(A), None, None),
                Some(A),
                false,
                Some(3),
                None
            ),
            (Some(true), None)
        );
    }

    #[test]
    fn a_different_file_does_not_match_and_names_the_generation_it_is() {
        // It is what was offered at generation 3.
        assert_eq!(
            verdict(
                &evidence(Some(B), None, None),
                Some(A),
                false,
                Some(3),
                None
            ),
            (Some(false), Some(3))
        );
        // Nothing offered has this digest: a local edit the server never saw.
        assert_eq!(
            verdict(&evidence(Some(B), None, None), Some(A), false, None, None),
            (Some(false), None)
        );
    }

    #[test]
    fn a_report_without_a_digest_says_nothing() {
        assert_eq!(
            verdict(&evidence(None, None, None), Some(A), false, None, None),
            (None, None)
        );
    }

    #[test]
    fn a_revoked_device_is_not_judged() {
        let revoked = Evidence {
            revoked: true,
            ..evidence(Some(A), None, None)
        };
        assert_eq!(
            verdict(&revoked, Some(A), false, Some(1), None),
            (None, None)
        );
    }

    #[test]
    fn nothing_offered_means_nothing_to_match() {
        // But the file may still be what an earlier offer was.
        assert_eq!(
            verdict(&evidence(Some(A), None, None), None, false, Some(4), None),
            (None, Some(4))
        );
    }

    #[test]
    fn a_version_with_device_secrets_is_judged_by_template_and_unchanged_file() {
        // The file holds the host's secrets: its digest is B, never the offer A.
        // The agent applied template A and the file is as it was verified.
        assert_eq!(
            verdict(
                &evidence(Some(B), Some(A), Some(B)),
                Some(A),
                true,
                None,
                Some(7)
            ),
            (Some(true), None)
        );
        // Same template, but the file changed since: an edit or a rotation not
        // yet verified. Never "it matches generation 7".
        assert_eq!(
            verdict(
                &evidence(Some(C), Some(A), Some(B)),
                Some(A),
                true,
                None,
                Some(7)
            ),
            (Some(false), None)
        );
        // Same template, never verified: no evidence either way.
        assert_eq!(
            verdict(
                &evidence(Some(B), Some(A), None),
                Some(A),
                true,
                None,
                Some(7)
            ),
            (None, None)
        );
        // Another template was applied: it is that generation.
        assert_eq!(
            verdict(
                &evidence(Some(B), Some(C), Some(B)),
                Some(A),
                true,
                None,
                Some(5)
            ),
            (Some(false), Some(5))
        );
    }

    #[test]
    fn a_secret_version_offered_while_an_older_plain_one_runs() {
        // No template: the agent runs a file without secrets, which is an
        // earlier offer when its digest was offered.
        assert_eq!(
            verdict(&evidence(Some(B), None, None), Some(A), true, Some(2), None),
            (Some(false), Some(2))
        );
        // Unknown file: the server cannot tell what it is.
        assert_eq!(
            verdict(&evidence(Some(B), None, None), Some(A), true, None, None),
            (None, None)
        );
    }

    #[test]
    fn a_plain_version_offered_while_an_older_secret_one_runs() {
        assert_eq!(
            verdict(
                &evidence(Some(B), Some(C), Some(B)),
                Some(A),
                false,
                None,
                Some(4)
            ),
            (Some(false), Some(4))
        );
    }

    #[test]
    fn generations_are_plain_positive_numbers() {
        assert_eq!(generation("12").unwrap(), 12);
        assert_eq!(generation("9007199254740991").unwrap(), MAX_GENERATION);
        for bad in [
            "",
            "0",
            "012",
            "+1",
            "-1",
            "1.5",
            "1e3",
            " 1",
            "9007199254740992",
            "99999999999999999",
        ] {
            assert!(generation(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_format_is_what_the_bytes_are() {
        assert_eq!(format_of("{\n  \"a\": 1\n}\n"), "json");
        assert_eq!(format_of("a:\n  b: 1\n"), "yaml");
    }
}
