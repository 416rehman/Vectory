use std::{env, path::PathBuf};
use vectory_server::{Settings, api, device, initialize, rollout};

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_owned())
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
        validation_url: env::var("VECTORY_VALIDATION_URL").ok(),
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
    let web_addr = env_or("VECTORY_HTTP_ADDR", "127.0.0.1:8080");
    let listener = tokio::net::TcpListener::bind(&web_addr).await?;
    let app = api::router(state.clone());
    tracing::info!(%web_addr,"dashboard listener ready (use a TLS reverse proxy in production)");
    if let (Some(cert), Some(key)) = (cert, key) {
        let agent_addr = env_or("VECTORY_AGENT_ADDR", "0.0.0.0:8443");
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
