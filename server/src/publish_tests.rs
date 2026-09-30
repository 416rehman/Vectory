//! Tests gate publishing. A draft that carries pipeline `tests` runs them in
//! the isolated worker, the same path `POST /configurations/test` uses, before
//! a version is made. A test that failed, that Vector could not read or build,
//! or that never ran stops the publish with `409 TESTS_FAILED` and the results,
//! unless the request acknowledges it with `acknowledge_test_failures: true`.
//! The audit row of an acknowledged publish says so and keeps the counts,
//! never the tests. A draft without tests, or whose tests all pass, publishes
//! as it always did.
use crate::{
    State,
    error::{ApiError, Result},
    validation,
};
use axum::http::StatusCode;
use serde_json::{Value, json};

/// Most test rows a refusal lists: the number the test route bounds a run to.
const MAX_ROWS: usize = 100;
/// Longest `detail` a row keeps in a refusal. The full text stays with
/// `POST /configurations/test`.
const MAX_DETAIL: usize = 1000;

/// What the tests came to. Every configured test lands in exactly one count.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counts {
    pub passed: usize,
    /// Vector ran it and it failed.
    pub failed: usize,
    /// Vector could not read or build it, so it never ran.
    pub refused: usize,
    /// Vector did not run it (another test stopped the run, or nothing ran).
    pub not_run: usize,
}
impl Counts {
    fn stopped(self) -> bool {
        self.failed + self.refused + self.not_run > 0
    }
    /// "1 failed, 1 couldn't be built, 1 didn't run, 2 passed".
    fn phrase(self) -> String {
        [
            (self.failed, "failed"),
            (self.refused, "couldn't be built"),
            (self.not_run, "didn't run"),
            (self.passed, "passed"),
        ]
        .iter()
        .filter(|(count, _)| *count > 0)
        .map(|(count, what)| format!("{count} {what}"))
        .collect::<Vec<_>>()
        .join(", ")
    }
}

/// One run of a draft's tests, read for the gate.
pub(crate) struct Outcome {
    /// One row per configured test, bounded, as the test route reports them.
    rows: Vec<Value>,
    counts: Counts,
    /// Vector ran the tests, so each row is its verdict.
    tests_run: bool,
}

/// `acknowledge_test_failures` from a publish request: absent is false.
pub(crate) fn acknowledged(request: &Value) -> Result<bool> {
    match request.get("acknowledge_test_failures") {
        None => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(ApiError::invalid(
            "acknowledge_test_failures must be true or false",
        )),
    }
}

/// Run the draft's tests for a publish. `None` when the draft has none, or when
/// Vector skipped them and said why (a program that calls out, or values only
/// a device has): nothing failed there, and the device runs them for real.
pub(crate) async fn run(s: &State, config: &Value) -> Result<Option<Outcome>> {
    if config["tests"].as_array().is_none_or(Vec::is_empty) {
        return Ok(None);
    }
    let reply = match validation::run_pipeline_tests(s, config).await {
        Ok(run) => run.reply,
        // No test runner (none configured, or it did not answer): the tests
        // did not run. A busy runner is the caller's to retry.
        Err(error) if error.code == "CAPABILITY_DENIED" => {
            return Ok(Some(Outcome::not_run(config, false)));
        }
        Err(error) => return Err(error),
    };
    Ok(Outcome::assess(config, &reply))
}

impl Outcome {
    /// Every configured test as one that did not run.
    fn not_run(config: &Value, tests_run: bool) -> Self {
        let rows = validation::complete_results(config, Vec::new());
        Self {
            counts: Counts {
                not_run: rows.len(),
                ..Counts::default()
            },
            rows: rows.iter().map(bounded).collect(),
            tests_run,
        }
    }

    /// The gate's reading of a test route reply.
    fn assess(config: &Value, reply: &Value) -> Option<Self> {
        let tests_run = reply["tests_run"] == true;
        let reported = reply["tests"].as_array().filter(|rows| !rows.is_empty());
        let Some(reported) = reported else {
            // No verdicts. A valid reply that says Vector skipped the tests is
            // a skip it explained; anything else is tests that did not run.
            return (reply["valid"] != true || tests_run).then(|| Self::not_run(config, tests_run));
        };
        let mut counts = Counts::default();
        for row in reported {
            if row["passed"] == true {
                counts.passed += 1;
            } else if row["not_run"] == true {
                counts.not_run += 1;
            } else if row["refused"] == true {
                counts.refused += 1;
            } else {
                counts.failed += 1;
            }
        }
        Some(Self {
            rows: reported.iter().take(MAX_ROWS).map(bounded).collect(),
            counts,
            tests_run,
        })
    }

    /// Whether a test failed, was refused, or did not run.
    pub(crate) fn blocks(&self) -> bool {
        self.counts.stopped()
    }

    /// Refuse the publish unless it acknowledges the failing tests.
    pub(crate) fn check(&self, acknowledged: bool) -> Result<()> {
        if !self.blocks() || acknowledged {
            return Ok(());
        }
        let counts = self.counts;
        Err(ApiError::new(
            StatusCode::CONFLICT,
            "TESTS_FAILED",
            format!(
                "Pipeline tests didn't pass ({}). Nothing was published. Fix them, or publish again with acknowledge_test_failures set to true.",
                counts.phrase()
            ),
        )
        .with_extra(json!({
            "tests": self.rows,
            "tests_run": self.tests_run,
            "counts": {"passed": counts.passed, "failed": counts.failed, "refused": counts.refused, "not_run": counts.not_run},
        })))
    }

    /// What the audit row of an acknowledged publish records: that tests were
    /// failing and how many of each kind. Never a test's name or body.
    pub(crate) fn audit_details(&self) -> Option<Value> {
        let counts = self.counts;
        self.blocks().then(|| {
            json!({
                "tests_failed": true,
                "tests_failed_count": counts.failed,
                "tests_refused_count": counts.refused,
                "tests_not_run_count": counts.not_run,
                "tests_passed_count": counts.passed,
                "summary": format!("Published with failing tests: {}.", counts.phrase()),
            })
        })
    }
}

/// A row as a refusal lists it: the verdict and its message, `detail` cut
/// short and no output payloads.
fn bounded(row: &Value) -> Value {
    let mut out = json!({"name": row["name"], "passed": row["passed"] == true});
    for flag in ["not_run", "refused"] {
        if row[flag] == true {
            out[flag] = json!(true);
        }
    }
    if let Some(message) = row["message"].as_str() {
        out["message"] = json!(message);
    }
    if let Some(detail) = row["detail"].as_str() {
        out["detail"] = json!(crate::vector_diagnostics::bounded(detail, MAX_DETAIL));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(names: &[&str]) -> Value {
        json!({"tests": names.iter().map(|name| json!({"name": name})).collect::<Vec<_>>()})
    }
    fn assess(config: &Value, reply: Value) -> Option<Outcome> {
        Outcome::assess(config, &reply)
    }

    #[test]
    fn every_test_lands_in_exactly_one_count() {
        let reply = json!({"valid": false, "tests_run": true, "tests": [
            {"name": "a", "passed": true},
            {"name": "b", "passed": false, "message": "assertion failed"},
            {"name": "c", "passed": false, "refused": true, "message": "Could not build this test: x."},
            {"name": "d", "passed": false, "not_run": true, "message": "Vector did not run this test."},
            {"name": "e", "passed": false, "not_run": true},
        ]});
        let outcome = assess(&config(&["a", "b", "c", "d", "e"]), reply).unwrap();
        assert_eq!(
            outcome.counts,
            Counts {
                passed: 1,
                failed: 1,
                refused: 1,
                not_run: 2
            }
        );
        assert!(outcome.blocks());
        assert_eq!(
            outcome.counts.phrase(),
            "1 failed, 1 couldn't be built, 2 didn't run, 1 passed"
        );
        assert_eq!(outcome.rows.len(), 5);
        assert_eq!(outcome.rows[2]["refused"], true);
        assert_eq!(outcome.rows[3]["not_run"], true);
    }

    #[test]
    fn passing_tests_never_block_and_record_nothing() {
        let reply = json!({"valid": true, "tests_run": true, "tests": [
            {"name": "a", "passed": true}, {"name": "b", "passed": true}
        ]});
        let outcome = assess(&config(&["a", "b"]), reply).unwrap();
        assert_eq!(outcome.counts.passed, 2);
        assert!(!outcome.blocks());
        assert!(outcome.check(false).is_ok());
        assert!(outcome.audit_details().is_none());
    }

    #[test]
    fn a_reply_without_verdicts_is_tests_that_did_not_run() {
        let two = config(&["a", "b"]);
        // The worker could not run them.
        let stuck = assess(
            &two,
            json!({"valid": false, "tests_run": false, "tests": []}),
        )
        .unwrap();
        assert_eq!(stuck.counts.not_run, 2);
        assert!(stuck.blocks());
        assert_eq!(stuck.rows[0]["message"], "Vector did not run this test.");
        // An older server that ran nothing yet said it did.
        let silent = assess(&two, json!({"valid": true, "tests_run": true, "tests": []})).unwrap();
        assert_eq!(silent.counts.not_run, 2);
        // A skip Vector explained (valid, nothing to retry) blocks nothing.
        assert!(
            assess(
                &two,
                json!({"valid": true, "tests_run": false, "tests": []})
            )
            .is_none()
        );
    }

    #[test]
    fn the_refusal_lists_the_results_and_the_counts_and_bounds_them() {
        let long = "x".repeat(5000);
        let reply = json!({"valid": false, "tests_run": true, "tests": [
            {"name": "a", "passed": false, "message": "assertion failed", "detail": long,
             "outputs": [{"message": "secret-looking payload"}]},
        ]});
        let outcome = assess(&config(&["a"]), reply).unwrap();
        let refusal = outcome.check(false).unwrap_err();
        assert_eq!(refusal.status, StatusCode::CONFLICT);
        assert_eq!(refusal.code, "TESTS_FAILED");
        assert!(refusal.message.contains("1 failed"), "{}", refusal.message);
        let extra = refusal.extra.unwrap();
        let row = &extra["tests"][0];
        assert_eq!(row["name"], "a");
        assert!(row["detail"].as_str().unwrap().len() < 1100);
        assert!(row.get("outputs").is_none());
        assert_eq!(
            extra["counts"],
            json!({"passed": 0, "failed": 1, "refused": 0, "not_run": 0})
        );
        assert_eq!(extra["tests_run"], true);
        // Acknowledging passes the same outcome, and the audit keeps counts only.
        assert!(outcome.check(true).is_ok());
        let details = outcome.audit_details().unwrap();
        assert_eq!(details["tests_failed"], true);
        assert_eq!(details["tests_failed_count"], 1);
        assert_eq!(
            details["summary"],
            "Published with failing tests: 1 failed."
        );
        assert!(!details.to_string().contains("assertion failed"));
        assert!(!details.to_string().contains("\"a\""));
    }

    #[test]
    fn the_flag_must_be_a_boolean() {
        assert!(!acknowledged(&json!({})).unwrap());
        assert!(acknowledged(&json!({"acknowledge_test_failures": true})).unwrap());
        assert!(!acknowledged(&json!({"acknowledge_test_failures": false})).unwrap());
        for bad in [json!("true"), json!(1), json!(null), json!([true])] {
            assert!(acknowledged(&json!({"acknowledge_test_failures": bad})).is_err());
        }
    }
}
