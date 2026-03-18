use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine as _;
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::{attachment_store, preferences_store, thread_store, workspace_store};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/chat/stream", post(stream_chat))
        .route("/api/chat/abort", post(abort_chat))
        .route("/api/chat/user-input", post(user_input))
        .route("/api/chat/permission", post(permission_response))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamInput {
    thread_id: String,
    prompt: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    attachments: Option<Vec<String>>,
    canvas: Option<CanvasPromptContext>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasSelectionInput {
    start: usize,
    end: usize,
    text: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasPromptContext {
    mode: String,
    canvas_id: Option<String>,
    title: Option<String>,
    kind: Option<String>,
    current_content: Option<String>,
    selection: Option<CanvasSelectionInput>,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionInput {
    thread_id: String,
    request_id: String,
    option_id: String,
}

async fn abort_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AbortInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let thread = thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
        .await?
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
    Json(body): Json<UserInputInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let thread = thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;
    let session_id = thread.copilot_session_id.ok_or_else(|| {
        AppError::BadRequest("This thread does not have an active Copilot session.".into())
    })?;

    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|error| AppError::Internal(format!("Copilot connection failed: {error}")))?;

    let pending = conn
        .get_pending_user_input(&body.request_id)
        .await
        .ok_or_else(|| {
            AppError::NotFound("That Copilot input request is no longer pending.".into())
        })?;
    if pending.session_id != session_id {
        return Err(AppError::BadRequest(
            "That Copilot input request does not belong to this thread.".into(),
        ));
    }

    conn.respond_to_user_input(&body.request_id, body.answer.trim())
        .await
        .map_err(|error| AppError::Internal(format!("Failed to send Copilot input: {error}")))?;

    Ok(Json(json!({ "accepted": true })))
}

async fn permission_response(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PermissionInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let thread = thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;
    let session_id = thread.copilot_session_id.ok_or_else(|| {
        AppError::BadRequest("This thread does not have an active Copilot session.".into())
    })?;

    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|error| AppError::Internal(format!("Copilot connection failed: {error}")))?;

    let pending = conn
        .get_pending_permission(&body.request_id)
        .await
        .ok_or_else(|| {
            AppError::NotFound("That Copilot permission request is no longer pending.".into())
        })?;
    if pending.session_id != session_id {
        return Err(AppError::BadRequest(
            "That Copilot permission request does not belong to this thread.".into(),
        ));
    }

    conn.respond_to_permission_request(&body.request_id, &body.option_id)
        .await
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to send Copilot permission decision: {error}"
            ))
        })?;

    Ok(Json(json!({ "accepted": true })))
}

async fn stream_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChatStreamInput>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let thread = thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    let prompt = body.prompt.trim().to_string();
    if prompt.is_empty() || prompt.len() > 8000 {
        return Err(AppError::BadRequest(
            "Prompt must be 1-8000 characters.".into(),
        ));
    }

    let attachment_ids = body.attachments.unwrap_or_default();
    let attachments = attachment_store::get_attachments_by_ids(
        &state.db,
        &session.user_id,
        Some(&thread.id),
        &attachment_ids,
    )
    .await?;
    if attachments.len() != attachment_ids.len() {
        return Err(AppError::BadRequest(
            "One or more attachments could not be loaded for this thread.".into(),
        ));
    }

    let model = body.model.as_deref().unwrap_or(&thread.model).to_string();
    let reasoning_effort = body
        .reasoning_effort
        .clone()
        .or(thread.reasoning_effort.clone());

    let title_preview = if prompt.len() > 42 {
        format!("{}...", &prompt[..42])
    } else {
        prompt.clone()
    };
    thread_store::rename_thread_if_placeholder(&state.db, &thread.id, &title_preview).await?;
    thread_store::update_thread(
        &state.db,
        &state.config,
        &session.user_id,
        &thread.id,
        None,
        Some(&model),
        reasoning_effort.as_ref().map(|r| Some(r.as_str())),
    )
    .await?;
    thread_store::update_thread_preview(&state.db, &thread.id, &prompt).await?;

    let prompt_content = build_prompt_content(&prompt, &attachments, body.canvas.as_ref())?;

    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(256);
    let state_clone = state.clone();
    let thread_id = thread.id.clone();
    let workspace_path = workspace_store::ensure_runtime_workspace_directory(
        &state.config,
        &thread.workspace_path,
    )
    .map_err(|error| AppError::BadRequest(error.to_string()))?;

    tokio::spawn(async move {
        let conn = match state_clone.copilot.get_or_create_connection().await {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "error", "message": format!("Copilot connection failed: {e}") }))))
                    .await;
                let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                return;
            }
        };

        let (acp_session_id, session_was_resumed) = if let Some(ref existing_id) =
            thread.copilot_session_id
        {
            if conn.is_alive().await {
                let _ = tx
                    .send(Ok(make_event(
                        &json!({ "type": "session", "sessionId": existing_id }),
                    )))
                    .await;
                (existing_id.clone(), true)
            } else {
                match conn.new_session(&workspace_path).await {
                    Ok(id) => {
                        let _ = thread_store::update_thread_session(&state_clone.db, &thread_id, &id).await;
                        let _ = tx
                            .send(Ok(make_event(
                                &json!({ "type": "session", "sessionId": id }),
                            )))
                            .await;
                        (id, false)
                    }
                    Err(e) => {
                        let _ = tx
                            .send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to create session: {e}") }))))
                            .await;
                        let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                        return;
                    }
                }
            }
        } else {
            match conn.new_session(&workspace_path).await {
                Ok(id) => {
                    let _ = thread_store::update_thread_session(&state_clone.db, &thread_id, &id).await;
                    let _ = tx
                        .send(Ok(make_event(
                            &json!({ "type": "session", "sessionId": id }),
                        )))
                        .await;
                    (id, false)
                }
                Err(e) => {
                    let _ = tx
                        .send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to create session: {e}") }))))
                        .await;
                    let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                    return;
                }
            }
        };

        let result_rx = match conn
            .send_prompt_streaming(&acp_session_id, prompt_content)
            .await
        {
            Ok(rx) => rx,
            Err(e) => {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to send prompt: {e}") }))))
                    .await;
                let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                return;
            }
        };
        if !attachment_ids.is_empty() {
            match next_user_message_index(
                &conn,
                &acp_session_id,
                &workspace_path,
                !session_was_resumed,
            )
            .await
            {
                Some(user_message_index) => {
                    if let Err(error) = attachment_store::save_message_attachments(
                        &state_clone.db,
                        &thread_id,
                        user_message_index,
                        &attachment_ids,
                    )
                    .await
                    {
                        tracing::warn!(
                            "Failed to persist attachment mapping for thread {}: {}",
                            thread_id,
                            error
                        );
                    }
                }
                None => {
                    tracing::warn!(
                        "Could not determine the next user message index for thread {}; attachments will not be replayed.",
                        thread_id
                    );
                }
            }
        }

        let mut streamed_content = String::new();
        let mut streamed_reasoning = String::new();
        let timeout = tokio::time::sleep(Duration::from_secs(600));
        tokio::pin!(timeout);
        tokio::pin!(result_rx);

        loop {
            tokio::select! {
                result = &mut result_rx => {
                    for notif in conn.drain_notifications().await {
                        process_notification(
                            &notif,
                            &tx,
                            &mut streamed_content,
                            &mut streamed_reasoning,
                            &state_clone,
                            &conn,
                            &acp_session_id,
                        ).await;
                    }
                    match result {
                        Ok(resp) => {
                            if let Some(ref err) = resp.error {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": err.message })))).await;
                            }
                            if !streamed_reasoning.is_empty() {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "reasoning", "content": streamed_reasoning })))).await;
                            }
                            if let Some(usage) = extract_usage(resp.result.as_ref(), &model) {
                                let _ = tx.send(Ok(make_event(&json!({ "type": "usage", "usage": usage })))).await;
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
                    for notif in conn.drain_notifications().await {
                        process_notification(
                            &notif,
                            &tx,
                            &mut streamed_content,
                            &mut streamed_reasoning,
                            &state_clone,
                            &conn,
                            &acp_session_id,
                        ).await;
                    }
                }
                _ = &mut timeout => {
                    let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": "Prompt timed out." })))).await;
                    break;
                }
            }
        }

        if !streamed_content.is_empty() {
            let _ =
                thread_store::update_thread_preview(&state_clone.db, &thread_id, &streamed_content)
                    .await;
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

fn build_prompt_content(
    prompt: &str,
    attachments: &[attachment_store::AttachmentRecord],
    canvas: Option<&CanvasPromptContext>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let canvas_prompt = build_canvas_prompt(prompt, canvas);
    let mut content = vec![json!({ "type": "text", "text": canvas_prompt })];

    for attachment in attachments {
        let bytes = std::fs::read(&attachment.file_path).map_err(|error| {
            AppError::Internal(format!(
                "Failed to read attachment '{}': {error}",
                attachment.name
            ))
        })?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let resource_uri = format!("file:///attachment/{}", attachment.name);
        let block = if attachment.mime_type.starts_with("image/") {
            json!({
                "type": "image",
                "mimeType": attachment.mime_type,
                "data": encoded,
            })
        } else if attachment.mime_type.starts_with("audio/") {
            json!({
                "type": "audio",
                "mimeType": attachment.mime_type,
                "data": encoded,
            })
        } else if let Ok(text) = std::str::from_utf8(&bytes) {
            json!({
                "type": "resource",
                "resource": {
                    "uri": resource_uri,
                    "mimeType": attachment.mime_type,
                    "text": text,
                }
            })
        } else {
            json!({
                "type": "resource",
                "resource": {
                    "uri": resource_uri,
                    "mimeType": attachment.mime_type,
                    "blob": encoded,
                }
            })
        };
        content.push(block);
    }

    Ok(content)
}

fn build_canvas_prompt(prompt: &str, canvas: Option<&CanvasPromptContext>) -> String {
    let Some(canvas) = canvas else {
        return prompt.to_string();
    };

    let title = canvas.title.as_deref().unwrap_or("Untitled canvas");
    let kind = canvas.kind.as_deref().unwrap_or("document");
    let current_content = canvas.current_content.as_deref().unwrap_or("");
    let identifier = canvas
        .canvas_id
        .as_deref()
        .map(|canvas_id| format!(" (id: {canvas_id})"))
        .unwrap_or_default();

    match canvas.mode.as_str() {
        "create" => format!(
            "You are creating content for a {kind} canvas titled \"{title}\"{identifier}.\n\
Return only the canvas content. Do not add commentary, prefaces, or markdown fences unless the content itself requires them.\n\n\
User request:\n{prompt}"
        ),
        "update" => {
            if let Some(selection) = canvas.selection.as_ref() {
                format!(
                    "You are editing the selected portion of a {kind} canvas titled \"{title}\"{identifier}.\n\
Current canvas content:\n<<<CANVAS\n{current_content}\nCANVAS\n\n\
Selected range: {start}-{end}\n\
Selected text:\n<<<SELECTION\n{selection_text}\nSELECTION\n\n\
User request:\n{prompt}\n\n\
Return only the replacement text for the selected range. Do not add commentary or markdown fences.",
                    start = selection.start,
                    end = selection.end,
                    selection_text = selection.text
                )
            } else {
                format!(
                    "You are revising a {kind} canvas titled \"{title}\"{identifier}.\n\
Current canvas content:\n<<<CANVAS\n{current_content}\nCANVAS\n\n\
User request:\n{prompt}\n\n\
Return the full updated canvas content only. Do not add commentary or markdown fences."
                )
            }
        }
        "chat" => {
            if let Some(selection) = canvas.selection.as_ref() {
                format!(
                    "{prompt}\n\n\
Additional context from the currently open canvas titled \"{title}\" ({kind}){identifier}:\n\
Selected range: {start}-{end}\n\
Selected text:\n<<<SELECTION\n{selection_text}\nSELECTION\n\n\
Use that as context, but answer normally in chat.",
                    start = selection.start,
                    end = selection.end,
                    selection_text = selection.text
                )
            } else if current_content.is_empty() {
                prompt.to_string()
            } else {
                format!(
                    "{prompt}\n\n\
Additional context from the currently open canvas titled \"{title}\" ({kind}){identifier}:\n\
<<<CANVAS\n{current_content}\nCANVAS\n\n\
Use that as context, but answer normally in chat."
                )
            }
        }
        _ => prompt.to_string(),
    }
}

fn make_event(data: &serde_json::Value) -> Event {
    Event::default().data(serde_json::to_string(data).unwrap_or_default())
}

async fn next_user_message_index(
    conn: &crate::copilot::acp_client::AcpConnection,
    session_id: &str,
    workspace_path: &str,
    assume_empty: bool,
) -> Option<usize> {
    if assume_empty {
        return Some(0);
    }

    let capabilities = conn.get_capabilities().await;
    if !capabilities.load_session {
        return None;
    }

    let replayed_messages = conn
        .load_session_messages(session_id, workspace_path)
        .await
        .ok()?;
    Some(
        replayed_messages
            .iter()
            .filter(|message| message.role == "user")
            .count(),
    )
}

async fn process_notification(
    notif: &crate::copilot::types::JsonRpcNotification,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    streamed_content: &mut String,
    streamed_reasoning: &mut String,
    state: &AppState,
    conn: &crate::copilot::acp_client::AcpConnection,
    session_id: &str,
) {
    if notif.method.starts_with("_server_request/") {
        process_server_request_notification(notif, tx, state, conn, session_id).await;
        return;
    }

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
        "agent_message_chunk" | "message" | "agent_message" => {
            for text in extract_text_fragments(update.get("content")) {
                streamed_content.push_str(&text);
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "chunk", "delta": text }))))
                    .await;
            }
        }
        "reasoning" | "agent_reasoning_chunk" | "agent_thought_chunk" => {
            for text in extract_text_fragments(update.get("content")) {
                streamed_reasoning.push_str(&text);
                let _ = tx
                    .send(Ok(make_event(
                        &json!({ "type": "reasoning_delta", "delta": text }),
                    )))
                    .await;
            }
        }
        "tool_call" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .or_else(|| update.get("id").and_then(|v| v.as_str()))
                .unwrap_or("unknown");
            let name = update
                .get("title")
                .and_then(|v| v.as_str())
                .or_else(|| update.get("name").and_then(|v| v.as_str()))
                .unwrap_or("Tool");
            let kind = update.get("kind").and_then(|v| v.as_str());
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("running");
            let now = chrono::Utc::now().to_rfc3339();

            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": id,
                    "toolName": name,
                    "kind": kind,
                    "status": map_tool_status(status),
                    "startedAt": now,
                    "updatedAt": now,
                    "arguments": update.get("rawInput").or(update.get("arguments")).map(|v| v.to_string()),
                    "locations": extract_locations(update.get("locations")),
                }
            })))).await;
        }
        "tool_call_update" | "tool_result" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .or_else(|| update.get("id").and_then(|v| v.as_str()))
                .unwrap_or("unknown");
            let now = chrono::Utc::now().to_rfc3339();
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": id,
                    "toolName": update.get("title").or(update.get("name")).and_then(|v| v.as_str()).unwrap_or("Tool"),
                    "status": map_tool_status(update.get("status").and_then(|v| v.as_str()).unwrap_or("running")),
                    "startedAt": now,
                    "updatedAt": now,
                    "arguments": update.get("rawInput").or(update.get("arguments")).map(|v| v.to_string()),
                    "result": update.get("content").or(update.get("result")).map(|v| v.to_string()),
                    "additionalContext": extract_progress_message(update),
                    "error": update.get("error").map(|v| v.to_string()),
                }
            })))).await;
        }
        "plan" | "agent_plan" => {
            let items = extract_plan_items(update);
            if !items.is_empty() {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "plan", "items": items }))))
                    .await;
            }
        }
        "status_update" | "status" | "agent_status" => {
            if let Some(phase) = extract_status_text(update) {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "status", "phase": phase }))))
                    .await;
            }
        }
        _ => {}
    }
}

async fn process_server_request_notification(
    notif: &crate::copilot::types::JsonRpcNotification,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    state: &AppState,
    conn: &crate::copilot::acp_client::AcpConnection,
    session_id: &str,
) {
    let Some(params) = notif.params.as_ref() else {
        return;
    };
    let Some(request_id) = params.get("requestId").and_then(|value| value.as_str()) else {
        return;
    };

    match notif.method.as_str() {
        "_server_request/session/userInput" => {
            if let Some(request) = conn.get_pending_user_input(request_id).await {
                let _ = tx
                    .send(Ok(make_event(
                        &json!({ "type": "user_input_request", "request": request }),
                    )))
                    .await;
            }
        }
        "_server_request/session/requestPermission"
        | "_server_request/session/request_permission"
        | "_server_request/session/request" => {
            if let Some(request) = conn.get_pending_permission(request_id).await {
                let approval_mode = match preferences_store::get_preferences(&state.db, &state.config).await {
                    Ok(prefs) => prefs.approval_mode,
                    Err(error) => {
                        let _ = tx.send(Ok(make_event(&json!({
                            "type": "error",
                            "message": format!("Failed to load approval preferences: {error}")
                        })))).await;
                        return;
                    }
                };
                if let Some((option_id, decision, reason)) =
                    auto_decide_permission(&request, &approval_mode)
                {
                    match conn
                        .respond_to_permission_request(request_id, &option_id)
                        .await
                    {
                        Ok(()) => {
                            let now = chrono::Utc::now().to_rfc3339();
                            let _ = tx.send(Ok(make_event(&json!({
                                "type": "tool_event",
                                "activity": {
                                    "id": request.tool_call_id.clone().unwrap_or_else(|| request.request_id.clone()),
                                    "toolName": request.tool_name.clone().unwrap_or_else(|| "Tool".to_string()),
                                    "kind": request.tool_kind,
                                    "status": "running",
                                    "startedAt": request.created_at,
                                    "updatedAt": now,
                                    "permissionDecision": decision,
                                    "permissionDecisionReason": reason,
                                }
                            })))).await;
                            let _ = tx.send(Ok(make_event(&json!({ "type": "permission_cleared", "requestId": request_id })))).await;
                        }
                        Err(error) => {
                            let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to respond to Copilot permission request: {error}") })))).await;
                        }
                    }
                } else if request.session_id == session_id {
                    let _ = tx
                        .send(Ok(make_event(
                            &json!({ "type": "permission_request", "request": request }),
                        )))
                        .await;
                }
            }
        }
        _ => {}
    }
}

fn auto_decide_permission(
    request: &crate::copilot::acp_client::PendingPermissionRequest,
    approval_mode: &str,
) -> Option<(String, &'static str, String)> {
    if approval_mode == "approve-all" {
        let option = preferred_allow_option(&request.options)?;
        return Some((
            option.option_id.clone(),
            "allow",
            "Approved automatically by the daemon approval setting.".to_string(),
        ));
    }

    if approval_mode != "safer-defaults" {
        return None;
    }

    let kind = request
        .tool_kind
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_read_only = matches!(
        kind.as_str(),
        "read" | "search" | "find" | "list" | "lookup" | "open"
    );
    let is_destructive = matches!(
        kind.as_str(),
        "write" | "edit" | "delete" | "execute" | "shell" | "command" | "terminal"
    );

    if is_read_only {
        let option = safe_allow_option(&request.options)?;
        return Some((
            option.option_id.clone(),
            "allow",
            "Allowed automatically by safer-defaults because this looks read-only.".to_string(),
        ));
    }

    if is_destructive {
        let option = preferred_deny_option(&request.options)?;
        return Some((
            option.option_id.clone(),
            "deny",
            "Denied automatically by safer-defaults because this looks write-capable.".to_string(),
        ));
    }

    None
}

fn preferred_allow_option(
    options: &[crate::copilot::acp_client::PendingPermissionOption],
) -> Option<&crate::copilot::acp_client::PendingPermissionOption> {
    options
        .iter()
        .find(|option| option.kind.as_deref().map(is_allow_kind).unwrap_or(false))
        .or_else(|| {
            options
                .iter()
                .find(|option| is_allow_option_id(&option.option_id))
        })
        .or_else(|| options.first())
}

fn safe_allow_option(
    options: &[crate::copilot::acp_client::PendingPermissionOption],
) -> Option<&crate::copilot::acp_client::PendingPermissionOption> {
    options
        .iter()
        .find(|option| option.kind.as_deref().map(is_allow_kind).unwrap_or(false))
        .or_else(|| {
            options
                .iter()
                .find(|option| is_allow_option_id(&option.option_id))
        })
}

fn preferred_deny_option(
    options: &[crate::copilot::acp_client::PendingPermissionOption],
) -> Option<&crate::copilot::acp_client::PendingPermissionOption> {
    options
        .iter()
        .find(|option| option.kind.as_deref().map(is_reject_kind).unwrap_or(false))
        .or_else(|| {
            options
                .iter()
                .find(|option| is_reject_option_id(&option.option_id))
        })
}

fn is_allow_kind(kind: &str) -> bool {
    matches!(
        kind,
        "allow_once" | "allow-once" | "allow_always" | "allow-always"
    )
}

fn is_reject_kind(kind: &str) -> bool {
    matches!(
        kind,
        "reject_once" | "reject-once" | "reject_always" | "reject-always" | "deny"
    )
}

fn is_allow_option_id(option_id: &str) -> bool {
    matches!(
        option_id,
        "allow_once" | "allow-once" | "allow_always" | "allow-always"
    )
}

fn is_reject_option_id(option_id: &str) -> bool {
    matches!(
        option_id,
        "reject_once" | "reject-once" | "reject_always" | "reject-always" | "deny"
    )
}

fn extract_usage(result: Option<&serde_json::Value>, model: &str) -> Option<serde_json::Value> {
    let result = result?;
    let usage = result.get("usage")?;
    Some(json!({
        "model": result.get("model").and_then(|value| value.as_str()).unwrap_or(model),
        "inputTokens": usage.get("inputTokens").or_else(|| usage.get("input_tokens")).and_then(|value| value.as_u64()),
        "outputTokens": usage.get("outputTokens").or_else(|| usage.get("output_tokens")).and_then(|value| value.as_u64()),
        "cacheReadTokens": usage.get("cacheReadTokens").or_else(|| usage.get("cache_read_tokens")).and_then(|value| value.as_u64()),
        "cacheWriteTokens": usage.get("cacheWriteTokens").or_else(|| usage.get("cache_write_tokens")).and_then(|value| value.as_u64()),
        "duration": usage.get("duration").and_then(|value| value.as_u64()),
    }))
}

fn extract_text_fragments(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::String(text)) => vec![text.clone()],
        Some(serde_json::Value::Object(object)) => object
            .get("text")
            .and_then(|value| value.as_str())
            .map(|value| vec![value.to_string()])
            .unwrap_or_default(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
                    .or_else(|| item.as_str().map(str::to_owned))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn extract_plan_items(update: &serde_json::Value) -> Vec<String> {
    if let Some(items) = update.get("items").and_then(|value| value.as_array()) {
        let extracted = items
            .iter()
            .filter_map(|item| {
                item.get("title")
                    .or_else(|| item.get("label"))
                    .or_else(|| item.get("text"))
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
                    .or_else(|| item.as_str().map(str::to_owned))
            })
            .collect::<Vec<_>>();
        if !extracted.is_empty() {
            return extracted;
        }
    }

    extract_text_fragments(update.get("content"))
        .into_iter()
        .flat_map(|text| {
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn extract_status_text(update: &serde_json::Value) -> Option<String> {
    update
        .get("message")
        .or_else(|| update.get("status"))
        .or_else(|| update.get("label"))
        .or_else(|| update.get("title"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .or_else(|| {
            extract_text_fragments(update.get("content"))
                .into_iter()
                .next()
        })
}

fn extract_progress_message(update: &serde_json::Value) -> Option<String> {
    update
        .get("progressMessage")
        .or_else(|| update.get("additionalContext"))
        .or_else(|| update.get("message"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

fn extract_locations(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let locations = value?.as_array()?;
    let collected = locations
        .iter()
        .filter_map(|location| {
            location
                .get("path")
                .or_else(|| location.get("uri"))
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .or_else(|| location.as_str().map(str::to_owned))
        })
        .collect::<Vec<_>>();
    if collected.is_empty() {
        None
    } else {
        Some(collected)
    }
}

fn map_tool_status(status: &str) -> &'static str {
    match status {
        "completed" | "done" => "completed",
        "failed" | "error" => "failed",
        _ => "running",
    }
}
