//! Group revision guards shared by explicit edits and device retirement.
use crate::{
    db,
    error::{ApiError, Result},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

const MAX_REVISION: u64 = 9_007_199_254_740_991;

pub fn revision(group: &Value) -> Result<u64> {
    match group.get("revision") {
        None => Ok(0),
        Some(value) => value
            .as_u64()
            .filter(|n| *n <= MAX_REVISION)
            .ok_or_else(|| {
                ApiError::conflict(
                    "Stored group revision is invalid; preserve state and obtain local recovery",
                )
            }),
    }
}

pub fn normalized(mut group: Value) -> Result<Value> {
    group["revision"] = json!(revision(&group)?);
    Ok(group)
}

pub fn next_revision(group: &Value) -> Result<u64> {
    let current = revision(group)?;
    if current == MAX_REVISION {
        return Err(ApiError::conflict(
            "Group revision counter is exhausted; preserve state and obtain local recovery",
        ));
    }
    Ok(current + 1)
}

pub fn check_revision(group: &Value, input: &Value) -> Result<u64> {
    let expected = input
        .get("revision")
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_REVISION)
        .ok_or_else(|| {
            ApiError::invalid("revision must be an integer between 0 and 9007199254740991")
        })?;
    if expected != revision(group)? {
        return Err(ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "STALE_REVISION",
            "Group changed; review its latest membership and details before saving",
        ));
    }
    next_revision(group)
}

pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<Value>> {
    db::records(conn, "group")
        .await?
        .into_iter()
        .map(normalized)
        .collect()
}

/// Called only inside the enclosing serialized revoke/recovery transaction.
/// A retired identity is removed, never exchanged for a same-name replacement.
/// Unrelated groups and repeated revocations keep their revision unchanged.
pub async fn remove_device(conn: &mut SqliteConnection, device: &str) -> Result<()> {
    for mut group in db::records(conn, "group").await? {
        if !group["device_ids"]
            .as_array()
            .is_some_and(|members| members.iter().any(|id| id == device))
        {
            continue;
        }
        let next = next_revision(&group)?;
        group["device_ids"]
            .as_array_mut()
            .unwrap()
            .retain(|id| id != device);
        group["revision"] = json!(next);
        db::update(conn, "group", &group).await?;
    }
    Ok(())
}
