//! Actor-scoped access-edit identities. Status returns an immutable public
//! snapshot of the applied edit; cancellation fences a delayed request but
//! never attempts to undo an edit that already committed.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Path, RawQuery, State as AppState},
    http::HeaderMap,
};
use serde_json::{Value, json};
use sqlx::{FromRow, SqliteConnection};

#[derive(FromRow)]
pub(crate) struct Entry {
    user_id: String,
    state: String,
    user_json: Option<String>,
}

pub(crate) fn no_query(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|query| !query.is_empty()) {
        return Err(ApiError::invalid(
            "Access edit requests do not accept query parameters",
        ));
    }
    Ok(())
}

pub(crate) fn already_used() -> ApiError {
    crate::user_requests::already_used()
}

pub(crate) async fn entry(
    conn: &mut SqliteConnection,
    actor: &str,
    key: &str,
    target: &str,
) -> Result<Option<Entry>> {
    let prior: Option<Entry> = sqlx::query_as(
        "SELECT user_id,state,user_json FROM access_edit_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor)
    .bind(key)
    .fetch_optional(conn)
    .await?;
    if prior.as_ref().is_some_and(|entry| entry.user_id != target) {
        return Err(ApiError::conflict(
            "This access edit request ID belongs to another account",
        ));
    }
    Ok(prior)
}

fn status(key: &str, target: &str, prior: Option<&Entry>) -> Result<Value> {
    match prior {
        None => Ok(json!({"request_id":key,"user_id":target,"status":"not_found"})),
        Some(entry) if entry.state == "cancelled" && entry.user_json.is_none() => {
            Ok(json!({"request_id":key,"user_id":target,"status":"cancelled"}))
        }
        Some(entry) if entry.state == "applied" => {
            let user: Value =
                serde_json::from_str(entry.user_json.as_deref().ok_or_else(|| {
                    ApiError::conflict("The access edit request record is incomplete")
                })?)
                .map_err(|_| ApiError::conflict("The access edit request record is invalid"))?;
            if user["id"].as_str() != Some(target) {
                return Err(ApiError::conflict(
                    "The access edit request target is invalid",
                ));
            }
            Ok(json!({"request_id":key,"user_id":target,"status":"applied","user":user}))
        }
        _ => Err(ApiError::conflict(
            "The access edit request record is invalid",
        )),
    }
}

pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((target, key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    no_query(raw.as_deref())?;
    let target = crate::deployment_requests::parse_id(&target)?;
    let key = crate::deployment_requests::parse_id(&key)?;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], false).await?;
    let prior = entry(&mut tx, actor["id"].as_str().unwrap(), &key, &target).await?;
    Ok(Json(status(&key, &target, prior.as_ref())?))
}

pub async fn cancel(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((target, key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    no_query(raw.as_deref())?;
    if crate::token_requests::parse(&body)? != json!({}) {
        return Err(ApiError::invalid(
            "Access edit request cancellation requires an empty object",
        ));
    }
    let target = crate::deployment_requests::parse_id(&target)?;
    let key = crate::deployment_requests::parse_id(&key)?;
    let (_guard, mut tx) = crate::db::write_tx(&s).await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let actor_id = actor["id"].as_str().unwrap();
    let prior = entry(&mut tx, actor_id, &key, &target).await?;
    if prior.is_none() {
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=?")
            .bind(&target)
            .fetch_one(&mut *tx)
            .await?;
        if exists == 0 {
            return Err(ApiError::missing());
        }
        let now = db::now();
        sqlx::query("INSERT INTO access_edit_requests(actor_id,request_id,user_id,state,created_at,cancelled_at) VALUES(?,?,?,'cancelled',?,?)")
            .bind(actor_id)
            .bind(&key)
            .bind(&target)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        db::audit(
            &mut tx,
            actor_id,
            "user.access_request.cancel",
            &target,
            "success",
        )
        .await?;
    }
    let cancelled = Entry {
        user_id: target.clone(),
        state: "cancelled".into(),
        user_json: None,
    };
    let out = status(&key, &target, prior.as_ref().or(Some(&cancelled)))?;
    tx.commit().await?;
    Ok(Json(out))
}
