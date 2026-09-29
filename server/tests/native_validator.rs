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
#[tokio::test]
async fn legacy_worker_cannot_claim_file_path_static_check() {
    use axum::{Json, Router, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let worker = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/validate",
                post(|| async {
                    Json(json!({"valid":true,"vector_validated":false,"deferred":true,"vector_version":"0.58.0","errors":[],"warnings":[]}))
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
    assert_eq!(result["valid"], false, "{result}");
    assert_eq!(result["deferred"], true);
    assert_eq!(result["vector_validated"], false);
    assert!(result.get("static_checked").is_none());
    worker.abort();
}

#[tokio::test]
async fn real_vector_worker_accepts_and_rejects_configuration() {
    let Ok(vector) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; native validator execution unverified");
        return;
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    let mut worker = tokio::process::Command::new(env!("CARGO_BIN_EXE_vector-validator"));
    worker
        .env("VECTORY_VALIDATOR_ISOLATED", "true")
        .env("VECTORY_VECTOR_BINARY", vector)
        .env("VECTORY_VALIDATOR_ADDR", addr.to_string())
        .kill_on_drop(true);
    let mut child = worker.spawn().unwrap();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let url = format!("http://{addr}");
    let mut ready = false;
    for _ in 0..50 {
        if client.get(format!("{url}/health")).send().await.is_ok() {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(ready, "worker did not start");
    let config = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"console":{"type":"console","inputs":["sample"],"encoding":{"codec":"json"}}}});
    let accepted: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":config}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(accepted["valid"], true, "{accepted}");
    assert_eq!(accepted["vector_validated"], true);
    let invalid = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"transforms":{"broken":{"type":"remap","inputs":["sample"],"source":"THIS IS NOT VALID VRL!!!"}},"sinks":{"console":{"type":"console","inputs":["broken"],"encoding":{"codec":"json"}}}});
    let rejected: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":invalid}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rejected["valid"], false, "{rejected}");
    assert_eq!(rejected["vector_validated"], false);
    assert_eq!(
        rejected["native_issue"]["code"], "VRL_COMPILE_ERROR",
        "{rejected}"
    );
    assert!(rejected["errors"].to_string().contains("transforms.broken"));
    assert!(!rejected.to_string().contains("THIS IS NOT"));
    let mut fixture_path = invalid.clone();
    fixture_path["tests"] = json!([{"name":"Synthetic path is event data","inputs":[{"insert_at":"broken","type":"log","log_fields":{"path":"/synthetic/event.jsonl"}}],"outputs":[{"extract_from":"broken","conditions":[{"type":"vrl","source":"true"}]}]}]);
    let fixture_rejected: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":fixture_path}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(fixture_rejected["valid"], false, "{fixture_rejected}");
    assert_ne!(fixture_rejected["deferred"], true);
    assert!(!fixture_rejected.to_string().contains("THIS IS NOT"));
    // A file sink needs its final path checked on the device, but must not
    // suppress independent static checks such as VRL compilation.
    let path_fixture = tempfile::tempdir().unwrap();
    let path_only = path_fixture
        .path()
        .join("vectory-native-validation-only.jsonl")
        .to_string_lossy()
        .to_string();
    let mut with_path = json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"transforms":{"normalize":{"type":"remap","inputs":["sample"],"source":".ok = true"}},"sinks":{"out":{"type":"file","inputs":["normalize"],"path":path_only,"encoding":{"codec":"json"}}}});
    let path_checked: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":with_path}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(path_checked["valid"], true, "{path_checked}");
    assert_eq!(path_checked["static_checked"], true, "{path_checked}");
    assert_eq!(path_checked["deferred"], true);
    assert_eq!(path_checked["vector_validated"], false);
    let isolated_state = tempfile::tempdir().unwrap();
    let state = vectory_server::initialize(vectory_server::Settings {
        data_dir: isolated_state.path().join("state"),
        bootstrap_secret: "isolated-native-validation-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: isolated_state.path().join("dist"),
        releases_dir: isolated_state.path().join("releases"),
        instance_name: "Native validation test".into(),
        validation_url: Some(url.clone()),
        ..Default::default()
    })
    .await
    .unwrap();
    let public_checked = vectory_server::validation::validate_isolated(&state, &with_path)
        .await
        .unwrap();
    assert_eq!(public_checked["valid"], true, "{public_checked}");
    assert_eq!(public_checked["deferred"], true);
    assert_eq!(public_checked["vector_validated"], false);
    assert!(public_checked.get("static_checked").is_none());
    with_path["transforms"]["normalize"]["source"] = json!("THIS IS NOT VALID VRL!!!");
    let path_rejected: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":with_path}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(path_rejected["valid"], false, "{path_rejected}");
    assert_eq!(path_rejected["static_checked"], true, "{path_rejected}");
    assert_eq!(path_rejected["deferred"], true);
    assert!(!path_rejected.to_string().contains("THIS IS NOT"));
    let public_rejected = vectory_server::validation::validate_isolated(&state, &with_path)
        .await
        .unwrap();
    assert_eq!(public_rejected["valid"], false, "{public_rejected}");
    assert_eq!(public_rejected["deferred"], true);
    assert_eq!(public_rejected["vector_validated"], false);
    assert!(
        public_rejected["errors"]
            .to_string()
            .contains("transforms.normalize")
    );
    assert!(public_rejected.get("static_checked").is_none());
    assert!(!public_rejected.to_string().contains("THIS IS NOT"));
    // Device-local paths (data_dir, file globs, TLS files) must not suppress VRL
    // compilation: a fallible route condition is caught before publication.
    let mut device_paths = json!({"data_dir":"/var/lib/vector","sources":{"logs":{"type":"file","include":["/var/log/app/*.log"]}},"transforms":{"by_status":{"type":"route","inputs":["logs"],"route":{"errors":".status >= 500"}}},"sinks":{"out":{"type":"http","inputs":["by_status.errors"],"uri":"https://collector.example.test/ingest","encoding":{"codec":"json"},"tls":{"ca_file":"/etc/vector/ca.pem"}}}});
    let device_rejected = vectory_server::validation::validate_isolated(&state, &device_paths)
        .await
        .unwrap();
    assert_eq!(device_rejected["valid"], false, "{device_rejected}");
    assert_eq!(device_rejected["deferred"], true);
    assert!(
        device_rejected["errors"]
            .to_string()
            .contains("transforms.by_status"),
        "{device_rejected}"
    );
    device_paths["transforms"]["by_status"]["route"]["errors"] =
        json!("(int(.status) ?? 0) >= 500");
    let device_accepted = vectory_server::validation::validate_isolated(&state, &device_paths)
        .await
        .unwrap();
    assert_eq!(device_accepted["valid"], true, "{device_accepted}");
    assert_eq!(device_accepted["deferred"], true);
    assert_eq!(device_accepted["vector_validated"], false);
    let unknown: serde_json::Value = client.post(format!("{url}/validate")).json(&json!({"config":{"sources":{"input":{"type":"not_a_real_vector_type"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(
        unknown["valid"], false,
        "Unknown types must not be silently deferred"
    );
    assert_eq!(
        unknown["native_issue"]["code"], "UNKNOWN_VARIANT",
        "{unknown}"
    );
    assert!(unknown["errors"].to_string().contains("sources.input"));
    assert_ne!(unknown["deferred"], true);
    let missing: serde_json::Value = client
        .post(format!("{url}/validate"))
        .json(&json!({"config":{"sources":{"input":{"type":"file"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}}}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(missing["valid"], false, "{missing}");
    assert_eq!(
        missing["native_issue"],
        json!({"code":"REQUIRED_FIELD","section":"sources","component":"input","field":"include"})
    );
    assert!(
        missing["errors"]
            .to_string()
            .contains("required setting `include`")
    );
    let platform: serde_json::Value = client.post(format!("{url}/validate")).json(&json!({"config":{"sources":{"input":{"type":"journald"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(platform["valid"], true);
    assert_eq!(platform["deferred"], true);
    assert!(
        platform["deferred_reasons"]
            .to_string()
            .contains("platform-specific source journald")
    );
    // The six pinned Unix transport projections all require a device-local path.
    // They must not be rejected by a Windows worker or reported as native-validated.
    // This establishes truthful deferral, not Unix runtime compatibility.
    for (kind, component, mode) in [
        ("sources", "socket", "unix_datagram"),
        ("sources", "socket", "unix_stream"),
        ("sources", "syslog", "unix"),
        ("sources", "fluent", "unix"),
        ("sources", "statsd", "unix"),
        ("sinks", "statsd", "unix"),
    ] {
        let mut projected = if kind == "sources" {
            json!({"sources":{"input":{"type":component,"mode":mode,"path":"/tmp/vectory-review.sock"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}}})
        } else {
            json!({"sources":{"input":{"type":"internal_metrics"}},"sinks":{"out":{"type":component,"mode":mode,"path":"/tmp/vectory-review.sock","inputs":["input"]}}})
        };
        for endpoint in ["validate", "tests"] {
            let deferred: serde_json::Value = client
                .post(format!("{url}/{endpoint}"))
                .json(&json!({"config":projected}))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(
                deferred["deferred"], true,
                "{kind}/{component}/{mode}: {deferred}"
            );
            assert_eq!(deferred["vector_validated"], false);
            assert_eq!(deferred["valid"], endpoint == "validate");
            assert_eq!(
                deferred["deferred_reasons"],
                json!(["device-local paths or external code files"])
            );
            if endpoint == "tests" {
                assert_eq!(deferred["tests_run"], false);
            }
        }
        let id = if kind == "sources" { "input" } else { "out" };
        projected[kind][id].as_object_mut().unwrap().remove("path");
        assert!(
            !vectory_server::validation::needs_device_context(&projected),
            "A transport mode alone must not hide missing required fields from native validation"
        );
    }
    let transformed:serde_json::Value=client.post(format!("{url}/vrl-test")).json(&json!({"program":".message = upcase!(.message)","sample":{"message":"synthetic only"}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(transformed["valid"], true, "{transformed}");
    assert_eq!(transformed["output"]["message"], "SYNTHETIC ONLY");
    let denied: serde_json::Value = client
        .post(format!("{url}/vrl-test"))
        .json(&json!({"program":".secret = get_env_var!(\"SECRET\")","sample":{}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(denied["valid"], false);
    let mut tested = json!({
        "timezone":"UTC","sources":{"sample_one":{"type":"demo_logs","format":"json"}},
        "transforms":{"normalize":{"type":"remap","inputs":["sample_*"],"source":".message = upcase!(.message)"}},
        "sinks":{"out":{"type":"blackhole","inputs":["normal*"]}},
        "tests":[{"name":"Uppercase message","inputs":[{"insert_at":"normalize","type":"log","log_fields":{"message":"synthetic","path":"/synthetic/event.jsonl"}}],"outputs":[{"extract_from":"normalize","conditions":[{"type":"vrl","source":".message == \"SYNTHETIC\""}]}]}]
    });
    let test_result: serde_json::Value = client
        .post(format!("{url}/tests"))
        .json(&json!({"config":tested}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(test_result["valid"], true, "{test_result}");
    assert_eq!(test_result["tests_run"], true);
    assert!(!test_result.to_string().contains("SYNTHETIC"));
    let without_tests: serde_json::Value = client
        .post(format!("{url}/tests"))
        .json(&json!({"config":{"sources":{"sample_one":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["sample_one"]}}}}))
        .send().await.unwrap().json().await.unwrap();
    assert_eq!(without_tests["valid"], false);
    assert_eq!(without_tests["tests_run"], false);
    tested["tests"][0]["outputs"][0]["conditions"][0]["source"] =
        json!(".message == \"INTENTIONAL_FAILED_EXPECTATION\"");
    let failed: serde_json::Value = client
        .post(format!("{url}/tests"))
        .json(&json!({"config":tested}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(failed["valid"], false, "{failed}");
    assert_eq!(failed["tests_run"], true);
    assert_eq!(
        failed["native_issue"]["code"], "PIPELINE_TEST_FAILED",
        "{failed}"
    );
    assert!(
        !failed
            .to_string()
            .contains("INTENTIONAL_FAILED_EXPECTATION")
    );
    let local = json!({"provider":{"type":"http","url":"http://127.0.0.1:1/SHOULD_NEVER_RESOLVE"},"secret":{"device":{"type":"exec","command":["SHOULD_NEVER_EXECUTE"]}}});
    for endpoint in ["validate", "tests"] {
        let deferred: serde_json::Value = client
            .post(format!("{url}/{endpoint}"))
            .json(&json!({"config":local}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(deferred["deferred"], true, "{deferred}");
        assert_eq!(deferred["vector_validated"], false);
        assert!(!deferred.to_string().contains("SHOULD_NEVER"));
        if endpoint == "tests" {
            assert_eq!(deferred["tests_run"], false);
            assert_eq!(deferred["valid"], false);
        }
    }
    child.kill().await.unwrap();
}
