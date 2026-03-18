use std::collections::HashMap;

use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder, Set,
};
use serde::Serialize;
use uuid::Uuid;

use crate::config::Config;
use crate::db::entities::{projects, threads};
use crate::db::{now_iso, Database};
use crate::store::preferences_store;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    pub workspace_path: String,
    pub updated_at: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copilot_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
}

#[derive(Clone)]
struct ProjectContext {
    name: String,
    workspace_path: Option<String>,
}

async fn load_project_contexts(
    db: &Database,
    owner_id: &str,
    project_ids: impl IntoIterator<Item = String>,
) -> anyhow::Result<HashMap<String, ProjectContext>> {
    let project_ids = project_ids.into_iter().collect::<Vec<_>>();
    if project_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let projects = projects::Entity::find()
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .filter(projects::Column::Id.is_in(project_ids))
        .all(db.connection())
        .await?;

    Ok(projects
        .into_iter()
        .map(|project| {
            (
                project.id,
                ProjectContext {
                    name: project.name,
                    workspace_path: project.workspace_path,
                },
            )
        })
        .collect())
}

async fn load_project_context(
    db: &Database,
    owner_id: &str,
    project_id: Option<&str>,
) -> anyhow::Result<Option<ProjectContext>> {
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    Ok(projects::Entity::find_by_id(project_id.to_string())
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?
        .map(|project| ProjectContext {
            name: project.name,
            workspace_path: project.workspace_path,
        }))
}

fn into_summary(
    thread: threads::Model,
    project_contexts: &HashMap<String, ProjectContext>,
    general_workspace_path: &str,
) -> ThreadSummary {
    let project_workspace_path = thread
        .project_id
        .as_ref()
        .and_then(|project_id| project_contexts.get(project_id))
        .and_then(|context| context.workspace_path.clone());
    ThreadSummary {
        project_name: thread
            .project_id
            .as_ref()
            .and_then(|project_id| project_contexts.get(project_id))
            .map(|context| context.name.clone()),
        id: thread.id,
        title: thread.title,
        project_id: thread.project_id,
        model: thread.model,
        reasoning_effort: thread.reasoning_effort,
        workspace_path: thread
            .workspace_path
            .filter(|path| !path.trim().is_empty())
            .or(project_workspace_path)
            .unwrap_or_else(|| general_workspace_path.to_string()),
        updated_at: thread.updated_at,
        created_at: thread.created_at,
        copilot_session_id: thread.copilot_session_id,
        last_message_preview: thread.last_message_preview,
    }
}

async fn project_exists(db: &Database, owner_id: &str, project_id: &str) -> anyhow::Result<bool> {
    Ok(projects::Entity::find_by_id(project_id.to_string())
        .filter(projects::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?
        .is_some())
}

pub async fn create_thread(
    db: &Database,
    config: &Config,
    owner_id: &str,
    default_model: &str,
    project_id: Option<&str>,
    title: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> anyhow::Result<Option<ThreadSummary>> {
    if let Some(project_id) = project_id {
        if !project_exists(db, owner_id, project_id).await? {
            return Ok(None);
        }
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    let actual_model = model.filter(|m| !m.is_empty()).unwrap_or(default_model);
    let actual_title = title.filter(|t| !t.is_empty()).unwrap_or("New chat");
    let general_workspace_path = preferences_store::get_general_chat_workspace_path(db, config).await?;
    let project_context = load_project_context(db, owner_id, project_id).await?;
    let resolved_workspace_path = project_context
        .as_ref()
        .and_then(|context| context.workspace_path.clone())
        .unwrap_or_else(|| general_workspace_path.clone());

    let thread = threads::ActiveModel {
        id: Set(id.clone()),
        github_user_id: Set(owner_id.to_string()),
        project_id: Set(project_id.map(str::to_string)),
        workspace_path: Set(Some(resolved_workspace_path.clone())),
        title: Set(actual_title.to_string()),
        model: Set(actual_model.to_string()),
        reasoning_effort: Set(reasoning_effort.map(str::to_string)),
        last_message_preview: Set(None),
        copilot_session_id: Set(None),
        created_at: Set(now.clone()),
        updated_at: Set(now),
    }
    .insert(db.connection())
    .await?;

    let project_contexts = if let Some(project_id) = thread.project_id.clone() {
        load_project_contexts(db, owner_id, [project_id]).await?
    } else {
        HashMap::new()
    };
    Ok(Some(into_summary(
        thread,
        &project_contexts,
        &general_workspace_path,
    )))
}

pub async fn list_threads(
    db: &Database,
    config: &Config,
    owner_id: &str,
    project_id: Option<&str>,
) -> anyhow::Result<Vec<ThreadSummary>> {
    let mut query = threads::Entity::find()
        .filter(threads::Column::GithubUserId.eq(owner_id.to_string()))
        .order_by_desc(threads::Column::UpdatedAt);

    if let Some(project_id) = project_id {
        query = query.filter(threads::Column::ProjectId.eq(project_id.to_string()));
    }

    let threads = query.all(db.connection()).await?;
    let project_contexts = load_project_contexts(
        db,
        owner_id,
        threads
            .iter()
            .filter_map(|thread| thread.project_id.clone())
            .collect::<Vec<_>>(),
    )
    .await?;
    let general_workspace_path = preferences_store::get_general_chat_workspace_path(db, config).await?;

    Ok(threads
        .into_iter()
        .map(|thread| into_summary(thread, &project_contexts, &general_workspace_path))
        .collect())
}

pub async fn get_thread(
    db: &Database,
    config: &Config,
    owner_id: &str,
    thread_id: &str,
) -> anyhow::Result<Option<ThreadSummary>> {
    let thread = threads::Entity::find_by_id(thread_id.to_string())
        .filter(threads::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?;
    let Some(thread) = thread else {
        return Ok(None);
    };
    let project_context = load_project_context(db, owner_id, thread.project_id.as_deref()).await?;
    let mut project_contexts = HashMap::new();
    if let Some(project_id) = thread.project_id.clone() {
        if let Some(context) = project_context {
            project_contexts.insert(project_id, context);
        }
    }
    let general_workspace_path = preferences_store::get_general_chat_workspace_path(db, config).await?;
    Ok(Some(into_summary(
        thread,
        &project_contexts,
        &general_workspace_path,
    )))
}

pub async fn update_thread_session(
    db: &Database,
    thread_id: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    if let Some(thread) = threads::Entity::find_by_id(thread_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = thread.into_active_model();
        active.copilot_session_id = Set(Some(session_id.to_string()));
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    }
    Ok(())
}

pub async fn clear_thread_session(db: &Database, thread_id: &str) -> anyhow::Result<()> {
    if let Some(thread) = threads::Entity::find_by_id(thread_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = thread.into_active_model();
        active.copilot_session_id = Set(None);
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    }
    Ok(())
}

pub async fn update_thread_preview(
    db: &Database,
    thread_id: &str,
    preview: &str,
) -> anyhow::Result<()> {
    let single_line = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated = if single_line.len() > 160 {
        format!("{}...", &single_line[..160])
    } else {
        single_line
    };

    if let Some(thread) = threads::Entity::find_by_id(thread_id.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = thread.into_active_model();
        active.last_message_preview = Set(Some(truncated));
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    }
    Ok(())
}

pub async fn update_thread(
    db: &Database,
    config: &Config,
    owner_id: &str,
    thread_id: &str,
    project_id: Option<Option<&str>>,
    model: Option<&str>,
    reasoning_effort: Option<Option<&str>>,
) -> anyhow::Result<Option<ThreadSummary>> {
    let Some(thread) = threads::Entity::find_by_id(thread_id.to_string())
        .filter(threads::Column::GithubUserId.eq(owner_id.to_string()))
        .one(db.connection())
        .await?
    else {
        return Ok(None);
    };

    let actual_model = model
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| thread.model.clone());
    let actual_project_id = match project_id {
        Some(project_id) => project_id.map(str::to_string),
        None => thread.project_id.clone(),
    };
    let actual_reasoning = match reasoning_effort {
        Some(reasoning_effort) => reasoning_effort.map(str::to_string),
        None => thread.reasoning_effort.clone(),
    };
    let general_workspace_path = preferences_store::get_general_chat_workspace_path(db, config).await?;

    if let Some(project_id) = actual_project_id.as_deref() {
        if !project_exists(db, owner_id, project_id).await? {
            return Ok(None);
        }
    }

    let resolved_workspace_path = if thread.copilot_session_id.is_none() {
        load_project_context(db, owner_id, actual_project_id.as_deref())
            .await?
            .and_then(|context| context.workspace_path)
            .or(thread.workspace_path.clone())
            .unwrap_or_else(|| general_workspace_path.clone())
    } else {
        thread
            .workspace_path
            .clone()
            .unwrap_or_else(|| general_workspace_path.clone())
    };

    let mut active = thread.into_active_model();
    active.project_id = Set(actual_project_id.clone());
    active.workspace_path = Set(Some(resolved_workspace_path.clone()));
    active.model = Set(actual_model);
    active.reasoning_effort = Set(actual_reasoning.clone());
    active.updated_at = Set(now_iso());
    let thread = active.update(db.connection()).await?;

    let mut project_contexts = HashMap::new();
    if let Some(project_id) = actual_project_id {
        if let Some(project_context) = load_project_context(db, owner_id, Some(&project_id)).await? {
            project_contexts.insert(project_id, project_context);
        }
    }

    Ok(Some(into_summary(
        thread,
        &project_contexts,
        &general_workspace_path,
    )))
}

pub async fn rename_thread_if_placeholder(
    db: &Database,
    thread_id: &str,
    title: &str,
) -> anyhow::Result<()> {
    let Some(thread) = threads::Entity::find_by_id(thread_id.to_string())
        .one(db.connection())
        .await?
    else {
        return Ok(());
    };

    if thread.title.trim().is_empty() || thread.title == "New chat" {
        let mut active = thread.into_active_model();
        active.title = Set(title.to_string());
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn creates_thread_for_project_and_truncates_preview() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();
        crate::store::auth_store::create_local_session(&db, &config)
            .await
            .unwrap();

        let project = crate::store::project_store::create_project(
            &db,
            &config.daemon_owner_id,
            "Launch work",
            "Project for testing",
            None,
        )
        .await
        .unwrap();

        let thread = create_thread(
            &db,
            &config,
            &config.daemon_owner_id,
            &config.default_model,
            Some(project.id.as_str()),
            None,
            None,
            None,
        )
        .await
        .unwrap()
        .expect("thread should be created");

        assert_eq!(thread.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(thread.project_name.as_deref(), Some("Launch work"));
        assert_eq!(thread.title, "New chat");

        update_thread_preview(&db, &thread.id, &format!("{}\n{}", "hello", "word ".repeat(80)))
            .await
            .unwrap();
        let updated = get_thread(&db, &config, &config.daemon_owner_id, &thread.id)
            .await
            .unwrap()
            .expect("updated thread");
        let preview = updated.last_message_preview.expect("preview should exist");
        assert!(preview.len() <= 163);
        assert!(!preview.contains('\n'));
    }
}
