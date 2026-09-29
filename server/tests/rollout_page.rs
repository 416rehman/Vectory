//! Read models behind the rollout page: lineage in summaries, lanes, grouped
//! failures, per-device timelines and history filters. Synthetic data only.
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
    pipeline: String,
}

async fn fixture(count: usize) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-rollout-page-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Rollout page tests".into(),
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
    .bind("Rollout operator")
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
    let mut tx = state.pool.begin().await.unwrap();
    let mut devices = Vec::new();
    for n in 0..count {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let data = json!({"id":id,"name":format!("web-{n:02}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        devices.push(id);
    }
    let pipeline = db::id();
    db::insert(
        &mut tx,
        "configuration",
        &json!({"id":pipeline,"name":"Web access logs","created_at":db::now()}),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let app = api::router(state.clone());
    Fixture {
        _temp: temp,
        state,
        app,
        cookie: format!("vectory_session={token}"),
        csrf,
        devices,
        pipeline,
    }
}

async fn version(s: &State, pipeline: &str, number: i64) -> String {
    let id = db::id();
    let artifact = format!("{{\"data_dir\":\"/var/lib/vectory-page/{number}\"}}\n");
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":pipeline,"number":number,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    id
}

fn request(devices: &[String], version: &str, priority: i64, canary: bool) -> Value {
    json!({"version_id":version,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot",
        "rollout":{"kind":if canary {"canary"} else {"all"},"canary_size":1,"batch_size":2,"observation_seconds":30,"failure_threshold":1}})
}

async fn post(f: &Fixture, path: &str, body: Value) -> (StatusCode, Value) {
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("cookie", &f.cookie)
                .header("x-csrf-token", &f.csrf)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn get(f: &Fixture, path: &str) -> (StatusCode, Value) {
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(path)
                .header("cookie", &f.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn lanes_follow_release_order_and_failures_group_by_reason() {
    let f = fixture(5).await;
    let v1 = version(&f.state, &f.pipeline, 1).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let created = rollout::create(&mut tx, &request(&f.devices, &v1, 100, true), "operator")
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    // The canary device fails with a sanitized diagnostic from the agent.
    let canary = &f.devices[0];
    sqlx::query("UPDATE deployment_targets SET state='failed',error='Vector rejected the configuration' WHERE deployment_id=? AND device_id=?")
        .bind(&id)
        .bind(canary)
        .execute(&mut *tx)
        .await
        .unwrap();
    let generation: i64 = sqlx::query_scalar(
        "SELECT generation FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(&id)
    .bind(canary)
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let attempt = json!({"generation":generation,"version_id":v1,"sha256":"a".repeat(64),"state":"failed","error":{"code":"VALIDATION_FAILED","stage":"validation","message":"Vector rejected the configuration","diagnostics":[{"message":"data_dir \"/var/lib/vector/\" does not exist"}]}});
    sqlx::query("UPDATE devices SET data=json_set(data,'$.terminal_configuration_attempt',json(?),'$.apply_state','failed') WHERE id=?")
        .bind(attempt.to_string())
        .bind(canary)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let (status, lanes) = get(&f, &format!("/api/v1/deployments/{id}/rollout")).await;
    assert_eq!(status, StatusCode::OK, "{lanes}");
    let stages = lanes["stages"].as_array().unwrap();
    // Canary (released), then the queued plan: batches of two in device order.
    assert_eq!(stages.len(), 3);
    assert_eq!(stages[0]["kind"], "canary");
    assert_eq!(stages[0]["state"], "failed");
    assert_eq!(stages[0]["devices"][0]["device_name"], "web-00");
    assert_eq!(stages[1]["kind"], "batch");
    assert_eq!(stages[1]["index"], 1);
    assert_eq!(stages[1]["state"], "queued");
    assert_eq!(stages[1]["size"], 2);
    assert_eq!(stages[2]["index"], 2);
    assert_eq!(stages[2]["devices"][1]["device_name"], "web-04");
    let failure = &lanes["failures"][0];
    assert_eq!(failure["count"], 1);
    assert_eq!(failure["state"], "failed");
    assert_eq!(
        failure["diagnostic"],
        "data_dir \"/var/lib/vector/\" does not exist"
    );
    assert_eq!(failure["devices"][0]["device_id"], json!(canary));
    // Every member is listed for a retry, not only the named few.
    assert_eq!(failure["device_ids"], json!([canary]));
    assert_eq!(lanes["check_in_seconds"], 60);

    // The target page carries timing, check-in cadence and the diagnostic.
    let (_, page) = get(
        &f,
        &format!("/api/v1/deployments/{id}/targets?state=failed"),
    )
    .await;
    let row = &page["items"][0];
    assert!(row["released_at"].is_string());
    assert_eq!(row["check_in_seconds"], 60);
    assert_eq!(
        row["diagnostic"],
        "data_dir \"/var/lib/vector/\" does not exist"
    );
    // The step that failed comes from the attempt, not from the last
    // recorded apply state, so a skipped heartbeat never blames "download".
    assert_eq!(row["failure_stage"], "validation");
    assert!(row["timeline"].as_array().unwrap().is_empty());
    for private in [
        "_attempt",
        "_terminal",
        "_policy",
        "_acknowledgement",
        "next_release_at",
    ] {
        assert!(row.get(private).is_none(), "{private} leaked");
    }

    let (_, missing) = get(&f, &format!("/api/v1/deployments/{}/rollout", db::id())).await;
    assert_eq!(missing["error"]["code"], "NOT_FOUND");
}

#[tokio::test]
async fn timelines_use_recorded_apply_states_after_release() {
    let f = fixture(1).await;
    let v1 = version(&f.state, &f.pipeline, 1).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let created = rollout::create(&mut tx, &request(&f.devices, &v1, 100, false), "operator")
        .await
        .unwrap();
    let device = &f.devices[0];
    for state in [
        "desired",
        "downloaded",
        "validated",
        "validated",
        "verified_applied",
    ] {
        db::audit(&mut tx, device, "device.apply_state", device, state)
            .await
            .unwrap();
    }
    // Another device's events never join this timeline.
    db::audit(&mut tx, "other", "device.apply_state", "other", "failed")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let (_, page) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/targets",
            created["id"].as_str().unwrap()
        ),
    )
    .await;
    let states: Vec<&str> = page["items"][0]["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["state"].as_str().unwrap())
        .collect();
    assert_eq!(
        states,
        ["desired", "downloaded", "validated", "verified_applied"]
    );
}

#[tokio::test]
async fn timelines_show_each_devices_latest_changes_however_busy_the_page() {
    let f = fixture(2).await;
    let v1 = version(&f.state, &f.pipeline, 1).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let created = rollout::create(&mut tx, &request(&f.devices, &v1, 100, false), "operator")
        .await
        .unwrap();
    // One device flaps through thousands of recorded changes, then verifies.
    let busy = &f.devices[0];
    for n in 0..5100 {
        let state = if n % 2 == 0 { "desired" } else { "downloaded" };
        db::audit(&mut tx, busy, "device.apply_state", busy, state)
            .await
            .unwrap();
    }
    db::audit(
        &mut tx,
        busy,
        "device.apply_state",
        busy,
        "verified_applied",
    )
    .await
    .unwrap();
    // The other device's few changes come after all of those.
    let quiet = &f.devices[1];
    for state in ["desired", "verified_applied"] {
        db::audit(&mut tx, quiet, "device.apply_state", quiet, state)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let (status, page) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/targets",
            created["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    let timeline = |device: &str| -> Vec<String> {
        page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["device_id"] == device)
            .unwrap()["timeline"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["state"].as_str().unwrap().to_owned())
            .collect()
    };
    let flapping = timeline(busy);
    assert_eq!(flapping.len(), 12, "the latest twelve changes");
    assert_eq!(flapping.last().unwrap(), "verified_applied");
    assert_eq!(timeline(quiet), ["desired", "verified_applied"]);
}

#[tokio::test]
async fn summaries_carry_lineage_and_history_filters_by_group_and_rollback() {
    let f = fixture(2).await;
    let v1 = version(&f.state, &f.pipeline, 1).await;
    let v2 = version(&f.state, &f.pipeline, 2).await;
    let group = db::id();
    let mut tx = f.state.pool.begin().await.unwrap();
    db::insert(&mut tx,"group",&json!({"id":group,"name":"web","description":"","device_ids":f.devices,"created_at":db::now(),"revision":1})).await.unwrap();
    let first = rollout::create(&mut tx, &request(&f.devices, &v1, 100, false), "operator")
        .await
        .unwrap();
    let mut grouped = request(&[], &v2, 100, false);
    grouped["selector"]["group_ids"] = json!([group]);
    grouped["replaces"] = json!([first["id"]]);
    let second = rollout::create(&mut tx, &grouped, "operator")
        .await
        .unwrap();
    let rollback = rollout::action(
        &mut tx,
        second["id"].as_str().unwrap(),
        "rollback",
        "operator",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let (_, source) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/summary",
            second["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(source["status"], "cancelled");
    assert_eq!(source["status_before_rollback"], "active");
    assert_eq!(source["rolled_back_by"], rollback["id"]);
    assert_eq!(source["rolled_back_to_version"], 1);
    assert_eq!(source["replaces"][0]["deployment_id"], first["id"]);
    assert_eq!(source["replaces"][0]["version_number"], 1);
    assert_eq!(source["rollback_available"], true);

    let (_, replaced) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/summary",
            first["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(replaced["status"], "unassigned");
    assert_eq!(replaced["status_before_removal"], "active");
    assert_eq!(replaced["replaced_by"][0]["deployment_id"], second["id"]);
    assert_eq!(replaced["replaced_by"][0]["version_number"], 2);
    assert_eq!(replaced["replaced_by"][0]["device_count"], 2);
    // A first deployment has nothing earlier to roll back to.
    assert_eq!(replaced["rollback_available"], false);
    let (_, rows) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/targets",
            first["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(rows["items"][0]["state"], "removed");
    assert_eq!(rows["items"][0]["replaced_by"], second["id"]);

    let (_, back) = get(
        &f,
        &format!(
            "/api/v1/deployments/{}/summary",
            rollback["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(back["rollback_of"], second["id"]);
    assert_eq!(back["rollback_of_version"], 2);

    let (_, filtered) = get(&f, "/api/v1/deployments/history?status=rolled_back").await;
    assert_eq!(filtered["total"], 1);
    assert_eq!(filtered["items"][0]["id"], second["id"]);
    let (_, cancelled) = get(&f, "/api/v1/deployments/history?status=cancelled").await;
    assert_eq!(cancelled["total"], 0);
    let (_, by_group) = get(&f, &format!("/api/v1/deployments/history?group_id={group}")).await;
    assert_eq!(by_group["total"], 1);
    assert_eq!(by_group["items"][0]["id"], second["id"]);
    let (status, _) = get(&f, "/api/v1/deployments/history?group_id=not-a-uuid").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, search) = get(&f, "/api/v1/deployments/history?search=rolled%20back").await;
    assert_eq!(search["total"], 1);
}

#[tokio::test]
async fn a_new_version_prefills_the_values_each_device_already_uses() {
    let f = fixture(3).await;
    let variables = json!([{"name":"metrics_address","path":"/sinks/metrics/address","type":"string"},{"name":"port","path":"/sources/in/port","type":"integer"}]);
    let mut ids = Vec::new();
    for number in [1, 2] {
        let id = db::id();
        let artifact = format!("{{\"data_dir\":\"/var/lib/vectory-page/{number}\"}}\n");
        let mut conn = f.state.pool.acquire().await.unwrap();
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":f.pipeline,"number":number,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"variables":variables,"created_at":db::now()})).await.unwrap();
        ids.push(id);
    }
    // Another pipeline's values never leak into this one.
    let other_pipeline = db::id();
    let other = db::id();
    {
        let mut conn = f.state.pool.acquire().await.unwrap();
        db::insert(
            &mut conn,
            "configuration",
            &json!({"id":other_pipeline,"name":"Other","created_at":db::now()}),
        )
        .await
        .unwrap();
        let artifact = "{\"data_dir\":\"/var/lib/vectory-page/other\"}\n";
        db::insert(&mut conn,"version",&json!({"id":other,"configuration_id":other_pipeline,"number":1,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"variables":variables,"created_at":db::now()})).await.unwrap();
    }
    // Deployments that each device received (generation > 0), oldest first,
    // plus a newer unreleased one and a rollback that binds nothing.
    let mut tx = f.state.pool.begin().await.unwrap();
    let released = |n: usize| format!("2026-01-01T00:00:0{n}Z");
    for (n, devices, version, values, generation) in [
        (
            1,
            &f.devices[..2],
            &ids[0],
            json!({"defaults":{"port":9000},"devices":{f.devices[0].clone():{"metrics_address":"127.0.0.1:9101"},f.devices[1].clone():{"metrics_address":"127.0.0.1:9102","port":9001}}}),
            1,
        ),
        (
            2,
            &f.devices[2..],
            &other,
            json!({"defaults":{"metrics_address":"127.0.0.1:9999","port":1},"devices":{}}),
            1,
        ),
        (3, &f.devices[..1], &ids[0], Value::Null, 2),
        (
            4,
            &f.devices[..1],
            &ids[0],
            json!({"defaults":{"metrics_address":"127.0.0.1:1","port":1},"devices":{}}),
            0,
        ),
    ] {
        let mut deployment = request(devices, version, 100, false);
        let id = db::id();
        deployment["id"] = json!(id);
        deployment["status"] = json!("completed");
        if !values.is_null() {
            deployment["variable_bindings"] = values;
        }
        db::insert(&mut tx, "deployment", &deployment)
            .await
            .unwrap();
        sqlx::query("UPDATE records SET created_at=? WHERE kind='deployment' AND id=?")
            .bind(released(n))
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();
        for device in devices {
            sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,?,?)")
                .bind(&id)
                .bind(device)
                .bind(if generation > 0 { "verified_applied" } else { "pending" })
                .bind(generation)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
    }
    tx.commit().await.unwrap();

    let (status, body) = post(
        &f,
        "/api/v1/deployments/binding-suggestions",
        json!({"version_id":ids[1],"device_ids":f.devices}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["devices"][&f.devices[0]],
        json!({"metrics_address":"127.0.0.1:9101","port":9000})
    );
    assert_eq!(
        body["devices"][&f.devices[1]],
        json!({"metrics_address":"127.0.0.1:9102","port":9001})
    );
    assert!(body["devices"].get(&f.devices[2]).is_none());
    assert_eq!(body["sources"][&f.devices[0]]["version_number"], 1);

    let (status, _) = post(
        &f,
        "/api/v1/deployments/binding-suggestions",
        json!({"version_id":ids[1],"device_ids":f.devices,"extra":true}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_retry_resends_the_same_device_artifact_under_the_new_generation() {
    let f = fixture(1).await;
    let device = &f.devices[0];
    let config = json!({"sources":{"in":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["in"],"buffer":{"max_events":500}}}});
    let variables =
        json!([{"name":"max_events","path":"/sinks/out/buffer/max_events","type":"integer"}]);
    let version = db::id();
    let artifact = format!("{config}\n");
    {
        let mut conn = f.state.pool.acquire().await.unwrap();
        db::insert(&mut conn,"version",&json!({"id":version,"configuration_id":f.pipeline,"number":1,"config":config,"variables":variables,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    }
    let mut tx = f.state.pool.begin().await.unwrap();
    let mut create = request(std::slice::from_ref(device), &version, 100, false);
    create["variable_bindings"] = json!({"defaults":{"max_events":700},"devices":{}});
    rollout::create(&mut tx, &create, "operator").await.unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','failed') WHERE id=?")
        .bind(device)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let artifact_for = |generation: i64| {
        let pool = f.state.pool.clone();
        let device = device.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT sha256 FROM desired_artifacts WHERE device_id=? AND generation=?",
            )
            .bind(device)
            .bind(generation)
            .fetch_optional(&pool)
            .await
            .unwrap()
        }
    };
    let first = artifact_for(1).await.expect("released artifact");

    let (status, body) = post(
        &f,
        &format!("/api/v1/devices/{device}/retry"),
        json!({"expected_version_id":version,"expected_generation":1}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["desired_generation"], 2);
    // The agent's next check-in finds the same rendered artifact, not a gap.
    assert_eq!(artifact_for(2).await.as_deref(), Some(first.as_str()));

    // An earlier server's retry raised the generation without the artifact.
    sqlx::query("UPDATE devices SET desired_generation=3 WHERE id=?")
        .bind(device)
        .execute(&f.state.pool)
        .await
        .unwrap();
    assert!(artifact_for(3).await.is_none());
    // The next release still records the exact prior artifact, and repairs it.
    let next = db::id();
    {
        let mut conn = f.state.pool.acquire().await.unwrap();
        db::insert(&mut conn,"version",&json!({"id":next,"configuration_id":f.pipeline,"number":2,"config":config,"variables":variables,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    }
    let mut tx = f.state.pool.begin().await.unwrap();
    let mut create = request(std::slice::from_ref(device), &next, 200, false);
    create["variable_bindings"] = json!({"defaults":{"max_events":900},"devices":{}});
    let created = rollout::create(&mut tx, &create, "operator").await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(artifact_for(3).await.as_deref(), Some(first.as_str()));
    let previous: Option<String> = sqlx::query_scalar(
        "SELECT previous_artifact_sha256 FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(created["id"].as_str().unwrap())
    .bind(device)
    .fetch_one(&f.state.pool)
    .await
    .unwrap();
    assert_eq!(previous.as_deref(), Some(first.as_str()));
}

#[tokio::test]
async fn a_duplicated_pipeline_prefills_the_values_its_original_runs() {
    let f = fixture(3).await;
    let variables =
        json!([{"name":"metrics_address","path":"/sinks/metrics/address","type":"string"}]);
    let original = db::id();
    let copy = db::id();
    let copy_version = db::id();
    let unrelated = db::id();
    let unrelated_version = db::id();
    let mut tx = f.state.pool.begin().await.unwrap();
    let artifact = "{\"data_dir\":\"/var/lib/vectory-page/original\"}\n";
    db::insert(&mut tx,"version",&json!({"id":original,"configuration_id":f.pipeline,"number":2,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"variables":variables,"created_at":db::now()})).await.unwrap();
    for (id, name, source) in [
        (&copy, "Web access logs (copy)", Some(&f.pipeline)),
        (&unrelated, "Unrelated", None),
    ] {
        db::insert(
            &mut tx,
            "configuration",
            &json!({"id":id,"name":name,"created_at":db::now()}),
        )
        .await
        .unwrap();
        let mut revision = json!({"id":db::id(),"configuration_id":id,"revision":1,"message":"Duplicated saved pipeline","created_at":db::now()});
        if let Some(source) = source {
            revision["source"] = json!({"kind":"draft","id":source,"revision":3});
        } else {
            revision["message"] = json!("Created pipeline");
        }
        db::insert(&mut tx, "revision", &revision).await.unwrap();
    }
    for (id, pipeline) in [(&copy_version, &copy), (&unrelated_version, &unrelated)] {
        let artifact = format!("{{\"data_dir\":\"/var/lib/vectory-page/{id}\"}}\n");
        db::insert(&mut tx,"version",&json!({"id":id,"configuration_id":pipeline,"number":1,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"variables":variables,"created_at":db::now()})).await.unwrap();
    }
    let mut deployment = request(&f.devices[..2], &original, 100, false);
    let deployment_id = db::id();
    deployment["id"] = json!(deployment_id);
    deployment["status"] = json!("completed");
    deployment["variable_bindings"] = json!({"defaults":{},"devices":{f.devices[0].clone():{"metrics_address":"127.0.0.1:9101"},f.devices[1].clone():{"metrics_address":"127.0.0.1:9102"}}});
    db::insert(&mut tx, "deployment", &deployment)
        .await
        .unwrap();
    for device in &f.devices[..2] {
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,'verified_applied',1)")
            .bind(&deployment_id)
            .bind(device)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();

    let (status, body) = post(
        &f,
        "/api/v1/deployments/binding-suggestions",
        json!({"version_id":copy_version,"device_ids":f.devices}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["devices"][&f.devices[0]],
        json!({"metrics_address":"127.0.0.1:9101"})
    );
    assert_eq!(
        body["devices"][&f.devices[1]],
        json!({"metrics_address":"127.0.0.1:9102"})
    );
    assert!(body["devices"].get(&f.devices[2]).is_none());
    assert_eq!(
        body["sources"][&f.devices[0]]["deployment_id"],
        deployment_id
    );
    assert_eq!(body["sources"][&f.devices[0]]["version_number"], 2);
    assert_eq!(
        body["sources"][&f.devices[0]]["configuration_name"],
        "Web access logs"
    );

    // A pipeline that wasn't duplicated from it never borrows its values.
    let (status, body) = post(
        &f,
        "/api/v1/deployments/binding-suggestions",
        json!({"version_id":unrelated_version,"device_ids":f.devices}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["devices"], json!({}));
}
