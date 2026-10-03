//! The audit rows a refused enrollment writes. The log is append-only and never
//! pruned, and anyone who can reach the enrollment route can be refused, so
//! what refusals add to it has a ceiling. A refusal that carries no real token
//! is written once per client and reason a minute, and one that carries a real
//! token once per token and reason a minute (see `device::enroll`). On top of
//! that every client together writes at most `REFUSAL_ROWS_PER_MINUTE` rows a
//! minute. The refusals past that are counted, and one row for the minute says
//! how many were not written. The counts live in memory and start again with
//! the server, like the request limits they sit beside.
use crate::{State, db, error::Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::time::Duration;

/// Rows every client together may add for refused enrollments in one UTC
/// minute, besides the one row that counts what the minute left out.
pub const REFUSAL_ROWS_PER_MINUTE: u32 = 60;
/// The action of the row that says how many refusals a minute did not write.
pub const SUMMARY_ACTION: &str = "device.enroll_refusals_summarized";
/// The counts of a minute outlive it, so the next minute (or the timer) can
/// settle it.
const KEEP: Duration = Duration::from_secs(300);

fn minute_of(at: DateTime<Utc>) -> i64 {
    at.timestamp().div_euclid(60)
}
fn key(kind: &str, minute: i64) -> String {
    format!("enrollment-audit-all:{kind}:{minute}")
}

/// Write the audit row of a refused enrollment, unless this minute's shared
/// budget is spent: then the refusal is counted for the minute's summary.
pub async fn record(s: &State, details: Value) -> Result<()> {
    record_at(s, details, Utc::now()).await
}

/// `record` at `now`, so a test can hold the minute still.
pub async fn record_at(s: &State, details: Value, now: DateTime<Utc>) -> Result<()> {
    let minute = minute_of(now);
    // The minute before says how many refusals it left out of the log. Its
    // row never holds this refusal back.
    let _ = settle(s, minute - 1).await;
    if s.limit(key("rows", minute), REFUSAL_ROWS_PER_MINUTE, KEEP)
        .is_err()
    {
        let first = s.counted(&key("over", minute)) == 0;
        let _ = s.limit(key("over", minute), u32::MAX, KEEP);
        // The last minute of a flood has no later refusal to settle it, so the
        // first refusal left out of the current minute sets a timer for its end.
        if first && minute == minute_of(Utc::now()) {
            let s = s.clone();
            let wait = 60 - Utc::now().timestamp().rem_euclid(60);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(u64::try_from(wait).unwrap_or(1) + 1)).await;
                let _ = settle(&s, minute).await;
            });
        }
        return Ok(());
    }
    let (_guard, mut tx) = db::write_tx(s).await?;
    db::insert(
        &mut tx,
        "audit",
        &json!({"id":db::id(),"actor":"anonymous","action":"device.enroll","target":"unregistered","outcome":"failure","created_at":db::now(),"details":details}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Say, once, how many refusals `minute` left out of the log. Nothing is
/// written when it left out none or the row was written already.
pub async fn settle(s: &State, minute: i64) -> Result<()> {
    let left_out = s.counted(&key("over", minute));
    if left_out == 0 || s.limit(key("said", minute), 1, KEEP).is_err() {
        return Ok(());
    }
    let from = DateTime::from_timestamp(minute * 60, 0)
        .map(|at| at.format("%H:%M").to_string())
        .unwrap_or_default();
    let summary = if left_out == 1 {
        format!("1 further refusal in the minute from {from} UTC was not written")
    } else {
        format!("{left_out} further refusals in the minute from {from} UTC were not written")
    };
    let (_guard, mut tx) = db::write_tx(s).await?;
    db::insert(
        &mut tx,
        "audit",
        &json!({"id":db::id(),"actor":"anonymous","action":SUMMARY_ACTION,"target":"unregistered","outcome":"failure","created_at":db::now(),"details":{"summary":summary}}),
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
