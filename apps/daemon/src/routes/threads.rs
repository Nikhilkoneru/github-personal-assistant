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

    // Try to load messages from ACP session
    let messages: Vec<serde_json::Value> = Vec::new();
    // TODO: hydrate from ACP session/load if copilot_session_id is present

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
            "messages": messages,
        }
    })))
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
