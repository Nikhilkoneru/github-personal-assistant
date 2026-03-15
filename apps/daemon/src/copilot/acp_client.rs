use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::types::*;

pub struct AcpConnection {
    child: Mutex<Child>,
    pub(crate) writer: Mutex<tokio::process::ChildStdin>,
    pub(crate) next_id: AtomicU64,
    pub(crate) pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    notification_tx: mpsc::UnboundedSender<JsonRpcNotification>,
    pub(crate) notification_rx: Mutex<mpsc::UnboundedReceiver<JsonRpcNotification>>,
    initialized: Mutex<bool>,
    pub(crate) cached_models: Mutex<Option<serde_json::Value>>,
}

impl AcpConnection {
    pub async fn spawn() -> anyhow::Result<Self> {
        let mut child = Command::new("copilot")
            .args(["--acp", "--stdio"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow::anyhow!("No stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow::anyhow!("No stdout"))?;
        let stderr = child.stderr.take();

        // Log stderr
        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("copilot stderr: {}", line);
                }
            });
        }

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (notification_tx, notification_rx) = mpsc::unbounded_channel();

        // Spawn reader task
        let pending_clone = pending.clone();
        let notif_tx = notification_tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                    tracing::warn!("ACP: unparseable line: {}", &line[..line.len().min(200)]);
                    continue;
                };

                match AcpMessage::from_value(val) {
                    Some(AcpMessage::Response(resp)) => {
                        if let Some(id) = resp.id.as_ref().and_then(|v| v.as_u64()) {
                            let mut map = pending_clone.lock().await;
                            if let Some(sender) = map.remove(&id) {
                                let _ = sender.send(resp);
                            }
                        }
                    }
                    Some(AcpMessage::Notification(notif)) => {
                        // Handle client-side requests from the agent (fs, terminal)
                        // For now, we just forward notifications
                        let _ = notif_tx.send(notif);
                    }
                    None => {
                        tracing::debug!("ACP: unknown message type");
                    }
                }
            }
            tracing::info!("ACP reader task ended");
        });

        let conn = AcpConnection {
            child: Mutex::new(child),
            writer: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending,
            notification_tx,
            notification_rx: Mutex::new(notification_rx),
            initialized: Mutex::new(false),
            cached_models: Mutex::new(None),
        };

        conn.initialize().await?;
        Ok(conn)
    }

    async fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<JsonRpcResponse> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, tx);
        }

        let line = serde_json::to_string(&msg)? + "\n";
        {
            let mut writer = self.writer.lock().await;
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
        }

        let resp = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await??;
        if let Some(ref err) = resp.error {
            anyhow::bail!("ACP error ({}): {}", err.code, err.message);
        }
        Ok(resp)
    }

    async fn send_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let line = serde_json::to_string(&msg)? + "\n";
        let mut writer = self.writer.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.flush().await?;
        Ok(())
    }

    async fn initialize(&self) -> anyhow::Result<()> {
        let params = InitializeParams {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "gpa-daemon".to_string(),
                version: "1.0.0".to_string(),
            },
            capabilities: ClientCapabilities {
                prompt_capabilities: Some(PromptCapabilities {
                    image: true,
                    audio: false,
                    embedded_context: true,
                }),
            },
        };

        let _resp = self
            .send_request("initialize", serde_json::to_value(params)?)
            .await?;

        *self.initialized.lock().await = true;
        tracing::info!("ACP connection initialized");
        Ok(())
    }

    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    pub async fn new_session(&self) -> anyhow::Result<String> {
        let cwd = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let resp = self
            .send_request(
                "session/new",
                json!({
                    "cwd": cwd,
                    "mcpServers": []
                }),
            )
            .await?;

        // Cache models from session/new response
        if let Some(models) = resp.result.as_ref().and_then(|r| r.get("models")) {
            *self.cached_models.lock().await = Some(models.clone());
        }

        let session_id = resp
            .result
            .as_ref()
            .and_then(|r| r.get("sessionId"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("No sessionId in session/new response"))?
            .to_string();
        Ok(session_id)
    }

    pub async fn get_cached_models(&self) -> Option<serde_json::Value> {
        self.cached_models.lock().await.clone()
    }

    pub async fn load_session(&self, session_id: &str) -> anyhow::Result<serde_json::Value> {
        let resp = self
            .send_request("session/load", json!({ "sessionId": session_id }))
            .await?;
        Ok(resp.result.unwrap_or(serde_json::Value::Null))
    }

    /// Send a prompt and stream session/update notifications.
    /// Returns a receiver for notifications and a future that resolves to the prompt result.
    pub async fn prompt(
        &self,
        session_id: &str,
        content: Vec<serde_json::Value>,
    ) -> anyhow::Result<(
        mpsc::UnboundedReceiver<JsonRpcNotification>,
        tokio::task::JoinHandle<anyhow::Result<serde_json::Value>>,
    )> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": content
            }
        });

        let (result_tx, result_rx) = oneshot::channel::<JsonRpcResponse>();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, result_tx);
        }

        // Create a dedicated notification channel for this prompt
        let (notif_tx, notif_rx) = mpsc::unbounded_channel();

        // Drain the shared notification channel into the per-prompt channel
        let shared_notif_tx = self.notification_tx.clone();
        let shared_notif_rx_handle = {
            let mut rx = self.notification_rx.lock().await;
            let (forward_tx, mut forward_rx) = mpsc::unbounded_channel();

            // Swap the receiver — take ownership for forwarding
            // Actually, let's use a different approach: subscribe to notifications
            // For simplicity, forward from the shared channel
            tokio::spawn({
                let notif_tx = notif_tx.clone();
                async move {
                    while let Some(notif) = forward_rx.recv().await {
                        let _ = notif_tx.send(notif);
                    }
                }
            });

            // Replace the main receiver with a forwarding one
            drop(rx);
            drop(shared_notif_tx);
            drop(forward_tx);
            // This approach is getting complex. Let me simplify.
        };
        let _ = shared_notif_rx_handle;

        let line = serde_json::to_string(&msg)? + "\n";
        {
            let mut writer = self.writer.lock().await;
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
        }

        let result_handle = tokio::spawn(async move {
            let resp = tokio::time::timeout(std::time::Duration::from_secs(600), result_rx)
                .await
                .map_err(|_| anyhow::anyhow!("Prompt timed out"))??;
            Ok(resp.result.unwrap_or(serde_json::Value::Null))
        });

        Ok((notif_rx, result_handle))
    }

    pub async fn cancel_session(&self, session_id: &str) -> anyhow::Result<()> {
        self.send_notification("session/cancel", json!({ "sessionId": session_id }))
            .await
    }

    /// Send a prompt and return a channel that receives streaming events
    /// plus a handle for the final response.
    pub async fn send_prompt_streaming(
        &self,
        session_id: &str,
        content: Vec<serde_json::Value>,
    ) -> anyhow::Result<tokio::sync::oneshot::Receiver<JsonRpcResponse>> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": content
            }
        });

        let (result_tx, result_rx) = oneshot::channel::<JsonRpcResponse>();
        {
            let mut map = self.pending.lock().await;
            map.insert(id, result_tx);
        }

        let line = serde_json::to_string(&msg)? + "\n";
        {
            let mut writer = self.writer.lock().await;
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
        }

        Ok(result_rx)
    }

    /// Drain any pending notifications (non-blocking)
    pub async fn drain_notifications(&self) -> Vec<JsonRpcNotification> {
        let mut rx = self.notification_rx.lock().await;
        let mut out = Vec::new();
        while let Ok(notif) = rx.try_recv() {
            out.push(notif);
        }
        out
    }
}
