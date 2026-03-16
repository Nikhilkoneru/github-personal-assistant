pub mod acp_client;
pub mod types;

use std::sync::Arc;
use tokio::sync::Mutex;

use crate::config::Config;
use acp_client::AcpConnection;

pub struct CopilotManager {
    config: Config,
    connection: Mutex<Option<Arc<AcpConnection>>>,
}

impl CopilotManager {
    pub fn new(config: Config) -> Self {
        CopilotManager {
            config,
            connection: Mutex::new(None),
        }
    }

    pub async fn create_fresh_connection(&self) -> anyhow::Result<Arc<AcpConnection>> {
        Ok(Arc::new(AcpConnection::spawn(&self.config).await?))
    }

    pub async fn get_or_create_connection(&self) -> anyhow::Result<Arc<AcpConnection>> {
        let mut guard = self.connection.lock().await;
        if let Some(ref conn) = *guard {
            if conn.is_alive().await {
                return Ok(conn.clone());
            }
        }

        let conn = Arc::new(AcpConnection::spawn(&self.config).await?);
        *guard = Some(conn.clone());
        Ok(conn)
    }
}
