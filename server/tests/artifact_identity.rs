//! What a published artifact's digest depends on. Canvas layout is
//! presentation: moving, resizing or reordering nodes never changes the
//! runtime bytes or their SHA-256. Identical bytes are stored once and every
//! device that receives them references that one blob by digest.
use axum::{
    Extension, Router,
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use rand::{Rng, SeedableRng, seq::SliceRandom};
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, db, device, initialize};

const SECRET: &str = "isolated-test-bootstrap-secret-123456789";

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
/// The exact bytes a device downloads.
async fn download(app: Router, path: &str) -> (StatusCode, Vec<u8>) {
    let response = app
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
async fn state() -> (tempfile::TempDir, State, String, String) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: SECRET.into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Test".into(),
        ..Default::default()
    })
    .await
    .unwrap();
    let (status, v, cookie) = call(api::router(s.clone()), "POST", "/api/v1/bootstrap", json!({"bootstrap_secret":SECRET,"email":"admin@example.test","name":"Administrator","password":"a-long-enough-password"}), "", "").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let csrf = v["csrf_token"].as_str().unwrap().to_owned();
    (temp, s, cookie, csrf)
}
fn config() -> Value {
    json!({
        "sources":{"web":{"type":"demo_logs","format":"apache_common","interval":1}},
        "transforms":{
            "parse":{"type":"remap","inputs":["web"],"source":".status = 200"},
            "errors":{"type":"filter","inputs":["parse"],"condition":".status >= 500"}
        },
        "sinks":{"out":{"type":"blackhole","inputs":["errors"]},"all":{"type":"blackhole","inputs":["parse"]}}
    })
}
/// The editor's graph for `config()`: nodes with positions and presentation
/// fields, and the edges between them.
fn graph() -> Value {
    json!({
        "nodes":[
            {"id":"web","type":"source","position":{"x":0,"y":0},"data":{"kind":"sources","type":"demo_logs"}},
            {"id":"parse","type":"transform","position":{"x":240,"y":0},"data":{"kind":"transforms","type":"remap"}},
            {"id":"errors","type":"transform","position":{"x":480,"y":-80},"data":{"kind":"transforms","type":"filter"}},
            {"id":"out","type":"sink","position":{"x":720,"y":-80},"data":{"kind":"sinks","type":"blackhole"}},
            {"id":"all","type":"sink","position":{"x":720,"y":80},"data":{"kind":"sinks","type":"blackhole"}}
        ],
        "edges":[
            {"id":"web-parse","source":"web","target":"parse"},
            {"id":"parse-errors","source":"parse","target":"errors"},
            {"id":"errors-out","source":"errors","target":"out"},
            {"id":"parse-all","source":"parse","target":"all"}
        ]
    })
}
/// The same graph moved around: new positions and sizes, selection and
/// viewport state, nodes and edges in another order. Coordinates are
/// quarter pixels so they survive a JSON round trip bit for bit and the
/// saved layout can be compared exactly.
fn moved(seed: u64) -> Value {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let mut graph = graph();
    let mut coordinate = || f64::from(rng.gen_range(-20_000..20_000)) / 4.0;
    for node in graph["nodes"].as_array_mut().unwrap() {
        node["position"] = json!({"x":coordinate(),"y":coordinate()});
    }
    for node in graph["nodes"].as_array_mut().unwrap() {
        if rng.gen_bool(0.5) {
            node["width"] = json!(rng.gen_range(120..480));
            node["height"] = json!(rng.gen_range(40..200));
        }
        if rng.gen_bool(0.3) {
            node["selected"] = json!(true);
        }
    }
    graph["nodes"].as_array_mut().unwrap().shuffle(&mut rng);
    graph["edges"].as_array_mut().unwrap().shuffle(&mut rng);
    if rng.gen_bool(0.5) {
        graph["viewport"] = json!({"x":rng.gen_range(-900..900),"y":rng.gen_range(-900..900),"zoom":f64::from(rng.gen_range(2..=16)) / 8.0});
    }
    graph
}

#[tokio::test]
async fn moving_nodes_never_changes_the_published_digest() {
    let (_temp, s, cookie, csrf) = state().await;
    let app = api::router(s.clone());
    let (status, pipeline, _) = call(
        app.clone(),
        "POST",
        "/api/v1/configurations",
        json!({"name":"Layout property","graph":graph(),"config":config()}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{pipeline}");
    let id = pipeline["id"].as_str().unwrap().to_owned();
    let publish = |revision: Value| {
        let (app, id, cookie, csrf) = (app.clone(), id.clone(), cookie.clone(), csrf.clone());
        async move {
            let (status, version, _) = call(
                app,
                "POST",
                &format!("/api/v1/configurations/{id}/publish"),
                json!({"revision":revision,"message":"layout"}),
                &cookie,
                &csrf,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{version}");
            version
        }
    };
    let first = publish(pipeline["revision"].clone()).await;
    let digest = first["sha256"].as_str().unwrap().to_owned();
    assert_eq!(digest, db::hash(first["artifact"].as_str().unwrap()));
    let mut revision = pipeline["revision"].clone();
    for seed in 0..24 {
        let layout = moved(seed);
        let (status, draft, _) = call(app.clone(), "PUT", &format!("/api/v1/configurations/{id}/draft"), json!({"revision":revision,"graph":layout,"config":config(),"message":format!("move {seed}")}), &cookie, &csrf).await;
        assert_eq!(status, StatusCode::OK, "{draft}");
        assert_eq!(draft["graph"], layout, "the layout itself is saved");
        revision = draft["revision"].clone();
        let version = publish(revision.clone()).await;
        assert_ne!(version["id"], first["id"], "each publish is a new version");
        assert_eq!(version["graph"], layout);
        assert_eq!(
            version["sha256"], digest,
            "seed {seed}: a layout change altered the runtime digest"
        );
        assert_eq!(version["artifact"], first["artifact"]);
    }
    // The property is not vacuous: a runtime change does change the digest.
    let mut changed = config();
    changed["sources"]["web"]["interval"] = json!(2);
    let (status, draft, _) = call(
        app.clone(),
        "PUT",
        &format!("/api/v1/configurations/{id}/draft"),
        json!({"revision":revision,"graph":graph(),"config":changed}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{draft}");
    assert_ne!(publish(draft["revision"].clone()).await["sha256"], digest);
}

#[tokio::test]
async fn identical_bytes_are_stored_once_and_referenced_by_digest_for_every_device() {
    let (_temp, s, cookie, csrf) = state().await;
    let app = api::router(s.clone());
    // Forty devices that can check in.
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for n in 0..40 {
        let id = uuid::Uuid::new_v4().to_string();
        let name = format!("store-{n:02}");
        let d = json!({"id":id,"name":name,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"labels":{},"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&name)
            .bind(d.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at,signing_key_id) VALUES(?,?,?,?)")
            .bind(format!("credential-{id}"))
            .bind(&id)
            .bind((chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .bind(s.keys.active_signing_id())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    // Two versions with identical runtime bytes: the second only moved nodes.
    let (_, pipeline, _) = call(
        app.clone(),
        "POST",
        "/api/v1/configurations",
        json!({"name":"Shared bytes","graph":graph(),"config":config()}),
        &cookie,
        &csrf,
    )
    .await;
    let id = pipeline["id"].as_str().unwrap().to_owned();
    let (_, first, _) = call(
        app.clone(),
        "POST",
        &format!("/api/v1/configurations/{id}/publish"),
        json!({"revision":pipeline["revision"],"message":"v1"}),
        &cookie,
        &csrf,
    )
    .await;
    let (_, draft, _) = call(
        app.clone(),
        "PUT",
        &format!("/api/v1/configurations/{id}/draft"),
        json!({"revision":pipeline["revision"],"graph":moved(99),"config":config()}),
        &cookie,
        &csrf,
    )
    .await;
    let (_, second, _) = call(
        app.clone(),
        "POST",
        &format!("/api/v1/configurations/{id}/publish"),
        json!({"revision":draft["revision"],"message":"v2"}),
        &cookie,
        &csrf,
    )
    .await;
    let digest = first["sha256"].as_str().unwrap().to_owned();
    assert_eq!(second["sha256"], digest);
    let deploy = |version: &Value, priority: i64| json!({"version_id":version["id"],"priority":priority,"target_mode":"snapshot","selector":{"device_ids":ids,"group_ids":[],"exclude_ids":[]},"rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0}});
    for (version, priority) in [(&first, 10), (&second, 20)] {
        let (status, created, _) = call(
            app.clone(),
            "POST",
            "/api/v1/deployments",
            deploy(version, priority),
            &cookie,
            &csrf,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
    }
    let blobs: i64 = sqlx::query_scalar("SELECT count(*) FROM artifact_blobs")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(blobs, 1, "one blob for 40 devices and two versions");
    let references: Vec<(String, i64)> =
        sqlx::query_as("SELECT sha256,count(*) FROM desired_artifacts GROUP BY sha256")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        references,
        [(digest.clone(), 80)],
        "each device's two generations reference the one blob"
    );
    // Every device is told the same digest and receives the same bytes.
    for id in &ids {
        let app = device::router(s.clone()).layer(Extension(device::PeerCertificate(Some(
            format!("credential-{id}"),
        ))));
        let heartbeat = json!({"protocol_version":1,"request_id":"r","boot_id":"b","nonce":STANDARD.encode([3;32]),"agent_version":"test","vector_version":"0.58.0","reported_generation":0,"policy_generation":0,"actual_sha256":"","apply_state":"desired","local_paused":false,"remote_pause_acknowledged":false});
        let (status, envelope, _) = call(
            app.clone(),
            "POST",
            "/agent/v1/heartbeat",
            heartbeat,
            "",
            "",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{envelope}");
        let manifest: Value = serde_json::from_slice(
            &STANDARD
                .decode(envelope["payload"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["desired"]["version_id"], second["id"]);
        assert_eq!(manifest["desired"]["sha256"], digest);
        assert_eq!(
            manifest["desired"]["artifact_path"],
            format!("/agent/v1/artifacts/{digest}")
        );
        let (status, bytes) = download(app, &format!("/agent/v1/artifacts/{digest}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(db::hash(&bytes), digest, "{id}");
        assert_eq!(bytes, first["artifact"].as_str().unwrap().as_bytes());
    }
}
