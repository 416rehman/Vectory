//! Immutable, typed public variables for a published Vector configuration.
//! Substitution replaces existing scalar JSON values only; it never parses a
//! string as configuration, changes an object key, or changes an array shape.
use crate::{
    db,
    error::{ApiError, Result},
    validation,
};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

pub struct Artifact {
    pub bytes: String,
    pub sha256: String,
    pub size: usize,
}

fn pointer_tokens(path: &str) -> Option<Vec<String>> {
    if !path.starts_with('/') || path.len() > 512 {
        return None;
    }
    let mut tokens = Vec::new();
    for token in path[1..].split('/') {
        if token.is_empty() {
            return None;
        }
        let mut decoded = String::new();
        let mut chars = token.chars();
        while let Some(ch) = chars.next() {
            if ch == '~' {
                decoded.push(match chars.next()? {
                    '0' => '~',
                    '1' => '/',
                    _ => return None,
                });
            } else {
                decoded.push(ch);
            }
        }
        tokens.push(decoded);
    }
    Some(tokens)
}

fn scalar_type(value: &Value) -> Option<&'static str> {
    match value {
        Value::String(_) => Some("string"),
        Value::Bool(_) => Some("boolean"),
        Value::Number(n)
            if n.as_i64()
                .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n)) =>
        {
            Some("integer")
        }
        _ => None,
    }
}

fn safe_path(tokens: &[String]) -> bool {
    // Public values only. Secret references belong in the existing device-local
    // secret system, and structural Vector selectors cannot be parametrized.
    if [
        "api",
        "data_dir",
        "providers",
        "secrets",
        "enrichment_tables",
        "healthchecks",
        "acknowledgements",
    ]
    .contains(&tokens[0].as_str())
    {
        return false;
    }
    !tokens.iter().any(|part| {
        let lower = part.to_ascii_lowercase();
        [
            "type",
            "inputs",
            "command",
            "exec",
            "script",
            "code",
            "source",
            "condition",
            "auth",
            "password",
            "secret",
            "token",
            "credential",
            "private_key",
            "access_key",
            "api_key",
            "headers",
            "query",
            "provider",
            "source_files",
            "files",
            "verify_certificate",
            "verify_hostname",
            "tls",
            "ca_file",
            "cert_file",
            "key_file",
        ]
        .contains(&lower.as_str())
            || lower.contains("password")
            || lower.contains("secret")
            || lower.contains("credential")
    })
}

pub fn declarations(config: &Value, input: &Value) -> Result<Value> {
    let items = input
        .as_array()
        .ok_or_else(|| ApiError::invalid("variables must be an array"))?;
    if items.len() > 64 {
        return Err(ApiError::invalid("At most 64 variables are allowed"));
    }
    let mut names = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for item in items {
        let object = item
            .as_object()
            .ok_or_else(|| ApiError::invalid("Variable declaration must be an object"))?;
        if object.len() != 3
            || !["name", "path", "type"]
                .iter()
                .all(|key| object.contains_key(*key))
        {
            return Err(ApiError::invalid(
                "Variable declaration requires only name, path and type",
            ));
        }
        let name = item["name"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("Invalid variable name"))?;
        if name.is_empty()
            || name.len() > 64
            || !name.bytes().next().unwrap().is_ascii_alphabetic()
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            || !names.insert(name.to_owned())
        {
            return Err(ApiError::invalid(
                "Variable names must be unique ASCII identifiers of at most 64 characters",
            ));
        }
        let path = item["path"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("Invalid variable path"))?;
        let tokens = pointer_tokens(path).ok_or_else(|| {
            ApiError::invalid("Variable path must be a canonical JSON Pointer to a scalar")
        })?;
        let mut cursor = config;
        for token in &tokens {
            cursor = cursor
                .as_object()
                .and_then(|object| object.get(token))
                .ok_or_else(|| {
                    ApiError::invalid("Variable path must traverse objects, not arrays")
                })?;
        }
        if !safe_path(&tokens) || !paths.insert(path.to_owned()) {
            return Err(ApiError::invalid(
                "Variable path is duplicated or targets a structural or credential field",
            ));
        }
        let typ = item["type"]
            .as_str()
            .ok_or_else(|| ApiError::invalid("Invalid variable type"))?;
        if !["string", "integer", "boolean"].contains(&typ)
            || config.pointer(path).and_then(scalar_type) != Some(typ)
        {
            return Err(ApiError::invalid(
                "Variable path must identify an existing scalar of the declared type",
            ));
        }
    }
    Ok(input.clone())
}

fn safe_value(value: &Value, typ: &str) -> bool {
    if scalar_type(value) != Some(typ) {
        return false;
    }
    if let Some(text) = value.as_str() {
        if text.len() > 4096 || text.chars().any(char::is_control) {
            return false;
        }
        let lower = text.to_ascii_lowercase();
        if [
            "vectory-secret:",
            "secret[",
            "${",
            "{{",
            "%{",
            "password=",
            "token=",
            "api_key=",
            "apikey=",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
        {
            return false;
        }
        if text.contains('$') || text.contains('@') && text.contains("://") {
            return false;
        }
    }
    true
}

fn binding_maps<'a>(
    bindings: &'a Value,
) -> Result<(
    &'a serde_json::Map<String, Value>,
    &'a serde_json::Map<String, Value>,
)> {
    let obj = bindings
        .as_object()
        .ok_or_else(|| ApiError::invalid("variable_bindings must be an object"))?;
    if obj.keys().any(|key| key != "defaults" && key != "devices") {
        return Err(ApiError::invalid("Unknown variable_bindings field"));
    }
    let defaults = obj
        .get("defaults")
        .and_then(Value::as_object)
        .ok_or_else(|| ApiError::invalid("variable_bindings.defaults must be an object"))?;
    let devices = obj
        .get("devices")
        .and_then(Value::as_object)
        .ok_or_else(|| ApiError::invalid("variable_bindings.devices must be an object"))?;
    Ok((defaults, devices))
}

pub fn validate_bindings(
    version: &Value,
    bindings: &Value,
    selected: &BTreeSet<String>,
    persistent: bool,
) -> Result<()> {
    let declarations = version["variables"].as_array().cloned().unwrap_or_default();
    if declarations.is_empty() {
        if bindings.is_null() || bindings == &json!({"defaults":{},"devices":{}}) {
            return Ok(());
        }
        return Err(ApiError::invalid("This version declares no variables"));
    }
    let (defaults, devices) = binding_maps(bindings)?;
    let types = declarations
        .iter()
        .map(|d| {
            (
                d["name"].as_str().unwrap_or("").to_owned(),
                d["type"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for (name, value) in defaults {
        if !types.get(name).is_some_and(|typ| safe_value(value, typ)) {
            return Err(ApiError::invalid(
                "Variable default has an unknown name, invalid type or unsafe value",
            ));
        }
    }
    if persistent && defaults.len() != types.len() {
        return Err(ApiError::invalid(
            "Persistent assignments require a default for every variable",
        ));
    }
    if devices.len() > 10000 {
        return Err(ApiError::invalid("Too many device variable overrides"));
    }
    for (device, values) in devices {
        if uuid::Uuid::parse_str(device).is_err() || !selected.contains(device) {
            return Err(ApiError::invalid(
                "Variable override targets an unselected device",
            ));
        }
        let values = values
            .as_object()
            .ok_or_else(|| ApiError::invalid("Device variable overrides must be objects"))?;
        for (name, value) in values {
            if !types.get(name).is_some_and(|typ| safe_value(value, typ)) {
                return Err(ApiError::invalid(
                    "Device variable override has an unknown name, invalid type or unsafe value",
                ));
            }
        }
    }
    for device in selected {
        for name in types.keys() {
            if defaults.contains_key(name)
                || devices
                    .get(device)
                    .and_then(Value::as_object)
                    .is_some_and(|values| values.contains_key(name))
            {
                continue;
            }
            return Err(ApiError::invalid(
                "Each target requires a value for every declared variable",
            ));
        }
    }
    Ok(())
}

pub fn render(version: &Value, bindings: &Value, device: &str) -> Result<Artifact> {
    let declarations = version["variables"].as_array().cloned().unwrap_or_default();
    if declarations.is_empty() {
        let bytes = version["artifact"]
            .as_str()
            .ok_or_else(ApiError::missing)?
            .to_owned();
        let sha256 = db::hash(&bytes);
        if version["sha256"].as_str() != Some(sha256.as_str()) {
            return Err(ApiError::invalid("Published artifact digest mismatch"));
        }
        return Ok(Artifact {
            size: bytes.len(),
            sha256,
            bytes,
        });
    }
    let (defaults, devices) = binding_maps(bindings)?;
    let overrides = devices.get(device).and_then(Value::as_object);
    let mut config = version["config"].clone();
    for declaration in declarations {
        let name = declaration["name"].as_str().ok_or_else(ApiError::missing)?;
        let path = declaration["path"].as_str().ok_or_else(ApiError::missing)?;
        let typ = declaration["type"].as_str().ok_or_else(ApiError::missing)?;
        let value = overrides
            .and_then(|o| o.get(name))
            .or_else(|| defaults.get(name))
            .ok_or_else(|| ApiError::invalid("Device has no value for a declared variable"))?;
        if !safe_value(value, typ) {
            return Err(ApiError::invalid(
                "Variable value is unsafe or has the wrong type",
            ));
        }
        let leaf = config.pointer_mut(path).ok_or_else(ApiError::missing)?;
        if scalar_type(leaf) != Some(typ) {
            return Err(ApiError::invalid(
                "Variable declaration no longer matches the published configuration",
            ));
        }
        *leaf = value.clone();
    }
    if validation::validate(&config)["valid"] != true {
        return Err(ApiError::invalid(
            "Rendered device configuration failed structural validation",
        ));
    }
    let bytes = validation::render(&config)
        .map_err(|_| ApiError::invalid("Cannot render device configuration"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(ApiError::invalid("Rendered device artifact exceeds 1 MiB"));
    }
    Ok(Artifact {
        size: bytes.len(),
        sha256: db::hash(&bytes),
        bytes,
    })
}

pub async fn target_artifact(
    db: &mut SqliteConnection,
    deployment: &Value,
    device: &str,
) -> Result<Artifact> {
    if let Some(sha) = deployment["rollback_artifacts"][device].as_str() {
        if let Ok(artifact) = blob(db, sha).await {
            return Ok(artifact);
        }
        let version = db::record(
            db,
            "version",
            deployment["version_id"]
                .as_str()
                .ok_or_else(ApiError::missing)?,
        )
        .await?;
        if version["variables"].as_array().is_none_or(Vec::is_empty)
            && version["sha256"].as_str() == Some(sha)
        {
            return render(&version, &Value::Null, device);
        }
        return Err(ApiError::missing());
    }
    let version = db::record(
        db,
        "version",
        deployment["version_id"]
            .as_str()
            .ok_or_else(ApiError::missing)?,
    )
    .await?;
    render(&version, &deployment["variable_bindings"], device)
}

pub async fn blob(db: &mut SqliteConnection, sha: &str) -> Result<Artifact> {
    let row = sqlx::query("SELECT artifact,size FROM artifact_blobs WHERE sha256=?")
        .bind(sha)
        .fetch_optional(&mut *db)
        .await?
        .ok_or_else(ApiError::missing)?;
    let bytes: Vec<u8> = row.get("artifact");
    let size: i64 = row.get("size");
    if bytes.len() as i64 != size || db::hash(&bytes) != sha {
        return Err(ApiError::invalid("Stored artifact digest mismatch"));
    }
    let bytes = String::from_utf8(bytes)
        .map_err(|_| ApiError::invalid("Stored artifact is invalid UTF-8"))?;
    Ok(Artifact {
        bytes,
        sha256: sha.to_owned(),
        size: size as usize,
    })
}

pub async fn snapshot(
    db: &mut SqliteConnection,
    device: &str,
    generation: i64,
    version: &str,
    artifact: &Artifact,
) -> Result<()> {
    if generation <= 0
        || artifact.size == 0
        || artifact.size > 1024 * 1024
        || db::hash(&artifact.bytes) != artifact.sha256
    {
        return Err(ApiError::invalid(
            "Cannot persist an invalid target artifact",
        ));
    }
    sqlx::query("INSERT OR IGNORE INTO artifact_blobs(sha256,size,artifact) VALUES(?,?,?)")
        .bind(&artifact.sha256)
        .bind(artifact.size as i64)
        .bind(artifact.bytes.as_bytes())
        .execute(&mut *db)
        .await?;
    // A digest collision or corrupt content cannot silently alias another
    // workload. Read all bytes, not just metadata, before referencing it.
    let stored = blob(db, &artifact.sha256).await?;
    if stored.bytes != artifact.bytes {
        return Err(ApiError::invalid("Artifact digest collision"));
    }
    sqlx::query("INSERT OR IGNORE INTO desired_artifacts(device_id,generation,version_id,sha256,created_at) VALUES(?,?,?,?,?)")
        .bind(device).bind(generation).bind(version).bind(&artifact.sha256).bind(db::now())
        .execute(&mut *db).await?;
    let row = sqlx::query(
        "SELECT version_id,sha256 FROM desired_artifacts WHERE device_id=? AND generation=?",
    )
    .bind(device)
    .bind(generation)
    .fetch_one(&mut *db)
    .await?;
    if row.get::<String, _>("version_id") != version
        || row.get::<String, _>("sha256") != artifact.sha256
    {
        return Err(ApiError::invalid(
            "Desired artifact changed without a new generation",
        ));
    }
    Ok(())
}

pub async fn current(
    db: &mut SqliteConnection,
    device: &str,
    generation: i64,
    version: &str,
) -> Result<Option<Artifact>> {
    let row = sqlx::query(
        "SELECT sha256,version_id FROM desired_artifacts WHERE device_id=? AND generation=?",
    )
    .bind(device)
    .bind(generation)
    .fetch_optional(&mut *db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.get::<String, _>("version_id") != version {
        return Err(ApiError::invalid("Desired generation and version disagree"));
    }
    Ok(Some(blob(db, row.get::<&str, _>("sha256")).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn typed_render_preserves_structure_and_distinct_digest() {
        let config = json!({"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"max_events":500}}}});
        let vars =
            json!([{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}]);
        declarations(&config, &vars).unwrap();
        let template = validation::render(&config).unwrap();
        let version = json!({"config":config,"variables":vars,"artifact":template,"sha256":db::hash(&template)});
        let devices = BTreeSet::from([
            "11111111-1111-4111-8111-111111111111".to_owned(),
            "22222222-2222-4222-8222-222222222222".to_owned(),
        ]);
        let bindings = json!({"defaults":{"max_events":600},"devices":{"22222222-2222-4222-8222-222222222222":{"max_events":700}}});
        validate_bindings(&version, &bindings, &devices, true).unwrap();
        let a = render(&version, &bindings, "11111111-1111-4111-8111-111111111111").unwrap();
        let b = render(&version, &bindings, "22222222-2222-4222-8222-222222222222").unwrap();
        assert_ne!(a.sha256, b.sha256);
        assert_eq!(
            serde_json::from_str::<Value>(&a.bytes).unwrap()["sinks"]["out"]["buffer"]["max_events"],
            600
        );
        assert_eq!(
            serde_json::from_str::<Value>(&b.bytes).unwrap()["sinks"]["out"]["type"],
            "blackhole"
        );
    }
    #[test]
    fn rejects_structural_and_secret_paths_and_values() {
        let config = json!({"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"auth":{"token":"none"}}}});
        for path in [
            "/sources/in/type",
            "/sinks/out/inputs/0",
            "/sinks/out/auth/token",
            "/sinks/out/missing",
        ] {
            assert!(
                declarations(&config, &json!([{"name":"x","path":path,"type":"string"}])).is_err(),
                "{path}"
            );
        }
        let vars = json!([{"name":"format","path":"/sources/in/format","type":"string"}]);
        let template = validation::render(&config).unwrap();
        let version = json!({"config":config,"variables":vars,"artifact":template,"sha256":db::hash(&template)});
        let device = "11111111-1111-4111-8111-111111111111";
        let ids = BTreeSet::from([device.to_owned()]);
        assert!(
            validate_bindings(
                &version,
                &json!({"defaults":{"format":"${PASSWORD}"},"devices":{}}),
                &ids,
                true
            )
            .is_err()
        );
        assert!(
            validate_bindings(
                &version,
                &json!({"defaults":{"format":42},"devices":{}}),
                &ids,
                true
            )
            .is_err()
        );
    }
}
