//! One-shot, actor-scoped account creation identities. A completed request is
//! recovered through a secret-free read; POST is never replayed or re-applied.
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
use sqlx::SqliteConnection;

type Entry = (String, Option<String>);

fn no_query(raw: Option<&str>) -> Result<()> {
    if raw.is_some_and(|query| !query.is_empty()) {
        return Err(ApiError::invalid(
            "User creation requests do not accept query parameters",
        ));
    }
    Ok(())
}

async fn entry(db: &mut SqliteConnection, actor: &str, key: &str) -> Result<Option<Entry>> {
    Ok(
        sqlx::query_as("SELECT state,user_id FROM user_requests WHERE actor_id=? AND request_id=?")
            .bind(actor)
            .bind(key)
            .fetch_optional(db)
            .await?,
    )
}

async fn status(db: &mut SqliteConnection, key: &str, prior: Option<Entry>) -> Result<Value> {
    match prior {
        None => Ok(json!({"request_id":key,"status":"not_found"})),
        Some((state, None)) if state == "cancelled" => {
            Ok(json!({"request_id":key,"status":"cancelled"}))
        }
        Some((state, Some(id))) if state == "created" => {
            let user = sqlx::query("SELECT * FROM users WHERE id=?")
                .bind(id)
                .fetch_optional(db)
                .await?
                .ok_or_else(|| ApiError::conflict("The created user is unavailable"))?;
            Ok(json!({"request_id":key,"status":"created","user":auth::public_user(&user)}))
        }
        _ => Err(ApiError::conflict("User creation request is invalid")),
    }
}

pub(crate) async fn create(s: &State, h: &HeaderMap, v: &Value, key: &str) -> Result<Json<Value>> {
    let actor = auth::authorize(s, h, &["admin"], true).await?;
    let actor_id = actor["id"].as_str().unwrap();
    // A completed or cancelled request never validates or hashes a password
    // again. This fast read is only an optimization; the writer check below is
    // authoritative for races with another create or cancellation.
    let existing: Option<Entry> =
        sqlx::query_as("SELECT state,user_id FROM user_requests WHERE actor_id=? AND request_id=?")
            .bind(actor_id)
            .bind(key)
            .fetch_optional(&s.pool)
            .await?;
    if existing.is_some() {
        return Err(ApiError::conflict(
            "This user creation request already finished. Check its status.",
        ));
    }
    if v.as_object().is_none_or(|fields| {
        fields.len() != 5
            || fields.keys().any(|field| {
                !matches!(
                    field.as_str(),
                    "request_id" | "name" | "email" | "password" | "role"
                )
            })
    }) {
        return Err(ApiError::invalid(
            "A keyed user creation requires request_id, name, email, password, and role",
        ));
    }
    let email = auth::user_email(v)?;
    let name = db::string(v, "name", 100)?;
    let password = db::string(v, "password", 256)?;
    auth::check_password(password)?;
    let role = db::string(v, "role", 20)?;
    if !["viewer", "editor", "operator", "admin"].contains(&role) {
        return Err(ApiError::invalid("Invalid role"));
    }
    let password_hash = auth::password_hash(password.to_owned()).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, h, &["admin"], true).await?;
    let actor_id = actor["id"].as_str().unwrap();
    if entry(&mut tx, actor_id, key).await?.is_some() {
        return Err(ApiError::conflict(
            "This user creation request already finished. Check its status.",
        ));
    }
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM users WHERE email=?")
        .bind(&email)
        .fetch_one(&mut *tx)
        .await?;
    if exists > 0 {
        return Err(ApiError::conflict("Email is already registered"));
    }
    let id = db::id();
    let user = json!({"id":id,"email":email,"name":name,"role":role,"enabled":true,"revision":1});
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&email)
    .bind(name)
    .bind(role)
    .bind(password_hash)
    .bind(db::now())
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO user_requests(actor_id,request_id,state,user_id,created_at) VALUES(?,?,'created',?,?)")
        .bind(actor_id)
        .bind(key)
        .bind(&id)
        .bind(db::now())
        .execute(&mut *tx)
        .await?;
    db::audit(&mut tx, actor_id, "user.create", &id, "success").await?;
    tx.commit().await?;
    Ok(Json(json!({"request_id":key,"user":user})))
}

pub async fn lookup(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], false).await?;
    no_query(raw.as_deref())?;
    let key = crate::deployment_requests::parse_id(&id)?;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], false).await?;
    let prior = entry(&mut tx, actor["id"].as_str().unwrap(), &key).await?;
    let result = status(&mut tx, &key, prior).await?;
    Ok(Json(result))
}

pub async fn cancel(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
    body: axum::body::Bytes,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["admin"], true).await?;
    no_query(raw.as_deref())?;
    if crate::token_requests::parse(&body)? != json!({}) {
        return Err(ApiError::invalid(
            "User creation request cancellation requires an empty object",
        ));
    }
    let key = crate::deployment_requests::parse_id(&id)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["admin"], true).await?;
    let actor_id = actor["id"].as_str().unwrap();
    let prior = entry(&mut tx, actor_id, &key).await?;
    if prior.is_none() {
        let now = db::now();
        sqlx::query("INSERT INTO user_requests(actor_id,request_id,state,created_at,cancelled_at) VALUES(?,?,'cancelled',?,?)")
            .bind(actor_id)
            .bind(&key)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        db::audit(&mut tx, actor_id, "user.request.cancel", &key, "success").await?;
    }
    let result = status(&mut tx, &key, prior.or(Some(("cancelled".into(), None)))).await?;
    tx.commit().await?;
    Ok(Json(result))
}
