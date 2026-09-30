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
