//! The four events of agent updates a channel can ask for, and the message each
//! one makes. They are read from the audit trail through the notifier's cursor,
//! as a rollout's failure is, with the same identity (one event per audit row),
//! quiet-hour and digest rules:
//!
//! - `agent_update.failed` (an error): a rollout's gate failed it.
//! - `agent_update.rolled_back` (a warning): a device went back to its previous
//!   build.
//! - `agent_update.stopped` (a warning): Stop all updates.
//! - `agent_update.key_changed` (a warning): updates were turned on or off, or
//!   a release key was rotated, rolled over or revoked, which decides what key
//!   new hosts pin. Changing the custody is not an event of its own.
//!
//! A pipeline filter matches none of them. A group filter matches a rollback by
//! its device and a failure by the rollout's selector groups or its targets'
//! groups; a stop and a key change match only a rule that has no filter.
use super::{fingerprint, parse_version};
use crate::{
    agent_update_rollouts::detail,
    error::Result,
    notifier::{device_groups, device_name, named},
};
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use std::collections::BTreeSet;

/// The audit actions the four events are read from.
pub const ACTIONS: [&str; 8] = [
    "agent_update_rollout.gate",
    "device.agent_update",
    "agent_update.stop",
    "agent_update.enable",
    "agent_update.disable",
    "agent_release_key.rotate",
    "agent_release_key.rollover",
    "agent_release_key.revoke",
];

/// A key's short ID: the first 16 hex digits of its fingerprint.
fn short(fingerprint_of_key: &Value) -> Value {
    match fingerprint_of_key.as_str() {
        Some(key) if fingerprint(key) => json!(&key[..16]),
        _ => Value::Null,
    }
}

/// The event an audit row is, if it is one of the four, with the facts the
/// message is made of (names are read when the message is made, not now).
pub fn fact(event: &Value) -> Option<(&'static str, Value)> {
    let details = &event["details"];
    let outcome = event["outcome"].as_str().unwrap_or("");
    let actor = &event["actor"];
    Some(match event["action"].as_str()? {
        "agent_update_rollout.gate" if details["gate_state"] == "failed" => (
            "agent_update.failed",
            json!({
                "severity": "error",
                "rollout_id": event["target"],
                "failure_reason": details["reason"],
            }),
        ),
        "device.agent_update" if details["state"] == "rolled_back" => (
            "agent_update.rolled_back",
            json!({
                "severity": "warning",
                "device_id": event["target"],
                "rollout_id": details["rollout_id"],
                "release_version": details["version"],
                "from_version": details["from_version"],
                "code": details["code"],
            }),
        ),
        "agent_update.stop" if outcome == "success" => (
            "agent_update.stopped",
            json!({
                "severity": "warning",
                "actor": actor,
                "reason": details["reason"],
                "cancelled_rollouts": details["cancelled_rollouts"],
            }),
        ),
        action @ ("agent_update.enable"
        | "agent_update.disable"
        | "agent_release_key.rotate"
        | "agent_release_key.rollover"
        | "agent_release_key.revoke")
            if outcome == "success" =>
        {
            // `key` is the key that became current: turning updates off and
            // revoking a key leave none.
            let (change, key) = match action {
                "agent_update.enable" => ("enabled", short(&details["fingerprint"])),
                "agent_update.disable" => ("disabled", Value::Null),
                "agent_release_key.rotate" => ("rotated", short(&details["fingerprint"])),
                "agent_release_key.rollover" => ("rolled_over", short(&details["fingerprint"])),
                _ => ("revoked", Value::Null),
            };
            (
                "agent_update.key_changed",
                json!({
                    "severity": "warning",
                    "actor": actor,
                    "change": change,
                    "key": key,
                    "revoked_key": if change == "revoked" { short(&details["fingerprint"]) } else { Value::Null },
                    "withdrawn_releases": details["withdrawn_releases"],
                    "cancelled_rollouts": details["cancelled_rollouts"],
                }),
            )
        }
        _ => return None,
    })
}

/// A version as a message says it: only when it is one. What a host reports of
/// the build it ran is its own word, and a message is read, and linked, by
/// people and channels that trust it.
fn shown(version: &str) -> &str {
    if parse_version(version).is_some() {
        version
    } else {
        "an unreadable version"
    }
}

fn plural(count: u64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// A rollout as a message names it.
struct Rollout {
    name: String,
    version: String,
    failure_reason: Option<String>,
    selector: Value,
}
async fn rollout(db: &mut SqliteConnection, id: &str) -> Result<Option<Rollout>> {
    let row: Option<(Option<String>, String, Option<String>, String)> = sqlx::query_as(
        "SELECT substr(ro.name,1,120),rel.version,ro.failure_reason,ro.selector FROM agent_update_rollouts ro JOIN agent_releases rel ON rel.id=ro.release_id WHERE ro.id=?",
    )
    .bind(id)
    .fetch_optional(&mut *db)
    .await?;
    Ok(
        row.map(|(name, version, failure_reason, selector)| Rollout {
            name: named(
                name.as_deref(),
                120,
                &format!("Update to {}", shown(&version)),
            ),
            version,
            failure_reason,
            selector: serde_json::from_str(&selector).unwrap_or(Value::Null),
        }),
    )
}
/// The name of the person whose action it was. The commands an administrator
/// runs on the server itself, such as the one that follows a restore, act as
/// `local-admin`, which is no account.
async fn actor(db: &mut SqliteConnection, id: &Value) -> Result<String> {
    if id.as_str() == Some("local-admin") {
        return Ok("A local administrator".to_owned());
    }
    let name: Option<String> =
        sqlx::query_scalar("SELECT substr(name,1,120) FROM users WHERE id=?")
            .bind(id.as_str().unwrap_or(""))
            .fetch_optional(&mut *db)
            .await?;
    Ok(named(name.as_deref(), 120, "Someone"))
}

/// Fills in what the message of `kind` says: its headline, message, context
/// lines, link and `agent_update` member (and the device of a rollback). Returns
/// the groups the event belongs to, for the channel's group filter.
pub async fn context(
    db: &mut SqliteConnection,
    kind: &str,
    data: &Value,
    notice: &mut Value,
) -> Result<BTreeSet<String>> {
    let mut groups = BTreeSet::new();
    let mut update = json!({"release_version": null, "rollout": null, "code": null, "key": null});
    match kind {
        "agent_update.failed" => {
            let id = data["rollout_id"].as_str().unwrap_or("");
            let found = rollout(db, id).await?;
            let name = found
                .as_ref()
                .map_or_else(|| "An agent update".to_owned(), |r| r.name.clone());
            let reason = found
                .as_ref()
                .and_then(|r| r.failure_reason.as_deref())
                .or(data["failure_reason"].as_str());
            notice["headline"] = json!(format!("Agent update failed: {name}"));
            notice["message"] = json!(match reason {
                Some("data_plane") => {
                    "Devices that took it stopped delivering events, so it stopped before the next stage."
                }
                Some("stalled") => "It made no progress for 24 hours, so it stopped.",
                _ => {
                    "More devices rolled back or failed than its failure threshold allows, so it stopped."
                }
            });
            let mut lines = vec![format!("Agent update: {name}")];
            if let Some(found) = &found {
                lines.push(format!("Release: {}", shown(&found.version)));
                update["release_version"] = json!(found.version);
                update["rollout"] = json!({"id": id, "name": found.name});
                for group in found.selector["group_ids"].as_array().into_iter().flatten() {
                    if let Some(group) = group.as_str() {
                        groups.insert(group.to_owned());
                    }
                }
                groups.extend(
                    sqlx::query_scalar::<_, String>("SELECT DISTINCT g.id FROM records g,json_each(g.data,'$.device_ids') m WHERE g.kind='group' AND m.value IN (SELECT device_id FROM agent_update_targets WHERE rollout_id=?)")
                        .bind(id)
                        .fetch_all(&mut *db)
                        .await?,
                );
            }
            notice["context"] = json!(lines);
            notice["path"] = json!(format!("/#/agent-updates/{id}"));
        }
        "agent_update.rolled_back" => {
            let device = data["device_id"].as_str().unwrap_or("");
            let name = device_name(db, device)
                .await?
                .map_or_else(|| "A device".to_owned(), |d| d.0);
            groups = device_groups(db, device).await?;
            let rollout_id = data["rollout_id"].as_str().unwrap_or("");
            let found = rollout(db, rollout_id).await?;
            let version = data["release_version"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| found.as_ref().map(|r| r.version.clone()));
            let code = data["code"].as_str();
            let went_back = match data["from_version"].as_str() {
                Some(from) => format!("went back to {}", shown(from)),
                None => "went back to its previous agent".to_owned(),
            };
            let tried = version
                .as_deref()
                .map(|version| format!(" after trying {}", shown(version)))
                .unwrap_or_default();
            let why = detail::message(code).map(|sentence| format!(" {sentence}"));
            notice["headline"] = json!(format!("Agent rolled back on {name}"));
            notice["message"] = json!(format!(
                "{name} {went_back}{tried}.{}",
                why.unwrap_or_default()
            ));
            let mut lines = vec![format!("Device: {name}")];
            if let Some(found) = &found {
                lines.push(format!("Agent update: {}", found.name));
                update["rollout"] = json!({"id": rollout_id, "name": found.name});
            }
            if let Some(version) = &version {
                lines.push(format!("Release: {}", shown(version)));
                update["release_version"] = json!(version);
            }
            if let Some(code) = code {
                lines.push(format!("Code: {code}"));
                update["code"] = json!(code);
            }
            notice["context"] = json!(lines);
            notice["device"] = json!({"id": device, "name": name});
            notice["path"] = json!(if found.is_some() {
                format!("/#/agent-updates/{rollout_id}")
            } else {
                format!("/#/devices/{device}")
            });
        }
        "agent_update.stopped" => {
            let who = actor(db, &data["actor"]).await?;
            let reason = named(data["reason"].as_str(), 300, "");
            let cancelled = data["cancelled_rollouts"].as_u64().unwrap_or(0);
            let mut message = format!("{who} stopped all agent updates.");
            if !reason.is_empty() {
                // A reason that is a sentence keeps its own full stop.
                let end = if reason.ends_with(['.', '!', '?']) {
                    ""
                } else {
                    "."
                };
                message.push_str(&format!(" Reason: “{reason}”{end}"));
            }
            message.push_str(" No host is offered a build until an administrator ends the stop.");
            if cancelled > 0 {
                message.push_str(&format!(
                    " {} cancelled.",
                    plural(cancelled, "update rollout was", "update rollouts were")
                ));
            }
            notice["headline"] = json!("Agent updates stopped");
            notice["message"] = json!(message);
            notice["context"] = json!(["Agent updates"]);
            notice["path"] = json!("/#/agent-updates");
        }
        _ => {
            let who = actor(db, &data["actor"]).await?;
            let key = data["key"].as_str();
            let revoked = data["revoked_key"].as_str();
            let current = key.unwrap_or("");
            let (headline, message) = match data["change"].as_str().unwrap_or("") {
                "enabled" => (
                    "Agent updates turned on".to_owned(),
                    format!(
                        "{who} turned agent updates on. Hosts that enroll now pin release key {current}."
                    ),
                ),
                "disabled" => (
                    "Agent updates turned off".to_owned(),
                    format!(
                        "{who} turned agent updates off. Hosts that enroll now pin no release key, until they are turned on again."
                    ),
                ),
                "rotated" => (
                    "Release key rotated".to_owned(),
                    format!(
                        "{who} rotated the release key. Hosts that enroll now pin {current}; hosts that pin the previous key follow the statement it signed."
                    ),
                ),
                "rolled_over" => (
                    "Release key rolled over".to_owned(),
                    format!(
                        "{who} rolled the release key over to {current} with a statement the previous key signed."
                    ),
                ),
                _ => {
                    let withdrawn = data["withdrawn_releases"].as_u64().unwrap_or(0);
                    let ended = data["cancelled_rollouts"].as_u64().unwrap_or(0);
                    let mut message = format!(
                        "{who} revoked release key {}.",
                        revoked.unwrap_or("that was in use")
                    );
                    if withdrawn > 0 || ended > 0 {
                        message.push_str(&format!(
                            " {} withdrawn and {} ended.",
                            plural(
                                withdrawn,
                                "release it signed was",
                                "releases it signed were"
                            ),
                            plural(ended, "update rollout", "update rollouts")
                        ));
                    }
                    ("Release key revoked".to_owned(), message)
                }
            };
            notice["headline"] = json!(headline);
            notice["message"] = json!(message);
            notice["context"] = json!(match (key, revoked) {
                (Some(key), _) => vec![format!("Release key: {key}")],
                (None, Some(revoked)) => vec![format!("Revoked key: {revoked}")],
                (None, None) => vec!["Agent updates".to_owned()],
            });
            notice["path"] = json!("/#/agent-updates-settings");
            update["key"] = json!(key);
        }
    }
    notice["agent_update"] = update;
    Ok(groups)
}

/// The example message for the dashboard's preview, or none when `kind` is not
/// one of the four. The names say it is an example; the notifier sets the
/// message's ID, type and time.
pub fn example(kind: &str) -> Option<Value> {
    const EXAMPLE_ID: &str = "00000000-0000-4000-8000-000000000000";
    let rollout = json!({"id": EXAMPLE_ID, "name": "Example update to 0.2.0"});
    let (severity, headline, message, context, path, device, update) = match kind {
        "agent_update.failed" => (
            "error",
            "Agent update failed: Example update to 0.2.0",
            "More devices rolled back or failed than its failure threshold allows, so it stopped.",
            json!(["Agent update: Example update to 0.2.0", "Release: 0.2.0"]),
            "/#/agent-updates",
            Value::Null,
            json!({"release_version": "0.2.0", "rollout": rollout, "code": null, "key": null}),
        ),
        "agent_update.rolled_back" => (
            "warning",
            "Agent rolled back on example-device",
            "example-device went back to 0.1.0 after trying 0.2.0. The new agent started but didn't pass its health check, so the previous build was put back.",
            json!([
                "Device: example-device",
                "Agent update: Example update to 0.2.0",
                "Release: 0.2.0",
                "Code: UNHEALTHY"
            ]),
            "/#/agent-updates",
            json!({"id": EXAMPLE_ID, "name": "example-device"}),
            json!({"release_version": "0.2.0", "rollout": rollout, "code": "UNHEALTHY", "key": null}),
        ),
        "agent_update.stopped" => (
            "warning",
            "Agent updates stopped",
            "An administrator stopped all agent updates. Reason: “Example: a build misbehaves”. No host is offered a build until an administrator ends the stop. 1 update rollout was cancelled.",
            json!(["Agent updates"]),
            "/#/agent-updates",
            Value::Null,
            json!({"release_version": null, "rollout": null, "code": null, "key": null}),
        ),
        "agent_update.key_changed" => (
            "warning",
            "Release key rotated",
            "An administrator rotated the release key. Hosts that enroll now pin 0123456789abcdef; hosts that pin the previous key follow the statement it signed.",
            json!(["Release key: 0123456789abcdef"]),
            "/#/agent-updates-settings",
            Value::Null,
            json!({"release_version": null, "rollout": null, "code": null, "key": "0123456789abcdef"}),
        ),
        _ => return None,
    };
    Some(json!({
        "id": null,
        "type": kind,
        "severity": severity,
        "recovery": false,
        "example": true,
        "occurred_at": null,
        "headline": headline,
        "message": message,
        "context": context,
        "path": path,
        "device": device,
        "pipeline": null,
        "deployment": null,
        "issue": null,
        "agent_update": update,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn row(action: &str, outcome: &str, target: &str, details: Value) -> Value {
        json!({"id":db::id(),"actor":"user","action":action,"target":target,"outcome":outcome,"created_at":db::now(),"details":details})
    }

    #[test]
    fn only_four_kinds_of_audit_rows_are_events() {
        let rollout = db::id();
        let failed = fact(&row(
            "agent_update_rollout.gate",
            "failed",
            &rollout,
            json!({"gate_state":"failed","reason":"threshold","verified_count":1}),
        ))
        .unwrap();
        assert_eq!(failed.0, "agent_update.failed");
        assert_eq!(failed.1["severity"], "error");
        assert_eq!(failed.1["rollout_id"], rollout.as_str());
        // A rollout that completed, or one that is observed, says nothing.
        for gate in ["completed", "observing", "passed"] {
            assert!(
                fact(&row(
                    "agent_update_rollout.gate",
                    gate,
                    &rollout,
                    json!({"gate_state":gate})
                ))
                .is_none(),
                "{gate}"
            );
        }
        let device = db::id();
        let back = fact(&row(
            "device.agent_update",
            "rolled_back",
            &device,
            json!({"rollout_id":rollout,"version":"0.2.0","from_version":"0.1.0","code":"UNHEALTHY","state":"rolled_back"}),
        ))
        .unwrap();
        assert_eq!(back.0, "agent_update.rolled_back");
        assert_eq!(back.1["device_id"], device.as_str());
        assert_eq!(back.1["code"], "UNHEALTHY");
        for state in ["verified", "failed", "refused"] {
            assert!(
                fact(&row(
                    "device.agent_update",
                    state,
                    &device,
                    json!({"state":state})
                ))
                .is_none(),
                "{state}"
            );
        }
        let stop = fact(&row(
            "agent_update.stop",
            "success",
            "server",
            json!({"reason":"a build misbehaves","cancelled_rollouts":2}),
        ))
        .unwrap();
        assert_eq!(stop.0, "agent_update.stopped");
        assert_eq!(stop.1["cancelled_rollouts"], 2);
        // Ending the stop, and everything else the audit trail holds about
        // agent updates, is not an event.
        for action in [
            "agent_update.stop_clear",
            "agent_release.prepare",
            "agent_release.sign",
            "agent_release.withdraw",
            "agent_update_rollout.create",
            "agent_update_rollout.release",
            "agent_update_rollout.pause",
            "agent_update_rollout.cancel",
            "deployment.gate",
        ] {
            assert!(
                fact(&row(action, "success", "x", json!({"gate_state":"failed"}))).is_none(),
                "{action}"
            );
        }
    }

    #[test]
    fn a_key_change_names_the_key_that_became_current() {
        for (action, change, key) in [
            ("agent_update.enable", "enabled", Some(&KEY[..16])),
            ("agent_update.disable", "disabled", None),
            ("agent_release_key.rotate", "rotated", Some(&KEY[..16])),
            (
                "agent_release_key.rollover",
                "rolled_over",
                Some(&KEY[..16]),
            ),
            ("agent_release_key.revoke", "revoked", None),
        ] {
            let (kind, data) = fact(&row(
                action,
                "success",
                "x",
                json!({"fingerprint":KEY,"custody":"server"}),
            ))
            .unwrap();
            assert_eq!(kind, "agent_update.key_changed", "{action}");
            assert_eq!(data["change"], change, "{action}");
            assert_eq!(data["key"], json!(key), "{action}");
            assert_eq!(
                data["revoked_key"],
                if change == "revoked" {
                    json!(&KEY[..16])
                } else {
                    Value::Null
                },
                "{action}"
            );
        }
        // A fingerprint that is not one names nothing.
        let (_, data) = fact(&row(
            "agent_release_key.rotate",
            "success",
            "x",
            json!({"fingerprint":"not-a-fingerprint"}),
        ))
        .unwrap();
        assert_eq!(data["key"], Value::Null);
    }

    #[test]
    fn every_kind_has_an_example_that_says_it_is_one() {
        for kind in [
            "agent_update.failed",
            "agent_update.rolled_back",
            "agent_update.stopped",
            "agent_update.key_changed",
        ] {
            let example = example(kind).unwrap();
            assert_eq!(example["example"], true);
            assert_eq!(example["type"], kind);
            assert!(example["agent_update"].is_object());
            assert!(example["headline"].as_str().is_some_and(|h| !h.is_empty()));
        }
        assert!(example("rollout.failed").is_none());
    }
}
