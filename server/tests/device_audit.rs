//! The audit rows a device writes about itself, and the timeline the rollout
//! page builds from them: each deployment's start and result stays in the log
//! however quickly deployments follow one another, a device that flaps stays
//! bounded and cannot spend another device's rows, and a target's timeline
//! holds only the rows that followed its own release.
use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, device, initialize, rollout};

const DEVICE: &str = "00000000-0000-4000-8000-000000000001";
const OTHER: &str = "00000000-0000-4000-8000-000000000002";
const PIPELINE: &str = "00000000-0000-4000-8000-000000000100";

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
        bootstrap_secret: "isolated-device-audit-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Device audit tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let (user, token, csrf) = (db::id(), auth::random_secret(), auth::random_secret());
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&user)
    .bind("viewer@example.invalid")
    .bind("Audit reader")
    .bind("viewer")
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&user)
        .bind(&csrf)
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    for (n, id) in [DEVICE, OTHER].into_iter().enumerate() {
        let data = json!({"id":id,"name":format!("web-{n:02}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&s.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(peer(id))
            .bind(id)
            .bind((chrono::Utc::now() + chrono::Duration::days(1)).to_rfc3339())
            .execute(&s.pool)
            .await
            .unwrap();
    }
    db::insert(
        &mut s.pool.acquire().await.unwrap(),
        "configuration",
        &json!({"id":PIPELINE,"name":"Web access logs","created_at":db::now()}),
    )
    .await
    .unwrap();
    Fixture {
        app: api::router(s.clone()),
        s,
        _temp: temp,
        cookie: format!("vectory_session={token}"),
    }
}

fn peer(device: &str) -> String {
    format!("audit-test-peer-{device}")
}
fn artifact(number: i64) -> String {
    format!("{{\"data_dir\":\"/var/lib/vectory-audit/{number}\"}}\n")
}
/// A published version, and a deployment of it to `devices` that releases at
/// once.
async fn deploy(f: &Fixture, number: i64, devices: &[&str]) -> String {
    let body = artifact(number);
    let version = db::id();
    let mut tx = f.s.pool.begin().await.unwrap();
    db::insert(&mut tx,"version",&json!({"id":version,"configuration_id":PIPELINE,"number":number,"artifact":body,"sha256":db::hash(&body),"size":body.len(),"created_at":db::now()})).await.unwrap();
    let created = rollout::create(
        &mut tx,
        &json!({"version_id":version,"selector":{"device_ids":devices,"group_ids":[],"exclude_ids":[]},"priority":100 * number,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":2,"observation_seconds":30,"failure_threshold":1}}),
        "operator",
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    created["id"].as_str().unwrap().to_owned()
}
/// A check-in of `device` that says it has reached `generation` and runs the
/// artifact of version `running` (none: nothing yet).
async fn beat(
    f: &Fixture,
    device: &str,
    state: &str,
    generation: i64,
    running: Option<i64>,
) -> StatusCode {
    let body = json!({"protocol_version":1,"request_id":"audit-test","boot_id":"audit-boot","nonce":"AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=","agent_version":"test","vector_version":"0.58.0","reported_generation":generation,"policy_generation":0,"actual_sha256":running.map(|n| db::hash(artifact(n))),"apply_state":state,"local_paused":false,"remote_pause_acknowledged":false});
    let response = device::router(f.s.clone())
        .layer(Extension(device::PeerCertificate(Some(peer(device)))))
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/v1/heartbeat")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    status
}
async fn rows(f: &Fixture, device: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT json_extract(r.data,'$.outcome') FROM records r JOIN audit_sequence q ON q.audit_id=r.id WHERE r.kind='audit' AND json_extract(r.data,'$.actor')=? AND json_extract(r.data,'$.action')='device.apply_state' ORDER BY q.sequence")
        .bind(device)
        .fetch_all(&f.s.pool)
        .await
        .unwrap()
}
/// The states the rollout page's timeline shows for `device` in `deployment`.
async fn timeline(f: &Fixture, deployment: &str, device: &str) -> Vec<String> {
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/deployments/{deployment}/targets"))
                .header("cookie", &f.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let page: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status, StatusCode::OK, "{page}");
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
}

// Three versions released one after another within a second, each verified:
// the log shows each one's start and result, and so does each target's
// timeline, though the releases and the verifications share a second.
#[tokio::test]
async fn three_quick_deployments_each_keep_their_own_start_and_result() {
    let f = fixture().await;
    let mut deployments = Vec::new();
    for number in 1..=3 {
        deployments.push(deploy(&f, number, &[DEVICE]).await);
        // The device learns of it while still running the previous version,
        // then runs this one.
        let (state, running) = if number == 1 {
            ("unmanaged", None)
        } else {
            ("verified_applied", Some(number - 1))
        };
        beat(&f, DEVICE, state, number - 1, running).await;
        beat(&f, DEVICE, "verified_applied", number, Some(number)).await;
    }
    assert_eq!(
        rows(&f, DEVICE).await,
        [
            "desired",
            "verified_applied",
            "desired",
            "verified_applied",
            "desired",
            "verified_applied"
        ]
    );
    for deployment in &deployments {
        assert_eq!(
            timeline(&f, deployment, DEVICE).await,
            ["desired", "verified_applied"],
            "{deployment}"
        );
    }
}

// A device that repeats one generation gets one exempt row of each of the
// three states and then the usual four a minute, whatever it keeps sending;
// another device's rows are its own.
#[tokio::test]
async fn a_device_that_flaps_between_results_stays_bounded_and_cannot_starve_another() {
    let bound = device::DEVICE_AUDIT_ROWS_PER_MINUTE as usize;
    let f = fixture().await;
    deploy(&f, 1, &[DEVICE, OTHER]).await;
    // Twelve check-ins in a second that alternate between running the version
    // and claiming to, with another build.
    for i in 0..12 {
        let running = if i % 2 == 0 { 1 } else { 9 };
        beat(&f, DEVICE, "verified_applied", 1, Some(running)).await;
    }
    let flapping = rows(&f, DEVICE).await;
    let alternate: Vec<&str> = (0..bound + 2)
        .map(|i| {
            if i % 2 == 0 {
                "verified_applied"
            } else {
                "failed"
            }
        })
        .collect();
    assert_eq!(
        flapping, alternate,
        "the first row of each of the two states, then the usual limit"
    );
    // The other device is not held back by that.
    beat(&f, OTHER, "unmanaged", 0, None).await;
    beat(&f, OTHER, "verified_applied", 1, Some(1)).await;
    assert_eq!(rows(&f, OTHER).await, ["desired", "verified_applied"]);
    assert_eq!(rows(&f, DEVICE).await.len(), bound + 2);
}

// A row shares its second with the release that follows it, or with the one
// before it: by the audit log's own order it belongs to the deployment it
// came after, and a target recorded before releases left a row falls back to
// the times.
#[tokio::test]
async fn a_timeline_starts_after_its_own_release_not_in_its_second() {
    let f = fixture().await;
    let first = deploy(&f, 1, &[DEVICE]).await;
    for state in ["desired", "verified_applied"] {
        db::audit(
            &mut f.s.pool.acquire().await.unwrap(),
            DEVICE,
            "device.apply_state",
            DEVICE,
            state,
        )
        .await
        .unwrap();
    }
    let second = deploy(&f, 2, &[DEVICE]).await;
    for state in ["desired", "downloaded"] {
        db::audit(
            &mut f.s.pool.acquire().await.unwrap(),
            DEVICE,
            "device.apply_state",
            DEVICE,
            state,
        )
        .await
        .unwrap();
    }
    assert_eq!(
        timeline(&f, &first, DEVICE).await,
        ["desired", "verified_applied"]
    );
    assert_eq!(
        timeline(&f, &second, DEVICE).await,
        ["desired", "downloaded"]
    );
    // An older target, with no release row, is read by time as before: its
    // window starts at its release, so it includes the rows of that second.
    // The row is removed from this scratch database by lifting its guard.
    sqlx::query("DROP TRIGGER append_only_audit")
        .execute(&f.s.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM records WHERE kind='audit' AND json_extract(data,'$.action')='deployment.release' AND json_extract(data,'$.target') LIKE ?")
        .bind(format!("{second}:%"))
        .execute(&f.s.pool)
        .await
        .unwrap();
    let by_time = timeline(&f, &second, DEVICE).await;
    assert_eq!(by_time.last().map(String::as_str), Some("downloaded"));
}
