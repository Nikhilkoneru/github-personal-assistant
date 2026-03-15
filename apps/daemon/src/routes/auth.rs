use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::{check_service_access, extract_bearer_token, get_session, require_session};
use crate::error::AppError;
use crate::state::AppState;
use crate::store::auth_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/capabilities", get(capabilities))
        .route("/api/auth/session", get(get_current_session))
        .route("/api/auth/local/session", post(create_local_session))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/github/device/start", post(device_start))
        .route("/api/auth/github/device/{flow_id}", get(device_poll))
}

async fn capabilities(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    let config = &state.config;
    let (label, description, automatic, local_bootstrap, device_flow, redirect_flow) =
        match config.app_auth_mode.as_str() {
            "local" => (
                "Continue to chats",
                "This browser can reconnect directly to your daemon and reuse a local session on this device.",
                true, true, false, false,
            ),
            "github-device" => (
                "Sign in with GitHub",
                "Open GitHub device verification, confirm the code, and this client will finish sign-in automatically.",
                false, false, true, false,
            ),
            _ => (
                "Continue with GitHub",
                "Open the backend-managed GitHub OAuth flow and return here once the daemon has created your session.",
                false, false, false, true,
            ),
        };

    Ok(Json(json!({
        "mode": config.app_auth_mode,
        "supportedModes": [config.app_auth_mode],
        "backendHandled": true,
        "sessionRequired": true,
        "serviceTokenRequired": config.service_access_token.is_some(),
        "authConfigured": config.is_auth_configured(),
        "version": "rust-1",
        "copilotAuthMode": config.copilot_auth_mode(),
        "signIn": {
            "label": label,
            "description": description,
            "automatic": automatic,
            "localBootstrap": local_bootstrap,
            "deviceFlow": device_flow,
            "redirectFlow": redirect_flow,
        }
    })))
}

async fn get_current_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    let session = extract_bearer_token(&headers)
        .and_then(|t| get_session(&state.db, &state.config, &t));

    match session {
        Some(s) => Ok(Json(json!({
            "session": {
                "sessionToken": s.session_token,
                "user": {
                    "id": s.user_id,
                    "login": s.login,
                    "name": s.name,
                    "avatarUrl": s.avatar_url,
                }
            }
        }))),
        None => Ok(Json(json!({ "session": null }))),
    }
}

async fn create_local_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    if state.config.app_auth_mode != "local" {
        return Err(AppError::Conflict("Local auth is not active on this daemon right now.".into()));
    }

    // Return existing session if valid
    if let Some(token) = extract_bearer_token(&headers) {
        if let Some(s) = get_session(&state.db, &state.config, &token) {
            return Ok((
                axum::http::StatusCode::CREATED,
                Json(json!({
                    "session": {
                        "sessionToken": s.session_token,
                        "user": {
                            "id": s.user_id,
                            "login": s.login,
                            "name": s.name,
                            "avatarUrl": s.avatar_url,
                        }
                    }
                })),
            ));
        }
    }

    let session = auth_store::create_local_session(&state.db, &state.config);
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "session": session })),
    ))
}

async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::http::StatusCode, AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    if let Some(token) = extract_bearer_token(&headers) {
        auth_store::destroy_session(&state.db, &token);
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeviceCodeGitHubResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: i64,
    #[serde(default = "default_interval")]
    interval: i64,
}

fn default_interval() -> i64 {
    5
}

#[derive(Deserialize)]
struct DeviceTokenGitHubResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn device_start(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    if state.config.app_auth_mode != "github-device" {
        return Err(AppError::Conflict("GitHub sign-in is disabled.".into()));
    }

    let client_id = state.config.github_client_id.as_ref().ok_or_else(|| {
        AppError::BadGateway("GITHUB_CLIENT_ID not configured.".into())
    })?;

    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .json(&json!({
            "client_id": client_id,
            "scope": "read:user user:email"
        }))
        .send()
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(AppError::BadGateway("Failed to start GitHub device flow.".into()));
    }

    let body: DeviceCodeGitHubResponse = resp
        .json()
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    let device_auth = auth_store::create_device_auth(
        &state.db,
        &body.device_code,
        &body.user_code,
        &body.verification_uri,
        body.verification_uri_complete.as_deref(),
        body.expires_in,
        body.interval,
    );

    Ok((axum::http::StatusCode::CREATED, Json(serde_json::to_value(device_auth).unwrap())))
}

async fn device_poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(flow_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    if !check_service_access(&headers, &state.config) {
        return Err(AppError::Unauthorized("Missing or invalid service access token.".into()));
    }

    if state.config.app_auth_mode != "github-device" {
        return Err(AppError::Conflict("GitHub sign-in is disabled.".into()));
    }

    let client_id = state.config.github_client_id.as_ref().ok_or_else(|| {
        AppError::BadGateway("GITHUB_CLIENT_ID not configured.".into())
    })?;

    let record = auth_store::get_device_auth(&state.db, &flow_id);
    let record = match record {
        Some(r) => r,
        None => {
            return Ok(Json(json!({
                "status": "expired",
                "error": "GitHub device code expired. Start sign-in again."
            })));
        }
    };

    // Check if already complete
    if let Some(payload) = auth_store::get_device_auth_poll_payload(&state.db, &state.config, &flow_id) {
        if !matches!(&payload, auth_store::DeviceAuthPoll::Pending(_)) {
            return Ok(Json(serde_json::to_value(payload).unwrap()));
        }
    }

    // Check rate limit
    if chrono::Utc::now() < chrono::DateTime::parse_from_rfc3339(&record.next_poll_at).unwrap_or_default() {
        if let Some(payload) = auth_store::get_device_auth_poll_payload(&state.db, &state.config, &flow_id) {
            return Ok(Json(serde_json::to_value(payload).unwrap()));
        }
    }

    // Poll GitHub
    let client = reqwest::Client::new();
    let resp = client
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .json(&json!({
            "client_id": client_id,
            "device_code": record.device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }))
        .send()
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(AppError::BadGateway("Failed to poll GitHub device authorization.".into()));
    }

    let body: DeviceTokenGitHubResponse = resp
        .json()
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    if let Some(access_token) = body.access_token {
        // Exchange token for user profile
        let profile = fetch_github_profile(&access_token).await?;
        let session = auth_store::create_app_session(
            &state.db,
            &state.config,
            &access_token,
            Some((&profile.0, Some(&profile.1), profile.2.as_deref())),
        );
        auth_store::complete_device_auth(&state.db, &flow_id, &session.session_token);
        return Ok(Json(json!({
            "status": "complete",
            "session": session
        })));
    }

    match body.error.as_deref() {
        Some("authorization_pending") => {
            auth_store::schedule_device_poll(&state.db, &flow_id, None);
        }
        Some("slow_down") => {
            auth_store::schedule_device_poll(&state.db, &flow_id, Some(record.interval + 5));
        }
        Some("access_denied") => {
            auth_store::fail_device_auth(&state.db, &flow_id, "denied", "GitHub device authorization was denied.");
        }
        Some("expired_token") => {
            auth_store::fail_device_auth(&state.db, &flow_id, "expired", "GitHub device code expired. Start sign-in again.");
        }
        _ => {
            let desc = body.error_description.unwrap_or_else(|| "Unexpected device auth state.".into());
            return Err(AppError::BadGateway(desc));
        }
    }

    match auth_store::get_device_auth_poll_payload(&state.db, &state.config, &flow_id) {
        Some(payload) => Ok(Json(serde_json::to_value(payload).unwrap())),
        None => Ok(Json(json!({ "status": "expired", "error": "Flow not found." }))),
    }
}

async fn fetch_github_profile(access_token: &str) -> Result<(String, String, Option<String>), AppError> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/user")
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "gpa-daemon/1.0")
        .send()
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(AppError::BadGateway("Failed to load GitHub user.".into()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| AppError::BadGateway(e.to_string()))?;
    let login = body["login"].as_str().unwrap_or("unknown").to_string();
    let name = body["name"].as_str().unwrap_or(&login).to_string();
    let avatar_url = body["avatar_url"].as_str().map(|s| s.to_string());
    Ok((login, name, avatar_url))
}
