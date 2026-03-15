use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::project_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list).post(create))
        .route("/api/projects/:project_id", get(get_one))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let projects = project_store::list_projects(&state.db, &session.user_id);
    Ok(Json(json!({ "projects": projects })))
}

#[derive(Deserialize)]
struct CreateProject {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateProject>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let name = body.name.trim();
    if name.len() < 2 || name.len() > 80 {
        return Err(AppError::BadRequest("Name must be 2-80 characters.".into()));
    }
    let desc = body.description.as_deref().unwrap_or("").trim();
    let project = project_store::create_project(&state.db, &session.user_id, name, desc);
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "project": project }))))
}

async fn get_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(project_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let project = project_store::get_project(&state.db, &session.user_id, &project_id)
        .ok_or_else(|| AppError::NotFound("Project not found.".into()))?;
    Ok(Json(json!({ "project": project })))
}
