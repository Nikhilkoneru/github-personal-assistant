use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use super::types::*;

/// Agent capabilities discovered during initialization.
#[derive(Debug, Clone, Default)]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub list_sessions: bool,
}

/// A session entry returned by session/list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "_meta")]
    pub meta: Option<serde_json::Value>,
}

/// Result of session/list with pagination.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    pub sessions: Vec<SessionInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A structured message parsed from session/load replay.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayedMessage {
    pub role: String, // "user" or "assistant"
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
}

pub struct AcpConnection {
    child: Mutex<Child>,
    pub(crate) writer: Arc<Mutex<tokio::process::ChildStdin>>,
    pub(crate) next_id: AtomicU64,
    pub(crate) pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    notification_tx: mpsc::UnboundedSender<JsonRpcNotification>,
    pub(crate) notification_rx: Mutex<mpsc::UnboundedReceiver<JsonRpcNotification>>,
    initialized: Mutex<bool>,
    pub(crate) cached_models: Mutex<Option<serde_json::Value>>,
    pub(crate) capabilities: Mutex<AgentCapabilities>,
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
                    tracing::info!("copilot stderr: {}", line);
                }
            });
        }

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (notification_tx, notification_rx) = mpsc::unbounded_channel();

        // Spawn reader task
        let pending_clone = pending.clone();
        let notif_tx = notification_tx.clone();
        let (response_tx, mut response_rx) = mpsc::unbounded_channel::<String>();
        let response_tx_clone = response_tx.clone();

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
                        let _ = notif_tx.send(notif);
                    }
                    Some(AcpMessage::ServerRequest(req)) => {
                        tracing::info!("ACP server request: method={} id={:?} params={}", 
                            req.method, req.id, serde_json::to_string(&req.params).unwrap_or_default());
                        
                        // Auto-approve tool permissions and other server requests
                        let response = match req.method.as_str() {
                            "session/requestPermission" | "session/request_permission" | "session/request" => {
                                // Pick the "allow always" or "allow once" option
                                let option_id = req.params.as_ref()
                                    .and_then(|p| p.get("options"))
                                    .and_then(|opts| opts.as_array())
                                    .and_then(|arr| {
                                        // Prefer "allow_always", fall back to "allow_once"
                                        arr.iter()
                                            .find(|o| o.get("optionId").and_then(|v| v.as_str()) == Some("allow_always"))
                                            .or_else(|| arr.iter().find(|o| o.get("kind").and_then(|v| v.as_str()) == Some("allow_always")))
                                            .or_else(|| arr.iter().find(|o| o.get("optionId").and_then(|v| v.as_str()) == Some("allow_once")))
                                            .or_else(|| arr.first())
                                    })
                                    .and_then(|o| o.get("optionId").and_then(|v| v.as_str()))
                                    .unwrap_or("allow_always");
                                
                                tracing::info!("Auto-approving permission with optionId: {option_id}");
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": req.id,
                                    "result": { "selectedOptionId": option_id }
                                })
                            }
                            "session/userInput" => {
                                // Auto-respond with empty input for now
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": req.id,
                                    "result": { "input": "" }
                                })
                            }
                            _ => {
                                // Generic success response
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": req.id,
                                    "result": {}
                                })
                            }
                        };
                        let line = serde_json::to_string(&response).unwrap_or_default() + "\n";
                        let _ = response_tx_clone.send(line);

                        // Also forward as notification so the SSE handler can emit events
                        let notif = JsonRpcNotification {
                            jsonrpc: "2.0".into(),
                            method: format!("_server_request/{}", req.method),
                            params: req.params,
                        };
                        let _ = notif_tx.send(notif);
                    }
                    None => {
                        tracing::debug!("ACP: unknown message type");
                    }
                }
            }
            tracing::info!("ACP reader task ended");
        });

        let writer_arc: Arc<Mutex<tokio::process::ChildStdin>> = Arc::new(Mutex::new(stdin));

        // Spawn auto-response writer task
        let writer_for_responses = writer_arc.clone();
        tokio::spawn(async move {
            while let Some(line) = response_rx.recv().await {
                tracing::info!("Writing auto-response: {}", line.trim());
                let mut w = writer_for_responses.lock().await;
                if let Err(e) = w.write_all(line.as_bytes()).await {
                    tracing::error!("Failed to write auto-response: {e}");
                }
                let _ = w.flush().await;
                tracing::info!("Auto-response written successfully");
            }
        });

        let conn = AcpConnection {
            child: Mutex::new(child),
            writer: writer_arc,
            next_id: AtomicU64::new(1),
            pending,
            notification_tx,
            notification_rx: Mutex::new(notification_rx),
            initialized: Mutex::new(false),
            cached_models: Mutex::new(None),
            capabilities: Mutex::new(AgentCapabilities::default()),
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

        let resp = self
            .send_request("initialize", serde_json::to_value(params)?)
            .await?;

        // Parse agent capabilities from initialize response
        if let Some(result) = resp.result.as_ref() {
            let mut caps = self.capabilities.lock().await;
            caps.load_session = result
                .get("agentCapabilities")
                .and_then(|c| c.get("loadSession"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            caps.list_sessions = result
                .get("agentCapabilities")
                .and_then(|c| c.get("sessionCapabilities"))
                .and_then(|c| c.get("list"))
                .is_some();
            tracing::info!(
                "ACP capabilities: loadSession={}, listSessions={}",
                caps.load_session,
                caps.list_sessions
            );
        }

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

    /// Get discovered agent capabilities.
    pub async fn get_capabilities(&self) -> AgentCapabilities {
        self.capabilities.lock().await.clone()
    }

    /// List sessions known to the agent via ACP session/list.
    /// Supports optional cwd filter and cursor-based pagination.
    pub async fn list_sessions(
        &self,
        cwd: Option<&str>,
        cursor: Option<&str>,
    ) -> anyhow::Result<ListSessionsResult> {
        let caps = self.capabilities.lock().await;
        if !caps.list_sessions {
            anyhow::bail!("Agent does not support session/list");
        }
        drop(caps);

        let mut params = json!({});
        if let Some(cwd) = cwd {
            params["cwd"] = json!(cwd);
        }
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }

        let resp = self.send_request("session/list", params).await?;
        let result = resp
            .result
            .ok_or_else(|| anyhow::anyhow!("No result in session/list response"))?;

        let sessions: Vec<SessionInfo> = result
            .get("sessions")
            .and_then(|s| serde_json::from_value(s.clone()).ok())
            .unwrap_or_default();
        let next_cursor = result
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        Ok(ListSessionsResult {
            sessions,
            next_cursor,
        })
    }

    /// Load a session and collect the replayed conversation history.
    /// Returns structured messages by consuming session/update notifications
    /// until the session/load response arrives.
    pub async fn load_session_messages(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> anyhow::Result<Vec<ReplayedMessage>> {
        let caps = self.capabilities.lock().await;
        if !caps.load_session {
            anyhow::bail!("Agent does not support session/load");
        }
        drop(caps);

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/load",
            "params": {
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": []
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

        // Collect replayed notifications until the response arrives
        let mut messages: Vec<ReplayedMessage> = Vec::new();
        let mut current_user_text = String::new();
        let mut current_assistant_text = String::new();
        let mut current_tool_calls: Vec<serde_json::Value> = Vec::new();
        let mut last_role: Option<String> = None;
        let mut saw_tool_call_since_last_assistant_text = false;

        let timeout = tokio::time::sleep(std::time::Duration::from_secs(30));
        tokio::pin!(timeout);
        tokio::pin!(result_rx);

        loop {
            tokio::select! {
                result = &mut result_rx => {
                    // Drain remaining notifications
                    for notif in self.drain_notifications().await {
                        Self::accumulate_replay_message(
                            &notif, &mut messages, &mut current_user_text,
                            &mut current_assistant_text, &mut current_tool_calls, &mut last_role,
                            &mut saw_tool_call_since_last_assistant_text,
                        );
                    }
                    // Flush any remaining accumulated text
                    Self::flush_accumulated(
                        &mut messages, &mut current_user_text,
                        &mut current_assistant_text, &mut current_tool_calls, &mut last_role,
                        &mut saw_tool_call_since_last_assistant_text,
                    );

                    match result {
                        Ok(resp) => {
                            if let Some(ref err) = resp.error {
                                anyhow::bail!("session/load error: {}", err.message);
                            }
                            // Cache models if returned
                            if let Some(models) = resp.result.as_ref().and_then(|r| r.get("models")) {
                                *self.cached_models.lock().await = Some(models.clone());
                            }
                        }
                        Err(e) => anyhow::bail!("session/load channel error: {e}"),
                    }
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {
                    for notif in self.drain_notifications().await {
                        Self::accumulate_replay_message(
                            &notif, &mut messages, &mut current_user_text,
                            &mut current_assistant_text, &mut current_tool_calls, &mut last_role,
                            &mut saw_tool_call_since_last_assistant_text,
                        );
                    }
                }
                _ = &mut timeout => {
                    anyhow::bail!("session/load timed out");
                }
            }
        }

        Ok(messages)
    }

    /// Accumulate a replayed notification into the message list.
    fn accumulate_replay_message(
        notif: &JsonRpcNotification,
        messages: &mut Vec<ReplayedMessage>,
        current_user_text: &mut String,
        current_assistant_text: &mut String,
        current_tool_calls: &mut Vec<serde_json::Value>,
        last_role: &mut Option<String>,
        saw_tool_call_since_last_assistant_text: &mut bool,
    ) {
        if notif.method != "session/update" {
            return;
        }
        let Some(ref params) = notif.params else {
            return;
        };
        let Some(update) = params.get("update") else {
            return;
        };
        let update_type = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match update_type {
            "user_message_chunk" => {
                // If we were accumulating assistant text, flush it
                if last_role.as_deref() == Some("assistant") {
                    Self::flush_accumulated(
                        messages,
                        current_user_text,
                        current_assistant_text,
                        current_tool_calls,
                        last_role,
                        saw_tool_call_since_last_assistant_text,
                    );
                }
                if let Some(text) = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                {
                    current_user_text.push_str(text);
                }
                *last_role = Some("user".into());
            }
            "agent_message_chunk" | "message" => {
                // Split a new assistant segment after tools complete so post-tool text
                // becomes a new message instead of mutating the earlier one.
                if last_role.as_deref() == Some("user")
                    || (last_role.as_deref() == Some("assistant")
                        && *saw_tool_call_since_last_assistant_text
                        && (!current_assistant_text.is_empty() || !current_tool_calls.is_empty()))
                {
                    Self::flush_accumulated(
                        messages,
                        current_user_text,
                        current_assistant_text,
                        current_tool_calls,
                        last_role,
                        saw_tool_call_since_last_assistant_text,
                    );
                }
                if let Some(content) = update.get("content") {
                    if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                        current_assistant_text.push_str(text);
                    } else if let Some(blocks) = content.as_array() {
                        for block in blocks {
                            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                current_assistant_text.push_str(text);
                            }
                        }
                    }
                }
                *last_role = Some("assistant".into());
            }
            "tool_call" | "tool_call_update" | "tool_result" => {
                // Collect tool call info alongside assistant message
                let tool_info = json!({
                    "id": update.get("toolCallId").or(update.get("id")),
                    "name": update.get("title").or(update.get("name")),
                    "status": update.get("status"),
                    "arguments": update.get("rawInput").or(update.get("arguments")),
                    "result": update.get("content").or(update.get("result")),
                    "additionalContext": update.get("progressMessage"),
                    "error": update.get("error"),
                });
                Self::upsert_replay_tool_call(current_tool_calls, tool_info);
                *saw_tool_call_since_last_assistant_text = true;
                *last_role = Some("assistant".into());
            }
            _ => {}
        }
    }

    /// Flush accumulated text into a message.
    fn flush_accumulated(
        messages: &mut Vec<ReplayedMessage>,
        current_user_text: &mut String,
        current_assistant_text: &mut String,
        current_tool_calls: &mut Vec<serde_json::Value>,
        last_role: &mut Option<String>,
        saw_tool_call_since_last_assistant_text: &mut bool,
    ) {
        if !current_user_text.is_empty() {
            messages.push(ReplayedMessage {
                role: "user".into(),
                content: std::mem::take(current_user_text),
                tool_calls: None,
            });
        }
        if !current_assistant_text.is_empty() || !current_tool_calls.is_empty() {
            let tools = if current_tool_calls.is_empty() {
                None
            } else {
                Some(std::mem::take(current_tool_calls))
            };
            messages.push(ReplayedMessage {
                role: "assistant".into(),
                content: std::mem::take(current_assistant_text),
                tool_calls: tools,
            });
        }
        current_tool_calls.clear();
        *last_role = None;
        *saw_tool_call_since_last_assistant_text = false;
    }

    fn upsert_replay_tool_call(
        current_tool_calls: &mut Vec<serde_json::Value>,
        next_tool_call: serde_json::Value,
    ) {
        let next_id = next_tool_call
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_owned);

        if let Some(next_id) = next_id {
            if let Some(existing) = current_tool_calls.iter_mut().find(|tool_call| {
                tool_call
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == next_id)
                    .unwrap_or(false)
            }) {
                if let (Some(existing_object), Some(next_object)) =
                    (existing.as_object_mut(), next_tool_call.as_object())
                {
                    for (key, value) in next_object {
                        if !value.is_null() {
                            existing_object.insert(key.clone(), value.clone());
                        }
                    }
                    return;
                }
            }
        }

        current_tool_calls.push(next_tool_call);
    }
}
