//! How many update rollouts can be open at once. Every rollout that is active is
//! read at each scheduler tick, under the writer lock the check-ins share, so
//! the number is bounded: an Operator cannot make the server too busy to answer
//! its fleet by starting rollouts.
use super::{engine::Rig, support::*};
use axum::http::StatusCode;
use serde_json::{Value, json};
use vectory_server::db;

const MESSAGE: &str =
    "At most 200 update rollouts can be active or paused at once. Cancel or finish one first.";

/// Rollouts in a status, written directly: reviewing a device each for two
/// hundred rollouts would show nothing more.
async fn insert(r: &Rig, status: &str, count: usize) {
    for _ in 0..count {
        sqlx::query("INSERT INTO agent_update_rollouts(id,release_id,selector,canary_size,batch_size,observation_seconds,failure_threshold,status,created_at) VALUES(?,?,'{}',1,10,300,0,?,?)")
            .bind(db::id())
            .bind(&r.release.id)
            .bind(status)
            .bind(db::now())
            .execute(&r.f.state.pool)
            .await
            .unwrap();
    }
}

/// The body that starts a rollout of one device, reviewed.
async fn body(r: &Rig, device: &String) -> Value {
    let review = preview(&r.f, &r.release.id, &[device], json!({})).await;
    let mut body = request(&r.release.id, &[device], json!({}));
    body["review_token"] = review["review_token"].clone();
    body
}
async fn create(r: &Rig, body: &Value) -> (StatusCode, Value) {
    let (status, _, value) = send(
        &r.f.app,
        "POST",
        "/api/v1/agent-update-rollouts",
        body.clone(),
        Some(&r.f.operator),
    )
    .await;
    (status, value)
}
async fn open(r: &Rig) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM agent_update_rollouts WHERE status IN ('active','paused')",
    )
    .fetch_one(&r.f.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn at_most_two_hundred_update_rollouts_are_active_or_paused_at_once() {
    let r = Rig::build(5).await;
    insert(&r, "active", 150).await;
    insert(&r, "paused", 47).await;
    // Rollouts that ended never count.
    for status in ["completed", "cancelled", "failed"] {
        insert(&r, status, 30).await;
    }
    assert_eq!(open(&r).await, 197);
    // The 198th is reviewed and started through the route.
    let first = r.start(&[&r.ids[0]], json!({})).await;
    // The 199th carries a request ID, so a retry can be told from a new request.
    let mut keyed = body(&r, &r.ids[1]).await;
    keyed["request_id"] = json!(uuid::Uuid::new_v4().to_string());
    let (status, keyed_rollout) = create(&r, &keyed).await;
    assert_eq!(status, StatusCode::OK, "{keyed_rollout}");
    assert_eq!(open(&r).await, 199);
    // The 200th is the last place.
    let (status, created) = create(&r, &body(&r, &r.ids[2]).await).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(open(&r).await, 200);
    let shown = ok(
        &r.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &r.f.viewer,
    )
    .await;
    assert_eq!(shown["active_rollouts"], 200);

    // One more is refused, and creates nothing.
    let more = body(&r, &r.ids[3]).await;
    let (status, refusal) = create(&r, &more).await;
    assert_eq!(
        (status, refusal["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("UPDATE_ROLLOUT_LIMIT")),
        "{refusal}"
    );
    assert_eq!(refusal["error"]["message"], MESSAGE);
    assert_eq!(open(&r).await, 200);
    let targets: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_update_targets WHERE device_id=?")
            .bind(&r.ids[3])
            .fetch_one(&r.f.state.pool)
            .await
            .unwrap();
    assert_eq!(targets, 0);
    // A retry of a request that already made its rollout answers with it.
    let (status, again) = create(&r, &keyed).await;
    assert_eq!(status, StatusCode::OK, "{again}");
    assert_eq!(again["id"], keyed_rollout["id"]);
    assert_eq!(open(&r).await, 200);

    // A paused rollout counts: pausing frees nothing.
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{first}/pause"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    assert_eq!(create(&r, &more).await.0, StatusCode::CONFLICT);
    // Cancelling one frees a place, and the next fills it again.
    ok(
        &r.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{first}/cancel"),
        Value::Null,
        &r.f.operator,
    )
    .await;
    assert_eq!(open(&r).await, 199);
    let (status, made) = create(&r, &more).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    assert_eq!(open(&r).await, 200);
    let (status, refusal) = create(&r, &body(&r, &r.ids[4]).await).await;
    assert_eq!(
        (status, refusal["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("UPDATE_ROLLOUT_LIMIT"))
    );
}
