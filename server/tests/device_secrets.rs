//! Device secrets at every credential field: the server's table, publish-time
//! checks through the API, and the isolated Vector check with placeholders.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tower::ServiceExt;
use vectory_server::validation::{DEVICE_SECRET_FIX, secret_fields};
use vectory_server::{Settings, State, api, auth, db, initialize};

#[test]
fn the_server_table_matches_the_dashboard_and_agent_copies() {
    let copy: Value = serde_json::from_str(include_str!(
        "../../dashboard/src/generated/secret-fields.json"
    ))
    .unwrap();
    let from_json: BTreeSet<String> = copy["fields"]
        .as_object()
        .unwrap()
        .iter()
        .flat_map(|(section, types)| {
            types
                .as_object()
                .unwrap()
                .iter()
                .flat_map(move |(kind, paths)| {
                    paths
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(move |path| format!("{section}/{kind}/{}", path.as_str().unwrap()))
                })
        })
        .collect();
    let from_rust: BTreeSet<String> = secret_fields::SECRET_FIELDS
        .iter()
        .map(|(section, kind, path)| format!("{section}/{kind}/{path}"))
        .collect();
    assert_eq!(
        from_rust.len(),
        secret_fields::SECRET_FIELDS.len(),
        "duplicates"
    );
    assert_eq!(
        from_json, from_rust,
        "run node scripts/generate-secret-fields.mjs"
    );
    assert_eq!(copy["field_count"], from_rust.len());
    assert_eq!(copy["schema_sha256"], secret_fields::SCHEMA_SHA256);
    assert_eq!(
        secret_fields::VECTOR_VERSION,
        vectory_server::validation::VECTOR_VERSION
    );
    let go = include_str!("../../agent/internal/agent/secret_fields_generated.go");
    for (section, kind, path) in secret_fields::SECRET_FIELDS {
        assert!(
            go.contains(&format!("{{{section:?}, {kind:?}, {path:?}}},")),
            "{kind} {path}"
        );
    }
    // The credentials this work is about, by name.
    for expected in [
        "sinks/datadog_logs/default_api_key",
        "sinks/splunk_hec_logs/default_token",
        "sinks/kafka/sasl.password",
        "sinks/aws_s3/auth.secret_access_key",
        "sinks/prometheus_remote_write/auth.password",
        "sinks/redis/sentinel_connect.connections.password",
        "sinks/nats/auth.user_password.password",
        "sinks/mqtt/password",
        "sinks/http/tls.key_pass",
        "sources/splunk_hec/valid_tokens[]",
        "sinks/http/auth.user",
        "sinks/loki/auth.token",
        "sinks/elasticsearch/auth.password",
    ] {
        assert!(from_rust.contains(expected), "{expected}");
    }
    // Nothing that routes data: destinations, headers, paths and programs.
    for path in from_rust {
        let field = path.rsplit('/').next().unwrap();
        for forbidden in [
            "uri", "endpoint", "headers", "path", "command", "source", "address",
        ] {
            assert!(
                !field.split(['.', '[']).any(|segment| segment == forbidden),
                "{path}"
            );
        }
    }
}

struct Identity {
    cookie: String,
    csrf: String,
}

async fn fixture(validation_url: Option<String>) -> (tempfile::TempDir, State, Router, Identity) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-device-secret-test-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Device secret tests".into(),
        validation_url,
        ..Default::default()
    })
    .await
    .unwrap();
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind("Test editor")
    .bind("admin")
    .bind("unused-test-login")
    .bind(db::now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&state.pool)
        .await
        .unwrap();
    let app = api::router(state.clone());
    (
        temp,
        state,
        app,
        Identity {
            cookie: format!("vectory_session={token}"),
            csrf,
        },
    )
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    value: Value,
    actor: &Identity,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", &actor.cookie)
        .header("x-csrf-token", &actor.csrf)
        .body(Body::from(value.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn pipeline(credential: &str) -> Value {
    json!({
        "sources":{"in":{"type":"demo_logs","format":"json"}},
        "sinks":{"dd":{"type":"datadog_logs","inputs":["in"],"default_api_key":credential}}
    })
}

#[tokio::test]
async fn plain_text_credentials_never_reach_history_and_references_publish() {
    let (_temp, _state, app, actor) = fixture(None).await;
    let (status, created) = call(
        &app,
        "POST",
        "/api/v1/configurations",
        json!({"name":"Datadog logs","description":"","config":pipeline("vectory-secret:DD_API_KEY"),"graph":{"nodes":[],"edges":[]}}),
        &actor,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    // The check names the field and the fix, never the value.
    let (status, check) = call(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/validate"),
        json!({"config":pipeline("dd-plaintext-api-key")}),
        &actor,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["valid"], false);
    assert_eq!(
        check["errors"],
        json!([format!(
            "sinks.dd: Plaintext credentials cannot be stored in `default_api_key`. {DEVICE_SECRET_FIX}"
        )])
    );
    assert!(!check.to_string().contains("dd-plaintext-api-key"));
    // A draft holding plain text is refused, so no revision stores it.
    let (status, refused) = call(
        &app,
        "PUT",
        &format!("/api/v1/configurations/{id}/draft"),
        json!({"revision":created["revision"],"config":pipeline("dd-plaintext-api-key"),"graph":created["graph"],"name":"Datadog logs","description":""}),
        &actor,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert!(!refused.to_string().contains("dd-plaintext-api-key"));
    // The reference publishes, and the version says it needs device secrets.
    let (status, version) = call(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/publish"),
        json!({"revision":created["revision"],"message":"Datadog key from each device"}),
        &actor,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(version["uses_local_secrets"], true);
    assert_eq!(
        version["config"]["sinks"]["dd"]["default_api_key"],
        "vectory-secret:DD_API_KEY"
    );
    assert!(
        version["validation"]["warnings"]
            .to_string()
            .contains("Each device checks secrets before applying this version."),
        "{version}"
    );
    // A reference in a destination is refused at publish.
    let mut exfiltration = pipeline("vectory-secret:DD_API_KEY");
    exfiltration["sinks"]["web"] = json!({"type":"http","inputs":["in"],"uri":"vectory-secret:DD_API_KEY","encoding":{"codec":"json"}});
    let (status, check) = call(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/validate"),
        json!({"config":exfiltration}),
        &actor,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        check["errors"],
        json!(["sinks.web: Only credential fields can hold a device secret, and `uri` isn't one."])
    );
}

async fn start_worker(vector: &str) -> (tokio::process::Child, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let child = tokio::process::Command::new(env!("CARGO_BIN_EXE_vector-validator"))
        .env("VECTORY_VALIDATOR_ISOLATED", "true")
        .env("VECTORY_VECTOR_BINARY", vector)
        .env("VECTORY_VALIDATOR_ADDR", addr.to_string())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let url = format!("http://{addr}");
    let client = reqwest::Client::new();
    for _ in 0..100 {
        if client.get(format!("{url}/health")).send().await.is_ok() {
            return (child, url);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("worker did not start");
}

/// Vector checks a pipeline whose credentials are device secrets: each
/// reference becomes a placeholder, so options, VRL and topology are still
/// checked, and the result says each device resolves the secrets.
#[tokio::test]
async fn pinned_vector_checks_pipelines_with_device_secrets() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; device secret placeholders unverified");
        return;
    };
    let (mut child, url) = start_worker(&vector).await;
    let (_temp, state, _app, _actor) = fixture(Some(url)).await;
    let config = json!({
        "sources":{"metrics":{"type":"internal_metrics"},"logs":{"type":"demo_logs","format":"json"}},
        "sinks":{
            "dd":{"type":"datadog_logs","inputs":["logs"],"default_api_key":"vectory-secret:DD_API_KEY"},
            "queue":{"type":"kafka","inputs":["logs"],"bootstrap_servers":"kafka.example:9092","topic":"logs","encoding":{"codec":"json"},
                "sasl":{"enabled":true,"mechanism":"PLAIN","username":"svc","password":"vectory-secret:KAFKA_PASSWORD"}},
            "rw":{"type":"prometheus_remote_write","inputs":["metrics"],"endpoint":"https://rw.example/api/v1/write",
                "auth":{"strategy":"basic","user":"vectory-secret:RW_USER","password":"vectory-secret:RW_PASSWORD"}},
            "hec":{"type":"splunk_hec_logs","inputs":["logs"],"endpoint":"https://hec.example:8088","default_token":"vectory-secret:HEC_TOKEN","encoding":{"codec":"json"}}
        }
    });
    let result = vectory_server::validation::validate_isolated(&state, &config)
        .await
        .unwrap();
    assert_eq!(result["valid"], true, "{result}");
    assert_eq!(result["static_checked"], true, "{result}");
    assert_eq!(result["deferred"], true);
    assert_eq!(result["vector_validated"], false);
    assert_eq!(result["deferred_reasons"], json!(["device secrets"]));
    assert_eq!(
        result["placeholders"],
        json!([
            "vectory-secret:DD_API_KEY",
            "vectory-secret:HEC_TOKEN",
            "vectory-secret:KAFKA_PASSWORD",
            "vectory-secret:RW_PASSWORD",
            "vectory-secret:RW_USER"
        ])
    );
    // Placeholders keep the real checks running: an option error is still found.
    let mut broken = config.clone();
    broken["sinks"]["queue"]["topik"] = json!("logs");
    let rejected = vectory_server::validation::validate_isolated(&state, &broken)
        .await
        .unwrap();
    assert_eq!(rejected["valid"], false, "{rejected}");
    assert!(
        rejected["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["component"] == "queue" && d["severity"] == "error"),
        "{rejected}"
    );
    child.kill().await.unwrap();
}
