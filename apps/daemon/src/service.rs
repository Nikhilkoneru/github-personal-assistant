use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::Context;

use crate::config::Config;
use crate::runtime;

pub fn install(config: &Config, start_now: bool) -> anyhow::Result<()> {
    ensure_config_snapshot(config)?;
    let exe_path = std::env::current_exe().context("Could not determine the gcpa executable path")?;
    let definition_path = runtime::service_definition_path(config);

    if let Some(parent) = definition_path.parent() {
        fs::create_dir_all(parent)?;
    }

    if cfg!(target_os = "macos") {
        fs::write(&definition_path, render_launchd_plist(config, &exe_path))?;
        let domain = launchd_domain()?;
        let _ = run_command("launchctl", &["bootout", &domain, &runtime::path_to_string(&definition_path)]);
        run_command("launchctl", &["bootstrap", &domain, &runtime::path_to_string(&definition_path)])?;
        run_command("launchctl", &["enable", &format!("{domain}/{}", runtime::service_name())])?;
        if start_now {
            run_command("launchctl", &["kickstart", "-k", &format!("{domain}/{}", runtime::service_name())])?;
        }
    } else if cfg!(target_os = "windows") {
        let runner_path = runtime::windows_service_runner_path(config);
        if let Some(parent) = runner_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&runner_path, render_windows_runner(config, &exe_path))?;
        run_command(
            "schtasks",
            &[
                "/Create",
                "/TN",
                runtime::service_name(),
                "/SC",
                "ONLOGON",
                "/RL",
                "LIMITED",
                "/TR",
                &runtime::path_to_string(&runner_path),
                "/F",
            ],
        )?;
        if start_now {
            let _ = run_command("schtasks", &["/Run", "/TN", runtime::service_name()]);
        }
    } else {
        fs::write(&definition_path, render_systemd_unit(config, &exe_path))?;
        run_command("systemctl", &["--user", "daemon-reload"])?;
        if start_now {
            run_command("systemctl", &["--user", "enable", "--now", &format!("{}.service", runtime::service_name())])?;
        } else {
            run_command("systemctl", &["--user", "enable", &format!("{}.service", runtime::service_name())])?;
        }
    }

    println!("Installed {} auto-start service.", runtime::cli_name());
    println!("Status: {}", format!("{} daemon service status", runtime::cli_name()));
    Ok(())
}

pub fn uninstall(config: &Config) -> anyhow::Result<()> {
    let definition_path = runtime::service_definition_path(config);

    if cfg!(target_os = "macos") {
        let domain = launchd_domain()?;
        let _ = run_command("launchctl", &["bootout", &domain, &runtime::path_to_string(&definition_path)]);
        if definition_path.exists() {
            fs::remove_file(&definition_path)?;
        }
    } else if cfg!(target_os = "windows") {
        let _ = run_command("schtasks", &["/Delete", "/TN", runtime::service_name(), "/F"]);
        let runner_path = runtime::windows_service_runner_path(config);
        if runner_path.exists() {
            fs::remove_file(runner_path)?;
        }
    } else {
        let _ = run_command("systemctl", &["--user", "disable", "--now", &format!("{}.service", runtime::service_name())]);
        let _ = run_command("systemctl", &["--user", "daemon-reload"]);
        if definition_path.exists() {
            fs::remove_file(&definition_path)?;
        }
    }

    println!("Removed {} auto-start service.", runtime::cli_name());
    Ok(())
}

pub fn start(config: &Config) -> anyhow::Result<()> {
    ensure_installed(config)?;

    if cfg!(target_os = "macos") {
        let domain = launchd_domain()?;
        run_command("launchctl", &["kickstart", "-k", &format!("{domain}/{}", runtime::service_name())])?;
    } else if cfg!(target_os = "windows") {
        run_command("schtasks", &["/Run", "/TN", runtime::service_name()])?;
    } else {
        run_command("systemctl", &["--user", "start", &format!("{}.service", runtime::service_name())])?;
    }

    println!("Started {} service.", runtime::cli_name());
    Ok(())
}

pub fn stop(config: &Config) -> anyhow::Result<()> {
    ensure_installed(config)?;

    if cfg!(target_os = "macos") {
        let domain = launchd_domain()?;
        run_command("launchctl", &["bootout", &domain, &runtime::path_to_string(&runtime::service_definition_path(config))])?;
    } else if cfg!(target_os = "windows") {
        run_command("schtasks", &["/End", "/TN", runtime::service_name()])?;
    } else {
        run_command("systemctl", &["--user", "stop", &format!("{}.service", runtime::service_name())])?;
    }

    println!("Stopped {} service.", runtime::cli_name());
    Ok(())
}

pub fn restart(config: &Config) -> anyhow::Result<()> {
    ensure_installed(config)?;

    if cfg!(target_os = "macos") {
        let domain = launchd_domain()?;
        run_command("launchctl", &["kickstart", "-k", &format!("{domain}/{}", runtime::service_name())])?;
    } else if cfg!(target_os = "windows") {
        let _ = run_command("schtasks", &["/End", "/TN", runtime::service_name()]);
        run_command("schtasks", &["/Run", "/TN", runtime::service_name()])?;
    } else {
        run_command("systemctl", &["--user", "restart", &format!("{}.service", runtime::service_name())])?;
    }

    println!("Restarted {} service.", runtime::cli_name());
    Ok(())
}

pub fn status(config: &Config) -> anyhow::Result<()> {
    ensure_installed(config)?;

    if cfg!(target_os = "macos") {
        let domain = launchd_domain()?;
        let output = run_command("launchctl", &["print", &format!("{domain}/{}", runtime::service_name())])?;
        println!("{output}");
    } else if cfg!(target_os = "windows") {
        let output = run_command("schtasks", &["/Query", "/TN", runtime::service_name(), "/V", "/FO", "LIST"])?;
        println!("{output}");
    } else {
        let output = run_command("systemctl", &["--user", "status", &format!("{}.service", runtime::service_name())])?;
        println!("{output}");
    }

    Ok(())
}

pub fn print_definition(config: &Config) -> anyhow::Result<()> {
    let exe_path = std::env::current_exe().context("Could not determine the gcpa executable path")?;
    let definition = if cfg!(target_os = "macos") {
        render_launchd_plist(config, &exe_path)
    } else if cfg!(target_os = "windows") {
        render_windows_runner(config, &exe_path)
    } else {
        render_systemd_unit(config, &exe_path)
    };

    println!("# {} definition path: {}", runtime::service_manager_label(), runtime::service_definition_path(config).display());
    println!("{definition}");
    Ok(())
}

fn ensure_installed(config: &Config) -> anyhow::Result<()> {
    let path = runtime::service_definition_path(config);
    if path.exists() {
        return Ok(());
    }

    anyhow::bail!(
        "{} is not installed for auto-start yet. Run '{}' first.",
        runtime::cli_name(),
        format!("{} daemon service install", runtime::cli_name())
    )
}

fn ensure_config_snapshot(config: &Config) -> anyhow::Result<()> {
    if config.config_file_path.exists() {
        return Ok(());
    }

    if let Some(parent) = config.config_file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&config.config_file_path, config.to_env_file_contents())?;
    Ok(())
}

fn render_launchd_plist(config: &Config, exe_path: &Path) -> String {
    let service_path = runtime::path_to_string(exe_path);
    let config_path = xml_escape(&runtime::path_to_string(&config.config_file_path));
    let log_path = xml_escape(&runtime::path_to_string(&config.log_file_path));
    let app_support = xml_escape(&runtime::path_to_string(&config.app_support_dir));

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>{exe}</string>
      <string>daemon</string>
      <string>run</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>GCPA_CONFIG_FILE</key>
      <string>{config_path}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>{app_support}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
  </dict>
</plist>
"#,
        label = runtime::service_name(),
        exe = xml_escape(&service_path),
        config_path = config_path,
        log_path = log_path,
        app_support = app_support,
    )
}

fn render_systemd_unit(config: &Config, exe_path: &Path) -> String {
    format!(
        "[Unit]\nDescription=GitHub Personal Assistant daemon\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=GCPA_CONFIG_FILE={}\nExecStart={} daemon run\nWorkingDirectory={}\nRestart=always\nRestartSec=3\nStandardOutput=append:{}\nStandardError=append:{}\n\n[Install]\nWantedBy=default.target\n",
        shell_escape(&runtime::path_to_string(&config.config_file_path)),
        shell_escape(&runtime::path_to_string(exe_path)),
        shell_escape(&runtime::path_to_string(&config.app_support_dir)),
        shell_escape(&runtime::path_to_string(&config.log_file_path)),
        shell_escape(&runtime::path_to_string(&config.log_file_path)),
    )
}

fn render_windows_runner(config: &Config, exe_path: &Path) -> String {
    format!(
        "@echo off\r\nset GCPA_CONFIG_FILE={}\r\n\"{}\" daemon run\r\n",
        runtime::path_to_string(&config.config_file_path),
        runtime::path_to_string(exe_path),
    )
}

fn launchd_domain() -> anyhow::Result<String> {
    let uid = run_command("id", &["-u"])?;
    Ok(format!("gui/{}", uid.trim()))
}

fn run_command(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("Failed to execute {program}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        if stdout.is_empty() {
            Ok(stderr)
        } else if stderr.is_empty() {
            Ok(stdout)
        } else {
            Ok(format!("{stdout}\n{stderr}"))
        }
    } else {
        anyhow::bail!(
            "{} {} failed: {}",
            program,
            args.join(" "),
            if stderr.is_empty() { stdout } else { stderr }
        )
    }
}

fn shell_escape(value: &str) -> String {
    if value.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '-' | '_' | '.' | ':')) {
        value.to_string()
    } else {
        format!("\"{}\"", value.replace('"', "\\\""))
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
