//! Reviewed replacement of existing assignments, history lineage and device
//! status derivation. Synthetic devices and versions only.
use serde_json::{Value, json};
use sqlx::SqliteConnection;
use vectory_server::{Settings, State, db, initialize, rollout};

struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    devices: Vec<String>,
    pipeline: String,
}

async fn fixture(count: usize) -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-replacement-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Replacement tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let mut tx = state.pool.begin().await.unwrap();
    let mut devices = Vec::new();
    for n in 0..count {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let name = format!("edge-{n:02}");
        let data = json!({"id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"policy_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&name)
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
    Fixture {
        _temp: temp,
        state,
        devices,
        pipeline,
    }
}

async fn version(db: &mut SqliteConnection, pipeline: &str, number: i64) -> String {
    let id = db::id();
    // A distinct restricted-mode configuration per version.
    let artifact = format!("{{\"data_dir\":\"/var/lib/vectory-test/{number}\"}}\n");
    db::insert(db,"version",&json!({"id":id,"configuration_id":pipeline,"number":number,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    id
}

fn configuration(devices: &[String], version: &str, priority: i64) -> Value {
    json!({"version_id":version,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}})
}

fn policy(devices: &[String], paused: bool, priority: i64) -> Value {
    json!({"policy":{"heartbeat_seconds":60,"sync_paused":paused,"telemetry_enabled":true},"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}})
}

async fn device(db: &mut SqliteConnection, id: &str) -> Value {
    rollout::devices(db)
        .await
        .unwrap()
        .into_iter()
        .find(|d| d["id"] == id)
        .unwrap()
}

async fn record(db: &mut SqliteConnection, id: &str) -> Value {
    db::record(db, "deployment", id).await.unwrap()
}

async fn target_state(db: &mut SqliteConnection, deployment: &str, device: &str) -> String {
    sqlx::query_scalar("SELECT state FROM deployment_targets WHERE deployment_id=? AND device_id=?")
        .bind(deployment)
        .bind(device)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_new_version_of_the_same_pipeline_is_suggested_as_a_replacement_and_replaces_in_one_step()
{
    let f = fixture(3).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    let old = rollout::create(&mut tx, &configuration(&f.devices, &v2, 110), "operator")
        .await
        .unwrap();

    // Without an explicit replacement the deterministic rule still applies:
    // equal priority with a different payload is a conflict, never a tie-break.
    let mut request = configuration(&f.devices, &v3, 110);
    let preview = rollout::preview(&mut tx, &request).await.unwrap();
    assert_eq!(preview["outcomes"][0]["outcome"], "conflict");
    assert!(
        rollout::create(&mut tx, &request, "operator")
            .await
            .is_err()
    );
    let suggested = &preview["suggested_replaces"][0];
    assert_eq!(suggested["assignment"]["id"], old["id"]);
    assert_eq!(
        suggested["assignment"]["configuration_name"],
        "Web access logs"
    );
    assert_eq!(suggested["assignment"]["version_number"], 2);
    assert_eq!(suggested["device_ids"].as_array().unwrap().len(), 3);
    assert_eq!(preview["suggested_priority"], 110);
    assert_eq!(preview["winning_priority"], 111);
    assert_eq!(preview["conflicts"][0]["assignments"][0]["id"], old["id"]);

    // The reviewed replacement reuses the old priority and has no conflict.
    request["replaces"] = json!([old["id"]]);
    let preview = rollout::preview(&mut tx, &request).await.unwrap();
    assert!(preview["conflicts"].as_array().unwrap().is_empty());
    for outcome in preview["outcomes"].as_array().unwrap() {
        assert_eq!(outcome["outcome"], "replace");
        assert_eq!(outcome["replaces"]["version_number"], 2);
        assert_eq!(outcome["winner"]["id"], old["id"]);
    }
    assert_eq!(preview["replacements"][0]["retires_assignment"], true);
    assert!(preview["suggested_replaces"].as_array().unwrap().is_empty());

    let created = rollout::create(&mut tx, &request, "operator")
        .await
        .unwrap();
    for id in &f.devices {
        let current = device(&mut tx, id).await;
        assert_eq!(current["desired_version_id"], v3);
        assert_eq!(current["assignment"]["id"], created["id"]);
        assert_eq!(current["desired_version"]["number"], 3);
        assert_eq!(
            target_state(&mut tx, old["id"].as_str().unwrap(), id).await,
            "removed"
        );
    }
    // Replacement retires the binding without rewriting the old rollout outcome.
    let retired = record(&mut tx, old["id"].as_str().unwrap()).await;
    assert_eq!(retired["status"], "unassigned");
    assert_eq!(retired["status_before_removal"], "active");
    assert_eq!(retired["replaced_by"][0]["deployment_id"], created["id"]);
    assert_eq!(retired["replaced_by"][0]["device_count"], 3);
    // Previous version history lets the new rollout be rolled back.
    let previous: Option<String> = sqlx::query_scalar(
        "SELECT previous_version_id FROM deployment_targets WHERE deployment_id=? LIMIT 1",
    )
    .bind(created["id"].as_str().unwrap())
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(previous.as_deref(), Some(v2.as_str()));
    assert!(rollout::conflicts(&mut tx, None).await.unwrap().is_empty());
    rollout::resolve(&mut tx).await.unwrap();
}

#[tokio::test]
async fn a_canary_replacement_takes_over_each_device_only_when_it_is_released() {
    let f = fixture(2).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    let old = rollout::create(&mut tx, &configuration(&f.devices, &v2, 100), "operator")
        .await
        .unwrap();
    let mut request = configuration(&f.devices, &v3, 100);
    request["rollout"]["kind"] = json!("canary");
    request["replaces"] = json!([old["id"]]);
    let canary = rollout::create(&mut tx, &request, "operator")
        .await
        .unwrap();
    let (first, second) = (&f.devices[0], &f.devices[1]);
    // The canary device moves to v3; the unreleased device keeps v2 and the
    // resolver sees no equal-priority conflict while both assignments exist.
    assert_eq!(device(&mut tx, first).await["desired_version_id"], v3);
    assert_eq!(device(&mut tx, second).await["desired_version_id"], v2);
    assert_eq!(device(&mut tx, second).await["assignment"]["id"], old["id"]);
    assert_eq!(
        target_state(&mut tx, old["id"].as_str().unwrap(), first).await,
        "removed"
    );
    assert_ne!(
        target_state(&mut tx, old["id"].as_str().unwrap(), second).await,
        "removed"
    );
    assert!(rollout::conflicts(&mut tx, None).await.unwrap().is_empty());
    rollout::resolve(&mut tx).await.unwrap();
    let partial = record(&mut tx, old["id"].as_str().unwrap()).await;
    assert_eq!(partial["status"], "active");
    assert_eq!(partial["replaced_by"][0]["device_count"], 1);

    // Cancelling the canary before release leaves the waiting device managed by v2.
    rollout::action(
        &mut tx,
        canary["id"].as_str().unwrap(),
        "cancel",
        "operator",
    )
    .await
    .unwrap();
    rollout::resolve(&mut tx).await.unwrap();
    assert_eq!(device(&mut tx, second).await["desired_version_id"], v2);
    assert_eq!(device(&mut tx, first).await["desired_version_id"], v3);
    let cancelled = record(&mut tx, canary["id"].as_str().unwrap()).await;
    assert!(cancelled["cancelled_at"].is_string());
}

#[tokio::test]
async fn resuming_sync_replaces_the_pause_settings_instead_of_conflicting() {
    let f = fixture(1).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let pause = rollout::create(&mut tx, &policy(&f.devices, true, 100), "operator")
        .await
        .unwrap();
    assert_eq!(device(&mut tx, &f.devices[0]).await["sync_paused"], true);
    let mut resume = policy(&f.devices, false, 100);
    let preview = rollout::preview(&mut tx, &resume).await.unwrap();
    assert_eq!(preview["outcomes"][0]["outcome"], "conflict");
    assert_eq!(
        preview["suggested_replaces"][0]["assignment"]["id"],
        pause["id"]
    );
    assert_eq!(
        preview["suggested_replaces"][0]["assignment"]["policy"]["sync_paused"],
        true
    );
    resume["replaces"] = json!([pause["id"]]);
    let preview = rollout::preview(&mut tx, &resume).await.unwrap();
    assert_eq!(preview["outcomes"][0]["outcome"], "replace");
    let resumed = rollout::create(&mut tx, &resume, "operator").await.unwrap();
    let current = device(&mut tx, &f.devices[0]).await;
    assert_eq!(current["sync_paused"], false);
    assert_eq!(current["policy_assignment"]["id"], resumed["id"]);
    assert_eq!(current["policy_assignment"]["created_by_name"], Value::Null);
    let retired = record(&mut tx, pause["id"].as_str().unwrap()).await;
    assert_eq!(retired["status"], "unassigned");
    assert_eq!(retired["replaced_by"][0]["deployment_id"], resumed["id"]);
}

#[tokio::test]
async fn persistent_replacement_takes_over_future_members_only_when_it_covers_the_selector() {
    let f = fixture(3).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    let group = db::id();
    db::insert(&mut tx,"group",&json!({"id":group,"name":"edge","description":"","device_ids":[f.devices[0],f.devices[1]],"created_at":db::now(),"revision":1})).await.unwrap();
    let persistent = |version: &str| {
        let mut request = configuration(&[], version, 120);
        request["selector"]["group_ids"] = json!([group]);
        request["target_mode"] = json!("persistent");
        request
    };
    let old = rollout::create(&mut tx, &persistent(&v2), "operator")
        .await
        .unwrap();

    // A snapshot of today's members replaces them but leaves the group binding
    // in place for devices that join later.
    let mut snapshot = configuration(&f.devices[..2], &v3, 120);
    snapshot["replaces"] = json!([old["id"]]);
    let preview = rollout::preview(&mut tx, &snapshot).await.unwrap();
    assert_eq!(preview["replacements"][0]["retires_assignment"], false);

    // A persistent replacement for the same group retires it entirely.
    let mut replacement = persistent(&v3);
    replacement["replaces"] = json!([old["id"]]);
    let preview = rollout::preview(&mut tx, &replacement).await.unwrap();
    assert_eq!(preview["replacements"][0]["retires_assignment"], true);
    let created = rollout::create(&mut tx, &replacement, "operator")
        .await
        .unwrap();
    let retired = record(&mut tx, old["id"].as_str().unwrap()).await;
    assert_eq!(retired["status"], "unassigned");
    let excluded = retired["selector"]["exclude_ids"].as_array().unwrap();
    assert_eq!(excluded.len(), 2);

    // A later member joins only the replacement; no equal-priority conflict.
    let mut edited = db::record(&mut tx, "group", &group).await.unwrap();
    edited["device_ids"] = json!(f.devices);
    db::update(&mut tx, "group", &edited).await.unwrap();
    rollout::reconcile_membership(&mut tx).await.unwrap();
    let joined = device(&mut tx, &f.devices[2]).await;
    assert_eq!(joined["desired_version_id"], v3);
    assert_eq!(joined["assignment"]["id"], created["id"]);
}

#[tokio::test]
async fn replacement_requests_are_validated_and_stale_reviews_are_explicit() {
    let f = fixture(2).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    let first = rollout::create(
        &mut tx,
        &configuration(&f.devices[..1], &v2, 100),
        "operator",
    )
    .await
    .unwrap();
    let settings = rollout::create(&mut tx, &policy(&f.devices, false, 100), "operator")
        .await
        .unwrap();
    let mut request = configuration(&f.devices[1..], &v3, 100);
    // An assignment that does not select these devices is a stale review.
    request["replaces"] = json!([first["id"]]);
    let error = rollout::preview(&mut tx, &request).await.unwrap_err();
    assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(error.code, "REPLACEMENT_CHANGED");
    // Unknown assignments are stale too; other resources and malformed lists are invalid.
    request["replaces"] = json!([db::id()]);
    assert_eq!(
        rollout::preview(&mut tx, &request).await.unwrap_err().code,
        "REPLACEMENT_CHANGED"
    );
    request["replaces"] = json!([settings["id"]]);
    assert_eq!(
        rollout::preview(&mut tx, &request)
            .await
            .unwrap_err()
            .status,
        axum::http::StatusCode::BAD_REQUEST
    );
    let duplicate = first["id"].as_str().unwrap();
    request["replaces"] = json!([duplicate, duplicate]);
    assert!(rollout::validate_request(&request).is_err());
    request["replaces"] = json!(["not-a-uuid"]);
    assert!(rollout::validate_request(&request).is_err());
    request["replaces"] = json!([duplicate.to_uppercase()]);
    assert!(rollout::validate_request(&request).is_err());
}

#[tokio::test]
async fn history_keeps_rollout_outcomes_and_links_rollbacks() {
    let f = fixture(2).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    rollout::create(&mut tx, &configuration(&f.devices, &v2, 100), "operator")
        .await
        .unwrap();
    let newer = rollout::create(&mut tx, &configuration(&f.devices, &v3, 150), "operator")
        .await
        .unwrap();
    let source = newer["id"].as_str().unwrap();
    // Record a completed rollout, as the scheduler does after verification.
    let mut completed = record(&mut tx, source).await;
    completed["status"] = json!("completed");
    db::update(&mut tx, "deployment", &completed).await.unwrap();
    let rollback = rollout::action(&mut tx, source, "rollback", "operator")
        .await
        .unwrap();
    let rolled_back = record(&mut tx, source).await;
    assert_eq!(rolled_back["status"], "cancelled");
    assert_eq!(rolled_back["status_before_rollback"], "completed");
    assert_eq!(rolled_back["rolled_back_by"], rollback["id"]);
    assert!(rolled_back["rolled_back_at"].is_string());
    assert_eq!(rollback["rollback_of"], newer["id"]);
    assert_eq!(rollback["version_id"], v2);

    // Removing an assignment keeps how its rollout ended.
    let removed = rollout::action(
        &mut tx,
        rollback["id"].as_str().unwrap(),
        "unassign",
        "operator",
    )
    .await
    .unwrap();
    assert_eq!(removed["status"], "unassigned");
    assert_eq!(removed["status_before_removal"], "active");
    assert!(removed["removed_at"].is_string());
}

#[tokio::test]
async fn device_status_waits_for_first_check_in_and_tolerates_unacknowledged_intervals() {
    let f = fixture(2).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let (fresh, known) = (&f.devices[0], &f.devices[1]);
    sqlx::query("UPDATE devices SET data=json_remove(data,'$.last_seen') WHERE id=?")
        .bind(fresh)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        device(&mut tx, fresh).await["status"],
        "awaiting_first_check_in"
    );
    // Two minutes of silence is within three default (60 s) check-ins.
    let two_minutes_ago = (chrono::Utc::now() - chrono::Duration::seconds(120))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query("UPDATE devices SET data=json_set(data,'$.last_seen',?) WHERE id=?")
        .bind(&two_minutes_ago)
        .bind(known)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(device(&mut tx, known).await["status"], "unmanaged");
    // A shorter interval is not trusted until the agent acknowledges it.
    let mut quick = policy(&[known.clone()], false, 100);
    quick["policy"]["heartbeat_seconds"] = json!(15);
    rollout::create(&mut tx, &quick, "operator").await.unwrap();
    let pending = device(&mut tx, known).await;
    assert_eq!(pending["check_in_seconds"], 60);
    assert_eq!(pending["status"], "unmanaged");
    assert!(pending.get("heartbeat_floor_seconds").is_none());
    // After acknowledgement the new interval applies.
    let acknowledged: i64 = sqlx::query_scalar("SELECT policy_generation FROM devices WHERE id=?")
        .bind(known)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.policy_generation',?) WHERE id=?")
        .bind(acknowledged)
        .bind(known)
        .execute(&mut *tx)
        .await
        .unwrap();
    let current = device(&mut tx, known).await;
    assert_eq!(current["check_in_seconds"], 15);
    assert_eq!(current["status"], "offline");
}

#[tokio::test]
async fn devices_report_running_and_desired_versions_by_name() {
    let f = fixture(1).await;
    let mut tx = f.state.pool.begin().await.unwrap();
    let v2 = version(&mut tx, &f.pipeline, 2).await;
    let v3 = version(&mut tx, &f.pipeline, 3).await;
    let id = &f.devices[0];
    assert!(device(&mut tx, id).await["running_version"].is_null());
    rollout::create(&mut tx, &configuration(&f.devices, &v3, 100), "operator")
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.verified_configuration_attempt',json(?)) WHERE id=?")
        .bind(json!({"generation":1,"version_id":v2,"sha256":"0".repeat(64),"secret_revision":0}).to_string())
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    let current = device(&mut tx, id).await;
    assert_eq!(current["running_version"]["id"], v2);
    assert_eq!(current["running_version"]["number"], 2);
    assert_eq!(
        current["running_version"]["configuration_name"],
        "Web access logs"
    );
    assert_eq!(current["desired_version"]["number"], 3);
    assert!(current.get("verified_configuration_attempt").is_none());
}
