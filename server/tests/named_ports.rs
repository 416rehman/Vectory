//! Pinned native Vector output-port parity. Syntax/topology checks only.
use serde_json::{Value, json};

#[test]
fn conditional_named_outputs_match_pinned_vector() {
    let Ok(binary) = std::env::var("VECTORY_TEST_VECTOR") else {
        eprintln!("SKIP: VECTORY_TEST_VECTOR absent; named-port native parity unverified");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let mut cases: Vec<(String, Value, bool)> = Vec::new();
    let mut transform = |name: &str, component: Value, port: &str, expected: bool| {
        let mut component = component;
        component["inputs"] = json!(["sample"]);
        cases.push((name.into(), json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"transforms":{"process":component},"sinks":{"out":{"type":"blackhole","inputs":[format!("process{port}")]}}}), expected));
    };
    transform(
        "remap-dropped-enabled",
        json!({"type":"remap","source":".ok = true","reroute_dropped":true}),
        ".dropped",
        true,
    );
    transform(
        "remap-dropped-disabled",
        json!({"type":"remap","source":".ok = true"}),
        ".dropped",
        false,
    );
    transform(
        "exclusive-route-named",
        json!({"type":"exclusive_route","routes":[{"name":"accept","condition":"true"}]}),
        ".accept",
        true,
    );
    transform(
        "exclusive-route-unmatched",
        json!({"type":"exclusive_route","routes":[{"name":"accept","condition":"true"}]}),
        "._unmatched",
        true,
    );
    transform(
        "exclusive-route-default-absent",
        json!({"type":"exclusive_route","routes":[{"name":"accept","condition":"true"}]}),
        "",
        false,
    );
    transform(
        "route-unmatched-disabled",
        json!({"type":"route","route":{"accept":"true"},"reroute_unmatched":false}),
        "._unmatched",
        false,
    );
    transform(
        "route-unmatched-default",
        json!({"type":"route","route":{"accept":"true"}}),
        "._unmatched",
        true,
    );
    for port in ["logs", "metrics", "traces", "llmobs"] {
        let mut source =
            json!({"type":"datadog_agent","address":"127.0.0.1:19080","multiple_outputs":true});
        for enabled in [true, false] {
            source[format!("disable_{port}")] = json!(!enabled);
            cases.push((format!("datadog-{port}-{enabled}"), json!({"sources":{"sample":source},"sinks":{"out":{"type":"blackhole","inputs":[format!("sample.{port}")]}}}), enabled));
        }
    }
    cases.push(("datadog-single-default".into(), json!({"sources":{"sample":{"type":"datadog_agent","address":"127.0.0.1:19080"}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}}}), true));
    let memory = json!({"sources":{"seed":{"type":"demo_logs","format":"json"}},"enrichment_tables":{"lookup":{"type":"memory","inputs":["seed"],"source_config":{"source_key":"memory_source","export_interval":1}}},"sinks":{"out":{"type":"blackhole","inputs":["memory_source"]}}});
    cases.push(("memory-generated-source".into(), memory.clone(), true));
    let mut expired = memory.clone();
    expired["sinks"]["out"]["inputs"] = json!(["memory_source.expired"]);
    cases.push(("memory-expired-disabled".into(), expired.clone(), false));
    expired["enrichment_tables"]["lookup"]["source_config"]["export_expired_items"] = json!(true);
    cases.push(("memory-expired-enabled".into(), expired, true));
    let mut absent = memory.clone();
    absent["enrichment_tables"]["lookup"]
        .as_object_mut()
        .unwrap()
        .remove("source_config");
    cases.push(("memory-source-absent".into(), absent, false));
    let mut collision = memory.clone();
    collision["enrichment_tables"]["lookup"]["source_config"]["source_key"] = json!("seed");
    cases.push(("memory-source-collision".into(), collision, false));
    let mut missing = memory.clone();
    missing["enrichment_tables"]["lookup"]["inputs"] = json!(["missing"]);
    cases.push(("memory-missing-table-input".into(), missing, false));
    let mut sink_input = memory.clone();
    sink_input["sinks"]["out"]["inputs"] = json!(["lookup"]);
    cases.push(("memory-table-is-not-output".into(), sink_input, false));
    let mut no_sources = memory.clone();
    no_sources.as_object_mut().unwrap().remove("sources");
    cases.push((
        "memory-still-requires-top-level-source".into(),
        no_sources,
        false,
    ));
    let mut no_sinks = memory.clone();
    no_sinks.as_object_mut().unwrap().remove("sinks");
    cases.push((
        "memory-still-requires-top-level-sink".into(),
        no_sinks,
        false,
    ));
    for (name, config, expected) in cases {
        assert_eq!(
            vectory_server::validation::validate(&config)["valid"],
            expected,
            "structural: {name}"
        );
        let file = dir.path().join(format!("{name}.json"));
        std::fs::write(&file, serde_json::to_vec(&config).unwrap()).unwrap();
        let result = std::process::Command::new(&binary)
            .args([
                "validate",
                "--no-environment",
                "--skip-healthchecks",
                "--config-json",
            ])
            .arg(file)
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            expected,
            "native: {name}: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
