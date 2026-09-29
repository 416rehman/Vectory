//! Fleet aggregates for the Overview: what is healthy, what needs an operator
//! and what changed. Everything is computed from stored state with bounded
//! queries; missing data stays missing and nothing is inferred as success.
use crate::{audit, db, error::Result};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Map, Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, HashMap, HashSet};

/// A released version still applying after this long is "stuck".
const STUCK_AFTER_MINUTES: i64 = 10;
/// Scheduled rollouts starting within this window appear with live ones.
const SCHEDULED_WINDOW_HOURS: i64 = 24;
const ROLLOUT_LIMIT: usize = 6;
const NAMES_PER_GROUP: usize = 5;
const IDS_PER_GROUP: usize = 50;
const ACTIVITY_LIMIT: usize = 12;
const ACTIVITY_PAGE: i64 = 100;
const ACTIVITY_PAGES: i64 = 3;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn time(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// Add the richer aggregates to an existing overview object. The original
/// fields stay unchanged so older dashboards keep working.
pub async fn extend(
    conn: &mut SqliteConnection,
    devices: &[Value],
    overview: &mut Value,
) -> Result<()> {
    let live: Vec<&Value> = devices
        .iter()
        .filter(|d| d["status"] != "revoked")
        .collect();
    let managed = live
        .iter()
        .filter(|d| !d["desired_version_id"].is_null())
        .count();
    let on_desired = live.iter().filter(|d| d["status"] == "verified").count();
    let degraded = live
        .iter()
        .filter(|d| data_plane_issue(d).is_some())
        .count();
    let versions = versions(conn, &live).await?;
    let rollouts = rollouts(conn).await?;
    let attention = attention(conn, &live, &versions).await?;
    let names: HashMap<&str, &str> = devices
        .iter()
        .map(|d| (text(d, "id"), text(d, "name")))
        .collect();
    let (activity, hidden) = fleet_activity(conn, &names).await?;
    let versions_total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='version'")
            .fetch_one(&mut *conn)
            .await?;
    let extra = json!({
        "devices_managed": managed,
        "devices_on_desired": on_desired,
        "devices_degraded": degraded,
        "versions_total": versions_total,
        "versions": versions,
        "rollouts": rollouts,
        "attention": attention,
        "fleet_activity": activity,
        "security_events_hidden": hidden,
    });
    if let (Some(target), Value::Object(source)) = (overview.as_object_mut(), extra) {
        target.extend(source);
    }
    Ok(())
}

/// Pipeline name and number for every version a device is assigned.
async fn versions(conn: &mut SqliteConnection, devices: &[&Value]) -> Result<Value> {
    let ids: Vec<&str> = devices
        .iter()
        .filter_map(|d| d["desired_version_id"].as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut out = Map::new();
    if ids.is_empty() {
        return Ok(Value::Object(out));
    }
    let rows = sqlx::query(
        "SELECT v.id, json_extract(v.data,'$.number') AS number,
                json_extract(v.data,'$.configuration_id') AS configuration_id,
                json_extract(c.data,'$.name') AS name
         FROM records v
         LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')
         WHERE v.kind='version' AND v.id IN (SELECT value FROM json_each(?))",
    )
    .bind(json!(ids).to_string())
    .fetch_all(&mut *conn)
    .await?;
    for row in rows {
        out.insert(
            row.get::<String, _>("id"),
            json!({
                "number": row.get::<Option<i64>, _>("number"),
                "configuration_id": row.get::<Option<String>, _>("configuration_id"),
                "configuration_name": row.get::<Option<String>, _>("name"),
            }),
        );
    }
    Ok(Value::Object(out))
}

/// Live and paused rollouts, then scheduled ones starting soon, with progress.
async fn rollouts(conn: &mut SqliteConnection) -> Result<Vec<Value>> {
    let rows: Vec<String> = sqlx::query_scalar(
        "WITH page AS MATERIALIZED (
            SELECT id,data,created_at FROM records
            WHERE kind='deployment' AND json_extract(data,'$.status') IN ('active','paused','scheduled')
            ORDER BY created_at DESC,id ASC LIMIT 50
         ), counts AS MATERIALIZED (
            SELECT t.deployment_id,t.state,count(*) AS n
            FROM page p CROSS JOIN deployment_targets t ON t.deployment_id=p.id
            GROUP BY t.deployment_id,t.state
         )
         SELECT json_object(
            'id',d.id,
            'name',CASE WHEN json_type(d.data,'$.name')='text' THEN substr(json_extract(d.data,'$.name'),1,120) END,
            'configuration_id',json_extract(v.data,'$.configuration_id'),
            'configuration_name',json_extract(c.data,'$.name'),
            'version_id',CASE WHEN json_type(d.data,'$.version_id')='text' THEN json_extract(d.data,'$.version_id') END,
            'version_number',json_extract(v.data,'$.number'),
            'policy',json(CASE WHEN json_type(d.data,'$.policy')='object' THEN 'true' ELSE 'false' END),
            'status',json_extract(d.data,'$.status'),
            'scheduled_at',json_extract(d.data,'$.scheduled_at'),
            'created_at',d.created_at,
            'priority',json_extract(d.data,'$.priority'),
            'rollout_kind',json_extract(d.data,'$.rollout.kind'),
            'canary_size',json_extract(d.data,'$.rollout.canary_size'),
            'batch_size',json_extract(d.data,'$.rollout.batch_size'),
            'target_count',COALESCE((SELECT sum(n) FROM counts WHERE deployment_id=d.id),0),
            'state_counts',json(COALESCE((SELECT json_group_object(state,n) FROM counts WHERE deployment_id=d.id),'{}'))
         ) FROM page d
         LEFT JOIN records v ON v.kind='version' AND v.id=json_extract(d.data,'$.version_id')
         LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')
         ORDER BY d.created_at DESC,d.id ASC",
    )
    .fetch_all(&mut *conn)
    .await?;
    let horizon = Utc::now() + Duration::hours(SCHEDULED_WINDOW_HOURS);
    let mut live = Vec::new();
    let mut scheduled = Vec::new();
    for row in rows {
        let item = db::parse(&row)?;
        if item["status"] == "scheduled" {
            if let Some(at) = time(text(&item, "scheduled_at")) {
                if at <= horizon {
                    scheduled.push((at, item));
                }
            }
        } else {
            live.push(item);
        }
    }
    scheduled.sort_by_key(|(at, _)| *at);
    live.extend(scheduled.into_iter().map(|(_, item)| item));
    live.truncate(ROLLOUT_LIMIT);
    Ok(live)
}

struct Group<'a> {
    cause: &'static str,
    severity: &'static str,
    version_id: Option<&'a str>,
    state: Option<&'a str>,
    devices: Vec<&'a Value>,
    since: Option<String>,
}

/// The first open data-plane issue of a device that verifiably runs the
/// version it was measured on. Anything else (another version, not applied)
/// is not a current delivery problem of this device.
pub fn data_plane_issue(device: &Value) -> Option<&Value> {
    let summary = &device["data_plane"];
    (device["status"] == "verified"
        && summary["version_id"].is_string()
        && summary["version_id"] == device["desired_version_id"])
        .then(|| summary["issues"].as_array().and_then(|list| list.first()))
        .flatten()
}

/// The most common first data-plane issue across a group: title, reason, fix.
/// Issues count as the same condition by code and component: the message
/// quotes each device's own measured rate, so it differs between devices
/// with the same problem.
fn delivery(devices: &[&Value]) -> Option<Value> {
    let mut counts: BTreeMap<(&str, &str), (usize, &Value)> = BTreeMap::new();
    for issue in devices.iter().filter_map(|d| data_plane_issue(d)) {
        let key = (text(issue, "code"), text(issue, "component_id"));
        counts.entry(key).or_insert((0, issue)).0 += 1;
    }
    // The first condition in key order wins a tie, so the pick is stable.
    counts
        .into_values()
        .rev()
        .max_by_key(|(count, _)| *count)
        .map(|(_, issue)| issue.clone())
}

fn reason(devices: &[&Value]) -> Option<String> {
    // Prefer the most common sanitized failure summary the agents reported.
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for device in devices {
        let error = &device["configuration_attempt"]["error"];
        // The error's own summary first, then its first error diagnostic:
        // diagnostics can start with a warning, which is not why it failed.
        let summary = error["message"]
            .as_str()
            .filter(|m| !m.is_empty())
            .or_else(|| {
                error["diagnostics"]
                    .as_array()?
                    .iter()
                    .find(|d| d["severity"] != "warning")?["message"]
                    .as_str()
            })
            .or_else(|| error["code"].as_str());
        if let Some(summary) = summary {
            *counts
                .entry(summary.chars().take(300).collect())
                .or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(summary, _)| summary)
}

/// Devices that need an operator, grouped by cause and ordered by severity.
async fn attention(
    conn: &mut SqliteConnection,
    devices: &[&Value],
    versions: &Value,
) -> Result<Vec<Value>> {
    let mut failed: BTreeMap<(Option<&str>, &str), Vec<&Value>> = BTreeMap::new();
    let mut unknown: BTreeMap<Option<&str>, Vec<&Value>> = BTreeMap::new();
    let mut degraded: BTreeMap<Option<&str>, Vec<&Value>> = BTreeMap::new();
    let (mut offline, mut paused, mut unmanaged, mut applying) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for device in devices {
        let version = device["desired_version_id"].as_str();
        match text(device, "status") {
            state @ ("failed" | "rolled_back") => {
                failed.entry((version, state)).or_default().push(*device)
            }
            "verification_unknown" => unknown.entry(version).or_default().push(*device),
            "offline" => offline.push(*device),
            "paused" => paused.push(*device),
            "unmanaged" => unmanaged.push(*device),
            "applying" => applying.push(*device),
            "verified" if data_plane_issue(device).is_some() => {
                degraded.entry(version).or_default().push(*device)
            }
            _ => {}
        }
    }
    let mut groups: Vec<Group> = Vec::new();
    for ((version_id, state), list) in failed {
        groups.push(Group {
            cause: "failed",
            severity: "danger",
            version_id,
            state: Some(state),
            devices: list,
            since: None,
        });
    }
    for (version_id, list) in degraded {
        let since = list
            .iter()
            .filter_map(|d| data_plane_issue(d)?["since"].as_str())
            .filter_map(time)
            .min()
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        groups.push(Group {
            cause: "degraded",
            severity: "danger",
            version_id,
            state: Some("degraded"),
            devices: list,
            since,
        });
    }
    for (version_id, list) in unknown {
        groups.push(Group {
            cause: "check_required",
            severity: "warning",
            version_id,
            state: Some("verification_unknown"),
            devices: list,
            since: None,
        });
    }
    // Released more than STUCK_AFTER_MINUTES ago and still not applied.
    let pairs: Vec<Value> = applying
        .iter()
        .filter_map(|d| {
            d["assignment"]["id"]
                .as_str()
                .map(|assignment| json!([assignment, text(d, "id")]))
        })
        .collect();
    if !pairs.is_empty() {
        let rows = sqlx::query(
            "SELECT t.device_id,t.released_at FROM deployment_targets t
             JOIN json_each(?) j ON t.deployment_id=json_extract(j.value,'$[0]') AND t.device_id=json_extract(j.value,'$[1]')
             WHERE t.released_at IS NOT NULL AND t.state<>'verified_applied'",
        )
        .bind(Value::Array(pairs).to_string())
        .fetch_all(&mut *conn)
        .await?;
        let cutoff = Utc::now() - Duration::minutes(STUCK_AFTER_MINUTES);
        let released: HashMap<String, DateTime<Utc>> = rows
            .iter()
            .filter_map(|row| {
                let at = time(&row.get::<String, _>("released_at"))?;
                Some((row.get::<String, _>("device_id"), at))
            })
            .filter(|(_, at)| *at < cutoff)
            .collect();
        let mut by_version: BTreeMap<Option<&str>, Vec<&Value>> = BTreeMap::new();
        for device in &applying {
            if released.contains_key(text(device, "id")) {
                by_version
                    .entry(device["desired_version_id"].as_str())
                    .or_default()
                    .push(*device);
            }
        }
        for (version_id, list) in by_version {
            let since = list
                .iter()
                .filter_map(|d| released.get(text(d, "id")))
                .min()
                .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
            groups.push(Group {
                cause: "stuck",
                severity: "warning",
                version_id,
                state: Some("applying"),
                devices: list,
                since,
            });
        }
    }
    if !offline.is_empty() {
        let since = offline
            .iter()
            .filter_map(|d| d["last_seen"].as_str())
            .filter_map(time)
            .min()
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        groups.push(Group {
            cause: "offline",
            severity: "warning",
            version_id: None,
            state: None,
            devices: offline,
            since,
        });
    }
    if !paused.is_empty() {
        groups.push(Group {
            cause: "paused",
            severity: "neutral",
            version_id: None,
            state: None,
            devices: paused,
            since: None,
        });
    }
    if !unmanaged.is_empty() {
        groups.push(Group {
            cause: "unmanaged",
            severity: "neutral",
            version_id: None,
            state: None,
            devices: unmanaged,
            since: None,
        });
    }
    // The rollout a failing group's devices share, and whether it can be rolled
    // back, so Needs you offers Roll back only where the server would allow it.
    let shared = |devices: &[&Value]| -> Option<String> {
        let mut ids = devices.iter().map(|d| d["assignment"]["id"].as_str());
        let first = ids.next().flatten()?;
        ids.all(|id| id == Some(first)).then(|| first.to_owned())
    };
    let wanted: HashSet<String> = groups
        .iter()
        .filter(|group| matches!(group.cause, "failed" | "degraded"))
        .filter_map(|group| shared(&group.devices))
        .collect();
    let available: HashSet<String> = if wanted.is_empty() {
        HashSet::new()
    } else {
        sqlx::query_scalar(
            "SELECT d.id FROM json_each(?) j JOIN records d ON d.kind='deployment' AND d.id=j.value
             WHERE json_type(d.data,'$.rolled_back_by') IS NULL AND json_type(d.data,'$.version_id')='text'
               AND json_extract(d.data,'$.status') IN ('active','paused','completed','cancelled','failed')
               AND EXISTS(SELECT 1 FROM deployment_targets t WHERE t.deployment_id=d.id AND t.generation>0 AND t.state<>'removed' AND t.previous_version_id IS NOT NULL)",
        )
        .bind(json!(wanted).to_string())
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect()
    };
    Ok(groups
        .into_iter()
        .map(|group| {
            let version = group
                .version_id
                .map(|id| versions[id].clone())
                .unwrap_or(Value::Null);
            let deployment = matches!(group.cause, "failed" | "degraded")
                .then(|| shared(&group.devices))
                .flatten();
            let mut item = json!({
                "cause": group.cause,
                "severity": group.severity,
                "count": group.devices.len(),
                "device_ids": group.devices.iter().take(IDS_PER_GROUP).map(|d| text(d, "id")).collect::<Vec<_>>(),
                "device_names": group.devices.iter().take(NAMES_PER_GROUP).map(|d| text(d, "name")).collect::<Vec<_>>(),
                "version_id": group.version_id,
                "version_number": version["number"],
                "configuration_id": version["configuration_id"],
                "configuration_name": version["configuration_name"],
                "state": group.state,
                "since": group.since,
                "reason": if group.cause == "failed" { reason(&group.devices) } else { None },
                "rollback_available": deployment.as_ref().is_some_and(|id| available.contains(id)),
                "deployment_id": deployment,
            });
            if group.cause == "degraded" {
                if let Some(issue) = delivery(&group.devices) {
                    item["title"] = issue["title"].clone();
                    item["reason"] = issue["message"].clone();
                    item["fix"] = issue["hint"].clone();
                    item["code"] = issue["code"].clone();
                    item["component_id"] = issue["component_id"].clone();
                }
            }
            if group.cause == "paused" {
                item["requested"] = json!(
                    group
                        .devices
                        .iter()
                        .filter(|d| d["local_paused"] != true && d["pause_acknowledged"] != true)
                        .count()
                );
                item["local"] =
                    json!(group.devices.iter().filter(|d| d["local_paused"] == true).count());
            }
            item
        })
        .collect())
}

/// Sign-in and account events belong in Security activity, not the fleet feed.
pub fn security_action(action: &str) -> bool {
    action == "bootstrap"
        || action == "login"
        || action.starts_with("login.")
        || action == "logout"
        || action.starts_with("account.")
        || action.starts_with("user.")
        || action.starts_with("mfa.")
        || action.starts_with("signing.")
        || action.starts_with("server.restore_access")
}

/// Actions that change what devices run or how the fleet is organized.
pub fn fleet_action(action: &str, outcome: &str) -> bool {
    match action {
        "configuration.create"
        | "configuration.publish"
        | "configuration.duplicate"
        | "configuration.archive"
        | "configuration.unarchive"
        | "deployment.create"
        | "deployment.schedule"
        | "deployment.pause"
        | "deployment.resume"
        | "deployment.cancel"
        | "deployment.unassign"
        | "deployment.rollback"
        | "deployment.release"
        | "deployment.activate"
        | "deployment.missed"
        | "deployment.refresh_targets"
        | "device.enroll"
        | "device.revoke"
        | "device.retry"
        | "device.recovery_authorize"
        | "device.recovery_complete"
        | "group.create"
        | "group.update"
        | "policy.create"
        | "token.create"
        | "token.revoke"
        | "issue.acknowledge"
        | "issue.reopen" => true,
        "device.apply_state" => matches!(
            outcome,
            "verified_applied" | "failed" | "rolled_back" | "verification_unknown"
        ),
        _ => false,
    }
}

/// Collapse bursts of per-device events into one line with the devices named.
fn collapse(rows: Vec<Value>, names: &HashMap<&str, &str>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for row in rows {
        let action = text(&row, "action").to_owned();
        let device = row["device_id"]
            .as_str()
            .and_then(|id| names.get(id).copied())
            .or_else(|| row["target_name"].as_str())
            .unwrap_or("")
            .to_owned();
        let same = out.last().is_some_and(|last: &Value| {
            last["action"] == action.as_str()
                && match action.as_str() {
                    "deployment.release" => last["target_id"] == row["target_id"],
                    "device.apply_state" => last["outcome"] == row["outcome"],
                    _ => false,
                }
        });
        if same {
            let last = out.last_mut().unwrap();
            last["repeat"] = json!(last["repeat"].as_u64().unwrap_or(1) + 1);
            last["first_at"] = row["created_at"].clone();
            if let Some(list) = last["device_names"].as_array_mut() {
                if !device.is_empty()
                    && list.len() < NAMES_PER_GROUP
                    && !list.iter().any(|name| name == device.as_str())
                {
                    list.push(json!(device));
                }
            }
            continue;
        }
        let mut item = row;
        if matches!(action.as_str(), "deployment.release" | "device.apply_state") {
            item["repeat"] = json!(1);
            item["device_names"] = json!(if device.is_empty() {
                vec![]
            } else {
                vec![device]
            });
        }
        out.push(item);
    }
    out
}

/// Recent fleet changes, newest first, with deployment context attached.
async fn fleet_activity(
    conn: &mut SqliteConnection,
    names: &HashMap<&str, &str>,
) -> Result<(Vec<Value>, usize)> {
    let mut kept = Vec::new();
    let mut hidden = 0;
    for page in 0..ACTIVITY_PAGES {
        let rows = audit::rows(
            conn,
            &audit::Filters::default(),
            ACTIVITY_PAGE,
            page * ACTIVITY_PAGE,
            None,
            None,
            false,
        )
        .await?;
        let exhausted = (rows.len() as i64) < ACTIVITY_PAGE;
        for (row, _) in rows {
            let action = text(&row, "action");
            if security_action(action) {
                hidden += 1;
            } else if fleet_action(action, text(&row, "outcome")) {
                kept.push(row);
            }
        }
        if exhausted || collapse(kept.clone(), names).len() > ACTIVITY_LIMIT {
            break;
        }
    }
    let mut items = collapse(kept, names);
    items.truncate(ACTIVITY_LIMIT);
    enrich(conn, &mut items).await?;
    Ok((items, hidden))
}

/// Name the pipeline, version and target count behind deployment events.
async fn enrich(conn: &mut SqliteConnection, items: &mut [Value]) -> Result<()> {
    let deployments: Vec<&str> = items
        .iter()
        .filter(|item| item["target_kind"] == "deployment")
        .filter_map(|item| item["target_id"].as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let published: Vec<&str> = items
        .iter()
        .filter(|item| item["action"] == "configuration.publish")
        .filter_map(|item| item["target"].as_str())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut context: HashMap<String, Value> = HashMap::new();
    // Devices a rollback returned, for "rolled back r15-demo v3 on edge-02".
    let mut rolled_back_names: HashMap<String, Vec<String>> = HashMap::new();
    if !deployments.is_empty() {
        // A rollback's own pipeline and version are the prior one: lineage
        // names both sides so sentences never point the wrong way.
        let rows = sqlx::query(
            "SELECT d.id,json_extract(c.data,'$.name') AS name,json_extract(v.data,'$.number') AS number,
                    json_type(d.data,'$.policy')='object' AS policy,json_extract(d.data,'$.rollout.kind') AS kind,
                    json_extract(d.data,'$.priority') AS priority,
                    (SELECT count(*) FROM deployment_targets t WHERE t.deployment_id=d.id) AS targets,
                    CASE WHEN json_type(d.data,'$.rolled_back_by')='text' THEN json_extract(d.data,'$.rolled_back_by') END AS rolled_back_by,
                    (SELECT CASE WHEN json_type(bc.data,'$.name')='text' THEN substr(json_extract(bc.data,'$.name'),1,240) END FROM records b JOIN records bv ON bv.kind='version' AND bv.id=json_extract(b.data,'$.version_id') JOIN records bc ON bc.kind='configuration' AND bc.id=json_extract(bv.data,'$.configuration_id') WHERE b.kind='deployment' AND b.id=json_extract(d.data,'$.rolled_back_by')) AS rolled_back_to_name,
                    (SELECT CASE WHEN json_type(bv.data,'$.number')='integer' THEN json_extract(bv.data,'$.number') END FROM records b JOIN records bv ON bv.kind='version' AND bv.id=json_extract(b.data,'$.version_id') WHERE b.kind='deployment' AND b.id=json_extract(d.data,'$.rolled_back_by')) AS rolled_back_to_number,
                    (SELECT count(*) FROM deployment_targets bt WHERE bt.deployment_id=json_extract(d.data,'$.rolled_back_by')) AS rolled_back_devices,
                    (SELECT CASE WHEN json_type(oc.data,'$.name')='text' THEN substr(json_extract(oc.data,'$.name'),1,240) END FROM records o JOIN records ov ON ov.kind='version' AND ov.id=json_extract(o.data,'$.version_id') JOIN records oc ON oc.kind='configuration' AND oc.id=json_extract(ov.data,'$.configuration_id') WHERE o.kind='deployment' AND o.id=json_extract(d.data,'$.rollback_of')) AS rollback_of_name,
                    (SELECT CASE WHEN json_type(ov.data,'$.number')='integer' THEN json_extract(ov.data,'$.number') END FROM records o JOIN records ov ON ov.kind='version' AND ov.id=json_extract(o.data,'$.version_id') WHERE o.kind='deployment' AND o.id=json_extract(d.data,'$.rollback_of')) AS rollback_of_number
             FROM records d
             LEFT JOIN records v ON v.kind='version' AND v.id=json_extract(d.data,'$.version_id')
             LEFT JOIN records c ON c.kind='configuration' AND c.id=json_extract(v.data,'$.configuration_id')
             WHERE d.kind='deployment' AND d.id IN (SELECT value FROM json_each(?))",
        )
        .bind(json!(deployments).to_string())
        .fetch_all(&mut *conn)
        .await?;
        for row in rows {
            let rolled_back_by: Option<String> = row.get("rolled_back_by");
            context.insert(
                row.get::<String, _>("id"),
                json!({
                    "configuration_name": row.get::<Option<String>, _>("name"),
                    "version_number": row.get::<Option<i64>, _>("number"),
                    "policy": row.get::<Option<bool>, _>("policy").unwrap_or(false),
                    "rollout_kind": row.get::<Option<String>, _>("kind"),
                    "priority": row.get::<Option<i64>, _>("priority"),
                    "target_count": row.get::<i64, _>("targets"),
                    "rolled_back_to_configuration_name": row.get::<Option<String>, _>("rolled_back_to_name"),
                    "rolled_back_to_version_number": row.get::<Option<i64>, _>("rolled_back_to_number"),
                    "rolled_back_device_count": rolled_back_by.as_ref().map(|_| row.get::<i64, _>("rolled_back_devices")),
                    "rollback_of_configuration_name": row.get::<Option<String>, _>("rollback_of_name"),
                    "rollback_of_version_number": row.get::<Option<i64>, _>("rollback_of_number"),
                }),
            );
            if let Some(rollback) = rolled_back_by {
                let names: Vec<String> = sqlx::query_scalar(
                    "SELECT substr(d.name,1,240) FROM deployment_targets t JOIN devices d ON d.id=t.device_id WHERE t.deployment_id=? ORDER BY d.name LIMIT ?",
                )
                .bind(&rollback)
                .bind(NAMES_PER_GROUP as i64)
                .fetch_all(&mut *conn)
                .await?;
                rolled_back_names.insert(row.get::<String, _>("id"), names);
            }
        }
    }
    let mut numbers: HashMap<String, i64> = HashMap::new();
    if !published.is_empty() {
        let rows = sqlx::query(
            "SELECT id,json_extract(data,'$.number') AS number FROM records
             WHERE kind='version' AND id IN (SELECT value FROM json_each(?))",
        )
        .bind(json!(published).to_string())
        .fetch_all(&mut *conn)
        .await?;
        for row in rows {
            if let Some(number) = row.get::<Option<i64>, _>("number") {
                numbers.insert(row.get::<String, _>("id"), number);
            }
        }
    }
    for item in items.iter_mut() {
        if let Some(found) = item["target_id"]
            .as_str()
            .filter(|_| item["target_kind"] == "deployment")
            .and_then(|id| context.get(id))
        {
            item["deployment"] = found.clone();
        }
        if item["action"] == "deployment.rollback" {
            if let Some(names) = item["target_id"]
                .as_str()
                .and_then(|id| rolled_back_names.get(id))
            {
                item["device_names"] = json!(names);
            }
        }
        if item["action"] == "configuration.publish" {
            if let Some(number) = item["target"].as_str().and_then(|id| numbers.get(id)) {
                item["version_number"] = json!(number);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_fleet_and_security_events() {
        for action in [
            "login",
            "login.mfa",
            "logout",
            "mfa.confirm",
            "user.create",
            "account.password",
            "bootstrap",
            "signing.rotate",
        ] {
            assert!(security_action(action), "{action}");
            assert!(!fleet_action(action, "success"), "{action}");
        }
        for action in [
            "deployment.create",
            "deployment.release",
            "configuration.publish",
            "device.enroll",
            "group.update",
            "policy.create",
        ] {
            assert!(fleet_action(action, "success"), "{action}");
            assert!(!security_action(action), "{action}");
        }
        // Editing noise and intermediate apply progress stay out of the feed.
        assert!(!fleet_action("configuration.save", "success"));
        assert!(!fleet_action("vrl.synthetic_test", "failed"));
        assert!(!fleet_action("device.apply_state", "downloaded"));
        assert!(fleet_action("device.apply_state", "failed"));
    }

    #[test]
    fn collapses_consecutive_device_events() {
        let names = HashMap::from([("d1", "edge-01"), ("d2", "edge-02"), ("d3", "web-01")]);
        let row = |action: &str, target: &str, device: &str, outcome: &str, at: &str| json!({"action":action,"target_id":target,"device_id":device,"outcome":outcome,"created_at":at,"target_name":null});
        let rows = vec![
            row("deployment.release", "x", "d1", "success", "03"),
            row("deployment.release", "x", "d2", "success", "02"),
            row("deployment.release", "y", "d3", "success", "01"),
            row("device.apply_state", "d1", "d1", "verified_applied", "00"),
        ];
        let out = collapse(rows, &names);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["repeat"], 2);
        assert_eq!(out[0]["device_names"], json!(["edge-01", "edge-02"]));
        assert_eq!(out[0]["first_at"], "02");
        assert_eq!(out[1]["repeat"], 1);
        assert_eq!(out[2]["device_names"], json!(["edge-01"]));
    }

    #[test]
    fn degraded_means_verified_on_the_measured_version_with_an_open_issue() {
        let issue = json!({"code":"DATA_PLANE_SINK_ERRORS","title":"out can't deliver events","message":"m","hint":"h"});
        let device = json!({"status":"verified","desired_version_id":"v2","data_plane":{"version_id":"v2","issues":[issue]}});
        assert_eq!(
            data_plane_issue(&device).unwrap()["code"],
            "DATA_PLANE_SINK_ERRORS"
        );
        let mut other = device.clone();
        other["desired_version_id"] = json!("v3");
        assert!(data_plane_issue(&other).is_none());
        let mut applying = device.clone();
        applying["status"] = json!("applying");
        assert!(data_plane_issue(&applying).is_none());
        let mut healthy = device.clone();
        healthy["data_plane"]["issues"] = json!([]);
        assert!(data_plane_issue(&healthy).is_none());
        assert_eq!(delivery(&[&device, &device]).unwrap()["hint"], "h");
    }

    #[test]
    fn delivery_groups_the_same_condition_despite_different_measured_rates() {
        let device = |component: &str, message: &str| {
            let issue = json!({"code":"DATA_PLANE_SINK_ERRORS","component_id":component,"title":format!("{component} can't deliver events"),"message":message,"hint":"h"});
            json!({"status":"verified","desired_version_id":"v2","data_plane":{"version_id":"v2","issues":[issue]}})
        };
        // Two devices share one failing sink; each message quotes its own rate.
        let a = device(
            "archive",
            "The http sink archive is failing about 12 requests a minute.",
        );
        let b = device(
            "archive",
            "The http sink archive is failing about 9 requests a minute.",
        );
        let c = device(
            "search",
            "The http sink search is failing about 3 requests a minute.",
        );
        for order in [[&c, &a, &b], [&a, &c, &b], [&a, &b, &c]] {
            assert_eq!(
                delivery(&order).unwrap()["component_id"],
                "archive",
                "the condition two devices share wins"
            );
        }
        // A tie picks the same condition whatever the device order.
        assert_eq!(delivery(&[&a, &c]).unwrap()["component_id"], "archive");
        assert_eq!(delivery(&[&c, &a]).unwrap()["component_id"], "archive");
    }

    #[test]
    fn reports_the_most_common_failure_summary() {
        let failed = |message: &str| json!({"configuration_attempt":{"error":{"code":"VALIDATION_FAILED","message":message}}});
        let a = failed("data_dir missing");
        let b = failed("data_dir missing");
        let c = failed("port in use");
        assert_eq!(reason(&[&a, &b, &c]).as_deref(), Some("data_dir missing"));
        let bare = json!({"configuration_attempt":{"error":{"code":"APPLY_FAILED","message":""}}});
        assert_eq!(reason(&[&bare]).as_deref(), Some("APPLY_FAILED"));
        assert_eq!(reason(&[&json!({})]), None);
    }
}
