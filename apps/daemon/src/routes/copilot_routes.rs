use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::preferences_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/copilot/preferences",
            get(get_preferences).put(set_preferences),
        )
        .route("/api/copilot/status", get(get_status))
        .route("/api/copilot/sessions/:session_id", delete(delete_session))
}

async fn get_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    let prefs = preferences_store::get_preferences(&state.db, &state.config).await?;
    Ok(Json(json!({ "preferences": prefs })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPreferences {
    #[serde(default)]
    approval_mode: Option<String>,
    #[serde(default)]
    general_chat_workspace_path: Option<Option<String>>,
}

async fn set_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetPreferences>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    let approval_mode = body.approval_mode.as_deref().map(|mode| match mode {
        "safer-defaults" => "safer-defaults",
        _ => "approve-all",
    });
    let prefs = preferences_store::set_preferences(
        &state.db,
        &state.config,
        approval_mode,
        body.general_chat_workspace_path.as_ref().map(|value| value.as_deref()),
    )
    .await?;
    Ok(Json(json!({ "preferences": prefs })))
}

async fn get_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;

    // Basic status response — ACP connection status
    let connected = match state.copilot.get_or_create_connection().await {
        Ok(conn) => conn.is_alive().await,
        Err(_) => false,
    };

    Ok(Json(json!({
        "status": {
            "version": crate::runtime::app_version(),
            "protocolVersion": 1,
            "connectionState": if connected { "connected" } else { "disconnected" },
        },
        "auth": {
            "isAuthenticated": state.config.is_copilot_configured(),
            "authType": if state.config.copilot_use_logged_in_user { "user" } else { "token" },
        },
        "sessions": [],
    })))
}

async fn delete_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(_session_id): axum::extract::Path<String>,
) -> Result<axum::http::StatusCode, AppError> {
    let _session = require_session(&headers, &state.db, &state.config).await?;
    // ACP doesn't have session deletion — sessions are managed by the agent
    Ok(axum::http::StatusCode::NO_CONTENT)
}
