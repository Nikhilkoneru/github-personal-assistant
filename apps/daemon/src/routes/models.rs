use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::auth_middleware::require_session;
use crate::error::AppError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/models", get(list_models))
}

async fn list_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, AppError> {
    let _session = require_session(&headers, &state.db, &state.config)?;

    // Try to get models from ACP connection
    if let Ok(conn) = state.copilot.get_or_create_connection().await {
        // If no cached models yet, create a temporary session to populate them
        if conn.get_cached_models().await.is_none() {
            let _ = conn.new_session().await;
        }

        if let Some(models_data) = conn.get_cached_models().await {
            if let Some(available) = models_data.get("availableModels").and_then(|v| v.as_array()) {
                let models: Vec<serde_json::Value> = available
                    .iter()
                    .map(|m| {
                        let id = m.get("modelId").and_then(|v| v.as_str()).unwrap_or("unknown");
                        let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                        let usage = m.get("_meta")
                            .and_then(|meta| meta.get("copilotUsage"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("0x");
                        json!({
                            "id": id,
                            "name": name,
                            "source": "sdk",
                            "supportsReasoning": false,
                            "billing": {
                                "multiplier": usage.trim_end_matches('x').parse::<f64>().unwrap_or(0.0)
                            }
                        })
                    })
                    .collect();
                return Ok(Json(json!({ "models": models })));
            }
        }
    }

    // Fallback static models
    let models = vec![
        model_entry("gpt-5-mini", "GPT-5 mini", false),
        model_entry("gpt-4.1", "GPT-4.1", false),
        model_entry("claude-sonnet-4", "Claude Sonnet 4", false),
    ];

    Ok(Json(json!({ "models": models })))
}

fn model_entry(id: &str, name: &str, supports_reasoning: bool) -> serde_json::Value {
    json!({
        "id": id,
        "name": name,
        "source": "static",
        "supportsReasoning": supports_reasoning,
    })
}
