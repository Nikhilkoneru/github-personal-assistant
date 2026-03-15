# ACP Rust SDK - Comprehensive Deep-Dive

## 1. CRATE STRUCTURE

### Package Information
- **Name**: `agent-client-protocol`
- **Version**: `0.10.2`
- **Edition**: 2024 (Rust)
- **License**: Apache-2.0
- **Repository**: https://github.com/agentclientprotocol/rust-sdk

### Dependencies
**Runtime Dependencies:**
- `agent-client-protocol-schema` (=0.11.2) - Core protocol definitions
- `anyhow` (1.0) - Error handling
- `async-broadcast` (0.7) - Async broadcasting for stream messages
- `async-trait` (0.1) - Async trait support
- `derive_more` (2) - Derive macros
- `futures` (0.3.31) - Async utilities
- `log` (0.4) - Logging

**Dev Dependencies:**
- `env_logger` (0.11)
- `futures-util` (0.3)
- `piper` (0.2)
- `pretty_assertions` (1)
- `rustyline` (17) - REPL support for examples
- `tokio` (1.48) - Async runtime
- `tokio-util` (0.7) - Tokio utilities

### Module Hierarchy
```
src/
├── lib.rs              (703 lines) - Main module exports and connection types
├── client.rs           (260 lines) - Client trait definition
├── agent.rs            (347 lines) - Agent trait definition
├── rpc.rs              (367 lines) - Low-level RPC connection handling
├── stream_broadcast.rs (300 lines) - Stream message broadcasting for debugging
└── rpc_tests.rs        (919 lines) - Integration tests

examples/
├── client.rs           - Example client connecting to agent via subprocess
└── agent.rs            - Example agent listening on stdio
```

### Features
- `unstable_auth_methods`
- `unstable_cancel_request`
- `unstable_session_fork`
- `unstable_session_model`
- `unstable_session_resume`
- `unstable_session_usage`
- `unstable_session_close`
- `unstable_message_id`
- `unstable_boolean_config`

---

## 2. CORE TYPES (Defined in agent-client-protocol-schema)

The SDK re-exports all types from the schema crate. Key types include:

### Session Management Types

**NewSessionRequest**
- Initiates a new conversation session
- Contains working directory (`cwd`)
- Builder methods for configuration

**NewSessionResponse**
- Returns unique `session_id: SessionId`

**LoadSessionRequest**
- Loads/resumes an existing session
- Contains `session_id`
- Agent streams history back via notifications

**LoadSessionResponse**
- Confirms session loaded successfully

**ListSessionsRequest/Response**
- Lists existing sessions (unstable feature)

**ForkSessionRequest/Response** (unstable_session_fork)
- Creates new session from existing one with same history

**ResumeSessionRequest/Response** (unstable_session_resume)
- Resumes session without replaying message history

**CloseSessionRequest/Response** (unstable_session_close)
- Terminates and frees session resources

### Prompt/Interaction Types

**PromptRequest**
- `session_id: SessionId`
- `prompt: Vec<ContentBlock>` - User messages with optional context (files, images, etc.)

**PromptResponse**
- `stop_reason: StopReason` - Why the prompt turn ended

**StopReason** (Enum)
- `EndTurn` - Normal completion
- `ToolCall` - Stopped to execute tool
- `Cancelled` - User cancelled via session/cancel notification

**CancelNotification**
- `session_id: SessionId`
- Signals agent to stop current work

### Content Block Types

**ContentBlock** (Enum)
- `Text(TextContent)` - Plain text content
- `Image(ImageContent)` - Image with MIME type and data
- `Audio(AudioContent)` - Audio with MIME type and data
- `Resource(ResourceContent)` - Binary data resource
- `ResourceLink(ResourceLink)` - URL/URI reference to external resource

**TextContent**
- `text: String`

**ImageContent**
- `mime_type: String`
- `data: Vec<u8>` or Base64-encoded

**ResourceContent**
- `mime_type: String`
- `data: Vec<u8>`

**ResourceLink**
- `uri: String`

### Session Update Types

**SessionNotification**
- `session_id: SessionId`
- `update: SessionUpdate` - Streaming update from agent

**SessionUpdate** (Enum - All variants)
- `AgentMessageChunk(ContentChunk)` - Part of agent's response
- `ToolCall(ToolCall)` - Agent wants to call a tool
- `ToolCallUpdate(ToolCallUpdate)` - Progress on tool execution
- `ToolResult(ToolResult)` - Tool execution result
- `PromptResult(PromptResult)` - Final result of prompt
- Many more (permission requests, mode changes, etc.)

**ContentChunk**
- `content: ContentBlock` - Single piece of agent output

**ToolCall**
- `id: String` - Unique identifier
- `name: String` - Tool name
- `input: serde_json::Value` - Tool parameters (JSON)

**ToolCallUpdate** (Enum)
- `UpdateProgress { text: String }` - Progress message
- `UpdatePartialInput { partial: String }` - Partial input update

**ToolResult**
- `tool_call_id: String` - Links back to ToolCall
- `result: Vec<ContentBlock>` - Tool output

### Permission & Interaction Types

**RequestPermissionRequest**
- `tool: String` - Tool being invoked
- `input: serde_json::Value` - Tool input
- `other_params: Map<String, Value>` - Additional context

**RequestPermissionResponse**
- `outcome: RequestPermissionOutcome`

**RequestPermissionOutcome** (Enum)
- `Approved`
- `Denied`
- `Cancelled` - User cancelled the prompt turn

### Initialization & Capabilities

**InitializeRequest**
- `protocol_version: ProtocolVersion`
- `client_info: Implementation` (optional)
- `client_capabilities: ClientCapabilities` (optional)

**InitializeResponse**
- `protocol_version: ProtocolVersion`
- `agent_info: Implementation`
- `agent_capabilities: AgentCapabilities` (optional)
- `available_authentication_methods: Vec<AuthMethod>` (optional)

**Implementation**
- `name: String`
- `version: String`
- `title: String` (optional)

**ClientCapabilities** (Bitflags)
- `fs.readTextFile` - Can read files
- `fs.writeTextFile` - Can write files
- `terminal` - Can create terminals
- Custom capabilities via extensibility

**AgentCapabilities**
- `supports_loadSession: bool`
- `supports_setSessionMode: bool`
- `sessionCapabilities` - fork, resume, close, list support
- Custom capabilities

### File System Types

**ReadTextFileRequest**
- `path: PathBuf`

**ReadTextFileResponse**
- `content: String`

**WriteTextFileRequest**
- `path: PathBuf`
- `content: String`

**WriteTextFileResponse**
- Empty by default

### Terminal Types

**CreateTerminalRequest**
- `command: String`
- `args: Vec<String>` (optional)
- `cwd: PathBuf` (optional)

**CreateTerminalResponse**
- `terminal_id: TerminalId`

**TerminalOutputRequest**
- `terminal_id: TerminalId`

**TerminalOutputResponse**
- `output: String` - Current terminal content
- `exit_code: Option<i32>` - If exited

**WaitForTerminalExitRequest**
- `terminal_id: TerminalId`

**WaitForTerminalExitResponse**
- `exit_code: i32`

**KillTerminalRequest**
- `terminal_id: TerminalId`

**KillTerminalResponse**
- Empty

**ReleaseTerminalRequest**
- `terminal_id: TerminalId`

**ReleaseTerminalResponse**
- Empty

### Extensibility Types

**ExtRequest**
- `method: String` - Custom method name
- `params: Box<RawValue>` - JSON-RPC params

**ExtResponse**
- `result: Box<RawValue>` - JSON-RPC result

**ExtNotification**
- `method: String`
- `params: Box<RawValue>`

---

## 3. CLIENT IMPLEMENTATION

### ClientSideConnection

Located in `lib.rs`, lines 19-225.

```rust
pub struct ClientSideConnection {
    conn: RpcConnection<ClientSide, AgentSide>,
}

impl ClientSideConnection {
    /// Creates a new client-side connection
    pub fn new(
        client: impl MessageHandler<ClientSide> + 'static,
        outgoing_bytes: impl Unpin + AsyncWrite,
        incoming_bytes: impl Unpin + AsyncRead,
        spawn: impl Fn(LocalBoxFuture<'static, ()>) + 'static,
    ) -> (Self, impl Future<Output = Result<()>>) { ... }
    
    /// Subscribe to stream updates for debugging
    pub fn subscribe(&self) -> StreamReceiver { ... }
}
```

### Methods Exposed by ClientSideConnection

ClientSideConnection implements the `Agent` trait, providing these methods:

```rust
// Initialization
async fn initialize(&self, args: InitializeRequest) -> Result<InitializeResponse>
async fn authenticate(&self, args: AuthenticateRequest) -> Result<AuthenticateResponse>

// Session Management
async fn new_session(&self, args: NewSessionRequest) -> Result<NewSessionResponse>
async fn load_session(&self, args: LoadSessionRequest) -> Result<LoadSessionResponse>
async fn list_sessions(&self, args: ListSessionsRequest) -> Result<ListSessionsResponse>
async fn fork_session(&self, args: ForkSessionRequest) -> Result<ForkSessionResponse> // unstable
async fn resume_session(&self, args: ResumeSessionRequest) -> Result<ResumeSessionResponse> // unstable
async fn close_session(&self, args: CloseSessionRequest) -> Result<CloseSessionResponse> // unstable

// Session Control
async fn set_session_mode(&self, args: SetSessionModeRequest) -> Result<SetSessionModeResponse>
async fn set_session_model(&self, args: SetSessionModelRequest) -> Result<SetSessionModelResponse> // unstable
async fn set_session_config_option(&self, args: SetSessionConfigOptionRequest) -> Result<SetSessionConfigOptionResponse>

// Prompt Execution
async fn prompt(&self, args: PromptRequest) -> Result<PromptResponse>
async fn cancel(&self, args: CancelNotification) -> Result<()>

// Extensibility
async fn ext_method(&self, args: ExtRequest) -> Result<ExtResponse>
async fn ext_notification(&self, args: ExtNotification) -> Result<()>
```

### JSON-RPC Framing

Handled in `rpc.rs`. The SDK uses **line-delimited JSON-RPC 2.0** format:

- Messages are serialized as JSON
- Each message ends with a newline `\n`
- No message-length prefix or special framing

### Bidirectional Communication

The `RpcConnection<Local, Remote>` generic handles both directions:

**Client → Agent** (Outgoing):
- Requests (method calls expecting responses)
- Notifications (one-way messages)

**Agent → Client** (Incoming):
- Requests (client must respond)
- Notifications (fire-and-forget)
- Responses to our requests

See `rpc.rs` lines 33-38 and 112-152 for request/notify implementation.

### Streaming Notifications During Prompt

When `prompt()` is called:
1. Sends PromptRequest to agent
2. Agent streams SessionNotification updates via notifications
3. Client receives via `session_notification()` callback
4. When complete, agent sends PromptResponse
5. Any new PromptResponse ends the turn

See `client.rs` lines 35-46 for the `session_notification()` callback signature.

---

## 4. SERVER-TO-CLIENT REQUEST HANDLING

### Client Trait

Located in `client.rs`. Must be implemented to receive agent requests:

```rust
#[async_trait::async_trait(?Send)]
pub trait Client {
    /// Agent requesting permission for tool call
    async fn request_permission(
        &self,
        args: RequestPermissionRequest,
    ) -> Result<RequestPermissionResponse>;

    /// Agent sending session updates (notifications)
    async fn session_notification(&self, args: SessionNotification) -> Result<()>;

    // File system access (if advertised in capabilities)
    async fn read_text_file(&self, _args: ReadTextFileRequest) -> Result<ReadTextFileResponse> { ... }
    async fn write_text_file(&self, _args: WriteTextFileRequest) -> Result<WriteTextFileResponse> { ... }

    // Terminal access (if advertised in capabilities)
    async fn create_terminal(&self, _args: CreateTerminalRequest) -> Result<CreateTerminalResponse> { ... }
    async fn terminal_output(&self, _args: TerminalOutputRequest) -> Result<TerminalOutputResponse> { ... }
    async fn terminal_kill(&self, _args: KillTerminalRequest) -> Result<KillTerminalResponse> { ... }
    async fn terminal_release(&self, _args: ReleaseTerminalRequest) -> Result<ReleaseTerminalResponse> { ... }
    async fn wait_for_terminal_exit(&self, _args: WaitForTerminalExitRequest) -> Result<WaitForTerminalExitResponse> { ... }

    // Extensibility
    async fn ext_method(&self, _args: ExtRequest) -> Result<ExtResponse> { ... }
    async fn ext_notification(&self, _args: ExtNotification) -> Result<()> { ... }
}
```

### Implementation Pattern

The RPC layer automatically:
1. Deserializes incoming JSON-RPC requests by method name
2. Calls appropriate trait method on your Client impl
3. Serializes response and sends back

Example from `lib.rs` lines 307-348:
```rust
impl<T: Client> MessageHandler<ClientSide> for T {
    async fn handle_request(&self, request: AgentRequest) -> Result<ClientResponse> {
        match request {
            AgentRequest::RequestPermissionRequest(args) => {
                let response = self.request_permission(args).await?;
                Ok(ClientResponse::RequestPermissionResponse(response))
            }
            AgentRequest::WriteTextFileRequest(args) => { ... }
            // ... etc
        }
    }
}
```

### Traits & Callbacks Required

1. Implement `Client` trait
2. Pass to `ClientSideConnection::new()`
3. RPC layer handles request dispatching

---

## 5. SESSION LIFECYCLE IN THE SDK

### Creating a Session

```rust
// 1. Initialize connection
let (conn, io_task) = ClientSideConnection::new(my_client, outgoing, incoming, |fut| {
    tokio::task::spawn_local(fut);
});
tokio::task::spawn_local(io_task);

// 2. Call initialize() to negotiate protocol
conn.initialize(
    InitializeRequest::new(ProtocolVersion::V1)
        .client_info(Implementation::new("my-client", "1.0.0"))
).await?;

// 3. Create new session
let response = conn.new_session(
    NewSessionRequest::new(std::env::current_dir()?)
).await?;
let session_id = response.session_id;
```

### Loading a Session

```rust
// Load existing session
let response = conn.load_session(
    LoadSessionRequest::new(session_id)
).await?;

// Agent streams all history back via session_notification callbacks
// Client receives SessionUpdate::AgentMessageChunk, ToolCall, etc.
// These are delivered to client.session_notification() method

// After all history replayed, load_session returns
```

### Listing Sessions

```rust
let response = conn.list_sessions(ListSessionsRequest::new()).await?;
// Returns vector of session metadata
```

### Sending Prompts & Consuming Updates

```rust
// Send prompt request
let response = conn.prompt(
    PromptRequest::new(
        session_id,
        vec!["What is the weather?".into()]
    )
).await?;

// Agent immediately starts streaming updates via notifications:
// - SessionNotification with SessionUpdate variants flow to client.session_notification()
// - These are delivered asynchronously as received

// Once agent completes, returns PromptResponse with stop_reason
let stop_reason = response.stop_reason;
// StopReason::EndTurn -> Normal completion
// StopReason::ToolCall -> Stopped to execute tool
// StopReason::Cancelled -> User cancelled via cancel()
```

### Cancelling a Prompt

```rust
// While prompt() is awaiting:
conn.cancel(CancelNotification::new(session_id)).await?;

// Agent receives notification, cancels work, and:
// - Sends any pending session notifications
// - Responds to prompt() with StopReason::Cancelled
```

---

## 6. TRANSPORT LAYER

### Stdio Communication

The SDK **does NOT** handle subprocess spawning. The client/agent are responsible:

**Client Example (from `examples/client.rs` lines 107-127):**
```rust
let mut child = tokio::process::Command::new(program)
    .args(args.iter())
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .kill_on_drop(true)
    .spawn()?;

let outgoing = child.stdin.take().unwrap().compat_write();
let incoming = child.stdout.take().unwrap().compat();

let (conn, io_task) = ClientSideConnection::new(
    my_client,
    outgoing,
    incoming,
    |fut| { tokio::task::spawn_local(fut); }
);
```

**Agent Example (from `examples/agent.rs` lines 159-191):**
```rust
let outgoing = tokio::io::stdout().compat_write();
let incoming = tokio::io::stdin().compat();

let (conn, io_task) = AgentSideConnection::new(
    my_agent,
    outgoing,
    incoming,
    |fut| { tokio::task::spawn_local(fut); }
);

tokio::task::spawn_local(io_task); // Handle I/O
```

### JSON-RPC Message Framing Details

From `rpc.rs` lines 154-254:

**Outgoing** (lines 167-175):
```rust
let mut outgoing_line = Vec::new();
serde_json::to_writer(&mut outgoing_line, &JsonRpcMessage::wrap(&message))?;
log::trace!("send: {}", String::from_utf8_lossy(&outgoing_line));
outgoing_line.push(b'\n');  // Add newline terminator
outgoing_bytes.write_all(&outgoing_line).await.ok();
```

**Incoming** (lines 180-184):
```rust
let mut incoming_line = String::new();
loop {
    bytes_read = input_reader.read_line(&mut incoming_line).fuse();
    if bytes_read.map_err(Error::into_internal_error)? == 0 {
        break // EOF
    }
    log::trace!("recv: {}", &incoming_line);
    match serde_json::from_str::<RawIncomingMessage>(&incoming_line) { ... }
}
```

**Format**: Line-delimited JSON-RPC 2.0
- Each line is a complete JSON-RPC message
- No outer wrapper or length prefix
- Newline `\n` is the message delimiter
- Handles escaped forward slashes in method names (`\/` unescapes to `/`)

---

## 7. EXAMPLES

### Example Client (`examples/client.rs`)

**Key Features:**
- Spawns agent subprocess with stdio piping
- Implements `Client` trait (rejecting most capabilities)
- Handles `session_notification()` to display agent output
- Sends prompts interactively via readline
- Streams agent messages to stdout

**Usage:**
```bash
cargo build --example agent
cargo run --example client -- target/debug/examples/agent
```

**Session Lifecycle:**
```rust
1. Initialize with ProtocolVersion::V1
2. Create new session with working directory
3. Interactive prompt loop: readline → prompt() → display output
4. Exit on EOF
```

### Example Agent (`examples/agent.rs`)

**Key Features:**
- Listens on stdin/stdout
- Implements `Agent` trait
- Returns echo-like responses
- Sends responses via `session_notification()`
- Uses mpsc channel to queue updates

**Session Flow:**
```rust
impl Agent:
  initialize() → Accept protocol version
  new_session() → Create session with ID
  prompt() → Echo back user input as AgentMessageChunk
              Send notifications for each content block
              Return StopReason::EndTurn
  cancel() → Log and accept
```

---

## 8. ERROR HANDLING

### Error Type

From `agent-client-protocol-schema`:
```rust
pub struct Error {
    code: i32,
    message: String,
    data: Option<Value>,
}
```

### Creating Errors

**Common Error Constructors:**
```rust
Error::invalid_params()         // Invalid request params
Error::method_not_found()       // Unknown method
Error::internal_error()         // Server error
Error::internal_error().data(msg)  // With custom data
```

### Error Propagation

**In RPC Layer** (`rpc.rs` lines 154-254):
- JSON parse errors → log and continue
- Unknown method → send error response
- Serialization errors → internal error
- IO errors → propagate to caller

**In RPC Messages:**
```rust
// Request fails → send Response::Error with RequestId
pub enum Response<T: Response> {
    Result { id: RequestId, result: T },
    Error { id: RequestId, error: Error },
}
```

### Result Type

```rust
pub type Result<T> = std::result::Result<T, Error>;
```

Used throughout for async trait methods.

### Error Scenarios

1. **Protocol Version Mismatch** → Not advertised
2. **Unknown Session ID** → Method returns error
3. **File Not Found** → `read_text_file()` returns error
4. **Permission Denied** → `request_permission()` returns Denied
5. **Tool Execution Failed** → Returned as ToolResult
6. **Connection Lost** → IO future returns error

---

## 9. ADDITIONAL IMPLEMENTATION DETAILS

### MessageHandler Trait

Located in `rpc.rs` lines 328-338:

```rust
pub trait MessageHandler<Local: Side> {
    fn handle_request(
        &self,
        request: Local::InRequest,
    ) -> impl Future<Output = Result<Local::OutResponse>>;

    fn handle_notification(
        &self,
        notification: Local::InNotification,
    ) -> impl Future<Output = Result<()>>;
}
```

Implemented automatically for types implementing `Agent` or `Client` traits.

### Side Trait (Generic RPC)

Determines which types are In/Out for each side:

**ClientSide** (client receiving from agent):
```rust
impl Side for ClientSide {
    type InNotification = AgentNotification;
    type InRequest = AgentRequest;
    type OutResponse = ClientResponse;
}
```

**AgentSide** (agent receiving from client):
```rust
impl Side for AgentSide {
    type InRequest = ClientRequest;
    type InNotification = ClientNotification;
    type OutResponse = AgentResponse;
}
```

### Stream Message Broadcasting

For debugging/logging, use `conn.subscribe()`:

```rust
let mut receiver = conn.subscribe();
while let Ok(message) = receiver.recv().await {
    match message.direction {
        StreamMessageDirection::Incoming => println!("← {}", message.message),
        StreamMessageDirection::Outgoing => println!("→ {}", message.message),
    }
}
```

`StreamMessage` contains:
- `direction: StreamMessageDirection` (Incoming/Outgoing)
- `message: StreamMessageContent` (Request/Response/Notification)

---

## 10. KEY DESIGN PATTERNS

### 1. Dual-Sided Connection Types
- `ClientSideConnection` - For clients connecting to agents
- `AgentSideConnection` - For agents connecting to clients
- Both use same underlying `RpcConnection<Local, Remote>` generic

### 2. Trait-Based Callbacks
- Implement `Client` trait for server-to-client requests
- Implement `Agent` trait for client-to-agent requests
- RPC layer automatically dispatches by method name

### 3. Non-Blocking Async/Await
- All I/O is non-blocking async
- No `Send` requirement (uses `!Send` async traits and LocalSet)
- Spawn via provided closure to integrate with runtime

### 4. Generic Message Handler
- `MessageHandler<Side>` trait decouples RPC from business logic
- Automatic impl for `Agent` and `Client` types
- Enables type-safe request routing

### 5. Builder Pattern
- Request types use builders (e.g., `InitializeRequest::new().client_info(...)`)
- Fluent API for optional fields

---

## 11. CRITICAL ARCHITECTURAL NOTES

1. **LocalSet Required**: Futures are `!Send`. Must use `tokio::task::LocalSet`
   ```rust
   let local_set = tokio::task::LocalSet::new();
   local_set.run_until(async { ... }).await
   ```

2. **I/O Task Must Be Spawned**: `ClientSideConnection::new()` returns a future that must be spawned
   ```rust
   let (conn, io_task) = ClientSideConnection::new(...);
   tokio::task::spawn_local(io_task); // REQUIRED
   ```

3. **Linear Request/Response Matching**: Each request gets a unique ID, responses matched by ID
   ```rust
   AtomicI64 incremented for each outgoing request
   Responses matched by RequestId
   ```

4. **Notification Streaming**: `session/update` notifications arrive asynchronously during/after `prompt()`
   Delivered via `session_notification()` callback on Client trait

5. **Capability Negotiation**: Client should advertise capabilities in `InitializeRequest`
   Agent checks before making requests (e.g., only request permission if client supports it)

---

## REFACTORING NOTES FOR CUSTOM ACP CLIENT

If refactoring a custom ACP client to use this SDK:

1. **Replace custom JSON-RPC handling** with `RpcConnection<ClientSide, AgentSide>`
2. **Implement `Client` trait** for all incoming requests from agent
3. **Use `ClientSideConnection`** instead of custom connection class
4. **Replace subprocess spawn logic** with provided patterns
5. **Use provided `MessageHandler` dispatch** instead of custom routing
6. **Adopt builder pattern** for request construction
7. **Migrate to `async-trait`** if using custom traits
8. **Use stream broadcasting** for debugging instead of custom logging

Key simplifications:
- No custom JSON-RPC frame parsing needed
- No manual request ID management
- No custom error handling for protocol violations
- Automatic type-safe routing by method name

