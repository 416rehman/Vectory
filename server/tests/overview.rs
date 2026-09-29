use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

struct Actor {
    cookie: String,
}
async fn admin(s: &State) -> Actor {
    let id = db::id();
    let token = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind("Overview admin")
    .bind("admin")
    .bind("unused-test-login")
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
    Actor {
        cookie: format!("vectory_session={token}"),
    }
}
async fn fixture() -> (tempfile::TempDir, State, Router, Actor) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-test-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Overview tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let actor = admin(&s).await;
    (temp, s.clone(), api::router(s), actor)
}
async fn overview(app: &Router, actor: &Actor) -> Value {
    get(app, actor, "/api/v1/overview").await
}
async fn get(app: &Router, actor: &Actor, uri: &str) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", &actor.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn device(
    s: &State,
    name: &str,
    data: Value,
    desired: Option<&str>,
    revoked: bool,
) -> String {
    let id = db::id();
    let mut data = data;
    data["id"] = json!(id);
    data["name"] = json!(name);
    sqlx::query("INSERT INTO devices(id,name,data,desired_version_id,desired_generation,revoked) VALUES(?,?,?,?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(data.to_string())
        .bind(desired)
        .bind(if desired.is_some() { 1 } else { 0 })
        .bind(revoked)
        .execute(&s.pool)
        .await
        .unwrap();
    id
}
async fn audit(s: &State, n: usize, action: &str, target: &str, outcome: &str) {
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(
        &mut conn,
        "audit",
        &json!({"id":format!("50000000-0000-4000-8000-{n:012}"),"actor":"scheduler","action":action,"target":target,"outcome":outcome,"created_at":format!("2026-09-29T02:0{n}:00Z")}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn overview_groups_needs_rollouts_and_fleet_changes_from_stored_state() {
    let (_temp, s, app, actor) = fixture().await;
    let pipeline = db::id();
    let version = db::id();
    let deployment = db::id();
    let sha = "a".repeat(64);
    {
        let mut conn = s.pool.acquire().await.unwrap();
        db::insert(
            &mut conn,
            "configuration",
            &json!({"id":pipeline,"name":"Edge syslog processing","description":"","config":{},"graph":{"nodes":[],"edges":[]}}),
        )
        .await
        .unwrap();
        db::insert(
            &mut conn,
            "version",
            &json!({"id":version,"configuration_id":pipeline,"number":2,"sha256":sha}),
        )
        .await
        .unwrap();
        db::insert(
            &mut conn,
            "deployment",
            &json!({"id":deployment,"version_id":version,"status":"active","priority":100,"target_mode":"snapshot","selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"canary","canary_size":1,"batch_size":2,"observation_seconds":60,"failure_threshold":0}}),
        )
        .await
        .unwrap();
    }
    let now = db::now();
    let failed = device(
        &s,
        "edge-01",
        json!({"last_seen":now,"apply_state":"failed","reported_generation":1,"configuration_attempt":{"generation":1,"version_id":version,"sha256":sha,"state":"failed","error":{"code":"VALIDATION_FAILED","stage":"validation","message":"data_dir \"/var/lib/vector/\" does not exist"}}}),
        Some(&version),
        false,
    )
    .await;
    device(
        &s,
        "edge-02",
        json!({"last_seen":"2026-01-01T00:00:00Z","apply_state":"unmanaged","reported_generation":0}),
        None,
        false,
    )
    .await;
    device(
        &s,
        "web-01",
        json!({"last_seen":now,"apply_state":"unmanaged","reported_generation":0}),
        None,
        false,
    )
    .await;
    device(
        &s,
        "retired-01",
        json!({"last_seen":now,"apply_state":"failed","reported_generation":0}),
        None,
        true,
    )
    .await;
    sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,'failed',1)")
        .bind(&deployment)
        .bind(&failed)
        .execute(&s.pool)
        .await
        .unwrap();
    audit(&s, 1, "configuration.publish", &version, "success").await;
    audit(&s, 2, "configuration.save", &pipeline, "success").await;
    audit(&s, 3, "deployment.create", &deployment, "success").await;
    audit(&s, 4, "login", &db::id(), "denied").await;

    let value = overview(&app, &actor).await;
    // The original fields stay for older dashboards.
    assert_eq!(value["devices_total"], 4);
    assert_eq!(value["deployments_active"], 1);
    assert_eq!(value["recent_activity"].as_array().unwrap().len(), 4);
    assert_eq!(value["devices"].as_array().unwrap().len(), 4);

    assert_eq!(value["devices_managed"], 1);
    assert_eq!(value["devices_on_desired"], 0);
    assert_eq!(value["versions_total"], 1);
    assert_eq!(
        value["versions"][&version],
        json!({"number":2,"configuration_id":pipeline,"configuration_name":"Edge syslog processing"})
    );

    let attention = value["attention"].as_array().unwrap();
    assert_eq!(attention[0]["cause"], "failed");
    assert_eq!(attention[0]["severity"], "danger");
    assert_eq!(attention[0]["count"], 1);
    assert_eq!(attention[0]["device_names"], json!(["edge-01"]));
    assert_eq!(attention[0]["configuration_name"], "Edge syslog processing");
    assert_eq!(attention[0]["version_number"], 2);
    assert_eq!(
        attention[0]["reason"],
        "data_dir \"/var/lib/vector/\" does not exist"
    );
    let causes: Vec<&str> = attention
        .iter()
        .map(|group| group["cause"].as_str().unwrap())
        .collect();
    assert_eq!(causes, ["failed", "offline", "unmanaged"]);
    let offline = &attention[1];
    assert_eq!(offline["device_names"], json!(["edge-02"]));
    assert_eq!(offline["since"], "2026-01-01T00:00:00Z");
    // A revoked identity never counts as needing attention.
    assert!(!value.to_string().contains("retired-01\"]"));

    let rollouts = value["rollouts"].as_array().unwrap();
    assert_eq!(rollouts.len(), 1);
    assert_eq!(rollouts[0]["id"], deployment.as_str());
    assert_eq!(rollouts[0]["configuration_name"], "Edge syslog processing");
    assert_eq!(rollouts[0]["version_number"], 2);
    assert_eq!(rollouts[0]["rollout_kind"], "canary");
    assert_eq!(rollouts[0]["target_count"], 1);
    assert_eq!(rollouts[0]["state_counts"], json!({"failed":1}));

    let activity = value["fleet_activity"].as_array().unwrap();
    let actions: Vec<&str> = activity
        .iter()
        .map(|item| item["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["deployment.create", "configuration.publish"]);
    assert_eq!(
        activity[0]["deployment"],
        json!({"configuration_name":"Edge syslog processing","version_number":2,"policy":false,"rollout_kind":"canary","priority":100,"target_count":1})
    );
    assert_eq!(activity[1]["version_number"], 2);
    assert_eq!(value["security_events_hidden"], 1);

    // Device list rows name their desired version; unmanaged rows stay bare.
    let devices = get(&app, &actor, "/api/v1/devices").await;
    let rows = devices.as_array().unwrap();
    let named = rows.iter().find(|d| d["id"] == failed.as_str()).unwrap();
    assert_eq!(
        named["desired_version"],
        json!({"number":2,"configuration_id":pipeline,"configuration_name":"Edge syslog processing"})
    );
    let bare = rows.iter().find(|d| d["name"] == "edge-02").unwrap();
    assert!(bare.get("desired_version").is_none());
}

#[tokio::test]
async fn overview_is_empty_but_well_formed_for_a_new_workspace() {
    let (_temp, _s, app, actor) = fixture().await;
    let value = overview(&app, &actor).await;
    assert_eq!(value["devices_total"], 0);
    assert_eq!(value["devices_managed"], 0);
    assert_eq!(value["versions_total"], 0);
    assert_eq!(value["versions"], json!({}));
    assert_eq!(value["rollouts"], json!([]));
    assert_eq!(value["attention"], json!([]));
    assert_eq!(value["fleet_activity"], json!([]));
    assert_eq!(value["security_events_hidden"], 0);
}
