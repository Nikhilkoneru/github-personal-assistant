mod auth_middleware;
mod config;
mod copilot;
mod db;
mod error;
mod remote_access;
mod routes;
mod runtime;
mod service;
mod state;
mod store;
mod update;

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
#[command(name = "continuum", about = "Continuum Chat")]
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
    RemoteAccess(RemoteAccessCommand),
    Open,
    Update(UpdateArgs),
}

#[derive(Subcommand, Debug)]
enum RunCommand {
    Daemon(NetworkArgs),
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

#[derive(Subcommand, Debug)]
enum RemoteAccessCommand {
    #[command(subcommand)]
    Tailscale(TailscaleCommand),
}

#[derive(Subcommand, Debug)]
enum TailscaleCommand {
    Enable(TailscaleEnableArgs),
    Disable,
    Status {
        #[arg(long)]
        json: bool,
    },
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
struct UpdateArgs {
    #[arg(long)]
    version: Option<String>,
    #[arg(long, default_value_t = false)]
    check: bool,
    #[arg(long, default_value_t = false)]
    force: bool,
    #[arg(long, default_value_t = false)]
    restart_service: bool,
}

#[derive(Args, Debug, Clone)]
struct TailscaleEnableArgs {
    #[arg(long, default_value_t = 443)]
    https_port: u16,
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
                println!("continuum {}", report.runtime.version);
                for check in report.checks {
                    println!(
                        "[{}] {} - {}",
                        if check.ok { "ok" } else { "warn" },
                        check.name,
                        check.detail
                    );
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
                println!(
                    "Service: {} ({})",
                    runtime.service_name, runtime.service_manager
                );
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
        Some(CommandGroup::RemoteAccess(RemoteAccessCommand::Tailscale(command))) => {
            match command {
                TailscaleCommand::Enable(args) => {
                    let status =
                        remote_access::enable_tailscale_https(config.port, args.https_port)?;
                    println!(
                        "Tailscale HTTPS enabled at {}",
                        status
                            .serve_url
                            .clone()
                            .unwrap_or_else(|| config.preferred_ui_origin())
                    );
                    println!("Open it with: {} open", runtime::cli_name());
                    Ok(())
                }
                TailscaleCommand::Disable => {
                    if remote_access::disable_tailscale_https(config.port)? {
                        println!("Removed continuum-managed Tailscale Serve HTTPS config.");
                    } else {
                        println!("No Tailscale Serve config was active for this node.");
                    }
                    Ok(())
                }
                TailscaleCommand::Status { json } => {
                    let status =
                        remote_access::inspect_tailscale(config.port)?.ok_or_else(|| {
                            anyhow::anyhow!("Tailscale is not available on this machine.")
                        })?;
                    if json {
                        println!("{}", serde_json::to_string_pretty(&status)?);
                    } else {
                        println!(
                            "Tailscale: {}",
                            if status.running {
                                "running"
                            } else {
                                "not running"
                            }
                        );
                        if let Some(url) = status.direct_url {
                            println!("Direct URL: {url}");
                        }
                        if let Some(url) = status.serve_url {
                            println!("HTTPS URL: {url}");
                        } else if status.running {
                            println!(
                                "HTTPS URL: not configured (run `{} remote-access tailscale enable`)",
                                runtime::cli_name()
                            );
                        }
                        if let Some(url) = status.preferred_url {
                            println!("Preferred URL: {url}");
                        }
                    }
                    Ok(())
                }
            }
        }
        Some(CommandGroup::Open) => {
            let url = config.preferred_ui_origin();
            runtime::open_browser(&url)?;
            println!("Opened {url}");
            Ok(())
        }
        Some(CommandGroup::Update(args)) => {
            update::run(
                &config,
                update::UpdateOptions {
                    version: args.version,
                    check: args.check,
                    force: args.force,
                    restart_service: args.restart_service,
                },
            )
            .await
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
    let database = Database::open(&config).await?;
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
        .merge(routes::canvases::router())
        .merge(routes::models::router())
        .merge(routes::copilot_routes::router())
        .merge(routes::attachments::router())
        .merge(routes::chat::router())
        .fallback(routes::ui::serve)
        .layer(cors)
        .with_state(state.clone());

    let addr = SocketAddr::new(config.host.parse()?, config.port);
    tracing::info!("continuum daemon listening on http://{addr}");
    tracing::info!("Web UI available at {}", config.preferred_ui_origin());
    if let Some(ref url) = config.tailscale_api_url {
        tracing::info!("Tailscale URL: {url}");
    }

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
