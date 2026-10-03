//! Functional test of the actual Vector executable. This does NOT establish container isolation.
use serde_json::json;
#[tokio::test]
async fn pinned_vector_confirms_known_option_failures() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; pinned option validation unverified");
        return;
    };
    let version = tokio::process::Command::new(&vector)
        .arg("--version")
        .output()
        .await
        .unwrap();
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains("0.58.0"));
    let temp = tempfile::tempdir().unwrap();
    let source = json!({"in":{"type":"demo_logs","format":"json"}});
    let cases = [
        (
            "sample_missing_strategy",
            json!({"data_dir":temp.path(),"sources":source,"transforms":{"pick":{"type":"sample","inputs":["in"]}},"sinks":{"out":{"type":"blackhole","inputs":["pick"]}}}),
            false,
        ),
        (
            "sample_with_rate",
            json!({"data_dir":temp.path(),"sources":source,"transforms":{"pick":{"type":"sample","inputs":["in"],"rate":10}},"sinks":{"out":{"type":"blackhole","inputs":["pick"]}}}),
            true,
        ),
        (
            "buffer_zero_events",
            json!({"data_dir":temp.path(),"sources":source,"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"type":"memory","max_events":0}}}}),
            false,
        ),
        (
            "buffer_default_memory_size",
            json!({"data_dir":temp.path(),"sources":source,"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"type":"memory"}}}}),
            true,
        ),
        (
            "buffer_two_memory_sizes",
            json!({"data_dir":temp.path(),"sources":source,"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"type":"memory","max_events":500,"max_size":1048576}}}}),
            false,
        ),
        (
            "buffer_too_small_disk",
            json!({"data_dir":temp.path(),"sources":source,"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"type":"disk","max_size":100}}}}),
            false,
        ),
    ];
    for (name, config, accepted) in cases {
        let path = temp.path().join(format!("{name}.json"));
        tokio::fs::write(&path, vectory_server::validation::render(&config).unwrap())
            .await
            .unwrap();
        let mut command = tokio::process::Command::new(&vector);
        command
            .arg("validate")
            .arg(&path)
            .current_dir(temp.path())
            .env_clear()
            .kill_on_drop(true);
        #[cfg(windows)]
        if let Ok(root) = std::env::var("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(8), command.output())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.status.success(), accepted, "{name}");
    }
}

/// The server's event-type table must agree with Vector wherever Vector can
/// see the types, and it must go on to catch the same mismatch behind a remap,
/// where Vector types every transform output as any event.
#[tokio::test]
async fn event_type_table_matches_the_pinned_vector() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; event type table unverified");
        return;
    };
    let temp = tempfile::tempdir().unwrap();
    let json_codec = json!({"codec":"json"});
    let logs = json!({"type":"demo_logs","format":"json"});
    let metrics = json!({"type":"internal_metrics"});
    let sinks = [
        json!({"type":"datadog_metrics","default_api_key":"x"}),
        json!({"type":"prometheus_exporter"}),
        json!({"type":"prometheus_remote_write","endpoint":"http://127.0.0.1:9/x"}),
        json!({"type":"statsd","mode":"udp","address":"127.0.0.1:8125"}),
        json!({"type":"influxdb_metrics","endpoint":"http://127.0.0.1:8086","database":"d"}),
        json!({"type":"aws_cloudwatch_metrics","default_namespace":"n","region":"us-east-1"}),
        json!({"type":"gcp_stackdriver_metrics","project_id":"p","resource":{"type":"global"}}),
        json!({"type":"loki","endpoint":"http://127.0.0.1:3100","encoding":json_codec,"labels":{"a":"b"}}),
        json!({"type":"datadog_logs","default_api_key":"x"}),
        json!({"type":"splunk_hec_logs","endpoint":"http://127.0.0.1:8088","default_token":"x","encoding":json_codec}),
        json!({"type":"aws_cloudwatch_logs","group_name":"g","stream_name":"s","region":"us-east-1","encoding":json_codec}),
        json!({"type":"gcp_stackdriver_logs","log_id":"l","project_id":"p","resource":{"type":"global"}}),
        json!({"type":"influxdb_logs","endpoint":"http://127.0.0.1:8086","measurement":"m","database":"d"}),
        json!({"type":"papertrail","endpoint":"tcp://127.0.0.1:514","encoding":json_codec}),
    ];
    let sources = [
        logs.clone(),
        json!({"type":"file","include":["/tmp/x.log"]}),
        json!({"type":"journald"}),
        json!({"type":"kubernetes_logs"}),
        json!({"type":"syslog","mode":"udp","address":"127.0.0.1:5514"}),
        json!({"type":"docker_logs"}),
        json!({"type":"internal_logs"}),
        metrics.clone(),
        json!({"type":"host_metrics"}),
        json!({"type":"prometheus_scrape","endpoints":["http://127.0.0.1:9/m"]}),
        json!({"type":"statsd","mode":"udp","address":"127.0.0.1:8126"}),
        json!({"type":"static_metrics","metrics":[]}),
        json!({"type":"apache_metrics","endpoints":["http://127.0.0.1/server-status"]}),
        json!({"type":"nginx_metrics","endpoints":["http://127.0.0.1/status"]}),
    ];
    let loki = sinks[7].clone();
    let prometheus = sinks[1].clone();
    let mut cases = Vec::new();
    for sink in &sinks {
        for source in [&logs, &metrics] {
            let mut case = json!({"sources":{"s":source},"sinks":{"k":sink}});
            case["sinks"]["k"]["inputs"] = json!(["s"]);
            cases.push(case);
        }
    }
    for source in &sources {
        for sink in [&loki, &prometheus] {
            let mut case = json!({"sources":{"s":source},"sinks":{"k":sink}});
            case["sinks"]["k"]["inputs"] = json!(["s"]);
            cases.push(case);
        }
    }
    for (transform, extra) in [
        ("log_to_metric", json!({"metrics":[]})),
        ("metric_to_log", json!({})),
        ("aggregate", json!({})),
    ] {
        for source in [&logs, &metrics] {
            let mut case = json!({"sources":{"s":source},"transforms":{"t":extra},"sinks":{"k":{"type":"blackhole","inputs":["t"]}}});
            case["transforms"]["t"]["type"] = json!(transform);
            case["transforms"]["t"]["inputs"] = json!(["s"]);
            cases.push(case);
        }
    }
    let mismatch = |config: &serde_json::Value| {
        vectory_server::validation::validate(config)["errors"]
            .to_string()
            .contains(" emits ")
    };
    let mut disagreements = Vec::new();
    for (n, mut config) in cases.into_iter().enumerate() {
        config["data_dir"] = json!(temp.path());
        let path = temp.path().join(format!("types-{n}.json"));
        tokio::fs::write(&path, config.to_string()).await.unwrap();
        let output = tokio::process::Command::new(&vector)
            .args(["validate", "--no-environment"])
            .arg(&path)
            .env_clear()
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).to_string()
            + &String::from_utf8_lossy(&output.stderr);
        let native = text.contains("Data type mismatch");
        assert!(
            native || output.status.success(),
            "fixture must load: {config}\n{text}"
        );
        if native != mismatch(&config) {
            disagreements.push(config);
        }
    }
    assert!(disagreements.is_empty(), "{disagreements:#?}");

    // Behind a remap Vector sees no mismatch; the server still does.
    let hidden = json!({"data_dir":temp.path(),"sources":{"s":logs},"transforms":{"p":{"type":"remap","inputs":["s"],"source":".x = 1"}},"sinks":{"k":{"type":"datadog_metrics","inputs":["p"],"default_api_key":"x"}}});
    let path = temp.path().join("hidden.json");
    tokio::fs::write(&path, hidden.to_string()).await.unwrap();
    let output = tokio::process::Command::new(&vector)
        .args(["validate", "--no-environment"])
        .arg(&path)
        .env_clear()
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert!(mismatch(&hidden));
}
#[tokio::test]
async fn outdated_worker_replies_are_refused() {
    use axum::{Json, Router, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let worker = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/validate",
                post(|| async {
                    Json(json!({"valid":true,"vector_validated":true,"static_checked":true,"vector_version":"0.58.0","errors":[],"warnings":[]}))
                }),
            ),
        )
        .await
        .unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let state = vectory_server::initialize(vectory_server::Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-legacy-validation-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Legacy worker test".into(),
        validation_url: Some(format!("http://{addr}")),
        ..Default::default()
    })
    .await
    .unwrap();
    let config = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"file","inputs":["sample"],"path":"/device/events.jsonl","encoding":{"codec":"json"}}}});
    let result = vectory_server::validation::validate_isolated(&state, &config)
        .await
        .unwrap();
    // A reply without the structured protocol is never a completed check.
    assert_eq!(result["valid"], false, "{result}");
    assert_eq!(result["static_checked"], false);
    assert_eq!(result["vector_validated"], false);
    assert!(
        result["errors"]
            .to_string()
            .contains("publication is blocked")
    );
    worker.abort();
}

async fn start_worker(vector: &str) -> (tokio::process::Child, String, reqwest::Client) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let mut worker = tokio::process::Command::new(env!("CARGO_BIN_EXE_vector-validator"));
    worker
        .env("VECTORY_VALIDATOR_ISOLATED", "true")
        .env("VECTORY_VECTOR_BINARY", vector)
        .env("VECTORY_VALIDATOR_ADDR", addr.to_string())
        .kill_on_drop(true);
    let child = worker.spawn().unwrap();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let url = format!("http://{addr}");
    for _ in 0..100 {
        if client.get(format!("{url}/health")).send().await.is_ok() {
            return (child, url, client);
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("worker did not start");
}

async fn post(
    client: &reqwest::Client,
    url: &str,
    path: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    client
        .post(format!("{url}/{path}"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn diagnostic<'a>(result: &'a serde_json::Value, component: &str) -> &'a serde_json::Value {
    result["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["component"] == component && d["severity"] == "error")
        .unwrap_or_else(|| panic!("no error for {component}: {result}"))
}

async fn public_state(url: &str) -> (tempfile::TempDir, vectory_server::State) {
    let isolated_state = tempfile::tempdir().unwrap();
    let state = vectory_server::initialize(vectory_server::Settings {
        data_dir: isolated_state.path().join("state"),
        bootstrap_secret: "isolated-native-validation-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: isolated_state.path().join("dist"),
        releases_dir: isolated_state.path().join("releases"),
        instance_name: "Native validation test".into(),
        validation_url: Some(url.to_owned()),
        ..Default::default()
    })
    .await
    .unwrap();
    (isolated_state, state)
}

#[tokio::test]
async fn real_vector_worker_reports_precise_diagnostics() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; native validator execution unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    let config = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"console":{"type":"console","inputs":["sample"],"encoding":{"codec":"json"}}}});
    let accepted = post(&client, &url, "validate", json!({"config":config})).await;
    assert_eq!(accepted["valid"], true, "{accepted}");
    assert_eq!(accepted["static_checked"], true);
    assert_eq!(accepted["worker_protocol"], 2);
    let (_state_dir, state) = public_state(&url).await;
    let public = vectory_server::validation::validate_isolated(&state, &config)
        .await
        .unwrap();
    assert_eq!(public["valid"], true, "{public}");
    assert_eq!(public["vector_validated"], true);
    assert_eq!(public["deferred"], false);
    assert_eq!(public["warnings"], json!([]));

    // Every VRL error is reported with its location, route output and Vector's fix.
    let nginx = json!({
        "data_dir":"/var/lib/vector",
        "sources":{"file":{"type":"file","include":["/var/log/nginx/access.log"]}},
        "transforms":{
            "parse":{"type":"remap","inputs":["file"],"source":". = parse_nginx_log(.message, \"combined\")"},
            "by_status":{"type":"route","inputs":["parse"],"route":{"server_errors":".status >= 500","client_errors":".status >= 400 && .status < 500"}}
        },
        "sinks":{
            "loki":{"type":"loki","inputs":["by_status.server_errors"],"endpoint":"http://127.0.0.1:3100","encoding":{"codec":"json"},"labels":{"source":"vector"}},
            "archive":{"type":"aws_s3","inputs":["by_status.client_errors"],"bucket":"logs","region":"us-east-1","encoding":{"codec":"json"},"compression":"gzip"}
        }
    });
    let rejected = vectory_server::validation::validate_isolated(&state, &nginx)
        .await
        .unwrap();
    assert_eq!(rejected["valid"], false, "{rejected}");
    assert_eq!(rejected["static_checked"], true);
    let parse = diagnostic(&rejected, "parse");
    assert_eq!(parse["code"], "E103");
    assert_eq!(
        (parse["line"].clone(), parse["column"].clone()),
        (json!(1), json!(5))
    );
    assert_eq!(parse["field"], "source");
    assert_eq!(
        parse["fix"]["replacement"],
        "parse_nginx_log!(.message, \"combined\")"
    );
    let conditions: Vec<&serde_json::Value> = rejected["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["component"] == "by_status" && d["severity"] == "error")
        .collect();
    assert_eq!(conditions.len(), 3, "{rejected}");
    assert!(
        conditions
            .iter()
            .any(|d| d["route_output"] == "server_errors"
                && d["fix"]["replacement"] == "((.status >= 500) ?? false)")
    );
    assert!(conditions.iter().all(|d| d["code"] == "E100"));
    let mut fixed = nginx.clone();
    fixed["transforms"]["parse"]["source"] = json!(". = parse_nginx_log!(.message, \"combined\")");
    fixed["transforms"]["by_status"]["route"] = json!({"server_errors":"(.status >= 500) ?? false","client_errors":"(.status >= 400 && .status < 500) ?? false"});
    let accepted = vectory_server::validation::validate_isolated(&state, &fixed)
        .await
        .unwrap();
    assert_eq!(accepted["valid"], true, "{accepted}");
    assert_eq!(
        accepted["deferred"], true,
        "device paths stay device checks"
    );
    assert_eq!(accepted["vector_validated"], false);
    assert!(
        accepted["diagnostics"]
            .to_string()
            .contains("Events that match no route are dropped")
    );

    // Option errors surface together, not one per check.
    let broken = json!({
        "bogus_top_level": true,
        "sources":{"input":{"type":"file"},"typo":{"type":"demo_logz"}},
        "transforms":{"tag":{"type":"remap","inputs":["input","typo"],"source":".x = 1","drop_on_eror":true}},
        "sinks":{"out":{"type":"blackhole","inputs":["tag"]}}
    });
    let all = post(&client, &url, "validate", json!({"config":broken})).await;
    assert_eq!(all["valid"], false, "{all}");
    for (component, code) in [
        ("input", "missing_field"),
        ("typo", "unknown_variant"),
        ("tag", "unknown_field"),
    ] {
        assert_eq!(diagnostic(&all, component)["code"], code, "{all}");
    }
    assert!(all["diagnostics"].to_string().contains("bogus_top_level"));
    assert_eq!(
        diagnostic(&all, "tag")["hint"],
        "Did you mean `drop_on_error`?"
    );

    // Secrets and environment references no longer skip Vector: placeholders
    // keep static checks running, so a logs→metrics mismatch is still caught.
    let secrets = json!({
        "secret":{"vault":{"type":"exec","command":["SHOULD_NEVER_EXECUTE"]}},
        "sources":{"otel":{"type":"opentelemetry","grpc":{"address":"0.0.0.0:${OTLP_GRPC_PORT}"},"http":{"address":"${OTLP_HTTP}"}}},
        "sinks":{"datadog":{"type":"datadog_metrics","inputs":["otel.logs"],"default_api_key":"SECRET[vault.dd_key]"}}
    });
    let mismatch = vectory_server::validation::validate_isolated(&state, &secrets)
        .await
        .unwrap();
    assert_eq!(mismatch["valid"], false, "{mismatch}");
    assert_eq!(diagnostic(&mismatch, "datadog")["code"], "type_mismatch");
    assert_eq!(mismatch["deferred"], true);
    assert_eq!(
        mismatch["placeholders"],
        json!(["${OTLP_GRPC_PORT}", "${OTLP_HTTP}", "SECRET[vault.dd_key]"])
    );
    assert!(!mismatch.to_string().contains("SHOULD_NEVER"));

    let unknown = post(&client, &url, "validate", json!({"config":{"sources":{"input":{"type":"not_a_real_vector_type"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}}})).await;
    assert_eq!(
        unknown["valid"], false,
        "Unknown types must not be silently deferred"
    );
    assert_eq!(diagnostic(&unknown, "input")["code"], "unknown_variant");

    let platform = vectory_server::validation::validate_isolated(&state, &json!({"sources":{"input":{"type":"journald"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}})).await.unwrap();
    assert_eq!(platform["valid"], true, "{platform}");
    assert_eq!(platform["deferred"], true);
    assert!(
        platform["deferred_reasons"]
            .to_string()
            .contains("platform-specific source journald")
    );

    // Providers are never fetched and secret backends never executed.
    let local = json!({"provider":{"type":"http","url":"http://127.0.0.1:1/SHOULD_NEVER_RESOLVE"},"secret":{"device":{"type":"exec","command":["SHOULD_NEVER_EXECUTE"]}}});
    let deferred = post(&client, &url, "validate", json!({"config":local})).await;
    assert_eq!(deferred["static_checked"], false);
    assert!(!deferred.to_string().contains("SHOULD_NEVER"));
    let tests = post(&client, &url, "tests", json!({"config":local})).await;
    assert_eq!(tests["tests_run"], false);
    child.kill().await.unwrap();
}

/// Vector's own `Failed to validate sink "<id>": <reason>` refusals belong to
/// their step, and to the setting the reason names, as the editor's Problems
/// panel uses them to jump there. Without it they read as pipeline-wide.
#[tokio::test]
async fn vectors_validation_refusals_belong_to_their_step_and_setting() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; refusal placement unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    let json_codec = json!({"codec":"json"});
    let source = json!({"in":{"type":"demo_logs","format":"json"}});
    let (_state_dir, state) = public_state(&url).await;
    for (id, sink, field, message) in [
        (
            "http_out",
            json!({"type":"http","inputs":["in"],"uri":"","encoding":json_codec}),
            "uri",
            "`uri` must not be empty",
        ),
        (
            "out_http",
            json!({"type":"http","inputs":["in"],"uri":"http://127.0.0.1:9/ingest","encoding":json_codec,"batch":{"max_events":0}}),
            "batch.max_events",
            "`max_events` must be greater than zero",
        ),
    ] {
        let config = json!({"sources":source,"sinks":{id:sink}});
        for result in [
            post(&client, &url, "validate", json!({"config":config})).await,
            vectory_server::validation::validate_isolated(&state, &config)
                .await
                .unwrap(),
        ] {
            assert_eq!(result["valid"], false, "{id}: {result}");
            let refusal = diagnostic(&result, id);
            assert_eq!(refusal["section"], "sinks", "{id}: {result}");
            assert_eq!(refusal["field"], field, "{id}: {result}");
            assert_eq!(refusal["code"], "invalid_value", "{id}: {result}");
            assert!(
                refusal["message"].as_str().unwrap().starts_with(message),
                "{id}: {result}"
            );
            assert!(
                !result["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["section"] == "global"),
                "{id}: nothing is left for Pipeline settings: {result}"
            );
        }
    }
    child.kill().await.unwrap();
}

/// Apply every "Treat errors as no match" fix the way the editor does (one
/// span at a time, checking again after each), then run the result natively.
#[tokio::test]
async fn condition_quick_fixes_keep_the_original_meaning() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; condition fix semantics unverified");
        return;
    };
    let (mut child, url, _client) = start_worker(&vector).await;
    let (_state_dir, state) = public_state(&url).await;
    let mut config = json!({
        "sources":{"in":{"type":"demo_logs","format":"json"}},
        "transforms":{"by_status":{"type":"route","inputs":["in"],"route":{
            "server_errors":".status >= 500",
            "client_errors":".status >= 400 && .status < 500"
        }}},
        "sinks":{
            "server":{"type":"blackhole","inputs":["by_status.server_errors"]},
            "client":{"type":"blackhole","inputs":["by_status.client_errors"]},
            "rest":{"type":"blackhole","inputs":["by_status._unmatched"]}
        }
    });
    let mut applied = 0;
    loop {
        let result = vectory_server::validation::validate_isolated(&state, &config)
            .await
            .unwrap();
        let Some(fix) = result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["fix"]["label"] == "Treat errors as no match")
            .cloned()
        else {
            assert_eq!(result["valid"], true, "{result}");
            break;
        };
        assert_eq!(fix["fix"]["scope"], "span");
        let output = fix["route_output"].as_str().unwrap();
        let condition = config["transforms"]["by_status"]["route"][output]
            .as_str()
            .unwrap()
            .to_owned();
        let start = fix["column"].as_u64().unwrap() as usize - 1;
        let end = start + fix["length"].as_u64().unwrap() as usize;
        let rewritten = format!(
            "{}{}{}",
            &condition[..start],
            fix["fix"]["replacement"].as_str().unwrap(),
            &condition[end..]
        );
        config["transforms"]["by_status"]["route"][output] = json!(rewritten);
        applied += 1;
        assert!(applied <= 3, "fixes did not converge: {config}");
    }
    assert_eq!(applied, 3, "{config}");
    let route = &config["transforms"]["by_status"]["route"];
    assert_eq!(
        route["client_errors"],
        "((.status >= 400) ?? false) && ((.status < 500) ?? false)"
    );
    let client = reqwest::Client::new();
    let routed = post(
        &client,
        &url,
        "transform-test",
        json!({
            "transform":{"type":"route","route":route},
            "samples":[{"status":200},{"status":404},{"status":503},{"status":"not a number"},{}]
        }),
    )
    .await;
    let ports: Vec<Vec<&str>> = routed["results"]
        .as_array()
        .unwrap_or_else(|| panic!("{routed}"))
        .iter()
        .map(|result| {
            let mut ports: Vec<&str> = result["outputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|output| output["port"].as_str().unwrap())
                .collect();
            ports.sort();
            ports
        })
        .collect();
    assert_eq!(
        ports,
        vec![
            vec!["_unmatched"],
            vec!["client_errors"],
            vec!["server_errors"],
            vec!["_unmatched"],
            vec!["_unmatched"],
        ],
        "{routed}"
    );
    child.kill().await.unwrap();
}

/// Vector drops the events still in flight when its stdin ends. Before the
/// worker held stdin open until the last sample had entered the pipeline, about
/// one run in a hundred lost the last sample's outputs and reported it as
/// unmatched. Sixty runs make a return of that visible in a single test run.
#[tokio::test]
async fn the_last_sample_of_a_run_is_never_lost() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; synthetic sample execution unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    for run in 0..60 {
        let routed = post(
            &client,
            &url,
            "transform-test",
            json!({
                "transform":{"type":"route","route":{"errors":"(.status >= 500) ?? false"}},
                "samples":[{"status":503},{"status":200},{}]
            }),
        )
        .await;
        let ports: Vec<&str> = routed["results"]
            .as_array()
            .unwrap_or_else(|| panic!("run {run}: {routed}"))
            .iter()
            .map(|result| result["outputs"][0]["port"].as_str().unwrap_or("none"))
            .collect();
        assert_eq!(
            ports,
            vec!["errors", "_unmatched", "_unmatched"],
            "run {run}: {routed}"
        );
    }
    child.kill().await.unwrap();
}

#[tokio::test]
async fn real_vector_worker_runs_samples_and_tests() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; synthetic sample execution unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    // Timestamps are real JSON, not VRL literal syntax.
    let parsed = post(&client, &url, "transform-test", json!({
        "transform":{"type":"remap","source":". = parse_nginx_log!(.message, \"combined\")\n.checked_at = now()"},
        "samples":[{"message":"127.0.0.1 - - [29/Sep/2026:01:02:03 +0000] \"GET /x HTTP/1.1\" 503 12 \"-\" \"curl\""},{"message":"not nginx"}]
    })).await;
    assert_eq!(parsed["compiled"], true, "{parsed}");
    let event = &parsed["results"][0]["outputs"][0]["event"];
    assert_eq!(event["status"], 503);
    assert_eq!(event["timestamp"], "2026-09-29T01:02:03Z");
    assert!(event["checked_at"].is_string());
    assert_eq!(
        parsed["results"][0]["outputs"][0]["timestamps"],
        json!(["checked_at", "timestamp"])
    );
    assert_eq!(parsed["results"][1]["outcome"], "error");
    assert_eq!(parsed["results"][1]["line"], 1);
    let routed = post(
        &client,
        &url,
        "transform-test",
        json!({
            "transform":{"type":"route","route":{"errors":"(.status >= 500) ?? false"}},
            "samples":[{"status":503},{"status":200}]
        }),
    )
    .await;
    assert_eq!(
        routed["results"][0]["outputs"][0]["port"], "errors",
        "{routed}"
    );
    assert_eq!(routed["results"][1]["outputs"][0]["port"], "_unmatched");
    let failing = post(
        &client,
        &url,
        "transform-test",
        json!({
            "transform":{"type":"filter","condition":".status >= 500"},
            "samples":[{"status":503}]
        }),
    )
    .await;
    assert_eq!(failing["compiled"], false, "{failing}");
    assert_eq!(failing["diagnostics"][0]["code"], "E100");
    assert_eq!(failing["diagnostics"][0]["field"], "condition");
    let legacy = post(&client, &url, "vrl-test", json!({"program":".message = upcase!(.message)\n.at = now()","sample":{"message":"synthetic only"}})).await;
    assert_eq!(legacy["valid"], true, "{legacy}");
    assert_eq!(legacy["output"]["message"], "SYNTHETIC ONLY");
    let denied = post(
        &client,
        &url,
        "vrl-test",
        json!({"program":".secret = get_env_var!(\"SECRET\")","sample":{}}),
    )
    .await;
    assert_eq!(
        denied["valid"], false,
        "The worker environment is empty: {denied}"
    );

    let mut tested = json!({
        "timezone":"UTC","sources":{"sample_one":{"type":"demo_logs","format":"json"}},
        "transforms":{"normalize":{"type":"remap","inputs":["sample_*"],"source":".message = upcase!(.message)"}},
        "sinks":{"out":{"type":"blackhole","inputs":["normal*"]}},
        "tests":[{"name":"Uppercase message","inputs":[{"insert_at":"normalize","type":"log","log_fields":{"message":"synthetic"}}],"outputs":[{"extract_from":"normalize","conditions":[{"type":"vrl","source":"assert_eq!(.message, \"SYNTHETIC\")"}]}]}]
    });
    let passed = post(&client, &url, "tests", json!({"config":tested})).await;
    assert_eq!(passed["tests_run"], true, "{passed}");
    assert_eq!(
        passed["tests"],
        json!([{"name":"Uppercase message","passed":true}])
    );
    tested["tests"][0]["outputs"][0]["conditions"][0]["source"] =
        json!("assert_eq!(.message, \"LOWER\", message: \"message should be LOWER\")");
    let failed = post(&client, &url, "tests", json!({"config":tested})).await;
    assert_eq!(failed["tests_run"], true, "{failed}");
    assert_eq!(failed["tests"][0]["passed"], false);
    assert_eq!(failed["tests"][0]["message"], "message should be LOWER");
    assert_eq!(failed["tests"][0]["outputs"][0]["message"], "SYNTHETIC");
    child.kill().await.unwrap();
}

#[tokio::test]
async fn worker_never_sends_requests_an_author_wrote() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; network-function guard unverified");
        return;
    };
    // A listener that counts connections: VRL's http_request would open one.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = connections.clone();
    tokio::spawn(async move {
        while listener.accept().await.is_ok() {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    });
    let (mut child, url, client) = start_worker(&vector).await;
    let program = format!(
        "resp, err = http_request(\"http://127.0.0.1:{port}/probe\")\n.reached = err == null\n.body = resp"
    );
    let single = post(
        &client,
        &url,
        "vrl-test",
        json!({"program": program, "sample": {"message": "x"}}),
    )
    .await;
    assert_eq!(single["valid"], false, "{single}");
    assert!(
        single["diagnostic"]
            .as_str()
            .unwrap()
            .contains("http_request"),
        "{single}"
    );
    let transform = post(
        &client,
        &url,
        "transform-test",
        json!({"transform": {"type": "remap", "source": program}, "samples": [{"message": "x"}]}),
    )
    .await;
    assert_eq!(transform["compiled"], false, "{transform}");
    assert_eq!(
        transform["diagnostics"][0]["code"],
        "vrl_function_unavailable"
    );
    let tests = post(
        &client,
        &url,
        "tests",
        json!({"config": {
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"call": {"type": "remap", "inputs": ["in"], "source": program}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["call"]}},
            "tests": [{"name": "calls out", "inputs": [{"insert_at": "call", "type": "log", "log_fields": {"message": "x"}}],
                "outputs": [{"extract_from": "call", "conditions": [{"type": "vrl", "source": ".reached == true"}]}]}]
        }}),
    )
    .await;
    assert_eq!(tests["tests_run"], false, "{tests}");
    assert_eq!(tests["diagnostics"][0]["code"], "vrl_function_unavailable");
    assert_eq!(tests["diagnostics"][0]["severity"], "warning");
    // Control: a program without network calls still runs.
    let plain = post(
        &client,
        &url,
        "vrl-test",
        json!({"program": ".ok = true", "sample": {"message": "x"}}),
    )
    .await;
    assert_eq!(plain["valid"], true, "{plain}");
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        connections.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "the worker connected to a server the author's program named"
    );
    child.kill().await.ok();
}

#[tokio::test]
async fn a_test_that_cannot_be_built_is_never_reported_as_a_pass() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; unbuildable tests unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    // The route conditions can fail at runtime (E100), so Vector cannot build
    // the tests. That used to come back as "0 of 0 tests passed".
    let result = post(
        &client,
        &url,
        "tests",
        json!({"config": {
            "sources": {"web": {"type": "demo_logs", "format": "json"}},
            "transforms": {"by_status": {"type": "route", "inputs": ["web"],
                "route": {"server_errors": ".status >= 500"}}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["by_status.server_errors"]}},
            "tests": [
                {"name": "503 is a server error",
                 "inputs": [{"insert_at": "by_status", "type": "log", "log_fields": {"status": 503}}],
                 "outputs": [{"extract_from": "by_status.server_errors",
                              "conditions": [{"type": "vrl", "source": ".status == 503"}]}]},
                {"name": "200 matches nothing",
                 "inputs": [{"insert_at": "by_status", "type": "log", "log_fields": {"status": 200}}],
                 "no_outputs_from": ["by_status.server_errors"]}
            ]
        }}),
    )
    .await;
    assert_eq!(result["tests_run"], true, "{result}");
    let tests = result["tests"].as_array().unwrap();
    assert_eq!(tests.len(), 2, "{result}");
    for test in tests {
        assert_eq!(test["passed"], false, "{result}");
        let message = test["message"].as_str().unwrap();
        assert!(
            message.starts_with("Could not build this test"),
            "{message}"
        );
        assert!(message.contains("by_status"), "{message}");
    }
    child.kill().await.ok();
}

#[tokio::test]
async fn tests_vector_refuses_to_run_are_never_reported_as_a_pass() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; refused tests unverified");
        return;
    };
    let (mut child, url, client) = start_worker(&vector).await;
    let base = |tests: serde_json::Value| {
        json!({"config": {
            "sources": {"web": {"type": "demo_logs", "format": "json"}},
            "transforms": {"parse": {"type": "remap", "inputs": ["web"], "source": ".seen = true"}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["parse"]}},
            "tests": tests,
        }})
    };
    let good = json!({"name": "good",
        "inputs": [{"insert_at": "parse", "type": "log", "log_fields": {"message": "hi"}}],
        "outputs": [{"extract_from": "parse", "conditions": [{"type": "vrl", "source": ".seen == true"}]}]});

    // A misspelled test setting: Vector exits 78 after "Running tests" and runs nothing.
    let typo = json!({"name": "typo",
        "inputs": [{"insert_at": "parse", "type": "log", "log_fieldz": {"message": "hi"}}],
        "outputs": [{"extract_from": "parse", "conditions": [{"type": "vrl", "source": ".seen == true"}]}]});
    let refused = post(&client, &url, "tests", base(json!([good.clone(), typo]))).await;
    assert_eq!(refused["tests_run"], true, "{refused}");
    let tests = refused["tests"].as_array().unwrap();
    assert_eq!(tests.len(), 1, "{refused}");
    assert_eq!(tests[0]["name"], "typo");
    assert_eq!(tests[0]["passed"], false);
    let message = tests[0]["message"].as_str().unwrap();
    assert!(
        message.starts_with("Vector can't read this test: inputs[0].log_fieldz"),
        "{message}"
    );
    assert!(message.contains("unknown field"), "{message}");

    // A condition Vector cannot match to any of its kinds.
    let condition = json!({"name": "cond",
        "inputs": [{"insert_at": "parse", "type": "log", "log_fields": {"message": "hi"}}],
        "outputs": [{"extract_from": "parse", "conditions": [{"type": "vrl", "sourse": ".seen == true"}]}]});
    let refused = post(&client, &url, "tests", base(json!([condition]))).await;
    assert_eq!(refused["tests_run"], true, "{refused}");
    assert_eq!(refused["tests"][0]["name"], "cond");
    assert_eq!(refused["tests"][0]["passed"], false);
    assert!(
        refused["tests"][0]["message"]
            .as_str()
            .unwrap()
            .contains("conditions[0]")
    );

    // A test without any expectation is read but cannot be built.
    let empty = json!({"name": "expects nothing",
        "inputs": [{"insert_at": "parse", "type": "log", "log_fields": {"message": "hi"}}]});
    let refused = post(&client, &url, "tests", base(json!([empty]))).await;
    assert_eq!(refused["tests_run"], true, "{refused}");
    assert_eq!(refused["tests"][0]["passed"], false, "{refused}");
    assert!(
        refused["tests"][0]["message"]
            .as_str()
            .unwrap()
            .contains("outputs"),
        "{refused}"
    );

    // Tests that run are unaffected: one passes, one fails on its own merits.
    let wrong = json!({"name": "wrong",
        "inputs": [{"insert_at": "parse", "type": "log", "log_fields": {"message": "hi"}}],
        "outputs": [{"extract_from": "parse", "conditions": [{"type": "vrl", "source": ".seen == false"}]}]});
    let ran = post(&client, &url, "tests", base(json!([good, wrong]))).await;
    assert_eq!(ran["tests_run"], true, "{ran}");
    assert_eq!(ran["tests"][0]["passed"], true, "{ran}");
    assert_eq!(ran["tests"][1]["passed"], false, "{ran}");
    assert_eq!(ran["diagnostics"], json!([]), "{ran}");
    child.kill().await.ok();
}

#[tokio::test]
async fn worker_never_reads_files_an_author_named() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; file-function guard unverified");
        return;
    };
    // VRL's validate_json_schema quotes the schema file's own values in its error.
    let dir = tempfile::tempdir().unwrap();
    let schema = dir.path().join("schema.json");
    std::fs::write(&schema, r#"{"type":"object","required":["hunter2secret"]}"#).unwrap();
    let program = format!(
        "_, err = validate_json_schema(.message, \"{}\")\n.err = err",
        schema.display()
    );
    let (mut child, url, client) = start_worker(&vector).await;
    let single = post(
        &client,
        &url,
        "vrl-test",
        json!({"program": program, "sample": {"message": "x"}}),
    )
    .await;
    assert_eq!(single["valid"], false, "{single}");
    assert!(
        single["diagnostic"]
            .as_str()
            .unwrap()
            .contains("validate_json_schema"),
        "{single}"
    );
    assert!(!single.to_string().contains("hunter2secret"), "{single}");
    let transform = post(
        &client,
        &url,
        "transform-test",
        json!({"transform": {"type": "remap", "source": program}, "samples": [{"message": "x"}]}),
    )
    .await;
    assert_eq!(transform["compiled"], false, "{transform}");
    assert_eq!(
        transform["diagnostics"][0]["code"],
        "vrl_function_unavailable"
    );
    assert!(
        !transform.to_string().contains("hunter2secret"),
        "{transform}"
    );

    // The static check compiles the program, which would open the file too: the
    // step is replaced by a stand-in and the device checks it.
    let config = json!({
        "sources": {"in": {"type": "demo_logs", "format": "json"}},
        "transforms": {"check": {"type": "remap", "inputs": ["in"], "source": program}},
        "sinks": {"out": {"type": "blackhole", "inputs": ["check"]}},
    });
    let checked = post(&client, &url, "validate", json!({"config": config})).await;
    assert_eq!(checked["valid"], true, "{checked}");
    assert_eq!(checked["stubbed"], json!(["check"]), "{checked}");
    assert!(!checked.to_string().contains("hunter2secret"), "{checked}");
    assert!(
        checked["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "device_check"
                && d["message"] == "This step reads a file on each device."),
        "{checked}"
    );
    let mut with_tests = config.clone();
    with_tests["tests"] = json!([{"name": "reads", "inputs": [{"insert_at": "check", "type": "log", "log_fields": {"message": "x"}}],
        "outputs": [{"extract_from": "check", "conditions": [{"type": "vrl", "source": ".err == null"}]}]}]);
    let tests = post(&client, &url, "tests", json!({"config": with_tests})).await;
    assert_eq!(tests["tests_run"], false, "{tests}");
    assert_eq!(tests["diagnostics"][0]["code"], "vrl_function_unavailable");
    assert!(!tests.to_string().contains("hunter2secret"), "{tests}");
    // Control: a program that reads nothing still runs.
    let plain = post(
        &client,
        &url,
        "vrl-test",
        json!({"program": ".ok = true", "sample": {"message": "x"}}),
    )
    .await;
    assert_eq!(plain["valid"], true, "{plain}");
    child.kill().await.ok();
}

/// A pipeline whose source and sink are the components under test, with one
/// trivial unit test so `vector test` has something to run.
#[cfg(target_os = "linux")]
fn pipeline(
    source: serde_json::Value,
    mut sink: serde_json::Value,
    data_dir: &std::path::Path,
) -> serde_json::Value {
    sink["inputs"] = json!(["t"]);
    json!({
        "data_dir": data_dir,
        "sources": {"s": source},
        "transforms": {"t": {"type": "remap", "inputs": ["s"], "source": "."}},
        "sinks": {"k": sink},
        "tests": [{"name": "t",
            "inputs": [{"insert_at": "t", "type": "log", "log_fields": {"message": "x"}}],
            "outputs": [{"extract_from": "t", "conditions": [{"type": "vrl", "source": "true"}]}]}],
    })
}

/// Run pinned Vector with an empty environment and wait for it to end, with
/// `stdin` held open so a source that reads it has something to read.
#[cfg(target_os = "linux")]
async fn vector_ends(
    vector: &str,
    args: &[&str],
    config: &std::path::Path,
    stdin: Option<&str>,
) -> (Option<i32>, String) {
    use tokio::io::AsyncWriteExt;
    let mut command = tokio::process::Command::new(vector);
    command
        .args(args)
        .arg(config)
        .current_dir(config.parent().unwrap())
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    if let Some(text) = stdin {
        input.write_all(text.as_bytes()).await.unwrap();
    }
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let read = async {
        use tokio::io::AsyncReadExt;
        let (mut stdout, mut stderr) = (String::new(), String::new());
        let _ = tokio::join!(
            out.read_to_string(&mut stdout),
            err.read_to_string(&mut stderr)
        );
        stdout + &stderr
    };
    let status = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let (status, text) = tokio::join!(child.wait(), read);
        (status.unwrap().code(), text)
    })
    .await
    .expect("vector did not end");
    drop(input);
    status
}

/// Run pinned Vector as it runs a pipeline for real, until `marker` appears
/// (or ten seconds pass), then stop it. Whether the marker appeared.
#[cfg(target_os = "linux")]
async fn vector_runs_until(
    vector: &str,
    config: &std::path::Path,
    stdin: Option<&str>,
    marker: &std::path::Path,
) -> bool {
    use tokio::io::AsyncWriteExt;
    let mut command = tokio::process::Command::new(vector);
    command
        .arg("--config-json")
        .arg(config)
        .current_dir(config.parent().unwrap())
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().unwrap();
    // Held open: Vector drops the events still in flight when stdin ends.
    let mut input = child.stdin.take().unwrap();
    if let Some(text) = stdin {
        input.write_all(text.as_bytes()).await.unwrap();
    }
    let mut seen = false;
    for _ in 0..100 {
        if marker.exists() {
            seen = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    child.kill().await.ok();
    seen
}

/// Components that run a program, read what started Vector, or write a file all
/// act when Vector runs a pipeline. `vector validate --no-environment` and
/// `vector test`, the only two commands the worker uses on a draft, start none
/// of them: each marker below appears under a normal run and never under those
/// two commands, and never through the worker.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn components_that_act_when_vector_runs_never_start_under_validate_or_test() {
    use std::os::unix::fs::PermissionsExt;
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; component start guard unverified");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let marker = |name: &str| dir.path().join(format!("ran-{name}"));
    // A stand-in for `journalctl` that only leaves its marker.
    let journalctl = dir.path().join("journalctl");
    std::fs::write(
        &journalctl,
        format!(
            "#!/bin/sh\ntouch {}\nsleep 30\n",
            marker("journald").display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&journalctl, std::fs::Permissions::from_mode(0o755)).unwrap();
    let blackhole = json!({"type": "blackhole"});
    let to_file =
        |name: &str| json!({"type": "file", "path": marker(name), "encoding": {"codec": "json"}});
    let cases = [
        (
            "exec",
            json!({"type": "exec", "command": ["touch", marker("exec")], "mode": "scheduled",
                "scheduled": {"exec_interval_secs": 1}}),
            blackhole.clone(),
            None,
        ),
        (
            "journald",
            json!({"type": "journald", "journalctl_path": journalctl}),
            blackhole.clone(),
            None,
        ),
        (
            "file",
            json!({"type": "demo_logs", "format": "json"}),
            to_file("file"),
            None,
        ),
        (
            "stdin",
            json!({"type": "stdin"}),
            to_file("stdin"),
            Some("hello\n"),
        ),
        (
            "fd",
            json!({"type": "file_descriptor", "fd": 0}),
            to_file("fd"),
            Some("hello\n"),
        ),
    ];
    let (mut child, url, client) = start_worker(&vector).await;
    for (name, source, sink, stdin) in cases {
        let config = pipeline(source, sink, dir.path());
        let path = dir.path().join(format!("{name}.json"));
        std::fs::write(&path, config.to_string()).unwrap();
        let marker = marker(name);

        // The two commands the worker uses, on the draft as written.
        for args in [
            &["validate", "--no-environment"][..],
            &["test", "--config-json"][..],
        ] {
            let (code, text) = vector_ends(&vector, args, &path, stdin).await;
            assert_eq!(code, Some(0), "{name}: {args:?} did not accept it: {text}");
            assert!(!marker.exists(), "{name} started under {args:?}");
        }
        // The worker, which hands Vector a copy with stand-ins.
        let checked = post(&client, &url, "validate", json!({"config": config})).await;
        assert_eq!(checked["valid"], true, "{name}: {checked}");
        let tested = post(&client, &url, "tests", json!({"config": config})).await;
        assert_eq!(tested["tests_run"], true, "{name}: {tested}");
        assert_eq!(tested["tests"][0]["passed"], true, "{name}: {tested}");
        assert!(!marker.exists(), "{name} started through the worker");

        // Control: the same pipeline under a normal run does leave its marker.
        assert!(
            vector_runs_until(&vector, &path, stdin, &marker).await,
            "{name}: the marker never appeared under a normal run, so this test proves nothing"
        );
    }

    // A secret backend of type `exec` runs a program when a configuration uses
    // one of its secrets. The worker removes every backend, and replaces every
    // reference with a placeholder, before Vector sees the draft.
    let backend = marker("secret");
    let secret = json!({
        "data_dir": dir.path(),
        "secret": {"vault": {"type": "exec", "command": ["touch", backend]}},
        "sources": {"s": {"type": "demo_logs", "format": "json"}},
        "transforms": {"t": {"type": "remap", "inputs": ["s"], "source": ".token = \"SECRET[vault.token]\""}},
        "sinks": {"k": {"type": "blackhole", "inputs": ["t"]}},
        "tests": [{"name": "t",
            "inputs": [{"insert_at": "t", "type": "log", "log_fields": {"message": "x"}}],
            "outputs": [{"extract_from": "t", "conditions": [{"type": "vrl", "source": "true"}]}]}],
    });
    let checked = post(&client, &url, "validate", json!({"config": secret})).await;
    assert_eq!(checked["valid"], true, "{checked}");
    let tested = post(&client, &url, "tests", json!({"config": secret})).await;
    assert_eq!(tested["tests_run"], true, "{tested}");
    assert!(
        !backend.exists(),
        "the secret backend ran through the worker"
    );
    let path = dir.path().join("secret.json");
    std::fs::write(&path, secret.to_string()).unwrap();
    assert!(
        vector_runs_until(&vector, &path, None, &backend).await,
        "the marker never appeared under a normal run, so this test proves nothing"
    );
    // Vector itself runs the backend under `vector test`, so the removal above
    // is what keeps the program from running in the worker.
    std::fs::remove_file(&backend).unwrap();
    vector_ends(&vector, &["test", "--config-json"], &path, None).await;
    assert!(
        backend.exists(),
        "Vector no longer runs a secret backend for a test: review what the worker removes"
    );
    child.kill().await.ok();
}

/// Signed-in people for the API in front of a worker.
struct Session {
    cookie: String,
    csrf: String,
}

async fn session(state: &vectory_server::State, role: &str) -> Session {
    let id = vectory_server::db::id();
    let token = vectory_server::auth::random_secret();
    let csrf = vectory_server::auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Test {role}"))
    .bind(role)
    .bind("unused-test-login")
    .bind(vectory_server::db::now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(vectory_server::db::hash(&token))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&state.pool)
        .await
        .unwrap();
    Session {
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}

async fn api(
    app: &axum::Router,
    method: &str,
    path: &str,
    body: serde_json::Value,
    who: &Session,
) -> (axum::http::StatusCode, serde_json::Value) {
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let request = axum::http::Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", &who.cookie)
        .header("x-csrf-token", &who.csrf)
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// One `lua` transform per form the transform takes, each running a program
/// that leaves its own marker file. A marker that appears names the form that
/// ran.
#[cfg(unix)]
fn lua_forms(dir: &std::path::Path) -> (serde_json::Value, Vec<std::path::PathBuf>) {
    let marker = |name: &str| dir.join(format!("ran-{name}"));
    let touch = |name: &str| format!("os.execute('touch {}')", marker(name).display());
    let popen = |name: &str| {
        format!(
            "local p = io.popen('touch {}'); p:close()",
            marker(name).display()
        )
    };
    let modules = dir.join("modules");
    std::fs::create_dir_all(&modules).unwrap();
    std::fs::write(
        modules.join("evil.lua"),
        format!("{}\nreturn {{}}\n", touch("module")),
    )
    .unwrap();
    let forms = json!({
        "lua_chunk": {"type":"lua","version":"2","inputs":["in"],
            "source": format!("{}\nfunction process(e, emit) emit(e) end", touch("chunk")),
            "hooks":{"process":"process"}},
        "lua_hooks": {"type":"lua","version":"2","inputs":["in"],
            "source": format!(
                "function init(emit) {} end\nfunction process(e, emit) {} {} emit(e) end\nfunction tick(emit) {} end\nfunction shutdown(emit) {} end",
                popen("init"), touch("process"), popen("popen"), touch("timer"), touch("shutdown")
            ),
            "hooks":{"init":"init","process":"process","shutdown":"shutdown"},
            "timers":[{"interval_seconds":1,"handler":"tick"}]},
        "lua_v1": {"type":"lua","version":"1","inputs":["in"], "source": touch("v1")},
        "lua_modules": {"type":"lua","version":"2","inputs":["in"],
            "search_dirs":[modules.to_string_lossy()],
            "source":"local evil = require('evil')\nfunction process(e, emit) emit(e) end",
            "hooks":{"process":"process"}},
    });
    let ids: Vec<String> = forms.as_object().unwrap().keys().cloned().collect();
    let tests: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            json!({"name": format!("{id} runs"),
            "inputs":[{"insert_at":id,"type":"log","log_fields":{"message":"x"}}],
            "outputs":[{"extract_from":id,"conditions":[{"type":"vrl","source":"true"}]}]})
        })
        .collect();
    let config = json!({
        "sources":{"in":{"type":"demo_logs","format":"json"}},
        "transforms": forms,
        "sinks":{"out":{"type":"blackhole","inputs":ids}},
        "tests": tests,
    });
    let markers = [
        "chunk", "init", "process", "popen", "timer", "shutdown", "v1", "module",
    ]
    .iter()
    .map(|name| marker(name))
    .collect();
    (config, markers)
}

/// Lua can run any program: `os.execute` and `io.popen` fire when Vector builds
/// the transform, which `vector test` does. User Lua runs on devices only, so
/// neither the worker nor the API in front of it may hand a `lua` transform to
/// Vector, in any form, from any route.
#[cfg(unix)]
#[tokio::test]
async fn lua_never_runs_in_the_validator() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; Lua guard unverified");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let (config, markers) = lua_forms(dir.path());
    let ran = || -> Vec<String> {
        markers
            .iter()
            .filter(|marker| marker.exists())
            .map(|marker| marker.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    };
    let none = Vec::<String>::new();
    let (mut child, url, client) = start_worker(&vector).await;
    let (_state_dir, state) = public_state(&url).await;
    let app = vectory_server::api::router(state.clone());
    let editor = session(&state, "editor").await;
    let operator = session(&state, "operator").await;

    // The worker's own routes never build the transform.
    let tests = post(&client, &url, "tests", json!({"config": config})).await;
    assert_eq!(ran(), none, "the worker's /tests ran Lua: {tests}");
    assert_eq!(tests["tests_run"], false, "{tests}");
    let checked = post(&client, &url, "validate", json!({"config": config})).await;
    assert_eq!(ran(), none, "the worker's /validate ran Lua: {checked}");
    assert_eq!(checked["valid"], true, "{checked}");
    let mut stubbed: Vec<&str> = checked["stubbed"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|id| id.as_str())
        .collect();
    stubbed.sort();
    assert_eq!(
        stubbed,
        vec!["lua_chunk", "lua_hooks", "lua_modules", "lua_v1"],
        "{checked}"
    );
    let sample = post(
        &client,
        &url,
        "transform-test",
        json!({"transform": config["transforms"]["lua_chunk"], "samples": [{"message": "x"}]}),
    )
    .await;
    assert_eq!(ran(), none, "the sample runner ran Lua: {sample}");
    assert_eq!(sample["compiled"], false, "{sample}");

    // The API: the test route, the validate route and the publish gate.
    let (status, run) = api(
        &app,
        "POST",
        "/api/v1/configurations/test",
        json!({"config": config}),
        &editor,
    )
    .await;
    assert_eq!(ran(), none, "POST /configurations/test ran Lua: {run}");
    assert_eq!(status, axum::http::StatusCode::OK, "{run}");
    assert_eq!(run["tests_run"], false, "{run}");
    assert_eq!(run["deferred"], true, "{run}");
    assert_eq!(run["tests"], json!([]), "{run}");
    assert!(
        run["deferred_reasons"]
            .as_array()
            .unwrap()
            .contains(&json!("Lua runs on devices")),
        "{run}"
    );
    assert!(
        run["errors"][0]
            .as_str()
            .unwrap()
            .starts_with("Lua can run any program, so tests that include it run only on devices."),
        "{run}"
    );

    let (status, created) = api(
        &app,
        "POST",
        "/api/v1/configurations",
        json!({"name":"Lua","description":"","config":{"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}},"graph":{"nodes":[],"edges":[]}}),
        &editor,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, saved) = api(
        &app,
        "PUT",
        &format!("/api/v1/configurations/{id}/draft"),
        json!({"revision":created["revision"],"config":config,"graph":created["graph"],"name":"Lua","description":""}),
        &editor,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{saved}");
    let (status, validated) = api(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/validate"),
        json!({"config": config}),
        &editor,
    )
    .await;
    assert_eq!(
        ran(),
        none,
        "POST /configurations/{{id}}/validate ran Lua: {validated}"
    );
    assert_eq!(status, axum::http::StatusCode::OK, "{validated}");
    assert_eq!(validated["valid"], true, "{validated}");
    assert_eq!(validated["deferred"], true, "{validated}");
    assert_eq!(validated["vector_validated"], false, "{validated}");
    // The module form also names a device directory, which is its own reason.
    assert_eq!(
        validated["deferred_reasons"],
        json!([
            "Lua runs on devices",
            "device-local paths or external code files"
        ]),
        "{validated}"
    );
    let notes: Vec<&str> = validated["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|d| d["code"] == "device_check" && d["severity"] == "warning")
        .filter_map(|d| d["component"].as_str())
        .collect();
    assert_eq!(
        notes.len(),
        4,
        "each Lua step says a device checks it: {validated}"
    );

    // Publishing: the draft is valid, its tests did not run, and the existing
    // acknowledgement is what lets it through.
    let publish = json!({"revision":saved["revision"],"message":""});
    let (status, refusal) = api(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/publish"),
        publish.clone(),
        &operator,
    )
    .await;
    assert_eq!(ran(), none, "publishing ran Lua: {refusal}");
    assert_eq!(status, axum::http::StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["code"], "TESTS_FAILED", "{refusal}");
    assert_eq!(refusal["tests_run"], false, "{refusal}");
    assert_eq!(refusal["counts"]["not_run"], 4, "{refusal}");
    let mut acknowledged = publish;
    acknowledged["acknowledge_test_failures"] = json!(true);
    let (status, version) = api(
        &app,
        "POST",
        &format!("/api/v1/configurations/{id}/publish"),
        acknowledged,
        &operator,
    )
    .await;
    assert_eq!(ran(), none, "an acknowledged publish ran Lua: {version}");
    assert_eq!(status, axum::http::StatusCode::OK, "{version}");
    child.kill().await.ok();
}

/// A named pipe standing in for a path an author names. A writer's `open`
/// returns only when something opens the pipe for reading, so `opened()` says
/// whether anything tried to read the path.
#[cfg(target_os = "linux")]
struct Tripwire {
    path: std::path::PathBuf,
    opened: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(target_os = "linux")]
impl Tripwire {
    fn new(path: std::path::PathBuf) -> Self {
        let made = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());
        let opened = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (flag, pipe) = (opened.clone(), path.clone());
        std::thread::spawn(move || {
            if std::fs::OpenOptions::new().write(true).open(&pipe).is_ok() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        Tripwire { path, opened }
    }
    async fn opened(&self) -> bool {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        self.opened.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(target_os = "linux")]
impl Drop for Tripwire {
    // Lets a writer that nothing opened for end: on Linux a read-write open of
    // a pipe does not block.
    fn drop(&mut self) {
        let _ = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path);
    }
}

/// A pipeline whose one step looks up an enrichment table, and a test of it.
#[cfg(target_os = "linux")]
fn enrichment_pipeline(table: serde_json::Value, condition: &str) -> serde_json::Value {
    json!({
        "sources": {"in": {"type": "demo_logs", "format": "json"}},
        "transforms": {"look": {"type": "remap", "inputs": ["in"],
            "source": format!(".row = get_enrichment_table_record!(\"lk\", {condition})")}},
        "sinks": {"out": {"type": "blackhole", "inputs": ["look"]}},
        "enrichment_tables": {"lk": table},
        "tests": [{"name": "looks it up",
            "inputs": [{"insert_at": "look", "type": "log", "log_fields": {"message": "x"}}],
            "outputs": [{"extract_from": "look", "conditions": [{"type": "vrl", "source": "assert_eq!(.row.v, \"nope\")"}]}]}],
    })
}

/// An enrichment table that reads a file makes Vector open that file when it
/// builds the table, which `vector test` does, and the lookup returns the rows
/// to whoever wrote it. The server never reads a path an author names: a device
/// reads its own files. Every table type but `memory` stays out of the worker's
/// Vector, through the worker, the test route and the validate route.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn enrichment_tables_that_read_files_never_reach_the_validator() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; enrichment file guard unverified");
        return;
    };
    const SENTINEL: &str = "SENTINEL-4f9a1c-in-no-reply";
    let dir = tempfile::tempdir().unwrap();
    let csv = dir.path().join("lookup.csv");
    std::fs::write(&csv, format!("k,v\nAAA,{SENTINEL}\n")).unwrap();
    let table = |kind: &str, path: &std::path::Path| match kind {
        "file" => json!({"type": "file",
            "file": {"path": path, "encoding": {"type": "csv", "include_headers": true}},
            "schema": {"k": "string", "v": "string"}}),
        other => json!({"type": other, "path": path}),
    };
    let by_key = r#"{"k": "AAA"}"#;
    let by_ip = r#"{"ip": "1.2.3.4"}"#;

    // Control: Vector itself opens each path and returns the file's rows, so a
    // pipe that stays unopened below means something kept the table away.
    let control = enrichment_pipeline(table("file", &csv), by_key);
    let control_path = dir.path().join("control.json");
    std::fs::write(&control_path, control.to_string()).unwrap();
    let (_, text) = vector_ends(&vector, &["test", "--config-json"], &control_path, None).await;
    assert!(
        text.contains(SENTINEL),
        "the control lookup did not return the file's row: {text}"
    );
    for (kind, condition) in [("file", by_key), ("geoip", by_ip), ("mmdb", by_ip)] {
        let pipe = Tripwire::new(dir.path().join(format!("control-{kind}")));
        let config = enrichment_pipeline(table(kind, &pipe.path), condition);
        let path = dir.path().join(format!("control-{kind}.json"));
        std::fs::write(&path, config.to_string()).unwrap();
        vector_ends(&vector, &["test", "--config-json"], &path, None).await;
        assert!(
            pipe.opened().await,
            "{kind}: Vector did not open the path under a normal test, so this test proves nothing"
        );
    }

    // The same pipelines through the worker and the API.
    let cases = vec![
        (
            "file with rows",
            Some(enrichment_pipeline(table("file", &csv), by_key)),
            None,
        ),
        ("file", None, Some(("file", by_key))),
        ("geoip", None, Some(("geoip", by_ip))),
        ("mmdb", None, Some(("mmdb", by_ip))),
    ];
    let (mut child, url, client) = start_worker(&vector).await;
    let (_state_dir, state) = public_state(&url).await;
    let app = vectory_server::api::router(state.clone());
    let editor = session(&state, "editor").await;
    let (status, created) = api(
        &app,
        "POST",
        "/api/v1/configurations",
        json!({"name":"Enrichment","description":"","config":{"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}},"graph":{"nodes":[],"edges":[]}}),
        &editor,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let mut replies = Vec::new();
    let mut pipes = Vec::new();
    for (name, config, pipe) in cases {
        let config = match (config, pipe) {
            (Some(config), _) => config,
            (None, Some((kind, condition))) => {
                let tripwire = Tripwire::new(dir.path().join(format!("worker-{kind}")));
                let config = enrichment_pipeline(table(kind, &tripwire.path), condition);
                pipes.push((name, tripwire));
                config
            }
            (None, None) => unreachable!(),
        };
        let tests = post(&client, &url, "tests", json!({"config": config})).await;
        assert_eq!(tests["tests_run"], false, "{name}: {tests}");
        let checked = post(&client, &url, "validate", json!({"config": config})).await;
        assert_eq!(checked["valid"], true, "{name}: {checked}");
        assert_eq!(checked["stubbed"], json!(["look"]), "{name}: {checked}");
        let (status, run) = api(
            &app,
            "POST",
            "/api/v1/configurations/test",
            json!({"config": config}),
            &editor,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{name}: {run}");
        assert_eq!(run["tests_run"], false, "{name}: {run}");
        assert_eq!(run["deferred"], true, "{name}: {run}");
        assert_eq!(run["tests"], json!([]), "{name}: {run}");
        assert!(
            run["deferred_reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("Enrichment tables are read on devices")),
            "{name}: {run}"
        );
        assert_eq!(
            run["errors"],
            json!([
                "Enrichment tables are read on devices, so tests that use them run only on devices. Use Check on devices with Also run the pipeline's tests."
            ]),
            "{name}: {run}"
        );
        let (status, validated) = api(
            &app,
            "POST",
            &format!("/api/v1/configurations/{id}/validate"),
            json!({"config": config}),
            &editor,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK, "{name}: {validated}");
        assert_eq!(validated["valid"], true, "{name}: {validated}");
        assert_eq!(validated["deferred"], true, "{name}: {validated}");
        assert_eq!(validated["vector_validated"], false, "{name}: {validated}");
        assert!(
            validated["deferred_reasons"]
                .as_array()
                .unwrap()
                .contains(&json!("Enrichment tables are read on devices")),
            "{name}: {validated}"
        );
        assert!(
            validated["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| {
                    d["code"] == "device_check"
                        && d["component"] == "look"
                        && d["message"]
                            == "This step looks up an enrichment table, which each device reads."
                }),
            "{name}: {validated}"
        );
        replies.extend([tests, checked, run, validated]);
    }
    for reply in &replies {
        assert!(
            !reply.to_string().contains(SENTINEL),
            "a reply carried the file's row: {reply}"
        );
    }
    for (name, pipe) in &pipes {
        assert!(
            !pipe.opened().await,
            "{name}: the worker opened a path the author named"
        );
    }

    // A memory table reads no file: its tests still run, as before.
    let memory = json!({
        "sources": {"in": {"type": "demo_logs", "format": "json"}},
        "transforms": {"keep": {"type": "remap", "inputs": ["in"], "source": ".seen = true"}},
        "sinks": {"out": {"type": "blackhole", "inputs": ["keep"]}},
        "enrichment_tables": {"memo": {"type": "memory", "ttl": 60}},
        "tests": [{"name": "keeps working",
            "inputs": [{"insert_at": "keep", "type": "log", "log_fields": {"message": "x"}}],
            "outputs": [{"extract_from": "keep", "conditions": [{"type": "vrl", "source": ".seen == true"}]}]}],
    });
    let tests = post(&client, &url, "tests", json!({"config": memory})).await;
    assert_eq!(tests["tests_run"], true, "{tests}");
    assert_eq!(tests["tests"][0]["passed"], true, "{tests}");
    let (_, run) = api(
        &app,
        "POST",
        "/api/v1/configurations/test",
        json!({"config": memory}),
        &editor,
    )
    .await;
    assert_eq!(run["tests_run"], true, "{run}");
    assert_eq!(run["valid"], true, "{run}");
    child.kill().await.ok();
}

/// Run Vector for a moment and stop it, for a program that makes it wait on a
/// path.
#[cfg(target_os = "linux")]
async fn vector_briefly(vector: &str, args: &[&str], config: &std::path::Path) {
    let mut child = tokio::process::Command::new(vector)
        .args(args)
        .arg(config)
        .current_dir(config.parent().unwrap())
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait()).await;
    child.kill().await.ok();
}

/// `parse_groks(alias_sources:)` and `parse_etld(psl:)` read the file a call
/// passes when Vector compiles the program, whichever command compiles it. The
/// server never opens a path an author names: not in the static check, the
/// tests or the sample runner.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_vrl_call_that_passes_a_file_never_opens_it_in_the_worker() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; VRL file argument guard unverified");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let pipeline = |source: &str| {
        json!({
            "sources": {"in": {"type": "demo_logs", "format": "json"}},
            "transforms": {"look": {"type": "remap", "inputs": ["in"], "source": source}},
            "sinks": {"out": {"type": "blackhole", "inputs": ["look"]}},
            "tests": [{"name": "t",
                "inputs": [{"insert_at": "look", "type": "log", "log_fields": {"message": "x"}}],
                "outputs": [{"extract_from": "look", "conditions": [{"type": "vrl", "source": "true"}]}]}],
        })
    };
    let programs: [(&str, fn(&std::path::Path) -> String); 2] = [
        ("parse_groks", |path| {
            format!(
                ".x = parse_groks!(.message, [\"%{{A:a}}\"], alias_sources: [\"{}\"])",
                path.display()
            )
        }),
        ("parse_etld", |path| {
            format!(".x = parse_etld!(.message, psl: \"{}\")", path.display())
        }),
    ];
    let (mut child, url, client) = start_worker(&vector).await;
    for (name, program) in programs {
        // Control: Vector opens the path when it compiles the program.
        let control = Tripwire::new(dir.path().join(format!("control-{name}")));
        let path = dir.path().join(format!("control-{name}.json"));
        std::fs::write(&path, pipeline(&program(&control.path)).to_string()).unwrap();
        vector_briefly(&vector, &["validate", "--no-environment"], &path).await;
        assert!(
            control.opened().await,
            "{name}: Vector did not open the path, so this test proves nothing"
        );

        // The worker, on every route that compiles a program.
        let pipe = Tripwire::new(dir.path().join(format!("worker-{name}")));
        let source = program(&pipe.path);
        let config = pipeline(&source);
        let checked = post(&client, &url, "validate", json!({"config": config})).await;
        assert_eq!(checked["valid"], true, "{name}: {checked}");
        assert_eq!(checked["stubbed"], json!(["look"]), "{name}: {checked}");
        let tests = post(&client, &url, "tests", json!({"config": config})).await;
        assert_eq!(tests["tests_run"], false, "{name}: {tests}");
        assert_eq!(
            tests["diagnostics"][0]["code"], "vrl_function_unavailable",
            "{name}: {tests}"
        );
        let sample = post(
            &client,
            &url,
            "transform-test",
            json!({"transform": {"type": "remap", "source": source}, "samples": [{"message": "x"}]}),
        )
        .await;
        assert_eq!(sample["compiled"], false, "{name}: {sample}");
        assert_eq!(
            sample["diagnostics"][0]["code"], "vrl_function_unavailable",
            "{name}: {sample}"
        );
        let single = post(
            &client,
            &url,
            "vrl-test",
            json!({"program": source, "sample": {"message": "x"}}),
        )
        .await;
        assert_eq!(single["valid"], false, "{name}: {single}");
        assert!(
            !pipe.opened().await,
            "{name}: the worker opened a path a program named"
        );
    }

    // Without a file the same functions are ordinary, and stay checked here.
    for source in [
        ".x = parse_etld!(.message)",
        ".x = parse_groks!(.message, [\"%{WORD:w}\"])",
    ] {
        let checked = post(
            &client,
            &url,
            "validate",
            json!({"config": pipeline(source)}),
        )
        .await;
        assert_eq!(checked["valid"], true, "{source}: {checked}");
        assert_eq!(checked["stubbed"], json!([]), "{source}: {checked}");
        let sample = post(
            &client,
            &url,
            "transform-test",
            json!({"transform": {"type": "remap", "source": source}, "samples": [{"message": "www.example.com"}]}),
        )
        .await;
        assert_eq!(sample["compiled"], true, "{source}: {sample}");
    }
    child.kill().await.ok();
}

/// The two commands the worker uses open only the paths the worker keeps out of
/// them (an enrichment table's file, a `remap` file, a `file` secret backend, the
/// files a VRL call passes). A TLS file, a codec descriptor, a credentials file,
/// a kubeconfig, a source's files, a sink's file and `data_dir` are all read or
/// written only when Vector builds or runs a component, so a device does it and
/// the server never does. A Vector upgrade that changes this fails here.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn validate_and_test_open_none_of_the_paths_a_component_names() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; path guard unverified");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let pipeline = |extra: serde_json::Value,
                    source: serde_json::Value,
                    sink: serde_json::Value| {
        let mut config = json!({
            "sources": {"s": source},
            "transforms": {"t": {"type": "remap", "inputs": ["s"], "source": "."}},
            "sinks": {"k": sink},
            "tests": [{"name": "t",
                "inputs": [{"insert_at": "t", "type": "log", "log_fields": {"message": "x"}}],
                "outputs": [{"extract_from": "t", "conditions": [{"type": "vrl", "source": "true"}]}]}],
        });
        for (key, value) in extra.as_object().unwrap() {
            config[key] = value.clone();
        }
        config
    };
    let demo = json!({"type": "demo_logs", "format": "json"});
    let blackhole = json!({"type": "blackhole", "inputs": ["t"]});
    let commands: [&[&str]; 2] = [
        &["validate", "--no-environment"],
        &["test", "--config-json"],
    ];

    // Control: a file enrichment table's path is opened under a test, so a pipe
    // that stays closed below means Vector did not reach for it.
    let control = Tripwire::new(dir.path().join("control"));
    let config = pipeline(
        json!({"enrichment_tables": {"lk": {"type": "file",
            "file": {"path": control.path, "encoding": {"type": "csv"}}}}}),
        demo.clone(),
        blackhole.clone(),
    );
    let path = dir.path().join("control.json");
    std::fs::write(&path, config.to_string()).unwrap();
    vector_briefly(&vector, commands[1], &path).await;
    assert!(
        control.opened().await,
        "Vector did not open the path under a test, so this test proves nothing"
    );

    type Build = fn(&std::path::Path) -> serde_json::Value;
    let cases: Vec<(&str, Build)> = vec![
        (
            "source file include",
            |p| json!({"source": {"type": "file", "include": [p]}}),
        ),
        ("source http_server tls files", |p| {
            json!({"source": {"type": "http_server", "address": "127.0.0.1:1",
                "tls": {"enabled": true, "ca_file": p, "crt_file": p, "key_file": p}}})
        }),
        ("sink http tls ca_file", |p| {
            json!({"sink": {"type": "http", "inputs": ["t"], "uri": "http://127.0.0.1:1",
                "encoding": {"codec": "json"}, "tls": {"ca_file": p}}})
        }),
        ("source socket protobuf descriptor", |p| {
            json!({"source": {"type": "socket", "mode": "tcp", "address": "127.0.0.1:1",
                "decoding": {"codec": "protobuf", "protobuf": {"desc_file": p, "message_type": "x.Y"}}}})
        }),
        ("sink console protobuf descriptor", |p| {
            json!({"sink": {"type": "console", "inputs": ["t"],
                "encoding": {"codec": "protobuf", "protobuf": {"desc_file": p, "message_type": "x.Y"}}}})
        }),
        ("sink aws_s3 credentials file", |p| {
            json!({"sink": {"type": "aws_s3", "inputs": ["t"], "bucket": "b", "region": "us-east-1",
                "encoding": {"codec": "json"}, "auth": {"credentials_file": p}}})
        }),
        ("sink gcp_cloud_storage credentials", |p| {
            json!({"sink": {"type": "gcp_cloud_storage", "inputs": ["t"], "bucket": "b",
                "encoding": {"codec": "json"}, "credentials_path": p}})
        }),
        (
            "source kubernetes_logs kubeconfig",
            |p| json!({"source": {"type": "kubernetes_logs", "kube_config_file": p}}),
        ),
    ];
    for (index, (name, build)) in cases.into_iter().enumerate() {
        let pipe = Tripwire::new(dir.path().join(format!("pipe-{index}")));
        let parts = build(&pipe.path);
        let config = pipeline(
            json!({}),
            parts.get("source").cloned().unwrap_or_else(|| demo.clone()),
            parts
                .get("sink")
                .cloned()
                .unwrap_or_else(|| blackhole.clone()),
        );
        let path = dir.path().join("case.json");
        std::fs::write(&path, config.to_string()).unwrap();
        for args in commands {
            let (code, text) = vector_ends(&vector, args, &path, None).await;
            assert_eq!(code, Some(0), "{name}: {args:?} did not accept it: {text}");
        }
        assert!(
            !pipe.opened().await,
            "{name}: validate or test opened the path it names"
        );
    }

    // A sink's file is only created when it receives an event, and `data_dir`
    // only when a component needs it: neither command makes either.
    let made = dir.path().join("made-by-vector");
    let config = pipeline(
        json!({"data_dir": made.join("data")}),
        demo.clone(),
        json!({"type": "file", "inputs": ["t"], "path": made.join("events.json"),
            "encoding": {"codec": "json"}}),
    );
    let path = dir.path().join("made.json");
    std::fs::write(&path, config.to_string()).unwrap();
    for args in commands {
        let (code, text) = vector_ends(&vector, args, &path, None).await;
        assert_eq!(code, Some(0), "{args:?}: {text}");
    }
    assert!(
        !made.exists(),
        "validate or test created a path a draft names"
    );
}
