//! Durable actor-scoped saved agent-settings creation identities.
//! All creation calls run under the caller's writer lock and live authorization.
use crate::{
    State, api, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

const HISTORY_SQL: &str = "WITH page AS MATERIALIZED (SELECT request_id,policy_id,created_at FROM policy_requests WHERE actor_id=? ORDER BY created_at DESC,request_id DESC LIMIT ? OFFSET ?) SELECT json_object('request_id',p.request_id,'policy_id',p.policy_id,'created_at',p.created_at,'policy_name',CASE WHEN json_type(g.data,'$.name')='text' THEN substr(json_extract(g.data,'$.name'),1,120) ELSE NULL END) FROM page p LEFT JOIN records g ON g.kind='policy' AND g.id=p.policy_id ORDER BY p.created_at DESC,p.request_id DESC";

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    page: Option<u64>,
    page_size: Option<u64>,
}

// Reject duplicate object keys at every nesting level without discarding unknown
// fields: every supplied field remains part of the canonical idempotency binding.
struct UniqueValue(Value);
impl<'de> serde::Deserialize<'de> for UniqueValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                v: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(json!(v)))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(json!(v)))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(json!(v)))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(v)
                    .map(|v| UniqueValue(Value::Number(v)))
                    .ok_or_else(|| E::custom("Invalid number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                v: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(json!(v)))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                v: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(json!(v)))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = vec![];
                while let Some(v) = a.next_element::<UniqueValue>()? {
                    values.push(v.0);
                }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut a: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some((key, value)) = a.next_entry::<String, UniqueValue>()? {
                    if values.insert(key, value.0).is_some() {
                        return Err(serde::de::Error::custom("Duplicate object key"));
                    }
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        d.deserialize_any(Visitor)
    }
}
// Devices currently governed by a saved template: their winning settings
// assignment was applied from it, or (for assignments made before templates
// were linked) carries exactly the same settings.
const APPLIED: &str = "applied AS MATERIALIZED (SELECT dv.id AS device_id,substr(dv.name,1,240) AS device_name,json_extract(dep.data,'$.policy_id') AS policy_id,json_extract(dep.data,'$.policy.heartbeat_seconds') AS heartbeat,json_extract(dep.data,'$.policy.sync_paused') AS paused,json_extract(dep.data,'$.policy.telemetry_enabled') AS telemetry FROM devices dv JOIN records dep ON dep.kind='deployment' AND dep.id=dv.policy_assignment_id WHERE dv.revoked=0)";
const APPLIED_MATCH: &str = "(a.policy_id=p.id OR (a.policy_id IS NULL AND a.heartbeat=json_extract(p.data,'$.policy.heartbeat_seconds') AND a.paused=json_extract(p.data,'$.policy.sync_paused') AND a.telemetry=json_extract(p.data,'$.policy.telemetry_enabled')))";
fn saved_settings_query(single: bool) -> String {
    format!(
        "WITH {APPLIED} SELECT json_object('id',p.id,'name',json_extract(p.data,'$.name'),'policy',json_extract(p.data,'$.policy'),'created_at',json_extract(p.data,'$.created_at'),\
         'updated_at',json_extract(p.data,'$.updated_at'),'revision',COALESCE(json_extract(p.data,'$.revision'),0),\
         'applied_device_count',(SELECT count(*) FROM applied a WHERE {APPLIED_MATCH}),\
         'outdated_device_count',(SELECT count(*) FROM applied a WHERE a.policy_id=p.id AND NOT (a.heartbeat IS json_extract(p.data,'$.policy.heartbeat_seconds') AND a.paused IS json_extract(p.data,'$.policy.sync_paused') AND a.telemetry IS json_extract(p.data,'$.policy.telemetry_enabled'))),\
         'applied_devices',json(COALESCE((SELECT json_group_array(json_object('id',x.device_id,'name',x.device_name)) FROM (SELECT a.device_id,a.device_name FROM applied a WHERE {APPLIED_MATCH} ORDER BY a.device_name COLLATE NOCASE,a.device_id LIMIT 20) x),'[]'))) \
         FROM records p WHERE p.kind='policy'{} ORDER BY p.created_at DESC,p.id",
        if single { " AND p.id=?" } else { "" }
    )
}
pub async fn list(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut conn = s.pool.acquire().await?;
    let rows: Vec<String> = sqlx::query_scalar(&saved_settings_query(false))
        .fetch_all(&mut *conn)
        .await?;
    Ok(Json(json!(
        rows.iter()
            .map(|row| saved_row(row))
            .collect::<Result<Vec<_>>>()?
    )))
}
fn saved_row(row: &str) -> Result<Value> {
    let mut value = db::parse(row)?;
    if value["updated_at"].is_null() {
        value.as_object_mut().unwrap().remove("updated_at");
    }
    Ok(value)
}
async fn saved(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let row: Option<String> = sqlx::query_scalar(&saved_settings_query(true))
        .bind(id)
        .fetch_optional(&mut *db)
        .await?;
    saved_row(&row.ok_or_else(ApiError::missing)?)
}
pub async fn detail(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut conn = s.pool.acquire().await?;
    Ok(Json(saved(&mut conn, &id).await?))
}
/// Editing a saved template never changes a device. Devices keep the settings
/// they were given until someone applies the template again.
pub async fn edit(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    if raw.is_some_and(|r| !r.is_empty()) {
        return Err(ApiError::invalid(
            "Saved settings updates do not accept query parameters",
        ));
    }
    let request: UniqueValue = serde_json::from_slice(&body)
        .map_err(|_| ApiError::invalid("Provide a JSON object without duplicate keys"))?;
    let request = request.0;
    if request.as_object().is_none_or(|fields| {
        fields.len() != 3
            || ["name", "policy", "revision"]
                .iter()
                .any(|key| !fields.contains_key(*key))
    }) {
        return Err(ApiError::invalid(
            "Provide exactly name, policy and revision",
        ));
    }
    let expected = request["revision"]
        .as_u64()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| ApiError::invalid("revision must be a nonnegative safe integer"))?;
    let name = db::string(&request, "name", 120)?.to_owned();
    db::validate_policy(&request["policy"])?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let mut record = db::record(&mut tx, "policy", &id).await?;
    let current = record["revision"].as_u64().unwrap_or(0);
    if current != expected {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "These settings changed since you opened them. Review the latest values before saving.",
        ));
    }
    record["name"] = json!(name);
    record["policy"] = request["policy"].clone();
    record["revision"] = json!(current + 1);
    record["updated_at"] = json!(db::now());
    db::update(&mut tx, "policy", &record).await?;
    db::audit(
        &mut tx,
        api::text(&actor, "id"),
        "policy.update",
        &id,
        "success",
    )
    .await?;
    let result = saved(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(result))
}
pub async fn post(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    if raw.is_some_and(|r| !r.is_empty()) {
        return Err(ApiError::invalid(
            "Policy creation does not accept query parameters",
        ));
    }
    let request: UniqueValue = serde_json::from_slice(&body)
        .map_err(|_| ApiError::invalid("Provide a JSON object without duplicate keys"))?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let value = create(&mut tx, &request.0, api::text(&actor, "id")).await?;
    tx.commit().await?;
    Ok(Json(value))
}
async fn result(db: &mut SqliteConnection, id: &str, key: &str) -> Result<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT data FROM records WHERE kind='policy' AND id=?")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let unavailable = || {
        ApiError::conflict(
            "The original saved settings are unavailable; this request ID cannot create another template",
        )
    };
    let v = db::parse(&raw.ok_or_else(unavailable)?)?;
    let name = db::string(&v, "name", 120).map_err(|_| unavailable())?;
    db::validate_policy(&v["policy"]).map_err(|_| unavailable())?;
    let at = v["created_at"]
        .as_str()
        .filter(|s| s.len() <= 64 && chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .ok_or_else(unavailable)?;
    // Allowlisted original result, with response-only correlation metadata.
    Ok(
        json!({"id":id,"name":name,"policy":v["policy"],"created_at":at,"request_id":key,"create_idempotency":true}),
    )
}
pub async fn create(db: &mut SqliteConnection, request: &Value, actor: &str) -> Result<Value> {
    let key = crate::deployment_requests::request_id(request)?;
    let mut payload = request.clone();
    payload
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("Policy creation request must be an object"))?
        .remove("request_id");
    let digest = db::hash(format!(
        "vectory-policy-create-v1\n{}",
        crate::deployment_requests::canonical(&payload)
    ));
    if let Some(key) = &key {
        let prior:Option<(String,String)>=sqlx::query_as("SELECT payload_sha256,policy_id FROM policy_requests WHERE actor_id=? AND request_id=?").bind(actor).bind(key).fetch_optional(&mut *db).await?;
        if let Some((old, id)) = prior {
            if old != digest {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "IDEMPOTENCY_CONFLICT",
                    "This request ID already belongs to a different saved-settings request; recover the original result before starting another operation",
                ));
            }
            return result(db, &id, key).await;
        }
    }
    db::validate_policy(&payload["policy"])?;
    let record = json!({"id":db::id(),"name":db::string(&payload,"name",120)?,"policy":payload["policy"],"created_at":db::now()});
    db::insert(db, "policy", &record).await?;
    db::audit(
        db,
        actor,
        "policy.create",
        api::text(&record, "id"),
        "success",
    )
    .await?;
    if let Some(key) = key {
        sqlx::query("INSERT INTO policy_requests(actor_id,request_id,payload_sha256,policy_id,created_at) VALUES(?,?,?,?,?)").bind(actor).bind(&key).bind(digest).bind(api::text(&record,"id")).bind(db::now()).execute(&mut *db).await?;
        result(db, api::text(&record, "id"), &key).await
    } else {
        Ok(record)
    }
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
    let id: Option<String> = sqlx::query_scalar(
        "SELECT policy_id FROM policy_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor["id"].as_str().unwrap())
    .bind(&key)
    .fetch_optional(&mut *tx)
    .await?;
    Ok(Json(match id {
        None => json!({"create_idempotency":true,"request_id":key,"found":false}),
        Some(id) => {
            json!({"create_idempotency":true,"request_id":key,"found":true,"policy":result(&mut tx,&id,&key).await?})
        }
    }))
}
pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let (_, page, size, offset) =
        crate::deployment_history::bounds(None, input.page, input.page_size)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    let actor = actor["id"].as_str().unwrap();
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM policy_requests WHERE actor_id=?")
        .bind(actor)
        .fetch_one(&mut *tx)
        .await?;
    // Materialize only registry metadata for the requested page before joining
    // names; no original request, policy body or arbitrary extensions leave SQL.
    let rows: Vec<String> = sqlx::query_scalar(HISTORY_SQL)
        .bind(actor)
        .bind(size)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|r| db::parse(r))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"create_idempotency":true,"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;
    #[tokio::test]
    async fn history_pages_registry_before_indexed_name_join() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let rows = sqlx::query(&format!("EXPLAIN QUERY PLAN {HISTORY_SQL}"))
            .bind("actor")
            .bind(12)
            .bind(24)
            .fetch_all(&pool)
            .await
            .unwrap();
        let plan = rows
            .iter()
            .map(|r| r.get::<String, _>("detail"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(plan.contains("policy_requests_recent"), "{plan}");
        assert!(plan.contains("MATERIALIZE page"), "{plan}");
        assert!(
            plan.contains("SEARCH g USING INDEX sqlite_autoindex_records_1 (kind=? AND id=?)"),
            "{plan}"
        );
        assert!(!HISTORY_SQL.contains("payload_sha256"));
        assert!(!HISTORY_SQL.contains("$.policy"));
    }
}
