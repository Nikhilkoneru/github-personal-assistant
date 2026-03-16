use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::runtime;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/health", get(health))
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let config = &state.config;
    let runtime = runtime::build_runtime_info(config, &state.started_at);
    let status = if runtime.copilot.found { "ok" } else { "degraded" };
    Json(json!({
        "status": status,
        "copilotConfigured": config.is_copilot_configured(),
        "authConfigured": config.is_auth_configured(),
        "authMode": config.app_auth_mode,
        "copilotAuthMode": config.copilot_auth_mode(),
        "apiOrigin": config.api_origin(),
        "publicApiUrl": config.public_api_url,
        "tailscaleApiUrl": config.tailscale_api_url,
        "remoteAccessMode": config.remote_access_mode,
        "remoteAccessConfigured": config.is_remote_access_configured(),
        "runtime": runtime,
    }))
}
