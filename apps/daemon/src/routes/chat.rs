use std::convert::Infallible;
use std::time::Duration;

use anyhow::Context;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::post;
use axum::{Json, Router};
use futures::stream::Stream;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashSet;
use tokio::sync::mpsc;

use crate::auth_middleware::require_session;
use crate::canvas_selection::build_selection_context_excerpt;
use crate::copilot::{
    PendingPermissionOption, PendingPermissionRequest, PendingToolCallRequest, SendPromptInput,
    SessionEvent, UserMessageAttachment, SDK_PERMISSION_APPROVED, SDK_PERMISSION_DENIED,
};
use crate::error::AppError;
use crate::state::AppState;
use crate::store::{
    attachment_store, canvas_store, preferences_store, thread_store, workspace_store,
};

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasCreateToolArgs {
    title: String,
    #[serde(default)]
    kind: Option<String>,
    content: String,
    #[serde(default)]
    open: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasUpdateToolArgs {
    #[serde(default)]
    canvas_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    content: String,
    #[serde(default)]
    selection_replace: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasOpenToolArgs {
    canvas_id: String,
}

async fn abort_chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AbortInput>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config).await?;
    let thread =
        thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
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
    let thread =
        thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
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
    let thread =
        thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
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
    let thread =
        thread_store::get_thread(&state.db, &state.config, &session.user_id, &body.thread_id)
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

    let canvas_context = body.canvas.clone();
    let prompt_text = build_prompt_text(&prompt, canvas_context.as_ref());

    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(256);
    let state_clone = state.clone();
    let thread_id = thread.id.clone();
    let workspace_path =
        workspace_store::ensure_runtime_workspace_directory(&state.config, &thread.workspace_path)
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

        let (copilot_session_id, session_was_resumed) = if let Some(ref existing_id) =
            thread.copilot_session_id
        {
            match conn
                .ensure_session(
                    existing_id,
                    &workspace_path,
                    Some(&model),
                    reasoning_effort.as_deref(),
                    None,
                )
                .await
            {
                Ok(session_id) => {
                    let _ = tx
                        .send(Ok(make_event(
                            &json!({ "type": "session", "sessionId": session_id }),
                        )))
                        .await;
                    (session_id, true)
                }
                Err(error)
                    if crate::copilot::sdk_client::SdkConnection::is_resettable_session_error(
                        &error,
                    ) =>
                {
                    let _ = thread_store::clear_thread_session(&state_clone.db, &thread_id).await;
                    match conn
                        .new_session(
                            &workspace_path,
                            Some(&model),
                            reasoning_effort.as_deref(),
                            None,
                        )
                        .await
                    {
                        Ok(id) => {
                            let _ = thread_store::update_thread_session(
                                &state_clone.db,
                                &thread_id,
                                &id,
                            )
                            .await;
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
                Err(e) => {
                    let _ = tx
                        .send(Ok(make_event(&json!({ "type": "error", "message": format!("Failed to resume session: {e}") }))))
                        .await;
                    let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
                    return;
                }
            }
        } else {
            match conn
                .new_session(
                    &workspace_path,
                    Some(&model),
                    reasoning_effort.as_deref(),
                    None,
                )
                .await
            {
                Ok(id) => {
                    let _ =
                        thread_store::update_thread_session(&state_clone.db, &thread_id, &id).await;
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

        let source_user_message_index = if session_was_resumed {
            next_user_message_index(&conn, &copilot_session_id).await
        } else {
            Some(0)
        };

        let mut result_rx = match conn
            .send_prompt_streaming(
                &copilot_session_id,
                SendPromptInput {
                    prompt: prompt_text,
                    attachments: attachments
                        .iter()
                        .map(|attachment| UserMessageAttachment {
                            path: attachment.file_path.clone(),
                            display_name: attachment.name.clone(),
                        })
                        .collect(),
                    mode: None,
                },
            )
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
            match source_user_message_index {
                Some(user_message_index) => {
                    if let Err(error) = attachment_store::save_message_attachments(
                        &state_clone.db,
                        &thread_id,
                        user_message_index,
                        Some(&copilot_session_id),
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
        let mut streamed_message_ids = HashSet::new();
        let mut streamed_reasoning_ids = HashSet::new();
        let timeout = tokio::time::sleep(Duration::from_secs(600));
        tokio::pin!(timeout);

        loop {
            tokio::select! {
                result = result_rx.recv() => {
                    match result {
                        Ok(event) => {
                            if process_event(
                                &event,
                                &tx,
                                &mut streamed_content,
                                &mut streamed_reasoning,
                                &mut streamed_message_ids,
                                &mut streamed_reasoning_ids,
                                &state_clone,
                                &conn,
                                &copilot_session_id,
                                &thread_id,
                                source_user_message_index,
                                canvas_context.as_ref(),
                            ).await {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            let _ = tx.send(Ok(make_event(&json!({ "type": "error", "message": "Connection lost." })))).await;
                            break;
                        }
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

const SELECTION_CONTEXT_RADIUS_CHARS: usize = 220;

fn render_context_edge(
    text: &str,
    truncated_start: bool,
    truncated_end: bool,
    empty_label: &str,
) -> String {
    if text.is_empty() {
        return empty_label.to_string();
    }

    format!(
        "{}{}{}",
        if truncated_start { "…" } else { "" },
        text,
        if truncated_end { "…" } else { "" }
    )
}

fn build_prompt_text(prompt: &str, canvas: Option<&CanvasPromptContext>) -> String {
    build_canvas_prompt(prompt, canvas)
}

fn canvas_update_sync_open_state() -> Option<bool> {
    Some(true)
}

fn uses_markdown_canvas_format(kind: &str) -> bool {
    matches!(kind, "document" | "notes")
}

fn canvas_format_guidance(kind: &str) -> &'static str {
    if uses_markdown_canvas_format(kind) {
        "For document and notes canvases, default to well-structured markdown with headings, lists, emphasis, blockquotes, tables, and fenced code blocks when they improve the result. Only use plain text or another format if the user explicitly asks for it.\n"
    } else {
        ""
    }
}

fn canvas_content_update_from_request<'a>(
    args: &'a CanvasUpdateToolArgs,
    canvas_context: Option<&'a CanvasPromptContext>,
) -> anyhow::Result<canvas_store::CanvasContentUpdate<'a>> {
    if args.selection_replace.unwrap_or(false) {
        let canvas_context =
            canvas_context.context("selectionReplace requires an active canvas context")?;
        let selection = canvas_context
            .selection
            .as_ref()
            .context("selectionReplace requires an active selection")?;
        let current_content = canvas_context
            .current_content
            .as_deref()
            .context("selectionReplace requires the current canvas content")?;
        Ok(canvas_store::CanvasContentUpdate::SelectionReplace(
            canvas_store::SelectionReplaceInput {
                expected_current_content: current_content,
                start_utf16: selection.start,
                end_utf16: selection.end,
                selected_text: &selection.text,
                replacement: &args.content,
            },
        ))
    } else {
        Ok(canvas_store::CanvasContentUpdate::Full(&args.content))
    }
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
            "The user wants to create or draft in a {kind} canvas titled \"{title}\"{identifier}.\n\
Prefer using the `canvas.create` tool to create the artifact instead of returning the draft as plain chat text.\n\
When you call the tool, provide the full canvas content and a suitable title/kind.\n\
{format_guidance}\
If you also send a chat reply after the tool call, keep it brief and reference the canvas naturally.\n\n\
User request:\n{prompt}",
            format_guidance = canvas_format_guidance(kind)
        ),
        "update" => {
            if let Some(selection) = canvas.selection.as_ref() {
                let local_context = build_selection_context_excerpt(
                    current_content,
                    selection.start,
                    selection.end,
                    SELECTION_CONTEXT_RADIUS_CHARS,
                );
                let (before_context, after_context) = match local_context {
                    Ok(local_context) => (
                        render_context_edge(
                            &local_context.before,
                            local_context.before_truncated,
                            false,
                            "(start of document)",
                        ),
                        render_context_edge(
                            &local_context.after,
                            false,
                            local_context.after_truncated,
                            "(end of document)",
                        ),
                    ),
                    Err(_) => (
                        "(selection context unavailable)".to_string(),
                        "(selection context unavailable)".to_string(),
                    ),
                };

                format!(
                    "The user wants to edit the selected portion of a {kind} canvas titled \"{title}\"{identifier}.\n\
                    Current canvas content:\n<<<CANVAS\n{current_content}\nCANVAS\n\n\
                    Immediate surrounding context for the selected range:\n<<<BEFORE\n{before_context}\nBEFORE\n\
                    <<<SELECTION\n{selection_text}\nSELECTION\n\
                    <<<AFTER\n{after_context}\nAFTER\n\n\
                    Selected range (UTF-16 offsets {start}–{end}).\n\n\
                    {format_guidance}\
                    IMPORTANT: Treat the current canvas content as the source of truth for tone, formatting, markdown structure, indentation, heading/list/code conventions, and surrounding context unless the user explicitly asks to change them.\n\
                    IMPORTANT: Call `canvas_update` with `selectionReplace: true` and set `content` to ONLY the replacement text for the selected range. Your replacement must fit seamlessly between the BEFORE and AFTER context. \
                    Do not close the canvas as part of this update; the edited canvas should remain open after the tool call.\n\
                    Do NOT send the full document, wrapper markup, or any explanation — the backend will splice your replacement into the original at the selection boundaries.\n\
                    If you also reply in chat, keep it brief and do not repeat the content inline.\n\n\
                    User request:\n{prompt}",
                    before_context = before_context,
                    start = selection.start,
                    end = selection.end,
                    selection_text = selection.text,
                    after_context = after_context,
                    format_guidance = canvas_format_guidance(kind),
                )
            } else {
                format!(
                    "The user wants to revise a {kind} canvas titled \"{title}\"{identifier}.\n\
Current canvas content:\n<<<CANVAS\n{current_content}\nCANVAS\n\n\
Prefer using the `canvas.update` tool for the actual mutation. Send the full updated canvas content in the tool call.\n\
{format_guidance}\
Treat the current canvas content as the source of truth for tone, formatting, markdown structure, indentation, heading/list/code conventions, and surrounding context unless the user explicitly asks to change them.\n\
If you also reply in chat, keep it brief and do not repeat the full document inline.\n\n\
User request:\n{prompt}",
                    format_guidance = canvas_format_guidance(kind)
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
    conn: &crate::copilot::sdk_client::SdkConnection,
    session_id: &str,
) -> Option<usize> {
    let replayed_messages = conn.load_session_messages(session_id).await.ok()?;
    Some(
        replayed_messages
            .iter()
            .filter(|message| message.role == "user")
            .count(),
    )
}

async fn process_event(
    event: &SessionEvent,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    streamed_content: &mut String,
    streamed_reasoning: &mut String,
    streamed_message_ids: &mut HashSet<String>,
    streamed_reasoning_ids: &mut HashSet<String>,
    state: &AppState,
    conn: &crate::copilot::sdk_client::SdkConnection,
    session_id: &str,
    thread_id: &str,
    source_user_message_index: Option<usize>,
    canvas_context: Option<&CanvasPromptContext>,
) -> bool {
    match event.event_type.as_str() {
        "assistant.message_delta" => {
            let message_id = event
                .data
                .get("messageId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            streamed_message_ids.insert(message_id);
            if let Some(text) = event
                .data
                .get("deltaContent")
                .and_then(|value| value.as_str())
            {
                streamed_content.push_str(&text);
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "chunk", "delta": text }))))
                    .await;
            }
        }
        "assistant.message" => {
            let message_id = event
                .data
                .get("messageId")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if !streamed_message_ids.contains(message_id) {
                if let Some(text) = event.data.get("content").and_then(|value| value.as_str()) {
                    streamed_content.push_str(text);
                    let _ = tx
                        .send(Ok(make_event(&json!({ "type": "chunk", "delta": text }))))
                        .await;
                }
            }
        }
        "assistant.reasoning_delta" => {
            let reasoning_id = event
                .data
                .get("reasoningId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            streamed_reasoning_ids.insert(reasoning_id);
            if let Some(text) = event
                .data
                .get("deltaContent")
                .and_then(|value| value.as_str())
            {
                streamed_reasoning.push_str(text);
                let _ = tx
                    .send(Ok(make_event(
                        &json!({ "type": "reasoning_delta", "delta": text }),
                    )))
                    .await;
            }
        }
        "assistant.reasoning" => {
            let reasoning_id = event
                .data
                .get("reasoningId")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if !streamed_reasoning_ids.contains(reasoning_id) {
                if let Some(text) = event.data.get("content").and_then(|value| value.as_str()) {
                    streamed_reasoning.push_str(text);
                    let _ = tx
                        .send(Ok(make_event(
                            &json!({ "type": "reasoning_delta", "delta": text }),
                        )))
                        .await;
                }
            }
        }
        "assistant.intent" => {
            if let Some(phase) = event.data.get("intent").and_then(|value| value.as_str()) {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "status", "phase": phase }))))
                    .await;
            }
        }
        "session.info" => {
            if let Some(phase) = event.data.get("message").and_then(|value| value.as_str()) {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "status", "phase": phase }))))
                    .await;
            }
        }
        "tool.user_requested" | "tool.execution_start" => {
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": event.data.get("toolCallId").and_then(|value| value.as_str()).unwrap_or("unknown"),
                    "toolName": event.data.get("toolName").and_then(|value| value.as_str()).unwrap_or("Tool"),
                    "status": "running",
                    "startedAt": event.timestamp,
                    "updatedAt": event.timestamp,
                    "arguments": event.data.get("arguments").map(|value| value.to_string()),
                }
            })))).await;
        }
        "tool.execution_progress" => {
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": event.data.get("toolCallId").and_then(|value| value.as_str()).unwrap_or("unknown"),
                    "toolName": "Tool",
                    "status": "running",
                    "startedAt": event.timestamp,
                    "updatedAt": event.timestamp,
                    "additionalContext": event.data.get("progressMessage").and_then(|value| value.as_str()),
                }
            })))).await;
        }
        "tool.execution_partial_result" => {
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": event.data.get("toolCallId").and_then(|value| value.as_str()).unwrap_or("unknown"),
                    "toolName": "Tool",
                    "status": "running",
                    "startedAt": event.timestamp,
                    "updatedAt": event.timestamp,
                    "result": event.data.get("partialOutput").and_then(|value| value.as_str()),
                }
            })))).await;
        }
        "tool.execution_complete" => {
            let success = event
                .data
                .get("success")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let _ = tx.send(Ok(make_event(&json!({
                "type": "tool_event",
                "activity": {
                    "id": event.data.get("toolCallId").and_then(|value| value.as_str()).unwrap_or("unknown"),
                    "toolName": event.data.get("mcpToolName").or_else(|| event.data.get("toolName")).and_then(|value| value.as_str()).unwrap_or("Tool"),
                    "status": if success { "completed" } else { "failed" },
                    "startedAt": event.timestamp,
                    "updatedAt": event.timestamp,
                    "result": event.data.get("result").and_then(|value| value.get("content")).map(|value| value.to_string()),
                    "error": event.data.get("error").and_then(|value| value.get("message")).and_then(|value| value.as_str()),
                }
            })))).await;
        }
        "assistant.usage" => {
            if let Some(usage) = extract_usage_from_event(&event.data) {
                let _ = tx
                    .send(Ok(make_event(&json!({ "type": "usage", "usage": usage }))))
                    .await;
            }
        }
        "sdk.user_input_request" => {
            let _ = tx
                .send(Ok(make_event(
                    &json!({ "type": "user_input_request", "request": event.data }),
                )))
                .await;
        }
        "sdk.permission_request" => {
            let Ok(request) =
                serde_json::from_value::<PendingPermissionRequest>(event.data.clone())
            else {
                return false;
            };
            let approval_mode =
                match preferences_store::get_preferences(&state.db, &state.config).await {
                    Ok(prefs) => prefs.approval_mode,
                    Err(error) => {
                        let _ = tx
                            .send(Ok(make_event(&json!({
                                "type": "error",
                                "message": format!("Failed to load approval preferences: {error}")
                            }))))
                            .await;
                        return false;
                    }
                };
            if let Some((option_id, decision, reason)) =
                auto_decide_permission(&request, &approval_mode)
            {
                match conn
                    .respond_to_permission_request(&request.request_id, &option_id)
                    .await
                {
                    Ok(()) => {
                        let _ = tx.send(Ok(make_event(&json!({
                            "type": "tool_event",
                            "activity": {
                                "id": request.tool_call_id.clone().unwrap_or_else(|| request.request_id.clone()),
                                "toolName": request.tool_name.clone().unwrap_or_else(|| "Tool".to_string()),
                                "kind": request.tool_kind,
                                "status": "running",
                                "startedAt": request.created_at,
                                "updatedAt": event.timestamp,
                                "permissionDecision": decision,
                                "permissionDecisionReason": reason,
                            }
                        })))).await;
                        let _ = tx.send(Ok(make_event(&json!({ "type": "permission_cleared", "requestId": request.request_id })))).await;
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
        "sdk.tool_call_request" => {
            let Ok(request) = serde_json::from_value::<PendingToolCallRequest>(event.data.clone())
            else {
                return false;
            };
            if request.session_id == session_id {
                handle_canvas_tool_call(
                    state,
                    conn,
                    tx,
                    thread_id,
                    source_user_message_index,
                    session_id,
                    canvas_context,
                    &request,
                )
                .await;
            }
        }
        "abort" => {
            let message = event
                .data
                .get("reason")
                .and_then(|value| value.as_str())
                .unwrap_or("Response stopped.");
            let _ = tx
                .send(Ok(make_event(
                    &json!({ "type": "aborted", "message": message }),
                )))
                .await;
            return true;
        }
        "session.error" => {
            let message = event
                .data
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Copilot request failed.");
            let _ = tx
                .send(Ok(make_event(
                    &json!({ "type": "error", "message": message }),
                )))
                .await;
            return true;
        }
        "session.idle" => {
            if !streamed_reasoning.is_empty() {
                let _ = tx
                    .send(Ok(make_event(
                        &json!({ "type": "reasoning", "content": streamed_reasoning }),
                    )))
                    .await;
            }
            let _ = tx.send(Ok(make_event(&json!({ "type": "done" })))).await;
            return true;
        }
        _ => {}
    }
    false
}

async fn handle_canvas_tool_call(
    state: &AppState,
    conn: &crate::copilot::sdk_client::SdkConnection,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: &str,
    canvas_context: Option<&CanvasPromptContext>,
    request: &PendingToolCallRequest,
) {
    let result = match request.tool_name.as_str() {
        "canvas.create" | "canvas_create" => {
            handle_canvas_create_tool(
                state,
                tx,
                thread_id,
                source_user_message_index,
                source_copilot_session_id,
                request,
            )
            .await
        }
        "canvas.update" | "canvas_update" => {
            handle_canvas_update_tool(
                state,
                tx,
                thread_id,
                source_user_message_index,
                source_copilot_session_id,
                canvas_context,
                request,
            )
            .await
        }
        "canvas.list" | "canvas_list" => handle_canvas_list_tool(state, tx, thread_id).await,
        "canvas.open" | "canvas_open" => {
            handle_canvas_open_tool(state, tx, thread_id, request).await
        }
        "canvas.close" | "canvas_close" => handle_canvas_close_tool(state, tx, thread_id).await,
        _ => Ok(tool_failure_result(
            format!("Unsupported tool '{}'", request.tool_name),
            "This daemon does not support that tool.",
        )),
    };

    let response = match result {
        Ok(result) => result,
        Err(error) => tool_failure_result(
            error.to_string(),
            "The requested canvas action could not be completed.",
        ),
    };

    if let Err(error) = conn
        .respond_to_tool_call(&request.request_id, response)
        .await
    {
        let _ = tx
            .send(Ok(make_event(&json!({
                "type": "error",
                "message": format!("Failed to respond to Copilot tool call: {error}"),
            }))))
            .await;
    }
}

async fn handle_canvas_create_tool(
    state: &AppState,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: &str,
    request: &PendingToolCallRequest,
) -> anyhow::Result<serde_json::Value> {
    let args: CanvasCreateToolArgs = serde_json::from_value(request.arguments.clone())?;
    let title = canvas_store::normalize_canvas_title(&args.title)?;
    let kind = canvas_store::normalize_canvas_kind(args.kind.as_deref().unwrap_or("document"))?;
    let canvas = canvas_store::create_canvas(
        &state.db,
        thread_id,
        &title,
        &kind,
        &args.content,
        source_user_message_index,
        Some(source_copilot_session_id),
    )
    .await?;
    emit_canvas_sync(
        tx,
        &state.db,
        thread_id,
        Some(canvas.id.as_str()),
        args.open.or(Some(true)),
    )
    .await?;
    Ok(tool_success_result(format!(
        "Created canvas \"{}\" (id: {}).",
        canvas.title, canvas.id
    )))
}

async fn handle_canvas_update_tool(
    state: &AppState,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
    source_user_message_index: Option<usize>,
    source_copilot_session_id: &str,
    canvas_context: Option<&CanvasPromptContext>,
    request: &PendingToolCallRequest,
) -> anyhow::Result<serde_json::Value> {
    let args: CanvasUpdateToolArgs = serde_json::from_value(request.arguments.clone())?;
    let canvas_id = args
        .canvas_id
        .as_deref()
        .or_else(|| canvas_context.and_then(|canvas| canvas.canvas_id.as_deref()))
        .context("canvas.update requires canvasId when there is no active canvas context")?;
    let normalized_title = args
        .title
        .as_deref()
        .map(canvas_store::normalize_canvas_title)
        .transpose()?;

    let content_update = Some(canvas_content_update_from_request(&args, canvas_context)?);

    let canvas = canvas_store::update_canvas(
        &state.db,
        thread_id,
        canvas_id,
        normalized_title.as_deref(),
        content_update,
        source_user_message_index,
        Some(source_copilot_session_id),
    )
    .await?
    .with_context(|| format!("Canvas {canvas_id} was not found"))?;
    emit_canvas_sync(
        tx,
        &state.db,
        thread_id,
        Some(canvas.id.as_str()),
        canvas_update_sync_open_state(),
    )
    .await?;
    Ok(tool_success_result(format!(
        "Updated canvas \"{}\" (id: {}).",
        canvas.title, canvas.id
    )))
}

async fn handle_canvas_list_tool(
    state: &AppState,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
) -> anyhow::Result<serde_json::Value> {
    let canvases = canvas_store::list_canvases(&state.db, thread_id).await?;
    let summary = if canvases.is_empty() {
        "No canvases exist for this thread yet.".to_string()
    } else {
        canvases
            .iter()
            .map(|canvas| format!("- {} ({}, id: {})", canvas.title, canvas.kind, canvas.id))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let _ = tx
        .send(Ok(make_event(&json!({
            "type": "canvas_sync",
            "canvases": canvases,
        }))))
        .await;
    Ok(tool_success_result(summary))
}

async fn handle_canvas_open_tool(
    state: &AppState,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
    request: &PendingToolCallRequest,
) -> anyhow::Result<serde_json::Value> {
    let args: CanvasOpenToolArgs = serde_json::from_value(request.arguments.clone())?;
    let canvases = canvas_store::list_canvases(&state.db, thread_id).await?;
    let canvas = canvases
        .iter()
        .find(|canvas| canvas.id == args.canvas_id)
        .cloned()
        .with_context(|| format!("Canvas {} was not found", args.canvas_id))?;
    let active_canvas_id = canvas.id.clone();
    let _ = tx
        .send(Ok(make_event(&json!({
            "type": "canvas_sync",
            "canvases": canvases,
            "activeCanvasId": active_canvas_id,
            "open": true,
        }))))
        .await;
    Ok(tool_success_result(format!(
        "Opened canvas \"{}\".\n\nCurrent content:\n{}",
        canvas.title, canvas.content
    )))
}

async fn handle_canvas_close_tool(
    state: &AppState,
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    thread_id: &str,
) -> anyhow::Result<serde_json::Value> {
    emit_canvas_sync(tx, &state.db, thread_id, None, Some(false)).await?;
    Ok(tool_success_result(
        "Closed the canvas pane without deleting any saved canvas.".to_string(),
    ))
}

async fn emit_canvas_sync(
    tx: &mpsc::Sender<Result<Event, Infallible>>,
    db: &crate::db::Database,
    thread_id: &str,
    active_canvas_id: Option<&str>,
    open: Option<bool>,
) -> anyhow::Result<()> {
    let canvases = canvas_store::list_canvases(db, thread_id).await?;
    let mut payload = json!({
        "type": "canvas_sync",
        "canvases": canvases,
    });
    if let Some(active_canvas_id) = active_canvas_id {
        payload["activeCanvasId"] = json!(active_canvas_id);
    }
    if let Some(open) = open {
        payload["open"] = json!(open);
    }
    let _ = tx.send(Ok(make_event(&payload))).await;
    Ok(())
}

fn tool_success_result(text_result_for_llm: String) -> serde_json::Value {
    json!({
        "textResultForLlm": text_result_for_llm,
        "resultType": "success",
        "toolTelemetry": {},
    })
}

fn tool_failure_result(error: String, text_result_for_llm: &str) -> serde_json::Value {
    json!({
        "textResultForLlm": text_result_for_llm,
        "resultType": "failure",
        "error": error,
        "toolTelemetry": {},
    })
}

fn auto_decide_permission(
    request: &PendingPermissionRequest,
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

fn preferred_allow_option(options: &[PendingPermissionOption]) -> Option<&PendingPermissionOption> {
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

fn safe_allow_option(options: &[PendingPermissionOption]) -> Option<&PendingPermissionOption> {
    options
        .iter()
        .find(|option| option.kind.as_deref().map(is_allow_kind).unwrap_or(false))
        .or_else(|| {
            options
                .iter()
                .find(|option| is_allow_option_id(&option.option_id))
        })
}

fn preferred_deny_option(options: &[PendingPermissionOption]) -> Option<&PendingPermissionOption> {
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
        SDK_PERMISSION_APPROVED | "allow_once" | "allow-once" | "allow_always" | "allow-always"
    )
}

fn is_reject_option_id(option_id: &str) -> bool {
    matches!(
        option_id,
        SDK_PERMISSION_DENIED
            | "reject_once"
            | "reject-once"
            | "reject_always"
            | "reject-always"
            | "deny"
    )
}

fn extract_usage_from_event(data: &serde_json::Value) -> Option<serde_json::Value> {
    let model = data
        .get("model")
        .or_else(|| data.get("modelId"))
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let usage = data.get("usage").unwrap_or(data);
    let has_any_tokens = usage.get("inputTokens").is_some()
        || usage.get("input_tokens").is_some()
        || usage.get("outputTokens").is_some()
        || usage.get("output_tokens").is_some()
        || usage.get("cacheReadTokens").is_some()
        || usage.get("cache_read_tokens").is_some()
        || usage.get("cacheWriteTokens").is_some()
        || usage.get("cache_write_tokens").is_some()
        || usage.get("duration").is_some();
    if !has_any_tokens {
        return None;
    }
    let usage = data.get("usage").unwrap_or(data);
    Some(json!({
        "model": model,
        "inputTokens": usage.get("inputTokens").or_else(|| usage.get("input_tokens")).and_then(|value| value.as_u64()),
        "outputTokens": usage.get("outputTokens").or_else(|| usage.get("output_tokens")).and_then(|value| value.as_u64()),
        "cacheReadTokens": usage.get("cacheReadTokens").or_else(|| usage.get("cache_read_tokens")).and_then(|value| value.as_u64()),
        "cacheWriteTokens": usage.get("cacheWriteTokens").or_else(|| usage.get("cache_write_tokens")).and_then(|value| value.as_u64()),
        "duration": usage.get("duration").and_then(|value| value.as_u64()),
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        build_canvas_prompt, canvas_content_update_from_request, canvas_update_sync_open_state,
        CanvasPromptContext, CanvasSelectionInput, CanvasUpdateToolArgs,
    };
    use crate::canvas_selection::build_selection_context_excerpt;

    fn utf16_range_for(content: &str, selected: &str) -> (usize, usize) {
        let byte_start = content
            .find(selected)
            .expect("selected text should exist in the content");
        let start = content[..byte_start].encode_utf16().count();
        let end = start + selected.encode_utf16().count();
        (start, end)
    }

    #[test]
    fn selection_update_prompt_keeps_full_document_and_style_guidance() {
        let current_content = "## Shopping list\n\n- apples\n- bananas\n- carrots\n";
        let selected_text = "- bananas";
        let (start, end) = utf16_range_for(current_content, selected_text);
        let canvas = CanvasPromptContext {
            mode: "update".to_string(),
            canvas_id: Some("canvas-1".to_string()),
            title: Some("Shopping".to_string()),
            kind: Some("document".to_string()),
            current_content: Some(current_content.to_string()),
            selection: Some(CanvasSelectionInput {
                start,
                end,
                text: selected_text.to_string(),
            }),
        };

        let prompt = build_canvas_prompt("Make it more formal.", Some(&canvas));

        assert!(prompt.contains("Current canvas content:\n<<<CANVAS\n## Shopping list"));
        assert!(prompt.contains("Immediate surrounding context for the selected range:"));
        assert!(prompt.contains("Treat the current canvas content as the source of truth"));
        assert!(prompt.contains("fit seamlessly between the BEFORE and AFTER context"));
        assert!(prompt.contains("ONLY the replacement text for the selected range"));
        assert!(prompt.contains("Selected range (UTF-16 offsets"));
        assert!(prompt.contains("should remain open after the tool call"));
    }

    #[test]
    fn document_create_prompt_prefers_markdown_structure() {
        let canvas = CanvasPromptContext {
            mode: "create".to_string(),
            canvas_id: Some("canvas-1".to_string()),
            title: Some("Release notes".to_string()),
            kind: Some("document".to_string()),
            current_content: None,
            selection: None,
        };

        let prompt = build_canvas_prompt("Draft release notes for the new version.", Some(&canvas));

        assert!(prompt.contains("default to well-structured markdown"));
        assert!(prompt.contains("headings, lists, emphasis, blockquotes, tables, and fenced code blocks"));
    }

    #[test]
    fn selection_context_excerpt_uses_utf16_offsets() {
        let excerpt = build_selection_context_excerpt("aa🙂bbccdd", 2, 4, 2).unwrap();

        assert_eq!(excerpt.before, "aa");
        assert_eq!(excerpt.after, "bb");
        assert!(!excerpt.before_truncated);
        assert!(excerpt.after_truncated);
    }

    #[test]
    fn selection_replace_requires_an_active_canvas_context() {
        let args = CanvasUpdateToolArgs {
            canvas_id: Some("canvas-1".to_string()),
            title: None,
            content: "replacement".to_string(),
            selection_replace: Some(true),
        };

        let error = canvas_content_update_from_request(&args, None).unwrap_err();
        assert!(error
            .to_string()
            .contains("selectionReplace requires an active canvas context"));
    }

    #[test]
    fn selection_replace_requires_current_canvas_content() {
        let args = CanvasUpdateToolArgs {
            canvas_id: Some("canvas-1".to_string()),
            title: None,
            content: "replacement".to_string(),
            selection_replace: Some(true),
        };
        let canvas = CanvasPromptContext {
            mode: "update".to_string(),
            canvas_id: Some("canvas-1".to_string()),
            title: Some("Shopping".to_string()),
            kind: Some("document".to_string()),
            current_content: None,
            selection: Some(CanvasSelectionInput {
                start: 0,
                end: 4,
                text: "text".to_string(),
            }),
        };

        let error = canvas_content_update_from_request(&args, Some(&canvas)).unwrap_err();
        assert!(error
            .to_string()
            .contains("selectionReplace requires the current canvas content"));
    }

    #[test]
    fn selection_replace_requires_an_active_selection() {
        let args = CanvasUpdateToolArgs {
            canvas_id: Some("canvas-1".to_string()),
            title: None,
            content: "replacement".to_string(),
            selection_replace: Some(true),
        };
        let canvas = CanvasPromptContext {
            mode: "update".to_string(),
            canvas_id: Some("canvas-1".to_string()),
            title: Some("Shopping".to_string()),
            kind: Some("document".to_string()),
            current_content: Some("text".to_string()),
            selection: None,
        };

        let error = canvas_content_update_from_request(&args, Some(&canvas)).unwrap_err();
        assert!(error
            .to_string()
            .contains("selectionReplace requires an active selection"));
    }

    #[test]
    fn canvas_updates_always_keep_the_canvas_open() {
        assert_eq!(canvas_update_sync_open_state(), Some(true));
    }
}
