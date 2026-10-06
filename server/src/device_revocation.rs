//! Monotonic device-identity revocation. Status is exact identity state, not
//! attribution to a particular browser attempt or proof the local process stopped.
use crate::{
    State, api, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, Query, RawQuery, State as AppState, rejection::QueryRejection},
    http::HeaderMap,
};
use serde_json::{Value, json};

fn id(value: &str) -> Result<String> {
    crate::deployment_requests::parse_id(value)
        .map_err(|_| ApiError::invalid("device_id must be a hyphenated UUID"))
}
async fn revoked(conn: &mut sqlx::SqliteConnection, id: &str) -> Result<bool> {
    sqlx::query_scalar("SELECT revoked FROM devices WHERE id=?")
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or_else(ApiError::missing)
}
fn receipt(id: &str, revoked: bool) -> Value {
    json!({"device_id":id,"revocation_status":true,"revoked":revoked})
}
/// Everything that follows a device identity's revocation, whether an
/// operator revoked it or an identity recovery replaced it: it leaves its
/// groups and persistent assignments, and since it never checks in again,
/// nothing it reported can resolve on its own, so its open issues close as
/// `revoked`, its delivery state goes and the agent update it was in goes on
/// without it.
pub(crate) async fn retire(tx: &mut sqlx::SqliteConnection, id: &str) -> Result<()> {
    crate::groups::remove_device(tx, id).await?;
    crate::rollout::retire_persistent_targets(tx, id).await?;
    crate::issues::resolve_device(tx, id, "revoked").await?;
    // An agent update it was in goes on without it.
    crate::agent_update_rollouts::device_revoked(tx, id).await?;
    sqlx::query("DELETE FROM data_plane_state WHERE device_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE devices SET data=json_remove(data,'$.data_plane') WHERE id=? AND json_type(data,'$.data_plane') IS NOT NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // It can never answer a device check again.
    crate::device_validations::end_for(tx, id).await?;
    Ok(())
}
pub async fn status(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(source): Path<String>,
    RawQuery(raw): RawQuery,
    parsed: std::result::Result<Query<crate::deployment_history::EmptyQuery>, QueryRejection>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], false).await?;
    crate::deployment_history::query(raw.as_deref(), parsed)?;
    let source = id(&source)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    auth::authorize_in(&mut tx, &h, &["operator"], false).await?;
    Ok(Json(receipt(&source, revoked(&mut tx, &source).await?)))
}
pub async fn post(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(source): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    if raw.is_some_and(|query| !query.is_empty()) {
        return Err(ApiError::invalid(
            "Device revocation does not accept query parameters",
        ));
    }
    // Preserve an omitted legacy action body; supplied content must be {}.
    if !body.is_empty() && crate::token_requests::parse(&body)? != json!({}) {
        return Err(ApiError::invalid(
            "Device revocation requires an empty object",
        ));
    }
    let source = id(&source)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    if !revoked(&mut tx, &source).await? {
        sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
            .bind(&source)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE credentials SET revoked=1 WHERE device_id=? AND revoked=0")
            .bind(&source)
            .execute(&mut *tx)
            .await?;
        retire(&mut tx, &source).await?;
        db::audit(
            &mut tx,
            api::text(&actor, "id"),
            "device.revoke",
            &source,
            "success",
        )
        .await?;
    }
    tx.commit().await?;
    let mut out = receipt(&source, true);
    out["ok"] = json!(true);
    Ok(Json(out))
}
