# ACP Rust SDK - Quick Reference Card

## File at a Glance

| File | Size | Lines | Purpose |
|------|------|-------|---------|
| ACP_ANALYSIS_INDEX.md | 12K | 440 | Navigation & cross-references |
| ACP_RUST_SDK_DEEPDIVE.md | 24K | 832 | Complete architecture guide |
| ACP_TYPES_REFERENCE.md | 12K | 409 | Type definitions & traits |
| ACP_USAGE_PATTERNS.md | 16K | 532 | Code examples & patterns |
| ACP_SDK_ANALYSIS_README.md | 8K | 168 | Quick start guide |
| **TOTAL** | **72K** | **2,381** | **Complete reference** |

## One-Minute Overview

**ACP Rust SDK** provides two connection types for the Agent Client Protocol:
- **ClientSideConnection**: Client → Agent communication
- **AgentSideConnection**: Agent → Client communication

Both are generic and trait-based with automatic JSON-RPC routing.

## Core Traits (Must Implement)

### Client Trait (10 methods)
```rust
#[async_trait::async_trait(?Send)]
pub trait Client {
    // REQUIRED
    async fn request_permission(...) -> Result<...>
    async fn session_notification(...) -> Result<()>
    
    // OPTIONAL (return method_not_found by default)
    async fn read_text_file(...)
    async fn write_text_file(...)
    async fn create_terminal(...)
    async fn terminal_output(...)
    async fn kill_terminal(...)
    async fn release_terminal(...)
    async fn wait_for_terminal_exit(...)
    async fn ext_method(...)
    async fn ext_notification(...)
}
```

### Agent Trait (11 methods)
```rust
#[async_trait::async_trait(?Send)]
pub trait Agent {
    // REQUIRED
    async fn initialize(...) -> Result<...>
    async fn authenticate(...) -> Result<...>
    async fn new_session(...) -> Result<...>
    async fn prompt(...) -> Result<...>
    async fn cancel(...) -> Result<()>
    
    // OPTIONAL
    async fn load_session(...)
    async fn set_session_mode(...)
    async fn list_sessions(...)
    async fn fork_session(...) // unstable
    async fn resume_session(...) // unstable
    async fn close_session(...) // unstable
    async fn set_session_config_option(...)
    async fn ext_method(...)
    async fn ext_notification(...)
}
```

## Minimal Client Implementation

```rust
#[derive(Clone)]
struct MyClient;

#[async_trait::async_trait(?Send)]
impl Client for MyClient {
    async fn request_permission(&self, args: RequestPermissionRequest) 
        -> Result<RequestPermissionResponse> {
        Ok(RequestPermissionResponse::new(RequestPermissionOutcome::Approved))
    }
    
    async fn session_notification(&self, args: SessionNotification) 
        -> Result<()> {
        println!("{:?}", args.update);
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        let (conn, io_task) = ClientSideConnection::new(
            MyClient,
            outgoing_bytes,
            incoming_bytes,
            |fut| tokio::task::spawn_local(fut),
        );
        tokio::task::spawn_local(io_task);
        
        conn.initialize(InitializeRequest::new(ProtocolVersion::V1)).await?;
        let session = conn.new_session(NewSessionRequest::new(cwd)).await?;
        conn.prompt(PromptRequest::new(session.session_id, prompts)).await?;
        
        Ok::<_, anyhow::Error>(())
    }).await
}
```

## Minimal Agent Implementation

```rust
#[derive(Clone)]
struct MyAgent;

#[async_trait::async_trait(?Send)]
impl Agent for MyAgent {
    async fn initialize(&self, args: InitializeRequest) 
        -> Result<InitializeResponse> {
        Ok(InitializeResponse::new(args.protocol_version))
    }
    
    async fn authenticate(&self, _args: AuthenticateRequest) 
        -> Result<AuthenticateResponse> {
        Ok(AuthenticateResponse::default())
    }
    
    async fn new_session(&self, _args: NewSessionRequest) 
        -> Result<NewSessionResponse> {
        Ok(NewSessionResponse::new("session-1"))
    }
    
    async fn prompt(&self, args: PromptRequest) 
        -> Result<PromptResponse> {
        println!("Prompt: {:?}", args.prompt);
        Ok(PromptResponse::new(StopReason::EndTurn))
    }
    
    async fn cancel(&self, _args: CancelNotification) -> Result<()> {
        Ok(())
    }
}
```

## Key Methods

### ClientSideConnection (Implements Agent trait)
```rust
async fn initialize(&self, args: InitializeRequest) -> Result<InitializeResponse>
async fn authenticate(&self, args: AuthenticateRequest) -> Result<AuthenticateResponse>
async fn new_session(&self, args: NewSessionRequest) -> Result<NewSessionResponse>
async fn load_session(&self, args: LoadSessionRequest) -> Result<LoadSessionResponse>
async fn list_sessions(&self, args: ListSessionsRequest) -> Result<ListSessionsResponse>
async fn prompt(&self, args: PromptRequest) -> Result<PromptResponse>
async fn cancel(&self, args: CancelNotification) -> Result<()>
async fn set_session_mode(&self, args: SetSessionModeRequest) -> Result<SetSessionModeResponse>
async fn set_session_config_option(&self, args: SetSessionConfigOptionRequest) -> Result<SetSessionConfigOptionResponse>
pub fn subscribe(&self) -> StreamReceiver  // For debugging
```

### AgentSideConnection (Implements Client trait)
```rust
async fn request_permission(&self, args: RequestPermissionRequest) -> Result<RequestPermissionResponse>
async fn session_notification(&self, args: SessionNotification) -> Result<()>
async fn read_text_file(&self, args: ReadTextFileRequest) -> Result<ReadTextFileResponse>
async fn write_text_file(&self, args: WriteTextFileRequest) -> Result<WriteTextFileResponse>
async fn create_terminal(&self, args: CreateTerminalRequest) -> Result<CreateTerminalResponse>
async fn terminal_output(&self, args: TerminalOutputRequest) -> Result<TerminalOutputResponse>
async fn kill_terminal(&self, args: KillTerminalRequest) -> Result<KillTerminalResponse>
async fn release_terminal(&self, args: ReleaseTerminalRequest) -> Result<ReleaseTerminalResponse>
async fn wait_for_terminal_exit(&self, args: WaitForTerminalExitRequest) -> Result<WaitForTerminalExitResponse>
pub fn subscribe(&self) -> StreamReceiver  // For debugging
```

## Message Format

**Line-delimited JSON-RPC 2.0 over stdio**:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
{"jsonrpc":"2.0","id":1,"result":{...}}
{"jsonrpc":"2.0","method":"session/update","params":{...}}
```

Each message ends with `\n` (newline).

## Session Lifecycle

```
Client                          Agent
  |                              |
  |------ initialize()---------->|
  |<----- InitializeResponse ----|
  |                              |
  |------ new_session()--------->|
  |<----- NewSessionResponse -----|
  |                              |
  |------ prompt() ------------->|
  |<----- (streaming updates)---|  (session_notification)
  |<----- PromptResponse --------|
  |                              |
  |------ prompt() ------------->|  (next prompt)
  |                              |
  |------ cancel() ------------->|  (if needed)
  |<----- PromptResponse --------|
  |                              |
```

## Critical Patterns

### 1. LocalSet Required (Tokio)
```rust
let local_set = tokio::task::LocalSet::new();
local_set.run_until(async { ... }).await
```

### 2. I/O Task Must Be Spawned
```rust
let (conn, io_task) = ClientSideConnection::new(...);
tokio::task::spawn_local(io_task);  // NOT optional!
```

### 3. Builder Pattern for Requests
```rust
InitializeRequest::new(version)
    .client_info(Implementation::new("name", "1.0"))
    .client_capabilities(caps)
```

### 4. Async Trait with !Send
```rust
#[async_trait::async_trait(?Send)]
impl Trait for Type {
    async fn method(&self) -> Result<...> { }
}
```

### 5. Error Handling
```rust
Err(Error::invalid_params().data("details"))
Err(Error::method_not_found())
Err(Error::internal_error())
```

## Request Types Summary

| Request | Response | Purpose |
|---------|----------|---------|
| InitializeRequest | InitializeResponse | Negotiate protocol |
| AuthenticateRequest | AuthenticateResponse | Authenticate client |
| NewSessionRequest | NewSessionResponse | Create session |
| LoadSessionRequest | LoadSessionResponse | Load existing session |
| PromptRequest | PromptResponse | Send user input |
| SetSessionModeRequest | SetSessionModeResponse | Change mode |
| ListSessionsRequest | ListSessionsResponse | List sessions |
| SetSessionConfigOptionRequest | SetSessionConfigOptionResponse | Configure session |

## Notification Types

| From Agent | Purpose |
|-----------|---------|
| SessionNotification | Streaming updates (tool calls, messages, etc.) |
| CancelNotification | Cancel ongoing work |

## Content Block Types

```rust
pub enum ContentBlock {
    Text(TextContent),           // text: String
    Image(ImageContent),         // mime_type, data
    Audio(AudioContent),         // mime_type, data
    Resource(ResourceContent),   // mime_type, data
    ResourceLink(ResourceLink),  // uri: String
}
```

## StopReason Enum

```rust
pub enum StopReason {
    EndTurn,      // Normal completion
    ToolCall,     // Stopped to execute tool
    Cancelled,    // User cancelled
}
```

## Common SessionUpdate Variants

```rust
pub enum SessionUpdate {
    AgentMessageChunk(ContentChunk),    // Message fragment
    ToolCall(ToolCall),                 // Tool invocation
    ToolCallUpdate(ToolCallUpdate),     // Tool progress
    ToolResult(ToolResult),             // Tool output
    PermissionRequest(...),             // Ask permission
    StatusUpdate(...),                  // Progress update
    // ... and more
}
```

## Error Constructors

```rust
Error::invalid_params()
Error::method_not_found()
Error::internal_error()
Error::internal_error().data(serde_json::json!({"key": "value"}))
```

## Dependencies

```toml
[dependencies]
agent-client-protocol = "0.10"
tokio = { version = "1.48", features = ["full"] }
async-trait = "0.1"
serde_json = "1.0"
futures = "0.3"
```

## Feature Flags

```rust
#[cfg(feature = "unstable_session_fork")]
async fn fork_session(...) -> Result<...>

#[cfg(feature = "unstable_session_resume")]
async fn resume_session(...) -> Result<...>

#[cfg(feature = "unstable_session_model")]
async fn set_session_model(...) -> Result<...>
```

## Stream Monitoring (Debugging)

```rust
let mut receiver = conn.subscribe();
while let Ok(msg) = receiver.recv().await {
    match msg.direction {
        StreamMessageDirection::Incoming => println!("← {:?}", msg.message),
        StreamMessageDirection::Outgoing => println!("→ {:?}", msg.message),
    }
}
```

## Subprocess Example

```rust
let mut child = tokio::process::Command::new("/path/to/agent")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .kill_on_drop(true)
    .spawn()?;

let outgoing = child.stdin.take().unwrap().compat_write();
let incoming = child.stdout.take().unwrap().compat();

let (conn, io_task) = ClientSideConnection::new(
    client_impl,
    outgoing,
    incoming,
    |fut| tokio::task::spawn_local(fut),
);
```

## Important Files to Read

1. **Start**: ACP_ANALYSIS_INDEX.md
2. **Architecture**: ACP_RUST_SDK_DEEPDIVE.md
3. **Types**: ACP_TYPES_REFERENCE.md
4. **Examples**: ACP_USAGE_PATTERNS.md

## Quick Links

- Repository: https://github.com/agentclientprotocol/rust-sdk
- Docs: https://docs.rs/agent-client-protocol
- Spec: https://agentclientprotocol.com

---

**Version**: SDK 0.10.2 | Schema 0.11.2 | Created: March 2025
