//! Rotating the dedicated device CA with a bounded overlap.
//!
//! `rotate` (offline, under the data directory lock) makes a new CA current
//! and keeps the replaced one as `previous`: every new and renewed device
//! certificate then comes from the new CA, while certificates from either CA
//! pass TLS. Devices move to the new CA at their next renewal, in their
//! certificate's last day, so within the 30-day certificate lifetime. `retire`
//! removes the previous CA once no active device holds a certificate it
//! issued. A chain never authenticates alone: each request still needs the
//! certificate's registered, unexpired, unrevoked fingerprint.
use crate::{
    State,
    crypto::{self, DeviceCa, NEXT_DEVICE_CA, NEXT_DEVICE_CA_KEY, PREVIOUS_DEVICE_CA},
    db,
    error::Result,
};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

/// Most device names a status or refusal lists; the count is always exact.
const LISTED: usize = 20;

/// An active device that still holds a certificate from the previous CA,
/// and when the last such certificate expires.
pub struct Holder {
    pub id: String,
    pub name: String,
    pub expires_at: String,
}

/// Active devices holding an unexpired, unrevoked credential issued by
/// `previous`. Credentials issued before issuers were recorded (NULL) count
/// too: they came from a CA that was current before tracking, never from a
/// CA a rotation created since.
pub async fn holders(db: &mut SqliteConnection, previous: &str) -> Result<Vec<Holder>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT d.id,d.name,MAX(c.expires_at) FROM credentials c JOIN devices d ON d.id=c.device_id \
         WHERE c.revoked=0 AND d.revoked=0 AND c.expires_at>? AND (c.ca_id=? OR c.ca_id IS NULL) \
         GROUP BY d.id ORDER BY d.name,d.id",
    )
    .bind(db::now())
    .bind(previous)
    .fetch_all(&mut *db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, expires_at)| Holder {
            id,
            name,
            expires_at,
        })
        .collect())
}

fn previous_summary(previous: &DeviceCa, holders: &[Holder]) -> Value {
    let mut out = previous.summary();
    out["devices"] = json!(holders.len());
    out["device_names"] = json!(
        holders
            .iter()
            .take(LISTED)
            .map(|h| h.name.as_str())
            .collect::<Vec<_>>()
    );
    // Retire succeeds by then even if no listed device renews: every one of
    // these certificates has expired.
    out["last_expires_at"] = json!(holders.iter().map(|h| h.expires_at.as_str()).max());
    out
}

/// The device CAs a server trusts: the current one and, during a rotation's
/// overlap, the previous one with the devices still holding its certificates.
pub async fn status(db: &mut SqliteConnection, keys: &crypto::Keys) -> Result<Value> {
    let previous = match keys.previous_device_ca() {
        Some(previous) => previous_summary(previous, &holders(db, &previous.sha256).await?),
        None => Value::Null,
    };
    Ok(json!({"current":keys.device_ca().summary(),"previous":previous}))
}

fn short(sha256: &str) -> &str {
    &sha256[..16.min(sha256.len())]
}

/// Make a new device CA current and keep the replaced one as previous.
/// Refuses while a previous CA is still trusted: one overlap at a time.
pub async fn rotate(s: &State) -> anyhow::Result<Value> {
    let dir = s.settings.data_dir.join("keys");
    if s.keys.previous_device_ca().is_some() || dir.join(PREVIOUS_DEVICE_CA).exists() {
        anyhow::bail!(
            "The previous device CA {} is still trusted. Retire it first with vectory-admin retire-device-ca, then rotate again.",
            s.keys
                .previous_device_ca()
                .map_or("", |previous| short(&previous.sha256))
        )
    }
    let old = s.keys.device_ca().clone();
    let mut suffix = [0u8; 4];
    rand::rngs::OsRng.fill_bytes(&mut suffix);
    // A distinct subject for every CA, so a certificate's issuer names one.
    let (key, certificate) = crypto::new_device_ca(&format!(
        "Vectory device CA {} {}",
        chrono::Utc::now().format("%Y-%m-%d"),
        hex::encode(suffix)
    ))?;
    let new = DeviceCa::from_pem(&certificate)?;
    let mut tx = s.pool.begin().await?;
    db::audit(
        &mut tx,
        "local-admin",
        "signing.device_ca.rotate.prepare",
        &format!("{}:{}", old.sha256, new.sha256),
        "prepared",
    )
    .await
    .map_err(|e| anyhow::anyhow!(e.message))?;
    tx.commit().await?;
    // Stage the new CA, commit by recording the current one as previous, then
    // let the loader's own crash recovery move the new files into place.
    crate::maintenance::atomic_private_replace(&dir.join(NEXT_DEVICE_CA_KEY), key.as_bytes())?;
    crate::maintenance::atomic_private_replace(&dir.join(NEXT_DEVICE_CA), certificate.as_bytes())?;
    crate::maintenance::atomic_private_replace(
        &dir.join(PREVIOUS_DEVICE_CA),
        s.keys.ca_pem.as_bytes(),
    )?;
    crypto::settle_device_ca_rotation(&dir)?;
    let mut tx = s.pool.begin().await?;
    db::audit(
        &mut tx,
        "local-admin",
        "signing.device_ca.rotate",
        &new.sha256,
        "success",
    )
    .await
    .map_err(|e| anyhow::anyhow!(e.message))?;
    let holders = holders(&mut tx, &old.sha256)
        .await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    tx.commit().await?;
    Ok(json!({"current":new.summary(),"previous":previous_summary(&old, &holders)}))
}

/// Stop trusting the previous device CA once no active device holds a
/// certificate it issued. Without `apply` this only reports whether it can.
/// The report's `ready` says whether retiring was (or would be) possible.
pub async fn retire(s: &State, apply: bool) -> anyhow::Result<Value> {
    let dir = s.settings.data_dir.join("keys");
    let file = dir.join(PREVIOUS_DEVICE_CA);
    let Some(previous) = s.keys.previous_device_ca().filter(|_| file.exists()) else {
        anyhow::bail!("No previous device CA is trusted, so there is nothing to retire.")
    };
    if DeviceCa::from_pem(&std::fs::read_to_string(&file)?)?.sha256 != previous.sha256 {
        anyhow::bail!("The keys directory changed while this command ran; run it again.")
    }
    let mut conn = s.pool.acquire().await?;
    let holders = holders(&mut conn, &previous.sha256)
        .await
        .map_err(|e| anyhow::anyhow!(e.message))?;
    drop(conn);
    let mut report = json!({"previous":previous_summary(previous, &holders),"ready":holders.is_empty(),"retired":false});
    if !apply || !holders.is_empty() {
        return Ok(report);
    }
    std::fs::remove_file(&file)?;
    #[cfg(unix)]
    std::fs::File::open(&dir)?.sync_all()?;
    let mut tx = s.pool.begin().await?;
    db::audit(
        &mut tx,
        "local-admin",
        "signing.device_ca.retire",
        &previous.sha256,
        "success",
    )
    .await
    .map_err(|e| anyhow::anyhow!(e.message))?;
    tx.commit().await?;
    report["retired"] = json!(true);
    Ok(report)
}
