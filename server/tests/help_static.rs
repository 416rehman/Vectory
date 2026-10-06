use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use tower::ServiceExt;
use vectory_server::{Settings, api, initialize};

async fn fixture() -> (tempfile::TempDir, Router) {
    let temp = tempfile::tempdir().unwrap();
    let dist = temp.path().join("dist");
    for directory in [
        "help/topic",
        "help/assets",
        "help/pagefind",
        "help/_markdown",
    ] {
        std::fs::create_dir_all(dist.join(directory)).unwrap();
    }
    for (path, content) in [
        (
            "index.html",
            "<!doctype html><title>Dashboard sentinel</title>",
        ),
        ("help/index.html", "<!doctype html><title>Help home</title>"),
        (
            "help/topic/index.html",
            "<!doctype html><title>Help topic</title>",
        ),
        (
            "help/404.html",
            "<!doctype html><title>Help page not found</title>",
        ),
        (
            "help/assets/site.js",
            "document.documentElement.dataset.help='ready';",
        ),
        ("help/assets/site.css", "body{color:#123}"),
        (
            "help/_markdown/topic.md",
            "# Help topic\n\n| Field | Value |\n| --- | --- |\n| Name | Test |\n\n```json\n{\"example\":true}\n```\n\n[Open pipeline](/#/configurations?panel=settings&section=tests)\n",
        ),
    ] {
        std::fs::write(dist.join(path), content).unwrap();
    }
    std::fs::write(dist.join("help/pagefind/search.wasm"), b"\0asm\x01\0\0\0").unwrap();
    let state = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "isolated-help-test-bootstrap-secret-123456789".into(),
        cookie_secure: false,
        dashboard_dir: dist,
        releases_dir: temp.path().join("releases"),
        instance_name: "Help tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    (temp, api::router(state))
}

#[tokio::test]
async fn markdown_is_public_exact_text_with_existing_security_and_real_missing_paths() {
    let (_temp, app) = fixture().await;
    let response = request(&app, "GET", "/help/_markdown/topic.md").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/markdown");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    let csp = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(csp.contains("connect-src 'self'"));
    assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval'"));
    assert!(!csp.contains("script-src 'self' 'unsafe-inline'"));
    assert!(!response.headers().contains_key("set-cookie"));
    let text = String::from_utf8(body(response).await).unwrap();
    assert_eq!(
        text,
        "# Help topic\n\n| Field | Value |\n| --- | --- |\n| Name | Test |\n\n```json\n{\"example\":true}\n```\n\n[Open pipeline](/#/configurations?panel=settings&section=tests)\n"
    );
    let head = request(&app, "HEAD", "/help/_markdown/topic.md").await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers()["content-type"], "text/markdown");
    assert!(body(head).await.is_empty());
    for path in [
        "/help/_markdown/missing.md",
        "/help/_markdown/%2e%2e/%2e%2e/index.html",
        "/help/_markdown/../../index.html",
        "/help/_markdown/%2e%2e%2f%2e%2e%2findex.html",
    ] {
        let response = request(&app, "GET", path).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(
            !String::from_utf8(body(response).await)
                .unwrap()
                .contains("Dashboard sentinel")
        );
    }
}

async fn request(app: &Router, method: &str, path: &str) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn body(response: Response) -> Vec<u8> {
    response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

#[tokio::test]
async fn help_has_public_canonical_routes_and_preserves_queries() {
    let (_temp, app) = fixture().await;
    let redirect = request(&app, "GET", "/help?search=configuration").await;
    assert_eq!(redirect.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        redirect.headers()["location"],
        "/help/?search=configuration"
    );
    let directory = request(&app, "GET", "/help/topic?section=first").await;
    assert_eq!(directory.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(
        directory.headers()["location"],
        "/help/topic/?section=first"
    );
    for (path, text) in [("/help/", "Help home"), ("/help/topic/", "Help topic")] {
        let response = request(&app, "GET", path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        assert!(!response.headers().contains_key("set-cookie"));
        assert!(
            String::from_utf8(body(response).await)
                .unwrap()
                .contains(text)
        );
    }
}

#[tokio::test]
async fn help_serves_local_assets_with_correct_types_and_head_semantics() {
    let (_temp, app) = fixture().await;
    for (path, mime) in [
        ("/help/assets/site.js", "text/javascript"),
        ("/help/assets/site.css", "text/css"),
        ("/help/pagefind/search.wasm", "application/wasm"),
    ] {
        let response = request(&app, "GET", path).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            response.headers()["content-type"]
                .to_str()
                .unwrap()
                .starts_with(mime)
        );
        assert!(!body(response).await.is_empty());
        let head = request(&app, "HEAD", path).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert!(body(head).await.is_empty());
    }
    assert_eq!(
        request(&app, "POST", "/help/topic/").await.status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[tokio::test]
async fn help_missing_pages_assets_and_traversal_never_return_dashboard() {
    let (temp, app) = fixture().await;
    for path in [
        "/help/unknown/",
        "/help/assets/missing.js",
        "/help/%2e%2e/index.html",
        "/help/../index.html",
    ] {
        let response = request(&app, "GET", path).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        let text = String::from_utf8(body(response).await).unwrap();
        assert!(text.contains("Help page not found"), "{path}: {text}");
        assert!(!text.contains("Dashboard sentinel"));
    }
    // A packaging error must still fail closed, even if the custom 404 is absent.
    std::fs::remove_file(temp.path().join("dist/help/404.html")).unwrap();
    let response = request(&app, "GET", "/help/still-missing/").await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(
        !String::from_utf8(body(response).await)
            .unwrap()
            .contains("Dashboard sentinel")
    );
    let dashboard = request(&app, "GET", "/").await;
    assert_eq!(dashboard.status(), StatusCode::OK);
    assert!(
        String::from_utf8(body(dashboard).await)
            .unwrap()
            .contains("Dashboard sentinel")
    );
}

#[tokio::test]
async fn only_help_reads_allow_wasm_while_scripts_and_embedding_stay_restricted() {
    let (_temp, app) = fixture().await;
    for (method, path, wasm, embedded) in [
        ("GET", "/help/", true, false),
        ("HEAD", "/help/topic/", true, false),
        ("GET", "/help/missing/", true, false),
        ("POST", "/help/topic/", false, false),
        ("GET", "/help-other/", false, false),
        ("GET", "/", false, false),
        ("GET", "/api/v1/status", false, false),
        ("GET", "/api-reference.html", false, true),
    ] {
        let response = request(&app, method, path).await;
        let csp = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert_eq!(csp.contains("'wasm-unsafe-eval'"), wasm, "{method} {path}");
        let scripts = csp
            .split(';')
            .find(|part| part.trim().starts_with("script-src "))
            .unwrap();
        assert!(!scripts.contains("'unsafe-inline'"));
        assert!(!scripts.contains("'unsafe-eval'"));
        assert!(csp.contains("connect-src 'self'"));
        assert!(csp.contains("base-uri 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(
            response.headers()["x-frame-options"],
            if embedded { "SAMEORIGIN" } else { "DENY" }
        );
    }
}
