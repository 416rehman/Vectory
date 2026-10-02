//! Tests gate publishing: a draft that carries pipeline tests runs them before
//! a version is made, and a test that failed, could not be built, or never ran
//! stops the publish unless the request acknowledges it.
use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    routing::post,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

struct Identity {
    id: String,
    cookie: String,
    csrf: String,
}
async fn identity(s: &State, role: &str) -> Identity {
    let id = db::id();
    let token = auth::random_secret();
    let csrf = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(format!("Test {role}"))
    .bind(role)
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
    Identity {
        id,
        cookie: format!("vectory_session={token}"),
        csrf,
    }
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    value: Value,
    actor: &Identity,
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("cookie", &actor.cookie)
        .header("x-csrf-token", &actor.csrf);
    let response = app
        .clone()
        .oneshot(request.body(Body::from(value.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

/// The isolated worker, as far as publishing sees it: it accepts every draft
/// and answers `/tests` with whatever the test has set (`null` is an outage).
struct Env {
    _temp: tempfile::TempDir,
    _worker: tokio::task::JoinHandle<()>,
    s: State,
    app: Router,
    /// Writes drafts; only an operator publishes.
    editor: Identity,
    operator: Identity,
    tests_reply: Arc<Mutex<Value>>,
    tests_calls: Arc<AtomicUsize>,
}
async fn env() -> Env {
    let tests_reply = Arc::new(Mutex::new(Value::Null));
    let tests_calls = Arc::new(AtomicUsize::new(0));
    let (reply, calls) = (tests_reply.clone(), tests_calls.clone());
    let worker = Router::new()
        .route(
            "/validate",
            post(|| async {
                Json(json!({"worker_protocol":2,"valid":true,"static_checked":true,"stubbed":[],"placeholders":[],"vector_version":"0.58.0","diagnostics":[]}))
            }),
        )
        .route(
            "/tests",
            post(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let reply = reply.lock().unwrap().clone();
                async move {
                    if reply.is_null() {
                        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})));
                    }
                    let mut reply = reply;
                    reply["worker_protocol"] = json!(2);
                    reply["vector_version"] = json!("0.58.0");
                    reply["placeholders"] = json!([]);
                    reply["diagnostics"] = reply.get("diagnostics").cloned().unwrap_or(json!([]));
                    (StatusCode::OK, Json(reply))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, worker).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-test-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Publish gate tests".into(),
        validation_url: Some(format!("http://{address}")),
        ..Default::default()
    })
    .await
    .unwrap();
    let editor = identity(&s, "editor").await;
    let operator = identity(&s, "operator").await;
    let app = api::router(s.clone());
    Env {
        _temp: temp,
        _worker: task,
        s,
        app,
        editor,
        operator,
        tests_reply,
        tests_calls,
    }
}
impl Env {
    fn worker_says(&self, reply: Value) {
        *self.tests_reply.lock().unwrap() = reply;
    }
    fn test_runs(&self) -> usize {
        self.tests_calls.load(Ordering::SeqCst)
    }
    async fn versions(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='version'")
            .fetch_one(&self.s.pool)
            .await
            .unwrap()
    }
    /// A saved draft carrying tests with these names (none for an empty list).
    async fn draft(&self, names: &[&str]) -> Value {
        let (status, created) = call(
            &self.app,
            "POST",
            "/api/v1/configurations",
            json!({"name":"Gate","description":"","config":base(),"graph":{"nodes":[],"edges":[]}}),
            &self.editor,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let mut config = base();
        if !names.is_empty() {
            config["tests"] = json!(names.iter().map(|name| test_case(name)).collect::<Vec<_>>());
        }
        let (status, saved) = call(
            &self.app,
            "PUT",
            &format!("/api/v1/configurations/{}/draft", created["id"].as_str().unwrap()),
            json!({"revision":created["revision"],"config":config,"graph":created["graph"],"name":"Gate","description":""}),
            &self.editor,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        saved
    }
    async fn publish(&self, draft: &Value, extra: Value) -> (StatusCode, Value) {
        self.publish_as(&self.operator, draft, extra).await
    }
    async fn publish_as(
        &self,
        actor: &Identity,
        draft: &Value,
        extra: Value,
    ) -> (StatusCode, Value) {
        let mut body = json!({"revision":draft["revision"],"message":""});
        for (key, value) in extra.as_object().unwrap() {
            body[key] = value.clone();
        }
        call(
            &self.app,
            "POST",
            &format!(
                "/api/v1/configurations/{}/publish",
                draft["id"].as_str().unwrap()
            ),
            body,
            actor,
        )
        .await
    }
    /// The stored audit rows of `configuration.publish` for a version.
    async fn publish_audit(&self, version: &str) -> Vec<Value> {
        sqlx::query("SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')='configuration.publish' AND json_extract(data,'$.target')=?")
            .bind(version)
            .fetch_all(&self.s.pool)
            .await
            .unwrap()
            .iter()
            .map(|row| serde_json::from_str(&row.get::<String, _>("data")).unwrap())
            .collect()
    }
}
fn base() -> Value {
    json!({"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["sample"]}}})
}
fn test_case(name: &str) -> Value {
    json!({"name":name,"inputs":[{"insert_at":"sample","type":"log","log_fields":{"message":"example"}}],"outputs":[{"extract_from":"sample","conditions":["true"]}]})
}
fn passed(name: &str) -> Value {
    json!({"name":name,"passed":true})
}
fn failed(name: &str) -> Value {
    json!({"name":name,"passed":false,"message":"assertion failed","detail":"SECRET-TEST-BODY payload"})
}
fn refused(name: &str) -> Value {
    json!({"name":name,"passed":false,"message":"Could not build this test: inputs[0]: unable to locate target transform 'nosuch'."})
}
fn verdicts(rows: Vec<Value>) -> Value {
    json!({"tests_run":true,"tests":rows})
}

#[tokio::test]
async fn passing_tests_publish_as_they_always_did() {
    let env = env().await;
    env.worker_says(verdicts(vec![passed("one"), passed("two")]));
    let draft = env.draft(&["one", "two"]).await;
    let (status, version) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(env.test_runs(), 1);
    assert_eq!(env.versions().await, 1);
    // The audit row is the plain one: nothing about tests was wrong.
    let audit = env.publish_audit(version["id"].as_str().unwrap()).await;
    assert_eq!(audit.len(), 1);
    assert!(audit[0].get("details").is_none(), "{}", audit[0]);
    // An acknowledgement that was not needed records nothing either.
    let again = env.draft(&["one", "two"]).await;
    let (status, version) = env
        .publish(&again, json!({"acknowledge_test_failures":true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    let audit = env.publish_audit(version["id"].as_str().unwrap()).await;
    assert!(audit[0].get("details").is_none(), "{}", audit[0]);
}

#[tokio::test]
async fn a_draft_without_tests_never_asks_the_worker_for_any() {
    let env = env().await;
    env.worker_says(verdicts(vec![failed("never asked")]));
    let draft = env.draft(&[]).await;
    let (status, version) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(env.test_runs(), 0);
    assert_eq!(env.versions().await, 1);
}

#[tokio::test]
async fn a_failing_test_stops_the_publish_with_its_results() {
    let env = env().await;
    env.worker_says(verdicts(vec![passed("one"), failed("two")]));
    let draft = env.draft(&["one", "two"]).await;
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["code"], "TESTS_FAILED");
    assert!(
        refusal["error"]["message"]
            .as_str()
            .unwrap()
            .contains("1 failed, 1 passed"),
        "{refusal}"
    );
    assert_eq!(
        refusal["counts"],
        json!({"passed":1,"failed":1,"refused":0,"not_run":0})
    );
    assert_eq!(refusal["tests_run"], true);
    let rows = refusal["tests"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], json!({"name":"one","passed":true}));
    assert_eq!(rows[1]["name"], "two");
    assert_eq!(rows[1]["passed"], false);
    assert_eq!(rows[1]["message"], "assertion failed");
    // Nothing was published, audited or changed.
    assert_eq!(env.versions().await, 0);
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM records WHERE kind='audit' AND json_extract(data,'$.action')='configuration.publish'",
    )
    .fetch_one(&env.s.pool)
    .await
    .unwrap();
    assert_eq!(audits, 0);
}

#[tokio::test]
async fn a_test_vector_refused_and_a_test_that_did_not_run_stop_the_publish() {
    let env = env().await;
    // Vector could not build the first test, so it ran nothing: the second is
    // reported as not run.
    env.worker_says(verdicts(vec![refused("first")]));
    let draft = env.draft(&["first", "second"]).await;
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["code"], "TESTS_FAILED");
    assert_eq!(
        refusal["counts"],
        json!({"passed":0,"failed":0,"refused":1,"not_run":1})
    );
    let rows = refusal["tests"].as_array().unwrap();
    assert_eq!(rows[0]["refused"], true);
    assert_eq!(rows[1]["not_run"], true);
    assert_eq!(rows[1]["message"], "Vector did not run this test.");
    assert_eq!(env.versions().await, 0);
}

#[tokio::test]
async fn tests_that_could_not_run_at_all_stop_the_publish() {
    let env = env().await;
    let draft = env.draft(&["one", "two"]).await;
    // The runner is down: 503 from the worker.
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["code"], "TESTS_FAILED");
    assert_eq!(refusal["tests_run"], false);
    assert_eq!(
        refusal["counts"],
        json!({"passed":0,"failed":0,"refused":0,"not_run":2})
    );
    // The worker answers but ran nothing and says nothing else.
    env.worker_says(json!({"tests_run":false,"tests":[]}));
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["counts"]["not_run"], 2);
    assert_eq!(env.versions().await, 0);
}

#[tokio::test]
async fn tests_vector_skipped_and_explained_do_not_stop_the_publish() {
    let env = env().await;
    // A program that calls out: the worker never sends it, says why, and a
    // device runs the tests for real.
    env.worker_says(json!({"tests_run":false,"tests":[],"diagnostics":[
        {"severity":"warning","code":"vrl_function_unavailable","message":"This program calls http_request, which sends network requests. The server never sends requests from samples or tests."}
    ]}));
    let draft = env.draft(&["calls out"]).await;
    let (status, version) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{version}");
    let audit = env.publish_audit(version["id"].as_str().unwrap()).await;
    assert!(audit[0].get("details").is_none(), "{}", audit[0]);
}

#[tokio::test]
async fn an_acknowledged_publish_goes_through_and_the_audit_records_the_counts_only() {
    let env = env().await;
    env.worker_says(verdicts(vec![
        passed("one"),
        failed("two"),
        refused("three"),
    ]));
    let draft = env.draft(&["one", "two", "three", "four"]).await;
    let (status, version) = env
        .publish(&draft, json!({"acknowledge_test_failures":true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(env.versions().await, 1);
    let audit = env.publish_audit(version["id"].as_str().unwrap()).await;
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0]["outcome"], "success");
    assert_eq!(audit[0]["actor"], env.operator.id);
    assert_eq!(
        audit[0]["details"],
        json!({
            "tests_failed": true,
            "tests_failed_count": 1,
            "tests_refused_count": 1,
            "tests_not_run_count": 1,
            "tests_passed_count": 1,
            "summary": "Published with failing tests: 1 failed, 1 couldn't be built, 1 didn't run, 1 passed."
        })
    );
    // Never a test's name or body.
    let stored = audit[0].to_string();
    for secret in [
        "SECRET-TEST-BODY",
        "assertion failed",
        "two",
        "three",
        "four",
    ] {
        assert!(!stored.contains(secret), "{secret} in {stored}");
    }
    // The audit page shows the same counts to a reader.
    let id = audit[0]["id"].as_str().unwrap();
    let (status, detail) = call(
        &env.app,
        "GET",
        &format!("/api/v1/audit/{id}"),
        Value::Null,
        &env.operator,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["details"]["tests_failed"], true);
    assert_eq!(detail["details"]["tests_failed_count"], 1);
    assert_eq!(detail["details"]["tests_refused_count"], 1);
    assert_eq!(detail["details"]["tests_not_run_count"], 1);
    assert_eq!(detail["details"]["tests_passed_count"], 1);
    assert!(
        detail["details"]["summary"]
            .as_str()
            .unwrap()
            .starts_with("Published with failing tests")
    );
}

#[tokio::test]
async fn the_acknowledgement_is_a_boolean_and_false_is_no_acknowledgement() {
    let env = env().await;
    env.worker_says(verdicts(vec![failed("one")]));
    let draft = env.draft(&["one"]).await;
    for bad in [json!("true"), json!(1), json!(null), json!({})] {
        let (status, error) = env
            .publish(&draft, json!({"acknowledge_test_failures":bad}))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
        assert_eq!(error["error"]["code"], "INVALID_INPUT");
    }
    let (status, refusal) = env
        .publish(&draft, json!({"acknowledge_test_failures":false}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(env.versions().await, 0);
}

#[tokio::test]
async fn only_operators_publish_and_a_refused_role_learns_nothing_about_the_tests() {
    let env = env().await;
    env.worker_says(verdicts(vec![failed("one")]));
    let draft = env.draft(&["one"]).await;
    for role in ["viewer", "editor"] {
        let actor = identity(&env.s, role).await;
        for extra in [json!({}), json!({"acknowledge_test_failures":true})] {
            let (status, denied) = env.publish_as(&actor, &draft, extra).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{role}: {denied}");
            assert_eq!(denied["error"]["code"], "FORBIDDEN");
            assert!(denied.get("tests").is_none(), "{denied}");
        }
    }
    assert_eq!(env.test_runs(), 0);
    let admin = identity(&env.s, "admin").await;
    let (status, refusal) = env.publish_as(&admin, &draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    let (status, version) = env
        .publish_as(&admin, &draft, json!({"acknowledge_test_failures":true}))
        .await;
    assert_eq!(status, StatusCode::OK, "{version}");
    let audit = env.publish_audit(version["id"].as_str().unwrap()).await;
    assert_eq!(audit[0]["actor"], admin.id);
    assert_eq!(audit[0]["details"]["tests_failed"], true);
}

#[tokio::test]
async fn the_refusal_is_bounded_however_much_the_worker_reports() {
    let env = env().await;
    let names: Vec<String> = (0..100).map(|n| format!("test {n:03}")).collect();
    let rows: Vec<Value> = names
        .iter()
        .map(|name| {
            json!({"name":name,"passed":false,"message":"assertion failed","detail":"d".repeat(3000),
                "outputs":[{"payload":"o".repeat(1500)}]})
        })
        .collect();
    env.worker_says(verdicts(rows));
    let refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let draft = env.draft(&refs).await;
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{}", refusal["error"]);
    let rows = refusal["tests"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    for row in rows {
        assert!(row["detail"].as_str().unwrap().len() <= 1003);
        assert!(row.get("outputs").is_none());
    }
    assert!(
        refusal.to_string().len() < 200_000,
        "{}",
        refusal.to_string().len()
    );
    assert_eq!(refusal["counts"]["failed"], 100);
}

#[tokio::test]
async fn an_invalid_draft_and_a_stale_revision_are_refused_before_any_test_runs() {
    let env = env().await;
    env.worker_says(verdicts(vec![failed("one")]));
    let draft = env.draft(&["one"]).await;
    let (status, stale) = env
        .publish(
            &json!({"id":draft["id"],"revision":draft["revision"].as_u64().unwrap() + 1}),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{stale}");
    assert_eq!(stale["error"]["code"], "STALE_REVISION");
    assert_eq!(env.test_runs(), 0);
    // A structurally invalid draft (a sink reading from nothing) is refused
    // with its problems, not with test results.
    let (status, saved) = call(
        &env.app,
        "PUT",
        &format!("/api/v1/configurations/{}/draft", draft["id"].as_str().unwrap()),
        json!({"revision":draft["revision"],"config":{"sources":{"sample":{"type":"demo_logs","format":"json"}},"sinks":{"out":{"type":"blackhole","inputs":["missing"]}},"tests":[test_case("one")]},"graph":draft["graph"],"name":"Gate","description":""}),
        &env.editor,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, invalid) = env.publish(&saved, json!({})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{invalid}");
    assert_eq!(invalid["error"]["code"], "VALIDATION_FAILED");
    assert!(invalid.get("tests").is_none());
    assert_eq!(env.test_runs(), 0);
}

#[tokio::test]
async fn a_keyed_publish_retries_with_the_acknowledgement_and_replays_without_running_tests() {
    let env = env().await;
    env.worker_says(verdicts(vec![failed("one")]));
    let draft = env.draft(&["one"]).await;
    let key = db::id();
    // The refusal creates nothing, so the same key can still publish.
    let (status, refusal) = env.publish(&draft, json!({"request_id":key})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    assert_eq!(refusal["error"]["code"], "TESTS_FAILED");
    let (status, lookup) = call(
        &env.app,
        "GET",
        &format!("/api/v1/configurations/publish-requests/{key}"),
        Value::Null,
        &env.operator,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{lookup}");
    assert_eq!(lookup["found"], false);
    let acknowledged = json!({"request_id":key,"acknowledge_test_failures":true});
    let (status, version) = env.publish(&draft, acknowledged.clone()).await;
    assert_eq!(status, StatusCode::OK, "{version}");
    assert_eq!(version["request_id"], json!(key));
    let runs = env.test_runs();
    // The identical retry returns the same version and never runs a test, even
    // though the tests still fail and the worker has since gone away.
    env.worker_says(Value::Null);
    let (status, replay) = env.publish(&draft, acknowledged).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], version["id"]);
    assert_eq!(env.test_runs(), runs);
    assert_eq!(env.versions().await, 1);
    assert_eq!(
        env.publish_audit(version["id"].as_str().unwrap())
            .await
            .len(),
        1
    );
    // The same key without the acknowledgement is a different request.
    let (status, conflict) = env.publish(&draft, json!({"request_id":key})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
    assert_eq!(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT");
}

#[tokio::test]
async fn the_test_route_and_the_gate_share_one_runner() {
    // Whatever the test route reports for a draft, the publish gate reads:
    // the rows the route sends are the rows the refusal lists.
    let env = env().await;
    env.worker_says(verdicts(vec![passed("one"), failed("two")]));
    let draft = env.draft(&["one", "two"]).await;
    let (status, reported) = call(
        &env.app,
        "POST",
        "/api/v1/configurations/test",
        json!({"config":draft["config"]}),
        &env.operator,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{reported}");
    let (status, refusal) = env.publish(&draft, json!({})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{refusal}");
    let names = |value: &Value| -> Vec<(String, bool)> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["name"].as_str().unwrap().to_owned(),
                    row["passed"].as_bool().unwrap(),
                )
            })
            .collect()
    };
    assert_eq!(names(&reported["tests"]), names(&refusal["tests"]));
    assert_eq!(env.test_runs(), 2);
}
