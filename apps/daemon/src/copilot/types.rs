use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// A message from the ACP agent — either a response, notification, or server request.
#[derive(Debug)]
pub enum AcpMessage {
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
    /// Server-to-client request (has both `id` and `method`). Needs a response.
    ServerRequest(JsonRpcRequest),
}

impl AcpMessage {
    pub fn from_value(val: serde_json::Value) -> Option<Self> {
        let has_id = val.get("id").is_some();
        let has_method = val.get("method").is_some();
        let has_result_or_error = val.get("result").is_some() || val.get("error").is_some();

        if has_id && has_method && !has_result_or_error {
            // Server-to-client request: has id + method, no result/error
            serde_json::from_value::<JsonRpcRequest>(val).ok().map(AcpMessage::ServerRequest)
        } else if has_id && has_result_or_error {
            // Response to our request
            serde_json::from_value::<JsonRpcResponse>(val).ok().map(AcpMessage::Response)
        } else if has_method {
            // Notification (no id)
            serde_json::from_value::<JsonRpcNotification>(val)
                .ok()
                .map(AcpMessage::Notification)
        } else {
            None
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Serialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilities>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    pub image: bool,
    pub audio: bool,
    pub embedded_context: bool,
}

/// Streamed session update from the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdate {
    pub session_id: String,
    pub update: SessionUpdatePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdatePayload {
    pub session_update: String,
    #[serde(flatten)]
    pub data: serde_json::Value,
}
