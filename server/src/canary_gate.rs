//! Current canary proof is distinct from retained target history. Reads use the
//! same predicate as advancement and never change observation state.
use crate::{db, error::Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{QueryBuilder, Row, Sqlite, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

pub const REASONS: [&str; 7] = [
    "superseded",
    "stale",
    "paused",
    "unverified",
    "unavailable",
    "measuring",
    "degraded",
];
pub fn enabled(d: &Value) -> bool {
    d["rollout"]["kind"] == "canary" && matches!(d["status"].as_str(), Some("active" | "paused"))
}
pub async fn load(db: &mut SqliteConnection, id: &str) -> Result<Value> {
    let raw:Option<String>=sqlx::query_scalar("SELECT json_object('id',id,'version_id',json_extract(data,'$.version_id'),'policy',json_extract(data,'$.policy'),'status',json_extract(data,'$.status'),'rollout',json_extract(data,'$.rollout'),'target_mode',json_extract(data,'$.target_mode'),'selector',json_extract(data,'$.selector'),'observation_started_at',json_extract(data,'$.observation_started_at'),'observation_evidence',json_extract(data,'$.observation_evidence'),'early_releases',json_extract(data,'$.early_releases')) FROM records WHERE kind='deployment' AND id=?").bind(id).fetch_optional(db).await?;
    raw.map(|s| db::parse(&s))
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}
pub fn clear(d: &mut Value) {
    d["observation_started_at"] = Value::Null;
    d.as_object_mut().unwrap().remove("observation_evidence");
}
pub async fn invalidate_resource(
    db: &mut SqliteConnection,
    device: &str,
    configuration: bool,
) -> Result<()> {
    sqlx::query("UPDATE records SET data=json_remove(json_set(data,'$.observation_started_at',NULL),'$.observation_evidence') WHERE kind='deployment' AND json_extract(data,'$.rollout.kind')='canary' AND json_extract(data,'$.status') IN ('active','paused') AND COALESCE(json_type(data,'$.version_id')='text',0)=? AND EXISTS(SELECT 1 FROM deployment_targets t WHERE t.deployment_id=records.id AND t.device_id=? AND t.generation>0 AND t.state<>'removed')").bind(configuration).bind(device).execute(db).await?;
    Ok(())
}
pub struct Assessment {
    pub released: i64,
    pub verified: i64,
    pub pending: i64,
    pub reasons: BTreeMap<&'static str, i64>,
    pub target_reasons: BTreeMap<String, Option<&'static str>>,
    pub fingerprint: String,
    pub evaluated_at: String,
}
impl Assessment {
    pub fn all_verified(&self) -> bool {
        self.released == self.verified
    }
    pub fn matches_window(&self, d: &Value) -> bool {
        self.released > 0
            && self.all_verified()
            && d["observation_evidence"].as_str() == Some(&self.fingerprint)
    }
    pub fn projection(&self, d: &Value) -> Value {
        let started = d["observation_started_at"].as_str().filter(|at| {
            DateTime::parse_from_rfc3339(at).is_ok_and(|at| {
                DateTime::parse_from_rfc3339(&self.evaluated_at)
                    .is_ok_and(|evaluated| at <= evaluated)
            })
        });
        let observing = d["status"] == "active" && self.matches_window(d) && started.is_some();
        json!({"state":if d["status"]=="paused"{"paused"}else if observing{"observing"}else{"waiting"},"released_count":self.released,"verified_count":self.verified,"pending_count":self.pending,"reasons":self.reasons,"observation_started_at":if observing{json!(started)}else{Value::Null},"observation_seconds":d["rollout"]["observation_seconds"].as_i64().unwrap_or(60).clamp(0,86400),"evaluated_at":self.evaluated_at})
    }
}
// SQL extracts only proof metadata. No telemetry numbers, error diagnostics,
// raw device extension data, configuration body, or artifact enters these
// queries: data-plane health arrives as the evaluated version, evaluation count
// and open-issue count, and telemetry only as its sample time.
const ROWS: &str = "SELECT t.device_id,t.state,t.generation,a.version_id AS artifact_version_id,a.sha256 AS artifact_sha256,d.id AS existing_id,d.revoked,d.desired_version_id,d.desired_generation,d.assignment_id,d.policy_generation,d.policy_assignment_id,d.policy,json_object('last_seen',substr(json_extract(d.data,'$.last_seen'),1,64),'apply_state',substr(json_extract(d.data,'$.apply_state'),1,32),'reported_apply_state',substr(json_extract(d.data,'$.reported_apply_state'),1,32),'reported_generation',json_extract(d.data,'$.reported_generation'),'policy_generation',json_extract(d.data,'$.policy_generation'),'heartbeat_floor_seconds',json_extract(d.data,'$.heartbeat_floor_seconds'),'local_paused',json_extract(d.data,'$.local_paused'),'pause_acknowledged',json_extract(d.data,'$.pause_acknowledged'),'desired_artifact_sha256',substr(json_extract(d.data,'$.desired_artifact_sha256'),1,65),'actual_sha256',substr(json_extract(d.data,'$.actual_sha256'),1,65),'applied_template_sha256',substr(json_extract(d.data,'$.applied_template_sha256'),1,65),'secret_revision',json_extract(d.data,'$.secret_revision'),'verified_secret_revision',json_extract(d.data,'$.verified_secret_revision'),'verified_effective_sha256',substr(json_extract(d.data,'$.verified_effective_sha256'),1,65),'data_plane_version',substr(json_extract(d.data,'$.data_plane.version_id'),1,64),'data_plane_evaluations',json_extract(d.data,'$.data_plane.evaluations'),'data_plane_issues',CASE WHEN json_type(d.data,'$.data_plane.issues')='array' THEN json_array_length(d.data,'$.data_plane.issues') ELSE 0 END,'telemetry_sampled_at',substr(json_extract(d.data,'$.telemetry.sampled_at'),1,64)) AS evidence FROM deployment_targets t LEFT JOIN desired_artifacts a ON a.device_id=t.device_id AND a.generation=t.generation LEFT JOIN devices d ON d.id=t.device_id WHERE t.deployment_id=";
pub async fn evaluate(
    db: &mut SqliteConnection,
    d: &Value,
    only: Option<&BTreeSet<String>>,
) -> Result<Assessment> {
    let config = d["version_id"].is_string();
    let metadata = if config {
        sqlx::query("SELECT json_extract(data,'$.sha256') AS sha,COALESCE(json_extract(data,'$.uses_local_secrets'),0) AS secrets,CASE WHEN json_type(data,'$.variables')='array' THEN json_array_length(data,'$.variables') ELSE 0 END AS variable_count FROM records WHERE kind='version' AND id=?").bind(d["version_id"].as_str().unwrap()).fetch_optional(&mut *db).await?
    } else {
        None
    };
    let sha = metadata
        .as_ref()
        .and_then(|r| r.get::<Option<String>, _>("sha"));
    let secrets = metadata
        .as_ref()
        .is_some_and(|r| r.get::<bool, _>("secrets"));
    let variable_count = metadata
        .as_ref()
        .map(|r| r.get::<i64, _>("variable_count"))
        .unwrap_or(0);
    // Evaluations a device needs on this version before delivery counts as
    // measured (Settings → Notifications → Detection).
    let measured_after = if config {
        crate::detection::thresholds(db).await?.gate_min_evaluations
    } else {
        crate::data_plane::GATE_MIN_EVALUATIONS
    };
    let now = Utc::now();
    let mut digest = Sha256::new();
    let mut out = Assessment {
        released: 0,
        verified: 0,
        pending: 0,
        reasons: REASONS.into_iter().map(|s| (s, 0)).collect(),
        target_reasons: BTreeMap::new(),
        fingerprint: String::new(),
        evaluated_at: db::now(),
    };
    let mut after = String::new();
    loop {
        // Evaluate only queried target identities. Expanding the entire selector
        // here would turn a twelve-row detail page into N device queries.
        let mut q = QueryBuilder::<Sqlite>::new("SELECT ");
        if d["target_mode"] == "persistent" {
            let selector = d["selector"].to_string();
            q.push("(d.revoked=0 AND NOT EXISTS(SELECT 1 FROM json_each(")
                .push_bind(selector.clone()).push(",'$.exclude_ids') e WHERE e.value=t.device_id) AND (EXISTS(SELECT 1 FROM json_each(")
                .push_bind(selector.clone()).push(",'$.device_ids') direct WHERE direct.value=t.device_id) OR EXISTS(SELECT 1 FROM json_each(")
                .push_bind(selector).push(",'$.group_ids') ref JOIN records g ON g.kind='group' AND g.id=ref.value JOIN json_each(g.data,'$.device_ids') member WHERE member.value=t.device_id)))");
        } else {
            q.push("1");
        }
        q.push(" AS member,")
            .push(ROWS.strip_prefix("SELECT ").unwrap());
        q.push_bind(d["id"].as_str().unwrap_or(""))
            .push(" AND t.device_id>")
            .push_bind(after.clone());
        if let Some(ids) = only {
            if ids.is_empty() {
                break;
            }
            q.push(" AND t.device_id IN (");
            let mut sep = q.separated(",");
            for id in ids {
                sep.push_bind(id.clone());
            }
            sep.push_unseparated(")");
        }
        q.push(" ORDER BY t.device_id LIMIT 100");
        let rows = q.build().fetch_all(&mut *db).await?;
        let len = rows.len();
        for row in rows {
            let id: String = row.get("device_id");
            after = id.clone();
            let state: String = row.get("state");
            let generation: i64 = row.get("generation");
            let relevant =
                state != "removed" && row.get::<Option<bool>, _>("member").unwrap_or(false);
            if !relevant || generation <= 0 {
                if relevant && state == "pending" {
                    out.pending += 1;
                }
                if only.is_some() {
                    out.target_reasons.insert(id, None);
                }
                continue;
            }
            out.released += 1;
            let evidence = db::parse(row.get("evidence"))?;
            let snapshot_sha = row.get::<Option<String>, _>("artifact_sha256");
            let snapshot_version = row.get::<Option<String>, _>("artifact_version_id");
            let expected_sha = if snapshot_sha.is_some() {
                (snapshot_version.as_deref() == d["version_id"].as_str())
                    .then_some(snapshot_sha.as_deref())
                    .flatten()
            } else if variable_count == 0 {
                sha.as_deref()
            } else {
                None
            };
            let snapshot_matches_device = snapshot_sha.is_none()
                || evidence["desired_artifact_sha256"].as_str() == expected_sha;
            let policy = row
                .get::<Option<String>, _>("policy")
                .map(|s| db::parse(&s))
                .transpose()?
                .unwrap_or(Value::Null);
            let interval = crate::rollout::check_in_seconds(
                &policy,
                &evidence,
                row.get::<Option<i64>, _>("policy_generation").unwrap_or(0),
            );
            let fresh = evidence["last_seen"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .is_some_and(|at| {
                    let age = now.signed_duration_since(at).num_seconds();
                    age >= 0 && age <= interval * 3
                });
            let owner = row.get::<Option<String>, _>(if config {
                "assignment_id"
            } else {
                "policy_assignment_id"
            });
            let desired = row.get::<Option<i64>, _>(if config {
                "desired_generation"
            } else {
                "policy_generation"
            });
            let same_payload = if config {
                row.get::<Option<String>, _>("desired_version_id")
                    .as_deref()
                    == d["version_id"].as_str()
            } else {
                policy == d["policy"]
            };
            let reason = if row.get::<Option<String>, _>("existing_id").is_none()
                || row.get::<Option<bool>, _>("revoked").unwrap_or(true)
            {
                Some("unavailable")
            } else if owner.as_deref() != d["id"].as_str()
                || desired != Some(generation)
                || !same_payload
            {
                Some("superseded")
            } else if !fresh {
                Some("stale")
            } else if config
                && (evidence["local_paused"] == true
                    || evidence["local_paused"] == 1
                    || policy["sync_paused"] == true)
            {
                Some("paused")
            } else {
                let accepted = if config {
                    let actual = evidence["actual_sha256"].as_str();
                    let digest_ok = if secrets {
                        expected_sha == evidence["applied_template_sha256"].as_str()
                            && expected_sha.is_some()
                            && actual.is_some_and(|s| {
                                s.len() == 64
                                    && evidence["verified_effective_sha256"].as_str() == Some(s)
                            })
                            && evidence["secret_revision"].as_i64().is_some_and(|r| {
                                r >= 1 && evidence["verified_secret_revision"].as_i64() == Some(r)
                            })
                    } else {
                        expected_sha.is_some() && actual == expected_sha
                    };
                    snapshot_matches_device
                        && evidence["apply_state"] == "verified_applied"
                        && (evidence["reported_apply_state"].is_null()
                            || evidence["reported_apply_state"] == "verified_applied")
                        && evidence["reported_generation"] == generation
                        && digest_ok
                } else {
                    evidence["policy_generation"] == generation
                        && (policy["sync_paused"] != true
                            || evidence["pause_acknowledged"] == true
                            || evidence["pause_acknowledged"] == 1)
                };
                if state == "verified_applied" && accepted {
                    if config {
                        data_plane(&evidence, &policy, d, interval, now, measured_after)
                    } else {
                        None
                    }
                } else {
                    Some("unverified")
                }
            };
            if let Some(reason) = reason {
                *out.reasons.get_mut(reason).unwrap() += 1;
            } else {
                out.verified += 1;
            }
            if only.is_some() {
                out.target_reasons.insert(id.clone(), reason);
            }
            digest.update(
                json!([
                    id,
                    generation,
                    owner,
                    if config {
                        d["version_id"].clone()
                    } else {
                        policy.clone()
                    },
                    if config {
                        json!([
                            expected_sha,
                            evidence["actual_sha256"],
                            evidence["applied_template_sha256"],
                            if secrets {
                                evidence["secret_revision"].clone()
                            } else {
                                Value::Null
                            }
                        ])
                    } else {
                        Value::Null
                    }
                ])
                .to_string(),
            );
            digest.update(b"\n");
        }
        if len < 100 {
            break;
        }
    }
    out.fingerprint = format!("{:x}", digest.finalize());
    Ok(out)
}
/// A verified configuration still has to deliver. A device with an open
/// data-plane issue on this version is `degraded`. A device that reports
/// telemetry but hasn't been evaluated enough times on this version is still
/// `measuring`. A device without fresh telemetry is judged on apply state
/// alone, since there is nothing to measure.
fn data_plane(
    evidence: &Value,
    policy: &Value,
    d: &Value,
    interval: i64,
    now: DateTime<Utc>,
    measured_after: u64,
) -> Option<&'static str> {
    let measured_version = evidence["data_plane_version"].as_str() == d["version_id"].as_str();
    if measured_version && evidence["data_plane_issues"].as_i64().unwrap_or(0) > 0 {
        return Some("degraded");
    }
    let reporting = policy["telemetry_enabled"] == true
        && evidence["telemetry_sampled_at"]
            .as_str()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| {
                let age = now.signed_duration_since(at).num_seconds();
                age >= -300 && age <= (interval * 3).max(180)
            });
    let evaluations = evidence["data_plane_evaluations"].as_u64().unwrap_or(0);
    (reporting && !(measured_version && evaluations >= measured_after)).then_some("measuring")
}
/// Released devices of a configuration rollout whose data plane is failing on
/// its version. The scheduler counts them as failures against the threshold.
pub async fn degraded(db: &mut SqliteConnection, d: &Value, devices: &[&str]) -> Result<usize> {
    let Some(version) = d["version_id"].as_str() else {
        return Ok(0);
    };
    if devices.is_empty() {
        return Ok(0);
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE id IN (SELECT value FROM json_each(?)) AND revoked=0 AND json_extract(data,'$.data_plane.version_id')=? AND json_type(data,'$.data_plane.issues')='array' AND json_array_length(data,'$.data_plane.issues')>0")
        .bind(json!(devices).to_string())
        .bind(version)
        .fetch_one(db)
        .await?;
    Ok(count as usize)
}
/// Check the old and newly accepted heartbeat state around an update so a
/// stale/unverified interval cannot heal unnoticed between scheduler ticks.
pub async fn invalidate_unproven_device(db: &mut SqliteConnection, id: &str) -> Result<()> {
    let ids:Vec<String>=sqlx::query_scalar("SELECT r.id FROM records r JOIN deployment_targets t ON t.deployment_id=r.id WHERE r.kind='deployment' AND t.device_id=? AND t.generation>0 AND t.state<>'removed' AND json_extract(r.data,'$.rollout.kind')='canary' AND json_extract(r.data,'$.status') IN ('active','paused') AND json_extract(r.data,'$.observation_started_at') IS NOT NULL").bind(id).fetch_all(&mut *db).await?;
    let only = BTreeSet::from([id.to_owned()]);
    for id in ids {
        let d = load(db, &id).await?;
        let proof = evaluate(db, &d, Some(&only)).await?;
        if !proof.all_verified() {
            sqlx::query("UPDATE records SET data=json_remove(json_set(data,'$.observation_started_at',NULL),'$.observation_evidence') WHERE kind='deployment' AND id=?").bind(id).execute(&mut *db).await?;
        }
    }
    Ok(())
}
