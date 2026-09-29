//! One-shot administrator reset-code issuance identities. A status read never
//! recovers a one-time code; cancellation fences a delayed POST and revokes only
//! this request's still-current unused verifier.
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
    was_issued: bool,
    verifier: Option<String>,
    expires_at: Option<String>,
}

fn no_query(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|query| !query.is_empty()) {
        return Err(ApiError::invalid(
            "Password reset requests do not accept query parameters",
        ));
    }
    Ok(())
}

pub(crate) fn already_used() -> ApiError {
    ApiError::conflict("This password reset request already finished. Check its status.")
}

pub(crate) async fn entry(
    conn: &mut SqliteConnection,
    actor: &str,
    key: &str,
    target: &str,
) -> Result<Option<Entry>> {
    let prior: Option<Entry> = sqlx::query_as(
        "SELECT user_id,state,was_issued,verifier,expires_at FROM password_reset_requests WHERE actor_id=? AND request_id=?",
    )
    .bind(actor)
    .bind(key)
    .fetch_optional(conn)
    .await?;
    if prior.as_ref().is_some_and(|entry| entry.user_id != target) {
        return Err(ApiError::conflict(
            "This password reset request ID belongs to another account",
        ));
    }
    Ok(prior)
}

async fn status(
    conn: &mut SqliteConnection,
    key: &str,
    entry: Option<&Entry>,
    target: &str,
) -> Result<Value> {
    match entry {
        None => Ok(json!({"request_id":key,"user_id":target,"status":"not_found"})),
        Some(entry) if entry.state == "cancelled" => Ok(json!({
            "request_id":key,"user_id":target,"status":"cancelled","was_issued":entry.was_issued
        })),
        Some(entry) if entry.state == "issued" => {
            let verifier = entry
                .verifier
                .as_deref()
                .ok_or_else(|| ApiError::conflict("The reset request record is incomplete"))?;
            let expires_at = entry
                .expires_at
                .as_deref()
                .ok_or_else(|| ApiError::conflict("The reset request record is incomplete"))?;
            // A later issuance, expiry, redemption, account disable or password
            // change makes this exact request inactive. Another code for the
            // same user must never make this old request appear active.
            let active: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM password_reset_codes r JOIN users u ON u.id=r.user_id JOIN users issuer ON issuer.id=r.issuer_id WHERE r.user_id=? AND r.verifier=? AND r.expires_at>? AND u.enabled=1 AND issuer.enabled=1 AND issuer.role='admin'",
            )
            .bind(target)
            .bind(verifier)
            .bind(db::now())
            .fetch_one(conn)
            .await?;
            Ok(
                json!({"request_id":key,"user_id":target,"status":"issued","active":active>0,"expires_at":expires_at}),
            )
        }
        _ => Err(ApiError::conflict("The reset request record is invalid")),
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
    let result = status(&mut tx, &key, prior.as_ref(), &target).await?;
    Ok(Json(result))
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
            "Password reset request cancellation requires an empty object",
        ));
    }
    let target = crate::deployment_requests::parse_id(&target)?;
    let key = crate::deployment_requests::parse_id(&key)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let actor_id = actor["id"].as_str().unwrap();
    let prior = entry(&mut tx, actor_id, &key, &target).await?;
    let result = match prior.as_ref() {
        Some(prior) if prior.state == "cancelled" => {
            status(&mut tx, &key, Some(prior), &target).await?
        }
        Some(prior) if prior.state == "issued" => {
            let verifier = prior
                .verifier
                .as_deref()
                .ok_or_else(|| ApiError::conflict("The reset request record is incomplete"))?;
            let active: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM password_reset_codes r JOIN users u ON u.id=r.user_id JOIN users issuer ON issuer.id=r.issuer_id WHERE r.user_id=? AND r.verifier=? AND r.expires_at>? AND u.enabled=1 AND issuer.enabled=1 AND issuer.role='admin'",
            )
            .bind(&target)
            .bind(verifier)
            .bind(db::now())
            .fetch_one(&mut *tx)
            .await?;
            let removed =
                sqlx::query("DELETE FROM password_reset_codes WHERE user_id=? AND verifier=?")
                    .bind(&target)
                    .bind(verifier)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected();
            if active > 0 && removed > 0 {
                sqlx::query("UPDATE users SET revision=revision+1 WHERE id=?")
                    .bind(&target)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE password_reset_requests SET state='cancelled',verifier=NULL,expires_at=NULL,cancelled_at=? WHERE actor_id=? AND request_id=?")
                .bind(db::now())
                .bind(actor_id)
                .bind(&key)
                .execute(&mut *tx)
                .await?;
            db::audit(
                &mut tx,
                actor_id,
                "user.password_reset.request.cancel",
                &target,
                "success",
            )
            .await?;
            json!({"request_id":key,"user_id":target,"status":"cancelled","was_issued":true})
        }
        None => {
            // This tombstone wins even if the original HTTP body was sent
            // earlier but has not yet reached the serialized writer.
            let target_exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE id=?")
                .bind(&target)
                .fetch_one(&mut *tx)
                .await?;
            if target_exists == 0 {
                return Err(ApiError::missing());
            }
            sqlx::query("INSERT INTO password_reset_requests(actor_id,request_id,user_id,state,was_issued,created_at,cancelled_at) VALUES(?,?,?,'cancelled',0,?,?)")
                .bind(actor_id)
                .bind(&key)
                .bind(&target)
                .bind(db::now())
                .bind(db::now())
                .execute(&mut *tx)
                .await?;
            db::audit(
                &mut tx,
                actor_id,
                "user.password_reset.request.cancel",
                &target,
                "success",
            )
            .await?;
            json!({"request_id":key,"user_id":target,"status":"cancelled","was_issued":false})
        }
        _ => return Err(ApiError::conflict("The reset request record is invalid")),
    };
    tx.commit().await?;
    Ok(Json(result))
}
