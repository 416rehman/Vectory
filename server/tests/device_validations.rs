//! Check on devices: an operator asks the target devices to validate a
//! candidate pipeline version on their own hosts before deploying it. Real
//! previews, real check-ins and real artifact downloads feed every assertion;
//! the answer of a device never changes desired state, a generation, policy or
//! an issue.
use axum::{
    Extension, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Duration;
use tokio::sync::oneshot;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize, validation};

const PIPELINE: &str = "00000000-0000-4000-8000-000000000a01";

fn declared() -> Value {
    json!([{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}])
}

fn pipeline(max_events: i64) -> Value {
    json!({
        "sources":{"in":{"type":"demo_logs","format":"json","interval":1}},
        "sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"max_events":max_events,"type":"memory"}}}
    })
}

struct Who {
    id: String,
    cookie: String,
    csrf: String,
}

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    app: Router,
    admin: Who,
    operator: Who,
    ids: Vec<String>,
}

async fn user(state: &State, role: &str) -> Who {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Synthetic {role}"))
    .bind(role)
    .bind("unused-test-hash")
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
    Who {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}

/// An enrolled device that checked in `seen` (None: never).
async fn insert_device(state: &State, name: &str, seen: Option<String>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let data = json!({
        "id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0",
        "configuration_mode":"full","last_seen":seen,"apply_state":"unmanaged",
        "reported_generation":0,"actual_sha256":null,"labels":{},"created_at":db::now()
    });
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(data.to_string())
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)",
    )
    .bind(format!("credential-{id}"))
    .bind(&id)
    .bind("2099-01-01T00:00:00Z")
    .bind(state.keys.active_signing_id())
    .execute(&state.pool)
    .await
    .unwrap();
    id
}

async fn fixture(devices: usize) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-device-validation-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Synthetic device check fixture".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = user(&state, "admin").await;
    let operator = user(&state, "operator").await;
    let mut conn = state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "configuration",
        &json!({"id":PIPELINE,"name":"Edge syslog","description":"","revision":1,"graph":{"nodes":[],"edges":[]},"config":{},"variables":[],"archived":false,"created_at":db::now(),"updated_at":db::now()}),
    )
    .await
    .unwrap();
    drop(conn);
    let mut ids = Vec::new();
    for index in 0..devices {
        ids.push(insert_device(&state, &format!("edge-{index:02}"), Some(db::now())).await);
    }
    Fixture {
        _temp: temp,
        app: api::router(state.clone()),
        state,
        admin,
        operator,
        ids,
    }
}

/// A published version as the publish route stores it.
async fn insert_version(state: &State, number: i64, config: &Value, declarations: Value) -> String {
    let artifact = validation::render(config).unwrap();
    version_with(state, number, config, declarations, artifact).await
}

async fn version_with(
    state: &State,
    number: i64,
    config: &Value,
    declarations: Value,
    artifact: String,
) -> String {
    let id = db::id();
    let mut conn = state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "version",
        &json!({
            "id":id,"configuration_id":PIPELINE,"number":number,"config":config,
            "variables":declarations,"artifact":artifact,"sha256":db::hash(&artifact),
            "size":artifact.len(),"created_at":db::now(),"uses_local_secrets":false
        }),
    )
    .await
    .unwrap();
    id
}

async fn send(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    who: Option<&Who>,
) -> (StatusCode, HeaderMap, Value) {
    send_with(
        app,
        method,
        path,
        body,
        who.map(|w| (w.cookie.as_str(), Some(w.csrf.as_str()))),
    )
    .await
}

/// Like `send`, with the cookie and CSRF token given separately so a test can
/// leave one out.
async fn send_with(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    session: Option<(&str, Option<&str>)>,
) -> (StatusCode, HeaderMap, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some((cookie, csrf)) = session {
        request = request.header("cookie", cookie);
        if let Some(csrf) = csrf {
            request = request.header("x-csrf-token", csrf);
        }
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)})),
    )
}

fn agent(f: &Fixture, device: &str) -> Router {
    device::router(f.state.clone()).layer(Extension(device::PeerCertificate(Some(format!(
        "credential-{device}"
    )))))
}

/// A check-in as the agent sends it: the status, the exact signed payload text
/// and its JSON.
async fn heartbeat(f: &Fixture, device: &str, extra: Value) -> (StatusCode, String, Value) {
    let mut body = json!({
        "protocol_version":1,"request_id":"r","boot_id":"b","nonce":STANDARD.encode([3; 32]),
        "agent_version":"test","vector_version":"0.58.0","reported_generation":0,
        "policy_generation":0,"actual_sha256":"","apply_state":"unmanaged",
        "local_paused":false,"remote_pause_acknowledged":false,"configuration_mode":"full"
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        body[key] = value.clone();
    }
    let (status, _, envelope) =
        send(&agent(f, device), "POST", "/agent/v1/heartbeat", body, None).await;
    if status != StatusCode::OK {
        return (status, String::new(), envelope);
    }
    let payload = String::from_utf8(
        STANDARD
            .decode(envelope["payload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let manifest = serde_json::from_str(&payload).unwrap();
    (status, payload, manifest)
}

/// A check-in that announces the feature; returns the manifest.
async fn announce(f: &Fixture, device: &str) -> Value {
    let (status, _, manifest) =
        heartbeat(f, device, json!({"agent_features":["validation"]})).await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    manifest
}

async fn fetch(f: &Fixture, device: &str, sha256: &str) -> (StatusCode, Vec<u8>) {
    let response = agent(f, device)
        .oneshot(
            Request::builder()
                .uri(format!("/agent/v1/artifacts/{sha256}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}

fn review(devices: &[&String], version: &str) -> Value {
    json!({
        "version_id":version,
        "selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},
        "priority":10,"target_mode":"snapshot",
        "rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}
    })
}

/// A preview that asks for a check, as `who`.
async fn ask(
    f: &Fixture,
    who: &Who,
    devices: &[&String],
    version: &str,
    extra: Value,
) -> (StatusCode, HeaderMap, Value) {
    let mut body = review(devices, version);
    body["device_validation"] = json!(true);
    for (key, value) in extra.as_object().into_iter().flatten() {
        body[key] = value.clone();
    }
    send(
        &f.app,
        "POST",
        "/api/v1/deployments/preview",
        body,
        Some(who),
    )
    .await
}

async fn read(f: &Fixture, who: &Who, id: &str) -> (StatusCode, Value) {
    let (status, _, body) = send(
        &f.app,
        "GET",
        &format!("/api/v1/device-validations/{id}"),
        Value::Null,
        Some(who),
    )
    .await;
    (status, body)
}

fn entry<'a>(check: &'a Value, device: &str) -> &'a Value {
    check["devices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == device)
        .unwrap_or_else(|| panic!("{device} is not in {check}"))
}

fn digest_of(preview: &Value, device: &str) -> (String, i64) {
    let found = preview["artifact_previews"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["device_id"] == device)
        .unwrap();
    (
        found["sha256"].as_str().unwrap().to_owned(),
        found["size"].as_i64().unwrap(),
    )
}

/// Everything a device's answer must leave alone.
async fn untouched(
    f: &Fixture,
) -> (
    Vec<(String, Option<String>, i64, String, i64)>,
    i64,
    i64,
    i64,
) {
    let devices = sqlx::query("SELECT id,desired_version_id,desired_generation,policy,policy_generation FROM devices ORDER BY id")
        .fetch_all(&f.state.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row.get::<String, _>("id"),
                row.get::<Option<String>, _>("desired_version_id"),
                row.get::<i64, _>("desired_generation"),
                row.get::<String, _>("policy"),
                row.get::<i64, _>("policy_generation"),
            )
        })
        .collect();
    let count = |sql: &'static str| {
        let pool = f.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    (
        devices,
        count("SELECT count(*) FROM records WHERE kind='issue'").await,
        count("SELECT count(*) FROM deployment_targets").await,
        count("SELECT count(*) FROM desired_artifacts").await,
    )
}

fn passed() -> Value {
    json!({"valid":true,"diagnostics":[],"tests":[],"duration_ms":820,"secrets_missing":[]})
}

fn with_id(id: &str, mut result: Value) -> Value {
    result["id"] = json!(id);
    json!({"validation_result":result})
}

/// Every row of a check: device, recorded state and the candidate bytes it holds.
async fn rows(f: &Fixture, id: &str) -> Vec<(String, String, Option<i64>)> {
    sqlx::query("SELECT device_id,state,length(artifact) AS bytes FROM device_validations WHERE id=? ORDER BY device_id")
        .bind(id)
        .fetch_all(&f.state.pool)
        .await
        .unwrap()
        .into_iter()
        .map(|row| (row.get("device_id"), row.get("state"), row.get("bytes")))
        .collect()
}

/// One device's row of a check.
async fn row(f: &Fixture, id: &str, device: &str) -> (String, String, Option<i64>) {
    rows(f, id)
        .await
        .into_iter()
        .find(|row| row.0 == device)
        .unwrap_or_else(|| panic!("{device} has no row in {id}"))
}

#[tokio::test]
async fn a_check_runs_from_request_to_answer_and_changes_nothing_else() {
    let f = fixture(2).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let (a, b) = (&f.ids[0], &f.ids[1]);
    announce(&f, a).await;
    announce(&f, b).await;
    let before = untouched(&f).await;

    // Each device is reviewed with its own value for the variable.
    let (status, _, preview) = ask(
        &f,
        &f.operator,
        &[a, b],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{b:{"max_events":700}}},"run_tests":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    assert_eq!(preview["validation_truncated"], false);
    // The preview's own fields are untouched.
    assert!(preview["devices"].as_array().unwrap().len() == 2 && preview["blockers"] == json!([]));
    let (sha_a, size_a) = digest_of(&preview, a);
    let (sha_b, size_b) = digest_of(&preview, b);
    assert_ne!(sha_a, sha_b, "each device is checked with its own bytes");

    // Both devices are pending, the check runs, and it is the requester's.
    let (status, check) = read(&f, &f.operator, &id).await;
    assert_eq!(status, StatusCode::OK, "{check}");
    assert_eq!(check["id"], id);
    assert_eq!(
        (
            check["state"].clone(),
            check["run_tests"].clone(),
            check["truncated"].clone()
        ),
        (json!("running"), json!(true), json!(false))
    );
    assert_eq!(entry(&check, a)["state"], "pending");
    assert_eq!(entry(&check, b)["name"], "edge-01");
    let created =
        chrono::DateTime::parse_from_rfc3339(check["created_at"].as_str().unwrap()).unwrap();
    let expires =
        chrono::DateTime::parse_from_rfc3339(check["expires_at"].as_str().unwrap()).unwrap();
    assert_eq!((expires - created).num_seconds(), 600);

    // The signed manifest carries the check, bound to this device and nonce.
    let (status, payload, manifest) =
        heartbeat(&f, a, json!({"agent_features":["validation"]})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(manifest["device_id"], *a);
    assert_eq!(manifest["nonce"], STANDARD.encode([3; 32]));
    assert_eq!(
        manifest["validation"],
        json!({"id":id,"sha256":sha_a,"size":size_a,"artifact_path":format!("/agent/v1/artifacts/{sha_a}"),"run_tests":true,"expires_at":check["expires_at"]})
    );
    assert!(payload.contains("\"validation\":{"));
    assert!(
        manifest["features"]
            .as_array()
            .unwrap()
            .contains(&json!("validation"))
    );
    // It changes no generation, no desired state and no policy.
    assert!(
        manifest["desired"].is_null()
            && manifest["generation"] == 0
            && manifest["policy_generation"] == 0
    );

    // The device downloads exactly its own candidate: its value applied, the
    // digest and size the manifest named.
    let (status, bytes) = fetch(&f, a, &sha_a).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (db::hash(&bytes), bytes.len() as i64),
        (sha_a.clone(), size_a)
    );
    let candidate: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(candidate["sinks"]["out"]["buffer"]["max_events"], 600);
    let (status, bytes) = fetch(&f, b, &sha_b).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (db::hash(&bytes), bytes.len() as i64),
        (sha_b.clone(), size_b)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["sinks"]["out"]["buffer"]["max_events"],
        700
    );

    // The device reports its answer; the next manifest no longer carries the check.
    let (status, _, manifest) = heartbeat(
        &f,
        a,
        json!({"agent_features":["validation"],"validation_result":{"id":id,"valid":true,"diagnostics":[],"tests":[{"name":"routes errors","passed":true}],"duration_ms":820,"secrets_missing":[]}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    assert!(manifest.get("validation").is_none(), "{manifest}");
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(check["state"], "running", "device b has not answered");
    let answered = entry(&check, a);
    assert_eq!(answered["state"], "passed");
    assert_eq!(answered["valid"], true);
    assert_eq!(answered["duration_ms"], 820);
    assert_eq!(
        answered["tests"],
        json!([{"name":"routes errors","passed":true}])
    );
    assert_eq!(answered["diagnostics"], json!([]));
    assert_eq!(answered["secrets_missing"], json!([]));
    // An answered check authorizes nothing, and its bytes are gone.
    assert_eq!(fetch(&f, a, &sha_a).await.0, StatusCode::FORBIDDEN);
    assert_eq!(row(&f, &id, a).await, (a.clone(), "passed".into(), None));

    // The other device fails and says why; the check is complete.
    let (status, _, manifest) = heartbeat(
        &f,
        b,
        json!({"agent_features":["validation"],"validation_result":{"id":id,"valid":false,"diagnostics":[
            {"severity":"warning","code":"HEALTHCHECK_FAILED","component_id":"out","message":"The health check failed."},
            {"severity":"error","code":"SECRET_BINDING_MISSING","component_id":"out","field":"auth.password","message":"A device secret is not bound.","hint":"Run vectory configure-secrets."}
        ],"tests":[],"duration_ms":40,"secrets_missing":["TOKEN","API_KEY"]}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(check["state"], "complete");
    let failed = entry(&check, b);
    assert_eq!(
        (failed["state"].clone(), failed["valid"].clone()),
        (json!("failed"), json!(false))
    );
    // Errors first, names sorted.
    assert_eq!(failed["diagnostics"][0]["code"], "SECRET_BINDING_MISSING");
    assert_eq!(failed["diagnostics"][1]["code"], "HEALTHCHECK_FAILED");
    assert_eq!(failed["secrets_missing"], json!(["API_KEY", "TOKEN"]));

    // No deployment, desired state, generation, policy or issue changed.
    assert_eq!(untouched(&f).await, before);
}

#[tokio::test]
async fn a_device_reads_only_its_own_candidate_and_answers_only_its_own_check() {
    let f = fixture(3).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let (a, b, c) = (&f.ids[0], &f.ids[1], &f.ids[2]);
    for device in [a, b, c] {
        announce(&f, device).await;
    }
    // A and B are checked with different bytes; C is not part of the check.
    let (_, _, preview) = ask(
        &f,
        &f.operator,
        &[a, b],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{b:{"max_events":700}}}}),
    )
    .await;
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    let (sha_a, _) = digest_of(&preview, a);
    let (sha_b, _) = digest_of(&preview, b);
    assert_eq!(fetch(&f, a, &sha_a).await.0, StatusCode::OK);
    assert_eq!(fetch(&f, b, &sha_b).await.0, StatusCode::OK);
    // Another device's candidate is refused, whoever asks, with the refusal an
    // unrelated digest gets.
    assert_eq!(fetch(&f, b, &sha_a).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fetch(&f, a, &sha_b).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fetch(&f, c, &sha_a).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fetch(&f, c, &sha_b).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fetch(&f, c, &"0".repeat(64)).await.0, StatusCode::FORBIDDEN);
    // A device outside the check cannot answer it, and a device cannot answer
    // for another: both are ignored, not errors, and change nothing.
    let (status, _, manifest) = heartbeat(&f, c, with_id(&id, passed())).await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    assert!(manifest.get("validation").is_none());
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(check["state"], "running");
    assert!(
        check["devices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["state"] == "pending")
    );
    // A's own answer counts only for A.
    heartbeat(&f, a, with_id(&id, passed())).await;
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["state"], "passed");
    assert_eq!(entry(&check, b)["state"], "pending");
    // An answer repeated is ignored, never an error, and never overwrites.
    let (status, _, _) = heartbeat(
        &f,
        a,
        with_id(
            &id,
            json!({"valid":false,"diagnostics":[{"severity":"error","code":"X","message":"late"}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["valid"], true);
    assert_eq!(entry(&check, a)["diagnostics"], json!([]));
    // An unknown ID is ignored the same way.
    let (status, _, _) = heartbeat(&f, b, with_id(&db::id(), passed())).await;
    assert_eq!(status, StatusCode::OK);
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, b)["state"], "pending");
}

#[tokio::test]
async fn an_expired_check_stops_authorizing_and_a_late_answer_is_ignored() {
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let (_, _, preview) = ask(
        &f,
        &f.operator,
        &[a],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    let (sha, _) = digest_of(&preview, a);
    assert_eq!(fetch(&f, a, &sha).await.0, StatusCode::OK);
    assert!(announce(&f, a).await.get("validation").is_some());

    // Time passes: the check ran out ten minutes after it began.
    let past = (chrono::Utc::now() - chrono::Duration::seconds(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query("UPDATE device_validations SET expires_at=? WHERE id=?")
        .bind(&past)
        .bind(&id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(fetch(&f, a, &sha).await.0, StatusCode::FORBIDDEN);
    assert!(announce(&f, a).await.get("validation").is_none());
    // The dashboard reads it expired and complete before any job has run.
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(check["state"], "complete");
    assert_eq!(entry(&check, a)["state"], "expired");
    assert_eq!(entry(&check, a)["updated_at"], past);
    assert!(entry(&check, a).get("valid").is_none());
    // A late answer is ignored: the check stays expired, with no verdict.
    let (status, _, _) = heartbeat(&f, a, with_id(&id, passed())).await;
    assert_eq!(status, StatusCode::OK);
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["state"], "expired");
    assert!(entry(&check, a).get("valid").is_none());
    // The retention job records the expiry and clears the bytes.
    assert_eq!(row(&f, &id, a).await.1, "pending");
    vectory_server::rollout::prune(&f.state).await.unwrap();
    assert_eq!(row(&f, &id, a).await, (a.clone(), "expired".into(), None));
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["updated_at"], past);
}

#[tokio::test]
async fn a_newer_check_supersedes_the_older_pending_one_of_the_same_device() {
    let f = fixture(2).await;
    let first = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let second = insert_version(&f.state, 2, &pipeline(900), declared()).await;
    let (a, b) = (&f.ids[0], &f.ids[1]);
    announce(&f, a).await;
    announce(&f, b).await;
    let (_, _, one) = ask(
        &f,
        &f.operator,
        &[a, b],
        &first,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let (_, _, two) = ask(
        &f,
        &f.admin,
        &[a],
        &second,
        json!({"variable_bindings":{"defaults":{"max_events":900},"devices":{}}}),
    )
    .await;
    let (old, new) = (
        one["validation_id"].as_str().unwrap().to_owned(),
        two["validation_id"].as_str().unwrap().to_owned(),
    );
    assert_ne!(old, new);
    let (sha_old, _) = digest_of(&one, a);
    let (sha_new, _) = digest_of(&two, a);
    assert_ne!(sha_old, sha_new);
    // A's older check ended when the newer one began; B's was not touched.
    let (_, check) = read(&f, &f.operator, &old).await;
    assert_eq!(entry(&check, a)["state"], "expired");
    assert_eq!(entry(&check, b)["state"], "pending");
    assert_eq!(check["state"], "running");
    // The device is asked for the newer candidate only, and only that one downloads.
    let manifest = announce(&f, a).await;
    assert_eq!(manifest["validation"]["id"], new);
    assert_eq!(manifest["validation"]["sha256"], sha_new);
    assert_eq!(fetch(&f, a, &sha_old).await.0, StatusCode::FORBIDDEN);
    assert_eq!(fetch(&f, a, &sha_new).await.0, StatusCode::OK);
    // At most one pending check per device, enforced by the database too.
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM device_validations WHERE device_id=? AND state='pending'",
    )
    .bind(a)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(pending, 1);
    let second_pending = sqlx::query("INSERT INTO device_validations(id,device_id,device_name,configuration_id,version_id,sha256,size,run_tests,requested_by,created_at,expires_at,state,artifact,updated_at) VALUES(?,?,?,?,?,?,1,0,'u','t','t','pending',x'61',?)")
        .bind(db::id())
        .bind(a)
        .bind("edge-00")
        .bind(PIPELINE)
        .bind(&first)
        .bind("a".repeat(64))
        .bind("t")
        .execute(&f.state.pool)
        .await;
    assert!(
        second_pending.is_err(),
        "a second pending check for one device was stored"
    );
}

#[tokio::test]
async fn six_checks_a_minute_per_user_and_ordinary_previews_are_not_counted() {
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let bindings = json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}});
    for attempt in 0..6 {
        let (status, _, body) = ask(&f, &f.operator, &[a], &version, bindings.clone()).await;
        assert_eq!(status, StatusCode::OK, "attempt {attempt}: {body}");
    }
    let (status, headers, body) = ask(&f, &f.operator, &[a], &version, bindings.clone()).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "RATE_LIMITED");
    assert!(
        headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|seconds| (1..=60).contains(&seconds))
    );
    // The refused request created nothing: the sixth check is still the pending one.
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT id) FROM device_validations WHERE state='pending'",
    )
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(pending, 1);
    // Previews that ask for no check have no such limit.
    for _ in 0..8 {
        let mut body = review(&[a], &version);
        body["variable_bindings"] = bindings["variable_bindings"].clone();
        let (status, _, body) = send(
            &f.app,
            "POST",
            "/api/v1/deployments/preview",
            body,
            Some(&f.operator),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.get("validation_id").is_none() && body.get("validation_truncated").is_none());
    }
    // Another user has a budget of their own.
    let (status, _, body) = ask(&f, &f.admin, &[a], &version, bindings).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn roles_csrf_and_who_may_read_a_check() {
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let bindings = json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}});
    let viewer = user(&f.state, "viewer").await;
    let editor = user(&f.state, "editor").await;
    let other_operator = user(&f.state, "operator").await;
    // Asking needs an operator (or an administrator), a session and a CSRF token.
    for who in [&viewer, &editor] {
        let (status, _, _) = ask(&f, who, &[a], &version, bindings.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let mut body = review(&[a], &version);
    body["device_validation"] = json!(true);
    body["variable_bindings"] = bindings["variable_bindings"].clone();
    let path = "/api/v1/deployments/preview";
    let (status, _, _) = send_with(&f.app, "POST", path, body.clone(), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        path,
        body.clone(),
        Some((&f.operator.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        path,
        body.clone(),
        Some((&f.operator.cookie, Some("wrong"))),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let none: i64 = sqlx::query_scalar("SELECT count(*) FROM device_validations")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(none, 0, "a refused request created a check");
    let (status, _, preview) = ask(&f, &f.operator, &[a], &version, bindings).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let id = preview["validation_id"].as_str().unwrap();

    // Reading: the creator and an administrator; another operator gets what an
    // unknown ID gets; a viewer and an editor are refused by role.
    assert_eq!(read(&f, &f.operator, id).await.0, StatusCode::OK);
    assert_eq!(read(&f, &f.admin, id).await.0, StatusCode::OK);
    let (status, hidden) = read(&f, &other_operator, id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (unknown_status, unknown) = read(&f, &other_operator, &db::id()).await;
    assert_eq!((unknown_status, &unknown), (StatusCode::NOT_FOUND, &hidden));
    for who in [&viewer, &editor] {
        assert_eq!(read(&f, who, id).await.0, StatusCode::FORBIDDEN);
    }
    let (status, _, _) = send_with(
        &f.app,
        "GET",
        &format!("/api/v1/device-validations/{id}"),
        Value::Null,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Strict reads: a malformed ID and any query parameter are refused.
    assert_eq!(
        read(&f, &f.operator, "not-a-uuid").await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, _, _) = send(
        &f.app,
        "GET",
        &format!("/api/v1/device-validations/{id}?extra=1"),
        Value::Null,
        Some(&f.operator),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // The response says nothing the wire does not.
    let (_, check) = read(&f, &f.operator, id).await;
    let mut keys: Vec<_> = check.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "created_at",
            "devices",
            "expires_at",
            "id",
            "run_tests",
            "state",
            "truncated"
        ]
    );
    let mut keys: Vec<_> = check["devices"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "diagnostics",
            "id",
            "name",
            "secrets_missing",
            "state",
            "tests",
            "updated_at"
        ]
    );
}

#[tokio::test]
async fn results_are_bounded_and_an_oversized_one_refuses_the_whole_heartbeat() {
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let (_, _, preview) = ask(
        &f,
        &f.operator,
        &[a],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    // Close to the 512-byte bound of one diagnostic, under it.
    let diagnostic = |n: usize| json!({"severity":"error","code":"INVALID_ADDRESS","component_id":"in","field":"address","message":format!("{n:02} {}", "m".repeat(197)),"hint":"h".repeat(150)});
    let name = |n: usize| format!("{n}-{}", "t".repeat(190));
    // One too many diagnostics, tests or names, or an overlong text: refused,
    // and the heartbeat's other changes are not kept.
    let long = "x".repeat(513);
    for oversized in [
        json!({"diagnostics":(0..21).map(diagnostic).collect::<Vec<_>>()}),
        json!({"tests":(0..101).map(|n| json!({"name":name(n),"passed":true})).collect::<Vec<_>>()}),
        json!({"tests":[{"name":"t","passed":false,"message":long}]}),
        json!({"tests":[{"name":"t".repeat(201),"passed":false}]}),
        json!({"secrets_missing":(0..65).map(|n| format!("S{n}")).collect::<Vec<_>>()}),
        json!({"diagnostics":[{"severity":"error","code":"X","message":"m","extra":"unknown key"}]}),
        json!({"surprise":true}),
    ] {
        let mut result = json!({"valid":false});
        for (key, value) in oversized.as_object().unwrap() {
            result[key] = value.clone();
        }
        let mut body = with_id(&id, result);
        body["agent_version"] = json!("changed-by-the-refused-heartbeat");
        let (status, _, error) = heartbeat(&f, a, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{oversized}");
        assert_eq!(error["error"]["code"], "INVALID_INPUT");
    }
    let agent_version: String =
        sqlx::query_scalar("SELECT json_extract(data,'$.agent_version') FROM devices WHERE id=?")
            .bind(a)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(
        agent_version, "test",
        "a refused heartbeat changed the device"
    );
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["state"], "pending");

    // The largest valid answer is kept, whole and bounded.
    let result = json!({
        "valid":false,
        "diagnostics":(0..20).map(diagnostic).collect::<Vec<_>>(),
        "tests":(0..100).map(|n| json!({"name":name(n),"passed":n % 2 == 0,"not_run":n % 3 == 0,"message":"m".repeat(512)})).collect::<Vec<_>>(),
        "duration_ms":86_400_000u64,
        "secrets_missing":(0..64).map(|n| format!("SECRET_{n:02}")).collect::<Vec<_>>(),
    });
    let (status, _, body) = heartbeat(&f, a, with_id(&id, result)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, check) = read(&f, &f.operator, &id).await;
    let kept = entry(&check, a);
    assert_eq!(kept["state"], "failed");
    assert_eq!(kept["diagnostics"].as_array().unwrap().len(), 20);
    assert_eq!(kept["tests"].as_array().unwrap().len(), 100);
    assert_eq!(kept["secrets_missing"].as_array().unwrap().len(), 64);
    assert_eq!(kept["duration_ms"], 86_400_000u64);
    let stored: i64 =
        sqlx::query_scalar("SELECT length(result_json) FROM device_validations WHERE id=?")
            .bind(&id)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert!(stored < 131_072, "stored {stored} bytes");
}

#[tokio::test]
async fn an_unannounced_or_offline_device_is_never_waited_for() {
    let f = fixture(0).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let current = insert_device(&f.state, "a-current", Some(db::now())).await;
    let old = insert_device(&f.state, "b-old", Some("2020-01-01T00:00:00Z".into())).await;
    let never = insert_device(&f.state, "c-never", None).await;
    let announced = insert_device(&f.state, "d-announced", Some(db::now())).await;
    // The announcing device checks in with the feature; the others do not (and
    // one that announced but went quiet is offline, not unsupported).
    announce(&f, &announced).await;
    sqlx::query("UPDATE devices SET data=json_set(data,'$.agent_features',json('[\"validation\"]')) WHERE id=?")
        .bind(&old)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (status, _, preview) = ask(
        &f,
        &f.operator,
        &[&current, &old, &never, &announced],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let id = preview["validation_id"].as_str().unwrap();
    let (_, check) = read(&f, &f.operator, id).await;
    assert_eq!(entry(&check, &current)["state"], "unsupported");
    assert_eq!(entry(&check, &old)["state"], "offline");
    assert_eq!(entry(&check, &never)["state"], "offline");
    assert_eq!(entry(&check, &announced)["state"], "pending");
    assert_eq!(check["state"], "running");
    // Only the device that can answer holds bytes; the rest answered at creation.
    let held = rows(&f, id).await;
    assert_eq!(
        held.iter().filter(|(_, _, bytes)| bytes.is_some()).count(),
        1
    );
    // An unsupported agent is never sent the check, and cannot fetch it.
    let (_, _, manifest) = heartbeat(&f, &current, json!({})).await;
    assert!(manifest.get("validation").is_none());
    let (sha, _) = digest_of(&preview, &announced);
    assert_eq!(fetch(&f, &current, &sha).await.0, StatusCode::FORBIDDEN);
    // When it is the only device, an unsupported one completes the check at once.
    let (_, _, alone) = ask(
        &f,
        &f.operator,
        &[&current],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let (_, check) = read(&f, &f.operator, alone["validation_id"].as_str().unwrap()).await;
    assert_eq!(
        (
            check["state"].clone(),
            entry(&check, &current)["state"].clone()
        ),
        (json!("complete"), json!("unsupported"))
    );
}

#[tokio::test]
async fn a_manifest_carries_a_check_only_when_this_heartbeat_announced_the_feature() {
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let (_, _, preview) = ask(
        &f,
        &f.operator,
        &[a],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let id = preview["validation_id"].as_str().unwrap();
    for extra in [
        json!({}),
        json!({"agent_features":[]}),
        json!({"agent_features":["wake"]}),
        json!({"agent_features":null}),
    ] {
        let (status, _, manifest) = heartbeat(&f, a, extra.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(manifest.get("validation").is_none(), "{extra}: {manifest}");
    }
    // The check is still waiting for a device that announces itself.
    let manifest = announce(&f, a).await;
    assert_eq!(manifest["validation"]["id"], id);
    // Announcements are as of the latest check-in; readiness is stored as reported.
    let (status, _, _) = heartbeat(&f, a, json!({"agent_features":["validation","future_thing"],"readiness":{"data_dir_writable":true,"allowed_listener_count":4}})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, shown) = send(
        &f.app,
        "GET",
        &format!("/api/v1/devices/{a}"),
        Value::Null,
        Some(&f.operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shown["agent_features"],
        json!(["validation", "future_thing"])
    );
    assert_eq!(
        shown["readiness"],
        json!({"data_dir_writable":true,"allowed_listener_count":4})
    );
    heartbeat(&f, a, json!({})).await;
    let (_, _, shown) = send(
        &f.app,
        "GET",
        &format!("/api/v1/devices/{a}"),
        Value::Null,
        Some(&f.operator),
    )
    .await;
    assert!(
        shown.get("agent_features").is_none() && shown.get("readiness").is_none(),
        "{shown}"
    );
    // A malformed announcement or readiness refuses the heartbeat whole.
    for extra in [
        json!({"agent_features":["Validation"]}),
        json!({"agent_features":"validation"}),
        json!({"readiness":{"data_dir_writable":1}}),
        json!({"readiness":{"unknown":true}}),
    ] {
        let (status, _, _) = heartbeat(&f, a, extra.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}");
    }
}

#[tokio::test]
async fn an_ordinary_manifest_is_the_old_manifest_plus_only_the_new_optional_fields() {
    let f = fixture(2).await;
    let version = insert_version(&f.state, 3, &pipeline(500), json!([])).await;
    let (assigned, bare) = (&f.ids[0], &f.ids[1]);
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=4 WHERE id=?")
        .bind(&version)
        .bind(assigned)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (_, payload, manifest) = heartbeat(&f, assigned, json!({"reported_generation":0})).await;
    let sha = manifest["desired"]["sha256"].as_str().unwrap().to_owned();
    let size = manifest["desired"]["size"].as_i64().unwrap();
    let (issued, expires) = (
        manifest["issued_at"].as_str().unwrap(),
        manifest["expires_at"].as_str().unwrap(),
    );
    // What the previous server signed for the same inputs, byte for byte: keys
    // in order, no `validation`, none of the new optional fields.
    let old = format!(
        r#"{{"desired":{{"artifact_path":"/agent/v1/artifacts/{sha}","sha256":"{sha}","size":{size},"vector_version":"0.58.0","version_id":"{version}"}},"device_id":"{assigned}","expires_at":"{expires}","features":["diagnostics","host_runtime","vector_log_summary","telemetry_v2","secret_names","service_manager","vector_running","agent_sha256","state_dir","wake"],"generation":4,"issued_at":"{issued}","nonce":"{nonce}","policy":{{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}},"policy_generation":0,"protocol_version":1}}"#,
        nonce = STANDARD.encode([3; 32]),
    );
    let mut stripped: Value = serde_json::from_str(&payload).unwrap();
    let desired = stripped["desired"].as_object_mut().unwrap();
    assert_eq!(desired.remove("version_number"), Some(json!(3)));
    assert_eq!(
        desired.remove("configuration_name"),
        Some(json!("Edge syslog"))
    );
    let features = stripped["features"].as_array_mut().unwrap();
    assert_eq!(
        features.iter().position(|name| name == "validation"),
        Some(features.len() - 2)
    );
    features.retain(|name| name != "validation");
    assert_eq!(serde_json::to_string(&stripped).unwrap(), old);
    // A device with nothing assigned: no `desired`, no check, nothing else new.
    let (_, payload, _) = heartbeat(&f, bare, json!({})).await;
    let mut stripped: Value = serde_json::from_str(&payload).unwrap();
    assert!(stripped["desired"].is_null() && stripped.get("validation").is_none());
    stripped["features"]
        .as_array_mut()
        .unwrap()
        .retain(|name| name != "validation");
    let expected = format!(
        r#"{{"desired":null,"device_id":"{bare}","expires_at":"{}","features":["diagnostics","host_runtime","vector_log_summary","telemetry_v2","secret_names","service_manager","vector_running","agent_sha256","state_dir","wake"],"generation":0,"issued_at":"{}","nonce":"{}","policy":{{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}},"policy_generation":0,"protocol_version":1}}"#,
        stripped["expires_at"].as_str().unwrap(),
        stripped["issued_at"].as_str().unwrap(),
        STANDARD.encode([3; 32]),
    );
    assert_eq!(serde_json::to_string(&stripped).unwrap(), expected);
    // The heartbeat body of an agent that has never heard of this feature is accepted as before.
    let (status, _, _) = heartbeat(
        &f,
        bare,
        json!({"telemetry":null,"labels":{"group":"production"}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn the_manifest_names_the_version_and_pipeline_it_describes() {
    let f = fixture(1).await;
    let (first, second) = (
        insert_version(&f.state, 1, &pipeline(500), json!([])).await,
        insert_version(&f.state, 2, &pipeline(900), json!([])).await,
    );
    let a = &f.ids[0];
    let assign = |version: String, generation: i64| {
        let (pool, device) = (f.state.pool.clone(), a.clone());
        async move {
            sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=? WHERE id=?")
                .bind(version)
                .bind(generation)
                .bind(device)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let rename = |name: Option<&str>| {
        let pool = f.state.pool.clone();
        let name = name.map(str::to_owned);
        async move {
            sqlx::query("UPDATE records SET data=json_set(data,'$.name',?) WHERE kind='configuration' AND id=?")
                .bind(name)
                .bind(PIPELINE)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    assign(first.clone(), 1).await;
    let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
    assert_eq!(
        (
            manifest["desired"]["version_id"].clone(),
            manifest["desired"]["version_number"].clone(),
            manifest["desired"]["configuration_name"].clone()
        ),
        (json!(first), json!(1), json!("Edge syslog"))
    );
    // A rename changes the name at the same generation; a new version, its number.
    rename(Some("Renamed pipeline")).await;
    let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
    assert_eq!(
        (
            manifest["generation"].clone(),
            manifest["desired"]["configuration_name"].clone()
        ),
        (json!(1), json!("Renamed pipeline"))
    );
    assign(second.clone(), 2).await;
    let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
    assert_eq!(
        (
            manifest["desired"]["version_id"].clone(),
            manifest["desired"]["version_number"].clone()
        ),
        (json!(second), json!(2))
    );
    // A name that is too long is cut to 120 characters; one that is not valid
    // text, or missing, is left out rather than guessed.
    let long = "é".repeat(130);
    rename(Some(long.as_str())).await;
    let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
    assert_eq!(manifest["desired"]["configuration_name"], "é".repeat(120));
    for name in [Some("bell\u{7}"), Some(""), None] {
        rename(name).await;
        let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
        assert!(
            manifest["desired"].get("configuration_name").is_none(),
            "{name:?}: {manifest}"
        );
        assert_eq!(manifest["desired"]["version_number"], 2);
    }
    // No assignment: no desired state, so no labels.
    sqlx::query("UPDATE devices SET desired_version_id=NULL,desired_generation=3 WHERE id=?")
        .bind(a)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (_, _, manifest) = heartbeat(&f, a, json!({})).await;
    assert!(manifest["desired"].is_null());
}

#[tokio::test]
async fn the_audit_row_holds_counts_and_the_pipeline_identity_never_the_configuration() {
    let f = fixture(3).await;
    let version = insert_version(&f.state, 1, &pipeline(500), declared()).await;
    let (a, b, c) = (&f.ids[0], &f.ids[1], &f.ids[2]);
    announce(&f, a).await;
    sqlx::query(
        "UPDATE devices SET data=json_set(data,'$.last_seen','2020-01-01T00:00:00Z') WHERE id=?",
    )
    .bind(b)
    .execute(&f.state.pool)
    .await
    .unwrap();
    let (_, _, preview) = ask(
        &f,
        &f.operator,
        &[a, b, c],
        &version,
        json!({"run_tests":true,"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    let id = preview["validation_id"].as_str().unwrap();
    let (status, _, page) = send(
        &f.app,
        "GET",
        "/api/v1/audit/history?action=deployment.device_validation_requested",
        Value::Null,
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1);
    let event = &page["items"][0];
    assert_eq!(event["actor_id"], f.operator.id);
    assert_eq!(event["outcome"], "success");
    // Named after the pipeline it checked, linkable, never a deployment.
    assert_eq!(
        (
            event["target_kind"].clone(),
            event["target_name"].clone(),
            event["target_id"].clone()
        ),
        (
            json!("configuration"),
            json!("Edge syslog"),
            json!(PIPELINE)
        )
    );
    let (_, _, detail) = send(
        &f.app,
        "GET",
        &format!("/api/v1/audit/{}", event["id"].as_str().unwrap()),
        Value::Null,
        Some(&f.admin),
    )
    .await;
    assert_eq!(
        detail["details"],
        json!({"validation_id":id,"configuration_id":PIPELINE,"version_id":version,"run_tests":true,"truncated":false,"device_count":3,"pending_count":1,"offline_count":1,"unsupported_count":1})
    );
    // The stored event carries nothing else: no configuration, bytes, digest or name.
    let stored: String = sqlx::query_scalar("SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.device_validation_requested'")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    let stored: Value = serde_json::from_str(&stored).unwrap();
    let mut keys: Vec<_> = stored["details"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "configuration_id",
            "device_count",
            "offline_count",
            "pending_count",
            "run_tests",
            "truncated",
            "unsupported_count",
            "validation_id",
            "version_id"
        ]
    );
    for secret in ["sinks", "blackhole", "max_events", "edge-00", "artifact"] {
        assert!(
            !stored.to_string().contains(secret),
            "{secret} reached the audit row: {stored}"
        );
    }
    // Reading a check, and a device's answer, write no audit row.
    read(&f, &f.operator, id).await;
    heartbeat(&f, a, with_id(id, passed())).await;
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action') LIKE '%validation%'")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(events, 1);
    // A check that addressed nobody creates nothing, answers without an ID and
    // writes no audit row.
    let (status, _, nobody) = ask(
        &f,
        &f.operator,
        &[],
        &version,
        json!({"variable_bindings":{"defaults":{"max_events":600},"devices":{}}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{nobody}");
    assert!(nobody.get("validation_id").is_none() && nobody.get("validation_truncated").is_none());
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action') LIKE '%validation%'")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(events, 1);
}

#[tokio::test]
async fn a_request_checks_the_first_fifty_devices_by_name_and_says_it_was_truncated() {
    let f = fixture(52).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    for device in &f.ids {
        announce(&f, device).await;
    }
    let all: Vec<&String> = f.ids.iter().collect();
    let (status, _, preview) = ask(&f, &f.operator, &all, &version, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["validation_truncated"], true);
    assert_eq!(
        preview["devices"].as_array().unwrap().len(),
        52,
        "the review still covers every device"
    );
    let (_, check) = read(&f, &f.operator, preview["validation_id"].as_str().unwrap()).await;
    assert_eq!(check["truncated"], true);
    let names: Vec<_> = check["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names.len(), 50);
    assert_eq!(
        names,
        (0..50).map(|n| format!("edge-{n:02}")).collect::<Vec<_>>()
    );
    let (_, _, detail) = send(
        &f.app,
        "GET",
        "/api/v1/audit/history?action=deployment.device_validation_requested",
        Value::Null,
        Some(&f.admin),
    )
    .await;
    let (_, _, detail) = send(
        &f.app,
        "GET",
        &format!(
            "/api/v1/audit/{}",
            detail["items"][0]["id"].as_str().unwrap()
        ),
        Value::Null,
        Some(&f.admin),
    )
    .await;
    assert_eq!(
        (
            detail["details"]["device_count"].clone(),
            detail["details"]["truncated"].clone()
        ),
        (json!(50), json!(true))
    );
    // Fewer devices than the cap are not truncated.
    let (_, _, few) = ask(&f, &f.operator, &all[..3], &version, json!({})).await;
    assert_eq!(few["validation_truncated"], false);
}

#[tokio::test]
async fn one_request_stores_a_bounded_number_of_candidate_bytes() {
    let f = fixture(12).await;
    // Almost 1 MiB each: ten fit in 10 MiB, the eleventh does not.
    let artifact = format!("{{\"padding\":\"{}\"}}", "x".repeat(999_980));
    let each = artifact.len() as i64;
    let version = version_with(&f.state, 1, &pipeline(500), json!([]), artifact).await;
    for device in &f.ids {
        announce(&f, device).await;
    }
    let all: Vec<&String> = f.ids.iter().collect();
    let (status, _, preview) = ask(&f, &f.operator, &all, &version, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["validation_truncated"], true);
    let (_, check) = read(&f, &f.operator, preview["validation_id"].as_str().unwrap()).await;
    assert_eq!(check["devices"].as_array().unwrap().len(), 10);
    assert_eq!(check["truncated"], true);
    let stored: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(length(artifact)),0) FROM device_validations")
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    assert_eq!(stored, 10 * each);
}

#[tokio::test]
async fn only_a_pipeline_version_can_be_checked_and_creating_a_deployment_still_refuses_the_fields()
{
    let f = fixture(1).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    let a = &f.ids[0];
    announce(&f, a).await;
    let policy = json!({"policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true},"selector":{"device_ids":[a],"group_ids":[],"exclude_ids":[]},"priority":10,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0},"device_validation":true});
    let (status, _, body) = send(
        &f.app,
        "POST",
        "/api/v1/deployments/preview",
        policy,
        Some(&f.operator),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    for bad in [
        json!({"device_validation":"yes"}),
        json!({"device_validation":1}),
        json!({"device_validation":true,"run_tests":"yes"}),
    ] {
        let mut body = review(&[a], &version);
        for (key, value) in bad.as_object().unwrap() {
            body[key] = value.clone();
        }
        let (status, _, body) = send(
            &f.app,
            "POST",
            "/api/v1/deployments/preview",
            body,
            Some(&f.operator),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    // `run_tests` without a check is accepted and does nothing.
    let mut body = review(&[a], &version);
    body["run_tests"] = json!(true);
    let (status, _, body) = send(
        &f.app,
        "POST",
        "/api/v1/deployments/preview",
        body,
        Some(&f.operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.get("validation_id").is_none());
    // A deployment is created with the fields it has always had.
    for field in ["device_validation", "run_tests"] {
        let mut body = review(&[a], &version);
        body[field] = json!(true);
        let (status, _, body) = send(
            &f.app,
            "POST",
            "/api/v1/deployments",
            body,
            Some(&f.operator),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {body}");
    }
    let none: i64 = sqlx::query_scalar("SELECT count(*) FROM device_validations")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(none, 0);
}

#[tokio::test]
async fn revoking_a_device_ends_its_check_and_old_rows_age_out_after_a_day() {
    let f = fixture(2).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    let (a, b) = (&f.ids[0], &f.ids[1]);
    announce(&f, a).await;
    announce(&f, b).await;
    let (_, _, preview) = ask(&f, &f.operator, &[a, b], &version, json!({})).await;
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    let (status, _, body) = send(
        &f.app,
        "POST",
        &format!("/api/v1/devices/{a}/revoke"),
        json!({}),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, a)["state"], "expired");
    assert_eq!(entry(&check, b)["state"], "pending");
    assert_eq!(row(&f, &id, a).await, (a.clone(), "expired".into(), None));
    // Retention: a day-old row goes, a younger one stays.
    let stale = (chrono::Utc::now() - chrono::Duration::hours(25))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let recent = (chrono::Utc::now() - chrono::Duration::hours(23))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    for (row, at) in [("1", &stale), ("2", &recent)] {
        sqlx::query("INSERT INTO device_validations(id,device_id,device_name,configuration_id,version_id,sha256,size,run_tests,requested_by,created_at,expires_at,state,result_json,updated_at) VALUES(?,?,?,?,?,?,1,0,'u',?,?,'failed','{\"valid\":false}',?)")
            .bind(format!("{row}0000000-0000-4000-8000-000000000000"))
            .bind(b)
            .bind("edge-01")
            .bind(PIPELINE)
            .bind(&version)
            .bind("a".repeat(64))
            .bind(at)
            .bind(at)
            .bind(at)
            .execute(&f.state.pool)
            .await
            .unwrap();
    }
    vectory_server::rollout::prune(&f.state).await.unwrap();
    let left: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM device_validations WHERE id LIKE '_0000000-%' ORDER BY id",
    )
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(left, ["20000000-0000-4000-8000-000000000000"]);
    // The pending check of the live device is untouched.
    assert_eq!(row(&f, &id, b).await.1, "pending");
}

#[tokio::test]
async fn two_simultaneous_requests_leave_one_pending_check_per_device() {
    let f = fixture(3).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    for device in &f.ids {
        announce(&f, device).await;
    }
    let all: Vec<&String> = f.ids.iter().collect();
    let (one, two) = tokio::join!(
        ask(&f, &f.operator, &all, &version, json!({})),
        ask(&f, &f.admin, &all, &version, json!({})),
    );
    assert_eq!((one.0, two.0), (StatusCode::OK, StatusCode::OK));
    let pending: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id,count(*) FROM device_validations WHERE state='pending' GROUP BY id",
    )
    .fetch_all(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0].1, 3);
    // The one that lost every device reads expired on all of them.
    let ids = [
        one.2["validation_id"].as_str().unwrap(),
        two.2["validation_id"].as_str().unwrap(),
    ];
    let loser = ids.iter().find(|id| **id != pending[0].0).unwrap();
    let who = if *loser == ids[0] {
        &f.operator
    } else {
        &f.admin
    };
    let (_, check) = read(&f, who, loser).await;
    assert_eq!(check["state"], "complete");
    assert!(
        check["devices"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["state"] == "expired")
    );
}

/// A wait parked for the device at the generations it holds now, the way its
/// agent holds one. The answer arrives on the receiver.
async fn park(f: &Fixture, device: &str) -> oneshot::Receiver<Value> {
    let (generation, policy): (i64, i64) =
        sqlx::query_as("SELECT desired_generation,policy_generation FROM devices WHERE id=?")
            .bind(device)
            .fetch_one(&f.state.pool)
            .await
            .unwrap();
    let response = agent(f, device)
        .oneshot(
            Request::get(format!(
                "/agent/v1/wait?generation={generation}&policy_generation={policy}"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (sender, receiver) = oneshot::channel();
    tokio::spawn(async move {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let _ = sender.send(serde_json::from_slice(&bytes).unwrap());
    });
    assert!(f.state.wake.listening(device));
    receiver
}

/// The answer of a parked wait, if it comes within `within`.
async fn answered(wait: &mut oneshot::Receiver<Value>, within: Duration) -> Option<Value> {
    tokio::time::timeout(within, wait)
        .await
        .ok()
        .map(Result::unwrap)
}

#[tokio::test]
async fn a_committed_check_wakes_the_parked_wait_of_each_device_it_asked_and_only_those() {
    let f = fixture(3).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    let (asked, unsupported, outside) = (&f.ids[0], &f.ids[1], &f.ids[2]);
    announce(&f, asked).await;
    announce(&f, outside).await;
    let mut waits = Vec::new();
    for device in &f.ids {
        waits.push(park(&f, device).await);
    }
    let before = untouched(&f).await;

    // A preview that asks for no check wakes nobody.
    let (status, _, _) = send(
        &f.app,
        "POST",
        "/api/v1/deployments/preview",
        review(&[asked, unsupported], &version),
        Some(&f.operator),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(f.state.wake.woken(), 0);
    assert!(f.ids.iter().all(|device| f.state.wake.listening(device)));

    // A check wakes the device it asked, with the ordinary hint.
    let (status, _, preview) =
        ask(&f, &f.operator, &[asked, unsupported], &version, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    let id = preview["validation_id"].as_str().unwrap().to_owned();
    assert_eq!(
        answered(&mut waits[0], Duration::from_secs(3)).await,
        Some(json!({"changed":true}))
    );
    // Neither a device that cannot be checked nor one the request left out.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(f.state.wake.woken(), 1);
    assert!(f.state.wake.listening(unsupported));
    assert!(f.state.wake.listening(outside));
    let (_, check) = read(&f, &f.operator, &id).await;
    assert_eq!(entry(&check, unsupported)["state"], "unsupported");
    // The hint carries nothing: the check reaches the device in its signed
    // manifest, and no generation moved.
    let manifest = announce(&f, asked).await;
    assert_eq!(manifest["validation"]["id"], id);
    assert_eq!(untouched(&f).await, before);

    // A refused check wakes nobody. Five more checks use up the minute's six
    // without asking a waiting device; the seventh is refused.
    let mut again = park(&f, asked).await;
    for _ in 0..5 {
        let (status, _, body) = ask(&f, &f.operator, &[unsupported], &version, json!({})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, headers, _) = ask(&f, &f.operator, &[asked], &version, json!({})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(headers.contains_key("retry-after"));
    assert!(
        answered(&mut again, Duration::from_millis(250))
            .await
            .is_none()
    );
    assert_eq!(f.state.wake.woken(), 1);
}

#[tokio::test]
async fn a_server_holding_its_most_candidates_refuses_a_new_check_and_changes_nothing() {
    let f = fixture(2).await;
    let version = insert_version(&f.state, 1, &pipeline(500), json!([])).await;
    let (a, b) = (&f.ids[0], &f.ids[1]);
    announce(&f, a).await;
    announce(&f, b).await;
    let (status, _, first) = ask(&f, &f.operator, &[a], &version, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (_, first_size) = digest_of(&first, a);
    let first = first["validation_id"].as_str().unwrap().to_owned();
    // Other devices' checks hold the rest of what the server keeps for waiting
    // candidates, to the byte: 127 of a mebibyte each and one that fills the gap.
    let mebibyte: i64 = 1024 * 1024;
    let mut sizes = vec![mebibyte; 127];
    sizes.push(mebibyte - first_size);
    let stamp = db::now();
    for (index, size) in sizes.into_iter().enumerate() {
        let device = insert_device(&f.state, &format!("held-{index:03}"), Some(db::now())).await;
        sqlx::query("INSERT INTO device_validations(id,device_id,device_name,configuration_id,version_id,sha256,size,run_tests,requested_by,created_at,expires_at,state,artifact,updated_at) VALUES(?,?,?,?,?,?,?,0,'held',?,'2099-01-01T00:00:00Z','pending',zeroblob(?),?)")
            .bind(format!("{index:08x}-0000-4000-8000-000000000001"))
            .bind(&device)
            .bind(format!("held-{index:03}"))
            .bind(PIPELINE)
            .bind(&version)
            .bind("a".repeat(64))
            .bind(size)
            .bind(&stamp)
            .bind(size)
            .bind(&stamp)
            .execute(&f.state.pool)
            .await
            .unwrap();
    }
    let waiting = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(SUM(size),0) FROM device_validations WHERE state='pending' AND artifact IS NOT NULL",
        )
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(waiting().await, 128 * mebibyte);
    let audits = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.device_validation_requested'",
        )
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
    };
    assert_eq!(audits().await, 1);
    let before = untouched(&f).await;

    // Replacing the first check frees its bytes and adds a candidate for each
    // of two devices: one more than the server keeps. Nothing is kept of it,
    // and the check it would have replaced is still waiting for its answer.
    let (status, headers, body) = ask(&f, &f.operator, &[a, b], &version, json!({})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "CAPACITY_BUSY");
    assert_eq!(headers["retry-after"], "60");
    assert_eq!(
        row(&f, &first, a).await,
        (a.clone(), "pending".into(), Some(first_size))
    );
    let all: i64 = sqlx::query_scalar("SELECT count(*) FROM device_validations")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(all, 129);
    assert_eq!(waiting().await, 128 * mebibyte);
    assert_eq!(audits().await, 1);
    assert_eq!(untouched(&f).await, before);
    // The first device still gets its candidate, the second never had one.
    let manifest = announce(&f, a).await;
    assert_eq!(manifest["validation"]["id"], first);
    assert!(announce(&f, b).await.get("validation").is_none());

    // Once the other candidates are gone there is room again.
    sqlx::query(
        "UPDATE device_validations SET state='expired',artifact=NULL WHERE requested_by='held'",
    )
    .execute(&f.state.pool)
    .await
    .unwrap();
    let (status, _, body) = ask(&f, &f.operator, &[a, b], &version, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(row(&f, &first, a).await.1, "expired");
    assert_eq!(audits().await, 2);
}
