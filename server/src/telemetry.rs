//! Device telemetry: bounded validation of agent samples, per-device history
//! with range downsampling, and fleet, version and pipeline aggregates.
//!
//! Every number here comes from a device report. A metric no device reported
//! stays null (never zero), and every aggregate states how many devices it
//! covers so a partial fleet can never read as a whole one.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::Row;
use std::collections::{BTreeMap, HashMap};

/// Device-level numbers. Rates are averages over the agent's sampling window;
/// `errors` and `discarded_*` are cumulative counters since Vector started.
pub const DEVICE_FIELDS: &[&str] = &[
    "events_per_second",
    "events_out_per_second",
    "bytes_in_per_second",
    "bytes_out_per_second",
    "errors",
    "errors_per_minute",
    "uptime_seconds",
    "memory_bytes",
    "cpu_seconds",
    "discarded_events",
    "discarded_intentional",
    "discarded_error",
    "filtered_per_minute",
    "dropped_per_minute",
    "buffer_bytes",
    "buffer_events",
    "buffer_utilization",
];
/// Per-component numbers. `events_per_second` is the component's sent rate.
pub const COMPONENT_FIELDS: &[&str] = &[
    "events_per_second",
    "received_events_per_second",
    "received_bytes_per_second",
    "sent_bytes_per_second",
    "errors",
    "errors_per_minute",
    "discarded_events",
    "discarded_intentional",
    "discarded_error",
    "filtered_per_minute",
    "dropped_per_minute",
    "buffer_bytes",
    "buffer_events",
    "buffer_max_events",
    "buffer_max_bytes",
    "buffer_utilization",
    "utilization",
    "latency_mean_seconds",
];
/// Fractions in 0..=1.
const RATIO_FIELDS: &[&str] = &["buffer_utilization", "utilization"];
const MAX_COMPONENTS: usize = 50;
const MAX_OUTPUTS: usize = 16;
const MAX_VALUE: f64 = 1e15;
/// A sample older than max(this, three check-ins) no longer describes "now".
const FRESH_MIN_SECONDS: i64 = 180;
/// Rates that aggregate by sum across devices and by mean across time.
const RATE_FIELDS: &[&str] = &[
    "events_per_second",
    "events_out_per_second",
    "bytes_in_per_second",
    "bytes_out_per_second",
    "errors_per_minute",
    "filtered_per_minute",
    "dropped_per_minute",
];
/// Gauges whose peak within a downsampled step is the useful reading.
const PEAK_FIELDS: &[&str] = &["buffer_bytes", "buffer_events", "buffer_utilization"];
/// Counters and process gauges that keep their latest value within a step.
const LATEST_FIELDS: &[&str] = &[
    "errors",
    "discarded_events",
    "discarded_intentional",
    "discarded_error",
    "uptime_seconds",
    "memory_bytes",
    "cpu_seconds",
];

fn bounded_identifier(value: &str, extra: &[u8], max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || extra.contains(&b))
}
fn metric(v: &Value, key: &str, message: &'static str) -> Result<Option<f64>> {
    if v[key].is_null() {
        return Ok(None);
    }
    let limit = if RATIO_FIELDS.contains(&key) {
        1.0
    } else {
        MAX_VALUE
    };
    v[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= limit)
        .map(Some)
        .ok_or_else(|| ApiError::invalid(message))
}

/// Validate one agent sample against the allowlist. Unknown fields, unbounded
/// labels and out-of-range numbers reject the heartbeat; nothing is clamped.
pub fn validate(v: &Value) -> Result<Value> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let Some(fields) = v.as_object() else {
        return Err(ApiError::invalid("Telemetry contains an unsupported field"));
    };
    if fields
        .keys()
        .any(|k| k != "sampled_at" && k != "components" && !DEVICE_FIELDS.contains(&k.as_str()))
    {
        return Err(ApiError::invalid("Telemetry contains an unsupported field"));
    }
    let time = DateTime::parse_from_rfc3339(db::string(v, "sampled_at", 64)?)
        .map_err(|_| ApiError::invalid("Invalid telemetry timestamp"))?;
    if (Utc::now().signed_duration_since(time).num_seconds()).abs() > 86400 {
        return Err(ApiError::invalid(
            "Telemetry sample is outside the retention window",
        ));
    }
    let mut out = json!({"sampled_at":time.to_rfc3339_opts(chrono::SecondsFormat::Secs,true)});
    for key in DEVICE_FIELDS {
        if let Some(n) = metric(
            v,
            key,
            "Telemetry values must be bounded nonnegative numbers",
        )? {
            out[*key] = json!(n);
        }
    }
    if !v["components"].is_null() {
        let components = v["components"]
            .as_array()
            .filter(|c| c.len() <= MAX_COMPONENTS)
            .ok_or_else(|| ApiError::invalid("Telemetry supports at most 50 component samples"))?;
        let mut result = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for component in components {
            if component.as_object().is_none_or(|o| {
                o.keys().any(|k| {
                    !["id", "type", "kind", "sent_by_output"].contains(&k.as_str())
                        && !COMPONENT_FIELDS.contains(&k.as_str())
                })
            }) {
                return Err(ApiError::invalid("Invalid component telemetry fields"));
            }
            let id = db::string(component, "id", 100)?;
            if !bounded_identifier(id, b"_.-", 100) || !seen.insert(id) {
                return Err(ApiError::invalid(
                    "Component telemetry IDs must be unique bounded identifiers",
                ));
            }
            let mut sample = json!({"id":id});
            if !component["type"].is_null() {
                let kind = db::string(component, "type", 64)?;
                if !bounded_identifier(kind, b"_-", 64) {
                    return Err(ApiError::invalid("Invalid component type"));
                }
                sample["type"] = json!(kind);
            }
            if !component["kind"].is_null() {
                let kind = component["kind"].as_str().unwrap_or("");
                if !["source", "transform", "sink"].contains(&kind) {
                    return Err(ApiError::invalid("Invalid component kind"));
                }
                sample["kind"] = json!(kind);
            }
            for key in COMPONENT_FIELDS {
                if let Some(n) = metric(
                    component,
                    key,
                    "Component metrics must be bounded nonnegative numbers",
                )? {
                    sample[*key] = json!(n);
                }
            }
            if !component["sent_by_output"].is_null() {
                let outputs = component["sent_by_output"]
                    .as_object()
                    .filter(|o| o.len() <= MAX_OUTPUTS)
                    .ok_or_else(|| {
                        ApiError::invalid("Component outputs must be a bounded object")
                    })?;
                let mut rates = Map::new();
                for (name, rate) in outputs {
                    let n = rate
                        .as_f64()
                        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= MAX_VALUE);
                    match n {
                        Some(n) if bounded_identifier(name, b"_.-", 100) => {
                            rates.insert(name.clone(), json!(n));
                        }
                        _ => {
                            return Err(ApiError::invalid(
                                "Component outputs must use bounded names and rates",
                            ));
                        }
                    }
                }
                sample["sent_by_output"] = Value::Object(rates);
            }
            result.push(sample);
        }
        out["components"] = json!(result);
    }
    Ok(out)
}

/// History buckets keep device-level readings only. The latest per-component
/// breakdown lives on the device record, which keeps retention storage small.
pub fn history_sample(sample: &Value) -> Value {
    let mut stored = sample.clone();
    if let Some(o) = stored.as_object_mut() {
        o.remove("components");
    }
    stored
}

fn fresh_window(policy: &Value) -> i64 {
    FRESH_MIN_SECONDS.max(policy["heartbeat_seconds"].as_i64().unwrap_or(60) * 3)
}
/// The device's latest sample, if it is recent enough to describe "now".
fn fresh_sample<'a>(device: &'a Value, policy: &Value, now: DateTime<Utc>) -> Option<&'a Value> {
    let sample = &device["telemetry"];
    let at = DateTime::parse_from_rfc3339(sample["sampled_at"].as_str()?).ok()?;
    let age = now.signed_duration_since(at).num_seconds();
    (age <= fresh_window(policy) && age >= -300).then_some(sample)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RangeQuery {
    range: Option<String>,
}
/// The device history endpoint predates query parameters and keeps ignoring
/// unknown ones; the record is always selected by the path alone.
#[derive(Default, Deserialize)]
pub struct DeviceRangeQuery {
    range: Option<String>,
}
/// (minutes covered, step minutes). Steps keep every response at most 360 points.
fn range(value: &str) -> Result<(i64, i64)> {
    let (minutes, step) = match value {
        "15m" => (15, 1),
        "1h" => (60, 1),
        "2h" => (120, 1),
        "6h" => (360, 1),
        "24h" => (1440, 5),
        "7d" => (10080, 30),
        "30d" => (43200, 120),
        _ => {
            return Err(ApiError::invalid(
                "range must be 15m, 1h, 2h, 6h, 24h, 7d or 30d",
            ));
        }
    };
    Ok((minutes.min(db::telemetry_retention_days() * 1440), step))
}
fn bucket_time(bucket: i64) -> String {
    DateTime::<Utc>::from_timestamp(bucket * 60, 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Downsample chronological minute samples into `step`-minute points: rates are
/// averaged, buffer gauges keep their peak, counters keep their latest value.
fn downsample(rows: Vec<(i64, Value)>, step: i64) -> Vec<Value> {
    let mut slots: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for (bucket, sample) in rows {
        slots
            .entry(bucket.div_euclid(step))
            .or_default()
            .push(sample);
    }
    slots
        .into_iter()
        .map(|(slot, samples)| {
            let mut point = json!({
                "bucket": slot * step,
                "sampled_at": samples.last().and_then(|s| s["sampled_at"].as_str()).map_or_else(|| bucket_time(slot * step), str::to_owned),
                "samples": samples.len(),
            });
            for key in RATE_FIELDS {
                let values: Vec<f64> = samples.iter().filter_map(|s| s[*key].as_f64()).collect();
                if !values.is_empty() {
                    point[*key] = json!(values.iter().sum::<f64>() / values.len() as f64);
                }
            }
            for key in PEAK_FIELDS {
                if let Some(peak) = samples
                    .iter()
                    .filter_map(|s| s[*key].as_f64())
                    .reduce(f64::max)
                {
                    point[*key] = json!(peak);
                }
            }
            for key in LATEST_FIELDS {
                if let Some(latest) = samples.iter().rev().find_map(|s| s[*key].as_f64()) {
                    point[*key] = json!(latest);
                }
            }
            point
        })
        .collect()
}

/// `GET /devices/{id}/telemetry[?range=]`. Without a range this keeps the
/// original contract (up to 120 raw minute buckets). With a range it returns
/// at most 360 downsampled points over the requested window.
pub async fn device_history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<DeviceRangeQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=?")
        .bind(&id)
        .fetch_one(&s.pool)
        .await?;
    if exists == 0 {
        return Err(ApiError::missing());
    }
    let Some(requested) = input.range else {
        let rows = sqlx::query(
            "SELECT bucket,data FROM telemetry WHERE device_id=? ORDER BY bucket DESC LIMIT 120",
        )
        .bind(&id)
        .fetch_all(&s.pool)
        .await?;
        let mut samples = Vec::new();
        for row in rows.into_iter().rev() {
            let mut sample = db::parse(row.get("data"))?;
            sample["bucket"] = json!(row.get::<i64, _>("bucket"));
            samples.push(sample);
        }
        return Ok(Json(json!({"device_id":id,"samples":samples})));
    };
    let (minutes, step) = range(&requested)?;
    let end = Utc::now().timestamp() / 60;
    let start = end - minutes + 1;
    let rows = sqlx::query(
        "SELECT bucket,data FROM telemetry WHERE device_id=? AND bucket>=? ORDER BY bucket",
    )
    .bind(&id)
    .bind(start)
    .fetch_all(&s.pool)
    .await?;
    let mut samples = Vec::with_capacity(rows.len());
    for row in rows {
        samples.push((
            row.get::<i64, _>("bucket"),
            history_sample(&db::parse(row.get("data"))?),
        ));
    }
    Ok(Json(json!({
        "device_id": id,
        "range": requested,
        "step_seconds": step * 60,
        "from": bucket_time(start),
        "to": bucket_time(end + 1),
        "samples": downsample(samples, step),
    })))
}

/// Sums device readings, remembering how many devices contributed to each.
#[derive(Default)]
struct Totals {
    sums: BTreeMap<&'static str, (f64, usize)>,
    peaks: BTreeMap<&'static str, f64>,
}
impl Totals {
    fn add(&mut self, key: &'static str, value: Option<f64>) {
        if let Some(v) = value {
            let entry = self.sums.entry(key).or_insert((0.0, 0));
            entry.0 += v;
            entry.1 += 1;
        }
    }
    fn peak(&mut self, key: &'static str, value: Option<f64>) {
        if let Some(v) = value {
            let entry = self.peaks.entry(key).or_insert(v);
            *entry = entry.max(v);
        }
    }
    fn write(&self, out: &mut Value, keys: &[(&'static str, &'static str)]) {
        for (source, target) in keys {
            out[*target] = self.sums.get(source).map_or(Value::Null, |(v, _)| json!(v));
        }
    }
    fn coverage(&self, keys: &[(&'static str, &'static str)]) -> Value {
        Value::Object(
            keys.iter()
                .map(|(source, target)| {
                    (
                        (*target).to_owned(),
                        json!(self.sums.get(source).map_or(0, |(_, n)| *n)),
                    )
                })
                .collect(),
        )
    }
}
/// (device field, published fleet field)
const FLEET_TOTALS: &[(&str, &str)] = &[
    ("events_per_second", "events_in_per_second"),
    ("events_out_per_second", "events_out_per_second"),
    ("bytes_in_per_second", "bytes_in_per_second"),
    ("bytes_out_per_second", "bytes_out_per_second"),
    ("errors_per_minute", "errors_per_minute"),
    ("filtered_per_minute", "filtered_per_minute"),
    ("dropped_per_minute", "dropped_per_minute"),
];

struct DeviceRow {
    id: String,
    data: Value,
    policy: Value,
}
async fn live_devices(s: &State) -> Result<Vec<DeviceRow>> {
    let rows = sqlx::query("SELECT id,data,policy FROM devices WHERE revoked=0 ORDER BY name")
        .fetch_all(&s.pool)
        .await?;
    rows.into_iter()
        .map(|row| {
            Ok(DeviceRow {
                id: row.get("id"),
                data: db::parse(row.get("data"))?,
                policy: db::parse(row.get("policy"))?,
            })
        })
        .collect()
}

/// `GET /telemetry/summary?range=` — fleet throughput, errors and coverage now,
/// plus a downsampled series for sparklines and the live graph overlay.
pub async fn fleet_summary(
    AppState(s): AppState<State>,
    h: HeaderMap,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<RangeQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let input = crate::deployment_history::query(raw.as_deref(), parsed)?;
    let requested = input.range.unwrap_or_else(|| "1h".into());
    let (minutes, step) = range(&requested)?;
    let now = Utc::now();
    let devices = live_devices(&s).await?;
    let mut totals = Totals::default();
    let (mut reporting, mut disabled, mut no_endpoint) = (0, 0, 0);
    let mut newest: Option<DateTime<Utc>> = None;
    for device in &devices {
        if device.policy["telemetry_enabled"] == false {
            disabled += 1;
            continue;
        }
        if device.data["host_runtime"]["metrics_source"] == "none" {
            no_endpoint += 1;
        }
        let Some(sample) = fresh_sample(&device.data, &device.policy, now) else {
            continue;
        };
        reporting += 1;
        if let Some(at) = sample["sampled_at"]
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        {
            let at = at.with_timezone(&Utc);
            newest = Some(newest.map_or(at, |n| n.max(at)));
        }
        for (field, _) in FLEET_TOTALS {
            totals.add(field, sample[*field].as_f64());
        }
        totals.peak("buffer_utilization", sample["buffer_utilization"].as_f64());
    }
    let end = now.timestamp() / 60;
    let start = end - minutes + 1;
    // Mean per device within each step, then sum across devices: a device
    // reporting every 15 s and one reporting every minute weigh the same.
    let series_rows = sqlx::query(
        "SELECT slot,count(*) AS devices,\
         sum(ein) AS ein,sum(eout) AS eout,sum(epm) AS epm,sum(dpm) AS dpm,max(buf) AS buf \
         FROM (SELECT bucket/?1 AS slot,device_id,\
           avg(json_extract(data,'$.events_per_second')) AS ein,\
           avg(json_extract(data,'$.events_out_per_second')) AS eout,\
           avg(json_extract(data,'$.errors_per_minute')) AS epm,\
           avg(json_extract(data,'$.dropped_per_minute')) AS dpm,\
           max(json_extract(data,'$.buffer_utilization')) AS buf \
           FROM telemetry WHERE bucket>=?2 GROUP BY slot,device_id) \
         GROUP BY slot ORDER BY slot",
    )
    .bind(step)
    .bind(start)
    .fetch_all(&s.pool)
    .await?;
    let series: Vec<Value> = series_rows
        .into_iter()
        .map(|row| {
            let slot: i64 = row.get("slot");
            json!({
                "bucket": slot * step,
                "at": bucket_time(slot * step),
                "devices_reporting": row.get::<i64, _>("devices"),
                "events_in_per_second": row.get::<Option<f64>, _>("ein"),
                "events_out_per_second": row.get::<Option<f64>, _>("eout"),
                "errors_per_minute": row.get::<Option<f64>, _>("epm"),
                "dropped_per_minute": row.get::<Option<f64>, _>("dpm"),
                "buffer_utilization_max": row.get::<Option<f64>, _>("buf"),
            })
        })
        .collect();
    let mut out = json!({
        "generated_at": now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "range": requested,
        "step_seconds": step * 60,
        "from": bucket_time(start),
        "devices_total": devices.len(),
        "devices_reporting": reporting,
        "devices_metrics_disabled": disabled,
        "devices_without_metrics_endpoint": no_endpoint,
        "fresh_seconds": FRESH_MIN_SECONDS,
        "newest_sample_at": newest.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        "buffer_utilization_max": totals.peaks.get("buffer_utilization"),
        "coverage": totals.coverage(FLEET_TOTALS),
        "series": series,
    });
    totals.write(&mut out, FLEET_TOTALS);
    Ok(Json(out))
}

/// The version a device is verified to be running right now, if any: the
/// last verified candidate, while the managed file still matches its digest.
pub fn running_version(device: &Value) -> Option<&str> {
    let marker = &device["verified_configuration_attempt"];
    let version = marker["version_id"].as_str()?;
    let actual = device["actual_sha256"].as_str()?;
    let verified = device["verified_effective_sha256"]
        .as_str()
        .or_else(|| marker["sha256"].as_str())?;
    (actual == verified).then_some(version)
}

#[derive(Default)]
struct ComponentAggregate {
    kind: Option<String>,
    component_type: Option<String>,
    devices: usize,
    totals: Totals,
    outputs: BTreeMap<String, f64>,
}
/// Per-component fields summed across devices, and the published names.
const COMPONENT_SUMS: &[(&str, &str)] = &[
    ("received_events_per_second", "received_events_per_second"),
    ("events_per_second", "sent_events_per_second"),
    ("received_bytes_per_second", "received_bytes_per_second"),
    ("sent_bytes_per_second", "sent_bytes_per_second"),
    ("errors_per_minute", "errors_per_minute"),
    ("filtered_per_minute", "filtered_per_minute"),
    ("dropped_per_minute", "dropped_per_minute"),
    ("buffer_events", "buffer_events"),
    ("buffer_bytes", "buffer_bytes"),
];
/// Per-component fields where the worst device is the useful reading.
const COMPONENT_PEAKS: &[(&str, &str)] = &[
    ("buffer_utilization", "buffer_utilization_max"),
    ("utilization", "utilization_max"),
    ("latency_mean_seconds", "latency_mean_seconds_max"),
];

/// Aggregate the fresh samples of `devices` per component ID.
fn aggregate(devices: &[(&DeviceRow, &Value)]) -> Value {
    let mut components: BTreeMap<String, ComponentAggregate> = BTreeMap::new();
    let mut totals = Totals::default();
    let (mut oldest, mut newest): (Option<String>, Option<String>) = (None, None);
    for (_, sample) in devices {
        for (field, _) in FLEET_TOTALS {
            totals.add(field, sample[*field].as_f64());
        }
        if let Some(at) = sample["sampled_at"].as_str() {
            if oldest.as_deref().is_none_or(|o| at < o) {
                oldest = Some(at.to_owned());
            }
            if newest.as_deref().is_none_or(|n| at > n) {
                newest = Some(at.to_owned());
            }
        }
        for c in sample["components"].as_array().into_iter().flatten() {
            let Some(id) = c["id"].as_str() else { continue };
            let entry = components.entry(id.to_owned()).or_default();
            entry.devices += 1;
            if entry.kind.is_none() {
                entry.kind = c["kind"].as_str().map(str::to_owned);
            }
            if entry.component_type.is_none() {
                entry.component_type = c["type"].as_str().map(str::to_owned);
            }
            for (field, _) in COMPONENT_SUMS {
                entry.totals.add(field, c[*field].as_f64());
            }
            for (field, _) in COMPONENT_PEAKS {
                entry.totals.peak(field, c[*field].as_f64());
            }
            for (output, rate) in c["sent_by_output"].as_object().into_iter().flatten() {
                if let Some(rate) = rate.as_f64() {
                    *entry.outputs.entry(output.clone()).or_default() += rate;
                }
            }
        }
    }
    let components: Vec<Value> = components
        .into_iter()
        .map(|(id, c)| {
            let mut out = json!({"id":id,"kind":c.kind,"type":c.component_type,"devices_reporting":c.devices});
            c.totals.write(&mut out, COMPONENT_SUMS);
            for (field, target) in COMPONENT_PEAKS {
                out[*target] = c.totals.peaks.get(field).map_or(Value::Null, |v| json!(v));
            }
            out["sent_by_output"] = if c.outputs.is_empty() {
                Value::Null
            } else {
                json!(c.outputs)
            };
            out
        })
        .collect();
    let mut out = json!({
        "devices_reporting": devices.len(),
        "oldest_sample_at": oldest,
        "newest_sample_at": newest,
        "coverage": totals.coverage(FLEET_TOTALS),
        "components": components,
    });
    totals.write(&mut out, FLEET_TOTALS);
    out
}

async fn running_aggregate(
    s: &State,
    versions: &HashMap<String, i64>,
) -> Result<(Value, BTreeMap<String, (usize, usize)>)> {
    let now = Utc::now();
    let devices = live_devices(s).await?;
    let mut running = 0;
    let mut reporting = Vec::new();
    let mut per_version: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for device in &devices {
        let Some(version) = running_version(&device.data).filter(|v| versions.contains_key(*v))
        else {
            continue;
        };
        running += 1;
        let counts = per_version.entry(version.to_owned()).or_default();
        counts.0 += 1;
        if device.policy["telemetry_enabled"] == false {
            continue;
        }
        if let Some(sample) = fresh_sample(&device.data, &device.policy, now) {
            counts.1 += 1;
            reporting.push((device, sample));
        }
    }
    let mut out = aggregate(&reporting);
    out["generated_at"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    out["devices_running"] = json!(running);
    out["device_ids"] = json!(
        reporting
            .iter()
            .map(|(d, _)| d.id.clone())
            .collect::<Vec<_>>()
    );
    Ok((out, per_version))
}

/// `GET /versions/{id}/telemetry` — per-component rates summed across the
/// devices verified to be running this exact version, with coverage.
pub async fn version_telemetry(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let version = {
        let mut conn = s.pool.acquire().await?;
        db::record(&mut conn, "version", &id).await?
    };
    let versions = HashMap::from([(id.clone(), version["number"].as_i64().unwrap_or(0))]);
    let (mut out, _) = running_aggregate(&s, &versions).await?;
    out["version_id"] = json!(id);
    out["configuration_id"] = version["configuration_id"].clone();
    out["version_number"] = version["number"].clone();
    Ok(Json(out))
}

/// `GET /configurations/{id}/telemetry` — the same aggregate across every
/// version of one pipeline, with a per-version coverage breakdown.
pub async fn configuration_telemetry(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let rows = {
        let mut conn = s.pool.acquire().await?;
        db::record(&mut conn, "configuration", &id).await?;
        sqlx::query("SELECT id,json_extract(data,'$.number') AS number FROM records WHERE kind='version' AND json_extract(data,'$.configuration_id')=?")
            .bind(&id)
            .fetch_all(&mut *conn)
            .await?
    };
    let versions: HashMap<String, i64> = rows
        .into_iter()
        .map(|row| {
            (
                row.get("id"),
                row.get::<Option<i64>, _>("number").unwrap_or(0),
            )
        })
        .collect();
    let (mut out, per_version) = running_aggregate(&s, &versions).await?;
    let mut breakdown: Vec<Value> = per_version
        .into_iter()
        .map(|(version, (running, reporting))| json!({"version_id":version,"version_number":versions.get(&version),"devices_running":running,"devices_reporting":reporting}))
        .collect();
    breakdown.sort_by_key(|v| std::cmp::Reverse(v["version_number"].as_i64().unwrap_or(0)));
    out["configuration_id"] = json!(id);
    out["versions"] = json!(breakdown);
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn telemetry_preserves_unavailability_and_bounds_component_cardinality() {
        let minimal = json!({"sampled_at":db::now()});
        let result = validate(&minimal).unwrap();
        assert!(result.get("errors").is_none());
        assert!(result.get("memory_bytes").is_none());
        assert!(result.get("components").is_none());
        let measured = json!({"sampled_at":db::now(),"uptime_seconds":12,"cpu_seconds":0,"components":[{"id":"web_ingest","type":"http_server","events_per_second":2.5,"errors":0}]});
        assert_eq!(validate(&measured).unwrap()["components"][0]["errors"], 0.0);
        let mut invalid = measured.clone();
        invalid["components"][0]["tenant"] = json!("unbounded-label");
        assert!(validate(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["memory_bytes"] = json!(-1);
        assert!(validate(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["components"] = json!(vec![measured["components"][0].clone(); 51]);
        assert!(validate(&invalid).is_err());
        let mut invalid = measured.clone();
        invalid["components"] = json!(vec![measured["components"][0].clone(); 2]);
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn rich_component_metrics_are_bounded() {
        let sample = json!({"sampled_at":db::now(),"events_per_second":10,"events_out_per_second":9,"errors_per_minute":0,"discarded_intentional":4,"discarded_error":1,"buffer_utilization":0.25,"components":[{"id":"by_severity","type":"route","kind":"transform","received_events_per_second":10,"events_per_second":10,"sent_by_output":{"errors":1,"_unmatched":9},"utilization":0.01,"latency_mean_seconds":0.0001}]});
        let valid = validate(&sample).unwrap();
        assert_eq!(valid["components"][0]["sent_by_output"]["errors"], 1.0);
        assert_eq!(valid["components"][0]["kind"], "transform");
        for (path, value) in [
            ("/buffer_utilization", json!(1.5)),
            ("/components/0/utilization", json!(2)),
            ("/components/0/kind", json!("pipe")),
            ("/components/0/sent_by_output", json!({"bad name":1})),
            ("/components/0/sent_by_output", json!({"errors":-1})),
            (
                "/components/0/sent_by_output",
                json!(
                    (0..17)
                        .map(|i| (format!("o{i}"), json!(1)))
                        .collect::<Map<_, _>>()
                ),
            ),
            ("/events_out_per_second", json!("fast")),
        ] {
            let mut invalid = sample.clone();
            *invalid.pointer_mut(path).unwrap() = value;
            assert!(validate(&invalid).is_err(), "{path}");
        }
        let mut unknown = sample.clone();
        unknown["cpu_percent"] = json!(3);
        assert!(validate(&unknown).is_err());
    }
    #[test]
    fn downsampling_averages_rates_keeps_peaks_and_latest_counters() {
        let rows = vec![
            (
                100,
                json!({"sampled_at":"a","events_per_second":10.0,"buffer_utilization":0.1,"errors":5.0}),
            ),
            (
                101,
                json!({"sampled_at":"b","events_per_second":20.0,"buffer_utilization":0.4,"errors":7.0}),
            ),
            (102, json!({"sampled_at":"c","errors":8.0})),
            (106, json!({"sampled_at":"d","events_per_second":4.0})),
        ];
        let points = downsample(rows, 5);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0]["bucket"], 100);
        assert_eq!(points[0]["events_per_second"], 15.0);
        assert_eq!(points[0]["buffer_utilization"], 0.4);
        assert_eq!(points[0]["errors"], 8.0);
        assert_eq!(points[0]["sampled_at"], "c");
        assert_eq!(points[0]["samples"], 3);
        assert!(points[1].get("errors").is_none(), "missing stays missing");
        assert_eq!(points[1]["bucket"], 105);
    }
    #[test]
    fn running_version_requires_the_verified_digest_to_still_be_current() {
        let device = json!({"actual_sha256":"a","verified_effective_sha256":"a","verified_configuration_attempt":{"version_id":"v1","sha256":"a"}});
        assert_eq!(running_version(&device), Some("v1"));
        let mut drifted = device.clone();
        drifted["actual_sha256"] = json!("b");
        assert_eq!(running_version(&drifted), None);
        assert_eq!(running_version(&json!({"actual_sha256":"a"})), None);
    }
    #[test]
    fn range_bounds_are_explicit() {
        assert_eq!(range("1h").unwrap(), (60, 1));
        assert_eq!(range("7d").unwrap().1, 30);
        assert!(range("1y").is_err());
        for value in ["15m", "1h", "2h", "6h", "24h", "7d", "30d"] {
            let (minutes, step) = range(value).unwrap();
            assert!(minutes / step <= 360, "{value}");
        }
    }
}
