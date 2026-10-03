//! The agent update tables: what the database itself refuses, so no code path
//! can leave two keys signing at once, a ready release without a signature, or
//! a device in two update rollouts that have not ended for it.
use sqlx::SqlitePool;
use vectory_server::{Settings, db, initialize};

async fn pool() -> (tempfile::TempDir, SqlitePool) {
    let temp = tempfile::tempdir().unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Test".into(),
        ..Default::default()
    })
    .await
    .unwrap();
    (temp, state.pool.clone())
}

fn fingerprint(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

async fn key(pool: &SqlitePool, n: u8, state: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO agent_release_keys(fingerprint,public_key,custody,state,created_at) VALUES(?,?,?,?,?)")
        .bind(fingerprint(n))
        .bind(format!("vectory-release-key ed25519 key{n} test"))
        .bind("offline")
        .bind(state)
        .bind(db::now())
        .execute(pool)
        .await
        .map(|_| ())
}

async fn release(
    pool: &SqlitePool,
    version: &str,
    counter: i64,
    state: &str,
    signed: bool,
) -> Result<String, sqlx::Error> {
    let id = db::id();
    sqlx::query("INSERT INTO agent_releases(id,version,counter,manifest,manifest_sha256,signature,signer,issued_at,expires_at,state,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(version)
        .bind(counter)
        .bind(b"{}".to_vec())
        .bind(db::hash(format!("{version}:{counter}")))
        .bind(signed.then(|| b"signature".to_vec()))
        .bind(signed.then(|| fingerprint(1)))
        .bind(db::now())
        .bind(db::now())
        .bind(state)
        .bind(db::now())
        .execute(pool)
        .await?;
    Ok(id)
}

async fn device(pool: &SqlitePool, name: &str) -> String {
    let id = db::id();
    sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,'{}')")
        .bind(&id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn rollout(pool: &SqlitePool, release: &str) -> String {
    let id = db::id();
    sqlx::query("INSERT INTO agent_update_rollouts(id,release_id,selector,canary_size,batch_size,observation_seconds,failure_threshold,status,created_at) VALUES(?,?,'{}',1,10,300,0,'active',?)")
        .bind(&id)
        .bind(release)
        .bind(db::now())
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn target(
    pool: &SqlitePool,
    rollout: &str,
    device: &str,
    state: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO agent_update_targets(rollout_id,device_id,device_name,state,created_at,updated_at) VALUES(?,?,'edge',?,?,?)")
        .bind(rollout)
        .bind(device)
        .bind(state)
        .bind(db::now())
        .bind(db::now())
        .execute(pool)
        .await
        .map(|_| ())
}

#[tokio::test]
async fn updates_are_off_with_one_setting_row_and_no_key() {
    let (_temp, pool) = pool().await;
    let (enabled, custody, key, sequence, revision): (bool, Option<String>, Option<String>, i64, i64) =
        sqlx::query_as("SELECT enabled,custody,current_key,counter_sequence,revision FROM agent_update_settings WHERE id=1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!enabled && custody.is_none() && key.is_none());
    assert_eq!((sequence, revision), (0, 0));
    assert!(
        sqlx::query("INSERT INTO agent_update_settings(id) VALUES(2)")
            .execute(&pool)
            .await
            .is_err(),
        "the setting is one row"
    );
    let stop = sqlx::query("UPDATE agent_update_settings SET stopped_reason='why' WHERE id=1")
        .execute(&pool)
        .await;
    assert!(stop.is_err(), "a stop has a reason and a time together");
}

#[tokio::test]
async fn one_key_signs_at_a_time_and_a_key_names_its_statement_whole() {
    let (_temp, pool) = pool().await;
    key(&pool, 1, "current").await.unwrap();
    assert!(
        key(&pool, 2, "current").await.is_err(),
        "a second current key"
    );
    key(&pool, 2, "retired").await.unwrap();
    key(&pool, 3, "revoked").await.unwrap();
    key(&pool, 4, "retired").await.unwrap();
    // A fingerprint is 64 characters.
    assert!(
        sqlx::query("INSERT INTO agent_release_keys(fingerprint,public_key,custody,state,created_at) VALUES('short','k','offline','retired',?)")
            .bind(db::now())
            .execute(&pool)
            .await
            .is_err()
    );
    // A statement, its signature and the key it replaced come together.
    assert!(
        sqlx::query("UPDATE agent_release_keys SET introduced_from=? WHERE fingerprint=?")
            .bind(fingerprint(1))
            .bind(fingerprint(2))
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query("UPDATE agent_release_keys SET introduced_from=?,introduced_statement='s',introduced_signature='g' WHERE fingerprint=?")
        .bind(fingerprint(2))
        .bind(fingerprint(1))
        .execute(&pool)
        .await
        .unwrap();
    // The setting can name only a key that exists.
    assert!(
        sqlx::query("UPDATE agent_update_settings SET current_key=? WHERE id=1")
            .bind(fingerprint(9))
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query("UPDATE agent_update_settings SET current_key=?,custody='offline' WHERE id=1")
        .bind(fingerprint(1))
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_release_is_ready_only_with_a_signature_and_a_version_has_one_live_release() {
    let (_temp, pool) = pool().await;
    key(&pool, 1, "current").await.unwrap();
    assert!(
        release(&pool, "0.1.1", 1, "ready", false).await.is_err(),
        "ready needs a signature"
    );
    assert!(
        release(&pool, "0.1.1", 1, "awaiting_signature", true)
            .await
            .is_err(),
        "a signature that is awaited is not there yet"
    );
    let first = release(&pool, "0.1.1", 1, "awaiting_signature", false)
        .await
        .unwrap();
    assert!(
        release(&pool, "0.1.1", 2, "ready", true).await.is_err(),
        "one release of a version that is not withdrawn"
    );
    assert!(
        release(&pool, "0.1.2", 1, "ready", true).await.is_err(),
        "a counter is used once"
    );
    sqlx::query("UPDATE agent_releases SET state='withdrawn' WHERE id=?")
        .bind(&first)
        .execute(&pool)
        .await
        .unwrap();
    release(&pool, "0.1.1", 2, "ready", true).await.unwrap();
    release(&pool, "0.1.2", 3, "ready", true).await.unwrap();
}

#[tokio::test]
async fn a_device_is_in_one_update_rollout_that_has_not_ended_for_it() {
    let (_temp, pool) = pool().await;
    key(&pool, 1, "current").await.unwrap();
    let first_release = release(&pool, "0.1.1", 1, "ready", true).await.unwrap();
    let second_release = release(&pool, "0.1.2", 2, "ready", true).await.unwrap();
    let (first, second) = (
        rollout(&pool, &first_release).await,
        rollout(&pool, &second_release).await,
    );
    let (edge, other) = (
        device(&pool, "edge-01").await,
        device(&pool, "edge-02").await,
    );
    target(&pool, &first, &edge, "pending").await.unwrap();
    for open in [
        "pending",
        "offered",
        "downloading",
        "staged",
        "waiting_for_host",
        "waiting_for_window",
        "applying",
        "restarted",
    ] {
        assert!(
            target(&pool, &second, &edge, open).await.is_err(),
            "{open} is not an ended state"
        );
    }
    // The same device in another rollout once the first ended for it.
    target(&pool, &second, &other, "pending").await.unwrap();
    for ended in [
        "verified",
        "rolled_back",
        "refused",
        "failed",
        "cancelled",
        "skipped",
    ] {
        sqlx::query("UPDATE agent_update_targets SET state=? WHERE rollout_id=? AND device_id=?")
            .bind(ended)
            .bind(&first)
            .bind(&edge)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agent_update_targets WHERE rollout_id=? AND device_id=?")
            .bind(&second)
            .bind(&edge)
            .execute(&pool)
            .await
            .unwrap();
        target(&pool, &second, &edge, "pending").await.unwrap();
        sqlx::query("DELETE FROM agent_update_targets WHERE rollout_id=? AND device_id=?")
            .bind(&second)
            .bind(&edge)
            .execute(&pool)
            .await
            .unwrap();
    }
    // A target belongs to a rollout and a device that exist, in a known state.
    assert!(
        target(&pool, &db::id(), &edge, "verified").await.is_err(),
        "no such rollout"
    );
    assert!(
        target(&pool, &second, &db::id(), "pending").await.is_err(),
        "no such device"
    );
    assert!(
        target(&pool, &second, &edge, "installing").await.is_err(),
        "no such state"
    );
}

#[tokio::test]
async fn a_rollout_keeps_to_the_bounds_of_its_settings() {
    let (_temp, pool) = pool().await;
    key(&pool, 1, "current").await.unwrap();
    let release = release(&pool, "0.1.1", 1, "ready", true).await.unwrap();
    let insert = |canary: i64, batch: i64, seconds: i64, threshold: i64, status: &'static str| {
        let pool = pool.clone();
        let release = release.clone();
        async move {
            sqlx::query("INSERT INTO agent_update_rollouts(id,release_id,selector,canary_size,batch_size,observation_seconds,failure_threshold,status,created_at) VALUES(?,?,'{}',?,?,?,?,?,?)")
                .bind(db::id())
                .bind(release)
                .bind(canary)
                .bind(batch)
                .bind(seconds)
                .bind(threshold)
                .bind(status)
                .bind(db::now())
                .execute(&pool)
                .await
                .is_ok()
        }
    };
    assert!(insert(1, 10, 300, 0, "active").await);
    assert!(insert(100, 50, 60, 100, "paused").await);
    assert!(insert(101, 10, 300, 0, "active").await == false);
    assert!(insert(0, 10, 300, 0, "active").await == false);
    assert!(insert(1, 51, 300, 0, "active").await == false);
    assert!(insert(1, 10, 59, 0, "active").await == false);
    assert!(insert(1, 10, 86401, 0, "active").await == false);
    assert!(insert(1, 10, 300, 101, "active").await == false);
    assert!(insert(1, 10, 300, 0, "running").await == false);
}

#[tokio::test]
async fn a_report_is_one_valid_json_document_of_a_device_that_exists() {
    let (_temp, pool) = pool().await;
    let edge = device(&pool, "edge-00").await;
    let insert = |device: String, report: String| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO agent_update_reports(device_id,report,reported_at) VALUES(?,?,?)",
            )
            .bind(device)
            .bind(report)
            .bind(db::now())
            .execute(&pool)
            .await
            .is_ok()
        }
    };
    assert!(
        !insert(db::id(), "{}".into()).await,
        "a report is of a device the server knows"
    );
    assert!(!insert(edge.clone(), "not json".into()).await);
    assert!(
        !insert(edge.clone(), format!("{{\"x\":\"{}\"}}", "x".repeat(16384))).await,
        "at most 16 KiB"
    );
    assert!(insert(edge.clone(), "{}".into()).await);
    assert!(
        !insert(edge, "{}".into()).await,
        "one report for a device: the latest replaces it"
    );
}

#[tokio::test]
async fn a_release_keeps_what_its_manifest_says_about_the_hosts_it_needs() {
    let (_temp, pool) = pool().await;
    key(&pool, 1, "current").await.unwrap();
    let id = release(&pool, "0.1.1", 1, "ready", true).await.unwrap();
    let (min_from, definition): (Option<String>, i64) =
        sqlx::query_as("SELECT min_from,service_definition FROM agent_releases WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (min_from, definition),
        (None, 1),
        "any agent, the first definition"
    );
    let set = |min_from: Option<&'static str>, definition: i64| {
        let pool = pool.clone();
        let id = id.clone();
        async move {
            sqlx::query("UPDATE agent_releases SET min_from=?,service_definition=? WHERE id=?")
                .bind(min_from)
                .bind(definition)
                .bind(id)
                .execute(&pool)
                .await
                .is_ok()
        }
    };
    assert!(set(Some("0.1.0"), 2).await);
    assert!(set(None, 9_007_199_254_740_991).await);
    assert!(
        !set(Some("1.0"), 1).await,
        "a version has at least five characters"
    );
    assert!(!set(Some("0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"), 1).await);
    assert!(!set(None, 0).await, "the first definition is 1");
}
