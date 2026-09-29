use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

async fn actor(s: &State, role: &str) -> (String, String, String) {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.invalid"))
    .bind(role)
    .bind(role)
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    (id, format!("vectory_session={token}"), csrf)
}
async fn fixture() -> (
    tempfile::TempDir,
    State,
    Router,
    Vec<String>,
    String,
    String,
) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-isolated-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Resume admission tests".into(),
        validation_url: None,
    })
    .await
    .unwrap();
    let (_, cookie, csrf) = actor(&s, "admin").await;
    let mut ids = Vec::new();
    for n in 0..3 {
        let id = db::id();
        let d = json!({"id":id,"name":format!("fixture-{n}"),"vector_version":"0.58.0","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(d["name"].as_str().unwrap())
            .bind(d.to_string())
            .execute(&s.pool)
            .await
            .unwrap();
        ids.push(id);
    }
    (temp, s.clone(), api::router(s), ids, cookie, csrf)
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn emit(name: &str, value: &Value) {
    if let Ok(directory) = std::env::var("VECTORY_GROUP_FIXTURES") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{name}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }
}

async fn seed_versions(s: &State) -> (String, String) {
    let a = db::id();
    let b = db::id();
    let configuration = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    for (id, n) in [(&a, 1), (&b, 2)] {
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":configuration,"number":n,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    }
    (a, b)
}
fn binding(
    resource: &str,
    version: &str,
    seconds: u64,
    priority: i64,
    mode: &str,
    group_ids: Value,
    device_ids: Value,
    exclude_ids: Value,
    canary: bool,
) -> Value {
    let mut v = json!({"selector":{"group_ids":group_ids,"device_ids":device_ids,"exclude_ids":exclude_ids},"priority":priority,"target_mode":mode,"rollout":{"kind":if canary{"canary"}else{"all"},"canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}});
    if resource == "configuration" {
        v["version_id"] = json!(version);
    } else {
        v["policy"] =
            json!({"heartbeat_seconds":seconds,"sync_paused":false,"telemetry_enabled":true});
    }
    v
}
async fn create_binding(app: &Router, cookie: &str, csrf: &str, v: Value) -> Value {
    let (status, d) = call(app, "POST", "/api/v1/deployments", v, cookie, csrf).await;
    assert_eq!(status, StatusCode::OK, "{d}");
    d
}
async fn state_snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM records ORDER BY kind,id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,data,desired_version_id,desired_generation,policy,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let targets:Vec<String>=sqlx::query_scalar("SELECT json_array(deployment_id,device_id,state,generation,error,original,released_at,verified_at) FROM deployment_targets ORDER BY deployment_id,device_id").fetch_all(&s.pool).await.unwrap();
    json!({"records":records,"devices":devices,"targets":targets})
}

fn action(d: &Value, name: &str) -> String {
    format!("/api/v1/deployments/{}/{name}", d["id"].as_str().unwrap())
}
async fn pause(app: &Router, d: &Value, cookie: &str, csrf: &str) {
    assert_eq!(
        call(app, "POST", &action(d, "pause"), json!({}), cookie, csrf)
            .await
            .0,
        StatusCode::OK
    );
}
async fn stored_status(s: &State, d: &Value, status: &str) {
    let mut conn = s.pool.acquire().await.unwrap();
    let mut v = db::record(&mut conn, "deployment", d["id"].as_str().unwrap())
        .await
        .unwrap();
    v["status"] = json!(status);
    db::update(&mut conn, "deployment", &v).await.unwrap();
}

#[tokio::test]
async fn resume_rechecks_same_resource_for_all_priorities_modes_and_rollout_kinds() {
    for resource in ["configuration", "policy"] {
        for mode in ["snapshot", "persistent"] {
            for canary in [false, true] {
                for priority in [50, 100, 200] {
                    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
                    let (a, _) = seed_versions(&s).await;
                    let source = create_binding(
                        &app,
                        &cookie,
                        &csrf,
                        binding(
                            resource,
                            &a,
                            180,
                            100,
                            mode,
                            json!([]),
                            json!(ids[..2]),
                            json!([]),
                            canary,
                        ),
                    )
                    .await;
                    pause(&app, &source, &cookie, &csrf).await;
                    create_binding(
                        &app,
                        &cookie,
                        &csrf,
                        binding(
                            resource,
                            &a,
                            180,
                            priority,
                            mode,
                            json!([]),
                            json!([ids[1]]),
                            json!([]),
                            true,
                        ),
                    )
                    .await;
                    let before = state_snapshot(&s).await;
                    let rejected = call(
                        &app,
                        "POST",
                        &action(&source, "resume"),
                        json!({}),
                        &cookie,
                        &csrf,
                    )
                    .await;
                    assert_eq!(
                        rejected.0,
                        StatusCode::CONFLICT,
                        "{resource}/{mode}/{canary}/{priority}: {}",
                        rejected.1
                    );
                    assert_eq!(rejected.1["error"]["code"], "ACTIVE_CANARY_OVERLAP");
                    assert_eq!(state_snapshot(&s).await, before);
                    emit("resume_overlap_error", &rejected.1);
                    emit(
                        "resume_rejected_summary",
                        &call(
                            &app,
                            "GET",
                            &action(&source, "summary"),
                            Value::Null,
                            &cookie,
                            "",
                        )
                        .await
                        .1,
                    );
                    emit(
                        "resume_rejected_targets",
                        &call(
                            &app,
                            "GET",
                            &action(&source, "targets"),
                            Value::Null,
                            &cookie,
                            "",
                        )
                        .await
                        .1,
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn self_and_other_resources_or_inactive_canaries_do_not_block() {
    for case in [
        "self",
        "nonoverlap",
        "independent_policy",
        "independent_configuration",
        "paused",
        "completed",
        "failed",
        "cancelled",
        "unassigned",
        "scheduled",
        "missed",
        "ordinary",
    ] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, _) = seed_versions(&s).await;
        let source_resource = if case == "independent_configuration" {
            "policy"
        } else {
            "configuration"
        };
        let source = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                source_resource,
                &a,
                180,
                100,
                "snapshot",
                json!([]),
                json!(ids[..2]),
                json!([]),
                true,
            ),
        )
        .await;
        pause(&app, &source, &cookie, &csrf).await;
        if case != "self" {
            let other_resource = match case {
                "independent_policy" => "policy",
                "independent_configuration" => "configuration",
                _ => source_resource,
            };
            let other = create_binding(
                &app,
                &cookie,
                &csrf,
                binding(
                    other_resource,
                    &a,
                    180,
                    200,
                    "snapshot",
                    json!([]),
                    json!([ids[if case == "nonoverlap" { 2 } else { 1 }]]),
                    json!([]),
                    case != "ordinary",
                ),
            )
            .await;
            if [
                "paused",
                "completed",
                "failed",
                "cancelled",
                "unassigned",
                "scheduled",
                "missed",
            ]
            .contains(&case)
            {
                stored_status(&s, &other, case).await;
            }
        }
        let result = call(
            &app,
            "POST",
            &action(&source, "resume"),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(result.0, StatusCode::OK, "{case}: {}", result.1);
        assert_eq!(result.1["status"], "active");
    }
}

#[tokio::test]
async fn candidate_scope_uses_frozen_snapshot_current_group_exclusions_and_retirement() {
    for case in [
        "snapshot_group_added",
        "persistent_group_removed",
        "excluded",
        "removed",
        "revoked",
    ] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, _) = seed_versions(&s).await;
        let group=call(&app,"POST","/api/v1/groups",json!({"name":"Scope group","description":"Native fixture","device_ids":if case=="snapshot_group_added"{json!([ids[0]])}else{json!(ids[..2])}}),&cookie,&csrf).await.1;
        let grouped = case.starts_with("snapshot_group") || case.starts_with("persistent_group");
        let source = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                100,
                if case == "persistent_group_removed" {
                    "persistent"
                } else {
                    "snapshot"
                },
                if grouped {
                    json!([group["id"]])
                } else {
                    json!([])
                },
                if grouped { json!([]) } else { json!(ids[..2]) },
                if case == "excluded" {
                    json!([ids[1]])
                } else {
                    json!([])
                },
                false,
            ),
        )
        .await;
        pause(&app, &source, &cookie, &csrf).await;
        if grouped {
            let changed=call(&app,"PUT",&format!("/api/v1/groups/{}",group["id"].as_str().unwrap()),json!({"name":group["name"],"description":group["description"],"revision":group["revision"],"device_ids":if case=="snapshot_group_added"{json!(ids[..2])}else{json!([ids[0]])}}),&cookie,&csrf).await;
            assert_eq!(changed.0, StatusCode::OK);
        }
        if case == "removed" {
            sqlx::query("UPDATE deployment_targets SET state='removed' WHERE deployment_id=? AND device_id=?").bind(source["id"].as_str().unwrap()).bind(&ids[1]).execute(&s.pool).await.unwrap();
        }
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                200,
                "snapshot",
                json!([]),
                json!([ids[1]]),
                json!([]),
                true,
            ),
        )
        .await;
        if case == "revoked" {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &format!("/api/v1/devices/{}/revoke", ids[1]),
                    json!({}),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let old_targets:Vec<String>=sqlx::query_scalar("SELECT json_array(device_id,state,generation,original,released_at,verified_at) FROM deployment_targets WHERE deployment_id=? ORDER BY device_id").bind(source["id"].as_str().unwrap()).fetch_all(&s.pool).await.unwrap();
        let result = call(
            &app,
            "POST",
            &action(&source, "resume"),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(result.0, StatusCode::OK, "{case}: {}", result.1);
        let new_targets:Vec<String>=sqlx::query_scalar("SELECT json_array(device_id,state,generation,original,released_at,verified_at) FROM deployment_targets WHERE deployment_id=? ORDER BY device_id").bind(source["id"].as_str().unwrap()).fetch_all(&s.pool).await.unwrap();
        assert_eq!(
            old_targets, new_targets,
            "{case}: resume must not readmit excluded historical IDs"
        );
    }
}

#[tokio::test]
async fn pending_competitor_and_multiple_canaries_block_without_mutation() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let (a, _) = seed_versions(&s).await;
    let source = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "snapshot",
            json!([]),
            json!([ids[1], ids[2]]),
            json!([]),
            false,
        ),
    )
    .await;
    pause(&app, &source, &cookie, &csrf).await;
    let first = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            200,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    assert_eq!(
        first["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["device_id"] == ids[1])
            .unwrap()["generation"],
        0
    );
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            300,
            "snapshot",
            json!([]),
            json!([ids[2]]),
            json!([]),
            true,
        ),
    )
    .await;
    let before = state_snapshot(&s).await;
    let result = call(
        &app,
        "POST",
        &action(&source, "resume"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(result.0, StatusCode::CONFLICT);
    assert_eq!(result.1["error"]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(state_snapshot(&s).await, before);
}

#[tokio::test]
async fn concurrent_resumes_allow_one_active_canary_and_recheck_the_second() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, _) = seed_versions(&s).await;
    let mut ds = Vec::new();
    for priority in [100, 200] {
        let d = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                priority,
                "snapshot",
                json!([]),
                json!(ids[..2]),
                json!([]),
                true,
            ),
        )
        .await;
        pause(&app, &d, &cookie, &csrf).await;
        ds.push(d);
    }
    let p = action(&ds[0], "resume");
    let q = action(&ds[1], "resume");
    let (x, y) = tokio::join!(
        call(&app, "POST", &p, json!({}), &cookie, &csrf),
        call(&app, "POST", &q, json!({}), &cookie, &csrf)
    );
    assert_eq!(
        [x.0, y.0]
            .into_iter()
            .filter(|s| *s == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        [x.0, y.0]
            .into_iter()
            .filter(|s| *s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let mut conn = s.pool.acquire().await.unwrap();
    let records = db::records(&mut conn, "deployment").await.unwrap();
    assert_eq!(
        records.iter().filter(|d| d["status"] == "active").count(),
        1
    );
    assert_eq!(
        records.iter().filter(|d| d["status"] == "paused").count(),
        1
    );
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.resume'").fetch_one(&mut *conn).await.unwrap();
    assert_eq!(audits, 1);
}

#[tokio::test]
async fn resume_requires_paused_state_live_role_and_csrf() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, _) = seed_versions(&s).await;
    let source = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    for status in [
        "active",
        "failed",
        "cancelled",
        "completed",
        "unassigned",
        "scheduled",
        "missed",
    ] {
        stored_status(&s, &source, status).await;
        let before = state_snapshot(&s).await;
        let rejected = call(
            &app,
            "POST",
            &action(&source, "resume"),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(rejected.0, StatusCode::CONFLICT);
        assert_eq!(state_snapshot(&s).await, before);
    }
    stored_status(&s, &source, "paused").await;
    for role in ["viewer", "editor"] {
        let (_, other, token) = actor(&s, role).await;
        assert_eq!(
            call(
                &app,
                "POST",
                &action(&source, "resume"),
                json!({}),
                &other,
                &token
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(&app, "POST", &action(&source, "resume"), json!({}), "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &action(&source, "resume"),
            json!({}),
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (who, other, token) = actor(&s, "operator").await;
    let guard = s.writer.lock().await;
    let app2 = app.clone();
    let p = action(&source, "resume");
    let handle =
        tokio::spawn(async move { call(&app2, "POST", &p, json!({}), &other, &token).await });
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
        .bind(who)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(handle.await.unwrap().0, StatusCode::UNAUTHORIZED);
    let (_, other, token) = actor(&s, "operator").await;
    assert_eq!(
        call(
            &app,
            "POST",
            &action(&source, "resume"),
            json!({}),
            &other,
            &token
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn late_resume_or_release_audit_failure_rolls_back_status_admission_and_counters() {
    for fault in ["deployment.resume", "deployment.release"] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, _) = seed_versions(&s).await;
        let source = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                100,
                "snapshot",
                json!([]),
                json!(ids[..2]),
                json!([]),
                true,
            ),
        )
        .await;
        pause(&app, &source, &cookie, &csrf).await;
        sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=? AND generation>0").bind(source["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
        sqlx::query("UPDATE devices SET data=json_set(data,'$.reported_generation',desired_generation,'$.apply_state','verified_applied','$.actual_sha256',?) WHERE assignment_id=?").bind(db::hash("{}\n")).bind(source["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
        if fault == "deployment.release" {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &action(&source, "resume"),
                    json!({}),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
            let mut conn = s.pool.acquire().await.unwrap();
            let mut d = db::record(&mut conn, "deployment", source["id"].as_str().unwrap())
                .await
                .unwrap();
            assert!(d["observation_started_at"].is_string());
            d["observation_started_at"] =
                json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
            db::update(&mut conn, "deployment", &d).await.unwrap();
        }
        sqlx::query(&format!("CREATE TRIGGER fail_resume BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='{fault}' BEGIN SELECT RAISE(ABORT,'fixture'); END")).execute(&s.pool).await.unwrap();
        let before = state_snapshot(&s).await;
        if fault == "deployment.resume" {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &action(&source, "resume"),
                    json!({}),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
        } else {
            assert!(vectory_server::rollout::tick(&s).await.is_err());
        }
        assert_eq!(state_snapshot(&s).await, before);
        sqlx::query("DROP TRIGGER fail_resume")
            .execute(&s.pool)
            .await
            .unwrap();
        if fault == "deployment.resume" {
            let resumed = call(
                &app,
                "POST",
                &action(&source, "resume"),
                json!({}),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(resumed.0, StatusCode::OK);
            assert_eq!(
                resumed.1["targets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|t| t["generation"] == 0)
                    .count(),
                1,
                "Resume starts a new window"
            );
        } else {
            vectory_server::rollout::tick(&s).await.unwrap();
            let mut conn = s.pool.acquire().await.unwrap();
            assert!(
                vectory_server::rollout::targets(&mut conn, source["id"].as_str().unwrap())
                    .await
                    .unwrap()
                    .iter()
                    .all(|t| t["generation"].as_i64().unwrap() > 0)
            );
        }
    }
}
/// Promoted from the preserved historical-proof observation.
#[tokio::test]
async fn superseded_canary_proof_cannot_admit_next_target() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let a = db::id();
    let b = db::id();
    let configuration = db::id();
    let mut hashes = Vec::new();
    let mut conn = s.pool.acquire().await.unwrap();
    for (n, id) in [&a, &b].into_iter().enumerate() {
        let artifact=json!({"sources":{"in":{"type":"demo_logs","format":"json","interval":n+1}},"sinks":{"out":{"type":"blackhole","inputs":["in"]}}}).to_string();
        let sha = db::hash(&artifact);
        hashes.push(sha.clone());
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":configuration,"number":n+1,"artifact":artifact,"sha256":sha,"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    }
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('supersession-observation-peer',?,?)").bind(&ids[0]).bind((chrono::Utc::now()+chrono::Duration::days(1)).to_rfc3339()).execute(&mut *conn).await.unwrap();
    drop(conn);
    let agent = vectory_server::device::router(s.clone()).layer(axum::Extension(
        vectory_server::device::PeerCertificate(Some("supersession-observation-peer".into())),
    ));
    let heartbeat = |generation: i64, sha: &str| json!({"protocol_version":1,"request_id":db::id(),"boot_id":"synthetic-boot","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"synthetic","vector_version":"0.58.0","reported_generation":generation,"policy_generation":0,"actual_sha256":sha,"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false});
    let source = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            true,
        ),
    )
    .await;
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat(1, &hashes[0]),
            "",
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    pause(&app, &source, &cookie, &csrf).await;
    let replacement = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            200,
            "snapshot",
            json!([]),
            json!([ids[0]]),
            json!([]),
            false,
        ),
    )
    .await;
    assert_eq!(
        call(
            &agent,
            "POST",
            "/agent/v1/heartbeat",
            heartbeat(2, &hashes[1]),
            "",
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    let before_device = call(
        &app,
        "GET",
        &format!("/api/v1/devices/{}", ids[0]),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(before_device["desired_version_id"], b);
    assert_eq!(before_device["reported_generation"], 2);
    assert_eq!(before_device["apply_state"], "verified_applied");
    assert_eq!(before_device["actual_sha256"], hashes[1]);
    let mut conn = s.pool.acquire().await.unwrap();
    let mut d = db::record(&mut conn, "deployment", source["id"].as_str().unwrap())
        .await
        .unwrap();
    d["observation_started_at"] =
        json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    db::update(&mut conn, "deployment", &d).await.unwrap();
    drop(conn);
    let before = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/{}", source["id"].as_str().unwrap()),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    let after = call(
        &app,
        "POST",
        &action(&source, "resume"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(after.0, StatusCode::OK);
    let target = |v: &Value, id: &str| {
        v["targets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["device_id"] == id)
            .unwrap()
            .clone()
    };
    assert_eq!(target(&before, &ids[0])["state"], "verified_applied");
    assert_eq!(target(&before, &ids[1])["generation"], 0);
    assert_eq!(target(&after.1, &ids[1])["generation"], 0);
    assert!(after.1["observation_started_at"].is_null());
    let current = call(
        &app,
        "GET",
        &format!("/api/v1/devices/{}", ids[0]),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(current["desired_version_id"], b);
    assert_eq!(current["actual_sha256"], hashes[1]);
    emit(
        "canary_historical_proof_regression",
        &json!({"source_before":before,"source_after":after.1,"replacement":replacement,"device_before_resume":before_device,"device_after_resume":current,"different_artifact_hashes":hashes[0]!=hashes[1],"resume_status":200,"next_target_before":target(&before,&ids[1]),"next_target_after":target(&after.1,&ids[1]),"verification_source":"Synthetic authenticated-peer heartbeat through real server handler; no native agent or Vector activation","activation_claimed":false}),
    );
}
