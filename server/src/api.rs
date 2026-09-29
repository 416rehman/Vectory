use crate::{
    State, auth, db,
    error::{ApiError, Result},
    rollout, validation,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State as AppState},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Redirect, Response},
    routing::{any, delete, get, post, put},
};
use serde_json::{Value, json};
use sqlx::Row;
use tower_http::services::{ServeDir, ServeFile};

pub fn router(s: State) -> Router {
    let spa = ServeDir::new(&s.settings.dashboard_dir)
        .not_found_service(ServeFile::new(s.settings.dashboard_dir.join("index.html")));
    // Keep the full URI so directory redirects retain the /help prefix. The
    // dedicated fallback must never turn a missing help page into the app SPA.
    let help = ServeDir::new(&s.settings.dashboard_dir).not_found_service(ServeFile::new(
        s.settings.dashboard_dir.join("help/404.html"),
    ));
    Router::new()
        .route("/help", get(help_redirect))
        .route_service("/help/", help.clone())
        .route_service("/help/{*path}", help)
        .route("/api/v1/status", get(auth::status))
        .route("/api/v1/bootstrap", post(auth::bootstrap))
        .route("/api/v1/login", post(auth::login))
        .route("/api/v1/login/mfa", post(crate::login_challenges::complete))
        .route("/api/v1/logout", post(auth::logout))
        .route("/api/v1/session", get(auth::session))
        .route("/api/v1/users", get(auth::users).post(auth::create_user))
        .route(
            "/api/v1/users/requests/{id}",
            get(crate::user_requests::lookup),
        )
        .route(
            "/api/v1/users/requests/{id}/cancel",
            post(crate::user_requests::cancel),
        )
        .route("/api/v1/users/{id}", put(crate::accounts::edit))
        .route(
            "/api/v1/users/{id}/access-requests/{request_id}",
            get(crate::access_requests::lookup),
        )
        .route(
            "/api/v1/users/{id}/access-requests/{request_id}/cancel",
            post(crate::access_requests::cancel),
        )
        .route(
            "/api/v1/users/{id}/password-reset",
            post(crate::accounts::issue_reset),
        )
        .route(
            "/api/v1/users/{id}/password-reset/requests/{request_id}",
            get(crate::reset_requests::lookup),
        )
        .route(
            "/api/v1/users/{id}/password-reset/requests/{request_id}/cancel",
            post(crate::reset_requests::cancel),
        )
        .route(
            "/api/v1/account/password",
            post(crate::accounts::change_password),
        )
        .route(
            "/api/v1/account/revoke-sessions",
            post(crate::accounts::revoke_sessions),
        )
        .route(
            "/api/v1/password-reset",
            post(crate::accounts::redeem_reset),
        )
        .route("/api/v1/account/sessions", get(auth::sessions))
        .route(
            "/api/v1/account/sessions/{id}/revoke",
            post(auth::revoke_session),
        )
        .route(
            "/api/v1/users/{id}/two-factor-reset",
            post(crate::mfa::admin_reset),
        )
        .route(
            "/api/v1/invite/preview",
            post(crate::accounts::preview_invite),
        )
        .route(
            "/api/v1/invite/accept",
            post(crate::accounts::accept_invite),
        )
        .route("/api/v1/openapi.json", get(openapi))
        .route("/api/v1/audit/history", get(crate::audit::history))
        .route(
            "/api/v1/audit/exports",
            get(crate::audit_exports::list).post(crate::audit_exports::prepare),
        )
        .route(
            "/api/v1/audit/exports/{id}",
            delete(crate::audit_exports::discard),
        )
        .route(
            "/api/v1/audit/exports/{id}/download",
            get(crate::audit_exports::download),
        )
        .route("/api/v1/audit/{id}", get(crate::audit::detail))
        .route("/api/v1/issues/history", get(crate::issues::history))
        .route("/api/v1/issues/groups", get(crate::issues::groups))
        .route("/api/v1/issues/{id}", get(crate::issues::detail))
        .route(
            "/api/v1/issues/{id}/acknowledge",
            post(crate::issues::acknowledge),
        )
        .route("/api/v1/issues/{id}/reopen", post(crate::issues::reopen))
        .route("/api/v1/mfa", get(crate::mfa::status))
        .route("/api/v1/mfa/{action}", post(crate::mfa::manage))
        .route("/api/v1/deployments/preview", post(deployment_preview))
        .route(
            "/api/v1/deployments/binding-suggestions",
            post(crate::deployment_history::binding_suggestions),
        )
        .route(
            "/api/v1/deployments/requests",
            get(crate::deployment_requests::history),
        )
        .route(
            "/api/v1/deployments/requests/{id}",
            get(crate::deployment_requests::lookup),
        )
        .route(
            "/api/v1/deployments/history",
            get(crate::deployment_history::history),
        )
        .route(
            "/api/v1/deployments/{id}/rollback-preview",
            get(crate::rollback_review::get),
        )
        .route(
            "/api/v1/deployments/{id}/unassign-preview",
            post(crate::assignment_removal::post_preview),
        )
        .route(
            "/api/v1/deployments/{id}/unassign",
            post(crate::assignment_removal::post_commit),
        )
        .route(
            "/api/v1/deployments/{id}/refresh-preview",
            post(crate::scheduled_refresh::post_preview),
        )
        .route(
            "/api/v1/deployments/{id}/refresh",
            post(crate::scheduled_refresh::post_commit),
        )
        .route(
            "/api/v1/deployments/{id}/summary",
            get(crate::deployment_history::summary),
        )
        .route(
            "/api/v1/deployments/{id}/targets",
            get(crate::deployment_history::targets),
        )
        .route(
            "/api/v1/deployments/{id}/rollout",
            get(crate::deployment_history::rollout),
        )
        .route("/api/v1/vrl/test", post(validation::synthetic_vrl))
        .route(
            "/api/v1/configurations/test",
            post(validation::pipeline_tests),
        )
        .route(
            "/api/v1/configurations/library",
            get(crate::pipeline_library::library),
        )
        .route(
            "/api/v1/configurations/{id}/history",
            get(crate::pipelines::history),
        )
        .route(
            "/api/v1/configurations/{id}/revisions/{revision_id}",
            get(crate::pipelines::revision_detail),
        )
        .route(
            "/api/v1/devices/{id}/telemetry",
            get(crate::telemetry::device_history),
        )
        .route(
            "/api/v1/telemetry/summary",
            get(crate::telemetry::fleet_summary),
        )
        .route(
            "/api/v1/versions/{id}/telemetry",
            get(crate::telemetry::version_telemetry),
        )
        .route(
            "/api/v1/configurations/{id}/telemetry",
            get(crate::telemetry::configuration_telemetry),
        )
        .route(
            "/api/v1/devices/{id}/revoke",
            post(crate::device_revocation::post),
        )
        .route(
            "/api/v1/devices/{id}/revocation",
            get(crate::device_revocation::status),
        )
        .route(
            "/api/v1/devices/{id}/recover",
            post(crate::device_recovery_requests::post),
        )
        .route(
            "/api/v1/devices/{id}/recovery-requests/{key}",
            get(crate::device_recovery_requests::lookup),
        )
        .route(
            "/api/v1/devices/{id}/recovery-requests/{key}/cancel",
            post(crate::device_recovery_requests::cancel),
        )
        .route(
            "/api/v1/groups/requests",
            get(crate::group_requests::history),
        )
        .route(
            "/api/v1/groups/membership-preview",
            post(crate::group_requests::membership_preview),
        )
        .route(
            "/api/v1/groups/requests/{id}",
            get(crate::group_requests::lookup),
        )
        .route(
            "/api/v1/configurations/publish-requests",
            get(crate::publication_requests::history),
        )
        .route(
            "/api/v1/configurations/publish-requests/{id}",
            get(crate::publication_requests::lookup),
        )
        .route(
            "/api/v1/configurations/requests",
            get(crate::pipeline_requests::history),
        )
        .route(
            "/api/v1/configurations/requests/{id}",
            get(crate::pipeline_requests::lookup),
        )
        .route(
            "/api/v1/policies",
            get(crate::policy_requests::list).post(crate::policy_requests::post),
        )
        .route(
            "/api/v1/policies/requests",
            get(crate::policy_requests::history),
        )
        .route(
            "/api/v1/policies/{id}",
            get(crate::policy_requests::detail).put(crate::policy_requests::edit),
        )
        .route(
            "/api/v1/policies/requests/{id}",
            get(crate::policy_requests::lookup),
        )
        .route(
            "/api/v1/tokens",
            get(crate::token_requests::list).post(crate::token_requests::post),
        )
        .route(
            "/api/v1/tokens/requests/{id}",
            get(crate::token_requests::lookup),
        )
        .route(
            "/api/v1/tokens/requests/{id}/cancel",
            post(crate::token_requests::cancel),
        )
        .route("/api/v1/releases", get(crate::install::list_releases))
        .route(
            "/api/v1/releases/{name}",
            get(crate::install::download_release),
        )
        .route("/api/v1/agent-install", get(crate::install::details))
        .route(
            "/api/v1/agent-install/activity",
            get(crate::install::activity),
        )
        .route("/api/v1/{collection}", get(list).post(create))
        .route("/api/v1/{collection}/{id}", get(detail).put(edit_group))
        .route(
            "/api/v1/{collection}/{id}/{action}",
            get(history).post(action).put(draft),
        )
        .route("/api/{*path}", any(|| async { ApiError::missing() }))
        .route("/agent/{*path}", any(|| async { ApiError::missing() }))
        .fallback_service(spa)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY))
        .layer(middleware::from_fn(reject_oversized))
        .layer(middleware::from_fn(security_headers))
        .with_state(s)
}
/// Largest accepted request body for the dashboard/API and agent listeners.
pub const MAX_REQUEST_BODY: usize = 1024 * 1024;
/// Refuse a declared oversized body before reading any of it. `DefaultBodyLimit`
/// still bounds chunked bodies, but only once a handler starts reading.
pub async fn reject_oversized(request: Request, next: Next) -> Response {
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if declared.is_some_and(|length| length > MAX_REQUEST_BODY as u64) {
        return ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PAYLOAD_TOO_LARGE",
            "Request body is larger than 1 MiB",
        )
        .into_response();
    }
    next.run(request).await
}
async fn help_redirect(uri: Uri) -> Redirect {
    let location = uri
        .query()
        .map_or_else(|| "/help/".to_string(), |query| format!("/help/?{query}"));
    Redirect::permanent(&location)
}
async fn openapi(AppState(s): AppState<State>, h: HeaderMap) -> Result<Response> {
    auth::authorize(&s, &h, &[], false).await?;
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        include_str!("../../contracts/openapi.json"),
    )
        .into_response())
}
pub async fn security_headers(request: Request, next: Next) -> Response {
    let embedded_reference = request.method() == axum::http::Method::GET
        && request.uri().path() == "/api-reference.html";
    let help = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    ) && request.uri().path().starts_with("/help/");
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
    headers.insert(
        "x-frame-options",
        HeaderValue::from_static(if embedded_reference {
            "SAMEORIGIN"
        } else {
            "DENY"
        }),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert("content-security-policy", HeaderValue::from_static(if embedded_reference {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; object-src 'none'"
    } else if help {
        // Pagefind compiles its bundled search WebAssembly. This does not
        // permit JavaScript eval or inline scripts, and is isolated to help.
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    }));
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}
pub(crate) fn text<'a>(v: &'a Value, key: &str) -> &'a str {
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
        "devices" => {
            let mut devices = rollout::devices(&mut conn).await?;
            crate::overview::annotate_versions(&mut conn, &mut devices).await?;
            json!(devices)
        }
        "deployments" => json!(rollout::deployments(&mut conn).await?),
        "configurations" => json!(db::records(&mut conn, "configuration").await?),
        "groups" => json!(crate::groups::list(&mut conn).await?),
        "policies" => json!(db::records(&mut conn, "policy").await?),
        "issues" => json!(crate::issues::legacy(&mut conn).await?),
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
        "settings" => {
            json!({"version":env!("CARGO_PKG_VERSION"),"vector_version":validation::VECTOR_VERSION,"heartbeat_seconds":60,"telemetry_retention_days":db::telemetry_retention_days(),"instance_name":s.settings.instance_name})
        }
        "overview" => {
            let devices = rollout::devices(&mut conn).await?;
            let configurations: i64 =
                sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='configuration'")
                    .fetch_one(&mut *conn)
                    .await?;
            let deployments = db::records(&mut conn, "deployment").await?;
            let issues_open = crate::issues::open_count(&mut conn).await?;
            let audit = recent_activity(&mut conn).await?;
            let mut overview = json!({"devices_total":devices.len(),"devices_online":devices.iter().filter(|d|!matches!(text(d,"status"),"offline"|"revoked"|"awaiting_first_check_in")).count(),"configurations_total":configurations,"deployments_active":deployments.iter().filter(|d|matches!(text(d,"status"),"active"|"paused")).count(),"issues_open":issues_open,"recent_activity":audit});
            crate::overview::extend(&mut conn, &devices, &mut overview).await?;
            overview["devices"] = json!(devices);
            overview
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
        "groups" => crate::groups::normalized(db::record(&mut conn, "group", &id).await?)?,
        "versions" => db::record(&mut conn, "version", &id).await?,
        "deployments" => rollout::deployment(&mut conn, &id).await?,
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
        crate::pipelines::full_history(&mut conn, &id, kind).await?
    )))
}
pub async fn create(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path(collection): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    auth::authorize(
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
    let actor = auth::authorize_in(
        &mut tx,
        &h,
        if collection == "configurations" {
            &["editor"]
        } else {
            &["operator"]
        },
        true,
    )
    .await?;
    let out = match collection.as_str() {
        "configurations" => crate::pipeline_requests::execute(&mut tx, None, &v, &actor).await?,
        "groups" => crate::group_requests::create(&mut tx, &v, text(&actor, "id")).await?,
        "deployments" => {
            crate::deployment_requests::create(&mut tx, &v, text(&actor, "id")).await?
        }
        "policies" => {
            return Err(ApiError::invalid(
                "Use the canonical saved-settings creation endpoint",
            ));
        }
        "tokens" => {
            return Err(ApiError::invalid(
                "Use the canonical token creation endpoint",
            ));
        }
        _ => return Err(ApiError::missing()),
    };
    tx.commit().await?;
    Ok(Json(out))
}
pub(crate) fn description(v: &Value) -> Result<String> {
    let d = v["description"].as_str().unwrap_or("");
    if d.len() > 2000 {
        return Err(ApiError::invalid("Description is too long"));
    }
    Ok(d.into())
}
pub(crate) fn validate_draft(v: &Value) -> Result<()> {
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
    crate::variables::declarations(&v["config"], v.get("variables").unwrap_or(&json!([])))?;
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
pub(crate) async fn revision(
    conn: &mut sqlx::SqliteConnection,
    c: &Value,
    actor: &Value,
    message: &str,
    source: Option<Value>,
) -> Result<()> {
    let mut entry = json!({"id":db::id(),"configuration_id":c["id"],"revision":c["revision"],"name":c["name"],"description":c["description"],"graph":c["graph"],"config":c["config"],"variables":c.get("variables").cloned().unwrap_or_else(||json!([])),"message":message,"created_at":db::now(),"author":text(actor,"name"),"author_id":text(actor,"id"),"archived":c["archived"]==true});
    if let Some(source) = source {
        entry["source"] = source;
    }
    db::insert(conn, "revision", &entry).await
}
pub async fn draft(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id, action)): Path<(String, String, String)>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["editor"], true).await?;
    if collection != "configurations" || action != "draft" {
        return Err(ApiError::missing());
    }
    validate_draft(&v)?;
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["editor"], true).await?;
    let mut c = db::record(&mut tx, "configuration", &id).await?;
    crate::pipelines::ensure_editable(&c)?;
    if v["revision"].as_u64() != c["revision"].as_u64() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "STALE_REVISION",
            "Draft changed; reload before saving",
        ));
    }
    if v.get("name").is_some() {
        c["name"] = json!(db::string(&v, "name", 120)?);
    }
    if v.get("description").is_some() {
        if !v["description"].is_string() {
            return Err(ApiError::invalid("Description must be text"));
        }
        c["description"] = json!(description(&v)?);
    }
    c["revision"] = json!(c["revision"].as_u64().unwrap_or(0) + 1);
    c["graph"] = v["graph"].clone();
    c["config"] = v["config"].clone();
    c["variables"] = crate::variables::declarations(
        &c["config"],
        v.get("variables")
            .or_else(|| c.get("variables"))
            .unwrap_or(&json!([])),
    )?;
    c["updated_at"] = json!(db::now());
    let message = v["message"].as_str().unwrap_or("");
    if message.len() > 2000 {
        return Err(ApiError::invalid("Message is too long"));
    }
    db::update(&mut tx, "configuration", &c).await?;
    revision(&mut tx, &c, &actor, message, None).await?;
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
pub(crate) async fn group(
    conn: &mut sqlx::SqliteConnection,
    v: &Value,
    id: Option<&str>,
) -> Result<Value> {
    let members = v["device_ids"]
        .as_array()
        .ok_or_else(|| ApiError::invalid("device_ids must be an array"))?;
    if members.len() > 10000 {
        return Err(ApiError::invalid("Too many group members"));
    }
    let selector = json!({"device_ids":members,"group_ids":[],"exclude_ids":[]});
    let members = rollout::select(conn, &selector).await?;
    Ok(
        json!({"id":id.map(str::to_owned).unwrap_or_else(db::id),"name":db::string(v,"name",120)?,"description":description(v)?,"device_ids":members,"created_at":db::now(),"revision":1}),
    )
}
pub async fn edit_group(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &h, &["operator"], true).await?;
    if collection != "groups" {
        return Err(ApiError::missing());
    }
    let _guard = s.writer.lock().await;
    let mut tx = s.pool.begin().await?;
    let actor = auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    let previous = db::record(&mut tx, "group", &id).await?;
    let next_revision = crate::groups::check_revision(&previous, &v)?;
    let mut g = group(&mut tx, &v, Some(&id)).await?;
    g["created_at"] = previous["created_at"].clone();
    g["revision"] = json!(next_revision);
    let memberships = rollout::persistent_memberships(&mut tx).await?;
    db::update(&mut tx, "group", &g).await?;
    rollout::guard_membership_additions(&mut tx, &memberships).await?;
    rollout::reconcile_membership(&mut tx).await?;
    db::insert(
        &mut tx,
        "audit",
        &json!({
            "id":db::id(),"actor":text(&actor,"id"),"action":"group.update",
            "target":id,"outcome":"success","created_at":db::now(),
            "previous_group_revision":crate::groups::revision(&previous)?,
            "group_revision":next_revision
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(g))
}
pub async fn action(
    AppState(s): AppState<State>,
    h: HeaderMap,
    Path((collection, id, action)): Path<(String, String, String)>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>> {
    let roles: &[&str] = if collection == "configurations" && action == "validate" {
        &["editor", "operator"]
    } else if collection == "configurations"
        && ["duplicate", "restore", "archive", "unarchive"].contains(&action.as_str())
    {
        &["editor"]
    } else if collection == "devices" && action == "recover" {
        &["admin"]
    } else {
        &["operator"]
    };
    auth::authorize(&s, &h, roles, true).await?;
    let v = body.map(|j| j.0).unwrap_or_else(|| json!({}));
    if collection == "configurations" && action == "publish" {
        if let Some(version) =
            crate::publication_requests::before_validation(&s, &h, &id, &v).await?
        {
            return Ok(Json(version));
        }
    }
    let mut checked = None;
    if collection == "configurations" && (action == "validate" || action == "publish") {
        let mut conn = s.pool.acquire().await?;
        let configuration = db::record(&mut conn, "configuration", &id).await?;
        drop(conn);
        if action == "validate" {
            return Ok(Json(validation::validate_isolated(&s, &v["config"]).await?));
        }
        crate::pipelines::ensure_editable(&configuration)?;
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
    let actor = auth::authorize_in(&mut tx, &h, roles, true).await?;
    let out = match (collection.as_str(), action.as_str()) {
        ("configurations", "duplicate") => {
            crate::pipeline_requests::execute(&mut tx, Some(&id), &v, &actor).await?
        }
        ("configurations", "restore" | "archive" | "unarchive") => {
            crate::pipelines::action(&mut tx, &id, &action, &v, &actor).await?
        }
        ("configurations", "validate") => {
            db::record(&mut tx, "configuration", &id).await?;
            validation::validate(&v["config"])
        }
        ("configurations", "publish") => {
            if let Some(version) =
                crate::publication_requests::replay(&mut tx, text(&actor, "id"), &id, &v).await?
            {
                version
            } else {
                let c = db::record(&mut tx, "configuration", &id).await?;
                crate::pipelines::ensure_editable(&c)?;
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
                let number:i64=sqlx::query_scalar("SELECT COALESCE(MAX(CAST(json_extract(data,'$.number') AS INTEGER)),0)+1 FROM records WHERE kind='version' AND json_extract(data,'$.configuration_id')=?")
                .bind(&id).fetch_one(&mut *tx).await?;
                let message = v["message"].as_str().unwrap_or("");
                if message.len() > 2000 {
                    return Err(ApiError::invalid("Message is too long"));
                }
                let variables = crate::variables::declarations(
                    &c["config"],
                    c.get("variables").unwrap_or(&json!([])),
                )?;
                let mut version = json!({"id":db::id(),"configuration_id":id,"number":number,"graph":c["graph"],"config":c["config"],"variables":variables,"artifact":artifact,"sha256":db::hash(&artifact),"size":artifact.len(),"created_at":db::now(),"message":message,"author":text(&actor,"name"),"author_id":text(&actor,"id"),"source_revision":c["revision"],"validation":validation,"uses_local_secrets":validation::local_secret_references(&c["config"]).0});
                db::insert(&mut tx, "version", &version).await?;
                db::audit(
                    &mut tx,
                    text(&actor, "id"),
                    "configuration.publish",
                    text(&version, "id"),
                    "success",
                )
                .await?;
                crate::publication_requests::remember(
                    &mut tx,
                    text(&actor, "id"),
                    &id,
                    &v,
                    &mut version,
                )
                .await?;
                version
            }
        }
        ("devices", "revoke") => {
            return Err(ApiError::invalid(
                "Use the canonical device revocation endpoint",
            ));
        }
        ("devices", "recover") => {
            return Err(ApiError::invalid(
                "Use the canonical device recovery authorization endpoint",
            ));
        }
        ("devices", "retry") => {
            let object = v
                .as_object()
                .ok_or_else(|| ApiError::invalid("Retry request must be an object"))?;
            if object
                .keys()
                .any(|k| k != "expected_version_id" && k != "expected_generation")
            {
                return Err(ApiError::invalid("Unknown retry request field"));
            }
            let expected_version = v["expected_version_id"]
                .as_str()
                .ok_or_else(|| ApiError::invalid("expected_version_id must be a UUID"))?;
            let parsed_version = uuid::Uuid::parse_str(expected_version)
                .map_err(|_| ApiError::invalid("expected_version_id must be a UUID"))?;
            if !parsed_version
                .hyphenated()
                .to_string()
                .eq_ignore_ascii_case(expected_version)
            {
                return Err(ApiError::invalid(
                    "expected_version_id must be a hyphenated UUID",
                ));
            }
            let expected_generation = v["expected_generation"]
                .as_i64()
                .filter(|n| (1..=9_007_199_254_740_991).contains(n))
                .ok_or_else(|| {
                    ApiError::invalid("expected_generation must be a positive safe integer")
                })?;
            let row=sqlx::query("SELECT assignment_id,desired_version_id,desired_generation,revoked,data,policy FROM devices WHERE id=?").bind(&id).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::missing)?;
            let desired_version: Option<String> = row.get("desired_version_id");
            let current_generation: i64 = row.get("desired_generation");
            let data = db::parse(row.get("data"))?;
            if row.get::<bool, _>("revoked") || desired_version.is_none() {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "DEVICE_NOT_RETRYABLE",
                    "Only a currently managed, nonrevoked device can retry",
                ));
            }
            if desired_version.as_deref() != Some(parsed_version.hyphenated().to_string().as_str())
                || current_generation != expected_generation
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "STALE_DEVICE_REVIEW",
                    "The desired version or generation changed. Review the latest device before retrying",
                ));
            }
            // reported_generation is the last verified generation, not the failed
            // attempt. A failed new version legitimately leaves it behind desired.
            if ![
                "failed",
                "rolled_back",
                "verification_unknown",
                "incompatible",
                "drift",
                "drift_detected",
            ]
            .contains(&text(&data, "apply_state"))
            {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "DEVICE_NOT_RETRYABLE",
                    "The device no longer reports a retryable failure. Review its latest state",
                ));
            }
            let policy = db::parse(row.get("policy"))?;
            if policy["sync_paused"] == true || data["local_paused"] == true {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "DEVICE_SYNC_PAUSED",
                    "Resume synchronization and review the device before retrying",
                ));
            }
            if current_generation >= 9_007_199_254_740_991 {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "DEVICE_NOT_RETRYABLE",
                    "The device generation limit has been reached",
                ));
            }
            s.limit(format!("retry:{id}"), 1, std::time::Duration::from_secs(60))?;
            sqlx::query("UPDATE devices SET desired_generation=desired_generation+1,data=json_set(data,'$.apply_state','desired') WHERE id=?")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            let generation: i64 =
                sqlx::query_scalar("SELECT desired_generation FROM devices WHERE id=?")
                    .bind(&id)
                    .fetch_one(&mut *tx)
                    .await?;
            // A device-specific artifact is stored per generation; the retry
            // resends the exact same one under the new generation.
            let version_id = parsed_version.hyphenated().to_string();
            if let Some(artifact) =
                crate::variables::current(&mut tx, &id, current_generation, &version_id).await?
            {
                crate::variables::snapshot(&mut tx, &id, generation, &version_id, &artifact)
                    .await?;
            }
            if let Some(assignment) = row.get::<Option<String>, _>("assignment_id") {
                let changed=sqlx::query("UPDATE deployment_targets SET state='desired',generation=?,verified_at=NULL,error=NULL WHERE deployment_id=? AND device_id=? AND state<>'removed'").bind(generation).bind(&assignment).bind(&id).execute(&mut *tx).await?.rows_affected()>0;
                let mut d = db::record(&mut tx, "deployment", &assignment).await?;
                if changed && d["status"] == "completed" {
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
        ("deployments", "unassign-preview" | "unassign" | "refresh-preview" | "refresh") => {
            return Err(ApiError::invalid(
                "Use the canonical reviewed deployment endpoint",
            ));
        }
        ("deployments", "rollback") => {
            crate::deployment_requests::rollback(&mut tx, &id, &v, text(&actor, "id")).await?
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
    auth::authorize_in(&mut tx, &h, &["operator"], true).await?;
    Ok(Json(rollout::preview(&mut tx, &v).await?))
}
async fn recent_activity(conn: &mut sqlx::SqliteConnection) -> Result<Vec<Value>> {
    Ok(crate::audit::rows(
        conn,
        &crate::audit::Filters::default(),
        20,
        0,
        None,
        None,
        false,
    )
    .await?
    .into_iter()
    .map(|(value, _)| value)
    .collect())
}
async fn audit_view(conn: &mut sqlx::SqliteConnection) -> Result<Vec<Value>> {
    crate::audit::legacy(conn, i64::MAX).await
}
