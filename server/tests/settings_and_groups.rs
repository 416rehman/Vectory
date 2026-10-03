//! Saved agent settings attribution and editing, and reviewed group membership
//! previews. Synthetic devices only; every preview must leave state unchanged.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize, rollout};

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    app: Router,
    cookie: String,
    csrf: String,
    devices: Vec<String>,
}

async fn fixture(count: usize) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-settings-groups-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Settings and groups tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let user = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&user)
    .bind("operator@example.invalid")
    .bind("Settings operator")
    .bind("operator")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&user)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&state.pool)
        .await
        .unwrap();
    let mut devices = Vec::new();
    for n in 0..count {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let data = json!({"id":id,"name":format!("edge-{n:02}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&state.pool)
            .await
            .unwrap();
        devices.push(id);
    }
    Fixture {
        _temp: temp,
        app: api::router(state.clone()),
        state,
        cookie: format!("vectory_session={token}"),
        csrf,
        devices,
    }
}

async fn call(f: &Fixture, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("cookie", &f.cookie)
                .header("x-csrf-token", &f.csrf)
                .header("content-type", "application/json")
                .body(body.map_or(Body::empty(), |v| Body::from(v.to_string())))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn settings(heartbeat: i64, paused: bool) -> Value {
    json!({"heartbeat_seconds":heartbeat,"sync_paused":paused,"telemetry_enabled":true})
}

fn apply(devices: &[String], policy: Value, policy_id: Option<&str>) -> Value {
    let mut request = json!({"policy":policy,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}});
    if let Some(id) = policy_id {
        request["policy_id"] = json!(id);
    }
    request
}

#[tokio::test]
async fn saved_settings_report_where_they_are_applied_and_edits_use_revisions() {
    let f = fixture(3).await;
    let (status, standard) = call(
        &f,
        "POST",
        "/api/v1/policies",
        Some(json!({"name":"Standard check-ins","policy":settings(15, false)})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{standard}");
    let id = standard["id"].as_str().unwrap().to_owned();
    let (status, created) = call(
        &f,
        "POST",
        "/api/v1/deployments",
        Some(apply(&f.devices[..2], settings(15, false), Some(&id))),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    // The device projection names the template behind its settings.
    let (_, device) = call(
        &f,
        "GET",
        &format!("/api/v1/devices/{}", f.devices[0]),
        None,
    )
    .await;
    assert_eq!(
        device["policy_assignment"]["policy_name"],
        "Standard check-ins"
    );
    assert_eq!(
        device["policy_assignment"]["created_by_name"],
        "Settings operator"
    );

    let (_, list) = call(&f, "GET", "/api/v1/policies", None).await;
    let saved = list
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap();
    assert_eq!(saved["applied_device_count"], 2);
    assert_eq!(saved["applied_devices"][0]["name"], "edge-00");
    assert_eq!(saved["revision"], 0);

    // Applying a template requires its current values.
    let (status, stale) = call(
        &f,
        "POST",
        "/api/v1/deployments/preview",
        Some(apply(&f.devices[2..], settings(30, false), Some(&id))),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");

    let (status, edited) = call(
        &f,
        "PUT",
        &format!("/api/v1/policies/{id}"),
        Some(json!({"name":"Fast check-ins","policy":settings(10, false),"revision":0})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["revision"], 1);
    assert_eq!(edited["name"], "Fast check-ins");
    // Editing never changes devices: they keep the settings they were given.
    let (_, device) = call(
        &f,
        "GET",
        &format!("/api/v1/devices/{}", f.devices[0]),
        None,
    )
    .await;
    assert_eq!(device["effective_policy"]["heartbeat_seconds"], 15);
    let (status, conflict) = call(
        &f,
        "PUT",
        &format!("/api/v1/policies/{id}"),
        Some(json!({"name":"Late edit","policy":settings(20, false),"revision":0})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["error"]["code"], "STALE_REVISION");
    let (status, _) = call(
        &f,
        "PUT",
        &format!("/api/v1/policies/{id}"),
        Some(json!({"name":"Extra","policy":settings(20, false),"revision":1,"other":true})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, detail) = call(&f, "GET", &format!("/api/v1/policies/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["name"], "Fast check-ins");
    // Devices still follow the template, now with earlier values.
    assert_eq!(detail["applied_device_count"], 2);
    assert_eq!(detail["outdated_device_count"], 2);
    assert_eq!(saved["outdated_device_count"], 0);
    // The existing receipt shape still recovers keyed creation.
    let (status, _) = call(&f, "GET", &format!("/api/v1/policies/{}", db::id()), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn membership_preview_explains_effects_without_changing_anything() {
    let f = fixture(3).await;
    let pipeline = db::id();
    let version = db::id();
    let artifact = "{\"data_dir\":\"/var/lib/vectory-groups\"}\n";
    let group = db::id();
    let mut tx = f.state.pool.begin().await.unwrap();
    db::insert(
        &mut tx,
        "configuration",
        &json!({"id":pipeline,"name":"Edge metrics","created_at":db::now()}),
    )
    .await
    .unwrap();
    db::insert(&mut tx,"version",&json!({"id":version,"configuration_id":pipeline,"number":3,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    db::insert(&mut tx,"group",&json!({"id":group,"name":"edge","description":"","device_ids":[f.devices[0],f.devices[1]],"created_at":db::now(),"revision":1})).await.unwrap();
    let assignment = rollout::create(&mut tx, &json!({"version_id":version,"selector":{"device_ids":[],"group_ids":[group],"exclude_ids":[]},"priority":130,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}}), "operator").await.unwrap();
    tx.commit().await.unwrap();
    let before: Vec<String> = sqlx::query_scalar("SELECT json_object('id',id,'assignment',assignment_id,'desired',desired_version_id,'generation',desired_generation) FROM devices ORDER BY id").fetch_all(&f.state.pool).await.unwrap();

    // Add edge-02, remove edge-01.
    let (status, preview) = call(
        &f,
        "POST",
        "/api/v1/groups/membership-preview",
        Some(json!({"group_id":group,"device_ids":[f.devices[0],f.devices[2]],"revision":1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["ready"], true);
    let devices = preview["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 2);
    let added = devices.iter().find(|d| d["change"] == "added").unwrap();
    assert_eq!(added["device_name"], "edge-02");
    assert_eq!(added["configuration"]["changed"], true);
    assert!(added["configuration"]["before"]["assignment_id"].is_null());
    assert_eq!(
        added["configuration"]["after"]["assignment_id"],
        assignment["id"]
    );
    assert_eq!(
        added["configuration"]["after"]["configuration_name"],
        "Edge metrics"
    );
    assert_eq!(added["configuration"]["after"]["version_number"], 3);
    assert_eq!(added["policy"]["changed"], false);
    let removed = devices.iter().find(|d| d["change"] == "removed").unwrap();
    assert_eq!(removed["device_name"], "edge-01");
    assert_eq!(
        removed["configuration"]["before"]["assignment_id"],
        assignment["id"]
    );
    assert!(removed["configuration"]["after"]["assignment_id"].is_null());

    // Nothing changed: not the group, targets, desired state or audit.
    let after: Vec<String> = sqlx::query_scalar("SELECT json_object('id',id,'assignment',assignment_id,'desired',desired_version_id,'generation',desired_generation) FROM devices ORDER BY id").fetch_all(&f.state.pool).await.unwrap();
    assert_eq!(before, after);
    let (_, saved) = call(&f, "GET", &format!("/api/v1/groups/{group}"), None).await;
    assert_eq!(saved["device_ids"].as_array().unwrap().len(), 2);
    assert_eq!(saved["revision"], 1);

    // A stale revision is reported, unknown devices are rejected.
    let (_, stale) = call(
        &f,
        "POST",
        "/api/v1/groups/membership-preview",
        Some(json!({"group_id":group,"device_ids":[f.devices[0]],"revision":0})),
    )
    .await;
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["ready"], false);
    let (status, _) = call(
        &f,
        "POST",
        "/api/v1/groups/membership-preview",
        Some(json!({"group_id":group,"device_ids":[db::id()]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &f,
        "POST",
        "/api/v1/groups/membership-preview",
        Some(json!({"group_id":group,"device_ids":[],"extra":1})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

fn rollout_settings() -> Value {
    json!({"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0})
}

/// A persistent deployment of agent settings that follows `group`.
fn settings_following(group: &str, heartbeat: i64, priority: i64) -> Value {
    json!({"policy":settings(heartbeat, false),"selector":{"device_ids":[],"group_ids":[group],"exclude_ids":[]},"priority":priority,"target_mode":"persistent","rollout":rollout_settings()})
}

/// A snapshot deployment of agent settings on exactly these devices.
fn settings_on(devices: &[String], heartbeat: i64, priority: i64) -> Value {
    json!({"policy":settings(heartbeat, false),"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":rollout_settings()})
}

/// A pipeline version whose restricted-mode artifact differs per number.
async fn pipeline_version(
    tx: &mut sqlx::SqliteConnection,
    name: &str,
    number: i64,
) -> (String, String) {
    let pipeline = db::id();
    let version = db::id();
    let artifact = format!("{{\"data_dir\":\"/var/lib/vectory-groups/{number}\"}}\n");
    db::insert(
        tx,
        "configuration",
        &json!({"id":pipeline,"name":name,"created_at":db::now()}),
    )
    .await
    .unwrap();
    db::insert(tx,"version",&json!({"id":version,"configuration_id":pipeline,"number":number,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    (pipeline, version)
}

fn pipeline_following(group: &str, version: &str, priority: i64) -> Value {
    json!({"version_id":version,"selector":{"device_ids":[],"group_ids":[group],"exclude_ids":[]},"priority":priority,"target_mode":"persistent","rollout":rollout_settings()})
}

fn pipeline_on(devices: &[String], version: &str, priority: i64) -> Value {
    json!({"version_id":version,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":rollout_settings()})
}

async fn new_group(f: &Fixture, name: &str, members: &[String]) -> String {
    let id = db::id();
    let mut conn = f.state.pool.acquire().await.unwrap();
    db::insert(&mut conn,"group",&json!({"id":id,"name":name,"description":"","device_ids":members,"created_at":db::now(),"revision":1})).await.unwrap();
    id
}

async fn edit_group(
    f: &Fixture,
    group: &str,
    name: &str,
    members: &[String],
) -> (StatusCode, Value) {
    call(
        f,
        "PUT",
        &format!("/api/v1/groups/{group}"),
        Some(json!({"name":name,"description":"","device_ids":members,"revision":1})),
    )
    .await
}

async fn preview_edit(f: &Fixture, group: &str, members: &[String]) -> Value {
    let (status, preview) = call(
        f,
        "POST",
        "/api/v1/groups/membership-preview",
        Some(json!({"group_id":group,"device_ids":members,"revision":1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    preview
}

/// The one entry that names `device`, with its two assignments told apart by
/// what they target.
fn named<'a>(details: &'a [Value], device: &str) -> (&'a Value, &'a Value, &'a Value) {
    let entry = details
        .iter()
        .find(|entry| entry["device_id"] == device)
        .unwrap_or_else(|| panic!("no conflict names {device}: {details:?}"));
    let assignments = entry["assignments"].as_array().unwrap();
    assert_eq!(assignments.len(), 2, "{entry}");
    let by = |targets: &str| {
        assignments
            .iter()
            .find(|assignment| assignment["targets"] == targets)
            .unwrap_or_else(|| panic!("no assignment targets {targets}: {entry}"))
    };
    (entry, by("devices"), by("group"))
}

#[tokio::test]
async fn a_group_edit_that_collides_names_the_device_and_both_assignments() {
    let f = fixture(20).await;
    let message = "Group membership creates conflicting equal-priority assignments";
    let mut tx = f.state.pool.begin().await.unwrap();
    let (_, metrics) = pipeline_version(&mut tx, "Edge metrics", 1).await;
    let (_, logs) = pipeline_version(&mut tx, "Access logs", 4).await;
    tx.commit().await.unwrap();

    // Agent settings: edge-01 has its own, and "Berlin edge" follows others.
    let berlin = new_group(&f, "Berlin edge", &f.devices[..1]).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let hand = rollout::create(&mut tx, &settings_on(&f.devices[1..2], 15, 100), "operator")
        .await
        .unwrap();
    let following = rollout::create(&mut tx, &settings_following(&berlin, 60, 100), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let members: Vec<String> = f.devices[..2].to_vec();
    let (status, refused) = edit_group(&f, &berlin, "Berlin edge", &members).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["code"], "CONFLICT");
    assert_eq!(refused["error"]["message"], message);
    assert_eq!(refused["error"]["details_total"], 1);
    let details = refused["error"]["details"].as_array().unwrap();
    assert_eq!(details.len(), 1, "{refused}");
    let (entry, own, group) = named(details, &f.devices[1]);
    assert_eq!(entry["device_name"], "edge-01");
    assert_eq!(entry["resource"], "policy");
    assert_eq!(entry["priority"], 100);
    assert_eq!(own["id"], hand["id"]);
    assert_eq!(own["resource"], "policy");
    assert_eq!(own["priority"], 100);
    assert_eq!(own["groups"], json!([]));
    assert_eq!(own["policy"]["heartbeat_seconds"], 15);
    assert_eq!(group["id"], following["id"]);
    assert_eq!(group["target_mode"], "persistent");
    assert_eq!(group["groups"], json!([{"id":berlin,"name":"Berlin edge"}]));
    // The refusal changed nothing.
    let (_, saved) = call(&f, "GET", &format!("/api/v1/groups/{berlin}"), None).await;
    assert_eq!(saved["device_ids"], json!(f.devices[..1]));
    assert_eq!(saved["revision"], 1);
    // The preview before saving answers the same list, and says it is not ready.
    let preview = preview_edit(&f, &berlin, &members).await;
    assert_eq!(preview["ready"], false);
    assert_eq!(preview["blockers"].as_array().unwrap().len(), 1);
    let blocker = &preview["blockers"][0];
    assert_eq!(blocker["code"], "CONFLICT");
    assert_eq!(blocker["reason"], message);
    assert_eq!(blocker["details"], refused["error"]["details"]);
    assert_eq!(blocker["details_total"], 1);

    // Pipelines collide the same way.
    let paris = new_group(&f, "Paris edge", &f.devices[2..3]).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let by_hand = rollout::create(
        &mut tx,
        &pipeline_on(&f.devices[3..4], &metrics, 100),
        "operator",
    )
    .await
    .unwrap();
    let by_group = rollout::create(&mut tx, &pipeline_following(&paris, &logs, 100), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let members: Vec<String> = f.devices[2..4].to_vec();
    let (status, refused) = edit_group(&f, &paris, "Paris edge", &members).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    let details = refused["error"]["details"].as_array().unwrap();
    let (entry, own, group) = named(details, &f.devices[3]);
    assert_eq!(entry["device_name"], "edge-03");
    assert_eq!(entry["resource"], "configuration");
    assert_eq!(own["id"], by_hand["id"]);
    assert_eq!(own["resource"], "configuration");
    assert_eq!(own["configuration_name"], "Edge metrics");
    assert_eq!(own["version_number"], 1);
    assert_eq!(group["id"], by_group["id"]);
    assert_eq!(group["configuration_name"], "Access logs");
    assert_eq!(group["version_number"], 4);
    assert_eq!(group["groups"], json!([{"id":paris,"name":"Paris edge"}]));
    let preview = preview_edit(&f, &paris, &members).await;
    assert_eq!(
        preview["blockers"][0]["details"],
        refused["error"]["details"]
    );

    // Other priorities are no conflict: the higher one wins, so both are saved.
    let rome = new_group(&f, "Rome edge", &f.devices[4..5]).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    rollout::create(&mut tx, &settings_on(&f.devices[5..6], 15, 110), "operator")
        .await
        .unwrap();
    rollout::create(&mut tx, &settings_following(&rome, 60, 100), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let members: Vec<String> = f.devices[4..6].to_vec();
    let preview = preview_edit(&f, &rome, &members).await;
    assert_eq!(preview["ready"], true, "{preview}");
    assert_eq!(preview["blockers"], json!([]));
    let (status, saved) = edit_group(&f, &rome, "Rome edge", &members).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let oslo = new_group(&f, "Oslo edge", &f.devices[6..7]).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    rollout::create(
        &mut tx,
        &pipeline_on(&f.devices[7..8], &metrics, 120),
        "operator",
    )
    .await
    .unwrap();
    rollout::create(&mut tx, &pipeline_following(&oslo, &logs, 100), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let members: Vec<String> = f.devices[6..8].to_vec();
    let (status, saved) = edit_group(&f, &oslo, "Oslo edge", &members).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["device_ids"].as_array().unwrap().len(), 2);

    // A large collision lists the first ten devices by name and counts them all.
    let wide = new_group(&f, "Wide edge", &f.devices[8..9]).await;
    let crowd: Vec<String> = f.devices[9..].to_vec();
    let mut tx = f.state.pool.begin().await.unwrap();
    rollout::create(&mut tx, &settings_on(&crowd, 15, 100), "operator")
        .await
        .unwrap();
    rollout::create(&mut tx, &settings_following(&wide, 60, 100), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let members: Vec<String> = f.devices[8..].to_vec();
    let (status, refused) = edit_group(&f, &wide, "Wide edge", &members).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refused}");
    assert_eq!(refused["error"]["details_total"], crowd.len());
    let details = refused["error"]["details"].as_array().unwrap();
    assert_eq!(details.len(), 10, "{refused}");
    let names: Vec<&str> = details
        .iter()
        .map(|entry| entry["device_name"].as_str().unwrap())
        .collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "listed by device name");
    assert_eq!(names[0], "edge-09");
    // Nothing but names and numbers: no selector, no member list.
    let text = refused.to_string();
    assert!(
        !text.contains("selector") && !text.contains("device_ids"),
        "{text}"
    );
}

#[tokio::test]
async fn membership_preview_answers_busy_instead_of_queueing_behind_writers() {
    let f = fixture(2).await;
    let group = db::id();
    let mut conn = f.state.pool.acquire().await.unwrap();
    db::insert(&mut conn,"group",&json!({"id":group,"name":"edge","description":"","device_ids":[f.devices[0]],"created_at":db::now(),"revision":1})).await.unwrap();
    drop(conn);
    let body = json!({"group_id":group,"device_ids":[f.devices[0],f.devices[1]],"revision":1});
    let preview = || {
        f.app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/groups/membership-preview")
                .header("cookie", &f.cookie)
                .header("x-csrf-token", &f.csrf)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
    };
    // A heartbeat or the scheduler is writing. The preview doesn't wait
    // behind it: it answers at once, and the dashboard retries.
    let writing = f.state.writer.lock().await;
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), preview())
        .await
        .expect("the preview queued behind the writer")
        .unwrap();
    drop(writing);
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response.headers()["retry-after"], "1");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let busy: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(busy["error"]["code"], "CAPACITY_BUSY");
    assert_eq!(busy["error"]["message"], "Preview busy, retrying");
    // Once the writer is done, the same preview answers.
    let response = preview().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let answered: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answered["devices"][0]["change"], "added", "{answered}");
    let (_, saved) = call(&f, "GET", &format!("/api/v1/groups/{group}"), None).await;
    assert_eq!(
        saved["device_ids"],
        json!([f.devices[0]]),
        "still unchanged"
    );
}
