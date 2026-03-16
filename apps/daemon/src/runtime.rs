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
    pub open_hint: String,
    pub ui_access_url: String,
    pub ui_access_hint: String,
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

pub fn build_target() -> &'static str {
    env!("GCPA_BUILD_TARGET")
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
    config
        .app_support_dir
        .join("scripts")
        .join("gcpa-daemon.cmd")
}

pub fn build_runtime_info(config: &Config, started_at: &str) -> DaemonRuntimeInfo {
    let executable_path = env::current_exe()
        .map(|path| path_to_string(&path))
        .unwrap_or_else(|_| cli_name().to_string());
    let copilot = resolve_copilot_tool(config, true);
    let service_definition_path = service_definition_path(config);
    let service_installed = service_definition_path.exists();
    let ui_access_url = config.preferred_ui_origin();
    let ui_access_hint = match config.remote_access_mode.as_str() {
        "tailscale" => format!(
            "Open {} in a browser on a device with Tailscale installed and signed into the same tailnet. The same origin serves both the UI and /api.",
            ui_access_url
        ),
        _ => format!(
            "Open {} in your browser. The same origin serves both the UI and /api.",
            ui_access_url
        ),
    };
    let logs_hint = if cfg!(target_os = "windows") {
        format!(
            "Get-Content -Path '{}' -Wait",
            path_to_string(&config.log_file_path)
        )
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
        service_installed,
        control_surface: "bundled web ui + gcpa cli".to_string(),
        install_hint: format!("{} daemon service install", cli_name()),
        restart_hint: format!("{} daemon service restart", cli_name()),
        status_hint: format!("{} daemon service status", cli_name()),
        logs_hint,
        update_hint: if service_installed {
            format!("{} update --restart-service", cli_name())
        } else {
            format!("{} update", cli_name())
        },
        open_hint: format!("{} open", cli_name()),
        ui_access_url: ui_access_url.clone(),
        ui_access_hint,
        copilot,
    }
}

pub fn build_doctor_report(config: &Config, started_at: &str) -> DoctorReport {
    let runtime = build_runtime_info(config, started_at);

    let checks = vec![
        DoctorCheck {
            name: "config-file".to_string(),
            ok: runtime.config_file_exists,
            detail: if runtime.config_file_exists {
                format!("Using {}", runtime.config_path)
            } else {
                format!(
                    "No config file at {}. Service install will create one from current settings.",
                    runtime.config_path
                )
            },
        },
        DoctorCheck {
            name: "copilot-cli".to_string(),
            ok: runtime.copilot.found,
            detail: runtime.copilot.path.clone().unwrap_or_else(|| {
                "GitHub Copilot CLI not found. Install it or set COPILOT_BIN.".to_string()
            }),
        },
        DoctorCheck {
            name: "bundled-web-ui".to_string(),
            ok: true,
            detail: runtime.ui_access_hint.clone(),
        },
        DoctorCheck {
            name: "remote-access".to_string(),
            ok: config.is_remote_access_configured() || config.remote_access_mode == "local",
            detail: match config.remote_access_mode.as_str() {
                "tailscale" => config
                    .tailscale_api_url
                    .clone()
                    .map(|url| {
                        format!(
                            "{url} (install Tailscale on this machine and the customer device, then open the same URL there)"
                        )
                    })
                    .unwrap_or_else(|| "Tailscale is not running or no Tailscale URL could be detected.".to_string()),
                "public" => config
                    .public_api_url
                    .clone()
                    .unwrap_or_else(|| "PUBLIC_API_URL is not configured.".to_string()),
                _ => format!("Local UI/API URL: {}", config.api_origin()),
            },
        },
    ];

    DoctorReport { runtime, checks }
}

pub fn open_browser(url: &str) -> anyhow::Result<()> {
    let status = if cfg!(target_os = "macos") {
        Command::new("open").arg(url).status()?
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).status()?
    } else {
        Command::new("xdg-open").arg(url).status()?
    };
    if !status.success() {
        anyhow::bail!("Browser open command failed for {url}");
    }
    Ok(())
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

fn resolve_copilot_tool(config: &Config, include_version: bool) -> ToolStatus {
    let mut extra_candidates = Vec::new();
    if cfg!(target_os = "macos") {
        extra_candidates.push(PathBuf::from("/opt/homebrew/bin/copilot"));
        extra_candidates.push(PathBuf::from("/usr/local/bin/copilot"));
    } else if cfg!(target_os = "linux") {
        extra_candidates.push(PathBuf::from("/usr/local/bin/copilot"));
        extra_candidates.push(PathBuf::from("/snap/bin/copilot"));
    }

    resolve_tool(
        config.copilot_bin.as_deref(),
        "copilot",
        &extra_candidates,
        include_version,
    )
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
                version: if include_version {
                    command_version(&candidate)
                } else {
                    None
                },
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
