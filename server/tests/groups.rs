use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize};

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
        instance_name: "Group CAS tests".into(),
        validation_url: None,
        ..Default::default()
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
async fn create_group(app: &Router, cookie: &str, csrf: &str, ids: &[String]) -> Value {
    let (status, group) = call(
        app,
        "POST",
        "/api/v1/groups",
        json!({"name":"Operations","description":"Original","device_ids":ids}),
        cookie,
        csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    assert_eq!(group["revision"], 1);
    group
}
fn edit(group: &Value, ids: &[String]) -> Value {
    json!({"name":group["name"],"description":group["description"],"device_ids":ids,"revision":group["revision"]})
}
fn path(group: &Value) -> String {
    format!("/api/v1/groups/{}", group["id"].as_str().unwrap())
}
fn policy(group: &Value, devices: &[String], seconds: i64) -> Value {
    json!({"policy":{"heartbeat_seconds":seconds,"sync_paused":false,"telemetry_enabled":true},"selector":{"device_ids":devices,"group_ids":if group.is_null(){json!([])}else{json!([group["id"]])},"exclude_ids":[]},"priority":100,"target_mode":"persistent","rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}})
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

#[tokio::test]
async fn stale_metadata_save_preserves_new_member_assignment_and_revision() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (_, second_cookie, second_csrf) = actor(&s, "operator").await;
    let original = create_group(&app, &cookie, &csrf, &ids[..1]).await;
    let (status, stale) = call(
        &app,
        "GET",
        &path(&original),
        Value::Null,
        &second_cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    emit("group_created", &original);
    let (status, binding) = call(
        &app,
        "POST",
        "/api/v1/deployments",
        policy(&original, &[], 180),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{binding}");
    let (status, updated) = call(
        &app,
        "PUT",
        &path(&original),
        edit(&original, &ids[..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["revision"], 2);
    emit("group_updated", &updated);
    let (_, before) = call(
        &app,
        "GET",
        &format!("/api/v1/devices/{}", ids[1]),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(before["policy_assignment"]["id"], binding["id"]);
    let mut stale_edit = edit(&stale, &ids[..1]);
    stale_edit["description"] = json!("Only editing description from old tab");
    let (status, error) = call(
        &app,
        "PUT",
        &path(&original),
        stale_edit,
        &second_cookie,
        &second_csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "STALE_REVISION");
    emit("stale_error", &error);
    assert_eq!(
        call(&app, "GET", &path(&original), Value::Null, &cookie, "")
            .await
            .1,
        updated
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/devices/{}", ids[1]),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1,
        before
    );
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::records(&mut conn, "audit")
            .await
            .unwrap()
            .iter()
            .filter(|a| a["action"] == "group.update")
            .count(),
        1
    );
    drop(conn);
    let mut rename = edit(&updated, &ids[..2]);
    rename["name"] = json!("Operations renamed");
    rename["description"] = json!("Reviewed metadata only");
    let (status, renamed) = call(&app, "PUT", &path(&updated), rename, &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["revision"], 3);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/devices/{}", ids[1]),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1,
        before
    );
}

#[tokio::test]
async fn concurrent_same_revision_writes_have_exactly_one_winner() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (_, other_cookie, other_csrf) = actor(&s, "operator").await;
    let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
    let url = path(&group);
    let mut left = edit(&group, &ids[..2]);
    left["description"] = json!("Left");
    let mut right = edit(&group, &ids[..1]);
    right["description"] = json!("Right");
    let (a, b) = tokio::join!(
        call(&app, "PUT", &url, left, &cookie, &csrf),
        call(&app, "PUT", &url, right, &other_cookie, &other_csrf)
    );
    assert_eq!(
        [a.0, b.0].iter().filter(|s| **s == StatusCode::OK).count(),
        1
    );
    assert_eq!(
        [a.0, b.0]
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let final_group = call(&app, "GET", &url, Value::Null, &cookie, "").await.1;
    assert_eq!(final_group["revision"], 2);
    assert_eq!(final_group, if a.0 == StatusCode::OK { a.1 } else { b.1 });
}

#[tokio::test]
async fn revisions_are_required_bounded_and_legacy_reads_are_nonmutating() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
    let url = path(&group);
    for bad in [
        Value::Null,
        json!("1"),
        json!(true),
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992u64),
    ] {
        let mut body = edit(&group, &ids);
        body["revision"] = bad;
        let (status, error) = call(&app, "PUT", &url, body, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error["error"]["code"], "INVALID_INPUT");
    }
    let mut missing = edit(&group, &ids);
    missing.as_object_mut().unwrap().remove("revision");
    assert_eq!(
        call(&app, "PUT", &url, missing, &cookie, &csrf).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/v1/groups/missing",
            edit(&group, &ids),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut legacy = group.clone();
    legacy.as_object_mut().unwrap().remove("revision");
    let mut conn = s.pool.acquire().await.unwrap();
    db::update(&mut conn, "group", &legacy).await.unwrap();
    drop(conn);
    let (_, read) = call(&app, "GET", &url, Value::Null, &cookie, "").await;
    assert_eq!(read["revision"], 0);
    emit("legacy_group", &read);
    let (_, list) = call(&app, "GET", "/api/v1/groups", Value::Null, &cookie, "").await;
    assert_eq!(list[0]["revision"], 0);
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut conn, "group", group["id"].as_str().unwrap())
            .await
            .unwrap(),
        legacy
    );
    drop(conn);
    let (status, upgraded) = call(&app, "PUT", &url, edit(&read, &ids), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(upgraded["revision"], 1);
    let mut exhausted = upgraded.clone();
    exhausted["revision"] = json!(9_007_199_254_740_991u64);
    let mut conn = s.pool.acquire().await.unwrap();
    db::update(&mut conn, "group", &exhausted).await.unwrap();
    drop(conn);
    assert_eq!(
        call(&app, "PUT", &url, edit(&exhausted, &ids), &cookie, &csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", &url, Value::Null, &cookie, "").await.1,
        exhausted
    );
}

#[tokio::test]
async fn roles_csrf_and_queued_offboarding_guard_edits() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
    let url = path(&group);
    assert_eq!(
        call(&app, "GET", &url, Value::Null, "", "").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&app, "PUT", &url, edit(&group, &ids), &cookie, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for role in ["viewer", "editor"] {
        let (_, c, t) = actor(&s, role).await;
        assert_eq!(
            call(&app, "GET", &url, Value::Null, &c, "").await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&app, "PUT", &url, edit(&group, &ids), &c, &t).await.0,
            StatusCode::FORBIDDEN
        );
    }
    let (id, c, t) = actor(&s, "operator").await;
    let lock = s.writer.lock().await;
    let router = app.clone();
    let update_url = url.clone();
    let body = edit(&group, &ids);
    let task = tokio::spawn(async move { call(&router, "PUT", &update_url, body, &c, &t).await });
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    sqlx::query("DELETE FROM sessions WHERE user_id=?")
        .bind(&id)
        .execute(&s.pool)
        .await
        .unwrap();
    drop(lock);
    assert_eq!(task.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        call(&app, "GET", &url, Value::Null, &cookie, "").await.1,
        group
    );
}

#[tokio::test]
async fn reconcile_conflict_and_late_audit_failure_roll_back_revision_and_assignments() {
    for fault in [false, true] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
        let url = path(&group);
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/v1/deployments",
                policy(&group, &[], 180),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::OK
        );
        if fault {
            sqlx::query("CREATE TRIGGER reject_group_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='group.update' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").execute(&s.pool).await.unwrap();
        } else {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    "/api/v1/deployments",
                    policy(&Value::Null, &ids[1..2], 60),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        let before = call(&app, "GET", "/api/v1/devices", Value::Null, &cookie, "")
            .await
            .1;
        let mut conn = s.pool.acquire().await.unwrap();
        let audits = db::records(&mut conn, "audit").await.unwrap();
        drop(conn);
        let snapshot = state_snapshot(&s).await;
        let (status, error) =
            call(&app, "PUT", &url, edit(&group, &ids[..2]), &cookie, &csrf).await;
        assert_eq!(state_snapshot(&s).await, snapshot);
        assert_eq!(
            status,
            if fault {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::CONFLICT
            }
        );
        assert_eq!(
            error["error"]["code"],
            if fault { "INTERNAL" } else { "CONFLICT" }
        );
        assert_eq!(
            call(&app, "GET", &url, Value::Null, &cookie, "").await.1,
            group
        );
        assert_eq!(
            call(&app, "GET", "/api/v1/devices", Value::Null, &cookie, "")
                .await
                .1,
            before
        );
        let mut conn = s.pool.acquire().await.unwrap();
        assert_eq!(db::records(&mut conn, "audit").await.unwrap(), audits);
    }
}

#[tokio::test]
async fn device_revocation_invalidates_only_affected_group_edits_and_is_atomic() {
    for fault in [false, true] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
        let unrelated = create_group(&app, &cookie, &csrf, &ids[2..]).await;
        let (version, _) = seed_versions(&s).await;
        let assignment = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &version,
                180,
                100,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        let target_before = full_target(&s, assignment["id"].as_str().unwrap(), &ids[0]).await;
        if fault {
            sqlx::query("CREATE TRIGGER reject_revoke_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.revoke' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").execute(&s.pool).await.unwrap();
        }
        let action = format!("/api/v1/devices/{}/revoke", ids[0]);
        assert_eq!(
            call(&app, "POST", &action, json!({}), &cookie, &csrf)
                .await
                .0,
            if fault {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::OK
            }
        );
        let after = call(&app, "GET", &path(&group), Value::Null, &cookie, "")
            .await
            .1;
        assert_eq!(
            call(&app, "GET", &path(&unrelated), Value::Null, &cookie, "")
                .await
                .1,
            unrelated
        );
        let revoked: bool = sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(revoked, !fault);
        let mut expected = target_before.clone();
        if !fault {
            expected["state"] = json!("removed");
        }
        assert_eq!(
            full_target(&s, assignment["id"].as_str().unwrap(), &ids[0]).await,
            expected
        );
        if fault {
            assert_eq!(after, group);
        } else {
            assert_eq!(after["revision"], 2);
            assert_eq!(after["device_ids"], json!([ids[1]]));
            let (status, error) = call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, &ids[..2]),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error["error"]["code"], "STALE_REVISION");
            assert_eq!(
                call(&app, "POST", &action, json!({}), &cookie, &csrf)
                    .await
                    .0,
                StatusCode::OK
            );
            assert_eq!(
                call(&app, "GET", &path(&group), Value::Null, &cookie, "")
                    .await
                    .1,
                after
            );
        }
    }
}

#[tokio::test]
async fn recovery_retirement_invalidates_group_review_without_inheriting_membership() {
    for fault in [false, true] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
        let unrelated = create_group(&app, &cookie, &csrf, &ids[2..]).await;
        let (version, _) = seed_versions(&s).await;
        let assignment = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &version,
                180,
                100,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        let target_before = full_target(&s, assignment["id"].as_str().unwrap(), &ids[0]).await;
        let (status, authorization) = call(
            &app,
            "POST",
            &format!("/api/v1/devices/{}/recover", ids[0]),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        if fault {
            sqlx::query("CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='device.recovery_complete' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").execute(&s.pool).await.unwrap();
        }
        let key = rcgen::KeyPair::generate().unwrap();
        let csr = rcgen::CertificateParams::default()
            .serialize_request(&key)
            .unwrap()
            .pem()
            .unwrap();
        let input = json!({"protocol_version":1,"request_id":db::id(),"token":authorization["token"],"name":"fixture-0","csr_pem":csr,"os":"windows","arch":"amd64","agent_version":"test","vector_version":"0.58.0"});
        let (status, result) = call(
            &device::router(s.clone()),
            "POST",
            "/agent/v1/enroll",
            input.clone(),
            "",
            "",
        )
        .await;
        assert_eq!(
            status,
            if fault {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::OK
            }
        );
        let after = call(&app, "GET", &path(&group), Value::Null, &cookie, "")
            .await
            .1;
        assert_eq!(
            call(&app, "GET", &path(&unrelated), Value::Null, &cookie, "")
                .await
                .1,
            unrelated
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM devices")
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(count, if fault { 3 } else { 4 });
        let revoked: bool = sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(revoked, !fault);
        if fault {
            assert_eq!(after, group);
            assert_eq!(
                full_target(&s, assignment["id"].as_str().unwrap(), &ids[0]).await,
                target_before
            );
        } else {
            let mut expected = target_before.clone();
            expected["state"] = json!("removed");
            assert_eq!(
                full_target(&s, assignment["id"].as_str().unwrap(), &ids[0]).await,
                expected
            );
            let inherited: i64 =
                sqlx::query_scalar("SELECT count(*) FROM deployment_targets WHERE device_id=?")
                    .bind(result["device_id"].as_str().unwrap())
                    .fetch_one(&s.pool)
                    .await
                    .unwrap();
            assert_eq!(inherited, 0);
            assert_ne!(result["device_id"], ids[0]);
            assert_eq!(after["revision"], 2);
            assert_eq!(after["device_ids"], json!([ids[1]]));
            let (status, replay) = call(
                &device::router(s.clone()),
                "POST",
                "/agent/v1/enroll",
                input,
                "",
                "",
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(replay["device_id"], result["device_id"]);
            assert_eq!(
                call(&app, "GET", &path(&group), Value::Null, &cookie, "")
                    .await
                    .1,
                after
            );
            let (status, error) = call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, &ids[..2]),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(error["error"]["code"], "STALE_REVISION");
        }
    }
}

// Regression for the independently recorded cross-assignment admission bypass.
#[tokio::test]
async fn group_expansion_cannot_bypass_a_different_active_canary() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let mut canary_ids = vec![ids[0].clone(), ids[2].clone()];
    canary_ids.sort();
    let x = &canary_ids[0];
    let group = create_group(&app, &cookie, &csrf, &ids[1..2]).await;
    let first = db::id();
    let second = db::id();
    let configuration = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    for (id, number) in [(&first, 1), (&second, 2)] {
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":configuration,"number":number,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    }
    drop(conn);
    let rollout = json!({"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0});
    let high_body = json!({"version_id":second,"selector":{"device_ids":[],"group_ids":[group["id"]],"exclude_ids":[]},"priority":200,"target_mode":"persistent","rollout":rollout});
    let (status, high) = call(
        &app,
        "POST",
        "/api/v1/deployments",
        high_body,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut low_body = json!({"version_id":first,"selector":{"device_ids":canary_ids,"group_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"snapshot","rollout":rollout});
    low_body["rollout"]["kind"] = json!("canary");
    let (status, low) = call(
        &app,
        "POST",
        "/api/v1/deployments",
        low_body,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let before = call(
        &app,
        "GET",
        &format!("/api/v1/devices/{x}"),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(before["desired_version_id"], first);
    let direct = json!({"version_id":second,"selector":{"device_ids":[x],"group_ids":[],"exclude_ids":[]},"priority":200,"target_mode":"snapshot","rollout":rollout});
    let (status, preview) = call(
        &app,
        "POST",
        "/api/v1/deployments/preview",
        direct.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["blockers"][0]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(
        call(&app, "POST", "/api/v1/deployments", direct, &cookie, &csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, changed) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &[ids[1].clone(), x.clone()]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(changed["error"]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(
        call(&app, "GET", &path(&group), Value::Null, &cookie, "")
            .await
            .1,
        group
    );
    let after = call(
        &app,
        "GET",
        &format!("/api/v1/devices/{x}"),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(after, before);
    assert_ne!(after["assignment"]["id"], high["id"]);
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}", low["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1["status"],
        "active"
    );
    emit(
        "cross_assignment_guard",
        &json!({"blocked":true,"group_put_status":409,"error":changed,"group_unchanged":true,"device_unchanged":true,"active_canary_still_active":true}),
    );
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

#[tokio::test]
async fn membership_admission_blocks_both_resources_all_priorities_and_is_atomic() {
    for resource in ["configuration", "policy"] {
        for priority in [50, 100, 200] {
            let (_temp, s, app, ids, cookie, csrf) = fixture().await;
            let group = create_group(&app, &cookie, &csrf, &ids[1..2]).await;
            let (a, b) = seed_versions(&s).await;
            create_binding(
                &app,
                &cookie,
                &csrf,
                binding(
                    resource,
                    &b,
                    180,
                    priority,
                    "persistent",
                    json!([group["id"]]),
                    json!([]),
                    json!([]),
                    false,
                ),
            )
            .await;
            create_binding(
                &app,
                &cookie,
                &csrf,
                binding(
                    resource,
                    &a,
                    60,
                    100,
                    "snapshot",
                    json!([]),
                    json!([ids[0], ids[2]]),
                    json!([]),
                    true,
                ),
            )
            .await;
            let before = state_snapshot(&s).await;
            let (status, error) = call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, &ids[..2]),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(
                status,
                StatusCode::CONFLICT,
                "{resource} {priority}: {error}"
            );
            assert_eq!(error["error"]["code"], "ACTIVE_CANARY_OVERLAP");
            assert_eq!(state_snapshot(&s).await, before);
        }
    }
}

#[tokio::test]
async fn membership_admission_respects_resource_and_blocker_state() {
    for (resource, blocker_resource, status, blocked) in [
        ("configuration", "policy", "active", false),
        ("policy", "configuration", "active", false),
        ("configuration", "configuration", "paused", false),
        ("configuration", "configuration", "completed", false),
        ("policy", "policy", "cancelled", false),
        ("policy", "policy", "failed", false),
        ("policy", "policy", "unassigned", false),
    ] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let group = create_group(&app, &cookie, &csrf, &ids[1..2]).await;
        let (a, b) = seed_versions(&s).await;
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                resource,
                &b,
                180,
                200,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        let mut canary = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                blocker_resource,
                &a,
                60,
                100,
                "snapshot",
                json!([]),
                json!([ids[0], ids[2]]),
                json!([]),
                true,
            ),
        )
        .await;
        canary["status"] = json!(status);
        let mut conn = s.pool.acquire().await.unwrap();
        db::update(&mut conn, "deployment", &canary).await.unwrap();
        drop(conn);
        let (status, result) = call(
            &app,
            "PUT",
            &path(&group),
            edit(&group, &ids[..2]),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(
            status,
            if blocked {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            },
            "{resource} {blocker_resource}: {result}"
        );
    }
}

#[tokio::test]
async fn membership_admission_uses_effective_sets_not_raw_groups_or_target_rows() {
    for case in [
        "direct",
        "other_group",
        "excluded",
        "metadata",
        "removal",
        "snapshot",
        "failed",
        "cancelled",
        "revoked",
    ] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, b) = seed_versions(&s).await;
        let group = create_group(
            &app,
            &cookie,
            &csrf,
            if case == "removal" {
                &ids[..2]
            } else {
                &ids[1..2]
            },
        )
        .await;
        let other = create_group(&app, &cookie, &csrf, &ids[..1]).await;
        let groups = if case == "other_group" {
            json!([group["id"], other["id"]])
        } else {
            json!([group["id"]])
        };
        let direct = if case == "direct" {
            json!([ids[0]])
        } else {
            json!([])
        };
        let excluded = if case == "excluded" {
            json!([ids[0]])
        } else {
            json!([])
        };
        let mut incoming = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &b,
                180,
                200,
                if case == "snapshot" {
                    "snapshot"
                } else {
                    "persistent"
                },
                groups,
                direct,
                excluded,
                false,
            ),
        )
        .await;
        if ["failed", "cancelled"].contains(&case) {
            incoming["status"] = json!(case);
            let mut conn = s.pool.acquire().await.unwrap();
            db::update(&mut conn, "deployment", &incoming)
                .await
                .unwrap();
        }
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                60,
                100,
                "snapshot",
                json!([]),
                json!([ids[0], ids[2]]),
                json!([]),
                true,
            ),
        )
        .await;
        let members = if ["metadata", "removal"].contains(&case) {
            &ids[1..2]
        } else {
            &ids[..2]
        };
        if case == "revoked" {
            sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
                .bind(&ids[0])
                .execute(&s.pool)
                .await
                .unwrap();
            let before = state_snapshot(&s).await;
            let (status, _) = call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, members),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(state_snapshot(&s).await, before);
            continue;
        }
        let (status, result) = call(
            &app,
            "PUT",
            &path(&group),
            edit(&group, members),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{case}: {result}");
    }
}

#[tokio::test]
async fn own_canary_expansion_remains_gated_but_other_canary_new_members_block() {
    for other in [false, true] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, b) = seed_versions(&s).await;
        let group = create_group(&app, &cookie, &csrf, &ids[1..2]).await;
        let own = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &b,
                180,
                200,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                true,
            ),
        )
        .await;
        if other {
            create_binding(
                &app,
                &cookie,
                &csrf,
                binding(
                    "configuration",
                    &a,
                    60,
                    100,
                    "snapshot",
                    json!([]),
                    json!([ids[0], ids[2]]),
                    json!([]),
                    true,
                ),
            )
            .await;
        }
        let before = state_snapshot(&s).await;
        let (status, result) = call(
            &app,
            "PUT",
            &path(&group),
            edit(&group, &ids[..2]),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(
            status,
            if other {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            },
            "{result}"
        );
        if other {
            assert_eq!(state_snapshot(&s).await, before);
        } else {
            let (state,generation):(String,i64)=sqlx::query_as("SELECT state,generation FROM deployment_targets WHERE deployment_id=? AND device_id=?").bind(own["id"].as_str().unwrap()).bind(&ids[0]).fetch_one(&s.pool).await.unwrap();
            assert_eq!((state.as_str(), generation), ("pending", 0));
            assert_eq!(
                call(
                    &app,
                    "GET",
                    &format!("/api/v1/devices/{}", ids[0]),
                    Value::Null,
                    &cookie,
                    ""
                )
                .await
                .1["desired_version_id"],
                Value::Null
            );
        }
    }
}

#[tokio::test]
async fn multiple_affected_assignments_are_guarded_before_any_admission() {
    for incoming_state in ["active", "paused", "completed"] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, b) = seed_versions(&s).await;
        let group = create_group(&app, &cookie, &csrf, &ids[1..2]).await;
        // One allowed resource plus a blocked one: transaction cannot partially admit.
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "policy",
                &b,
                180,
                200,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        let mut incoming = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &b,
                180,
                200,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        incoming["status"] = json!(incoming_state);
        let mut conn = s.pool.acquire().await.unwrap();
        db::update(&mut conn, "deployment", &incoming)
            .await
            .unwrap();
        drop(conn);
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                60,
                100,
                "snapshot",
                json!([]),
                json!([ids[0], ids[2]]),
                json!([]),
                true,
            ),
        )
        .await;
        let before = state_snapshot(&s).await;
        assert_eq!(
            call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, &ids[..2]),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(state_snapshot(&s).await, before);
    }
}

#[tokio::test]
async fn group_revision_audit_is_safe_lazy_and_exported_without_private_fields() {
    for previous in [0u64, 9007199254740990] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let mut group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
        if previous == 0 {
            group.as_object_mut().unwrap().remove("revision");
        } else {
            group["revision"] = json!(previous);
        }
        let mut conn = s.pool.acquire().await.unwrap();
        db::update(&mut conn, "group", &group).await.unwrap();
        drop(conn);
        let mut body = edit(&group, &ids[..1]);
        body["revision"] = json!(previous);
        body["description"] = json!("Reviewed metadata");
        let (status, _) = call(&app, "PUT", &path(&group), body, &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK);
        let mut conn = s.pool.acquire().await.unwrap();
        let events = db::records(&mut conn, "audit").await.unwrap();
        drop(conn);
        let event = events
            .iter()
            .find(|e| e["action"] == "group.update")
            .unwrap();
        assert_eq!(event["previous_group_revision"], previous);
        assert_eq!(event["group_revision"], previous + 1);
        let (status, detail) = call(
            &app,
            "GET",
            &format!("/api/v1/audit/{}", event["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            detail["details"],
            json!({"previous_group_revision":previous,"group_revision":previous+1})
        );
        let history = call(
            &app,
            "GET",
            "/api/v1/audit/history?action=group.update",
            Value::Null,
            &cookie,
            "",
        )
        .await
        .1;
        assert!(history["items"][0].get("details").is_none());
        assert!(history["items"][0].get("group_revision").is_none());
        emit(
            if previous == 0 {
                "group_history_legacy"
            } else {
                "group_history_large"
            },
            &history,
        );
        let (status, ready) = call(
            &app,
            "POST",
            "/api/v1/audit/exports",
            json!({"action":"group.update"}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{ready}");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(ready["download_path"].as_str().unwrap())
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let lines = std::str::from_utf8(&bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1]["event"]["details"], detail["details"]);
        emit(
            if previous == 0 {
                "group_audit_legacy"
            } else {
                "group_audit_large"
            },
            &detail,
        );
        emit(
            if previous == 0 {
                "group_export_legacy"
            } else {
                "group_export_large"
            },
            &json!(lines),
        );
    }
}

#[tokio::test]
async fn two_canaries_sharing_changed_group_reject_new_overlap_atomically() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let group = create_group(&app, &cookie, &csrf, &[]).await;
    for (version, priority, device) in [(&a, 100, &ids[1]), (&b, 200, &ids[2])] {
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                version,
                180,
                priority,
                "persistent",
                json!([group["id"]]),
                json!([device]),
                json!([]),
                true,
            ),
        )
        .await;
    }
    let before = state_snapshot(&s).await;
    let (status, error) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[..1]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(state_snapshot(&s).await, before);
}

#[tokio::test]
async fn group_audit_projection_omits_legacy_invalid_and_other_action_revision_fields() {
    let (_temp, s, app, _, cookie, _) = fixture().await;
    for (index, action, previous, next, expected) in [
        (0, "group.update", Value::Null, Value::Null, json!({})),
        (
            1,
            "group.update",
            json!(-1),
            json!(9007199254740992u64),
            json!({}),
        ),
        (
            2,
            "group.update",
            json!("0"),
            json!({"secret":"PRIVATE_REVISION"}),
            json!({}),
        ),
        (3, "group.update", json!(0.5), json!(true), json!({})),
        (4, "device.apply_state", json!(0), json!(1), json!({})),
        (
            5,
            "group.update",
            json!(0),
            json!(1),
            json!({"previous_group_revision":0,"group_revision":1}),
        ),
    ] {
        let event = json!({"id":db::id(),"actor":"system","action":action,"target":db::id(),"outcome":"success","created_at":db::now(),"previous_group_revision":previous,"group_revision":next,"private":"PRIVATE_REVISION","details":{"private":"PRIVATE_REVISION"}});
        let mut conn = s.pool.acquire().await.unwrap();
        db::insert(&mut conn, "audit", &event).await.unwrap();
        drop(conn);
        let (status, detail) = call(
            &app,
            "GET",
            &format!("/api/v1/audit/{}", event["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["details"], expected, "case {index}");
        assert!(!detail.to_string().contains("PRIVATE_REVISION"));
    }
}

#[tokio::test]
async fn historical_removed_target_does_not_bypass_readdition_guard() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
    let incoming = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            200,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([]),
            false,
        ),
    )
    .await;
    let (status, group) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[1..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let state: String = sqlx::query_scalar(
        "SELECT state FROM deployment_targets WHERE deployment_id=? AND device_id=?",
    )
    .bind(incoming["id"].as_str().unwrap())
    .bind(&ids[0])
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(state, "removed");
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            60,
            100,
            "snapshot",
            json!([]),
            json!([ids[0], ids[2]]),
            json!([]),
            true,
        ),
    )
    .await;
    let before = state_snapshot(&s).await;
    let (status, error) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["error"]["code"], "ACTIVE_CANARY_OVERLAP");
    assert_eq!(state_snapshot(&s).await, before);
}

// Regression for the recorded persistent retirement bookkeeping gap.
#[tokio::test]
async fn retirement_marks_only_current_persistent_targets_removed() {
    let mut observations = Vec::new();
    for case in ["persistent_revoke", "persistent_remove", "snapshot_revoke"] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, _) = seed_versions(&s).await;
        let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
        let d = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                100,
                if case == "snapshot_revoke" {
                    "snapshot"
                } else {
                    "persistent"
                },
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        if case == "persistent_remove" {
            assert_eq!(
                call(
                    &app,
                    "PUT",
                    &path(&group),
                    edit(&group, &[]),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
        } else {
            assert_eq!(
                call(
                    &app,
                    "POST",
                    &format!("/api/v1/devices/{}/revoke", ids[0]),
                    json!({}),
                    &cookie,
                    &csrf
                )
                .await
                .0,
                StatusCode::OK
            );
        }
        vectory_server::rollout::tick(&s).await.unwrap();
        let summary = call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}/summary", d["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            "",
        )
        .await
        .1;
        let targets = call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}/targets", d["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            "",
        )
        .await
        .1;
        emit(&format!("retirement_{case}_summary"), &summary);
        emit(&format!("retirement_{case}_targets"), &targets);
        emit(
            &format!("retirement_{case}_history"),
            &call(
                &app,
                "GET",
                "/api/v1/deployments/history",
                Value::Null,
                &cookie,
                "",
            )
            .await
            .1,
        );
        assert_eq!(summary["target_count"], 1);
        assert_eq!(summary["verified_count"], 0);
        assert_eq!(
            summary["status"],
            if case == "snapshot_revoke" {
                "active"
            } else {
                "completed"
            }
        );
        assert_eq!(
            targets["items"][0]["state"],
            if case == "snapshot_revoke" {
                "desired"
            } else {
                "removed"
            }
        );
        observations.push(json!({"case":case,"status":summary["status"],"target_count":summary["target_count"],"verified_count":summary["verified_count"],"target_state":targets["items"][0]["state"],"target_generation":targets["items"][0]["generation"]}));
    }
    emit(
        "retirement_regression",
        &json!({"scope":"Retirement regression; synthetic identities, no agent activation.","observations":observations}),
    );
}

async fn full_target(s: &State, deployment: &str, device: &str) -> Value {
    let raw:String=sqlx::query_scalar("SELECT json_object('deployment_id',deployment_id,'device_id',device_id,'state',state,'generation',generation,'previous_version_id',previous_version_id,'released_at',released_at,'verified_at',verified_at,'error',error,'original',original) FROM deployment_targets WHERE deployment_id=? AND device_id=?").bind(deployment).bind(device).fetch_one(&s.pool).await.unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn retirement_preserves_proof_and_frozen_history_across_resources_and_states() {
    for resource in ["configuration", "policy"] {
        for status in [
            "active",
            "paused",
            "completed",
            "cancelled",
            "failed",
            "unassigned",
        ] {
            for mode in ["persistent", "snapshot"] {
                let (_temp, s, app, ids, cookie, csrf) = fixture().await;
                let (a, b) = seed_versions(&s).await;
                let group = create_group(&app, &cookie, &csrf, &ids[..1]).await;
                // Policy uses direct identity; configuration uses group membership.
                let groups = if resource == "configuration" {
                    json!([group["id"]])
                } else {
                    json!([])
                };
                let direct = if resource == "policy" {
                    json!([ids[0]])
                } else {
                    json!([])
                };
                let mut d = create_binding(
                    &app,
                    &cookie,
                    &csrf,
                    binding(
                        resource,
                        &a,
                        180,
                        100,
                        mode,
                        groups,
                        direct,
                        json!([]),
                        false,
                    ),
                )
                .await;
                sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at='2026-09-26T00:00:00Z',previous_version_id=?,error=NULL WHERE deployment_id=?").bind(&b).bind(d["id"].as_str().unwrap()).execute(&s.pool).await.unwrap();
                d["status"] = json!(status);
                let mut conn = s.pool.acquire().await.unwrap();
                db::update(&mut conn, "deployment", &d).await.unwrap();
                drop(conn);
                let before = full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await;
                let delivered: (String, i64, i64) = sqlx::query_as(
                    "SELECT data,desired_generation,policy_generation FROM devices WHERE id=?",
                )
                .bind(&ids[0])
                .fetch_one(&s.pool)
                .await
                .unwrap();
                assert_eq!(
                    call(
                        &app,
                        "POST",
                        &format!("/api/v1/devices/{}/revoke", ids[0]),
                        json!({}),
                        &cookie,
                        &csrf
                    )
                    .await
                    .0,
                    StatusCode::OK
                );
                let mut expected = before.clone();
                if mode == "persistent" && ["active", "paused", "completed"].contains(&status) {
                    expected["state"] = json!("removed");
                }
                assert_eq!(
                    full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
                    expected,
                    "{resource}/{mode}/{status}"
                );
                let after: (String, i64, i64) = sqlx::query_as(
                    "SELECT data,desired_generation,policy_generation FROM devices WHERE id=?",
                )
                .bind(&ids[0])
                .fetch_one(&s.pool)
                .await
                .unwrap();
                assert_eq!(after, delivered);
                assert_eq!(
                    call(
                        &app,
                        "POST",
                        &format!("/api/v1/devices/{}/revoke", ids[0]),
                        json!({}),
                        &cookie,
                        &csrf
                    )
                    .await
                    .0,
                    StatusCode::OK
                );
                assert_eq!(
                    full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
                    expected
                );
                let summary = call(
                    &app,
                    "GET",
                    &format!("/api/v1/deployments/{}/summary", d["id"].as_str().unwrap()),
                    Value::Null,
                    &cookie,
                    "",
                )
                .await
                .1;
                assert_eq!(summary["target_count"], 1);
                assert_eq!(
                    summary["verified_count"],
                    if expected["state"] == "removed" { 0 } else { 1 }
                );
            }
        }
    }
}

#[tokio::test]
async fn revoke_does_not_admit_next_canary_or_depend_on_unrelated_conflicts() {
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let (a, b) = seed_versions(&s).await;
    let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([]),
            true,
        ),
    )
    .await;
    let pending = full_target(&s, d["id"].as_str().unwrap(), &ids[1]).await;
    assert_eq!(pending["generation"], 0);
    // Corrupt unrelated stored assignments to establish that security revocation
    // is independent from global resolver consistency. No fake activation claim.
    let unrelated = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            30,
            "snapshot",
            json!([]),
            json!([ids[2]]),
            json!([]),
            false,
        ),
    )
    .await;
    let mut conflicting = unrelated.clone();
    conflicting["id"] = json!(db::id());
    conflicting["version_id"] = json!(b);
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, "deployment", &conflicting)
        .await
        .unwrap();
    drop(conn);
    sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,generation,state) VALUES(?,?,1,'desired')").bind(conflicting["id"].as_str().unwrap()).bind(&ids[2]).execute(&s.pool).await.unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/devices/{}/revoke", ids[0]),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        full_target(&s, d["id"].as_str().unwrap(), &ids[1]).await,
        pending
    );
    assert_eq!(
        full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await["state"],
        "removed"
    );
    // Remove only the isolated inconsistent fixture record; ordinary scheduler
    // may now release the next eligible member under existing removal semantics.
    sqlx::query("DELETE FROM records WHERE kind='deployment' AND id=?")
        .bind(conflicting["id"].as_str().unwrap())
        .execute(&s.pool)
        .await
        .unwrap();
    vectory_server::rollout::tick(&s).await.unwrap();
    assert_eq!(
        full_target(&s, d["id"].as_str().unwrap(), &ids[1]).await["state"],
        "desired"
    );
}

#[tokio::test]
async fn removal_retains_history_readdition_resets_proof_error_and_admission() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
    let mut d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            100,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([]),
            false,
        ),
    )
    .await;
    sqlx::query("UPDATE deployment_targets SET state='verified_applied',verified_at='2026-09-26T00:00:00Z',previous_version_id=?,error='OLD_CATEGORY (validation)' WHERE deployment_id=? AND device_id=?").bind(&a).bind(d["id"].as_str().unwrap()).bind(&ids[0]).execute(&s.pool).await.unwrap();
    let before = full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await;
    let (status, group) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[1..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let mut expected = before.clone();
    expected["state"] = json!("removed");
    assert_eq!(
        full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
        expected
    );
    d["rollout"]["kind"] = json!("canary");
    d["status"] = json!("active");
    let mut conn = s.pool.acquire().await.unwrap();
    db::update(&mut conn, "deployment", &d).await.unwrap();
    drop(conn);
    assert_eq!(
        call(
            &app,
            "PUT",
            &path(&group),
            edit(&group, &ids[..2]),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let readded = full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await;
    assert_eq!(readded["state"], "pending");
    assert_eq!(readded["generation"], 0);
    for key in ["released_at", "verified_at", "error", "previous_version_id"] {
        assert_eq!(readded[key], Value::Null, "{key}");
    }
    assert_eq!(readded["original"], before["original"]);
}

/// A member that leaves the group and returns is released the deployment
/// afresh, so the target records what the device runs when it comes back, not
/// what it ran the first time.
#[tokio::test]
async fn a_member_that_leaves_and_returns_records_what_the_device_ran_on_its_return() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    let c = db::id();
    let mut conn = s.pool.acquire().await.unwrap();
    let artifact = "{\"data_dir\":\"/var/lib/vector/third\"}\n";
    db::insert(&mut conn,"version",&json!({"id":c,"configuration_id":db::id(),"number":1,"artifact":artifact,"sha256":db::hash(artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
    drop(conn);
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            10,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
    let d = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            100,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([]),
            false,
        ),
    )
    .await;
    let recorded = || async {
        sqlx::query_as::<_, (Option<String>, i64)>("SELECT previous_version_id,previous_recorded FROM deployment_targets WHERE deployment_id=? AND device_id=?")
            .bind(d["id"].as_str().unwrap())
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap()
    };
    let running = || async {
        sqlx::query_scalar::<_, Option<String>>("SELECT desired_version_id FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap()
    };
    assert_eq!(running().await.as_deref(), Some(b.as_str()));
    assert_eq!(recorded().await, (Some(a.clone()), 1));
    // The device leaves the group, goes to another deployment, then returns.
    let (status, group) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[1..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    assert_eq!(running().await.as_deref(), Some(a.as_str()));
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &c,
            180,
            50,
            "snapshot",
            json!([]),
            json!(ids[..1]),
            json!([]),
            false,
        ),
    )
    .await;
    assert_eq!(running().await.as_deref(), Some(c.as_str()));
    let (status, group) = call(
        &app,
        "PUT",
        &path(&group),
        edit(&group, &ids[..2]),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    assert_eq!(running().await.as_deref(), Some(b.as_str()));
    assert_eq!(
        recorded().await,
        (Some(c), 1),
        "a fresh release records what the device ran when it came back"
    );
}

#[tokio::test]
async fn removed_generation_cannot_claim_cancelled_assignment_or_rollback_targets() {
    for stopped in ["cancelled", "failed", "rollback"] {
        let (_temp, s, app, ids, cookie, csrf) = fixture().await;
        let (a, b) = seed_versions(&s).await;
        create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                10,
                "snapshot",
                json!([]),
                json!(ids[..2]),
                json!([]),
                false,
            ),
        )
        .await;
        let group = create_group(&app, &cookie, &csrf, &ids[..2]).await;
        let mut d = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &b,
                180,
                20,
                "persistent",
                json!([group["id"]]),
                json!([]),
                json!([]),
                false,
            ),
        )
        .await;
        assert_eq!(
            call(
                &app,
                "PUT",
                &path(&group),
                edit(&group, &ids[1..2]),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::OK
        );
        let removed = full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await;
        assert_eq!(removed["state"], "removed");
        assert!(removed["generation"].as_u64().unwrap() > 0);
        if stopped == "rollback" {
            let (status, replacement) = call(
                &app,
                "POST",
                &format!("/api/v1/deployments/{}/rollback", d["id"].as_str().unwrap()),
                json!({"request_id":db::id()}),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{replacement}");
            assert_eq!(replacement["targets"].as_array().unwrap().len(), 1);
            assert_eq!(replacement["targets"][0]["device_id"], ids[1]);
        } else {
            d["status"] = json!(stopped);
            let mut conn = s.pool.acquire().await.unwrap();
            db::update(&mut conn, "deployment", &d).await.unwrap();
            vectory_server::rollout::resolve(&mut conn).await.unwrap();
            drop(conn);
            let device = call(
                &app,
                "GET",
                &format!("/api/v1/devices/{}", ids[0]),
                Value::Null,
                &cookie,
                "",
            )
            .await
            .1;
            assert_eq!(device["desired_version_id"], a);
        }
        assert_eq!(
            full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
            removed
        );
    }
}

#[tokio::test]
async fn retained_removed_assignment_is_not_resurrected_by_heartbeat_retry_or_recovery() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (_temp, s, app, mut ids, cookie, csrf) = fixture().await;
    ids.sort();
    let x = &ids[1];
    let (a, b) = seed_versions(&s).await;
    let group = create_group(&app, &cookie, &csrf, &[x.clone()]).await;
    let delivered = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            100,
            "persistent",
            json!([group["id"]]),
            json!([]),
            json!([]),
            false,
        ),
    )
    .await;
    // Higher-priority canary admits ids[0] first. X still runs its former
    // assignment while the winning candidate is pending, a legitimate state.
    create_binding(
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
            json!([ids[0], x]),
            json!([]),
            true,
        ),
    )
    .await;
    assert_eq!(
        call(
            &app,
            "PUT",
            &path(&group),
            edit(&group, &[]),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let removed = full_target(&s, delivered["id"].as_str().unwrap(), x).await;
    assert_eq!(removed["state"], "removed");
    assert_eq!(removed["generation"], 1);
    let assignment: Option<String> =
        sqlx::query_scalar("SELECT assignment_id FROM devices WHERE id=?")
            .bind(x)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(assignment.as_deref(), delivered["id"].as_str());
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('retained-target-peer',?,'2099-01-01T00:00:00Z')").bind(x).execute(&s.pool).await.unwrap();
    let agent = device::router(s.clone()).layer(axum::Extension(device::PeerCertificate(Some(
        "retained-target-peer".into(),
    ))));
    for state in ["verified_applied", "verification_unknown", "failed"] {
        let body = json!({"protocol_version":1,"request_id":db::id(),"boot_id":"fixture","nonce":STANDARD.encode([13;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("{}\n"),"apply_state":state,"local_paused":false,"remote_pause_acknowledged":false,"configuration_attempt":{"generation":1,"version_id":a,"sha256":db::hash("{}\n"),"state":state}});
        let (status, result) = call(&agent, "POST", "/agent/v1/heartbeat", body, "", "").await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(
            full_target(&s, delivered["id"].as_str().unwrap(), x).await,
            removed
        );
    }
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','failed') WHERE id=?")
        .bind(x)
        .execute(&s.pool)
        .await
        .unwrap();
    let (status, result) = call(
        &app,
        "POST",
        &format!("/api/v1/devices/{x}/retry"),
        json!({"expected_version_id":a,"expected_generation":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["desired_generation"], 2);
    assert_eq!(
        full_target(&s, delivered["id"].as_str().unwrap(), x).await,
        removed
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}", delivered["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1["status"],
        "completed"
    );
    let report = vectory_server::maintenance::GenerationReport {
        devices: vec![vectory_server::maintenance::GenerationEntry {
            device_id: x.clone(),
            highest_generation: 2,
            highest_policy_generation: 0,
            highest_secret_revision: 0,
            expected_version_id: Some(a),
            expected_sha256: Some(db::hash("{}\n")),
            expected_policy_sha256: db::hash(db::default_policy().to_string()),
        }],
    };
    vectory_server::maintenance::recover_generations(&s, report, true)
        .await
        .unwrap();
    assert_eq!(
        full_target(&s, delivered["id"].as_str().unwrap(), x).await,
        removed
    );
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/api/v1/deployments/{}", delivered["id"].as_str().unwrap()),
            Value::Null,
            &cookie,
            ""
        )
        .await
        .1["status"],
        "completed"
    );
}

#[tokio::test]
async fn scheduler_repairs_only_ineligible_current_persistent_rows() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, _) = seed_versions(&s).await;
    let mut histories = Vec::new();
    for (mode, status, priority) in [
        ("persistent", "active", 10),
        ("persistent", "paused", 20),
        ("persistent", "completed", 30),
        ("persistent", "cancelled", 40),
        ("snapshot", "active", 50),
    ] {
        let mut d = create_binding(
            &app,
            &cookie,
            &csrf,
            binding(
                "configuration",
                &a,
                180,
                priority,
                mode,
                json!([]),
                json!([ids[0]]),
                json!([]),
                false,
            ),
        )
        .await;
        d["status"] = json!(status);
        let mut conn = s.pool.acquire().await.unwrap();
        db::update(&mut conn, "deployment", &d).await.unwrap();
        drop(conn);
        histories.push((
            d.clone(),
            full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
        ));
    }
    // Simulate a database retained from an older server, before retirement bookkeeping.
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    vectory_server::rollout::tick(&s).await.unwrap();
    for (d, mut before) in histories {
        if d["target_mode"] == "persistent" && d["status"] != "cancelled" {
            before["state"] = json!("removed");
        }
        assert_eq!(
            full_target(&s, d["id"].as_str().unwrap(), &ids[0]).await,
            before
        );
    }
}

// Separately executed next-workflow observation, not retirement acceptance.
#[tokio::test]
async fn review_observes_snapshot_rollback_with_revoked_target_requires_manual_scope() {
    let (_temp, s, app, ids, cookie, csrf) = fixture().await;
    let (a, b) = seed_versions(&s).await;
    create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            10,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    let current = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &b,
            180,
            20,
            "snapshot",
            json!([]),
            json!(ids[..2]),
            json!([]),
            false,
        ),
    )
    .await;
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/v1/devices/{}/revoke", ids[0]),
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = state_snapshot(&s).await;
    let key = db::id();
    let (status, error) = call(
        &app,
        "POST",
        &format!(
            "/api/v1/deployments/{}/rollback",
            current["id"].as_str().unwrap()
        ),
        json!({"request_id":key}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        error["error"]["message"],
        "Selector contains an unknown or revoked device"
    );
    assert_eq!(state_snapshot(&s).await, before);
    let lookup = call(
        &app,
        "GET",
        &format!("/api/v1/deployments/requests/{key}"),
        Value::Null,
        &cookie,
        "",
    )
    .await
    .1;
    assert_eq!(lookup, json!({"request_id":key,"found":false}));
    let replacement = create_binding(
        &app,
        &cookie,
        &csrf,
        binding(
            "configuration",
            &a,
            180,
            30,
            "snapshot",
            json!([]),
            json!([ids[1]]),
            json!([]),
            false,
        ),
    )
    .await;
    assert_eq!(replacement["targets"].as_array().unwrap().len(), 1);
    emit(
        "snapshot_retired_rollback_observation",
        &json!({"scope":"Separate expected-observation, synthetic fixture only; no snapshot rollback fix in retirement slice","rollback_status":400,"error":error,"all_transactional_state_unchanged":true,"request_mapping_created":false,"explicit_live_only_deployment_succeeds":true}),
    );
}
