use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::copilot::acp_client::ReplayedMessage;
use crate::error::AppError;
use crate::state::AppState;
use crate::store::thread_store::{self, ThreadSummary};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatToolActivityResponse {
    id: String,
    tool_name: String,
    status: String,
    started_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageMetadataResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_activities: Option<Vec<ChatToolActivityResponse>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageResponse {
    id: String,
    role: String,
    content: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<ChatMessageMetadataResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadDetailResponse {
    #[serde(flatten)]
    thread: ThreadSummary,
    messages: Vec<ChatMessageResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_user_input_request: Option<serde_json::Value>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/threads", get(list).post(create))
        .route("/api/threads/:thread_id", get(get_detail).patch(update))
        .route("/api/threads/:thread_id/messages", get(get_messages))
        .route("/api/sessions", get(list_acp_sessions))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    project_id: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ListQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let threads = thread_store::list_threads(&state.db, &session.user_id, query.project_id.as_deref());
    Ok(Json(json!({ "threads": threads })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThread {
    project_id: Option<String>,
    title: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Option<CreateThread>>,
) -> Result<(axum::http::StatusCode, Json<serde_json::Value>), AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let body = body.unwrap_or(CreateThread {
        project_id: None,
        title: None,
        model: None,
        reasoning_effort: None,
    });
    let thread = thread_store::create_thread(
        &state.db,
        &session.user_id,
        &state.config.default_model,
        body.project_id.as_deref(),
        body.title.as_deref(),
        body.model.as_deref(),
        body.reasoning_effort.as_deref(),
    )
    .ok_or_else(|| AppError::NotFound("Project not found.".into()))?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "thread": thread }))))
}

async fn get_detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;
    let messages = load_thread_messages(&state, &thread)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;

    Ok(Json(json!({
        "thread": ThreadDetailResponse {
            thread,
            messages,
            pending_user_input_request: None,
        }
    })))
}

/// Load messages for a thread via ACP session/load.
/// This uses the protocol's history replay — no internal file reading.
async fn get_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::get_thread(&state.db, &session.user_id, &thread_id)
        .ok_or_else(|| AppError::NotFound("Thread not found.".into()))?;

    let Some(ref copilot_session_id) = thread.copilot_session_id else {
        // No ACP session yet — return empty messages
        return Ok(Json(json!({ "messages": [] })));
    };

    match load_thread_messages(&state, &thread).await {
        Ok(messages) => Ok(Json(json!({ "messages": messages }))),
        Err(e) => {
            tracing::warn!("Failed to load session messages for {copilot_session_id}: {e}");
            Ok(Json(json!({
                "messages": [],
                "error": format!("Failed to load session: {e}")
            })))
        }
    }
}

/// List all ACP sessions via session/list protocol method.
/// This is the pure ACP view — not filtered by our local thread table.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSessionsQuery {
    cwd: Option<String>,
    cursor: Option<String>,
}

async fn list_acp_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ListSessionsQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config)?;

    let conn = state
        .copilot
        .get_or_create_connection()
        .await
        .map_err(|e| AppError::Internal(format!("Copilot connection failed: {e}")))?;

    let caps = conn.get_capabilities().await;
    if !caps.list_sessions {
        return Ok(Json(json!({
            "sessions": [],
            "error": "Agent does not support session/list"
        })));
    }

    match conn
        .list_sessions(query.cwd.as_deref(), query.cursor.as_deref())
        .await
    {
        Ok(result) => Ok(Json(json!({
            "sessions": result.sessions,
            "nextCursor": result.next_cursor,
        }))),
        Err(e) => {
            tracing::warn!("Failed to list sessions: {e}");
            Ok(Json(json!({
                "sessions": [],
                "error": format!("Failed to list sessions: {e}")
            })))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateThread {
    project_id: Option<Option<String>>,
    model: Option<String>,
    reasoning_effort: Option<Option<String>>,
}

async fn update(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(thread_id): axum::extract::Path<String>,
    Json(body): Json<UpdateThread>,
) -> Result<Json<serde_json::Value>, AppError> {
    let session = require_session(&headers, &state.db, &state.config)?;
    let thread = thread_store::update_thread(
        &state.db,
        &session.user_id,
        &thread_id,
        body.project_id.as_ref().map(|o| o.as_deref()),
        body.model.as_deref(),
        body.reasoning_effort.as_ref().map(|o| o.as_deref()),
    )
    .ok_or_else(|| AppError::NotFound("Thread or project not found.".into()))?;
    Ok(Json(json!({ "thread": thread })))
}

async fn load_thread_messages(
    state: &AppState,
    thread: &ThreadSummary,
) -> anyhow::Result<Vec<ChatMessageResponse>> {
    let Some(ref copilot_session_id) = thread.copilot_session_id else {
        return Ok(Vec::new());
    };

    let conn = state.copilot.create_fresh_connection().await?;
    let caps = conn.get_capabilities().await;
    if !caps.load_session {
        anyhow::bail!("Agent does not support session/load");
    }

    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let replayed_messages = conn.load_session_messages(copilot_session_id, &cwd).await?;

    Ok(replayed_messages_to_chat_messages(
        &replayed_messages,
        &thread.created_at,
        &thread.id,
    ))
}

fn replayed_messages_to_chat_messages(
    replayed_messages: &[ReplayedMessage],
    base_timestamp: &str,
    thread_id: &str,
) -> Vec<ChatMessageResponse> {
    let base_time = parse_base_time(base_timestamp);

    replayed_messages
        .iter()
        .enumerate()
        .map(|(index, replayed_message)| {
            let created_at = (base_time + Duration::milliseconds(index as i64)).to_rfc3339();
            let tool_activities = replayed_message
                .tool_calls
                .as_ref()
                .map(|tool_calls| tool_calls_to_activities(tool_calls, &created_at))
                .filter(|tool_calls| !tool_calls.is_empty());

            ChatMessageResponse {
                id: format!("{thread_id}-replay-{index}"),
                role: replayed_message.role.clone(),
                content: replayed_message.content.clone(),
                created_at,
                metadata: tool_activities.map(|tool_activities| ChatMessageMetadataResponse {
                    tool_activities: Some(tool_activities),
                }),
            }
        })
        .collect()
}

fn tool_calls_to_activities(
    tool_calls: &[serde_json::Value],
    timestamp: &str,
) -> Vec<ChatToolActivityResponse> {
    tool_calls
        .iter()
        .enumerate()
        .map(|(index, tool_call)| ChatToolActivityResponse {
            id: tool_call
                .get("id")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("tool-{index}")),
            tool_name: tool_call
                .get("name")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| "Tool".to_string()),
            status: map_tool_status(
                tool_call
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("running"),
            )
            .to_string(),
            started_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            arguments: value_to_string(tool_call.get("arguments")),
            result: value_to_string(tool_call.get("result")),
            additional_context: value_to_string(tool_call.get("additionalContext")),
            error: value_to_string(tool_call.get("error")),
        })
        .collect()
}

fn parse_base_time(base_timestamp: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(base_timestamp)
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn map_tool_status(status: &str) -> &'static str {
    match status {
        "completed" | "done" => "completed",
        "failed" | "error" => "failed",
        _ => "running",
    }
}

fn value_to_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::Null) | None => None,
        Some(serde_json::Value::String(value)) => {
            if value.trim().is_empty() {
                None
            } else {
                Some(value.clone())
            }
        }
        Some(other) => Some(other.to_string()),
    }
}
