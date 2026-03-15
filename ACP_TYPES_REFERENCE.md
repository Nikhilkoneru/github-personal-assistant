# ACP Rust SDK - Complete Type Reference

## CONNECTION TYPES

### ClientSideConnection

```rust
// From lib.rs lines 19-75
pub struct ClientSideConnection {
    conn: RpcConnection<ClientSide, AgentSide>,
}

impl ClientSideConnection {
    pub fn new(
        client: impl MessageHandler<ClientSide> + 'static,
        outgoing_bytes: impl Unpin + AsyncWrite,
        incoming_bytes: impl Unpin + AsyncRead,
        spawn: impl Fn(LocalBoxFuture<'static, ()>) + 'static,
    ) -> (Self, impl Future<Output = Result<()>>)
    
    pub fn subscribe(&self) -> StreamReceiver
}

// Implements Agent trait (see agent.rs)
```

### AgentSideConnection

```rust
// From lib.rs lines 365-531
pub struct AgentSideConnection {
    conn: RpcConnection<AgentSide, ClientSide>,
}

impl AgentSideConnection {
    pub fn new(
        agent: impl MessageHandler<AgentSide> + 'static,
        outgoing_bytes: impl Unpin + AsyncWrite,
        incoming_bytes: impl Unpin + AsyncRead,
        spawn: impl Fn(LocalBoxFuture<'static, ()>) + 'static,
    ) -> (Self, impl Future<Output = Result<()>>)
    
    pub fn subscribe(&self) -> StreamReceiver
}

// Implements Client trait (see client.rs)
```

### RpcConnection (Internal)

```rust
// From rpc.rs lines 32-38
pub(crate) struct RpcConnection<Local: Side, Remote: Side> {
    outgoing_tx: UnboundedSender<OutgoingMessage<Local, Remote>>,
    pending_responses: Arc<Mutex<HashMap<RequestId, PendingResponse>>>,
    next_id: AtomicI64,
    broadcast: StreamBroadcast,
}

// Key Methods:
pub(crate) fn new<Handler>(
    handler: Handler,
    outgoing_bytes: impl Unpin + AsyncWrite,
    incoming_bytes: impl Unpin + AsyncRead,
    spawn: impl Fn(LocalBoxFuture<'static, ()>) + 'static,
) -> (Self, impl futures::Future<Output = Result<()>>)

pub(crate) fn subscribe(&self) -> StreamReceiver

pub(crate) fn notify(
    &self,
    method: impl Into<Arc<str>>,
    params: Option<Remote::InNotification>,
) -> Result<()>

pub(crate) fn request<Out: DeserializeOwned + Send + 'static>(
    &self,
    method: impl Into<Arc<str>>,
    params: Option<Remote::InRequest>,
) -> impl Future<Output = Result<Out>>
```

---

## TRAIT DEFINITIONS

### Agent Trait

```rust
// From agent.rs lines 24-222
#[async_trait::async_trait(?Send)]
pub trait Agent {
    async fn initialize(&self, args: InitializeRequest) -> Result<InitializeResponse>;
    async fn authenticate(&self, args: AuthenticateRequest) -> Result<AuthenticateResponse>;
    async fn new_session(&self, args: NewSessionRequest) -> Result<NewSessionResponse>;
    async fn load_session(&self, _args: LoadSessionRequest) -> Result<LoadSessionResponse> { 
        Err(Error::method_not_found()) 
    }
    async fn set_session_mode(&self, _args: SetSessionModeRequest) -> Result<SetSessionModeResponse> {
        Err(Error::method_not_found())
    }
    #[cfg(feature = "unstable_session_model")]
    async fn set_session_model(&self, _args: SetSessionModelRequest) -> Result<SetSessionModelResponse> {
        Err(Error::method_not_found())
    }
    async fn set_session_config_option(&self, _args: SetSessionConfigOptionRequest) -> Result<SetSessionConfigOptionResponse> {
        Err(Error::method_not_found())
    }
    async fn list_sessions(&self, _args: ListSessionsRequest) -> Result<ListSessionsResponse> {
        Err(Error::method_not_found())
    }
    #[cfg(feature = "unstable_session_fork")]
    async fn fork_session(&self, _args: ForkSessionRequest) -> Result<ForkSessionResponse> {
        Err(Error::method_not_found())
    }
    #[cfg(feature = "unstable_session_resume")]
    async fn resume_session(&self, _args: ResumeSessionRequest) -> Result<ResumeSessionResponse> {
        Err(Error::method_not_found())
    }
    #[cfg(feature = "unstable_session_close")]
    async fn close_session(&self, _args: CloseSessionRequest) -> Result<CloseSessionResponse> {
        Err(Error::method_not_found())
    }
    async fn prompt(&self, args: PromptRequest) -> Result<PromptResponse>;
    async fn cancel(&self, args: CancelNotification) -> Result<()>;
    async fn ext_method(&self, _args: ExtRequest) -> Result<ExtResponse> {
        Ok(ExtResponse::new(RawValue::NULL.to_owned().into()))
    }
    async fn ext_notification(&self, _args: ExtNotification) -> Result<()> {
        Ok(())
    }
}
```

### Client Trait

```rust
// From client.rs lines 18-168
#[async_trait::async_trait(?Send)]
pub trait Client {
    async fn request_permission(&self, args: RequestPermissionRequest) -> Result<RequestPermissionResponse>;
    async fn session_notification(&self, args: SessionNotification) -> Result<()>;
    async fn write_text_file(&self, _args: WriteTextFileRequest) -> Result<WriteTextFileResponse> {
        Err(Error::method_not_found())
    }
    async fn read_text_file(&self, _args: ReadTextFileRequest) -> Result<ReadTextFileResponse> {
        Err(Error::method_not_found())
    }
    async fn create_terminal(&self, _args: CreateTerminalRequest) -> Result<CreateTerminalResponse> {
        Err(Error::method_not_found())
    }
    async fn terminal_output(&self, _args: TerminalOutputRequest) -> Result<TerminalOutputResponse> {
        Err(Error::method_not_found())
    }
    async fn release_terminal(&self, _args: ReleaseTerminalRequest) -> Result<ReleaseTerminalResponse> {
        Err(Error::method_not_found())
    }
    async fn wait_for_terminal_exit(&self, _args: WaitForTerminalExitRequest) -> Result<WaitForTerminalExitResponse> {
        Err(Error::method_not_found())
    }
    async fn kill_terminal(&self, _args: KillTerminalRequest) -> Result<KillTerminalResponse> {
        Err(Error::method_not_found())
    }
    async fn ext_method(&self, _args: ExtRequest) -> Result<ExtResponse> {
        Ok(ExtResponse::new(RawValue::NULL.to_owned().into()))
    }
    async fn ext_notification(&self, _args: ExtNotification) -> Result<()> {
        Ok(())
    }
}
```

### MessageHandler Trait

```rust
// From rpc.rs lines 328-338
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

// Auto-implemented for types implementing Agent or Client
```

---

## STREAM BROADCASTING TYPES

### StreamMessage

```rust
// From stream_broadcast.rs lines 23-29
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamMessage {
    pub direction: StreamMessageDirection,
    pub message: StreamMessageContent,
}
```

### StreamMessageDirection

```rust
// From stream_broadcast.rs lines 31-38
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMessageDirection {
    Incoming,  // From other side
    Outgoing,  // To other side
}
```

### StreamMessageContent

```rust
// From stream_broadcast.rs lines 40-71
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamMessageContent {
    Request {
        id: RequestId,
        method: Arc<str>,
        params: Option<serde_json::Value>,
    },
    Response {
        id: RequestId,
        result: Result<Option<serde_json::Value>>,
    },
    Notification {
        method: Arc<str>,
        params: Option<serde_json::Value>,
    },
}
```

### StreamReceiver

```rust
// From stream_broadcast.rs lines 73-110
#[derive(Debug, From)]
pub struct StreamReceiver(async_broadcast::Receiver<StreamMessage>);

impl StreamReceiver {
    pub async fn recv(&mut self) -> Result<StreamMessage> {
        self.0
            .recv()
            .await
            .map_err(|e| Error::internal_error().data(e.to_string()))
    }
}
```

---

## RPC MESSAGE TYPES (Internal)

### IncomingMessage

```rust
// From rpc.rs lines 317-326
#[derive(Debug)]
pub enum IncomingMessage<Local: Side> {
    Request {
        id: RequestId,
        request: Local::InRequest,
    },
    Notification {
        notification: Local::InNotification,
    },
}
```

### RawIncomingMessage

```rust
// From rpc.rs lines 305-315
#[derive(Debug, Deserialize)]
pub struct RawIncomingMessage<'a> {
    id: Option<RequestId>,
    #[serde(borrow)]
    method: Option<Cow<'a, str>>,
    #[serde(borrow)]
    params: Option<&'a RawValue>,
    #[serde(borrow)]
    result: Option<&'a RawValue>,
    error: Option<Error>,
}
```

---

## MARKER TYPES

### ClientSide

```rust
// From lib.rs lines 227-304
#[derive(Clone, Debug)]
pub struct ClientSide;

impl Side for ClientSide {
    type InNotification = AgentNotification;
    type InRequest = AgentRequest;
    type OutResponse = ClientResponse;
    
    fn decode_request(method: &str, params: Option<&RawValue>) -> Result<AgentRequest>
    fn decode_notification(method: &str, params: Option<&RawValue>) -> Result<AgentNotification>
}
```

### AgentSide

```rust
// From lib.rs lines 533-625
#[derive(Clone, Debug)]
pub struct AgentSide;

impl Side for AgentSide {
    type InRequest = ClientRequest;
    type InNotification = ClientNotification;
    type OutResponse = AgentResponse;
    
    fn decode_request(method: &str, params: Option<&RawValue>) -> Result<ClientRequest>
    fn decode_notification(method: &str, params: Option<&RawValue>) -> Result<ClientNotification>
}
```

---

## SIDE TRAIT (Generic)

```rust
// From agent-client-protocol-schema (re-exported)
pub trait Side: Clone + Debug {
    type InRequest;
    type InNotification;
    type OutResponse;
    
    fn decode_request(method: &str, params: Option<&RawValue>) -> Result<Self::InRequest>;
    fn decode_notification(method: &str, params: Option<&RawValue>) -> Result<Self::InNotification>;
}
```

---

## EXPORTED TYPES FROM SCHEMA

All types from `agent-client-protocol-schema` are re-exported:

```rust
pub use agent_client_protocol_schema::*;
```

This includes:
- Request/Response types (InitializeRequest, etc.)
- Notification types (SessionNotification, etc.)
- Content types (ContentBlock, TextContent, etc.)
- Error types
- Enums (StopReason, SessionUpdate, etc.)

---

## KEY TYPE RELATIONSHIPS

```
ClientSideConnection (implements Agent trait)
    ↓
RpcConnection<ClientSide, AgentSide>
    ↓ (message routing)
ClientSide (Side marker)
    ├─ InRequest: AgentRequest
    ├─ InNotification: AgentNotification
    └─ OutResponse: ClientResponse

AgentSideConnection (implements Client trait)
    ↓
RpcConnection<AgentSide, ClientSide>
    ↓ (message routing)
AgentSide (Side marker)
    ├─ InRequest: ClientRequest
    ├─ InNotification: ClientNotification
    └─ OutResponse: AgentResponse
```

---

## ERROR HANDLING HIERARCHY

```rust
pub type Result<T> = std::result::Result<T, Error>;

pub struct Error {
    code: i32,
    message: String,
    data: Option<Value>,
}

impl Error {
    pub fn invalid_params() -> Error
    pub fn method_not_found() -> Error
    pub fn internal_error() -> Error
    pub fn data(self, data: impl Into<Value>) -> Self
}
```

