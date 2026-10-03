//! The download of a release file on the agent listener: authorized by the
//! offer a device holds, streamed from the release store with its digest
//! checked as it goes, and limited per device and for the server.
use super::support::*;
use axum::{
    Extension,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{db, device};

/// The transfers of release files share one limit for the whole process, which
/// is what these tests probe: they take turns.
static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct World {
    f: Fixture,
    key: String,
    release: Value,
    devices: Vec<String>,
    sha256: String,
    bytes: Vec<u8>,
}

/// A server that has prepared the release of 0.1.1 (one file, `size` bytes) and
/// released it to `devices` devices that run 0.1.0.
async fn world(devices: usize, size: usize) -> World {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    let bytes: Vec<u8> = (0..size).map(|n| (n * 7 % 251) as u8).collect();
    mirror(&f, &[("0.1.1", "linux", "amd64", bytes.clone())]);
    let release = prepare(&f, "0.1.1").await;
    let sha256 = release["artifacts"][0]["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut ids = Vec::new();
    for n in 0..devices {
        let id = device(&f, &format!("edge-{n:02}"), "0.1.0").await;
        store(&f, &id, &member(&[&key])).await;
        ids.push(id);
    }
    let refs: Vec<&String> = ids.iter().collect();
    start(
        &f,
        release["id"].as_str().unwrap(),
        &refs,
        json!({"canary_size":devices.max(1) as i64,"batch_size":50}),
    )
    .await;
    step(&f, Utc::now()).await;
    World {
        f,
        key,
        release,
        devices: ids,
        sha256,
        bytes,
    }
}

async fn fetch(f: &Fixture, device: &str, sha256: &str) -> Response {
    agent(f, device)
        .oneshot(
            Request::builder()
                .uri(format!("/agent/v1/agent-releases/{sha256}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn error_code(response: Response) -> (StatusCode, Option<String>, Option<String>) {
    let status = response.status();
    let retry = response
        .headers()
        .get("retry-after")
        .map(|v| v.to_str().unwrap().to_owned());
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let code = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["error"]["code"].as_str().map(str::to_owned));
    (status, code, retry)
}
async fn body(response: Response) -> Result<Vec<u8>, axum::Error> {
    response
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes().to_vec())
}
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
}

#[tokio::test]
async fn a_device_that_holds_the_offer_gets_exactly_the_build() {
    let _turn = TURN.lock().await;
    let w = world(1, 200_000).await;
    let response = fetch(&w.f, &w.devices[0], &w.sha256).await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers["content-type"], "application/octet-stream");
    assert_eq!(headers["content-length"], w.bytes.len().to_string());
    assert_eq!(headers["cache-control"], "no-store");
    for name in [
        "etag",
        "location",
        "accept-ranges",
        "content-range",
        "content-disposition",
    ] {
        assert!(!headers.contains_key(name), "{name}");
    }
    assert_eq!(body(response).await.unwrap(), w.bytes);
    // It is what the manifest named: the same digest, from the store.
    assert_eq!(db::hash(&w.bytes), w.sha256);
    // A range is never honoured: the whole file again.
    let ranged = agent(&w.f, &w.devices[0])
        .oneshot(
            Request::builder()
                .uri(format!("/agent/v1/agent-releases/{}", w.sha256))
                .header("range", "bytes=100-")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ranged.status(), StatusCode::OK);
    assert_eq!(body(ranged).await.unwrap().len(), w.bytes.len());
}

#[tokio::test]
async fn the_build_comes_from_the_store_whatever_became_of_the_catalog() {
    let _turn = TURN.lock().await;
    let w = world(1, 60_000).await;
    // The mirror the release was made from is emptied, and another build takes
    // its place.
    let dir = w.f.temp.path().join("releases");
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        std::fs::remove_file(entry.path()).unwrap();
    }
    mirror(&w.f, &[("0.1.2", "linux", "amd64", vec![1u8; 10])]);
    let id = w.release["id"].as_str().unwrap();
    // The release is what it was, with its file in the store, and the catalog
    // no longer holds its version.
    let shown = ok(
        &w.f,
        "GET",
        &format!("/api/v1/agent-releases/{id}"),
        Value::Null,
        &w.f.viewer,
    )
    .await;
    for member in [
        "id",
        "version",
        "counter",
        "manifest_sha256",
        "artifacts",
        "state",
    ] {
        assert_eq!(shown[member], w.release[member], "{member}");
    }
    assert_eq!(shown["state"], "ready");
    let setting = ok(
        &w.f,
        "GET",
        "/api/v1/agent-updates",
        Value::Null,
        &w.f.viewer,
    )
    .await;
    let versions: Vec<&str> = setting["catalog"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["version"].as_str().unwrap())
        .collect();
    assert_eq!(versions, ["0.1.2"], "{setting}");
    // The device is still offered the file and gets exactly the bytes it was
    // offered, from the store.
    let response = fetch(&w.f, &w.devices[0], &w.sha256).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await.unwrap(), w.bytes);
    // The prune keeps what a release names.
    vectory_server::rollout::prune(&w.f.state).await.unwrap();
    let again = fetch(&w.f, &w.devices[0], &w.sha256).await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(body(again).await.unwrap(), w.bytes);
}

#[tokio::test]
async fn nothing_is_served_without_a_current_offer_for_that_digest() {
    let _turn = TURN.lock().await;
    let w = world(2, 50_000).await;
    let (offered, bystander) = (
        w.devices[0].clone(),
        device(&w.f, "bystander", "0.1.0").await,
    );
    store(&w.f, &bystander, &member(&[&w.key])).await;
    // A digest no release names: not found; a malformed one too.
    for sha in [
        db::hash("nothing"),
        "A".repeat(64),
        "abc".to_owned(),
        "g".repeat(64),
    ] {
        let (status, code, _) = error_code(fetch(&w.f, &offered, &sha).await).await;
        assert_eq!(
            (status, code.as_deref()),
            (StatusCode::NOT_FOUND, Some("NOT_FOUND")),
            "{sha}"
        );
    }
    // A device with no offer, however real the digest.
    let (status, code, _) = error_code(fetch(&w.f, &bystander, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::FORBIDDEN, Some("FORBIDDEN"))
    );
    // The offered device asking for a digest it was not offered: another release's file.
    let other = release(&w.f, "0.1.2", 90, &w.key, &[("linux", "arm64")]).await;
    let (status, _, _) =
        error_code(fetch(&w.f, &offered, &other.sha256("linux", "arm64")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // No certificate, a revoked device and an unknown credential.
    let unauthenticated = device::router(w.f.state.clone())
        .layer(Extension(device::PeerCertificate(None)))
        .oneshot(
            Request::builder()
                .uri(format!("/agent/v1/agent-releases/{}", w.sha256))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
    let revoked = w.devices[1].clone();
    revoke(&w.f, &revoked).await;
    assert_eq!(
        fetch(&w.f, &revoked, &w.sha256).await.status(),
        StatusCode::UNAUTHORIZED
    );
    // And while it holds the offer it is served.
    assert_eq!(
        fetch(&w.f, &offered, &w.sha256).await.status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn what_takes_the_offer_away_takes_the_download_away() {
    let _turn = TURN.lock().await;
    let w = world(1, 30_000).await;
    let device = w.devices[0].clone();
    let rollout: String = sqlx::query_scalar("SELECT id FROM agent_update_rollouts")
        .fetch_one(&w.f.state.pool)
        .await
        .unwrap();
    let served = |status: StatusCode| async move { assert_eq!(status, StatusCode::OK) };
    served(fetch(&w.f, &device, &w.sha256).await.status()).await;
    // Paused: the offer is withdrawn.
    ok(
        &w.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/pause"),
        Value::Null,
        &w.f.operator,
    )
    .await;
    let (status, code, _) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::FORBIDDEN, Some("FORBIDDEN"))
    );
    ok(
        &w.f,
        "POST",
        &format!("/api/v1/agent-update-rollouts/{rollout}/resume"),
        Value::Null,
        &w.f.operator,
    )
    .await;
    step(&w.f, Utc::now()).await;
    served(fetch(&w.f, &device, &w.sha256).await.status()).await;
    // Stop all updates.
    let stopped = ok(
        &w.f,
        "POST",
        "/api/v1/agent-updates/stop",
        json!({"reason":"Hold"}),
        &w.f.operator,
    )
    .await;
    assert_eq!(
        fetch(&w.f, &device, &w.sha256).await.status(),
        StatusCode::FORBIDDEN
    );
    // A stopped server cancelled the rollout; start another to go on.
    ok(
        &w.f,
        "POST",
        "/api/v1/agent-updates/stop/clear",
        json!({"revision":stopped["revision"]}),
        &w.f.admin,
    )
    .await;
    let again = start(
        &w.f,
        w.release["id"].as_str().unwrap(),
        &[&device],
        json!({}),
    )
    .await;
    step(&w.f, Utc::now()).await;
    served(fetch(&w.f, &device, &w.sha256).await.status()).await;
    // A device that no longer reports a key that reaches the signer is not
    // offered, and not served.
    store(&w.f, &device, &member(&[&fingerprint("someone else")])).await;
    assert_eq!(
        fetch(&w.f, &device, &w.sha256).await.status(),
        StatusCode::FORBIDDEN
    );
    store(&w.f, &device, &member(&[&w.key])).await;
    served(fetch(&w.f, &device, &w.sha256).await.status()).await;
    // An expired release.
    sqlx::query("UPDATE agent_releases SET expires_at='2020-01-01T00:00:00Z'")
        .execute(&w.f.state.pool)
        .await
        .unwrap();
    assert_eq!(
        fetch(&w.f, &device, &w.sha256).await.status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("UPDATE agent_releases SET expires_at='2099-01-01T00:00:00Z'")
        .execute(&w.f.state.pool)
        .await
        .unwrap();
    // Cancelled.
    ok(
        &w.f,
        "POST",
        &format!(
            "/api/v1/agent-update-rollouts/{}/cancel",
            again["id"].as_str().unwrap()
        ),
        Value::Null,
        &w.f.operator,
    )
    .await;
    assert_eq!(
        fetch(&w.f, &device, &w.sha256).await.status(),
        StatusCode::FORBIDDEN
    );
    // A revoked key.
    let second = start(
        &w.f,
        w.release["id"].as_str().unwrap(),
        &[&device],
        json!({}),
    )
    .await;
    let _ = second;
    step(&w.f, Utc::now()).await;
    served(fetch(&w.f, &device, &w.sha256).await.status()).await;
    ok(
        &w.f,
        "POST",
        &format!("/api/v1/agent-release-keys/{}/revoke", w.key),
        json!({"reason":"Lost","current_password":PASSWORD}),
        &w.f.admin,
    )
    .await;
    assert_eq!(
        fetch(&w.f, &device, &w.sha256).await.status(),
        StatusCode::FORBIDDEN
    );
    // Updates off: the route is not there.
    switch(&w.f, false).await;
    let (status, code, _) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::NOT_FOUND, Some("NOT_FOUND"))
    );
}

#[tokio::test]
async fn a_download_never_waits_for_the_writer() {
    let _turn = TURN.lock().await;
    let w = world(1, 30_000).await;
    let held = w.f.state.writer.lock().await;
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fetch(&w.f, &w.devices[0], &w.sha256),
    )
    .await
    .expect("a read, not a write");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await.unwrap(), w.bytes);
    drop(held);
}

#[tokio::test]
async fn a_device_may_ask_six_times_an_hour_and_a_refusal_is_not_a_request_for_a_build() {
    let _turn = TURN.lock().await;
    let w = world(1, 20_000).await;
    let device = w.devices[0].clone();
    // Refused requests do not spend the hour's six.
    for _ in 0..20 {
        assert_eq!(
            fetch(&w.f, &device, &db::hash("unknown")).await.status(),
            StatusCode::NOT_FOUND
        );
    }
    for _ in 0..6 {
        let response = fetch(&w.f, &device, &w.sha256).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await.unwrap().len(), w.bytes.len());
        settle().await;
    }
    let (status, code, retry) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::TOO_MANY_REQUESTS, Some("RATE_LIMITED"))
    );
    assert!(
        retry.is_some_and(|seconds| seconds.parse::<u64>().unwrap() > 0),
        "Retry-After says when"
    );
    // Another device has its own budget.
    let other = device_with_offer(&w).await;
    assert_eq!(
        fetch(&w.f, &other, &w.sha256).await.status(),
        StatusCode::OK
    );
}
async fn device_with_offer(w: &World) -> String {
    let id = device(&w.f, "latecomer", "0.1.0").await;
    store(&w.f, &id, &member(&[&w.key])).await;
    let rollout = start(&w.f, w.release["id"].as_str().unwrap(), &[&id], json!({})).await;
    let _ = rollout;
    step(&w.f, Utc::now()).await;
    id
}

#[tokio::test]
async fn a_request_that_is_not_a_request_for_a_build_is_counted_too_but_generously() {
    let _turn = TURN.lock().await;
    let w = world(1, 20_000).await;
    let device = w.devices[0].clone();
    let mut last = StatusCode::OK;
    for _ in 0..61 {
        last = fetch(&w.f, &device, &db::hash("unknown")).await.status();
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS, "sixty a minute");
}

#[tokio::test]
async fn a_device_has_one_transfer_at_a_time() {
    let _turn = TURN.lock().await;
    // A file larger than the buffer between the disk and the connection, so the
    // transfer is still running while nobody reads it.
    let w = world(1, 1_500_000).await;
    let device = w.devices[0].clone();
    let first = fetch(&w.f, &device, &w.sha256).await;
    assert_eq!(first.status(), StatusCode::OK);
    settle().await;
    let (status, code, retry) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::TOO_MANY_REQUESTS, Some("RATE_LIMITED"))
    );
    assert!(retry.is_some());
    // Reading the first to its end frees the device's slot. The refused request
    // spent nothing from its hour.
    assert_eq!(body(first).await.unwrap().len(), w.bytes.len());
    settle().await;
    let again = fetch(&w.f, &device, &w.sha256).await;
    assert_eq!(again.status(), StatusCode::OK);
    drop(again);
    settle().await;
}

#[tokio::test]
async fn sixteen_transfers_at_once_is_the_most_the_server_streams() {
    let _turn = TURN.lock().await;
    let w = world(17, 1_500_000).await;
    let mut open = Vec::new();
    for device in &w.devices[..16] {
        let response = fetch(&w.f, device, &w.sha256).await;
        assert_eq!(response.status(), StatusCode::OK);
        open.push(response);
    }
    settle().await;
    let last = &w.devices[16];
    let (status, code, retry) = error_code(fetch(&w.f, last, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::TOO_MANY_REQUESTS, Some("CAPACITY_BUSY"))
    );
    assert!(retry.is_some());
    // A transfer that ends gives its place to the next; the turned-away device
    // spent nothing of its hour.
    drop(open.pop());
    settle().await;
    let response = fetch(&w.f, last, &w.sha256).await;
    assert_eq!(response.status(), StatusCode::OK);
    open.push(response);
    drop(open);
    settle().await;
    let counted = w.f.state.counted(&format!("agent-release:{last}"));
    assert_eq!(counted, 1, "one request for a build, not two");
}

#[tokio::test]
async fn a_file_that_changed_in_the_store_is_never_delivered_complete() {
    let _turn = TURN.lock().await;
    let w = world(1, 300_000).await;
    let device = w.devices[0].clone();
    let path =
        w.f.temp
            .path()
            .join("state/artifacts/agent-releases")
            .join(&w.sha256);
    // The same size, one byte different: the bytes stream, but the last chunk
    // is withheld, so the device never has a complete file under any name.
    let mut changed = w.bytes.clone();
    changed[1000] ^= 1;
    std::fs::write(&path, &changed).unwrap();
    let response = fetch(&w.f, &device, &w.sha256).await;
    assert_eq!(response.status(), StatusCode::OK);
    let received = response.into_body().collect().await;
    assert!(received.is_err(), "the transfer is cut off");
    settle().await;
    // Another size is refused before anything is sent.
    std::fs::write(&path, &w.bytes[..1000]).unwrap();
    let (status, code, _) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::CONFLICT, Some("CONFLICT"))
    );
    // A file that is not there is not found.
    std::fs::remove_file(&path).unwrap();
    let (status, code, _) = error_code(fetch(&w.f, &device, &w.sha256).await).await;
    assert_eq!(
        (status, code.as_deref()),
        (StatusCode::NOT_FOUND, Some("NOT_FOUND"))
    );
}
