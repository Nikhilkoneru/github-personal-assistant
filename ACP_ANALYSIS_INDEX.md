# ACP Rust SDK Analysis - Complete Index

**Analysis Date**: March 15, 2025  
**SDK Version**: 0.10.2  
**Schema Version**: 0.11.2  
**Repository**: /Users/nikhilkoneru/Projects/acp-rust-sdk

---

## Document Summary

| Document | Size | Purpose | Audience |
|----------|------|---------|----------|
| ACP_SDK_ANALYSIS_README.md | 168 lines | Index & navigation | Everyone |
| ACP_RUST_SDK_DEEPDIVE.md | 832 lines | Architecture overview | Architects, leads |
| ACP_TYPES_REFERENCE.md | 409 lines | Type definitions | Implementers |
| ACP_USAGE_PATTERNS.md | 532 lines | Code examples | Developers |
| **TOTAL** | **1,941 lines** | **Complete reference** | **All roles** |

---

## Navigation Guide

### I need to...

#### Understand the architecture
→ **ACP_RUST_SDK_DEEPDIVE.md** sections 1-3
- What modules exist
- How types are organized  
- What the key structs are

#### Implement a client
→ **ACP_USAGE_PATTERNS.md** (Complete Client Implementation Example)
→ **ACP_TYPES_REFERENCE.md** (Client Trait section)
→ **ACP_RUST_SDK_DEEPDIVE.md** (Sections 2-4)

#### Implement an agent
→ **ACP_USAGE_PATTERNS.md** (Complete Agent Implementation Example)
→ **ACP_TYPES_REFERENCE.md** (Agent Trait section)
→ **ACP_RUST_SDK_DEEPDIVE.md** (Sections 2-5)

#### Understand message flow
→ **ACP_RUST_SDK_DEEPDIVE.md** sections 3, 4, 6
- Client-to-agent requests
- Agent-to-client requests
- JSON-RPC framing

#### Look up a type signature
→ **ACP_TYPES_REFERENCE.md**
- All trait definitions
- All connection types
- All marker types

#### Learn about session management
→ **ACP_RUST_SDK_DEEPDIVE.md** section 5
→ **ACP_USAGE_PATTERNS.md** (Loading Sessions section)

#### Understand terminal operations
→ **ACP_USAGE_PATTERNS.md** (Terminal Operations section)
→ **ACP_TYPES_REFERENCE.md** (types in schema)

#### Refactor custom code to use SDK
→ **ACP_RUST_SDK_DEEPDIVE.md** section 11 (Refactoring Notes)
→ **ACP_USAGE_PATTERNS.md** (complete examples)
→ Refactoring checklist in ACP_SDK_ANALYSIS_README.md

#### Handle errors properly
→ **ACP_RUST_SDK_DEEPDIVE.md** section 8
→ **ACP_USAGE_PATTERNS.md** (Error Handling Patterns)
→ **ACP_TYPES_REFERENCE.md** (Error Handling Hierarchy)

#### Debug message flow
→ **ACP_RUST_SDK_DEEPDIVE.md** section 9 (Stream Broadcasting)
→ **ACP_USAGE_PATTERNS.md** (Monitoring With Stream Broadcasting)
→ **ACP_TYPES_REFERENCE.md** (Stream Broadcasting Types)

---

## Critical Concepts

### 1. Dual-Sided Architecture
**Location**: ACP_RUST_SDK_DEEPDIVE.md section 3

The SDK provides two connection types for the same protocol:
- **ClientSideConnection**: For clients connecting to agents
- **AgentSideConnection**: For agents connecting to clients

Both use the same underlying `RpcConnection<Local, Remote>` generic.

### 2. Trait-Based Callbacks
**Location**: ACP_RUST_SDK_DEEPDIVE.md section 4

Implement traits to receive requests:
- Implement **Client trait** to handle agent requests
- Implement **Agent trait** to handle client requests
- RPC layer automatically routes messages by method name

### 3. JSON-RPC Over Stdio
**Location**: ACP_RUST_SDK_DEEPDIVE.md section 6

- Line-delimited JSON-RPC 2.0 format
- Each message ends with `\n`
- No length prefix or special framing
- Automatic request ID matching for responses

### 4. LocalSet Required
**Location**: ACP_RUST_SDK_DEEPDIVE.md section 11

Futures are `!Send`, so:
```rust
let local_set = tokio::task::LocalSet::new();
local_set.run_until(async { ... }).await
```

### 5. I/O Task Must Be Spawned
**Location**: ACP_USAGE_PATTERNS.md (Critical Patterns section)

```rust
let (conn, io_task) = ClientSideConnection::new(...);
tokio::task::spawn_local(io_task);  // NOT optional!
```

---

## Method References

### Client Trait Methods
**Location**: ACP_TYPES_REFERENCE.md (Client Trait section)

| Method | Purpose | Optional |
|--------|---------|----------|
| `request_permission()` | Permission for tool calls | No |
| `session_notification()` | Receive stream updates | No |
| `read_text_file()` | File system access | Yes |
| `write_text_file()` | File system access | Yes |
| `create_terminal()` | Terminal management | Yes |
| `terminal_output()` | Terminal output | Yes |
| `kill_terminal()` | Terminal control | Yes |
| `release_terminal()` | Terminal cleanup | Yes |
| `wait_for_terminal_exit()` | Terminal wait | Yes |
| `ext_method()` | Custom methods | Yes |
| `ext_notification()` | Custom notifications | Yes |

### Agent Trait Methods
**Location**: ACP_TYPES_REFERENCE.md (Agent Trait section)

| Method | Purpose | Optional |
|--------|---------|----------|
| `initialize()` | Protocol negotiation | No |
| `authenticate()` | Client auth | No |
| `new_session()` | Create session | No |
| `load_session()` | Load session | Yes |
| `prompt()` | Process user input | No |
| `cancel()` | Cancel operation | No |
| `set_session_mode()` | Switch mode | Yes |
| `set_session_model()` | Select model | Yes (unstable) |
| `list_sessions()` | List sessions | Yes |
| `fork_session()` | Fork session | Yes (unstable) |
| `resume_session()` | Resume session | Yes (unstable) |
| `close_session()` | Close session | Yes (unstable) |
| `set_session_config_option()` | Configuration | Yes |
| `ext_method()` | Custom methods | Yes |
| `ext_notification()` | Custom notifications | Yes |

---

## Feature Flags

**Location**: ACP_SDK_ANALYSIS_README.md (Features section)

Available features for conditional compilation:

```rust
[features]
unstable = [
    "unstable_auth_methods",
    "unstable_cancel_request", 
    "unstable_session_fork",
    "unstable_session_model",
    "unstable_session_resume",
    "unstable_session_usage",
    "unstable_session_close",
    "unstable_message_id",
    "unstable_boolean_config",
]
```

Use to enable experimental features from the protocol spec.

---

## Type Mapping

### Request Types
From `agent-client-protocol-schema` (re-exported):
- InitializeRequest / InitializeResponse
- AuthenticateRequest / AuthenticateResponse
- NewSessionRequest / NewSessionResponse
- LoadSessionRequest / LoadSessionResponse
- PromptRequest / PromptResponse
- SetSessionModeRequest / SetSessionModeResponse
- And many more...

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 2 (Core Types)

### Update Types (Streaming)
- SessionUpdate (enum with many variants)
- ContentChunk
- ToolCall
- ToolCallUpdate
- ToolResult
- Permission requests
- Status updates

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 2 (Session Update Types)

### Content Types
- ContentBlock (enum)
  - Text
  - Image
  - Audio
  - Resource
  - ResourceLink

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 2 (Content Block Types)

---

## Error Handling

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 8

Error types:
- `Error::invalid_params()`
- `Error::method_not_found()`
- `Error::internal_error()`
- Custom data via `.data(msg)`

Result type: `type Result<T> = std::result::Result<T, Error>;`

---

## Session Lifecycle

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 5

1. Initialize protocol
2. Create/Load session
3. Send prompts and consume updates
4. Handle tool calls
5. Cancel if needed

**Code Examples**: ACP_USAGE_PATTERNS.md

---

## Dependencies

**Location**: ACP_SDK_ANALYSIS_README.md (Dependencies section)

| Crate | Version | Purpose |
|-------|---------|---------|
| agent-client-protocol-schema | 0.11.2 | Protocol types |
| tokio | 1.48+ | Async runtime |
| async-broadcast | 0.7 | Stream monitoring |
| async-trait | 0.1 | Async traits |
| serde_json | 1.0 | JSON serialization |
| futures | 0.3.31 | Async utilities |

---

## Examples in SDK

**Location**: `/acp-rust-sdk/src/agent-client-protocol/examples/`

### example/client.rs
- Complete working client implementation
- Spawns agent subprocess
- Interactive prompt loop
- Receives and displays agent output

**See**: ACP_USAGE_PATTERNS.md for annotated version

### example/agent.rs
- Complete working agent implementation
- Listens on stdin/stdout
- Echo-like behavior
- Demonstrates session_notification sending

**See**: ACP_USAGE_PATTERNS.md for annotated version

---

## Integration Points

### Custom Client → SDK Migration
**Location**: ACP_RUST_SDK_DEEPDIVE.md section 11 (Refactoring Notes)

1. Replace JSON-RPC handling → Use `RpcConnection`
2. Replace custom traits → Implement `Client` trait
3. Replace connection class → Use `ClientSideConnection`
4. Update subprocess spawn → Follow example patterns
5. Replace error handling → Use SDK `Error` type
6. Add stream monitoring → Use `conn.subscribe()`

### Key Simplifications
- No custom message parsing
- No manual request ID management
- No error handling for unknown methods (automatic)
- Automatic type-safe routing

---

## Code Structure

### Total Lines
- lib.rs: 703 lines
- agent.rs: 347 lines
- client.rs: 260 lines
- rpc.rs: 367 lines
- stream_broadcast.rs: 300 lines
- rpc_tests.rs: 919 lines
- examples: ~350 lines combined
- **Total: ~2,900 lines**

### Module Organization
```
ClientSideConnection (lib.rs)
    ↓ implements Agent trait
    ↓ uses RpcConnection<ClientSide, AgentSide>
AgentSideConnection (lib.rs)
    ↓ implements Client trait
    ↓ uses RpcConnection<AgentSide, ClientSide>
```

---

## Quick Reference

### Create Client Connection
```rust
let (conn, io_task) = ClientSideConnection::new(
    my_client_impl,
    outgoing_bytes,
    incoming_bytes,
    |fut| tokio::task::spawn_local(fut),
);
tokio::task::spawn_local(io_task);
```

### Create Agent Connection
```rust
let (conn, io_task) = AgentSideConnection::new(
    my_agent_impl,
    outgoing_bytes,
    incoming_bytes,
    |fut| tokio::task::spawn_local(fut),
);
tokio::task::spawn_local(io_task);
```

### Send Request from Client
```rust
let response = conn.new_session(NewSessionRequest::new(cwd)).await?;
```

### Send Notification from Agent
```rust
conn.session_notification(SessionNotification::new(
    session_id,
    SessionUpdate::AgentMessageChunk(chunk),
)).await?
```

### Receive Requests on Client
```rust
#[async_trait::async_trait(?Send)]
impl Client for MyType {
    async fn request_permission(&self, args: RequestPermissionRequest) 
        -> Result<RequestPermissionResponse> { ... }
}
```

---

## Testing

**Location**: ACP_RUST_SDK_DEEPDIVE.md section 7 (Examples)

The SDK provides comprehensive examples that can be used for:
- Integration testing
- Protocol verification
- Implementation validation

Run with:
```bash
cargo build --example agent
cargo run --example client -- target/debug/examples/agent
```

---

## Version Compatibility

- **Rust Edition**: 2024
- **Minimum Tokio**: 1.48
- **Protocol Version**: V1 (via InitializeRequest)
- **License**: Apache-2.0

---

## Support & Resources

**Official Resources**:
- Repository: https://github.com/agentclientprotocol/rust-sdk
- Documentation: https://docs.rs/agent-client-protocol
- Protocol Specification: https://agentclientprotocol.com

**This Analysis**:
- Created: March 15, 2025
- Scope: Complete SDK deep-dive
- Purpose: Refactoring reference for custom ACP clients

---

## Document Cross-References

| Concept | Document | Section |
|---------|----------|---------|
| Architecture | DEEPDIVE | 1-3 |
| Types | TYPES_REFERENCE | All |
| Examples | USAGE_PATTERNS | All |
| Client impl | USAGE_PATTERNS | Complete Client Implementation |
| Agent impl | USAGE_PATTERNS | Complete Agent Implementation |
| Transport | DEEPDIVE | 6, 11 |
| Traits | TYPES_REFERENCE | Trait Definitions |
| Errors | DEEPDIVE | 8 |
| Session flow | DEEPDIVE | 5 |
| Refactoring | DEEPDIVE | 11 |

