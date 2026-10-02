//! This process is intended ONLY for the isolated validation container, never the API process.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use vectory_server::{
    validation::{self, WORKER_PROTOCOL},
    vector_diagnostics::{self as diagnostics, Diagnostic},
};

struct Worker {
    vector: std::path::PathBuf,
    slots: tokio::sync::Semaphore,
    /// `(section, type)` pairs this Vector build includes, from `vector list`.
    available: Option<BTreeSet<(String, String)>>,
}

impl Worker {
    fn has(&self, section: &str, kind: &str) -> bool {
        self.available
            .as_ref()
            .is_none_or(|set| set.contains(&(section.to_owned(), kind.to_owned())))
    }
}

enum Run {
    Completed {
        code: Option<i32>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    Timeout,
    OutputLimit,
}

/// What the worker learns while Vector runs: when its output last moved,
/// whether the settle marker was printed, and whether the process has ended.
struct Activity {
    began: Instant,
    last_output_ms: AtomicU64,
    marker_seen: AtomicBool,
    exited: AtomicBool,
}

impl Activity {
    fn new() -> Self {
        Activity {
            began: Instant::now(),
            last_output_ms: AtomicU64::new(0),
            marker_seen: AtomicBool::new(false),
            exited: AtomicBool::new(false),
        }
    }
    fn now_ms(&self) -> u64 {
        self.began.elapsed().as_millis() as u64
    }
    fn quiet_ms(&self) -> u64 {
        self.now_ms()
            .saturating_sub(self.last_output_ms.load(Ordering::SeqCst))
    }
}

/// How long Vector's output must stay silent after the marker before stdin is
/// closed: the last sample's outputs are then all printed.
const SETTLE_QUIET_MS: u64 = 100;

/// Whether `buffer` holds `line` as a whole line (terminated by a newline).
fn has_line(buffer: &[u8], line: &[u8]) -> bool {
    buffer
        .split(|byte| *byte == b'\n')
        .rev()
        .skip(1)
        .any(|candidate| candidate == line)
}

/// Run pinned Vector with an argument array (never a shell), a scrubbed
/// environment, a private working directory and bounded time and output.
/// The config file path is appended as the final argument.
///
/// Vector drops the events still in flight when its stdin ends, so a run that
/// feeds stdin passes `settle`: the line Vector prints once the last input has
/// entered the pipeline. Stdin then stays open until that line has been seen
/// and the output has been quiet for a moment, or the process has ended.
async fn run_vector(
    worker: &Worker,
    args: &[&str],
    config: &Value,
    dir: &Path,
    stdin: Option<Vec<u8>>,
    settle: Option<Vec<u8>>,
    time: Duration,
    output: usize,
) -> Result<Run, StatusCode> {
    let path = dir.join("config.json");
    tokio::fs::write(
        &path,
        validation::render(config).map_err(|_| StatusCode::BAD_REQUEST)?,
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut command = tokio::process::Command::new(&worker.vector);
    command
        .args(args)
        .arg(&path)
        .current_dir(dir)
        .env_clear()
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
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
    let input = child.stdin.take();
    let mut out_reader = child.stdout.take().unwrap().take(output as u64 + 1);
    let mut err_reader = child.stderr.take().unwrap().take(output as u64 + 1);
    let activity = Activity::new();
    let run = async {
        let feed = async {
            if let (Some(mut pipe), Some(bytes)) = (input, stdin) {
                // A program may exit before reading; a closed pipe is not an error.
                let _ = pipe.write_all(&bytes).await;
                if settle.is_some() {
                    while !activity.exited.load(Ordering::SeqCst)
                        && !(activity.marker_seen.load(Ordering::SeqCst)
                            && activity.quiet_ms() >= SETTLE_QUIET_MS)
                    {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
                let _ = pipe.shutdown().await;
            }
            Ok::<_, std::io::Error>(())
        };
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let read_out = async {
            let mut chunk = [0u8; 8192];
            loop {
                let count = out_reader.read(&mut chunk).await?;
                if count == 0 {
                    break;
                }
                stdout.extend_from_slice(&chunk[..count]);
                activity
                    .last_output_ms
                    .store(activity.now_ms(), Ordering::SeqCst);
                if let Some(marker) = &settle
                    && has_line(&stdout, marker)
                {
                    activity.marker_seen.store(true, Ordering::SeqCst);
                }
            }
            Ok::<_, std::io::Error>(())
        };
        let read_err = async {
            err_reader.read_to_end(&mut stderr).await?;
            Ok::<_, std::io::Error>(())
        };
        let wait = async {
            let status = child.wait().await?;
            activity.exited.store(true, Ordering::SeqCst);
            Ok::<_, std::io::Error>(status)
        };
        let (status, _, _, _) = tokio::try_join!(wait, feed, read_out, read_err)?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    let outcome = tokio::time::timeout(time, run).await;
    let (status, mut stdout, mut stderr) = match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => return Err(StatusCode::SERVICE_UNAVAILABLE),
        Err(_) => {
            let _ = child.kill().await;
            return Ok(Run::Timeout);
        }
    };
    if stdout.len() > output || stderr.len() > output {
        return Ok(Run::OutputLimit);
    }
    // The worker's private directory is not part of the caller's draft.
    let private = dir.to_string_lossy().to_string();
    for bytes in [&mut stdout, &mut stderr] {
        let text = String::from_utf8_lossy(bytes).replace(&private, "");
        *bytes = text.into_bytes();
    }
    Ok(Run::Completed {
        code: status.code(),
        stdout,
        stderr,
    })
}

fn limit_diagnostic(run: &Run) -> Option<Diagnostic> {
    match run {
        Run::Timeout => Some(Diagnostic {
            code: Some("timeout".into()),
            ..Diagnostic::error("Vector did not finish within the isolated worker's time limit.")
        }),
        Run::OutputLimit => Some(Diagnostic {
            code: Some("output_limit".into()),
            ..Diagnostic::error("Vector's output exceeded the isolated worker's limit.")
        }),
        Run::Completed { .. } => None,
    }
}

fn protocol(mut value: Value) -> Json<Value> {
    value["worker_protocol"] = json!(WORKER_PROTOCOL);
    value["vector_version"] = json!(validation::VECTOR_VERSION);
    Json(value)
}

fn device_stub_notes(config: &Value, stubbed: &BTreeMap<String, String>) -> Vec<Diagnostic> {
    stubbed
        .iter()
        .map(|(id, reason)| Diagnostic {
            code: Some("device_check".into()),
            ..Diagnostic::warning(format!("This step {reason}.")).at(config, id)
        })
        .filter(|d| d.component.is_some())
        .collect()
}

/// `vector validate --no-environment` on a placeholder candidate, repeated
/// with stand-ins so one run's first option error doesn't hide the rest.
async fn validate(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let _permit = worker
        .slots
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let config = &input["config"];
    if !config.is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let candidate = validation::static_candidate(config, |section, kind| worker.has(section, kind));
    let device_stubs: Vec<String> = candidate.stubbed.keys().cloned().collect();
    if !candidate.checkable {
        return Ok(protocol(json!({
            "valid": true, "static_checked": false, "diagnostics": [],
            "placeholders": candidate.placeholders, "stubbed": device_stubs,
        })));
    }
    let dir = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let deadline = Instant::now() + Duration::from_millis(4800);
    let mut current = candidate.config;
    let mut stubbed = candidate.stubbed.clone();
    let mut found = device_stub_notes(config, &candidate.stubbed);
    let mut ran = false;
    for _ in 0..8 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_millis(250) {
            break;
        }
        let run = run_vector(
            &worker,
            &["validate", "--no-environment"],
            &current,
            dir.path(),
            None,
            None,
            remaining,
            64 * 1024,
        )
        .await?;
        if let Some(diagnostic) = limit_diagnostic(&run) {
            found.push(diagnostic);
            break;
        }
        let Run::Completed {
            code,
            stdout,
            stderr,
        } = run
        else {
            break;
        };
        // Vector documents 78 for a rejected configuration; other exits are worker failures.
        if code != Some(0) && code != Some(78) {
            found.push(Diagnostic::error(
                "Vector exited unexpectedly while checking this pipeline.",
            ));
            break;
        }
        ran = true;
        let parsed = diagnostics::parse_validate(config, &stdout, &stderr);
        let raw_errors: Vec<Diagnostic> = parsed
            .iter()
            .filter(|d| d.severity == "error")
            .cloned()
            .collect();
        found.extend(
            parsed
                .into_iter()
                .filter(|d| !validation::about_stand_in(d, &stubbed))
                .filter(|d| {
                    d.code.as_deref() != Some("no_consumers")
                        || !d.component.as_deref().is_some_and(|id| {
                            validation::consumed(config, id, d.route_output.as_deref())
                        })
                })
                .map(validation::soften_placeholder),
        );
        if code == Some(0) {
            break;
        }
        if raw_errors.is_empty() {
            found.push(Diagnostic::error(
                "Vector rejected this pipeline without a specific message.",
            ));
            break;
        }
        // Transform compilation is the last static stage and lists every error.
        if raw_errors.iter().all(|e| {
            e.code
                .as_deref()
                .is_some_and(|c| c.starts_with('E') || c == "transform_build")
        }) {
            break;
        }
        if !validation::repair_candidate(&mut current, &raw_errors, &mut stubbed) {
            break;
        }
    }
    // Findings softened to device checks do not make the draft invalid.
    let errors = found.iter().any(|d| d.severity == "error");
    let mut unique = BTreeSet::new();
    found.retain(|d| unique.insert(d.to_json().to_string()));
    found.truncate(diagnostics::MAX_DIAGNOSTICS);
    Ok(protocol(json!({
        "valid": ran && !errors,
        "static_checked": ran,
        "diagnostics": found.iter().map(Diagnostic::to_json).collect::<Vec<_>>(),
        "placeholders": candidate.placeholders,
        "stubbed": device_stubs,
    })))
}

/// `vector test` with per-test results.
async fn pipeline_tests(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let _permit = worker
        .slots
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let config = &input["config"];
    if !config.is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let network = validation::unrunnable_vrl_calls(config);
    if !network.is_empty() && config["tests"].as_array().is_some_and(|t| !t.is_empty()) {
        return Ok(protocol(json!({
            "tests_run": false, "tests": [],
            "diagnostics": [validation::unrunnable_call_diagnostic(&network, "warning").to_json()],
            "placeholders": [],
        })));
    }
    // Vector builds a step's Lua to run a test, and Lua can run any program: the
    // tests of a draft with a Lua step run on devices, whoever asks the worker.
    if !validation::lua_transforms(config).is_empty()
        && config["tests"].as_array().is_some_and(|t| !t.is_empty())
    {
        return Ok(protocol(json!({
            "tests_run": false, "tests": [],
            "diagnostics": [validation::lua_tests_diagnostic().to_json()],
            "placeholders": [],
        })));
    }
    let candidate = validation::static_candidate(config, |section, kind| worker.has(section, kind));
    if !candidate.checkable || config["tests"].as_array().is_none_or(|t| t.is_empty()) {
        return Ok(protocol(json!({
            "tests_run": false, "tests": [], "diagnostics": [], "placeholders": candidate.placeholders,
        })));
    }
    let dir = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let run = run_vector(
        &worker,
        &["test", "--config-json"],
        &candidate.config,
        dir.path(),
        None,
        None,
        Duration::from_secs(5),
        128 * 1024,
    )
    .await?;
    if let Some(diagnostic) = limit_diagnostic(&run) {
        return Ok(protocol(json!({
            "tests_run": false, "tests": [], "diagnostics": [diagnostic.to_json()],
            "placeholders": candidate.placeholders,
        })));
    }
    let Run::Completed {
        code,
        stdout,
        stderr,
    } = run
    else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    let started = [stdout.as_slice(), stderr.as_slice()].iter().any(|bytes| {
        diagnostics::plain_text(bytes)
            .lines()
            .any(|line| line.trim() == "Running tests")
    });
    let mut tests = if started {
        diagnostics::parse_tests(&stdout, &stderr)
    } else {
        vec![]
    };
    let mut found: Vec<Value> = if started {
        vec![]
    } else {
        diagnostics::parse_validate(config, &stdout, &stderr)
            .into_iter()
            .filter(|d| !validation::about_stand_in(d, &candidate.stubbed))
            .map(validation::soften_placeholder)
            .map(|d| d.to_json())
            .collect()
    };
    // Vector exits with a failure for a failed test too. Without one, it stopped
    // before it could give a verdict, and the reason belongs in the result.
    if started && code != Some(0) && tests.iter().all(|test| test["passed"] == true) {
        let refusal = diagnostics::test_refusal(config, &stdout, &stderr);
        tests.extend(refusal.tests);
        found.extend(refusal.diagnostic.map(|d| d.to_json()));
    }
    Ok(protocol(json!({
        "tests_run": started && !tests.is_empty(),
        "tests": tests,
        "diagnostics": found,
        "placeholders": candidate.placeholders,
    })))
}

/// Replace native references in the step's own settings, like the static check.
fn substituted(transform: &Value, found: &mut BTreeSet<String>) -> Value {
    fn walk(value: &mut Value, key: &str, found: &mut BTreeSet<String>) {
        match value {
            Value::String(text) => {
                if let Some(next) = validation::substitute_references(text, key, found) {
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
    let mut copy = transform.clone();
    walk(&mut copy, "", found);
    copy
}

/// Run synthetic samples through one transform: stdin → step → console.
async fn transform_test(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let _permit = worker
        .slots
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let transform = &input["transform"];
    let samples = input["samples"].as_array().ok_or(StatusCode::BAD_REQUEST)?;
    if samples.is_empty()
        || samples.len() > validation::MAX_SAMPLES
        || samples.iter().any(|sample| !sample.is_object())
        || input["samples"].to_string().len() > validation::MAX_SAMPLE_BYTES
        || transform.to_string().len() > 65536
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let timezone = input["timezone"].as_str().filter(|zone| zone.len() <= 64);
    if let Err(message) = validation::testable_transform(transform) {
        return Ok(protocol(json!({
            "compiled": false, "results": [], "placeholders": [],
            "diagnostics": [Diagnostic::error(message).to_json()],
        })));
    }
    let network = validation::unrunnable_vrl_calls(transform);
    if !network.is_empty() {
        return Ok(protocol(json!({
            "compiled": false, "results": [], "placeholders": [],
            "diagnostics": [validation::unrunnable_call_diagnostic(&network, "error").to_json()],
        })));
    }
    let mut placeholders = BTreeSet::new();
    let step = substituted(transform, &mut placeholders);
    let dir = tempfile::tempdir().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = dir.path().join("data");
    tokio::fs::create_dir(&data)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let pipeline = validation::sample_pipeline(&step, &data.to_string_lossy(), timezone);
    let mut lines = Vec::new();
    for (index, sample) in samples.iter().enumerate() {
        lines.extend_from_slice(json!({"i":index,"e":sample}).to_string().as_bytes());
        lines.push(b'\n');
    }
    let run = run_vector(
        &worker,
        &["--quiet", "--config-json"],
        &pipeline,
        dir.path(),
        Some(lines),
        Some(validation::sample_done_marker(samples.len())),
        Duration::from_secs(5),
        512 * 1024,
    )
    .await?;
    let placeholders: Vec<String> = placeholders.into_iter().take(64).collect();
    if let Some(diagnostic) = limit_diagnostic(&run) {
        return Ok(protocol(json!({
            "compiled": true, "results": null, "placeholders": placeholders,
            "diagnostics": [diagnostic.to_json()],
        })));
    }
    let Run::Completed { code, stdout, .. } = run else {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    };
    if code == Some(0) {
        let results = validation::sample_results(&step, samples.len(), &stdout);
        return Ok(protocol(json!({
            "compiled": true, "results": results, "diagnostics": [], "placeholders": placeholders,
        })));
    }
    // A failed start logs one line per problem; `vector validate` on the same
    // micro-pipeline reports every compiler error with its route name.
    let check = run_vector(
        &worker,
        &["validate", "--no-environment"],
        &pipeline,
        dir.path(),
        None,
        None,
        Duration::from_secs(5),
        64 * 1024,
    )
    .await?;
    let mut found: Vec<Value> = match check {
        Run::Completed { stdout, stderr, .. } => {
            diagnostics::parse_validate(&pipeline, &stdout, &stderr)
                .into_iter()
                .filter(|d| d.component.as_deref() == Some("vectory_step") && d.severity == "error")
                .map(|mut d| {
                    // The caller knows which step it tested; its micro-pipeline IDs stay private.
                    d.component = None;
                    d.section = None;
                    d.field = diagnostics::vrl_field(
                        &json!({"transforms":{"step":transform}}),
                        "step",
                        d.route_output.as_deref(),
                    );
                    validation::soften_placeholder(d).to_json()
                })
                .collect()
        }
        other => limit_diagnostic(&other)
            .into_iter()
            .map(|d| d.to_json())
            .collect(),
    };
    if found.is_empty() {
        found.push(
            Diagnostic::error("Vector could not start this step with the synthetic samples.")
                .to_json(),
        );
    }
    found.truncate(diagnostics::MAX_DIAGNOSTICS);
    Ok(protocol(json!({
        "compiled": false, "results": [], "diagnostics": found, "placeholders": placeholders,
    })))
}

/// Original single-program endpoint, now backed by the same micro-pipeline so
/// timestamps and aborts are reported correctly.
async fn synthetic_vrl(
    State(worker): State<Arc<Worker>>,
    Json(input): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let program = input["program"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .ok_or(StatusCode::BAD_REQUEST)?;
    if !input["sample"].is_object() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let Json(reply) = transform_test(
        State(worker),
        Json(json!({"transform":{"type":"remap","source":program},"samples":[input["sample"]]})),
    )
    .await?;
    let result = &reply["results"][0];
    let output = result["outputs"][0]["event"].clone();
    let failed = reply["compiled"] != true
        || ["error", "aborted"].contains(&result["outcome"].as_str().unwrap_or(""));
    let diagnostic = reply["diagnostics"][0]["detail"]
        .as_str()
        .or(reply["diagnostics"][0]["message"].as_str())
        .or(result["message"].as_str())
        .map(str::to_owned);
    Ok(protocol(json!({
        "valid": !failed,
        "output": if failed { Value::Null } else { output },
        "errors": if failed { vec!["VRL compilation or synthetic execution failed. Review the program and sample."] } else { vec![] },
        "diagnostic": diagnostic,
    })))
}

async fn available_components(vector: &Path) -> Option<BTreeSet<(String, String)>> {
    let output = tokio::process::Command::new(vector)
        .args(["list", "--format", "json"])
        .env_clear()
        .output()
        .await
        .ok()?;
    let list: Value = serde_json::from_slice(&output.stdout).ok()?;
    let mut set = BTreeSet::new();
    for section in ["sources", "transforms", "sinks", "enrichment_tables"] {
        for kind in list[section].as_array()?.iter().filter_map(Value::as_str) {
            set.insert((section.to_owned(), kind.to_owned()));
        }
    }
    Some(set)
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
    let available = available_components(&vector).await;
    let worker = Arc::new(Worker {
        vector,
        slots: tokio::sync::Semaphore::new(2),
        available,
    });
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({"status":"ok","vector_version":validation::VECTOR_VERSION,"worker_protocol":WORKER_PROTOCOL}))
            }),
        )
        .route("/validate", post(validate))
        .route("/tests", post(pipeline_tests))
        .route("/vrl-test", post(synthetic_vrl))
        .route("/transform-test", post(transform_test))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .with_state(worker);
    let listener = tokio::net::TcpListener::bind(
        std::env::var("VECTORY_VALIDATOR_ADDR").unwrap_or_else(|_| "0.0.0.0:8081".into()),
    )
    .await?;
    axum::serve(listener, app).await?;
    Ok(())
}
