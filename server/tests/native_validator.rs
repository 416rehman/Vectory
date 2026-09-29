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
