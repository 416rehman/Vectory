//! Secret-free, actor-scoped enrollment-token operation identities.
//! Creation, cancellation and their audits share the serialized writer transaction.
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
use std::collections::HashMap;

// Every supplied field is bound, including unknown fields. Reject duplicate keys
// before canonicalization so two different parsers cannot bind different requests.
struct Unique(Value);
impl<'de> serde::Deserialize<'de> for Unique {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = Unique;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate keys")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("Invalid number"))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Unique, E> {
                Ok(Unique(json!(v)))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = vec![];
                while let Some(x) = a.next_element::<Unique>()? {
                    v.push(x.0)
                }
                Ok(Unique(Value::Array(v)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Unique, A::Error> {
                let mut v = serde_json::Map::new();
                while let Some((k, x)) = a.next_entry::<String, Unique>()? {
                    if v.insert(k, x.0).is_some() {
                        return Err(serde::de::Error::custom("Duplicate key"));
                    }
                }
                Ok(Unique(Value::Object(v)))
            }
        }
        d.deserialize_any(Visitor)
    }
}
pub(crate) fn parse(body: &[u8]) -> Result<Value> {
    serde_json::from_slice::<Unique>(body)
        .map(|v| v.0)
        .map_err(|_| ApiError::invalid("Provide a JSON object without duplicate keys"))
}
fn no_query(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|r| !r.is_empty()) {
        return Err(ApiError::invalid(
            "Token requests do not accept query parameters",
        ));
    }
    Ok(())
}
pub async fn list(state: AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    let s = state.0.clone();
    let Json(tokens) = api::list(state, h, Path("tokens".to_owned())).await?;
    let mut conn = s.pool.acquire().await?;
    Ok(Json(usage(&mut conn, tokens).await?))
}
/// Adds who created each token, when it last enrolled a device and which
/// devices it enrolled (most recent first, at most 20, plus the total).
async fn usage(db: &mut SqliteConnection, tokens: Value) -> Result<Value> {
    let Value::Array(mut tokens) = tokens else {
        return Ok(tokens);
    };
    let users: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id,name FROM users")
            .fetch_all(&mut *db)
            .await?
            .into_iter()
            .collect();
    type Event = (Option<String>, Option<String>, String);
    let created: Vec<Event> = sqlx::query_as(
        "SELECT json_extract(data,'$.target'),json_extract(data,'$.actor'),created_at FROM records WHERE kind='audit' AND json_extract(data,'$.action')='token.create' AND json_extract(data,'$.outcome')='success'",
    )
    .fetch_all(&mut *db)
    .await?;
    let authorized: Vec<Event> = sqlx::query_as(
        "SELECT json_extract(data,'$.target'),json_extract(data,'$.actor'),created_at FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.recovery_authorize' AND json_extract(data,'$.outcome')='success' ORDER BY created_at",
    )
    .fetch_all(&mut *db)
    .await?;
    let enrolled: Vec<(String, String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT e.token_id,d.id,d.name,d.revoked,json_extract(d.data,'$.created_at') AS enrolled_at FROM enrollments e JOIN devices d ON d.id=json_extract(e.response,'$.device_id') ORDER BY enrolled_at DESC,d.id",
    )
    .fetch_all(&mut *db)
    .await?;
    let person = |actor: &Option<String>| {
        actor.as_ref().map_or(
            Value::Null,
            |id| json!({"id":id,"name":users.get(id).map_or(Value::Null,|name|json!(name))}),
        )
    };
    for token in tokens.iter_mut() {
        let id = api::text(token, "id").to_owned();
        let creator = if let Some(device) = token["recovery_device_id"].as_str() {
            // Recovery tokens are issued by the administrator who authorized recovery.
            let at = api::text(token, "created_at");
            authorized
                .iter()
                .rev()
                .find(|(target, _, when)| target.as_deref() == Some(device) && when.as_str() <= at)
                .map(|(_, actor, _)| person(actor))
        } else {
            created
                .iter()
                .find(|(target, ..)| target.as_deref() == Some(id.as_str()))
                .map(|(_, actor, _)| person(actor))
        };
        let devices: Vec<Value> = enrolled
            .iter()
            .filter(|(token_id, ..)| *token_id == id)
            .map(|(_, device, name, revoked, at)| {
                // A recovered device's old record keeps its name with a marker.
                let name = name
                    .split_once("#retired-")
                    .map_or(name.as_str(), |(n, _)| n);
                json!({"id":device,"name":name,"revoked":*revoked != 0,"enrolled_at":at})
            })
            .collect();
        token["created_by"] = creator.unwrap_or(Value::Null);
        token["last_used_at"] = devices
            .first()
            .map_or(Value::Null, |d| d["enrolled_at"].clone());
        token["device_count"] = json!(devices.len());
        token["devices"] = json!(devices.into_iter().take(20).collect::<Vec<_>>());
    }
    Ok(Value::Array(tokens))
}
pub async fn post(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    no_query(raw.as_deref())?;
    let v = parse(&body)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let out = create(&mut tx, &v, api::text(&actor, "id")).await?;
    tx.commit().await?;
    Ok(Json(out))
}
type Entry = (Option<String>, Option<String>, String);
async fn entry(db: &mut SqliteConnection, actor: &str, key: &str) -> Result<Option<Entry>> {
    Ok(sqlx::query_as("SELECT payload_sha256,token_id,state FROM token_requests WHERE actor_id=? AND request_id=?").bind(actor).bind(key).fetch_optional(db).await?)
}
async fn token(db: &mut SqliteConnection, id: &str) -> Result<Option<Value>> {
    let raw: Option<String> = sqlx::query_scalar("SELECT data FROM enrollment_tokens WHERE id=?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    raw.map(|raw| {
        let v=db::parse(&raw)?;
        // Do not leak future recovery-token extensions or arbitrary stored fields.
        Ok(json!({"id":id,"name":v["name"],"expires_at":v["expires_at"],"uses":v["uses"],"max_uses":v["max_uses"],"name_prefix":v["name_prefix"],"revoked":v["revoked"],"created_at":v["created_at"]}))
    }).transpose()
}
async fn status(db: &mut SqliteConnection, key: &str, e: &Entry) -> Result<Value> {
    let record = match &e.1 {
        Some(id) => token(db, id).await?,
        None => None,
    };
    if e.2 == "created" && record.is_none() {
        return Err(ApiError::conflict(
            "The original token is unavailable; this request ID cannot create another token. Cancel the request before starting over.",
        ));
    }
    if e.2 == "cancelled" && record.as_ref().is_some_and(|r| r["revoked"] != true) {
        return Err(ApiError::conflict(
            "The cancelled token's revocation could not be confirmed",
        ));
    }
    Ok(
        json!({"request_id":key,"request_correlation":true,"found":true,"state":e.2,"record":record}),
    )
}
pub async fn create(db: &mut SqliteConnection, request: &Value, actor: &str) -> Result<Value> {
    let key = crate::deployment_requests::request_id(request)?;
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Token creation request must be an object"))?
        .remove("request_id");
    let digest = db::hash(format!(
        "vectory-token-create-v1\n{}",
        crate::deployment_requests::canonical(&payload)
    ));
    if let Some(key) = &key {
        if let Some(prior) = entry(db, actor, key).await? {
            if prior.0.as_ref().is_some_and(|old| old != &digest) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "This request ID belongs to a different token request; check or cancel the original request before starting over",
                ));
            }
            // No secret is recoverable. In particular a cancelled-before-create
            // key is closed permanently even if its original POST arrives later.
            return status(db, key, &prior).await;
        }
    }
    let hours = payload["expires_hours"]
        .as_u64()
        .filter(|h| (1..=720).contains(h))
        .ok_or_else(|| ApiError::invalid("expires_hours must be 1..720"))?;
    let max = payload["max_uses"].as_u64();
    if !payload["max_uses"].is_null() && max.is_none_or(|n| n == 0 || n > 100000) {
        return Err(ApiError::invalid("max_uses must be 1..100000"));
    }
    if key.is_some() && !payload["name_prefix"].is_null() && !payload["name_prefix"].is_string() {
        return Err(ApiError::invalid("name_prefix must be a string or null"));
    }
    let prefix = payload["name_prefix"].as_str().unwrap_or("");
    if prefix.len() > 80
        || !prefix
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(ApiError::invalid(
            "name_prefix must use lowercase letters, digits or hyphens",
        ));
    }
    let record = json!({"id":db::id(),"name":db::string(&payload,"name",120)?,"expires_at":(chrono::Utc::now()+chrono::Duration::hours(hours as i64)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"uses":0,"max_uses":max,"name_prefix":if prefix.is_empty(){Value::Null}else{json!(prefix)},"revoked":false,"created_at":db::now()});
    let secret = auth::random_secret();
    sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
        .bind(api::text(&record, "id"))
        .bind(db::hash(&secret))
        .bind(record.to_string())
        .execute(&mut *db)
        .await?;
    db::audit(
        db,
        actor,
        "token.create",
        api::text(&record, "id"),
        "success",
    )
    .await?;
    let mut out = json!({"token":secret,"record":record});
    if let Some(key) = key {
        sqlx::query("INSERT INTO token_requests(actor_id,request_id,payload_sha256,token_id,state,created_at) VALUES(?,?,?,?,'created',?)").bind(actor).bind(&key).bind(digest).bind(api::text(&record,"id")).bind(db::now()).execute(&mut *db).await?;
        out["request_id"] = json!(key);
        out["request_correlation"] = json!(true);
    }
    Ok(out)
}
pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let key = crate::deployment_requests::parse_id(&id)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let out = match entry(&mut tx, api::text(&actor, "id"), &key).await? {
        None => json!({"request_id":key,"request_correlation":true,"found":false}),
        Some(e) => status(&mut tx, &key, &e).await?,
    };
    Ok(Json(out))
}
pub async fn cancel(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    no_query(raw.as_deref())?;
    if parse(&body)? != json!({}) {
        return Err(ApiError::invalid(
            "Token request cancellation requires an empty object",
        ));
    }
    let key = crate::deployment_requests::parse_id(&id)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let actor = api::text(&actor, "id");
    let prior = entry(&mut tx, actor, &key).await?;
    if prior.as_ref().is_none_or(|e| e.2 != "cancelled") {
        if let Some(id) = prior.as_ref().and_then(|e| e.1.as_ref()) {
            // Preserve the complete original record and all unrelated identities.
            let raw: Option<String> =
                sqlx::query_scalar("SELECT data FROM enrollment_tokens WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            if let Some(raw) = raw {
                let mut record = db::parse(&raw)?;
                if record["revoked"] != true {
                    record["revoked"] = json!(true);
                    sqlx::query("UPDATE enrollment_tokens SET data=? WHERE id=?")
                        .bind(record.to_string())
                        .bind(id)
                        .execute(&mut *tx)
                        .await?;
                    db::audit(&mut tx, actor, "token.revoke", id, "success").await?;
                }
            }
        }
        sqlx::query("INSERT INTO token_requests(actor_id,request_id,state,created_at,cancelled_at) VALUES(?,?,'cancelled',?,?) ON CONFLICT(actor_id,request_id) DO UPDATE SET state='cancelled',cancelled_at=excluded.cancelled_at").bind(actor).bind(&key).bind(db::now()).bind(db::now()).execute(&mut *tx).await?;
        db::audit(&mut tx, actor, "token.request.cancel", &key, "success").await?;
    }
    let current = entry(&mut tx, actor, &key).await?.unwrap();
    let out = status(&mut tx, &key, &current).await?;
    tx.commit().await?;
    Ok(Json(out))
}
