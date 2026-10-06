use serde_json::{Value, json};
use std::{path::Path, process::Command};
use vectory_server::{Settings, State, db, initialize, restored_access};

async fn fixture() -> (tempfile::TempDir, State) {
    let directory = tempfile::tempdir().unwrap();
    let state = initialize(settings(directory.path())).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES('admin','admin@example.test','Admin','admin','synthetic-password-hash','2026-01-01T00:00:00Z');
         INSERT INTO sessions VALUES('session-one','admin','csrf-one','2099-01-01T00:00:00Z');
         INSERT INTO sessions VALUES('expired-session','admin','expired-csrf','2000-01-01T00:00:00Z');
         INSERT INTO password_reset_codes(verifier,user_id,expires_at,issuer_id) VALUES('reset-verifier','admin','2099-01-01T00:00:00Z','admin');
         INSERT INTO user_mfa VALUES('admin','synthetic-sealed-mfa',1,'2026-01-01T00:00:00Z',123);
         INSERT INTO mfa_recovery_codes VALUES('admin','recovery-one');
         INSERT INTO mfa_recovery_codes VALUES('admin','recovery-two');
         INSERT INTO devices(id,name,data,desired_generation,policy_generation,desired_version_id,assignment_id) VALUES('device','device','{\"secret_revision\":7}',19,12,'version','deployment');
         INSERT INTO credentials(fingerprint,device_id,expires_at) VALUES('fingerprint','device','2099-01-01T00:00:00Z');
         INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES('deployment','device','verified',19);
         INSERT INTO telemetry VALUES('device',10,'{\"uptime_seconds\":300}');"
    ).execute(&state.pool).await.unwrap();
    // Bind the active credential now, so later CLI initialization is not a schema repair.
    sqlx::query("UPDATE credentials SET signing_key_id=?")
        .bind(state.keys.active_signing_id())
        .execute(&state.pool)
        .await
        .unwrap();
    for (id, revoked) in [
        ("active", Some(json!(false))),
        ("old", Some(json!(true))),
        ("missing", None),
        ("numeric", Some(json!(1))),
    ] {
        let mut data =
            json!({"id":id,"name_prefix":"fixture-","uses":3,"expires_at":"2099-01-01T00:00:00Z"});
        if let Some(revoked) = revoked {
            data["revoked"] = revoked;
        }
        sqlx::query("INSERT INTO enrollment_tokens VALUES(?,?,?)")
            .bind(id)
            .bind(format!("verifier-{id}"))
            .bind(data.to_string())
            .execute(&state.pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO enrollments VALUES('request','key-hash','active','{\"device_id\":\"device\"}')").execute(&state.pool).await.unwrap();
    let mut connection = state.pool.acquire().await.unwrap();
    for kind in [
        "configuration",
        "revision",
        "version",
        "deployment",
        "audit",
    ] {
        db::insert(
            &mut connection,
            kind,
            &json!({"id":kind,"created_at":"2026-01-01T00:00:00Z","fixture":true}),
        )
        .await
        .unwrap();
    }
    drop(connection);
    (directory, state)
}

fn settings(directory: &Path) -> Settings {
    Settings {
        data_dir: directory.join("state"),
        bootstrap_secret: String::new(),
        cookie_secure: true,
        dashboard_dir: directory.join("dashboard"),
        releases_dir: directory.join("releases"),
        instance_name: "Restored-access test".into(),
        validation_url: None,
        ..Default::default()
    }
}

async fn counts(state: &State) -> Value {
    restored_access::invalidate(state, false).await.unwrap()["counts"].clone()
}

async fn preserved(state: &State) -> Value {
    let mut result = serde_json::Map::new();
    for (table, columns) in [
        (
            "users",
            "'id',id,'email',email,'name',name,'role',role,'password_hash',password_hash,'created_at',created_at,'enabled',enabled,'revision',revision",
        ),
        (
            "user_mfa",
            "'user_id',user_id,'secret_ciphertext',secret_ciphertext,'enabled',enabled,'pending_expires_at',pending_expires_at,'last_used_step',last_used_step",
        ),
        (
            "devices",
            "'id',id,'name',name,'data',data,'revoked',revoked,'desired_version_id',desired_version_id,'desired_generation',desired_generation,'policy',policy,'policy_generation',policy_generation,'assignment_id',assignment_id,'policy_assignment_id',policy_assignment_id",
        ),
        (
            "credentials",
            "'fingerprint',fingerprint,'device_id',device_id,'expires_at',expires_at,'revoked',revoked,'signing_key_id',signing_key_id",
        ),
        (
            "enrollments",
            "'request_id',request_id,'key_hash',key_hash,'token_id',token_id,'response',response",
        ),
        (
            "deployment_targets",
            "'deployment_id',deployment_id,'device_id',device_id,'state',state,'generation',generation,'previous_version_id',previous_version_id,'released_at',released_at,'verified_at',verified_at,'error',error,'original',original",
        ),
        (
            "telemetry",
            "'device_id',device_id,'bucket',bucket,'data',data",
        ),
    ] {
        let raw:String=sqlx::query_scalar(&format!("SELECT json_group_array(json(item)) FROM (SELECT json_object({columns}) item FROM {table} ORDER BY rowid)")).fetch_one(&state.pool).await.unwrap();
        result.insert(table.into(), serde_json::from_str(&raw).unwrap());
    }
    let raw: Vec<String> =
        sqlx::query_scalar("SELECT data FROM records WHERE kind!='audit' ORDER BY kind,id")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    result.insert("immutable_and_deployment_records".into(), json!(raw));
    Value::Object(result)
}

async fn audit_count(state: &State) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit'")
        .fetch_one(&state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn preview_changes_no_access_and_apply_preserves_runtime_identity_and_history() {
    let (_directory, state) = fixture().await;
    let before = preserved(&state).await;
    let expected = json!({"browser_sessions":2,"password_reset_codes":1,"enrollment_tokens_to_revoke":3,"mfa_recovery_codes":2});
    assert_eq!(counts(&state).await, expected);
    assert_eq!(audit_count(&state).await, 1);
    assert_eq!(preserved(&state).await, before);
    let applied = restored_access::invalidate(&state, true).await.unwrap();
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["counts"], expected);
    assert_eq!(
        counts(&state).await,
        json!({"browser_sessions":0,"password_reset_codes":0,"enrollment_tokens_to_revoke":0,"mfa_recovery_codes":0})
    );
    assert_eq!(preserved(&state).await, before);
    let records: Vec<String> = sqlx::query_scalar("SELECT data FROM enrollment_tokens ORDER BY id")
        .fetch_all(&state.pool)
        .await
        .unwrap();
    assert_eq!(records.len(), 4);
    for raw in records {
        let record: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(record["revoked"], true);
        assert_eq!(record["uses"], 3);
        assert_eq!(record["name_prefix"], "fixture-");
    }
    let audit:String=sqlx::query_scalar("SELECT data FROM records WHERE kind='audit' AND json_extract(data,'$.action')='server.restore_access.invalidate'").fetch_one(&state.pool).await.unwrap();
    let value: Value = serde_json::from_str(&audit).unwrap();
    assert_eq!(value["details"], expected);
    for sensitive in [
        "session-one",
        "reset-verifier",
        "recovery-one",
        "synthetic-password-hash",
        "synthetic-sealed-mfa",
        "verifier-active",
    ] {
        assert!(!audit.contains(sensitive));
    }
    let again = restored_access::invalidate(&state, true).await.unwrap();
    assert_eq!(again["counts"], counts(&state).await);
    assert_eq!(preserved(&state).await, before);
    state.pool.close().await;
}

#[tokio::test]
async fn failure_rolls_back_every_invalidation_and_audit() {
    let (_directory, state) = fixture().await;
    let before = counts(&state).await;
    sqlx::query("CREATE TRIGGER fail_restored_access BEFORE UPDATE ON enrollment_tokens BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END").execute(&state.pool).await.unwrap();
    assert!(restored_access::invalidate(&state, true).await.is_err());
    assert_eq!(counts(&state).await, before);
    assert_eq!(audit_count(&state).await, 1);
    sqlx::query("DROP TRIGGER fail_restored_access")
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_restored_audit BEFORE INSERT ON records WHEN NEW.kind='audit' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END").execute(&state.pool).await.unwrap();
    assert!(restored_access::invalidate(&state, true).await.is_err());
    assert_eq!(counts(&state).await, before);
    state.pool.close().await;
}

#[tokio::test]
async fn malformed_token_records_fail_closed_before_any_invalidation() {
    let (_directory, state) = fixture().await;
    sqlx::query("UPDATE enrollment_tokens SET data='[]' WHERE id='active'")
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(restored_access::invalidate(&state, false).await.is_err());
    assert!(restored_access::invalidate(&state, true).await.is_err());
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 2);
    assert_eq!(audit_count(&state).await, 1);
    state.pool.close().await;
}

fn command(directory: &Path, apply: Option<&str>) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vectory-admin"));
    command
        .args(["--data-dir"])
        .arg(directory.join("state"))
        .arg("invalidate-restored-access");
    if let Some(option) = apply {
        command.arg(option);
    }
    command.output().unwrap()
}

#[tokio::test]
async fn real_cli_refuses_live_state_defaults_to_preview_and_requires_exact_apply() {
    let (directory, state) = fixture().await;
    let locked = command(directory.path(), Some("--apply"));
    assert_eq!(locked.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&locked.stderr);
    assert!(
        stderr.contains("still running on this data directory"),
        "{stderr}"
    );
    assert!(!stderr.contains("Stack backtrace") && !stderr.contains("Error: "));
    assert_eq!(counts(&state).await["browser_sessions"], 2);
    state.pool.close().await;
    drop(state);
    let invalid = command(directory.path(), Some("--aply"));
    assert_eq!(invalid.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("unexpected argument '--aply'"));
    let preview = command(directory.path(), None);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let value: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(value["applied"], false);
    assert_eq!(value["counts"]["browser_sessions"], 2);
    let applied = command(directory.path(), Some("--apply"));
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let value: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(value["applied"], true);
    let final_preview = command(directory.path(), None);
    assert!(final_preview.status.success());
    let value: Value = serde_json::from_slice(&final_preview.stdout).unwrap();
    assert_eq!(
        value["counts"],
        json!({"browser_sessions":0,"password_reset_codes":0,"enrollment_tokens_to_revoke":0,"mfa_recovery_codes":0})
    );
}
