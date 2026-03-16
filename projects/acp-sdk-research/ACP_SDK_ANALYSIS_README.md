# ACP Rust SDK - Complete Analysis

This directory contains comprehensive documentation on the Agent Client Protocol (ACP) Rust SDK for refactoring custom ACP client implementations.

## Documents Included

### 1. **ACP_RUST_SDK_DEEPDIVE.md** (23 KB)
High-level overview and architecture guide covering:
- Crate structure and dependencies
- Core types overview
- Client & Agent implementation patterns
- Server-to-client request handling
- Session lifecycle
- Transport layer (stdio, JSON-RPC framing)
- Error handling
- Design patterns and architectural notes

**Best for**: Understanding the SDK architecture at a high level

### 2. **ACP_TYPES_REFERENCE.md** (11 KB)
Complete type reference with exact struct/trait definitions:
- `ClientSideConnection` and `AgentSideConnection`
- `Agent` and `Client` trait definitions
- `MessageHandler<T>` trait
- Stream broadcasting types
- RPC internal types
- Marker types (`ClientSide`, `AgentSide`)
- Error handling hierarchy

**Best for**: Looking up exact type signatures and implementing traits

### 3. **ACP_USAGE_PATTERNS.md** (15 KB)
Ready-to-use code examples and patterns:
- Complete client implementation example
- Complete agent implementation example
- Sending session notifications
- Stream monitoring
- Capability negotiation
- Error handling patterns
- Session loading and history replay
- Terminal operations
- Extension methods
- Critical patterns to remember

**Best for**: Copy-paste examples and integration patterns

## Quick Start

### For implementing a client:
1. Read: `ACP_RUST_SDK_DEEPDIVE.md` sections 1-4
2. Reference: `ACP_TYPES_REFERENCE.md` for `Client` trait
3. Copy: Complete client example from `ACP_USAGE_PATTERNS.md`

### For implementing an agent:
1. Read: `ACP_RUST_SDK_DEEPDIVE.md` sections 1-6
2. Reference: `ACP_TYPES_REFERENCE.md` for `Agent` trait
3. Copy: Complete agent example from `ACP_USAGE_PATTERNS.md`

### For understanding transport:
1. Read: `ACP_RUST_SDK_DEEPDIVE.md` section 6
2. Reference: Transport layer details in section 11

### For refactoring existing code:
1. Read: `ACP_RUST_SDK_DEEPDIVE.md` section 11 (Refactoring Notes)
2. Cross-reference types in `ACP_TYPES_REFERENCE.md`
3. Use patterns from `ACP_USAGE_PATTERNS.md`

## Key Takeaways

### Architecture
- **Dual-sided**: `ClientSideConnection` and `AgentSideConnection` for both perspectives
- **Generic RPC**: Underlying `RpcConnection<Local, Remote>` handles both sides
- **Trait-based**: Client/Agent traits define the interface
- **Non-blocking**: All futures are `!Send`, requires `LocalSet`

### Traits to Implement
- **Client trait** (10 methods) - For client-side implementations
- **Agent trait** (11 methods) - For agent-side implementations

### Critical Pattern
```rust
let (conn, io_task) = ClientSideConnection::new(...);
tokio::task::spawn_local(io_task);  // MUST spawn this!
```

### Transport
- Line-delimited JSON-RPC 2.0 over stdio
- No custom framing needed
- Each message ends with `\n`

### Types Come From Schema
All domain types (requests, responses, notifications) come from `agent-client-protocol-schema` crate (v0.11.2)

## File Structure of SDK

```
src/agent-client-protocol/
├── src/
│   ├── lib.rs (703 lines)
│   │   ├── ClientSideConnection
│   │   ├── AgentSideConnection
│   │   ├── ClientSide/AgentSide marker types
│   │   └── Side trait implementations
│   ├── client.rs (260 lines)
│   │   └── Client trait definition
│   ├── agent.rs (347 lines)
│   │   └── Agent trait definition
│   ├── rpc.rs (367 lines)
│   │   ├── RpcConnection<Local, Remote>
│   │   ├── MessageHandler trait
│   │   └── JSON-RPC message handling
│   ├── stream_broadcast.rs (300 lines)
│   │   ├── StreamMessage
│   │   ├── StreamReceiver
│   │   └── Stream monitoring
│   └── rpc_tests.rs (919 lines)
│       └── Integration tests
└── examples/
    ├── client.rs - Example client
    └── agent.rs - Example agent
```

## Refactoring Checklist

If refactoring a custom ACP client to use this SDK:

- [ ] Replace custom JSON-RPC framing with `RpcConnection`
- [ ] Implement `Client` trait for incoming requests
- [ ] Use `ClientSideConnection` instead of custom connection class
- [ ] Adopt `LocalSet` for spawning (if using Tokio)
- [ ] Remove custom request ID management (now automatic)
- [ ] Replace custom error handling with SDK `Error` type
- [ ] Use builder pattern for request construction
- [ ] Implement stream monitoring via `conn.subscribe()`
- [ ] Update subprocess spawn logic to match example patterns
- [ ] Test with both examples (agent.rs and client.rs)

## Version Information

- **SDK Version**: 0.10.2
- **Schema Version**: 0.11.2
- **Rust Edition**: 2024
- **Min Tokio**: 1.48
- **License**: Apache-2.0

## Dependencies

Runtime:
- `agent-client-protocol-schema` (=0.11.2)
- `tokio` (1.48)
- `async-broadcast` (0.7)
- `async-trait` (0.1)
- `serde_json` (1.0)
- `futures` (0.3.31)

Features available:
- `unstable_auth_methods`
- `unstable_session_fork`
- `unstable_session_model`
- `unstable_session_resume`
- `unstable_session_close`
- And others...

## Additional Resources

- **Repository**: https://github.com/agentclientprotocol/rust-sdk
- **Documentation**: https://docs.rs/agent-client-protocol
- **Protocol Spec**: https://agentclientprotocol.com
