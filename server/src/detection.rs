//! Editable data-plane detection thresholds (Settings → Notifications →
//! Detection). Only the numbers an operator can reason about are editable,
//! each within bounds checked here; everything else in `data_plane` stays a
//! constant. With no saved row, or an unreadable one, evaluation uses the
//! built-in defaults, which equal the constants.
use crate::{
    State, auth,
    data_plane::{self, Thresholds},
    db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{State as AppState, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
};
use serde_json::{Map, Value, json};
use sqlx::SqliteConnection;

pub struct Field {
    pub key: &'static str,
    /// Plain words for the audit summary.
    pub label: &'static str,
    /// The unit after a count of one, then after any other count.
    pub one: &'static str,
    pub unit: &'static str,
    pub default: u64,
    pub min: u64,
    pub max: u64,
}
impl Field {
    /// "1 failed request a minute", "20 failed requests a minute", "90%".
    pub fn amount(&self, value: u64) -> String {
        format!("{value}{}", if value == 1 { self.one } else { self.unit })
    }
}
pub const FIELDS: [Field; 5] = [
    Field {
        key: "sink_errors_per_minute",
        label: "Failing destination",
        one: " failed request a minute",
        unit: " failed requests a minute",
        default: data_plane::SINK_ERRORS_PER_MINUTE as u64,
        min: 1,
        max: 10_000,
    },
    Field {
        key: "error_drops_per_minute",
        label: "Dropped events",
        one: " event dropped a minute",
        unit: " events dropped a minute",
        default: data_plane::ERROR_DROPS_PER_MINUTE as u64,
        min: 1,
        max: 100_000,
    },
    Field {
        key: "buffer_full_percent",
        label: "Full buffer",
        one: "%",
        unit: "%",
        default: (data_plane::BUFFER_FULL * 100.0) as u64,
        // Below 55% a buffer is barely out of the "clear" range (under 50%).
        min: 55,
        max: 100,
    },
    Field {
        key: "stall_checks",
        label: "Stalled pipeline",
        one: " check",
        unit: " checks",
        default: data_plane::STALL_SAMPLES,
        min: 2,
        max: 20,
    },
    Field {
        key: "canary_checks",
        label: "Canary measurement",
        one: " check",
        unit: " checks",
        default: data_plane::GATE_MIN_EVALUATIONS,
        min: 1,
        max: 20,
    },
];

/// The values in `FIELDS` order, or why they can't be used.
fn values(v: &Value) -> std::result::Result<[u64; 5], String> {
    let object = v
        .as_object()
        .ok_or_else(|| "thresholds must be an object".to_owned())?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !FIELDS.iter().any(|f| f.key == key.as_str()))
    {
        return Err(format!("Unknown threshold {unknown}"));
    }
    let mut out = [0; 5];
    for (slot, field) in out.iter_mut().zip(FIELDS.iter()) {
        let value = object
            .get(field.key)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{} must be a whole number", field.key))?;
        if !(field.min..=field.max).contains(&value) {
            return Err(format!(
                "{} must be between {} and {}",
                field.key, field.min, field.max
            ));
        }
        *slot = value;
    }
    Ok(out)
}
fn defaults() -> [u64; 5] {
    FIELDS.map(|f| f.default)
}
fn to_thresholds(values: [u64; 5]) -> Thresholds {
    Thresholds {
        sink_errors_per_minute: values[0] as f64,
        error_drops_per_minute: values[1] as f64,
        buffer_full: values[2] as f64 / 100.0,
        stall_samples: values[3],
        gate_min_evaluations: values[4],
    }
}
fn object(values: [u64; 5]) -> Value {
    Value::Object(
        FIELDS
            .iter()
            .zip(values)
            .map(|(f, v)| (f.key.to_owned(), json!(v)))
            .collect::<Map<_, _>>(),
    )
}
async fn stored(
    db: &mut SqliteConnection,
) -> Result<Option<([u64; 5], i64, String, Option<String>)>> {
    let row: Option<(String, i64, String, Option<String>)> = sqlx::query_as(
        "SELECT s.data,s.revision,s.updated_at,substr(u.name,1,120) FROM detection_settings s LEFT JOIN users u ON u.id=s.updated_by WHERE s.id=1",
    )
    .fetch_optional(&mut *db)
    .await?;
    Ok(row.map(|(data, revision, at, name)| {
        let parsed = serde_json::from_str::<Value>(&data)
            .ok()
            .and_then(|v| values(&v).ok())
            .unwrap_or_else(defaults);
        (parsed, revision, at, name)
    }))
}
/// The thresholds evaluation uses now.
pub async fn thresholds(db: &mut SqliteConnection) -> Result<Thresholds> {
    Ok(to_thresholds(
        stored(db).await?.map(|s| s.0).unwrap_or_else(defaults),
    ))
}
async fn read(db: &mut SqliteConnection) -> Result<Value> {
    let current = stored(db).await?;
    let (values, revision, updated_at, updated_by) = match current {
        Some((values, revision, at, name)) => (values, revision, Some(at), name),
        None => (defaults(), 0, None, None),
    };
    let bounds: Map<String, Value> = FIELDS
        .iter()
        .map(|f| (f.key.to_owned(), json!({"min": f.min, "max": f.max})))
        .collect();
    Ok(json!({
        "thresholds": object(values),
        "defaults": object(defaults()),
        "bounds": bounds,
        "revision": revision,
        "updated_at": updated_at,
        "updated_by_name": updated_by,
        "evaluation_interval_seconds": data_plane::EVALUATION_INTERVAL_SECONDS,
    }))
}
/// `GET /api/v1/detection`: any signed-in role may read what drives issues
/// and canary gates.
pub async fn get(AppState(s): AppState<State>, h: HeaderMap) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut conn = s.pool.acquire().await?;
    Ok(Json(read(&mut conn).await?))
}
/// `PUT /api/v1/detection {thresholds,revision}`: administrators only,
/// under the current revision, audited with what changed.
pub async fn put(
    AppState(s): AppState<State>,
    h: HeaderMap,
    input: std::result::Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    let Json(body) = input.map_err(|_| ApiError::invalid("Send thresholds and revision"))?;
    let fields = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("Send thresholds and revision"))?;
    if fields.keys().any(|k| k != "thresholds" && k != "revision") {
        return Err(ApiError::invalid("Send only thresholds and revision"));
    }
    let proposed = values(&body["thresholds"]).map_err(ApiError::invalid)?;
    let revision = body["revision"]
        .as_i64()
        .filter(|n| (0..=9_007_199_254_740_991).contains(n))
        .ok_or_else(|| ApiError::invalid("revision must be a whole number"))?;
    let (_guard, mut tx) = db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let current = stored(&mut tx).await?;
    let (previous, current_revision) = current
        .as_ref()
        .map(|(v, r, _, _)| (*v, *r))
        .unwrap_or_else(|| (defaults(), 0));
    if current_revision != revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Someone changed these thresholds. Review the current values before saving.",
        ));
    }
    if previous == proposed {
        return Ok(Json(read(&mut tx).await?));
    }
    let now = db::now();
    sqlx::query("INSERT INTO detection_settings(id,data,revision,updated_at,updated_by) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
        .bind(object(proposed).to_string())
        .bind(current_revision + 1)
        .bind(&now)
        .bind(actor["id"].as_str().unwrap_or(""))
        .execute(&mut *tx)
        .await?;
    let summary = FIELDS
        .iter()
        .zip(previous.iter().zip(proposed.iter()))
        .filter(|(_, (before, after))| before != after)
        .map(|(f, (before, after))| {
            format!("{}: {} → {}", f.label, f.amount(*before), f.amount(*after))
        })
        .collect::<Vec<_>>()
        .join(". ");
    db::insert(
        &mut tx,
        "audit",
        &json!({
            "id": db::id(),
            "actor": actor["id"],
            "action": "detection.update",
            "target": "data_plane",
            "outcome": "success",
            "created_at": now,
            "details": {"summary": format!("{summary}.")},
        }),
    )
    .await?;
    let out = read(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_equal_the_evaluator_constants() {
        assert_eq!(to_thresholds(defaults()), Thresholds::default());
    }

    #[test]
    fn bounds_are_enforced() {
        let good = object(defaults());
        assert!(values(&good).is_ok());
        for (key, bad) in [
            ("sink_errors_per_minute", json!(0)),
            ("sink_errors_per_minute", json!(10_001)),
            ("buffer_full_percent", json!(54)),
            ("buffer_full_percent", json!(101)),
            ("stall_checks", json!(1)),
            ("canary_checks", json!(21)),
            ("error_drops_per_minute", json!(1.5)),
            ("error_drops_per_minute", json!("5")),
        ] {
            let mut v = good.clone();
            v[key] = bad.clone();
            assert!(values(&v).is_err(), "{key}={bad}");
        }
        let mut unknown = good.clone();
        unknown["refresh_seconds"] = json!(300);
        assert!(values(&unknown).is_err());
        let mut missing = good;
        missing.as_object_mut().unwrap().remove("stall_checks");
        assert!(values(&missing).is_err());
    }
}
