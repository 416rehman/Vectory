//! What an enrollment token may enroll, beyond its expiry, use count and name
//! prefix: an optional list of preapproved device names, each of which can
//! enroll once, and labels every device it enrolls receives.
//!
//! Labels describe a device (site, rack, owner). They never place it in a
//! group, target it with a deployment or give it secret access: enrollment
//! only ever creates an unmanaged device, and targeting stays explicit.
use crate::error::{ApiError, Result};
use serde_json::{Map, Value, json};

/// Most names one token can preapprove.
pub const MAX_NAMES: usize = 500;
/// Most labels one token can give a device.
pub const MAX_LABELS: usize = 8;
/// Longest label key, in characters.
pub const MAX_LABEL_KEY: usize = 63;
/// Longest label value, in characters.
pub const MAX_LABEL_VALUE: usize = 128;

/// A device name as enrollment stores it: the requested name trimmed and
/// ASCII-lowercased, 1 to 100 letters, digits, dots, hyphens or underscores,
/// starting with a letter or digit. None when the name can never enroll.
pub fn device_name(raw: &str) -> Option<String> {
    if raw.is_empty() || raw.len() > 100 || raw.contains('\0') {
        return None;
    }
    let name = raw.trim().to_ascii_lowercase();
    let valid = name
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    valid.then_some(name)
}

/// A label key: trimmed and lowercased, 1 to 63 letters, digits, dots,
/// hyphens or underscores, starting with a letter or digit.
pub fn label_key(raw: &str) -> Option<String> {
    let key = raw.trim().to_ascii_lowercase();
    let valid = key.len() <= MAX_LABEL_KEY
        && key
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b));
    valid.then_some(key)
}

/// A label value: trimmed, 1 to 128 characters, no control characters. Case
/// and non-ASCII letters are kept as written.
pub fn label_value(raw: &str) -> Option<String> {
    let value = raw.trim();
    let valid = !value.is_empty()
        && value.chars().count() <= MAX_LABEL_VALUE
        && !value.chars().any(char::is_control);
    valid.then(|| value.to_owned())
}

/// The scope fields of a token creation request, normalized. `allowed_names`
/// and `labels` are optional; null or absent means no list and no labels.
pub struct Scope {
    pub allowed_names: Option<Vec<String>>,
    pub labels: Option<Map<String, Value>>,
}

/// Validate `allowed_names` and `labels` of a token creation request. Every
/// preapproved name must also satisfy the token's name prefix, if any, since
/// a name that can never enroll is a mistake in the request.
pub fn parse(payload: &Value, prefix: Option<&str>) -> Result<Scope> {
    let allowed_names = match &payload["allowed_names"] {
        Value::Null => None,
        Value::Array(items) => {
            if items.is_empty() || items.len() > MAX_NAMES {
                return Err(ApiError::invalid(format!(
                    "allowed_names must list 1 to {MAX_NAMES} device names, or be null"
                )));
            }
            let mut names = Vec::with_capacity(items.len());
            for item in items {
                let raw = item
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("allowed_names must contain only strings"))?;
                let name = device_name(raw).ok_or_else(|| {
                    ApiError::invalid(format!(
                        "{:?} can't be a device name: use up to 100 letters, digits, dots, hyphens or underscores, starting with a letter or digit",
                        raw.chars().take(100).collect::<String>()
                    ))
                })?;
                if prefix.is_some_and(|prefix| !name.starts_with(prefix)) {
                    return Err(ApiError::invalid(format!(
                        "{name} doesn't start with the token's name prefix, so it could never enroll"
                    )));
                }
                if names.contains(&name) {
                    return Err(ApiError::invalid(format!(
                        "{name} appears more than once in allowed_names"
                    )));
                }
                names.push(name);
            }
            Some(names)
        }
        _ => {
            return Err(ApiError::invalid(
                "allowed_names must be a list of device names or null",
            ));
        }
    };
    let labels = match &payload["labels"] {
        Value::Null => None,
        Value::Object(items) => {
            if items.len() > MAX_LABELS {
                return Err(ApiError::invalid(format!(
                    "A token can give at most {MAX_LABELS} labels"
                )));
            }
            let mut labels = Map::new();
            for (raw_key, raw_value) in items {
                let key = label_key(raw_key).ok_or_else(|| {
                    ApiError::invalid(format!(
                        "{:?} can't be a label key: use up to {MAX_LABEL_KEY} letters, digits, dots, hyphens or underscores, starting with a letter or digit",
                        raw_key.chars().take(MAX_LABEL_KEY + 1).collect::<String>()
                    ))
                })?;
                let value = raw_value.as_str().and_then(label_value).ok_or_else(|| {
                    ApiError::invalid(format!(
                        "The {key} label needs a value of 1 to {MAX_LABEL_VALUE} characters without control characters"
                    ))
                })?;
                if labels.insert(key.clone(), json!(value)).is_some() {
                    return Err(ApiError::invalid(format!(
                        "The {key} label appears more than once"
                    )));
                }
            }
            (!labels.is_empty()).then_some(labels)
        }
        _ => {
            return Err(ApiError::invalid(
                "labels must be an object of key-value strings or null",
            ));
        }
    };
    Ok(Scope {
        allowed_names,
        labels,
    })
}

impl Scope {
    /// Store the scope on a new token record. Fields are added only when set,
    /// so a token without a scope keeps its original shape.
    pub fn store(self, record: &mut Value) {
        if let Some(names) = self.allowed_names {
            record["allowed_names"] = json!(names);
        }
        if let Some(labels) = self.labels {
            record["labels"] = Value::Object(labels);
        }
    }
}

/// Why this token refuses to enroll `name`, as an enrollment refusal reason:
/// the name isn't on the token's list, or it already enrolled with it.
pub fn refusal(record: &Value, name: &str) -> Option<&'static str> {
    let listed = record["allowed_names"].as_array()?;
    if !listed.iter().any(|entry| entry.as_str() == Some(name)) {
        return Some("NAME_NOT_PREAPPROVED");
    }
    record["enrolled_names"]
        .as_array()
        .is_some_and(|used| used.iter().any(|entry| entry.as_str() == Some(name)))
        .then_some("NAME_ALREADY_ENROLLED")
}

/// Remember that a preapproved name enrolled, so it can't enroll again.
pub fn record_use(record: &mut Value, name: &str) {
    if !record["allowed_names"].is_array() {
        return;
    }
    if !record["enrolled_names"].is_array() {
        record["enrolled_names"] = json!([]);
    }
    let used = record["enrolled_names"].as_array_mut().unwrap();
    if !used.iter().any(|entry| entry.as_str() == Some(name)) {
        used.push(json!(name));
    }
}

/// The labels a device enrolled with this token receives.
pub fn device_labels(record: &Value) -> Value {
    match &record["labels"] {
        Value::Object(labels) => Value::Object(labels.clone()),
        _ => json!({}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_normalize_like_enrollment_and_refuse_what_can_never_enroll() {
        assert_eq!(device_name(" Edge-01 ").as_deref(), Some("edge-01"));
        assert_eq!(device_name("web_2.eu").as_deref(), Some("web_2.eu"));
        for bad in [
            "", "   ", "-edge", ".edge", "edge 01", "edge/01", "édge", "a\0b",
        ] {
            assert_eq!(device_name(bad), None, "{bad:?}");
        }
        assert!(device_name(&"a".repeat(100)).is_some());
        assert!(device_name(&"a".repeat(101)).is_none());
    }

    #[test]
    fn labels_normalize_keys_keep_values_and_are_bounded() {
        assert_eq!(label_key(" Site ").as_deref(), Some("site"));
        assert_eq!(
            label_key("team.platform-core_2").as_deref(),
            Some("team.platform-core_2")
        );
        for bad in ["", "-site", "site name", "site=eu", "sité", &"k".repeat(64)] {
            assert_eq!(label_key(bad), None, "{bad:?}");
        }
        assert_eq!(label_value("  São Paulo ").as_deref(), Some("São Paulo"));
        assert_eq!(label_value("a=b").as_deref(), Some("a=b"));
        for bad in ["", "  ", "line\nbreak", "tab\there", &"v".repeat(129)] {
            assert_eq!(label_value(bad), None, "{bad:?}");
        }
        assert!(label_value(&"é".repeat(128)).is_some());
    }

    #[test]
    fn a_scope_is_validated_whole_and_stored_only_when_set() {
        let scope = parse(
            &json!({"allowed_names":[" Web-01","web-02"],"labels":{"Site":" Berlin ","rack":"a7"}}),
            Some("web-"),
        )
        .unwrap();
        let mut record = json!({"id":"t"});
        scope.store(&mut record);
        assert_eq!(record["allowed_names"], json!(["web-01", "web-02"]));
        assert_eq!(record["labels"], json!({"site":"Berlin","rack":"a7"}));

        let mut plain = json!({"id":"t"});
        parse(&json!({"allowed_names":null,"labels":{}}), None)
            .unwrap()
            .store(&mut plain);
        assert_eq!(plain, json!({"id":"t"}), "no scope, no new fields");

        for (payload, prefix) in [
            (json!({"allowed_names":[]}), None),
            (json!({"allowed_names":"web-01"}), None),
            (json!({"allowed_names":[1]}), None),
            (json!({"allowed_names":["bad name"]}), None),
            (json!({"allowed_names":["web-01","WEB-01"]}), None),
            (json!({"allowed_names":["db-01"]}), Some("web-")),
            (json!({"allowed_names":vec!["n"; MAX_NAMES + 1]}), None),
            (json!({"labels":[]}), None),
            (json!({"labels":{"bad key":"x"}}), None),
            (json!({"labels":{"site":""}}), None),
            (json!({"labels":{"site":3}}), None),
            (json!({"labels":{"Site":"a","site":"b"}}), None),
            (
                json!({"labels":(0..=MAX_LABELS).map(|n| (format!("k{n}"), json!("v"))).collect::<Map<_, _>>()}),
                None,
            ),
        ] {
            assert!(parse(&payload, prefix).is_err(), "{payload} {prefix:?}");
        }
        let many: Vec<String> = (0..MAX_NAMES).map(|n| format!("host-{n}")).collect();
        assert_eq!(
            parse(&json!({"allowed_names":many}), Some("host-"))
                .unwrap()
                .allowed_names
                .unwrap()
                .len(),
            MAX_NAMES
        );
    }

    #[test]
    fn a_listed_name_enrolls_once_and_other_names_never() {
        let mut record = json!({"allowed_names":["web-01","web-02"],"labels":{"site":"berlin"}});
        assert_eq!(refusal(&record, "web-03"), Some("NAME_NOT_PREAPPROVED"));
        assert_eq!(refusal(&record, "web-01"), None);
        record_use(&mut record, "web-01");
        assert_eq!(refusal(&record, "web-01"), Some("NAME_ALREADY_ENROLLED"));
        assert_eq!(refusal(&record, "web-02"), None);
        record_use(&mut record, "web-01");
        assert_eq!(record["enrolled_names"], json!(["web-01"]));
        assert_eq!(device_labels(&record), json!({"site":"berlin"}));

        let mut open = json!({"name_prefix":"web-"});
        assert_eq!(refusal(&open, "anything"), None);
        record_use(&mut open, "anything");
        assert!(open.get("enrolled_names").is_none());
        assert_eq!(device_labels(&open), json!({}));
    }
}
