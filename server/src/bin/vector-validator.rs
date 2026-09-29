//! This process is intended ONLY for the isolated validation container, never the API process.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;
use vectory_server::validation;

struct Worker {
    vector: std::path::PathBuf,
    slots: tokio::sync::Semaphore,
}
async fn synthetic_vrl(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let _permit = worker
        .slots
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let program = input["program"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .ok_or(StatusCode::BAD_REQUEST)?;
    if !input["sample"].is_object() || input["sample"].to_string().len() > 65536 {
        return Err(StatusCode::BAD_REQUEST);
    }
    if program.contains("get_env_var") {
        return Ok(Json(
            json!({"valid":false,"output":null,"errors":["Environment access is disabled for synthetic samples"]}),
        ));
    }
    let dir = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let program_file = dir.path().join("program.vrl");
    let input_file = dir.path().join("sample.json");
    tokio::fs::write(&program_file, program)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::fs::write(&input_file, format!("{}\n", input["sample"]))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut command = tokio::process::Command::new(&worker.vector);
    command
        .arg("vrl")
        .arg("--program")
        .arg(&program_file)
        .arg("--input")
        .arg(&input_file)
        .arg("--print-object")
        .current_dir(dir.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    if let Ok(root) = std::env::var("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command
        .spawn()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let mut stdout = child.stdout.take().unwrap().take(32769);
    let mut stderr = child.stderr.take().unwrap().take(32769);
    let output = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read = async {
            tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
            Ok::<_, std::io::Error>((out, err))
        };
        let (status, (out, err)) = tokio::try_join!(child.wait(), read)?;
        Ok::<_, std::io::Error>(
            if status.success() && out.len() <= 32768 && err.len() <= 32768 {
                serde_json::from_slice::<Value>(&out).ok()
            } else {
                None
            },
        )
    };
    let parsed = match tokio::time::timeout(Duration::from_secs(5), output).await {
        Ok(Ok(Some(v))) => Some(v),
        _ => None,
    };
    if parsed.is_none() {
        let _ = child.kill().await;
    }
    Ok(Json(match parsed {
        Some(output) => json!({"valid":true,"output":output,"errors":[]}),
        None => {
            json!({"valid":false,"output":null,"errors":["VRL compilation/execution failed or exceeded the five-second/32-KiB limits. Review the program and synthetic sample."]})
        }
    }))
}
async fn validate(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    run_configuration(worker, input, false).await
}
async fn pipeline_tests(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    run_configuration(worker, input, true).await
}
async fn run_configuration(
    worker: Arc<Worker>,
    input: Value,
    tests: bool,
) -> Result<Json<Value>, StatusCode> {
    let _permit = worker
        .slots
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let mut result = validation::validate(&input["config"]);
    if tests {
        result["tests_run"] = json!(false);
    }
    if result["valid"] != true {
        return Ok(Json(result));
    }
    let static_paths = !tests && validation::can_static_check_file_sink_paths(&input["config"]);
    if !static_paths && validation::mark_device_deferred(&mut result, &input["config"]) {
        result["deferred"] = json!(true);
        if tests {
            result["valid"] = json!(false);
            result["errors"] = json!(["Run these tests on the device with its local resources."]);
        }
        return Ok(Json(result));
    }
    if tests
        && input["config"]["tests"]
            .as_array()
            .is_none_or(|tests| tests.is_empty())
    {
        result["valid"] = json!(false);
        result["errors"] = json!(["Add at least one Vector pipeline test before running tests."]);
        return Ok(Json(result));
    }
    let dir = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let path = dir.path().join("config.json");
    tokio::fs::write(
        &path,
        validation::render(&input["config"]).map_err(|_| StatusCode::BAD_REQUEST)?,
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut command = tokio::process::Command::new(&worker.vector);
    command
        .args(if tests {
            ["test", "--config-json"]
        } else {
            ["validate", "--no-environment"]
        })
        .arg(&path)
        .current_dir(dir.path())
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Windows development checks require SystemRoot; actual isolation remains a container gate.
    #[cfg(windows)]
    if let Ok(root) = std::env::var("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command
        .spawn()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = async {
        let read = async {
            let mut bytes = Vec::new();
            let mut err = Vec::new();
            let mut out_reader = stdout.take(32769);
            let mut err_reader = stderr.take(32769);
            tokio::try_join!(
                out_reader.read_to_end(&mut bytes),
                err_reader.read_to_end(&mut err)
            )?;
            Ok::<_, std::io::Error>((bytes, err))
        };
        let (status, (stdout, stderr)) = tokio::try_join!(child.wait(), read)?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    let mut native_issue = Value::Null;
    let completed = match tokio::time::timeout(Duration::from_secs(5), output).await {
        Ok(Ok((status, stdout, stderr))) if stdout.len() <= 32768 && stderr.len() <= 32768 => {
            Some((status, stdout, stderr))
        }
        Ok(Ok(_)) => {
            native_issue = json!({"code":"VALIDATION_OUTPUT_LIMIT"});
            None
        }
        Err(_) => {
            native_issue = json!({"code":"VALIDATION_TIMEOUT"});
            None
        }
        _ => None,
    };
    let accepted = completed
        .as_ref()
        .is_some_and(|(status, _, _)| status.success());
    // Vector documents 78 for a rejected configuration. Other exits, output
    // overflow, and timeout are worker failures, not completed static checks.
    let static_checked = completed
        .as_ref()
        .is_some_and(|(status, _, _)| status.success() || status.code() == Some(78));
    if completed.is_none() {
        let _ = child.kill().await;
    }
    let tests_started = completed.as_ref().is_some_and(|(status, stdout, stderr)| {
        status.success()
            || [stdout.as_slice(), stderr.as_slice()]
                .into_iter()
                .any(|bytes| {
                    std::str::from_utf8(bytes)
                        .is_ok_and(|part| part.lines().any(|line| line.trim() == "Running tests"))
                })
    });
    if !accepted
        && native_issue.is_null()
        && let Some((status, stdout, stderr)) = &completed
        && status.code() == Some(78)
    {
        native_issue = validation::classify_native_issue(&input["config"], stdout, stderr, tests);
    }
    result["valid"] = json!(accepted);
    result["vector_validated"] = json!(accepted && !tests);
    if tests {
        result["tests_run"] = json!(tests_started);
        result["output"] = json!(if accepted {
            "Vector pipeline tests passed."
        } else {
            "Vector pipeline tests failed or exceeded execution limits."
        });
    }
    result["warnings"] = json!([if tests {
        "Pipeline tests ran with a scrubbed environment in the isolated worker. Device environment validation is still required."
    } else {
        "Vector environment checks were disabled in the isolated worker; device environment validation is required."
    }]);
    if !accepted && !native_issue.is_null() {
        result["native_issue"] = native_issue.clone();
    }
    result["errors"] = if accepted {
        json!([])
    } else if let Some(message) = validation::public_native_issue(&input["config"], &native_issue) {
        json!([message])
    } else {
        json!([
            "Vector rejected the configuration or could not finish validation. Review the configuration and run local Vector for detailed diagnostics."
        ])
    };
    if static_paths {
        validation::mark_device_deferred(&mut result, &input["config"]);
        result["static_checked"] = json!(static_checked);
        result["vector_validated"] = json!(false);
        result["warnings"] = json!([if static_checked {
            "Isolated Vector static checks completed with environment checks disabled. Device-local paths and environment remain unverified until device validation."
        } else {
            "Isolated Vector static checks did not complete. Device-local paths and environment remain unverified."
        }]);
    }
    Ok(Json(result))
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    if std::env::var("VECTORY_VALIDATOR_ISOLATED").as_deref() != Ok("true") {
        anyhow::bail!(
            "Validator must run in a separately isolated worker with no production mounts/secrets and restricted network/resources; set VECTORY_VALIDATOR_ISOLATED=true only in that runtime"
        )
    }
    let vector = std::path::PathBuf::from(
        std::env::var("VECTORY_VECTOR_BINARY").unwrap_or_else(|_| "/usr/local/bin/vector".into()),
    );
    if !vector.is_absolute() {
        anyhow::bail!("Validator Vector path must be absolute")
    }
    let output = tokio::process::Command::new(&vector)
        .arg("--version")
        .env_clear()
        .output()
        .await?;
    if !output.status.success()
        || !String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .any(|w| w == validation::VECTOR_VERSION)
    {
        anyhow::bail!("Validator requires the pinned Vector version")
    }
    let worker = Arc::new(Worker {
        vector,
        slots: tokio::sync::Semaphore::new(2),
    });
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"status":"ok","vector_version":validation::VECTOR_VERSION}))
            }),
        )
        .route("/validate", post(validate))
        .route("/tests", post(pipeline_tests))
        .route("/vrl-test", post(synthetic_vrl))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(worker);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("VECTORY_VALIDATOR_ADDR").unwrap_or_else(|_| "0.0.0.0:8081".into()),
    )
    .await?;
    axum::serve(listener, app).await?;
    Ok(())
}
