use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::OnceLock,
};

pub const VECTOR_VERSION: &str = "0.58.0";

// Native Vector diagnostics can contain configuration values, local paths, VRL
// source, test events, and credentials. The isolated worker emits only these
// categories and identifiers that are already present in the submitted config.
// The API independently checks them before constructing public error text.
fn diagnostic_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn curated_field(section: &str, component_type: &str, field: &str) -> bool {
    static FIELDS: OnceLock<BTreeSet<(String, String, String)>> = OnceLock::new();
    FIELDS
        .get_or_init(|| {
            let catalog: Value =
                serde_json::from_str(include_str!("../../vector-catalog/catalog.json"))
                    .expect("pinned Vector component catalog must be JSON");
            catalog["components"]
                .as_array()
                .expect("pinned Vector component catalog must have components")
                .iter()
                .flat_map(|component| {
                    let section = component["kind"].as_str().unwrap_or("").to_owned();
                    let kind = component["type"].as_str().unwrap_or("").to_owned();
                    component["fields"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(move |field| (section.clone(), kind.clone(), field.to_owned()))
                })
                .collect()
        })
        .contains(&(
            section.to_owned(),
            component_type.to_owned(),
            field.to_owned(),
        ))
}

fn native_location(config: &Value, section: &str, component: &str) -> bool {
    ["sources", "transforms", "sinks"].contains(&section)
        && diagnostic_identifier(component)
        && config[section].get(component).is_some()
}

/// Extract a bounded category from pinned Vector's output. Never copy a
/// message, value, test name, event, or path from the native process.
pub fn classify_native_issue(config: &Value, stdout: &[u8], stderr: &[u8], tests: bool) -> Value {
    let output = [stdout, stderr]
        .into_iter()
        .filter_map(|bytes| std::str::from_utf8(bytes).ok())
        .collect::<Vec<_>>();
    if tests
        && output
            .iter()
            .any(|part| part.lines().any(|line| line.trim() == "Running tests"))
        && output.iter().any(|part| {
            part.lines().any(|line| {
                let line = line.trim();
                line.starts_with("test ") && line.ends_with(" ... failed")
            })
        })
    {
        return json!({"code":"PIPELINE_TEST_FAILED"});
    }
    for part in &output {
        let mut transform_errors = false;
        let mut transform = None;
        for line in part.lines() {
            let line = line.trim();
            if line == "Transform errors" {
                transform_errors = true;
                continue;
            }
            let Some(detail) = line.strip_prefix("x ") else {
                continue;
            };
            if transform_errors {
                if let Some(name) = detail
                    .strip_prefix("Transform \"")
                    .and_then(|text| text.split_once("\":").map(|(name, _)| name))
                    && native_location(config, "transforms", name)
                {
                    transform = Some(name);
                }
                continue;
            }
            for section in ["sources", "transforms", "sinks"] {
                let Some(rest) = detail
                    .strip_prefix(section)
                    .and_then(|text| text.strip_prefix('.'))
                else {
                    continue;
                };
                let Some((component, reason)) = rest.split_once(':') else {
                    continue;
                };
                if !native_location(config, section, component) {
                    continue;
                }
                let reason = reason.trim();
                let code = if reason.starts_with("missing field `") {
                    "REQUIRED_FIELD"
                } else if reason.starts_with("unknown variant ") {
                    "UNKNOWN_VARIANT"
                } else if reason.starts_with("unknown field ") {
                    "UNKNOWN_FIELD"
                } else if reason.starts_with("invalid type") {
                    "INVALID_TYPE"
                } else if reason.starts_with("invalid value") {
                    "INVALID_VALUE"
                } else {
                    continue;
                };
                let mut issue = json!({"code":code,"section":section,"component":component});
                if code == "REQUIRED_FIELD"
                    && let Some(field) = reason
                        .strip_prefix("missing field `")
                        .and_then(|text| text.split_once('`').map(|(field, _)| field))
                    && diagnostic_identifier(field)
                    && curated_field(
                        section,
                        config[section][component]["type"].as_str().unwrap_or(""),
                        field,
                    )
                {
                    issue["field"] = json!(field);
                }
                return issue;
            }
        }
        if transform_errors {
            if let Some(component) = transform {
                return json!({"code":"VRL_COMPILE_ERROR","section":"transforms","component":component});
            }
            return json!({"code":"VRL_COMPILE_ERROR"});
        }
    }
    Value::Null
}

/// Accept only a fixed category and an existing, conservatively named config
/// location. This guards the public API even if a validator worker is faulty.
pub fn public_native_issue(config: &Value, issue: &Value) -> Option<String> {
    let object = issue.as_object()?;
    if object
        .keys()
        .any(|key| !["code", "section", "component", "field"].contains(&key.as_str()))
    {
        return None;
    }
    let code = issue["code"].as_str()?;
    if ![
        "PIPELINE_TEST_FAILED",
        "VRL_COMPILE_ERROR",
        "REQUIRED_FIELD",
        "UNKNOWN_VARIANT",
        "UNKNOWN_FIELD",
        "INVALID_TYPE",
        "INVALID_VALUE",
        "VALIDATION_TIMEOUT",
        "VALIDATION_OUTPUT_LIMIT",
    ]
    .contains(&code)
    {
        return None;
    }
    let location = match (issue.get("section"), issue.get("component")) {
        (None, None) => None,
        (Some(section), Some(component)) => {
            let (section, component) = (section.as_str()?, component.as_str()?);
            if !native_location(config, section, component) {
                return None;
            }
            if code == "VRL_COMPILE_ERROR" && section != "transforms" {
                return None;
            }
            Some((section, component))
        }
        _ => return None,
    };
    if [
        "PIPELINE_TEST_FAILED",
        "VALIDATION_TIMEOUT",
        "VALIDATION_OUTPUT_LIMIT",
    ]
    .contains(&code)
        && location.is_some()
    {
        return None;
    }
    let field = match issue.get("field") {
        Some(value) => {
            let field = value.as_str()?;
            let (section, component) = location?;
            if code != "REQUIRED_FIELD"
                || !diagnostic_identifier(field)
                || config[section][component].get(field).is_some()
                || !curated_field(
                    section,
                    config[section][component]["type"].as_str().unwrap_or(""),
                    field,
                )
            {
                return None;
            }
            Some(field)
        }
        None => None,
    };
    let at = location
        .map(|(section, component)| format!("{section}.{component}: "))
        .unwrap_or_default();
    Some(match code {
        "PIPELINE_TEST_FAILED" => "A Vector pipeline test assertion failed. Review its expected outputs and run the test locally for details.".into(),
        "VRL_COMPILE_ERROR" => format!("{at}Vector could not compile a transform program. Review its VRL syntax and fallible operations."),
        "REQUIRED_FIELD" => match field {
            Some(field) => format!("{at}required setting `{field}` is missing."),
            None => format!("{at}a required setting is missing."),
        },
        "UNKNOWN_VARIANT" => format!("{at}Vector {VECTOR_VERSION} does not recognize a component type or option value. Review the documented choices."),
        "UNKNOWN_FIELD" => format!("{at}Vector {VECTOR_VERSION} does not recognize an option name. Review the component settings."),
        "INVALID_TYPE" => format!("{at}an option has the wrong value type for Vector {VECTOR_VERSION}."),
        "INVALID_VALUE" => format!("{at}an option value is invalid for Vector {VECTOR_VERSION}."),
        "VALIDATION_TIMEOUT" => "Native Vector validation exceeded the isolated worker's five-second limit.".into(),
        "VALIDATION_OUTPUT_LIMIT" => "Native Vector diagnostics exceeded the isolated worker's output limit.".into(),
        _ => unreachable!(),
    })
}

/// Rebuild the test response from safe fields. The validator is a separate
/// process, and its raw diagnostics (including event payloads) are never a
/// public API value, even when the worker itself returns an `errors` array.
pub fn public_pipeline_test_result(config: &Value, worker: &Value) -> Option<Value> {
    if worker["vector_version"] != VECTOR_VERSION {
        return None;
    }
    // A worker must not claim that device-local checks were deferred while
    // reporting a completed, passing pipeline test to the public API.
    if worker
        .get("deferred")
        .is_some_and(|value| value != &Value::Bool(false))
    {
        return None;
    }
    let valid = worker["valid"].as_bool()?;
    let tests_run = worker["tests_run"].as_bool()?;
    let has_tests = config["tests"]
        .as_array()
        .is_some_and(|tests| !tests.is_empty());
    if (valid
        && (!tests_run
            || !has_tests
            || worker["errors"]
                .as_array()
                .is_none_or(|errors| !errors.is_empty())
            || !worker["native_issue"].is_null()))
        || (!has_tests && tests_run)
    {
        return None;
    }
    let native_message = if !tests_run && worker["native_issue"]["code"] == "PIPELINE_TEST_FAILED" {
        None
    } else {
        public_native_issue(config, &worker["native_issue"])
    };
    let message = if !has_tests {
        "Add at least one Vector pipeline test before running tests.".to_owned()
    } else if tests_run {
        native_message.unwrap_or_else(|| {
            "Vector pipeline tests failed. Review the assertions and run local Vector for detailed diagnostics.".into()
        })
    } else {
        native_message.unwrap_or_else(|| {
            "The isolated Vector worker could not run pipeline tests. Review the configuration and try again.".into()
        })
    };
    Some(json!({
        "valid":valid,
        "tests_run":tests_run,
        "errors": if valid { Vec::<String>::new() } else { vec![message] },
        "warnings": if tests_run { vec!["Tests ran in the isolated Vector worker. Each target device still validates its local environment before activation."] } else { vec![] },
        "output":if valid { "Vector pipeline tests passed." } else if tests_run { "Vector pipeline tests failed." } else { "Vector pipeline tests did not run." },
        "deferred":false,
        "vector_version":VECTOR_VERSION,
    }))
}
/// Turn `vector vrl` stderr into a bounded plain-text diagnostic. The program
/// and sample are the caller's own synthetic input, so the compiler's message
/// (code, span, hint) is safe to return; process log lines and terminal escape
/// sequences are removed and output is capped.
pub fn vrl_diagnostic(stderr: &[u8]) -> Option<String> {
    const LIMIT: usize = 4000;
    let text = String::from_utf8_lossy(stderr);
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if ch == '\n' || ch == '\t' || !ch.is_control() {
            plain.push(ch);
        }
    }
    let lines: Vec<&str> = plain
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            // Drop Vector's own tracing lines, e.g. `2026-...Z  INFO vector::app: ...`.
            !(trimmed.len() > 20
                && trimmed.as_bytes()[..4].iter().all(u8::is_ascii_digit)
                && trimmed.as_bytes()[4] == b'-'
                && [" INFO ", " WARN ", " DEBUG ", " TRACE ", " ERROR "]
                    .iter()
                    .any(|level| trimmed.contains(level)))
        })
        .collect();
    let joined = lines.join("\n");
    let trimmed = joined.trim_matches('\n').trim_end();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() <= LIMIT {
        return Some(trimmed.to_owned());
    }
    let mut end = LIMIT;
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}\n…", &trimmed[..end]))
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
                if [
                    "get_env_var",
                    "get_secret",
                    "get_enrichment_table",
                    "find_enrichment_table",
                ]
                .iter()
                .any(|function| text.contains(function))
                {
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
// `vector validate --no-environment` compiles transforms (VRL, routes) but does
// not build sources, sinks or health checks, so device-local paths outside
// transforms (data_dir, file globs, TLS files, sink paths, Unix sockets) are
// parsed but never opened. The isolated worker can therefore still catch
// compile and topology errors. Transforms that load external code, providers,
// secrets, environment interpolation and enrichment data stay deferred.
pub fn can_static_check_device_paths(config: &Value) -> bool {
    let reasons = device_context_reasons(config);
    if reasons.len() != 1 || reasons[0] != "device-local paths or external code files" {
        return false;
    }
    // Only transforms are built. Remap programs loaded from files and Lua
    // modules resolved from search paths would be read on the worker.
    !config["transforms"].as_object().is_some_and(|transforms| {
        transforms
            .values()
            .any(|transform| match transform["type"].as_str() {
                Some("remap") => !transform["file"].is_null() || !transform["files"].is_null(),
                Some("lua") => true,
                _ => false,
            })
    })
}
pub fn mark_device_deferred(result: &mut Value, config: &Value) -> bool {
    let reasons = device_context_reasons(config);
    if reasons.is_empty() {
        return false;
    }
    result["deferred"] = json!(true);
    result["deferred_reasons"] = json!(reasons);
    let mut warnings: Vec<String> = result["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    warnings.push(format!(
        "Native validation is deferred to the device: {}. The server has not verified the target platform or resolved or executed these device resources.",
        reasons.join(", ")
    ));
    warnings.sort();
    warnings.dedup();
    result["warnings"] = json!(warnings);
    true
}
pub fn is_local_secret(value: &str) -> bool {
    let Some(name) = value.strip_prefix("vectory-secret:") else {
        return false;
    };
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_alphabetic()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
pub fn local_secret_references(config: &Value) -> (bool, Vec<String>) {
    fn walk(
        root: &Value,
        value: &Value,
        path: &mut Vec<String>,
        found: &mut bool,
        errors: &mut Vec<String>,
    ) {
        match value {
            Value::String(text) if text.contains("vectory-secret:") => {
                let valid = path.len() == 4
                    && path[0] == "sinks"
                    && path[2] == "auth"
                    && ["user", "password", "token"].contains(&path[3].as_str())
                    && ["http", "loki", "elasticsearch"]
                        .contains(&root["sinks"][&path[1]]["type"].as_str().unwrap_or(""))
                    && is_local_secret(text);
                if valid {
                    *found = true
                } else {
                    errors.push("Local secret references must be exact vectory-secret:NAME values in approved http/loki/elasticsearch sink auth fields".into())
                }
            }
            Value::String(text)
                if path.len() == 4
                    && path[0] == "sinks"
                    && path[2] == "auth"
                    && ["user", "password", "token"].contains(&path[3].as_str())
                    && !text.is_empty()
                    && !is_native_secret_reference(text) =>
            {
                errors.push(
                    "Plaintext credentials cannot be stored in sink authentication fields; use approved device-local secret references"
                        .into(),
                );
            }
            Value::Object(fields) => {
                for (key, value) in fields {
                    path.push(key.clone());
                    walk(root, value, path, found, errors);
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (index, value) in items.iter().enumerate() {
                    path.push(index.to_string());
                    walk(root, value, path, found, errors);
                    path.pop();
                }
            }
            _ => {}
        }
    }
    let mut found = false;
    let mut errors = Vec::new();
    walk(config, config, &mut Vec::new(), &mut found, &mut errors);
    (found, errors)
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
pub async fn validate_isolated(s: &crate::State, config: &Value) -> crate::error::Result<Value> {
    let mut result = validate(config);
    if result["valid"] != true {
        return Ok(result);
    }
    let static_paths = can_static_check_device_paths(config);
    // A configured worker must answer even when device resources prevent it
    // from running Vector. The worker reports an honest deferral for that
    // configuration; skipping the request would let its outage publish drafts.
    let deferred = !static_paths && mark_device_deferred(&mut result, config);
    let Some(url) = &s.settings.validation_url else {
        if static_paths {
            mark_device_deferred(&mut result, config);
        }
        return Ok(result);
    };
    let _permit = s.validation_slots.try_acquire().map_err(|_| {
        crate::error::ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Validation capacity busy; retry later",
        )
    })?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| crate::error::ApiError::invalid("Validator client unavailable"))?;
    let outcome = async {
        let mut response = client
            .post(format!("{}/validate", url.trim_end_matches('/')))
            .json(&json!({"config":config}))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65536) {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 65536 {
                return None;
            }
            bytes.extend_from_slice(&chunk)
        }
        let value: Value = serde_json::from_slice(&bytes).ok()?;
        if value["vector_version"] != VECTOR_VERSION
            || !value["valid"].is_boolean()
            || !value["vector_validated"].is_boolean()
            || (value["valid"] == false && value["vector_validated"] == true)
            || (value["valid"] == true && !value["native_issue"].is_null())
            || (static_paths
                && (value["static_checked"] != true
                    || value["deferred"] != true
                    || value["vector_validated"] != false))
            || (deferred
                && (value["vector_validated"] != false
                    || (value["valid"] == true
                        && (value["deferred"] != true
                            || value["deferred_reasons"] != result["deferred_reasons"]))))
            || (!static_paths
                && !deferred
                && value["valid"] == true
                && value["vector_validated"] != true)
        {
            return None;
        }
        Some(value)
    }
    .await;
    match outcome {
        Some(value) => {
            result["valid"] = value["valid"].clone();
            result["vector_validated"] = value["vector_validated"].clone();
            let native_message = if value["native_issue"]["code"] == "PIPELINE_TEST_FAILED" {
                None
            } else {
                public_native_issue(config, &value["native_issue"])
            };
            if deferred {
                // Preserve the server's exact device-context reasons. A worker
                // acknowledgement is availability evidence, not native Vector
                // validation or a reason to drop the deferral warning.
                if value["valid"] != true {
                    result["errors"] = json!([
                        native_message.clone().unwrap_or_else(|| "Isolated validator rejected the configuration. Validate on the device for local details.".into())
                    ]);
                }
            } else if static_paths {
                mark_device_deferred(&mut result, config);
                result["warnings"] = json!([
                    "Isolated Vector static checks completed with environment checks disabled. Device-local paths and environment remain unverified until device validation."
                ]);
            } else {
                result["warnings"] = json!([
                    "Validated by the isolated Vector worker with environment checks disabled; devices still validate local environment and capability policy before activation."
                ]);
            }
            if value["valid"] != true && !deferred {
                result["errors"] = json!([
                    native_message.unwrap_or_else(|| "Vector rejected the configuration. Validate it locally to inspect detailed diagnostics.".into())
                ])
            }
        }
        None => {
            result["valid"] = json!(false);
            if static_paths {
                mark_device_deferred(&mut result, config);
            }
            result["errors"] = json!([
                "Configured isolated Vector validator is unavailable; publication is blocked."
            ]);
        }
    }
    Ok(result)
}
pub fn render(config: &Value) -> std::result::Result<String, serde_json::Error> {
    // serde_json's default map is ordered: artifact bytes are stable and exclude canvas layout.
    serde_json::to_string_pretty(config).map(|s| s + "\n")
}
// Output semantics from Vector v0.58.0. Unknown component types are deliberately
// left to the pinned native validator instead of treating this list as a catalog.
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
pub fn validate(config: &Value) -> Value {
    let mut errors = Vec::<String>::new();
    let mut warnings=vec!["Vector validation unavailable; structural checks only. The device must validate with its installed Vector binary before activation.".to_owned()];
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
                    if name.is_empty() || name.len() > 128 || name.contains('.') {
                        errors.push(format!("Invalid component ID in {section}"))
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
                    if ![
                        "file",
                        "syslog",
                        "http_server",
                        "opentelemetry",
                        "remap",
                        "filter",
                        "route",
                        "sample",
                        "console",
                        "http",
                        "elasticsearch",
                        "aws_s3",
                        "loki",
                        "demo_logs",
                        "internal_metrics",
                        "prometheus_exporter",
                    ]
                    .contains(&item["type"].as_str().unwrap_or(""))
                    {
                        warnings.push(format!(
                            "{name}: generic component; requires native Vector validation"
                        ))
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
                if source_key.is_empty() || source_key.len() > 128 || source_key.contains('.') {
                    errors.push(format!("{table_name}: invalid memory source ID"));
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
    fn security(v: &Value, errors: &mut Vec<String>) {
        match v {
            Value::Object(o) => {
                for (k, v) in o {
                    let normalized = k.to_ascii_lowercase().replace(['-', '.'], "_");
                    // Native nullable credential lists retain field context while
                    // inspecting elements. JSON Schema marks these SensitiveString.
                    if ["valid_tokens", "access_keys"].contains(&normalized.as_str())
                        && v.as_array().is_some_and(|items| {
                            items.iter().any(|item| {
                                item.as_str().is_some_and(|text| {
                                    !text.is_empty() && !is_native_secret_reference(text)
                                })
                            })
                        })
                    {
                        errors.push("Plaintext credentials cannot be stored in configuration history; use native secret or environment references".into());
                    }
                    let credential_field = [
                        "password",
                        "passwd",
                        "api_key",
                        "apikey",
                        "access_key_id",
                        "secret_access_key",
                        "token",
                        "bearer",
                        "authorization",
                        "proxy_authorization",
                        "client_secret",
                        "private_key",
                    ]
                    .iter()
                    .any(|name| normalized == *name || normalized.ends_with(&format!("_{name}")));
                    if credential_field
                        && v.as_str().is_some_and(|s| {
                            !s.is_empty() && !is_local_secret(s) && !is_native_secret_reference(s)
                        })
                    {
                        errors.push("Plaintext credentials cannot be stored in configuration history; use native secret or environment references".into())
                    }
                    if v.as_str().is_some_and(|s| {
                        s.split_once("://").is_some_and(|(_, tail)| {
                            tail.split('/')
                                .next()
                                .unwrap_or("")
                                .split_once('@')
                                .is_some_and(|(credentials, _)| {
                                    !credentials.split(':').all(is_native_secret_reference)
                                })
                        })
                    }) {
                        errors.push(
                            "Plaintext credentials cannot be stored in configuration history"
                                .into(),
                        )
                    }
                    security(v, errors)
                }
            }
            Value::Array(a) => {
                for v in a {
                    security(v, errors)
                }
            }
            _ => {}
        }
    }
    security(config, &mut errors);
    if needs_device_context(config) {
        warnings.push("Device-local environment, secret providers or files are required; full Vector mode may be required and native validation must run on the device".into());
    }
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
    use super::*;
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
    fn device_deferral_keeps_structural_warnings() {
        let config = json!({"sources":{"opaque":{"type":"future_source","path":"/device/input"}},"sinks":{"out":{"type":"blackhole","inputs":["opaque"]}}});
        let mut result = validate(&config);
        assert_eq!(result["valid"], true, "{result}");
        assert!(mark_device_deferred(&mut result, &config));
        assert!(mark_device_deferred(&mut result, &config));
        let warnings = result["warnings"].as_array().unwrap();
        assert!(
            warnings
                .iter()
                .any(|warning| warning.as_str().unwrap().contains("generic component"))
        );
        assert_eq!(
            warnings
                .iter()
                .filter(|warning| warning
                    .as_str()
                    .unwrap()
                    .contains("Native validation is deferred"))
                .count(),
            1
        );
    }
    #[test]
    fn synthetic_test_event_path_does_not_defer_native_checks() {
        let mut config = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}},"tests":[{"name":"Synthetic path","inputs":[{"insert_at":"sample","type":"log","log_fields":{"path":"/synthetic/event","search_dirs":["/synthetic/only"],"message":"${LITERAL_EVENT}"}}]}]});
        config["tests"][0]["inputs"]
            .as_array_mut()
            .unwrap()
            .extend([
                json!({"insert_at":"sample","type":"raw","value":"${LITERAL_RAW_EVENT}"}),
                json!({"insert_at":"sample","type":"metric","metric":{"name":"synthetic","tags":{"path":"/synthetic/metric"}}}),
            ]);
        assert!(device_context_reasons(&config).is_empty());
        config["sinks"]["out"] = json!({"type":"file","inputs":["sample"],"path":"/device/output.jsonl","encoding":{"codec":"json"}});
        assert!(can_static_check_device_paths(&config));
        config["tests"][0]["inputs"]
            .as_array_mut()
            .unwrap()
            .push(json!({"insert_at":"sample","type":"vrl","source":".host = get_env_var!(\"DEVICE_HOST\")"}));
        assert!(
            device_context_reasons(&config).contains(&"VRL access to device resources".to_owned())
        );
        assert!(!can_static_check_device_paths(&config));
    }
    #[test]
    fn vrl_diagnostic_strips_logs_and_escapes_and_bounds_output() {
        let stderr = b"2026-09-29T02:07:28.361246Z  INFO vector::app: Log level is enabled. level=\"info\"\n\n\x1b[0m\x1b[1m\x1b[38;5;9merror[E103]\x1b[0m\x1b[1m: unhandled fallible assignment\x1b[0m\n  \x1b[0m\x1b[34m\xe2\x94\x8c\xe2\x94\x80\x1b[0m :1:6\n";
        let diagnostic = vrl_diagnostic(stderr).unwrap();
        assert!(diagnostic.starts_with("error[E103]: unhandled fallible assignment"));
        assert!(!diagnostic.contains('\u{1b}'));
        assert!(!diagnostic.contains("Log level"));
        assert!(diagnostic.contains(":1:6"));
        assert_eq!(
            vrl_diagnostic(b"2026-09-29T02:07:28Z  INFO vector::app: only logs\n"),
            None
        );
        let long = vec![b'x'; 9000];
        let bounded = vrl_diagnostic(&long).unwrap();
        assert!(bounded.len() <= 4005 && bounded.ends_with('…'));
    }
    #[test]
    fn static_worker_checks_device_paths_but_not_external_code() {
        let mut config = json!({"data_dir":"/var/lib/vector","sources":{"input":{"type":"file","include":["/var/log/app/*.log"]}},"transforms":{"parse":{"type":"remap","inputs":["input"],"source":". = parse_json!(.message)"}},"sinks":{"out":{"type":"file","inputs":["parse"],"path":"/device/events.jsonl","encoding":{"codec":"json"}}}});
        assert!(can_static_check_device_paths(&config));
        // Sources and sinks are not built with --no-environment: TLS files and
        // Unix sockets are parsed, never opened.
        config["sinks"]["out"]["tls"]["ca_file"] = json!("/device/ca.pem");
        assert!(can_static_check_device_paths(&config));
        config["sources"]["input"] =
            json!({"type":"socket","mode":"unix_stream","path":"/device/input.sock"});
        assert!(can_static_check_device_paths(&config));
        // Environment interpolation changes the loaded bytes; keep it deferred.
        config["sinks"]["out"]["path"] = json!("${DEVICE_OUTPUT}");
        assert!(!can_static_check_device_paths(&config));
        config["sinks"]["out"]["path"] = json!("/device/events.jsonl");
        // Component IDs and route names are labels, not path fields.
        let labels = json!({"sources":{"file":{"type":"demo_logs","format":"json"}},"transforms":{"logs_dir":{"type":"route","inputs":["file"],"route":{"file":".a == 1"}}},"sinks":{"out_path":{"type":"blackhole","inputs":["logs_dir.file"]}}});
        assert!(
            device_context_reasons(&labels).is_empty(),
            "{:?}",
            device_context_reasons(&labels)
        );
        // Transforms are compiled, so external VRL files cannot be read on the worker.
        config["transforms"]["parse"] =
            json!({"type":"remap","inputs":["input"],"file":"/etc/vector/parse.vrl"});
        assert!(!can_static_check_device_paths(&config));
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
            let mut result = validate(&config);
            assert!(mark_device_deferred(&mut result, &config));
            assert_eq!(result["valid"], true);
            assert_eq!(result["vector_validated"], false);
            assert!(result["deferred_reasons"].to_string().contains(component));
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
    fn native_diagnostics_classify_pinned_output_without_copying_values() {
        let config = json!({"sources":{"input":{"type":"file"}},"transforms":{"normalize":{"type":"remap","inputs":["input"],"source":"THIS IS NOT VALID VRL!!!"}},"sinks":{"out":{"type":"blackhole","inputs":["normalize"]}}});
        let vrl = b"Transform errors\n----------------\nx Transform \"normalize\": \nerror[E203]: syntax error\n1 | THIS IS NOT VALID VRL!!!\n  | /host/private/SECRET_VALUE\n";
        let issue = classify_native_issue(&config, &[], vrl, false);
        assert_eq!(
            issue,
            json!({"code":"VRL_COMPILE_ERROR","section":"transforms","component":"normalize"})
        );
        let public = public_native_issue(&config, &issue).unwrap();
        assert!(public.contains("transforms.normalize"));
        assert!(!public.contains("SECRET_VALUE"));
        assert!(!public.contains("THIS IS NOT"));

        let missing =
            b"Failed to load [\"/private/path\"]\nx sources.input: missing field `include`\n";
        let issue = classify_native_issue(&config, &[], missing, false);
        assert_eq!(
            issue,
            json!({"code":"REQUIRED_FIELD","section":"sources","component":"input","field":"include"})
        );
        assert_eq!(
            public_native_issue(&config, &issue).unwrap(),
            "sources.input: required setting `include` is missing."
        );

        let unknown = b"x sources.input: unknown variant `SECRET_VALUE`, expected one of `file`\n";
        let issue = classify_native_issue(&config, &[], unknown, false);
        assert_eq!(issue["code"], "UNKNOWN_VARIANT");
        assert!(
            !public_native_issue(&config, &issue)
                .unwrap()
                .contains("SECRET_VALUE")
        );

        let test_output = b"Running tests\ntest private-secret-name ... failed\noutput payloads:\n  {\"secret\":\"SECRET_VALUE\"}\n";
        let issue = classify_native_issue(&config, test_output, &[], true);
        assert_eq!(issue, json!({"code":"PIPELINE_TEST_FAILED"}));
        let public = public_native_issue(&config, &issue).unwrap();
        assert!(!public.contains("private-secret-name"));
        assert!(!public.contains("SECRET_VALUE"));
    }

    #[test]
    fn native_diagnostic_boundary_rejects_forged_locations_and_fields() {
        let config = json!({"sources":{"input":{"type":"file"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}});
        for issue in [
            json!({"code":"REQUIRED_FIELD","section":"sources","component":"input","field":"SECRET_VALUE"}),
            json!({"code":"REQUIRED_FIELD","section":"sources","component":"other","field":"include"}),
            json!({"code":"UNKNOWN_VARIANT","section":"sources","component":"input","message":"SECRET_VALUE"}),
            json!({"code":"PIPELINE_TEST_FAILED","section":"sources","component":"input"}),
            json!({"code":"VRL_COMPILE_ERROR","section":"sources","component":"input"}),
            json!({"code":"SECRET_VALUE"}),
        ] {
            assert_eq!(public_native_issue(&config, &issue), None, "{issue}");
        }
        assert_eq!(
            classify_native_issue(
                &config,
                &[],
                b"x sources.other: missing field `include`",
                false
            ),
            Value::Null
        );
        assert_eq!(
            classify_native_issue(
                &config,
                &[],
                b"x sources.input: missing field `SECRET_VALUE`",
                false
            )["field"],
            Value::Null
        );
    }

    #[test]
    fn public_test_result_discards_worker_diagnostics_and_claims() {
        let config = json!({"tests":[{"name":"private-name"}]});
        let hostile = json!({"valid":false,"tests_run":true,"vector_version":"0.58.0","errors":["SECRET_VALUE /private/path"],"output":"SECRET_VALUE","warnings":["SECRET_VALUE"],"native_issue":{"code":"PIPELINE_TEST_FAILED"},"deferred":false});
        let public = public_pipeline_test_result(&config, &hostile).unwrap();
        assert_eq!(public["valid"], false);
        assert_eq!(public["tests_run"], true);
        assert_eq!(public["deferred"], false);
        assert!(!public.to_string().contains("SECRET_VALUE"));
        assert!(!public.to_string().contains("/private/path"));
        assert!(!public.to_string().contains("native_issue"));
        let malformed = json!({"valid":true,"tests_run":false,"vector_version":"0.58.0"});
        assert_eq!(public_pipeline_test_result(&config, &malformed), None);
        let contradictory = json!({"valid":true,"tests_run":true,"vector_version":"0.58.0","errors":["SECRET_VALUE"]});
        assert_eq!(public_pipeline_test_result(&config, &contradictory), None);
        let deferred_pass = json!({"valid":true,"tests_run":true,"vector_version":"0.58.0","errors":[],"native_issue":null,"deferred":true});
        assert_eq!(public_pipeline_test_result(&config, &deferred_pass), None);
    }
}
