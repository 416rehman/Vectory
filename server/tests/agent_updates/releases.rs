//! Agent releases: prepared from this server's own catalog, signed by the key
//! that is current, served to the devices a rollout releases them to, and
//! withdrawn when they should no longer be.
use super::support::*;
use axum::http::StatusCode;
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use vectory_server::{
    agent_release::{self, ReleaseKey, RolloverEnvelope, Track, VerifyInput},
    agent_releases, db,
};

const RELEASES: &str = "/api/v1/agent-releases";

fn builds(version: &str) -> Vec<(&str, &str, &str, Vec<u8>)> {
    vec![
        (version, "linux", "amd64", vec![1u8; 5000]),
        (version, "linux", "arm64", vec![2u8; 6000]),
        (version, "darwin", "arm64", vec![3u8; 7000]),
        (version, "windows", "amd64", vec![4u8; 8000]),
    ]
}
fn stored_path(f: &Fixture, digest: &str) -> std::path::PathBuf {
    f.temp
        .path()
        .join("state/artifacts/agent-releases")
        .join(digest)
}
async fn stored_files(f: &Fixture) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(f.temp.path().join("state/artifacts/agent-releases"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
    names.sort();
    names
}
async fn manifest_of(f: &Fixture, id: &str) -> Vec<u8> {
    let (status, _, bytes) = send_bytes(
        &f.app,
        "GET",
        &format!("{RELEASES}/{id}/manifest"),
        Vec::new(),
        "application/json",
        Some((&f.viewer.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    bytes
}
async fn signature_of(f: &Fixture, id: &str) -> Option<Vec<u8>> {
    sqlx::query_scalar("SELECT signature FROM agent_releases WHERE id=?")
        .bind(id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap()
}
async fn put_signature(
    f: &Fixture,
    who: &Who,
    id: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> (StatusCode, Value) {
    let (status, _, body) = send_bytes(
        &f.app,
        "PUT",
        &format!("{RELEASES}/{id}/signature"),
        bytes,
        content_type,
        Some((&who.cookie, Some(&who.csrf))),
    )
    .await;
    (
        status,
        serde_json::from_slice(&body)
            .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&body)})),
    )
}
async fn prune(f: &Fixture) {
    vectory_server::rollout::prune(&f.state).await.unwrap();
}

#[tokio::test]
async fn a_release_is_prepared_from_the_catalog_copied_signed_and_stored_exactly() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = ReleaseKey::parse(on["current_key"]["public_key"].as_str().unwrap()).unwrap();
    let entries = mirror(
        &f,
        &[
            builds("0.1.1"),
            vec![("0.1.0", "linux", "amd64", vec![9u8; 100])],
        ]
        .concat(),
    );
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap().to_owned();
    assert_eq!(release["version"], "0.1.1");
    assert_eq!(release["counter"], 1);
    assert_eq!(release["state"], "ready");
    assert_eq!(release["expired"], false);
    assert_eq!(
        release["signer"],
        json!({"fingerprint":key.fingerprint(),"custody":"server"})
    );
    assert_eq!(release["prepared_by_name"], "Synthetic admin");
    assert_eq!(release["withdrawn_at"], Value::Null);
    assert_eq!(release["withdrawn_reason"], Value::Null);
    assert_eq!(release["rollouts"], json!([]));
    // One artifact per platform of the version, in the catalog's order, with the
    // size and digest of the file that was copied.
    let artifacts = release["artifacts"].as_array().unwrap();
    let platforms: Vec<(&str, &str)> = artifacts
        .iter()
        .map(|a| (a["os"].as_str().unwrap(), a["arch"].as_str().unwrap()))
        .collect();
    assert_eq!(
        platforms,
        [
            ("linux", "amd64"),
            ("linux", "arm64"),
            ("darwin", "arm64"),
            ("windows", "amd64")
        ]
    );
    let files: Vec<&str> = artifacts
        .iter()
        .map(|a| a["file"].as_str().unwrap())
        .collect();
    assert_eq!(
        files,
        [
            "vectory-0.1.1-linux-amd64",
            "vectory-0.1.1-linux-arm64",
            "vectory-0.1.1-darwin-arm64",
            "vectory-0.1.1-windows-amd64.exe"
        ]
    );
    for artifact in artifacts {
        let entry = entries
            .iter()
            .find(|e| {
                e["version"] == "0.1.1"
                    && e["os"] == artifact["os"]
                    && e["arch"] == artifact["arch"]
            })
            .unwrap();
        assert_eq!(artifact["size"], entry["size"]);
        assert_eq!(artifact["sha256"], entry["sha256"]);
        // The copy is in the store under its digest, private to the server.
        let path = stored_path(&f, artifact["sha256"].as_str().unwrap());
        let source = std::fs::read(
            f.temp
                .path()
                .join("releases")
                .join(entry["name"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), source);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    assert_eq!(
        stored_files(&f).await.len(),
        4,
        "only the version asked for, and no temporary file"
    );
    // The manifest: exactly the stored bytes, in the format of the contract.
    let bytes = manifest_of(&f, &id).await;
    let manifest = agent_release::parse_manifest(&bytes).unwrap();
    assert_eq!(manifest.version.to_string(), "0.1.1");
    assert_eq!(manifest.counter, 1);
    assert_eq!(manifest.service_definition, 1);
    assert_eq!(manifest.min_from, None);
    assert_eq!(manifest.expires_at - manifest.issued_at, 180 * 24 * 3600);
    assert!((manifest.issued_at - Utc::now().timestamp()).abs() < 60);
    assert_eq!(manifest.artifacts.len(), 4);
    assert_eq!(
        agent_release::manifest_sha256(&bytes),
        release["manifest_sha256"].as_str().unwrap()
    );
    assert_eq!(
        release["issued_at"],
        agent_release::format_instant(manifest.issued_at).unwrap()
    );
    assert_eq!(
        release["expires_at"],
        agent_release::format_instant(manifest.expires_at).unwrap()
    );
    assert!(
        !bytes.ends_with(b"\n"),
        "the server writes one line with no final line feed"
    );
    // The signature file the server made verifies under the key.
    let signature = signature_of(&f, &id).await.expect("signed at once");
    let entries = agent_release::parse_signature_file(&signature).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].key, key.fingerprint());
    assert!(agent_release::verify_release_signature(
        &key,
        &bytes,
        &entries[0].signature
    ));
    agent_release::check_signature_file(&bytes, &signature, &key).unwrap();
    // The audit trail says what was prepared and that it was signed.
    for action in ["agent_release.prepare", "agent_release.sign"] {
        let rows = audits(&f, action).await;
        assert_eq!(rows.len(), 1, "{action}");
        assert_eq!(rows[0]["target"], json!(id));
        assert_eq!(rows[0]["details"]["version"], "0.1.1");
        assert_eq!(rows[0]["details"]["counter"], 1);
        assert_eq!(
            rows[0]["details"]["manifest_sha256"],
            release["manifest_sha256"]
        );
        assert_eq!(rows[0]["details"]["release_id"], json!(id));
    }
    assert_eq!(
        audits(&f, "agent_release.sign").await[0]["details"]["fingerprint"],
        json!(key.fingerprint())
    );
    // Listed and read like any other.
    let listed = ok(&f, "GET", RELEASES, Value::Null, &f.viewer).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0], release);
    assert_eq!(
        ok(
            &f,
            "GET",
            &format!("{RELEASES}/{id}"),
            Value::Null,
            &f.editor
        )
        .await,
        release
    );
    // The next release takes the next counter.
    let next = prepare(&f, "0.1.0").await;
    assert_eq!(next["counter"], 2);
    let listed = ok(&f, "GET", RELEASES, Value::Null, &f.viewer).await;
    assert_eq!(listed[0]["id"], next["id"], "newest first");
    assert_eq!(listed[1]["id"], json!(id));
}

#[tokio::test]
async fn the_manifest_is_served_as_a_file_in_any_state() {
    let f = fixture().await;
    enable_server(&f).await;
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap();
    let (status, headers, bytes) = send_bytes(
        &f.app,
        "GET",
        &format!("{RELEASES}/{id}/manifest"),
        Vec::new(),
        "x",
        Some((&f.viewer.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json");
    assert_eq!(
        headers["content-disposition"],
        "attachment; filename=\"release.json\""
    );
    assert_eq!(headers["content-length"], bytes.len().to_string());
    assert_eq!(
        headers["etag"],
        format!("\"{}\"", release["manifest_sha256"].as_str().unwrap())
    );
    assert_eq!(headers["cache-control"], "no-store");
    // Withdrawn, the bytes are still there: the row and the manifest stay.
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{id}/withdraw"),
        json!({"reason":"Superseded"}),
        &f.admin,
    )
    .await;
    assert_eq!(manifest_of(&f, id).await, bytes);
    let (status, _, _) = send_bytes(
        &f.app,
        "GET",
        &format!("{RELEASES}/00000000-0000-4000-8000-000000000001/manifest"),
        Vec::new(),
        "x",
        Some((&f.viewer.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = send_bytes(
        &f.app,
        "GET",
        &format!("{RELEASES}/{id}/manifest"),
        Vec::new(),
        "x",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn only_an_administrator_prepares_a_release_of_a_version_the_catalog_holds() {
    let f = fixture().await;
    enable_server(&f).await;
    mirror(&f, &builds("0.1.1"));
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            RELEASES,
            json!({"version":"0.1.1"}),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    let (status, _, _) = send_with(
        &f.app,
        "POST",
        RELEASES,
        json!({"version":"0.1.1"}),
        Some((&f.admin.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no CSRF token");
    for bad in [
        json!({}),
        json!({"version":7}),
        json!({"version":""}),
        json!({"version":"0.1"}),
        json!({"version":"0.1.1-rc1"}),
        json!({"version":"01.1.1"}),
        json!({"version":"0.1.1.1"}),
        json!({"version":"v0.1.1"}),
        json!({"version":"0.1.1","extra":true}),
    ] {
        refused(
            &f,
            "POST",
            RELEASES,
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.9.9"}),
        &f.admin,
        StatusCode::CONFLICT,
        "RELEASE_NOT_IN_CATALOG",
    )
    .await;
    prepare(&f, "0.1.1").await;
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.1.1"}),
        &f.admin,
        StatusCode::CONFLICT,
        "RELEASE_EXISTS",
    )
    .await;
    assert_eq!(stored_files(&f).await.len(), 4);
    // Nothing a refusal did is left: one release, one counter.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_releases")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // While updates are off none of it exists.
    switch(&f, false).await;
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.1.1"}),
        &f.admin,
        StatusCode::NOT_FOUND,
        "AGENT_UPDATES_OFF",
    )
    .await;
}

#[tokio::test]
async fn a_build_in_the_catalog_that_no_longer_matches_is_not_a_release() {
    let f = fixture().await;
    enable_server(&f).await;
    let entries = mirror(&f, &builds("0.1.1"));
    // The file changed after the catalog described it: the catalog itself does
    // not offer it.
    std::fs::write(
        f.temp
            .path()
            .join("releases")
            .join(entries[0]["name"].as_str().unwrap()),
        vec![0u8; 5000],
    )
    .unwrap();
    let release = prepare(&f, "0.1.1").await;
    let platforms: Vec<&str> = release["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["os"].as_str().unwrap())
        .collect();
    assert_eq!(
        platforms,
        ["linux", "darwin", "windows"],
        "linux/amd64 is left out"
    );
    assert_eq!(release["artifacts"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn a_build_in_the_mirror_replaces_the_bundled_build_of_its_platform() {
    let f = fixture_with(|s| {
        s.bundled_releases_dir = s.releases_dir.parent().map(|dir| dir.join("bundled"));
    })
    .await;
    enable_server(&f).await;
    let bundled = f.temp.path().join("bundled");
    // The image brings 0.1.1 for three platforms.
    let image = catalog_in(
        &bundled,
        &[
            ("0.1.1", "linux", "amd64", vec![1u8; 5000]),
            ("0.1.1", "linux", "arm64", vec![2u8; 6000]),
            ("0.1.1", "darwin", "arm64", vec![3u8; 7000]),
        ],
    );
    // The operator's mirror has another build of 0.1.1 for linux/amd64, and a
    // newer version, 0.1.4, for linux/arm64.
    let mirrored = mirror(
        &f,
        &[
            ("0.1.1", "linux", "amd64", vec![9u8; 5500]),
            ("0.1.4", "linux", "arm64", vec![8u8; 6500]),
        ],
    );
    let digest_of = |entries: &[Value], version: &str, os: &str, arch: &str| -> String {
        entries
            .iter()
            .find(|entry| entry["version"] == version && entry["os"] == os && entry["arch"] == arch)
            .unwrap()["sha256"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let platforms = |release: &Value| -> Vec<(String, String, String)> {
        release["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|artifact| {
                (
                    artifact["os"].as_str().unwrap().to_owned(),
                    artifact["arch"].as_str().unwrap().to_owned(),
                    artifact["sha256"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    };
    // The catalog holds, for each platform, the mirror's build when there is one
    // and the image's when there is not. 0.1.1 is therefore the mirror's
    // linux/amd64 and the image's darwin/arm64: the image's linux/amd64 is not
    // in it though the version is the same, and its linux/arm64 is gone because
    // the mirror's build of that platform is another version.
    let release = prepare(&f, "0.1.1").await;
    assert_eq!(
        platforms(&release),
        [
            (
                "linux".to_owned(),
                "amd64".to_owned(),
                digest_of(&mirrored, "0.1.1", "linux", "amd64")
            ),
            (
                "darwin".to_owned(),
                "arm64".to_owned(),
                digest_of(&image, "0.1.1", "darwin", "arm64")
            ),
        ]
    );
    let mut stored = stored_files(&f).await;
    stored.sort();
    let mut expected = vec![
        digest_of(&mirrored, "0.1.1", "linux", "amd64"),
        digest_of(&image, "0.1.1", "darwin", "arm64"),
    ];
    expected.sort();
    assert_eq!(stored, expected, "a replaced build is never copied");
    assert_eq!(
        std::fs::read(stored_path(
            &f,
            &digest_of(&mirrored, "0.1.1", "linux", "amd64")
        ))
        .unwrap(),
        vec![9u8; 5500]
    );
    // 0.1.4 is the mirror's alone.
    let newer = prepare(&f, "0.1.4").await;
    assert_eq!(
        platforms(&newer),
        [(
            "linux".to_owned(),
            "arm64".to_owned(),
            digest_of(&mirrored, "0.1.4", "linux", "arm64")
        )]
    );
    // A version that only a replaced build had is not in the catalog at all.
    catalog_in(&bundled, &[("0.1.9", "linux", "amd64", vec![5u8; 100])]);
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.1.9"}),
        &f.admin,
        StatusCode::CONFLICT,
        "RELEASE_NOT_IN_CATALOG",
    )
    .await;
}

#[tokio::test]
async fn the_counter_follows_the_sequence_and_what_devices_report_they_attempted() {
    let f = fixture().await;
    enable_server(&f).await;
    mirror(
        &f,
        &[
            builds("0.1.1"),
            builds("0.1.2"),
            builds("0.1.3"),
            builds("0.1.4"),
        ]
        .concat(),
    );
    assert_eq!(prepare(&f, "0.1.1").await["counter"], 1);
    // A device reports it attempted counter 50 from a key it pins: the next
    // release takes 51, so no host holds a floor at or above it.
    let a = device(&f, "edge-00", "0.1.0").await;
    store(
        &f,
        &a,
        &with(
            member(&[&fingerprint("any")]),
            json!({"highest_counter":50}),
        ),
    )
    .await;
    assert_eq!(prepare(&f, "0.1.2").await["counter"], 51);
    // The stored sequence is what a counter is taken from: it never goes back.
    store(
        &f,
        &a,
        &with(
            member(&[&fingerprint("any")]),
            json!({"highest_counter":10}),
        ),
    )
    .await;
    assert_eq!(prepare(&f, "0.1.3").await["counter"], 52);
    // More than a million above the sequence is ignored, so no device can use
    // the sequence up; a revoked device is not counted at all.
    let b = device(&f, "edge-01", "0.1.0").await;
    store(
        &f,
        &b,
        &with(
            member(&[&fingerprint("any")]),
            json!({"highest_counter":5_000_000}),
        ),
    )
    .await;
    let c = device(&f, "edge-02", "0.1.0").await;
    store(
        &f,
        &c,
        &with(
            member(&[&fingerprint("any")]),
            json!({"highest_counter":500}),
        ),
    )
    .await;
    revoke(&f, &c).await;
    assert_eq!(prepare(&f, "0.1.4").await["counter"], 53);
    let sequence: i64 = sqlx::query_scalar("SELECT counter_sequence FROM agent_update_settings")
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(sequence, 53);
    // Taking a counter does not advance the setting's revision.
    let before =
        ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await["revision"].clone();
    mirror(&f, &builds("0.1.5"));
    prepare(&f, "0.1.5").await;
    assert_eq!(
        ok(&f, "GET", "/api/v1/agent-updates", Value::Null, &f.viewer).await["revision"],
        before
    );
}

#[tokio::test]
async fn twenty_releases_that_are_not_withdrawn_is_the_most() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    for n in 0..20 {
        release(&f, &format!("0.3.{n}"), n + 1, &key, &[("linux", "amd64")]).await;
    }
    mirror(&f, &builds("0.1.1"));
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.1.1"}),
        &f.admin,
        StatusCode::INSUFFICIENT_STORAGE,
        "RELEASE_STORAGE_FULL",
    )
    .await;
    let first = ok(&f, "GET", RELEASES, Value::Null, &f.viewer).await;
    let id = first.as_array().unwrap().last().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{id}/withdraw"),
        json!({"reason":"Making room"}),
        &f.admin,
    )
    .await;
    prepare(&f, "0.1.1").await;
}

#[tokio::test]
async fn the_release_store_is_bounded_and_a_withdrawn_release_gives_its_room_back() {
    let f = fixture_with(|settings| settings.agent_release_storage_bytes = Some(30_000)).await;
    enable_server(&f).await;
    mirror(
        &f,
        &[
            builds("0.1.1"),
            builds("0.1.2")
                .into_iter()
                .map(|(v, o, a, bytes)| (v, o, a, bytes.into_iter().map(|b| b ^ 0x55).collect()))
                .collect(),
        ]
        .concat(),
    );
    // Four builds of 26,000 bytes fit; two releases of them do not.
    let first = prepare(&f, "0.1.1").await;
    refused(
        &f,
        "POST",
        RELEASES,
        json!({"version":"0.1.2"}),
        &f.admin,
        StatusCode::INSUFFICIENT_STORAGE,
        "RELEASE_STORAGE_FULL",
    )
    .await;
    assert_eq!(
        stored_files(&f).await.len(),
        4,
        "the refused release left nothing in the store"
    );
    // Withdrawn, the release stops counting at once (its files go in the next
    // prune); then the other fits.
    let id = first["id"].as_str().unwrap();
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{id}/withdraw"),
        json!({"reason":"Replaced"}),
        &f.admin,
    )
    .await;
    prune(&f).await;
    prepare(&f, "0.1.2").await;
    assert_eq!(stored_files(&f).await.len(), 4);
}

#[tokio::test]
async fn offline_custody_prepares_a_release_that_waits_for_the_teams_signature() {
    let f = fixture().await;
    let team = team("team");
    enable_offline(&f, &team).await;
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap().to_owned();
    assert_eq!(release["state"], "awaiting_signature");
    assert_eq!(release["signer"], Value::Null);
    assert!(signature_of(&f, &id).await.is_none());
    assert_eq!(audits(&f, "agent_release.prepare").await.len(), 1);
    assert!(
        audits(&f, "agent_release.sign").await.is_empty(),
        "nobody signed it yet"
    );
    // It cannot start a rollout.
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[&team.fingerprint()])).await;
    refused(
        &f,
        "POST",
        "/api/v1/agent-update-rollouts/preview",
        request(&id, &[&edge], json!({})),
        &f.operator,
        StatusCode::CONFLICT,
        "RELEASE_NOT_READY",
    )
    .await;

    let manifest = manifest_of(&f, &id).await;
    let good = team.sign(&manifest);
    // Who may upload, and how much.
    for who in [&f.viewer, &f.editor, &f.operator] {
        let (status, _) =
            put_signature(&f, who, &id, good.clone(), "application/octet-stream").await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    let (status, _, _) = send_bytes(
        &f.app,
        "PUT",
        &format!("{RELEASES}/{id}/signature"),
        good.clone(),
        "application/octet-stream",
        Some((&f.admin.cookie, None)),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "no CSRF token");
    let (status, value) =
        put_signature(&f, &f.admin, &id, vec![b' '; 4097], "application/json").await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("PAYLOAD_TOO_LARGE"))
    );
    let (status, value) = put_signature(
        &f,
        &f.admin,
        "00000000-0000-4000-8000-000000000001",
        good.clone(),
        "text/plain",
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::NOT_FOUND, Some("NOT_FOUND"))
    );
    // A file that is not a valid signature file, or whose signature is not the
    // current key's over the stored manifest, is refused and audited with why.
    let stranger = self::team("stranger");
    let other_manifest = agent_release::build_manifest(
        "0.9.9",
        1,
        Utc::now().timestamp(),
        Utc::now().timestamp() + 1000,
        None,
        1,
        &[agent_release::ArtifactInput {
            os: "linux",
            arch: "amd64",
            size: 1,
            sha256: &"a".repeat(64),
        }],
    )
    .unwrap();
    for (n, bad) in [
        Vec::new(),
        b"not a signature file".to_vec(),
        b"{\"schema\":\"vectory.agent-release-signatures.v1\",\"signatures\":[]}".to_vec(),
        stranger.sign(&manifest),
        team.sign(&other_manifest),
        [good.clone(), b"x".to_vec()].concat(),
    ]
    .into_iter()
    .enumerate()
    {
        let (status, value) =
            put_signature(&f, &f.admin, &id, bad, "application/octet-stream").await;
        assert_eq!(
            (status, value["error"]["code"].as_str()),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                Some("RELEASE_SIGNATURE_INVALID")
            ),
            "case {n}: {value}"
        );
        assert!(signature_of(&f, &id).await.is_none());
    }
    let refused_rows = audits(&f, "agent_release.signature_upload").await;
    assert_eq!(refused_rows.len(), 6);
    assert!(refused_rows.iter().all(|row| row["outcome"] == "refused"
        && row["target"] == json!(id)
        && row["details"]["reason"].is_string()));
    // A signature file that names other keys besides is stored as uploaded, once
    // an entry names the current key and verifies.
    let mine = agent_release::parse_signature_file(&good).unwrap();
    let theirs = agent_release::parse_signature_file(&stranger.sign(&manifest)).unwrap();
    let two = agent_release::build_signature_file(&[theirs[0].clone(), mine[0].clone()]).unwrap();
    let with_line_feed = [two.clone(), b"\n".to_vec()].concat();
    let (status, ready) = put_signature(
        &f,
        &f.admin,
        &id,
        with_line_feed.clone(),
        "application/x-anything",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ready}");
    assert_eq!(ready["state"], "ready");
    assert_eq!(
        ready["signer"],
        json!({"fingerprint":team.fingerprint(),"custody":"offline"})
    );
    assert_eq!(
        signature_of(&f, &id).await.unwrap(),
        with_line_feed,
        "the bytes as uploaded"
    );
    let rows = audits(&f, "agent_release.signature_upload").await;
    assert_eq!(rows.last().unwrap()["outcome"], "success");
    // Only a release that awaits its signature takes one.
    let (status, value) =
        put_signature(&f, &f.admin, &id, good.clone(), "application/octet-stream").await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (StatusCode::CONFLICT, Some("CONFLICT"))
    );
    // Now it can be reviewed.
    let review = preview(&f, &id, &[&edge], json!({})).await;
    assert_eq!(review["will_update"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_signature_made_for_another_key_is_not_accepted_after_the_key_changed() {
    let f = fixture().await;
    let first = team("team");
    enable_offline(&f, &first).await;
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap();
    // The team rotates its key before it signs: the release waits for the key
    // that is current now.
    let second = team("team-next");
    let statement =
        agent_release::build_statement(&first.fingerprint(), &second.key, Utc::now().timestamp())
            .unwrap();
    let signature = agent_release::sign_rollover(&first.seed, &statement).unwrap();
    ok(&f, "POST", "/api/v1/agent-release-keys/rollover", json!({"statement":STANDARD.encode(&statement),"signature":STANDARD.encode(signature),"current_password":PASSWORD}), &f.admin).await;
    let manifest = manifest_of(&f, id).await;
    let (status, value) = put_signature(
        &f,
        &f.admin,
        id,
        first.sign(&manifest),
        "application/octet-stream",
    )
    .await;
    assert_eq!(
        (status, value["error"]["code"].as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Some("RELEASE_SIGNATURE_INVALID")
        )
    );
    let (status, ready) = put_signature(
        &f,
        &f.admin,
        id,
        second.sign(&manifest),
        "application/octet-stream",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{ready}");
    assert_eq!(ready["signer"]["fingerprint"], json!(second.fingerprint()));
}

#[tokio::test]
async fn withdrawing_ends_the_rollouts_that_offer_the_release_and_its_files_leave_the_store_once_unneeded()
 {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap().to_owned();
    let digests: Vec<String> = release["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["sha256"].as_str().unwrap().to_owned())
        .collect();
    let edge = device(&f, "edge-00", "0.1.0").await;
    let other = device(&f, "edge-01", "0.1.0").await;
    for device in [&edge, &other] {
        store(&f, device, &member(&[&key])).await;
    }
    let rollout = start(&f, &id, &[&edge, &other], json!({"canary_size":1})).await;
    let rollout = rollout["id"].as_str().unwrap().to_owned();
    step(&f, Utc::now()).await;
    let path = format!("{RELEASES}/{id}/withdraw");
    for who in [&f.viewer, &f.editor, &f.operator] {
        refused(
            &f,
            "POST",
            &path,
            json!({"reason":"Bad build"}),
            who,
            StatusCode::FORBIDDEN,
            "FORBIDDEN",
        )
        .await;
    }
    for bad in [
        json!({}),
        json!({"reason":""}),
        json!({"reason":"two\nlines"}),
        json!({"reason":"x".repeat(501)}),
        json!({"reason":"ok","extra":1}),
    ] {
        refused(
            &f,
            "POST",
            &path,
            bad,
            &f.admin,
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
        )
        .await;
    }
    refused(
        &f,
        "POST",
        &format!("{RELEASES}/00000000-0000-4000-8000-000000000001/withdraw"),
        json!({"reason":"x"}),
        &f.admin,
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
    )
    .await;
    let withdrawn = ok(
        &f,
        "POST",
        &path,
        json!({"reason":"  Bad build  "}),
        &f.admin,
    )
    .await;
    assert_eq!(withdrawn["state"], "withdrawn");
    assert_eq!(withdrawn["withdrawn_reason"], "Bad build");
    assert!(withdrawn["withdrawn_at"].is_string());
    assert_eq!(
        withdrawn["rollouts"],
        json!([{"id":rollout,"status":"cancelled"}])
    );
    let ended = ok(
        &f,
        "GET",
        &format!("/api/v1/agent-update-rollouts/{rollout}"),
        Value::Null,
        &f.viewer,
    )
    .await;
    assert_eq!(ended["cancel_reason"], "release_withdrawn");
    assert_eq!(ended["state_counts"]["cancelled"], 2);
    // The device is offered nothing; a repeat is a conflict.
    assert!(
        report(
            &f,
            &edge,
            "0.1.0",
            &db::hash("running 0.1.0 linux amd64"),
            "boot",
            &member(&[&key])
        )
        .await
        .get("agent_update")
        .is_none()
    );
    refused(
        &f,
        "POST",
        &path,
        json!({"reason":"again"}),
        &f.admin,
        StatusCode::CONFLICT,
        "CONFLICT",
    )
    .await;
    let rows = audits(&f, "agent_release.withdraw").await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["target"], json!(id));
    assert_eq!(rows[0]["details"]["reason"], "Bad build");
    assert_eq!(rows[0]["details"]["cancelled_rollouts"], 1);
    assert_eq!(rows[0]["details"]["version"], "0.1.1");
    // Its rollouts ended with it, so nothing needs its files: they are gone.
    assert!(stored_files(&f).await.is_empty());
    prune(&f).await;
    assert!(stored_files(&f).await.is_empty());
    let removed: i64 = sqlx::query_scalar("SELECT files_removed FROM agent_releases WHERE id=?")
        .bind(&id)
        .fetch_one(&f.state.pool)
        .await
        .unwrap();
    assert_eq!(removed, 1);
    // The row and the manifest stay.
    assert!(!manifest_of(&f, &id).await.is_empty());
    assert_eq!(
        ok(
            &f,
            "GET",
            &format!("{RELEASES}/{id}"),
            Value::Null,
            &f.viewer
        )
        .await["state"],
        "withdrawn"
    );
    // The same version can be prepared again, with a new counter, and its files
    // are copied again.
    let again = prepare(&f, "0.1.1").await;
    assert_eq!(again["counter"], 2);
    assert_ne!(again["id"], json!(id));
    assert_eq!(stored_files(&f).await.len(), 4);
    for digest in &digests {
        assert!(stored_path(&f, digest).exists());
    }
}

#[tokio::test]
async fn files_another_release_still_names_stay_when_one_is_withdrawn() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = on["current_key"]["fingerprint"]
        .as_str()
        .unwrap()
        .to_owned();
    mirror(&f, &builds("0.1.1"));
    let first = prepare(&f, "0.1.1").await;
    // Another release names one of the same files.
    let shared = first["artifacts"][0]["sha256"].as_str().unwrap().to_owned();
    let other = release(&f, "0.1.2", 9, &key, &[("linux", "amd64")]).await;
    sqlx::query("UPDATE agent_release_artifacts SET sha256=? WHERE release_id=?")
        .bind(&shared)
        .bind(&other.id)
        .execute(&f.state.pool)
        .await
        .unwrap();
    let id = first["id"].as_str().unwrap();
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{id}/withdraw"),
        json!({"reason":"Redo"}),
        &f.admin,
    )
    .await;
    prune(&f).await;
    // The file both name stays; the three only the withdrawn release named go.
    assert_eq!(stored_files(&f).await, [shared.clone()]);
    // Once the other release is withdrawn too, the last file goes.
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{}/withdraw", other.id),
        json!({"reason":"Redo"}),
        &f.admin,
    )
    .await;
    assert!(stored_files(&f).await.is_empty());
}

#[tokio::test]
async fn a_release_names_only_files_the_store_still_holds_at_the_size_it_copied() {
    let f = fixture().await;
    enable_server(&f).await;
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let files: Vec<(String, u64)> = release["artifacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|artifact| {
            (
                artifact["sha256"].as_str().unwrap().to_owned(),
                artifact["size"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(files.len(), 4);
    assert!(agent_releases::store_holds(&f.state, &files));
    // Nothing held is a release with no files, and a file that is one byte
    // short, removed, or a directory where the file should be, is not held.
    assert!(agent_releases::store_holds(&f.state, &[]));
    let (digest, size) = files[0].clone();
    let mut changed = files.clone();
    changed[0].1 = size + 1;
    assert!(!agent_releases::store_holds(&f.state, &changed));
    std::fs::remove_file(stored_path(&f, &digest)).unwrap();
    assert!(!agent_releases::store_holds(&f.state, &files));
    std::fs::create_dir(stored_path(&f, &digest)).unwrap();
    assert!(!agent_releases::store_holds(&f.state, &files));
    // A release prepared again copies what went missing before it names it.
    std::fs::remove_dir(stored_path(&f, &digest)).unwrap();
    let id = release["id"].as_str().unwrap();
    ok(
        &f,
        "POST",
        &format!("{RELEASES}/{id}/withdraw"),
        json!({"reason":"Redo"}),
        &f.admin,
    )
    .await;
    let again = prepare(&f, "0.1.1").await;
    assert_eq!(again["artifacts"], release["artifacts"]);
    assert!(agent_releases::store_holds(&f.state, &files));
}

#[tokio::test]
async fn the_prune_removes_files_nobody_names_once_they_are_old_enough_not_to_belong_to_a_request()
{
    let f = fixture().await;
    enable_server(&f).await;
    mirror(&f, &builds("0.1.1"));
    prepare(&f, "0.1.1").await;
    let dir = f.temp.path().join("state/artifacts/agent-releases");
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600);
    let stray_old = dir.join(db::hash("an old orphan"));
    let stray_new = dir.join(db::hash("a new orphan"));
    let temporary_old = dir.join(".tmpOLD");
    let temporary_new = dir.join(".tmpNEW");
    for path in [&stray_old, &stray_new, &temporary_old, &temporary_new] {
        std::fs::write(path, b"left behind").unwrap();
    }
    for path in [&stray_old, &temporary_old] {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(old)
            .unwrap();
    }
    prune(&f).await;
    assert!(!stray_old.exists());
    assert!(!temporary_old.exists());
    assert!(
        stray_new.exists(),
        "a file that may belong to a request that has not finished stays"
    );
    assert!(temporary_new.exists());
    assert_eq!(stored_files(&f).await.len(), 6);
}

#[tokio::test]
async fn an_offer_is_valid_on_the_host_it_is_made_to() {
    // The server's own offer, taken from a manifest, decided by the function a
    // host decides with: the signature, the key the host pins, the platform,
    // the counter and the version.
    let f = fixture().await;
    let on = enable_server(&f).await;
    let key = ReleaseKey::parse(on["current_key"]["public_key"].as_str().unwrap()).unwrap();
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    let id = release["id"].as_str().unwrap().to_owned();
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[key.fingerprint()])).await;
    start(&f, &id, &[&edge], json!({})).await;
    step(&f, Utc::now()).await;
    let manifest = report(
        &f,
        &edge,
        "0.1.0",
        &db::hash("running 0.1.0 linux amd64"),
        "boot",
        &member(&[key.fingerprint()]),
    )
    .await;
    let offer = &manifest["agent_update"];
    let decode = |name: &str| STANDARD.decode(offer[name].as_str().unwrap()).unwrap();
    let (bytes, signatures) = (decode("manifest"), decode("signatures"));
    assert_eq!(
        bytes,
        manifest_of(&f, &id).await,
        "the stored bytes, as built"
    );
    assert_eq!(signatures, signature_of(&f, &id).await.unwrap());
    let pins = [key.clone()];
    let floors = BTreeMap::new();
    let decide = |rollovers: &[RolloverEnvelope], pins: &[ReleaseKey]| {
        agent_release::verify_release(&VerifyInput {
            manifest: &bytes,
            signatures: &signatures,
            rollovers,
            pins,
            floors: &floors,
            last: None,
            running_version: "0.1.0",
            os: "linux",
            arch: "amd64",
            track: Track::Patch,
            service_definition: 1,
            now: Utc::now().timestamp(),
        })
    };
    let verified = decide(&[], &pins).expect("the host accepts what the server offers");
    assert_eq!(verified.signer, key.fingerprint());
    assert_eq!(
        verified.manifest_sha256,
        release["manifest_sha256"].as_str().unwrap()
    );
    assert_eq!(offer["artifact"]["sha256"], json!(verified.artifact.sha256));
    assert_eq!(offer["artifact"]["size"], json!(verified.artifact.size));
    assert_eq!(
        offer["artifact"]["path"],
        format!("/agent/v1/agent-releases/{}", verified.artifact.sha256)
    );
    assert_eq!(verified.manifest.version.to_string(), "0.1.1");
    // A host that pins a key the offer's statements do not reach refuses it.
    let stranger = team("stranger");
    assert_eq!(
        decide(&[], &[stranger.key.clone()])
            .unwrap_err()
            .code
            .as_str(),
        "KEY_NOT_PINNED"
    );
}

#[tokio::test]
async fn a_host_that_pins_the_old_key_follows_the_statements_the_offer_carries() {
    let f = fixture().await;
    let on = enable_server(&f).await;
    let old = ReleaseKey::parse(on["current_key"]["public_key"].as_str().unwrap()).unwrap();
    // The server rotates twice; the host still pins the first key.
    let second = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let third = ok(
        &f,
        "POST",
        "/api/v1/agent-release-keys/rotate",
        json!({"current_password":PASSWORD}),
        &f.admin,
    )
    .await;
    let signer = ReleaseKey::parse(third["public_key"].as_str().unwrap()).unwrap();
    mirror(&f, &builds("0.1.1"));
    let release = prepare(&f, "0.1.1").await;
    assert_eq!(release["signer"]["fingerprint"], third["fingerprint"]);
    let id = release["id"].as_str().unwrap().to_owned();
    let edge = device(&f, "edge-00", "0.1.0").await;
    store(&f, &edge, &member(&[old.fingerprint()])).await;
    start(&f, &id, &[&edge], json!({})).await;
    step(&f, Utc::now()).await;
    let manifest = report(
        &f,
        &edge,
        "0.1.0",
        &db::hash("running 0.1.0 linux amd64"),
        "boot",
        &member(&[old.fingerprint()]),
    )
    .await;
    let offer = &manifest["agent_update"];
    let rollovers: Vec<RolloverEnvelope> =
        serde_json::from_value(offer["rollovers"].clone()).unwrap();
    assert_eq!(
        rollovers.len(),
        2,
        "the statements, in the order a host follows them"
    );
    assert_eq!(
        rollovers[0].statement,
        second["introduced_by"]["statement"].as_str().unwrap()
    );
    assert_eq!(
        rollovers[1].statement,
        third["introduced_by"]["statement"].as_str().unwrap()
    );
    let (bytes, signatures) = (
        STANDARD
            .decode(offer["manifest"].as_str().unwrap())
            .unwrap(),
        STANDARD
            .decode(offer["signatures"].as_str().unwrap())
            .unwrap(),
    );
    let floors = BTreeMap::new();
    let verified = agent_release::verify_release(&VerifyInput {
        manifest: &bytes,
        signatures: &signatures,
        rollovers: &rollovers,
        pins: &[old.clone()],
        floors: &floors,
        last: None,
        running_version: "0.1.0",
        os: "linux",
        arch: "amd64",
        track: Track::Patch,
        service_definition: 1,
        now: Utc::now().timestamp(),
    })
    .expect("the host follows the statements to the key that signed");
    assert_eq!(verified.signer, signer.fingerprint());
    assert_eq!(
        verified.pins_after.len(),
        1,
        "the old key is replaced, not added to"
    );
    assert_eq!(verified.pins_after[0].fingerprint(), signer.fingerprint());
    // Without them it does not.
    let refusal = agent_release::verify_release(&VerifyInput {
        manifest: &bytes,
        signatures: &signatures,
        rollovers: &[],
        pins: &[old.clone()],
        floors: &floors,
        last: None,
        running_version: "0.1.0",
        os: "linux",
        arch: "amd64",
        track: Track::Patch,
        service_definition: 1,
        now: Utc::now().timestamp(),
    })
    .unwrap_err();
    assert_eq!(refusal.code.as_str(), "KEY_NOT_PINNED");
    // A release signed only after an offer in time still expires: the manifest
    // is valid for 180 days on the host's clock.
    assert!(
        Utc::now().timestamp() + Duration::days(179).num_seconds()
            < agent_release::parse_manifest(&bytes).unwrap().expires_at
    );
}
