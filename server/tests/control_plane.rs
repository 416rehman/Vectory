use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize, rollout};

#[tokio::test]
async fn rollback_at_priority_ceiling_replaces_only_original_binding_and_preserves_history() {
    for priority in [100, 1_000_000] {
        let (_temp, s) = state().await;
        let ids = seed(&s, 2).await;
        let (cookie, csrf) = admin(&s).await;
        let app = api::router(s.clone());
        let mut tx = s.pool.begin().await.unwrap();
        rollout::create(&mut tx, &request(&ids, "version-a", 10, false), "operator")
            .await
            .unwrap();
        let original = rollout::create(
            &mut tx,
            &request(&ids[..1], "version-b", priority, false),
            "operator",
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let path = format!(
            "/api/v1/deployments/{}/rollback",
            original["id"].as_str().unwrap()
        );
        let (status, rolled, _) = call(app.clone(), "POST", &path, json!({}), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{rolled}");
        assert_eq!(
            rolled["priority"],
            if priority == 1_000_000 {
                priority
            } else {
                priority + 1
            }
        );
        assert_eq!(rolled["version_id"], "version-a");
        assert_eq!(rolled["targets"].as_array().unwrap().len(), 1);
        assert_eq!(rolled["targets"][0]["device_id"], ids[0]);
        let mut conn = s.pool.acquire().await.unwrap();
        let old = rollout::deployment(&mut conn, original["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(
            old["status"],
            if priority == 1_000_000 {
                "unassigned"
            } else {
                "cancelled"
            }
        );
        assert_eq!(
            old["targets"], original["targets"],
            "historical targets cannot be rewritten"
        );
        let device = rollout::devices(&mut conn).await.unwrap();
        let touched = device.iter().find(|d| d["id"] == ids[0]).unwrap();
        let untouched = device.iter().find(|d| d["id"] == ids[1]).unwrap();
        assert_eq!(touched["desired_version_id"], "version-a");
        assert_eq!(touched["desired_generation"], 3);
        assert_eq!(untouched["desired_version_id"], "version-a");
        assert_eq!(untouched["desired_generation"], 1);
        if priority == 1_000_000 {
            assert_eq!(
                call(app, "POST", &path, json!({}), &cookie, &csrf).await.0,
                StatusCode::CONFLICT
            );
        }
    }
}

#[tokio::test]
async fn ceiling_rollback_conflict_or_late_failure_reverts_bindings_generations_and_audit() {
    for late_failure in [false, true] {
        let (_temp, s) = state().await;
        let ids = seed(&s, 1).await;
        let (cookie, csrf) = admin(&s).await;
        let app = api::router(s.clone());
        let mut tx = s.pool.begin().await.unwrap();
        rollout::create(&mut tx, &request(&ids, "version-a", 10, false), "operator")
            .await
            .unwrap();
        let original = rollout::create(
            &mut tx,
            &request(&ids, "version-b", 1_000_000, false),
            "operator",
        )
        .await
        .unwrap();
        if late_failure {
            sqlx::query("CREATE TRIGGER fail_rollback_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.rollback' BEGIN SELECT RAISE(ABORT,'injected late failure'); END").execute(&mut *tx).await.unwrap();
        } else {
            rollout::create(
                &mut tx,
                &request(&ids, "version-b", 1_000_000, false),
                "operator",
            )
            .await
            .unwrap();
        }
        tx.commit().await.unwrap();
        let mut conn = s.pool.acquire().await.unwrap();
        let before_deployments = rollout::deployments(&mut conn).await.unwrap();
        let before_devices = rollout::devices(&mut conn).await.unwrap();
        let before_audit = db::records(&mut conn, "audit").await.unwrap();
        drop(conn);
        let (status, _, _) = call(
            app,
            "POST",
            &format!(
                "/api/v1/deployments/{}/rollback",
                original["id"].as_str().unwrap()
            ),
            json!({}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(
            status,
            if late_failure {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::CONFLICT
            }
        );
        let mut conn = s.pool.acquire().await.unwrap();
        assert_eq!(
            rollout::deployments(&mut conn).await.unwrap(),
            before_deployments
        );
        assert_eq!(rollout::devices(&mut conn).await.unwrap(), before_devices);
        assert_eq!(db::records(&mut conn, "audit").await.unwrap(), before_audit);
    }
}

#[tokio::test]
async fn pipeline_details_share_draft_concurrency_and_preserve_config() {
    let (_temp, state) = state().await;
    let (cookie, csrf) = admin(&state).await;
    let app = api::router(state.clone());
    let (_, created, _) = call(app.clone(), "POST", "/api/v1/configurations", json!({"name":"Before","description":"Original","config":pipeline(),"graph":{"nodes":[],"edges":[]}}), &cookie, &csrf).await;
    let path = format!(
        "/api/v1/configurations/{}/draft",
        created["id"].as_str().unwrap()
    );
    let update = json!({"revision":created["revision"],"name":"After","description":"Renamed safely","config":created["config"],"graph":created["graph"]});
    assert_eq!(
        call(app.clone(), "PUT", &path, update.clone(), &cookie, "")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    for bad in [json!(""), json!("x".repeat(121)), json!(null)] {
        let mut invalid = update.clone();
        invalid["name"] = bad;
        assert_eq!(
            call(app.clone(), "PUT", &path, invalid, &cookie, &csrf)
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (status, saved, _) = call(app.clone(), "PUT", &path, update.clone(), &cookie, &csrf).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["name"], "After");
    assert_eq!(saved["description"], "Renamed safely");
    assert_eq!(saved["config"], created["config"]);
    assert_eq!(
        saved["revision"].as_u64(),
        Some(created["revision"].as_u64().unwrap() + 1)
    );
    assert_eq!(
        call(app.clone(), "PUT", &path, update, &cookie, &csrf)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, following, _) = call(
        app,
        "PUT",
        &path,
        json!({"revision":saved["revision"],"config":saved["config"],"graph":saved["graph"]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(following["name"], "After");
    assert_eq!(following["description"], "Renamed safely");
}

#[tokio::test]
async fn credential_arrays_cannot_enter_draft_graph_or_immutable_history() {
    let (_temp, state) = state().await;
    let (cookie, csrf) = admin(&state).await;
    let app = api::router(state.clone());
    for (index, key) in ["valid_tokens", "access_keys"].iter().enumerate() {
        let mut config = pipeline();
        config["sources"]["credential_source"] =
            json!({"type":"splunk_hec","address":"127.0.0.1:8088"});
        config["sources"]["credential_source"][*key] =
            json!(["${LOCAL_CREDENTIAL}", "SECRET[local.key]"]);
        let payload = json!({"name":format!("Credential list {index}"),"description":"","config":config,"graph":{"nodes":[],"edges":[]}});
        let (status, draft, _) = call(
            app.clone(),
            "POST",
            "/api/v1/configurations",
            payload.clone(),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{draft}");
        let id = draft["id"].as_str().unwrap();
        let secret = format!("SYNTHETIC_UNSTORABLE_CREDENTIAL_{index}");
        let mut malicious = payload.clone();
        malicious["config"]["sources"]["credential_source"][*key] =
            json!(["${LOCAL_CREDENTIAL}", secret]);
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/api/v1/configurations",
                malicious.clone(),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        malicious["revision"] = draft["revision"].clone();
        assert_eq!(
            call(
                app.clone(),
                "PUT",
                &format!("/api/v1/configurations/{id}/draft"),
                malicious,
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let mut graph_copy = payload.clone();
        graph_copy["graph"]["nodes"] = json!([{"data":{(*key): [secret]}}]);
        assert_eq!(
            call(
                app.clone(),
                "POST",
                "/api/v1/configurations",
                graph_copy,
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (status, version, _) = call(
            app.clone(),
            "POST",
            &format!("/api/v1/configurations/{id}/publish"),
            json!({"revision":draft["revision"],"message":"Native secret references"}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{version}");
        assert!(
            version["artifact"]
                .as_str()
                .unwrap()
                .contains("${LOCAL_CREDENTIAL}")
        );
        assert!(
            version["artifact"]
                .as_str()
                .unwrap()
                .contains("SECRET[local.key]")
        );
        let leaked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM records WHERE data LIKE ?")
            .bind(format!("%{secret}%"))
            .fetch_one(&state.pool)
            .await
            .unwrap();
        assert_eq!(
            leaked, 0,
            "Synthetic credential must not enter any persisted record"
        );
    }
}

#[tokio::test]
async fn only_get_api_reference_permits_same_origin_embedding() {
    let (_temp, s) = state().await;
    let app = api::router(s);
    for (method, path, allowed) in [
        ("GET", "/api-reference.html", true),
        ("GET", "/", false),
        ("GET", "/api/v1/status", false),
        ("POST", "/api-reference.html", false),
        ("GET", "/api-reference.html/other", false),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()["x-frame-options"],
            if allowed { "SAMEORIGIN" } else { "DENY" }
        );
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(csp.contains(if allowed {
            "frame-ancestors 'self'"
        } else {
            "frame-ancestors 'none'"
        }));
        assert!(csp.contains("script-src 'self'"));
        assert!(csp.contains("connect-src 'self'"));
        assert!(!csp.contains("unsafe-eval"));
    }
}

#[tokio::test]
async fn device_effective_policy_is_current_read_only_and_pause_preserves_fields() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    let (cookie, csrf) = admin(&s).await;
    let app = api::router(s.clone());
    let mut deployment = request(&ids, "version-a", 100, false);
    deployment.as_object_mut().unwrap().remove("version_id");
    deployment["policy"] =
        json!({"heartbeat_seconds":420,"telemetry_enabled":false,"sync_paused":false});
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/deployments",
            deployment.clone(),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, devices, _) = call(
        app.clone(),
        "GET",
        "/api/v1/devices",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(devices[0]["effective_policy"], deployment["policy"]);
    deployment["policy"] = devices[0]["effective_policy"].clone();
    deployment["policy"]["sync_paused"] = json!(true);
    deployment["priority"] = json!(101);
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/deployments",
            deployment,
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, device, _) = call(
        app,
        "GET",
        &format!("/api/v1/devices/{}", ids[0]),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(
        device["effective_policy"],
        json!({"heartbeat_seconds":420,"telemetry_enabled":false,"sync_paused":true})
    );
}

#[tokio::test]
async fn configuration_mode_is_local_report_not_remote_policy() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let app = api::router(s.clone());
    let (_, token, _) = call(
        app.clone(),
        "POST",
        "/api/v1/tokens",
        json!({"name":"Mode test","expires_hours":1}),
        &cookie,
        &csrf,
    )
    .await;
    let key = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    let mut enrollment = json!({"protocol_version":1,"request_id":"mode-test","token":token["token"],"name":"mode-device","csr_pem":csr,"os":"windows","arch":"amd64","agent_version":"test","vector_version":"0.58.0","configuration_mode":"invalid"});
    assert_eq!(
        call(
            device::router(s.clone()),
            "POST",
            "/agent/v1/enroll",
            enrollment.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    enrollment["configuration_mode"] = json!("full");
    let (status, credential, _) = call(
        device::router(s.clone()),
        "POST",
        "/agent/v1/enroll",
        enrollment,
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{credential}");
    let id = credential["device_id"].as_str().unwrap();
    let read = |state: State| async move {
        let mut conn = state.pool.acquire().await.unwrap();
        rollout::devices(&mut conn).await.unwrap()
    };
    assert_eq!(read(s.clone()).await[0]["configuration_mode"], "full");
    let fingerprint: String =
        sqlx::query_scalar("SELECT fingerprint FROM credentials WHERE device_id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    let agent =
        device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))));
    let mut heartbeat = json!({"protocol_version":1,"request_id":"mode-heartbeat","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","boot_id":"mode-boot","agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false,"configuration_mode":"invalid"});
    assert_eq!(
        call(
            agent.clone(),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(read(s.clone()).await[0]["configuration_mode"], "full");
    heartbeat
        .as_object_mut()
        .unwrap()
        .remove("configuration_mode");
    assert_eq!(
        call(
            agent.clone(),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(read(s.clone()).await[0]["configuration_mode"], "restricted");
    heartbeat["configuration_mode"] = json!("full");
    assert_eq!(
        call(agent, "POST", "/agent/v1/heartbeat", heartbeat, "", "")
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(read(s.clone()).await[0]["configuration_mode"], "full");
    let policy = json!({"name":"Remote widening denied","policy":{"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true,"configuration_mode":"full"}});
    assert_eq!(
        call(app, "POST", "/api/v1/policies", policy, &cookie, &csrf)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn pipeline_validation_allows_publishers_without_granting_draft_writes() {
    let (_temp, s) = state().await;
    let (admin_cookie, admin_csrf) = admin(&s).await;
    let app = api::router(s.clone());
    let (created_status, created, _) = call(
        app.clone(),
        "POST",
        "/api/v1/configurations",
        json!({"name":"Role-checked validation","description":"","graph":{"nodes":[],"edges":[]},"config":pipeline()}),
        &admin_cookie,
        &admin_csrf,
    )
    .await;
    assert_eq!(created_status, StatusCode::OK, "{created}");
    let id = created["id"].as_str().unwrap();
    let check_path = format!("/api/v1/configurations/{id}/validate");
    let draft_path = format!("/api/v1/configurations/{id}/draft");
    let body = json!({"config":pipeline()});
    assert_eq!(
        call(app.clone(), "POST", &check_path, body.clone(), "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    let mut sessions = vec![("admin", admin_cookie, admin_csrf)];
    for role in ["viewer", "editor", "operator"] {
        let email = format!("validation-{role}@example.test");
        let (created_status, user, _) = call(
            app.clone(),
            "POST",
            "/api/v1/users",
            json!({"email":email,"name":role,"role":role,"password":"another-long-password"}),
            &sessions[0].1,
            &sessions[0].2,
        )
        .await;
        assert_eq!(created_status, StatusCode::OK, "{user}");
        let (login_status, session, cookie) = call(
            app.clone(),
            "POST",
            "/api/v1/login",
            json!({"email":email,"password":"another-long-password"}),
            "",
            "",
        )
        .await;
        assert_eq!(login_status, StatusCode::OK, "{session}");
        sessions.push((role, cookie, session["csrf_token"].as_str().unwrap().into()));
    }

    let mut conn = s.pool.acquire().await.unwrap();
    let before = db::record(&mut conn, "configuration", id).await.unwrap();
    let revisions_before = db::records(&mut conn, "revision").await.unwrap();
    let audits_before = db::records(&mut conn, "audit").await.unwrap();
    drop(conn);

    for (role, cookie, csrf) in &sessions {
        assert_eq!(
            call(
                app.clone(),
                "GET",
                &format!("/api/v1/configurations/{id}"),
                Value::Null,
                cookie,
                "",
            )
            .await
            .0,
            StatusCode::OK,
            "{role} can read the pipeline"
        );
        let (status, result, _) =
            call(app.clone(), "POST", &check_path, body.clone(), cookie, csrf).await;
        if *role == "viewer" {
            assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
        } else {
            assert_eq!(status, StatusCode::OK, "{role}: {result}");
            assert_eq!(result["valid"], true, "{role}: {result}");
        }
    }
    let (_, operator_cookie, operator_csrf) = &sessions[3];
    assert_eq!(
        call(
            app.clone(),
            "POST",
            &check_path,
            body.clone(),
            operator_cookie,
            "",
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            app.clone(),
            "PUT",
            &draft_path,
            json!({"revision":created["revision"],"config":pipeline(),"graph":{"nodes":[],"edges":[]},"message":"unauthorized"}),
            operator_cookie,
            operator_csrf,
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut conn, "configuration", id).await.unwrap(),
        before
    );
    assert_eq!(
        db::records(&mut conn, "revision").await.unwrap(),
        revisions_before
    );
    assert_eq!(
        db::records(&mut conn, "audit").await.unwrap(),
        audits_before
    );
}

#[tokio::test]
async fn pipeline_test_endpoint_requires_auth_csrf_and_isolated_execution() {
    let (_temp, s) = state().await;
    let (cookie, csrf) = admin(&s).await;
    let app = api::router(s.clone());
    let pure = json!({"config":{"sources":{"input":{"type":"demo_logs"}},"sinks":{"out":{"type":"blackhole","inputs":["input"]}},"tests":[]}});
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/configurations/test",
            pure.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/configurations/test",
            pure.clone(),
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/configurations/test",
            pure,
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let provider = json!({"provider":{"type":"http","url":"${DEVICE_PROVIDER_URL}"}});
    let (status, deferred, _) = call(
        app.clone(),
        "POST",
        "/api/v1/configurations/test",
        json!({"config":provider}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deferred["valid"], false);
    assert_eq!(deferred["tests_run"], false);
    assert_eq!(deferred["deferred"], true);
    let (_, draft, _) = call(app.clone(), "POST", "/api/v1/configurations", json!({"name":"Device provider","description":"","graph":{"nodes":[],"edges":[]},"config":provider}), &cookie, &csrf).await;
    let (status, version, _) = call(
        app,
        "POST",
        &format!(
            "/api/v1/configurations/{}/publish",
            draft["id"].as_str().unwrap()
        ),
        json!({"revision":draft["revision"],"message":"Provider-only bundle"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(version["config"], provider);
    assert_eq!(version["validation"]["vector_validated"], false);
    assert_eq!(version["validation"]["deferred"], true);
}

#[tokio::test]
async fn deployment_commit_rejects_membership_changed_since_concrete_preview() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 2).await;
    let (cookie, csrf) = admin(&s).await;
    let app = api::router(s.clone());
    let (status, group, _) = call(
        app.clone(),
        "POST",
        "/api/v1/groups",
        json!({"name":"Reviewed group","device_ids":[ids[0]]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let mut body = request(&[], "version-a", 100, false);
    body["selector"]["group_ids"] = json!([group["id"]]);
    let (status, preview, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments/preview",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["devices"].as_array().unwrap().len(), 1);
    body["expected_device_ids"] = json!([ids[0]]);
    assert_eq!(
        call(
            app.clone(),
            "PUT",
            &format!("/api/v1/groups/{}", group["id"].as_str().unwrap()),
            json!({"name":"Reviewed group","device_ids":ids,"revision":group["revision"]}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, error, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments",
        body.clone(),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='deployment'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "A stale preview must not partially create a deployment"
    );
    body["expected_device_ids"] = json!(ids);
    assert_eq!(
        call(app, "POST", "/api/v1/deployments", body, &cookie, &csrf)
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn displayed_verification_requires_current_generation_and_immutable_digest_evidence() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    let digest = db::hash("{}\n");
    sqlx::query("UPDATE devices SET desired_version_id='version-a',desired_generation=2,data=json_set(data,'$.apply_state','verified_applied','$.reported_generation',1,'$.actual_sha256',?) WHERE id=?").bind(&digest).bind(&ids[0]).execute(&s.pool).await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "applying"
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.reported_generation',2)")
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "verified"
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.actual_sha256',?)")
        .bind(db::hash("drift"))
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "applying"
    );
    db::insert(
        &mut conn,
        "version",
        &json!({"id":"secret-status","sha256":digest,"uses_local_secrets":true}),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE devices SET desired_version_id='secret-status',data=json_set(data,'$.applied_template_sha256',?,'$.verified_secret_revision',1)").bind(&digest).execute(&mut *conn).await.unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "applying"
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.verified_effective_sha256',?)")
        .bind(db::hash("drift"))
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "verified"
    );
    sqlx::query("UPDATE devices SET data=json_set(data,'$.applied_template_sha256',?)")
        .bind(db::hash("wrong-template"))
        .execute(&mut *conn)
        .await
        .unwrap();
    assert_eq!(
        rollout::devices(&mut conn).await.unwrap()[0]["status"],
        "applying"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn reused_state_replaces_explicit_everyone_acl_and_owner() {
    use std::process::Command;
    let (_temp, s) = state().await;
    let settings = s.settings.clone();
    let paths = [
        settings.data_dir.clone(),
        settings.data_dir.join("vectory.db"),
        settings.data_dir.join("keys/manifest-signing.key"),
    ];
    for path in &paths {
        let grant = if path.is_dir() {
            "*S-1-1-0:(OI)(CI)F"
        } else {
            "*S-1-1-0:F"
        };
        let result = Command::new("icacls")
            .arg(path)
            .args(["/grant", grant])
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    for path in &paths {
        let escaped = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$a=Get-Acl -LiteralPath '{escaped}'; @{{sddl=$a.Sddl;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value}}|ConvertTo-Json -Compress"
        );
        let result = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .unwrap();
        assert!(result.status.success());
        let acl: Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(acl["owner"], acl["current"]);
        let sddl = acl["sddl"].as_str().unwrap();
        assert!(sddl.contains("D:P"), "{sddl}");
        assert!(
            !sddl.contains(";;;WD)") && !sddl.contains(";;;BU)") && !sddl.contains("S-1-1-0"),
            "{sddl}"
        );
    }
    s.pool.close().await;
}

#[tokio::test]
async fn restored_generations_require_explicit_review_and_atomic_fencing() {
    use vectory_server::maintenance::{
        GenerationReport, generation_recovery_state, recover_generations,
    };
    let (_temp, s) = state().await;
    let ids = seed(&s, 2).await;
    sqlx::query("UPDATE devices SET desired_version_id='version-a',desired_generation=3,policy_generation=2,data=json_set(data,'$.secret_revision',4)").execute(&s.pool).await.unwrap();
    let mut report = generation_recovery_state(&s).await.unwrap();
    assert!(
        serde_json::from_value::<GenerationReport>(report.clone()).is_err(),
        "Missing agent high-water counters must fail closed"
    );
    // The export is unreviewed on purpose: the message names the device and the
    // counter, how many gaps remain, and where on the device to read the value.
    let first = report["devices"][0]["device_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let gap =
        vectory_server::maintenance::missing_counters(&report).expect("every counter is null");
    assert!(
        gap.starts_with(&format!(
            "highest_generation of device {first} has no value (5 more counters need a value too)."
        )),
        "{gap}"
    );
    assert!(
        gap.contains("sudo vectory status --json") && gap.contains("state.secret_revision"),
        "{gap}"
    );
    report["devices"][0]["highest_generation"] = json!(8);
    report["devices"][0]["highest_policy_generation"] = json!("6");
    let gap = vectory_server::maintenance::missing_counters(&report).unwrap();
    assert!(
        gap.starts_with(&format!(
            "highest_policy_generation of device {first} isn't a whole number"
        )),
        "{gap}"
    );
    for entry in report["devices"].as_array_mut().unwrap() {
        entry["highest_generation"] = json!(8);
        entry["highest_policy_generation"] = json!(6);
        entry["highest_secret_revision"] = json!(10);
    }
    let preview = recover_generations(&s, serde_json::from_value(report.clone()).unwrap(), false)
        .await
        .unwrap();
    assert_eq!(preview["applied"], false);
    assert_eq!(preview["devices"][0]["generation"], 9);
    assert!(vectory_server::maintenance::missing_counters(&report).is_none());
    let mut wrong = report.clone();
    wrong["devices"][1]["device_id"] = json!("unknown");
    let refusal = recover_generations(&s, serde_json::from_value(wrong).unwrap(), true)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refusal.starts_with("Device unknown in the generation report is unknown or revoked"),
        "{refusal}"
    );
    let mut twice = report.clone();
    twice["devices"][1]["device_id"] = twice["devices"][0]["device_id"].clone();
    let refusal = recover_generations(&s, serde_json::from_value(twice).unwrap(), true)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refusal.starts_with(&format!(
            "Device {first} appears more than once in the generation report"
        )),
        "{refusal}"
    );
    let mut wrong = report.clone();
    wrong["devices"][0]["expected_sha256"] = json!("0".repeat(64));
    assert!(
        recover_generations(&s, serde_json::from_value(wrong).unwrap(), true)
            .await
            .is_err()
    );
    let mut wrong = report.clone();
    wrong["devices"][0]["highest_secret_revision"] = json!(3);
    assert!(
        recover_generations(&s, serde_json::from_value(wrong).unwrap(), true)
            .await
            .is_err()
    );
    let before: i64 = sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
        .bind(&ids[0])
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(before, 3);
    recover_generations(&s, serde_json::from_value(report).unwrap(), true)
        .await
        .unwrap();
    let counters:(i64,i64,i64)=sqlx::query_as("SELECT desired_generation,policy_generation,json_extract(data,'$.secret_revision') FROM devices WHERE id=?").bind(&ids[0]).fetch_one(&s.pool).await.unwrap();
    assert_eq!(counters, (9, 7, 10));
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='server.restore_generation_fence'").fetch_one(&s.pool).await.unwrap();
    assert_eq!(audits, 2);
}

#[tokio::test]
async fn secret_materialization_cannot_bypass_plain_digests_or_reuse_revision_for_drift() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('local-secret-peer',?,?)",
    )
    .bind(&ids[0])
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE devices SET desired_version_id='version-a',desired_generation=1 WHERE id=?",
    )
    .bind(&ids[0])
    .execute(&s.pool)
    .await
    .unwrap();
    let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        "local-secret-peer".into(),
    ))));
    let mut heartbeat = json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":STANDARD.encode([2;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":1,"policy_generation":0,"actual_sha256":db::hash("materialized secret one"),"applied_template_sha256":db::hash("{}\n"),"secret_revision":1,"apply_state":"verified_applied","local_paused":false,"remote_pause_acknowledged":false});
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    let reported: String =
        sqlx::query_scalar("SELECT json_extract(data,'$.apply_state') FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        reported, "failed",
        "A template field must not bypass ordinary immutable digest equality"
    );
    let mut tx = s.pool.begin().await.unwrap();
    db::insert(&mut tx,"version",&json!({"id":"secret-version","configuration_id":"config","number":2,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"uses_local_secrets":true,"created_at":db::now()})).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE devices SET desired_version_id='secret-version' WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    for (revision, payload, state, expected) in [
        (
            1,
            "materialized secret one",
            "verified_applied",
            "verified_applied",
        ),
        (1, "manual changed bytes", "verified_applied", "failed"),
        (2, "materialized secret two", "failed", "failed"),
        (3, "materialized secret three", "rolled_back", "rolled_back"),
        (
            4,
            "materialized secret four",
            "verified_applied",
            "verified_applied",
        ),
    ] {
        heartbeat["secret_revision"] = json!(revision);
        heartbeat["actual_sha256"] = json!(db::hash(payload));
        heartbeat["apply_state"] = json!(state);
        let (status, body, _) = call(
            app.clone(),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat.clone(),
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let actual: String =
            sqlx::query_scalar("SELECT json_extract(data,'$.apply_state') FROM devices WHERE id=?")
                .bind(&ids[0])
                .fetch_one(&s.pool)
                .await
                .unwrap();
        assert_eq!(actual, expected);
    }
    heartbeat["secret_revision"] = json!(3);
    assert_eq!(
        call(app, "POST", "/agent/v1/heartbeat", heartbeat, "", "")
            .await
            .0,
        StatusCode::CONFLICT
    );
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='device.secret_reconciliation'").fetch_one(&s.pool).await.unwrap();
    assert_eq!(audits, 4);
}

#[tokio::test]
async fn telemetry_history_is_authenticated_bounded_and_chronological() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    let (cookie, _) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    for bucket in 0..125 {
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?)")
            .bind(&ids[0])
            .bind(bucket)
            .bind(json!({"sampled_at":db::now(),"errors":bucket}).to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let path = format!("/api/v1/devices/{}/telemetry", ids[0]);
    assert_eq!(
        call(api::router(s.clone()), "GET", &path, Value::Null, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, history, _) = call(api::router(s), "GET", &path, Value::Null, &cookie, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history["samples"].as_array().unwrap().len(), 120);
    assert_eq!(history["samples"][0]["bucket"], 5);
    assert_eq!(history["samples"][119]["bucket"], 124);
}

async fn state() -> (tempfile::TempDir, State) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Test".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    (temp, s)
}
async fn call(
    app: Router,
    method: &str,
    path: &str,
    v: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, Value, String) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !cookie.is_empty() {
        request = request.header("cookie", cookie)
    }
    if !csrf.is_empty() {
        request = request.header("x-csrf-token", csrf)
    }
    let response = app
        .oneshot(request.body(Body::from(v.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let cookie = response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_owned();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let out = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, out, cookie)
}
async fn admin(s: &State) -> (String, String) {
    let (status,v,cookie)=call(api::router(s.clone()),"POST","/api/v1/bootstrap",json!({"bootstrap_secret":"isolated-test-bootstrap-secret-123456789","email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}),"","").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    (cookie, v["csrf_token"].as_str().unwrap().into())
}
fn pipeline() -> Value {
    json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"console","inputs":["sample"],"encoding":{"codec":"json"}}}})
}
async fn seed(s: &State, count: usize) -> Vec<String> {
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for i in 0..count {
        let id = format!("device-{i}");
        let d = json!({"id":id,"name":id,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&id)
            .bind(d.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id)
    }
    for id in ["version-a", "version-b"] {
        db::insert(&mut tx,"version",&json!({"id":id,"configuration_id":"config","number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    }
    tx.commit().await.unwrap();
    ids
}
fn request(ids: &[String], version: &str, priority: i64, canary: bool) -> Value {
    json!({"version_id":version,"selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":priority,"target_mode":"snapshot","rollout":{"kind":if canary{"canary"}else{"all"},"canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}})
}

#[tokio::test]
async fn authentication_csrf_roles_and_immutable_versions() {
    let (_temp, s) = state().await;
    let app = api::router(s.clone());
    assert_eq!(
        call(app.clone(), "GET", "/api/v1/devices", Value::Null, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (cookie, csrf) = admin(&s).await;
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/groups",
            json!({"name":"x","device_ids":[]}),
            &cookie,
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status,c,_)=call(app.clone(),"POST","/api/v1/configurations",json!({"name":"Pipeline","description":"","graph":{"nodes":[],"edges":[]},"config":pipeline()}),&cookie,&csrf).await;
    assert_eq!(status, StatusCode::OK, "{c}");
    let id = c["id"].as_str().unwrap();
    let save = format!("/api/v1/configurations/{id}/draft");
    let (status, _, _) = call(
        app.clone(),
        "PUT",
        &save,
        json!({"revision":0,"graph":{"nodes":[],"edges":[]},"config":pipeline()}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let publish = format!("/api/v1/configurations/{id}/publish");
    let (status, v, _) = call(
        app.clone(),
        "POST",
        &publish,
        json!({"revision":1,"message":"v1"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["sha256"], db::hash(v["artifact"].as_str().unwrap()));
    assert_eq!(v["validation"]["vector_validated"], false);
    let mutation = sqlx::query("UPDATE records SET data='{}' WHERE kind='version' AND id=?")
        .bind(v["id"].as_str().unwrap())
        .execute(&s.pool)
        .await;
    assert!(mutation.is_err());
    for role in ["viewer", "editor", "operator"] {
        let email = format!("{role}@example.test");
        let (status, v, _) = call(
            app.clone(),
            "POST",
            "/api/v1/users",
            json!({"email":email,"name":role,"role":role,"password":"another-long-password"}),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
        let (status, session, user_cookie) = call(
            app.clone(),
            "POST",
            "/api/v1/login",
            json!({"email":email,"password":"another-long-password"}),
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{session}");
        let code = call(
            app.clone(),
            "POST",
            "/api/v1/users",
            json!({}),
            &user_cookie,
            session["csrf_token"].as_str().unwrap(),
        )
        .await
        .0;
        assert_eq!(code, StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn selector_conflict_and_canary_admission_are_transactional() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 3).await;
    let mut tx = s.pool.begin().await.unwrap();
    let low = rollout::create(&mut tx, &request(&ids, "version-a", 1, false), "operator")
        .await
        .unwrap();
    assert_eq!(low["targets"].as_array().unwrap().len(), 3);
    let high = rollout::create(&mut tx, &request(&ids, "version-b", 2, true), "operator")
        .await
        .unwrap();
    let targets = high["targets"].as_array().unwrap();
    assert_eq!(targets.iter().filter(|t| t["generation"] != 0).count(), 1);
    let rows = rollout::devices(&mut tx).await.unwrap();
    assert_eq!(
        rows.iter()
            .filter(|d| d["desired_version_id"] == "version-b")
            .count(),
        1
    );
    assert_eq!(
        rows.iter()
            .filter(|d| d["desired_version_id"] == "version-a")
            .count(),
        2
    );
    let conflict =
        rollout::create(&mut tx, &request(&ids, "version-a", 2, false), "operator").await;
    assert!(conflict.is_err());
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn canary_requires_continuously_fresh_verified_observation() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 2).await;
    let mut tx = s.pool.begin().await.unwrap();
    let d = rollout::create(&mut tx, &request(&ids, "version-a", 10, true), "operator")
        .await
        .unwrap();
    let deployment = d["id"].as_str().unwrap().to_owned();
    sqlx::query("UPDATE deployment_targets SET state='verified_applied' WHERE deployment_id=? AND generation>0").bind(&deployment).execute(&mut *tx).await.unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.reported_generation',desired_generation,'$.apply_state','verified_applied','$.actual_sha256',?) WHERE assignment_id=?").bind(db::hash("{}\n")).bind(&deployment).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    rollout::tick(&s).await.unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    let mut d = db::record(&mut tx, "deployment", &deployment)
        .await
        .unwrap();
    assert!(d["observation_started_at"].is_string());
    d["observation_started_at"] =
        json!((chrono::Utc::now() - chrono::Duration::seconds(120)).to_rfc3339());
    db::update(&mut tx, "deployment", &d).await.unwrap();
    let raw: String = sqlx::query_scalar("SELECT data FROM devices WHERE id=?")
        .bind(&ids[0])
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    let mut old = db::parse(&raw).unwrap();
    old["last_seen"] = json!((chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339());
    sqlx::query("UPDATE devices SET data=? WHERE id=?")
        .bind(old.to_string())
        .bind(&ids[0])
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    rollout::tick(&s).await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    let d = rollout::deployment(&mut conn, &deployment).await.unwrap();
    assert_eq!(
        d["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["generation"] != 0)
            .count(),
        1
    );
    assert!(d["observation_started_at"].is_null());
}

#[tokio::test]
async fn scheduled_activation_rechecks_canary_overlap_without_partial_admission() {
    for resource in ["configuration", "policy"] {
        let (_temp, s) = state().await;
        let ids = seed(&s, 4).await;
        let mut tx = s.pool.begin().await.unwrap();
        let mut planned = request(&ids[1..], "version-b", 200, false);
        let mut canary_request = request(&ids[..2], "version-a", 100, true);
        if resource == "policy" {
            for (body, seconds) in [(&mut planned, 30), (&mut canary_request, 120)] {
                body.as_object_mut().unwrap().remove("version_id");
                body["policy"] = json!({"heartbeat_seconds":seconds,"sync_paused":false,"telemetry_enabled":true});
            }
        }
        planned["scheduled_at"] =
            json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        let scheduled = rollout::create(&mut tx, &planned, "operator")
            .await
            .unwrap();
        let canary = rollout::create(&mut tx, &canary_request, "operator")
            .await
            .unwrap();
        let before_devices = rollout::devices(&mut tx).await.unwrap();
        let mut stored = db::record(&mut tx, "deployment", scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        stored["scheduled_at"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        db::update(&mut tx, "deployment", &stored).await.unwrap();
        tx.commit().await.unwrap();

        rollout::tick(&s).await.unwrap();
        rollout::tick(&s).await.unwrap();
        let mut conn = s.pool.acquire().await.unwrap();
        let failed = rollout::deployment(&mut conn, scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(failed["status"], "failed");
        for target in failed["targets"].as_array().unwrap() {
            assert_eq!(target["generation"], 0);
            assert!(target["released_at"].is_null());
            if target["device_id"] == ids[1] {
                assert_eq!(target["state"], "blocked");
                assert_eq!(
                    target["error"],
                    "Scheduled activation blocked by an active canary; pause or cancel it, then create a new reviewed deployment"
                );
            } else {
                assert_eq!(target["state"], "pending");
                assert!(target["error"].is_null());
            }
        }
        assert_eq!(rollout::devices(&mut conn).await.unwrap(), before_devices);
        assert_eq!(
            rollout::deployment(&mut conn, canary["id"].as_str().unwrap())
                .await
                .unwrap(),
            canary
        );
        let audits = db::records(&mut conn, "audit").await.unwrap();
        assert_eq!(
            audits
                .iter()
                .filter(|a| a["target"] == scheduled["id"]
                    && a["action"] == "deployment.activate"
                    && a["outcome"] == "blocked")
                .count(),
            1
        );
        assert!(!audits.iter().any(|a| {
            a["action"] == "deployment.release"
                && a["target"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with(scheduled["id"].as_str().unwrap())
        }));
    }
}

#[tokio::test]
async fn scheduled_canary_does_not_block_itself_or_an_independent_resource() {
    for with_other_resource in [false, true] {
        let (_temp, s) = state().await;
        let ids = seed(&s, 3).await;
        let mut tx = s.pool.begin().await.unwrap();
        let mut planned = request(&ids, "version-b", 200, true);
        planned["scheduled_at"] =
            json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        let scheduled = rollout::create(&mut tx, &planned, "operator")
            .await
            .unwrap();
        if with_other_resource {
            let mut other = request(&ids, "unused", 300, true);
            other.as_object_mut().unwrap().remove("version_id");
            other["policy"] =
                json!({"heartbeat_seconds":120,"sync_paused":false,"telemetry_enabled":true});
            rollout::create(&mut tx, &other, "operator").await.unwrap();
        }
        let mut stored = db::record(&mut tx, "deployment", scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        stored["scheduled_at"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        db::update(&mut tx, "deployment", &stored).await.unwrap();
        tx.commit().await.unwrap();
        rollout::tick(&s).await.unwrap();
        let mut conn = s.pool.acquire().await.unwrap();
        let activated = rollout::deployment(&mut conn, scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(activated["status"], "active");
        assert_eq!(
            activated["targets"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|t| t["generation"].as_i64().unwrap() > 0)
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn scheduled_activation_allows_nonoverlap_and_inactive_canaries() {
    for scenario in ["nonoverlap", "paused", "completed"] {
        let (_temp, s) = state().await;
        let ids = seed(&s, 3).await;
        let mut tx = s.pool.begin().await.unwrap();
        let mut planned = request(&ids[..2], "version-b", 200, false);
        planned["scheduled_at"] =
            json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        let scheduled = rollout::create(&mut tx, &planned, "operator")
            .await
            .unwrap();
        let canary = rollout::create(
            &mut tx,
            &request(
                if scenario == "nonoverlap" {
                    &ids[2..]
                } else {
                    &ids[..2]
                },
                "version-a",
                100,
                true,
            ),
            "operator",
        )
        .await
        .unwrap();
        if scenario == "paused" {
            rollout::action(&mut tx, canary["id"].as_str().unwrap(), "pause", "operator")
                .await
                .unwrap();
        } else if scenario == "completed" {
            let mut stored = db::record(&mut tx, "deployment", canary["id"].as_str().unwrap())
                .await
                .unwrap();
            stored["status"] = json!("completed");
            db::update(&mut tx, "deployment", &stored).await.unwrap();
        }
        let mut stored = db::record(&mut tx, "deployment", scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        stored["scheduled_at"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        db::update(&mut tx, "deployment", &stored).await.unwrap();
        tx.commit().await.unwrap();
        rollout::tick(&s).await.unwrap();
        let mut conn = s.pool.acquire().await.unwrap();
        let activated = rollout::deployment(&mut conn, scheduled["id"].as_str().unwrap())
            .await
            .unwrap();
        assert_eq!(activated["status"], "active", "{scenario}");
        assert!(
            activated["targets"]
                .as_array()
                .unwrap()
                .iter()
                .all(|t| t["generation"].as_i64().unwrap() > 0)
        );
    }
}

#[tokio::test]
async fn due_overlapping_canary_schedules_serialize_in_one_tick() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 3).await;
    let mut tx = s.pool.begin().await.unwrap();
    let mut scheduled_ids = Vec::new();
    for (version, priority) in [("version-a", 100), ("version-b", 200)] {
        let mut planned = request(&ids, version, priority, true);
        planned["scheduled_at"] =
            json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        let scheduled = rollout::create(&mut tx, &planned, "operator")
            .await
            .unwrap();
        let id = scheduled["id"].as_str().unwrap();
        scheduled_ids.push(id.to_owned());
        let mut stored = db::record(&mut tx, "deployment", id).await.unwrap();
        stored["scheduled_at"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        db::update(&mut tx, "deployment", &stored).await.unwrap();
    }
    tx.commit().await.unwrap();
    rollout::tick(&s).await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    let deployments = rollout::deployments(&mut conn).await.unwrap();
    assert_eq!(
        deployments
            .iter()
            .filter(|d| d["status"] == "active")
            .count(),
        1
    );
    assert_eq!(
        deployments
            .iter()
            .filter(|d| d["status"] == "failed")
            .count(),
        1
    );
    assert_eq!(
        deployments
            .iter()
            .flat_map(|d| d["targets"].as_array().unwrap())
            .filter(|t| t["generation"].as_i64().unwrap() > 0)
            .count(),
        1
    );
}

#[tokio::test]
async fn scheduled_canary_block_failure_rolls_back_status_targets_and_audit() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 3).await;
    let mut tx = s.pool.begin().await.unwrap();
    let mut planned = request(&ids, "version-b", 200, false);
    planned["scheduled_at"] = json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let scheduled = rollout::create(&mut tx, &planned, "operator")
        .await
        .unwrap();
    rollout::create(&mut tx, &request(&ids, "version-a", 100, true), "operator")
        .await
        .unwrap();
    let mut stored = db::record(&mut tx, "deployment", scheduled["id"].as_str().unwrap())
        .await
        .unwrap();
    stored["scheduled_at"] =
        json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
    db::update(&mut tx, "deployment", &stored).await.unwrap();
    sqlx::query("CREATE TRIGGER reject_block_audit BEFORE INSERT ON records WHEN NEW.kind='audit' AND json_extract(NEW.data,'$.action')='deployment.activate' AND json_extract(NEW.data,'$.outcome')='blocked' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    let before = rollout::deployments(&mut conn).await.unwrap();
    let devices = rollout::devices(&mut conn).await.unwrap();
    let audits = db::records(&mut conn, "audit").await.unwrap();
    drop(conn);
    assert!(rollout::tick(&s).await.is_err());
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(rollout::deployments(&mut conn).await.unwrap(), before);
    assert_eq!(rollout::devices(&mut conn).await.unwrap(), devices);
    assert_eq!(db::records(&mut conn, "audit").await.unwrap(), audits);
}

#[tokio::test]
async fn schedules_survive_restart_and_activate_once_or_become_missed() {
    let (temp, s) = state().await;
    let ids = seed(&s, 1).await;
    let settings = s.settings.clone();
    let mut tx = s.pool.begin().await.unwrap();
    let mut v = request(&ids, "version-a", 10, false);
    v["scheduled_at"] = json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let d = rollout::create(&mut tx, &v, "operator").await.unwrap();
    let id = d["id"].as_str().unwrap();
    let mut stored = db::record(&mut tx, "deployment", id).await.unwrap();
    stored["scheduled_at"] =
        json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
    db::update(&mut tx, "deployment", &stored).await.unwrap();
    tx.commit().await.unwrap();
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    rollout::tick(&s).await.unwrap();
    rollout::tick(&s).await.unwrap();
    let generation: i64 = sqlx::query_scalar("SELECT desired_generation FROM devices")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(generation, 1);
    let mut tx = s.pool.begin().await.unwrap();
    v["priority"] = json!(20);
    v["scheduled_at"] = json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let mut late = rollout::create(&mut tx, &v, "operator").await.unwrap();
    late["scheduled_at"] = json!((chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339());
    late.as_object_mut().unwrap().remove("targets");
    db::update(&mut tx, "deployment", &late).await.unwrap();
    tx.commit().await.unwrap();
    rollout::tick(&s).await.unwrap();
    let mut conn = s.pool.acquire().await.unwrap();
    assert_eq!(
        db::record(&mut conn, "deployment", late["id"].as_str().unwrap())
            .await
            .unwrap()["status"],
        "missed"
    );
    drop(temp);
}

#[tokio::test]
async fn persistent_new_members_cannot_bypass_active_canary() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 3).await;
    let mut tx = s.pool.begin().await.unwrap();
    let mut group = json!({"id":"group","name":"Production","device_ids":[ids[0],ids[1]],"created_at":db::now()});
    db::insert(&mut tx, "group", &group).await.unwrap();
    let mut v = request(&[], "version-a", 10, true);
    v["selector"]["group_ids"] = json!(["group"]);
    v["target_mode"] = json!("persistent");
    let d = rollout::create(&mut tx, &v, "operator").await.unwrap();
    group["device_ids"] = json!(ids);
    db::update(&mut tx, "group", &group).await.unwrap();
    rollout::reconcile_membership(&mut tx).await.unwrap();
    let targets = rollout::targets(&mut tx, d["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(targets.len(), 3);
    assert_eq!(targets.iter().filter(|t| t["generation"] != 0).count(), 1);
    let generation: i64 =
        sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id='device-2'")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(generation, 0);
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn signed_manifest_binds_nonce_and_artifact_is_current_only() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signature, Verifier};
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('fingerprint',?,?)",
    )
    .bind(&ids[0])
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .execute(&s.pool)
    .await
    .unwrap();
    let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        "fingerprint".into(),
    ))));
    let nonce = STANDARD.encode([42; 32]);
    let heartbeat = json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":nonce,"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false});
    let (status, envelope, _) = call(
        app.clone(),
        "POST",
        "/agent/v1/heartbeat",
        heartbeat.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let bytes = STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let sig = Signature::from_slice(
        &STANDARD
            .decode(envelope["signature"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    s.keys.signing.verifying_key().verify(&bytes, &sig).unwrap();
    let payload: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(payload["nonce"], nonce);
    assert_eq!(payload["device_id"], ids[0]);
    assert!(payload["desired"].is_null());
    assert_eq!(
        call(
            app.clone(),
            "GET",
            &format!("/agent/v1/artifacts/{}", db::hash("{}\n")),
            Value::Null,
            "",
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        call(app, "POST", "/agent/v1/heartbeat", heartbeat, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn artifact_downloads_never_wait_for_the_writer_lock() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    let mut tx = s.pool.begin().await.unwrap();
    rollout::create(&mut tx, &request(&ids, "version-a", 10, false), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('fingerprint',?,?)",
    )
    .bind(&ids[0])
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .execute(&s.pool)
    .await
    .unwrap();
    let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
        "fingerprint".into(),
    ))));
    let path = format!("/agent/v1/artifacts/{}", db::hash("{}\n"));
    // A heartbeat or the scheduler is writing. A download is a read: it
    // must not queue behind the writer, nor make writers queue behind it.
    let writing = s.writer.lock().await;
    let download = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        call(app.clone(), "GET", &path, Value::Null, "", ""),
    )
    .await;
    drop(writing);
    let (status, artifact, _) = download.expect("the download waited for the writer lock");
    assert_eq!(status, StatusCode::OK, "{artifact}");
    assert_eq!(artifact, json!({}));
    // The digest still decides: anything but the current artifact is refused.
    let other = format!("/agent/v1/artifacts/{}", db::hash("other"));
    assert_eq!(
        call(app, "GET", &other, Value::Null, "", "").await.0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn mfa_requires_second_factor_and_recovery_codes_are_single_use() {
    let (_temp, s) = state().await;
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let (_, _, old_cookie) = call(
        app.clone(),
        "POST",
        "/api/v1/login",
        json!({"email":"admin@example.test","password":"a-long-enough-password"}),
        "",
        "",
    )
    .await;
    let (status, setup, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/setup",
        json!({"password":"a-long-enough-password"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{setup}");
    let secret = setup["secret"].as_str().unwrap().to_owned();
    let totp = totp_rs::TOTP::from_url(setup["otpauth_url"].as_str().unwrap()).unwrap();
    let code = totp.generate_current().unwrap();
    let (status, confirmed, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/confirm",
        json!({"code":code}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{confirmed}");
    assert_eq!(confirmed["recovery_codes"].as_array().unwrap().len(), 8);
    assert_eq!(
        call(
            app.clone(),
            "GET",
            "/api/v1/session",
            Value::Null,
            &old_cookie,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let encrypted: String = sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(!encrypted.contains(&secret));
    assert!(s.keys.open_mfa("wrong-user", &encrypted).is_err());
    let credentials = json!({"email":"admin@example.test","password":"a-long-enough-password"});
    let (status, challenge, cookie) = call(
        app.clone(),
        "POST",
        "/api/v1/login",
        credentials.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(challenge["mfa_required"], true);
    assert!(challenge.get("csrf_token").is_none());
    assert!(cookie.is_empty());
    let mut replay = credentials.clone();
    replay["totp_code"] = json!(code);
    assert_eq!(
        call(app.clone(), "POST", "/api/v1/login", replay, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let mut backup = credentials;
    backup["recovery_code"] = confirmed["recovery_codes"][0].clone();
    let (status, session, new_cookie) =
        call(app.clone(), "POST", "/api/v1/login", backup.clone(), "", "").await;
    assert_eq!(status, StatusCode::OK, "{session}");
    assert_eq!(
        call(app.clone(), "POST", "/api/v1/login", backup, "", "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, disabled, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/disable",
        json!({"password":"a-long-enough-password","recovery_code":confirmed["recovery_codes"][1]}),
        &new_cookie,
        session["csrf_token"].as_str().unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{disabled}");
    assert_eq!(disabled["enabled"], false);
}

#[tokio::test]
async fn unread_mfa_receipts_leave_only_current_status_and_repeated_disable_has_new_effects() {
    let (_temp, s) = state().await;
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let password = "a-long-enough-password";

    // The first setup commits, but its one-time secret response is discarded.
    let setup_request = Request::builder()
        .method("POST")
        .uri("/api/v1/mfa/setup")
        .header("content-type", "application/json")
        .header("cookie", &cookie)
        .header("x-csrf-token", &csrf)
        .body(Body::from(json!({"password": password}).to_string()))
        .unwrap();
    let unread_setup = app.clone().oneshot(setup_request).await.unwrap();
    assert_eq!(unread_setup.status(), StatusCode::OK);
    assert_eq!(unread_setup.headers()["cache-control"], "no-store");
    drop(unread_setup);
    assert_eq!(
        call(app.clone(), "GET", "/api/v1/mfa", Value::Null, &cookie, "")
            .await
            .1,
        json!({"enabled": false, "recovery_codes_remaining": null}),
        "a pending setup is not a recoverable secret or enabled state"
    );
    let first_ciphertext: String = sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa")
        .fetch_one(&s.pool)
        .await
        .unwrap();

    // A separately requested setup replaces the unread one; only this new
    // response supplies a secret from which the person can verify a code.
    let (status, setup, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/setup",
        json!({"password": password}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let next_ciphertext: String = sqlx::query_scalar("SELECT secret_ciphertext FROM user_mfa")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_ne!(first_ciphertext, next_ciphertext);
    let generator = totp_rs::TOTP::from_url(setup["otpauth_url"].as_str().unwrap()).unwrap();
    let confirmation = generator.generate_current().unwrap();

    // Confirmation also commits without its body being read. The eight
    // recovery codes are stored as verifiers only, never available from GET.
    let confirm_request = Request::builder()
        .method("POST")
        .uri("/api/v1/mfa/confirm")
        .header("content-type", "application/json")
        .header("cookie", &cookie)
        .header("x-csrf-token", &csrf)
        .body(Body::from(json!({"code": confirmation}).to_string()))
        .unwrap();
    let unread_confirm = app.clone().oneshot(confirm_request).await.unwrap();
    assert_eq!(unread_confirm.status(), StatusCode::OK);
    drop(unread_confirm);
    assert_eq!(
        call(app.clone(), "GET", "/api/v1/mfa", Value::Null, &cookie, "")
            .await
            .1,
        json!({"enabled": true, "recovery_codes_remaining": 8})
    );
    let recovery_count: i64 = sqlx::query_scalar("SELECT count(*) FROM mfa_recovery_codes")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(recovery_count, 8);
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/mfa/confirm",
            json!({"code": confirmation}),
            &cookie,
            &csrf,
        )
        .await
        .0,
        StatusCode::CONFLICT,
        "repeating confirmation cannot recover the original codes"
    );

    let next_step = chrono::Utc::now().timestamp() / 30 + 1;
    let next_code = generator.generate((next_step * 30) as u64);
    let (status, disabled, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/disable",
        json!({"password": password, "code": next_code}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{disabled}");
    assert_eq!(disabled, json!({"enabled": false}));
    assert_eq!(
        call(app.clone(), "GET", "/api/v1/mfa", Value::Null, &cookie, "")
            .await
            .1,
        json!({"enabled": false, "recovery_codes_remaining": null})
    );
    let remaining_codes: i64 = sqlx::query_scalar("SELECT count(*) FROM mfa_recovery_codes")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(remaining_codes, 0);

    // A repeat with MFA already absent still commits a new audit and revokes
    // sessions created since the first disable. It is not harmless replay.
    let (status, sibling, sibling_cookie) = call(
        app.clone(),
        "POST",
        "/api/v1/login",
        json!({"email": "admin@example.test", "password": password}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sibling}");
    assert_eq!(
        call(
            app.clone(),
            "GET",
            "/api/v1/session",
            Value::Null,
            &sibling_cookie,
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, repeated, _) = call(
        app.clone(),
        "POST",
        "/api/v1/mfa/disable",
        json!({"password": password, "code": "not-a-current-code"}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{repeated}");
    assert_eq!(repeated, json!({"enabled": false}));
    assert_eq!(
        call(
            app.clone(),
            "GET",
            "/api/v1/session",
            Value::Null,
            &sibling_cookie,
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(app, "GET", "/api/v1/session", Value::Null, &cookie, "")
            .await
            .0,
        StatusCode::OK
    );
    let disable_audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='mfa.disable' AND json_extract(data,'$.outcome')='success'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(disable_audits, 2);
}

#[tokio::test]
async fn authorized_recovery_retires_old_identity_without_inheriting_assignments() {
    let (_temp, s) = state().await;
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let (_, token, _) = call(
        app.clone(),
        "POST",
        "/api/v1/tokens",
        json!({"name":"Test enrollment","expires_hours":1}),
        &cookie,
        &csrf,
    )
    .await;
    let device_api = device::router(s.clone());
    let key = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    let request = json!({"protocol_version":1,"request_id":"initial-enrollment","token":token["token"],"name":"edge-01","csr_pem":csr,"os":"linux","arch":"amd64","agent_version":"test","vector_version":"0.58.0"});
    let (status, enrolled, _) = call(
        device_api.clone(),
        "POST",
        "/agent/v1/enroll",
        request.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{enrolled}");
    let old = enrolled["device_id"].as_str().unwrap();
    let (_, group, _) = call(
        app.clone(),
        "POST",
        "/api/v1/groups",
        json!({"name":"Production","device_ids":[old]}),
        &cookie,
        &csrf,
    )
    .await;
    assert!(group["id"].is_string());
    let mut takeover = request.clone();
    takeover["request_id"] = json!("unauthorized-takeover");
    assert_eq!(
        call(
            device_api.clone(),
            "POST",
            "/agent/v1/enroll",
            takeover,
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, recovery, _) = call(
        app.clone(),
        "POST",
        &format!("/api/v1/devices/{old}/recover"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recovery}");
    // The old identity has an open issue that it can never resolve itself.
    let stranded = db::hash(format!("{old}:stranded"));
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, "issue", &json!({"id":stranded,"device_id":old,"code":"VALIDATION_FAILED","stage":"validate","count":1,"reports":1,"first_seen":db::now(),"last_seen":db::now(),"resolved":false,"revision":1})).await.unwrap();
    drop(conn);
    let replacement = rcgen::KeyPair::generate().unwrap();
    let mut retry = request;
    retry["token"] = recovery["token"].clone();
    retry["request_id"] = json!("recovery-enrollment");
    retry["csr_pem"] = json!(
        rcgen::CertificateParams::default()
            .serialize_request(&replacement)
            .unwrap()
            .pem()
            .unwrap()
    );
    let (status, new, _) = call(
        device_api.clone(),
        "POST",
        "/agent/v1/enroll",
        retry.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{new}");
    assert_ne!(new["device_id"], old);
    let (status, idempotent, _) = call(device_api, "POST", "/agent/v1/enroll", retry, "", "").await;
    assert_eq!(status, StatusCode::OK, "{idempotent}");
    assert_eq!(new, idempotent);
    let (_, fleet, _) = call(
        app.clone(),
        "GET",
        "/api/v1/devices",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    let device = fleet
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == new["device_id"])
        .unwrap();
    assert_eq!(device["desired_generation"], 0);
    assert!(device["desired_version_id"].is_null());
    let old_revoked: bool = sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
        .bind(old)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert!(old_revoked);
    let creds: i64 =
        sqlx::query_scalar("SELECT count(*) FROM credentials WHERE device_id=? AND revoked=0")
            .bind(old)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(creds, 0);
    let (_, issue, _) = call(
        app.clone(),
        "GET",
        &format!("/api/v1/issues/{stranded}"),
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert_eq!(issue["resolved_reason"], "revoked", "{issue}");
    let (_, groups, _) = call(app, "GET", "/api/v1/groups", Value::Null, &cookie, "").await;
    assert!(groups[0]["device_ids"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn operator_retry_advances_generation_and_schedule_refresh_requires_review() {
    let (_temp, s) = state().await;
    let old_ids = seed(&s, 2).await;
    let ids = vec![db::id(), db::id()];
    for (old, id) in old_ids.iter().zip(&ids) {
        sqlx::query("UPDATE devices SET id=?,data=json_set(data,'$.id',?) WHERE id=?")
            .bind(id)
            .bind(id)
            .bind(old)
            .execute(&s.pool)
            .await
            .unwrap();
    }
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    let version = "00000000-0000-4000-8000-000000000111";
    let mut metadata = db::record(&mut tx, "version", "version-a").await.unwrap();
    metadata["id"] = json!(version);
    db::insert(&mut tx, "version", &metadata).await.unwrap();
    rollout::create(&mut tx, &request(&ids[..1], version, 10, false), "operator")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','failed') WHERE id=?")
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let (status, retried, _) = call(
        app.clone(),
        "POST",
        &format!("/api/v1/devices/{}/retry", ids[0]),
        json!({"expected_version_id":version,"expected_generation":1}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["desired_generation"], 2);
    assert_eq!(
        call(
            app.clone(),
            "POST",
            &format!("/api/v1/devices/{}/retry", ids[0]),
            json!({"expected_version_id":version,"expected_generation":1}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, group, _) = call(
        app.clone(),
        "POST",
        "/api/v1/groups",
        json!({"name":"Scheduled fleet","device_ids":[ids[0]]}),
        &cookie,
        &csrf,
    )
    .await;
    let mut scheduled = request(&[], "version-b", 20, false);
    scheduled["selector"]["group_ids"] = json!([group["id"]]);
    scheduled["scheduled_at"] =
        json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let (status, deployment, _) = call(
        app.clone(),
        "POST",
        "/api/v1/deployments",
        scheduled,
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{deployment}");
    let (_, old_preview, _) = call(
        app.clone(),
        "POST",
        &format!(
            "/api/v1/deployments/{}/refresh-preview",
            deployment["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    let (status, _, _) = call(
        app.clone(),
        "PUT",
        &format!("/api/v1/groups/{}", group["id"].as_str().unwrap()),
        json!({"name":"Scheduled fleet","device_ids":ids,"revision":group["revision"]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let path = format!(
        "/api/v1/deployments/{}/refresh",
        deployment["id"].as_str().unwrap()
    );
    assert_eq!(
        call(
            app.clone(),
            "POST",
            &path,
            json!({"review_token":old_preview["review_token"],"expected_device_ids":[ids[0]]}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, fresh_preview, _) = call(
        app.clone(),
        "POST",
        &format!(
            "/api/v1/deployments/{}/refresh-preview",
            deployment["id"].as_str().unwrap()
        ),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    let (status, refreshed, _) = call(
        app,
        "POST",
        &path,
        json!({"review_token":fresh_preview["review_token"],"expected_device_ids":ids}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{refreshed}");
    assert_eq!(refreshed["targets"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn unassignment_preview_is_read_only_and_final_removal_keeps_reported_workload() {
    let (_temp, s) = state().await;
    seed(&s, 1).await;
    let ids = vec![db::id()];
    let version = db::id();
    sqlx::query("UPDATE devices SET id=?,data=json_set(data,'$.id',?) WHERE id='device-0'")
        .bind(&ids[0])
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let mut connection = s.pool.acquire().await.unwrap();
    db::insert(&mut connection,"version",&json!({"id":version,"configuration_id":db::id(),"number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    drop(connection);
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    let d = rollout::create(&mut tx, &request(&ids, &version, 10, false), "operator")
        .await
        .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.actual_sha256',?,'$.apply_state','verified_applied') WHERE id=?")
        .bind(db::hash("{}\n")).bind(&ids[0]).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let base = format!("/api/v1/deployments/{}", d["id"].as_str().unwrap());
    let (status, preview, _) = call(
        app.clone(),
        "POST",
        &format!("{base}/unassign-preview"),
        json!({}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert!(preview["devices"][0]["after"]["version_id"].is_null());
    assert_eq!(preview["devices"][0]["effect"], "unmanaged");
    let generation: i64 = sqlx::query_scalar("SELECT desired_generation FROM devices")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(generation, 1, "preview cannot advance generations");
    let (status, result, _) = call(
        app.clone(),
        "POST",
        &format!("{base}/unassign"),
        json!({"review_token":preview["review_token"]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["status"], "unassigned");
    for action in ["cancel", "pause", "resume", "rollback"] {
        assert_eq!(
            call(
                app.clone(),
                "POST",
                &format!("{base}/{action}"),
                json!({}),
                &cookie,
                &csrf
            )
            .await
            .0,
            StatusCode::CONFLICT,
            "Removed assignments cannot become effective again through {action}"
        );
    }
    rollout::tick(&s).await.unwrap();
    let (_, devices, _) = call(
        app.clone(),
        "GET",
        "/api/v1/devices",
        Value::Null,
        &cookie,
        "",
    )
    .await;
    assert!(devices[0]["desired_version_id"].is_null());
    assert_eq!(devices[0]["desired_generation"], 2);
    assert_eq!(devices[0]["actual_sha256"], db::hash("{}\n"));
    assert_eq!(devices[0]["status"], "unmanaged");
    let (_, audit, _) = call(app, "GET", "/api/v1/audit", Value::Null, &cookie, "").await;
    assert!(
        audit
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["actor"] == "Administrator" && event["actor_id"].is_string())
    );
}

#[tokio::test]
async fn missing_mfa_key_blocks_restore_and_state_directory_is_single_instance() {
    let (_temp, s) = state().await;
    assert!(
        initialize(s.settings.clone()).await.is_err(),
        "active instance lock is mandatory"
    );
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/mfa/setup",
            json!({"password":"a-long-enough-password"}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let settings = s.settings.clone();
    s.pool.close().await;
    drop(app);
    drop(s);
    // This removes only the test-owned ephemeral sealing key to exercise incomplete restore.
    std::fs::remove_file(settings.data_dir.join("keys/mfa-sealing.key")).unwrap();
    let error = initialize(settings)
        .await
        .err()
        .expect("missing sealing key must fail");
    assert!(error.to_string().contains("MFA sealing key is missing"));
}

#[tokio::test]
async fn signing_rotation_preserves_old_credentials_until_authenticated_renewal() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signature, Verifier};
    let (_temp, s) = state().await;
    let ids = seed(&s, 1).await;
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES('old',?,?,?)")
        .bind(&ids[0]).bind((chrono::Utc::now()+chrono::Duration::days(2)).to_rfc3339()).bind(s.keys.active_signing_id()).execute(&s.pool).await.unwrap();
    let old_key = s.keys.signing.verifying_key();
    let old_id = s.keys.active_signing_id();
    let settings = s.settings.clone();
    let new_id = vectory_server::maintenance::rotate_signing_key(&s)
        .await
        .unwrap();
    assert_ne!(new_id, old_id);
    s.pool.close().await;
    drop(s);
    let s = initialize(settings).await.unwrap();
    assert_eq!(s.keys.active_signing_id(), new_id);
    let heartbeat = json!({"protocol_version":1,"request_id":"request","boot_id":"boot","nonce":STANDARD.encode([42;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false});
    let old_app =
        device::router(s.clone()).layer(Extension(device::PeerCertificate(Some("old".into()))));
    let (status, envelope, _) = call(
        old_app.clone(),
        "POST",
        "/agent/v1/heartbeat",
        heartbeat.clone(),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let bytes = STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let signature = Signature::from_slice(
        &STANDARD
            .decode(envelope["signature"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    old_key.verify(&bytes, &signature).unwrap();
    assert!(
        s.keys
            .signing
            .verifying_key()
            .verify(&bytes, &signature)
            .is_err()
    );
    let key = rcgen::KeyPair::generate().unwrap();
    let csr = rcgen::CertificateParams::default()
        .serialize_request(&key)
        .unwrap()
        .pem()
        .unwrap();
    let (status, renewed, _) = call(
        old_app,
        "POST",
        "/agent/v1/renew",
        json!({"csr_pem":csr}),
        "",
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{renewed}");
    assert_eq!(
        renewed["signing_public_key"],
        STANDARD.encode(s.keys.signing.verifying_key().as_bytes())
    );
    use rustls::pki_types::pem::PemObject;
    let cert = rustls::pki_types::CertificateDer::pem_slice_iter(
        renewed["certificate_pem"].as_str().unwrap().as_bytes(),
    )
    .next()
    .unwrap()
    .unwrap();
    let fingerprint = db::hash(cert);
    let new_app =
        device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(fingerprint))));
    let (status, envelope, _) =
        call(new_app, "POST", "/agent/v1/heartbeat", heartbeat, "", "").await;
    assert_eq!(status, StatusCode::OK, "{envelope}");
    let bytes = STANDARD
        .decode(envelope["payload"].as_str().unwrap())
        .unwrap();
    let signature = Signature::from_slice(
        &STANDARD
            .decode(envelope["signature"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    s.keys
        .signing
        .verifying_key()
        .verify(&bytes, &signature)
        .unwrap();
    assert_eq!(
        vectory_server::maintenance::prune_signing_keys(&s)
            .await
            .unwrap(),
        0,
        "old key retained during valid credential overlap"
    );
    sqlx::query("UPDATE credentials SET revoked=1 WHERE fingerprint='old'")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        vectory_server::maintenance::prune_signing_keys(&s)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn authenticated_fleet_limiter_is_independent_of_anonymous_key_pressure() {
    let (_temp, s) = state().await;
    for i in 0..10000 {
        s.limit(
            format!("heartbeat:registered-device-{i}"),
            30,
            std::time::Duration::from_secs(60),
        )
        .unwrap();
    }
    for i in 0..vectory_server::ANONYMOUS_LIMIT_KEYS {
        s.limit(
            format!("login:unknown-{i}"),
            8,
            std::time::Duration::from_secs(300),
        )
        .unwrap();
    }
    s.limit(
        "heartbeat:another-registered-device".into(),
        30,
        std::time::Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(s.device_limits.lock().unwrap().len(), 10001);
}

#[tokio::test]
async fn a_full_limiter_admits_new_sign_in_clients_and_keeps_spent_budgets() {
    let (_temp, s) = state().await;
    let minute = std::time::Duration::from_secs(60);
    let five_minutes = std::time::Duration::from_secs(300);
    // Someone spent a reset code's budget, in a five-minute window.
    for _ in 0..8 {
        s.limit("password-reset:guessed".into(), 8, five_minutes)
            .unwrap();
    }
    assert!(
        s.limit("password-reset:guessed".into(), 8, five_minutes)
            .is_err()
    );
    // Sign-in clients with one-minute windows fill the partition.
    for i in 0..vectory_server::ANONYMOUS_LIMIT_KEYS {
        s.limit(format!("login-client:198.51.{i}"), 60, minute)
            .unwrap();
    }
    assert_eq!(
        s.limits.lock().unwrap().len(),
        vectory_server::ANONYMOUS_LIMIT_KEYS
    );
    // A new client can still sign in: the key whose window ends soonest
    // makes room. The server is never "busy" because the map is full.
    for n in 0..100 {
        s.limit(format!("login-client:203.0.113.{n}"), 60, minute)
            .unwrap();
    }
    assert_eq!(
        s.limits.lock().unwrap().len(),
        vectory_server::ANONYMOUS_LIMIT_KEYS
    );
    // The spent budget has the most time left, so it still holds.
    let refused = s
        .limit("password-reset:guessed".into(), 8, five_minutes)
        .unwrap_err();
    assert_eq!(refused.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(refused.retry_after.unwrap() > 60, "{refused:?}");
}

#[tokio::test]
async fn unauthenticated_agent_listener_traffic_never_displaces_sign_in_keys() {
    let (_temp, s) = state().await;
    let minute = std::time::Duration::from_secs(60);
    for _ in 0..60 {
        s.limit("login-client:198.51.100.7".into(), 60, minute)
            .unwrap();
    }
    let signing_in = s.limits.lock().unwrap().len();
    // A flood from many addresses fills its own partition: installer,
    // download, enrollment and invitation keys. Nothing is ever refused
    // because a map is full.
    for i in 0..vectory_server::PUBLIC_LIMIT_KEYS + 1000 {
        let key = match i % 4 {
            0 => format!("agent-installer:2001:db8:{i:x}::/64"),
            1 => format!("agent-download:2001:db8:{i:x}::/64"),
            2 => format!("enrollment:2001:db8:{i:x}::/64"),
            _ => format!("invite-preview:2001:db8:{i:x}::/64"),
        };
        s.limit(key, 300, std::time::Duration::from_secs(600))
            .unwrap();
    }
    assert_eq!(
        s.public_limits.lock().unwrap().len(),
        vectory_server::PUBLIC_LIMIT_KEYS
    );
    assert_eq!(s.limits.lock().unwrap().len(), signing_in);
    // The sign-in client's spent minute still holds.
    assert!(
        s.limit("login-client:198.51.100.7".into(), 60, minute)
            .is_err()
    );
}
