//! A device whose newest version failed but which verifiably keeps running an
//! earlier one, and delivers on it, is held there: amber, counted on its own,
//! and never called failed. A device that really has no working version is
//! still failed. The hand-made fleet states every number exactly.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

const OLD: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const NEW: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const TORN: &str = "9999999999999999999999999999999999999999999999999999999999999999";

struct Actor {
    cookie: String,
    csrf: String,
}
async fn admin(s: &State) -> Actor {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind("Held admin")
    .bind("admin")
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
async fn get(app: &Router, actor: &Actor, uri: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    assert_eq!(status, StatusCode::OK, "{uri}: {value}");
    value
}

struct Fleet {
    _temp: tempfile::TempDir,
    app: Router,
    admin: Actor,
    old: String,
    new: String,
}
async fn record(s: &State, kind: &str, value: Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, kind, &value).await.unwrap();
}
/// A device that was verified on the old version and is now assigned the new.
async fn device(s: &State, name: &str, new: &str, extra: Value) -> String {
    let id = db::id();
    let mut data = json!({"id":id,"name":name,"created_at":db::now(),"last_seen":db::now(),
        "os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"1.4.0",
        "reported_generation":2,"apply_state":"rolled_back","actual_sha256":OLD,
        "configuration_attempt":{"generation":2,"version_id":new,"sha256":NEW,"state":"failed",
            "error":{"code":"ADDRESS_IN_USE","stage":"reload","message":"Address already in use"}}});
    for (key, value) in extra.as_object().unwrap() {
        data[key] = value.clone();
    }
    sqlx::query("INSERT INTO devices(id,name,data,desired_version_id,desired_generation,policy,revoked) VALUES(?,?,?,?,?,?,0)")
        .bind(&id)
        .bind(name)
        .bind(data.to_string())
        .bind(new)
        .bind(2)
        .bind(json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true}).to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    id
}

async fn fleet() -> Fleet {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-held-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Held devices".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let admin = admin(&s).await;
    let (pipeline, old, new) = (db::id(), db::id(), db::id());
    record(&s, "configuration", json!({"id":pipeline,"name":"Edge syslog","description":"","config":{},"graph":{"nodes":[],"edges":[]}})).await;
    record(
        &s,
        "version",
        json!({"id":old,"configuration_id":pipeline,"number":1,"sha256":OLD}),
    )
    .await;
    record(
        &s,
        "version",
        json!({"id":new,"configuration_id":pipeline,"number":3,"sha256":NEW}),
    )
    .await;
    // The device records name the old version by ID.
    let with_old = |extra: Value| {
        let mut extra = extra;
        extra["verified_configuration_attempt"] =
            json!({"version_id":old,"generation":1,"sha256":OLD});
        extra
    };
    // Held: restored the old version after the new one failed.
    device(&s, "held-rolled", &new, with_old(json!({}))).await;
    // Held: the new version was refused before anything changed.
    device(
        &s,
        "held-refused",
        &new,
        with_old(json!({"apply_state":"failed"})),
    )
    .await;
    // Failed for real: no version was ever verified on it.
    device(
        &s,
        "lost-never-worked",
        &new,
        json!({"apply_state":"failed","verified_configuration_attempt":null,"actual_sha256":null}),
    )
    .await;
    // Failed for real: its file no longer matches what the agent verified.
    device(
        &s,
        "lost-torn",
        &new,
        with_old(json!({"apply_state":"failed","actual_sha256":TORN})),
    )
    .await;
    // Failed for real: its Vector is not running.
    device(
        &s,
        "lost-stopped",
        &new,
        with_old(json!({"vector_running":false})),
    )
    .await;
    // Failed for real: the old version is running but not delivering.
    device(
        &s,
        "lost-dropping",
        &new,
        with_old(
            json!({"data_plane":{"version_id":old,"evaluations":5,"issues":[{"title":"out can't deliver events","code":"DATA_PLANE_SINK_ERRORS","message":"Failing.","hint":"Check the destination."}]}}),
        ),
    )
    .await;
    // Healthy on the new version.
    device(
        &s,
        "fine",
        &new,
        json!({"apply_state":"verified_applied","actual_sha256":NEW,
            "verified_configuration_attempt":{"version_id":new,"generation":2,"sha256":NEW},
            "configuration_attempt":null}),
    )
    .await;
    Fleet {
        app: api::router(s.clone()),
        _temp: temp,
        admin,
        old,
        new,
    }
}

fn names(rows: &Value) -> Vec<String> {
    let mut names: Vec<String> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap().to_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn only_a_device_that_keeps_a_working_previous_version_is_held() {
    let f = fleet().await;
    let rows = get(&f.app, &f.admin, "/api/v1/devices").await;
    let by_name = |name: &str| -> &Value {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == name)
            .unwrap()
    };
    // The agent's own report is untouched: the flag only says the device
    // still runs an earlier version and delivers on it.
    for name in ["held-rolled", "held-refused"] {
        let row = by_name(name);
        assert_eq!(row["held_on_previous_version"], true, "{name}");
        assert_eq!(
            row["running_version"]["id"],
            json!(f.old),
            "{name}: running version"
        );
        assert_eq!(row["desired_version_id"], json!(f.new));
    }
    assert_eq!(by_name("held-rolled")["status"], "rolled_back");
    assert_eq!(by_name("held-refused")["status"], "failed");
    for name in [
        "lost-never-worked",
        "lost-torn",
        "lost-stopped",
        "lost-dropping",
        "fine",
    ] {
        assert!(
            by_name(name).get("held_on_previous_version").is_none(),
            "{name} is not held"
        );
    }
    assert_eq!(by_name("lost-never-worked")["status"], "failed");
    assert_eq!(by_name("fine")["status"], "verified");
    // The device page reads the same flag.
    let id = by_name("held-rolled")["id"].as_str().unwrap();
    let detail = get(&f.app, &f.admin, &format!("/api/v1/devices/{id}")).await;
    assert_eq!(detail["held_on_previous_version"], true);
}

#[tokio::test]
async fn the_inventory_counts_and_filters_held_devices_exactly() {
    let f = fleet().await;
    let all = get(&f.app, &f.admin, "/api/v1/devices/inventory").await;
    assert_eq!(all["total"], 7);
    // Held is its own bucket, and the failures are exactly the other four.
    assert_eq!(
        all["counts"]["status"],
        json!({"applied":1,"degraded":0,"held":2,"updating":0,"check":0,"failed":4,"offline":0,"paused":0,"unmanaged":0,"revoked":0})
    );
    let held = get(&f.app, &f.admin, "/api/v1/devices/inventory?status=held").await;
    assert_eq!(names(&held["items"]), ["held-refused", "held-rolled"]);
    assert_eq!(held["total"], 2);
    let failed = get(&f.app, &f.admin, "/api/v1/devices/inventory?status=failed").await;
    assert_eq!(
        names(&failed["items"]),
        [
            "lost-dropping",
            "lost-never-worked",
            "lost-stopped",
            "lost-torn"
        ]
    );
    // Held devices still need a look and still are not on their desired version.
    for view in ["failing", "not_on_desired"] {
        let listed = get(
            &f.app,
            &f.admin,
            &format!("/api/v1/devices/inventory?view={view}"),
        )
        .await;
        assert_eq!(listed["total"], 6, "{view}");
        for name in ["held-rolled", "held-refused"] {
            assert!(
                names(&listed["items"]).contains(&name.to_owned()),
                "{view} lists {name}"
            );
        }
    }
    // Problems first when sorted by status, held after failed, applied last.
    let by_status = get(
        &f.app,
        &f.admin,
        "/api/v1/devices/inventory?sort=status&dir=asc",
    )
    .await;
    let order: Vec<&str> = by_status["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    assert_eq!(order.last(), Some(&"fine"));
    let first_held = order.iter().position(|n| n.starts_with("held")).unwrap();
    let last_failed = order.iter().rposition(|n| n.starts_with("lost")).unwrap();
    assert!(last_failed < first_held, "{order:?}");
    // The filter fails closed on a status it doesn't know and names the new one.
    let response = get_status(&f.app, &f.admin, "/api/v1/devices/inventory?status=kept").await;
    assert_eq!(response.0, StatusCode::BAD_REQUEST);
    assert!(response.1.contains("held"), "{}", response.1);
}
async fn get_status(app: &Router, actor: &Actor, uri: &str) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn the_overview_counts_holds_apart_and_offers_them_amber() {
    let f = fleet().await;
    let slim = get(&f.app, &f.admin, "/api/v1/overview?slim=1").await;
    assert_eq!(
        slim["counts"]["health"],
        json!({"applied":1,"degraded":0,"held":2,"updating":0,"check":0,"failed":4,"offline":0,"paused":0,"unmanaged":0})
    );
    assert_eq!(slim["counts"]["total"], 7);
    // Devices that need a person, in order: the four failures, then the holds.
    let attention = slim["attention_devices"].as_array().unwrap();
    assert_eq!(slim["attention_devices_total"], 6);
    let causes: Vec<(&str, &str)> = attention
        .iter()
        .map(|d| (d["name"].as_str().unwrap(), d["cause"].as_str().unwrap()))
        .collect();
    assert_eq!(
        &causes[causes.len() - 2..],
        [("held-refused", "held"), ("held-rolled", "held")]
    );
    let held = attention
        .iter()
        .find(|d| d["name"] == "held-refused")
        .unwrap();
    assert_eq!(held["status"], "held");
    assert_eq!(held["reason"], "Address already in use");
    assert_eq!(held["code"], "ADDRESS_IN_USE");
    assert_eq!(held["configuration_name"], "Edge syslog");
    // The groups: holds are a warning of their own, failures stay danger.
    let group = slim["attention"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["cause"] == "held")
        .expect("a held group");
    assert_eq!(group["severity"], "warning");
    assert_eq!(group["count"], 2);
    assert_eq!(group["state"], "held");
    assert_eq!(group["version_id"], json!(f.new));
    assert_eq!(group["reason"], "Address already in use");
    let failed: i64 = slim["attention"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| g["cause"] == "failed")
        .map(|g| g["count"].as_i64().unwrap())
        .sum();
    assert_eq!(failed, 4);
    assert!(
        slim["attention"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|g| g["cause"] == "failed")
            .all(|g| g["severity"] == "danger")
    );
    // Every reviewed device has exactly one place: the buckets add up.
    let sum: u64 = slim["counts"]["health"]
        .as_object()
        .unwrap()
        .values()
        .map(|n| n.as_u64().unwrap())
        .sum();
    assert_eq!(sum, 7);
}
