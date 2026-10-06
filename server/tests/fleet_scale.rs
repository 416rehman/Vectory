//! Reads that must not grow with the fleet. Work is counted in SQL statements
//! and rows (sqlx's statement events), which a busy machine can't blur the
//! way it blurs wall time. The same device shapes are seeded at 1, 20 and
//! 2,000 devices; the rows are synthetic test data, about 7 KB each like a
//! reporting device with ten components. This file holds a single test: the
//! counting subscriber is process-wide.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use tower::ServiceExt;
use tracing_subscriber::layer::SubscriberExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

static STATEMENTS: AtomicU64 = AtomicU64::new(0);
static ROWS: AtomicU64 = AtomicU64::new(0);

struct Statements;
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Statements {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" {
            return;
        }
        struct Rows {
            returned: u64,
            connection_setup: bool,
        }
        impl Rows {
            // A pool that opens a new connection during a measured read runs
            // its PRAGMA batch first; that is the pool's work, not the read's.
            fn note_statement(&mut self, text: &str) {
                if text.trim_start().to_ascii_uppercase().starts_with("PRAGMA") {
                    self.connection_setup = true;
                }
            }
        }
        impl tracing::field::Visit for Rows {
            fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
                if field.name() == "rows_returned" {
                    self.returned = value;
                }
            }
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if matches!(field.name(), "summary" | "db.statement") {
                    self.note_statement(value);
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if matches!(field.name(), "summary" | "db.statement") {
                    self.note_statement(&format!("{value:?}").trim_matches('"').to_owned());
                }
            }
        }
        let mut rows = Rows {
            returned: 0,
            connection_setup: false,
        };
        event.record(&mut rows);
        if rows.connection_setup {
            return;
        }
        STATEMENTS.fetch_add(1, Ordering::SeqCst);
        ROWS.fetch_add(rows.returned, Ordering::SeqCst);
    }
}

#[derive(Debug, PartialEq, Clone, Copy)]
struct Work {
    statements: u64,
    rows: u64,
}
struct Fleet {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    cookie: String,
    probe: String,
    group: String,
}
impl Fleet {
    async fn read(&self, uri: &str) -> (Work, usize) {
        let (statements, rows) = (
            STATEMENTS.load(Ordering::SeqCst),
            ROWS.load(Ordering::SeqCst),
        );
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("cookie", &self.cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            Work {
                statements: STATEMENTS.load(Ordering::SeqCst) - statements,
                rows: ROWS.load(Ordering::SeqCst) - rows,
            },
            bytes.len(),
        )
    }
}

/// A reporting device's latest sample: ten components, like the review probe.
fn telemetry(rate: f64) -> Value {
    let components: Vec<Value> = (0..10)
        .map(|n| {
            json!({"id":format!("component_{n}"),"type":if n < 3 {"demo_logs"} else if n < 7 {"remap"} else {"http"},"kind":if n < 3 {"source"} else if n < 7 {"transform"} else {"sink"},
                "events_per_second":rate,"received_events_per_second":rate,"received_bytes_per_second":rate * 200.0,"sent_bytes_per_second":rate * 180.0,
                "errors":0,"errors_per_minute":0.0,"discarded_events":0,"discarded_intentional":0,"discarded_error":0,"filtered_per_minute":0.0,"dropped_per_minute":0.0,
                "buffer_events":0,"buffer_bytes":0,"buffer_utilization":0.01,"utilization":0.2,"outputs":{"_default":rate}})
        })
        .collect();
    json!({"sampled_at":db::now(),"events_per_second":rate,"events_out_per_second":rate,"bytes_in_per_second":rate * 200.0,"bytes_out_per_second":rate * 180.0,
        "errors":0,"errors_per_minute":0.0,"uptime_seconds":86400,"memory_bytes":104857600,"cpu_seconds":1200.5,"components":components})
}
fn logs() -> Value {
    let items: Vec<Value> = (0..5)
        .map(|n| json!({"fingerprint":format!("{n:016x}"),"level":"warn","component_id":format!("component_{n}"),"component_kind":"sink","component_type":"http",
            "error_type":"request_failed","stage":"sending","reason":"timeout","count":n + 1,"first_seen":db::now(),"last_seen":db::now(),
            "message":"Service call failed. No retries or retries exhausted. ".repeat(4)}))
        .collect();
    json!({"reported_at":db::now(),"items":items})
}
const SHA1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const SHA2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

/// `count` devices cycling through the same ten shapes, twenty-five groups of
/// mixed sizes, two pipelines and two rollouts, one of them a canary.
async fn fleet(count: usize) -> Fleet {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-fleet-scale-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Fleet scale".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let user = db::id();
    let token = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,'Reader','viewer','unused',?)",
    )
    .bind(&user)
    .bind(format!("{user}@example.test"))
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,'2099-01-01T00:00:00Z')")
        .bind(db::hash(&token))
        .bind(&user)
        .bind(auth::random_secret())
        .execute(&s.pool)
        .await
        .unwrap();
    let mut tx = s.pool.begin().await.unwrap();
    let (syslog, web, v1, v2, all, canary) = (
        "pipeline-syslog",
        "pipeline-web",
        "version-1",
        "version-2",
        "rollout-all",
        "rollout-canary",
    );
    for (kind, value) in [
        (
            "configuration",
            json!({"id":syslog,"name":"Edge syslog","description":"","config":{},"graph":{"nodes":[],"edges":[]}}),
        ),
        (
            "configuration",
            json!({"id":web,"name":"Web access","description":"","config":{},"graph":{"nodes":[],"edges":[]}}),
        ),
        (
            "version",
            json!({"id":v1,"configuration_id":syslog,"number":1,"sha256":SHA1}),
        ),
        (
            "version",
            json!({"id":v2,"configuration_id":web,"number":2,"sha256":SHA2}),
        ),
        (
            "deployment",
            json!({"id":all,"version_id":v1,"status":"active","priority":100,"target_mode":"snapshot","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0}}),
        ),
        (
            "deployment",
            json!({"id":canary,"version_id":v2,"status":"active","priority":200,"target_mode":"snapshot","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"canary","canary_size":1,"batch_size":1,"observation_seconds":600,"failure_threshold":0}}),
        ),
    ] {
        db::insert(&mut tx, kind, &value).await.unwrap();
    }
    let issue = json!({"issue_id":null,"code":"DATA_PLANE_SINK_ERRORS","component_id":"component_9","component_kind":"sink","title":"component_9 can't deliver events","message":"The http sink component_9 is failing about 12 requests a minute.","hint":"Check the destination.","since":db::now()});
    let mut ids = Vec::with_capacity(count);
    for n in 0..count {
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let applied = |version: &str, sha: &str| {
            json!({"last_seen":db::now(),"apply_state":"verified_applied","reported_generation":1,"actual_sha256":sha,
                "verified_configuration_attempt":{"version_id":version,"generation":1,"sha256":sha}})
        };
        let (mut data, desired, assignment, target, revoked, paused) = match n % 10 {
            0 => (
                applied(v1, SHA1),
                Some(v1),
                Some(all),
                Some((all, "verified_applied", 1)),
                false,
                false,
            ),
            1 => {
                let mut data = applied(v1, SHA1);
                data["data_plane"] = json!({"version_id":v1,"evaluations":3,"issues":[issue]});
                (
                    data,
                    Some(v1),
                    Some(all),
                    Some((all, "verified_applied", 1)),
                    false,
                    false,
                )
            }
            2 => (
                json!({"last_seen":db::now(),"apply_state":"failed","reported_generation":0,"configuration_attempt":{"generation":1,"version_id":v1,"sha256":SHA1,"state":"failed",
                "error":{"code":"VALIDATION_FAILED","stage":"validation","message":"data_dir \"/var/lib/vector\" does not exist"}}}),
                Some(v1),
                None,
                None,
                false,
                false,
            ),
            3 => {
                let mut data = applied(v1, SHA1);
                data["last_seen"] = json!("2026-01-01T00:00:00Z");
                (data, Some(v1), None, None, false, false)
            }
            4 => (
                json!({"apply_state":"unmanaged","reported_generation":0}),
                None,
                None,
                None,
                false,
                false,
            ),
            5 => (
                json!({"last_seen":db::now(),"apply_state":"downloaded","reported_generation":1}),
                Some(v1),
                Some(all),
                Some((all, "desired", 1)),
                false,
                false,
            ),
            6 => (
                json!({"last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0}),
                None,
                None,
                None,
                false,
                true,
            ),
            7 => (
                json!({"last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0}),
                None,
                None,
                None,
                false,
                false,
            ),
            8 => (
                applied(v2, SHA2),
                Some(v2),
                Some(canary),
                Some((canary, "verified_applied", 1)),
                false,
                false,
            ),
            _ => (applied(v1, SHA1), Some(v1), None, None, true, false),
        };
        let name = format!("device-{n:05}");
        for (key, value) in [
            ("id", json!(id)),
            ("name", json!(name)),
            ("os", json!("linux")),
            ("arch", json!(if n % 2 == 0 { "amd64" } else { "arm64" })),
            ("vector_version", json!("0.58.0")),
            ("agent_version", json!("1.4.0")),
            ("labels", json!({})),
            ("created_at", json!(db::now())),
            (
                "host_runtime",
                json!({"data_dir":"/var/lib/vector","data_dir_source":"pipeline","graceful_shutdown_seconds":60,"metrics_source":"explicit","metrics_address":"127.0.0.1:9598","activation":"reload"}),
            ),
            ("vector_log_summary", logs()),
            ("telemetry", telemetry(1.0 + (n % 7) as f64)),
        ] {
            if data.get(key).is_none() {
                data[key] = value;
            }
        }
        sqlx::query("INSERT INTO devices(id,name,data,desired_version_id,desired_generation,assignment_id,policy,revoked) VALUES(?,?,?,?,?,?,?,?)")
            .bind(&id)
            .bind(&name)
            .bind(data.to_string())
            .bind(desired)
            .bind(if desired.is_some() { 1 } else { 0 })
            .bind(assignment)
            .bind(json!({"heartbeat_seconds":60,"sync_paused":paused,"telemetry_enabled":true}).to_string())
            .bind(revoked)
            .execute(&mut *tx)
            .await
            .unwrap();
        if let Some((deployment, state, generation)) = target {
            sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,released_at) VALUES(?,?,?,?,'2026-01-01T00:00:00Z')")
                .bind(deployment)
                .bind(&id)
                .bind(state)
                .bind(generation)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        if !revoked {
            ids.push(id);
        }
    }
    let mut group = String::new();
    for g in 0..25 {
        let members: Vec<&String> = match g {
            0 => ids.iter().collect(),
            1..=12 => ids.iter().skip(g).step_by(12).collect(),
            _ => ids.iter().skip(g % 5).take(3).collect(),
        };
        let id = format!("10000000-0000-4000-8000-{g:012}");
        db::insert(&mut tx, "group", &json!({"id":id,"name":format!("Group {g}"),"description":"","device_ids":members,"created_at":db::now(),"revision":1})).await.unwrap();
        if g == 0 {
            group = id;
        }
    }
    tx.commit().await.unwrap();
    Fleet {
        _temp: temp,
        app: api::router(s.clone()),
        s,
        cookie: format!("vectory_session={token}"),
        probe: "00000000-0000-4000-8000-000000000000".into(),
        group,
    }
}

#[tokio::test]
async fn fleet_reads_do_not_grow_with_the_fleet() {
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(Statements))
        .unwrap();
    let (one, small, large) = (fleet(1).await, fleet(20).await, fleet(2000).await);

    // A device page reads that device, whatever the size of the fleet.
    let detail = format!("/api/v1/devices/{}", one.probe);
    let (lookup_one, bytes) = one.read(&detail).await;
    let (lookup_large, large_bytes) = large.read(&detail).await;
    eprintln!("GET /devices/{{id}}: 1 device {lookup_one:?}; 2,000 devices {lookup_large:?}");
    assert_eq!(lookup_one, lookup_large, "the device page reads one device");
    assert_eq!(bytes, large_bytes);

    for fleet in [&small, &large] {
        fleet.s.fleet.set_ttl(std::time::Duration::from_secs(600));
    }
    let page = "/api/v1/devices/inventory?page_size=10";
    let search = "/api/v1/devices/inventory?page_size=10&q=device-0";
    let slim = "/api/v1/overview?slim=1";
    let members = format!("/api/v1/groups/{}/members?page_size=10", large.group);
    let mut cold = Vec::new();
    for fleet in [&small, &large] {
        fleet.s.fleet.invalidate();
        cold.push(fleet.read(page).await.0);
    }
    eprintln!(
        "inventory, projection built: 20 devices {:?}; 2,000 devices {:?}",
        cold[0], cold[1]
    );
    // Building the projection reads each device once: statements don't
    // depend on the fleet, rows are about one per device (plus devices
    // stuck applying and a sample of a canary's released devices).
    assert_eq!(
        cold[0].statements, cold[1].statements,
        "no statement per device"
    );
    assert!(cold[1].rows <= 2 * 2000 + 400, "{:?}", cold[1]);
    for uri in [page, search, slim, members.as_str()] {
        let (small_work, _) = small.read(&uri.replace(&large.group, &small.group)).await;
        let (large_work, bytes) = large.read(uri).await;
        eprintln!(
            "{uri} from the shared projection: 20 devices {small_work:?}; 2,000 devices {large_work:?}, {bytes} bytes"
        );
        assert_eq!(small_work, large_work, "{uri}");
        assert!(large_work.statements <= 16, "{uri}: {large_work:?}");
        assert!(large_work.rows <= 120, "{uri}: {large_work:?}");
    }
    // What the dashboard read before: the whole fleet on every poll.
    for uri in ["/api/v1/devices", "/api/v1/overview"] {
        let (work, bytes) = large.read(uri).await;
        eprintln!("{uri} at 2,000 devices: {work:?}, {bytes} bytes");
    }
}
