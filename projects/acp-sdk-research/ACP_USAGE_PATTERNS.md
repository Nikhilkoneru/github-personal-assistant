# ACP Rust SDK - Usage Patterns & Implementation Guide

## COMPLETE CLIENT IMPLEMENTATION EXAMPLE

```rust
use agent_client_protocol::{self as acp, Agent as _, Client as _};
use std::sync::Arc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Implement the Client trait to receive requests from agent
#[derive(Clone)]
struct MyClient;

#[async_trait::async_trait(?Send)]
impl acp::Client for MyClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        println!("Permission requested for tool: {}", args.tool);
        // In real app, show dialog to user
        Ok(acp::RequestPermissionResponse::new(acp::RequestPermissionOutcome::Approved))
    }

    async fn session_notification(
        &self,
        args: acp::SessionNotification,
    ) -> acp::Result<()> {
        match args.update {
            acp::SessionUpdate::AgentMessageChunk(chunk) => {
                match chunk.content {
                    acp::ContentBlock::Text(text) => println!("Agent: {}", text.text),
                    acp::ContentBlock::Image(_) => println!("Agent: <image>"),
                    _ => println!("Agent: <content>"),
                }
            }
            acp::SessionUpdate::ToolCall(tool_call) => {
                println!("Tool call: {} with input: {}", tool_call.name, tool_call.input);
            }
            _ => {}
        }
        Ok(())
    }

    async fn read_text_file(
        &self,
        args: acp::ReadTextFileRequest,
    ) -> acp::Result<acp::ReadTextFileResponse> {
        let content = std::fs::read_to_string(&args.path)
            .map_err(|_| acp::Error::internal_error())?;
        Ok(acp::ReadTextFileResponse::new(content))
    }

    async fn write_text_file(
        &self,
        args: acp::WriteTextFileRequest,
    ) -> acp::Result<acp::WriteTextFileResponse> {
        std::fs::write(&args.path, &args.content)
            .map_err(|_| acp::Error::internal_error())?;
        Ok(acp::WriteTextFileResponse::default())
    }

    // ... implement other methods or return method_not_found()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Spawn agent subprocess
    let mut child = tokio::process::Command::new("/path/to/agent")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;

    let outgoing = child.stdin.take().unwrap().compat_write();
    let incoming = child.stdout.take().unwrap().compat();

    // 2. Use LocalSet for !Send futures
    let local_set = tokio::task::LocalSet::new();
    local_set
        .run_until(async move {
            // 3. Create connection with LocalSet spawner
            let (conn, io_task) = acp::ClientSideConnection::new(
                MyClient,
                outgoing,
                incoming,
                |fut| { tokio::task::spawn_local(fut); },
            );

            // 4. IMPORTANT: Spawn I/O task
            tokio::task::spawn_local(io_task);

            // 5. Initialize protocol
            conn.initialize(
                acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                    .client_info(acp::Implementation::new("my-client", "1.0.0"))
            ).await?;

            // 6. Create session
            let session_response = conn.new_session(
                acp::NewSessionRequest::new(std::env::current_dir()?)
            ).await?;
            let session_id = session_response.session_id;

            // 7. Send prompts
            let prompt_response = conn.prompt(
                acp::PromptRequest::new(
                    session_id,
                    vec!["What files are in this directory?".into()],
                )
            ).await?;

            println!("Stop reason: {:?}", prompt_response.stop_reason);

            Ok::<_, anyhow::Error>(())
        })
        .await?;

    drop(child);
    Ok(())
}
```

---

## COMPLETE AGENT IMPLEMENTATION EXAMPLE

```rust
use agent_client_protocol::{self as acp, Agent as _, Client as _};
use std::cell::Cell;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

#[derive(Clone)]
struct MyAgent {
    session_counter: std::sync::Arc<std::sync::Mutex<u64>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Agent for MyAgent {
    async fn initialize(
        &self,
        args: acp::InitializeRequest,
    ) -> acp::Result<acp::InitializeResponse> {
        println!("Client initialized: {:?}", args);
        Ok(acp::InitializeResponse::new(args.protocol_version)
            .agent_info(acp::Implementation::new("my-agent", "1.0.0")))
    }

    async fn authenticate(
        &self,
        _args: acp::AuthenticateRequest,
    ) -> acp::Result<acp::AuthenticateResponse> {
        Ok(acp::AuthenticateResponse::default())
    }

    async fn new_session(
        &self,
        args: acp::NewSessionRequest,
    ) -> acp::Result<acp::NewSessionResponse> {
        let mut counter = self.session_counter.lock().unwrap();
        *counter += 1;
        let session_id = format!("session-{}", counter);
        println!("New session created: {} in {:?}", session_id, args.cwd);
        Ok(acp::NewSessionResponse::new(session_id))
    }

    async fn prompt(
        &self,
        args: acp::PromptRequest,
    ) -> acp::Result<acp::PromptResponse> {
        println!("Prompt received for session {}", args.session_id);
        for content in args.prompt {
            match content {
                acp::ContentBlock::Text(text) => {
                    println!("User: {}", text.text);
                }
                _ => println!("User: <non-text content>"),
            }
        }
        Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
    }

    async fn cancel(
        &self,
        args: acp::CancelNotification,
    ) -> acp::Result<()> {
        println!("Cancel requested for session {}", args.session_id);
        Ok(())
    }

    async fn set_session_mode(
        &self,
        args: acp::SetSessionModeRequest,
    ) -> acp::Result<acp::SetSessionModeResponse> {
        println!("Mode set to: {}", args.mode);
        Ok(acp::SetSessionModeResponse::default())
    }

    // ... implement other methods
}

#[tokio::main]
async fn main() -> acp::Result<()> {
    env_logger::init();

    let outgoing = tokio::io::stdout().compat_write();
    let incoming = tokio::io::stdin().compat();

    let local_set = tokio::task::LocalSet::new();
    local_set
        .run_until(async move {
            let (conn, io_task) = acp::AgentSideConnection::new(
                MyAgent {
                    session_counter: std::sync::Arc::new(std::sync::Mutex::new(0)),
                },
                outgoing,
                incoming,
                |fut| { tokio::task::spawn_local(fut); },
            );

            // Handle I/O
            io_task.await
        })
        .await
}
```

---

## SENDING SESSION NOTIFICATIONS FROM AGENT

```rust
// Agent needs to send updates back to client
// Use AgentSideConnection::session_notification() which implements Client trait

async fn stream_agent_output(
    client_conn: &acp::AgentSideConnection,
    session_id: acp::SessionId,
    text: &str,
) -> acp::Result<()> {
    // Send text chunk notification
    client_conn.session_notification(
        acp::SessionNotification::new(
            session_id,
            acp::SessionUpdate::AgentMessageChunk(
                acp::ContentChunk::new(
                    acp::ContentBlock::Text(acp::TextContent::new(text))
                )
            ),
        )
    ).await
}
```

---

## MONITORING WITH STREAM BROADCASTING

```rust
async fn monitor_connection(mut receiver: acp::StreamReceiver) {
    while let Ok(message) = receiver.recv().await {
        match message.direction {
            acp::StreamMessageDirection::Incoming => {
                match message.message {
                    acp::StreamMessageContent::Request { id, method, params } => {
                        eprintln!("← Request [{}] {}", id, method);
                        if let Some(p) = params {
                            eprintln!("  Params: {}", p);
                        }
                    }
                    acp::StreamMessageContent::Response { id, result } => {
                        eprintln!("← Response [{}]", id);
                        match result {
                            Ok(Some(v)) => eprintln!("  Result: {}", v),
                            Ok(None) => eprintln!("  Result: null"),
                            Err(e) => eprintln!("  Error: {}", e.message),
                        }
                    }
                    acp::StreamMessageContent::Notification { method, params } => {
                        eprintln!("← Notification {}", method);
                        if let Some(p) = params {
                            eprintln!("  Params: {}", p);
                        }
                    }
                }
            }
            acp::StreamMessageDirection::Outgoing => {
                // Similar for outgoing
            }
        }
    }
}

// Usage:
let mut receiver = conn.subscribe();
tokio::task::spawn_local(monitor_connection(receiver));
```

---

## HANDLING CAPABILITY NEGOTIATION

```rust
async fn initialize_with_capabilities(
    conn: &acp::ClientSideConnection,
) -> acp::Result<acp::InitializeResponse> {
    let req = acp::InitializeRequest::new(acp::ProtocolVersion::V1)
        .client_info(
            acp::Implementation::new("my-client", "1.0.0")
                .title("My Custom Client")
        )
        // Advertise what we support
        .client_capabilities(
            acp::ClientCapabilities::new()
                .fs_read_text_file(true)
                .fs_write_text_file(true)
                .terminal(true)
        );

    let resp = conn.initialize(req).await?;
    
    // Check agent capabilities
    if let Some(caps) = &resp.agent_capabilities {
        println!("Agent supports loadSession: {}", caps.supports_load_session);
        println!("Agent supports fork: {}", caps.session_capabilities.fork);
    }

    Ok(resp)
}
```

---

## ERROR HANDLING PATTERNS

```rust
use agent_client_protocol::Error;

// Creating errors
fn my_operation() -> acp::Result<String> {
    Err(Error::invalid_params().data("Expected path parameter"))
}

// Handling errors
match conn.prompt(request).await {
    Ok(response) => {
        println!("Success: {:?}", response.stop_reason);
    }
    Err(err) => {
        eprintln!("Error [{}]: {}", err.code, err.message);
        if let Some(data) = err.data {
            eprintln!("Data: {}", data);
        }
    }
}
```

---

## LOADING SESSIONS WITH HISTORY REPLAY

```rust
async fn load_and_replay(
    conn: &acp::ClientSideConnection,
    session_id: &acp::SessionId,
) -> acp::Result<()> {
    // When you call load_session, agent will stream history back
    // as SessionNotification messages to your Client::session_notification()
    
    let response = conn.load_session(
        acp::LoadSessionRequest::new(session_id.clone())
    ).await?;
    
    // By this point, all history has been delivered to your
    // Client::session_notification() callback
    
    println!("Session loaded, history replayed");
    Ok(())
}
```

---

## SETTING SESSION MODES

```rust
async fn switch_mode(
    conn: &acp::ClientSideConnection,
    session_id: &acp::SessionId,
    mode: &str,
) -> acp::Result<()> {
    let response = conn.set_session_mode(
        acp::SetSessionModeRequest::new(
            session_id.clone(),
            mode.to_string(),
        )
    ).await?;

    println!("Mode set successfully");
    Ok(())
}
```

---

## HANDLING TERMINAL OPERATIONS

```rust
async fn run_terminal_command(
    client_conn: &acp::AgentSideConnection,
    cmd: &str,
) -> acp::Result<()> {
    // Agent requests terminal creation from client
    let create_resp = client_conn.create_terminal(
        acp::CreateTerminalRequest::new(cmd)
    ).await?;
    let term_id = create_resp.terminal_id;

    // Poll for output
    loop {
        let output_resp = client_conn.terminal_output(
            acp::TerminalOutputRequest::new(term_id.clone())
        ).await?;
        
        println!("{}", output_resp.output);
        
        if let Some(exit_code) = output_resp.exit_code {
            println!("Exit code: {}", exit_code);
            break;
        }
        
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    // Release terminal
    client_conn.release_terminal(
        acp::ReleaseTerminalRequest::new(term_id)
    ).await?;

    Ok(())
}
```

---

## EXTENSION METHODS (CUSTOM FUNCTIONALITY)

```rust
// Client receiving custom method from agent
#[async_trait::async_trait(?Send)]
impl acp::Client for MyClient {
    async fn ext_method(&self, args: acp::ExtRequest) -> acp::Result<acp::ExtResponse> {
        match args.method.as_str() {
            "my.company/ping" => {
                Ok(acp::ExtResponse::new(
                    serde_json::to_raw_value(&serde_json::json!({"response": "pong"}))?.into()
                ))
            }
            _ => Err(acp::Error::method_not_found()),
        }
    }

    async fn ext_notification(&self, args: acp::ExtNotification) -> acp::Result<()> {
        eprintln!("Custom notification: {}", args.method);
        Ok(())
    }
}

// Agent calling custom method on client
async fn call_custom_method(
    client_conn: &acp::AgentSideConnection,
) -> acp::Result<()> {
    let response: acp::ExtResponse = client_conn.ext_method(
        acp::ExtRequest::new(
            "my.company/ping",
            serde_json::to_raw_value(&serde_json::json!({}))?.into(),
        )
    ).await?;

    println!("Response: {}", response.result);
    Ok(())
}
```

---

## CRITICAL PATTERNS TO REMEMBER

### 1. LocalSet is Required
```rust
let local_set = tokio::task::LocalSet::new();
local_set.run_until(async {
    // All ACP code here
}).await
```

### 2. I/O Task Must Be Spawned
```rust
let (conn, io_task) = ClientSideConnection::new(...);
tokio::task::spawn_local(io_task);  // NOT optional!
```

### 3. Async Trait Usage
```rust
#[async_trait::async_trait(?Send)]  // Note: ?Send = !Send futures
impl Client for MyType {
    async fn my_method(&self, ...) -> Result<...> { ... }
}
```

### 4. Builder Pattern for Requests
```rust
InitializeRequest::new(version)
    .client_info(impl)
    .client_capabilities(caps)
```

### 5. Streaming Notifications
```rust
// Notifications arrive asynchronously during prompt
while let Ok(msg) = recv.recv().await {
    // Handle incoming messages
}
```

### 6. Error Handling
```rust
Err(Error::internal_error().data("details"))
Err(Error::method_not_found())
Err(Error::invalid_params())
```

