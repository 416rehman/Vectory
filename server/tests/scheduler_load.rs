//! The scheduler's work per tick depends on what is live, not on how many
//! rollouts ever finished. Work is counted in SQL statements and rows (from
//! sqlx's statement events), which a busy machine can't blur the way it
//! blurs wall time. This file holds a single test: the counting subscriber
//! is process-wide.
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use tracing_subscriber::layer::SubscriberExt;
use vectory_server::{Settings, State, db, initialize, rollout};

static STATEMENTS: AtomicU64 = AtomicU64::new(0);
static ROWS: AtomicU64 = AtomicU64::new(0);
static RECORD_WRITES: AtomicU64 = AtomicU64::new(0);

/// Counts every statement sqlx runs, the rows it returned, and the writes
/// to `records`.
struct Statements;
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Statements {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() != "sqlx::query" {
            return;
        }
        #[derive(Default)]
        struct Fields {
            summary: String,
            rows: u64,
        }
        impl tracing::field::Visit for Fields {
            fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
                if field.name() == "rows_returned" {
                    self.rows = value;
                }
            }
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name() == "summary" {
                    self.summary = value.to_owned();
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "summary" {
                    self.summary = format!("{value:?}");
                }
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        STATEMENTS.fetch_add(1, Ordering::SeqCst);
        ROWS.fetch_add(fields.rows, Ordering::SeqCst);
        let summary = fields.summary.to_ascii_lowercase();
        if summary.contains("update records") || summary.contains("insert into records") {
            RECORD_WRITES.fetch_add(1, Ordering::SeqCst);
        }
    }
}

struct Work {
    statements: u64,
    rows: u64,
    record_writes: u64,
    elapsed: std::time::Duration,
}
/// One steady-state tick: a warm-up tick first, then the counted one.
async fn tick(s: &State) -> Work {
    rollout::tick(s).await.unwrap();
    let (statements, rows, writes) = (
        STATEMENTS.load(Ordering::SeqCst),
        ROWS.load(Ordering::SeqCst),
        RECORD_WRITES.load(Ordering::SeqCst),
    );
    let started = std::time::Instant::now();
    rollout::tick(s).await.unwrap();
    Work {
        elapsed: started.elapsed(),
        statements: STATEMENTS.load(Ordering::SeqCst) - statements,
        rows: ROWS.load(Ordering::SeqCst) - rows,
        record_writes: RECORD_WRITES.load(Ordering::SeqCst) - writes,
    }
}
async fn devices(s: &State) -> Vec<String> {
    sqlx::query_scalar("SELECT json_array(id,assignment_id,desired_version_id,desired_generation,policy_assignment_id,policy_generation) FROM devices ORDER BY id")
        .fetch_all(&s.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn tick_work_does_not_grow_with_finished_rollouts() {
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(Statements))
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-scheduler-load-bootstrap".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Scheduler load".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    // A live fleet: twenty devices that haven't checked in, so both rollouts
    // stay active, which is when a tick has the most to look at.
    let mut tx = s.pool.begin().await.unwrap();
    let mut ids = Vec::new();
    for n in 0..20 {
        let id = format!("device-{n:02}");
        let data = json!({"id":id,"name":id,"os":"linux","arch":"amd64","vector_version":"0.58.0","agent_version":"test","apply_state":"unmanaged","reported_generation":0,"created_at":db::now()});
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,?)")
            .bind(&id)
            .bind(&id)
            .bind(data.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    db::insert(&mut tx,"version",&json!({"id":"version-a","configuration_id":"config","number":1,"artifact":"{}\n","sha256":db::hash("{}\n"),"size":3,"created_at":db::now()})).await.unwrap();
    db::insert(
        &mut tx,
        "group",
        &json!({"id":"fleet","name":"Fleet","description":"","device_ids":ids[..10],"created_at":db::now(),"revision":1}),
    )
    .await
    .unwrap();
    let rollout = json!({"kind":"all","canary_size":1,"batch_size":1,"observation_seconds":60,"failure_threshold":0});
    rollout::create(&mut tx, &json!({"version_id":"version-a","selector":{"device_ids":[],"group_ids":["fleet"],"exclude_ids":[]},"priority":10,"target_mode":"persistent","rollout":rollout}), "operator").await.unwrap();
    rollout::create(&mut tx, &json!({"version_id":"version-a","selector":{"device_ids":ids[10..],"group_ids":[],"exclude_ids":[]},"priority":10,"target_mode":"snapshot","rollout":rollout}), "operator").await.unwrap();
    tx.commit().await.unwrap();
    let live = tick(&s).await;
    let assigned = devices(&s).await;

    // Five hundred rollouts finish over the life of the instance: replaced
    // ones whose targets were all removed, cancelled ones that never
    // released, and assignments that were removed.
    let mut tx = s.pool.begin().await.unwrap();
    for n in 0..500 {
        let (status, state, generation) = match n % 5 {
            0..=2 => ("completed", "removed", 3),
            3 => ("cancelled", "pending", 0),
            _ => ("unassigned", "removed", 2),
        };
        let id = format!("00000000-0000-4000-8000-{n:012}");
        let device = &ids[n % ids.len()];
        db::insert(&mut tx, "deployment", &json!({"id":id,"name":format!("Rollout {n}"),"version_id":"version-a","selector":{"device_ids":[device],"group_ids":[],"exclude_ids":[]},"priority":10,"target_mode":"snapshot","rollout":rollout,"status":status,"created_at":format!("2026-01-01T00:{:02}:{:02}Z",n/60,n%60)})).await.unwrap();
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,released_at) VALUES(?,?,?,?,?)")
            .bind(&id)
            .bind(device)
            .bind(state)
            .bind(generation)
            .bind((generation > 0).then(db::now))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    let with_history = tick(&s).await;
    eprintln!(
        "tick with 2 live rollouts: {} statements, {} rows, {} record writes, {:?}",
        live.statements, live.rows, live.record_writes, live.elapsed
    );
    eprintln!(
        "same with 500 finished rollouts: {} statements, {} rows, {} record writes, {:?}",
        with_history.statements,
        with_history.rows,
        with_history.record_writes,
        with_history.elapsed
    );
    assert_eq!(devices(&s).await, assigned, "history changes no assignment");
    assert_eq!(
        (with_history.statements, with_history.rows),
        (live.statements, live.rows),
        "finished rollouts add no work to a tick"
    );
    assert_eq!(
        live.record_writes, 0,
        "a rollout with nothing to release isn't rewritten every tick"
    );
    assert_eq!(with_history.record_writes, 0);
}
