use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::{canvas_store, thread_store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/threads/:thread_id/canvases", get(list).post(create))
        .route("/api/threads/:thread_id/canvases/:canvas_id", patch(update))
}

async fn ensure_thread_access(
    state: &AppState,
    headers: &HeaderMap,
    thread_id: &str,
) -> Result<(), AppError> {
    let session = require_session(headers, &state.db, &state.config).await?;
    thread_store::get_thread(&state.db, &state.config, &session.user_id, thread_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;
    Ok(())
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_thread_access(&state, &headers, &thread_id).await?;
    let canvases = canvas_store::list_canvases(&state.db, &thread_id)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    Ok(Json(json!({ "canvases": canvases })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCanvas {
    title: String,
    kind: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    source_user_message_index: Option<usize>,
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
    Json(body): Json<CreateCanvas>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    ensure_thread_access(&state, &headers, &thread_id).await?;

    let title = canvas_store::normalize_canvas_title(&body.title)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let kind = canvas_store::normalize_canvas_kind(&body.kind)
        .map_err(|error| AppError::BadRequest(error.to_string()))?;

    let canvas = canvas_store::create_canvas(
        &state.db,
        &thread_id,
        &title,
        &kind,
        body.content.as_deref().unwrap_or(""),
        body.source_user_message_index,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "canvas": canvas })),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCanvas {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    source_user_message_index: Option<usize>,
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path((thread_id, canvas_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<UpdateCanvas>,
) -> Result<Json<serde_json::Value>, AppError> {
    ensure_thread_access(&state, &headers, &thread_id).await?;

    if let Some(title) = body.title.as_deref() {
        canvas_store::normalize_canvas_title(title)
            .map_err(|error| AppError::BadRequest(error.to_string()))?;
    }

    let canvas = canvas_store::update_canvas(
        &state.db,
        &thread_id,
        &canvas_id,
        body.title.as_deref().map(str::trim),
        body.content.as_deref(),
        body.source_user_message_index,
    )
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
    .ok_or_else(|| AppError::NotFound("Canvas not found.".into()))?;

    Ok(Json(json!({ "canvas": canvas })))
}
