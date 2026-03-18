use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set};
use serde::Serialize;
use uuid::Uuid;

use crate::db::entities::projects;
use crate::db::{now_iso, Database};
use crate::store::workspace_store;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub updated_at: String,
}

pub async fn create_project(
    db: &Database,
    owner_id: &str,
    name: &str,
    description: &str,
    workspace_path: Option<&str>,
) -> anyhow::Result<ProjectSummary> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let workspace_path = workspace_store::normalize_optional_workspace_path(workspace_path)?;

    projects::ActiveModel {
        id: Set(id.clone()),
        github_user_id: Set(owner_id.to_string()),
        name: Set(name.to_string()),
        description: Set(description.to_string()),
        workspace_path: Set(workspace_path.clone()),
        created_at: Set(now.clone()),
        updated_at: Set(now.clone()),
    }
    .insert(db.connection())
    .await?;

    Ok(ProjectSummary {
        id,
        name: name.to_string(),
        description: description.to_string(),
        workspace_path,
        updated_at: now,
    })
}

pub async fn list_projects(db: &Database, owner_id: &str) -> anyhow::Result<Vec<ProjectSummary>> {
    let projects = projects::Entity::find()
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .order_by_desc(projects::Column::UpdatedAt)
        .all(db.connection())
        .await?;

    Ok(projects
        .into_iter()
        .map(|project| ProjectSummary {
            id: project.id,
            name: project.name,
            description: project.description,
            workspace_path: project.workspace_path,
            updated_at: project.updated_at,
        })
        .collect())
}

pub async fn get_project(
    db: &Database,
    owner_id: &str,
    project_id: &str,
) -> anyhow::Result<Option<ProjectSummary>> {
    let project = projects::Entity::find_by_id(project_id.to_string())
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?;

    Ok(project.map(|project| ProjectSummary {
        id: project.id,
        name: project.name,
        description: project.description,
        workspace_path: project.workspace_path,
        updated_at: project.updated_at,
    }))
}

pub async fn update_project(
    db: &Database,
    owner_id: &str,
    project_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    workspace_path: Option<Option<&str>>,
) -> anyhow::Result<Option<ProjectSummary>> {
    let Some(project) = projects::Entity::find_by_id(project_id.to_string())
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    let mut active = project.into_active_model();
    if let Some(name) = name {
        active.name = Set(name.to_string());
    }
    if let Some(description) = description {
        active.description = Set(description.to_string());
    }
    if let Some(workspace_path) = workspace_path {
        active.workspace_path = Set(workspace_store::normalize_optional_workspace_path(workspace_path)?);
    }
    active.updated_at = Set(now_iso());
    let project = active.update(db.connection()).await?;

    Ok(Some(ProjectSummary {
        id: project.id,
        name: project.name,
        description: project.description,
        workspace_path: project.workspace_path,
        updated_at: project.updated_at,
    }))
}
