use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use serde::Serialize;

use crate::config::Config;
use crate::db::entities::app_preferences;
use crate::db::{now_iso, Database};
use crate::store::workspace_store;

const APPROVAL_MODE_KEY: &str = "copilot_approval_mode";
const GENERAL_CHAT_WORKSPACE_PATH_KEY: &str = "general_chat_workspace_path";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CopilotPreferences {
    pub approval_mode: String,
    pub general_chat_workspace_path: String,
}

pub async fn get_preferences(db: &Database, config: &Config) -> anyhow::Result<CopilotPreferences> {
    let mode = app_preferences::Entity::find_by_id(APPROVAL_MODE_KEY.to_string())
        .one(db.connection())
        .await?
        .map(|model| model.value)
        .unwrap_or_else(|| "approve-all".to_string());
    let general_chat_workspace_path = get_general_chat_workspace_path(db, config).await?;

    Ok(CopilotPreferences {
        approval_mode: mode,
        general_chat_workspace_path,
    })
}

pub async fn get_general_chat_workspace_path(
    db: &Database,
    config: &Config,
) -> anyhow::Result<String> {
    let stored = app_preferences::Entity::find_by_id(GENERAL_CHAT_WORKSPACE_PATH_KEY.to_string())
        .one(db.connection())
        .await?
        .map(|model| model.value);

    match stored {
        Some(path) => workspace_store::ensure_runtime_workspace_directory(config, &path),
        None => {
            let default_path = config.default_general_chat_workspace_path();
            std::fs::create_dir_all(&default_path)?;
            Ok(default_path.to_string_lossy().to_string())
        }
    }
}

pub async fn set_preferences(
    db: &Database,
    config: &Config,
    approval_mode: Option<&str>,
    general_chat_workspace_path: Option<Option<&str>>,
) -> anyhow::Result<CopilotPreferences> {
    let current = get_preferences(db, config).await?;
    let next_mode = approval_mode.unwrap_or(&current.approval_mode);
    let next_general_path = match general_chat_workspace_path {
        Some(Some(path)) => workspace_store::ensure_runtime_workspace_directory(config, path)?,
        Some(None) => {
            let default_path = config.default_general_chat_workspace_path();
            std::fs::create_dir_all(&default_path)?;
            default_path.to_string_lossy().to_string()
        }
        None => current.general_chat_workspace_path,
    };

    upsert_preference(db, APPROVAL_MODE_KEY, next_mode).await?;
    upsert_preference(
        db,
        GENERAL_CHAT_WORKSPACE_PATH_KEY,
        &next_general_path,
    )
    .await?;

    Ok(CopilotPreferences {
        approval_mode: next_mode.to_string(),
        general_chat_workspace_path: next_general_path,
    })
}

async fn upsert_preference(db: &Database, key: &str, value: &str) -> anyhow::Result<()> {
    if let Some(existing) = app_preferences::Entity::find_by_id(key.to_string())
        .one(db.connection())
        .await?
    {
        let mut active = existing.into_active_model();
        active.value = Set(value.to_string());
        active.updated_at = Set(now_iso());
        active.update(db.connection()).await?;
    } else {
        app_preferences::ActiveModel {
            key: Set(key.to_string()),
            value: Set(value.to_string()),
            updated_at: Set(now_iso()),
        }
        .insert(db.connection())
        .await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn defaults_and_updates_preferences() {
        let temp = tempfile::tempdir().unwrap();
        let config = crate::config::test_config(temp.path());
        let db = crate::db::Database::open(&config).await.unwrap();

        let initial = get_preferences(&db, &config).await.unwrap();
        assert_eq!(initial.approval_mode, "approve-all");
        assert!(initial.general_chat_workspace_path.ends_with("general-chat"));

        let custom_workspace = temp.path().join("workspace").join("general");
        std::fs::create_dir_all(&custom_workspace).unwrap();
        set_preferences(
            &db,
            &config,
            Some("safer-defaults"),
            Some(Some(custom_workspace.to_string_lossy().as_ref())),
        )
        .await
        .unwrap();
        let updated = get_preferences(&db, &config).await.unwrap();
        assert_eq!(updated.approval_mode, "safer-defaults");
        assert_eq!(
            updated.general_chat_workspace_path,
            custom_workspace.to_string_lossy()
        );
    }
}
