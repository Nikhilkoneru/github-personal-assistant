use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::config::Config;

const CLI_NAME: &str = "gcpa";
const SERVICE_NAME_UNIX: &str = "dev.github-personal-assistant.gcpa";
const SERVICE_NAME_WINDOWS: &str = "GCPA-Daemon";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRuntimeInfo {
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub pid: u32,
    pub started_at: String,
    pub executable_path: String,
    pub config_path: String,
    pub config_file_exists: bool,
    pub log_path: String,
    pub data_path: String,
    pub media_path: String,
    pub service_manager: String,
    pub service_name: String,
    pub service_definition_path: String,
    pub service_installed: bool,
    pub control_surface: String,
    pub install_hint: String,
    pub restart_hint: String,
    pub status_hint: String,
    pub logs_hint: String,
    pub update_hint: String,
    pub ui_deploy_hint: String,
    pub copilot: ToolStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub runtime: DaemonRuntimeInfo,
    pub checks: Vec<DoctorCheck>,
}

pub fn cli_name() -> &'static str {
    CLI_NAME
}

pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn service_name() -> &'static str {
    if cfg!(target_os = "windows") {
        SERVICE_NAME_WINDOWS
    } else {
        SERVICE_NAME_UNIX
    }
}

pub fn service_manager_label() -> &'static str {
    if cfg!(target_os = "macos") {
        "launchd"
    } else if cfg!(target_os = "windows") {
        "task-scheduler"
    } else {
        "systemd"
    }
}

pub fn service_definition_path(config: &Config) -> PathBuf {
    if cfg!(target_os = "macos") {
        user_home()
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", service_name()))
    } else if cfg!(target_os = "windows") {
        windows_service_runner_path(config)
    } else {
        user_home()
            .join(".config")
            .join("systemd")
            .join("user")
            .join(format!("{}.service", service_name()))
    }
}

pub fn windows_service_runner_path(config: &Config) -> PathBuf {
    config.app_support_dir.join("scripts").join("gcpa-daemon.cmd")
}

pub fn detect_project_root(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };

    loop {
        if current.join("apps/client/scripts/build.mjs").exists() && current.join("apps/daemon/Cargo.toml").exists() {
            return Some(current);
        }

        if !current.pop() {
            return None;
        }
    }
}

pub fn build_runtime_info(config: &Config, started_at: &str) -> DaemonRuntimeInfo {
    let executable_path = env::current_exe()
        .map(|path| path_to_string(&path))
        .unwrap_or_else(|_| cli_name().to_string());
    let copilot = resolve_copilot_tool(config, true);
    let service_definition_path = service_definition_path(config);
    let logs_hint = if cfg!(target_os = "windows") {
        format!("Get-Content -Path '{}' -Wait", path_to_string(&config.log_file_path))
    } else {
        format!("tail -f '{}'", path_to_string(&config.log_file_path))
    };

    DaemonRuntimeInfo {
        version: app_version().to_string(),
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        pid: std::process::id(),
        started_at: started_at.to_string(),
        executable_path,
        config_path: path_to_string(&config.config_file_path),
        config_file_exists: config.config_file_path.exists(),
        log_path: path_to_string(&config.log_file_path),
        data_path: path_to_string(&config.database_path),
        media_path: path_to_string(&config.media_root),
        service_manager: service_manager_label().to_string(),
        service_name: service_name().to_string(),
        service_definition_path: path_to_string(&service_definition_path),
        service_installed: service_definition_path.exists(),
        control_surface: "web-settings + gcpa cli".to_string(),
        install_hint: format!("{} daemon service install", cli_name()),
        restart_hint: format!("{} daemon service restart", cli_name()),
        status_hint: format!("{} daemon service status", cli_name()),
        logs_hint,
        update_hint: format!(
            "Replace the {} binary with a newer release, then run '{} daemon service restart'.",
            cli_name(),
            cli_name()
        ),
        ui_deploy_hint: format!(
            "{} ui deploy --repo OWNER/REPO --client-default-api-url https://your-daemon-url",
            cli_name()
        ),
        copilot,
    }
}

pub fn build_doctor_report(config: &Config, started_at: &str) -> DoctorReport {
    let runtime = build_runtime_info(config, started_at);
    let project_root = detect_project_root(&env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let git = resolve_named_tool("git", true);
    let gh = resolve_named_tool("gh", true);
    let node = resolve_named_tool("node", true);

    let checks = vec![
        DoctorCheck {
            name: "config-file".to_string(),
            ok: runtime.config_file_exists,
            detail: if runtime.config_file_exists {
                format!("Using {}", runtime.config_path)
            } else {
                format!("No config file at {}. Service install will create one from current settings.", runtime.config_path)
            },
        },
        DoctorCheck {
            name: "copilot-cli".to_string(),
            ok: runtime.copilot.found,
            detail: runtime
                .copilot
                .path
                .clone()
                .unwrap_or_else(|| "GitHub Copilot CLI not found. Install it or set COPILOT_BIN.".to_string()),
        },
        DoctorCheck {
            name: "git".to_string(),
            ok: git.found,
            detail: git.path.unwrap_or_else(|| "git not found in PATH".to_string()),
        },
        DoctorCheck {
            name: "gh".to_string(),
            ok: gh.found,
            detail: gh.path.unwrap_or_else(|| "gh not found in PATH".to_string()),
        },
        DoctorCheck {
            name: "node".to_string(),
            ok: node.found,
            detail: node.path.unwrap_or_else(|| "node not found in PATH".to_string()),
        },
        DoctorCheck {
            name: "frontend-source".to_string(),
            ok: project_root.is_some(),
            detail: project_root
                .map(|root| format!("Found UI source at {}", root.display()))
                .unwrap_or_else(|| "Run `gcpa ui deploy` from the repo or a child directory of it.".to_string()),
        },
    ];

    DoctorReport { runtime, checks }
}

pub fn resolve_copilot_command(config: &Config) -> anyhow::Result<PathBuf> {
    let tool = resolve_copilot_tool(config, false);
    match tool.path {
        Some(path) => Ok(PathBuf::from(path)),
        None => anyhow::bail!(
            "Could not find the GitHub Copilot CLI. Install it or set COPILOT_BIN in {}.",
            config.config_file_path.display()
        ),
    }
}

pub fn resolve_named_tool(binary_name: &str, include_version: bool) -> ToolStatus {
    resolve_tool(None, binary_name, &[], include_version)
}

fn resolve_copilot_tool(config: &Config, include_version: bool) -> ToolStatus {
    let mut extra_candidates = Vec::new();
    if cfg!(target_os = "macos") {
        extra_candidates.push(PathBuf::from("/opt/homebrew/bin/copilot"));
        extra_candidates.push(PathBuf::from("/usr/local/bin/copilot"));
    } else if cfg!(target_os = "linux") {
        extra_candidates.push(PathBuf::from("/usr/local/bin/copilot"));
        extra_candidates.push(PathBuf::from("/snap/bin/copilot"));
    }

    resolve_tool(config.copilot_bin.as_deref(), "copilot", &extra_candidates, include_version)
}

fn resolve_tool(
    override_path: Option<&str>,
    binary_name: &str,
    extra_candidates: &[PathBuf],
    include_version: bool,
) -> ToolStatus {
    let mut candidates = Vec::new();
    if let Some(path) = override_path.filter(|value| !value.trim().is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    candidates.extend(search_path(binary_name));
    candidates.extend(extra_candidates.iter().cloned());

    for candidate in candidates {
        if candidate.exists() {
            return ToolStatus {
                found: true,
                path: Some(path_to_string(&candidate)),
                version: if include_version { command_version(&candidate) } else { None },
            };
        }
    }

    ToolStatus {
        found: false,
        path: None,
        version: None,
    }
}

fn search_path(binary_name: &str) -> Vec<PathBuf> {
    let mut names = vec![binary_name.to_string()];
    if cfg!(target_os = "windows") && !binary_name.ends_with(".exe") {
        names.push(format!("{binary_name}.exe"));
        names.push(format!("{binary_name}.cmd"));
        names.push(format!("{binary_name}.bat"));
    }

    env::var_os("PATH")
        .map(|raw| {
            env::split_paths(&raw)
                .flat_map(|entry| names.iter().map(move |name| entry.join(name)))
                .collect()
        })
        .unwrap_or_default()
}

fn command_version(path: &Path) -> Option<String> {
    for args in [["--version"], ["version"]] {
        if let Ok(output) = Command::new(path).args(args).output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !stdout.is_empty() {
                    return Some(stdout.lines().next().unwrap_or(&stdout).to_string());
                }
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if !stderr.is_empty() {
                    return Some(stderr.lines().next().unwrap_or(&stderr).to_string());
                }
            }
        }
    }
    None
}

fn user_home() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
