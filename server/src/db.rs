use crate::error::{ApiError, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
tokio::task_local! { pub static REQUEST_ID: String; }
pub fn telemetry_retention_days() -> i64 {
    std::env::var("VECTORY_TELEMETRY_RETENTION_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7)
        .clamp(1, 30)
}
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}
pub fn parse(s: &str) -> Result<Value> {
    serde_json::from_str(s).map_err(|_| {
        ApiError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Stored record is invalid",
        )
    })
}
pub async fn records(db: &mut SqliteConnection, kind: &str) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT data FROM records WHERE kind=? ORDER BY created_at DESC,id")
        .bind(kind)
        .fetch_all(db)
        .await?;
    rows.iter().map(|r| parse(r.get::<&str, _>(0))).collect()
}
pub async fn record(db: &mut SqliteConnection, kind: &str, id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT data FROM records WHERE kind=? AND id=?")
        .bind(kind)
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::missing)?;
    parse(row.get(0))
}
pub async fn insert(db: &mut SqliteConnection, kind: &str, v: &Value) -> Result<()> {
    let audit = if kind == "audit" {
        let mut event = v.clone();
        event["request_id"] = json!(REQUEST_ID.try_with(Clone::clone).unwrap_or_else(|_| id()));
        Some(event)
    } else {
        None
    };
    let v = audit.as_ref().unwrap_or(v);
    sqlx::query("INSERT INTO records(kind,id,data,created_at) VALUES(?,?,?,?)")
        .bind(kind)
        .bind(
            v["id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("Missing ID"))?,
        )
        .bind(v.to_string())
        .bind(v["created_at"].as_str().unwrap_or(&now()))
        .execute(db)
        .await?;
    Ok(())
}
pub async fn update(db: &mut SqliteConnection, kind: &str, v: &Value) -> Result<()> {
    sqlx::query("UPDATE records SET data=? WHERE kind=? AND id=?")
        .bind(v.to_string())
        .bind(kind)
        .bind(
            v["id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("Missing ID"))?,
        )
        .execute(db)
        .await?;
    Ok(())
}
pub async fn audit(
    db: &mut SqliteConnection,
    actor: &str,
    action: &str,
    target: &str,
    outcome: &str,
) -> Result<()> {
    insert(db,"audit",&json!({"id":id(),"actor":actor,"action":action,"target":target,"outcome":outcome,"created_at":now()})).await
}
pub fn string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    let x = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid(format!("{key} must be a string")))?;
    if x.is_empty() || x.len() > max || x.chars().any(|c| c == '\0') {
        return Err(ApiError::invalid(format!(
            "{key} has invalid length or characters"
        )));
    }
    Ok(x)
}
pub fn default_policy() -> Value {
    json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true})
}
pub fn validate_policy(v: &Value) -> Result<()> {
    let interval = v["heartbeat_seconds"]
        .as_u64()
        .ok_or_else(|| ApiError::invalid("heartbeat_seconds must be an integer"))?;
    if !(10..=3600).contains(&interval)
        || !v["sync_paused"].is_boolean()
        || !v["telemetry_enabled"].is_boolean()
        || v.as_object().is_none_or(|o| o.len() != 3)
    {
        return Err(ApiError::invalid(
            "Policy requires heartbeat_seconds 10..3600 and sync_paused/telemetry_enabled booleans",
        ));
    }
    Ok(())
}
