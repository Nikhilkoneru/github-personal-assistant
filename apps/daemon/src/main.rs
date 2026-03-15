mod auth_middleware;
mod config;
mod copilot;
mod db;
mod error;
mod routes;
mod state;
mod store;

use std::net::SocketAddr;

use axum::Router;
use clap::Parser;
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::EnvFilter;

use config::Config;
use db::Database;
use state::AppState;

#[derive(Parser)]
#[command(name = "gpa-daemon", about = "GitHub Personal Assistant daemon")]
struct Cli {
    #[arg(long, default_value = "serve")]
    mode: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let _cli = Cli::parse();
    let config = Config::from_env();
    let database = Database::open(&config)?;
    let state = AppState::new(config.clone(), database);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(routes::health::router())
        .merge(routes::auth::router())
        .merge(routes::projects::router())
        .merge(routes::threads::router())
        .merge(routes::models::router())
        .merge(routes::copilot_routes::router())
        .merge(routes::attachments::router())
        .merge(routes::chat::router())
        .layer(cors)
        .with_state(state.clone());

    let addr = SocketAddr::new(config.host.parse()?, config.port);
    tracing::info!("GPA daemon listening on http://{addr}");
    if let Some(ref url) = config.tailscale_api_url {
        tracing::info!("Tailscale API URL: {url}");
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
