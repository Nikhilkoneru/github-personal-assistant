use std::fs;
use std::path::{Path, PathBuf};

use crate::remote_access;

const APP_SUPPORT_DIR_NAME: &str = "continuum-chat";
const LEGACY_APP_SUPPORT_DIR_NAME: &str = "github-personal-assistant";
const CONFIG_FILE_ENV: &str = "CONTINUUM_CONFIG_FILE";
const LEGACY_CONFIG_FILE_ENV: &str = "GCPA_CONFIG_FILE";

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub client_origin: String,
    pub public_api_url: Option<String>,
    pub tailscale_api_url: Option<String>,
    pub remote_access_mode: String,
    pub app_auth_mode: String,
    pub daemon_owner_id: String,
    pub daemon_owner_login: String,
    pub daemon_owner_name: String,
    pub copilot_use_logged_in_user: bool,
    pub copilot_github_token: Option<String>,
    pub default_model: String,
    pub github_client_id: Option<String>,
    pub github_client_secret: Option<String>,
    pub github_callback_url: Option<String>,
    pub app_support_dir: PathBuf,
    pub config_file_path: PathBuf,
    pub database_path: PathBuf,
    pub media_root: PathBuf,
    pub log_file_path: PathBuf,
    pub service_access_token: Option<String>,
    pub copilot_bin: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let explicit_app_support_dir = env_path("APP_SUPPORT_DIR");
        let explicit_config_path = env_path(CONFIG_FILE_ENV).or_else(|| env_path(LEGACY_CONFIG_FILE_ENV));
        if explicit_app_support_dir.is_none() && explicit_config_path.is_none() {
            if let Err(error) = migrate_legacy_app_support_dir() {
                eprintln!("Continuum warning: failed to migrate legacy app support directory: {error}");
            }
        }

        let initial_app_support_dir =
            explicit_app_support_dir.unwrap_or_else(default_app_support_dir);
        let initial_config_path = explicit_config_path
            .unwrap_or_else(|| default_config_path(&initial_app_support_dir));

        if initial_config_path.exists() {
            let _ = dotenvy::from_path(&initial_config_path);
        } else {
            load_workspace_env();
        }

        let app_support_dir = env_path("APP_SUPPORT_DIR").unwrap_or(initial_app_support_dir);
        let config_file_path = env_path(CONFIG_FILE_ENV)
            .or_else(|| env_path(LEGACY_CONFIG_FILE_ENV))
            .unwrap_or_else(|| default_config_path(&app_support_dir));

        let host = env_or("HOST", "0.0.0.0");
        let port = env_or("PORT", "4000").parse().unwrap_or(4000);
        let tailscale_api_url =
            env_opt("TAILSCALE_API_URL").or_else(|| detect_tailscale_api_url(port));
        let public_api_url = env_opt("PUBLIC_API_URL");
        let remote_access_mode = env_or(
            "REMOTE_ACCESS_MODE",
            if tailscale_api_url.is_some() {
                "tailscale"
            } else if public_api_url.is_some() {
                "public"
            } else {
                "local"
            },
        );
        let log_file_path = std::env::var("LOG_FILE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|_| app_support_dir.join("logs").join("daemon.log"));

        Config {
            host,
            port,
            client_origin: env_or("CLIENT_ORIGIN", "*"),
            public_api_url,
            tailscale_api_url,
            remote_access_mode,
            app_auth_mode: env_or("APP_AUTH_MODE", "local"),
            daemon_owner_id: env_or("DAEMON_OWNER_ID", "daemon-owner"),
            daemon_owner_login: env_or("DAEMON_OWNER_LOGIN", "daemon"),
            daemon_owner_name: env_or("DAEMON_OWNER_NAME", "Daemon owner"),
            copilot_use_logged_in_user: env_or("COPILOT_USE_LOGGED_IN_USER", "true")
                .parse()
                .unwrap_or(true),
            copilot_github_token: env_opt("COPILOT_GITHUB_TOKEN"),
            default_model: env_or("DEFAULT_MODEL", "gpt-5-mini"),
            github_client_id: env_opt("GITHUB_CLIENT_ID"),
            github_client_secret: env_opt("GITHUB_CLIENT_SECRET"),
            github_callback_url: env_opt("GITHUB_CALLBACK_URL"),
            database_path: std::env::var("DATABASE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| app_support_dir.join("data").join("assistant.sqlite")),
            media_root: std::env::var("MEDIA_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| app_support_dir.join("media")),
            app_support_dir,
            config_file_path,
            log_file_path,
            service_access_token: env_opt("SERVICE_ACCESS_TOKEN"),
            copilot_bin: env_opt("COPILOT_BIN"),
        }
    }

    pub fn apply_cli_overrides(&mut self, host: Option<String>, port: Option<u16>) {
        if let Some(host) = host.filter(|value| !value.trim().is_empty()) {
            self.host = host;
        }
        if let Some(port) = port {
            self.port = port;
        }
    }

    pub fn api_origin(&self) -> String {
        format!("http://{}:{}", self.browser_host(), self.port)
    }

    pub fn preferred_ui_origin(&self) -> String {
        self.tailscale_api_url
            .clone()
            .or_else(|| self.public_api_url.clone())
            .unwrap_or_else(|| self.api_origin())
    }

    pub fn is_copilot_configured(&self) -> bool {
        self.copilot_github_token.is_some() || self.copilot_use_logged_in_user
    }

    pub fn copilot_auth_mode(&self) -> &str {
        if self.copilot_github_token.is_some() {
            "github-token"
        } else if self.copilot_use_logged_in_user {
            "logged-in-user"
        } else {
            "unconfigured"
        }
    }

    pub fn is_auth_configured(&self) -> bool {
        match self.app_auth_mode.as_str() {
            "local" => true,
            "github-device" => self.github_client_id.is_some(),
            "github-oauth" => {
                self.github_client_id.is_some()
                    && self.github_client_secret.is_some()
                    && self.github_callback_url.is_some()
            }
            _ => true,
        }
    }

    pub fn is_remote_access_configured(&self) -> bool {
        match self.remote_access_mode.as_str() {
            "tailscale" => self.tailscale_api_url.is_some(),
            "public" => self
                .public_api_url
                .as_ref()
                .map(|u| !u.contains("localhost") && !u.contains("127.0.0.1"))
                .unwrap_or(false),
            _ => false,
        }
    }

    pub fn to_env_file_contents(&self) -> String {
        let mut lines = vec![
            "# continuum daemon configuration".to_string(),
            assignment("HOST", Some(&self.host)),
            assignment("PORT", Some(&self.port.to_string())),
            assignment("CLIENT_ORIGIN", Some(&self.client_origin)),
            assignment("DEFAULT_MODEL", Some(&self.default_model)),
            assignment("PUBLIC_API_URL", self.public_api_url.as_deref()),
            assignment("TAILSCALE_API_URL", self.tailscale_api_url.as_deref()),
            assignment("REMOTE_ACCESS_MODE", Some(&self.remote_access_mode)),
            assignment(
                "APP_SUPPORT_DIR",
                Some(&self.app_support_dir.to_string_lossy()),
            ),
            assignment("DATABASE_PATH", Some(&self.database_path.to_string_lossy())),
            assignment("MEDIA_ROOT", Some(&self.media_root.to_string_lossy())),
            assignment("LOG_FILE_PATH", Some(&self.log_file_path.to_string_lossy())),
            assignment("SERVICE_ACCESS_TOKEN", self.service_access_token.as_deref()),
            assignment("APP_AUTH_MODE", Some(&self.app_auth_mode)),
            assignment("DAEMON_OWNER_ID", Some(&self.daemon_owner_id)),
            assignment("DAEMON_OWNER_LOGIN", Some(&self.daemon_owner_login)),
            assignment("DAEMON_OWNER_NAME", Some(&self.daemon_owner_name)),
            assignment(
                "COPILOT_USE_LOGGED_IN_USER",
                Some(if self.copilot_use_logged_in_user {
                    "true"
                } else {
                    "false"
                }),
            ),
            assignment("COPILOT_GITHUB_TOKEN", self.copilot_github_token.as_deref()),
            assignment("COPILOT_BIN", self.copilot_bin.as_deref()),
            assignment("GITHUB_CLIENT_ID", self.github_client_id.as_deref()),
            assignment("GITHUB_CLIENT_SECRET", self.github_client_secret.as_deref()),
            assignment("GITHUB_CALLBACK_URL", self.github_callback_url.as_deref()),
        ];
        lines.push(String::new());
        lines.join("\n")
    }
}

fn detect_tailscale_api_url(port: u16) -> Option<String> {
    remote_access::detect_tailscale_url(port)
}

impl Config {
    fn browser_host(&self) -> String {
        match self.host.as_str() {
            "" | "0.0.0.0" => "127.0.0.1".to_string(),
            "::" => "[::1]".to_string(),
            other => other.to_string(),
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn env_path(key: &str) -> Option<PathBuf> {
    env_opt(key).map(PathBuf::from)
}

fn load_workspace_env() {
    let mut dir = std::env::current_dir().unwrap_or_default();
    loop {
        let env_path = dir.join(".env");
        if env_path.exists() {
            let _ = dotenvy::from_path(&env_path);
            break;
        }
        if !dir.pop() {
            break;
        }
    }
}

fn default_config_path(app_support_dir: &std::path::Path) -> PathBuf {
    app_support_dir.join("config").join("daemon.env")
}

fn default_app_support_dir() -> PathBuf {
    dirs_fallback().join(APP_SUPPORT_DIR_NAME)
}

fn migrate_legacy_app_support_dir() -> std::io::Result<()> {
    let legacy = dirs_fallback().join(LEGACY_APP_SUPPORT_DIR_NAME);
    let preferred = default_app_support_dir();
    if !legacy.exists() || preferred.exists() {
        return Ok(());
    }

    fs::rename(&legacy, &preferred)?;
    rewrite_path_references(&default_config_path(&preferred), &legacy, &preferred)?;

    for definition_path in known_service_definition_paths() {
        rewrite_path_references(&definition_path, &legacy, &preferred)?;
    }

    Ok(())
}

fn rewrite_path_references(path: &Path, from: &Path, to: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }

    let contents = fs::read_to_string(path)?;
    let from = from.to_string_lossy();
    let to = to.to_string_lossy();
    let updated = contents.replace(from.as_ref(), to.as_ref());
    if updated != contents {
        fs::write(path, updated)?;
    }

    Ok(())
}

fn known_service_definition_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    if cfg!(target_os = "macos") {
        paths.push(
            dirs_home()
                .join("Library")
                .join("LaunchAgents")
                .join("dev.continuum-chat.continuum.plist"),
        );
    } else if cfg!(target_os = "windows") {
        paths.push(
            default_app_support_dir()
                .join("scripts")
                .join("continuum-daemon.cmd"),
        );
    } else {
        paths.push(
            dirs_home()
                .join(".config")
                .join("systemd")
                .join("user")
                .join("dev.continuum-chat.continuum.service"),
        );
    }

    paths
}

fn assignment(key: &str, value: Option<&str>) -> String {
    match value.filter(|raw| !raw.trim().is_empty()) {
        Some(value) => format!(
            "{key}=\"{}\"",
            value.replace('\\', "\\\\").replace('"', "\\\"")
        ),
        None => format!("{key}="),
    }
}

fn dirs_fallback() -> PathBuf {
    if cfg!(target_os = "macos") {
        dirs_home().join("Library").join("Application Support")
    } else if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home())
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_home().join(".local").join("share"))
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_path_references_updates_matching_paths() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("daemon.env");
        let from = temp.path().join("github-personal-assistant");
        let to = temp.path().join("continuum-chat");
        fs::write(&file, format!("APP_SUPPORT_DIR=\"{}\"\n", from.display())).unwrap();

        rewrite_path_references(&file, &from, &to).unwrap();

        let contents = fs::read_to_string(&file).unwrap();
        assert!(contents.contains(&to.to_string_lossy().to_string()));
        assert!(!contents.contains(&from.to_string_lossy().to_string()));
    }

    #[test]
    fn default_app_support_dir_uses_continuum_name() {
        assert!(default_app_support_dir()
            .ends_with(Path::new(APP_SUPPORT_DIR_NAME)));
    }
}
