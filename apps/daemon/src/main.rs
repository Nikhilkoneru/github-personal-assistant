mod auth_middleware;
mod config;
mod copilot;
mod db;
mod error;
mod routes;
mod runtime;
mod service;
mod state;
mod store;
mod ui_deploy;

use std::net::SocketAddr;

use axum::Router;
use clap::{Args, Parser, Subcommand};
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

use config::Config;
use db::Database;
use state::AppState;

#[derive(Parser, Debug)]
#[command(name = "gcpa", about = "GitHub Copilot Personal Assistant")]
struct Cli {
    #[command(subcommand)]
    command: Option<CommandGroup>,
}

#[derive(Subcommand, Debug)]
enum CommandGroup {
    #[command(subcommand)]
    Daemon(DaemonCommand),
    #[command(subcommand)]
    Run(RunCommand),
    #[command(subcommand)]
    Ui(UiCommand),
}

#[derive(Subcommand, Debug)]
enum RunCommand {
    Daemon(NetworkArgs),
}

#[derive(Subcommand, Debug)]
enum UiCommand {
    Deploy(UiDeployArgs),
}

#[derive(Subcommand, Debug)]
enum DaemonCommand {
    Run(NetworkArgs),
    Doctor {
        #[arg(long)]
        json: bool,
    },
    Paths {
        #[arg(long)]
        json: bool,
    },
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
}

#[derive(Subcommand, Debug)]
enum ServiceCommand {
    Install(ServiceInstallArgs),
    Uninstall,
    Status,
    Start,
    Stop,
    Restart,
    Print,
}

#[derive(Args, Debug, Clone, Default)]
struct NetworkArgs {
    #[arg(long)]
    host: Option<String>,
    #[arg(long)]
    port: Option<u16>,
}

#[derive(Args, Debug, Clone)]
struct ServiceInstallArgs {
    #[command(flatten)]
    network: NetworkArgs,
    #[arg(long, default_value_t = true)]
    start_now: bool,
}

#[derive(Args, Debug, Clone)]
struct UiDeployArgs {
    #[arg(long)]
    repo: String,
    #[arg(long, default_value = "main")]
    branch: String,
    #[arg(long, default_value = "docs")]
    target_dir: String,
    #[arg(long)]
    client_default_api_url: Option<String>,
    #[arg(long)]
    private_repo: bool,
    #[arg(long)]
    skip_pages_config: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let mut config = Config::from_env();

    match &cli.command {
        Some(CommandGroup::Daemon(DaemonCommand::Run(network)))
        | Some(CommandGroup::Run(RunCommand::Daemon(network))) => {
            config.apply_cli_overrides(network.host.clone(), network.port);
        }
        Some(CommandGroup::Daemon(DaemonCommand::Service {
            command: ServiceCommand::Install(args),
        })) => {
            config.apply_cli_overrides(args.network.host.clone(), args.network.port);
        }
        _ => {}
    }

    let _log_guard = init_tracing(&config)?;
    let started_at = db::now_iso();

    match cli.command {
        None => serve(config, started_at).await,
        Some(CommandGroup::Run(RunCommand::Daemon(_)))
        | Some(CommandGroup::Daemon(DaemonCommand::Run(_))) => serve(config, started_at).await,
        Some(CommandGroup::Daemon(DaemonCommand::Doctor { json })) => {
            let report = runtime::build_doctor_report(&config, &started_at);
            if json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!("gcpa {}", report.runtime.version);
                for check in report.checks {
                    println!("[{}] {} - {}", if check.ok { "ok" } else { "warn" }, check.name, check.detail);
                }
            }
            Ok(())
        }
        Some(CommandGroup::Daemon(DaemonCommand::Paths { json })) => {
            let runtime = runtime::build_runtime_info(&config, &started_at);
            if json {
                println!("{}", serde_json::to_string_pretty(&runtime)?);
            } else {
                println!("Executable: {}", runtime.executable_path);
                println!("Config: {}", runtime.config_path);
                println!("Log: {}", runtime.log_path);
                println!("Database: {}", runtime.data_path);
                println!("Media: {}", runtime.media_path);
                println!("Service: {} ({})", runtime.service_name, runtime.service_manager);
                println!("Service definition: {}", runtime.service_definition_path);
            }
            Ok(())
        }
        Some(CommandGroup::Daemon(DaemonCommand::Service { command })) => match command {
            ServiceCommand::Install(args) => service::install(&config, args.start_now),
            ServiceCommand::Uninstall => service::uninstall(&config),
            ServiceCommand::Status => service::status(&config),
            ServiceCommand::Start => service::start(&config),
            ServiceCommand::Stop => service::stop(&config),
            ServiceCommand::Restart => service::restart(&config),
            ServiceCommand::Print => service::print_definition(&config),
        },
        Some(CommandGroup::Ui(UiCommand::Deploy(args))) => {
            let options = ui_deploy::UiDeployOptions {
                repo: args.repo,
                branch: args.branch,
                target_dir: args.target_dir,
                client_default_api_url: args.client_default_api_url,
                private_repo: args.private_repo,
                skip_pages_config: args.skip_pages_config,
            };
            ui_deploy::deploy_ui(&config, &options)
        }
    }
}

fn init_tracing(config: &Config) -> anyhow::Result<tracing_appender::non_blocking::WorkerGuard> {
    if let Some(parent) = config.log_file_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let log_parent = config
        .log_file_path
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_else(|| config.app_support_dir.join("logs"));
    let log_filename = config
        .log_file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("daemon.log");

    let file_appender = tracing_appender::rolling::never(log_parent, log_filename);
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(fmt::layer().with_target(false))
        .with(fmt::layer().with_ansi(false).with_writer(file_writer))
        .init();

    Ok(guard)
}

async fn serve(config: Config, started_at: String) -> anyhow::Result<()> {
    let database = Database::open(&config)?;
    let state = AppState::new(config.clone(), database, started_at);

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .merge(routes::health::router())
        .merge(routes::auth::router())
        .merge(routes::projects::router())
        .merge(routes::threads::router())
        .merge(routes::models::router())
        .merge(routes::copilot_routes::router())
        .merge(routes::attachments::router())
        .merge(routes::chat::router())
        .layer(cors)
        .with_state(state.clone());

    let addr = SocketAddr::new(config.host.parse()?, config.port);
    tracing::info!("gcpa daemon listening on http://{addr}");
    if let Some(ref url) = config.tailscale_api_url {
        tracing::info!("Tailscale API URL: {url}");
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
