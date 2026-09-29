use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize};

const WEB: &str = "10000000-0000-4000-8000-000000000001";
const EDGE: &str = "10000000-0000-4000-8000-000000000002";
const STALE: &str = "10000000-0000-4000-8000-000000000003";
const VERSION: &str = "20000000-0000-4000-8000-000000000001";
const OTHER_VERSION: &str = "20000000-0000-4000-8000-000000000002";
const PIPELINE: &str = "30000000-0000-4000-8000-000000000001";

struct Fixture {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    cookie: String,
}
async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-telemetry-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Telemetry tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let id = db::id();
    let token = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind("viewer@example.test")
    .bind("Viewer")
    .bind("viewer")
    .bind("unused")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(auth::random_secret())
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    let app = api::router(s.clone());
    Fixture {
        _temp: temp,
        s,
        app,
        cookie: format!("vectory_session={token}"),
    }
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn ago(seconds: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(seconds))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
async fn device_with(f: &Fixture, id: &str, name: &str, data: Value) {
    let mut record = json!({"id":id,"name":name,"os":"linux","arch":"amd64","apply_state":"verified_applied","reported_generation":1,"created_at":db::now()});
    for (k, v) in data.as_object().unwrap() {
        record[k] = v.clone();
    }
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(id)
        .bind(name)
        .bind(record.to_string())
        .execute(&f.s.pool)
        .await
        .unwrap();
}
fn running(version: &str) -> Value {
    json!({"actual_sha256":"a".repeat(64),"verified_effective_sha256":"a".repeat(64),"verified_configuration_attempt":{"generation":1,"version_id":version,"sha256":"a".repeat(64)}})
}
fn merged(mut a: Value, b: Value) -> Value {
    for (k, v) in b.as_object().unwrap() {
        a[k] = v.clone();
    }
    a
}
async fn seed(f: &Fixture) {
    let mut conn = f.s.pool.acquire().await.unwrap();
    db::insert(&mut conn,"configuration",&json!({"id":PIPELINE,"name":"Web access logs","description":"","revision":1,"config":{},"graph":{"nodes":[],"edges":[]},"created_at":db::now(),"updated_at":db::now()})).await.unwrap();
    for (id, number) in [(VERSION, 2), (OTHER_VERSION, 1)] {
        db::insert(&mut conn,"version",&json!({"id":id,"configuration_id":PIPELINE,"number":number,"artifact":"{}","sha256":"a".repeat(64),"size":2,"created_at":db::now()})).await.unwrap();
    }
    drop(conn);
    device_with(f, WEB, "web-01", merged(running(VERSION), json!({"telemetry":{"sampled_at":ago(20),"events_per_second":10.0,"events_out_per_second":8.0,"errors_per_minute":0.0,"buffer_utilization":0.2,"components":[
        {"id":"app_logs","kind":"source","type":"demo_logs","events_per_second":10.0},
        {"id":"by_severity","kind":"transform","type":"route","received_events_per_second":10.0,"events_per_second":10.0,"sent_by_output":{"errors":1.0,"_unmatched":9.0}},
        {"id":"archive","kind":"sink","type":"http","received_events_per_second":9.0,"events_per_second":8.0,"buffer_utilization":0.2,"errors_per_minute":0.0}
    ]}}))).await;
    device_with(f, EDGE, "edge-01", merged(running(VERSION), json!({"telemetry":{"sampled_at":ago(40),"events_per_second":5.0,"events_out_per_second":5.0,"components":[
        {"id":"by_severity","kind":"transform","type":"route","events_per_second":5.0,"sent_by_output":{"errors":0.5}},
        {"id":"archive","kind":"sink","type":"http","events_per_second":5.0,"buffer_utilization":0.6,"errors_per_minute":3.0}
    ]}}))).await;
    // A running device whose latest sample is an hour old: it counts as running
    // but must never contribute to "now".
    device_with(
        f,
        STALE,
        "edge-02",
        merged(
            running(OTHER_VERSION),
            json!({"telemetry":{"sampled_at":ago(3600),"events_per_second":999.0}}),
        ),
    )
    .await;
    let now = chrono::Utc::now().timestamp() / 60;
    for (device, minutes_ago, rate) in [
        (WEB, 1, 10.0),
        (WEB, 2, 12.0),
        (EDGE, 1, 5.0),
        (WEB, 400, 7.0),
    ] {
        sqlx::query("INSERT INTO telemetry(device_id,bucket,data) VALUES(?,?,?)")
            .bind(device)
            .bind(now - minutes_ago)
            .bind(json!({"sampled_at":ago(minutes_ago*60),"events_per_second":rate,"events_out_per_second":rate-1.0,"errors_per_minute":1.0}).to_string())
            .execute(&f.s.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn fleet_summary_reports_fresh_totals_with_coverage_and_null_when_missing() {
    let f = fixture().await;
    let (status, empty) = get(&f, "/api/v1/telemetry/summary").await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty["devices_total"], 0);
    assert_eq!(empty["devices_reporting"], 0);
    assert!(
        empty["events_in_per_second"].is_null(),
        "no reports is unavailable, not zero"
    );
    assert!(empty["errors_per_minute"].is_null());
    assert_eq!(empty["series"], json!([]));
    seed(&f).await;
    let (status, summary) = get(&f, "/api/v1/telemetry/summary?range=1h").await;
    assert_eq!(status, StatusCode::OK, "{summary}");
    assert_eq!(summary["devices_total"], 3);
    assert_eq!(summary["devices_reporting"], 2);
    assert_eq!(summary["events_in_per_second"], 15.0);
    assert_eq!(summary["events_out_per_second"], 13.0);
    assert_eq!(summary["errors_per_minute"], 0.0);
    assert_eq!(
        summary["coverage"]["errors_per_minute"], 1,
        "only web-01 reported errors"
    );
    assert_eq!(summary["coverage"]["events_in_per_second"], 2);
    assert_eq!(summary["buffer_utilization_max"], 0.2);
    assert!(summary["bytes_in_per_second"].is_null());
    assert_eq!(summary["step_seconds"], 60);
    let series = summary["series"].as_array().unwrap();
    assert_eq!(
        series.len(),
        2,
        "the 400-minute-old bucket is outside 1h: {series:?}"
    );
    let last = series.last().unwrap();
    assert_eq!(last["devices_reporting"], 2);
    assert_eq!(last["events_in_per_second"], 15.0);
    let (_, day) = get(&f, "/api/v1/telemetry/summary?range=24h").await;
    assert_eq!(day["step_seconds"], 300);
    assert_eq!(
        get(&f, "/api/v1/telemetry/summary?range=1y").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(&f, "/api/v1/telemetry/summary?extra=1").await.0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn version_and_pipeline_aggregates_cover_only_devices_running_them() {
    let f = fixture().await;
    seed(&f).await;
    let (status, version) = get(&f, &format!("/api/v1/versions/{VERSION}/telemetry")).await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(version["devices_running"], 2);
    assert_eq!(version["devices_reporting"], 2);
    assert_eq!(version["events_in_per_second"], 15.0);
    let components = version["components"].as_array().unwrap();
    let route = components
        .iter()
        .find(|c| c["id"] == "by_severity")
        .unwrap();
    assert_eq!(route["devices_reporting"], 2);
    assert_eq!(route["sent_events_per_second"], 15.0);
    assert_eq!(route["sent_by_output"]["errors"], 1.5);
    assert_eq!(route["sent_by_output"]["_unmatched"], 9.0);
    assert!(route["received_events_per_second"].is_number());
    let sink = components.iter().find(|c| c["id"] == "archive").unwrap();
    assert_eq!(sink["buffer_utilization_max"], 0.6);
    assert_eq!(sink["errors_per_minute"], 3.0);
    let source = components.iter().find(|c| c["id"] == "app_logs").unwrap();
    assert_eq!(source["devices_reporting"], 1, "coverage is per component");
    assert!(source["errors_per_minute"].is_null());
    let (_, other) = get(&f, &format!("/api/v1/versions/{OTHER_VERSION}/telemetry")).await;
    assert_eq!(other["devices_running"], 1);
    assert_eq!(
        other["devices_reporting"], 0,
        "stale samples never describe now"
    );
    assert!(other["events_in_per_second"].is_null());
    let (_, pipeline) = get(&f, &format!("/api/v1/configurations/{PIPELINE}/telemetry")).await;
    assert_eq!(pipeline["devices_running"], 3);
    assert_eq!(pipeline["devices_reporting"], 2);
    assert_eq!(pipeline["versions"][0]["version_number"], 2);
    assert_eq!(pipeline["versions"][0]["devices_running"], 2);
    assert_eq!(pipeline["versions"][1]["devices_reporting"], 0);
    assert_eq!(
        get(
            &f,
            "/api/v1/versions/20000000-0000-4000-8000-000000000099/telemetry"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn device_history_keeps_legacy_shape_and_downsamples_ranges() {
    let f = fixture().await;
    seed(&f).await;
    let (status, legacy) = get(&f, &format!("/api/v1/devices/{WEB}/telemetry")).await;
    assert_eq!(status, StatusCode::OK, "{legacy}");
    assert_eq!(legacy["device_id"], WEB);
    assert_eq!(legacy["samples"].as_array().unwrap().len(), 3);
    assert!(legacy.get("step_seconds").is_none());
    let (_, hour) = get(&f, &format!("/api/v1/devices/{WEB}/telemetry?range=1h")).await;
    assert_eq!(hour["step_seconds"], 60);
    assert_eq!(hour["samples"].as_array().unwrap().len(), 2);
    let (_, day) = get(&f, &format!("/api/v1/devices/{WEB}/telemetry?range=24h")).await;
    assert_eq!(day["step_seconds"], 300);
    let points = day["samples"].as_array().unwrap();
    assert!(points.len() <= 3, "{points:?}");
    assert!(points.iter().all(|p| p["samples"].as_u64().unwrap() >= 1));
    assert_eq!(
        get(
            &f,
            &format!("/api/v1/devices/{WEB}/telemetry?range=forever")
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        get(
            &f,
            "/api/v1/devices/10000000-0000-4000-8000-000000000099/telemetry?range=1h"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn heartbeats_store_rich_samples_on_the_device_and_compact_history() {
    let f = fixture().await;
    device_with(
        &f,
        WEB,
        "web-01",
        json!({"apply_state":"unmanaged","reported_generation":0}),
    )
    .await;
    sqlx::query(
        "INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('telemetry-peer',?,?)",
    )
    .bind(WEB)
    .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
    .execute(&f.s.pool)
    .await
    .unwrap();
    let heartbeat = json!({"protocol_version":1,"request_id":"r","boot_id":"b","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"unmanaged","local_paused":false,"remote_pause_acknowledged":false,
        "telemetry":{"sampled_at":db::now(),"events_per_second":3.0,"events_out_per_second":2.0,"discarded_intentional":7.0,"discarded_error":0.0,"components":[{"id":"parse","kind":"transform","type":"remap","received_events_per_second":3.0,"events_per_second":3.0,"sent_by_output":{"_default":3.0}}]}});
    let response = device::router(f.s.clone())
        .layer(Extension(device::PeerCertificate(Some(
            "telemetry-peer".into(),
        ))))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/v1/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(heartbeat.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let (_, detail) = get(&f, &format!("/api/v1/devices/{WEB}")).await;
    assert_eq!(
        detail["telemetry"]["components"][0]["sent_by_output"]["_default"],
        3.0
    );
    assert_eq!(detail["telemetry"]["discarded_intentional"], 7.0);
    let stored: String = sqlx::query_scalar("SELECT data FROM telemetry WHERE device_id=?")
        .bind(WEB)
        .fetch_one(&f.s.pool)
        .await
        .unwrap();
    let stored: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(stored["events_out_per_second"], 2.0);
    assert!(
        stored.get("components").is_none(),
        "history keeps device-level readings only"
    );
}
