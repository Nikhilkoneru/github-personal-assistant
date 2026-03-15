use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::thread_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/threads", get(list).post(create))
        .route("/api/threads/{thread_id}", get(get_detail).patch(update))
        .route("/api/threads/{thread_id}/messages", get(get_messages))
        .route("/api/sessions", get(list_acp_sessions))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    project_id: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let threads = thread_store::list_threads(&state.db, &session.user_id, query.project_id.as_deref());
    Ok(Json(json!({ "threads": threads })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThread {
    project_id: Option<String>,
    title: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Option<CreateThread>>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let body = body.unwrap_or(CreateThread {
        project_id: None,
        title: None,
        model: None,
        reasoning_effort: None,
    });
    let thread = thread_store::create_thread(
        &state.db,
        &session.user_id,
        &state.config.default_model,
        body.project_id.as_deref(),
        body.title.as_deref(),
        body.model.as_deref(),
        body.reasoning_effort.as_deref(),
    )
    .ok_or_else(|| AppError::NotFound("Project not found.".into()))?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "thread": thread }))))
}

async fn get_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    Ok(Json(json!({
        "thread": {
            "id": thread.id,
            "title": thread.title,
            "projectId": thread.project_id,
            "projectName": thread.project_name,
            "model": thread.model,
            "reasoningEffort": thread.reasoning_effort,
            "updatedAt": thread.updated_at,
            "createdAt": thread.created_at,
            "copilotSessionId": thread.copilot_session_id,
            "lastMessagePreview": thread.last_message_preview,
        }
    })))
}

/// Load messages for a thread via ACP session/load.
/// This uses the protocol's history replay — no internal file reading.
async fn get_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    let Some(ref copilot_session_id) = thread.copilot_session_id else {
        // No ACP session yet — return empty messages
        return Ok(Json(json!({ "messages": [] })));
    };

    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|e| AppError::Internal(format!("Copilot connection failed: {e}")))?;

    let caps = conn.get_capabilities().await;
    if !caps.load_session {
        return Ok(Json(json!({
            "messages": [],
            "error": "Agent does not support session/load"
        })));
    }

    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    match conn.load_session_messages(copilot_session_id, &cwd).await {
        Ok(messages) => Ok(Json(json!({ "messages": messages }))),
        Err(e) => {
            tracing::warn!("Failed to load session messages: {e}");
            Ok(Json(json!({
                "messages": [],
                "error": format!("Failed to load session: {e}")
            })))
        }
    }
}

/// List all ACP sessions via session/list protocol method.
/// This is the pure ACP view — not filtered by our local thread table.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsQuery {
    cwd: Option<String>,
    cursor: Option<String>,
}

async fn list_acp_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ListSessionsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config)?;

    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|e| AppError::Internal(format!("Copilot connection failed: {e}")))?;

    let caps = conn.get_capabilities().await;
    if !caps.list_sessions {
        return Ok(Json(json!({
            "sessions": [],
            "error": "Agent does not support session/list"
        })));
    }

    match conn
        .list_sessions(query.cwd.as_deref(), query.cursor.as_deref())
        .await
    {
        Ok(result) => Ok(Json(json!({
            "sessions": result.sessions,
            "nextCursor": result.next_cursor,
        }))),
        Err(e) => {
            tracing::warn!("Failed to list sessions: {e}");
            Ok(Json(json!({
                "sessions": [],
                "error": format!("Failed to list sessions: {e}")
            })))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateThread {
    project_id: Option<Option<String>>,
    model: Option<String>,
    reasoning_effort: Option<Option<String>>,
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
    Json(body): Json<UpdateThread>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::update_thread(
        &state.db,
        &session.user_id,
        &thread_id,
        body.project_id.as_ref().map(|o| o.as_deref()),
        body.model.as_deref(),
        body.reasoning_effort.as_ref().map(|o| o.as_deref()),
    )
    .ok_or_else(|| AppError::NotFound("Thread or project not found.".into()))?;
    Ok(Json(json!({ "thread": thread })))
}
