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
        instance_name: "Synthetic exact detail read tests".into(),
        validation_url: None,
    })
    .await
    .unwrap();
    let (_, cookie, csrf) = actor(&s, "admin").await;
    let mut ids = Vec::new();
    for n in 0..2 {
        let id = format!("00000000-0000-4000-8000-0000000000a{n}");
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

async fn read(app: &Router, path: &str, cookie: &str) -> (StatusCode, Value) {
    call(app, "GET", path, Value::Null, cookie, "").await
}
async fn snapshot(s: &State) -> Value {
    let records: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(kind,id,data,created_at) FROM records ORDER BY kind,id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    let devices:Vec<String>=sqlx::query_scalar("SELECT json_array(id,name,data,revoked,desired_version_id,desired_generation,policy,policy_generation,assignment_id,policy_assignment_id) FROM devices ORDER BY id").fetch_all(&s.pool).await.unwrap();
    let telemetry: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(device_id,bucket,data) FROM telemetry ORDER BY device_id,bucket",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    let sessions: Vec<String> = sqlx::query_scalar(
        "SELECT json_array(verifier,user_id,csrf,expires_at) FROM sessions ORDER BY verifier",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    json!({"records":records,"devices":devices,"telemetry":telemetry,"sessions":sessions})
}
fn emit(manifest: &mut Vec<Value>, name: &str, schema: &str, value: &Value, expected: Value) {
    if let Ok(dir) = std::env::var("VECTORY_DEVICE_DETAIL_FIXTURES") {
        std::fs::create_dir_all(&dir).unwrap();
        let file = format!("{name}.json");
        std::fs::write(
            std::path::Path::new(&dir).join(&file),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
        manifest.push(json!({"file":file,"schema":schema,"expected":expected}));
    }
}
#[tokio::test]
async fn exact_device_telemetry_version_and_configuration_reads_preserve_relationships() {
    let (_temp, s, app, ids, cookie, _) = fixture().await;
    let mut manifest = Vec::new();
    let configs = [
        "00000000-0000-4000-8000-0000000000c0",
        "00000000-0000-4000-8000-0000000000c1",
    ];
    let versions = [
        "00000000-0000-4000-8000-0000000000d0",
        "00000000-0000-4000-8000-0000000000d1",
    ];
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..2 {
        let config = json!({"id":configs[n],"name":format!("Synthetic pipeline {n}"),"description":"Read-only relationship fixture, not published/activated by a real validator","revision":1,"config":{"sources":{},"transforms":{},"sinks":{}},"graph":{"nodes":[],"edges":[]},"created_at":db::now(),"updated_at":db::now(),"archived":false,"archived_at":null});
        db::insert(&mut tx, "configuration", &config).await.unwrap();
        let version = json!({"id":versions[n],"configuration_id":configs[n],"number":n+1,"graph":config["graph"],"config":config["config"],"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now(),"message":"Synthetic relationship evidence only","validation":{"valid":true,"errors":[]},"source_revision":1});
        db::insert(&mut tx, "version", &version).await.unwrap();
        sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=1 WHERE id=?")
            .bind(versions[n])
            .bind(&ids[n])
            .execute(&mut *tx)
            .await
            .unwrap();
        for bucket in [10, 11] {
            sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?)").bind(&ids[n]).bind(bucket).bind(json!({"sampled_at":db::now(),"errors":100*(n+1)+bucket as usize,"components":[]}).to_string()).execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
    let before = snapshot(&s).await;
    for n in 0..2 {
        let endpoints = [
            (format!("/api/v1/devices/{}", ids[n]), "Device", "device"),
            (
                format!("/api/v1/devices/{}/telemetry", ids[n]),
                "TelemetryHistory",
                "telemetry",
            ),
            (
                format!("/api/v1/versions/{}", versions[n]),
                "Version",
                "version",
            ),
            (
                format!("/api/v1/configurations/{}", configs[n]),
                "Configuration",
                "configuration",
            ),
        ];
        for (path, schema, label) in endpoints {
            assert_eq!(read(&app, &path, "").await.0, StatusCode::UNAUTHORIZED);
            let (code, value) = read(&app, &path, &cookie).await;
            assert_eq!(code, StatusCode::OK, "{value}");
            let expected = match label {
                "device" => {
                    assert_eq!(value["id"], ids[n]);
                    assert_eq!(value["desired_version_id"], versions[n]);
                    json!({"id":ids[n],"desired_version_id":versions[n]})
                }
                "telemetry" => {
                    assert_eq!(value["device_id"], ids[n]);
                    assert_eq!(value["samples"].as_array().unwrap().len(), 2);
                    assert_eq!(value["samples"][0]["bucket"], 10);
                    assert_eq!(value["samples"][0]["errors"], 100 * (n + 1) + 10);
                    assert_eq!(value["samples"][1]["errors"], 100 * (n + 1) + 11);
                    json!({"device_id":ids[n],"first_errors":100*(n+1)+10})
                }
                "version" => {
                    assert_eq!(value["id"], versions[n]);
                    assert_eq!(value["configuration_id"], configs[n]);
                    json!({"id":versions[n],"configuration_id":configs[n]})
                }
                _ => {
                    assert_eq!(value["id"], configs[n]);
                    json!({"id":configs[n]})
                }
            };
            emit(
                &mut manifest,
                &format!("{label}_{n}"),
                schema,
                &value,
                expected,
            );
            let prefix = path.rsplit_once('/').unwrap().0;
            if label != "telemetry" {
                let original = path.rsplit_once('/').unwrap().1;
                for alias in [original.to_uppercase(), original.replace("-", "")] {
                    assert_eq!(
                        read(&app, &format!("{prefix}/{alias}"), &cookie).await.0,
                        StatusCode::NOT_FOUND
                    );
                }
            } else {
                assert_eq!(
                    read(
                        &app,
                        &format!("/api/v1/devices/{}/telemetry", ids[n].to_uppercase()),
                        &cookie
                    )
                    .await
                    .0,
                    StatusCode::NOT_FOUND
                );
            }
            // URI percent decoding preserves equivalent identity; query fields cannot select a different record.
            assert_eq!(
                read(&app, &path.replace('-', "%2D"), &cookie).await.1,
                value
            );
            assert_eq!(
                read(&app, &format!("{path}?id={}", ids[1 - n]), &cookie)
                    .await
                    .1,
                value
            );
        }
    }
    let missing = "00000000-0000-4000-8000-0000000000ff";
    for (label, path) in [
        ("device", format!("/api/v1/devices/{missing}")),
        ("telemetry", format!("/api/v1/devices/{missing}/telemetry")),
        ("version", format!("/api/v1/versions/{missing}")),
        ("configuration", format!("/api/v1/configurations/{missing}")),
    ] {
        let (code, error) = read(&app, &path, &cookie).await;
        assert_eq!(code, StatusCode::NOT_FOUND);
        emit(
            &mut manifest,
            &format!("missing_{label}"),
            "Error",
            &error,
            json!({"http_status":404}),
        );
    }
    assert_eq!(snapshot(&s).await, before);
    // These resources are independent snapshots. An old immutable version remains
    // correctly readable after a newer desired assignment is observed on a device.
    sqlx::query("UPDATE devices SET desired_version_id=?,desired_generation=2 WHERE id=?")
        .bind(versions[1])
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let stable = snapshot(&s).await;
    let latest = read(&app, &format!("/api/v1/devices/{}", ids[0]), &cookie)
        .await
        .1;
    assert_eq!(latest["id"], ids[0]);
    assert_eq!(latest["desired_version_id"], versions[1]);
    assert_eq!(latest["desired_generation"], 2);
    let old = read(&app, &format!("/api/v1/versions/{}", versions[0]), &cookie)
        .await
        .1;
    assert_eq!(old["configuration_id"], configs[0]);
    emit(
        &mut manifest,
        "device_after_desired_change",
        "Device",
        &latest,
        json!({"id":ids[0],"desired_version_id":versions[1],"desired_generation":2}),
    );
    assert_eq!(snapshot(&s).await, stable);
    if let Ok(dir) = std::env::var("VECTORY_DEVICE_DETAIL_FIXTURES") {
        std::fs::write(
            std::path::Path::new(&dir).join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }
}
