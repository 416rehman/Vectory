//! Functional test of the actual Vector executable. This does NOT establish container isolation.
use serde_json::json;
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
    assert!(!rejected.to_string().contains("THIS IS NOT"));
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
    child.kill().await.unwrap();
}
