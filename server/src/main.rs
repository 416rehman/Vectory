use std::{env, net::SocketAddr, path::PathBuf};
use vectory_server::{Settings, api, device, initialize, rollout};

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
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
    let secret = if let Ok(path) = env::var("VECTORY_BOOTSTRAP_SECRET_FILE") {
        std::fs::read_to_string(path)?.trim().to_owned()
    } else {
        env::var("VECTORY_BOOTSTRAP_SECRET").unwrap_or_default()
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
    };
    let state = initialize(settings).await?;
    let scheduler = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        loop {
            interval.tick().await;
            if let Err(e) = rollout::tick(&scheduler).await {
                tracing::error!(
                    code = e.code,
                    "scheduler transaction failed; last valid desired state retained"
                )
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(&web_addr).await?;
    let app = api::router(state.clone());
    tracing::info!(%web_addr,"dashboard listener ready (use a TLS reverse proxy in production)");
    if let (Some(cert), Some(key), Some(agent_addr)) = (cert, key, agent_addr) {
        tokio::select! {result=axum::serve(listener,app)=>{result?},result=device::serve_tls(state,&agent_addr,&cert,&key)=>{result?},_=tokio::signal::ctrl_c()=>{}}
    } else {
        tracing::warn!(
            "Explicit development mode: agent listener disabled without TLS certificate and key"
        );
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{check_agent_bind_address, check_http_bind_address, validation_url_for_mode};

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
