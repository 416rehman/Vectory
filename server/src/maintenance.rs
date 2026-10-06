//! Offline maintenance helpers. The caller must hold the exclusive data-directory lock.
use crate::{State, crypto, db};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::{fs, io::Write, path::Path};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationReport {
    pub devices: Vec<GenerationEntry>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GenerationEntry {
    pub device_id: String,
    pub highest_generation: u64,
    pub highest_policy_generation: u64,
    pub highest_secret_revision: u64,
    pub expected_version_id: Option<String>,
    pub expected_sha256: Option<String>,
    pub expected_policy_sha256: String,
}
/// The three counters a device's own state holds, with where `vectory status
/// --json` on the device shows each.
const COUNTERS: [(&str, &str); 3] = [
    ("highest_generation", "state.highest_generation"),
    (
        "highest_policy_generation",
        "state.highest_policy_generation",
    ),
    ("highest_secret_revision", "state.secret_revision"),
];

/// A device ID as it appears in a message: bounded, and without characters a
/// terminal would act on.
fn shown(id: &str) -> String {
    id.chars()
        .take(64)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// What an unreviewed report still lacks. `generation-recovery-state` leaves
/// every counter `null` on purpose, so a report that wasn't filled in says
/// which device and counter it stopped on, and where on the device to read the
/// value, instead of a parser's complaint about a type.
pub fn missing_counters(report: &Value) -> Option<String> {
    let mut gaps = Vec::new();
    for entry in report.get("devices")?.as_array()? {
        let id = shown(
            entry["device_id"]
                .as_str()
                .unwrap_or("(without a device_id)"),
        );
        for (field, source) in COUNTERS {
            match entry.get(field) {
                Some(value) if value.as_u64().is_some() => {}
                Some(Value::Null) | None => gaps.push((id.clone(), field, source, "has no value")),
                Some(_) => gaps.push((id.clone(), field, source, "isn't a whole number")),
            }
        }
    }
    let (id, field, _, problem) = gaps.first()?;
    let others = gaps.len() - 1;
    Some(format!(
        "{field} of device {id} {problem}{}. The exported report leaves every counter empty on purpose. On each device run `sudo vectory status --json` and copy state.highest_generation, state.highest_policy_generation and state.secret_revision into highest_generation, highest_policy_generation and highest_secret_revision.",
        match others {
            0 => String::new(),
            1 => " (1 more counter needs a value too)".to_owned(),
            n => format!(" ({n} more counters need a value too)"),
        }
    ))
}
pub async fn generation_recovery_state(s: &State) -> anyhow::Result<Value> {
    let rows=sqlx::query("SELECT id,desired_version_id,desired_generation,policy_generation,policy,data FROM devices WHERE revoked=0 ORDER BY id").fetch_all(&s.pool).await?;
    let mut devices = Vec::new();
    let mut conn = s.pool.acquire().await?;
    for row in rows {
        let version: Option<String> = row.get("desired_version_id");
        let sha = if let Some(ref id) = version {
            Some(
                db::record(&mut conn, "version", id)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.message))?["sha256"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            )
        } else {
            None
        };
        devices.push(json!({"device_id":row.get::<String,_>("id"),"highest_generation":null,"highest_policy_generation":null,"highest_secret_revision":null,"expected_version_id":version,"expected_sha256":sha,"expected_policy_sha256":db::hash(db::parse(row.get("policy")).map_err(|e|anyhow::anyhow!(e.message))?.to_string())}));
    }
    Ok(json!({"devices":devices}))
}
pub async fn recover_generations(
    s: &State,
    report: GenerationReport,
    apply: bool,
) -> anyhow::Result<Value> {
    if report.devices.is_empty() || report.devices.len() > 10000 {
        anyhow::bail!("Provide1..10000 explicit device reports")
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut tx = s.pool.begin().await?;
    let mut plan = Vec::new();
    for entry in &report.devices {
        if !seen.insert(&entry.device_id) {
            anyhow::bail!(
                "Device {} appears more than once in the generation report; list each device once",
                shown(&entry.device_id)
            )
        }
        if [
            entry.highest_generation,
            entry.highest_policy_generation,
            entry.highest_secret_revision,
        ]
        .iter()
        .any(|n| *n >= i64::MAX as u64)
        {
            anyhow::bail!("Generation bounds exceed supported integer range")
        }
        let row = sqlx::query("SELECT * FROM devices WHERE id=? AND revoked=0")
            .bind(&entry.device_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Device {} in the generation report is unknown or revoked; use the IDs that generation-recovery-state lists, and leave out revoked devices",
                    shown(&entry.device_id)
                )
            })?;
        let current = row.get::<i64, _>("desired_generation") as u64;
        let current_policy = row.get::<i64, _>("policy_generation") as u64;
        let data = db::parse(row.get("data")).map_err(|e| anyhow::anyhow!(e.message))?;
        if entry.highest_generation < current
            || entry.highest_policy_generation < current_policy
            || entry.highest_secret_revision < data["secret_revision"].as_u64().unwrap_or(0)
        {
            anyhow::bail!(
                "Report is older than server state; review actual highest persisted agent counters"
            )
        }
        let version: Option<String> = row.get("desired_version_id");
        if version != entry.expected_version_id {
            anyhow::bail!("Reviewed desired version no longer matches restored server state")
        }
        let sha = if let Some(ref id) = version {
            Some(
                db::record(&mut tx, "version", id)
                    .await
                    .map_err(|e| anyhow::anyhow!(e.message))?["sha256"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
            )
        } else {
            None
        };
        if sha != entry.expected_sha256
            || db::hash(
                db::parse(row.get("policy"))
                    .map_err(|e| anyhow::anyhow!(e.message))?
                    .to_string(),
            ) != entry.expected_policy_sha256
        {
            anyhow::bail!(
                "Reviewed configuration or complete policy differs from the restored state"
            )
        }
        plan.push(json!({"device_id":entry.device_id,"previous_generation":current,"generation":entry.highest_generation+1,"previous_policy_generation":current_policy,"policy_generation":entry.highest_policy_generation+1,"secret_revision_floor":entry.highest_secret_revision,"version_id":version,"sha256":sha,"policy_sha256":entry.expected_policy_sha256}));
    }
    if apply {
        for item in &plan {
            let id = item["device_id"].as_str().unwrap();
            let row =
                sqlx::query("SELECT assignment_id,policy_assignment_id FROM devices WHERE id=?")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            sqlx::query("UPDATE devices SET desired_generation=?,policy_generation=?,data=json_set(data,'$.secret_revision',?) WHERE id=?").bind(item["generation"].as_i64().unwrap()).bind(item["policy_generation"].as_i64().unwrap()).bind(item["secret_revision_floor"].as_i64().unwrap()).bind(id).execute(&mut *tx).await?;
            for (column, counter) in [
                ("assignment_id", "generation"),
                ("policy_assignment_id", "policy_generation"),
            ] {
                if let Some(assignment) = row.get::<Option<String>, _>(column) {
                    let changed=sqlx::query("UPDATE deployment_targets SET generation=?,state='desired',verified_at=NULL,error=NULL WHERE deployment_id=? AND device_id=? AND state<>'removed'").bind(item[counter].as_i64().unwrap()).bind(&assignment).bind(id).execute(&mut *tx).await?.rows_affected()>0;
                    let mut deployment = db::record(&mut tx, "deployment", &assignment)
                        .await
                        .map_err(|e| anyhow::anyhow!(e.message))?;
                    if changed && deployment["status"] == "completed" {
                        deployment["status"] = json!("active");
                        deployment["observation_started_at"] = Value::Null;
                        db::update(&mut tx, "deployment", &deployment)
                            .await
                            .map_err(|e| anyhow::anyhow!(e.message))?;
                    }
                }
            }
            db::insert(&mut tx,"audit",&json!({"id":db::id(),"actor":"local-admin","action":"server.restore_generation_fence","target":id,"outcome":"success","created_at":db::now(),"details":item})).await.map_err(|e|anyhow::anyhow!(e.message))?;
        }
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(json!({"applied":apply,"devices":plan}))
}

pub(crate) fn atomic_private_replace(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Missing parent directory"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    #[cfg(not(windows))]
    temporary.persist(path).map_err(|e| e.error)?.sync_all()?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let source = temporary
            .path()
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let destination = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(unix)]
    {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}
pub async fn rotate_signing_key(s: &State) -> anyhow::Result<String> {
    let directory = s.settings.data_dir.join("keys");
    let history = directory.join("signing-history");
    fs::create_dir_all(&history)?;
    crypto::restrict_dir(&history)?;
    if s.keys.previous_signing_ids().len() >= 4 {
        anyhow::bail!(
            "Four previous signing keys are retained; renew/revoke old credentials and run prune-signing-keys before rotating again"
        )
    }
    let old_id = s.keys.active_signing_id();
    let retained = history.join(format!("{old_id}.key"));
    if retained.exists() {
        if fs::read(&retained)? != s.keys.signing.to_bytes() {
            anyhow::bail!("Retained signing key identity mismatch")
        }
    } else {
        atomic_private_replace(&retained, &s.keys.signing.to_bytes())?;
    }
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let new = ed25519_dalek::SigningKey::from_bytes(&raw);
    let new_id = db::hash(new.verifying_key().as_bytes());
    // Every old registered credential is already bound to old_id by initialize.
    // Persist the old key before replacing current, so a crash at either boundary
    // leaves old devices verifiable. New enrollments cannot race an offline lock.
    let mut tx = s.pool.begin().await?;
    db::audit(
        &mut tx,
        "local-admin",
        "signing.rotate.prepare",
        &format!("{old_id}:{new_id}"),
        "prepared",
    )
    .await
    .map_err(|e| anyhow::anyhow!(e.message))?;
    tx.commit().await?;
    atomic_private_replace(&directory.join("manifest-signing.key"), &raw)?;
    let mut tx = s.pool.begin().await?;
    db::audit(&mut tx, "local-admin", "signing.rotate", &new_id, "success")
        .await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    tx.commit().await?;
    Ok(new_id)
}
pub async fn prune_signing_keys(s: &State) -> anyhow::Result<usize> {
    let mut count = 0;
    for id in s.keys.previous_signing_ids() {
        let active:i64=sqlx::query_scalar("SELECT count(*) FROM credentials WHERE signing_key_id=? AND revoked=0 AND expires_at>?").bind(&id).bind(db::now()).fetch_one(&s.pool).await?;
        if active != 0 {
            continue;
        }
        let path = s
            .settings
            .data_dir
            .join("keys/signing-history")
            .join(format!("{id}.key"));
        // IDs were verified against actual public keys while loading this directory.
        if !fs::symlink_metadata(&path)?.is_file() {
            anyhow::bail!("Refusing a nonregular historical key")
        }
        fs::remove_file(path)?;
        count += 1;
        let mut tx = s.pool.begin().await?;
        db::audit(&mut tx, "local-admin", "signing.prune", &id, "success")
            .await
            .map_err(|e| anyhow::anyhow!(e.message))?;
        tx.commit().await?;
    }
    Ok(count)
}
