use std::{env, net::SocketAddr, path::PathBuf};
use vectory_server::{Settings, api, device, initialize, install, notifier, rollout, wake};

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
}

/// Agent wake-ups: `VECTORY_AGENT_WAKE_LIMIT` parked waits at once (default
/// 20,000; 0 turns them off and agents only poll).
fn wake_options(value: Option<String>) -> anyhow::Result<wake::Options> {
    let mut options = wake::Options::default();
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        options.limit = value
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|limit| *limit <= 100_000)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "VECTORY_AGENT_WAKE_LIMIT must be a whole number from 0 (off) to 100000"
                )
            })?;
    }
    Ok(options)
}

/// Ctrl-C, or SIGTERM from a service manager or `docker stop`.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

/// Answers every parked wait (`changed:false`) and gives the answers a moment
/// to leave, so agents fall back to their schedule instead of seeing a reset.
async fn release_waits(state: &vectory_server::State) {
    let answered = state.wake.close();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    while state.wake.parked() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    if answered > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        tracing::info!(answered, "answered parked agent waits before stopping");
    }
}

/// An optional public origin from the environment, normalized, or an error
/// that names the variable when it isn't a bare origin.
fn optional_origin(key: &str, schemes: &[&str]) -> anyhow::Result<Option<String>> {
    match env::var(key) {
        Ok(value) if !value.trim().is_empty() => install::origin(&value, schemes)
            .map(Some)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "{key} must be a bare {} origin such as {}://vectory.example.com:8443 (no path, query or user name)",
                    schemes.join(" or "),
                    schemes[0]
                )
            }),
        _ => Ok(None),
    }
}

fn validation_url_for_mode(
    development: bool,
    value: Option<String>,
) -> anyhow::Result<Option<String>> {
    let url = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if !development && url.is_none() {
        anyhow::bail!(
            "Production requires VECTORY_VALIDATION_URL for the isolated Vector 0.58 validator; use VECTORY_DEVELOPMENT=true only for an explicitly local structural-only preview"
        );
    }
    Ok(url)
}

fn check_http_bind_address(development: bool, address: &str) -> anyhow::Result<()> {
    if !development {
        return Ok(());
    }
    let socket: SocketAddr = address.parse().map_err(|_| {
        anyhow::anyhow!(
            "VECTORY_DEVELOPMENT=true requires VECTORY_HTTP_ADDR to use a literal loopback IP and port (for example 127.0.0.1:8080 or [::1]:8080)"
        )
    })?;
    if !socket.ip().is_loopback() {
        anyhow::bail!(
            "VECTORY_DEVELOPMENT=true requires a loopback-only VECTORY_HTTP_ADDR; public and wildcard HTTP bindings are not allowed"
        );
    }
    Ok(())
}

fn check_agent_bind_address(
    development: bool,
    validator_configured: bool,
    address: &str,
) -> anyhow::Result<()> {
    if !development || validator_configured {
        return Ok(());
    }
    let socket: SocketAddr = address.parse().map_err(|_| {
        anyhow::anyhow!(
            "Structural-only development requires VECTORY_AGENT_ADDR to use a literal loopback IP and port (for example 127.0.0.1:8443 or [::1]:8443)"
        )
    })?;
    if !socket.ip().is_loopback() {
        anyhow::bail!(
            "Structural-only development requires a loopback-only VECTORY_AGENT_ADDR; public and wildcard agent TLS bindings are not allowed"
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "vectory_server=info,tower_http=warn".into()),
        )
        .init();
    let _ = rustls::crypto::ring::default_provider().install_default();
    let data = PathBuf::from(env_or("VECTORY_DATA_DIR", "./data"));
    let development = env_or("VECTORY_DEVELOPMENT", "false") == "true";
    // Where the setup secret comes from, for the banner; never its value.
    let (secret, secret_source) = if let Ok(path) = env::var("VECTORY_BOOTSTRAP_SECRET_FILE") {
        (std::fs::read_to_string(&path)?.trim().to_owned(), path)
    } else {
        (
            env::var("VECTORY_BOOTSTRAP_SECRET").unwrap_or_default(),
            "the VECTORY_BOOTSTRAP_SECRET environment variable".to_owned(),
        )
    };
    if secret.len() < 24 && !data.join("vectory.db").exists() {
        anyhow::bail!(
            "Provision VECTORY_BOOTSTRAP_SECRET_FILE with at least 24 random characters for first initialization"
        )
    }
    let cert = env::var("VECTORY_TLS_CERT").ok().map(PathBuf::from);
    let key = env::var("VECTORY_TLS_KEY").ok().map(PathBuf::from);
    if !development && (cert.is_none() || key.is_none()) {
        anyhow::bail!(
            "Production requires VECTORY_TLS_CERT and VECTORY_TLS_KEY for the agent listener"
        )
    }
    let secure = env_or("VECTORY_COOKIE_SECURE", "true") != "false";
    if !secure && !development {
        anyhow::bail!("Insecure cookies require VECTORY_DEVELOPMENT=true")
    }
    let validation_url =
        validation_url_for_mode(development, env::var("VECTORY_VALIDATION_URL").ok())?;
    let web_addr = env_or("VECTORY_HTTP_ADDR", "127.0.0.1:8080");
    check_http_bind_address(development, &web_addr)?;
    let agent_addr = if cert.is_some() && key.is_some() {
        let address = env_or("VECTORY_AGENT_ADDR", "0.0.0.0:8443");
        check_agent_bind_address(development, validation_url.is_some(), &address)?;
        Some(address)
    } else {
        None
    };
    if validation_url.is_none() {
        tracing::warn!(
            "Development preview has no isolated Vector validator; checks and publication are structural-only until each device validates the configuration"
        );
    }
    let public_agent_url = optional_origin("VECTORY_PUBLIC_AGENT_URL", &["https"])?;
    let public_url = optional_origin("VECTORY_PUBLIC_URL", &["https", "http"])?;
    let public_downloads = env_or("VECTORY_PUBLIC_AGENT_DOWNLOADS", "true");
    if public_downloads != "true" && public_downloads != "false" {
        anyhow::bail!("VECTORY_PUBLIC_AGENT_DOWNLOADS must be true or false")
    }
    let agent_port = agent_addr
        .as_deref()
        .and_then(|address| address.rsplit(':').next()?.parse::<u16>().ok());
    let agent_certificate_pem = match (&agent_addr, &cert) {
        (Some(_), Some(path)) => std::fs::read_to_string(path).ok(),
        _ => None,
    };
    let settings = Settings {
        data_dir: data.clone(),
        bootstrap_secret: secret,
        cookie_secure: secure,
        dashboard_dir: PathBuf::from(env_or("VECTORY_DASHBOARD_DIR", "../dashboard/dist")),
        releases_dir: PathBuf::from(
            env::var("VECTORY_RELEASES_DIR")
                .unwrap_or_else(|_| data.join("releases").to_string_lossy().into()),
        ),
        instance_name: env_or("VECTORY_INSTANCE_NAME", "Vectory"),
        validation_url,
        trust_proxy_headers: env_or("VECTORY_TRUST_PROXY_HEADERS", "false") == "true",
        bundled_releases_dir: env::var("VECTORY_BUNDLED_RELEASES_DIR")
            .ok()
            .filter(|path| !path.trim().is_empty())
            .map(PathBuf::from),
        public_agent_url,
        public_url,
        disable_public_agent_downloads: public_downloads == "false",
        agent_port,
        agent_certificate_pem,
        outbound: Default::default(),
        wake: wake_options(env::var("VECTORY_AGENT_WAKE_LIMIT").ok())?,
    };
    let state = initialize(settings).await?;
    tracing::info!(
        "{}",
        install::startup_banner(&state, &web_addr, &secret_source).await
    );
    let scheduler = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        for tick in 0u64.. {
            interval.tick().await;
            // A released wave wakes its agents once the tick has committed.
            if let Err(e) = wake::changes(&scheduler, rollout::tick(&scheduler)).await {
                tracing::error!(
                    code = e.code,
                    "scheduler transaction failed; last valid desired state retained"
                )
            }
            if tick % 30 == 0 {
                if let Err(e) = rollout::prune(&scheduler).await {
                    tracing::error!(
                        code = e.code,
                        "retention pruning failed; retrying next minute"
                    )
                }
            }
        }
    });
    // Notifications send from their own task: a slow receiver never holds
    // the writer lock, a heartbeat, the scheduler or a request.
    tokio::spawn(notifier::run(state.clone()));
    let listener = tokio::net::TcpListener::bind(&web_addr).await?;
    let app =
        api::router(state.clone()).into_make_service_with_connect_info::<std::net::SocketAddr>();
    tracing::info!(%web_addr,"dashboard listener ready (use a TLS reverse proxy in production)");
    if let (Some(cert), Some(key), Some(agent_addr)) = (cert, key, agent_addr) {
        tokio::select! {result=axum::serve(listener,app)=>{result?},result=device::serve_tls(state.clone(),&agent_addr,&cert,&key)=>{result?},_=shutdown_signal()=>{release_waits(&state).await}}
    } else {
        tracing::warn!(
            "Explicit development mode: agent listener disabled without TLS certificate and key"
        );
        axum::serve(listener, app)
            .with_graceful_shutdown(shutdown_signal())
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        check_agent_bind_address, check_http_bind_address, validation_url_for_mode, wake_options,
    };

    #[test]
    fn wake_limit_defaults_and_bounds() {
        let default = wake_options(None).unwrap();
        assert_eq!(
            (default.limit, default.hold),
            (20_000, std::time::Duration::from_secs(25))
        );
        assert_eq!(wake_options(Some(" ".into())).unwrap().limit, 20_000);
        assert_eq!(wake_options(Some("0".into())).unwrap().limit, 0);
        assert_eq!(wake_options(Some(" 5000 ".into())).unwrap().limit, 5000);
        for value in ["-1", "100001", "many", "1e4"] {
            let error = wake_options(Some(value.into())).unwrap_err();
            assert!(error.to_string().contains("VECTORY_AGENT_WAKE_LIMIT"));
        }
    }

    #[test]
    fn production_requires_configured_isolated_validator() {
        for value in [None, Some(String::new()), Some("  \t  ".into())] {
            let error = validation_url_for_mode(false, value).unwrap_err();
            assert!(error.to_string().contains("VECTORY_VALIDATION_URL"));
        }
        assert_eq!(
            validation_url_for_mode(false, Some(" http://validator:8081/ ".into())).unwrap(),
            Some("http://validator:8081/".into())
        );
    }

    #[test]
    fn explicit_development_can_use_structural_only_preview() {
        assert_eq!(validation_url_for_mode(true, None).unwrap(), None);
        assert_eq!(
            validation_url_for_mode(true, Some("   ".into())).unwrap(),
            None
        );
    }

    #[test]
    fn development_http_listener_must_use_literal_loopback() {
        for address in ["127.0.0.1:8080", "127.8.2.1:8080", "[::1]:8080"] {
            check_http_bind_address(true, address).unwrap();
        }
        for address in [
            "0.0.0.0:8080",
            "[::]:8080",
            "192.0.2.1:8080",
            "localhost:8080",
            "http://127.0.0.1:8080",
        ] {
            let error = check_http_bind_address(true, address).unwrap_err();
            assert!(
                error.to_string().contains("VECTORY_HTTP_ADDR"),
                "{address}: {error}"
            );
        }
        check_http_bind_address(false, "0.0.0.0:8080").unwrap();
    }

    #[test]
    fn structural_only_development_agent_listener_must_use_literal_loopback() {
        for address in ["127.0.0.1:8443", "127.8.2.1:8443", "[::1]:8443"] {
            check_agent_bind_address(true, false, address).unwrap();
        }
        for address in [
            "0.0.0.0:8443",
            "[::]:8443",
            "192.0.2.1:8443",
            "localhost:8443",
            "https://127.0.0.1:8443",
        ] {
            let error = check_agent_bind_address(true, false, address).unwrap_err();
            assert!(
                error.to_string().contains("VECTORY_AGENT_ADDR"),
                "{address}: {error}"
            );
        }
        check_agent_bind_address(true, true, "0.0.0.0:8443").unwrap();
        check_agent_bind_address(false, true, "0.0.0.0:8443").unwrap();
    }
}
