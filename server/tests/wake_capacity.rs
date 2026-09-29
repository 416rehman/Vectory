//! Memory per parked wait at fleet size, measured with a counting allocator:
//! 10,000 waits parked through the real agent router, in process. It counts
//! what the server keeps for a parked wait (the registry entry and its shared
//! device key, the parked response body and its timer, and the per-device rate
//! limit key), not what a real listener adds per connection (TLS and HTTP
//! state), which the socket harness measures (docs/internal/CAPACITY.md).
use axum::{Extension, body::Body, http::Request, http::StatusCode};
use serde_json::json;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicIsize, Ordering},
    time::Duration,
};
use tower::ServiceExt;
use vectory_server::{Settings, db, device, initialize, wake};

struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);
// SAFETY: every call forwards to the system allocator unchanged; the counter
// only records sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        pointer
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let moved = unsafe { System.realloc(pointer, layout, size) };
        if !moved.is_null() {
            LIVE.fetch_add(size as isize - layout.size() as isize, Ordering::Relaxed);
        }
        moved
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;

const WAITERS: usize = 10_000;
const WARM: usize = 100;

#[tokio::test]
async fn ten_thousand_parked_waits_stay_small() {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-wake-capacity-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Wake capacity".into(),
        validation_url: None,
        wake: wake::Options {
            limit: 20_000,
            hold: Duration::from_secs(600),
        },
        ..Default::default()
    })
    .await
    .unwrap();
    let expires = (chrono::Utc::now() + chrono::Duration::days(1))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for i in 0..WAITERS + WARM {
        let id = format!("00000000-0000-4000-8000-{i:012}");
        let data = json!({"id":id,"name":format!("capacity-{i:05}"),"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","last_seen":db::now(),"apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(data["name"].as_str().unwrap())
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES(?,?,?)")
            .bind(format!("peer-{id}"))
            .bind(&id)
            .bind(&expires)
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    let router = device::router(s.clone());
    // The parked body is what a listener keeps once the response head has
    // gone out; the head itself is written and freed.
    let park = |id: String| {
        let router = router.clone();
        async move {
            let response = router
                .layer(Extension(device::PeerCertificate(Some(format!(
                    "peer-{id}"
                )))))
                .oneshot(
                    Request::get("/agent/v1/wait?generation=0&policy_generation=0")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            response.into_body()
        }
    };
    let mut warm = Vec::new();
    for id in &ids[WAITERS..] {
        warm.push(park(id.clone()).await);
    }
    let measure = |label: &str, before: isize| {
        let after = LIVE.load(Ordering::Relaxed);
        let per = (after - before) as f64 / WAITERS as f64;
        println!(
            "{label}: {WAITERS} parked waits hold {} bytes: {per:.0} bytes each",
            after - before
        );
        per
    };
    // Cold: the registry and the per-device rate limit keys grow.
    let before = LIVE.load(Ordering::Relaxed);
    let mut parked = Vec::with_capacity(WAITERS);
    let reserved = LIVE.load(Ordering::Relaxed) - before;
    for id in &ids[..WAITERS] {
        parked.push(park(id.clone()).await);
    }
    assert_eq!(s.wake.parked(), WAITERS + WARM);
    let cold = measure("first waits", before + reserved);
    // Steady state: the same devices wait again; the registry's table and the
    // rate limit keys already exist.
    drop(parked);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(s.wake.parked(), WARM);
    let before = LIVE.load(Ordering::Relaxed);
    let mut parked = Vec::with_capacity(WAITERS);
    let reserved = LIVE.load(Ordering::Relaxed) - before;
    for id in &ids[..WAITERS] {
        parked.push(park(id.clone()).await);
    }
    let steady = measure("waiting again", before + reserved);
    assert!(
        cold < 1024.0 && steady < 512.0,
        "a parked wait costs {cold:.0} bytes (first) and {steady:.0} bytes (again)"
    );
    // Shutdown answers every one of them.
    assert_eq!(s.wake.close(), WAITERS + WARM);
    for body in parked.into_iter().chain(warm).take(50) {
        let bytes = http_body_util::BodyExt::collect(body)
            .await
            .unwrap()
            .to_bytes();
        assert_eq!(bytes, br#"{"changed":false}"#.as_slice());
    }
}
