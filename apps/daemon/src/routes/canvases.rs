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

    let title = body.title.trim();
    if title.len() < 2 || title.len() > 120 {
        return Err(AppError::BadRequest(
            "Canvas title must be 2-120 characters.".into(),
        ));
    }

    let kind = body.kind.trim();
    if kind.is_empty() || kind.len() > 40 {
        return Err(AppError::BadRequest(
            "Canvas kind must be 1-40 characters.".into(),
        ));
    }

    let canvas = canvas_store::create_canvas(
        &state.db,
        &thread_id,
        title,
        kind,
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
        let trimmed = title.trim();
        if trimmed.len() < 2 || trimmed.len() > 120 {
            return Err(AppError::BadRequest(
                "Canvas title must be 2-120 characters.".into(),
            ));
        }
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
