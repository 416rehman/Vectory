//! Release keys: the public keys whose signatures hosts trust to install an
//! agent build, who holds each private half (the custody), and how a key is
//! replaced by another.
//!
//! The server stores public keys, their state (`current`, `retired` or
//! `revoked`) and the rollover statements that led from one to the next, all of
//! it public. With custody `server` the private seed lives sealed in
//! `keys/agent-release-<fingerprint>.sealed`; with `offline` it never reaches
//! this server.
use crate::{
    State, auth,
    error::{ApiError, Result},
};
use axum::{Json, extract::State as AppState, http::HeaderMap};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::HashMap;

/// Keys one listing, and the bundle, carry.
pub const MAX_LISTED: i64 = 64;
/// Device names one key lists.
const NAMES_LISTED: usize = 20;

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
    crate::agent_updates::require_on(&mut tx).await?;
    Ok(Json(json!(list(&mut tx).await?)))
}
