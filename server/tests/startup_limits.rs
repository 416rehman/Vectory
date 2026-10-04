//! The limits that decide how much the server keeps and accepts stop it at
//! startup, before it opens anything, when they hold something that is not a
//! whole number in their range. They are never replaced by another value.
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

const SECRET: &str = "isolated-startup-limits-secret-123456789";

/// The real server in development mode with its state under `temp`, and the
/// given variable set. Its output goes to `server.log` there.
fn spawn(temp: &Path, variable: &str, value: &str) -> Child {
    let log = std::fs::File::create(temp.join("server.log")).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_vectory-server"));
    command.env_clear();
    // Winsock providers may need SystemRoot to load their DLLs on Windows.
    #[cfg(windows)]
    if let Ok(root) = std::env::var("SystemRoot") {
        command.env("SystemRoot", root);
    }
    command
        .env("VECTORY_DATA_DIR", temp.join("state"))
        .env("VECTORY_HTTP_ADDR", "127.0.0.1:0")
        .env("VECTORY_BOOTSTRAP_SECRET", SECRET)
        .env("VECTORY_COOKIE_SECURE", "false")
        .env("VECTORY_DEVELOPMENT", "true")
        .env("VECTORY_DASHBOARD_DIR", temp.join("dist"))
        .env("VECTORY_RELEASES_DIR", temp.join("releases"))
        .env(variable, value)
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .stdin(Stdio::null())
        .spawn()
        .unwrap()
}
fn log(temp: &Path) -> String {
    std::fs::read_to_string(temp.join("server.log")).unwrap_or_default()
}

#[test]
fn a_limit_that_is_not_a_whole_number_in_its_range_stops_the_server_before_it_opens_anything() {
    let cases = [
        (
            "VECTORY_TELEMETRY_RETENTION_DAYS",
            "from 1 to 30",
            ["90", "0", "x", "30d"],
        ),
        (
            "VECTORY_MAX_AGENT_CONNECTIONS",
            "from 64 to 65536",
            ["63", "70000", "x", "30d"],
        ),
    ];
    for (variable, range, value) in cases
        .into_iter()
        .flat_map(|(variable, range, values)| values.map(move |value| (variable, range, value)))
    {
        let temp = tempfile::tempdir().unwrap();
        let mut child = spawn(temp.path(), variable, value);
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break Some(status);
            }
            if started.elapsed() > Duration::from_secs(20) {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let output = log(temp.path());
        let status = status
            .unwrap_or_else(|| panic!("{variable}={value} did not stop the server: {output}"));
        assert!(!status.success(), "{variable}={value}: {output}");
        let sentence = format!("{variable} must be a whole number");
        assert!(output.contains(&sentence), "{variable}={value}: {output}");
        assert!(
            output.contains(range) && output.contains(&format!("not {value:?}")),
            "the sentence names the range and the value: {output}"
        );
        assert!(
            !temp.path().join("state/vectory.db").exists(),
            "{variable}={value}: the server opened its database before refusing"
        );
    }
}

#[test]
fn a_limit_in_its_range_lets_the_server_start() {
    for (variable, value) in [
        ("VECTORY_TELEMETRY_RETENTION_DAYS", "30"),
        ("VECTORY_MAX_AGENT_CONNECTIONS", "64"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let mut child = spawn(temp.path(), variable, value);
        let started = Instant::now();
        let mut ready = false;
        while started.elapsed() < Duration::from_secs(30) {
            if log(temp.path()).contains("dashboard listener ready") {
                ready = true;
                break;
            }
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let output = log(temp.path());
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            ready,
            "{variable}={value} did not start the server: {output}"
        );
        assert!(temp.path().join("state/vectory.db").exists());
    }
}
