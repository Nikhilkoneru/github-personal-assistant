use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail};

use crate::config::Config;

pub fn normalize_optional_workspace_path(path: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(normalize_workspace_path(path)?))
}

pub fn normalize_workspace_path(path: &str) -> anyhow::Result<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        bail!("Workspace path cannot be empty.");
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        bail!("Workspace path must be absolute.");
    }

    Ok(path.to_string_lossy().to_string())
}

pub fn ensure_existing_workspace_directory(path: &str) -> anyhow::Result<String> {
    let normalized = normalize_workspace_path(path)?;
    let directory = Path::new(&normalized);
    if !directory.exists() {
        bail!("Workspace path does not exist: {normalized}");
    }
    if !directory.is_dir() {
        bail!("Workspace path is not a directory: {normalized}");
    }
    Ok(normalized)
}

pub fn ensure_runtime_workspace_directory(config: &Config, path: &str) -> anyhow::Result<String> {
    let normalized = normalize_workspace_path(path)?;
    let directory = PathBuf::from(&normalized);
    let default_general_path = config.default_general_chat_workspace_path();
    if directory == default_general_path {
        fs::create_dir_all(&directory).map_err(|error| {
            anyhow!(
                "Unable to create the general chat workspace directory '{}': {error}",
                directory.display()
            )
        })?;
        return Ok(normalized);
    }

    if !directory.exists() {
        bail!("Workspace path does not exist: {normalized}");
    }
    if !directory.is_dir() {
        bail!("Workspace path is not a directory: {normalized}");
    }

    Ok(normalized)
}
