use std::fs;
use std::path::Path;
use std::process::Command;

use anyhow::Context;
use uuid::Uuid;

use crate::config::Config;
use crate::runtime;

#[derive(Debug, Clone)]
pub struct UiDeployOptions {
    pub repo: String,
    pub branch: String,
    pub target_dir: String,
    pub client_default_api_url: Option<String>,
    pub private_repo: bool,
    pub skip_pages_config: bool,
}

pub fn deploy_ui(config: &Config, options: &UiDeployOptions) -> anyhow::Result<()> {
    ensure_tool("gh")?;
    ensure_tool("git")?;
    ensure_tool("node")?;
    ensure_gh_auth()?;

    let cwd = std::env::current_dir()?;
    let project_root = runtime::detect_project_root(&cwd).ok_or_else(|| {
        anyhow::anyhow!(
            "Could not find the gcpa source tree from {}. Run this command from the repository or one of its child directories.",
            cwd.display()
        )
    })?;

    let deploy_api_url = options
        .client_default_api_url
        .clone()
        .or_else(|| config.tailscale_api_url.clone())
        .or_else(|| config.public_api_url.clone())
        .filter(|value| {
            let normalized = value.trim();
            !normalized.is_empty() && !normalized.contains("localhost") && !normalized.contains("127.0.0.1")
        });

    build_client(&project_root, deploy_api_url.as_deref())?;

    let dist_dir = project_root.join("apps/client/dist");
    if !dist_dir.exists() {
        anyhow::bail!("The client build did not produce {}", dist_dir.display());
    }

    let normalized_target_dir = normalize_target_dir(&options.target_dir)?;
    if !repo_exists(&options.repo)? {
        create_repo(&options.repo, options.private_repo)?;
    }

    let temp_root = std::env::temp_dir().join(format!("gcpa-ui-deploy-{}", Uuid::new_v4()));
    let repo_dir = temp_root.join("repo");
    fs::create_dir_all(&temp_root)?;

    let result = (|| -> anyhow::Result<()> {
        run_command(
            None,
            "gh",
            &["repo", "clone", &options.repo, repo_dir.to_str().unwrap_or("repo")],
        )?;
        ensure_branch(&repo_dir, &options.branch)?;

        let target_dir = repo_dir.join(&normalized_target_dir);
        sync_directory(&dist_dir, &target_dir)?;
        fs::write(target_dir.join(".nojekyll"), "")?;

        if has_repo_changes(&repo_dir)? {
            run_command(Some(&repo_dir), "git", &["add", normalized_target_dir.as_str()])?;
            run_command(Some(&repo_dir), "git", &["commit", "-m", "Deploy gcpa web UI"])?;
            run_command(Some(&repo_dir), "git", &["push", "-u", "origin", &options.branch])?;
        }

        if !options.skip_pages_config {
            configure_pages(&options.repo, &options.branch, &normalized_target_dir)?;
        }

        let pages_url = infer_pages_url(&options.repo);
        println!("Deployed web UI to {} ({})", options.repo, pages_url);
        if let Some(url) = deploy_api_url {
            println!("Default daemon URL: {url}");
        }
        Ok(())
    })();

    let _ = fs::remove_dir_all(&temp_root);
    result
}

fn ensure_tool(name: &str) -> anyhow::Result<()> {
    let tool = runtime::resolve_named_tool(name, false);
    if tool.found {
        Ok(())
    } else {
        anyhow::bail!("{} is required for `gcpa ui deploy` but was not found in PATH.", name)
    }
}

fn ensure_gh_auth() -> anyhow::Result<()> {
    run_command(None, "gh", &["auth", "status"])?;
    Ok(())
}

fn build_client(project_root: &Path, client_default_api_url: Option<&str>) -> anyhow::Result<()> {
    let script_path = project_root.join("apps/client/scripts/build.mjs");
    let mut command = Command::new("node");
    command.arg(&script_path).current_dir(project_root);
    if let Some(url) = client_default_api_url {
        command.env("CLIENT_DEFAULT_API_URL", url);
    }

    let output = command.output().context("Failed to run the client build")?;
    if !output.status.success() {
        anyhow::bail!(
            "Client build failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn normalize_target_dir(input: &str) -> anyhow::Result<String> {
    let normalized = input.trim().trim_matches('/');
    if normalized.is_empty() {
        anyhow::bail!("Target directory must not be empty.");
    }
    if normalized.starts_with("..") || normalized.contains("/../") {
        anyhow::bail!("Target directory must stay inside the target repository.");
    }
    Ok(normalized.to_string())
}

fn repo_exists(repo: &str) -> anyhow::Result<bool> {
    let status = Command::new("gh")
        .args(["repo", "view", repo])
        .status()
        .context("Failed to query GitHub for the target repository")?;
    Ok(status.success())
}

fn create_repo(repo: &str, private_repo: bool) -> anyhow::Result<()> {
    let visibility = if private_repo { "--private" } else { "--public" };
    run_command(None, "gh", &["repo", "create", repo, visibility, "--confirm"])?;
    Ok(())
}

fn ensure_branch(repo_dir: &Path, branch: &str) -> anyhow::Result<()> {
    let _ = run_command(Some(repo_dir), "git", &["checkout", branch]);
    run_command(Some(repo_dir), "git", &["checkout", "-B", branch])?;
    Ok(())
}

fn sync_directory(source: &Path, destination: &Path) -> anyhow::Result<()> {
    let preserved_cname = destination.join("CNAME");
    let existing_cname = if preserved_cname.exists() {
        Some(fs::read(&preserved_cname)?)
    } else {
        None
    };

    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    fs::create_dir_all(destination)?;
    copy_tree(source, destination)?;

    if let Some(contents) = existing_cname {
        fs::write(destination.join("CNAME"), contents)?;
    }

    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> anyhow::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            fs::create_dir_all(&destination_path)?;
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn has_repo_changes(repo_dir: &Path) -> anyhow::Result<bool> {
    let output = run_command(Some(repo_dir), "git", &["status", "--short"])?;
    Ok(!output.trim().is_empty())
}

fn configure_pages(repo: &str, branch: &str, target_dir: &str) -> anyhow::Result<()> {
    let path = format!("/{target_dir}");
    let endpoint = format!("repos/{repo}/pages");
    let post_args = [
        "api",
        "-X",
        "POST",
        endpoint.as_str(),
        "-f",
        &format!("source[branch]={branch}"),
        "-f",
        &format!("source[path]={path}"),
    ];
    if run_command(None, "gh", &post_args).is_ok() {
        return Ok(());
    }

    let put_args = [
        "api",
        "-X",
        "PUT",
        endpoint.as_str(),
        "-f",
        &format!("source[branch]={branch}"),
        "-f",
        &format!("source[path]={path}"),
    ];
    run_command(None, "gh", &put_args)?;
    Ok(())
}

fn infer_pages_url(repo: &str) -> String {
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or(repo);
    let name = parts.next().unwrap_or(repo);
    if name.eq_ignore_ascii_case(&format!("{owner}.github.io")) {
        format!("https://{name}/")
    } else {
        format!("https://{}.github.io/{}/", owner, name)
    }
}

fn run_command(current_dir: Option<&Path>, program: &str, args: &[&str]) -> anyhow::Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }

    let output = command
        .output()
        .with_context(|| format!("Failed to execute {} {}", program, args.join(" ")))?;

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
