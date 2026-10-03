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
async fn post(app: &Router, actor: &Actor, uri: &str, body: Value) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let value: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(status, StatusCode::OK, "{uri}: {value}");
    value
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
        json!({"last_seen":now,"apply_state":"failed","reported_generation":1,"configuration_attempt":{"generation":1,"version_id":version,"sha256":sha,"state":"failed","error":{"code":"VALIDATION_FAILED","stage":"validation","message":"","diagnostics":[{"severity":"warning","message":"Events that match no route are dropped."},{"severity":"error","message":"data_dir \"/var/lib/vector/\" does not exist"}]}}}),
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
        json!({"configuration_name":"Edge syslog processing","version_number":2,"policy":false,"rollout_kind":"canary","priority":100,"target_count":1,
            "rolled_back_to_configuration_name":null,"rolled_back_to_version_number":null,"rolled_back_device_count":null,
            "rollback_of_configuration_name":null,"rollback_of_version_number":null})
    );
    // Without a shared assignment there is no rollout to offer a rollback of.
    assert!(attention[0]["deployment_id"].is_null());
    assert_eq!(attention[0]["rollback_available"], false);
    assert_eq!(activity[1]["version_number"], 2);
    assert_eq!(value["security_events_hidden"], 1);

    // Device list rows name their desired version; unmanaged rows stay bare.
    let devices = get(&app, &actor, "/api/v1/devices").await;
    let rows = devices.as_array().unwrap();
    let named = rows.iter().find(|d| d["id"] == failed.as_str()).unwrap();
    assert_eq!(named["desired_version"]["number"], 2);
    assert_eq!(
        named["desired_version"]["configuration_id"],
        json!(pipeline)
    );
    assert_eq!(
        named["desired_version"]["configuration_name"],
        "Edge syslog processing"
    );
    let bare = rows.iter().find(|d| d["name"] == "edge-02").unwrap();
    assert!(bare["desired_version"].is_null());
}

/// Round-2 operator review P1-1 and P1-2: a rollback reads the right way round
/// (what was rolled back, on which devices, and what they run now), and a
/// failing group names the rollout its devices share and whether it can be
/// rolled back.
#[tokio::test]
async fn rollback_lineage_and_failing_groups_name_their_rollout() {
    let (_temp, s, app, actor) = fixture().await;
    let mut conn = s.pool.acquire().await.unwrap();
    let mut versions = Vec::new();
    for (name, slug) in [("Edge syslog processing", "edge"), ("r15-demo", "demo")] {
        let pipeline = db::id();
        db::insert(&mut conn,"configuration",&json!({"id":pipeline,"name":name,"description":"","config":{},"graph":{"nodes":[],"edges":[]}})).await.unwrap();
        let version = db::id();
        let artifact = format!("{{\"data_dir\":\"/var/lib/vector/{slug}\"}}\n");
        db::insert(&mut conn,"version",&json!({"id":version,"configuration_id":pipeline,"number":1,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now()})).await.unwrap();
        versions.push(version);
    }
    drop(conn);
    let (edge, demo) = (versions[0].clone(), versions[1].clone());
    let mut ids = Vec::new();
    for name in ["edge-nyc-02", "edge-fra-01"] {
        ids.push(
            device(
                &s,
                name,
                json!({"last_seen":db::now(),"vector_version":"0.58.0","apply_state":"unmanaged","reported_generation":0}),
                None,
                false,
            )
            .await,
        );
    }
    ids.sort();
    let request = |version: &str, kind: &str| {
        json!({"version_id":version,"selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"priority":100,"target_mode":"snapshot",
            "rollout":{"kind":kind,"canary_size":1,"batch_size":1,"observation_seconds":3600,"failure_threshold":0}})
    };
    let base = post(&app, &actor, "/api/v1/deployments", request(&edge, "all")).await;
    let mut canary_request = request(&demo, "canary");
    canary_request["replaces"] = json!([base["id"]]);
    let canary = post(&app, &actor, "/api/v1/deployments", canary_request).await;
    let canary_id = canary["id"].as_str().unwrap();
    // The canary device failed and the agent restored its last working config.
    let (generation, name): (i64, String) =
        sqlx::query_as("SELECT desired_generation,name FROM devices WHERE id=?")
            .bind(&ids[0])
            .fetch_one(&s.pool)
            .await
            .unwrap();
    sqlx::query("UPDATE devices SET data=json_set(data,'$.apply_state','rolled_back','$.configuration_attempt',json(?)) WHERE id=?")
        .bind(json!({"generation":generation,"version_id":demo,"sha256":"b".repeat(64),"state":"rolled_back","error":{"code":"APPLY_ROLLED_BACK","stage":"reload","message":"Another process is already listening on this component's address."}}).to_string())
        .bind(&ids[0])
        .execute(&s.pool)
        .await
        .unwrap();
    let value = overview(&app, &actor).await;
    let failed = value["attention"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["cause"] == "failed")
        .unwrap()
        .clone();
    assert_eq!(failed["state"], "rolled_back");
    assert_eq!(failed["device_names"], json!([name]));
    assert_eq!(failed["deployment_id"], canary_id);
    assert_eq!(failed["rollback_available"], true);

    let plan = get(
        &app,
        &actor,
        &format!("/api/v1/deployments/{canary_id}/rollback-preview"),
    )
    .await;
    assert_eq!(plan["ready"], true, "{plan}");
    let rollback = post(
        &app,
        &actor,
        &format!("/api/v1/deployments/{canary_id}/rollback"),
        json!({"request_id":db::id(),"review_token":plan["review_token"]}),
    )
    .await;
    let value = overview(&app, &actor).await;
    let activity = value["fleet_activity"].as_array().unwrap();
    let rolled = activity
        .iter()
        .find(|item| item["action"] == "deployment.rollback")
        .unwrap();
    assert_eq!(rolled["target_id"], canary_id);
    assert_eq!(rolled["deployment"]["configuration_name"], "r15-demo");
    assert_eq!(rolled["deployment"]["version_number"], 1);
    assert_eq!(
        rolled["deployment"]["rolled_back_to_configuration_name"],
        "Edge syslog processing"
    );
    assert_eq!(rolled["deployment"]["rolled_back_to_version_number"], 1);
    assert_eq!(rolled["deployment"]["rolled_back_device_count"], 1);
    assert_eq!(rolled["device_names"], json!([name]));
    let created = activity
        .iter()
        .find(|item| item["action"] == "deployment.create" && item["target_id"] == rollback["id"])
        .unwrap();
    assert_eq!(
        created["deployment"]["configuration_name"],
        "Edge syslog processing"
    );
    assert_eq!(
        created["deployment"]["rollback_of_configuration_name"],
        "r15-demo"
    );
    assert_eq!(created["deployment"]["rollback_of_version_number"], 1);
    // Rolled back: the rollout is no longer something to roll back.
    let summary = get(
        &app,
        &actor,
        &format!("/api/v1/deployments/{canary_id}/summary"),
    )
    .await;
    assert_eq!(
        summary["rolled_back_to_configuration_name"],
        "Edge syslog processing"
    );
    assert_eq!(
        summary["replaces"],
        json!([{"deployment_id":base["id"],"version_number":1,"configuration_name":"Edge syslog processing","rollback":false}])
    );
    let history = get(&app, &actor, "/api/v1/deployments/history?page_size=12").await;
    let restored = history["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == rollback["id"])
        .unwrap()
        .clone();
    assert_eq!(restored["rollback_of_configuration_name"], "r15-demo");
    assert_eq!(restored["rollback_of_version"], 1);
    let base_summary = get(
        &app,
        &actor,
        &format!(
            "/api/v1/deployments/{}/summary",
            base["id"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(
        base_summary["replaced_by"][0]["configuration_name"],
        "r15-demo"
    );
}

#[tokio::test]
async fn an_offline_device_that_verified_its_assigned_version_is_counted_apart() {
    let (_temp, s, app, actor) = fixture().await;
    let (pipeline, version, older) = (db::id(), db::id(), db::id());
    let sha = "b".repeat(64);
    {
        let mut conn = s.pool.acquire().await.unwrap();
        db::insert(
            &mut conn,
            "configuration",
            &json!({"id":pipeline,"name":"First pipeline","description":"","config":{},"graph":{"nodes":[],"edges":[]}}),
        )
        .await
        .unwrap();
        for (id, number) in [(&older, 1), (&version, 2)] {
            db::insert(
                &mut conn,
                "version",
                &json!({"id":id,"configuration_id":pipeline,"number":number,"sha256":sha}),
            )
            .await
            .unwrap();
        }
    }
    let verified =
        |id: &str| json!({"generation":1,"version_id":id,"sha256":sha,"state":"verified_applied"});
    let gone = "2026-01-01T00:00:00Z";
    // Verified its assigned version, then went offline.
    device(
        &s,
        "edge-01",
        json!({"last_seen":gone,"apply_state":"verified_applied","reported_generation":1,"verified_configuration_attempt":verified(&version)}),
        Some(&version),
        false,
    )
    .await;
    // Offline having verified an older version than the one it is assigned.
    device(
        &s,
        "edge-02",
        json!({"last_seen":gone,"apply_state":"verified_applied","reported_generation":1,"verified_configuration_attempt":verified(&older)}),
        Some(&version),
        false,
    )
    .await;
    // Offline and never verified anything.
    device(
        &s,
        "edge-03",
        json!({"last_seen":gone,"apply_state":"unmanaged","reported_generation":0}),
        Some(&version),
        false,
    )
    .await;
    // Offline with nothing assigned, and a revoked one that verified.
    device(
        &s,
        "edge-04",
        json!({"last_seen":gone,"apply_state":"unmanaged","reported_generation":0}),
        None,
        false,
    )
    .await;
    device(
        &s,
        "retired-01",
        json!({"last_seen":gone,"apply_state":"verified_applied","reported_generation":1,"verified_configuration_attempt":verified(&version)}),
        Some(&version),
        true,
    )
    .await;
    let value = overview(&app, &actor).await;
    assert_eq!(value["devices_managed"], 3);
    assert_eq!(value["devices_on_desired"], 0);
    assert_eq!(value["devices_offline_on_desired"], 1, "{value}");
    // They all last verified the one version, so its number is named.
    assert_eq!(value["offline_on_desired_version"], 2);
    // The slim read the Overview uses says the same.
    let slim = get(&app, &actor, "/api/v1/overview?slim=1").await;
    assert_eq!(slim["devices_offline_on_desired"], 1);
    assert_eq!(slim["offline_on_desired_version"], 2);
    assert_eq!(slim["devices_on_desired"], 0);
    // Another device out of reach on a different version: two are counted and
    // no single version is named.
    device(
        &s,
        "edge-05",
        json!({"last_seen":gone,"apply_state":"verified_applied","reported_generation":1,"verified_configuration_attempt":verified(&older)}),
        Some(&older),
        false,
    )
    .await;
    // The device went in beside the server, so the shared read is told.
    s.fleet.invalidate();
    let slim = get(&app, &actor, "/api/v1/overview?slim=1").await;
    assert_eq!(slim["devices_offline_on_desired"], 2);
    assert_eq!(slim["offline_on_desired_version"], Value::Null);
    // Nothing offline counts nothing and names nothing.
    let (_temp, _s, app, actor) = fixture().await;
    let empty = overview(&app, &actor).await;
    assert_eq!(empty["devices_offline_on_desired"], 0);
    assert_eq!(empty["offline_on_desired_version"], Value::Null);
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
