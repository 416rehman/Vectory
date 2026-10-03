//! Database upgrades: a migration that fails midway keeps nothing and leaves
//! the database at its previous version, and the server refuses to start with
//! a message that says where the database stands and what to do. A database a
//! newer server migrated, or one whose applied migration changed, is refused.
use serde_json::json;
use sqlx::{
    Row, SqlitePool,
    migrate::Migrator,
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
};
use std::borrow::Cow;
use vectory_server::{Settings, db, initialize};

fn settings(root: &std::path::Path) -> Settings {
    Settings {
        data_dir: root.join("state"),
        bootstrap_secret: "isolated-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: root.join("dist"),
        releases_dir: root.join("releases"),
        instance_name: "Test".into(),
        ..Default::default()
    }
}
async fn open(settings: &Settings) -> SqlitePool {
    std::fs::create_dir_all(&settings.data_dir).unwrap();
    SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(settings.data_dir.join("vectory.db"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true),
    )
    .await
    .unwrap()
}
/// Every schema object except the injected trigger, and every table's rows.
async fn snapshot(
    pool: &SqlitePool,
) -> (Vec<(String, String, Option<String>)>, Vec<(String, i64)>) {
    let schema: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT type,name,sql FROM sqlite_master WHERE name<>'fail_the_newest_migration' ORDER BY type,name",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    let mut rows = Vec::new();
    for (kind, name, _) in &schema {
        if kind == "table" && !name.starts_with("sqlite_") {
            let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM \"{name}\""))
                .fetch_one(pool)
                .await
                .unwrap();
            rows.push((name.clone(), count));
        }
    }
    (schema, rows)
}
async fn version(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_migration_that_fails_midway_keeps_nothing_and_the_server_refuses_to_start() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let shipped = sqlx::migrate!("./migrations");
    let newest = shipped.migrations.last().unwrap().clone();
    let previous = &shipped.migrations[shipped.migrations.len() - 2];
    // A database one migration behind this server, with representative rows.
    let behind = Migrator {
        migrations: Cow::Owned(shipped.migrations[..shipped.migrations.len() - 1].to_vec()),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    let pool = open(&settings).await;
    behind.run(&pool).await.unwrap();
    sqlx::query("INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('u','admin@example.test','Admin','admin','x',?)")
        .bind(db::now())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO devices(id,name,data) VALUES('d','edge-01',?)")
        .bind(json!({"id":"d","name":"edge-01","labels":{}}).to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('f','d','2099-01-01T00:00:00Z')")
        .execute(&pool)
        .await
        .unwrap();
    let mut conn = pool.acquire().await.unwrap();
    db::audit(&mut conn, "u", "bootstrap", "u", "success")
        .await
        .unwrap();
    drop(conn);
    let before = snapshot(&pool).await;
    assert_eq!(version(&pool).await, previous.version);
    // The newest migration's statements run, then its commit fails: the
    // failure lands after everything the migration changed.
    sqlx::query(&format!(
        "CREATE TRIGGER fail_the_newest_migration BEFORE INSERT ON _sqlx_migrations WHEN NEW.version={} BEGIN SELECT RAISE(ABORT,'disk full (injected)'); END",
        newest.version
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    for _ in 0..2 {
        let error = format!(
            "{:#}",
            initialize(settings.clone())
                .await
                .err()
                .expect("a failed migration must stop the server")
        );
        assert!(
            error.contains(&format!(
                "migration {} ({}) failed",
                newest.version, newest.description
            )) && error.contains("disk full (injected)")
                && error.contains(&format!("still at migration {}", previous.version))
                && error.contains("restore the backup you took before upgrading"),
            "{error}"
        );
    }
    let pool = open(&settings).await;
    assert_eq!(version(&pool).await, previous.version);
    assert_eq!(
        snapshot(&pool).await,
        before,
        "nothing of the failed migration remains"
    );
    let check: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(check, ["ok"]);

    // With the cause gone, the same server completes the upgrade.
    sqlx::query("DROP TRIGGER fail_the_newest_migration")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    let s = initialize(settings.clone()).await.unwrap();
    assert_eq!(version(&s.pool).await, newest.version);
    let row = sqlx::query("SELECT name FROM devices WHERE id='d'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(row.get::<String, _>("name"), "edge-01");
}

#[tokio::test]
async fn a_database_from_a_newer_server_is_refused_with_a_clear_message() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let s = initialize(settings.clone()).await.unwrap();
    sqlx::query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(99990101,'from a newer server',1,X'00',0)")
        .execute(&s.pool)
        .await
        .unwrap();
    s.pool.close().await;
    drop(s);
    let error = format!(
        "{:#}",
        initialize(settings.clone())
            .await
            .err()
            .expect("a newer database")
    );
    assert!(
        error.contains("upgraded by a newer Vectory")
            && error.contains("99990101")
            && error.contains("restore a backup taken before the upgrade"),
        "{error}"
    );
}

#[tokio::test]
async fn a_changed_applied_migration_is_refused() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let s = initialize(settings.clone()).await.unwrap();
    sqlx::query("UPDATE _sqlx_migrations SET checksum=X'00' WHERE version=1")
        .execute(&s.pool)
        .await
        .unwrap();
    s.pool.close().await;
    drop(s);
    let error = format!(
        "{:#}",
        initialize(settings)
            .await
            .err()
            .expect("an edited migration")
    );
    assert!(
        error.contains("Migration 1 (initial) in this database differs"),
        "{error}"
    );
}

/// Targets written before a rollout recorded what it replaced once: one that
/// had taken its device keeps what it recorded (even when that was nothing),
/// and one released behind a higher-priority assignment records when it takes
/// the device.
#[tokio::test]
async fn targets_that_already_took_their_device_keep_what_they_recorded() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let shipped = sqlx::migrate!("./migrations");
    let behind = Migrator {
        migrations: Cow::Owned(
            shipped
                .migrations
                .iter()
                .filter(|migration| migration.version < 135)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    let pool = open(&settings).await;
    behind.run(&pool).await.unwrap();
    for (id, assignment) in [
        ("d1", Some("dep-took")),
        ("d2", Some("dep-other")),
        ("d3", None),
    ] {
        sqlx::query("INSERT INTO devices(id,name,data,assignment_id) VALUES(?,?,'{}',?)")
            .bind(id)
            .bind(format!("edge-{id}"))
            .bind(assignment)
            .execute(&pool)
            .await
            .unwrap();
    }
    for (deployment, device, state, generation, previous) in [
        // Took its device; the device ran nothing managed before it.
        ("dep-took", "d1", "verified_applied", 2, None),
        // Recorded a version, and another assignment holds the device now.
        (
            "dep-with-previous",
            "d2",
            "verified_applied",
            4,
            Some("version-1"),
        ),
        // Released, but a higher-priority assignment still holds the device.
        ("dep-held", "d3", "desired", 1, None),
        ("dep-pending", "d1", "pending", 0, None),
        // Its device left: a fresh release records again.
        ("dep-left", "d2", "removed", 3, Some("version-1")),
    ] {
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,previous_version_id) VALUES(?,?,?,?,?)")
            .bind(deployment)
            .bind(device)
            .bind(state)
            .bind(generation)
            .bind(previous)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
    let s = initialize(settings).await.unwrap();
    let recorded: Vec<(String, i64)> = sqlx::query_as(
        "SELECT deployment_id,previous_recorded FROM deployment_targets ORDER BY deployment_id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        recorded,
        [
            ("dep-held".to_owned(), 0),
            ("dep-left".to_owned(), 0),
            ("dep-pending".to_owned(), 0),
            ("dep-took".to_owned(), 1),
            ("dep-with-previous".to_owned(), 1),
        ]
    );
}

/// Update rollouts written before they could end as stalled or because their
/// release expired keep everything they recorded, and the table takes the new
/// endings and still refuses others. Its targets and request keys stay attached.
#[tokio::test]
async fn update_rollouts_keep_what_they_recorded_and_take_the_new_endings() {
    let temp = tempfile::tempdir().unwrap();
    let settings = settings(temp.path());
    let shipped = sqlx::migrate!("./migrations");
    let behind = Migrator {
        migrations: Cow::Owned(
            shipped
                .migrations
                .iter()
                .filter(|migration| migration.version < 139)
                .cloned()
                .collect(),
        ),
        ignore_missing: false,
        locking: true,
        no_tx: false,
    };
    let pool = open(&settings).await;
    behind.run(&pool).await.unwrap();
    for (id, name) in [("d1", "edge-01"), ("d2", "edge-02")] {
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,'{}')")
            .bind(id)
            .bind(name)
            .execute(&pool)
            .await
            .unwrap();
    }
    let release = db::id();
    sqlx::query("INSERT INTO agent_releases(id,version,counter,manifest,manifest_sha256,issued_at,expires_at,state,prepared_at) VALUES(?,'0.1.1',1,x'7b7d',?,?,?,'awaiting_signature',?)")
        .bind(&release)
        .bind(db::hash("0.1.1"))
        .bind(db::now())
        .bind(db::now())
        .bind(db::now())
        .execute(&pool)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (status, failure, cancel) in [
        ("failed", Some("data_plane"), None),
        ("cancelled", None, Some("key_revoked")),
        ("active", None, None),
    ] {
        let id = db::id();
        sqlx::query("INSERT INTO agent_update_rollouts(id,release_id,selector,canary_size,batch_size,observation_seconds,failure_threshold,status,failure_reason,cancel_reason,created_at) VALUES(?,?,'{}',1,10,300,0,?,?,?,?)")
            .bind(&id)
            .bind(&release)
            .bind(status)
            .bind(failure)
            .bind(cancel)
            .bind(db::now())
            .execute(&pool)
            .await
            .unwrap();
        ids.push(id);
    }
    for (rollout, device, state) in [(&ids[0], "d1", "rolled_back"), (&ids[2], "d2", "pending")] {
        sqlx::query("INSERT INTO agent_update_targets(rollout_id,device_id,device_name,state,created_at,updated_at) VALUES(?,?,'edge',?,?,?)")
            .bind(rollout)
            .bind(device)
            .bind(state)
            .bind(db::now())
            .bind(db::now())
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO agent_update_requests(actor_id,request_id,payload_sha256,rollout_id,created_at) VALUES('actor',?,?,?,?)")
        .bind(db::id())
        .bind(db::hash("payload"))
        .bind(&ids[2])
        .bind(db::now())
        .execute(&pool)
        .await
        .unwrap();
    let before: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id,status,failure_reason,cancel_reason FROM agent_update_rollouts ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    pool.close().await;

    let s = initialize(settings).await.unwrap();
    let after: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id,status,failure_reason,cancel_reason FROM agent_update_rollouts ORDER BY id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(after, before);
    let progressed: Vec<Option<String>> =
        sqlx::query_scalar("SELECT progressed_at FROM agent_update_rollouts")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert!(progressed.iter().all(Option::is_none));
    for (table, rows) in [("agent_update_targets", 2), ("agent_update_requests", 1)] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&s.pool)
            .await
            .unwrap();
        assert_eq!(count, rows, "{table}");
    }
    let broken: Vec<(String, i64, String, i64)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert!(broken.is_empty(), "{broken:?}");
    let check: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert_eq!(check, ["ok"]);
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_update_rollouts' AND name LIKE 'agent_update_rollouts_%' ORDER BY name",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        indexes,
        [
            "agent_update_rollouts_open",
            "agent_update_rollouts_recent",
            "agent_update_rollouts_release"
        ]
    );
    // The targets still belong to their rollout: it cannot be deleted from under
    // them.
    assert!(
        sqlx::query("DELETE FROM agent_update_rollouts WHERE id=?")
            .bind(&ids[2])
            .execute(&s.pool)
            .await
            .is_err()
    );
    // The new endings are accepted, and anything else is still refused.
    let insert = |status: &'static str,
                  failure: Option<&'static str>,
                  cancel: Option<&'static str>| {
        let pool = s.pool.clone();
        let release = release.clone();
        async move {
            sqlx::query("INSERT INTO agent_update_rollouts(id,release_id,selector,canary_size,batch_size,observation_seconds,failure_threshold,status,failure_reason,cancel_reason,created_at) VALUES(?,?,'{}',1,10,300,0,?,?,?,?)")
                .bind(db::id())
                .bind(release)
                .bind(status)
                .bind(failure)
                .bind(cancel)
                .bind(db::now())
                .execute(&pool)
                .await
        }
    };
    assert!(insert("failed", Some("stalled"), None).await.is_ok());
    assert!(
        insert("cancelled", None, Some("release_expired"))
            .await
            .is_ok()
    );
    for reason in ["threshold", "data_plane"] {
        assert!(
            insert("failed", Some(reason), None).await.is_ok(),
            "{reason}"
        );
    }
    for reason in ["operator", "stop", "key_revoked", "release_withdrawn"] {
        assert!(
            insert("cancelled", None, Some(reason)).await.is_ok(),
            "{reason}"
        );
    }
    assert!(insert("failed", Some("expired"), None).await.is_err());
    assert!(insert("cancelled", None, Some("stalled")).await.is_err());
}
