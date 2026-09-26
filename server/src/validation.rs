use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const VECTOR_VERSION: &str = "0.58.0";
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
                    && !text.is_empty() =>
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
pub async fn validate_isolated(s: &crate::State, config: &Value) -> crate::error::Result<Value> {
    let mut result = validate(config);
    if result["valid"] != true {
        return Ok(result);
    }
    let Some(url) = &s.settings.validation_url else {
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
            result["warnings"] = json!([
                "Validated by the isolated Vector worker with environment checks disabled; devices still validate local environment and capability policy before activation."
            ]);
            if value["valid"] != true {
                result["errors"] = json!([
                    "Vector rejected the configuration. Validate it locally to inspect detailed diagnostics."
                ])
            }
        }
        None => {
            result["valid"] = json!(false);
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
pub fn validate(config: &Value) -> Value {
    let mut errors = Vec::<String>::new();
    let mut warnings=vec!["Vector validation unavailable; structural checks only. The device must validate with its installed Vector binary before activation.".to_owned()];
    if !config.is_object() {
        errors.push("Configuration must be a JSON object".into());
        return json!({"valid":false,"errors":errors,"warnings":warnings,"vector_validated":false,"vector_version":VECTOR_VERSION});
    }
    let mut names = BTreeSet::new();
    let mut dependencies = BTreeMap::<String, Vec<String>>::new();
    for section in ["sources", "transforms", "sinks"] {
        if let Some(items) = config.get(section) {
            if let Some(items) = items.as_object() {
                if items.len() > 1000 {
                    errors.push("Configuration exceeds 1000 components per section".into());
                    continue;
                }
                for (name, item) in items {
                    if name.is_empty()
                        || name.len() > 128
                        || !name
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    {
                        errors.push(format!("Invalid component ID in {section}"))
                    }
                    if !names.insert(name.clone()) {
                        errors.push(format!("Duplicate component ID: {name}"))
                    }
                    if item["type"].as_str().is_none() {
                        errors.push(format!("{name}: type is required"))
                    }
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
    if config["sources"].as_object().is_none_or(|o| o.is_empty()) {
        errors.push("At least one source is required".into())
    }
    if config["sinks"].as_object().is_none_or(|o| o.is_empty()) {
        errors.push("At least one sink is required".into())
    }
    for (name, inputs) in &dependencies {
        for input in inputs {
            let mut parts = input.splitn(2, '.');
            let source = parts.next().unwrap_or("");
            if !names.contains(source) {
                errors.push(format!("{name}: unknown input {input}"));
                continue;
            }
            if config["sinks"].get(source).is_some() {
                errors.push(format!("{name}: a sink cannot be an input"))
            }
            if let Some(port) = parts.next() {
                let transform = &config["transforms"][source];
                let route_output = transform["type"] == "route"
                    && (port == "_unmatched" || transform["route"].get(port).is_some());
                let otel_output = config["sources"][source]["type"] == "opentelemetry"
                    && ["logs", "metrics", "traces"].contains(&port);
                if !route_output && !otel_output {
                    errors.push(format!("{name}: unknown output {input}"))
                }
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
  Value::String(s) if s.as_bytes().windows(2).any(|p|p[0]==b'$'&&(p[1]==b'{'||p[1]==b'_'||p[1].is_ascii_alphabetic()))=>errors.push("Environment substitution is disabled; use explicitly reviewed device-local configuration".into()),
  Value::Object(o)=>{for(k,v)in o{
   if k=="type"&&v=="exec"{errors.push("Command-executing components are disabled".into())}
   if k=="secret"||k=="secrets"{errors.push("Secret providers require a separately supported capability policy and are disabled".into())}
   let normalized=k.to_ascii_lowercase().replace('-',"_");
   if ["password","passwd","api_key","apikey","access_key_id","secret_access_key","token","bearer","authorization","proxy_authorization","client_secret","private_key"].contains(&normalized.as_str())&&v.as_str().is_some_and(|s|!s.is_empty()&&!is_local_secret(s)){errors.push("Plaintext credentials cannot be stored in configuration history".into())}
   if v.as_str().is_some_and(|s|s.split_once("://").is_some_and(|(_,tail)|tail.split('/').next().unwrap_or("").contains('@'))){errors.push("Plaintext credentials cannot be stored in configuration history".into())}
   security(v,errors)
  }},Value::Array(a)=>for v in a{security(v,errors)},_=>{}}
    }
    security(config, &mut errors);
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
    fn capabilities_and_cycles_fail() {
        let v = json!({"sources":{"in":{"type":"exec","command":["echo"]}},"transforms":{"a":{"type":"filter","inputs":["b"]},"b":{"type":"filter","inputs":["a"]}},"sinks":{"out":{"type":"console","inputs":["in"]}}});
        let r = validate(&v);
        assert_eq!(r["valid"], false);
        assert!(r["errors"].as_array().unwrap().len() >= 2);
        assert_eq!(r["vector_validated"], false);
    }
}
