//! Data-plane health. A pipeline can apply cleanly and still deliver nothing:
//! its destination is down, a sink fails every request, or a buffer fills
//! until Vector's backpressure stops every path. The agent already reports
//! the numbers that show it; this module turns them into issues.
//!
//! Each accepted telemetry sample (at most one evaluation per
//! [`EVALUATION_INTERVAL_SECONDS`] per device) is checked against the version
//! the device verifiably runs. A condition opens a `DATA_PLANE_*` issue only
//! after it holds for consecutive evaluations, and resolves only after it is
//! clear for [`RESOLVE_SAMPLES`] evaluations, so one noisy sample neither
//! alarms nor heals. Nothing is inferred: a number the agent didn't report
//! never counts as healthy or unhealthy.
use crate::{db, error::Result, issues};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::SqliteConnection;

/// Evaluations per device are coalesced to at most one per this interval.
pub const EVALUATION_INTERVAL_SECONDS: i64 = 25;
/// Consecutive bad evaluations before an issue opens.
pub const OPEN_SAMPLES: u64 = 2;
/// Consecutive "receiving but not sending" evaluations before a stall opens.
pub const STALL_SAMPLES: u64 = 3;
/// Consecutive clean evaluations before an open issue resolves.
pub const RESOLVE_SAMPLES: u64 = 3;
/// Evaluations on a version before a canary counts its data plane as measured.
pub const GATE_MIN_EVALUATIONS: u64 = 3;
/// A sink failing at least this many requests a minute is failing.
pub const SINK_ERRORS_PER_MINUTE: f64 = 1.0;
/// A component dropping at least this many events a minute to errors is failing.
pub const ERROR_DROPS_PER_MINUTE: f64 = 1.0;
/// A buffer at least this full and still rising is filling up.
pub const BUFFER_RISING: f64 = 0.8;
/// A buffer at least this full is full, rising or not.
pub const BUFFER_FULL: f64 = 0.95;
/// A buffer below this is clear again.
pub const BUFFER_CLEAR: f64 = 0.5;
/// Sources must receive at least this rate for a stall to be judged.
pub const STALL_MIN_EVENTS_PER_SECOND: f64 = 0.1;
/// Delivering at most this share of what arrives counts as sending nothing.
pub const STALL_OUT_RATIO: f64 = 0.01;
/// Open issues per device; further conditions wait until one resolves.
pub const MAX_OPEN_PER_DEVICE: usize = 10;
/// Tracked streaks per device (components x conditions), including closed ones.
const MAX_TRACKED: usize = 200;
/// A sample older than this no longer describes the running pipeline.
const SAMPLE_MAX_AGE_SECONDS: i64 = 600;

pub const SINK_ERRORS: &str = "DATA_PLANE_SINK_ERRORS";
pub const STALLED: &str = "DATA_PLANE_STALLED";
pub const BUFFER: &str = "DATA_PLANE_BUFFER_FULL";
pub const ERROR_DROPS: &str = "DATA_PLANE_ERROR_DROPS";
pub const CODES: [&str; 4] = [STALLED, SINK_ERRORS, BUFFER, ERROR_DROPS];

pub fn is_data_plane(code: &str) -> bool {
    CODES.contains(&code)
}

/// Plain-language title (at most 120 characters). It names the component
/// when there is one.
pub fn title(code: &str, component: Option<&str>) -> String {
    let title = match (code, component) {
        (STALLED, _) => "The pipeline stopped delivering".into(),
        (SINK_ERRORS, Some(id)) => format!("{id} can't deliver events"),
        (BUFFER, Some(id)) => format!("{id}'s buffer is filling up"),
        (ERROR_DROPS, Some(id)) => format!("{id} is dropping events"),
        _ => generic_title(code).into(),
    };
    bounded(title, 120)
}
/// The title without a component, for search and grouped lists.
pub fn generic_title(code: &str) -> &'static str {
    match code {
        STALLED => "The pipeline stopped delivering",
        SINK_ERRORS => "A sink can't deliver events",
        BUFFER => "A buffer is filling up",
        _ => "A component is dropping events",
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Bad,
    Good,
    /// Neither: breaks a clean streak but doesn't add to a bad one.
    Hold,
}
#[derive(Debug)]
pub struct Finding {
    pub code: &'static str,
    pub component: Option<String>,
    pub component_kind: Option<String>,
    pub verdict: Verdict,
    /// Diagnostics for the issue: the finding first, then Vector's own log
    /// line for the component when the agent reported one.
    pub diagnostics: Value,
    pub evidence: Value,
}
impl Finding {
    /// The component the issue is keyed by. A stall is pipeline-wide; the
    /// sink it names is only the likely cause and may change.
    pub fn keyed_component(&self) -> Option<&str> {
        if self.code == STALLED {
            None
        } else {
            self.component.as_deref()
        }
    }
    fn key(&self) -> String {
        format!("{}:{}", self.code, self.keyed_component().unwrap_or(""))
    }
}

fn number(value: f64) -> String {
    if value >= 100.0 || value.fract() == 0.0 {
        format!("{value:.0}")
    } else if value >= 1.0 {
        format!("{value:.1}")
    } else {
        format!("{value:.2}")
    }
}
/// "12 requests", "1 request": a rate averaged over the sampling window,
/// rounded to what an operator counts.
fn per_minute(value: f64, noun: &str) -> String {
    let count = value.round().max(1.0);
    format!("{count:.0} {noun}{}", if count == 1.0 { "" } else { "s" })
}
fn percent(value: f64) -> String {
    format!("{:.0}%", (value * 100.0).clamp(0.0, 100.0))
}
fn bounded(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        text
    } else {
        let mut out: String = text.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

/// The most frequent recent Vector warning or error for a component.
fn log_for<'a>(logs: &'a [Value], component: &str) -> Option<&'a Value> {
    logs.iter()
        .filter(|item| item["component_id"].as_str() == Some(component))
        .max_by_key(|item| item["count"].as_u64().unwrap_or(0))
}
fn cause(log: Option<&Value>) -> String {
    log.and_then(|item| item["reason"].as_str())
        .map(|reason| format!(" ({})", reason.replace('_', " ")))
        .unwrap_or_default()
}
#[allow(clippy::too_many_arguments)]
fn finding(
    code: &'static str,
    component: Option<&str>,
    kind: Option<&str>,
    verdict: Verdict,
    severity: &str,
    message: String,
    hint: String,
    evidence: Value,
    log: Option<&Value>,
) -> Finding {
    let mut first = json!({"severity":severity,"code":code,"message":bounded(message,300),"hint":bounded(hint,200)});
    if let Some(id) = component {
        first["component_id"] = json!(id);
    }
    if let Some(kind) = kind {
        first["component_kind"] = json!(kind);
    }
    let mut diagnostics = vec![first];
    if let Some(message) = log.and_then(|item| item["message"].as_str()) {
        let mut line =
            json!({"severity":"warning","code":"VECTOR_LOG","message":bounded(message.into(),300)});
        if let Some(id) = component {
            line["component_id"] = json!(id);
        }
        diagnostics.push(line);
    }
    Finding {
        code,
        component: component.map(str::to_owned),
        component_kind: kind.map(str::to_owned),
        verdict,
        diagnostics: Value::Array(diagnostics),
        evidence,
    }
}

/// Judge one sample. `previous` holds each component's buffer fill from the
/// previous evaluation, so "rising" compares like with like.
pub fn assess(sample: &Value, previous: &Map<String, Value>, logs: &[Value]) -> Vec<Finding> {
    let mut out = Vec::new();
    let empty = Vec::new();
    let components = sample["components"].as_array().unwrap_or(&empty);
    for c in components {
        let Some(id) = c["id"].as_str() else { continue };
        let kind = c["kind"].as_str();
        let type_name = c["type"].as_str().unwrap_or("");
        let errors = c["errors_per_minute"].as_f64();
        let drops = c["dropped_per_minute"].as_f64();
        let fill = c["buffer_utilization"].as_f64();
        let log = log_for(logs, id);
        if kind == Some("sink") {
            if let Some(errors) = errors {
                let verdict = if errors >= SINK_ERRORS_PER_MINUTE {
                    Verdict::Bad
                } else if fill.is_none_or(|f| f < BUFFER_CLEAR) {
                    Verdict::Good
                } else {
                    // A stuck sink backs off and stops counting errors while
                    // its buffer stays full; that is not recovery.
                    Verdict::Hold
                };
                let described = if type_name.is_empty() {
                    format!("{id}")
                } else {
                    format!("The {type_name} sink {id}")
                };
                out.push(finding(
                    SINK_ERRORS,
                    Some(id),
                    kind,
                    verdict,
                    "error",
                    format!(
                        "{described} is failing about {} a minute{}.",
                        per_minute(errors, "request"),
                        cause(log)
                    ),
                    "Check that the destination is up and reachable from this device, and that its address and credentials are right.".into(),
                    json!({"errors_per_minute":errors,"buffer_utilization":fill}),
                    log,
                ));
            }
        }
        if let Some(fill) = fill {
            let before = previous.get(id).and_then(Value::as_f64);
            let rising = before.is_some_and(|b| fill > b + 0.001);
            let verdict = if fill >= BUFFER_FULL || (fill >= BUFFER_RISING && rising) {
                Verdict::Bad
            } else if fill < BUFFER_CLEAR {
                Verdict::Good
            } else {
                Verdict::Hold
            };
            let state = if fill >= BUFFER_FULL {
                "full".to_owned()
            } else {
                format!("{} full and rising", percent(fill))
            };
            out.push(finding(
                BUFFER,
                Some(id),
                kind,
                verdict,
                "warning",
                format!(
                    "The buffer in front of {id} is {state}. When it's full, Vector pauses every path that feeds {id}."
                ),
                format!("Look at what slows {id}, usually an unreachable or throttling destination. A bigger buffer only buys time."),
                json!({"buffer_utilization":fill,"previous_buffer_utilization":before}),
                log,
            ));
        }
        if let Some(drops) = drops {
            let verdict = if drops >= ERROR_DROPS_PER_MINUTE {
                Verdict::Bad
            } else {
                Verdict::Good
            };
            out.push(finding(
                ERROR_DROPS,
                Some(id),
                kind,
                verdict,
                "error",
                format!(
                    "{id} is dropping about {} a minute because of errors{}.",
                    per_minute(drops, "event"),
                    cause(log)
                ),
                format!(
                    "Open {id} and fix the error Vector reports. Events dropped on error are lost."
                ),
                json!({"dropped_per_minute":drops}),
                log,
            ));
        }
    }
    let (Some(input), Some(output)) = (
        sample["events_per_second"].as_f64(),
        sample["events_out_per_second"].as_f64(),
    ) else {
        return out;
    };
    let filtered = sample["filtered_per_minute"].as_f64().unwrap_or(0.0) / 60.0;
    let sinks: Vec<&Value> = components.iter().filter(|c| c["kind"] == "sink").collect();
    let fill = |c: &Value| c["buffer_utilization"].as_f64().unwrap_or(0.0);
    let errors = |c: &Value| c["errors_per_minute"].as_f64().unwrap_or(0.0);
    // Only a visibly struggling sink or failing component makes "nothing
    // out" a stall. A route that matches nothing is not an outage.
    let trouble = components.is_empty()
        || sinks
            .iter()
            .any(|c| errors(c) > 0.0 || fill(c) >= BUFFER_CLEAR)
        || components
            .iter()
            .any(|c| c["dropped_per_minute"].as_f64().unwrap_or(0.0) > 0.0);
    let culprit = sinks
        .iter()
        .filter(|c| errors(c) > 0.0 || fill(c) >= BUFFER_CLEAR)
        .max_by(|a, b| {
            (fill(a), errors(a))
                .partial_cmp(&(fill(b), errors(b)))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .and_then(|c| c["id"].as_str());
    let verdict = if input >= STALL_MIN_EVENTS_PER_SECOND
        && output <= input * STALL_OUT_RATIO
        && filtered < input * 0.5
        && trouble
    {
        Verdict::Bad
    } else if output > 0.0 && output > input * STALL_OUT_RATIO {
        Verdict::Good
    } else {
        Verdict::Hold
    };
    let (because, hint) = match culprit {
        Some(id) => {
            let c = sinks.iter().find(|c| c["id"] == id).unwrap();
            let why = if fill(c) >= BUFFER_CLEAR {
                format!(
                    " {id}'s buffer is {} full, so Vector is holding back every path that feeds it.",
                    percent(fill(c))
                )
            } else {
                format!(" {id} is failing its requests.")
            };
            (
                why,
                format!(
                    "Get {id}'s destination working again, or roll back to the last working version."
                ),
            )
        }
        None => (
            String::new(),
            "Check each sink's destination, or roll back to the last working version.".into(),
        ),
    };
    out.push(finding(
        STALLED,
        culprit,
        Some("sink").filter(|_| culprit.is_some()),
        verdict,
        "error",
        format!(
            "Vector is receiving {} events/s and delivering none.{because}",
            number(input)
        ),
        hint,
        json!({"events_in_per_second":input,"events_out_per_second":output,"culprit":culprit}),
        culprit.and_then(|id| log_for(logs, id)),
    ));
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum Transition {
    None,
    Open,
    Refresh,
    Resolve,
}
/// Advance one streak. `entry` holds `bad`, `good` and `open`.
pub fn step(entry: &mut Value, verdict: Verdict, needed: u64) -> Transition {
    let open = entry["open"] == true;
    let bad = entry["bad"].as_u64().unwrap_or(0);
    let good = entry["good"].as_u64().unwrap_or(0);
    match verdict {
        Verdict::Bad => {
            entry["bad"] = json!(bad.saturating_add(1).min(1_000_000));
            entry["good"] = json!(0);
            if open {
                Transition::Refresh
            } else if bad + 1 >= needed {
                Transition::Open
            } else {
                Transition::None
            }
        }
        Verdict::Good => {
            entry["good"] = json!(good.saturating_add(1).min(1_000_000));
            entry["bad"] = json!(0);
            if open && good + 1 >= RESOLVE_SAMPLES {
                Transition::Resolve
            } else {
                Transition::None
            }
        }
        Verdict::Hold => {
            entry["good"] = json!(0);
            Transition::None
        }
    }
}

fn parse_time(value: &Value) -> Option<DateTime<Utc>> {
    value
        .as_str()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
}

pub struct Observation<'a> {
    pub device_id: &'a str,
    /// The device record as just stored by the heartbeat.
    pub device: &'a Value,
    pub desired_version: Option<&'a str>,
    pub assignment_id: Option<String>,
    /// The accepted sample, or null when telemetry is off or unavailable.
    pub sample: &'a Value,
}

/// Evaluate a heartbeat's sample and keep issues and the device's
/// `data_plane` summary in step. Runs inside the heartbeat transaction.
pub async fn observe(db: &mut SqliteConnection, o: Observation<'_>) -> Result<()> {
    let stored: Option<String> =
        sqlx::query_scalar("SELECT data FROM data_plane_state WHERE device_id=?")
            .bind(o.device_id)
            .fetch_optional(&mut *db)
            .await?;
    if o.desired_version.is_none() {
        // Unassigned: the heartbeat already resolved every issue.
        if stored.is_some() {
            sqlx::query("DELETE FROM data_plane_state WHERE device_id=?")
                .bind(o.device_id)
                .execute(&mut *db)
                .await?;
        }
        if !o.device["data_plane"].is_null() {
            sqlx::query("UPDATE devices SET data=json_remove(data,'$.data_plane') WHERE id=?")
                .bind(o.device_id)
                .execute(&mut *db)
                .await?;
        }
        return Ok(());
    }
    let Some(running) = crate::telemetry::running_version(o.device) else {
        return Ok(());
    };
    let mut state = match stored.as_deref() {
        Some(raw) => db::parse(raw)?,
        None => Value::Null,
    };
    let mut changed = false;
    if state["version_id"].as_str() != Some(running) {
        // Findings belong to the version that produced them.
        issues::resolve_data_plane(db, o.device_id, Some(running), "superseded").await?;
        state = json!({"version_id":running,"evaluations":0,"keys":{},"buffers":{}});
        changed = true;
    }
    let now = Utc::now();
    let sampled = parse_time(&o.sample["sampled_at"]);
    let due = sampled.is_some_and(|at| {
        now.signed_duration_since(at).num_seconds() <= SAMPLE_MAX_AGE_SECONDS
            && parse_time(&state["sampled_at"]).is_none_or(|last| at > last)
            && parse_time(&state["evaluated_at"]).is_none_or(|last| {
                now.signed_duration_since(last).num_seconds() >= EVALUATION_INTERVAL_SECONDS
            })
    });
    if due {
        evaluate(db, &o, running, &mut state).await?;
        changed = true;
    }
    if changed {
        sqlx::query("INSERT INTO data_plane_state(device_id,data) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET data=excluded.data")
            .bind(o.device_id)
            .bind(state.to_string())
            .execute(&mut *db)
            .await?;
        sqlx::query("UPDATE devices SET data=json_set(data,'$.data_plane',json(?)) WHERE id=?")
            .bind(summary(&state).to_string())
            .bind(o.device_id)
            .execute(&mut *db)
            .await?;
    }
    Ok(())
}

async fn evaluate(
    db: &mut SqliteConnection,
    o: &Observation<'_>,
    running: &str,
    state: &mut Value,
) -> Result<()> {
    let empty = Vec::new();
    let logs = o.device["vector_log_summary"]["items"]
        .as_array()
        .unwrap_or(&empty);
    let previous = state["buffers"].as_object().cloned().unwrap_or_default();
    let findings = assess(o.sample, &previous, logs);
    let mut keys = state["keys"].as_object().cloned().unwrap_or_default();
    let mut open = keys.values().filter(|e| e["open"] == true).count();
    let mut seen = std::collections::BTreeSet::new();
    let now = db::now();
    for f in findings {
        let key = f.key();
        seen.insert(key.clone());
        if !keys.contains_key(&key) && keys.len() >= MAX_TRACKED {
            continue;
        }
        let entry = keys.entry(key).or_insert_with(|| json!({}));
        let needed = if f.code == STALLED {
            STALL_SAMPLES
        } else {
            OPEN_SAMPLES
        };
        let transition = step(entry, f.verdict, needed);
        let transition = if transition == Transition::Open && open >= MAX_OPEN_PER_DEVICE {
            Transition::None
        } else {
            transition
        };
        let report = issues::DataPlaneReport {
            device_id: o.device_id,
            version_id: running,
            code: f.code,
            component: f.keyed_component(),
            diagnostics: &f.diagnostics,
            evidence: &f.evidence,
            deployment_id: o.assignment_id.clone(),
        };
        match transition {
            Transition::Open | Transition::Refresh => {
                let id = issues::record_data_plane(db, report).await?;
                if transition == Transition::Open {
                    open += 1;
                    entry["open"] = json!(true);
                    entry["since"] = json!(now);
                }
                entry["issue_id"] = json!(id);
                entry["code"] = json!(f.code);
                entry["component_id"] = json!(f.component);
                entry["component_kind"] = json!(f.component_kind);
                entry["diagnostic"] = f.diagnostics[0].clone();
            }
            Transition::Resolve => {
                if let Some(id) = entry["issue_id"].as_str() {
                    issues::resolve_data_plane_issue(db, id, "healthy").await?;
                }
                open = open.saturating_sub(1);
                *entry = json!({"good":entry["good"]});
            }
            Transition::None => {}
        }
    }
    // A condition that no longer appears keeps an open issue (the component
    // may just not have reported); a closed streak without data is dropped.
    keys.retain(|key, entry| entry["open"] == true || seen.contains(key));
    let buffers: Map<String, Value> = o.sample["components"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|c| {
            Some((
                c["id"].as_str()?.to_owned(),
                json!(c["buffer_utilization"].as_f64()?),
            ))
        })
        .collect();
    state["keys"] = Value::Object(keys);
    state["buffers"] = Value::Object(buffers);
    state["sampled_at"] = o.sample["sampled_at"].clone();
    state["evaluated_at"] = json!(now);
    state["evaluations"] = json!(
        state["evaluations"]
            .as_u64()
            .unwrap_or(0)
            .saturating_add(1)
            .min(1_000_000)
    );
    Ok(())
}

/// The public, bounded summary kept on the device record: which version was
/// measured, how many times, and what is wrong right now.
fn summary(state: &Value) -> Value {
    let mut open: Vec<Value> = state["keys"]
        .as_object()
        .map(|keys| {
            keys.values()
                .filter(|e| e["open"] == true)
                .map(|e| {
                    let code = e["code"].as_str().unwrap_or("");
                    let component = e["component_id"].as_str();
                    json!({
                        "issue_id": e["issue_id"],
                        "code": code,
                        "component_id": component,
                        "component_kind": e["component_kind"],
                        "title": title(code, if code == STALLED { None } else { component }),
                        "message": e["diagnostic"]["message"],
                        "hint": e["diagnostic"]["hint"],
                        "since": e["since"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let rank = |code: &str| CODES.iter().position(|c| *c == code).unwrap_or(CODES.len());
    open.sort_by(|a, b| {
        rank(a["code"].as_str().unwrap_or(""))
            .cmp(&rank(b["code"].as_str().unwrap_or("")))
            .then_with(|| a["since"].as_str().cmp(&b["since"].as_str()))
    });
    open.truncate(MAX_OPEN_PER_DEVICE);
    json!({
        "version_id": state["version_id"],
        "evaluations": state["evaluations"],
        "evaluated_at": state["evaluated_at"],
        "issues": open,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink(id: &str, errors: f64, fill: f64) -> Value {
        json!({"id":id,"kind":"sink","type":"http","errors_per_minute":errors,"dropped_per_minute":0.0,"buffer_utilization":fill})
    }
    fn verdict(findings: &[Finding], code: &str) -> Verdict {
        findings.iter().find(|f| f.code == code).unwrap().verdict
    }

    #[test]
    fn failing_sink_with_a_filling_buffer_is_bad_everywhere() {
        let sample = json!({"events_per_second":5.0,"events_out_per_second":0.0,"components":[sink("out",12.0,0.9)]});
        let previous = Map::from_iter([("out".to_owned(), json!(0.7))]);
        let logs = vec![
            json!({"component_id":"out","reason":"connection_refused","message":"Connection refused (os error 111)","count":13}),
        ];
        let found = assess(&sample, &previous, &logs);
        assert_eq!(verdict(&found, SINK_ERRORS), Verdict::Bad);
        assert_eq!(verdict(&found, BUFFER), Verdict::Bad);
        assert_eq!(verdict(&found, STALLED), Verdict::Bad);
        assert_eq!(verdict(&found, ERROR_DROPS), Verdict::Good);
        let errors = found.iter().find(|f| f.code == SINK_ERRORS).unwrap();
        assert_eq!(
            errors.diagnostics[0]["message"],
            "The http sink out is failing about 12 requests a minute (connection refused)."
        );
        assert_eq!(
            errors.diagnostics[1]["message"],
            "Connection refused (os error 111)"
        );
        crate::configuration_attempt::diagnostics(&errors.diagnostics).unwrap();
        let stall = found.iter().find(|f| f.code == STALLED).unwrap();
        assert_eq!(stall.component.as_deref(), Some("out"));
        assert!(
            stall.diagnostics[0]["message"]
                .as_str()
                .unwrap()
                .contains("out's buffer is 90% full")
        );
    }

    #[test]
    fn backed_off_sink_with_a_full_buffer_holds_instead_of_healing() {
        let sample = json!({"events_per_second":5.0,"events_out_per_second":0.0,"components":[sink("out",0.0,1.0)]});
        let found = assess(&sample, &Map::new(), &[]);
        assert_eq!(verdict(&found, SINK_ERRORS), Verdict::Hold);
        assert_eq!(verdict(&found, BUFFER), Verdict::Bad);
        assert_eq!(verdict(&found, STALLED), Verdict::Bad);
    }

    #[test]
    fn healthy_and_intentionally_quiet_pipelines_never_alarm() {
        let healthy = json!({"events_per_second":5.0,"events_out_per_second":5.0,"components":[sink("out",0.0,0.1)]});
        for f in assess(&healthy, &Map::new(), &[]) {
            assert_eq!(f.verdict, Verdict::Good, "{f:?}");
        }
        // A route that matches nothing delivers nothing, and nothing is wrong.
        let quiet = json!({"events_per_second":5.0,"events_out_per_second":0.0,"components":[sink("out",0.0,0.0)]});
        assert_eq!(
            verdict(&assess(&quiet, &Map::new(), &[]), STALLED),
            Verdict::Hold
        );
        // A filter dropping everything on purpose is not a stall.
        let filtered = json!({"events_per_second":5.0,"events_out_per_second":0.0,"filtered_per_minute":300.0,"components":[sink("out",2.0,0.0)]});
        assert_eq!(
            verdict(&assess(&filtered, &Map::new(), &[]), STALLED),
            Verdict::Hold
        );
        // A steady buffer that isn't rising isn't filling up.
        let steady = json!({"components":[sink("out",0.0,0.85)]});
        let previous = Map::from_iter([("out".to_owned(), json!(0.85))]);
        assert_eq!(
            verdict(&assess(&steady, &previous, &[]), BUFFER),
            Verdict::Hold
        );
        // Unreported numbers are never judged.
        assert!(assess(&json!({"events_per_second":5.0}), &Map::new(), &[]).is_empty());
    }

    #[test]
    fn streaks_open_after_consecutive_bad_and_resolve_with_hysteresis() {
        let mut entry = json!({});
        assert_eq!(step(&mut entry, Verdict::Bad, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Bad, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Bad, 2), Transition::Open);
        entry["open"] = json!(true);
        assert_eq!(step(&mut entry, Verdict::Bad, 2), Transition::Refresh);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Hold, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::None);
        assert_eq!(step(&mut entry, Verdict::Good, 2), Transition::Resolve);
    }

    #[test]
    fn titles_name_the_component() {
        assert_eq!(title(SINK_ERRORS, Some("out")), "out can't deliver events");
        assert_eq!(
            title(STALLED, Some("out")),
            "The pipeline stopped delivering"
        );
        assert_eq!(title(BUFFER, None), "A buffer is filling up");
        assert_eq!(
            title(SINK_ERRORS, Some(&"x".repeat(100))).chars().count(),
            120
        );
    }
}
