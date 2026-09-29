//! Draft-library commands never mutate immutable versions or device assignments.
use crate::{
    State, api, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, State as AppState},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

#[derive(Deserialize)]
pub struct HistoryQuery {
    kind: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}

pub async fn history(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &headers, &[], false).await?;
    let (kind, sequence) = match query.kind.as_deref().unwrap_or("revisions") {
        "revisions" => ("revision", "revision"),
        "versions" => ("version", "number"),
        _ => return Err(ApiError::invalid("kind must be revisions or versions")),
    };
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(12);
    if !(1..=9_007_199_254_740_991).contains(&page) || !(1..=50).contains(&page_size) {
        return Err(ApiError::invalid(
            "page must be a positive safe integer and page_size must be 1..50",
        ));
    }
    let offset = page
        .checked_sub(1)
        .and_then(|n| n.checked_mul(page_size))
        .and_then(|n| i64::try_from(n).ok())
        .ok_or_else(|| ApiError::invalid("page is too large"))?;
    // Count and page must describe the same read snapshot while autosaves append.
    let mut tx = s.pool.begin().await?;
    db::record(&mut tx, "configuration", &id).await?;
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT count(*) FROM records WHERE kind='{kind}' AND json_extract(data,'$.configuration_id')=?"
    ))
    .bind(&id)
    .fetch_one(&mut *tx)
    .await?;
    let rows:Vec<String>=sqlx::query_scalar(&format!("SELECT json_remove(data,'$.config','$.graph','$.artifact','$.validation') FROM records WHERE kind='{kind}' AND json_extract(data,'$.configuration_id')=? ORDER BY CAST(json_extract(data,'$.{sequence}') AS INTEGER) DESC,id LIMIT ? OFFSET ?"))
        .bind(&id).bind(page_size as i64).bind(offset).fetch_all(&mut *tx).await?;
    let items = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":page_size}),
    ))
}

pub async fn revision_detail(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    Path((id, revision_id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &headers, &[], false).await?;
    let mut conn = s.pool.acquire().await?;
    db::record(&mut conn, "configuration", &id).await?;
    let entry = db::record(&mut conn, "revision", &revision_id).await?;
    if entry["configuration_id"] != id {
        return Err(ApiError::missing());
    }
    Ok(Json(entry))
}

pub(crate) async fn full_history(
    conn: &mut SqliteConnection,
    id: &str,
    kind: &str,
) -> Result<Vec<Value>> {
    let sequence = match kind {
        "revision" => "revision",
        "version" => "number",
        _ => return Err(ApiError::missing()),
    };
    let rows:Vec<String>=sqlx::query_scalar(&format!("SELECT data FROM records WHERE kind='{kind}' AND json_extract(data,'$.configuration_id')=? ORDER BY CAST(json_extract(data,'$.{sequence}') AS INTEGER) DESC,id"))
        .bind(id).fetch_all(conn).await?;
    rows.iter()
        .map(|row| db::parse(row).map(|v| db::normalize_variables(kind, v)))
        .collect()
}

pub(crate) fn ensure_editable(configuration: &Value) -> Result<()> {
    if configuration["archived"] == true {
        return Err(ApiError::conflict(
            "Pipeline is archived; unarchive it before editing or publishing",
        ));
    }
    Ok(())
}

fn check_revision(configuration: &Value, input: &Value) -> Result<()> {
    let revision = input["revision"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| ApiError::invalid("revision must be a positive integer"))?;
    if Some(revision) != configuration["revision"].as_u64() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Pipeline changed; reload before continuing",
        ));
    }
    Ok(())
}

pub(crate) async fn action(
    conn: &mut SqliteConnection,
    id: &str,
    action: &str,
    input: &Value,
    actor: &Value,
) -> Result<Value> {
    let mut configuration = db::record(conn, "configuration", id).await?;
    check_revision(&configuration, input)?;
    let current_revision = configuration["revision"].clone();
    let message;
    let source;
    match action {
        "duplicate" => {
            let name = db::string(input, "name", 120)?;
            let description = if input.get("description").is_some() {
                if !input["description"].is_string() {
                    return Err(ApiError::invalid("Description must be text"));
                }
                api::description(input)?.to_owned()
            } else {
                configuration["description"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned()
            };
            let copied = json!({"id":db::id(),"name":name,"description":description,"revision":1,"config":configuration["config"],"graph":configuration["graph"],"variables":configuration.get("variables").cloned().unwrap_or_else(||json!([])),"archived":false,"archived_at":null,"created_at":db::now(),"updated_at":db::now()});
            api::validate_draft(&copied)?;
            db::insert(conn, "configuration", &copied).await?;
            api::revision(
                conn,
                &copied,
                actor,
                "Duplicated saved pipeline",
                Some(json!({"kind":"draft","id":id,"revision":current_revision})),
            )
            .await?;
            db::audit(
                conn,
                api::text(actor, "id"),
                "configuration.duplicate",
                api::text(&copied, "id"),
                "success",
            )
            .await?;
            return Ok(copied);
        }
        "archive" | "unarchive" => {
            let archived = action == "archive";
            if (configuration["archived"] == true) == archived {
                return Err(ApiError::conflict(if archived {
                    "Pipeline is already archived"
                } else {
                    "Pipeline is not archived"
                }));
            }
            configuration["archived"] = json!(archived);
            configuration["archived_at"] = if archived {
                json!(db::now())
            } else {
                Value::Null
            };
            message = if archived {
                "Archived pipeline"
            } else {
                "Unarchived pipeline"
            }
            .to_owned();
            source = None;
        }
        "restore" => {
            ensure_editable(&configuration)?;
            let has_revision = input.get("revision_id").is_some();
            let has_version = input.get("version_id").is_some();
            if has_revision == has_version {
                return Err(ApiError::invalid(
                    "Provide exactly one revision_id or version_id",
                ));
            }
            let (kind, key) = if has_revision {
                ("revision", "revision_id")
            } else {
                ("version", "version_id")
            };
            let source_id = db::string(input, key, 128)?;
            let snapshot = db::record(conn, kind, source_id).await?;
            if snapshot["configuration_id"] != id {
                return Err(ApiError::invalid(
                    "Restore source must belong to this pipeline",
                ));
            }
            configuration["config"] = snapshot["config"].clone();
            configuration["graph"] = snapshot["graph"].clone();
            configuration["variables"] = snapshot
                .get("variables")
                .cloned()
                .unwrap_or_else(|| json!([]));
            api::validate_draft(&configuration)?;
            message = match input.get("message") {
                Some(Value::String(text)) if text.len() <= 2000 => text.clone(),
                Some(_) => {
                    return Err(ApiError::invalid(
                        "Message must be text of at most 2000 bytes",
                    ));
                }
                None => format!(
                    "Restored {kind} {}",
                    if kind == "revision" {
                        &snapshot["revision"]
                    } else {
                        &snapshot["number"]
                    }
                ),
            };
            source = Some(json!({"kind":kind,"id":source_id}));
        }
        _ => return Err(ApiError::missing()),
    }
    configuration["revision"] = json!(current_revision.as_u64().unwrap() + 1);
    configuration["updated_at"] = json!(db::now());
    db::update(conn, "configuration", &configuration).await?;
    api::revision(conn, &configuration, actor, &message, source).await?;
    db::audit(
        conn,
        api::text(actor, "id"),
        &format!("configuration.{action}"),
        id,
        "success",
    )
    .await?;
    Ok(configuration)
}
