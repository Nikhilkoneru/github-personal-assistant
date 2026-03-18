use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::{project_store, workspace_store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list).post(create))
        .route("/api/projects/:project_id", get(get_one).patch(update))
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let projects = project_store::list_projects(&state.db, &session.user_id).await?;
    Ok(Json(json!({ "projects": projects })))
}

#[derive(Deserialize)]
struct CreateProject {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    workspace_path: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateProject>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let name = body.name.trim();
    if name.len() < 2 || name.len() > 80 {
        return Err(AppError::BadRequest("Name must be 2-80 characters.".into()));
    }
    let desc = body.description.as_deref().unwrap_or("").trim();
    let workspace_path = body
        .workspace_path
        .as_deref()
        .map(workspace_store::ensure_existing_workspace_directory)
        .transpose()?;
    let project = project_store::create_project(
        &state.db,
        &session.user_id,
        name,
        desc,
        workspace_path.as_deref(),
    )
    .await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "project": project })),
    ))
}

async fn get_one(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(project_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let project = project_store::get_project(&state.db, &session.user_id, &project_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project not found.".into()))?;
    Ok(Json(json!({ "project": project })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProject {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    workspace_path: Option<Option<String>>,
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(project_id): axum::extract::Path<String>,
    Json(body): Json<UpdateProject>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let name = body.name.as_deref().map(str::trim);
    if let Some(name) = name {
        if name.len() < 2 || name.len() > 80 {
            return Err(AppError::BadRequest("Name must be 2-80 characters.".into()));
        }
    }

    let description = body.description.as_deref().map(str::trim);
    let workspace_path = match body.workspace_path.as_ref() {
        Some(Some(path)) => Some(Some(
            workspace_store::ensure_existing_workspace_directory(path)?,
        )),
        Some(None) => Some(None),
        None => None,
    };

    let project = project_store::update_project(
        &state.db,
        &session.user_id,
        &project_id,
        name,
        description,
        workspace_path.as_ref().map(|value| value.as_deref()),
    )
    .await?
    .ok_or_else(|| AppError::NotFound("Project not found.".into()))?;
    Ok(Json(json!({ "project": project })))
}
