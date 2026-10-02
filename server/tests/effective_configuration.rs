//! What a device was offered, read back: the artifact with this device's own
//! values applied (secrets still references), the generations it was offered,
//! a bounded comparison of two of them, and whether what the agent reports
//! running is the offer. Real deployments and real check-ins feed every read.
use axum::{
    Extension, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize, validation, variables};

const PIPELINE: &str = "00000000-0000-4000-8000-000000000900";
/// The one variable the test pipelines declare.
fn declared() -> Value {
    json!([{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}])
}

struct Who {
    cookie: String,
    csrf: String,
}

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    app: Router,
    admin: Who,
    ids: Vec<String>,
}

async fn user(state: &State, role: &str, expires: &str) -> Who {
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
        .bind(expires)
        .execute(&state.pool)
        .await
        .unwrap();
    Who {
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}

async fn insert_device(state: &State, name: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let data = json!({
        "id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0",
        "configuration_mode":"full","last_seen":db::now(),"apply_state":"unmanaged",
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
        bootstrap_secret: "unused-effective-configuration-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Synthetic effective configuration fixture".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = user(&state, "admin", "2099-01-01T00:00:00Z").await;
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
        ids.push(insert_device(&state, &format!("edge-{index:02}")).await);
    }
    Fixture {
        _temp: temp,
        app: api::router(state.clone()),
        state,
        admin,
        ids,
    }
}

fn pipeline(max_events: i64, interval: i64) -> Value {
    json!({
        "sources":{"in":{"type":"demo_logs","format":"json","interval":interval}},
        "sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"max_events":max_events,"type":"memory"}}}
    })
}

/// A published version, as the publish route stores it.
async fn insert_version(
    state: &State,
    number: i64,
    config: &Value,
    declarations: Value,
    secrets: bool,
) -> String {
    let id = db::id();
    let artifact = validation::render(config).unwrap();
    let mut conn = state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "version",
        &json!({
            "id":id,"configuration_id":PIPELINE,"number":number,"config":config,
            "variables":declarations,"artifact":artifact,"sha256":db::hash(&artifact),
            "size":artifact.len(),"created_at":db::now(),"uses_local_secrets":secrets
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
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(who) = who {
        request = request
            .header("cookie", &who.cookie)
            .header("x-csrf-token", &who.csrf);
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

async fn get(f: &Fixture, path: &str) -> (StatusCode, Value) {
    let (status, _, body) = send(&f.app, "GET", path, Value::Null, Some(&f.admin)).await;
    (status, body)
}

async fn configuration(f: &Fixture, device: &str, query: &str) -> Value {
    let (status, body) = get(f, &format!("/api/v1/devices/{device}/configuration{query}")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn comparison(f: &Fixture, device: &str, query: &str) -> Value {
    let (status, body) = get(
        f,
        &format!("/api/v1/devices/{device}/configuration/diff{query}"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

/// Deploy `version` to `devices` at `priority`, with `max_events` as the
/// default value of the variable and optional per-device overrides.
async fn deploy(
    f: &Fixture,
    version: &str,
    devices: &[&String],
    priority: i64,
    default: Option<i64>,
    overrides: &[(&String, i64)],
) -> Value {
    let mut body = json!({
        "version_id":version,
        "selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},
        "priority":priority,"target_mode":"snapshot",
        "rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}
    });
    if let Some(default) = default {
        let devices: serde_json::Map<String, Value> = overrides
            .iter()
            .map(|(id, value)| ((*id).clone(), json!({"max_events":value})))
            .collect();
        body["variable_bindings"] = json!({"defaults":{"max_events":default},"devices":devices});
    }
    let (status, _, deployment) =
        send(&f.app, "POST", "/api/v1/deployments", body, Some(&f.admin)).await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    deployment
}

async fn deploy_default(
    f: &Fixture,
    devices: &[&String],
    version: &str,
    priority: i64,
    value: i64,
) -> Value {
    deploy(f, version, devices, priority, Some(value), &[]).await
}

/// A check-in from the device, as its agent sends it.
async fn check_in(
    f: &Fixture,
    device: &str,
    reported: i64,
    actual: &str,
    state: &str,
    extra: Value,
) -> Value {
    let agent = device::router(f.state.clone()).layer(Extension(device::PeerCertificate(Some(
        format!("credential-{device}"),
    ))));
    let mut body = json!({
        "protocol_version":1,"request_id":"r","boot_id":"b","nonce":STANDARD.encode([3; 32]),
        "agent_version":"test","vector_version":"0.58.0","reported_generation":reported,
        "policy_generation":0,"actual_sha256":actual,"apply_state":state,
        "local_paused":false,"remote_pause_acknowledged":false,"configuration_mode":"full"
    });
    for (key, value) in extra.as_object().into_iter().flatten() {
        body[key] = value.clone();
    }
    let (status, _, envelope) = send(&agent, "POST", "/agent/v1/heartbeat", body, None).await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    serde_json::from_slice(
        &STANDARD
            .decode(envelope["payload"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap()
}

/// Seed an offer without going through a deployment, for shapes a deployment
/// cannot make: very large artifacts, an unassigned device, a legacy row.
async fn seed(state: &State, device: &str, generation: i64, version: &str, content: &str) {
    let mut conn = state.pool.acquire().await.unwrap();
    variables::snapshot(
        &mut conn,
        device,
        generation,
        version,
        &variables::Artifact {
            bytes: content.to_owned(),
            sha256: db::hash(content),
            size: content.len(),
        },
    )
    .await
    .unwrap();
}

async fn set_generation(state: &State, device: &str, version: Option<&str>, generation: i64) {
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=? WHERE id=?")
        .bind(version)
        .bind(generation)
        .bind(device)
        .execute(&state.pool)
        .await
        .unwrap();
}

async fn bare_version(state: &State, number: i64) -> String {
    let id = db::id();
    let mut conn = state.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "version",
        &json!({"id":id,"configuration_id":PIPELINE,"number":number,"variables":[],"created_at":db::now()}),
    )
    .await
    .unwrap();
    id
}

fn pretty(value: &Value) -> String {
    validation::render(value).unwrap()
}

#[tokio::test]
async fn each_device_reads_the_bytes_it_was_offered_with_its_own_values() {
    let f = fixture(3).await;
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    deploy(
        &f,
        &v1,
        &[&f.ids[0], &f.ids[1]],
        100,
        Some(600),
        &[(&f.ids[1], 700)],
    )
    .await;

    let a = configuration(&f, &f.ids[0], "").await;
    let b = configuration(&f, &f.ids[1], "").await;
    assert_eq!(a["device_id"], f.ids[0]);
    assert_eq!(b["device_id"], f.ids[1]);
    assert_eq!(
        (a["generation"].as_i64(), a["current"].clone()),
        (Some(1), json!(true))
    );
    assert_eq!(
        a["version"],
        json!({"id":v1,"number":1,"configuration_id":PIPELINE,"configuration_name":"Edge syslog"})
    );
    assert_eq!(a["format"], "json");
    assert_eq!(a["uses_local_secrets"], false);
    assert!(a["offered_at"].is_string());

    // The digest and size describe exactly the text returned, and the text is
    // the artifact with the device's value in place of the template's.
    for (body, expected) in [(&a, 600), (&b, 700)] {
        let content = body["content"].as_str().unwrap();
        assert_eq!(body["sha256"], db::hash(content));
        assert_eq!(body["size"], content.len());
        let parsed: Value = serde_json::from_str(content).unwrap();
        assert_eq!(parsed["sinks"]["out"]["buffer"]["max_events"], expected);
    }
    assert_ne!(
        a["sha256"], b["sha256"],
        "distinct values, distinct digests"
    );

    // Where each value came from.
    assert_eq!(
        a["variables"],
        json!([{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer","value":600,"source":"default"}])
    );
    assert_eq!(b["variables"][0]["value"], 700);
    assert_eq!(b["variables"][0]["source"], "device");

    // It is what the device downloads: the signed manifest names this digest
    // and the artifact route serves these bytes.
    let manifest = check_in(&f, &f.ids[1], 0, "", "desired", json!({})).await;
    assert_eq!(manifest["desired"]["sha256"], b["sha256"]);
    let agent = device::router(f.state.clone()).layer(Extension(device::PeerCertificate(Some(
        format!("credential-{}", f.ids[1]),
    ))));
    let response = agent
        .oneshot(
            Request::builder()
                .uri(manifest["desired"]["artifact_path"].as_str().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let served = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(served.as_ref(), b["content"].as_str().unwrap().as_bytes());

    // Nothing earlier, and one offered generation.
    assert_eq!(a["previous"], Value::Null);
    assert_eq!(a["generations"]["total"], 1);
    assert_eq!(a["generations"]["items"][0]["generation"], 1);
    assert_eq!(a["generations"]["items"][0]["sha256"], a["sha256"]);

    // A device that was never offered anything has nothing to show.
    let none = configuration(&f, &f.ids[2], "").await;
    assert_eq!(none["generation"], 0);
    for field in [
        "version",
        "sha256",
        "size",
        "format",
        "content",
        "offered_at",
        "previous",
    ] {
        assert_eq!(none[field], Value::Null, "{field}");
    }
    assert_eq!(none["variables"], json!([]));
    assert_eq!(none["generations"], json!({"total":0,"items":[]}));
}

#[tokio::test]
async fn an_earlier_generation_is_read_by_number_and_only_for_the_device_that_had_it() {
    let f = fixture(2).await;
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 5), declared(), false).await;
    deploy(&f, &v1, &[&f.ids[0], &f.ids[1]], 100, Some(600), &[]).await;
    deploy(&f, &v2, &[&f.ids[0]], 101, Some(600), &[]).await;

    let current = configuration(&f, &f.ids[0], "").await;
    assert_eq!(current["generation"], 2);
    assert_eq!(current["version"]["number"], 2);
    assert_eq!(
        current["previous"]["generation"], 1,
        "the previous offered generation"
    );
    assert_eq!(current["previous"]["version"]["number"], 1);
    let items: Vec<i64> = current["generations"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["generation"].as_i64().unwrap())
        .collect();
    assert_eq!(items, [2, 1], "newest first");

    let older = configuration(&f, &f.ids[0], "?generation=1").await;
    assert_eq!(older["generation"], 1);
    assert_eq!(older["current"], false);
    assert_eq!(older["version"]["number"], 1);
    assert_eq!(older["previous"], Value::Null);
    let parsed: Value = serde_json::from_str(older["content"].as_str().unwrap()).unwrap();
    assert_eq!(parsed["sources"]["in"]["interval"], 1);
    assert_eq!(older["sha256"], current["previous"]["sha256"]);
    // Reading an older generation never changes what is current.
    assert_eq!(configuration(&f, &f.ids[0], "").await["generation"], 2);

    // The other device was never offered generation 2, and its own
    // generation 1 is not reachable under another device's route.
    for query in ["?generation=2", "?generation=3", "?generation=999"] {
        let (status, body) = get(
            &f,
            &format!("/api/v1/devices/{}/configuration{query}", f.ids[1]),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{query}: {body}");
        assert_eq!(body["error"]["code"], "NOT_FOUND");
    }
    let (status, _) = get(
        &f,
        &format!(
            "/api/v1/devices/{}/configuration/diff?from=1&to=2",
            f.ids[1]
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_difference_between_generations_is_a_structured_and_a_unified_diff() {
    let f = fixture(1).await;
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 5), declared(), false).await;
    deploy(&f, &v1, &[&f.ids[0]], 100, Some(600), &[]).await;
    // The value changes too, so the second offer differs in two places.
    deploy(&f, &v2, &[&f.ids[0]], 101, Some(750), &[]).await;
    let id = &f.ids[0];

    let diff = comparison(&f, id, "").await;
    assert_eq!(diff["device_id"], *id);
    assert_eq!(diff["from"]["generation"], 1);
    assert_eq!(diff["to"]["generation"], 2);
    assert_eq!(diff["from"]["version"]["number"], 1);
    assert_eq!(diff["to"]["version"]["number"], 2);
    assert_eq!(diff["identical"], false);
    assert_eq!(diff["counts"], json!({"added":0,"removed":0,"changed":2}));
    assert_eq!(diff["truncated"], false);
    assert_eq!(diff["approximate"], false);
    // Two settings: far enough apart to be two hunks or near enough to be
    // one; either way each changed line is named by its component.
    let sections: Vec<&str> = diff["hunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|h| h["section"].as_str())
        .collect();
    assert!(
        sections
            .iter()
            .any(|s| s.starts_with("sinks.out.buffer") || s.starts_with("sources.in")),
        "{sections:?}"
    );
    let unified = diff["unified"].as_str().unwrap();
    assert!(
        unified.starts_with("--- generation 1\n+++ generation 2\n@@ "),
        "{unified}"
    );
    assert!(
        unified.contains("-        \"max_events\": 600"),
        "{unified}"
    );
    assert!(
        unified.contains("+        \"max_events\": 750"),
        "{unified}"
    );
    assert!(unified.contains("-      \"interval\": 1"), "{unified}");
    assert!(unified.contains("+      \"interval\": 5"), "{unified}");
    // The structured lines are the text lines, with their numbers.
    let removed: Vec<&Value> = diff["hunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|h| h["lines"].as_array().unwrap())
        .filter(|l| l["kind"] == "removed")
        .collect();
    assert_eq!(removed.len(), 2);
    assert!(
        removed
            .iter()
            .all(|l| l["old_line"].is_u64() && l["new_line"].is_null())
    );

    // The same pair named explicitly, and reversed.
    assert_eq!(
        comparison(&f, id, "?from=1&to=2").await["unified"],
        diff["unified"]
    );
    let reverse = comparison(&f, id, "?from=2&to=1").await;
    assert_eq!(
        reverse["counts"],
        json!({"added":0,"removed":0,"changed":2})
    );
    assert!(
        reverse["unified"]
            .as_str()
            .unwrap()
            .contains("+        \"max_events\": 600")
    );
    // Only `from`: compared with the current generation. Only `to`: with the
    // generation before it.
    assert_eq!(
        comparison(&f, id, "?from=1").await["unified"],
        diff["unified"]
    );
    assert_eq!(
        comparison(&f, id, "?to=2").await["unified"],
        diff["unified"]
    );

    // A generation compared with itself, and the first thing a device was
    // offered, which has nothing before it.
    let same = comparison(&f, id, "?from=2&to=2").await;
    assert_eq!(same["identical"], true);
    assert_eq!(same["counts"], json!({"added":0,"removed":0,"changed":0}));
    assert_eq!(same["hunks"], json!([]));
    assert_eq!(same["unified"], "");
    let first = comparison(&f, id, "?to=1").await;
    assert_eq!(first["from"], Value::Null);
    assert_eq!(first["to"]["generation"], 1);
    assert_eq!(first["hunks"], json!([]));
    assert_eq!(first["identical"], false);
}

#[tokio::test]
async fn offers_with_the_same_bytes_are_identical_even_when_the_version_differs() {
    // A second version that only moved nodes has the same runtime bytes.
    let f = fixture(1).await;
    let config = pipeline(500, 1);
    let v1 = insert_version(&f.state, 1, &config, json!([]), false).await;
    let v2 = insert_version(&f.state, 2, &config, json!([]), false).await;
    deploy(&f, &v1, &[&f.ids[0]], 100, None, &[]).await;
    deploy(&f, &v2, &[&f.ids[0]], 101, None, &[]).await;
    let current = configuration(&f, &f.ids[0], "").await;
    assert_eq!(current["generation"], 2);
    assert_eq!(current["version"]["number"], 2);
    assert_eq!(current["previous"]["version"]["number"], 1);
    assert_eq!(current["previous"]["sha256"], current["sha256"]);
    let diff = comparison(&f, &f.ids[0], "").await;
    assert_eq!(diff["identical"], true);
    assert_eq!(diff["hunks"], json!([]));
    assert_eq!(current["variables"], json!([]));
}

#[tokio::test]
async fn a_rollback_reads_as_the_earlier_bytes_and_names_where_its_values_came_from() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    deploy_default(&f, &[id], &v1, 100, 600).await;
    let second = deploy_default(&f, &[id], &v1, 101, 700).await;
    // The new rollout verified, so it can be rolled back.
    sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=?")
        .bind(second["id"].as_str().unwrap())
        .execute(&f.state.pool)
        .await
        .unwrap();
    let (status, _, rolled) = send(
        &f.app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/rollback",
            second["id"].as_str().unwrap()
        ),
        json!({}),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{rolled}");

    let current = configuration(&f, id, "").await;
    assert_eq!(current["generation"], 3);
    let original = configuration(&f, id, "?generation=1").await;
    assert_eq!(
        current["sha256"], original["sha256"],
        "the exact earlier bytes"
    );
    assert_eq!(current["variables"][0]["value"], 600);
    // The rollout that carries these values is the first one, not the rollback,
    // which binds no values of its own.
    assert_eq!(current["variables"][0]["source"], "default");
    let middle = configuration(&f, id, "?generation=2").await;
    assert_eq!(middle["variables"][0]["value"], 700);
    assert_eq!(current["previous"]["generation"], 2);
}

#[tokio::test]
async fn the_drift_verdict_follows_the_digest_the_agent_reports() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 5), declared(), false).await;
    deploy_default(&f, &[id], &v1, 100, 600).await;
    let first = configuration(&f, id, "").await;
    let digest1 = first["sha256"].as_str().unwrap().to_owned();

    // Before the first report: nothing to compare.
    assert_eq!(first["running"]["sha256"], Value::Null);
    assert_eq!(first["running"]["matches"], Value::Null);
    assert_eq!(first["running"]["matches_generation"], Value::Null);

    // It applied what it was offered.
    check_in(&f, id, 1, &digest1, "verified_applied", json!({})).await;
    let applied = configuration(&f, id, "").await;
    assert_eq!(applied["running"]["sha256"], digest1);
    assert_eq!(applied["running"]["matches"], true);
    assert_eq!(applied["running"]["matches_generation"], Value::Null);
    assert!(applied["running"]["reported_at"].is_string());

    // A hand edit: a different digest the server has never seen. Nothing is
    // claimed about what the file says.
    let edited = db::hash("someone edited the file");
    check_in(&f, id, 1, &edited, "verified_applied", json!({})).await;
    let drifted = configuration(&f, id, "").await;
    assert_eq!(drifted["running"]["sha256"], edited);
    assert_eq!(drifted["running"]["matches"], false);
    assert_eq!(drifted["running"]["matches_generation"], Value::Null);

    // A new version is offered and not applied yet: the device runs what it
    // was offered at generation 1, which says which one.
    deploy_default(&f, &[id], &v2, 101, 600).await;
    check_in(&f, id, 1, &digest1, "desired", json!({})).await;
    let waiting = configuration(&f, id, "").await;
    assert_eq!(waiting["generation"], 2);
    assert_eq!(waiting["running"]["matches"], false);
    assert_eq!(waiting["running"]["matches_generation"], 1);
    let older = configuration(&f, id, "?generation=1").await;
    assert_eq!(older["running"]["matches"], true);

    // It applies generation 2: now the older one is the one that differs.
    let digest2 = waiting["sha256"].as_str().unwrap().to_owned();
    check_in(&f, id, 2, &digest2, "verified_applied", json!({})).await;
    let now = configuration(&f, id, "").await;
    assert_eq!(now["running"]["matches"], true);
    let before = configuration(&f, id, "?generation=1").await;
    assert_eq!(before["running"]["matches"], false);
    assert_eq!(before["running"]["matches_generation"], 2);

    // An agent that sends no digest again.
    check_in(&f, id, 2, "", "verified_applied", json!({})).await;
    let none = configuration(&f, id, "").await;
    assert_eq!(none["running"]["sha256"], Value::Null);
    assert_eq!(none["running"]["matches"], Value::Null);
}

#[tokio::test]
async fn a_version_that_reads_device_secrets_stays_a_reference_and_is_judged_by_its_template() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let config = json!({
        "sources":{"in":{"type":"demo_logs","format":"json"}},
        "sinks":{"dd":{"type":"datadog_logs","inputs":["in"],"default_api_key":"vectory-secret:DD_API_KEY"}}
    });
    let version = insert_version(&f.state, 1, &config, json!([]), true).await;
    deploy(&f, &version, &[id], 100, None, &[]).await;
    let offered = configuration(&f, id, "").await;
    assert_eq!(offered["uses_local_secrets"], true);
    // The reference, exactly as published; never a value.
    let content = offered["content"].as_str().unwrap();
    assert!(
        content.contains("\"vectory-secret:DD_API_KEY\""),
        "{content}"
    );
    assert_eq!(content, pretty(&config));
    let template = offered["sha256"].as_str().unwrap().to_owned();

    // The host writes its own value in place of the reference. The agent
    // reports that file's digest and the template it built it from.
    let resolved = "dd-api-key-value-that-only-the-host-knows";
    let file = db::hash(format!("{content}{resolved}"));
    check_in(
        &f,
        id,
        1,
        &file,
        "verified_applied",
        json!({"applied_template_sha256":template,"secret_revision":1}),
    )
    .await;
    let body = configuration(&f, id, "").await;
    assert_eq!(body["running"]["sha256"], file);
    assert_ne!(
        body["running"]["sha256"], body["sha256"],
        "the file is not the template"
    );
    assert_eq!(body["running"]["template_sha256"], template);
    assert_eq!(
        body["running"]["matches"], true,
        "the template applied is the offered one and the file is as verified"
    );
    assert!(
        !body.to_string().contains(resolved),
        "nothing the host resolved is ever in a response"
    );

    // The file changes after it was verified: no longer the same, and the
    // server does not say what it became.
    check_in(
        &f,
        id,
        1,
        &db::hash("edited"),
        "verified_applied",
        json!({"applied_template_sha256":template,"secret_revision":1}),
    )
    .await;
    let edited = configuration(&f, id, "").await;
    assert_eq!(edited["running"]["matches"], false);
    assert_eq!(edited["running"]["matches_generation"], Value::Null);

    // Without a template digest the agent cannot be compared.
    check_in(
        &f,
        id,
        1,
        &db::hash("edited"),
        "verified_applied",
        json!({"secret_revision":1}),
    )
    .await;
    let unknown = configuration(&f, id, "").await;
    assert_eq!(unknown["running"]["matches"], Value::Null);
}

#[tokio::test]
async fn a_value_that_could_be_a_credential_is_never_shown_as_a_variable() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    // Not a state the API can reach (a declaration at a credential field is
    // refused at publish), so the rows are written directly: the read still
    // withholds the value, whatever is stored.
    let secret = "plain-token-value-0123456789";
    let declarations = json!([
        {"name":"token","path":"/sinks/out/auth/token","type":"string"},
        {"name":"mode","path":"/sources/in/format","type":"string"},
        {"name":"ref","path":"/sources/in/decoding/codec","type":"string"},
        {"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}
    ]);
    let config = json!({
        "sources":{"in":{"type":"demo_logs","format":"json","decoding":{"codec":"vectory-secret:HIDDEN"}}},
        "sinks":{"out":{"type":"http","inputs":["in"],"auth":{"strategy":"bearer","token":secret},"buffer":{"max_events":600}}}
    });
    let version = insert_version(&f.state, 1, &config, declarations, false).await;
    seed(&f.state, id, 1, &version, &pretty(&config)).await;
    set_generation(&f.state, id, Some(&version), 1).await;
    let body = configuration(&f, id, "").await;
    let rows = body["variables"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0]["value"], Value::Null, "a credential path");
    assert_eq!(rows[1]["value"], "json", "an ordinary value");
    assert_eq!(rows[2]["value"], Value::Null, "a reference to a secret");
    assert_eq!(rows[3]["value"], 600);
    assert!(
        !serde_json::to_string(&body["variables"])
            .unwrap()
            .contains(secret),
        "the variables table never holds the credential"
    );
}

#[tokio::test]
async fn an_unassigned_device_reads_its_history_but_has_nothing_current() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), json!([]), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 2), json!([]), false).await;
    deploy(&f, &v1, &[id], 100, None, &[]).await;
    deploy(&f, &v2, &[id], 101, None, &[]).await;
    // Its assignment is removed: a new generation, and no version.
    set_generation(&f.state, id, None, 3).await;
    let body = configuration(&f, id, "").await;
    assert_eq!(body["generation"], 3);
    assert_eq!(body["current"], true);
    for field in [
        "version",
        "sha256",
        "size",
        "format",
        "content",
        "offered_at",
    ] {
        assert_eq!(body[field], Value::Null, "{field}");
    }
    assert_eq!(
        body["previous"]["generation"], 2,
        "the last thing it was offered"
    );
    assert_eq!(body["generations"]["total"], 2);
    // What it was offered before is still readable.
    let earlier = configuration(&f, id, "?generation=1").await;
    assert_eq!(earlier["version"]["number"], 1);
    assert_eq!(earlier["current"], false);
    // The generation of the removal offered nothing, and there is no
    // current offer to compare.
    let (status, _) = get(
        &f,
        &format!("/api/v1/devices/{id}/configuration?generation=3"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = get(&f, &format!("/api/v1/devices/{id}/configuration/diff")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(
        comparison(&f, id, "?from=1&to=2").await["counts"]["changed"],
        1
    );
    // After the assignment was removed, the file it ran is still what it was
    // offered at generation 2 and the read says so.
    let digest2 = configuration(&f, id, "?generation=2").await["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    check_in(&f, id, 0, &digest2, "unmanaged", json!({})).await;
    let kept = configuration(&f, id, "").await;
    assert_eq!(kept["running"]["matches"], Value::Null);
    assert_eq!(kept["running"]["matches_generation"], 2);
}

#[tokio::test]
async fn a_generation_assigned_before_artifacts_were_stored_is_its_versions_artifact() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let config = pipeline(500, 1);
    let version = insert_version(&f.state, 1, &config, json!([]), false).await;
    set_generation(&f.state, id, Some(&version), 1).await;
    let body = configuration(&f, id, "").await;
    assert_eq!(body["content"], pretty(&config));
    assert_eq!(body["offered_at"], Value::Null);
    assert_eq!(body["generations"]["items"][0]["generation"], 1);
    // What a check-in serves for it.
    let manifest = check_in(&f, id, 0, "", "desired", json!({})).await;
    assert_eq!(manifest["desired"]["sha256"], body["sha256"]);
    // A version with device values cannot be reconstructed without a stored
    // artifact, and the read says so rather than guess.
    let with_values = insert_version(&f.state, 2, &pipeline(500, 1), declared(), false).await;
    set_generation(&f.state, id, Some(&with_values), 2).await;
    let (status, error) = get(&f, &format!("/api/v1/devices/{id}/configuration")).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
}

fn changed_lines(prefix: &str, count: usize, extra: usize) -> String {
    let mut object = serde_json::Map::new();
    for n in 0..count + extra {
        let value = if n < count {
            format!("{prefix} {n}")
        } else {
            format!("tail {n}")
        };
        object.insert(format!("key_{n:05}"), json!(value));
    }
    pretty(&json!({"settings": object}))
}

#[tokio::test]
async fn a_diff_is_cut_at_two_thousand_lines_and_says_what_it_left_out() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let version = bare_version(&f.state, 1).await;
    // 2,500 lines appended: an exact diff, longer than the cap.
    let base = changed_lines("same", 200, 0);
    let longer = changed_lines("same", 200, 2_500);
    seed(&f.state, id, 1, &version, &base).await;
    seed(&f.state, id, 2, &version, &longer).await;
    set_generation(&f.state, id, Some(&version), 2).await;
    let diff = comparison(&f, id, "").await;
    assert_eq!(diff["truncated"], true);
    assert_eq!(diff["approximate"], false);
    assert_eq!(diff["counts"]["added"], 2_500);
    assert_eq!(diff["counts"]["removed"], 0);
    let unified = diff["unified"].as_str().unwrap();
    let lines: Vec<&str> = unified.lines().collect();
    assert_eq!(lines.len(), 2_000, "headers, hunk and marker included");
    assert!(
        lines[1_999].starts_with("\\ Diff truncated: showing 1999 of "),
        "{}",
        lines[1_999]
    );
    assert!(diff["total_lines"].as_u64().unwrap() > 2_500);
    let shown: usize = diff["hunks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["lines"].as_array().unwrap().len())
        .sum();
    assert_eq!(
        shown,
        2_000 - 2 - diff["hunks"].as_array().unwrap().len() - 1
    );
    // Every structured line is a line of the text.
    assert!(
        unified.contains("+    \"key_00200\": \"tail 200\""),
        "starts after the context"
    );

    // Changing every other line is more than is matched line by line: the
    // changed region is shown as replaced, and flagged.
    let old = interleaved("old", 3_000);
    let new = interleaved("new", 3_000);
    seed(&f.state, id, 3, &version, &old).await;
    seed(&f.state, id, 4, &version, &new).await;
    set_generation(&f.state, id, Some(&version), 4).await;
    let replaced = comparison(&f, id, "?from=3&to=4").await;
    assert_eq!(replaced["approximate"], true);
    assert_eq!(replaced["truncated"], true);
    assert_eq!(replaced["unified"].as_str().unwrap().lines().count(), 2_000);
    // When nothing is shared, showing the region as replaced is exact.
    let wholly_old = changed_lines("old", 3_000, 0);
    let wholly_new = changed_lines("new", 3_000, 0);
    seed(&f.state, id, 5, &version, &wholly_old).await;
    seed(&f.state, id, 6, &version, &wholly_new).await;
    set_generation(&f.state, id, Some(&version), 6).await;
    let exact = comparison(&f, id, "?from=5&to=6").await;
    assert_eq!(exact["approximate"], false);
    assert_eq!(exact["truncated"], true);
    assert_eq!(exact["counts"]["changed"], 3_000);
}

/// `count` settings, every other one the same on both sides.
fn interleaved(changed: &str, count: usize) -> String {
    let mut object = serde_json::Map::new();
    for n in 0..count {
        let value = if n % 2 == 0 {
            format!("same {n}")
        } else {
            format!("{changed} {n}")
        };
        object.insert(format!("key_{n:05}"), json!(value));
    }
    pretty(&json!({"settings": object}))
}

#[tokio::test]
async fn a_large_artifact_is_returned_whole() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let version = bare_version(&f.state, 1).await;
    let mut entries = serde_json::Map::new();
    let mut n = 0;
    let content = loop {
        entries.insert(format!("entry_{n:06}"), json!("x".repeat(80)));
        n += 1;
        if n % 500 == 0 {
            let text = pretty(&json!({"settings": entries.clone()}));
            if text.len() > 900_000 {
                break text;
            }
        }
    };
    assert!(content.len() < 1_048_576, "within the artifact limit");
    seed(&f.state, id, 1, &version, &content).await;
    set_generation(&f.state, id, Some(&version), 1).await;
    let body = configuration(&f, id, "").await;
    assert_eq!(body["size"], content.len());
    assert_eq!(body["sha256"], db::hash(&content));
    assert_eq!(body["content"].as_str().unwrap(), content);
    assert_eq!(body["format"], "json");
}

#[tokio::test]
async fn every_signed_in_role_reads_and_nobody_else_does() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), json!([]), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 2), json!([]), false).await;
    deploy(&f, &v1, &[id], 100, None, &[]).await;
    deploy(&f, &v2, &[id], 101, None, &[]).await;
    let routes = [
        format!("/api/v1/devices/{id}/configuration"),
        format!("/api/v1/devices/{id}/configuration?generation=1"),
        format!("/api/v1/devices/{id}/configuration/diff"),
    ];
    // The route reads like a pipeline version does: any signed-in role.
    let version_path = format!("/api/v1/versions/{v1}");
    for role in ["viewer", "editor", "operator", "admin"] {
        let who = user(&f.state, role, "2099-01-01T00:00:00Z").await;
        let (status, _, _) = send(&f.app, "GET", &version_path, Value::Null, Some(&who)).await;
        assert_eq!(status, StatusCode::OK, "{role} reads a version");
        for route in &routes {
            let (status, headers, body) = send(&f.app, "GET", route, Value::Null, Some(&who)).await;
            assert_eq!(status, StatusCode::OK, "{role} {route}: {body}");
            assert_eq!(
                headers.get("cache-control").and_then(|v| v.to_str().ok()),
                Some("no-store"),
                "{role} {route}"
            );
        }
    }
    // Nobody else: no session, an unknown one, an expired one, a disabled account.
    let expired = user(&f.state, "admin", "2000-01-01T00:00:00Z").await;
    let disabled = user(&f.state, "admin", "2099-01-01T00:00:00Z").await;
    let account: String = sqlx::query_scalar("SELECT user_id FROM sessions WHERE verifier=?")
        .bind(db::hash(
            disabled.cookie.trim_start_matches("vectory_session="),
        ))
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(account)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let forged = Who {
        cookie: "vectory_session=not-a-session".into(),
        csrf: String::new(),
    };
    for route in &routes {
        for who in [None, Some(&forged), Some(&expired), Some(&disabled)] {
            let (status, _, body) = send(&f.app, "GET", route, Value::Null, who).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{route}: {body}");
            assert_eq!(body["error"]["code"], "UNAUTHENTICATED");
            assert!(body.get("content").is_none() && body.get("unified").is_none());
        }
    }
    // A device's own credential reaches nothing here: these are dashboard
    // routes, absent from the agent listener, for its own record or another's.
    let agent = device::router(f.state.clone()).layer(Extension(device::PeerCertificate(Some(
        format!("credential-{id}"),
    ))));
    for route in [
        format!("/api/v1/devices/{id}/configuration"),
        format!("/agent/v1/devices/{id}/configuration"),
        format!("/agent/v1/configuration"),
    ] {
        let (status, _, body) = send(&agent, "GET", &route, Value::Null, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{route}: {body}");
        assert!(body.get("content").is_none());
    }
}

#[tokio::test]
async fn unknown_devices_and_malformed_queries_are_refused_like_the_device_read() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), json!([]), false).await;
    deploy(&f, &v1, &[id], 100, None, &[]).await;
    let missing = uuid::Uuid::new_v4().to_string();
    let (status, device_read) = get(&f, &format!("/api/v1/devices/{missing}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for route in [
        format!("/api/v1/devices/{missing}/configuration"),
        format!("/api/v1/devices/{missing}/configuration?generation=1"),
        format!("/api/v1/devices/{missing}/configuration/diff"),
        "/api/v1/devices/not-a-uuid/configuration".to_owned(),
    ] {
        let (status, body) = get(&f, &route).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{route}");
        assert_eq!(
            body, device_read,
            "{route}: the same answer as the device read"
        );
    }
    for query in [
        "?generation=",
        "?generation=0",
        "?generation=-1",
        "?generation=1.5",
        "?generation=abc",
        "?generation=01",
        "?generation=9007199254740992",
        "?generation=1&generation=1",
        "?generation=1&other=1",
        "?other=1",
        "?generation=%ff",
        "?generation=%zz",
    ] {
        let (status, body) = get(&f, &format!("/api/v1/devices/{id}/configuration{query}")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["code"], "INVALID_INPUT", "{query}");
    }
    for query in [
        "?from=",
        "?from=0",
        "?to=x",
        "?from=1&from=1",
        "?from=1&to=1&extra=1",
        "?generation=1",
        "?from=%zz",
    ] {
        let (status, body) = get(
            &f,
            &format!("/api/v1/devices/{id}/configuration/diff{query}"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
        assert_eq!(body["error"]["code"], "INVALID_INPUT", "{query}");
    }
}

#[tokio::test]
async fn a_revoked_device_still_shows_what_it_was_offered_and_is_not_judged() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), json!([]), false).await;
    deploy(&f, &v1, &[id], 100, None, &[]).await;
    let digest = configuration(&f, id, "").await["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    check_in(&f, id, 1, &digest, "verified_applied", json!({})).await;
    assert_eq!(configuration(&f, id, "").await["running"]["matches"], true);
    let (status, _, receipt) = send(
        &f.app,
        "POST",
        &format!("/api/v1/devices/{id}/revoke"),
        json!({}),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{receipt}");
    // The device read still answers for a revoked device, and so does this.
    let (status, device_read) = get(&f, &format!("/api/v1/devices/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(device_read["status"], "revoked");
    let body = configuration(&f, id, "").await;
    assert_eq!(body["sha256"], digest);
    assert_eq!(body["running"]["sha256"], digest, "its last report");
    assert_eq!(
        body["running"]["matches"],
        Value::Null,
        "a revoked device can no longer report, so nothing is claimed about it now"
    );
    assert_eq!(comparison(&f, id, "?to=1").await["from"], Value::Null);
}

#[tokio::test]
async fn reading_writes_nothing_and_leaves_no_audit_row() {
    let f = fixture(2).await;
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), declared(), false).await;
    let v2 = insert_version(&f.state, 2, &pipeline(500, 5), declared(), false).await;
    deploy(
        &f,
        &v1,
        &[&f.ids[0], &f.ids[1]],
        100,
        Some(600),
        &[(&f.ids[1], 700)],
    )
    .await;
    deploy(&f, &v2, &[&f.ids[0]], 101, Some(600), &[]).await;
    let snapshot = || async {
        let counts: Vec<i64> = {
            let mut out = Vec::new();
            for table in [
                "records WHERE kind='audit'",
                "records",
                "desired_artifacts",
                "artifact_blobs",
                "deployment_targets",
            ] {
                out.push(
                    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                        .fetch_one(&f.state.pool)
                        .await
                        .unwrap(),
                );
            }
            out
        };
        let devices: Vec<String> = sqlx::query(
            "SELECT data,desired_generation,desired_version_id FROM devices ORDER BY id",
        )
        .fetch_all(&f.state.pool)
        .await
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}|{}|{:?}",
                row.get::<String, _>(0),
                row.get::<i64, _>(1),
                row.get::<Option<String>, _>(2)
            )
        })
        .collect();
        (counts, devices)
    };
    let before = snapshot().await;
    for id in &f.ids {
        configuration(&f, id, "").await;
        configuration(&f, id, "?generation=1").await;
        comparison(&f, id, "?from=1&to=1").await;
    }
    comparison(&f, &f.ids[0], "").await;
    assert_eq!(snapshot().await, before);
}

#[tokio::test]
async fn reads_and_comparisons_are_limited_per_account() {
    let f = fixture(1).await;
    let id = &f.ids[0];
    let v1 = insert_version(&f.state, 1, &pipeline(500, 1), json!([]), false).await;
    deploy(&f, &v1, &[id], 100, None, &[]).await;
    let compare = format!("/api/v1/devices/{id}/configuration/diff?from=1&to=1");
    let read = format!("/api/v1/devices/{id}/configuration");
    let someone_else = user(&f.state, "viewer", "2099-01-01T00:00:00Z").await;
    for _ in 0..60 {
        let (status, _, body) = send(&f.app, "GET", &compare, Value::Null, Some(&f.admin)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, headers, body) = send(&f.app, "GET", &compare, Value::Null, Some(&f.admin)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["error"]["code"], "RATE_LIMITED");
    assert!(headers.get("retry-after").is_some());
    // The limit is the account's, and each route has its own.
    let (status, _, _) = send(&f.app, "GET", &compare, Value::Null, Some(&someone_else)).await;
    assert_eq!(status, StatusCode::OK);
    for _ in 0..240 {
        let (status, _, _) = send(&f.app, "GET", &read, Value::Null, Some(&f.admin)).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (status, _, body) = send(&f.app, "GET", &read, Value::Null, Some(&f.admin)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
}
