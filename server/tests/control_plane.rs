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
            json!({"name":"Reviewed group","device_ids":ids}),
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
    let mut wrong = report.clone();
    wrong["devices"][1]["device_id"] = json!("unknown");
    assert!(
        recover_generations(&s, serde_json::from_value(wrong).unwrap(), true)
            .await
            .is_err()
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
    assert_eq!(
        call(
            app.clone(),
            "POST",
            "/api/v1/login",
            credentials.clone(),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
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
    let (_, groups, _) = call(app, "GET", "/api/v1/groups", Value::Null, &cookie, "").await;
    assert!(groups[0]["device_ids"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn operator_retry_advances_generation_and_schedule_refresh_requires_review() {
    let (_temp, s) = state().await;
    let ids = seed(&s, 2).await;
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    rollout::create(
        &mut tx,
        &request(&ids[..1], "version-a", 10, false),
        "operator",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let (status, retried, _) = call(
        app.clone(),
        "POST",
        &format!("/api/v1/devices/{}/retry", ids[0]),
        json!({}),
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
            json!({}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
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
    let (status, _, _) = call(
        app.clone(),
        "PUT",
        &format!("/api/v1/groups/{}", group["id"].as_str().unwrap()),
        json!({"name":"Scheduled fleet","device_ids":ids}),
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
            json!({"expected_device_ids":[ids[0]]}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, refreshed, _) = call(
        app,
        "POST",
        &path,
        json!({"expected_device_ids":ids}),
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
    let ids = seed(&s, 1).await;
    let app = api::router(s.clone());
    let (cookie, csrf) = admin(&s).await;
    let mut tx = s.pool.begin().await.unwrap();
    let d = rollout::create(&mut tx, &request(&ids, "version-a", 10, false), "operator")
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
    assert!(preview["devices"][0]["desired_version_id"].is_null());
    let generation: i64 = sqlx::query_scalar("SELECT desired_generation FROM devices")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(generation, 1, "preview cannot advance generations");
    let (status, result, _) = call(
        app.clone(),
        "POST",
        &format!("{base}/unassign"),
        json!({}),
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
    for i in 0..4096 {
        s.limit(
            format!("login:unknown-{i}"),
            8,
            std::time::Duration::from_secs(300),
        )
        .unwrap();
    }
    assert!(
        s.limit(
            "login:overflow".into(),
            8,
            std::time::Duration::from_secs(300)
        )
        .is_err()
    );
    s.limit(
        "heartbeat:another-registered-device".into(),
        30,
        std::time::Duration::from_secs(60),
    )
    .unwrap();
}
