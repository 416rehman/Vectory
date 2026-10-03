//! A name someone writes appears in notifications, the audit log, exports and
//! headings, where a line break starts a line of its own and a direction
//! override reorders what follows. Every route that takes a name refuses those
//! characters with a sentence that names the field, keeps the stored record as
//! it was, and still accepts ordinary names in any script.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

const DEVICE: &str = "00000000-0000-4000-8000-000000000001";
/// Line breaks, control characters and text-direction controls, by code point.
const HOSTILE: [u32; 17] = [
    0x0a, 0x0d, 0x09, 0x1b, 0x7f, 0x85, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069,
];
const ORDINARY: &str = "Équipe d'astreinte (Zürich) 🙂 運用 — v2, 50% & more";

struct Who {
    cookie: String,
    csrf: String,
}
struct Fixture {
    _temp: tempfile::TempDir,
    app: Router,
    admin: Who,
    operator: Who,
    editor: Who,
}

async fn person(s: &State, role: &str) -> Who {
    let user = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&user)
    .bind(format!("{user}@example.invalid"))
    .bind(format!("Synthetic {role}"))
    .bind(role)
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
    Who {
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-names-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Isolated names".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let data = json!({"id":DEVICE,"name":"synthetic-device","os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
        .bind(DEVICE)
        .bind("synthetic-device")
        .bind(data.to_string())
        .execute(&s.pool)
        .await
        .unwrap();
    Fixture {
        admin: person(&s, "admin").await,
        operator: person(&s, "operator").await,
        editor: person(&s, "editor").await,
        app: api::router(s),
        _temp: temp,
    }
}
async fn call(
    f: &Fixture,
    who: &Who,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = f
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("cookie", &who.cookie)
                .header("x-csrf-token", &who.csrf)
                .body(Body::from(if body.is_null() {
                    String::new()
                } else {
                    body.to_string()
                }))
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
async fn ok(f: &Fixture, who: &Who, method: &str, path: &str, body: Value) -> Value {
    let (status, value) = call(f, who, method, path, body).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {value}");
    value
}
/// The refusal a hostile name gets from `label`: a 400 whose message names the
/// field, for the name with the character inside it and at either end.
async fn refused(
    f: &Fixture,
    who: &Who,
    method: &str,
    path: &str,
    label: &str,
    body: impl Fn(&str) -> Value,
) {
    for code in HOSTILE {
        let c = char::from_u32(code).unwrap();
        for name in [
            format!("Edge{c}intake"),
            format!("{c}Edge"),
            format!("Edge{c}"),
        ] {
            let (status, error) = call(f, who, method, path, body(&name)).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{method} {path} U+{code:04X}: {error}"
            );
            assert_eq!(
                error["error"]["message"],
                format!(
                    "Enter {label} without line breaks, control characters or text-direction overrides"
                ),
                "{method} {path} U+{code:04X}"
            );
        }
    }
}

fn pipeline() -> Value {
    json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"console","inputs":["sample"],"encoding":{"codec":"json"}}}})
}
fn graph() -> Value {
    json!({"nodes":[],"edges":[]})
}
fn settings() -> Value {
    json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true})
}
fn deployment(name: &str) -> Value {
    json!({"name":name,"policy":settings(),"selector":{"device_ids":[DEVICE],"group_ids":[],"exclude_ids":[]},"expected_device_ids":[DEVICE],"priority":100,"target_mode":"snapshot","scheduled_at":null,"rollout":{"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0}})
}

#[tokio::test]
async fn a_pipeline_name_is_one_line_when_it_is_created_saved_or_duplicated() {
    let f = fixture().await;
    let body =
        |name: &str| json!({"name":name,"description":"","config":pipeline(),"graph":graph()});
    refused(
        &f,
        &f.editor,
        "POST",
        "/api/v1/configurations",
        "a pipeline name",
        body,
    )
    .await;
    let created = ok(
        &f,
        &f.editor,
        "POST",
        "/api/v1/configurations",
        body("Edge intake"),
    )
    .await;
    let id = created["id"].as_str().unwrap();
    let draft = format!("/api/v1/configurations/{id}/draft");
    let save = |name: &str| json!({"revision":1,"name":name,"config":pipeline(),"graph":graph()});
    refused(&f, &f.editor, "PUT", &draft, "a pipeline name", save).await;
    let duplicate = format!("/api/v1/configurations/{id}/duplicate");
    refused(
        &f,
        &f.editor,
        "POST",
        &duplicate,
        "a pipeline name",
        |name| json!({"revision":1,"name":name}),
    )
    .await;
    // Nothing was saved or copied by any refusal.
    let stored = ok(
        &f,
        &f.editor,
        "GET",
        &format!("/api/v1/configurations/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(stored["name"], "Edge intake");
    assert_eq!(stored["revision"], 1);
    let all = ok(&f, &f.editor, "GET", "/api/v1/configurations", Value::Null).await;
    assert_eq!(all.as_array().unwrap().len(), 1);
    // Ordinary names in any script, with spaces and punctuation, are accepted.
    let renamed = ok(&f, &f.editor, "PUT", &draft, save(ORDINARY)).await;
    assert_eq!(renamed["name"], ORDINARY);
    let copy = ok(
        &f,
        &f.editor,
        "POST",
        &duplicate,
        json!({"revision":2,"name":format!("{ORDINARY} copy")}),
    )
    .await;
    assert_eq!(copy["name"], format!("{ORDINARY} copy"));
    let again = ok(
        &f,
        &f.editor,
        "POST",
        "/api/v1/configurations",
        body(ORDINARY),
    )
    .await;
    assert_eq!(again["name"], ORDINARY);
}

#[tokio::test]
async fn deployment_group_settings_and_token_names_are_one_line() {
    let f = fixture().await;
    let op = &f.operator;
    // Deployments, through the review and the request itself.
    refused(
        &f,
        op,
        "POST",
        "/api/v1/deployments",
        "a deployment name",
        deployment,
    )
    .await;
    refused(
        &f,
        op,
        "POST",
        "/api/v1/deployments/preview",
        "a deployment name",
        deployment,
    )
    .await;
    let after = ok(&f, op, "GET", "/api/v1/deployments", Value::Null).await;
    assert!(after.as_array().unwrap().is_empty(), "{after}");
    let made = ok(&f, op, "POST", "/api/v1/deployments", deployment(ORDINARY)).await;
    assert_eq!(made["name"], ORDINARY);
    // Groups.
    refused(
        &f,
        op,
        "POST",
        "/api/v1/groups",
        "a group name",
        |name| json!({"name":name,"description":"","device_ids":[]}),
    )
    .await;
    let group = ok(
        &f,
        op,
        "POST",
        "/api/v1/groups",
        json!({"name":ORDINARY,"description":"","device_ids":[]}),
    )
    .await;
    let path = format!("/api/v1/groups/{}", group["id"].as_str().unwrap());
    refused(
        &f,
        op,
        "PUT",
        &path,
        "a group name",
        |name| json!({"name":name,"description":"","device_ids":[],"revision":group["revision"]}),
    )
    .await;
    let renamed = ok(
        &f,
        op,
        "PUT",
        &path,
        json!({"name":format!("{ORDINARY} 2"),"description":"","device_ids":[],"revision":group["revision"]}),
    )
    .await;
    assert_eq!(renamed["name"], format!("{ORDINARY} 2"));
    // Saved agent settings.
    refused(
        &f,
        op,
        "POST",
        "/api/v1/policies",
        "a settings name",
        |name| json!({"name":name,"policy":settings()}),
    )
    .await;
    let saved = ok(
        &f,
        op,
        "POST",
        "/api/v1/policies",
        json!({"name":ORDINARY,"policy":settings()}),
    )
    .await;
    let path = format!("/api/v1/policies/{}", saved["id"].as_str().unwrap());
    refused(
        &f,
        op,
        "PUT",
        &path,
        "a settings name",
        |name| json!({"name":name,"policy":settings(),"revision":0}),
    )
    .await;
    let renamed = ok(
        &f,
        op,
        "PUT",
        &path,
        json!({"name":format!("{ORDINARY} 2"),"policy":settings(),"revision":0}),
    )
    .await;
    assert_eq!(renamed["name"], format!("{ORDINARY} 2"));
    // Enrollment tokens.
    refused(
        &f,
        op,
        "POST",
        "/api/v1/tokens",
        "a token name",
        |name| json!({"name":name,"expires_hours":1}),
    )
    .await;
    let token = ok(
        &f,
        op,
        "POST",
        "/api/v1/tokens",
        json!({"name":ORDINARY,"expires_hours":1}),
    )
    .await;
    assert_eq!(token["record"]["name"], ORDINARY);
}

#[tokio::test]
async fn a_person_name_is_one_line_and_a_channel_name_still_is() {
    let f = fixture().await;
    for code in HOSTILE {
        let c = char::from_u32(code).unwrap();
        let (status, error) = call(
            &f,
            &f.admin,
            "POST",
            "/api/v1/users",
            json!({"name":format!("Jane{c}Doe"),"email":"jane@example.test","password":"a-long-enough-passphrase-1","role":"viewer"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "U+{code:04X}: {error}");
        assert_eq!(error["error"]["code"], "NAME_INVALID", "U+{code:04X}");
        assert_eq!(
            error["error"]["message"],
            "Enter a name without line breaks, control characters or text-direction overrides.",
            "U+{code:04X}"
        );
    }
    let (status, error) = call(
        &f,
        &f.admin,
        "POST",
        "/api/v1/notifications/channels",
        json!({"name":"On\u{2028}call","kind":"webhook","webhook":{"url":"https://hooks.example.test/x"},"rules":{"events":["issue.opened"]}}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    assert_eq!(
        error["error"]["message"],
        "Enter a channel name without line breaks, control characters or text-direction overrides"
    );
}
