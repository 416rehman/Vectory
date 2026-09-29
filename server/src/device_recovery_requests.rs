//! Secret-free recovery authorization, distinct from enrollment identity recovery.
//! Cancellation revokes only the mapped token, never an issued device identity.
use crate::{
    State, api, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

type Entry = (String, Option<String>, Option<String>, String);
fn source_id(id: &str) -> Result<String> {
    crate::deployment_requests::parse_id(id)
        .map_err(|_| ApiError::invalid("device_id must be a hyphenated UUID"))
}
fn no_query(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|r| !r.is_empty()) {
        return Err(ApiError::invalid(
            "Device recovery requests do not accept query parameters",
        ));
    }
    Ok(())
}
fn conflict() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "IDEMPOTENCY_CONFLICT",
        "This request ID belongs to a different device recovery authorization; check or cancel the original request before starting over",
    )
}
async fn entry(
    db: &mut SqliteConnection,
    actor: &str,
    key: &str,
    device: &str,
) -> Result<Option<Entry>> {
    let prior:Option<Entry>=sqlx::query_as("SELECT device_id,payload_sha256,token_id,state FROM device_recovery_requests WHERE actor_id=? AND request_id=?").bind(actor).bind(key).fetch_optional(db).await?;
    if prior.as_ref().is_some_and(|e| e.0 != device) {
        return Err(conflict());
    }
    Ok(prior)
}
async fn status(db: &mut SqliteConnection, key: &str, e: &Entry) -> Result<Value> {
    let raw: Option<String> = match &e.2 {
        Some(id) => {
            sqlx::query_scalar("SELECT data FROM enrollment_tokens WHERE id=?")
                .bind(id)
                .fetch_optional(db)
                .await?
        }
        None => None,
    };
    let record = match raw {
        Some(raw) => {
            let v = db::parse(&raw)?;
            if v["id"].as_str() != e.2.as_deref()
                || v["recovery_device_id"] != e.0
                || v["max_uses"] != 1
                || !v["name_prefix"].is_null()
                || db::string(&v, "recovery_name", 100).is_err()
                || v["name"] != format!("Recovery for {}", api::text(&v, "recovery_name"))
            {
                return Err(ApiError::conflict(
                    "The original recovery authorization could not be verified",
                ));
            }
            Some(
                json!({"id":e.2,"name":v["name"],"expires_at":v["expires_at"],"uses":v["uses"],"max_uses":v["max_uses"],"name_prefix":v["name_prefix"],"revoked":v["revoked"],"created_at":v["created_at"],"recovery_device_id":e.0,"recovery_name":v["recovery_name"]}),
            )
        }
        None => None,
    };
    if e.3 == "created" && record.is_none() {
        return Err(ApiError::conflict(
            "The original recovery token is unavailable; this request ID cannot create another token. Cancel the request before starting over.",
        ));
    }
    if e.3 == "cancelled" && record.as_ref().is_some_and(|r| r["revoked"] != true) {
        return Err(ApiError::conflict(
            "The cancelled recovery token's revocation could not be confirmed",
        ));
    }
    Ok(
        json!({"request_id":key,"request_correlation":true,"device_id":e.0,"found":true,"state":e.3,"record":record}),
    )
}
pub async fn post(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    no_query(raw.as_deref())?;
    // An absent legacy action body had the same meaning as an empty object.
    let v = if body.is_empty() {
        json!({})
    } else {
        crate::token_requests::parse(&body)?
    };
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let result = create(&mut tx, &id, &v, api::text(&actor, "id")).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn create(
    db: &mut SqliteConnection,
    id: &str,
    request: &Value,
    actor: &str,
) -> Result<Value> {
    let object = request
        .as_object()
        .ok_or_else(|| ApiError::invalid("Device recovery request must be an object"))?;
    if object
        .keys()
        .any(|k| k != "request_id" && k != "expected_name")
    {
        return Err(ApiError::invalid("Unknown device recovery request field"));
    }
    let key = crate::deployment_requests::request_id(request)?;
    let id = if key.is_some() {
        source_id(id)?
    } else {
        id.to_owned()
    };
    let expected = if key.is_some() {
        Some(db::string(request, "expected_name", 100)?)
    } else {
        None
    };
    let mut payload = request.clone();
    payload.as_object_mut().unwrap().remove("request_id");
    let digest = db::hash(format!(
        "vectory-device-recovery-v1\n{id}\n{}",
        crate::deployment_requests::canonical(&payload)
    ));
    if let Some(key) = &key {
        if let Some(prior) = entry(db, actor, key, &id).await? {
            if prior.1.as_ref().is_some_and(|old| old != &digest) {
                return Err(conflict());
            }
            // Retired/deleted source identities and used/expired tokens cannot
            // cause replay to mint another token or restore a previous device.
            return status(db, key, &prior).await;
        }
    } else if !object.is_empty() {
        return Err(ApiError::invalid(
            "A reviewed recovery authorization requires request_id and expected_name",
        ));
    }
    let name: String = sqlx::query_scalar("SELECT name FROM devices WHERE id=?")
        .bind(&id)
        .fetch_optional(&mut *db)
        .await?
        .ok_or_else(ApiError::missing)?;
    if name.contains("#retired-") {
        return Err(ApiError::conflict(
            "This identity has already been replaced",
        ));
    }
    if expected.is_some_and(|n| n != name) {
        return Err(ApiError::conflict(
            "The device name changed; refresh the device before authorizing recovery",
        ));
    }
    let record = json!({"id":db::id(),"name":format!("Recovery for {name}"),"expires_at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"uses":0,"max_uses":1,"name_prefix":Value::Null,"recovery_device_id":id,"recovery_name":name,"revoked":false,"created_at":db::now()});
    let secret = auth::random_secret();
    sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
        .bind(api::text(&record, "id"))
        .bind(db::hash(&secret))
        .bind(record.to_string())
        .execute(&mut *db)
        .await?;
    db::audit(db, actor, "device.recovery_authorize", &id, "success").await?;
    let mut out = json!({"token":secret,"record":record});
    if let Some(key) = key {
        sqlx::query("INSERT INTO device_recovery_requests(actor_id,request_id,device_id,payload_sha256,token_id,state,created_at) VALUES(?,?,?,?,?,'created',?)").bind(actor).bind(&key).bind(&id).bind(digest).bind(api::text(&record,"id")).bind(db::now()).execute(&mut *db).await?;
        out["request_id"] = json!(key);
        out["request_correlation"] = json!(true);
        out["device_id"] = json!(id);
    }
    Ok(out)
}
pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((id, key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let id = source_id(&id)?;
    let key = crate::deployment_requests::parse_id(&key)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], false).await?;
    let result = match entry(&mut tx, api::text(&actor, "id"), &key, &id).await? {
        None => json!({"request_id":key,"request_correlation":true,"device_id":id,"found":false}),
        Some(e) => status(&mut tx, &key, &e).await?,
    };
    Ok(Json(result))
}
pub async fn cancel(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((id, key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    no_query(raw.as_deref())?;
    if crate::token_requests::parse(&body)? != json!({}) {
        return Err(ApiError::invalid(
            "Device recovery cancellation requires an empty object",
        ));
    }
    let id = source_id(&id)?;
    let key = crate::deployment_requests::parse_id(&key)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let actor = api::text(&actor, "id");
    let prior = entry(&mut tx, actor, &key, &id).await?;
    if prior.as_ref().is_none_or(|e| e.3 != "cancelled") {
        if let Some(token) = prior.as_ref().and_then(|e| e.2.as_ref()) {
            let raw: Option<String> =
                sqlx::query_scalar("SELECT data FROM enrollment_tokens WHERE id=?")
                    .bind(token)
                    .fetch_optional(&mut *tx)
                    .await?;
            if let Some(raw) = raw {
                let mut record = db::parse(&raw)?;
                if record["recovery_device_id"] != id {
                    return Err(ApiError::conflict(
                        "The original recovery authorization could not be verified",
                    ));
                }
                if record["revoked"] != true {
                    record["revoked"] = json!(true);
                    sqlx::query("UPDATE enrollment_tokens SET data=? WHERE id=?")
                        .bind(record.to_string())
                        .bind(token)
                        .execute(&mut *tx)
                        .await?;
                    db::audit(&mut tx, actor, "token.revoke", token, "success").await?;
                }
            }
        }
        sqlx::query("INSERT INTO device_recovery_requests(actor_id,request_id,device_id,state,created_at,cancelled_at) VALUES(?,?,?,'cancelled',?,?) ON CONFLICT(actor_id,request_id) DO UPDATE SET state='cancelled',cancelled_at=excluded.cancelled_at").bind(actor).bind(&key).bind(&id).bind(db::now()).bind(db::now()).execute(&mut *tx).await?;
        db::audit(
            &mut tx,
            actor,
            "device.recovery_request.cancel",
            &key,
            "success",
        )
        .await?;
    }
    let current = entry(&mut tx, actor, &key, &id).await?.unwrap();
    let out = status(&mut tx, &key, &current).await?;
    tx.commit().await?;
    Ok(Json(out))
}
