use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, oneshot, Mutex, RwLock};

const MIN_SDK_PROTOCOL_VERSION: u32 = 2;
const MAX_SDK_PROTOCOL_VERSION: u32 = 3;
pub const SDK_PERMISSION_APPROVED: &str = "approved";
pub const SDK_PERMISSION_DENIED: &str = "denied-no-approval-rule-and-could-not-request-from-user";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub modified_time: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub is_remote: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub version: String,
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub is_authenticated: bool,
    #[serde(default)]
    pub auth_type: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub login: Option<String>,
    #[serde(default)]
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    #[serde(default)]
    pub supports: ModelSupports,
    #[serde(default)]
    pub limits: ModelLimits,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSupports {
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub reasoning_effort: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelLimits {
    #[serde(default)]
    pub max_prompt_tokens: Option<u32>,
    #[serde(default)]
    pub max_context_window_tokens: u32,
    #[serde(default)]
    pub vision: Option<ModelVisionLimits>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVisionLimits {
    #[serde(default)]
    pub supported_media_types: Vec<String>,
    #[serde(default)]
    pub max_prompt_images: u32,
    #[serde(default)]
    pub max_prompt_image_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPolicy {
    pub state: String,
    #[serde(default)]
    pub terms: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelBilling {
    #[serde(default)]
    pub multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub capabilities: ModelCapabilities,
    #[serde(default)]
    pub policy: Option<ModelPolicy>,
    #[serde(default)]
    pub billing: Option<ModelBilling>,
    #[serde(default)]
    pub supported_reasoning_efforts: Option<Vec<String>>,
    #[serde(default)]
    pub default_reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayedMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserInputRequest {
    pub request_id: String,
    pub session_id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
    pub allow_freeform: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionOption {
    pub option_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionRequest {
    pub request_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_kind: Option<String>,
    pub question: String,
    pub options: Vec<PendingPermissionOption>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCallRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct SessionEvent {
    pub id: String,
    pub timestamp: String,
    pub event_type: String,
    pub data: Value,
}

#[derive(Debug, Clone)]
pub struct UserMessageAttachment {
    pub path: String,
    pub display_name: String,
}

#[derive(Debug, Default, Clone)]
pub struct SendPromptInput {
    pub prompt: String,
    pub attachments: Vec<UserMessageAttachment>,
    pub mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcRequest {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

enum IncomingMessage {
    Response(JsonRpcResponse),
    Request(JsonRpcRequest),
    Notification(JsonRpcRequest),
}

#[derive(Clone)]
struct SessionRecord {
    working_directory: String,
    events: broadcast::Sender<SessionEvent>,
}

struct PendingUserInputState {
    request: PendingUserInputRequest,
    response_tx: Option<oneshot::Sender<String>>,
}

struct PendingPermissionState {
    request: PendingPermissionRequest,
    response_tx: Option<oneshot::Sender<String>>,
}

struct PendingToolCallState {
    request: PendingToolCallRequest,
    response_tx: Option<oneshot::Sender<Value>>,
}

pub struct SdkConnection {
    child: Mutex<Child>,
    writer: Arc<Mutex<ChildStdin>>,
    next_id: AtomicU64,
    protocol_version: AtomicU32,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<JsonRpcResponse>>>>,
    sessions: Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_user_inputs: Arc<Mutex<HashMap<String, PendingUserInputState>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermissionState>>>,
    pending_tool_calls: Arc<Mutex<HashMap<String, PendingToolCallState>>>,
}

impl SdkConnection {
    pub async fn spawn(config: &crate::config::Config) -> anyhow::Result<Self> {
        let copilot_command = crate::runtime::resolve_copilot_command(config)?;
        let mut command = Command::new(&copilot_command);
        command
            .args(["--server", "--stdio", "--log-level", "info"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(token) = config.copilot_github_token.as_deref() {
            command
                .env("COPILOT_SDK_AUTH_TOKEN", token)
                .args(["--auth-token-env", "COPILOT_SDK_AUTH_TOKEN"]);
        } else if !config.copilot_use_logged_in_user {
            command.arg("--no-auto-login");
        }

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .context("Copilot SDK stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("Copilot SDK stdout unavailable")?;
        let stderr = child.stderr.take();

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("copilot sdk stderr: {}", line);
                }
            });
        }

        let pending = Arc::new(Mutex::new(HashMap::new()));
        let sessions = Arc::new(RwLock::new(HashMap::new()));
        let pending_user_inputs = Arc::new(Mutex::new(HashMap::new()));
        let pending_permissions = Arc::new(Mutex::new(HashMap::new()));
        let pending_tool_calls = Arc::new(Mutex::new(HashMap::new()));
        let writer = Arc::new(Mutex::new(stdin));

        Self::spawn_reader_task(
            stdout,
            writer.clone(),
            pending.clone(),
            sessions.clone(),
            pending_user_inputs.clone(),
            pending_permissions.clone(),
            pending_tool_calls.clone(),
        );

        let conn = Self {
            child: Mutex::new(child),
            writer,
            next_id: AtomicU64::new(1),
            protocol_version: AtomicU32::new(MIN_SDK_PROTOCOL_VERSION),
            pending,
            sessions,
            pending_user_inputs,
            pending_permissions,
            pending_tool_calls,
        };

        conn.verify_protocol_version().await?;
        Ok(conn)
    }

    pub async fn is_alive(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(_) => false,
        }
    }

    pub async fn new_session(
        &self,
        cwd: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        tool_policy: Option<&SessionToolPolicy>,
    ) -> anyhow::Result<String> {
        let result = self
            .invoke(
                "session.create",
                Some(build_session_config(
                    cwd,
                    model,
                    reasoning_effort,
                    tool_policy,
                )),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .context("Missing sessionId in session.create response")?
            .to_string();
        let working_directory = result
            .get("workspacePath")
            .and_then(Value::as_str)
            .unwrap_or(cwd)
            .to_string();
        self.upsert_session_record(&session_id, &working_directory)
            .await;
        Ok(session_id)
    }

    pub async fn ensure_session(
        &self,
        session_id: &str,
        cwd: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        tool_policy: Option<&SessionToolPolicy>,
    ) -> anyhow::Result<String> {
        if self.sessions.read().await.contains_key(session_id) {
            return Ok(session_id.to_string());
        }
        self.resume_session(session_id, cwd, model, reasoning_effort, tool_policy)
            .await
    }

    pub async fn resume_session(
        &self,
        session_id: &str,
        cwd: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        tool_policy: Option<&SessionToolPolicy>,
    ) -> anyhow::Result<String> {
        let mut params = build_resume_config(cwd, model, reasoning_effort, tool_policy);
        params["sessionId"] = json!(session_id);
        let result = self.invoke("session.resume", Some(params)).await?;
        let resumed_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(session_id)
            .to_string();
        let working_directory = result
            .get("workspacePath")
            .and_then(Value::as_str)
            .unwrap_or(cwd)
            .to_string();
        self.upsert_session_record(&resumed_id, &working_directory)
            .await;
        Ok(resumed_id)
    }

    pub async fn list_sessions(&self) -> anyhow::Result<Vec<SessionInfo>> {
        let result = self.invoke("session.list", None).await?;
        Ok(result
            .get("sessions")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default())
    }

    pub async fn get_last_session_id(&self) -> anyhow::Result<Option<String>> {
        let result = self.invoke("session.getLastId", None).await?;
        Ok(result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    pub async fn delete_session(&self, session_id: &str) -> anyhow::Result<()> {
        let result = self
            .invoke("session.delete", Some(json!({ "sessionId": session_id })))
            .await?;
        if result
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            self.sessions.write().await.remove(session_id);
            Ok(())
        } else {
            anyhow::bail!(
                "{}",
                result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Failed to delete session")
            )
        }
    }

    pub async fn get_status(&self) -> anyhow::Result<RuntimeStatus> {
        Ok(serde_json::from_value(
            self.invoke("status.get", None).await?,
        )?)
    }

    pub async fn get_auth_status(&self) -> anyhow::Result<AuthStatus> {
        Ok(serde_json::from_value(
            self.invoke("auth.getStatus", None).await?,
        )?)
    }

    pub async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        let result = self.invoke("models.list", None).await?;
        Ok(result
            .get("models")
            .cloned()
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default())
    }

    pub async fn cancel_session(&self, session_id: &str) -> anyhow::Result<()> {
        self.notify("session.abort", json!({ "sessionId": session_id }))
            .await
    }

    pub async fn subscribe(
        &self,
        session_id: &str,
    ) -> anyhow::Result<broadcast::Receiver<SessionEvent>> {
        let sessions = self.sessions.read().await;
        let record = sessions
            .get(session_id)
            .with_context(|| format!("Copilot session {session_id} is not registered locally"))?;
        Ok(record.events.subscribe())
    }

    pub async fn send_prompt_streaming(
        &self,
        session_id: &str,
        input: SendPromptInput,
    ) -> anyhow::Result<broadcast::Receiver<SessionEvent>> {
        let rx = self.subscribe(session_id).await?;
        let attachments = if input.attachments.is_empty() {
            None
        } else {
            Some(
                input
                    .attachments
                    .into_iter()
                    .map(|attachment| {
                        json!({
                            "type": "file",
                            "path": attachment.path,
                            "displayName": attachment.display_name,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
        };
        self.invoke(
            "session.send",
            Some(json!({
                "sessionId": session_id,
                "prompt": input.prompt,
                "attachments": attachments,
                "mode": input.mode,
            })),
        )
        .await?;
        Ok(rx)
    }

    pub async fn load_session_messages(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Vec<ReplayedMessage>> {
        let result = self
            .invoke(
                "session.getMessages",
                Some(json!({ "sessionId": session_id })),
            )
            .await?;
        let raw_events = result
            .get("events")
            .or_else(|| result.get("messages"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let parsed_events = raw_events
            .into_iter()
            .filter_map(|event| SessionEventEnvelope::from_value(event).ok())
            .map(SessionEventEnvelope::into_session_event)
            .collect::<Vec<_>>();
        Ok(replay_messages_from_events(&parsed_events))
    }

    pub async fn get_pending_user_input_for_session(
        &self,
        session_id: &str,
    ) -> Option<PendingUserInputRequest> {
        self.pending_user_inputs
            .lock()
            .await
            .values()
            .find(|state| state.request.session_id == session_id)
            .map(|state| state.request.clone())
    }

    pub async fn get_pending_user_input(
        &self,
        request_id: &str,
    ) -> Option<PendingUserInputRequest> {
        self.pending_user_inputs
            .lock()
            .await
            .get(request_id)
            .map(|state| state.request.clone())
    }

    pub async fn get_pending_permissions_for_session(
        &self,
        session_id: &str,
    ) -> Vec<PendingPermissionRequest> {
        self.pending_permissions
            .lock()
            .await
            .values()
            .filter(|state| state.request.session_id == session_id)
            .map(|state| state.request.clone())
            .collect()
    }

    pub async fn get_pending_permission(
        &self,
        request_id: &str,
    ) -> Option<PendingPermissionRequest> {
        self.pending_permissions
            .lock()
            .await
            .get(request_id)
            .map(|state| state.request.clone())
    }

    pub async fn get_pending_tool_call(&self, request_id: &str) -> Option<PendingToolCallRequest> {
        self.pending_tool_calls
            .lock()
            .await
            .get(request_id)
            .map(|state| state.request.clone())
    }

    pub async fn respond_to_user_input(
        &self,
        request_id: &str,
        answer: &str,
    ) -> anyhow::Result<()> {
        let state = self.pending_user_inputs.lock().await.remove(request_id);
        let Some(state) = state else {
            anyhow::bail!("Copilot user input request {request_id} is no longer pending");
        };
        if let Some(response_tx) = state.response_tx {
            response_tx
                .send(answer.to_string())
                .map_err(|_| anyhow::anyhow!("Failed to deliver user input response"))
        } else {
            self.invoke(
                "session.userInput.handlePendingUserInputRequest",
                Some(json!({
                    "sessionId": state.request.session_id,
                    "requestId": request_id,
                    "answer": answer,
                })),
            )
            .await
            .map(|_| ())
        }
    }

    pub async fn respond_to_permission_request(
        &self,
        request_id: &str,
        option_id: &str,
    ) -> anyhow::Result<()> {
        let state = self.pending_permissions.lock().await.remove(request_id);
        let Some(state) = state else {
            anyhow::bail!("Copilot permission request {request_id} is no longer pending");
        };
        if let Some(response_tx) = state.response_tx {
            response_tx
                .send(option_id.to_string())
                .map_err(|_| anyhow::anyhow!("Failed to deliver permission response"))
        } else {
            self.invoke(
                "session.permissions.handlePendingPermissionRequest",
                Some(json!({
                    "sessionId": state.request.session_id,
                    "requestId": request_id,
                    "result": permission_result_from_option_id(option_id),
                })),
            )
            .await
            .map(|_| ())
        }
    }

    pub async fn respond_to_tool_call(
        &self,
        request_id: &str,
        result: Value,
    ) -> anyhow::Result<()> {
        let state = self.pending_tool_calls.lock().await.remove(request_id);
        let Some(state) = state else {
            anyhow::bail!("Copilot tool call request {request_id} is no longer pending");
        };
        if let Some(response_tx) = state.response_tx {
            response_tx
                .send(result)
                .map_err(|_| anyhow::anyhow!("Failed to deliver tool call response"))
        } else {
            self.invoke(
                "session.tools.handlePendingToolCall",
                Some(json!({
                    "sessionId": state.request.session_id,
                    "requestId": request_id,
                    "result": result,
                })),
            )
            .await
            .map(|_| ())
        }
    }

    pub fn protocol_version(&self) -> u32 {
        self.protocol_version.load(Ordering::SeqCst)
    }

    pub fn is_missing_session_error(error: &anyhow::Error) -> bool {
        let message = error.to_string();
        message.contains("Session not found")
            || message.contains("session not found")
            || message.contains("Resource not found")
    }

    pub fn is_resettable_session_error(error: &anyhow::Error) -> bool {
        Self::is_missing_session_error(error)
            || error.to_string().contains("Session file is corrupted")
    }

    async fn verify_protocol_version(&self) -> anyhow::Result<()> {
        let result = self
            .invoke("ping", Some(json!({ "message": null })))
            .await?;
        if let Some(protocol_version) = result.get("protocolVersion").and_then(Value::as_u64) {
            let protocol_version = protocol_version as u32;
            if !(MIN_SDK_PROTOCOL_VERSION..=MAX_SDK_PROTOCOL_VERSION).contains(&protocol_version) {
                anyhow::bail!(
                    "Copilot SDK protocol mismatch: expected {MIN_SDK_PROTOCOL_VERSION}-{MAX_SDK_PROTOCOL_VERSION}, got {protocol_version}"
                );
            }
            self.protocol_version
                .store(protocol_version, Ordering::SeqCst);
        }
        Ok(())
    }

    async fn invoke(&self, method: &str, params: Option<Value>) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Some(json!(id)),
            method: method.to_string(),
            params,
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        write_framed_json(&self.writer, &serde_json::to_value(&request)?).await?;
        let response = rx.await.context("Copilot SDK response channel closed")?;
        if let Some(error) = response.error {
            anyhow::bail!("{}", error.message);
        }
        Ok(response.result.unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str, params: Value) -> anyhow::Result<()> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: None,
            method: method.to_string(),
            params: Some(params),
        };
        write_framed_json(&self.writer, &serde_json::to_value(&request)?).await
    }

    async fn upsert_session_record(&self, session_id: &str, working_directory: &str) {
        let mut sessions = self.sessions.write().await;
        sessions
            .entry(session_id.to_string())
            .and_modify(|record| {
                Arc::make_mut(record).working_directory = working_directory.to_string();
            })
            .or_insert_with(|| Arc::new(SessionRecord::new(working_directory)));
    }

    fn spawn_reader_task(
        stdout: ChildStdout,
        writer: Arc<Mutex<ChildStdin>>,
        pending: Arc<Mutex<HashMap<String, oneshot::Sender<JsonRpcResponse>>>>,
        sessions: Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
        pending_user_inputs: Arc<Mutex<HashMap<String, PendingUserInputState>>>,
        pending_permissions: Arc<Mutex<HashMap<String, PendingPermissionState>>>,
        pending_tool_calls: Arc<Mutex<HashMap<String, PendingToolCallState>>>,
    ) {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = match read_framed_message(&mut reader).await {
                    Ok(message) => message,
                    Err(error) => {
                        tracing::warn!("Copilot SDK reader stopped: {error}");
                        break;
                    }
                };

                let value = match serde_json::from_str::<Value>(&message) {
                    Ok(value) => value,
                    Err(error) => {
                        tracing::warn!("Copilot SDK sent invalid JSON: {error}");
                        continue;
                    }
                };

                let Some(incoming) = classify_message(value) else {
                    continue;
                };

                match incoming {
                    IncomingMessage::Response(response) => {
                        if let Some(id) = response.id.as_ref().map(rpc_id_string) {
                            if let Some(sender) = pending.lock().await.remove(&id) {
                                let _ = sender.send(response);
                            }
                        }
                    }
                    IncomingMessage::Notification(notification) => {
                        handle_notification(
                            notification,
                            &sessions,
                            &pending_user_inputs,
                            &pending_permissions,
                            &pending_tool_calls,
                        )
                        .await;
                    }
                    IncomingMessage::Request(request) => {
                        let writer = writer.clone();
                        let sessions = sessions.clone();
                        let pending_user_inputs = pending_user_inputs.clone();
                        let pending_permissions = pending_permissions.clone();
                        let pending_tool_calls = pending_tool_calls.clone();
                        tokio::spawn(async move {
                            handle_request(
                                request,
                                writer,
                                sessions,
                                pending_user_inputs,
                                pending_permissions,
                                pending_tool_calls,
                            )
                            .await;
                        });
                    }
                }
            }
        });
    }
}

impl SessionRecord {
    fn new(working_directory: &str) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            working_directory: working_directory.to_string(),
            events,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEventEnvelope {
    id: String,
    timestamp: String,
    #[serde(rename = "type")]
    event_type: String,
    data: Value,
}

impl SessionEventEnvelope {
    fn from_value(value: Value) -> serde_json::Result<Self> {
        serde_json::from_value(value)
    }

    fn into_session_event(self) -> SessionEvent {
        SessionEvent {
            id: self.id,
            timestamp: self.timestamp,
            event_type: self.event_type,
            data: self.data,
        }
    }
}

async fn handle_notification(
    notification: JsonRpcRequest,
    sessions: &Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_user_inputs: &Arc<Mutex<HashMap<String, PendingUserInputState>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermissionState>>>,
    pending_tool_calls: &Arc<Mutex<HashMap<String, PendingToolCallState>>>,
) {
    match notification.method.as_str() {
        "session.event" => {
            let Some(params) = notification.params else {
                return;
            };
            let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
                return;
            };
            let Some(event_value) = params.get("event") else {
                return;
            };
            let Ok(event) = SessionEventEnvelope::from_value(event_value.clone()) else {
                return;
            };
            if let Some(record) = sessions.read().await.get(session_id) {
                let event = event.into_session_event();
                let _ = record.events.send(event.clone());
                maybe_emit_v3_bridge_events(
                    record,
                    session_id,
                    &event,
                    pending_user_inputs,
                    pending_permissions,
                    pending_tool_calls,
                )
                .await;
            }
        }
        "session.lifecycle" => {
            let Some(params) = notification.params else {
                return;
            };
            let Some(event_type) = params.get("type").and_then(Value::as_str) else {
                return;
            };
            if event_type == "session.deleted" {
                if let Some(session_id) = params.get("sessionId").and_then(Value::as_str) {
                    sessions.write().await.remove(session_id);
                }
            }
        }
        _ => {}
    }
}

async fn handle_request(
    request: JsonRpcRequest,
    writer: Arc<Mutex<ChildStdin>>,
    sessions: Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_user_inputs: Arc<Mutex<HashMap<String, PendingUserInputState>>>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPermissionState>>>,
    pending_tool_calls: Arc<Mutex<HashMap<String, PendingToolCallState>>>,
) {
    let Some(request_id_value) = request.id.clone() else {
        return;
    };

    let result = match request.method.as_str() {
        "permission.request" => {
            handle_permission_request(
                &request_id_value,
                request.params.as_ref().unwrap_or(&Value::Null),
                &sessions,
                &pending_permissions,
            )
            .await
        }
        "userInput.request" => {
            handle_user_input_request(
                &request_id_value,
                request.params.as_ref().unwrap_or(&Value::Null),
                &sessions,
                &pending_user_inputs,
            )
            .await
        }
        "tool.call" => {
            handle_tool_call_request(
                &request_id_value,
                request.params.as_ref().unwrap_or(&Value::Null),
                &sessions,
                &pending_tool_calls,
            )
            .await
        }
        _ => Err(anyhow::anyhow!(
            "Unsupported Copilot SDK server request: {}",
            request.method
        )),
    };

    let response = match result {
        Ok(result) => json!({
            "jsonrpc": "2.0",
            "id": request_id_value,
            "result": result,
        }),
        Err(error) => json!({
            "jsonrpc": "2.0",
            "id": request_id_value,
            "error": {
                "code": -32000,
                "message": error.to_string(),
            },
        }),
    };

    let _ = write_framed_json(&writer, &response).await;
}

async fn handle_permission_request(
    request_id_value: &Value,
    params: &Value,
    sessions: &Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermissionState>>>,
) -> anyhow::Result<Value> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .context("Missing sessionId in permission.request")?;
    let Some(session) = sessions.read().await.get(session_id).cloned() else {
        return Ok(json!({ "kind": SDK_PERMISSION_DENIED }));
    };

    let request_id = rpc_id_string(request_id_value);
    let permission = params.get("permissionRequest").unwrap_or(params);
    let tool_call_id = permission
        .get("toolCallId")
        .or_else(|| params.get("toolCallId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let tool_name = permission
        .get("title")
        .or_else(|| permission.get("toolName"))
        .or_else(|| permission.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let tool_kind = permission
        .get("kind")
        .and_then(Value::as_str)
        .or_else(|| params.get("kind").and_then(Value::as_str))
        .map(str::to_owned);
    let question = params
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| tool_name.as_ref().map(|name| format!("Allow {name}?")))
        .or_else(|| tool_kind.as_ref().map(|kind| format!("Allow {kind}?")))
        .unwrap_or_else(|| "Copilot needs permission to continue.".to_string());
    let request = PendingPermissionRequest {
        request_id: request_id.clone(),
        session_id: session_id.to_string(),
        tool_call_id,
        tool_name,
        tool_kind,
        question,
        options: vec![
            PendingPermissionOption {
                option_id: SDK_PERMISSION_APPROVED.to_string(),
                label: "Allow".to_string(),
                kind: Some("allow-once".to_string()),
            },
            PendingPermissionOption {
                option_id: SDK_PERMISSION_DENIED.to_string(),
                label: "Deny".to_string(),
                kind: Some("deny".to_string()),
            },
        ],
        created_at: Utc::now().to_rfc3339(),
    };

    let (response_tx, response_rx) = oneshot::channel();
    pending_permissions.lock().await.insert(
        request_id.clone(),
        PendingPermissionState {
            request: request.clone(),
            response_tx: Some(response_tx),
        },
    );

    let _ = session.events.send(SessionEvent {
        id: format!("permission-request-{request_id}"),
        timestamp: Utc::now().to_rfc3339(),
        event_type: "sdk.permission_request".to_string(),
        data: serde_json::to_value(&request)?,
    });

    let decision = response_rx
        .await
        .unwrap_or_else(|_| SDK_PERMISSION_DENIED.to_string());

    Ok(json!({ "kind": decision }))
}

async fn handle_user_input_request(
    request_id_value: &Value,
    params: &Value,
    sessions: &Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_user_inputs: &Arc<Mutex<HashMap<String, PendingUserInputState>>>,
) -> anyhow::Result<Value> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .context("Missing sessionId in userInput.request")?;
    let Some(session) = sessions.read().await.get(session_id).cloned() else {
        anyhow::bail!("Session not found for userInput.request: {session_id}");
    };

    let request_id = rpc_id_string(request_id_value);
    let request = PendingUserInputRequest {
        request_id: request_id.clone(),
        session_id: session_id.to_string(),
        question: params
            .get("question")
            .and_then(Value::as_str)
            .or_else(|| params.get("prompt").and_then(Value::as_str))
            .unwrap_or("Copilot needs your input.")
            .to_string(),
        choices: params
            .get("choices")
            .and_then(Value::as_array)
            .map(|choices| {
                choices
                    .iter()
                    .filter_map(|choice| choice.as_str().map(str::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        allow_freeform: params
            .get("allowFreeform")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        created_at: Utc::now().to_rfc3339(),
    };

    let (response_tx, response_rx) = oneshot::channel();
    pending_user_inputs.lock().await.insert(
        request_id.clone(),
        PendingUserInputState {
            request: request.clone(),
            response_tx: Some(response_tx),
        },
    );

    let _ = session.events.send(SessionEvent {
        id: format!("user-input-request-{request_id}"),
        timestamp: Utc::now().to_rfc3339(),
        event_type: "sdk.user_input_request".to_string(),
        data: serde_json::to_value(&request)?,
    });

    let answer = response_rx.await.unwrap_or_default();
    Ok(json!({
        "answer": answer,
        "wasFreeform": true,
    }))
}

async fn handle_tool_call_request(
    request_id_value: &Value,
    params: &Value,
    sessions: &Arc<RwLock<HashMap<String, Arc<SessionRecord>>>>,
    pending_tool_calls: &Arc<Mutex<HashMap<String, PendingToolCallState>>>,
) -> anyhow::Result<Value> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .context("Missing sessionId in tool.call")?;
    let Some(session) = sessions.read().await.get(session_id).cloned() else {
        return Ok(json!({
            "result": tool_failure_result(
                format!("Unknown session {session_id}"),
                "The requested tool could not run because the session no longer exists.",
            )
        }));
    };
    let tool_call_id = params
        .get("toolCallId")
        .and_then(Value::as_str)
        .context("Missing toolCallId in tool.call")?;
    let tool_name = params
        .get("toolName")
        .and_then(Value::as_str)
        .context("Missing toolName in tool.call")?;
    let request_id = rpc_id_string(request_id_value);
    let request = PendingToolCallRequest {
        request_id: request_id.clone(),
        session_id: session_id.to_string(),
        tool_call_id: tool_call_id.to_string(),
        tool_name: tool_name.to_string(),
        arguments: params.get("arguments").cloned().unwrap_or(Value::Null),
        created_at: Utc::now().to_rfc3339(),
    };

    let (response_tx, response_rx) = oneshot::channel();
    pending_tool_calls.lock().await.insert(
        request_id.clone(),
        PendingToolCallState {
            request: request.clone(),
            response_tx: Some(response_tx),
        },
    );

    let _ = session.events.send(SessionEvent {
        id: format!("tool-call-request-{request_id}"),
        timestamp: Utc::now().to_rfc3339(),
        event_type: "sdk.tool_call_request".to_string(),
        data: serde_json::to_value(&request)?,
    });

    let result = match tokio::time::timeout(Duration::from_secs(60), response_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            pending_tool_calls.lock().await.remove(&request_id);
            tool_failure_result(
                "Tool result channel closed".to_string(),
                "The tool could not finish because the daemon stopped waiting for the result.",
            )
        }
        Err(_) => {
            pending_tool_calls.lock().await.remove(&request_id);
            tool_failure_result(
                format!("Tool '{tool_name}' timed out"),
                "The tool did not finish within the allowed time.",
            )
        }
    };

    Ok(json!({ "result": result }))
}

/// Controls which built-in Copilot tools are available for a session.
pub struct SessionToolPolicy {
    /// Specific tools to include (allowlist). `None` = all built-in tools.
    pub available_tools: Option<Vec<String>>,
    /// Specific tools to exclude (blocklist). Applied after `available_tools`.
    pub excluded_tools: Option<Vec<String>>,
}

fn build_session_config(
    cwd: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    tool_policy: Option<&SessionToolPolicy>,
) -> Value {
    let mut config = json!({
        "workingDirectory": cwd,
        "streaming": true,
        "requestPermission": true,
        "requestUserInput": true,
        "tools": build_canvas_tools(),
        "excludedTools": [],
    });
    if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
        config["model"] = json!(model);
    }
    if let Some(reasoning_effort) = reasoning_effort.filter(|value| !value.trim().is_empty()) {
        config["reasoningEffort"] = json!(reasoning_effort);
    }
    if let Some(policy) = tool_policy {
        if let Some(ref available) = policy.available_tools {
            config["availableTools"] = json!(available);
        }
        if let Some(ref excluded) = policy.excluded_tools {
            config["excludedTools"] = json!(excluded);
        }
    }
    config
}

fn build_resume_config(
    cwd: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    tool_policy: Option<&SessionToolPolicy>,
) -> Value {
    build_session_config(cwd, model, reasoning_effort, tool_policy)
}

async fn maybe_emit_v3_bridge_events(
    session: &Arc<SessionRecord>,
    session_id: &str,
    event: &SessionEvent,
    pending_user_inputs: &Arc<Mutex<HashMap<String, PendingUserInputState>>>,
    pending_permissions: &Arc<Mutex<HashMap<String, PendingPermissionState>>>,
    pending_tool_calls: &Arc<Mutex<HashMap<String, PendingToolCallState>>>,
) {
    match event.event_type.as_str() {
        "user_input.requested" | "elicitation.requested" => {
            let Some(request_id) = event.data.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let question = event
                .data
                .get("question")
                .or_else(|| event.data.get("prompt"))
                .or_else(|| event.data.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Copilot needs your input.")
                .to_string();
            let choices = event
                .data
                .get("choices")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let allow_freeform = event
                .data
                .get("allowFreeform")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let request = PendingUserInputRequest {
                request_id: request_id.to_string(),
                session_id: session_id.to_string(),
                question,
                choices,
                allow_freeform,
                created_at: event.timestamp.clone(),
            };
            pending_user_inputs.lock().await.insert(
                request_id.to_string(),
                PendingUserInputState {
                    request: request.clone(),
                    response_tx: None,
                },
            );
            let _ = session.events.send(SessionEvent {
                id: format!("user-input-request-{request_id}"),
                timestamp: event.timestamp.clone(),
                event_type: "sdk.user_input_request".to_string(),
                data: serde_json::to_value(request).unwrap_or(Value::Null),
            });
        }
        "permission.requested" => {
            let Some(request_id) = event.data.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let permission = event.data.get("permissionRequest").unwrap_or(&Value::Null);
            let tool_call_id = permission
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let tool_name = permission
                .get("toolName")
                .or_else(|| permission.get("toolTitle"))
                .or_else(|| permission.get("title"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let tool_kind = permission
                .get("kind")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let question = match permission.get("kind").and_then(Value::as_str) {
                Some("custom-tool") => tool_name
                    .as_ref()
                    .map(|name| format!("Allow {name}?"))
                    .unwrap_or_else(|| "Allow this tool?".to_string()),
                _ => event
                    .data
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| tool_name.as_ref().map(|name| format!("Allow {name}?")))
                    .unwrap_or_else(|| "Copilot needs permission to continue.".to_string()),
            };
            let request = PendingPermissionRequest {
                request_id: request_id.to_string(),
                session_id: session_id.to_string(),
                tool_call_id,
                tool_name,
                tool_kind,
                question,
                options: vec![
                    PendingPermissionOption {
                        option_id: SDK_PERMISSION_APPROVED.to_string(),
                        label: "Allow".to_string(),
                        kind: Some("allow-once".to_string()),
                    },
                    PendingPermissionOption {
                        option_id: SDK_PERMISSION_DENIED.to_string(),
                        label: "Deny".to_string(),
                        kind: Some("deny".to_string()),
                    },
                ],
                created_at: event.timestamp.clone(),
            };
            pending_permissions.lock().await.insert(
                request_id.to_string(),
                PendingPermissionState {
                    request: request.clone(),
                    response_tx: None,
                },
            );
            let _ = session.events.send(SessionEvent {
                id: format!("permission-request-{request_id}"),
                timestamp: event.timestamp.clone(),
                event_type: "sdk.permission_request".to_string(),
                data: serde_json::to_value(request).unwrap_or(Value::Null),
            });
        }
        "external_tool.requested" => {
            let Some(request_id) = event.data.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let Some(tool_call_id) = event.data.get("toolCallId").and_then(Value::as_str) else {
                return;
            };
            let Some(tool_name) = event.data.get("toolName").and_then(Value::as_str) else {
                return;
            };
            let request = PendingToolCallRequest {
                request_id: request_id.to_string(),
                session_id: session_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                tool_name: tool_name.to_string(),
                arguments: event.data.get("arguments").cloned().unwrap_or(Value::Null),
                created_at: event.timestamp.clone(),
            };
            pending_tool_calls.lock().await.insert(
                request_id.to_string(),
                PendingToolCallState {
                    request: request.clone(),
                    response_tx: None,
                },
            );
            let _ = session.events.send(SessionEvent {
                id: format!("tool-call-request-{request_id}"),
                timestamp: event.timestamp.clone(),
                event_type: "sdk.tool_call_request".to_string(),
                data: serde_json::to_value(request).unwrap_or(Value::Null),
            });
        }
        _ => {}
    }
}

fn build_canvas_tools() -> Value {
    json!([
        {
            "name": "canvas_create",
            "description": "Create a new canvas artifact for the current chat thread only and store its full content. Never refer to or reuse canvas IDs from other chat threads. For document or notes canvases, default to well-structured markdown unless the user explicitly asks for another format.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Human-friendly title for the new canvas." },
                    "kind": { "type": "string", "description": "Canvas type such as document, code, or notes. Use document or notes for markdown-style drafts and prose." },
                    "content": { "type": "string", "description": "Full initial content to store in the canvas. For document and notes canvases, prefer final markdown structure with headings, lists, emphasis, tables, and code fences when useful." },
                    "open": { "type": "boolean", "description": "Whether the UI should open the canvas after creation." }
                },
                "required": ["title", "content"]
            },
            "skipPermission": true
        },
        {
            "name": "canvas_update",
            "description": "Update an existing canvas artifact in the current chat thread only. Never refer to or reuse canvas IDs from other chat threads. Keep the canvas open after updates; use canvas_close separately only when the user explicitly wants it closed. When selectionReplace is true, content replaces ONLY the user-selected range and should match the surrounding document's structure and formatting; otherwise content replaces the entire document. For document or notes canvases, preserve and extend valid markdown unless the user explicitly requests another format.",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvasId": { "type": "string", "description": "ID of the canvas to update." },
                    "title": { "type": "string", "description": "Optional replacement title." },
                    "content": { "type": "string", "description": "Replacement text. If selectionReplace is true this should be only the replacement text for the selected range and should fit the surrounding document; otherwise it replaces the full document. For document and notes canvases, prefer markdown that preserves the surrounding structure." },
                    "selectionReplace": { "type": "boolean", "description": "When true, content replaces only the currently selected text range instead of the whole document." }
                },
                "required": ["content"]
            },
            "skipPermission": true
        },
        {
            "name": "canvas_list",
            "description": "List the canvases available in the current chat thread only. Canvases from other chat threads are not available here.",
            "parameters": {
                "type": "object",
                "properties": {}
            },
            "skipPermission": true
        },
        {
            "name": "canvas_open",
            "description": "Open an existing canvas from the current chat thread in the UI so the user can focus on it. Canvases from other chat threads cannot be opened here.",
            "parameters": {
                "type": "object",
                "properties": {
                    "canvasId": { "type": "string", "description": "ID of the canvas to open." }
                },
                "required": ["canvasId"]
            },
            "skipPermission": true
        },
        {
            "name": "canvas_close",
            "description": "Close the canvas pane in the UI for the current chat thread without deleting any saved canvas.",
            "parameters": {
                "type": "object",
                "properties": {}
            },
            "skipPermission": true
        }
    ])
}

fn tool_failure_result(error: String, text_result_for_llm: &str) -> Value {
    json!({
        "textResultForLlm": text_result_for_llm,
        "resultType": "failure",
        "error": error,
        "toolTelemetry": {},
    })
}

#[cfg(test)]
mod tests {
    use super::build_canvas_tools;

    #[test]
    fn canvas_tools_describe_thread_local_scope() {
        let tools = build_canvas_tools();
        let canvas_update_description = tools[1]["description"]
            .as_str()
            .expect("canvas_update description should be a string");
        let canvas_list_description = tools[2]["description"]
            .as_str()
            .expect("canvas_list description should be a string");
        let canvas_open_description = tools[3]["description"]
            .as_str()
            .expect("canvas_open description should be a string");

        assert!(canvas_update_description.contains("current chat thread only"));
        assert!(canvas_update_description.contains("other chat threads"));
        assert!(canvas_list_description.contains("other chat threads are not available"));
        assert!(canvas_open_description.contains("other chat threads cannot be opened"));
    }
}

fn permission_result_from_option_id(option_id: &str) -> Value {
    if option_id == SDK_PERMISSION_APPROVED {
        json!({ "kind": "approved" })
    } else {
        json!({ "kind": "denied-no-approval-rule-and-could-not-request-from-user" })
    }
}

fn classify_message(value: Value) -> Option<IncomingMessage> {
    let has_id = value.get("id").is_some();
    let has_method = value.get("method").is_some();
    let has_result_or_error = value.get("result").is_some() || value.get("error").is_some();

    if has_id && has_method && !has_result_or_error {
        serde_json::from_value::<JsonRpcRequest>(value)
            .ok()
            .map(IncomingMessage::Request)
    } else if has_id && has_result_or_error {
        serde_json::from_value::<JsonRpcResponse>(value)
            .ok()
            .map(IncomingMessage::Response)
    } else if has_method {
        serde_json::from_value::<JsonRpcRequest>(value)
            .ok()
            .map(IncomingMessage::Notification)
    } else {
        None
    }
}

async fn read_framed_message(reader: &mut BufReader<ChildStdout>) -> anyhow::Result<String> {
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            anyhow::bail!("Copilot SDK connection closed")
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = Some(value.trim().parse()?);
        }
    }

    let content_length = content_length.context("Copilot SDK message missing Content-Length")?;
    let mut buffer = vec![0u8; content_length];
    reader.read_exact(&mut buffer).await?;
    Ok(String::from_utf8(buffer)?)
}

async fn write_framed_json(writer: &Arc<Mutex<ChildStdin>>, value: &Value) -> anyhow::Result<()> {
    let payload = serde_json::to_string(value)?;
    let frame = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
    let mut writer = writer.lock().await;
    writer.write_all(frame.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

fn rpc_id_string(id: &Value) -> String {
    if let Some(value) = id.as_str() {
        value.to_string()
    } else if let Some(value) = id.as_u64() {
        value.to_string()
    } else if let Some(value) = id.as_i64() {
        value.to_string()
    } else {
        id.to_string()
    }
}

fn replay_messages_from_events(events: &[SessionEvent]) -> Vec<ReplayedMessage> {
    let mut messages = Vec::new();
    let mut current_assistant_text = String::new();
    let mut current_tool_calls = Vec::new();
    let mut saw_tool_activity = false;
    let mut last_role: Option<&str> = None;

    for event in events {
        match event.event_type.as_str() {
            "user.message" => {
                flush_replayed_assistant(
                    &mut messages,
                    &mut current_assistant_text,
                    &mut current_tool_calls,
                    &mut saw_tool_activity,
                    &mut last_role,
                );
                if let Some(content) = event.data.get("content").and_then(Value::as_str) {
                    messages.push(ReplayedMessage {
                        role: "user".to_string(),
                        content: content.to_string(),
                        tool_calls: None,
                    });
                }
                last_role = Some("user");
            }
            "assistant.message" => {
                if last_role == Some("user")
                    || (last_role == Some("assistant")
                        && saw_tool_activity
                        && (!current_assistant_text.is_empty() || !current_tool_calls.is_empty()))
                {
                    flush_replayed_assistant(
                        &mut messages,
                        &mut current_assistant_text,
                        &mut current_tool_calls,
                        &mut saw_tool_activity,
                        &mut last_role,
                    );
                }
                if let Some(content) = event.data.get("content").and_then(Value::as_str) {
                    current_assistant_text.push_str(content);
                }
                if let Some(tool_requests) =
                    event.data.get("toolRequests").and_then(Value::as_array)
                {
                    for tool_request in tool_requests {
                        upsert_tool_call(
                            &mut current_tool_calls,
                            json!({
                                "id": tool_request.get("toolCallId"),
                                "name": tool_request.get("name"),
                                "arguments": tool_request.get("arguments"),
                                "status": "running",
                            }),
                        );
                    }
                }
                last_role = Some("assistant");
            }
            "tool.user_requested" => {
                upsert_tool_call(
                    &mut current_tool_calls,
                    json!({
                        "id": event.data.get("toolCallId"),
                        "name": event.data.get("toolName"),
                        "arguments": event.data.get("arguments"),
                        "status": "running",
                    }),
                );
                saw_tool_activity = true;
                last_role = Some("assistant");
            }
            "tool.execution_start" => {
                upsert_tool_call(
                    &mut current_tool_calls,
                    json!({
                        "id": event.data.get("toolCallId"),
                        "name": event.data.get("toolName"),
                        "arguments": event.data.get("arguments"),
                        "status": "running",
                    }),
                );
                saw_tool_activity = true;
                last_role = Some("assistant");
            }
            "tool.execution_progress" => {
                upsert_tool_call(
                    &mut current_tool_calls,
                    json!({
                        "id": event.data.get("toolCallId"),
                        "status": "running",
                        "additionalContext": event.data.get("progressMessage"),
                    }),
                );
                saw_tool_activity = true;
                last_role = Some("assistant");
            }
            "tool.execution_partial_result" => {
                upsert_tool_call(
                    &mut current_tool_calls,
                    json!({
                        "id": event.data.get("toolCallId"),
                        "status": "running",
                        "result": event.data.get("partialOutput"),
                    }),
                );
                saw_tool_activity = true;
                last_role = Some("assistant");
            }
            "tool.execution_complete" => {
                let success = event
                    .data
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                upsert_tool_call(
                    &mut current_tool_calls,
                    json!({
                        "id": event.data.get("toolCallId"),
                        "status": if success { "completed" } else { "failed" },
                        "result": event.data.get("result").and_then(|result| result.get("content")).cloned(),
                        "error": event.data.get("error").and_then(|error| error.get("message")).cloned(),
                    }),
                );
                saw_tool_activity = true;
                last_role = Some("assistant");
            }
            _ => {}
        }
    }

    flush_replayed_assistant(
        &mut messages,
        &mut current_assistant_text,
        &mut current_tool_calls,
        &mut saw_tool_activity,
        &mut last_role,
    );
    messages
}

fn flush_replayed_assistant(
    messages: &mut Vec<ReplayedMessage>,
    current_assistant_text: &mut String,
    current_tool_calls: &mut Vec<Value>,
    saw_tool_activity: &mut bool,
    last_role: &mut Option<&str>,
) {
    if current_assistant_text.is_empty() && current_tool_calls.is_empty() {
        *saw_tool_activity = false;
        *last_role = None;
        return;
    }
    let tool_calls = if current_tool_calls.is_empty() {
        None
    } else {
        Some(std::mem::take(current_tool_calls))
    };
    messages.push(ReplayedMessage {
        role: "assistant".to_string(),
        content: std::mem::take(current_assistant_text),
        tool_calls,
    });
    *saw_tool_activity = false;
    *last_role = None;
}

fn upsert_tool_call(current_tool_calls: &mut Vec<Value>, next_tool_call: Value) {
    let next_id = next_tool_call
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_owned);

    if let Some(next_id) = next_id {
        if let Some(existing) = current_tool_calls.iter_mut().find(|tool_call| {
            tool_call
                .get("id")
                .and_then(Value::as_str)
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
