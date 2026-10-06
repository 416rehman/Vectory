//! The offer: the manifest member `agent_update` that the signed manifest of a
//! check-in carries for a device an update rollout released a build to.
//!
//! The server's manifest signature makes the offer fresh and addressed to the
//! device; it authorizes no code. The host derives everything it acts on from
//! the release manifest after verifying the release's signatures and rollover
//! statements against the keys it pinned.
use super::review::{Statements, facts};
use crate::{
    agent_releases::{self, Artifact},
    error::Result,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeSet;

/// Target states that carry an offer.
pub const OFFERED_STATES: [&str; 5] = [
    "offered",
    "downloading",
    "staged",
    "waiting_for_host",
    "waiting_for_window",
];

/// What a device is offered right now.
pub struct Offer {
    pub rollout_id: String,
    pub release_id: String,
    pub manifest: Vec<u8>,
    pub signature: Vec<u8>,
    pub rollovers: Vec<(String, String)>,
    pub artifact: Artifact,
}
impl Offer {
    /// The manifest member, as the contract writes it.
    pub fn member(&self) -> Value {
        json!({
            "rollout_id": self.rollout_id,
            "release_id": self.release_id,
            "manifest": STANDARD.encode(&self.manifest),
            "signatures": STANDARD.encode(&self.signature),
            "rollovers": self.rollovers.iter().map(|(statement, signature)| json!({"statement":statement,"signature":signature})).collect::<Vec<_>>(),
            "artifact": {
                "sha256": self.artifact.sha256,
                "size": self.artifact.size,
                "path": path(&self.artifact.sha256),
            },
        })
    }
}
/// Where a build is downloaded from.
pub fn path(sha256: &str) -> String {
    format!("/agent/v1/agent-releases/{sha256}")
}

/// The offer a device holds, when it holds one: updates are on and not
/// stopped, its target is in a stage of an active rollout and has an offer, the
/// release is ready and has not expired, and a key it pins reaches the
/// release's signer within eight statements. Anything else, a paused or
/// finished rollout, a revoked key or Stop all updates included, takes it away.
pub async fn for_device(
    conn: &mut SqliteConnection,
    device: &str,
    now: &str,
) -> Result<Option<Offer>> {
    let held: Option<(String, String)> = sqlx::query_as(
        "SELECT t.rollout_id,ro.release_id FROM agent_update_targets t JOIN agent_update_rollouts ro ON ro.id=t.rollout_id WHERE t.device_id=? AND t.state IN ('offered','downloading','staged','waiting_for_host','waiting_for_window') AND ro.status='active'",
    )
    .bind(device)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((rollout, release_id)) = held else {
        return Ok(None);
    };
    let setting = super::setting(conn).await?;
    if !setting.enabled || setting.stopped.is_some() {
        return Ok(None);
    }
    let release = agent_releases::load(conn, &release_id).await?;
    if !release.offerable(now) {
        return Ok(None);
    }
    let Some(signer) = release.signer.clone() else {
        return Ok(None);
    };
    let revoked: Option<bool> =
        sqlx::query_scalar("SELECT state='revoked' FROM agent_release_keys WHERE fingerprint=?")
            .bind(&signer)
            .fetch_optional(&mut *conn)
            .await?;
    if revoked != Some(false) {
        return Ok(None);
    }
    let ids = BTreeSet::from([device.to_owned()]);
    let Some(facts) = facts(conn, &ids, "").await?.pop() else {
        return Ok(None);
    };
    let Some(artifact) = release.artifact_for(&facts.os, &facts.arch).cloned() else {
        return Ok(None);
    };
    let Some(rollovers) = Statements::load(conn).await?.chain(&facts.pins(), &signer) else {
        return Ok(None);
    };
    let row = sqlx::query("SELECT manifest,signature FROM agent_releases WHERE id=?")
        .bind(&release_id)
        .fetch_one(&mut *conn)
        .await?;
    let Some(signature) = row.get::<Option<Vec<u8>>, _>("signature") else {
        return Ok(None);
    };
    Ok(Some(Offer {
        rollout_id: rollout,
        release_id,
        manifest: row.get("manifest"),
        signature,
        rollovers,
        artifact,
    }))
}
