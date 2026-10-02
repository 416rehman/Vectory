//! The fleet-scale reads: the paged device inventory and its ids, group
//! members, the slim Overview with its fleet numbers and what runs where, the
//! direct device lookup, and the shared projection behind them. The fleet
//! here is small and hand-made so every number can be stated exactly.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize, rollout};

const SHA1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const SHA2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

struct Actor {
    cookie: String,
    csrf: String,
}
async fn actor(s: &State, role: &str) -> Actor {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Fleet {role}"))
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
    Actor {
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
    actor: Option<&Actor>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(actor) = actor {
        request = request
            .header("cookie", &actor.cookie)
            .header("x-csrf-token", &actor.csrf);
    }
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn get(app: &Router, actor: &Actor, uri: &str) -> Value {
    let (status, value) = call(app, "GET", uri, None, Some(actor)).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {value}");
    value
}
async fn refused(app: &Router, actor: &Actor, uri: &str) -> Value {
    let (status, value) = call(app, "GET", uri, None, Some(actor)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {value}");
    assert_eq!(value["error"]["code"], "INVALID_INPUT", "{uri}");
    value
}

struct Fleet {
    _temp: tempfile::TempDir,
    s: State,
    app: Router,
    admin: Actor,
    /// Device IDs by name.
    ids: std::collections::BTreeMap<&'static str, String>,
    v1: String,
    v2: String,
    groups: std::collections::BTreeMap<&'static str, String>,
    rollout: String,
    canary: String,
}
impl Fleet {
    fn id(&self, name: &str) -> &str {
        &self.ids[name]
    }
    fn names(&self, rows: &Value) -> Vec<String> {
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| row["name"].as_str().unwrap().to_owned())
            .collect()
    }
}

/// A verified device running `version`, reporting a fresh sample.
fn applied(version: &str, sha: &str, rate: f64) -> Value {
    json!({"last_seen":db::now(),"apply_state":"verified_applied","reported_generation":1,"actual_sha256":sha,
        "verified_configuration_attempt":{"version_id":version,"generation":1,"sha256":sha},
        "os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"1.4.0",
        "telemetry":{"sampled_at":db::now(),"events_per_second":rate,"events_out_per_second":rate / 2.0,"errors":1,"errors_per_minute":0.5,
            "components":[{"id":"out","kind":"sink","type":"http","events_per_second":rate}]},
        "vector_log_summary":{"reported_at":db::now(),"items":[]},
        "host_runtime":{"data_dir":"/var/lib/vector","data_dir_source":"pipeline","graceful_shutdown_seconds":60,"metrics_source":"explicit","activation":"reload"}})
}
fn merged(mut base: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().unwrap() {
        base[key] = value.clone();
    }
    base
}
#[allow(clippy::too_many_arguments)]
async fn insert(
    s: &State,
    name: &str,
    data: Value,
    desired: Option<&str>,
    assignment: Option<&str>,
    paused: bool,
    revoked: bool,
) -> String {
    let id = db::id();
    let mut data = data;
    data["id"] = json!(id);
    data["name"] = json!(name);
    data["created_at"] = json!(db::now());
    sqlx::query("INSERT INTO devices(id,name,data,desired_version_id,desired_generation,assignment_id,policy,revoked) VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(data.to_string())
        .bind(desired)
        .bind(if desired.is_some() { 1 } else { 0 })
        .bind(assignment)
        .bind(json!({"heartbeat_seconds":60,"sync_paused":paused,"telemetry_enabled":true}).to_string())
        .bind(revoked)
        .execute(&s.pool)
        .await
        .unwrap();
    id
}
async fn record(s: &State, kind: &str, value: Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, kind, &value).await.unwrap();
}
async fn target(s: &State, deployment: &str, device: &str, state: &str, generation: i64) {
    sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,released_at) VALUES(?,?,?,?,?)")
        .bind(deployment)
        .bind(device)
        .bind(state)
        .bind(generation)
        .bind((generation > 0).then(db::now))
        .execute(&s.pool)
        .await
        .unwrap();
}

/// Two pipelines on different devices, one device not delivering, a canary
/// in progress, and every other state a device can be in.
async fn fleet() -> Fleet {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-fleet-inventory-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Fleet inventory".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = actor(&s, "admin").await;
    let (syslog, web, v1, v2) = (db::id(), db::id(), db::id(), db::id());
    let (rollout, canary) = (db::id(), db::id());
    record(&s, "configuration", json!({"id":syslog,"name":"Edge syslog","description":"","config":{},"graph":{"nodes":[],"edges":[]}})).await;
    record(&s, "configuration", json!({"id":web,"name":"Web access","description":"","config":{},"graph":{"nodes":[],"edges":[]}})).await;
    record(
        &s,
        "version",
        json!({"id":v1,"configuration_id":syslog,"number":1,"sha256":SHA1}),
    )
    .await;
    record(
        &s,
        "version",
        json!({"id":v2,"configuration_id":web,"number":2,"sha256":SHA2}),
    )
    .await;
    let rollout_all = json!({"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":0,"failure_threshold":0});
    record(&s, "deployment", json!({"id":rollout,"version_id":v1,"status":"active","priority":100,"target_mode":"snapshot","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"rollout":rollout_all,"created_at":"2026-09-29T00:00:00Z"})).await;
    record(&s, "deployment", json!({"id":canary,"version_id":v2,"status":"active","priority":200,"target_mode":"snapshot","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"canary","canary_size":1,"batch_size":1,"observation_seconds":600,"failure_threshold":0},"created_at":"2026-09-29T00:01:00Z"})).await;
    let issue = json!({"issue_id":null,"code":"DATA_PLANE_SINK_ERRORS","component_id":"out","component_kind":"sink","title":"out can't deliver events","message":"The http sink out is failing about 12 requests a minute.","hint":"Check the destination.","since":"2026-09-29T00:00:00Z"});
    let mut ids = std::collections::BTreeMap::new();
    let mut add = async |name: &'static str,
                         data: Value,
                         desired: Option<&str>,
                         assignment: Option<&str>,
                         paused: bool,
                         revoked: bool| {
        let id = insert(&s, name, data, desired, assignment, paused, revoked).await;
        ids.insert(name, id.clone());
        id
    };
    // Edge syslog v1 runs on four devices; one of them isn't delivering.
    let edge1 = add(
        "edge-1",
        applied(&v1, SHA1, 10.0),
        Some(&v1),
        Some(&rollout),
        false,
        false,
    )
    .await;
    let edge2 = add(
        "edge-2",
        applied(&v1, SHA1, 30.0),
        Some(&v1),
        Some(&rollout),
        false,
        false,
    )
    .await;
    let edge10 = add(
        "edge-10",
        applied(&v1, SHA1, 20.0),
        Some(&v1),
        Some(&rollout),
        false,
        false,
    )
    .await;
    let degraded = add("Edge-3", merged(applied(&v1, SHA1, 40.0), json!({"data_plane":{"version_id":v1,"evaluations":3,"issues":[issue.clone(),issue.clone()]}})), Some(&v1), Some(&rollout), false, false).await;
    // Web access v2: a canary released to web-1, web-2 waits; web-3 runs it
    // from before, without a fresh sample.
    let web1 = add(
        "web-1",
        applied(&v2, SHA2, 5.0),
        Some(&v2),
        Some(&canary),
        false,
        false,
    )
    .await;
    let web2 = add(
        "web-2",
        merged(applied(&v1, SHA1, 1.0), json!({"telemetry":null})),
        Some(&v1),
        Some(&rollout),
        false,
        false,
    )
    .await;
    add(
        "web-3",
        merged(
            applied(&v2, SHA2, 0.0),
            json!({"telemetry":{"sampled_at":"2026-01-01T00:00:00Z","events_per_second":9.0}}),
        ),
        Some(&v2),
        None,
        false,
        false,
    )
    .await;
    // Everything else a device can be.
    add("db-failed", json!({"last_seen":db::now(),"apply_state":"failed","reported_generation":0,"os":"linux","arch":"arm64","vector_version":"0.57.1",
        "configuration_attempt":{"generation":1,"version_id":v1,"sha256":SHA1,"state":"failed","error":{"code":"VALIDATION_FAILED","stage":"validation","message":"data_dir \"/var/lib/vector\" does not exist"}}}), Some(&v1), None, false, false).await;
    add(
        "db-rolled",
        json!({"last_seen":db::now(),"apply_state":"rolled_back","reported_generation":1}),
        Some(&v1),
        None,
        false,
        false,
    )
    .await;
    add(
        "db-check",
        json!({"last_seen":db::now(),"apply_state":"verification_unknown","reported_generation":1}),
        Some(&v1),
        None,
        false,
        false,
    )
    .await;
    add(
        "db-applying",
        json!({"last_seen":db::now(),"apply_state":"downloaded","reported_generation":1}),
        Some(&v1),
        None,
        false,
        false,
    )
    .await;
    add("lost-1", json!({"last_seen":"2026-01-01T00:00:00Z","apply_state":"verified_applied","reported_generation":1,"actual_sha256":SHA1}), Some(&v1), None, false, false).await;
    add(
        "new-1",
        json!({"apply_state":"unmanaged","reported_generation":0}),
        None,
        None,
        false,
        false,
    )
    .await;
    add(
        "paused-1",
        json!({"last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0}),
        None,
        None,
        true,
        false,
    )
    .await;
    add("spare-1", json!({"last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"vector_version":"0.58.0","os":"windows","arch":"amd64"}), None, None, false, false).await;
    // Revoked: it still reports v1, which must never count.
    add(
        "retired-1",
        applied(&v1, SHA1, 99.0),
        Some(&v1),
        None,
        false,
        true,
    )
    .await;
    for device in [&edge1, &edge2, &edge10, &degraded, &web2] {
        target(&s, &rollout, device, "verified_applied", 1).await;
    }
    target(&s, &canary, &web1, "verified_applied", 1).await;
    target(&s, &canary, &web2, "pending", 0).await;
    let mut groups = std::collections::BTreeMap::new();
    for (name, members) in [
        ("Edge collectors", vec![&edge1, &edge2, &edge10, &degraded]),
        ("Web tier", vec![&web1, &web2, &ids["web-3"]]),
        (
            "Databases 100%_",
            vec![&ids["db-failed"], &ids["db-rolled"]],
        ),
        ("Everything", ids.values().collect::<Vec<_>>()),
        ("Empty", vec![]),
    ] {
        let id = db::id();
        let mut members: Vec<&String> = members;
        members.sort();
        record(&s, "group", json!({"id":id,"name":name,"description":"","device_ids":members,"created_at":db::now(),"revision":1})).await;
        groups.insert(name, id);
    }
    Fleet {
        _temp: temp,
        app: api::router(s.clone()),
        s,
        admin,
        ids,
        v1,
        v2,
        groups,
        rollout,
        canary,
    }
}

#[tokio::test]
async fn inventory_pages_filters_sorts_and_counts_like_the_devices_page() {
    let f = fleet().await;
    let page = get(&f.app, &f.admin, "/api/v1/devices/inventory").await;
    // Revoked devices stay out; names sort naturally and ignore case.
    assert_eq!(page["total"], 15);
    assert_eq!(
        (page["page"].as_u64(), page["page_size"].as_u64()),
        (Some(1), Some(50))
    );
    assert_eq!(
        f.names(&page["items"]),
        [
            "db-applying",
            "db-check",
            "db-failed",
            "db-rolled",
            "edge-1",
            "edge-2",
            "Edge-3",
            "edge-10",
            "lost-1",
            "new-1",
            "paused-1",
            "spare-1",
            "web-1",
            "web-2",
            "web-3"
        ]
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()[..],
        "{page}"
    );
    assert_eq!(
        page["counts"],
        json!({"status":{"applied":6,"degraded":1,"held":0,"updating":1,"check":1,"failed":2,"offline":2,"paused":1,"unmanaged":1,"revoked":1},
            "views":{"failing":4,"not_on_desired":4,"offline":2,"paused":1,"no_telemetry":10}})
    );
    // A page row is exactly the row GET /devices shows.
    let listed = get(&f.app, &f.admin, "/api/v1/devices").await;
    for row in page["items"].as_array().unwrap() {
        let same = listed
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["id"] == row["id"])
            .unwrap();
        assert_eq!(row, same);
        assert!(row["telemetry"].get("components").is_none() || row["telemetry"].is_null());
    }
    let edge3 = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["name"] == "Edge-3")
        .unwrap();
    assert_eq!(edge3["data_plane"]["issues"].as_array().unwrap().len(), 1);
    assert_eq!(edge3["data_plane"]["issue_count"], 2);
    // Each row's groups, by name.
    let groups = &page["device_groups"][f.id("edge-1")];
    assert_eq!(groups["total"], 2);
    assert_eq!(groups["items"][0]["name"], "Edge collectors");
    assert_eq!(groups["items"][1]["name"], "Everything");
    assert_eq!(page["device_groups"][f.id("new-1")]["total"], 1);

    // Search is literal and covers name, platform, versions, pipeline and groups.
    let search = |q: &str| format!("/api/v1/devices/inventory?q={q}");
    for (q, expected) in [
        ("EDGE-1", vec!["edge-1", "edge-10"]),
        ("arm64", vec!["db-failed"]),
        ("0.57", vec!["db-failed"]),
        ("windows%20amd64", vec!["spare-1"]),
        ("web%20access%20v2", vec!["web-1", "web-3"]),
        ("web%20tier", vec!["web-1", "web-2", "web-3"]),
        ("100%25_", vec!["db-failed", "db-rolled"]),
        ("%25", vec!["db-failed", "db-rolled"]),
        ("_", vec!["db-failed", "db-rolled"]),
        ("e%25g", vec![]),
    ] {
        let page = get(&f.app, &f.admin, &search(q)).await;
        assert_eq!(f.names(&page["items"]), expected, "q={q}");
        assert_eq!(page["total"], expected.len(), "q={q}");
    }
    // Counts follow the search, not the chip being looked at.
    let db = get(
        &f.app,
        &f.admin,
        "/api/v1/devices/inventory?q=db&status=failed",
    )
    .await;
    assert_eq!(f.names(&db["items"]), ["db-failed", "db-rolled"]);
    assert_eq!(db["total"], 2);
    assert_eq!(
        db["counts"]["status"],
        json!({"applied":0,"degraded":0,"held":0,"updating":1,"check":1,"failed":2,"offline":0,"paused":0,"unmanaged":0,"revoked":0})
    );
    assert_eq!(db["counts"]["views"]["failing"], 3);

    for (filter, expected) in [
        ("status=degraded", vec!["Edge-3"]),
        ("status=failed", vec!["db-failed", "db-rolled"]),
        ("status=offline", vec!["lost-1", "new-1"]),
        ("status=paused", vec!["paused-1"]),
        ("status=revoked", vec!["retired-1"]),
        (
            "view=failing",
            vec!["db-check", "db-failed", "db-rolled", "Edge-3"],
        ),
        ("view=offline", vec!["lost-1", "new-1"]),
        ("view=paused", vec!["paused-1"]),
        (
            "view=not_on_desired",
            vec!["db-applying", "db-check", "db-failed", "db-rolled"],
        ),
        ("version=0.57.1", vec!["db-failed"]),
        ("status=applied&view=no_telemetry", vec!["web-2", "web-3"]),
    ] {
        let page = get(
            &f.app,
            &f.admin,
            &format!("/api/v1/devices/inventory?{filter}"),
        )
        .await;
        assert_eq!(f.names(&page["items"]), expected, "{filter}");
    }
    let edge = get(
        &f.app,
        &f.admin,
        &format!(
            "/api/v1/devices/inventory?group={}",
            f.groups["Edge collectors"]
        ),
    )
    .await;
    assert_eq!(
        f.names(&edge["items"]),
        ["edge-1", "edge-2", "Edge-3", "edge-10"]
    );
    assert_eq!(edge["counts"]["status"]["applied"], 3);
    let unknown = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/inventory?group={}", db::id()),
    )
    .await;
    assert_eq!(unknown["total"], 0);
    let desired = get(
        &f.app,
        &f.admin,
        &format!(
            "/api/v1/devices/inventory?desired_version={}&status=applied",
            f.v2
        ),
    )
    .await;
    assert_eq!(f.names(&desired["items"]), ["web-1", "web-3"]);
    let running = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/inventory?running_version={}", f.v1),
    )
    .await;
    assert_eq!(
        f.names(&running["items"]),
        ["edge-1", "edge-2", "Edge-3", "edge-10", "web-2"]
    );

    // Sorts are total: missing values last in both directions, then name, then ID.
    for (sort, expected) in [
        (
            "sort=status",
            vec![
                "db-failed",
                "db-rolled",
                "Edge-3",
                "db-check",
                "lost-1",
                "new-1",
                "db-applying",
                "paused-1",
                "spare-1",
                "edge-1",
                "edge-2",
                "edge-10",
                "web-1",
                "web-2",
                "web-3",
            ],
        ),
        (
            "sort=events_in",
            vec![
                "Edge-3",
                "edge-2",
                "edge-10",
                "edge-1",
                "web-1",
                "db-applying",
                "db-check",
                "db-failed",
                "db-rolled",
                "lost-1",
                "new-1",
                "paused-1",
                "spare-1",
                "web-2",
                "web-3",
            ],
        ),
        (
            "sort=events_in&dir=asc",
            vec![
                "web-1",
                "edge-1",
                "edge-10",
                "edge-2",
                "Edge-3",
                "db-applying",
                "db-check",
                "db-failed",
                "db-rolled",
                "lost-1",
                "new-1",
                "paused-1",
                "spare-1",
                "web-2",
                "web-3",
            ],
        ),
        (
            "sort=pipeline&dir=desc",
            vec![
                "web-1",
                "web-3",
                "db-applying",
                "db-check",
                "db-failed",
                "db-rolled",
                "edge-1",
                "edge-2",
                "Edge-3",
                "edge-10",
                "lost-1",
                "web-2",
                "new-1",
                "paused-1",
                "spare-1",
            ],
        ),
        (
            "sort=version",
            vec![
                "db-failed",
                "edge-1",
                "edge-2",
                "Edge-3",
                "edge-10",
                "spare-1",
                "web-1",
                "web-2",
                "web-3",
                "db-applying",
                "db-check",
                "db-rolled",
                "lost-1",
                "new-1",
                "paused-1",
            ],
        ),
        (
            "sort=name&dir=desc",
            vec![
                "web-3",
                "web-2",
                "web-1",
                "spare-1",
                "paused-1",
                "new-1",
                "lost-1",
                "edge-10",
                "Edge-3",
                "edge-2",
                "edge-1",
                "db-rolled",
                "db-failed",
                "db-check",
                "db-applying",
            ],
        ),
    ] {
        let page = get(
            &f.app,
            &f.admin,
            &format!("/api/v1/devices/inventory?{sort}"),
        )
        .await;
        assert_eq!(f.names(&page["items"]), expected, "{sort}");
    }
    let seen = get(&f.app, &f.admin, "/api/v1/devices/inventory?sort=last_seen").await;
    let names = f.names(&seen["items"]);
    assert_eq!(
        names[names.len() - 2..],
        ["lost-1", "new-1"],
        "oldest, then never"
    );

    // Pages never skip or repeat a row.
    let mut paged = Vec::new();
    for page in 1..=6 {
        let rows = get(
            &f.app,
            &f.admin,
            &format!("/api/v1/devices/inventory?sort=status&page_size=3&page={page}"),
        )
        .await;
        assert_eq!(rows["total"], 15);
        paged.extend(f.names(&rows["items"]));
    }
    let whole = get(
        &f.app,
        &f.admin,
        "/api/v1/devices/inventory?sort=status&page_size=100",
    )
    .await;
    assert_eq!(paged, f.names(&whole["items"]));
    assert_eq!(paged.len(), 15);

    // Ids for "select all matching" follow the same filters and order.
    let ids = get(
        &f.app,
        &f.admin,
        "/api/v1/devices/inventory/ids?view=failing&sort=name",
    )
    .await;
    assert_eq!(ids["total"], 4);
    assert_eq!(ids["truncated"], false);
    assert_eq!(ids["ids"][0], f.id("db-check"));
    assert_eq!(ids["ids"][3], f.id("Edge-3"));
}

#[tokio::test]
async fn inventory_parameters_fail_closed_and_need_a_session() {
    let f = fleet().await;
    for uri in [
        "/api/v1/devices/inventory?pages=2",
        "/api/v1/devices/inventory?page=1&page=2",
        "/api/v1/devices/inventory?q=a&q=b",
        "/api/v1/devices/inventory?page=0",
        "/api/v1/devices/inventory?page_size=101",
        "/api/v1/devices/inventory?page_size=0",
        "/api/v1/devices/inventory?status=verified",
        "/api/v1/devices/inventory?view=drift",
        "/api/v1/devices/inventory?sort=name%3BDROP%20TABLE%20devices",
        "/api/v1/devices/inventory?dir=sideways",
        "/api/v1/devices/inventory?group=Everything",
        "/api/v1/devices/inventory?q=%zz",
        "/api/v1/devices/inventory/ids?page=1",
        "/api/v1/devices/inventory/ids?status=verified",
        "/api/v1/groups/00000000-0000-4000-8000-000000000001/members?sort=name",
    ] {
        refused(&f.app, &f.admin, uri).await;
    }
    let long = format!("/api/v1/devices/inventory?q={}", "x".repeat(101));
    refused(&f.app, &f.admin, &long).await;
    get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/inventory?q={}", "x".repeat(100)),
    )
    .await;
    // Empty filters are no filter.
    let empty = get(
        &f.app,
        &f.admin,
        "/api/v1/devices/inventory?q=&status=&view=&group=&sort=&dir=",
    )
    .await;
    assert_eq!(empty["total"], 15);
    for uri in [
        "/api/v1/devices/inventory",
        "/api/v1/devices/inventory/ids",
        "/api/v1/groups/00000000-0000-4000-8000-000000000001/members",
        "/api/v1/overview?slim=1",
    ] {
        let (status, _) = call(&f.app, "GET", uri, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let viewer = actor(&f.s, "viewer").await;
    get(&f.app, &viewer, "/api/v1/devices/inventory").await;
    get(&f.app, &viewer, "/api/v1/devices/inventory/ids").await;
    get(
        &f.app,
        &viewer,
        &format!("/api/v1/groups/{}/members", f.groups["Web tier"]),
    )
    .await;
    get(&f.app, &viewer, "/api/v1/overview?slim=1").await;
}

#[tokio::test]
async fn groups_carry_member_counts_and_members_page_by_name() {
    let f = fleet().await;
    let full = get(&f.app, &f.admin, "/api/v1/groups").await;
    let explicit = get(&f.app, &f.admin, "/api/v1/groups?include=members").await;
    let slim = get(&f.app, &f.admin, "/api/v1/groups?slim=1").await;
    assert_eq!(full, explicit);
    assert_eq!(full.as_array().unwrap().len(), 5);
    for (group, summary) in full
        .as_array()
        .unwrap()
        .iter()
        .zip(slim.as_array().unwrap())
    {
        assert_eq!(
            group["member_count"],
            group["device_ids"].as_array().unwrap().len()
        );
        assert!(summary.get("device_ids").is_none(), "{summary}");
        let mut without = group.clone();
        without.as_object_mut().unwrap().remove("device_ids");
        assert_eq!(&without, summary);
    }
    // Other parameters stay ignored, as before; the new ones are checked.
    assert_eq!(get(&f.app, &f.admin, "/api/v1/groups?cache=1").await, full);
    for uri in [
        "/api/v1/groups?slim=2",
        "/api/v1/groups?slim=1&slim=1",
        "/api/v1/groups?include=everything",
        "/api/v1/groups?slim=1&include=members",
        "/api/v1/overview?slim=yes",
    ] {
        refused(&f.app, &f.admin, uri).await;
    }

    let everything = &f.groups["Everything"];
    // Everything was written straight to storage, so it still holds the
    // revoked device, which shows as such.
    let page = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{everything}/members?page_size=4"),
    )
    .await;
    assert_eq!(page["total"], 16);
    assert_eq!(
        page["items"],
        json!([{"id":f.id("db-applying"),"name":"db-applying","status":"applying"},{"id":f.id("db-check"),"name":"db-check","status":"verification_unknown"},
            {"id":f.id("db-failed"),"name":"db-failed","status":"failed"},{"id":f.id("db-rolled"),"name":"db-rolled","status":"rolled_back"}])
    );
    let second = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{everything}/members?page_size=4&page=2"),
    )
    .await;
    assert_eq!(
        second["items"][2],
        json!({"id":f.id("Edge-3"),"name":"Edge-3","status":"degraded"})
    );
    let third = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{everything}/members?page_size=4&page=3"),
    )
    .await;
    assert_eq!(
        third["items"][3],
        json!({"id":f.id("retired-1"),"name":"retired-1","status":"revoked"})
    );
    let paused = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{everything}/members?q=paused"),
    )
    .await;
    assert_eq!(
        paused["items"],
        json!([{"id":f.id("paused-1"),"name":"paused-1","status":"pause_requested"}])
    );
    // Members match their own fields, not the group's name.
    assert_eq!(
        get(
            &f.app,
            &f.admin,
            &format!("/api/v1/groups/{everything}/members?q=everything")
        )
        .await["total"],
        0
    );
    let empty = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{}/members", f.groups["Empty"]),
    )
    .await;
    assert_eq!(empty, json!({"items":[],"total":0,"page":1,"page_size":50}));
    let (status, _) = call(
        &f.app,
        "GET",
        &format!("/api/v1/groups/{}/members", db::id()),
        None,
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A membership edit shows at once, with its revision checks unchanged.
    let web = full
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Web tier")
        .unwrap()
        .clone();
    let (status, _) = call(
        &f.app,
        "PUT",
        &format!("/api/v1/groups/{}", web["id"].as_str().unwrap()),
        Some(json!({"name":"Web tier","description":"","device_ids":[f.id("web-1")],"revision":0})),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "stale revision");
    let (status, saved) = call(
        &f.app,
        "PUT",
        &format!("/api/v1/groups/{}", web["id"].as_str().unwrap()),
        Some(json!({"name":"Web tier","description":"","device_ids":[f.id("web-1")],"revision":1})),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let members = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{}/members", web["id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(members["total"], 1);
    let tier = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/inventory?q=web%20tier"),
    )
    .await;
    assert_eq!(f.names(&tier["items"]), ["web-1"]);
    let slim = get(&f.app, &f.admin, "/api/v1/groups?slim=1").await;
    let web = slim
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Web tier")
        .unwrap();
    assert_eq!(
        (web["member_count"].as_u64(), web["revision"].as_u64()),
        (Some(1), Some(2))
    );
}

#[tokio::test]
async fn slim_overview_drops_devices_and_adds_the_fleet_numbers() {
    let f = fleet().await;
    let full = get(&f.app, &f.admin, "/api/v1/overview").await;
    let slim = get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    assert_eq!(full["devices"].as_array().unwrap().len(), 16);
    assert!(slim.get("devices").is_none());
    let mut without = full.clone();
    without.as_object_mut().unwrap().remove("devices");
    assert_eq!(without, slim, "slim is the default without its device list");
    assert_eq!(slim["devices_total"], 16);
    assert_eq!(slim["devices_online"], 13);
    assert_eq!(slim["deployments_active"], 2);

    let counts = &slim["counts"];
    assert_eq!(counts["total"], 15);
    assert_eq!(
        counts["health"],
        json!({"applied":6,"degraded":1,"held":0,"updating":1,"check":1,"failed":2,"offline":2,"paused":1,"unmanaged":1})
    );
    assert_eq!(
        counts["connection"],
        json!({"online":13,"offline":1,"never":1})
    );
    assert_eq!(counts["checked_in"], 14);
    assert_eq!(
        counts["waiting_device"],
        json!({"id":f.id("new-1"),"name":"new-1"})
    );
    let telemetry = &counts["telemetry"];
    assert_eq!(
        (
            telemetry["eligible"].as_u64(),
            telemetry["reporting"].as_u64(),
            telemetry["stale"].as_u64(),
            telemetry["disabled"].as_u64()
        ),
        (Some(15), Some(5), Some(1), Some(0))
    );
    assert_eq!(telemetry["events_in_per_second"], 105.0);
    assert_eq!(telemetry["events_in_devices"], 5);
    assert_eq!(telemetry["events_out_per_second"], 52.5);
    assert_eq!(telemetry["errors"], 5.0);
    assert_eq!(telemetry["errors_per_minute"], 2.5);
    assert!(telemetry["newest_sample_at"].is_string());

    let busiest = slim["busiest"].as_array().unwrap();
    assert_eq!(
        busiest
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Edge-3", "edge-2", "edge-10", "edge-1", "web-1"]
    );
    assert_eq!(
        busiest[0],
        json!({"id":f.id("Edge-3"),"name":"Edge-3","events_in_per_second":40.0,"events_out_per_second":20.0})
    );

    assert_eq!(slim["attention_devices_total"], 5);
    let attention = slim["attention_devices"].as_array().unwrap();
    assert_eq!(
        attention
            .iter()
            .map(|d| (d["name"].as_str().unwrap(), d["cause"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [
            ("Edge-3", "degraded"),
            ("db-failed", "failed"),
            ("db-rolled", "rolled_back"),
            ("db-check", "check_required"),
            ("lost-1", "offline")
        ]
    );
    assert_eq!(attention[0]["title"], "out can't deliver events");
    assert_eq!(attention[0]["fix"], "Check the destination.");
    assert_eq!(attention[0]["configuration_name"], "Edge syslog");
    assert_eq!(
        attention[1]["reason"],
        "data_dir \"/var/lib/vector\" does not exist"
    );
    assert_eq!(attention[1]["code"], "VALIDATION_FAILED");
    assert_eq!(attention[4]["since"], "2026-01-01T00:00:00Z");
    // The existing attention groups are unchanged.
    let causes: Vec<&str> = slim["attention"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g["cause"].as_str().unwrap())
        .collect();
    assert_eq!(
        causes,
        [
            "failed",
            "failed",
            "degraded",
            "check_required",
            "offline",
            "paused",
            "unmanaged"
        ]
    );
}

#[tokio::test]
async fn the_overview_counts_applied_devices_it_cannot_measure_and_adopted_configurations() {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-fleet-inventory-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Fleet inventory".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = actor(&s, "admin").await;
    let (pipeline, version) = (db::id(), db::id());
    record(&s, "configuration", json!({"id":pipeline,"name":"Edge syslog","description":"","config":{},"graph":{"nodes":[],"edges":[]}})).await;
    record(
        &s,
        "version",
        json!({"id":version,"configuration_id":pipeline,"number":1,"sha256":SHA1}),
    )
    .await;
    let run = Some(version.as_str());
    // Applied and reporting: measured.
    insert(
        &s,
        "measured",
        applied(&version, SHA1, 5.0),
        run,
        None,
        false,
        false,
    )
    .await;
    // Applied with no sample, or only an old one: delivery can't be measured.
    insert(
        &s,
        "silent",
        merged(applied(&version, SHA1, 5.0), json!({"telemetry":null})),
        run,
        None,
        false,
        false,
    )
    .await;
    insert(
        &s,
        "stale",
        merged(
            applied(&version, SHA1, 5.0),
            json!({"telemetry":{"sampled_at":"2026-01-01T00:00:00Z","events_per_second":9.0}}),
        ),
        run,
        None,
        false,
        false,
    )
    .await;
    // Not applied, or revoked: never counted.
    insert(
        &s,
        "failed",
        json!({"last_seen":db::now(),"apply_state":"failed","reported_generation":0}),
        run,
        None,
        false,
        false,
    )
    .await;
    insert(
        &s,
        "retired",
        merged(applied(&version, SHA1, 5.0), json!({"telemetry":null})),
        run,
        None,
        false,
        true,
    )
    .await;
    // Without a pipeline: a local configuration adopted at setup keeps running
    // unless Vector isn't running.
    let unmanaged =
        json!({"last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0});
    insert(
        &s,
        "adopted",
        merged(unmanaged.clone(), json!({"actual_sha256":SHA2})),
        None,
        None,
        false,
        false,
    )
    .await;
    insert(
        &s,
        "adopted-stopped",
        merged(
            unmanaged.clone(),
            json!({"actual_sha256":SHA2,"vector_running":false}),
        ),
        None,
        None,
        false,
        false,
    )
    .await;
    insert(&s, "bare", unmanaged, None, None, false, false).await;
    let app = api::router(s.clone());
    for uri in ["/api/v1/overview?slim=1", "/api/v1/overview"] {
        let overview = get(&app, &admin, uri).await;
        assert_eq!(overview["devices_unmeasured"], 2, "{uri}");
        let groups = overview["attention"].as_array().unwrap();
        let unmanaged = groups
            .iter()
            .find(|group| group["cause"] == "unmanaged")
            .unwrap();
        assert_eq!(unmanaged["count"], 3, "{uri}");
        assert_eq!(unmanaged["adopted"], 1, "{uri}");
        assert!(
            groups
                .iter()
                .filter(|group| group["cause"] != "unmanaged")
                .all(|group| group.get("adopted").is_none()),
            "{uri}: only the unmanaged group says how many adopted a local configuration"
        );
    }
}

#[tokio::test]
async fn running_now_rolls_up_what_devices_report() {
    let f = fleet().await;
    let slim = get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    assert_eq!(slim["running_total"], 2);
    let running = slim["running"].as_array().unwrap();
    // Edge syslog v1: edge-1, edge-2, edge-10, Edge-3 and web-2; the revoked
    // device and lost-1 (no verified run) don't count.
    assert_eq!(running[0]["configuration_name"], "Edge syslog");
    assert_eq!(running[0]["version_id"], f.v1);
    assert_eq!(running[0]["version"], 1);
    assert_eq!(running[0]["device_count"], 5);
    assert_eq!(running[0]["devices_reporting"], 4);
    assert_eq!(running[0]["events_in_per_second"], 100.0);
    assert_eq!(running[0]["events_out_per_second"], 50.0);
    assert_eq!(
        running[0]["groups"],
        json!([{"id":f.groups["Everything"],"name":"Everything","device_count":5},{"id":f.groups["Edge collectors"],"name":"Edge collectors","device_count":4},{"id":f.groups["Web tier"],"name":"Web tier","device_count":1}])
    );
    assert_eq!(running[0]["more_groups"], 0);
    assert_eq!(running[0]["state"], "not_delivering");
    assert_eq!(running[0]["not_delivering"], 1);
    assert_eq!(running[0]["canary"], Value::Null);
    // Web access v2: a canary on web-1 still measuring delivery; web-3's
    // sample is stale, so only web-1 reports.
    assert_eq!(running[1]["configuration_name"], "Web access");
    assert_eq!(running[1]["device_count"], 2);
    assert_eq!(running[1]["devices_reporting"], 1);
    assert_eq!(running[1]["events_in_per_second"], 5.0);
    assert_eq!(running[1]["state"], "canary");
    assert_eq!(
        running[1]["canary"],
        json!({"deployment_id":f.canary,"phase":"measuring","device_count":1,"device_names":["web-1"]})
    );
    assert_eq!(running[1]["not_delivering"], 0);
    // Nobody reported yet: unknown, never zero.
    sqlx::query("UPDATE devices SET data=json_remove(data,'$.telemetry')")
        .execute(&f.s.pool)
        .await
        .unwrap();
    f.s.fleet.invalidate();
    let quiet = get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    assert_eq!(quiet["running"][0]["events_in_per_second"], Value::Null);
    assert_eq!(quiet["running"][0]["devices_reporting"], 0);
    assert_eq!(
        quiet["counts"]["telemetry"]["events_in_per_second"],
        Value::Null
    );
}

#[tokio::test]
async fn rollouts_count_devices_that_applied_but_are_not_delivering() {
    let f = fleet().await;
    let overview = get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    let rollouts = overview["rollouts"].as_array().unwrap();
    let all = rollouts
        .iter()
        .find(|r| r["id"] == f.rollout.as_str())
        .unwrap();
    assert_eq!(all["state_counts"], json!({"verified_applied":5}));
    assert_eq!(all["degraded"], 1);
    let canary = rollouts
        .iter()
        .find(|r| r["id"] == f.canary.as_str())
        .unwrap();
    assert_eq!(canary["degraded"], 0);
    let summary = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/deployments/{}/summary", f.rollout),
    )
    .await;
    assert_eq!(
        (
            summary["degraded"].as_u64(),
            summary["verified_count"].as_u64()
        ),
        (Some(1), Some(5))
    );
    let history = get(&f.app, &f.admin, "/api/v1/deployments/history").await;
    let item = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == f.rollout.as_str())
        .unwrap();
    assert_eq!(item["degraded"], 1);
    // An issue measured on another version isn't this rollout's.
    sqlx::query("UPDATE devices SET data=json_set(data,'$.data_plane.version_id',?) WHERE id=?")
        .bind(&f.v2)
        .bind(f.id("Edge-3"))
        .execute(&f.s.pool)
        .await
        .unwrap();
    let summary = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/deployments/{}/summary", f.rollout),
    )
    .await;
    assert_eq!(summary["degraded"], 0);
}

#[tokio::test]
async fn device_detail_reads_one_device_with_its_groups_on_request() {
    let f = fleet().await;
    let mut conn = f.s.pool.acquire().await.unwrap();
    let every = rollout::devices(&mut conn).await.unwrap();
    drop(conn);
    // The page adds only the live wake-up projection (no agent waits here).
    let unwoken = |mut detail: Value| {
        let wake = detail.as_object_mut().unwrap().remove("wake");
        assert_eq!(wake, Some(json!({"listening": false})));
        detail
    };
    for (name, id) in &f.ids {
        let detail = get(&f.app, &f.admin, &format!("/api/v1/devices/{id}")).await;
        let expected = every.iter().find(|d| d["id"] == id.as_str()).unwrap();
        assert_eq!(&unwoken(detail), expected, "{name}");
    }
    let edge = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/{}?include=groups", f.id("edge-1")),
    )
    .await;
    assert_eq!(
        edge["groups"],
        json!({"total":2,"items":[{"id":f.groups["Edge collectors"],"name":"Edge collectors"},{"id":f.groups["Everything"],"name":"Everything"}]})
    );
    let mut without = unwoken(edge.clone());
    without.as_object_mut().unwrap().remove("groups");
    assert_eq!(
        &without,
        every.iter().find(|d| d["name"] == "edge-1").unwrap()
    );
    // Ignored as before; checked when it names an option.
    get(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/{}?selected=1", f.id("edge-1")),
    )
    .await;
    refused(
        &f.app,
        &f.admin,
        &format!("/api/v1/devices/{}?include=everything", f.id("edge-1")),
    )
    .await;
    let (status, _) = call(
        &f.app,
        "GET",
        &format!("/api/v1/devices/{}", db::id()),
        None,
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_shared_projection_serves_one_account_and_role_and_ends_with_any_change() {
    let f = fleet().await;
    let builds = || f.s.fleet.builds();
    // Long enough that a slow machine can't expire it mid-test.
    f.s.fleet.set_ttl(std::time::Duration::from_secs(600));
    get(&f.app, &f.admin, "/api/v1/devices/inventory").await;
    get(&f.app, &f.admin, "/api/v1/devices/inventory?q=edge").await;
    get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{}/members", f.groups["Everything"]),
    )
    .await;
    assert_eq!(
        builds(),
        1,
        "one projection serves the same account's reads"
    );
    // Concurrent first reads of another account share one build too.
    let operator = actor(&f.s, "operator").await;
    let uri = "/api/v1/devices/inventory";
    let pages = tokio::join!(
        get(&f.app, &operator, uri),
        get(&f.app, &operator, uri),
        get(&f.app, &operator, uri),
        get(&f.app, &operator, uri)
    );
    assert!(pages.0 == pages.1 && pages.1 == pages.2 && pages.2 == pages.3);
    assert_eq!(builds(), 2, "never shared across accounts");
    // A change outside the dashboard API shows once the projection expires.
    sqlx::query(
        "UPDATE devices SET data=json_set(data,'$.vector_version','0.58.1') WHERE name='spare-1'",
    )
    .execute(&f.s.pool)
    .await
    .unwrap();
    assert_eq!(
        get(&f.app, &f.admin, "/api/v1/devices/inventory?version=0.58.1").await["total"],
        0
    );
    f.s.fleet.set_ttl(std::time::Duration::from_millis(1));
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(
        get(&f.app, &f.admin, "/api/v1/devices/inventory?version=0.58.1").await["total"],
        1
    );
    f.s.fleet.set_ttl(std::time::Duration::from_secs(600));
    let before = builds();
    // A change through the API is visible to the very next read.
    let (status, group) = call(
        &f.app,
        "POST",
        "/api/v1/groups",
        Some(json!({"name":"Fresh","description":"","device_ids":[f.id("spare-1")]})),
        Some(&f.admin),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{group}");
    let fresh = get(&f.app, &f.admin, "/api/v1/devices/inventory?q=fresh").await;
    assert_eq!(f.names(&fresh["items"]), ["spare-1"]);
    assert_eq!(builds(), before + 1);
    let members = get(
        &f.app,
        &f.admin,
        &format!("/api/v1/groups/{}/members", group["id"].as_str().unwrap()),
    )
    .await;
    assert_eq!(members["items"][0]["name"], "spare-1");
    assert_eq!(builds(), before + 1);
    // Every request that isn't a read ends it, whatever it did.
    call(
        &f.app,
        "POST",
        "/api/v1/groups",
        Some(json!({"name":""})),
        Some(&f.admin),
    )
    .await;
    get(&f.app, &f.admin, "/api/v1/devices/inventory").await;
    assert_eq!(builds(), before + 2);
}
