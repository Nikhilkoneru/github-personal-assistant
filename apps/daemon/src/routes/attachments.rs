use axum::extract::{Multipart, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::attachment_store;

const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/attachments", post(upload))
}

async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;

    let mut file_bytes: Option<Vec<u8>> = None;
    let mut file_name: Option<String> = None;
    let mut file_mime: Option<String> = None;
    let mut thread_id: Option<String> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                file_name = field.file_name().map(|s| s.to_string());
                file_mime = field.content_type().map(|s| s.to_string());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                if bytes.len() > MAX_ATTACHMENT_BYTES {
                    return Err(AppError::BadRequest("Attachment exceeds the 20 MB limit.".into()));
                }
                file_bytes = Some(bytes.to_vec());
            }
            "threadId" => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                if !text.trim().is_empty() {
                    thread_id = Some(text.trim().to_string());
                }
            }
            _ => {}
        }
    }

    let bytes = file_bytes.ok_or_else(|| AppError::BadRequest("No file was uploaded.".into()))?;
    let name = file_name.unwrap_or_else(|| "attachment".into());
    let mime = file_mime.unwrap_or_else(|| "application/octet-stream".into());

    let attachment = attachment_store::save_attachment(
        &state.db,
        &state.config.media_root,
        &session.user_id,
        thread_id.as_deref(),
        &name,
        &mime,
        &bytes,
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "attachment": attachment })),
    ))
}
