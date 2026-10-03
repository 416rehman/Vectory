//! At start the server checks that the release key it holds can sign: with
//! updates on and server custody, the current key's sealed seed must be there
//! and open under the instance's sealing key. A database restored next to
//! another keys directory breaks that without any other sign until the first
//! release is prepared, so the server says so once, with the fix, and the
//! prune never removes another key's seed on the way.
use super::support::*;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use vectory_server::{Settings, State, db, initialize, rollout};

const FIX: &str =
    "Restore the keys directory from a backup that holds both the sealed key and the sealing key";

/// What the server logged, kept as text.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Log {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Log {
    type Writer = Log;
    fn make_writer(&'a self) -> Log {
        self.clone()
    }
}
impl Log {
    fn lines(&self) -> Vec<String> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

fn settings_of(temp: &Path) -> Settings {
    Settings {
        data_dir: temp.join("state"),
        bootstrap_secret: "unused-agent-update-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.join("dist"),
        releases_dir: temp.join("releases"),
        instance_name: "Synthetic agent update fixture".into(),
        validation_url: None,
        ..Default::default()
    }
}

/// Stops the fixture's server and starts another on the same state, with the
/// warnings the start logged.
async fn restart(f: Fixture) -> (tempfile::TempDir, State, Vec<String>) {
    let Fixture {
        temp, state, app, ..
    } = f;
    drop(app);
    state.pool.close().await;
    drop(state);
    let log = Log::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(log.clone())
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .finish();
    let state = {
        let _logging = tracing::subscriber::set_default(subscriber);
        initialize(settings_of(temp.path())).await.unwrap()
    };
    let lines = log
        .lines()
        .into_iter()
        .filter(|line| line.contains("release key"))
        .collect();
    (temp, state, lines)
}

fn sealed(temp: &Path, fingerprint: &str) -> PathBuf {
    temp.join("state/keys")
        .join(format!("agent-release-{fingerprint}.sealed"))
}

#[tokio::test]
async fn a_current_key_that_cannot_sign_is_said_once_at_start_and_nothing_is_pruned_first() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let fingerprint = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    // A database restored next to a newer keys directory: another key's seed is
    // there, and this one's is not.
    let newer = db::hash("a key a later state made current");
    let seed = sealed(f.temp.path(), &fingerprint);
    let stray = sealed(f.temp.path(), &newer);
    std::fs::copy(&seed, &stray).unwrap();
    std::fs::remove_file(&seed).unwrap();
    let (temp, state, warnings) = restart(f).await;
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains(FIX), "{}", warnings[0]);
    assert!(
        warnings[0].contains(&fingerprint[..16]),
        "it names the key: {}",
        warnings[0]
    );
    assert!(stray.exists(), "starting removed nothing");
    // The minute-by-minute prune would remove a seed that no current key owns:
    // not while the current key's own seed can't be read.
    rollout::prune(&state).await.unwrap();
    assert!(
        stray.exists(),
        "the newer state's seed is kept for the person who comes to fix this"
    );
    // With the key's file back, the prune does what it always did.
    std::fs::copy(&stray, &seed).unwrap();
    rollout::prune(&state).await.unwrap();
    assert!(seed.exists(), "the current key keeps its file");
    assert!(!stray.exists(), "a seed no current key owns goes");
    drop(temp);
}

#[tokio::test]
async fn a_seed_that_does_not_open_under_the_sealing_key_is_said_too() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let fingerprint = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    // A seed sealed by another instance: the right size, the wrong key.
    std::fs::write(sealed(f.temp.path(), &fingerprint), [7u8; 60]).unwrap();
    let (_temp, _state, warnings) = restart(f).await;
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains(FIX));
}

#[tokio::test]
async fn a_key_that_can_sign_or_is_not_the_servers_to_hold_is_not_a_warning() {
    // The server holds it and can sign: nothing to say.
    let f = fixture().await;
    enable_server(&f).await;
    let (_temp, _state, warnings) = restart(f).await;
    assert!(warnings.is_empty(), "{warnings:?}");

    // Updates are off: the seed is not needed.
    let f = fixture().await;
    let on = enable_server(&f).await;
    let fingerprint = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    std::fs::remove_file(sealed(f.temp.path(), &fingerprint)).unwrap();
    switch(&f, false).await;
    let (_temp, _state, warnings) = restart(f).await;
    assert!(warnings.is_empty(), "{warnings:?}");

    // The team holds the key: the server has no seed.
    let f = fixture().await;
    enable_offline(&f, &team("team")).await;
    let (_temp, _state, warnings) = restart(f).await;
    assert!(warnings.is_empty(), "{warnings:?}");
}
