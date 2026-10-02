//! Which devices a canary rollout releases first, and what it watches while
//! it waits.
//!
//! A request can name its canary devices (`rollout.canary_device_ids`). Without
//! a choice the canary is the devices most ready to take a change first:
//! online and healthy, reporting metrics so delivery can be measured; among
//! equally ready devices, device ID order, as rollouts always chose.
//!
//! While the canary waits, `watch` reports what each canary device delivers
//! now beside the same numbers over the minutes before its release, read from
//! the telemetry the server already stores.
use crate::{
    db,
    error::{ApiError, Result},
    rollout,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// Most canary devices a request can name.
pub const MAX_CHOSEN: usize = 100;
/// Canary devices whose numbers a rollout shows; the rest are counted.
pub const WATCHED: usize = 5;
/// The minutes before a release whose readings make the baseline.
pub const BASELINE_MINUTES: i64 = 10;
/// A sample older than this (or three check-ins) no longer describes "now".
const FRESH_SECONDS: i64 = 180;

/// How ready a device is to take a change first, best first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Readiness {
    /// Online, healthy and reporting metrics.
    Ready,
    /// Online and healthy, but it reports no metrics, so its delivery can't be
    /// measured.
    NoMetrics,
    /// Online, but failing or not delivering now.
    Failing,
    /// Online, but its sync is paused: it takes nothing until it resumes.
    Paused,
    /// Not checking in.
    Away,
}
impl Readiness {
    pub fn code(self) -> &'static str {
        match self {
            Readiness::Ready => "ready",
            Readiness::NoMetrics => "no_metrics",
            Readiness::Failing => "failing",
            Readiness::Paused => "paused",
            Readiness::Away => "away",
        }
    }
    /// Why a device ranks where it does, for the review.
    pub fn reason(self) -> &'static str {
        match self {
            Readiness::Ready => "Online and healthy, and it reports metrics",
            Readiness::NoMetrics => "Online and healthy, but it reports no metrics",
            Readiness::Failing => "Online, but failing or not delivering",
            Readiness::Paused => "Online, but its sync is paused",
            Readiness::Away => "Not checking in",
        }
    }
    /// A canary that can't take the change now holds the rollout.
    fn holds_rollout(self) -> bool {
        matches!(
            self,
            Readiness::Failing | Readiness::Paused | Readiness::Away
        )
    }
}

pub struct Ranked {
    pub id: String,
    pub name: String,
    pub readiness: Readiness,
}

/// Devices the request names as its canary, in the order it gave them.
pub fn chosen_ids(rollout: &Value) -> Vec<String> {
    rollout["canary_device_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
fn wave_size(rollout: &Value) -> usize {
    rollout["canary_size"]
        .as_u64()
        .unwrap_or(1)
        .clamp(1, 10_000) as usize
}

/// The devices of `ids` that exist, best canary first: by readiness, then by ID.
pub async fn rank(db: &mut SqliteConnection, ids: &BTreeSet<String>) -> Result<Vec<Ranked>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sqlx::query(
        "SELECT id,name,revoked,policy,policy_generation,json_object(\
           'last_seen',json_extract(data,'$.last_seen'),\
           'policy_generation',json_extract(data,'$.policy_generation'),\
           'heartbeat_floor_seconds',json_extract(data,'$.heartbeat_floor_seconds'),\
           'apply_state',json_extract(data,'$.apply_state'),\
           'local_paused',json_extract(data,'$.local_paused'),\
           'issues',CASE WHEN json_type(data,'$.data_plane.issues')='array' THEN json_array_length(data,'$.data_plane.issues') ELSE 0 END,\
           'sampled_at',json_extract(data,'$.telemetry.sampled_at')) AS evidence \
         FROM devices WHERE id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(ids).to_string())
    .fetch_all(&mut *db)
    .await?;
    let now = Utc::now();
    let mut ranked = Vec::with_capacity(rows.len());
    for row in rows {
        let evidence = db::parse(row.get("evidence"))?;
        let policy = db::parse(&row.get::<String, _>("policy"))?;
        let interval = rollout::check_in_seconds(&policy, &evidence, row.get("policy_generation"));
        let online = !row.get::<bool, _>("revoked")
            && rollout::checked_in_recently(evidence["last_seen"].as_str(), interval);
        let paused = policy["sync_paused"] == true
            || evidence["local_paused"] == true
            || evidence["local_paused"] == 1;
        let failing = matches!(
            evidence["apply_state"].as_str(),
            Some("failed" | "rolled_back" | "verification_unknown")
        ) || evidence["issues"].as_i64().unwrap_or(0) > 0;
        let reporting = evidence["sampled_at"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| {
                let age = now.signed_duration_since(at).num_seconds();
                (-300..=FRESH_SECONDS.max(interval * 3)).contains(&age)
            });
        let readiness = if !online {
            Readiness::Away
        } else if paused {
            Readiness::Paused
        } else if failing {
            Readiness::Failing
        } else if reporting {
            Readiness::Ready
        } else {
            Readiness::NoMetrics
        };
        ranked.push(Ranked {
            id: row.get("id"),
            name: row.get::<Option<String>, _>("name").unwrap_or_default(),
            readiness,
        });
    }
    ranked.sort_by(|a, b| a.readiness.cmp(&b.readiness).then_with(|| a.id.cmp(&b.id)));
    Ok(ranked)
}

/// The canary: the devices the request named that are still eligible, in the
/// order it gave them, then the best of the rest, up to `size`.
pub fn pick(chosen: &[String], ranked: &[Ranked], size: usize) -> Vec<String> {
    let eligible: BTreeSet<&str> = ranked.iter().map(|r| r.id.as_str()).collect();
    let mut picked: Vec<String> = Vec::new();
    for id in chosen {
        if picked.len() < size && eligible.contains(id.as_str()) && !picked.contains(id) {
            picked.push(id.clone());
        }
    }
    for device in ranked {
        if picked.len() >= size {
            break;
        }
        if !picked.contains(&device.id) {
            picked.push(device.id.clone());
        }
    }
    picked
}

/// The order a canary rollout releases `pending` devices in: while nothing has
/// been released, the canary first; everything else, and every later stage, in
/// device ID order as before.
pub async fn release_order(
    db: &mut SqliteConnection,
    d: &Value,
    pending: &[String],
) -> Result<Vec<String>> {
    if d["rollout"]["kind"] != "canary" || pending.is_empty() {
        return Ok(pending.to_vec());
    }
    let ids: BTreeSet<String> = pending.iter().cloned().collect();
    let ranked = rank(db, &ids).await?;
    let first = pick(
        &chosen_ids(&d["rollout"]),
        &ranked,
        wave_size(&d["rollout"]),
    );
    let mut order = first.clone();
    order.extend(pending.iter().filter(|id| !first.contains(id)).cloned());
    Ok(order)
}

/// The canary of a request as the review shows it: who goes first and why, and
/// what to warn about. `Null` when the request isn't a canary.
pub async fn describe(
    db: &mut SqliteConnection,
    rollout: &Value,
    selected: &BTreeSet<String>,
) -> Result<(Value, Vec<String>)> {
    if rollout["kind"] != "canary" {
        return Ok((Value::Null, Vec::new()));
    }
    let ranked = rank(db, selected).await?;
    let by_id: HashMap<&str, &Ranked> = ranked.iter().map(|r| (r.id.as_str(), r)).collect();
    let chosen: Vec<String> = chosen_ids(rollout)
        .into_iter()
        .filter(|id| by_id.contains_key(id.as_str()))
        .collect();
    let size = wave_size(rollout).min(ranked.len().max(1));
    let picked = pick(&chosen, &ranked, size);
    let mut warnings = Vec::new();
    let devices: Vec<Value> = picked
        .iter()
        .filter_map(|id| by_id.get(id.as_str()))
        .map(|device| {
            let named = chosen.contains(&device.id);
            if named && device.readiness.holds_rollout() {
                warnings.push(format!(
                    "{} is a canary but {}. The rollout waits for it.",
                    device.name,
                    match device.readiness {
                        Readiness::Away => "isn't checking in",
                        Readiness::Paused => "has its sync paused",
                        _ => "is failing or not delivering",
                    }
                ));
            }
            json!({
                "device_id": device.id,
                "device_name": device.name,
                "chosen": named,
                "readiness": device.readiness.code(),
                "reason": if named { "You chose it" } else { device.readiness.reason() },
            })
        })
        .collect();
    Ok((
        json!({
            "size": size,
            "chosen_by_you": !chosen.is_empty(),
            "device_ids": picked,
            "devices": devices,
        }),
        warnings,
    ))
}

fn mean(values: &[f64]) -> Value {
    if values.is_empty() {
        Value::Null
    } else {
        json!(values.iter().sum::<f64>() / values.len() as f64)
    }
}
fn number(value: &Value) -> Value {
    value.as_f64().map_or(Value::Null, |n| json!(n))
}

/// What the canary devices of a running canary rollout deliver now, against
/// the minutes before their release. At most `WATCHED` devices, and how many
/// more there are. `Null` for a rollout without a released canary.
pub async fn watch(db: &mut SqliteConnection, d: &Value) -> Result<Value> {
    let (Some(id), Some(version)) = (d["id"].as_str(), d["version_id"].as_str()) else {
        return Ok(Value::Null);
    };
    let first: Option<String> = sqlx::query_scalar(
        "SELECT min(released_at) FROM deployment_targets WHERE deployment_id=? AND generation>0 AND state<>'removed'",
    )
    .bind(id)
    .fetch_one(&mut *db)
    .await?;
    let Some(first) = first else {
        return Ok(Value::Null);
    };
    let members = "FROM deployment_targets t JOIN devices dev ON dev.id=t.device_id \
         WHERE t.deployment_id=? AND t.generation>0 AND t.state<>'removed' AND t.released_at=?";
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) {members}"))
        .bind(id)
        .bind(&first)
        .fetch_one(&mut *db)
        .await?;
    let rows = sqlx::query(&format!(
        "SELECT t.device_id,dev.name,dev.policy,dev.policy_generation,json_object(\
           'last_seen',json_extract(dev.data,'$.last_seen'),\
           'policy_generation',json_extract(dev.data,'$.policy_generation'),\
           'heartbeat_floor_seconds',json_extract(dev.data,'$.heartbeat_floor_seconds'),\
           'sampled_at',json_extract(dev.data,'$.telemetry.sampled_at'),\
           'events_in',json_extract(dev.data,'$.telemetry.events_per_second'),\
           'events_out',json_extract(dev.data,'$.telemetry.events_out_per_second'),\
           'errors',json_extract(dev.data,'$.telemetry.errors_per_minute'),\
           'buffer',json_extract(dev.data,'$.telemetry.buffer_utilization'),\
           'measured_version',json_extract(dev.data,'$.data_plane.version_id'),\
           'evaluations',json_extract(dev.data,'$.data_plane.evaluations')) AS evidence \
         {members} ORDER BY dev.name,t.device_id LIMIT ?"
    ))
    .bind(id)
    .bind(&first)
    .bind(WATCHED as i64)
    .fetch_all(&mut *db)
    .await?;
    let needed = crate::detection::thresholds(db).await?.gate_min_evaluations;
    // What the gate makes of each of these devices right now, by the same
    // predicate that decides whether the rollout may go on.
    let listed: BTreeSet<String> = rows
        .iter()
        .map(|row| row.get::<String, _>("device_id"))
        .collect();
    let proof = crate::canary_gate::evaluate(db, d, Some(&listed)).await?;
    let released = DateTime::parse_from_rfc3339(&first).ok();
    let now = Utc::now();
    let mut devices = Vec::with_capacity(rows.len());
    for row in rows {
        let device: String = row.get("device_id");
        let evidence = db::parse(row.get("evidence"))?;
        let policy = db::parse(&row.get::<String, _>("policy"))?;
        let interval = rollout::check_in_seconds(&policy, &evidence, row.get("policy_generation"));
        let reporting = policy["telemetry_enabled"] == true;
        let fresh = evidence["sampled_at"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| {
                let age = now.signed_duration_since(at).num_seconds();
                (-300..=FRESH_SECONDS.max(interval * 3)).contains(&age)
            });
        let current = (reporting && fresh).then(|| {
            json!({
                "sampled_at": evidence["sampled_at"],
                "events_in_per_second": number(&evidence["events_in"]),
                "events_out_per_second": number(&evidence["events_out"]),
                "errors_per_minute": number(&evidence["errors"]),
                "buffer_utilization": number(&evidence["buffer"]),
            })
        });
        let baseline = match released {
            None => Value::Null,
            Some(at) => {
                let minute = at.timestamp().div_euclid(60);
                let samples = sqlx::query(
                    "SELECT data FROM telemetry WHERE device_id=? AND bucket>=? AND bucket<?",
                )
                .bind(&device)
                .bind(minute - BASELINE_MINUTES)
                .bind(minute)
                .fetch_all(&mut *db)
                .await?;
                let mut columns: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
                for sample in &samples {
                    let data = db::parse(sample.get("data"))?;
                    for key in [
                        "events_per_second",
                        "events_out_per_second",
                        "errors_per_minute",
                        "buffer_utilization",
                    ] {
                        if let Some(value) = data[key].as_f64() {
                            columns.entry(key).or_default().push(value);
                        }
                    }
                }
                let column = |key: &str| mean(columns.get(key).map_or(&[][..], Vec::as_slice));
                if samples.is_empty() {
                    Value::Null
                } else {
                    json!({
                        "minutes": samples.len(),
                        "events_in_per_second": column("events_per_second"),
                        "events_out_per_second": column("events_out_per_second"),
                        "errors_per_minute": column("errors_per_minute"),
                        "buffer_utilization": column("buffer_utilization"),
                    })
                }
            }
        };
        let measured = if evidence["measured_version"].as_str() == Some(version) {
            evidence["evaluations"].as_u64().unwrap_or(0)
        } else {
            0
        };
        devices.push(json!({
            "device_id": device,
            "device_name": row.get::<Option<String>, _>("name"),
            "released_at": first,
            // Why the gate is not counting this device as verified, or null
            // when it is.
            "gate_reason": proof.target_reasons.get(&device).copied().flatten(),
            "now": current,
            "baseline": baseline,
            // How many delivery checks the device has had on this version,
            // against how many the gate needs; none when it reports nothing.
            "samples": reporting.then(|| json!({"measured": measured.min(needed), "needed": needed})),
        }));
    }
    Ok(json!({
        "window_seconds": BASELINE_MINUTES * 60,
        "evaluated_at": db::now(),
        "devices": devices,
        "more": (total as usize).saturating_sub(WATCHED),
    }))
}

/// Refuse a request whose canary devices are not among its targets.
pub fn check_members(rollout: &Value, selected: &BTreeSet<String>) -> Result<()> {
    if chosen_ids(rollout).iter().any(|id| !selected.contains(id)) {
        return Err(ApiError::invalid(
            "Canary devices must be devices this deployment targets",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranked(list: &[(&str, Readiness)]) -> Vec<Ranked> {
        list.iter()
            .map(|(id, readiness)| Ranked {
                id: (*id).to_owned(),
                name: format!("name-{id}"),
                readiness: *readiness,
            })
            .collect()
    }
    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn a_named_canary_goes_first_in_the_order_given_and_the_best_fill_the_rest() {
        let devices = ranked(&[
            ("a", Readiness::Ready),
            ("b", Readiness::NoMetrics),
            ("c", Readiness::Away),
        ]);
        assert_eq!(pick(&[], &devices, 2), ids(&["a", "b"]));
        assert_eq!(pick(&ids(&["c"]), &devices, 1), ids(&["c"]));
        assert_eq!(pick(&ids(&["c", "b"]), &devices, 2), ids(&["c", "b"]));
        // Fewer named than the size: the best of the rest fill in.
        assert_eq!(pick(&ids(&["c"]), &devices, 2), ids(&["c", "a"]));
        // A named device that is no longer a target is skipped, not replaced
        // by a stranger from outside the rollout; the best target takes its place.
        assert_eq!(pick(&ids(&["gone"]), &devices, 1), ids(&["a"]));
        // A duplicate takes one place, and the size bounds the choice.
        assert_eq!(pick(&ids(&["b", "b", "a"]), &devices, 2), ids(&["b", "a"]));
        assert_eq!(pick(&ids(&["a", "b", "c"]), &devices, 1), ids(&["a"]));
    }

    #[test]
    fn readiness_orders_online_healthy_devices_reporting_metrics_first() {
        let mut order = vec![
            Readiness::Away,
            Readiness::Failing,
            Readiness::NoMetrics,
            Readiness::Paused,
            Readiness::Ready,
        ];
        order.sort();
        assert_eq!(
            order,
            [
                Readiness::Ready,
                Readiness::NoMetrics,
                Readiness::Failing,
                Readiness::Paused,
                Readiness::Away
            ]
        );
        for readiness in order {
            assert!(!readiness.reason().is_empty());
        }
    }

    #[test]
    fn a_canary_is_a_target_or_the_request_is_refused() {
        let selected: BTreeSet<String> = ids(&["a", "b"]).into_iter().collect();
        assert!(check_members(&json!({"canary_device_ids": ["a"]}), &selected).is_ok());
        assert!(check_members(&json!({}), &selected).is_ok());
        assert!(check_members(&json!({"canary_device_ids": ["a", "z"]}), &selected).is_err());
    }
}
