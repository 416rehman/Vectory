use crate::vector_diagnostics::Diagnostic;
use base64::Engine;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

pub const VECTOR_VERSION: &str = "0.58.0";
/// Devices may run any patch release of the pinned minor version: Vector
/// patch releases fix bugs without changing configuration.
pub const VECTOR_SERIES: &str = "0.58";

/// Whether a device-reported Vector version is a patch release of the pinned
/// series: `0.58.0`, `0.58.3`, optionally `v`-prefixed or with build details
/// after a space (`0.58.1 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)`).
pub fn vector_compatible(reported: &str) -> bool {
    let version = reported.split_whitespace().next().unwrap_or("");
    let version = version.strip_prefix('v').unwrap_or(version);
    version
        .strip_prefix(VECTOR_SERIES)
        .and_then(|rest| rest.strip_prefix('.'))
        .is_some_and(|patch| {
            !patch.is_empty() && patch.len() <= 4 && patch.bytes().all(|b| b.is_ascii_digit())
        })
}

pub fn is_native_secret_reference(text: &str) -> bool {
    let text = text
        .strip_prefix("Bearer ")
        .or_else(|| text.strip_prefix("Basic "))
        .unwrap_or(text);
    if let Some(reference) = text
        .strip_prefix("SECRET[")
        .and_then(|s| s.strip_suffix(']'))
    {
        return reference.split_once('.').is_some_and(|(backend, key)| {
            !backend.is_empty()
                && !key.is_empty()
                && !reference
                    .chars()
                    .any(|c| c.is_whitespace() || c == '[' || c == ']')
        });
    }
    let name = text
        .strip_prefix("${")
        .and_then(|s| s.strip_suffix('}'))
        .or_else(|| text.strip_prefix('$'));
    name.is_some_and(|name| {
        !name.is_empty()
            && (name.as_bytes()[0].is_ascii_alphabetic() || name.starts_with('_'))
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
    })
}

fn credential_key_name(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['-', '.'], "_");
    // Vector also uses "key" for event-field names. These configure shape,
    // not authentication, and may legitimately be longer than eight bytes.
    if [
        "cache_size_per_key",
        "client_key",
        "client_metadata_key",
        "emit_events_discarded_per_key",
        "exchange_key",
        "file_key",
        "global_host_key",
        "global_log_schema_host_key",
        "global_timestamp_key",
        "headers_key",
        "host_key",
        "id_key",
        "include_key",
        "kms_key",
        "labels_key",
        "max_tracked_key",
        "message_key",
        "metadata_key",
        "offset_key",
        "partition_key",
        "path_key",
        "pid_key",
        "port_key",
        "properties_key",
        "redis_key",
        "routing_key",
        "sample_rate_key",
        "severity_key",
        "source_key",
        "source_type_key",
        "ssekms_key",
        "subject_key",
        "tag_cardinality_tracked_key",
        "tag_key",
        "timestamp_key",
        "timestamp_nanos_key",
        "topic_key",
    ]
    .contains(&key.as_str())
    {
        return false;
    }
    [
        "password",
        "passwd",
        "api_key",
        "apikey",
        "access_keys",
        "valid_tokens",
        "access_key_id",
        "secret_access_key",
        "token",
        "bearer",
        "authorization",
        "proxy_authorization",
        "client_secret",
        "private_key",
        "cookie",
        "set_cookie",
        "x_honeycomb_team",
        "dd_api_key",
        "x_api_key",
        "x_auth_token",
        "private_token",
        "x_insert_key",
        "x_license_key",
        "signature",
        "sig",
    ]
    .iter()
    .any(|name| key == *name || key.ends_with(&format!("_{name}")))
        || ["_token", "_key", "_secret", "_password", "_signature"]
            .iter()
            .any(|suffix| key.ends_with(suffix))
}

fn credential_header_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "token",
        "key",
        "secret",
        "auth",
        "cookie",
        "signature",
        "session",
    ]
    .iter()
    .any(|part| name.contains(part))
}

fn credential_query_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().replace(['-', '.'], "_").as_str(),
        "api_key"
            | "apikey"
            | "key"
            | "token"
            | "access_token"
            | "auth"
            | "sig"
            | "signature"
            | "secret"
            | "client_secret"
            | "password"
    )
}

fn placeholder_word(text: &str) -> bool {
    let text = text.trim();
    let text = ["Bearer ", "Basic ", "Token "]
        .into_iter()
        .find_map(|prefix| {
            text.get(..prefix.len())
                .filter(|head| head.eq_ignore_ascii_case(prefix))
                .map(|_| &text[prefix.len()..])
        })
        .unwrap_or(text);
    matches!(
        text.to_ascii_lowercase().as_str(),
        "changeme" | "example" | "redacted" | "xxxxxxxx"
    )
}

fn credential_literal(text: &str) -> bool {
    // Every cookie assignment must be a reference or a documented placeholder.
    // Looking only after the last '=' could excuse an earlier literal token;
    // treating an entirely native cookie list as plaintext would be noisy.
    let native_cookie_values = text.split(';').all(|assignment| {
        assignment
            .trim()
            .split_once('=')
            .is_some_and(|(key, value)| {
                !key.is_empty()
                    && key.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || [b'_', b'-', b'.'].contains(&byte)
                    })
                    && (is_native_secret_reference(value.trim()) || placeholder_word(value))
            })
    });
    let native_token = text
        .strip_prefix("Token ")
        .is_some_and(is_native_secret_reference);
    !text.trim().is_empty()
        && !placeholder_word(text)
        && !is_native_secret_reference(text)
        && !native_cookie_values
        && !native_token
}

fn substantial_credential_literal(text: &str) -> bool {
    text.chars().count() >= 8 && credential_literal(text)
}

fn decoded_url_piece(piece: &str) -> String {
    // Here '&' and '+' are URL-path characters, not form delimiters or spaces.
    let encoded = format!("v={}", piece.replace('&', "%26").replace('+', "%2B"));
    url::form_urlencoded::parse(encoded.as_bytes())
        .next()
        .map(|(_, decoded)| decoded.into_owned())
        .unwrap_or_default()
}

fn url_credential_candidate(text: &str) -> bool {
    let Ok(url) = url::Url::parse(text) else {
        // A malformed destination still reaches draft history. Do not let an
        // invalid URL evade the credential check before Vector rejects it.
        return text.split_once("://").is_some_and(|(_, tail)| {
            let authority = tail.split(['/', '?', '#']).next().unwrap_or("");
            authority.split_once('@').is_some_and(|(userinfo, _)| {
                userinfo
                    .split(':')
                    .any(|piece| credential_literal(&decoded_url_piece(piece)))
            }) || tail.split_once('?').is_some_and(|(_, query)| {
                url::form_urlencoded::parse(query.split('#').next().unwrap_or("").as_bytes())
                    .any(|(name, value)| credential_query_name(&name) && credential_literal(&value))
            })
        });
    };
    if credential_literal(&decoded_url_piece(url.username()))
        || url
            .password()
            .is_some_and(|password| credential_literal(&decoded_url_piece(password)))
    {
        return true;
    }
    if url
        .query_pairs()
        .any(|(name, value)| credential_query_name(&name) && credential_literal(&value))
    {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    let path: Vec<_> = url
        .path_segments()
        .into_iter()
        .flatten()
        .map(decoded_url_piece)
        .collect();
    let token = if host == "hooks.slack.com"
        && path.len() >= 4
        && path.first().is_some_and(|part| part == "services")
    {
        path.last()
    } else if [
        "discord.com",
        "discordapp.com",
        "canary.discord.com",
        "ptb.discord.com",
    ]
    .contains(&host.as_str())
        && path.len() >= 4
        && path[0] == "api"
        && path[1] == "webhooks"
    {
        path.get(3)
    } else if host == "webhook.office.com" || host.ends_with(".webhook.office.com") {
        path.last()
    } else if host == "outlook.office.com" && path.first().is_some_and(|part| part == "webhook") {
        path.last()
    } else {
        None
    };
    token.is_some_and(|value| substantial_credential_literal(value))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UrlCredentialScan {
    Clean,
    Plaintext,
    Limit,
}

fn url_credential_scan(text: &str) -> UrlCredentialScan {
    const MAX_URL_CANDIDATES: usize = 64;
    const MAX_URL_BYTES: usize = 16 * 1024;
    let mut prefix_end = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut candidates = 0;
    let mut limit = false;
    let found = text.match_indices("://").any(|(scheme_end, _)| {
        candidates += 1;
        if candidates > MAX_URL_CANDIDATES {
            // Avoid repeatedly parsing attacker-controlled nested URLs. An
            // exceptional field cannot safely enter draft history unchecked,
            // but it is not evidence that the field holds a credential.
            limit = true;
            return true;
        }
        let start = text[..scheme_end]
            .char_indices()
            .rev()
            .find(|(_, ch)| !(ch.is_ascii_alphanumeric() || *ch == '+' || *ch == '-' || *ch == '.'))
            .map_or(0, |(index, ch)| index + ch.len_utf8());
        let closing_wrapper = match text[..start].chars().last() {
            Some('(') => Some(')'),
            Some('<') => Some('>'),
            _ => None,
        };
        // Track an enclosing string across any prose before the URL. A quote
        // inside a direct URL is URL data, while an escaped quote in a VRL
        // string cannot close the URL before a later credential.
        for (offset, ch) in text[prefix_end..start].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if quote.is_some() && ch == '\\' {
                escaped = true;
                continue;
            }
            if quote == Some(ch) {
                quote = None;
            } else if quote.is_none() && ch == '"' {
                quote = Some(ch);
            } else if quote.is_none() && ch == '\'' {
                let at = prefix_end + offset;
                let before = &text[..at];
                let previous = before.chars().last();
                // `s'...'` is a VRL raw string. Do not mistake a word's
                // apostrophe (for example, "don't") for a string opener.
                let raw_string = previous == Some('s')
                    && before[..before.len() - 1]
                        .chars()
                        .last()
                        .is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_');
                if raw_string || previous.is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_')
                {
                    quote = Some(ch);
                }
            }
        }
        prefix_end = start;
        let tail = &text[scheme_end + 3..];
        let mut tail_escaped = false;
        let mut too_long = false;
        let mut end = tail
            .char_indices()
            .find(|(index, ch)| {
                if *index >= MAX_URL_BYTES {
                    too_long = true;
                    return true;
                }
                if ch.is_whitespace() {
                    return true;
                }
                if tail_escaped {
                    tail_escaped = false;
                    return false;
                }
                if quote.is_some() && *ch == '\\' {
                    tail_escaped = true;
                    return false;
                }
                quote == Some(*ch)
            })
            .map_or(text.len(), |(index, _)| scheme_end + 3 + index);
        if too_long || end - start > MAX_URL_BYTES {
            limit = true;
            return true;
        }
        // A presentation wrapper can end the URL only at the end of its
        // candidate. Stopping at the first `)` would miss a following literal
        // in `(...?api_key=example)more`.
        if let Some(wrapper) = closing_wrapper {
            if text[start..end].ends_with(wrapper) {
                end -= wrapper.len_utf8();
            }
        }
        url_credential_candidate(&text[start..end])
    });
    if limit {
        UrlCredentialScan::Limit
    } else if found {
        UrlCredentialScan::Plaintext
    } else {
        UrlCredentialScan::Clean
    }
}

fn plaintext_url_credential(text: &str) -> bool {
    url_credential_scan(text) == UrlCredentialScan::Plaintext
}

fn credential_token_shape(text: &str) -> bool {
    if text.contains("-----BEGIN ")
        && text.contains("PRIVATE KEY-----")
        && text.contains("-----END ")
    {
        return true;
    }
    text.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.'))
        .filter(|word| !word.is_empty())
        .any(|word| {
            if word.len() == 20
                && (word.starts_with("AKIA") || word.starts_with("ASIA"))
                && word[4..]
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
            {
                return true;
            }
            if let [header, payload, signature] = word.split('.').collect::<Vec<_>>().as_slice()
                && !header.is_empty()
                && payload.len() >= 8
                && signature.len() >= 8
                && let Ok(decoded) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(header)
                && serde_json::from_slice::<Value>(&decoded)
                    .ok()
                    .is_some_and(|header| header["alg"].as_str().is_some())
            {
                return true;
            }
            let prefix = [
                "xoxa-",
                "xoxb-",
                "xoxe-",
                "xoxp-",
                "xoxr-",
                "xoxs-",
                "ghp_",
                "github_pat_",
                "glpat-",
                "sk-",
            ]
            .into_iter()
            .find(|prefix| word.starts_with(prefix));
            prefix.is_some_and(|prefix| {
                let suffix = &word[prefix.len()..];
                suffix.len() >= 12
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            })
        })
}

/// High-confidence credential patterns for public variable bindings. Binding
/// values are durable and viewer-readable, but have no semantic field name to
/// judge; the explicit token shapes and URL credential sites are still unsafe.
pub fn strong_credential_shape(text: &str) -> bool {
    credential_token_shape(text) || url_credential_scan(text) != UrlCredentialScan::Clean
}

fn has_environment_reference(text: &str) -> bool {
    text.as_bytes()
        .windows(2)
        .any(|p| p[0] == b'$' && (p[1] == b'{' || p[1] == b'_' || p[1].is_ascii_alphabetic()))
}
fn is_device_path_field(key: &str) -> bool {
    [
        "path",
        "file",
        "files",
        "source_files",
        "search_dirs",
        "procfs_root",
        "sysfs_root",
    ]
    .contains(&key)
        || ["_file", "_files", "_path", "_paths", "_dir", "_dirs"]
            .iter()
            .any(|suffix| key.ends_with(suffix))
}
fn is_synthetic_test_event_field(path: &[String], key: &str) -> bool {
    // These are literal events supplied to Vector's unit-test inputs, not
    // configuration fields. Event keys such as `path` or `search_dirs` must not
    // turn a configuration into one requiring device-local resources.
    path.len() == 4
        && path[0] == "tests"
        && path[2] == "inputs"
        && ["log_fields", "metric", "value"].contains(&key)
}
pub fn needs_device_context(config: &Value) -> bool {
    !device_context_reasons(config).is_empty()
}
pub fn device_context_reasons(config: &Value) -> Vec<String> {
    fn walk(value: &Value, path: &mut Vec<String>, reasons: &mut BTreeSet<String>) {
        match value {
            Value::String(text) => {
                if has_environment_reference(text) {
                    reasons.insert("environment variables".into());
                }
                if text.contains("SECRET[") {
                    reasons.insert("native secret references".into());
                }
                if calls_device_function(text) || !file_argument_calls(text).is_empty() {
                    reasons.insert("VRL access to device resources".into());
                }
            }
            Value::Object(fields) => {
                // Component IDs and route names are user-chosen labels, not
                // configuration fields: an ID such as `file` or `logs_dir` must
                // not look like a device path.
                let labels = matches!(
                    path.as_slice(),
                    [section] if ["sources", "transforms", "sinks", "enrichment_tables"].contains(&section.as_str())
                ) || matches!(path.as_slice(), [section, _, field] if section == "transforms" && field == "route");
                for (key, value) in fields {
                    if is_synthetic_test_event_field(path, key) {
                        continue;
                    }
                    if labels {
                        path.push(key.clone());
                        walk(value, path, reasons);
                        path.pop();
                        continue;
                    }
                    match key.as_str() {
                        "provider" => {
                            reasons.insert("native configuration provider".into());
                        }
                        "secret" | "secrets" => {
                            reasons.insert("native secret providers".into());
                        }
                        "enrichment_tables" => {
                            reasons.insert("device enrichment data".into());
                        }
                        _ => {}
                    }
                    if is_device_path_field(key) {
                        reasons.insert("device-local paths or external code files".into());
                    }
                    path.push(key.clone());
                    walk(value, path, reasons);
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    path.push(index.to_string());
                    walk(item, path, reasons);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut reasons = BTreeSet::new();
    walk(config, &mut Vec::new(), &mut reasons);
    if !local_secret_scan(config).0.is_empty() {
        reasons.insert("device secrets".into());
    }
    if !lua_transforms(config).is_empty() {
        reasons.insert(LUA_ON_DEVICES.into());
    }
    if !file_enrichment_tables(config).is_empty() {
        reasons.insert(ENRICHMENT_ON_DEVICES.into());
    }
    if !instance_metadata_transforms(config).is_empty() {
        reasons.insert(INSTANCE_METADATA_ON_DEVICES.into());
    }
    if !file_remap_transforms(config).is_empty() {
        reasons.insert(REMAP_FILE_ON_DEVICES.into());
    }
    if let Some(sources) = config["sources"].as_object() {
        for source in sources.values() {
            let component = source["type"].as_str().unwrap_or("");
            // Exact platform-specific components from the pinned Vector 0.58 catalog.
            if ["dnstap", "file_descriptor", "journald", "windows_event_log"].contains(&component) {
                reasons.insert(format!("platform-specific source {component}"));
            }
        }
    }
    reasons.into_iter().collect()
}
/// A valid local secret name: a letter, then at most 63 letters, digits, `_`,
/// `.` or `-`.
pub fn is_secret_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphabetic()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
pub fn is_local_secret(value: &str) -> bool {
    value
        .strip_prefix("vectory-secret:")
        .is_some_and(is_secret_name)
}

// The generated device-secret field table, kept beside this module.
#[path = "secret_fields.rs"]
pub mod secret_fields;

/// The fix for a plaintext credential in a device-secret field.
pub const DEVICE_SECRET_FIX: &str = "Use a device secret: vectory-secret:NAME, then bind it on each device with `vectory configure-secrets`.";

/// One step of a configuration path: an object field or a list item. Keeping
/// them apart means an object key named `[]` is never taken for a list item.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathStep {
    Field(String),
    Item,
}

#[derive(Debug, PartialEq, Eq)]
enum FieldPattern {
    Field(&'static str),
    AnyKey,
    Item,
}

/// The table's paths per `(section, component type)`: `a.b` for fields, a
/// `[]` suffix for list items, `*` for any map key.
fn secret_field_patterns() -> &'static BTreeMap<(&'static str, &'static str), Vec<Vec<FieldPattern>>>
{
    static TABLE: OnceLock<BTreeMap<(&'static str, &'static str), Vec<Vec<FieldPattern>>>> =
        OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for (section, component_type, path) in secret_fields::SECRET_FIELDS {
            let mut steps = Vec::new();
            for field in path.split('.') {
                let name = field.trim_end_matches("[]");
                steps.push(match name {
                    "*" => FieldPattern::AnyKey,
                    name => FieldPattern::Field(name),
                });
                for _ in 0..(field.len() - name.len()) / 2 {
                    steps.push(FieldPattern::Item);
                }
            }
            table
                .entry((*section, *component_type))
                .or_default()
                .push(steps);
        }
        table
    })
}

/// Whether a path inside a component is one of the device-secret fields of
/// its section and type.
pub fn is_secret_field(section: &str, component_type: &str, path: &[PathStep]) -> bool {
    secret_field_patterns()
        .get(&(section, component_type))
        .is_some_and(|fields| {
            fields.iter().any(|pattern| {
                pattern.len() == path.len()
                    && pattern
                        .iter()
                        .zip(path)
                        .all(|(want, got)| match (want, got) {
                            (FieldPattern::Field(name), PathStep::Field(key)) => name == key,
                            (FieldPattern::AnyKey, PathStep::Field(_)) => true,
                            (FieldPattern::Item, PathStep::Item) => true,
                            _ => false,
                        })
            })
        })
}

/// Where a configuration value sits: the component that owns it, if any, and
/// the field inside it.
struct FieldLocation<'a> {
    section: &'a str,
    component: &'a str,
    component_type: Option<&'a str>,
    field: &'a [PathStep],
}

fn locate<'a>(config: &'a Value, path: &'a [PathStep]) -> Option<FieldLocation<'a>> {
    let [
        PathStep::Field(section),
        PathStep::Field(component),
        field @ ..,
    ] = path
    else {
        return None;
    };
    if !["sources", "transforms", "sinks"].contains(&section.as_str()) || field.is_empty() {
        return None;
    }
    let item = config[section.as_str()].get(component.as_str())?;
    item.is_object().then(|| FieldLocation {
        section,
        component,
        component_type: item["type"].as_str(),
        field,
    })
}

impl FieldLocation<'_> {
    /// A device-secret field of the agent's table.
    fn secret_field(&self) -> bool {
        self.component_type
            .is_some_and(|kind| is_secret_field(self.section, kind, self.field))
    }
    fn secret_field_or_descendant(&self) -> bool {
        self.component_type.is_some_and(|kind| {
            (1..=self.field.len())
                .any(|end| is_secret_field(self.section, kind, &self.field[..end]))
        })
    }
    /// `auth.user`, `auth.password` and `auth.token` of any sink: credentials
    /// before the table existed, whatever the sink type.
    fn legacy_sink_auth(&self) -> bool {
        self.section == "sinks"
            && matches!(self.field, [PathStep::Field(auth), PathStep::Field(key)]
                if auth == "auth" && ["user", "password", "token"].contains(&key.as_str()))
    }
    fn legacy_sink_auth_or_descendant(&self) -> bool {
        self.section == "sinks"
            && matches!(self.field,
                [PathStep::Field(auth), PathStep::Field(key), ..]
                if auth == "auth" && ["user", "password", "token"].contains(&key.as_str()))
    }
}

/// A path for people: `auth.token`, `valid_tokens[1]`.
fn display_path(path: &[PathStep], indexes: &[usize]) -> String {
    let mut out = String::new();
    let mut items = indexes.iter();
    for step in path {
        match step {
            PathStep::Field(key) => {
                if !out.is_empty() {
                    out.push('.');
                }
                out.push_str(key);
            }
            PathStep::Item => out.push_str(&format!("[{}]", items.next().copied().unwrap_or(0))),
        }
    }
    out
}

/// Visit every string with its path from the root and the index of each list
/// item on that path.
fn visit_strings(
    value: &Value,
    path: &mut Vec<PathStep>,
    indexes: &mut Vec<usize>,
    visit: &mut dyn FnMut(&str, &[PathStep], &[usize]),
) {
    match value {
        Value::String(text) => visit(text, path, indexes),
        Value::Object(fields) => {
            for (key, child) in fields {
                path.push(PathStep::Field(key.clone()));
                visit_strings(child, path, indexes, visit);
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(PathStep::Item);
                indexes.push(index);
                visit_strings(child, path, indexes, visit);
                indexes.pop();
                path.pop();
            }
        }
        _ => {}
    }
}

/// A `vectory-secret:NAME` reference at a device-secret field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalSecretReference {
    pub section: String,
    pub component: String,
    pub field: String,
    pub name: String,
}

/// Device-secret references and the problems with them: a reference outside
/// the table's fields, a malformed one, or plain text in a credential field.
/// Native `SECRET[...]`, `$NAME` and `${NAME}` references stay valid there.
pub fn local_secret_scan(config: &Value) -> (Vec<LocalSecretReference>, Vec<String>) {
    let mut references = Vec::new();
    let mut errors = Vec::new();
    visit_strings(
        config,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut |text, path, indexes| {
            let location = locate(config, path);
            let secret_field = location.as_ref().is_some_and(FieldLocation::secret_field);
            let (prefix, field) = match &location {
                Some(at) => {
                    let items = at.field.iter().filter(|s| **s == PathStep::Item).count();
                    (
                        format!("{}: ", at.component),
                        display_path(at.field, &indexes[indexes.len() - items..]),
                    )
                }
                None => (String::new(), display_path(path, indexes)),
            };
            if text.contains("vectory-secret:") {
                match (&location, secret_field, text.strip_prefix("vectory-secret:")) {
                    (Some(at), true, Some(name)) if is_secret_name(name) => {
                        references.push(LocalSecretReference {
                            section: at.section.to_owned(),
                            component: at.component.to_owned(),
                            field,
                            name: name.to_owned(),
                        })
                    }
                    (_, true, _) => errors.push(format!(
                        "{prefix}`{field}` must be exactly `vectory-secret:NAME`, where NAME is a letter followed by up to 63 letters, digits, dots, dashes or underscores."
                    )),
                    _ => errors.push(format!(
                        "{prefix}Only credential fields can hold a device secret, and `{field}` isn't one."
                    )),
                }
            } else if !text.trim().is_empty() && !is_native_secret_reference(text) {
                if secret_field {
                    errors.push(format!(
                        "{prefix}Plaintext credentials cannot be stored in `{field}`. {DEVICE_SECRET_FIX}"
                    ));
                } else if location
                    .as_ref()
                    .is_some_and(FieldLocation::legacy_sink_auth)
                {
                    errors.push(format!(
                        "{prefix}Plaintext credentials cannot be stored in `{field}`. Use a native secret or environment reference, such as SECRET[backend.key]."
                    ));
                }
            }
        },
    );
    (references, errors)
}

/// A plaintext credential finding contains only a location and a fixed fix.
/// The input value must never be included in validation, API or audit output.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CredentialFinding {
    pub code: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    pub field: String,
    pub message: String,
    pub fix: String,
}

fn is_test_input_event(path: &[PathStep]) -> bool {
    matches!(path,
        [PathStep::Field(tests), PathStep::Item, PathStep::Field(inputs), PathStep::Item,
         PathStep::Field(event), ..]
        if tests == "tests" && inputs == "inputs"
            && ["log_fields", "metric", "value"].contains(&event.as_str()))
}

/// Find plaintext credentials by their semantic field, header or query name,
/// known webhook shape, or a complete token shape. The same findings drive
/// validation and the structured draft refusal; test input events are data.
pub fn credential_findings(config: &Value) -> Vec<CredentialFinding> {
    const NATIVE_FIX: &str =
        "Use a native secret or environment reference, such as SECRET[backend.key].";
    let mut findings = Vec::new();
    visit_strings(
        config,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut |text, path, indexes| {
            if text.trim().is_empty()
                || is_test_input_event(path)
                || is_local_secret(text)
                || is_native_secret_reference(text)
            {
                return;
            }
            let location = locate(config, path);
            let secret_field = location
                .as_ref()
                .is_some_and(FieldLocation::secret_field_or_descendant);
            let legacy_auth = location
                .as_ref()
                .is_some_and(FieldLocation::legacy_sink_auth_or_descendant);
            // A malformed array or object under a credential key must not
            // smuggle literal strings into draft history. Component IDs are
            // labels, so only field steps within a component carry context.
            let field_path = location.as_ref().map_or_else(
                || match path {
                    [PathStep::Field(section), PathStep::Field(_), field @ ..]
                        if ["sources", "transforms", "sinks"].contains(&section.as_str()) =>
                    {
                        field
                    }
                    _ => path,
                },
                |at| at.field,
            );
            let credential_key = field_path.iter().any(|step| match step {
                PathStep::Field(key) => credential_key_name(key),
                PathStep::Item => false,
            });
            let credential_header = field_path.windows(2).any(|pair| {
                matches!(pair, [PathStep::Field(headers), PathStep::Field(name)]
                    if headers == "headers" && credential_header_name(name))
            });
            if !(secret_field
                || legacy_auth
                || ((credential_key || credential_header) && credential_literal(text))
                || plaintext_url_credential(text)
                || credential_token_shape(text))
            {
                return;
            }
            let full_path = display_path(path, indexes);
            let (component, field) = if let Some(at) = &location {
                let items = at
                    .field
                    .iter()
                    .filter(|step| **step == PathStep::Item)
                    .count();
                (
                    Some(at.component.to_owned()),
                    display_path(at.field, &indexes[indexes.len() - items..]),
                )
            } else {
                (None, full_path.clone())
            };
            let fix = if secret_field {
                DEVICE_SECRET_FIX
            } else {
                NATIVE_FIX
            };
            let prefix = component
                .as_deref()
                .filter(|_| secret_field || legacy_auth)
                .map_or_else(String::new, |name| format!("{name}: "));
            let named_field = if secret_field || legacy_auth {
                &field
            } else {
                &full_path
            };
            let message =
                format!("{prefix}Plaintext credentials cannot be stored in `{named_field}`. {fix}");
            findings.push(CredentialFinding {
                code: "plaintext_credential",
                path: full_path,
                component,
                field,
                message,
                fix: fix.into(),
            });
        },
    );
    findings
}

/// URL scans that exceed the conservative parsing budget are invalid input,
/// not plaintext findings. Refuse them before storage without alleging that a
/// harmless long field contains a credential.
pub fn credential_scan_limit_paths(config: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    visit_strings(
        config,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut |text, path, indexes| {
            if !is_test_input_event(path) && url_credential_scan(text) == UrlCredentialScan::Limit {
                paths.push(display_path(path, indexes));
            }
        },
    );
    paths
}

/// Whether a configuration uses device secrets, and the problems with its
/// references (see [`local_secret_scan`]).
pub fn local_secret_references(config: &Value) -> (bool, Vec<String>) {
    let (references, errors) = local_secret_scan(config);
    (!references.is_empty(), errors)
}

/// The secret names a device reports in its heartbeat: at most 64 distinct
/// valid names, never files or values. Returned sorted.
pub fn reported_secret_names(value: &Value) -> Option<Value> {
    let items = value.as_array().filter(|items| items.len() <= 64)?;
    let mut names = BTreeSet::new();
    for item in items {
        let name = item.as_str().filter(|name| is_secret_name(name))?;
        if !names.insert(name) {
            return None;
        }
    }
    Some(json!(names))
}

/// A device secret reference becomes a placeholder in the validation copy, as
/// a native reference does: its value exists only on devices. Only exact
/// references at device-secret fields are replaced.
fn replace_local_secrets(candidate: &mut Value, found: &mut BTreeSet<String>) {
    let mut targets = Vec::new();
    let view: &Value = candidate;
    visit_strings(
        view,
        &mut Vec::new(),
        &mut Vec::new(),
        &mut |text, path, indexes| {
            if is_local_secret(text) && locate(view, path).is_some_and(|at| at.secret_field()) {
                let mut items = indexes.iter();
                let pointer: String = path
                    .iter()
                    .map(|step| match step {
                        PathStep::Field(key) => {
                            format!("/{}", key.replace('~', "~0").replace('/', "~1"))
                        }
                        PathStep::Item => format!("/{}", items.next().copied().unwrap_or(0)),
                    })
                    .collect();
                targets.push((pointer, text.to_owned()));
            }
        },
    );
    for (pointer, reference) in targets {
        if let Some(slot) = candidate.pointer_mut(&pointer) {
            *slot = json!(PLACEHOLDER);
            found.insert(reference);
        }
    }
}

fn known_component(section: &str, component_type: &str) -> bool {
    static COMPONENTS: OnceLock<BTreeSet<(String, String)>> = OnceLock::new();
    COMPONENTS
        .get_or_init(|| {
            let catalog: Value =
                serde_json::from_str(include_str!("../../vector-catalog/catalog.json"))
                    .expect("pinned Vector component catalog must be JSON");
            catalog["components"]
                .as_array()
                .expect("pinned Vector component catalog must have components")
                .iter()
                .filter_map(|component| {
                    Some((
                        component["kind"].as_str()?.to_owned(),
                        component["type"].as_str()?.to_owned(),
                    ))
                })
                .collect()
        })
        .contains(&(section.to_owned(), component_type.to_owned()))
}

fn deferred_literal(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| has_environment_reference(text) || text.contains("SECRET["))
}

// These small literal checks cover constraints the pinned Vector 0.58 schema
// expresses unambiguously. They do not replace native validation, and values
// resolved only on a device must remain deferred rather than fail here.
fn validate_known_options(section: &str, name: &str, item: &Value, errors: &mut Vec<String>) {
    if section == "transforms" && item["type"] == "sample" {
        let has_rate = item.get("rate").is_some_and(|value| !value.is_null());
        let has_ratio = item.get("ratio").is_some_and(|value| !value.is_null());
        if has_rate == has_ratio {
            errors.push(format!(
                "{name}: sample requires exactly one of rate or ratio"
            ));
        }
        if has_rate && !deferred_literal(&item["rate"]) && item["rate"].as_u64().is_none() {
            errors.push(format!("{name}: sample rate must be an unsigned integer"));
        }
        if has_ratio
            && !deferred_literal(&item["ratio"])
            && item["ratio"]
                .as_f64()
                .is_none_or(|ratio| !(0.0..=1.0).contains(&ratio))
        {
            errors.push(format!("{name}: sample ratio must be between 0 and 1"));
        }
        let has_rate_field = item.get("rate_field").is_some_and(|value| !value.is_null());
        let has_ratio_field = item
            .get("ratio_field")
            .is_some_and(|value| !value.is_null());
        if has_rate_field && has_ratio_field {
            errors.push(format!(
                "{name}: sample cannot combine rate_field and ratio_field"
            ));
        }
        if item.get("key_field").is_some_and(|value| !value.is_null())
            && (has_rate_field || has_ratio_field)
        {
            errors.push(format!(
                "{name}: sample key_field cannot be combined with rate_field or ratio_field"
            ));
        }
    }
    if section != "sinks"
        || !known_component(section, item["type"].as_str().unwrap_or(""))
        || item.get("buffer").is_none()
    {
        return;
    }
    let buffer = &item["buffer"];
    if deferred_literal(buffer) {
        return;
    }
    let stages: Vec<&Value> = match buffer {
        Value::Object(_) => vec![buffer],
        Value::Array(stages) if !stages.is_empty() => stages.iter().collect(),
        _ => {
            errors.push(format!(
                "{name}: buffer must be an object or nonempty list of stages"
            ));
            return;
        }
    };
    let stage_count = stages.len();
    for (index, stage) in stages.into_iter().enumerate() {
        let location = if buffer.is_array() {
            format!("{name}: buffer stage {}", index + 1)
        } else {
            format!("{name}: buffer")
        };
        if !stage.is_object() {
            errors.push(format!("{location} must be an object"));
            continue;
        }
        let buffer_type = stage.get("type").unwrap_or(&Value::Null);
        let disk = buffer_type == "disk";
        if !buffer_type.is_null()
            && !deferred_literal(buffer_type)
            && buffer_type != "memory"
            && !disk
        {
            errors.push(format!("{location} type must be memory or disk"));
        }
        for field in ["max_events", "max_size"] {
            if let Some(value) = stage.get(field) {
                if !deferred_literal(value) && value.as_u64().is_none_or(|number| number == 0) {
                    errors.push(format!("{location} {field} must be a positive integer"));
                }
            }
        }
        if !disk
            && !deferred_literal(buffer_type)
            && stage.get("max_events").is_some()
            && stage.get("max_size").is_some()
        {
            errors.push(format!(
                "{location} memory buffers cannot combine max_events and max_size"
            ));
        }
        if disk {
            match stage.get("max_size") {
                None | Some(Value::Null) => {
                    errors.push(format!("{location} disk buffers require max_size"));
                }
                Some(value)
                    if !deferred_literal(value)
                        && value.as_u64().is_some_and(|number| number < 268_435_488) =>
                {
                    errors.push(format!(
                        "{location} disk max_size must be at least 268435488 bytes"
                    ));
                }
                _ => {}
            }
        }
        if let Some(when_full) = stage.get("when_full") {
            if !deferred_literal(when_full)
                && when_full != "block"
                && when_full != "drop_newest"
                && !(when_full == "overflow" && index + 1 < stage_count)
            {
                errors.push(format!("{location} when_full must be block, drop_newest, or overflow to a following stage"));
            }
        }
    }
}
/// Version of the private worker reply. The API refuses replies from a worker
/// that cannot report structured diagnostics, placeholders and stand-ins, so
/// an outdated worker is never mistaken for a completed check.
pub const WORKER_PROTOCOL: u64 = 2;
/// Token substituted for a secret or environment reference. A diagnostic that
/// quotes it describes the placeholder, not the device's real value.
pub const PLACEHOLDER: &str = "vectory-placeholder";

/// The `deferred_reasons` value for a draft with a `lua` transform. Lua can run
/// any program (`os.execute`, `io.popen`), and Vector runs a transform's Lua
/// when it builds the transform, which `vector test` does. User Lua therefore
/// never runs in the validator: a device checks it, and a device in full mode
/// runs it.
pub const LUA_ON_DEVICES: &str = "Lua runs on devices";

/// Why a `lua` step is replaced by a stand-in; the note reads "This step ...".
const LUA_STAND_IN: &str = "runs Lua code, so only a device checks it";

/// The `deferred_reasons` value for a draft with an enrichment table that reads
/// a file (`file`, `geoip`, `mmdb`). Vector opens the file when it builds the
/// table, which `vector test` does, and a lookup returns the rows to whoever
/// wrote it. The server never reads a path an author names; a device reads its
/// own files.
pub const ENRICHMENT_ON_DEVICES: &str = "Enrichment tables are read on devices";

/// Why a step that looks up an enrichment table is replaced by a stand-in.
const ENRICHMENT_STAND_IN: &str = "looks up an enrichment table, which each device reads";

/// The `deferred_reasons` value for a draft with an `aws_ec2_metadata`
/// transform. When Vector builds the transform, which `vector test` does, it
/// sends a token request (`PUT /latest/api/token`) and a request for the
/// instance identity document (`GET /latest/dynamic/instance-identity/document`)
/// to the `endpoint` the author wrote, and reports what came back. The server
/// never sends a request an author wrote: a device, which is the host the step
/// asks about, checks it.
pub const INSTANCE_METADATA_ON_DEVICES: &str =
    "The AWS instance metadata step is checked on devices";

/// Why an `aws_ec2_metadata` step is replaced by a stand-in; the note reads
/// "This step ...".
const INSTANCE_METADATA_STAND_IN: &str =
    "asks an AWS instance metadata service, so only a device checks it";

/// The `deferred_reasons` value for a draft with a remap that loads its VRL
/// program from a file (`file` or `files`). Vector opens the file when it
/// builds the remap, which `vector test` does, and quotes the program's lines
/// in its errors. The server never reads a path an author names: a device
/// reads its own files.
pub const REMAP_FILE_ON_DEVICES: &str = "A VRL program in a file is read on devices";

/// Why a remap that loads its program from a file is replaced by a stand-in;
/// the note reads "This step ...".
const REMAP_FILE_STAND_IN: &str = "loads its VRL program from a file on each device";

/// How many of a remap's three ways to name its program are set. Vector wants
/// exactly one of them.
fn remap_program_sources(remap: &Value) -> usize {
    ["source", "file", "files"]
        .iter()
        .filter(|key| !remap[**key].is_null())
        .count()
}

/// Whether a remap's program is in a file: `file` or `files` and no other way
/// to name it. A remap that names its program twice never reaches a file, and
/// Vector says so itself, so the check lets it.
fn loads_program_from_file(remap: &Value) -> bool {
    remap_program_sources(remap) == 1 && (!remap["file"].is_null() || !remap["files"].is_null())
}

/// A component's `type` as the checked copy reads it, once references are
/// replaced the way `static_candidate` replaces them: `${KIND:-lua}` is `lua`.
fn resolved_type(kind: &Value) -> Option<String> {
    let text = kind.as_str()?;
    Some(
        substitute_references(text, "type", &mut BTreeSet::new())
            .unwrap_or_else(|| text.to_owned()),
    )
}

/// The IDs of the transforms of one type in the copy Vector would read.
fn transforms_of_type(config: &Value, kind: &str) -> Vec<String> {
    config["transforms"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, transform)| resolved_type(&transform["type"]).as_deref() == Some(kind))
        .map(|(id, _)| id.clone())
        .collect()
}

/// The IDs of the transforms that are Lua in the copy Vector would read.
pub fn lua_transforms(config: &Value) -> Vec<String> {
    transforms_of_type(config, "lua")
}

/// The IDs of the transforms that ask an AWS instance metadata service in the
/// copy Vector would read.
pub fn instance_metadata_transforms(config: &Value) -> Vec<String> {
    transforms_of_type(config, "aws_ec2_metadata")
}

/// The IDs of the remaps that load their VRL program from a file, in the copy
/// Vector would read.
pub fn file_remap_transforms(config: &Value) -> Vec<String> {
    config["transforms"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, transform)| {
            resolved_type(&transform["type"]).as_deref() == Some("remap")
                && loads_program_from_file(transform)
        })
        .map(|(id, _)| id.clone())
        .collect()
}

/// The IDs of the enrichment tables that read a file: every type but `memory`,
/// so a type this server does not know counts as one that reads a file.
pub fn file_enrichment_tables(config: &Value) -> Vec<String> {
    config["enrichment_tables"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, table)| resolved_type(&table["type"]).as_deref() != Some("memory"))
        .map(|(id, _)| id.clone())
        .collect()
}

/// The finding for tests the server does not run because the draft has a Lua
/// step, an enrichment table that reads a file, an AWS instance metadata step
/// or a remap that loads its program from a file: a device runs them, and the
/// check on devices can include them. It names every cause the draft has.
/// `None` for any other draft.
pub fn tests_on_devices_diagnostic(config: &Value) -> Option<Diagnostic> {
    // The causes in the order they are named: whether the draft has one, what
    // the sentence says of it, and how the sentence ends when it is the only one.
    let causes: Vec<(&str, &str)> = [
        (
            !lua_transforms(config).is_empty(),
            "Lua can run any program",
            "include it",
        ),
        (
            !file_enrichment_tables(config).is_empty(),
            "enrichment tables are read on devices",
            "use them",
        ),
        (
            !instance_metadata_transforms(config).is_empty(),
            "the AWS instance metadata step asks the host's own metadata service",
            "include it",
        ),
        (
            !file_remap_transforms(config).is_empty(),
            "a VRL program in a file is read on devices",
            "include it",
        ),
    ]
    .into_iter()
    .filter(|(present, ..)| *present)
    .map(|(_, cause, ending)| (cause, ending))
    .collect();
    let (mut clause, ending) = match causes.as_slice() {
        [] => return None,
        [(cause, ending)] => ((*cause).to_owned(), *ending),
        [first @ .., (last, _)] => (
            format!(
                "{} and {last}",
                first
                    .iter()
                    .map(|(cause, _)| *cause)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "include them",
        ),
    };
    clause[..1].make_ascii_uppercase();
    Some(Diagnostic {
        section: Some("tests".into()),
        code: Some("tests_on_devices".into()),
        ..Diagnostic::error(format!(
            "{clause}, so tests that {ending} run only on devices. Use Check on devices with Also run the pipeline's tests."
        ))
    })
}

/// A copy of a draft prepared for `vector validate --no-environment` in the
/// isolated worker. It never contains resolved secrets: native references are
/// replaced by typed placeholders, secret backends and configuration
/// providers are removed (they may run programs or fetch remote content), and
/// components that only a device can load are replaced by inert stand-ins.
pub struct StaticCandidate {
    pub config: Value,
    /// Distinct `${VAR}`, `$VAR` and `SECRET[backend.key]` references replaced by placeholders.
    pub placeholders: Vec<String>,
    /// Component ID → reason it was replaced by an inert stand-in.
    pub stubbed: BTreeMap<String, String>,
    /// False when a configuration provider supplies the pipeline on the device.
    pub checkable: bool,
}

fn valid_reference_name(name: &str) -> bool {
    name.as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_alphabetic() || *b == b'_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A placeholder that still parses where the reference stood: a socket
/// address for `*address`, a URL for endpoints, a path for file fields and a
/// port after `host:`. Anything else becomes a plain token.
fn placeholder_value(key: &str, whole: bool, after_colon: bool) -> &'static str {
    if !whole {
        return if after_colon { "9" } else { PLACEHOLDER };
    }
    let key = key.to_ascii_lowercase();
    if key.ends_with("address") {
        "127.0.0.1:9"
    } else if ["endpoint", "endpoints", "uri", "url", "urls"].contains(&key.as_str())
        || key.ends_with("_url")
        || key.ends_with("_uri")
        || key.ends_with("_endpoint")
    {
        "http://127.0.0.1:9"
    } else if key == "path"
        || key.ends_with("_path")
        || key.ends_with("_file")
        || key.ends_with("_dir")
    {
        "/vectory-placeholder"
    } else {
        PLACEHOLDER
    }
}

/// Replace native references in one string, following Vector's interpolation
/// syntax (`${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:?err}`,
/// `$NAME`, `$$` escapes) and `SECRET[backend.key]`. A declared default is used
/// as-is. Returns `None` when the string holds no reference.
pub fn substitute_references(
    text: &str,
    key: &str,
    found: &mut BTreeSet<String>,
) -> Option<String> {
    let mut spans: Vec<(usize, usize, String, Option<String>)> = Vec::new();
    let mut index = 0;
    while index < text.len() {
        let rest = &text[index..];
        if rest.starts_with("SECRET[")
            && let Some(end) = rest.find(']')
            && is_native_secret_reference(&rest[..=end])
        {
            spans.push((index, index + end + 1, rest[..=end].to_owned(), None));
            index += end + 1;
            continue;
        }
        if rest.starts_with("$$") {
            index += 2;
            continue;
        }
        if let Some(inner) = rest.strip_prefix("${")
            && let Some(end) = inner.find('}')
        {
            let body = &inner[..end];
            let name_end = body
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(body.len());
            let (name, modifier) = body.split_at(name_end);
            let default = modifier
                .strip_prefix(":-")
                .or_else(|| modifier.strip_prefix('-'));
            if valid_reference_name(name)
                && (modifier.is_empty()
                    || default.is_some()
                    || modifier.starts_with(":?")
                    || modifier.starts_with('?'))
            {
                spans.push((
                    index,
                    index + end + 3,
                    rest[..end + 3].to_owned(),
                    default.map(str::to_owned),
                ));
                index += end + 3;
                continue;
            }
        }
        if let Some(inner) = rest.strip_prefix('$') {
            let end = inner
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(inner.len());
            if valid_reference_name(&inner[..end]) {
                spans.push((index, index + end + 1, rest[..end + 1].to_owned(), None));
                index += end + 1;
                continue;
            }
        }
        index += rest.chars().next().map_or(1, char::len_utf8);
    }
    if spans.is_empty() {
        return None;
    }
    let whole = spans.len() == 1 && spans[0].0 == 0 && spans[0].1 == text.len();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, end, reference, default) in spans {
        out.push_str(&text[last..start]);
        match default {
            Some(value) => out.push_str(&value),
            None => out.push_str(placeholder_value(key, whole, text[..start].ends_with(':'))),
        }
        found.insert(reference);
        last = end;
    }
    out.push_str(&text[last..]);
    Some(out)
}

/// An inert component with the same ID and inputs, used where a component
/// can't be built on the worker. Diagnostics about stand-ins are discarded.
fn stand_in(section: &str, inputs: Option<&Value>) -> Value {
    let inputs = inputs.cloned().unwrap_or_else(|| json!([]));
    match section {
        "sources" => json!({"type":"demo_logs","format":"json"}),
        "transforms" => json!({"type":"remap","inputs":inputs,"source":"."}),
        _ => json!({"type":"blackhole","inputs":inputs}),
    }
}

pub fn static_candidate(config: &Value, available: impl Fn(&str, &str) -> bool) -> StaticCandidate {
    fn walk(value: &mut Value, key: &str, found: &mut BTreeSet<String>) {
        match value {
            Value::String(text) => {
                if let Some(next) = substitute_references(text, key, found) {
                    *text = next;
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, key, found)),
            Value::Object(fields) => {
                for (field, item) in fields.iter_mut() {
                    walk(item, field, found);
                }
            }
            _ => {}
        }
    }
    let mut candidate = config.clone();
    let checkable = config.get("provider").is_none_or(Value::is_null);
    if let Some(root) = candidate.as_object_mut() {
        root.remove("secret");
        root.remove("provider");
    }
    let mut placeholders = BTreeSet::new();
    replace_local_secrets(&mut candidate, &mut placeholders);
    walk(&mut candidate, "", &mut placeholders);
    // Only a memory table reads no file. The others never reach Vector: it opens
    // their file when it builds them, which `vector test` does. A step that
    // looks one up cannot be compiled without it, so it gets a stand-in too.
    let reads_files = candidate["enrichment_tables"]
        .as_object()
        .is_some_and(|tables| tables.values().any(|table| table["type"] != "memory"));
    if let Some(tables) = candidate
        .get_mut("enrichment_tables")
        .and_then(Value::as_object_mut)
    {
        tables.retain(|_, table| table["type"] == "memory");
    }
    let mut stubbed = BTreeMap::new();
    for section in ["sources", "transforms", "sinks"] {
        let Some(components) = candidate.get_mut(section).and_then(Value::as_object_mut) else {
            continue;
        };
        for (id, component) in components.iter_mut() {
            let kind = component["type"].as_str().unwrap_or("").to_owned();
            // Whatever its form (inline source, hooks, timers, modules, either
            // version), a Lua step is never built here: its code runs when
            // Vector builds it, which is any program its author wrote.
            let reason = if section == "transforms" && kind == "lua" {
                Some(LUA_STAND_IN.to_owned())
            } else if section == "transforms" && kind == "aws_ec2_metadata" {
                // Vector sends requests to the step's `endpoint` when it builds
                // it, and quotes the answer in its errors.
                Some(INSTANCE_METADATA_STAND_IN.to_owned())
            } else if known_component(section, &kind) && !available(section, &kind) {
                Some(format!(
                    "`{kind}` isn't included in this server's Vector build; each device checks it"
                ))
            } else if section == "transforms"
                && kind == "remap"
                && loads_program_from_file(component)
            {
                // A remap that also names an inline program is left to Vector,
                // which refuses it before it opens any file.
                Some(REMAP_FILE_STAND_IN.to_owned())
            } else if reads_a_file(component) {
                // Compiling these reads the file, and the worker's answer would
                // describe the worker's files, not the device's.
                Some("reads a file on each device".to_owned())
            } else if reads_files && calls_any(component, ENRICHMENT_VRL_FUNCTIONS) {
                Some(ENRICHMENT_STAND_IN.to_owned())
            } else {
                None
            };
            if let Some(reason) = reason {
                *component = stand_in(section, component.get("inputs"));
                stubbed.insert(id.clone(), reason);
            }
        }
    }
    StaticCandidate {
        config: candidate,
        placeholders: placeholders.into_iter().take(64).collect(),
        stubbed,
        checkable,
    }
}

/// After a failed load, repair the candidate so the next run can report the
/// remaining problems. Vector stops at the first option error, so each broken
/// component is replaced by a stand-in (or loses the unknown option) until the
/// topology and VRL compile stages are reached. Returns false when nothing
/// could be repaired.
pub fn repair_candidate(
    candidate: &mut Value,
    errors: &[Diagnostic],
    stubbed: &mut BTreeMap<String, String>,
) -> bool {
    fn component<'a>(candidate: &'a mut Value, section: &str, id: &str) -> Option<&'a mut Value> {
        candidate.get_mut(section)?.get_mut(id)
    }
    let mut changed = false;
    for error in errors {
        let section = error.section.as_deref().unwrap_or("");
        match (section, error.component.as_deref(), error.code.as_deref()) {
            ("global", _, Some("unknown_field")) => {
                if let (Some(field), Some(root)) = (&error.field, candidate.as_object_mut()) {
                    changed |= root.remove(field).is_some();
                }
            }
            ("tests", _, _) => {
                if let Some(root) = candidate.as_object_mut() {
                    changed |= root.remove("tests").is_some();
                }
            }
            (section, Some(id), code) if ["sources", "transforms", "sinks"].contains(&section) => {
                let Some(item) = component(candidate, section, id) else {
                    continue;
                };
                match code {
                    Some("missing_input" | "type_mismatch") => {
                        let related = error.related.first().cloned().unwrap_or_default();
                        if let Some(inputs) = item.get_mut("inputs").and_then(Value::as_array_mut) {
                            let before = inputs.len();
                            inputs.retain(|input| input.as_str() != Some(related.as_str()));
                            changed |= inputs.len() != before;
                        }
                    }
                    Some("unknown_field") => {
                        if let (Some(field), Some(object)) = (&error.field, item.as_object_mut()) {
                            changed |= object.remove(field).is_some();
                        }
                    }
                    Some("cycle") => {}
                    _ if error.line.is_none() && !stubbed.contains_key(id) => {
                        let inputs = item.get("inputs").cloned();
                        *item = stand_in(section, inputs.as_ref());
                        stubbed.insert(id.to_owned(), "reported above".into());
                        changed = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    // A consumer left without inputs is removed with every reference to it, so
    // the next run can reach the checks that follow.
    loop {
        let mut removed = Vec::new();
        for section in ["transforms", "sinks"] {
            if let Some(items) = candidate.get_mut(section).and_then(Value::as_object_mut) {
                items.retain(|id, item| {
                    let empty = item["inputs"].as_array().is_some_and(Vec::is_empty);
                    if empty {
                        removed.push(id.clone());
                    }
                    !empty
                });
            }
        }
        if removed.is_empty() {
            break;
        }
        changed = true;
        for id in &removed {
            stubbed.insert(id.clone(), "reported above".into());
        }
        for section in ["transforms", "sinks"] {
            if let Some(items) = candidate.get_mut(section).and_then(Value::as_object_mut) {
                for item in items.values_mut() {
                    if let Some(inputs) = item.get_mut("inputs").and_then(Value::as_array_mut) {
                        inputs.retain(|input| {
                            let name = input.as_str().unwrap_or("");
                            !removed
                                .iter()
                                .any(|id| name == id || name.starts_with(&format!("{id}.")))
                        });
                    }
                }
            }
        }
    }
    changed
}

/// Vector's `*` and `?` input wildcards. Iterative with one backtrack point,
/// so the cost stays O(pattern × text) however many stars a draft contains.
fn glob_match(pattern: &str, text: &str) -> bool {
    let (pattern, text) = (pattern.as_bytes(), text.as_bytes());
    if pattern.len() > 256 {
        return false;
    }
    let (mut p, mut t) = (0, 0);
    // The last star seen and the text position it currently absorbs up to.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some(b'*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&c) if c == b'?' || c == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                Some((star_p, star_t)) => {
                    star = Some((star_p, star_t + 1));
                    p = star_p + 1;
                    t = star_t + 1;
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|&c| c == b'*')
}

/// True when the original draft connects `id` (or its named output) to a
/// consumer, including through a wildcard input. A "no consumers" warning for
/// such a component only reflects a repair made during checking.
pub fn consumed(config: &Value, id: &str, output: Option<&str>) -> bool {
    let reference = match output {
        Some(output) => format!("{id}.{output}"),
        None => id.to_owned(),
    };
    ["transforms", "sinks", "enrichment_tables"]
        .iter()
        .any(|section| {
            config[*section].as_object().is_some_and(|items| {
                items.values().any(|item| {
                    item["inputs"].as_array().is_some_and(|inputs| {
                        inputs.iter().filter_map(Value::as_str).any(|input| {
                            input == reference
                                || (input.contains(['*', '?']) && glob_match(input, &reference))
                        })
                    })
                })
            })
        })
}

/// True when a diagnostic only concerns a stand-in component.
pub fn about_stand_in(diagnostic: &Diagnostic, stubbed: &BTreeMap<String, String>) -> bool {
    diagnostic
        .component
        .as_deref()
        .is_some_and(|id| stubbed.contains_key(id))
        || diagnostic
            .related
            .iter()
            .any(|related| stubbed.contains_key(related.split('.').next().unwrap_or(related)))
}

/// A placeholder can make Vector reject a value the device will supply. Such
/// a finding is a device check, not an error in the draft.
pub fn soften_placeholder(mut diagnostic: Diagnostic) -> Diagnostic {
    let mentions = |text: &Option<String>| text.as_deref().is_some_and(|t| t.contains(PLACEHOLDER));
    if diagnostic.severity == "error"
        && (diagnostic.message.contains(PLACEHOLDER) || mentions(&diagnostic.detail))
    {
        diagnostic.severity = "warning";
        diagnostic.code = Some("device_value".into());
        diagnostic.message =
            "This value comes from a secret or environment reference. Each device checks it before applying.".into();
        diagnostic.hint = None;
        diagnostic.fix = None;
    }
    diagnostic
}

/// The code and field of a device-secret problem from `local_secret_scan`.
fn secret_problem(message: &str) -> Option<(&'static str, &str)> {
    fn field(rest: &str) -> Option<&str> {
        rest.split_once('`').map(|(field, _)| field)
    }
    if let Some(rest) = message.strip_prefix("Plaintext credentials cannot be stored in `") {
        return Some(("plaintext_credential", field(rest)?));
    }
    if let Some(rest) =
        message.strip_prefix("Only credential fields can hold a device secret, and `")
    {
        return Some(("secret_reference_refused", field(rest)?));
    }
    let rest = message.strip_prefix('`')?;
    rest.contains("` must be exactly `vectory-secret:NAME`")
        .then(|| field(rest).map(|field| ("secret_reference_invalid", field)))
        .flatten()
}

/// Convert server structural errors and warnings into diagnostics.
pub fn structural_diagnostics(config: &Value, result: &Value) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for (key, severity) in [("errors", "error"), ("warnings", "warning")] {
        for message in result[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let mut diagnostic = Diagnostic {
                severity,
                message: message.to_owned(),
                ..Default::default()
            };
            if let Some((id, rest)) = message.split_once(": ")
                && let Some(section) = crate::vector_diagnostics::section_of(config, id)
            {
                diagnostic.section = Some(section.into());
                diagnostic.component = Some(id.into());
                diagnostic.message = rest.trim().to_owned();
                if let Some(input) = rest.strip_prefix("unknown input ") {
                    diagnostic.code = Some("missing_input".into());
                    diagnostic.field = Some("inputs".into());
                    diagnostic.related = vec![input.trim().to_owned()];
                    diagnostic.message =
                        format!("Input `{}` does not match any component.", input.trim());
                } else if let Some(producer) = rest
                    .strip_prefix('`')
                    .and_then(|rest| rest.split_once("` emits "))
                    .map(|(producer, _)| producer)
                    .filter(|_| rest.contains(" accepts "))
                {
                    diagnostic.code = Some("type_mismatch".into());
                    diagnostic.field = Some("inputs".into());
                    diagnostic.related = vec![producer.to_owned()];
                    diagnostic.hint = Some(
                        "Connect a step that produces the event type this component accepts."
                            .into(),
                    );
                } else if let Some((code, field)) = secret_problem(rest) {
                    diagnostic.code = Some(code.into());
                    diagnostic.field = Some(field.into());
                } else if rest.contains("input") || rest.contains("output") {
                    diagnostic.field = Some("inputs".into());
                }
            } else if let Some(id) = message.strip_prefix("Duplicate component ID: ") {
                diagnostic = diagnostic.at(config, id.trim());
                diagnostic.code = Some("duplicate_id".into());
            } else if let Some((code, field)) = secret_problem(message) {
                diagnostic.code = Some(code.into());
                diagnostic.field = Some(field.into());
            } else if message == "Pipeline contains a cycle" {
                diagnostic.code = Some("cycle".into());
            } else if message.starts_with("At least one source")
                || message.starts_with("At least one sink")
            {
                diagnostic.section = Some("global".into());
                diagnostic.code = Some("empty_pipeline".into());
            }
            out.push(diagnostic);
        }
    }
    out
}

fn reason_phrase(reasons: &[String]) -> String {
    let phrases: Vec<String> = reasons
        .iter()
        .map(|reason| match reason.as_str() {
            "environment variables" => "environment variables".into(),
            "native secret references" | "native secret providers" | "device secrets" => {
                "secrets".into()
            }
            "VRL access to device resources" => "VRL that reads device resources".into(),
            LUA_ON_DEVICES => "Lua code".into(),
            INSTANCE_METADATA_ON_DEVICES => "the AWS instance metadata step".into(),
            REMAP_FILE_ON_DEVICES => "local files and paths".into(),
            "native configuration provider" => "the configuration provider".into(),
            "device enrichment data" | ENRICHMENT_ON_DEVICES => "enrichment data files".into(),
            "device-local paths or external code files" => "local files and paths".into(),
            other => other.strip_prefix("platform-specific source ").map_or_else(
                || other.to_owned(),
                |kind| format!("the {kind} source's platform"),
            ),
        })
        .collect();
    let mut unique: Vec<String> = Vec::new();
    for phrase in phrases {
        if !unique.contains(&phrase) {
            unique.push(phrase);
        }
    }
    match unique.len() {
        0 => String::new(),
        1 => unique[0].clone(),
        n => format!("{} and {}", unique[..n - 1].join(", "), unique[n - 1]),
    }
}

/// Assemble the public check result from diagnostics. `errors` and `warnings`
/// remain for existing clients; `diagnostics` is the structured form.
fn check_result(
    diagnostics: Vec<Diagnostic>,
    vector_ran: bool,
    vector_clean: bool,
    reasons: Vec<String>,
    placeholders: Vec<String>,
) -> Value {
    let mut diagnostics = diagnostics;
    let mut seen = BTreeSet::new();
    diagnostics.retain(|d| {
        seen.insert((
            d.severity,
            d.component.clone(),
            d.route_output.clone(),
            d.code.clone(),
            d.line,
            d.column,
            d.message.clone(),
        ))
    });
    let hidden = diagnostics
        .len()
        .saturating_sub(crate::vector_diagnostics::MAX_DIAGNOSTICS);
    diagnostics.sort_by_key(|d| d.severity != "error");
    diagnostics.truncate(crate::vector_diagnostics::MAX_DIAGNOSTICS);
    let valid = !diagnostics.iter().any(|d| d.severity == "error");
    let deferred = !reasons.is_empty() || !placeholders.is_empty();
    let mut warnings: Vec<String> = diagnostics
        .iter()
        .filter(|d| d.severity == "warning")
        .map(Diagnostic::summary)
        .collect();
    if hidden > 0 {
        warnings.push(format!("{hidden} more findings are not shown."));
    }
    if deferred {
        let what = reason_phrase(&reasons);
        warnings.push(if what.is_empty() {
            "Each device checks this version with its own Vector before applying it.".into()
        } else {
            format!("Each device checks {what} before applying this version.")
        });
    }
    let mut result = json!({
        "valid": valid,
        "vector_validated": valid && vector_ran && vector_clean && !deferred,
        "static_checked": vector_ran,
        "deferred": deferred,
        "diagnostics": diagnostics.iter().map(Diagnostic::to_json).collect::<Vec<_>>(),
        "errors": diagnostics.iter().filter(|d| d.severity == "error").map(Diagnostic::summary).collect::<Vec<_>>(),
        "warnings": warnings,
        "vector_version": VECTOR_VERSION,
    });
    if !reasons.is_empty() {
        result["deferred_reasons"] = json!(reasons);
    }
    if !placeholders.is_empty() {
        result["placeholders"] = json!(placeholders);
    }
    result
}

fn worker_client() -> crate::error::Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| crate::error::ApiError::invalid("Validator client unavailable"))
}

/// Say in the server's log why the worker's answer was unusable. Every check
/// reports the same sentence when that happens (the validator is unavailable),
/// so the log is where an operator finds the cause. Only fixed phrases and
/// numbers go in: nothing the worker or a draft sent.
fn worker_fault(path: &str, reason: &str) {
    tracing::warn!(
        path,
        reason,
        "the isolated validator gave no usable answer; the checks that need it are blocked"
    );
}

/// Why an answer in the right protocol still can't be used. The three readers
/// (`validate`, `tests` and `transform-test`) share the phrases, and each logs
/// one when it refuses the answer.
const NO_VERDICT: &str = "its answer lacks a true-or-false verdict";
const BAD_DIAGNOSTICS: &str = "its diagnostics are not in the expected form";
const BAD_PLACEHOLDER: &str = "a placeholder it names is not in the draft";
const BAD_TESTS: &str = "its test results are not in the expected form";
const BAD_SAMPLES: &str = "its sample results are not in the expected form";

fn request_fault(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "it did not answer within 8 seconds"
    } else if error.is_connect() {
        "the server could not connect to it"
    } else if error.is_body() || error.is_decode() {
        "its answer could not be read"
    } else {
        "the request to it failed"
    }
}

/// POST to the isolated worker and read a bounded JSON reply.
async fn worker_call(url: &str, path: &str, body: &Value, limit: usize) -> Option<Value> {
    let Ok(client) = worker_client() else {
        worker_fault(path, "the server's HTTP client could not be built");
        return None;
    };
    let mut response = match client
        .post(format!("{}/{path}", url.trim_end_matches('/')))
        .json(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            worker_fault(path, request_fault(&error));
            return None;
        }
    };
    if !response.status().is_success() {
        worker_fault(
            path,
            &format!("it answered HTTP {}", response.status().as_u16()),
        );
        return None;
    }
    if response
        .content_length()
        .is_some_and(|n| n as usize > limit)
    {
        worker_fault(path, "its answer is larger than the server accepts");
        return None;
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= limit => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(Some(_)) => {
                worker_fault(path, "its answer is larger than the server accepts");
                return None;
            }
            Ok(None) => break,
            Err(error) => {
                worker_fault(path, request_fault(&error));
                return None;
            }
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        worker_fault(path, "its answer is not JSON");
        return None;
    };
    if value["worker_protocol"] != WORKER_PROTOCOL || value["vector_version"] != VECTOR_VERSION {
        worker_fault(
            path,
            "it speaks another protocol, or runs another Vector, than this server expects",
        );
        return None;
    }
    Some(value)
}

/// What the server reads from a worker's `/validate` answer: the diagnostics,
/// placeholders and stand-ins, whether Vector ran and whether it accepted the
/// draft. The error says what is wrong with an answer that cannot be used.
type ValidateReply = (Vec<Value>, Vec<String>, Vec<String>, bool, bool);

fn read_validate_reply(config: &Value, value: &Value) -> Result<ValidateReply, &'static str> {
    let native = crate::vector_diagnostics::sanitize(config, &value["diagnostics"])
        .ok_or(BAD_DIAGNOSTICS)?;
    let placeholders =
        worker_placeholders(config, &value["placeholders"]).ok_or(BAD_PLACEHOLDER)?;
    let stubbed = value["stubbed"]
        .as_array()
        .filter(|list| list.len() <= 64)
        .ok_or("its list of stand-ins is missing or too long")?;
    if !value["static_checked"].is_boolean() || !value["valid"].is_boolean() {
        return Err(NO_VERDICT);
    }
    let stubbed: Vec<String> = stubbed
        .iter()
        .map(|id| id.as_str().filter(|id| id.len() <= 128).map(str::to_owned))
        .collect::<Option<_>>()
        .ok_or("a stand-in it names is not a short text")?;
    Ok((
        native,
        placeholders,
        stubbed,
        value["static_checked"] == true,
        value["valid"] == true,
    ))
}

fn worker_busy() -> crate::error::ApiError {
    crate::error::ApiError::new(
        axum::http::StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Validation capacity busy; retry later",
    )
}

/// Placeholders must be references that literally appear in the checked draft.
fn worker_placeholders(config: &Value, value: &Value) -> Option<Vec<String>> {
    let text = config.to_string();
    let items = value.as_array()?;
    if items.len() > 64 {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let item = item.as_str()?;
            (item.len() <= 200 && text.contains(item)).then(|| item.to_owned())
        })
        .collect()
}

pub async fn validate_isolated(s: &crate::State, config: &Value) -> crate::error::Result<Value> {
    let structural = validate(config);
    let mut diagnostics = structural_diagnostics(config, &structural);
    let mut reasons = device_context_reasons(config);
    let Some(url) = &s.settings.validation_url else {
        diagnostics.push(Diagnostic {
            code: Some("structural_only".into()),
            ..Diagnostic::warning(
                "Only the pipeline structure was checked here. Vector isn't configured on this server; each device validates before applying.",
            )
        });
        return Ok(check_result(diagnostics, false, false, reasons, vec![]));
    };
    if !config.is_object() {
        return Ok(check_result(diagnostics, false, false, reasons, vec![]));
    }
    if config.get("provider").is_some_and(|p| !p.is_null()) {
        diagnostics.push(Diagnostic {
            code: Some("provider".into()),
            section: Some("global".into()),
            ..Diagnostic::warning(
                "A configuration provider supplies this pipeline on each device, so Vector can't check it here.",
            )
        });
        return Ok(check_result(diagnostics, false, false, reasons, vec![]));
    }
    let _permit = s
        .validation_slots
        .try_acquire()
        .map_err(|_| worker_busy())?;
    let reply = worker_call(url, "validate", &json!({"config":config}), 256 * 1024).await;
    let checked = match reply
        .as_ref()
        .map(|value| read_validate_reply(config, value))
    {
        Some(Ok(parts)) => Some(parts),
        Some(Err(reason)) => {
            worker_fault("validate", reason);
            None
        }
        None => None,
    };
    let Some((native, placeholders, stubbed, ran, worker_valid)) = checked else {
        diagnostics.push(Diagnostic {
            code: Some("validator_unavailable".into()),
            ..Diagnostic::error(
                "Configured isolated Vector validator is unavailable; publication is blocked.",
            )
        });
        return Ok(check_result(diagnostics, false, false, reasons, vec![]));
    };
    let structural_components: BTreeSet<Option<String>> = diagnostics
        .iter()
        .filter(|d| d.severity == "error")
        .map(|d| d.component.clone())
        .collect();
    for item in native {
        let diagnostic = Diagnostic::from_json(&item);
        // The server's structural checks already explain topology errors.
        if matches!(
            diagnostic.code.as_deref(),
            Some("missing_input" | "cycle" | "type_mismatch")
        ) && structural_components.contains(&diagnostic.component)
        {
            continue;
        }
        diagnostics.push(diagnostic);
    }
    if !ran {
        diagnostics.push(Diagnostic {
            code: Some("validator_incomplete".into()),
            ..Diagnostic::error("Vector did not finish checking this pipeline. Try again.")
        });
    } else if !worker_valid && !diagnostics.iter().any(|d| d.severity == "error") {
        diagnostics.push(Diagnostic::error(
            "Vector rejected the configuration without a specific message.",
        ));
    }
    // A Lua, instance metadata or file-backed remap step's stand-in is explained
    // by its own reason; any other stand-in is a device-local file or component.
    let explained = [
        lua_transforms(config),
        instance_metadata_transforms(config),
        file_remap_transforms(config),
    ]
    .concat();
    if stubbed.iter().any(|id| !explained.contains(id))
        && !reasons
            .iter()
            .any(|r| r.contains("platform") || r.contains("paths"))
    {
        reasons.push("device-local paths or external code files".into());
    }
    Ok(check_result(
        diagnostics,
        ran,
        stubbed.is_empty(),
        reasons,
        placeholders,
    ))
}

/// Maximum synthetic samples in one tester run and their combined JSON size.
pub const MAX_SAMPLES: usize = 20;
pub const MAX_SAMPLE_BYTES: usize = 65536;

/// The transform types the sample tester can run: they need only the event.
pub fn testable_transform(transform: &Value) -> std::result::Result<&str, &'static str> {
    let kind = transform["type"].as_str().unwrap_or("");
    if !["remap", "filter", "route", "exclusive_route"].contains(&kind) {
        return Err("Sample testing supports remap, filter, route and exclusive route steps.");
    }
    if kind == "remap" && (!transform["file"].is_null() || !transform["files"].is_null()) {
        return Err(
            "This step loads VRL from a file on each device. Paste the program inline to test it with samples.",
        );
    }
    if kind == "remap" && !transform["source"].is_string() {
        return Err("Enter a VRL program to test.");
    }
    Ok(kind)
}

/// VRL functions that reach outside the event. A device refuses them in
/// restricted mode, and a pipeline that calls one needs full mode. The agent
/// (`externalVRL`) and the dashboard (`deviceVrlFunctions`) list the same
/// names; `tests/security/test_vrl_function_lists.py` fails when they drift.
/// `parse_etld(psl:)` and `parse_groks(alias_sources:)` read a file only when a
/// call passes one, so they are not listed here: see `FILE_ARGUMENT_FUNCTIONS`.
pub const DEVICE_VRL_FUNCTIONS: &[&str] = &[
    "get_env_var",
    "get_secret",
    "set_secret",
    "remove_secret",
    "get_enrichment_table_record",
    "find_enrichment_table_records",
    "dns_lookup",
    "reverse_dns",
    "http_request",
    "validate_json_schema",
    "parse_proto",
    "encode_proto",
];

/// The device functions that send network requests. Samples, unit tests and the
/// VRL tester execute in the isolated worker, which must never send a request
/// that an author wrote (it would read anything the worker can reach and return
/// the answer); a device runs these for real.
pub const NETWORK_VRL_FUNCTIONS: &[&str] = &["http_request", "dns_lookup", "reverse_dns"];

/// The device functions that read a file (a JSON schema or a protobuf
/// descriptor). The worker never runs them either: the error text quotes the
/// file's own values, and a missing file answers "does this path exist".
pub const FILE_VRL_FUNCTIONS: &[&str] = &["validate_json_schema", "parse_proto", "encode_proto"];

/// Whether `text` calls the VRL function `name`: `name(` or `name!(` that is
/// not the end of a longer identifier or a field path. VRL allows no space
/// between a name and its parenthesis; this tolerates one, so it never misses
/// a call. A metric named `http_requests_total` or an event value
/// `"http_request"` is not a call.
pub fn calls_function(text: &str, name: &str) -> bool {
    text.match_indices(name).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
            return false;
        }
        let rest = text[start + name.len()..].trim_start();
        rest.strip_prefix('!')
            .unwrap_or(rest)
            .trim_start()
            .starts_with('(')
    })
}

/// VRL functions that read a file only when a call passes one: `parse_groks`
/// takes `alias_sources` (JSON files of grok aliases) and `parse_etld` takes
/// `psl` (a public suffix list). Pinned Vector 0.58 opens the file when it
/// compiles the program, in any command and on a branch that never runs, so a
/// call that passes one is a file read, however the argument is written. Each
/// entry is the function, its named file argument, the argument count at which
/// the file is a positional one, and how a refusal names the call. The agent
/// (`fileArgumentFunctions` in `agent/internal/agent/vrl_file_arguments.go`) and
/// the dashboard (`fileArgumentFunctions` in `dashboard/src/vrlFileArguments.ts`)
/// hold the same table and scan, and `vector-catalog/fixtures/vrl-file-arguments.json`
/// holds the programs all three judge alike; `tests/security/test_vrl_function_lists.py`
/// fails when the tables drift. A device in restricted mode refuses such a call,
/// and a pipeline that makes one needs a full-mode device.
pub const FILE_ARGUMENT_FUNCTIONS: &[(&str, &str, usize, &str)] = &[
    (
        "parse_groks",
        "alias_sources",
        4,
        "parse_groks with alias_sources",
    ),
    ("parse_etld", "psl", 3, "parse_etld with psl"),
];

/// How a scan reads quotes. VRL ends a string or literal (`"..."`, `s'...'`,
/// `r'...'`) at the first quote that no backslash escapes. A second reading ends
/// a single-quoted one at the next `'` whatever precedes it, and a third ignores
/// quotes and comments, so a program that one reading misjudges can't hide an
/// argument from all of them: every call is read each way.
#[derive(Clone, Copy)]
enum Quotes {
    Escaped,
    Raw,
    Ignored,
}

/// What one reading of a call finds.
struct CallArguments {
    /// The arguments, top-level and trimmed.
    arguments: Vec<String>,
    /// Whether the call closed before the text ended.
    closed: bool,
    /// How many bytes of the text the reading went through, up to and including
    /// the closing parenthesis, or all of it when the call never closed.
    read: usize,
}

/// The arguments of one call, from the text after its opening parenthesis up to
/// the matching one: split on commas that are not inside brackets, braces,
/// parentheses, strings or comments.
fn call_arguments(body: &str, quotes: Quotes) -> CallArguments {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut chars = body.chars();
    while let Some(c) = chars.next() {
        match (c, quotes) {
            ('"' | '\'', Quotes::Escaped | Quotes::Raw) => {
                current.push(c);
                while let Some(inner) = chars.next() {
                    current.push(inner);
                    if inner == '\\' && (c == '"' || matches!(quotes, Quotes::Escaped)) {
                        current.extend(chars.next());
                    } else if inner == c {
                        break;
                    }
                }
            }
            ('#', Quotes::Escaped | Quotes::Raw) => {
                for inner in chars.by_ref() {
                    if inner == '\n' {
                        break;
                    }
                }
                current.push(' ');
            }
            ('(' | '[' | '{', _) => {
                depth += 1;
                current.push(c);
            }
            (')' | ']' | '}', _) if depth == 0 => {
                if !current.trim().is_empty() {
                    arguments.push(current.trim().to_owned());
                }
                return CallArguments {
                    arguments,
                    closed: true,
                    read: body.len() - chars.as_str().len(),
                };
            }
            (')' | ']' | '}', _) => {
                depth -= 1;
                current.push(c);
            }
            (',', _) if depth == 0 => {
                arguments.push(current.trim().to_owned());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    if !current.trim().is_empty() {
        arguments.push(current.trim().to_owned());
    }
    CallArguments {
        arguments,
        closed: false,
        read: body.len(),
    }
}

/// The most calls to one function, the most text of one call, and the most text
/// in all that are read. A program past any of them is taken to pass a file: no
/// real one is. The text in all is `MAX_SCAN_FACTOR` times the program's length
/// and `MAX_CALL_BYTES` more, counting every reading of every call: ordinary
/// calls read each byte of the program three times at most, so only calls nested
/// in each other, or left open so that each reads the rest again, reach it. It
/// keeps the work of a scan in step with the size of what it scans, however the
/// calls are arranged.
const MAX_FILE_ARGUMENT_CALLS: usize = 256;
const MAX_CALL_BYTES: usize = 32 * 1024;
const MAX_SCAN_FACTOR: usize = 4;

/// How `text` names each call it makes to a function with a file argument
/// (`FILE_ARGUMENT_FUNCTIONS`) that passes one, by name or by position. A call
/// that is read ambiguously counts as passing one: a stand-in only defers the
/// check to a device.
pub fn file_argument_calls(text: &str) -> Vec<&'static str> {
    let budget = MAX_SCAN_FACTOR * text.len() + MAX_CALL_BYTES;
    FILE_ARGUMENT_FUNCTIONS
        .iter()
        .filter(|(name, argument, positional, _)| {
            let mut read = 0;
            let mut scanned = 0;
            text.match_indices(name).any(|(start, _)| {
                let before = text[..start].chars().next_back();
                if before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
                    return false;
                }
                let rest = text[start + name.len()..].trim_start();
                let rest = rest.strip_prefix('!').unwrap_or(rest).trim_start();
                let Some(body) = rest.strip_prefix('(') else {
                    return false;
                };
                read += 1;
                if read > MAX_FILE_ARGUMENT_CALLS {
                    return true;
                }
                let mut end = body.len().min(MAX_CALL_BYTES);
                while !body.is_char_boundary(end) {
                    end -= 1;
                }
                let window = &body[..end];
                [Quotes::Escaped, Quotes::Raw, Quotes::Ignored]
                    .into_iter()
                    .any(|quotes| {
                        let call = call_arguments(window, quotes);
                        scanned += call.read;
                        (!call.closed && end < body.len())
                            || scanned > budget
                            || call.arguments.len() >= *positional
                            || call.arguments.iter().any(|argument_text| {
                                argument_text
                                    .strip_prefix(argument)
                                    .is_some_and(|after| after.trim_start().starts_with(':'))
                            })
                    })
            })
        })
        .map(|(_, _, _, label)| *label)
        .collect()
}

/// Whether `text` calls any VRL function that reaches outside the event.
pub fn calls_device_function(text: &str) -> bool {
    DEVICE_VRL_FUNCTIONS
        .iter()
        .any(|function| calls_function(text, function))
}

/// The device functions that look up an enrichment table. Compiling a call
/// needs the table, and a table that reads a file is never built in the worker.
pub const ENRICHMENT_VRL_FUNCTIONS: &[&str] = &[
    "get_enrichment_table_record",
    "find_enrichment_table_records",
];

/// Whether any string in `value` calls one of the functions `names`.
fn calls_any(value: &Value, names: &[&str]) -> bool {
    match value {
        Value::String(text) => names.iter().any(|name| calls_function(text, name)),
        Value::Array(items) => items.iter().any(|item| calls_any(item, names)),
        Value::Object(fields) => fields.values().any(|item| calls_any(item, names)),
        _ => false,
    }
}

/// Whether any string in `value` reads a file when Vector compiles it: a call
/// of a file-reading function, or of one that is passed a file.
fn reads_a_file(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            FILE_VRL_FUNCTIONS
                .iter()
                .any(|name| calls_function(text, name))
                || !file_argument_calls(text).is_empty()
        }
        Value::Array(items) => items.iter().any(reads_a_file),
        Value::Object(fields) => fields.values().any(reads_a_file),
        _ => false,
    }
}

/// The worker-refused functions called anywhere in the strings of a JSON
/// document: the network functions and the file-reading ones.
pub fn unrunnable_vrl_calls(value: &Value) -> BTreeSet<&'static str> {
    fn walk(value: &Value, found: &mut BTreeSet<&'static str>) {
        match value {
            Value::String(text) => {
                for name in NETWORK_VRL_FUNCTIONS.iter().chain(FILE_VRL_FUNCTIONS) {
                    if calls_function(text, name) {
                        found.insert(*name);
                    }
                }
                found.extend(file_argument_calls(text));
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, found)),
            Value::Object(fields) => fields.values().for_each(|item| walk(item, found)),
            _ => {}
        }
    }
    let mut found = BTreeSet::new();
    walk(value, &mut found);
    found
}

/// The diagnostic for a program the worker will not execute because it sends
/// network requests or reads files. `error` when nothing can run, `warning`
/// when only tests are skipped.
pub fn unrunnable_call_diagnostic(
    found: &BTreeSet<&'static str>,
    severity: &'static str,
) -> Diagnostic {
    let names = found.iter().copied().collect::<Vec<_>>().join(", ");
    let network = found
        .iter()
        .any(|name| NETWORK_VRL_FUNCTIONS.contains(name));
    let files = found.iter().any(|name| {
        FILE_VRL_FUNCTIONS.contains(name)
            || FILE_ARGUMENT_FUNCTIONS
                .iter()
                .any(|(_, _, _, label)| label == name)
    });
    let (does, never) = match (network, files) {
        (true, true) => (
            "sends network requests and reads files",
            "The server never sends requests or reads device files",
        ),
        (false, true) => ("reads files", "The server never reads device files"),
        _ => ("sends network requests", "The server never sends requests"),
    };
    let mut diagnostic = Diagnostic::error(format!(
        "This program calls {names}, which {does}. {never} from samples or tests."
    ));
    diagnostic.severity = severity;
    diagnostic.code = Some("vrl_function_unavailable".into());
    diagnostic.hint = Some(
        "A device in full mode runs it for real. Test the rest of the program here, or check it on a device."
            .into(),
    );
    diagnostic
}

fn port_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The output ports a sample run observes, in display order.
pub fn sample_ports(transform: &Value) -> Vec<String> {
    match transform["type"].as_str().unwrap_or("") {
        "route" => {
            let mut ports: Vec<String> = transform["route"]
                .as_object()
                .map(|routes| routes.keys().filter(|k| port_name(k)).cloned().collect())
                .unwrap_or_default();
            if transform["reroute_unmatched"] != false {
                ports.push("_unmatched".into());
            }
            ports
        }
        "exclusive_route" => {
            let mut ports: Vec<String> = transform["routes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|route| route["name"].as_str())
                .filter(|name| port_name(name))
                .map(str::to_owned)
                .collect();
            ports.push("_unmatched".into());
            ports
        }
        "remap" => vec![String::new(), "dropped".into()],
        _ => vec![String::new()],
    }
}

/// Build the isolated micro-pipeline for synthetic samples:
/// stdin (one JSON line per sample) → sample intake → the step under test →
/// one tagging remap per output → console (JSON). Remap runs with
/// `drop_on_error`, `drop_on_abort` and `reroute_dropped` enabled so errors and
/// aborts are observed with Vector's own reason; the UI explains what the
/// step's real settings do with such an event.
pub fn sample_pipeline(transform: &Value, data_dir: &str, timezone: Option<&str>) -> Value {
    let mut step = transform.clone();
    if let Some(object) = step.as_object_mut() {
        object.remove("inputs");
        object.remove("graph");
        object.insert("inputs".into(), json!(["vectory_sample_in"]));
        if object.get("type").and_then(Value::as_str) == Some("remap") {
            object.insert("drop_on_error".into(), json!(true));
            object.insert("drop_on_abort".into(), json!(true));
            object.insert("reroute_dropped".into(), json!(true));
        }
    }
    let mut transforms = serde_json::Map::new();
    transforms.insert(
        "vectory_sample_in".into(),
        json!({"type":"remap","inputs":["vectory_samples"],"source":"sample = object!(parse_json!(string!(.message)))\n%vectory_sample = sample.i\n. = object!(sample.e)"}),
    );
    transforms.insert("vectory_step".into(), step);
    // One line per sample, straight from the input: the worker keeps stdin
    // open until the last one is printed (see `sample_done_marker`).
    transforms.insert(
        "vectory_sample_done".into(),
        json!({"type":"remap","inputs":["vectory_sample_in"],"source":". = {\"m\": %vectory_sample}"}),
    );
    for (index, port) in sample_ports(transform).iter().enumerate() {
        let input = if port.is_empty() {
            "vectory_step".to_owned()
        } else {
            format!("vectory_step.{port}")
        };
        let label = serde_json::to_string(port).unwrap_or_else(|_| "\"\"".into());
        let source = if port == "dropped" {
            format!(". = {{\"s\": %vectory_sample, \"o\": {label}, \"d\": .metadata.dropped}}")
        } else {
            format!(
                "vectory_timestamps = keys(filter(flatten(.)) -> |_key, value| {{ is_timestamp(value) }})\n. = {{\"s\": %vectory_sample, \"o\": {label}, \"e\": ., \"t\": vectory_timestamps}}"
            )
        };
        transforms.insert(
            format!("vectory_out_{index}"),
            json!({"type":"remap","inputs":[input],"source":source}),
        );
    }
    let mut config = json!({
        "data_dir": data_dir,
        "sources": {"vectory_samples": {"type":"stdin"}},
        "transforms": transforms,
        "sinks": {"vectory_console": {"type":"console","inputs":["vectory_out_*","vectory_sample_done"],"encoding":{"codec":"json"},"target":"stdout"}},
    });
    if let Some(timezone) = timezone {
        config["timezone"] = json!(timezone);
    }
    config
}

/// What the console prints once the last of `samples` samples has entered the
/// micro-pipeline. Vector drops the events still in flight when its stdin
/// ends (about one run in a hundred lost the last sample's outputs), so the
/// worker holds stdin open until it sees this and the output has gone quiet.
pub fn sample_done_marker(samples: usize) -> Vec<u8> {
    format!("{{\"m\":{}}}", samples.saturating_sub(1)).into_bytes()
}

/// Byte offsets from a VRL runtime error, `at (37:75)`, as a 1-based line,
/// column and length in the program.
pub fn runtime_position(program: &str, message: &str) -> Option<(u64, u64, u64)> {
    let (_, rest) = message.split_once(" at (")?;
    let (span, _) = rest.split_once(')')?;
    let (start, end) = span.split_once(':')?;
    let (start, end): (usize, usize) = (start.parse().ok()?, end.parse().ok()?);
    if start > end
        || end > program.len()
        || !program.is_char_boundary(start)
        || !program.is_char_boundary(end)
    {
        return None;
    }
    let before = &program[..start];
    let line = before.matches('\n').count() as u64 + 1;
    let column = before.rsplit('\n').next().unwrap_or("").chars().count() as u64 + 1;
    Some((line, column, program[start..end].chars().count() as u64))
}

/// Group the console lines of a sample run by sample, in port order.
pub fn sample_results(transform: &Value, samples: usize, stdout: &[u8]) -> Vec<Value> {
    let kind = transform["type"].as_str().unwrap_or("");
    let ports = sample_ports(transform);
    let program = transform["source"].as_str().unwrap_or("");
    let mut results: Vec<Value> = (0..samples)
        .map(|index| json!({"sample":index,"outputs":[]}))
        .collect();
    for line in String::from_utf8_lossy(stdout).lines() {
        let Ok(item) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(index) = item["s"]
            .as_u64()
            .map(|i| i as usize)
            .filter(|i| *i < samples)
        else {
            continue;
        };
        let port = item["o"].as_str().unwrap_or("");
        let result = &mut results[index];
        if port == "dropped" {
            let dropped = &item["d"];
            let reason = dropped["reason"].as_str().unwrap_or("error");
            let message = dropped["message"].as_str().unwrap_or("").to_owned();
            result["outcome"] = json!(if reason == "abort" {
                "aborted"
            } else {
                "error"
            });
            if reason != "abort" {
                result["message"] = json!(crate::vector_diagnostics::bounded(&message, 600));
                if let Some((line, column, length)) = runtime_position(program, &message) {
                    result["line"] = json!(line);
                    result["column"] = json!(column);
                    result["length"] = json!(length);
                }
            }
            continue;
        }
        if !ports.iter().any(|p| p == port) || !item["e"].is_object() {
            continue;
        }
        let timestamps: Vec<Value> = item["t"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t.as_str().is_some_and(|t| t.len() <= 256))
            .take(256)
            .cloned()
            .collect();
        if let Some(outputs) = result["outputs"].as_array_mut()
            && outputs.len() < 8
            && item["e"].to_string().len() <= 32 * 1024
        {
            outputs.push(json!({"port":port,"event":item["e"],"timestamps":timestamps}));
        }
    }
    for result in &mut results {
        let emitted = result["outputs"].as_array().is_some_and(|o| !o.is_empty());
        if result.get("outcome").is_some() {
            continue;
        }
        result["outcome"] = json!(match (emitted, kind) {
            (true, _) => "emitted",
            (false, "filter") => "filtered",
            (false, "route" | "exclusive_route") => "unmatched",
            (false, _) => "dropped",
        });
        if let Some(outputs) = result["outputs"].as_array_mut() {
            outputs.sort_by_key(|output| {
                ports
                    .iter()
                    .position(|port| output["port"].as_str() == Some(port))
                    .unwrap_or(usize::MAX)
            });
        }
    }
    results
}

fn sanitize_results(value: &Value, samples: usize, ports: &[String]) -> Option<Vec<Value>> {
    let items = value.as_array()?;
    if items.len() != samples {
        return None;
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            if item["sample"].as_u64() != Some(index as u64) {
                return None;
            }
            let outcome = item["outcome"].as_str().filter(|o| {
                [
                    "emitted",
                    "filtered",
                    "unmatched",
                    "dropped",
                    "error",
                    "aborted",
                ]
                .contains(o)
            })?;
            let outputs = item["outputs"].as_array()?;
            if outputs.len() > 8 {
                return None;
            }
            let outputs = outputs
                .iter()
                .map(|output| {
                    let port = output["port"]
                        .as_str()
                        .filter(|p| ports.iter().any(|q| q == p))?;
                    let event = output["event"].as_object()?;
                    if output["event"].to_string().len() > 32 * 1024 {
                        return None;
                    }
                    let timestamps = output["timestamps"].as_array()?;
                    if timestamps.len() > 256
                        || timestamps
                            .iter()
                            .any(|t| t.as_str().is_none_or(|t| t.len() > 256))
                    {
                        return None;
                    }
                    Some(json!({"port":port,"event":event,"timestamps":timestamps}))
                })
                .collect::<Option<Vec<_>>>()?;
            let mut clean = json!({"sample":index,"outcome":outcome,"outputs":outputs});
            if let Some(message) = item.get("message") {
                let message = message.as_str().filter(|m| m.len() <= 2400)?;
                clean["message"] = json!(crate::vector_diagnostics::bounded(
                    &message
                        .chars()
                        .filter(|c| !c.is_control() || *c == '\n')
                        .collect::<String>(),
                    600
                ));
            }
            for key in ["line", "column", "length"] {
                if let Some(number) = item.get(key) {
                    clean[key] = json!(number.as_u64().filter(|n| *n <= 1_000_000)?);
                }
            }
            Some(clean)
        })
        .collect()
}

fn api_error(
    status: axum::http::StatusCode,
    code: &'static str,
    message: &'static str,
) -> crate::error::ApiError {
    crate::error::ApiError::new(status, code, message)
}

/// `POST /api/v1/vrl/test`. Runs user-provided synthetic samples through one
/// transform in the isolated worker. Accepts the original `{program, sample}`
/// body or `{transform, samples, timezone?}`.
pub async fn synthetic_vrl(
    axum::extract::State(s): axum::extract::State<crate::State>,
    h: axum::http::HeaderMap,
    axum::Json(input): axum::Json<Value>,
) -> crate::error::Result<axum::Json<Value>> {
    use axum::http::StatusCode;
    let user = crate::auth::authorize(&s, &h, &["editor", "operator"], true).await?;
    let legacy = input.get("transform").is_none();
    let (transform, samples) = if legacy {
        crate::db::string(&input, "program", 16384)?;
        if !input["sample"].is_object() {
            return Err(crate::error::ApiError::invalid(
                "Provide one synthetic sample object of at most 64 KiB",
            ));
        }
        (
            json!({"type":"remap","source":input["program"]}),
            vec![input["sample"].clone()],
        )
    } else {
        let transform = input["transform"].clone();
        if !transform.is_object() || transform.to_string().len() > 65536 {
            return Err(crate::error::ApiError::invalid(
                "Provide the step's settings as an object of at most 64 KiB",
            ));
        }
        let samples = input["samples"].as_array().cloned().unwrap_or_default();
        if samples.is_empty()
            || samples.len() > MAX_SAMPLES
            || samples.iter().any(|s| !s.is_object())
        {
            return Err(crate::error::ApiError::invalid(
                "Provide 1 to 20 synthetic sample objects",
            ));
        }
        (transform, samples)
    };
    if json!(samples).to_string().len() > MAX_SAMPLE_BYTES {
        return Err(crate::error::ApiError::invalid(
            "Synthetic samples must total at most 64 KiB",
        ));
    }
    let timezone = match input.get("timezone") {
        None | Some(Value::Null) => None,
        Some(Value::String(zone)) if zone.len() <= 64 && !zone.chars().any(char::is_control) => {
            Some(zone.clone())
        }
        Some(_) => {
            return Err(crate::error::ApiError::invalid(
                "Timezone must be a short name",
            ));
        }
    };
    if let Err(message) = testable_transform(&transform) {
        return Err(crate::error::ApiError::invalid(message));
    }
    // A debounced auto-run fires after typing pauses; the worker still has two slots.
    s.limit(
        format!("vrl:{}", crate::api::text(&user, "id")),
        120,
        std::time::Duration::from_secs(60),
    )?;
    let url = s.settings.validation_url.as_ref().ok_or_else(|| {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "CAPABILITY_DENIED",
            "Isolated synthetic sample runner is not configured",
        )
    })?;
    let _permit = s
        .validation_slots
        .try_acquire()
        .map_err(|_| worker_busy())?;
    let request = json!({"transform":transform,"samples":samples,"timezone":timezone});
    let reply = worker_call(url, "transform-test", &request, 512 * 1024)
        .await
        .ok_or_else(|| {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "VALIDATION_FAILED",
                "Isolated sample runner unavailable or busy",
            )
        })?;
    let ports = sample_ports(&transform);
    let parsed = (|| -> Result<_, &'static str> {
        let compiled = reply["compiled"].as_bool().ok_or(NO_VERDICT)?;
        let diagnostics = crate::vector_diagnostics::sanitize(&json!({}), &reply["diagnostics"])
            .ok_or(BAD_DIAGNOSTICS)?;
        let results = if compiled {
            sanitize_results(&reply["results"], samples.len(), &ports).ok_or(BAD_SAMPLES)?
        } else {
            vec![]
        };
        let placeholders =
            worker_placeholders(&transform, &reply["placeholders"]).ok_or(BAD_PLACEHOLDER)?;
        Ok((compiled, diagnostics, results, placeholders))
    })();
    let (compiled, diagnostics, results, placeholders) = parsed.map_err(|reason| {
        worker_fault("transform-test", reason);
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "VALIDATION_FAILED",
            "Invalid sample runner response",
        )
    })?;
    let first = results.first();
    let output = first
        .and_then(|r| r["outputs"].as_array())
        .and_then(|o| o.first())
        .map(|o| o["event"].clone())
        .unwrap_or(Value::Null);
    let diagnostic_text = diagnostics
        .iter()
        .filter_map(|d| d["detail"].as_str().or(d["message"].as_str()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut public = json!({
        "valid": compiled,
        "compiled": compiled,
        "output": output,
        "errors": if compiled { vec![] } else { vec!["VRL compilation failed. Review the program."] },
        "diagnostics": diagnostics,
        "results": results,
        "ports": ports,
    });
    if !diagnostic_text.is_empty() {
        public["diagnostic"] = json!(crate::vector_diagnostics::bounded(&diagnostic_text, 4000));
    }
    if !placeholders.is_empty() {
        public["placeholders"] = json!(placeholders);
    }
    if legacy
        && let Some(result) = first
        && ["error", "aborted"].contains(&result["outcome"].as_str().unwrap_or(""))
    {
        public["valid"] = json!(false);
        public["errors"] = json!([result["message"]
            .as_str()
            .unwrap_or("The program aborted the event.")]);
    }
    // Record that this account used the isolated runner, at most once per ten
    // minutes, instead of one audit row per auto-run.
    if s.limit(
        format!("vrl-audit:{}", crate::api::text(&user, "id")),
        1,
        std::time::Duration::from_secs(600),
    )
    .is_ok()
    {
        let (_guard, mut tx) = crate::db::write_tx(&s).await?;
        crate::auth::authorize_in(&mut tx, &h, &["editor", "operator"], true).await?;
        crate::db::audit(
            &mut tx,
            crate::api::text(&user, "id"),
            "vrl.synthetic_test",
            "",
            if compiled { "success" } else { "failed" },
        )
        .await?;
        tx.commit().await?;
    }
    Ok(axum::Json(public))
}

fn sanitize_tests(value: &Value) -> Option<Vec<Value>> {
    let items = value.as_array()?;
    if items.len() > 100 {
        return None;
    }
    items
        .iter()
        .map(|item| {
            let name = item["name"].as_str().filter(|n| n.len() <= 1000)?;
            let passed = item["passed"].as_bool()?;
            let mut clean =
                json!({"name":crate::vector_diagnostics::bounded(name,240),"passed":passed});
            for (key, limit) in [("message", 600), ("detail", 3000)] {
                if let Some(text) = item.get(key) {
                    let text = text.as_str().filter(|t| t.len() <= limit * 4)?;
                    let text: String = text
                        .chars()
                        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
                        .collect();
                    clean[key] = json!(crate::vector_diagnostics::bounded(&text, limit));
                }
            }
            if let Some(outputs) = item.get("outputs") {
                let outputs = outputs.as_array().filter(|o| o.len() <= 10)?;
                if outputs.iter().any(|o| o.to_string().len() > 8192) {
                    return None;
                }
                clean["outputs"] = json!(outputs);
            }
            // Vector never ran a test it could not read or build.
            if !passed
                && clean["message"]
                    .as_str()
                    .is_some_and(crate::vector_diagnostics::is_refusal)
            {
                clean["refused"] = json!(true);
            }
            Some(clean)
        })
        .collect()
}

/// Every configured test gets a result, in the configured order. Vector runs
/// nothing when one test cannot be read or built, and a worker can drop a
/// result, so a test without one is reported as not run, never left out of
/// the count.
pub(crate) fn complete_results(config: &Value, reported: Vec<Value>) -> Vec<Value> {
    let mut remaining: Vec<Option<Value>> = reported.into_iter().map(Some).collect();
    let mut ordered = Vec::new();
    for (index, test) in config["tests"].as_array().into_iter().flatten().enumerate() {
        let name =
            crate::vector_diagnostics::plain_text(test["name"].as_str().unwrap_or("").as_bytes());
        let name = match name.trim() {
            "" => format!("Test {}", index + 1),
            named => crate::vector_diagnostics::bounded(named, 240),
        };
        let found = remaining
            .iter_mut()
            .find(|result| result.as_ref().is_some_and(|r| r["name"] == json!(name)))
            .and_then(Option::take);
        ordered.push(found.unwrap_or_else(|| {
            json!({"name":name,"passed":false,"not_run":true,"message":"Vector did not run this test."})
        }));
    }
    ordered.extend(remaining.into_iter().flatten());
    ordered.truncate(100);
    ordered
}

/// A draft's native tests, run once: the reply `POST /configurations/test`
/// sends, and whether the isolated worker was asked at all.
pub(crate) struct TestRun {
    pub reply: Value,
    /// The worker answered, so the run is worth an audit row.
    pub asked: bool,
}

/// Run the draft's native `tests` with `vector test` in the isolated worker
/// and report every test's result. The test route and the publish gate both
/// come through here, so a version is never published on a verdict the test
/// route would not give.
pub(crate) async fn run_pipeline_tests(
    s: &crate::State,
    config: &Value,
) -> crate::error::Result<TestRun> {
    use axum::http::StatusCode;
    let structural = validate(config);
    let finish = |mut result: Value, tests: Vec<Value>, tests_run: bool, asked: bool| {
        let passed = tests.iter().filter(|t| t["passed"] == true).count();
        result["tests"] = json!(tests);
        result["tests_run"] = json!(tests_run);
        if tests_run {
            result["output"] = json!(format!("{passed} of {} tests passed.", tests.len()));
        }
        TestRun {
            reply: result,
            asked,
        }
    };
    if structural["valid"] != true {
        let result = check_result(
            structural_diagnostics(config, &structural),
            false,
            false,
            vec![],
            vec![],
        );
        return Ok(finish(result, vec![], false, false));
    }
    let reasons = device_context_reasons(config);
    if config.get("provider").is_some_and(|p| !p.is_null()) {
        let mut result = check_result(
            vec![Diagnostic {
                code: Some("provider".into()),
                ..Diagnostic::error(
                    "A configuration provider supplies this pipeline on each device. Run these tests on the device.",
                )
            }],
            false,
            false,
            reasons,
            vec![],
        );
        result["deferred"] = json!(true);
        return Ok(finish(result, vec![], false, false));
    }
    let unavailable = || {
        api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "CAPABILITY_DENIED",
            "Isolated Vector pipeline test runner is unavailable",
        )
    };
    let url = s.settings.validation_url.as_ref().ok_or_else(unavailable)?;
    if config["tests"]
        .as_array()
        .is_none_or(|tests| tests.is_empty())
    {
        let result = check_result(
            vec![Diagnostic {
                section: Some("tests".into()),
                code: Some("no_tests".into()),
                ..Diagnostic::error("Add at least one Vector pipeline test before running tests.")
            }],
            false,
            false,
            vec![],
            vec![],
        );
        return Ok(finish(result, vec![], false, false));
    }
    // Vector runs a Lua step's code, opens an enrichment table's file and a
    // remap's program file, and asks an instance metadata service, when it
    // builds them for a test. The worker is not asked: the tests run on devices.
    if let Some(diagnostic) = tests_on_devices_diagnostic(config) {
        let result = check_result(vec![diagnostic], false, false, reasons, vec![]);
        return Ok(finish(result, vec![], false, false));
    }
    let _permit = s
        .validation_slots
        .try_acquire()
        .map_err(|_| worker_busy())?;
    let reply = worker_call(url, "tests", &json!({"config":config}), 512 * 1024)
        .await
        .ok_or_else(unavailable)?;
    let parsed = (|| -> Result<_, &'static str> {
        let tests_run = reply["tests_run"].as_bool().ok_or(NO_VERDICT)?;
        let tests = sanitize_tests(&reply["tests"]).ok_or(BAD_TESTS)?;
        let diagnostics = crate::vector_diagnostics::sanitize(config, &reply["diagnostics"])
            .ok_or(BAD_DIAGNOSTICS)?;
        let placeholders =
            worker_placeholders(config, &reply["placeholders"]).ok_or(BAD_PLACEHOLDER)?;
        Ok((tests_run, tests, diagnostics, placeholders))
    })();
    let (tests_run, tests, native, placeholders) = parsed.map_err(|reason| {
        worker_fault("tests", reason);
        unavailable()
    })?;
    let tests = if tests_run {
        complete_results(config, tests)
    } else {
        tests
    };
    let mut diagnostics: Vec<Diagnostic> = native.iter().map(Diagnostic::from_json).collect();
    let not_run = tests.iter().filter(|t| t["not_run"] == true).count();
    let failed = tests
        .iter()
        .filter(|t| t["passed"] == false && t["not_run"] != true)
        .count();
    if tests_run && failed + not_run > 0 {
        let total = tests.len();
        diagnostics.push(Diagnostic {
            section: Some("tests".into()),
            code: Some("test_failed".into()),
            ..Diagnostic::error(match (failed, not_run) {
                (failed, 0) => format!("{failed} of {total} pipeline tests failed."),
                (0, not_run) => format!("{not_run} of {total} pipeline tests did not run."),
                (failed, not_run) => {
                    format!("{failed} of {total} pipeline tests failed; {not_run} did not run.")
                }
            })
        });
    } else if !tests_run && diagnostics.is_empty() {
        // The worker skipped the tests without saying why (a skip it explains,
        // such as a program that calls out, is not a failure to retry).
        diagnostics.push(Diagnostic::error(
            "The isolated Vector worker could not run pipeline tests. Try again.",
        ));
    }
    let mut result = check_result(diagnostics, tests_run, true, reasons, placeholders);
    result["vector_validated"] = json!(false);
    Ok(finish(result, tests, tests_run, true))
}

/// `POST /api/v1/configurations/test`: run the draft's native `tests` and
/// report every test's result.
pub async fn pipeline_tests(
    axum::extract::State(s): axum::extract::State<crate::State>,
    h: axum::http::HeaderMap,
    axum::Json(input): axum::Json<Value>,
) -> crate::error::Result<axum::Json<Value>> {
    let user = crate::auth::authorize(&s, &h, &["editor", "operator"], true).await?;
    s.limit(
        format!("pipeline-tests:{}", crate::api::text(&user, "id")),
        20,
        std::time::Duration::from_secs(60),
    )?;
    let run = run_pipeline_tests(&s, &input["config"]).await?;
    if run.asked {
        let (_guard, mut tx) = crate::db::write_tx(&s).await?;
        crate::auth::authorize_in(&mut tx, &h, &["editor", "operator"], true).await?;
        crate::db::audit(
            &mut tx,
            crate::api::text(&user, "id"),
            "configuration.tests",
            "",
            if run.reply["valid"] == true {
                "success"
            } else {
                "failed"
            },
        )
        .await?;
        tx.commit().await?;
    }
    Ok(axum::Json(run.reply))
}

pub fn render(config: &Value) -> std::result::Result<String, serde_json::Error> {
    // serde_json's default map is ordered: artifact bytes are stable and exclude canvas layout.
    serde_json::to_string_pretty(config).map(|s| s + "\n")
}
// Output semantics from Vector v0.58.0. Unknown component types are deliberately
// left to the pinned native validator instead of treating this list as a catalog.
const LOGS: u8 = 1;
const METRICS: u8 = 2;
const TRACES: u8 = 4;
const ANY_EVENT: u8 = LOGS | METRICS | TRACES;

/// Sources that always emit one event type. A native codec can decode any
/// event type, and anything not listed is treated as emitting anything.
fn source_emits(item: &Value, port: Option<&str>) -> u8 {
    let typ = item["type"].as_str().unwrap_or("");
    if matches!(typ, "opentelemetry" | "datadog_agent") {
        return match port {
            Some("logs") => LOGS,
            Some("metrics") => METRICS,
            Some("traces") => TRACES,
            _ => ANY_EVENT,
        };
    }
    if item["decoding"]["codec"]
        .as_str()
        .is_some_and(|codec| codec.starts_with("native"))
    {
        return ANY_EVENT;
    }
    match typ {
        "demo_logs" | "file" | "journald" | "windows_event_log" | "kubernetes_logs" | "syslog"
        | "docker_logs" | "internal_logs" => LOGS,
        "host_metrics" | "internal_metrics" | "prometheus_scrape" | "statsd" | "static_metrics"
        | "apache_metrics" | "nginx_metrics" => METRICS,
        _ => ANY_EVENT,
    }
}

/// Components that accept only some event types. Vector's own check stops at
/// a transform (it types every transform output as any event), so a remap
/// between a log source and a metrics sink passes `vector validate` and then
/// delivers nothing. The native test keeps this table equal to Vector 0.58.
pub(crate) fn accepted_events(kind: &str, typ: &str) -> u8 {
    match (kind, typ) {
        (
            "sinks",
            "datadog_metrics"
            | "prometheus_exporter"
            | "prometheus_remote_write"
            | "statsd"
            | "influxdb_metrics"
            | "aws_cloudwatch_metrics"
            | "gcp_stackdriver_metrics",
        )
        | ("transforms", "metric_to_log" | "aggregate") => METRICS,
        (
            "sinks",
            "loki"
            | "datadog_logs"
            | "splunk_hec_logs"
            | "aws_cloudwatch_logs"
            | "gcp_stackdriver_logs"
            | "influxdb_logs"
            | "papertrail",
        )
        | ("transforms", "log_to_metric") => LOGS,
        _ => ANY_EVENT,
    }
}

fn event_names(types: u8) -> String {
    let names: Vec<&str> = [(LOGS, "logs"), (METRICS, "metrics"), (TRACES, "traces")]
        .into_iter()
        .filter(|(bit, _)| types & bit != 0)
        .map(|(_, name)| name)
        .collect();
    match names.as_slice() {
        [one] => (*one).to_owned(),
        [first, second] => format!("{first} and {second}"),
        _ => names.join(", "),
    }
}

/// Follow event types from sources through transforms that keep them, and
/// report a consumer that can accept none of what an input sends.
fn event_type_mismatches(
    config: &Value,
    dependencies: &BTreeMap<String, Vec<String>>,
    errors: &mut Vec<String>,
) {
    fn emits(
        config: &Value,
        dependencies: &BTreeMap<String, Vec<String>>,
        input: &str,
        visiting: &mut BTreeSet<String>,
    ) -> u8 {
        if input.contains(['*', '?', '['])
            || has_environment_reference(input)
            || input.contains("SECRET[")
        {
            return ANY_EVENT;
        }
        let (id, port) = match input.split_once('.') {
            Some((id, port)) => (id, Some(port)),
            None => (input, None),
        };
        if let Some(source) = config["sources"].get(id) {
            return source_emits(source, port);
        }
        let Some(transform) = config["transforms"].get(id) else {
            return ANY_EVENT;
        };
        let passes = match transform["type"].as_str().unwrap_or("") {
            "log_to_metric" => return METRICS,
            "metric_to_log" => return LOGS,
            typ => matches!(
                typ,
                "remap"
                    | "filter"
                    | "route"
                    | "exclusive_route"
                    | "sample"
                    | "throttle"
                    | "dedupe"
                    | "reduce"
                    | "aggregate"
            ),
        };
        if !passes || !visiting.insert(id.to_owned()) {
            return ANY_EVENT;
        }
        let types = dependencies
            .get(id)
            .into_iter()
            .flatten()
            .fold(0, |types, input| {
                types | emits(config, dependencies, input, visiting)
            });
        visiting.remove(id);
        if types == 0 { ANY_EVENT } else { types }
    }
    for (name, inputs) in dependencies {
        let kind = if config["sinks"].get(name).is_some() {
            "sinks"
        } else {
            "transforms"
        };
        let accepts = accepted_events(kind, config[kind][name]["type"].as_str().unwrap_or(""));
        if accepts == ANY_EVENT {
            continue;
        }
        for input in inputs {
            let sent = emits(config, dependencies, input, &mut BTreeSet::new());
            if sent & accepts == 0 {
                errors.push(format!(
                    "{name}: `{input}` emits {} but `{name}` accepts {}.",
                    event_names(sent),
                    event_names(accepts)
                ));
            }
        }
    }
}

fn output_exists(kind: &str, item: &Value, port: Option<&str>) -> Option<bool> {
    let typ = item["type"].as_str()?;
    match (kind, typ) {
        ("transforms", "route") => Some(port.is_some_and(|port| {
            if port == "_unmatched" {
                item["reroute_unmatched"].as_bool().unwrap_or(true)
            } else {
                item["route"].get(port).is_some()
            }
        })),
        ("transforms", "exclusive_route") => Some(port.is_some_and(|port| {
            port == "_unmatched"
                || item["routes"].as_array().is_some_and(|routes| {
                    routes
                        .iter()
                        .any(|route| route["name"].as_str() == Some(port))
                })
        })),
        ("transforms", "remap") => {
            Some(port.is_none() || (port == Some("dropped") && item["reroute_dropped"] == true))
        }
        ("sources", "opentelemetry") => {
            Some(port.is_some_and(|port| ["logs", "metrics", "traces"].contains(&port)))
        }
        ("sources", "datadog_agent") => Some(if item["multiple_outputs"] == true {
            port.is_some_and(|port| {
                ["logs", "metrics", "traces", "llmobs"].contains(&port)
                    && item[format!("disable_{port}")] != true
            })
        } else {
            port.is_none()
        }),
        ("sources", "demo_logs" | "internal_metrics" | "file" | "http_server" | "syslog")
        | ("transforms", "filter" | "sample" | "reduce" | "log_to_metric") => Some(port.is_none()),
        _ => None,
    }
}
/// Whether a component ID could name a place on disk. Vector joins an ID onto
/// its data directory for checkpoints and disk buffers, so an absolute path
/// replaces that directory and separators climb out of it. On Windows a drive
/// prefix (`C:x`) replaces the directory too, so an ID may not start with a
/// drive letter and a colon. Vector itself refuses only a dot (measured with
/// 0.58), so this adds exactly the path separators, the drive prefix and the
/// control characters that let an ID forge a log line or a file name.
fn names_a_path(id: &str) -> bool {
    let mut chars = id.chars();
    let drive_prefix =
        chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && chars.next() == Some(':');
    drive_prefix
        || id
            .chars()
            .any(|c| matches!(c, '/' | '\\') || c.is_control())
}

/// The longest component ID, in bytes: what a pipeline may name a component and
/// what a device may report as the ID of one.
pub const MAX_COMPONENT_ID_BYTES: usize = 128;

/// Whether a device may report `id` as a component ID, or as the name of a
/// route's output, in a heartbeat's log groups and diagnostics. It is the text
/// rule of `validate`, so whatever a pipeline may name a component, a device may
/// report: not empty, at most `MAX_COMPONENT_ID_BYTES` bytes and nothing
/// `names_a_path` refuses (a `/` or `\`, a control character, a drive letter and
/// a colon at the start). A report adds the characters that can't be shown
/// safely in one line of text and the byte order mark (`db::refused_in_name`),
/// which `validate` leaves to the editor. A dot is allowed: an output's name may
/// hold one, and earlier agents reported them. The agent judges the same IDs
/// with `reportableID`, and `vector-catalog/fixtures/component-ids.json` pins
/// the two to each other.
pub fn reported_component_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_COMPONENT_ID_BYTES
        && !names_a_path(id)
        && !id.chars().any(crate::db::refused_in_name)
}
/// The refusal for such an ID: it names the component and the rule, and shows
/// a control character as an escape instead of carrying it into a message.
fn path_like_id(id: &str) -> String {
    let shown: String = id
        .chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect();
    format!(
        "{shown}: component IDs can't contain / or \\ or control characters, or start with a drive letter and a colon (like C:). Rename this component."
    )
}
pub fn validate(config: &Value) -> Value {
    let mut errors = Vec::<String>::new();
    let mut warnings = Vec::<String>::new();
    if !config.is_object() {
        errors.push("Configuration must be a JSON object".into());
        return json!({"valid":false,"errors":errors,"warnings":warnings,"vector_validated":false,"vector_version":VECTOR_VERSION});
    }
    let mut names = BTreeSet::new();
    let mut dependencies = BTreeMap::<String, Vec<String>>::new();
    let mut memory_sources = BTreeMap::<String, bool>::new();
    let mut memory_sinks = BTreeSet::<String>::new();
    for section in ["sources", "transforms", "sinks"] {
        if let Some(items) = config.get(section) {
            if let Some(items) = items.as_object() {
                if items.len() > 1000 {
                    errors.push("Configuration exceeds 1000 components per section".into());
                    continue;
                }
                for (name, item) in items {
                    if name.is_empty() || name.len() > MAX_COMPONENT_ID_BYTES || name.contains('.')
                    {
                        errors.push(format!("Invalid component ID in {section}"))
                    }
                    if names_a_path(name) {
                        errors.push(path_like_id(name));
                    }
                    if !names.insert(name.clone()) {
                        errors.push(format!("Duplicate component ID: {name}"))
                    }
                    if item["type"].as_str().is_none() {
                        errors.push(format!("{name}: type is required"))
                    }
                    validate_known_options(section, name, item, &mut errors);
                    if section != "sources" {
                        if let Some(inputs) = item["inputs"].as_array() {
                            if inputs.is_empty() {
                                errors.push(format!("{name}: at least one input is required"))
                            }
                            dependencies.insert(
                                name.clone(),
                                inputs
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect(),
                            );
                            if inputs.iter().any(|v| !v.is_string()) {
                                errors.push(format!("{name}: inputs must be strings"))
                            }
                        } else {
                            errors.push(format!("{name}: inputs must be an array"))
                        }
                    } else if item.get("inputs").is_some() {
                        errors.push(format!("{name}: sources cannot have inputs"))
                    }
                }
            } else {
                errors.push(format!("{section} must be an object"))
            }
        }
    }
    // Memory enrichment tables may supply a generated source and consume inputs.
    // These names are explicitly declared; arbitrary missing inputs still fail.
    if let Some(tables) = config["enrichment_tables"].as_object() {
        for (table_name, table) in tables {
            if table["type"] != "memory" {
                continue;
            }
            if let Some(inputs) = table.get("inputs") {
                if !names.insert(table_name.clone()) {
                    errors.push(format!("Duplicate component ID: {table_name}"));
                }
                if names_a_path(table_name) {
                    errors.push(path_like_id(table_name));
                }
                memory_sinks.insert(table_name.clone());
                if let Some(inputs) = inputs.as_array() {
                    if inputs.iter().any(|input| !input.is_string()) {
                        errors.push(format!("{table_name}: inputs must be strings"));
                    }
                    dependencies.insert(
                        table_name.clone(),
                        inputs
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect(),
                    );
                } else {
                    errors.push(format!("{table_name}: inputs must be an array"));
                }
            }
            if let Some(source_key) = table["source_config"]["source_key"].as_str() {
                if source_key.is_empty()
                    || source_key.len() > MAX_COMPONENT_ID_BYTES
                    || source_key.contains('.')
                {
                    errors.push(format!("{table_name}: invalid memory source ID"));
                }
                if names_a_path(source_key) {
                    errors.push(path_like_id(source_key));
                }
                if source_key == table_name || !names.insert(source_key.to_owned()) {
                    errors.push(format!("Duplicate component ID: {source_key}"));
                }
                memory_sources.insert(
                    source_key.to_owned(),
                    table["source_config"]["export_expired_items"] == true,
                );
            }
        }
    }
    let has_provider = config["provider"].is_object();
    if !has_provider && config["sources"].as_object().is_none_or(|o| o.is_empty()) {
        errors.push("At least one source is required".into())
    }
    if !has_provider && config["sinks"].as_object().is_none_or(|o| o.is_empty()) {
        errors.push("At least one sink is required".into())
    }
    for (name, inputs) in &dependencies {
        for input in inputs {
            if input.contains(['*', '?', '['])
                || has_environment_reference(input)
                || input.contains("SECRET[")
            {
                warnings.push(format!(
                    "{name}: dynamic input pattern requires native Vector topology validation"
                ));
                continue;
            }
            let mut parts = input.splitn(2, '.');
            let source = parts.next().unwrap_or("");
            if !names.contains(source) {
                if has_provider {
                    warnings.push(format!(
                        "{name}: provider-supplied input requires native device validation"
                    ));
                } else {
                    errors.push(format!("{name}: unknown input {input}"));
                }
                continue;
            }
            if config["sinks"].get(source).is_some() || memory_sinks.contains(source) {
                errors.push(format!("{name}: a sink cannot be an input"));
                continue;
            }
            let port = parts.next();
            if let Some(expired_enabled) = memory_sources.get(source) {
                if port.is_some() && !(port == Some("expired") && *expired_enabled) {
                    errors.push(format!("{name}: unknown or disabled output {input}"));
                }
                continue;
            }
            let kind = if config["sources"].get(source).is_some() {
                "sources"
            } else {
                "transforms"
            };
            match output_exists(kind, &config[kind][source], port) {
                Some(false) => errors.push(format!("{name}: unknown or disabled output {input}")),
                None if port.is_some() => warnings.push(format!(
                    "{name}: output {input} requires native Vector validation"
                )),
                _ => {}
            }
        }
    }
    fn visit(
        name: &str,
        deps: &BTreeMap<String, Vec<String>>,
        active: &mut BTreeSet<String>,
        done: &mut BTreeSet<String>,
    ) -> bool {
        if done.contains(name) {
            return true;
        }
        if !active.insert(name.into()) {
            return false;
        }
        if let Some(inputs) = deps.get(name) {
            for input in inputs {
                if input.contains(['*', '?', '['])
                    || has_environment_reference(input)
                    || input.contains("SECRET[")
                {
                    continue;
                }
                if !visit(input.split('.').next().unwrap_or(""), deps, active, done) {
                    return false;
                }
            }
        }
        active.remove(name);
        done.insert(name.into());
        true
    }
    let mut done = BTreeSet::new();
    for name in dependencies.keys() {
        if !visit(name, &dependencies, &mut BTreeSet::new(), &mut done) {
            errors.push("Pipeline contains a cycle".into());
            break;
        }
    }
    event_type_mismatches(config, &dependencies, &mut errors);
    errors.extend(
        credential_findings(config)
            .into_iter()
            .map(|finding| finding.message),
    );
    errors.extend(credential_scan_limit_paths(config).into_iter().map(|path| {
        format!("Credential scan limit exceeded at `{path}`. Shorten this field before saving.")
    }));
    let (_, reference_errors) = local_secret_references(config);
    errors.extend(reference_errors);
    errors.sort();
    errors.dedup();
    warnings.sort();
    warnings.dedup();
    json!({"valid":errors.is_empty(),"errors":errors,"warnings":warnings,"vector_validated":false,"vector_version":VECTOR_VERSION})
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_credential_fixtures_match_server_detector() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../vector-catalog/fixtures/credentials/cases.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let findings = credential_findings(&case["config"]);
            let expected = case["findings"].as_array().unwrap();
            let mut actual_pairs: Vec<_> = findings
                .iter()
                .map(|finding| (finding.code.to_owned(), finding.path.clone()))
                .collect();
            actual_pairs.sort();
            let mut expected_pairs: Vec<_> = expected
                .iter()
                .map(|finding| {
                    (
                        finding["code"].as_str().unwrap().to_owned(),
                        finding["path"].as_str().unwrap().to_owned(),
                    )
                })
                .collect();
            expected_pairs.sort();
            assert_eq!(actual_pairs, expected_pairs, "{}", case["name"]);
            for found in &findings {
                assert!(!found.message.contains("synthetic-"), "{}", case["name"]);
                assert!(!found.fix.contains("synthetic-"), "{}", case["name"]);
            }
        }
    }

    #[test]
    fn network_calls_are_found_by_call_syntax_only() {
        let call = |text: &str| unrunnable_vrl_calls(&json!({"source": text}));
        assert_eq!(
            call("resp, err = http_request(\"http://example.test\")"),
            BTreeSet::from(["http_request"])
        );
        assert_eq!(
            call(".a = http_request!( \"http://example.test\" )"),
            BTreeSet::from(["http_request"])
        );
        assert_eq!(
            call("dns_lookup!(.host)\n.name = reverse_dns!(.ip)"),
            BTreeSet::from(["dns_lookup", "reverse_dns"])
        );
        // VRL's lexer allows whitespace between the name, the bang and the
        // parenthesis (`http_request! ("u")` sends a real request).
        assert_eq!(
            call(".a = http_request! (\"http://example.test\")"),
            BTreeSet::from(["http_request"])
        );
        assert_eq!(
            call(".a, err = http_request\t(\"http://example.test\")"),
            BTreeSet::from(["http_request"])
        );
        // Field paths, longer identifiers and prose are not calls.
        assert!(call(".http_request = 1").is_empty());
        assert!(call("my_http_request(1)").is_empty());
        assert!(call("http_request_count = 3").is_empty());
        assert!(call("# the http_request function is not used").is_empty());
        // Calls are found wherever a program sits in the document.
        let nested =
            json!({"tests":[{"outputs":[{"conditions":[{"source":"http_request(\"u\")"}]}]}]});
        assert_eq!(
            unrunnable_vrl_calls(&nested),
            BTreeSet::from(["http_request"])
        );
        // Every network function is also a device function.
        assert!(
            NETWORK_VRL_FUNCTIONS
                .iter()
                .all(|name| DEVICE_VRL_FUNCTIONS.contains(name))
        );
    }

    #[test]
    fn a_name_inside_data_is_not_a_device_function_call() {
        // Ordinary pipelines that only mention a function's name: the canonical
        // Prometheus metric, an event value, a string, a step called http_requests.
        for config in [
            json!({"transforms":{"m":{"type":"log_to_metric","inputs":["a"],"metrics":[{"type":"counter","field":"message","name":"http_requests_total"}]}}}),
            json!({"transforms":{"f":{"type":"filter","inputs":["a"],"condition":".event == \"http_request\""}}}),
            json!({"transforms":{"r":{"type":"remap","inputs":["a"],"source":".kind = \"http_request_log\""}}}),
            json!({"transforms":{"http_requests":{"type":"remap","inputs":["a"],"source":"."}},"sinks":{"out":{"type":"blackhole","inputs":["http_requests"]}}}),
            json!({"transforms":{"r":{"type":"remap","inputs":["a"],"source":".parse_proto = 1\n.get_env_var = 2"}}}),
        ] {
            assert!(device_context_reasons(&config).is_empty(), "{config}");
        }
        for source in [
            ".x = http_request!(\"u\")",
            ".x = http_request! (\"u\")",
            ".x, err = dns_lookup(.host)",
            "get_env_var!(\"HOME\")",
            "get_enrichment_table_record!(\"t\", {})",
            "find_enrichment_table_records!(\"t\", {})",
            "validate_json_schema!(.message, \"/schema.json\")",
            "parse_proto!(.message, \"/d.desc\", \"x.Y\")",
            "encode_proto!(.message, \"/d.desc\", \"x.Y\")",
        ] {
            let config =
                json!({"transforms":{"r":{"type":"remap","inputs":["a"],"source":source}}});
            assert_eq!(
                device_context_reasons(&config),
                vec!["VRL access to device resources".to_owned()],
                "{source}"
            );
        }
    }

    #[test]
    fn the_worker_never_runs_a_program_that_reads_a_file() {
        let call = |text: &str| unrunnable_vrl_calls(&json!({"source": text}));
        assert_eq!(
            call("validate_json_schema!(.m, \"/etc/passwd\")"),
            BTreeSet::from(["validate_json_schema"])
        );
        assert_eq!(
            call("parse_proto!(.m, \"/d\", \"x\")\nencode_proto!(.m, \"/d\", \"x\")"),
            BTreeSet::from(["parse_proto", "encode_proto"])
        );
        let message = |names: &[&'static str]| {
            unrunnable_call_diagnostic(&names.iter().copied().collect(), "error").message
        };
        assert_eq!(
            message(&["parse_proto"]),
            "This program calls parse_proto, which reads files. The server never reads device files from samples or tests."
        );
        assert_eq!(
            message(&["http_request", "parse_proto"]),
            "This program calls http_request, parse_proto, which sends network requests and reads files. The server never sends requests or reads device files from samples or tests."
        );
        assert!(
            FILE_VRL_FUNCTIONS
                .iter()
                .all(|name| DEVICE_VRL_FUNCTIONS.contains(name))
        );
        // The static check stands in for a step that reads a device file rather
        // than compiling it in the worker.
        let config = json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"check": {"type": "remap", "inputs": ["in"],
                "source": "validate_json_schema!(.message, \"/etc/passwd\")"}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["check"]}},
        });
        let candidate = static_candidate(&config, |_, _| true);
        assert_eq!(
            candidate.stubbed.get("check").map(String::as_str),
            Some("reads a file on each device")
        );
        assert!(!candidate.config.to_string().contains("/etc/passwd"));
    }

    use super::*;
    #[test]
    fn devices_may_run_any_patch_release_of_the_pinned_series() {
        for ok in [
            "0.58.0",
            "0.58.1",
            "v0.58.12",
            "0.58.2 (x86_64-unknown-linux-gnu 0f0e3d1 2026-05-01)",
        ] {
            assert!(vector_compatible(ok), "{ok}");
        }
        for refused in [
            "",
            "0.58",
            "0.58.",
            "0.57.0",
            "0.59.0",
            "0.580.0",
            "0.58.x",
            "0.58.1-rc1",
            "1.58.0",
        ] {
            assert!(!vector_compatible(refused), "{refused}");
        }
    }

    #[test]
    fn event_types_follow_transforms_that_keep_them() {
        let mismatch = |config: &Value| {
            validate(config)["errors"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .filter(|e| e.contains(" emits "))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let mut config = json!({
            "sources":{"in":{"type":"demo_logs","format":"json"}},
            "transforms":{"p":{"type":"remap","inputs":["in"],"source":".x = 1"},
                "r":{"type":"route","inputs":["p"],"route":{"a":"true"}}},
            "sinks":{"dd":{"type":"datadog_metrics","inputs":["r.a"],"default_api_key":"SECRET[vault.dd_key]"}}
        });
        assert_eq!(
            mismatch(&config),
            ["dd: `r.a` emits logs but `dd` accepts metrics."]
        );
        let diagnostics = structural_diagnostics(&config, &validate(&config));
        let diagnostic = diagnostics
            .iter()
            .find(|d| d.code.as_deref() == Some("type_mismatch"))
            .unwrap();
        assert_eq!(diagnostic.component.as_deref(), Some("dd"));
        assert_eq!(diagnostic.field.as_deref(), Some("inputs"));
        assert_eq!(diagnostic.related, ["r.a"]);
        assert_eq!(
            diagnostic.message,
            "`r.a` emits logs but `dd` accepts metrics."
        );
        // Converting first, a wildcard, a native codec or an unknown step all pass.
        config["transforms"]["m"] = json!({"type":"log_to_metric","inputs":["r.a"],"metrics":[]});
        config["sinks"]["dd"]["inputs"] = json!(["m"]);
        assert!(mismatch(&config).is_empty());
        config["sinks"]["dd"]["inputs"] = json!(["r.*"]);
        assert!(mismatch(&config).is_empty());
        config["sinks"]["dd"]["inputs"] = json!(["p"]);
        config["sources"]["in"]["decoding"] = json!({"codec":"native_json"});
        assert!(mismatch(&config).is_empty());
        config["sources"]["in"] = json!({"type":"http_server","address":"0.0.0.0:80"});
        assert!(mismatch(&config).is_empty());
        let otel = json!({
            "sources":{"otel":{"type":"opentelemetry"}},
            "transforms":{"t":{"type":"metric_to_log","inputs":["otel.logs"]}},
            "sinks":{"prom":{"type":"prometheus_exporter","inputs":["otel.metrics"]},"loki":{"type":"loki","inputs":["t","otel.logs"]}}
        });
        assert_eq!(
            mismatch(&otel),
            ["t: `otel.logs` emits logs but `t` accepts metrics."]
        );
    }

    #[test]
    fn windows_event_log_emits_logs_for_static_type_checks() {
        let config = json!({
            "sources":{"events":{"type":"windows_event_log","channels":["Application"]}},
            "sinks":{"metrics":{"type":"prometheus_exporter","inputs":["events"]}}
        });
        let errors = validate(&config)["errors"].as_array().unwrap().clone();
        assert!(
            errors
                .iter()
                .any(|error| error.as_str().is_some_and(|error| {
                    error == "metrics: `events` emits logs but `metrics` accepts metrics."
                })),
            "{errors:?}"
        );
    }

    #[test]
    fn sample_strategy_errors_fail_structural_checks_without_native_vector() {
        let mut config = json!({"sources":{"in":{"type":"demo_logs"}},"transforms":{"pick":{"type":"sample","inputs":["in"]}},"sinks":{"out":{"type":"blackhole","inputs":["pick"]}}});
        let missing = validate(&config);
        assert_eq!(missing["valid"], false, "{missing}");
        assert!(
            missing["errors"]
                .to_string()
                .contains("exactly one of rate or ratio")
        );
        config["transforms"]["pick"]["rate"] = json!(10);
        assert_eq!(validate(&config)["valid"], true);
        config["transforms"]["pick"]["ratio"] = json!(0.5);
        assert_eq!(validate(&config)["valid"], false);
        config["transforms"]["pick"]
            .as_object_mut()
            .unwrap()
            .remove("rate");
        assert_eq!(validate(&config)["valid"], true);
        config["transforms"]["pick"]["ratio"] = json!(1.5);
        assert_eq!(validate(&config)["valid"], false);
        config["transforms"]["pick"]["ratio"] = json!(0.5);
        config["transforms"]["pick"]["rate_field"] = json!("rate");
        config["transforms"]["pick"]["ratio_field"] = json!("ratio");
        assert_eq!(validate(&config)["valid"], false);
        config["transforms"]["pick"]
            .as_object_mut()
            .unwrap()
            .remove("ratio_field");
        config["transforms"]["pick"]["key_field"] = json!("host");
        assert_eq!(validate(&config)["valid"], false);
        config["transforms"]["pick"]
            .as_object_mut()
            .unwrap()
            .remove("key_field");
        config["transforms"]["pick"]
            .as_object_mut()
            .unwrap()
            .remove("rate_field");
        config["transforms"]["pick"]
            .as_object_mut()
            .unwrap()
            .remove("ratio");
        config["transforms"]["pick"]["rate"] = json!("${DEVICE_SAMPLE_RATE}");
        let deferred = validate(&config);
        assert_eq!(deferred["valid"], true, "{deferred}");
        assert_eq!(deferred["vector_validated"], false);
        assert!(needs_device_context(&config));
    }
    #[test]
    fn known_sink_buffer_errors_fail_structural_checks() {
        let mut config = json!({"sources":{"in":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"type":"memory","max_events":500,"when_full":"block"}}}});
        assert_eq!(validate(&config)["valid"], true);
        config["sinks"]["out"]["buffer"] = json!({"type":"memory"});
        assert_eq!(validate(&config)["valid"], true); // Vector supplies the default size.
        config["sinks"]["out"]["buffer"] = json!({"max_events":500});
        assert_eq!(validate(&config)["valid"], true); // Vector defaults the type to memory.
        config["sinks"]["out"]["buffer"] =
            json!({"type":"memory","max_events":500,"max_size":1048576});
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["buffer"]["max_size"] = json!("${DEVICE_BUFFER_SIZE}");
        assert_eq!(validate(&config)["valid"], false); // Both keys remain present after substitution.
        config["sinks"]["out"]["buffer"] =
            json!({"type":"memory","max_size":"${DEVICE_BUFFER_SIZE}"});
        assert_eq!(validate(&config)["valid"], true); // The single value is device-resolved.
        config["sinks"]["out"]["buffer"] = json!({"type":"memory","max_events":500});
        config["sinks"]["out"]["buffer"]["max_events"] = json!(0);
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["buffer"] = json!({"type":"disk","max_size":100});
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["buffer"] = json!({"type":"disk"});
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["buffer"] = json!([{"type":"memory","max_events":500,"when_full":"overflow"},{"type":"disk","max_size":268435488,"when_full":"block"}]);
        assert_eq!(validate(&config)["valid"], true);
        config["sinks"]["out"]["buffer"][1]["when_full"] = json!("overflow");
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["buffer"] =
            json!({"type":"disk","max_size":"${DEVICE_BUFFER_SIZE}"});
        let deferred = validate(&config);
        assert_eq!(deferred["valid"], true, "{deferred}");
        assert!(needs_device_context(&config));
        config["sinks"]["out"]["type"] = json!("opaque_future_sink");
        config["sinks"]["out"]["buffer"] = json!({"type":"opaque_future_buffer"});
        assert_eq!(validate(&config)["valid"], true);
    }
    #[test]
    fn memory_enrichment_registers_only_declared_native_outputs() {
        let mut config = json!({"sources":{"seed":{"type":"demo_logs"}},"enrichment_tables":{"lookup":{"type":"memory","inputs":["seed"],"source_config":{"source_key":"memory_source","export_interval":1}}},"sinks":{"out":{"type":"blackhole","inputs":["memory_source"]}}});
        assert_eq!(validate(&config)["valid"], true);
        config["sinks"]["out"]["inputs"] = json!(["memory_source.expired"]);
        assert_eq!(validate(&config)["valid"], false);
        config["enrichment_tables"]["lookup"]["source_config"]["export_expired_items"] =
            json!(true);
        assert_eq!(validate(&config)["valid"], true);
        config["sinks"]["out"]["inputs"] = json!(["memory_source.unknown"]);
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["inputs"] = json!(["lookup"]);
        assert_eq!(validate(&config)["valid"], false);
        config["sinks"]["out"]["inputs"] = json!(["memory_source"]);
        config["enrichment_tables"]["lookup"]["inputs"] = json!(["missing"]);
        assert_eq!(validate(&config)["valid"], false);
        config["enrichment_tables"]["lookup"]["inputs"] = json!(["seed"]);
        config["enrichment_tables"]["lookup"]["source_config"]["source_key"] = json!("seed");
        assert_eq!(validate(&config)["valid"], false);
    }
    #[test]
    fn native_credential_lists_require_references() {
        for key in ["valid_tokens", "access_keys"] {
            let mut config = json!({"sources":{"in":{"type":"splunk_hec","address":"127.0.0.1:8088"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}});
            config["sources"]["in"][key] = json!(["${TOKEN}", "SECRET[local.token]"]);
            assert_eq!(validate(&config)["valid"], true);
            config["sources"]["in"][key] = json!(["${TOKEN}", "plaintext"]);
            assert_eq!(validate(&config)["valid"], false);
            config["sources"]["in"][key] = Value::Null;
            assert_eq!(validate(&config)["valid"], true);
        }
    }
    #[test]
    fn local_secrets_are_exact_typed_allowlisted_values() {
        let config = json!({"sources":{"sample":{"type":"demo_logs"}},"sinks":{"out":{"type":"http","inputs":["sample"],"uri":"https://example.test/ingest","auth":{"strategy":"bearer","token":"vectory-secret:INGEST_TOKEN"},"encoding":{"codec":"json"}}}});
        assert_eq!(validate(&config)["valid"], true);
        assert_eq!(local_secret_references(&config), (true, vec![]));
        for value in [
            "literal-credential",
            "Bearer vectory-secret:TOKEN",
            "vectory-secret:0invalid",
            "vectory-secret:bad/name",
        ] {
            let mut altered = config.clone();
            altered["sinks"]["out"]["auth"]["token"] = json!(value);
            assert_eq!(validate(&altered)["valid"], false, "{value}");
        }
        let mut altered = config.clone();
        altered["sinks"]["out"]["uri"] = json!("vectory-secret:URL");
        assert_eq!(validate(&altered)["valid"], false);
        let mut altered = config.clone();
        altered["sinks"]["out"]["type"] = json!("aws_s3");
        assert_eq!(validate(&altered)["valid"], false);
        let mut altered = config.clone();
        altered["sinks"]["out"]["auth"]["user"] = json!("plaintext-user");
        assert_eq!(validate(&altered)["valid"], false);
    }

    /// A component with `value` at a table path: a list for `[]`, a one-key
    /// map for `*`.
    fn at_secret_field(section: &str, kind: &str, field: &str, value: Value) -> Value {
        let mut value = value;
        for step in field.split('.').rev() {
            let name = step.trim_end_matches("[]");
            for _ in 0..(step.len() - name.len()) / 2 {
                value = json!([value]);
            }
            value = if name == "*" {
                json!({ "x": value })
            } else {
                json!({ name: value })
            };
        }
        value["type"] = json!(kind);
        json!({ section: { "c": value } })
    }

    #[test]
    fn every_device_secret_field_takes_a_reference_and_refuses_plain_text() {
        for (section, kind, field) in secret_fields::SECRET_FIELDS {
            let reference = at_secret_field(section, kind, field, json!("vectory-secret:KEY"));
            let (references, errors) = local_secret_scan(&reference);
            assert!(errors.is_empty(), "{kind} {field}: {errors:?}");
            assert_eq!(references.len(), 1, "{kind} {field}");
            assert_eq!(references[0].name, "KEY");
            assert_eq!(
                references[0].field,
                field.replace("[]", "[0]").replace('*', "x")
            );
            // Native references stay valid where they were valid.
            for native in ["SECRET[vault.key]", "${API_KEY}", "$API_KEY", ""] {
                let config = at_secret_field(section, kind, field, json!(native));
                assert_eq!(
                    local_secret_scan(&config).1,
                    Vec::<String>::new(),
                    "{native}"
                );
            }
            let plain = at_secret_field(section, kind, field, json!("hunter2-plaintext"));
            let (_, errors) = local_secret_scan(&plain);
            assert_eq!(errors.len(), 1, "{kind} {field}: {errors:?}");
            assert!(errors[0].starts_with("c: Plaintext credentials cannot be stored in `"));
            assert!(errors[0].ends_with(DEVICE_SECRET_FIX), "{}", errors[0]);
            assert!(!errors[0].contains("hunter2"));
        }
    }

    #[test]
    fn plain_text_credentials_are_refused_at_publish_with_the_fix() {
        let mut config = json!({
            "sources":{"in":{"type":"demo_logs","format":"json"}},
            "sinks":{
                "dd":{"type":"datadog_logs","inputs":["in"],"default_api_key":"dd-plaintext-key"},
                "queue":{"type":"kafka","inputs":["in"],"bootstrap_servers":"kafka.example:9092","topic":"logs","encoding":{"codec":"json"},
                    "sasl":{"enabled":true,"mechanism":"PLAIN","username":"svc","password":"kafka-plaintext"},
                    "tls":{"enabled":true,"key_file":"/etc/tls/key.pem","key_pass":"tls-plaintext"}}
            }
        });
        let result = validate(&config);
        assert_eq!(result["valid"], false);
        let errors: Vec<&str> = result["errors"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        // One error per field, with the fix, never the value.
        assert_eq!(
            errors,
            [
                format!(
                    "dd: Plaintext credentials cannot be stored in `default_api_key`. {DEVICE_SECRET_FIX}"
                ),
                format!(
                    "queue: Plaintext credentials cannot be stored in `sasl.password`. {DEVICE_SECRET_FIX}"
                ),
                format!(
                    "queue: Plaintext credentials cannot be stored in `tls.key_pass`. {DEVICE_SECRET_FIX}"
                ),
            ]
        );
        assert!(!result.to_string().contains("plaintext"));
        // A user name Vector doesn't treat as a credential stays in the pipeline.
        assert!(!result.to_string().contains("sasl.username"));
        let diagnostics = structural_diagnostics(&config, &result);
        let dd = diagnostics
            .iter()
            .find(|d| d.component.as_deref() == Some("dd"))
            .unwrap();
        assert_eq!(dd.code.as_deref(), Some("plaintext_credential"));
        assert_eq!(dd.field.as_deref(), Some("default_api_key"));
        assert!(dd.summary().ends_with(DEVICE_SECRET_FIX));
        config["sinks"]["dd"]["default_api_key"] = json!("vectory-secret:DD_API_KEY");
        config["sinks"]["queue"]["sasl"]["password"] = json!("SECRET[vault.kafka]");
        config["sinks"]["queue"]["tls"]["key_pass"] = json!("${TLS_KEY_PASS}");
        let fixed = validate(&config);
        assert_eq!(fixed["valid"], true, "{fixed}");
        assert_eq!(local_secret_references(&config), (true, vec![]));
        assert!(
            device_context_reasons(&config).contains(&"device secrets".to_owned()),
            "device secrets are resolved on each device"
        );
        assert_eq!(
            reason_phrase(&["device secrets".into(), "native secret references".into()]),
            "secrets"
        );
    }

    #[test]
    fn references_outside_credential_fields_are_refused_by_field() {
        let base = json!({
            "sources":{"in":{"type":"demo_logs","format":"json"},"cmd":{"type":"exec","mode":"scheduled","command":["echo"]}},
            "transforms":{"t":{"type":"remap","inputs":["in"],"source":"."}},
            "sinks":{"out":{"type":"http","inputs":["t"],"uri":"https://sink.example/","encoding":{"codec":"json"},"request":{}},
                "file":{"type":"file","inputs":["t"],"path":"/tmp/out.log","encoding":{"codec":"json"}},
                "es":{"type":"elasticsearch","inputs":["t"],"endpoints":["https://es.example:9200"]},
                "hec":{"type":"splunk_hec_logs","inputs":["t"],"endpoint":"https://hec.example:8088","default_token":"vectory-secret:HEC","encoding":{"codec":"json"}}}
        });
        for (pointer, field, component) in [
            ("/sinks/out/uri", "uri", "out"),
            ("/sinks/out/request", "request.headers.Authorization", "out"),
            ("/sinks/file/path", "path", "file"),
            ("/sinks/es/endpoints", "endpoints[0]", "es"),
            ("/sinks/hec/endpoint", "endpoint", "hec"),
            ("/sources/cmd/command", "command[1]", "cmd"),
            ("/transforms/t/source", "source", "t"),
        ] {
            let mut config = base.clone();
            let value = config.pointer_mut(pointer).unwrap();
            *value = match field {
                "request.headers.Authorization" => {
                    json!({"headers":{"Authorization":"vectory-secret:TOKEN"}})
                }
                "endpoints[0]" => json!(["vectory-secret:TOKEN"]),
                "command[1]" => json!(["echo", "vectory-secret:TOKEN"]),
                "source" => json!(".token = \"vectory-secret:TOKEN\""),
                _ => json!("vectory-secret:TOKEN"),
            };
            let result = validate(&config);
            assert_eq!(result["valid"], false, "{field}");
            let message = format!(
                "{component}: Only credential fields can hold a device secret, and `{field}` isn't one."
            );
            assert!(
                result["errors"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(message)),
                "{field}: {result}"
            );
            let diagnostic = structural_diagnostics(&config, &result)
                .into_iter()
                .find(|d| d.code.as_deref() == Some("secret_reference_refused"))
                .unwrap();
            assert_eq!(diagnostic.field.as_deref(), Some(field));
            // The validation copy never turns a refused reference into a placeholder.
            assert_eq!(
                static_candidate(&config, |_, _| true).placeholders,
                vec!["vectory-secret:HEC"]
            );
        }
        let outside = validate(
            &json!({"api":{"enabled":true,"address":"vectory-secret:ADDR"},"tests":[{"name":"t","inputs":[{"insert_at":"t","type":"log","log_fields":{"message":"vectory-secret:T"}}]}]}),
        );
        for message in [
            "Only credential fields can hold a device secret, and `api.address` isn't one.",
            "Only credential fields can hold a device secret, and `tests[0].inputs[0].log_fields.message` isn't one.",
        ] {
            assert!(
                outside["errors"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(message)),
                "{outside}"
            );
        }
        for malformed in [
            "prefix-vectory-secret:KEY",
            "vectory-secret:0bad",
            "Bearer vectory-secret:KEY",
        ] {
            let config =
                at_secret_field("sinks", "datadog_logs", "default_api_key", json!(malformed));
            let (references, errors) = local_secret_scan(&config);
            assert!(references.is_empty());
            assert!(
                errors[0].starts_with("c: `default_api_key` must be exactly `vectory-secret:NAME`"),
                "{errors:?}"
            );
        }
        // An object key named `[]` is not a list item.
        let key = json!({"sources":{"hec":{"type":"splunk_hec","valid_tokens":{"[]":"vectory-secret:T"}}}});
        assert_eq!(local_secret_scan(&key).1.len(), 1);
        // Unknown and missing types have no credential fields.
        for kind in [json!("not_a_vector_sink"), Value::Null] {
            let config = json!({"sinks":{"out":{"type":kind,"auth":{"token":"vectory-secret:T"}}}});
            assert!(!local_secret_scan(&config).1.is_empty());
        }
    }

    #[test]
    fn sink_auth_and_credential_names_outside_the_table_stay_protected() {
        // Before the table, sink auth fields refused plain text for any sink.
        let custom = json!({"sinks":{"out":{"type":"custom_future_sink","auth":{"user":"svc"}}}});
        let errors = local_secret_scan(&custom).1;
        assert_eq!(
            errors,
            [
                "out: Plaintext credentials cannot be stored in `auth.user`. Use a native secret or environment reference, such as SECRET[backend.key]."
            ]
        );
        // Credential-looking names anywhere else keep the generic refusal, once.
        let named = validate(
            &json!({"sources":{"in":{"type":"custom_source","client_secret":"synthetic-secret","endpoints":["https://synthetic-user:synthetic-password@es.example:9200"]}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}),
        );
        assert_eq!(named["valid"], false);
        let errors = named["errors"].as_array().unwrap();
        assert_eq!(errors.len(), 2, "{named}");
        assert!(
            errors
                .iter()
                .all(|e| e.as_str().unwrap().starts_with("Plaintext credentials"))
        );
    }

    #[test]
    fn http_credentials_outside_the_generated_table_are_refused_by_full_field_path() {
        let base = json!({
            "sources":{"in":{"type":"demo_logs","format":"json"}},
            "sinks":{"out":{"type":"http","inputs":["in"],"uri":"https://example.test/events","encoding":{"codec":"json"},"request":{"headers":{},"query":{}}}}
        });
        for (pointer, value, field) in [
            (
                "/sinks/out/client_secret",
                "z9Q4Y2R8",
                "sinks.out.client_secret",
            ),
            (
                "/sinks/out/request/headers/Authorization",
                "z9Q4Y2R8",
                "sinks.out.request.headers.Authorization",
            ),
            (
                "/sinks/out/request/query/api_key",
                "z9Q4Y2R8",
                "sinks.out.request.query.api_key",
            ),
            (
                "/sinks/out/request/headers/Authorization",
                "Bearer plaintext-token",
                "sinks.out.request.headers.Authorization",
            ),
            (
                "/sinks/out/request/headers/X-Honeycomb-Team",
                "plain-team-id",
                "sinks.out.request.headers.X-Honeycomb-Team",
            ),
            (
                "/sinks/out/request/headers/Cookie",
                "session=plain-cookie",
                "sinks.out.request.headers.Cookie",
            ),
            (
                "/sinks/out/request/headers/X-Signature",
                "plain-signature",
                "sinks.out.request.headers.X-Signature",
            ),
            (
                "/sinks/out/uri",
                "https://example.test/events?api_key=z9Q4Y2R8",
                "sinks.out.uri",
            ),
            (
                "/sinks/out/uri",
                "https://example.test/events?api_key=plain-key",
                "sinks.out.uri",
            ),
            (
                "/sinks/out/uri",
                "https://example.test/events?access%5Ftoken=plain-token",
                "sinks.out.uri",
            ),
            (
                "/sinks/out/uri",
                "https://hooks.slack.com/services/T123/B456/plain-webhook-token",
                "sinks.out.uri",
            ),
            (
                "/sinks/out/uri",
                "https://discord.com/api/webhooks/123/plain-discord-token",
                "sinks.out.uri",
            ),
            (
                "/sinks/out/uri",
                "https://user:plain-password@example.test/events",
                "sinks.out.uri",
            ),
        ] {
            let mut config = base.clone();
            if config.pointer(pointer).is_some() {
                *config.pointer_mut(pointer).unwrap() = json!(value);
            } else {
                let (parent, key) = pointer.rsplit_once('/').unwrap();
                config.pointer_mut(parent).unwrap()[key] = json!(value);
            }
            let result = validate(&config);
            assert_eq!(result["valid"], false, "{pointer}: {result}");
            let errors = result["errors"].as_array().unwrap();
            assert!(
                errors
                    .iter()
                    .any(|error| error.as_str().unwrap().contains(&format!("`{field}`"))),
                "{pointer}: {result}"
            );
            assert!(
                !result.to_string().contains(value),
                "credential appeared in validation response"
            );
            let diagnostic = structural_diagnostics(&config, &result)
                .into_iter()
                .find(|diagnostic| diagnostic.code.as_deref() == Some("plaintext_credential"))
                .unwrap();
            assert_eq!(diagnostic.field.as_deref(), Some(field));
        }
        let mut safe = base;
        safe["sinks"]["out"]["request"]["headers"]["X-Trace-Id"] = json!("nonsecret-id");
        for uri in [
            "https://example.test/events?page=3",
            "https://example.test/events?api_key=${API_KEY}",
            "https://hooks.slack.com/services/T123/B456/${WEBHOOK_TOKEN}",
        ] {
            safe["sinks"]["out"]["uri"] = json!(uri);
            assert_eq!(validate(&safe)["valid"], true, "{uri}");
        }
    }

    #[test]
    fn credential_shapes_cover_http_variants_without_refusing_examples() {
        for name in [
            "api_key",
            "apikey",
            "key",
            "token",
            "access_token",
            "auth",
            "sig",
            "signature",
            "secret",
            "client_secret",
            "password",
        ] {
            assert!(
                plaintext_url_credential(&format!(
                    "https://example.test/ingest?{name}=long-credential"
                )),
                "{name}"
            );
            assert!(
                !plaintext_url_credential(&format!("https://example.test/ingest?{name}=example")),
                "{name}"
            );
            assert!(
                plaintext_url_credential(&format!("https://example.test/ingest?{name}=x")),
                "{name}"
            );
        }
        for url in [
            "https://hooks.slack.com/services/T123/B456/long-webhook-token",
            "https://discordapp.com/api/webhooks/123/long-webhook-token",
            "https://tenant.webhook.office.com/IncomingWebhook/long-webhook-token",
            "https://outlook.office.com/webhook/long-webhook-token",
            "https://example.test/ingest?note=(ok)&api_key=short-secret",
            "https://example.test/ingest?note=\"ok\"&api_key=short-secret",
            "https://user:short-secret)@example.test/ingest",
            "https://example.test/ingest?note='ok'&api_key=short-secret",
            "https://example.test/ingest?note=<ok>&api_key=short-secret",
            "https://example.test/ingest?note=\\ok&api_key=short-secret",
        ] {
            assert!(plaintext_url_credential(url), "{url}");
        }
        assert!(plaintext_url_credential(
            ".uri = \"https://example.test/ingest?api_key=long-credential\""
        ));
        assert!(plaintext_url_credential(
            ".uri = \"https://example.test/ingest?note='ok'&api_key=short-secret\""
        ));
        assert!(!plaintext_url_credential(
            "https://example.test/ingest?api_key=${API_KEY}"
        ));
        assert!(!plaintext_url_credential(
            "https://${USER}:${PASSWORD}@example.test/ingest"
        ));
        assert!(!plaintext_url_credential(
            "https://SECRET[vault.user]:SECRET[vault.password]@example.test/ingest"
        ));
        assert!(!plaintext_url_credential(
            "https://example.test/ingest?note=(ok)&api_key=${API_KEY}"
        ));
        assert!(!plaintext_url_credential(
            "https://example.test/ingest?note=(ok)&api_key=example"
        ));
        assert!(!plaintext_url_credential(
            ".uri = \"https://example.test/ingest?note='ok'&api_key=${API_KEY}\""
        ));
        assert!(!plaintext_url_credential(
            ".message = \"hit https://example.test/?api_key=${API_KEY}\""
        ));
        assert!(!plaintext_url_credential(
            "s'hit https://example.test/?api_key=${API_KEY}'"
        ));
        assert!(!plaintext_url_credential(
            "See (https://collector.example/?api_key=example)"
        ));
        assert!(plaintext_url_credential(
            "See (https://collector.example/?api_key=tiny)"
        ));
        assert!(plaintext_url_credential(
            "See (https://collector.example/?api_key=example)more"
        ));
        assert!(plaintext_url_credential(
            ".message = \"hit https://example.test/?api_key=plain-secret\""
        ));
        assert!(plaintext_url_credential(
            "s'hit https://example.test/?api_key=plain-secret'"
        ));
        assert!(plaintext_url_credential(
            "don't trust https://example.test/?note='ok'&api_key=plain-secret"
        ));
        let long_url = format!(
            "https://example.test/{}?api_key=${{API_KEY}}",
            "x".repeat(16 * 1024)
        );
        let many_urls = std::iter::repeat_n("https://example.test/?api_key=${API_KEY}", 65)
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(url_credential_scan(&long_url), UrlCredentialScan::Limit);
        assert_eq!(url_credential_scan(&many_urls), UrlCredentialScan::Limit);
        assert!(!plaintext_url_credential(&long_url));
        assert!(!plaintext_url_credential(&many_urls));
        assert_eq!(
            credential_scan_limit_paths(&json!({"sinks":{"out":{"type":"http","uri":long_url}}})),
            ["sinks.out.uri"]
        );
        assert!(plaintext_url_credential(
            ".message = \"https://example.test/?note=\\\"ok\\\"&api_key=plain-secret\""
        ));
        assert!(!plaintext_url_credential(
            ".message = \"https://example.test/?note=\\\"ok\\\"&api_key=${API_KEY}\""
        ));
        assert!(!credential_literal("sid=${COOKIE}"));
        assert!(!credential_literal("Bearer redacted"));
        assert!(!credential_literal("bearer example"));
        assert!(!credential_literal("Token redacted"));
        assert!(!credential_literal("sid=${COOKIE}; theme=${THEME}"));
        assert!(!credential_literal(""));
        assert!(!credential_literal("example"));
        assert!(!credential_literal("SECRET[vault.key]"));
        assert!(credential_literal("x"));
        assert!(credential_literal("abc"));
        assert!(!credential_literal("sid=example"));
        assert!(credential_literal("Bearer live-secret=example"));
        assert!(credential_literal("sid=live-secret; theme=example"));
        assert!(credential_literal("sid=live-secret; theme=${THEME}"));
        assert!(!credential_key_name("source_key"));
        assert!(credential_key_name("x_honeycomb_team"));
        assert!(credential_header_name("X-Session-Token"));
        assert!(!credential_header_name("X-Team-Name"));
        assert!(credential_findings(&json!({"sinks":{"out":{"type":"http","request":{"headers":{"X-Team-Name":"platform"}}}}})).is_empty());
        assert_eq!(credential_findings(&json!({"sinks":{"out":{"type":"http","request":{"headers":{"X-Honeycomb-Team":"short"}}}}})).len(), 1);

        for token in [
            "AKIAABCDEFGHIJKLMNOP",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop",
            "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
            "xoxb-abcdefghijklmnop",
            "ghp_abcdefghijklmnop",
            "github_pat_abcdefghijklmnop",
            "glpat-abcdefghijklmnop",
            "sk-abcdefghijklmnop",
        ] {
            assert!(credential_token_shape(token), "{token}");
        }
        for ordinary in ["AKIAexample", "sk-example", "eyJhbGciOiJIUzI1NiJ9.abc"] {
            assert!(!credential_token_shape(ordinary), "{ordinary}");
        }
        let config = json!({
            "sources":{"in":{"type":"demo_logs","format":"json","note":"sk-abcdefghijklmnop"}},
            "sinks":{"out":{"type":"blackhole","inputs":["in"]}}
        });
        assert!(
            validate(&config)["errors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|error| error.as_str().unwrap().contains("`sources.in.note`"))
        );
    }

    #[test]
    fn device_secrets_become_placeholders_in_the_validation_copy() {
        let config = json!({
            "sources":{"in":{"type":"demo_logs","format":"json"}},
            "sinks":{
                "dd":{"type":"datadog_logs","inputs":["in"],"default_api_key":"vectory-secret:DD_API_KEY"},
                "rw":{"type":"prometheus_remote_write","inputs":["in"],"endpoint":"https://rw.example/api/v1/write",
                    "auth":{"strategy":"basic","user":"vectory-secret:RW_USER","password":"vectory-secret:RW_PASSWORD"}}
            }
        });
        let candidate = static_candidate(&config, |_, _| true);
        assert_eq!(
            candidate.config["sinks"]["dd"]["default_api_key"],
            PLACEHOLDER
        );
        assert_eq!(candidate.config["sinks"]["rw"]["auth"]["user"], PLACEHOLDER);
        assert_eq!(
            candidate.config["sinks"]["rw"]["auth"]["password"],
            PLACEHOLDER
        );
        assert_eq!(
            candidate.placeholders,
            vec![
                "vectory-secret:DD_API_KEY",
                "vectory-secret:RW_PASSWORD",
                "vectory-secret:RW_USER"
            ]
        );
        assert!(!candidate.config.to_string().contains("vectory-secret:"));
    }

    #[test]
    fn reported_secret_names_are_names_only_and_bounded() {
        assert_eq!(
            reported_secret_names(&json!(["ZETA", "ALPHA"])),
            Some(json!(["ALPHA", "ZETA"]))
        );
        assert_eq!(reported_secret_names(&json!([])), Some(json!([])));
        let many: Vec<String> = (0..65).map(|i| format!("N{i}")).collect();
        for invalid in [
            json!(["A", "A"]),
            json!(["/etc/vectory/secret"]),
            json!(["0bad"]),
            json!([1]),
            json!("A"),
            json!(many),
            json!([Value::Null]),
        ] {
            assert_eq!(reported_secret_names(&invalid), None, "{invalid}");
        }
    }

    #[test]
    fn named_route_and_hash_are_stable() {
        let v = json!({"sources":{"in":{"type":"demo_logs"}},"transforms":{"route":{"type":"route","inputs":["in"],"route":{"ok":"true"}}},"sinks":{"out":{"type":"console","inputs":["route.ok"],"encoding":{"codec":"json"}}}});
        assert_eq!(validate(&v)["valid"], true);
        assert_eq!(render(&v).unwrap(), render(&v).unwrap());
    }
    #[test]
    fn named_outputs_match_conditional_vector_ports() {
        let mut v = json!({"sources":{"in":{"type":"demo_logs"}},"transforms":{"process":{"type":"remap","inputs":["in"],"source":".ok = true","reroute_dropped":true}},"sinks":{"out":{"type":"console","inputs":["process.dropped"],"encoding":{"codec":"json"}}}});
        assert_eq!(validate(&v)["valid"], true);
        v["transforms"]["process"]["reroute_dropped"] = json!(false);
        assert_eq!(validate(&v)["valid"], false);
        v["transforms"]["process"] = json!({"type":"exclusive_route","inputs":["in"],"routes":[{"name":"accepted","condition":"true"}]});
        for port in ["accepted", "_unmatched"] {
            v["sinks"]["out"]["inputs"] = json!([format!("process.{port}")]);
            assert_eq!(validate(&v)["valid"], true);
        }
        for input in ["process", "process.missing"] {
            v["sinks"]["out"]["inputs"] = json!([input]);
            assert_eq!(validate(&v)["valid"], false);
        }
        v["transforms"]["process"] = json!({"type":"route","inputs":["in"],"route":{"accepted":"true"},"reroute_unmatched":false});
        v["sinks"]["out"]["inputs"] = json!(["process._unmatched"]);
        assert_eq!(validate(&v)["valid"], false);
        v["transforms"]["process"]["reroute_unmatched"] = json!(true);
        assert_eq!(validate(&v)["valid"], true);
        v["sources"]["in"] =
            json!({"type":"datadog_agent","address":"127.0.0.1:8080","multiple_outputs":true});
        v["transforms"] = json!({});
        for port in ["logs", "metrics", "traces", "llmobs"] {
            v["sinks"]["out"]["inputs"] = json!([format!("in.{port}")]);
            assert_eq!(validate(&v)["valid"], true);
            v["sources"]["in"][format!("disable_{port}")] = json!(true);
            assert_eq!(validate(&v)["valid"], false);
            v["sources"]["in"][format!("disable_{port}")] = json!(false);
        }
        v["sources"]["in"]["multiple_outputs"] = json!(false);
        assert_eq!(validate(&v)["valid"], false);
        v["sinks"]["out"]["inputs"] = json!(["in"]);
        assert_eq!(validate(&v)["valid"], true);
    }
    #[test]
    fn generic_ports_defer_to_native_without_weakening_security_or_topology() {
        let mut v = json!({"sources":{"in":{"type":"custom_source"}},"sinks":{"out":{"type":"blackhole","inputs":["in.logs"]}}});
        let result = validate(&v);
        assert_eq!(result["valid"], true);
        assert_eq!(result["vector_validated"], false);
        assert!(
            result["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| warning
                    .as_str()
                    .unwrap()
                    .contains("output in.logs requires native"))
        );
        v["sinks"]["out"]["inputs"] = json!(["missing.logs"]);
        assert_eq!(validate(&v)["valid"], false);
        v["sinks"]["out"]["inputs"] = json!(["out.logs"]);
        assert_eq!(validate(&v)["valid"], false);
        v["sinks"]["out"]["inputs"] = json!(["in.logs"]);
        v["sources"]["in"] = json!({"type":"custom_source","token":"plaintext"});
        assert_eq!(validate(&v)["valid"], false);
        v["sources"]["in"] = json!({"type":"custom_source","endpoint":"$SERVER"});
        assert_eq!(validate(&v)["valid"], true);
        assert!(needs_device_context(&v));
    }
    #[test]
    fn cycles_fail_even_with_full_native_components() {
        let v = json!({"sources":{"in":{"type":"exec","command":["echo"]}},"transforms":{"a":{"type":"filter","inputs":["b"]},"b":{"type":"filter","inputs":["a"]}},"sinks":{"out":{"type":"console","inputs":["in"]}}});
        let r = validate(&v);
        assert_eq!(r["valid"], false);
        assert!(
            r["errors"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e == "Pipeline contains a cycle")
        );
        assert_eq!(r["vector_validated"], false);
    }
    #[test]
    fn platform_deferral_is_exact_and_reports_resource_reasons() {
        for component in ["dnstap", "file_descriptor", "journald", "windows_event_log"] {
            let config = json!({"sources":{"input":{"type":component}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}});
            let result = validate(&config);
            assert_eq!(result["valid"], true);
            assert_eq!(result["vector_validated"], false);
            assert!(
                device_context_reasons(&config)
                    .iter()
                    .any(|r| r.contains(component))
            );
        }
        for component in ["demo_logs", "kafka", "not_a_real_type"] {
            let config = json!({"sources":{"input":{"type":component}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}});
            assert!(
                !needs_device_context(&config),
                "Unknown types must still reach native validation"
            );
        }
        assert!(
            device_context_reasons(
                &json!({"transforms":{"lua":{"type":"lua","search_dirs":["/device/code"]}}})
            )
            .contains(&"device-local paths or external code files".into())
        );
        for field in ["path", "procfs_root", "sysfs_root"] {
            let config = json!({"sources":{"input":{"type":"socket","mode":"unix",field:"/device/socket"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}});
            assert!(
                device_context_reasons(&config)
                    .contains(&"device-local paths or external code files".into())
            );
        }
    }
    #[test]
    fn full_configuration_preserves_native_references_globals_and_wildcards() {
        let config = json!({"sources":{"input one":{"type":"exec","command":["device-command"]}},"sinks":{"out":{"type":"aws_s3","inputs":["input*"],"bucket":"${BUCKET}","auth":{"access_key_id":"SECRET[host.access_key]","secret_access_key":"$SECRET_KEY"}}},"tests":[],"timezone":"UTC","wildcard_matching":"relaxed","enrichment_tables":{"lookup":{"type":"file","file":{"path":"/device/table.csv","encoding":{"type":"csv"}}}},"secret":{"host":{"type":"exec","command":["device-secret-provider"]}}});
        assert_eq!(validate(&config)["valid"], true);
        assert!(needs_device_context(&config));
        assert_eq!(
            serde_json::from_str::<Value>(&render(&config).unwrap()).unwrap(),
            config
        );
        assert_eq!(
            validate(&json!({"provider":{"type":"http","url":"${PROVIDER_URL}"}}))["valid"],
            true
        );
        for field in [
            "password",
            "api_key",
            "authorization",
            "client_secret",
            "sasl.password",
            "x-api-key",
            "authentication_token",
        ] {
            let mut altered = config.clone();
            altered["sinks"]["out"][field] = json!("plaintext-sensitive-value");
            let result = validate(&altered);
            assert_eq!(result["valid"], false);
            assert!(!result.to_string().contains("plaintext-sensitive-value"));
            altered["sinks"]["out"][field] = json!("SECRET[device.credential]");
            assert_eq!(validate(&altered)["valid"], true);
        }
    }

    #[test]
    fn placeholders_follow_vector_interpolation_and_keep_values_parseable() {
        let mut found = BTreeSet::new();
        let cases = [
            ("address", "0.0.0.0:${PORT}", "0.0.0.0:9"),
            ("address", "${LISTEN}", "127.0.0.1:9"),
            (
                "endpoint",
                "https://${ES_HOST}:9200",
                "https://vectory-placeholder:9200",
            ),
            ("uri", "SECRET[vault.url]", "http://127.0.0.1:9"),
            (
                "token",
                "Bearer SECRET[vault.token]",
                "Bearer vectory-placeholder",
            ),
            ("bucket", "${BUCKET:-logs}", "logs"),
            ("bucket", "${BUCKET-archive}", "archive"),
            ("path", "$LOG_DIR", "/vectory-placeholder"),
            ("source", ".cost = \"$$5 and $5\"", ".cost = \"$$5 and $5\""),
        ];
        for (key, text, expected) in cases {
            let replaced =
                substitute_references(text, key, &mut found).unwrap_or_else(|| text.to_owned());
            assert_eq!(replaced, expected, "{key}={text}");
        }
        assert!(
            found.contains("${PORT}")
                && found.contains("SECRET[vault.token]")
                && found.contains("$LOG_DIR")
        );
        assert!(substitute_references("no references", "x", &mut found).is_none());
    }

    #[test]
    fn static_candidate_never_runs_secret_backends_or_providers() {
        let config = json!({
            "secret": {"vault": {"type": "exec", "command": ["/bin/steal"]}},
            "sources": {"in": {"type": "socket", "mode": "tcp", "address": "0.0.0.0:${PORT}"}},
            "transforms": {
                "external": {"type": "remap", "inputs": ["in"], "file": "/etc/vector/parse.vrl"},
                "inline": {"type": "remap", "inputs": ["external"], "source": ".token = \"SECRET[vault.t]\""}
            },
            "sinks": {"out": {"type": "http", "inputs": ["inline"], "uri": "${URL}", "encoding": {"codec": "json"}}}
        });
        let candidate = static_candidate(&config, |_, _| true);
        assert!(candidate.checkable);
        assert!(candidate.config.get("secret").is_none());
        assert_eq!(candidate.config["sources"]["in"]["address"], "0.0.0.0:9");
        assert_eq!(
            candidate.config["sinks"]["out"]["uri"],
            "http://127.0.0.1:9"
        );
        assert_eq!(candidate.config["transforms"]["external"]["source"], ".");
        assert!(candidate.stubbed["external"].contains("file"));
        assert_eq!(
            candidate.placeholders,
            vec!["${PORT}", "${URL}", "SECRET[vault.t]"]
        );
        assert!(!candidate.config.to_string().contains("/bin/steal"));
        // A platform component missing from this worker's build is replaced, not rejected.
        let missing = static_candidate(&config, |_, kind| kind != "socket");
        assert_eq!(missing.config["sources"]["in"]["type"], "demo_logs");
        let mut provider = config.clone();
        provider["provider"] = json!({"type":"http","url":"https://config.example/"});
        let candidate = static_candidate(&provider, |_, _| true);
        assert!(!candidate.checkable);
        assert!(candidate.config.get("provider").is_none());
        // No section is created where the draft had none.
        let bare = static_candidate(&json!({"sources":{}}), |_, _| true);
        assert!(bare.config.get("transforms").is_none());
    }

    /// A `lua` step in every form the transform takes.
    fn lua_pipeline() -> Value {
        json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {
                "chunk": {"type": "lua", "version": "2", "inputs": ["in"],
                    "source": "os.execute('touch /x')\nfunction process(e, emit) emit(e) end",
                    "hooks": {"process": "process"}},
                "hooks": {"type": "lua", "version": "2", "inputs": ["chunk"],
                    "source": "function init() io.popen('id') end",
                    "hooks": {"init": "init"}, "timers": [{"interval_seconds": 1, "handler": "tick"}]},
                "v1": {"type": "lua", "version": "1", "inputs": ["hooks"], "source": "os.execute('id')"},
                "modules": {"type": "lua", "version": "2", "inputs": ["v1"],
                    "search_dirs": ["/device/lua"], "source": "require('m')"},
                "named": {"type": "lua", "inputs": ["modules"], "source": "x"},
                "plain": {"type": "remap", "inputs": ["named"], "source": "."}
            },
            "sinks": {"out": {"type": "blackhole", "inputs": ["plain"]}},
        })
    }

    #[test]
    fn a_lua_step_is_never_built_here_in_any_form() {
        let config = lua_pipeline();
        let candidate = static_candidate(&config, |_, _| true);
        for id in ["chunk", "hooks", "v1", "modules", "named"] {
            assert_eq!(
                candidate.stubbed.get(id).map(String::as_str),
                Some(LUA_STAND_IN),
                "{id}"
            );
            let step = &candidate.config["transforms"][id];
            assert_eq!(step["type"], "remap", "{id}");
            assert_eq!(step["source"], ".", "{id}");
        }
        assert!(!candidate.stubbed.contains_key("plain"));
        // The stand-ins keep the topology, and no Lua text reaches Vector.
        assert_eq!(
            candidate.config["transforms"]["v1"]["inputs"],
            json!(["hooks"])
        );
        let text = candidate.config.to_string();
        for code in [
            "os.execute",
            "io.popen",
            "require",
            "search_dirs",
            "\"lua\"",
        ] {
            assert!(
                !text.contains(code),
                "{code} reached the checked copy: {text}"
            );
        }
        // Even where this worker's Vector build has no `lua` at all.
        let without = static_candidate(&config, |_, kind| kind != "lua");
        assert_eq!(without.stubbed["chunk"], LUA_STAND_IN);
        assert_eq!(lua_transforms(&config).len(), 5);
    }

    #[test]
    fn lua_is_found_the_way_vector_would_read_the_checked_copy() {
        // A default in the type decides what Vector reads, so it counts.
        let disguised = json!({"transforms": {"x": {"type": "${KIND:-lua}", "inputs": ["in"], "source": "os.execute('id')"}}});
        assert_eq!(lua_transforms(&disguised), vec!["x".to_owned()]);
        let candidate = static_candidate(&disguised, |_, _| true);
        assert_eq!(candidate.stubbed["x"], LUA_STAND_IN);
        assert!(!candidate.config.to_string().contains("os.execute"));
        // The word elsewhere is not a Lua step.
        for config in [
            json!({"transforms": {"lua": {"type": "remap", "inputs": ["in"], "source": "."}}}),
            json!({"transforms": {"x": {"type": "remap", "inputs": ["in"], "source": ".kind = \"lua\""}}}),
            json!({"transforms": {"x": {"type": "${KIND}", "inputs": ["in"]}}}),
            json!({"transforms": {"x": {"type": "Lua", "inputs": ["in"]}}}),
            json!({"sources": {"lua": {"type": "demo_logs"}}, "sinks": {"lua": {"type": "blackhole"}}}),
            json!({"transforms": []}),
            json!({}),
        ] {
            assert!(lua_transforms(&config).is_empty(), "{config}");
            assert!(
                !device_context_reasons(&config).contains(&LUA_ON_DEVICES.to_owned()),
                "{config}"
            );
        }
    }

    #[test]
    fn a_lua_step_defers_to_devices_with_a_sentence_not_a_token() {
        let config = json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"probe": {"type": "lua", "version": "2", "inputs": ["in"],
                "source": "function process(e, emit) emit(e) end", "hooks": {"process": "process"}}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["probe"]}},
        });
        // Only its own reason: no local path is involved.
        assert_eq!(
            device_context_reasons(&config),
            vec![LUA_ON_DEVICES.to_owned()]
        );
        assert_eq!(reason_phrase(&[LUA_ON_DEVICES.to_owned()]), "Lua code");
        let result = check_result(vec![], true, true, device_context_reasons(&config), vec![]);
        assert_eq!(result["deferred"], true);
        assert_eq!(result["vector_validated"], false);
        assert_eq!(result["deferred_reasons"], json!([LUA_ON_DEVICES]));
        assert_eq!(
            result["warnings"],
            json!(["Each device checks Lua code before applying this version."])
        );
        let diagnostic = tests_on_devices_diagnostic(&config).unwrap();
        assert_eq!(diagnostic.severity, "error");
        assert_eq!(diagnostic.section.as_deref(), Some("tests"));
        assert_eq!(diagnostic.code.as_deref(), Some("tests_on_devices"));
        assert_eq!(
            diagnostic.message,
            "Lua can run any program, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests."
        );
        // It survives the API's re-check of a worker reply.
        let clean = crate::vector_diagnostics::sanitize(&config, &json!([diagnostic.to_json()]));
        assert_eq!(clean.unwrap()[0]["code"], "tests_on_devices");
    }

    /// The file every scanner of a VRL call that passes a file reads: this one,
    /// the agent's (`vrl_file_arguments_test.go`) and the dashboard's
    /// (`vrlFileArguments.test.ts`), so the three cannot drift.
    fn file_argument_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../vector-catalog/fixtures/vrl-file-arguments.json"
        ))
        .expect("the fixture is JSON")
    }

    /// A fixture program: a string, a list of programs joined together, or a
    /// program repeated.
    fn fixture_program(program: &Value) -> String {
        match program {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts.iter().map(fixture_program).collect(),
            Value::Object(_) => fixture_program(&program["repeat"])
                .repeat(program["times"].as_u64().expect("a count") as usize),
            other => panic!("not a program: {other}"),
        }
    }

    #[test]
    fn a_file_argument_is_found_however_it_is_written() {
        let fixture = file_argument_fixture();
        // The table and the bounds are the fixture's.
        let table: Vec<Value> = FILE_ARGUMENT_FUNCTIONS
            .iter()
            .map(|(function, argument, position, label)| {
                json!({"function": function, "argument": argument, "position": position, "label": label})
            })
            .collect();
        assert_eq!(json!(table), fixture["functions"]);
        assert_eq!(
            json!({"calls": MAX_FILE_ARGUMENT_CALLS, "call_bytes": MAX_CALL_BYTES, "scan_factor": MAX_SCAN_FACTOR}),
            fixture["bounds"]
        );
        let cases = fixture["cases"].as_array().expect("cases");
        assert!(cases.len() >= 60, "{} cases", cases.len());
        for case in cases {
            let found: Vec<&str> = case["found"]
                .as_array()
                .expect("found")
                .iter()
                .map(|label| label.as_str().expect("a label"))
                .collect();
            assert_eq!(
                file_argument_calls(&fixture_program(&case["program"])),
                found,
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn a_program_that_passes_a_file_is_never_compiled_here() {
        let config = json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {
                "groks": {"type": "remap", "inputs": ["in"],
                    "source": ".x = parse_groks!(.message, [\"%{A:a}\"], alias_sources: [\"/etc/a.json\"])"},
                "etld": {"type": "remap", "inputs": ["groks"],
                    "source": ".y = parse_etld!(.host, psl: \"/etc/list.dat\")"},
                "plain": {"type": "remap", "inputs": ["etld"],
                    "source": ".z = parse_etld!(.host)\n.w = parse_groks!(.message, [\"%{WORD:w}\"])"}
            },
            "sinks": {"out": {"type": "blackhole", "inputs": ["plain"]}},
        });
        let candidate = static_candidate(&config, |_, _| true);
        for id in ["groks", "etld"] {
            assert_eq!(
                candidate.stubbed.get(id).map(String::as_str),
                Some("reads a file on each device"),
                "{id}"
            );
        }
        assert!(!candidate.stubbed.contains_key("plain"));
        let text = candidate.config.to_string();
        assert!(
            !text.contains("/etc/a.json") && !text.contains("/etc/list.dat"),
            "{text}"
        );
        assert_eq!(
            unrunnable_vrl_calls(&config),
            BTreeSet::from(["parse_groks with alias_sources", "parse_etld with psl"])
        );
        let found = unrunnable_vrl_calls(&json!({"source": "parse_etld!(.h, psl: \"/p\")"}));
        assert_eq!(
            unrunnable_call_diagnostic(&found, "error").message,
            "This program calls parse_etld with psl, which reads files. The server never reads device files from samples or tests."
        );
        assert!(
            device_context_reasons(&config).contains(&"VRL access to device resources".to_owned())
        );
        let ordinary = json!({"transforms": {"p": {"type": "remap", "inputs": ["i"],
            "source": "parse_etld!(.h)"}}});
        assert!(device_context_reasons(&ordinary).is_empty());
    }

    /// A draft with an enrichment table of the given type and a step that looks it up.
    fn enrichment_pipeline(table: Value) -> Value {
        json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {
                "look": {"type": "remap", "inputs": ["in"],
                    "source": ".row = get_enrichment_table_record!(\"lk\", {\"k\": .message})"},
                "plain": {"type": "remap", "inputs": ["look"], "source": ".seen = true"}
            },
            "sinks": {"out": {"type": "blackhole", "inputs": ["plain"]}},
            "enrichment_tables": {"lk": table},
            "tests": [{"name": "t"}],
        })
    }

    #[test]
    fn an_enrichment_table_that_reads_a_file_never_reaches_vector() {
        for table in [
            json!({"type": "file", "file": {"path": "/etc/passwd", "encoding": {"type": "csv"}}}),
            json!({"type": "geoip", "path": "/etc/passwd"}),
            json!({"type": "mmdb", "path": "/etc/passwd"}),
            // A type this server does not know may read a file too.
            json!({"type": "future_kind", "path": "/etc/passwd"}),
            json!({"path": "/etc/passwd"}),
            // A default can decide the type.
            json!({"type": "${KIND:-file}", "file": {"path": "/etc/passwd"}}),
        ] {
            let config = enrichment_pipeline(table.clone());
            assert_eq!(
                file_enrichment_tables(&config),
                vec!["lk".to_owned()],
                "{table}"
            );
            let candidate = static_candidate(&config, |_, _| true);
            assert_eq!(candidate.config["enrichment_tables"], json!({}), "{table}");
            assert_eq!(
                candidate.stubbed.get("look").map(String::as_str),
                Some(ENRICHMENT_STAND_IN),
                "{table}"
            );
            // Only the step that looks the table up is replaced; the topology stays.
            assert!(!candidate.stubbed.contains_key("plain"), "{table}");
            assert_eq!(candidate.config["transforms"]["look"]["source"], ".");
            assert_eq!(
                candidate.config["transforms"]["plain"]["inputs"],
                json!(["look"])
            );
            assert!(
                !candidate.config.to_string().contains("/etc/passwd"),
                "{table}"
            );
            assert!(
                device_context_reasons(&config).contains(&ENRICHMENT_ON_DEVICES.to_owned()),
                "{table}"
            );
        }
        assert!(
            ENRICHMENT_VRL_FUNCTIONS
                .iter()
                .all(|name| DEVICE_VRL_FUNCTIONS.contains(name))
        );
    }

    #[test]
    fn a_memory_table_stays_in_the_checked_copy() {
        let config = enrichment_pipeline(json!({"type": "memory", "ttl": 60}));
        assert!(file_enrichment_tables(&config).is_empty());
        let candidate = static_candidate(&config, |_, _| true);
        assert_eq!(
            candidate.config["enrichment_tables"],
            config["enrichment_tables"]
        );
        assert!(candidate.stubbed.is_empty(), "{:?}", candidate.stubbed);
        assert_eq!(
            candidate.config["transforms"]["look"],
            config["transforms"]["look"]
        );
        // As before: the reason is the old one, and the tests still run.
        let reasons = device_context_reasons(&config);
        assert!(
            !reasons.contains(&ENRICHMENT_ON_DEVICES.to_owned()),
            "{reasons:?}"
        );
        assert!(tests_on_devices_diagnostic(&config).is_none());
        // Mixed with a table that reads a file, the memory table is kept.
        let mut mixed = config.clone();
        mixed["enrichment_tables"]["disk"] = json!({"type": "file", "file": {"path": "/x.csv"}});
        let candidate = static_candidate(&mixed, |_, _| true);
        assert_eq!(
            candidate.config["enrichment_tables"],
            json!({"lk": {"type": "memory", "ttl": 60}})
        );
    }

    #[test]
    fn tests_wait_for_devices_with_one_sentence_that_names_the_cause() {
        let lua = json!({"transforms": {"x": {"type": "lua", "version": "2", "inputs": ["in"]}}});
        let table = json!({"enrichment_tables": {"t": {"type": "geoip", "path": "/x.mmdb"}}});
        let both = json!({
            "transforms": lua["transforms"].clone(),
            "enrichment_tables": table["enrichment_tables"].clone(),
        });
        let message = |config: &Value| tests_on_devices_diagnostic(config).unwrap().message;
        assert_eq!(
            message(&lua),
            "Lua can run any program, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests."
        );
        assert_eq!(
            message(&table),
            "Enrichment tables are read on devices, so tests that use them run only on devices. Use Check on devices with Also run the pipeline's tests."
        );
        assert_eq!(
            message(&both),
            "Lua can run any program and enrichment tables are read on devices, so tests that include them run only on devices. Use Check on devices with Also run the pipeline's tests."
        );
        assert!(tests_on_devices_diagnostic(&json!({"transforms": {}})).is_none());
        // Both reasons name enrichment data once, not twice.
        assert_eq!(
            reason_phrase(&[
                "device enrichment data".to_owned(),
                ENRICHMENT_ON_DEVICES.to_owned()
            ]),
            "enrichment data files"
        );
    }

    fn instance_metadata_pipeline(kind: &str) -> Value {
        json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"meta": {"type": kind, "inputs": ["in"],
                "endpoint": "http://127.0.0.1:9", "refresh_interval_secs": 3600}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["meta"]}},
        })
    }

    #[test]
    fn an_instance_metadata_step_is_replaced_and_deferred_to_devices() {
        for kind in ["aws_ec2_metadata", "${KIND:-aws_ec2_metadata}"] {
            let config = instance_metadata_pipeline(kind);
            assert_eq!(
                instance_metadata_transforms(&config),
                vec!["meta"],
                "{kind}"
            );
            let candidate = static_candidate(&config, |_, _| true);
            assert_eq!(
                candidate.stubbed.get("meta").map(String::as_str),
                Some(INSTANCE_METADATA_STAND_IN),
                "{kind}"
            );
            // The step Vector would build, and the address it would ask, are gone.
            let text = candidate.config.to_string();
            assert!(
                !text.contains("aws_ec2_metadata") && !text.contains("127.0.0.1:9"),
                "{text}"
            );
            assert_eq!(
                candidate.config["transforms"]["meta"],
                json!({"type": "remap", "inputs": ["in"], "source": "."})
            );
            // Its own reason, and no local path: a type that a default reference
            // supplies is also an environment variable, and nothing else.
            let mut expected = vec![INSTANCE_METADATA_ON_DEVICES.to_owned()];
            if kind.starts_with('$') {
                expected.push("environment variables".to_owned());
            }
            assert_eq!(device_context_reasons(&config), expected, "{kind}");
            let result = check_result(vec![], true, true, device_context_reasons(&config), vec![]);
            assert_eq!(result["deferred"], true);
            assert_eq!(result["vector_validated"], false);
            assert_eq!(result["deferred_reasons"], json!(expected));
        }
        let result = check_result(
            vec![],
            true,
            true,
            device_context_reasons(&instance_metadata_pipeline("aws_ec2_metadata")),
            vec![],
        );
        assert_eq!(
            result["warnings"],
            json!([
                "Each device checks the AWS instance metadata step before applying this version."
            ])
        );
        assert_eq!(
            INSTANCE_METADATA_ON_DEVICES,
            "The AWS instance metadata step is checked on devices"
        );
        // Other steps, even ones that carry the name, are checked here as before.
        for config in [
            instance_metadata_pipeline("remap"),
            json!({"transforms": {"aws_ec2_metadata": {"type": "remap", "inputs": ["in"], "source": ".x = \"aws_ec2_metadata\""}}}),
            json!({"sources": {"aws_ec2_metadata": {"type": "demo_logs"}}, "sinks": {"aws_ec2_metadata": {"type": "blackhole"}}}),
            json!({}),
        ] {
            assert!(instance_metadata_transforms(&config).is_empty(), "{config}");
            assert!(
                !device_context_reasons(&config).contains(&INSTANCE_METADATA_ON_DEVICES.to_owned()),
                "{config}"
            );
            assert!(static_candidate(&config, |_, _| true).stubbed.is_empty());
        }
    }

    /// A pipeline whose one remap names its program the ways `program` says.
    fn remap_pipeline(program: Value) -> Value {
        let mut remap = json!({"type": "remap", "inputs": ["in"]});
        for (key, value) in program.as_object().unwrap() {
            remap[key] = value.clone();
        }
        json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"norm": remap},
            "sinks": {"out": {"type": "blackhole", "inputs": ["norm"]}},
        })
    }

    #[test]
    fn a_remap_with_its_program_in_a_file_is_replaced_and_deferred_to_devices() {
        // Exactly one way to name the program, and it is a file: the step is a
        // device's to read, in either spelling, with the others unset or null,
        // and whatever a default reference supplies as its type.
        for program in [
            json!({"file": "/etc/vector/normalize.vrl"}),
            json!({"files": ["/etc/vector/a.vrl", "/etc/vector/b.vrl"]}),
            json!({"file": "/etc/vector/normalize.vrl", "source": null, "files": null}),
            json!({"files": [], "file": null}),
            json!({"type": "${KIND:-remap}", "file": "/etc/vector/normalize.vrl"}),
        ] {
            let config = remap_pipeline(program.clone());
            assert_eq!(file_remap_transforms(&config), vec!["norm"], "{program}");
            let candidate = static_candidate(&config, |_, _| true);
            assert_eq!(
                candidate.stubbed.get("norm").map(String::as_str),
                Some(REMAP_FILE_STAND_IN),
                "{program}"
            );
            // The path Vector would open is gone from what it is given.
            assert_eq!(
                candidate.config["transforms"]["norm"],
                json!({"type": "remap", "inputs": ["in"], "source": "."}),
                "{program}"
            );
            let reasons = device_context_reasons(&config);
            assert!(
                reasons.contains(&REMAP_FILE_ON_DEVICES.to_owned()),
                "{program}"
            );
            let result = check_result(vec![], true, true, reasons, vec![]);
            assert_eq!(result["deferred"], true, "{program}");
            assert_eq!(result["vector_validated"], false, "{program}");
            assert!(
                result["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|warning| warning
                        .as_str()
                        .unwrap()
                        .starts_with("Each device checks local files and paths")),
                "{result}"
            );
            // Its tests wait for a device, whatever else the draft holds.
            let diagnostic = tests_on_devices_diagnostic(&config).unwrap();
            assert_eq!(
                diagnostic.message,
                "A VRL program in a file is read on devices, so tests that include it run only on devices. Use Check on devices with Also run the pipeline's tests.",
                "{program}"
            );
            assert_eq!(diagnostic.code.as_deref(), Some("tests_on_devices"));
        }
        assert_eq!(
            REMAP_FILE_ON_DEVICES,
            "A VRL program in a file is read on devices"
        );
        // Anything else is the worker's: an inline program, no program, and a
        // remap that names its program twice, which Vector refuses before it
        // opens a file and which is therefore left to say so itself.
        for program in [
            json!({"source": ".x = 1"}),
            json!({}),
            json!({"source": null, "file": null, "files": null}),
            json!({"source": ".x = 1", "file": "/etc/vector/normalize.vrl"}),
            json!({"source": ".x = 1", "files": ["/etc/vector/a.vrl"]}),
            json!({"file": "/etc/vector/a.vrl", "files": ["/etc/vector/b.vrl"]}),
            json!({"source": ".x = 1", "file": "/a.vrl", "files": ["/b.vrl"]}),
            json!({"source": ".x = 1", "file": "/etc/vector/normalize.vrl", "drop_on_error": false}),
        ] {
            let config = remap_pipeline(program.clone());
            assert!(file_remap_transforms(&config).is_empty(), "{program}");
            assert!(
                static_candidate(&config, |_, _| true).stubbed.is_empty(),
                "{program}"
            );
            assert!(
                !device_context_reasons(&config).contains(&REMAP_FILE_ON_DEVICES.to_owned()),
                "{program}"
            );
            assert!(tests_on_devices_diagnostic(&config).is_none(), "{program}");
        }
        // Other steps that carry a `file` are not remaps.
        let config =
            json!({"transforms": {"f": {"type": "filter", "inputs": ["in"], "file": "/x"}}});
        assert!(file_remap_transforms(&config).is_empty());
        assert!(static_candidate(&config, |_, _| true).stubbed.is_empty());
    }

    #[test]
    fn tests_wait_for_devices_and_name_every_cause_the_draft_has() {
        let causes = [
            (
                "transforms",
                "lua",
                json!({"type": "lua", "version": "2", "inputs": ["in"]}),
            ),
            (
                "enrichment_tables",
                "t",
                json!({"type": "geoip", "path": "/x.mmdb"}),
            ),
            (
                "transforms",
                "meta",
                json!({"type": "aws_ec2_metadata", "inputs": ["in"]}),
            ),
            (
                "transforms",
                "norm",
                json!({"type": "remap", "inputs": ["in"], "file": "/etc/vector/normalize.vrl"}),
            ),
        ];
        let lua = "Lua can run any program";
        let tables = "enrichment tables are read on devices";
        let metadata = "the AWS instance metadata step asks the host's own metadata service";
        let program = "a VRL program in a file is read on devices";
        let ending = "Use Check on devices with Also run the pipeline's tests.";
        // Every subset of the causes, named in one order, with the sentence's
        // ending that fits how many there are.
        for (mask, expected) in [
            (
                0b001,
                format!("{lua}, so tests that include it run only on devices. {ending}"),
            ),
            (
                0b010,
                format!(
                    "Enrichment tables are read on devices, so tests that use them run only on devices. {ending}"
                ),
            ),
            (
                0b100,
                format!(
                    "The AWS instance metadata step asks the host's own metadata service, so tests that include it run only on devices. {ending}"
                ),
            ),
            (
                0b011,
                format!(
                    "{lua} and {tables}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b101,
                format!(
                    "{lua} and {metadata}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b110,
                format!(
                    "Enrichment tables are read on devices and {metadata}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b111,
                format!(
                    "{lua}, {tables} and {metadata}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b1000,
                format!(
                    "A VRL program in a file is read on devices, so tests that include it run only on devices. {ending}"
                ),
            ),
            (
                0b1001,
                format!(
                    "{lua} and {program}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b1010,
                format!(
                    "Enrichment tables are read on devices and {program}, so tests that include them run only on devices. {ending}"
                ),
            ),
            (
                0b1111,
                format!(
                    "{lua}, {tables}, {metadata} and {program}, so tests that include them run only on devices. {ending}"
                ),
            ),
        ] {
            let mut config = json!({"transforms": {}, "enrichment_tables": {}});
            for (index, (section, id, component)) in causes.iter().enumerate() {
                if mask & (1 << index) != 0 {
                    config[*section][*id] = component.clone();
                }
            }
            let diagnostic = tests_on_devices_diagnostic(&config).unwrap();
            assert_eq!(diagnostic.message, expected, "{mask:04b}");
            assert_eq!(diagnostic.severity, "error");
            assert_eq!(diagnostic.section.as_deref(), Some("tests"));
            assert_eq!(diagnostic.code.as_deref(), Some("tests_on_devices"));
        }
    }

    #[test]
    fn repair_removes_reported_problems_so_later_stages_are_checked() {
        let mut candidate = json!({
            "bogus": true,
            "sources": {"a": {"type": "demo_logs", "format": "json"}, "b": {"type": "file"}},
            "transforms": {"t": {"type": "remap", "inputs": ["a", "gone"], "source": ".", "drop_on_eror": true}},
            "sinks": {"only_gone": {"type": "blackhole", "inputs": ["gone"]}, "fed": {"type": "blackhole", "inputs": ["t"]}}
        });
        let error = |section: &str,
                     component: Option<&str>,
                     code: &str,
                     field: Option<&str>,
                     related: Option<&str>| Diagnostic {
            section: Some(section.into()),
            component: component.map(str::to_owned),
            code: Some(code.into()),
            field: field.map(str::to_owned),
            related: related.into_iter().map(str::to_owned).collect(),
            ..Diagnostic::error("x")
        };
        let mut stubbed = BTreeMap::new();
        assert!(repair_candidate(
            &mut candidate,
            &[
                error("global", None, "unknown_field", Some("bogus"), None),
                error("sources", Some("b"), "missing_field", Some("include"), None),
                error(
                    "transforms",
                    Some("t"),
                    "unknown_field",
                    Some("drop_on_eror"),
                    None
                ),
                error(
                    "transforms",
                    Some("t"),
                    "missing_input",
                    Some("inputs"),
                    Some("gone")
                ),
                error(
                    "sinks",
                    Some("only_gone"),
                    "missing_input",
                    Some("inputs"),
                    Some("gone")
                ),
            ],
            &mut stubbed,
        ));
        assert!(candidate.get("bogus").is_none());
        assert_eq!(candidate["sources"]["b"]["type"], "demo_logs");
        assert_eq!(candidate["transforms"]["t"]["inputs"], json!(["a"]));
        assert!(candidate["transforms"]["t"].get("drop_on_eror").is_none());
        assert!(candidate["sinks"].get("only_gone").is_none());
        assert!(stubbed.contains_key("b") && stubbed.contains_key("only_gone"));
        assert!(!repair_candidate(
            &mut candidate,
            &[error("transforms", Some("t"), "cycle", None, None)],
            &mut stubbed
        ));
    }

    #[test]
    fn consumers_include_named_outputs_and_wildcards() {
        let config = json!({"transforms":{"r":{"type":"route","inputs":["in"],"route":{"a":"true"}}},"sinks":{"s":{"type":"blackhole","inputs":["r.a","app_*"]}}});
        assert!(consumed(&config, "r", Some("a")));
        assert!(!consumed(&config, "r", Some("_unmatched")));
        assert!(consumed(&config, "app_web", None));
        assert!(!consumed(&config, "web", None));
    }

    #[test]
    fn wildcard_matching_is_linear_in_the_number_of_stars() {
        assert!(glob_match("*", ""));
        assert!(glob_match("app_*", "app_web"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("*.a", "r.a"));
        assert!(!glob_match("app_*", "web"));
        assert!(glob_match("*a*b*", "xxaxxbxx"));
        assert!(!glob_match("*a*b", "xxaxxbxx"));
        assert!(glob_match("a*", "a"));
        assert!(!glob_match(&"*".repeat(257), "x"));
        let bomb = format!("{}b", "*a".repeat(24));
        let text = "a".repeat(60);
        let started = std::time::Instant::now();
        assert!(!glob_match(&bomb, &text));
        assert!(glob_match(&bomb, &format!("{text}b")));
        // The validator's no_consumers filter reaches the matcher through consumed().
        let config = json!({"sources":{"aaaa":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["src", bomb]}}});
        assert!(!consumed(&config, &text, None));
        assert!(started.elapsed() < std::time::Duration::from_millis(50));
    }

    #[test]
    fn sample_pipeline_tags_every_output_and_forces_observable_drops() {
        let remap =
            json!({"type":"remap","inputs":["upstream"],"source":".a = 1","drop_on_error":false});
        let pipeline = sample_pipeline(&remap, "/tmp/data", Some("UTC"));
        let step = &pipeline["transforms"]["vectory_step"];
        assert_eq!(step["inputs"], json!(["vectory_sample_in"]));
        assert_eq!(step["drop_on_error"], true);
        assert_eq!(step["reroute_dropped"], true);
        assert_eq!(pipeline["timezone"], "UTC");
        assert_eq!(
            pipeline["transforms"]["vectory_out_1"]["inputs"],
            json!(["vectory_step.dropped"])
        );
        // Every sample also prints a marker that does not pass through the step.
        assert_eq!(
            pipeline["transforms"]["vectory_sample_done"]["inputs"],
            json!(["vectory_sample_in"])
        );
        assert_eq!(
            pipeline["sinks"]["vectory_console"]["inputs"],
            json!(["vectory_out_*", "vectory_sample_done"])
        );
        assert_eq!(sample_done_marker(5), br#"{"m":4}"#.to_vec());
        assert_eq!(sample_done_marker(1), br#"{"m":0}"#.to_vec());
        let route = json!({"type":"route","route":{"errors":".status >= 500","ok":"true"},"reroute_unmatched":false});
        assert_eq!(sample_ports(&route), vec!["errors", "ok"]);
        let exclusive = json!({"type":"exclusive_route","routes":[{"name":"a","condition":"true"},{"name":"bad name","condition":"true"}]});
        assert_eq!(sample_ports(&exclusive), vec!["a", "_unmatched"]);
        assert!(testable_transform(&json!({"type":"remap","file":"/x.vrl"})).is_err());
        assert!(testable_transform(&json!({"type":"lua","source":"x"})).is_err());
    }

    #[test]
    fn sample_results_group_outputs_and_locate_runtime_errors() {
        let program = "if .x { abort }\n. = parse_json!(.message)";
        let remap = json!({"type":"remap","source":program});
        let start = program.find("parse_json!").unwrap();
        let end = program.len();
        let stdout = format!(
            "{}\n{}\n{}\nnot json\n{}\n",
            json!({"s":0,"o":"","e":{"a":1,"ts":"2026-01-01T00:00:00Z"},"t":["ts"]}),
            json!({"s":1,"o":"dropped","d":{"reason":"abort","message":"aborted"}}),
            json!({"s":2,"o":"dropped","d":{"reason":"error","message":format!("function call error for \"parse_json\" at ({start}:{end}): unable to parse json")}}),
            json!({"s":9,"o":"","e":{}}),
        );
        let results = sample_results(&remap, 4, stdout.as_bytes());
        assert_eq!(results[0]["outcome"], "emitted");
        assert_eq!(results[0]["outputs"][0]["timestamps"], json!(["ts"]));
        assert_eq!(results[1]["outcome"], "aborted");
        assert_eq!(results[2]["outcome"], "error");
        assert_eq!(
            (results[2]["line"].clone(), results[2]["column"].clone()),
            (json!(2), json!(5))
        );
        assert_eq!(results[3]["outcome"], "dropped");
        let filter = json!({"type":"filter","condition":"true"});
        assert_eq!(sample_results(&filter, 1, b"")[0]["outcome"], "filtered");
        assert_eq!(runtime_position("abc", "at (5:9)"), None);
    }

    #[test]
    fn check_result_reports_every_problem_and_honest_deferral() {
        let config = json!({"transforms":{"t":{"type":"remap","inputs":["a"],"source":"x"}}});
        let diagnostics = vec![
            Diagnostic::warning("w"),
            Diagnostic {
                code: Some("E103".into()),
                line: Some(1),
                column: Some(2),
                ..Diagnostic::error("unhandled fallible assignment").at(&config, "t")
            },
            Diagnostic::error("second"),
        ];
        let result = check_result(
            diagnostics,
            true,
            true,
            vec!["native secret references".into()],
            vec!["SECRET[a.b]".into()],
        );
        assert_eq!(result["valid"], false);
        assert_eq!(result["static_checked"], true);
        assert_eq!(result["vector_validated"], false);
        assert_eq!(result["deferred"], true);
        assert_eq!(result["diagnostics"][0]["severity"], "error");
        assert_eq!(
            result["errors"][0],
            "transforms.t line 1:2: E103 unhandled fallible assignment"
        );
        assert_eq!(result["placeholders"], json!(["SECRET[a.b]"]));
        assert!(
            result["warnings"]
                .to_string()
                .contains("Each device checks secrets")
        );
        let clean = check_result(vec![], true, true, vec![], vec![]);
        assert_eq!(clean["valid"], true);
        assert_eq!(clean["vector_validated"], true);
        assert_eq!(clean["deferred"], false);
        assert_eq!(clean["warnings"], json!([]));
    }

    #[test]
    fn every_configured_test_has_a_result_and_none_is_left_out_of_the_count() {
        let config =
            json!({"tests": [{"name": "first"}, {"name": "second"}, {}, {"name": "first"}]});
        // Vector reported only the test it could not read.
        let broken =
            json!({"name":"second","passed":false,"message":"Vector can't read this test: x"});
        let results = complete_results(&config, vec![broken.clone()]);
        let names: Vec<&str> = results
            .iter()
            .map(|r| r["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["first", "second", "Test 3", "first"]);
        assert_eq!(results[1], broken);
        for index in [0, 2, 3] {
            assert_eq!(results[index]["passed"], false, "{results:?}");
            assert_eq!(results[index]["not_run"], true, "{results:?}");
            assert_eq!(results[index]["message"], "Vector did not run this test.");
        }
        // Results Vector reported are kept in the configured order, one per test.
        let passed = |name: &str| json!({"name":name,"passed":true});
        let all = complete_results(
            &config,
            vec![
                passed("first"),
                passed("second"),
                passed("Test 3"),
                passed("first"),
            ],
        );
        assert!(
            all.iter()
                .all(|r| r["passed"] == true && r.get("not_run").is_none())
        );
        // A result for a name that is not configured is still shown, after the configured ones.
        let stray = complete_results(&config, vec![passed("stray")]);
        assert_eq!(stray.len(), 5);
        assert_eq!(stray[4]["name"], "stray");
    }

    fn pipeline_with_source(id: &str) -> Value {
        json!({
            "sources": {id: {"type": "demo_logs", "format": "json"}},
            "sinks": {"out": {"type": "blackhole", "inputs": [id]}},
        })
    }

    #[test]
    fn component_ids_may_not_name_paths_or_hold_control_characters() {
        // Vector joins a component's ID onto its data directory for
        // checkpoints and disk buffers, so an absolute path or a path with
        // separators puts them outside it.
        for id in [
            "/tmp/x",
            "a/b",
            "/",
            "a\\b",
            "C:\\x",
            "C:x",
            "d:",
            "a\nb",
            "a\tb",
            "a\u{0}b",
            "a\u{1b}[0m",
            "a\u{7f}b",
            "a\u{85}b",
        ] {
            let result = validate(&pipeline_with_source(id));
            assert_eq!(result["valid"], false, "{id:?}");
            let errors: Vec<&str> = result["errors"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            // The refusal names the component, and the rule, without echoing a
            // control character into a message.
            assert_eq!(errors.len(), 1, "{id:?}: {errors:?}");
            assert!(
                errors[0].ends_with(": component IDs can't contain / or \\ or control characters, or start with a drive letter and a colon (like C:). Rename this component."),
                "{id:?}: {}",
                errors[0]
            );
            assert!(!errors[0].chars().any(char::is_control), "{id:?}");
            if !id.chars().any(char::is_control) {
                assert!(errors[0].starts_with(&format!("{id}: ")), "{}", errors[0]);
            }
        }
        // The same rule for the ID of a memory table's generated source and
        // of the table that takes its inputs.
        let memory = |table: &str, source_key: &str| {
            json!({
                "sources": {"in": {"type": "demo_logs", "format": "json"}},
                "sinks": {"out": {"type": "blackhole", "inputs": ["in"]}},
                "enrichment_tables": {table: {"type": "memory", "inputs": ["in"],
                    "source_config": {"source_key": source_key, "export_interval": 5}}},
            })
        };
        assert_eq!(validate(&memory("cache", "export"))["valid"], true);
        for (table, source_key) in [("a/b", "export"), ("cache", "/tmp/x"), ("cache", "e\\x")] {
            let result = validate(&memory(table, source_key));
            assert_eq!(result["valid"], false, "{table} {source_key}");
            assert!(
                result["errors"]
                    .to_string()
                    .contains("component IDs can't contain"),
                "{result}"
            );
        }
    }

    #[test]
    fn component_ids_vector_accepts_stay_accepted() {
        // Measured with Vector 0.58: it refuses only a dot. Vectory adds only
        // what lets an ID leave the data directory, so these still pass.
        for id in [
            "plain",
            "with space",
            "-leading-dash",
            "star*",
            "bracket[0]",
            "colon:name",
            "cc:x",
            "1:x",
            "a,b",
            "caf\u{e9}",
            "a$b",
            "a{b}",
            "100%",
            "a\"b",
            "a'b",
            "UPPER_lower-123",
        ] {
            let result = validate(&pipeline_with_source(id));
            assert_eq!(result["valid"], true, "{id:?}: {}", result["errors"]);
        }
        // A dot, an empty ID and a long one stay refused, as they were.
        for id in ["a.b", "", &"x".repeat(129)] {
            assert_eq!(validate(&pipeline_with_source(id))["valid"], false);
        }
    }

    /// The IDs every reader of `component-ids.json` judges alike: the agent's
    /// `reportableID` reads this file too (`component_ids_test.go`).
    fn component_id_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../vector-catalog/fixtures/component-ids.json"
        ))
        .expect("the fixture is JSON")
    }

    #[test]
    fn a_reported_component_id_is_judged_as_the_shared_fixture_says() {
        let fixture = component_id_fixture();
        assert_eq!(fixture["max_bytes"], json!(MAX_COMPONENT_ID_BYTES));
        let cases = fixture["cases"].as_array().expect("cases");
        assert!(cases.len() >= 40, "{} cases", cases.len());
        for case in cases {
            let id = fixture_program(&case["id"]);
            let valid = case["valid"].as_bool().expect("valid");
            assert_eq!(reported_component_id(&id), valid, "{}", case["name"]);
        }
    }

    #[test]
    fn a_device_reports_no_id_the_validator_would_refuse_for_its_text() {
        // The report is never more permissive than the pipeline: an ID the
        // validator refuses for being empty, too long or a path is not
        // reportable, and a reportable one without a dot is a valid component ID.
        // What a report refuses on top (characters that can't be shown safely) is
        // the one difference.
        for case in component_id_fixture()["cases"].as_array().expect("cases") {
            let id = fixture_program(&case["id"]);
            let name = &case["name"];
            let validator_accepts = validate(&pipeline_with_source(&id))["valid"] == true;
            let text_refused =
                id.is_empty() || id.len() > MAX_COMPONENT_ID_BYTES || names_a_path(&id);
            if reported_component_id(&id) && !id.contains('.') {
                assert!(validator_accepts, "{name}");
            }
            if text_refused {
                assert!(!validator_accepts, "{name}");
                assert!(!reported_component_id(&id), "{name}");
            }
        }
    }

    #[test]
    fn a_refused_component_id_becomes_a_diagnostic_on_that_component() {
        let config = pipeline_with_source("a/b");
        let result = validate(&config);
        let diagnostics = structural_diagnostics(&config, &result);
        let refusal = diagnostics
            .iter()
            .find(|diagnostic| diagnostic.message.contains("component IDs can't contain"))
            .expect("a diagnostic for the refused ID");
        assert_eq!(refusal.component.as_deref(), Some("a/b"));
        assert_eq!(refusal.section.as_deref(), Some("sources"));
        assert_eq!(refusal.severity, "error");
    }

    #[test]
    fn softened_placeholder_findings_are_device_checks() {
        let softened =
            soften_placeholder(Diagnostic::error(format!("invalid value `{PLACEHOLDER}`")));
        assert_eq!(softened.severity, "warning");
        assert_eq!(softened.code.as_deref(), Some("device_value"));
        assert_eq!(
            soften_placeholder(Diagnostic::error("real")).severity,
            "error"
        );
    }
}
