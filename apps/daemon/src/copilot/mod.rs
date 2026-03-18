pub mod sdk_client;

use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::Config;
use sdk_client::SdkConnection;

pub use sdk_client::{
    PendingPermissionOption, PendingPermissionRequest, ReplayedMessage, SDK_PERMISSION_APPROVED,
    SDK_PERMISSION_DENIED, PendingToolCallRequest, SendPromptInput, SessionEvent,
    UserMessageAttachment,
};

pub struct CopilotManager {
    config: Config,
    connection: Mutex<Option<Arc<SdkConnection>>>,
}

impl CopilotManager {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            connection: Mutex::new(None),
        }
    }

    pub async fn create_fresh_connection(&self) -> anyhow::Result<Arc<SdkConnection>> {
        Ok(Arc::new(SdkConnection::spawn(&self.config).await?))
    }

    pub async fn get_or_create_connection(&self) -> anyhow::Result<Arc<SdkConnection>> {
        let mut guard = self.connection.lock().await;
        if let Some(ref conn) = *guard {
            if conn.is_alive().await {
                return Ok(conn.clone());
            }
        }

        let conn = Arc::new(SdkConnection::spawn(&self.config).await?);
        *guard = Some(conn.clone());
        Ok(conn)
    }
}
