use std::sync::Arc;

use crate::config::Config;
use crate::copilot::CopilotManager;
use crate::db::Database;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: Arc<Database>,
    pub copilot: Arc<CopilotManager>,
    pub started_at: String,
}

impl AppState {
    pub fn new(config: Config, database: Database, started_at: String) -> Self {
        let db = Arc::new(database);
        let copilot = Arc::new(CopilotManager::new(config.clone()));
        AppState {
            config,
            db,
            copilot,
            started_at,
        }
    }
}
