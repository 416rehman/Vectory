use crate::{
    State, auth, db,
    error::{ApiError, Result},
    rollout, validation,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State as AppState},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde_json::{Value, json};
use sqlx::Row;
use tower_http::services::{ServeDir, ServeFile};

pub fn router(s: State) -> Router {
    let spa = ServeDir::new(&s.settings.dashboard_dir)
        .not_found_service(ServeFile::new(s.settings.dashboard_dir.join("index.html")));
    Router::new()
        .route("/api/v1/status", get(auth::status))
        .route("/api/v1/bootstrap", post(auth::bootstrap))
        .route("/api/v1/login", post(auth::login))
        .route("/api/v1/logout", post(auth::logout))
        .route("/api/v1/session", get(auth::session))
        .route("/api/v1/users", get(auth::users).post(auth::create_user))
        .route("/api/v1/openapi.json", get(openapi))
        .route("/api/v1/mfa", get(crate::mfa::status))
        .route("/api/v1/mfa/{action}", post(crate::mfa::manage))
        .route("/api/v1/deployments/preview", post(deployment_preview))
        .route("/api/v1/vrl/test", post(synthetic_vrl))
        .route("/api/v1/devices/{id}/telemetry", get(telemetry_history))
        .route("/api/v1/{collection}", get(list).post(create))
        .route("/api/v1/{collection}/{id}", get(detail).put(edit_group))
        .route(
            "/api/v1/{collection}/{id}/{action}",
            get(history).post(action).put(draft),
        )
        .route("/api/{*path}", any(|| async { ApiError::missing() }))
        .route("/agent/{*path}", any(|| async { ApiError::missing() }))
        .fallback_service(spa)
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(s)
}
async fn telemetry_history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM devices WHERE id=?")
        .bind(&id)
        .fetch_one(&s.pool)
        .await?;
    if exists == 0 {
        return Err(ApiError::missing());
    }
    let rows = sqlx::query(
        "SELECT bucket,data FROM telemetry WHERE device_id=? ORDER BY bucket DESC LIMIT 120",
    )
    .bind(&id)
    .fetch_all(&s.pool)
    .await?;
    let mut samples = Vec::new();
    for row in rows.into_iter().rev() {
        let mut sample = db::parse(row.get("data"))?;
        sample["bucket"] = json!(row.get::<i64, _>("bucket"));
        samples.push(sample);
    }
    Ok(Json(json!({"device_id":id,"samples":samples})))
}
async fn openapi(AppState(s): AppState<State>, h: HeaderMap) -> Result<Response> {
    auth::authorize(&s, &h, &[], false).await?;
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        include_str!("../../contracts/openapi.json"),
    )
        .into_response())
}
async fn synthetic_vrl(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Json(input): Json<Value>,
) -> Result<Json<Value>> {
    let user = auth::authorize(&s, &h, &["editor"], true).await?;
    db::string(&input, "program", 16384)?;
    if !input["sample"].is_object() || input["sample"].to_string().len() > 65536 {
        return Err(ApiError::invalid(
            "Provide one synthetic sample object of at most64KiB",
        ));
    }
    s.limit(
        format!("vrl:{}", text(&user, "id")),
        20,
        std::time::Duration::from_secs(60),
    )?;
    let url = s.settings.validation_url.as_ref().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "CAPABILITY_DENIED",
            "Isolated synthetic sample runner is not configured",
        )
    })?;
    let _permit = s.validation_slots.try_acquire().map_err(|_| {
        ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Validation capacity busy; retry later",
        )
    })?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| ApiError::invalid("Validator client unavailable"))?;
    let mut response = client
        .post(format!("{}/vrl-test", url.trim_end_matches('/')))
        .json(&input)
        .send()
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "VALIDATION_FAILED",
                "Isolated sample runner unavailable",
            )
        })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "VALIDATION_FAILED",
            "Isolated sample runner unavailable or busy",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::invalid("Sample response failed"))?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err(ApiError::invalid("Sample output exceeds limit"));
        }
        bytes.extend_from_slice(&chunk)
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::invalid("Invalid sample runner response"))?;
    if !value["valid"].is_boolean() || !value["errors"].is_array() {
        return Err(ApiError::invalid("Invalid sample runner response"));
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    db::audit(
        &mut tx,
        text(&user, "id"),
        "vrl.synthetic_test",
        "",
        if value["valid"] == true {
            "success"
        } else {
            "failed"
        },
    )
    .await?;
    tx.commit().await?;
    Ok(Json(value))
}
pub async fn security_headers(request: Request, next: Next) -> Response {
    let api =
        request.uri().path().starts_with("/api/") || request.uri().path().starts_with("/agent/");
    let request_id = db::id();
    let mut response = db::REQUEST_ID
        .scope(request_id.clone(), next.run(request))
        .await;
    if api
        && (response.status().is_client_error() || response.status().is_server_error())
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("application/json"))
    {
        let status = response.status();
        let message = match status {
            StatusCode::PAYLOAD_TOO_LARGE => "Request exceeds the allowed size",
            StatusCode::NOT_FOUND => "Route not found",
            StatusCode::METHOD_NOT_ALLOWED => "Method not supported",
            _ => "Request is malformed or unsupported",
        };
        response = ApiError::new(
            status,
            if status == StatusCode::NOT_FOUND {
                "NOT_FOUND"
            } else {
                "INVALID_INPUT"
            },
            message,
        )
        .into_response();
    }
    let headers = response.headers_mut();
    headers.insert("x-request-id", HeaderValue::from_str(&request_id).unwrap());
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"));
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub async fn list(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(collection): Path<String>,
) -> Result<Json<Value>> {
    auth::authorize(
        &s,
        &h,
        if collection == "tokens" {
            &["operator"]
        } else {
            &[]
        },
        false,
    )
    .await?;
    let mut conn = s.pool.acquire().await?;
    let out = match collection.as_str() {
        "devices" => json!(rollout::devices(&mut conn).await?),
        "deployments" => json!(rollout::deployments(&mut conn).await?),
        "configurations" => json!(db::records(&mut conn, "configuration").await?),
        "groups" => json!(db::records(&mut conn, "group").await?),
        "policies" => json!(db::records(&mut conn, "policy").await?),
        "issues" => json!(db::records(&mut conn, "issue").await?),
        "audit" => json!(audit_view(&mut conn).await?),
        "tokens" => {
            let rows = sqlx::query("SELECT data FROM enrollment_tokens ORDER BY id")
                .fetch_all(&mut *conn)
                .await?;
            json!(
                rows.iter()
                    .map(|r| db::parse(r.get(0)))
                    .collect::<Result<Vec<_>>>()?
            )
        }
        "releases" => json!(releases(&s).await?),
        "settings" => {
            json!({"version":env!("CARGO_PKG_VERSION"),"vector_version":validation::VECTOR_VERSION,"heartbeat_seconds":60,"telemetry_retention_days":db::telemetry_retention_days(),"instance_name":s.settings.instance_name})
        }
        "overview" => {
            let devices = rollout::devices(&mut conn).await?;
            let configurations = db::records(&mut conn, "configuration").await?;
            let deployments = db::records(&mut conn, "deployment").await?;
            let issues = db::records(&mut conn, "issue").await?;
            let audit = audit_view(&mut conn).await?;
            json!({"devices_total":devices.len(),"devices_online":devices.iter().filter(|d|!matches!(text(d,"status"),"offline"|"revoked")).count(),"configurations_total":configurations.len(),"deployments_active":deployments.iter().filter(|d|matches!(text(d,"status"),"active"|"paused")).count(),"issues_open":issues.iter().filter(|i|i["resolved"]!=true).count(),"devices":devices,"recent_activity":audit.into_iter().take(20).collect::<Vec<_>>()})
        }
        _ => return Err(ApiError::missing()),
    };
    Ok(Json(out))
}
pub async fn detail(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
) -> Result<Response> {
    auth::authorize(&s, &h, &[], false).await?;
    let mut conn = s.pool.acquire().await?;
    let out = match collection.as_str() {
        "devices" => rollout::devices(&mut conn)
            .await?
            .into_iter()
            .find(|d| d["id"] == id)
            .ok_or_else(ApiError::missing)?,
        "configurations" => db::record(&mut conn, "configuration", &id).await?,
        "versions" => db::record(&mut conn, "version", &id).await?,
        "deployments" => rollout::deployment(&mut conn, &id).await?,
        "releases" => {
            let catalog = releases(&s).await?;
            let metadata = catalog
                .iter()
                .find(|r| r["name"] == id)
                .ok_or_else(ApiError::missing)?;
            let bytes = tokio::fs::read(s.settings.releases_dir.join(&id))
                .await
                .map_err(|_| ApiError::missing())?;
            if db::hash(&bytes) != text(metadata, "sha256") {
                return Err(ApiError::conflict("Release integrity check failed"));
            }
            let mut response = bytes.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            response.headers_mut().insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&format!("attachment; filename=\"{id}\""))
                    .map_err(|_| ApiError::invalid("Invalid filename"))?,
            );
            return Ok(response);
        }
        _ => return Err(ApiError::missing()),
    };
    Ok(Json(out).into_response())
}
pub async fn history(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id, action)): Path<(String, String, String)>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &[], false).await?;
    if collection != "configurations" {
        return Err(ApiError::missing());
    }
    let mut conn = s.pool.acquire().await?;
    db::record(&mut conn, "configuration", &id).await?;
    let kind = match action.as_str() {
        "revisions" => "revision",
        "versions" => "version",
        _ => return Err(ApiError::missing()),
    };
    Ok(Json(json!(
        db::records(&mut conn, kind)
            .await?
            .into_iter()
            .filter(|v| v["configuration_id"] == id)
            .collect::<Vec<_>>()
    )))
}
pub async fn create(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(collection): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let actor = auth::authorize(
        &s,
        &h,
        if collection == "configurations" {
            &["editor"]
        } else {
            &["operator"]
        },
        true,
    )
    .await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let out = match collection.as_str() {
        "configurations" => {
            let name = db::string(&v, "name", 120)?;
            validate_draft(&v)?;
            let record = json!({"id":db::id(),"name":name,"description":description(&v)?,"revision":1,"graph":v["graph"],"config":v["config"],"created_at":db::now(),"updated_at":db::now()});
            db::insert(&mut tx, "configuration", &record).await?;
            revision(&mut tx, &record, text(&actor, "name"), "Initial draft").await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "configuration.create",
                text(&record, "id"),
                "success",
            )
            .await?;
            record
        }
        "groups" => {
            let group = group(&mut tx, &v, None).await?;
            db::insert(&mut tx, "group", &group).await?;
            rollout::reconcile_membership(&mut tx).await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "group.create",
                text(&group, "id"),
                "success",
            )
            .await?;
            group
        }
        "deployments" => rollout::create(&mut tx, &v, text(&actor, "id")).await?,
        "policies" => {
            db::validate_policy(&v["policy"])?;
            let p = json!({"id":db::id(),"name":db::string(&v,"name",120)?,"policy":v["policy"],"created_at":db::now()});
            db::insert(&mut tx, "policy", &p).await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "policy.create",
                text(&p, "id"),
                "success",
            )
            .await?;
            p
        }
        "tokens" => {
            let hours = v["expires_hours"]
                .as_u64()
                .filter(|h| (1..=720).contains(h))
                .ok_or_else(|| ApiError::invalid("expires_hours must be 1..720"))?;
            let max = v["max_uses"].as_u64();
            if !v["max_uses"].is_null() && max.is_none_or(|n| n == 0 || n > 100000) {
                return Err(ApiError::invalid("max_uses must be 1..100000"));
            }
            let prefix = v["name_prefix"].as_str().unwrap_or("");
            if prefix.len() > 80
                || !prefix
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            {
                return Err(ApiError::invalid(
                    "name_prefix must use lowercase letters, digits or hyphens",
                ));
            }
            let secret = auth::random_secret();
            let record = json!({"id":db::id(),"name":db::string(&v,"name",120)?,"expires_at":(chrono::Utc::now()+chrono::Duration::hours(hours as i64)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"uses":0,"max_uses":max,"name_prefix":if prefix.is_empty(){Value::Null}else{json!(prefix)},"revoked":false,"created_at":db::now()});
            sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
                .bind(text(&record, "id"))
                .bind(db::hash(&secret))
                .bind(record.to_string())
                .execute(&mut *tx)
                .await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "token.create",
                text(&record, "id"),
                "success",
            )
            .await?;
            json!({"token":secret,"record":record})
        }
        _ => return Err(ApiError::missing()),
    };
    tx.commit().await?;
    Ok(Json(out))
}
fn description(v: &Value) -> Result<String> {
    let d = v["description"].as_str().unwrap_or("");
    if d.len() > 2000 {
        return Err(ApiError::invalid("Description is too long"));
    }
    Ok(d.into())
}
fn validate_draft(v: &Value) -> Result<()> {
    if !v["config"].is_object()
        || !v["graph"]["nodes"].is_array()
        || !v["graph"]["edges"].is_array()
    {
        return Err(ApiError::invalid(
            "Provide a config object and graph with nodes and edges arrays",
        ));
    }
    if v["graph"]["nodes"].as_array().unwrap().len() > 1000
        || v["graph"]["edges"].as_array().unwrap().len() > 5000
    {
        return Err(ApiError::invalid("Graph exceeds 1000 nodes or 5000 edges"));
    }
    for field in ["config", "graph"] {
        let security = validation::validate(&v[field]);
        if security["errors"].as_array().unwrap().iter().any(|e| {
            e.as_str()
                .is_some_and(|s| s.contains("Plaintext credentials"))
        }) {
            return Err(ApiError::invalid(
                "Plaintext credentials cannot be stored in draft history",
            ));
        }
    }
    Ok(())
}
async fn revision(
    conn: &mut sqlx::SqliteConnection,
    c: &Value,
    author: &str,
    message: &str,
) -> Result<()> {
    db::insert(conn,"revision",&json!({"id":db::id(),"configuration_id":c["id"],"revision":c["revision"],"graph":c["graph"],"config":c["config"],"message":message,"created_at":db::now(),"author":author})).await
}
pub async fn draft(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id, action)): Path<(String, String, String)>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &["editor"], true).await?;
    if collection != "configurations" || action != "draft" {
        return Err(ApiError::missing());
    }
    validate_draft(&v)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let mut c = db::record(&mut tx, "configuration", &id).await?;
    if v["revision"].as_u64() != c["revision"].as_u64() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Draft changed; reload before saving",
        ));
    }
    c["revision"] = json!(c["revision"].as_u64().unwrap_or(0) + 1);
    c["graph"] = v["graph"].clone();
    c["config"] = v["config"].clone();
    c["updated_at"] = json!(db::now());
    let message = v["message"].as_str().unwrap_or("");
    if message.len() > 2000 {
        return Err(ApiError::invalid("Message is too long"));
    }
    db::update(&mut tx, "configuration", &c).await?;
    revision(&mut tx, &c, text(&actor, "name"), message).await?;
    db::audit(
        &mut tx,
        text(&actor, "id"),
        "configuration.save",
        &id,
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(Json(c))
}
async fn group(conn: &mut sqlx::SqliteConnection, v: &Value, id: Option<&str>) -> Result<Value> {
    let members = v["device_ids"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("device_ids must be an array"))?;
    if members.len() > 10000 {
        return Err(ApiError::invalid("Too many group members"));
    }
    let selector = json!({"device_ids":members,"group_ids":[],"exclude_ids":[]});
    let members = rollout::select(conn, &selector).await?;
    Ok(
        json!({"id":id.map(str::to_owned).unwrap_or_else(db::id),"name":db::string(v,"name",120)?,"description":description(v)?,"device_ids":members,"created_at":db::now()}),
    )
}
pub async fn edit_group(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    let actor = auth::authorize(&s, &h, &["operator"], true).await?;
    if collection != "groups" {
        return Err(ApiError::missing());
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let previous = db::record(&mut tx, "group", &id).await?;
    let mut g = group(&mut tx, &v, Some(&id)).await?;
    g["created_at"] = previous["created_at"].clone();
    db::update(&mut tx, "group", &g).await?;
    rollout::reconcile_membership(&mut tx).await?;
    db::audit(&mut tx, text(&actor, "id"), "group.update", &id, "success").await?;
    tx.commit().await?;
    Ok(Json(g))
}
pub async fn action(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id, action)): Path<(String, String, String)>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>> {
    let role = if collection == "configurations" && action == "validate" {
        "editor"
    } else if collection == "devices" && action == "recover" {
        "admin"
    } else {
        "operator"
    };
    let actor = auth::authorize(&s, &h, &[role], true).await?;
    let v = body.map(|j| j.0).unwrap_or_else(|| json!({}));
    let mut checked = None;
    if collection == "configurations" && (action == "validate" || action == "publish") {
        let mut conn = s.pool.acquire().await?;
        let configuration = db::record(&mut conn, "configuration", &id).await?;
        drop(conn);
        if action == "validate" {
            return Ok(Json(validation::validate_isolated(&s, &v["config"]).await?));
        }
        if configuration["revision"] != v["revision"] {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "STALE_REVISION",
                "Draft changed; review before publishing",
            ));
        }
        checked = Some(validation::validate_isolated(&s, &configuration["config"]).await?);
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let out = match (collection.as_str(), action.as_str()) {
        ("configurations", "validate") => {
            db::record(&mut tx, "configuration", &id).await?;
            validation::validate(&v["config"])
        }
        ("configurations", "publish") => {
            let c = db::record(&mut tx, "configuration", &id).await?;
            if v["revision"].as_u64() != c["revision"].as_u64() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "STALE_REVISION",
                    "Draft changed; review before publishing",
                ));
            }
            let validation = checked.unwrap_or_else(|| validation::validate(&c["config"]));
            if validation["valid"] != true {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "VALIDATION_FAILED",
                    validation["errors"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("; "),
                ));
            }
            let artifact = validation::render(&c["config"])
                .map_err(|_| ApiError::invalid("Cannot render artifact"))?;
            if artifact.len() > 1024 * 1024 {
                return Err(ApiError::invalid("Artifact exceeds 1 MiB"));
            }
            let number = db::records(&mut tx, "version")
                .await?
                .iter()
                .filter(|p| p["configuration_id"] == id)
                .map(|p| p["number"].as_u64().unwrap_or(0))
                .max()
                .unwrap_or(0)
                + 1;
            let message = v["message"].as_str().unwrap_or("");
            if message.len() > 2000 {
                return Err(ApiError::invalid("Message is too long"));
            }
            let version = json!({"id":db::id(),"configuration_id":id,"number":number,"graph":c["graph"],"config":c["config"],"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now(),"message":message,"validation":validation,"uses_local_secrets":validation::local_secret_references(&c["config"]).0});
            db::insert(&mut tx, "version", &version).await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "configuration.publish",
                text(&version, "id"),
                "success",
            )
            .await?;
            version
        }
        ("devices", "revoke") => {
            let found = sqlx::query("UPDATE devices SET revoked=1 WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            if found.rows_affected() == 0 {
                return Err(ApiError::missing());
            }
            sqlx::query("UPDATE credentials SET revoked=1 WHERE device_id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            for mut group in db::records(&mut tx, "group").await? {
                if let Some(a) = group["device_ids"].as_array_mut() {
                    a.retain(|x| x != &id)
                }
                db::update(&mut tx, "group", &group).await?;
            }
            db::audit(&mut tx, text(&actor, "id"), "device.revoke", &id, "success").await?;
            json!({"ok":true})
        }
        ("devices", "recover") => {
            let row = sqlx::query("SELECT name FROM devices WHERE id=?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(ApiError::missing)?;
            let name: String = row.get("name");
            if name.contains("#retired-") {
                return Err(ApiError::conflict(
                    "This identity has already been replaced",
                ));
            }
            let secret = auth::random_secret();
            let record = json!({"id":db::id(),"name":format!("Recovery for {name}"),"expires_at":(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs,true),"uses":0,"max_uses":1,"name_prefix":Value::Null,"recovery_device_id":id,"recovery_name":name,"revoked":false,"created_at":db::now()});
            sqlx::query("INSERT INTO enrollment_tokens(id,verifier,data) VALUES(?,?,?)")
                .bind(text(&record, "id"))
                .bind(db::hash(&secret))
                .bind(record.to_string())
                .execute(&mut *tx)
                .await?;
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "device.recovery_authorize",
                &id,
                "success",
            )
            .await?;
            json!({"token":secret,"record":record})
        }
        ("devices", "retry") => {
            s.limit(format!("retry:{id}"), 1, std::time::Duration::from_secs(60))?;
            let row=sqlx::query("SELECT assignment_id FROM devices WHERE id=? AND revoked=0 AND desired_version_id IS NOT NULL").bind(&id).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::conflict("Only a currently managed, nonrevoked device can retry"))?;
            sqlx::query("UPDATE devices SET desired_generation=desired_generation+1 WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            let generation: i64 =
                sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
                    .bind(&id)
                    .fetch_one(&mut *tx)
                    .await?;
            if let Some(assignment) = row.get::<Option<String>, _>("assignment_id") {
                sqlx::query("UPDATE deployment_targets SET state='desired',generation=?,verified_at=NULL,error=NULL WHERE deployment_id=? AND device_id=?").bind(generation).bind(&assignment).bind(&id).execute(&mut *tx).await?;
                let mut d = db::record(&mut tx, "deployment", &assignment).await?;
                if d["status"] == "completed" {
                    d["status"] = json!("active");
                    d["observation_started_at"] = Value::Null;
                    db::update(&mut tx, "deployment", &d).await?;
                }
            }
            db::audit(&mut tx, text(&actor, "id"), "device.retry", &id, "success").await?;
            rollout::devices(&mut tx)
                .await?
                .into_iter()
                .find(|d| d["id"] == id)
                .ok_or_else(ApiError::missing)?
        }
        ("tokens", "revoke") => {
            let raw: String = sqlx::query_scalar("SELECT data FROM enrollment_tokens WHERE id=?")
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(ApiError::missing)?;
            let mut record = db::parse(&raw)?;
            record["revoked"] = json!(true);
            sqlx::query("UPDATE enrollment_tokens SET data=? WHERE id=?")
                .bind(record.to_string())
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            db::audit(&mut tx, text(&actor, "id"), "token.revoke", &id, "success").await?;
            json!({"ok":true})
        }
        ("deployments", "refresh-preview") => {
            let mut deployment = db::record(&mut tx, "deployment", &id).await?;
            if deployment["status"] != "scheduled" {
                return Err(ApiError::conflict(
                    "Only an unactivated schedule can refresh targets",
                ));
            }
            deployment["scheduled_at"] = Value::Null;
            rollout::preview(&mut tx, &deployment).await?
        }
        ("deployments", "unassign-preview") => {
            let deployment = rollout::deployment(&mut tx, &id).await?;
            let ids: std::collections::BTreeSet<String> = deployment["targets"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|t| t["device_id"].as_str().map(str::to_owned))
                .collect();
            rollout::action(&mut tx, &id, "unassign", text(&actor, "id")).await?;
            let devices = rollout::devices(&mut tx)
                .await?
                .into_iter()
                .filter(|d| ids.contains(text(d, "id")))
                .collect::<Vec<_>>();
            // Explicit rollback: a preview must never alter generations or append audit events.
            tx.rollback().await?;
            return Ok(Json(
                json!({"devices":devices,"conflicts":[],"warnings":["Removing the last configuration assignment marks a device unmanaged while retaining its running Vector workload. Lower-priority released assignments may become effective."]}),
            ));
        }
        ("deployments", "refresh") => {
            let deployment = db::record(&mut tx, "deployment", &id).await?;
            if deployment["status"] != "scheduled" {
                return Err(ApiError::conflict(
                    "Schedule activation already started or schedule is inactive",
                ));
            }
            let selected = rollout::select(&mut tx, &deployment["selector"]).await?;
            let expected = v["expected_device_ids"]
                .as_array()
                .ok_or_else(|| ApiError::invalid("Provide the reviewed expected_device_ids"))?
                .iter()
                .map(|id| {
                    id.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| ApiError::invalid("Invalid expected device ID"))
                })
                .collect::<Result<std::collections::BTreeSet<_>>>()?;
            if expected != selected {
                return Err(ApiError::conflict(
                    "Group membership changed after preview; review again",
                ));
            }
            if selected.is_empty() {
                return Err(ApiError::invalid("Schedule must have at least one target"));
            }
            sqlx::query("DELETE FROM deployment_targets WHERE deployment_id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            for target in selected {
                sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id) VALUES(?,?)")
                    .bind(&id)
                    .bind(target)
                    .execute(&mut *tx)
                    .await?;
            }
            db::audit(
                &mut tx,
                text(&actor, "id"),
                "deployment.refresh_targets",
                &id,
                "success",
            )
            .await?;
            rollout::deployment(&mut tx, &id).await?
        }
        ("deployments", _) => rollout::action(&mut tx, &id, &action, text(&actor, "id")).await?,
        _ => return Err(ApiError::missing()),
    };
    tx.commit().await?;
    Ok(Json(out))
}
pub async fn deployment_preview(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    Ok(Json(rollout::preview(&mut tx, &v).await?))
}
async fn releases(s: &State) -> Result<Vec<Value>> {
    let bytes = match tokio::fs::read(s.settings.releases_dir.join("catalog.json")).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(ApiError::invalid("Release catalog unavailable")),
    };
    if bytes.len() > 1024 * 1024 {
        return Err(ApiError::invalid("Release catalog is too large"));
    }
    let entries: Vec<Value> = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::invalid("Release catalog is invalid"))?;
    let mut out = Vec::new();
    for mut e in entries.into_iter().take(100) {
        let name = text(&e, "name");
        if name.is_empty()
            || name.starts_with('.')
            || name.len() > 150
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            continue;
        }
        let path = s.settings.releases_dir.join(name);
        let meta = match tokio::fs::symlink_metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file()
            || meta.len() > 128 * 1024 * 1024
            || e["size"].as_u64() != Some(meta.len())
        {
            continue;
        }
        let content = tokio::fs::read(&path)
            .await
            .map_err(|_| ApiError::missing())?;
        if db::hash(content) != text(&e, "sha256") {
            continue;
        }
        e["url"] = json!(format!("/api/v1/releases/{name}"));
        e["signed"] = json!(false);
        out.push(e)
    }
    Ok(out)
}
async fn audit_view(conn: &mut sqlx::SqliteConnection) -> Result<Vec<Value>> {
    let mut names = std::collections::HashMap::<String, String>::new();
    for row in sqlx::query("SELECT id,name FROM users UNION ALL SELECT id,name FROM devices")
        .fetch_all(&mut *conn)
        .await?
    {
        names.insert(row.get("id"), row.get("name"));
    }
    let mut entries = db::records(conn, "audit").await?;
    for entry in &mut entries {
        let actor = text(entry, "actor").to_owned();
        entry["actor_id"] = json!(actor);
        if let Some(name) = names.get(&actor) {
            entry["actor"] = json!(name)
        }
    }
    Ok(entries)
}
