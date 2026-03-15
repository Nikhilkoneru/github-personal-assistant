use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum::{Json, Router};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::thread_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/stream", post(stream_chat))
        .route("/api/chat/abort", post(abort_chat))
        .route("/api/chat/user-input", post(user_input))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamInput {
    thread_id: String,
    prompt: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    attachments: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbortInput {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserInputInput {
    thread_id: String,
    request_id: String,
    answer: String,
}

async fn abort_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AbortInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &body.thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    if let Some(ref sid) = thread.copilot_session_id {
        if let Ok(conn) = state.copilot.get_or_create_connection().await {
            let _ = conn.cancel_session(sid).await;
        }
    }

    Ok(Json(json!({ "aborted": true })))
}

async fn user_input(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(_body): Json<UserInputInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config)?;
    // TODO: implement user input response via ACP
    Ok(Json(json!({ "accepted": true })))
}

async fn stream_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChatStreamInput>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &body.thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    let prompt = body.prompt.trim().to_string();
    if prompt.is_empty() || prompt.len() > 8000 {
        return Err(AppError::BadRequest("Prompt must be 1-8000 characters.".into()));
    }

    let model = body.model.as_deref().unwrap_or(&thread.model).to_string();
    let reasoning_effort = body.reasoning_effort.clone().or(thread.reasoning_effort.clone());

    // Determine ACP session ID
    let session_id = thread
        .copilot_session_id
        .clone()
        .unwrap_or_else(|| format!("thread-{}", thread.id));

    // Update thread metadata
    let title_preview = if prompt.len() > 42 {
        format!("{}...", &prompt[..42])
    } else {
        prompt.clone()
    };
    thread_store::rename_thread_if_placeholder(&state.db, &thread.id, &title_preview);
    thread_store::update_thread(
        &state.db,
        &session.user_id,
        &thread.id,
        None,
        Some(&model),
        reasoning_effort.as_ref().map(|r| Some(r.as_str())),
    );
    thread_store::update_thread_session(&state.db, &thread.id, &session_id);
    thread_store::update_thread_preview(&state.db, &thread.id, &prompt);

    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(256);
    let state_clone = state.clone();
    let thread_id = thread.id.clone();

    tokio::spawn(async move {
        // Send session event
        let _ = tx.send(Ok(make_event(&json!({ "type": "session", "sessionId": session_id })))).await;

        // Connect to Copilot ACP
        let conn = match state_clone.copilot.get_or_create_connection().await {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": format!("Copilot connection failed: {e}") })))).await;
                let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                return;
            }
        };

        // Create or load session
        let acp_session_id = if thread.copilot_session_id.is_some() {
            // Try loading existing session
            match conn.load_session(&session_id).await {
                Ok(_) => session_id.clone(),
                Err(_) => {
                    // Fall back to new session
                    match conn.new_session().await {
                        Ok(id) => {
                            thread_store::update_thread_session(&state_clone.db, &thread_id, &id);
                            id
                        }
                        Err(e) => {
                            let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to create session: {e}") })))).await;
                            let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                            return;
                        }
                    }
                }
            }
        } else {
            match conn.new_session().await {
                Ok(id) => {
                    thread_store::update_thread_session(&state_clone.db, &thread_id, &id);
                    let _ = tx.send(Ok(make_event(&json!({ "type": "session", "sessionId": id })))).await;
                    id
                }
                Err(e) => {
                    let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to create session: {e}") })))).await;
                    let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                    return;
                }
            }
        };

        // Build prompt content blocks
        let content = vec![json!({ "type": "text", "text": prompt })];

        // Send prompt via ACP and get result receiver
        let result_rx = match conn.send_prompt_streaming(&acp_session_id, content).await {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to send prompt: {e}") })))).await;
                let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                return;
            }
        };

        // Wait for the result, periodically draining notifications for SSE events
        let mut streamed_content = String::new();
        let timeout = tokio::time::sleep(Duration::from_secs(600));
        tokio::pin!(timeout);
        tokio::pin!(result_rx);

        loop {
            tokio::select! {
                result = &mut result_rx => {
                    // Drain any remaining notifications
                    for notif in conn.drain_notifications().await {
                        process_notification(&notif, &tx, &mut streamed_content).await;
                    }
                    match result {
                        Ok(resp) => {
                            if let Some(ref err) = resp.error {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": err.message })))).await;
                            }
                            let stop_reason = resp.result.as_ref()
                                .and_then(|r| r.get("stopReason"))
                                .and_then(|v| v.as_str());
                            if stop_reason == Some("cancelled") {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "aborted", "message": "Response stopped." })))).await;
                            } else {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                            }
                        }
                        Err(_) => {
                            let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": "Connection lost." })))).await;
                        }
                    }
                    break;
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    // Drain notifications and forward as SSE events
                    for notif in conn.drain_notifications().await {
                        process_notification(&notif, &tx, &mut streamed_content).await;
                    }
                }
                _ = &mut timeout => {
                    let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": "Prompt timed out." })))).await;
                    break;
                }
            }
        }

        // Update preview with streamed content
        if !streamed_content.is_empty() {
            thread_store::update_thread_preview(&state_clone.db, &thread_id, &streamed_content);
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

fn make_event(data: &serde_json::Value) -> Event {
    Event::default().data(serde_json::to_string(data).unwrap_or_default())
}

async fn process_notification(
    notif: &crate::copilot::types::JsonRpcNotification,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    streamed_content: &mut String,
) {
    if notif.method != "session/update" {
        tracing::info!("ACP non-update notification: method={} params={}", notif.method, serde_json::to_string(&notif.params).unwrap_or_default());
        return;
    }

    let Some(ref params) = notif.params else { return };
    let Some(update) = params.get("update") else { return };
    let update_type = update.get("sessionUpdate").and_then(|v| v.as_str()).unwrap_or("");
    tracing::info!("ACP session/update: type={update_type} status={}", 
        update.get("status").and_then(|v| v.as_str()).unwrap_or("n/a"));

    match update_type {
        "agent_message_chunk" | "message" => {
            // Text content from the agent
            if let Some(content) = update.get("content") {
                if content.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                        streamed_content.push_str(text);
                        let _ = tx.send(Ok(make_event(&json!({ "type": "chunk", "delta": text })))).await;
                    }
                }
            }
            // Array-style content
            if let Some(content_arr) = update.get("content").and_then(|c| c.as_array()) {
                for block in content_arr {
                    if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                            streamed_content.push_str(text);
                            let _ = tx.send(Ok(make_event(&json!({ "type": "chunk", "delta": text })))).await;
                        }
                    }
                }
            }
        }
        "reasoning" | "agent_reasoning_chunk" | "agent_thought_chunk" => {
            if let Some(content) = update.get("content") {
                if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                    let _ = tx.send(Ok(make_event(&json!({ "type": "reasoning_delta", "delta": text })))).await;
                }
            }
            if let Some(content) = update.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        let _ = tx.send(Ok(make_event(&json!({ "type": "reasoning_delta", "delta": text })))).await;
                    }
                }
            }
        }
        "tool_call" => {
            tracing::info!("ACP tool_call raw: {}", serde_json::to_string(update).unwrap_or_default());
            // Copilot uses: toolCallId, title, kind, locations, rawInput, status
            let id = update.get("toolCallId").and_then(|v| v.as_str())
                .or_else(|| update.get("id").and_then(|v| v.as_str()))
                .unwrap_or("unknown");
            let name = update.get("title").and_then(|v| v.as_str())
                .or_else(|| update.get("name").and_then(|v| v.as_str()))
                .unwrap_or("Tool");
            let kind = update.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("running");
            let now = chrono::Utc::now().to_rfc3339();

            let mapped_status = match status {
                "completed" | "done" => "completed",
                "failed" | "error" => "failed",
                _ => "running",
            };

            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": id,
                    "toolName": name,
                    "kind": kind,
                    "status": mapped_status,
                    "startedAt": now,
                    "updatedAt": now,
                    "arguments": update.get("rawInput").or(update.get("arguments")).map(|v| v.to_string()),
                    "locations": update.get("locations"),
                }
            })))).await;
        }
        "tool_call_update" | "tool_result" => {
            let id = update.get("toolCallId").and_then(|v| v.as_str())
                .or_else(|| update.get("id").and_then(|v| v.as_str()))
                .unwrap_or("unknown");
            let status = update.get("status").and_then(|v| v.as_str()).unwrap_or("running");
            let now = chrono::Utc::now().to_rfc3339();
            let mapped_status = match status {
                "completed" | "done" => "completed",
                "failed" | "error" => "failed",
                _ => "running",
            };
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": id,
                    "toolName": update.get("title").or(update.get("name")).and_then(|v| v.as_str()).unwrap_or("Tool"),
                    "status": mapped_status,
                    "startedAt": now,
                    "updatedAt": now,
                    "result": update.get("content").map(|v| v.to_string()),
                }
            })))).await;
        }
        "plan" | "agent_plan" => {
            tracing::debug!("ACP plan update received: {}", serde_json::to_string(update).unwrap_or_default());
        }
        _ => {
            tracing::warn!("Unknown ACP session update type: {update_type} | raw: {}", serde_json::to_string(update).unwrap_or_default());
        }
    }
}
