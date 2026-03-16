use std::io::Read;

use axum::extract::{Multipart, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use flate2::read::GzDecoder;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::attachment_store;

const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
struct UploadEnvelope {
    file_bytes: Option<Vec<u8>>,
    file_name: Option<String>,
    file_mime: Option<String>,
    original_name: Option<String>,
    original_mime: Option<String>,
    content_encoding: Option<String>,
    thread_id: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/attachments", post(upload))
}

async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let mut upload = UploadEnvelope::default();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                upload.file_name = field.file_name().map(|s| s.to_string());
                upload.file_mime = field.content_type().map(|s| s.to_string());
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                if bytes.len() > MAX_ATTACHMENT_BYTES {
                    return Err(AppError::BadRequest(
                        "Attachment exceeds the 20 MB limit.".into(),
                    ));
                }
                upload.file_bytes = Some(bytes.to_vec());
            }
            "originalName" => upload.original_name = Some(read_field_text(field).await?),
            "originalMimeType" => upload.original_mime = Some(read_field_text(field).await?),
            "contentEncoding" => upload.content_encoding = Some(read_field_text(field).await?),
            "threadId" => {
                let text = read_field_text(field).await?;
                if !text.trim().is_empty() {
                    upload.thread_id = Some(text.trim().to_string());
                }
            }
            _ => {}
        }
    }

    let bytes = restore_upload_bytes(&upload)?;
    let name = upload
        .original_name
        .or(upload.file_name)
        .unwrap_or_else(|| "attachment".into());
    let mime = upload
        .original_mime
        .or(upload.file_mime)
        .unwrap_or_else(|| "application/octet-stream".into());

    let attachment = attachment_store::save_attachment(
        &state.db,
        &state.config.media_root,
        &session.user_id,
        upload.thread_id.as_deref(),
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

async fn read_field_text(field: axum::extract::multipart::Field<'_>) -> Result<String, AppError> {
    field
        .text()
        .await
        .map(|value| value.trim().to_string())
        .map_err(|e| AppError::BadRequest(e.to_string()))
}

fn restore_upload_bytes(upload: &UploadEnvelope) -> Result<Vec<u8>, AppError> {
    let bytes = upload
        .file_bytes
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("No file was uploaded.".into()))?;

    match upload.content_encoding.as_deref() {
        Some("gzip") => {
            let mut decoder = GzDecoder::new(&bytes[..]);
            let mut decoded = Vec::new();
            decoder.read_to_end(&mut decoded).map_err(|error| {
                AppError::BadRequest(format!("Could not decompress attachment upload: {error}"))
            })?;
            if decoded.len() > MAX_ATTACHMENT_BYTES {
                return Err(AppError::BadRequest(
                    "Attachment exceeds the 20 MB limit after decompression.".into(),
                ));
            }
            Ok(decoded)
        }
        Some(other) => Err(AppError::BadRequest(format!(
            "Unsupported attachment content encoding: {other}"
        ))),
        None => Ok(bytes.clone()),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::{write::GzEncoder, Compression};

    use super::*;

    #[test]
    fn restores_gzip_uploads() {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(b"hello world").unwrap();
        let compressed = encoder.finish().unwrap();
        let upload = UploadEnvelope {
            file_bytes: Some(compressed),
            content_encoding: Some("gzip".to_string()),
            ..UploadEnvelope::default()
        };

        assert_eq!(restore_upload_bytes(&upload).unwrap(), b"hello world");
    }

    #[test]
    fn rejects_unknown_content_encoding() {
        let upload = UploadEnvelope {
            file_bytes: Some(vec![1, 2, 3]),
            content_encoding: Some("brotli".to_string()),
            ..UploadEnvelope::default()
        };

        assert!(restore_upload_bytes(&upload).is_err());
    }
}
