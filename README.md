# Github Personal Assistant

Mac-hosted personal developer assistant with a React web client, a Node API, lightweight local metadata storage, and GitHub Copilot SDK-driven chat sessions.

This project is currently designed around a **single-user daemon** running on your Mac. The web UI is a remote shell for that daemon, not a multi-tenant SaaS product.

## What this product is now

The current product model is:

- one daemon owner
- one durable set of chats, projects, attachments, and history
- backend-driven auth negotiation
- Copilot SDK as the runtime chat engine
- local-first storage on the Mac host

Projects currently behave like **lightweight grouping only**. Chats are the primary surface; projects are just a way to organize related threads without adding extra runtime behavior.

## Workspace

- `apps/client` — static React web client and PWA shell
- `apps/api` — Express + TypeScript API with SQLite metadata persistence, auth/session handling, attachment processing, and Copilot SDK chat orchestration
- `packages/shared` — shared API and app types

## Current architecture

### Single-user daemon-owner model

The app is intentionally built for a single user.

- the daemon owns the durable data
- app auth controls access to the daemon
- app auth does **not** decide data ownership
- switching auth modes should not fork or hide history

This is why the backend was moved away from a GitHub-user-centric ownership model and toward one stable daemon-owner identity.

### App auth and Copilot runtime auth are separate

These are different concerns:

- **app auth** = how the frontend is allowed to use the daemon
- **Copilot runtime auth** = how the daemon itself talks to Copilot

App auth currently supports:

- `local`
- `github-device`
- `github-oauth`

Copilot runtime auth currently supports:

- logged-in local Copilot/GitHub user on the Mac
- explicit GitHub token override
- external Copilot CLI URL

For this product, `APP_AUTH_MODE=local` is the recommended default.

## Current UI direction

The UI has been evolving toward:

- a lighter, denser chat-first shell
- a sticky header + sticky composer
- only the message region owning scroll
- fewer filler labels and less wasted vertical space
- projects acting as grouping rather than a dominant dashboard

Recent UX changes already implemented include:

- compact header and composer
- model picker moved to the top header
- bottom composer reduced to attachment + send controls
- denser sidebar with less visual weight so more chats are visible
- PWA update-ready banner support

Near-term UX direction that is **desired but not fully implemented yet**:

- make the sidebar even more list-like and less panel-heavy
- make moving chats between projects very easy
- treat projects explicitly as organizational grouping instead of a heavyweight primary surface

## Current capabilities

- Single-user local auth with automatic session bootstrap plus optional GitHub device/OAuth sign-in
- Backend-advertised auth capabilities via `/api/auth/capabilities`
- Durable SQLite-backed app metadata for sessions, projects, threads, preferences, and attachments
- Copilot SDK session history used as the source of truth for chat replay, reasoning, tool activity, and usage
- Streaming chat route with real Copilot errors surfaced inline
- Backend-managed model listing from the Copilot SDK
- Copilot SDK status/session inspection plus deletion via `/api/copilot/status` and `/api/copilot/sessions/:sessionId`
- Rich Copilot model metadata including capabilities, billing, policy, and reasoning-effort support
- Copilot infinite-session configuration with app-owned SDK tools for thread attachments
- Local file attachments stored on the Mac host
- Thread-local uploads stored and reused locally
- Hosted frontend default daemon URL injection for GitHub Pages
- Service-worker cache fingerprinting so old app shells are invalidated on deploy
- Forced PWA shell updates so fresh deployments take over immediately

## How Copilot is managing state here

There are **two layers of Copilot-related state** in this setup.

### 1. General Copilot CLI state

The Copilot CLI itself keeps state under `~/.copilot/`.

Examples found on this machine:

- `~/.copilot/command-history-state.json`
- `~/.copilot/ide/...`
- `~/.copilot/pkg/universal/.../copilot-sdk`
- `~/.copilot/session-state/<session-id>/...`

Those session-state folders can contain things like:

- `workspace.yaml`
- `events.jsonl`
- `checkpoints/`
- `files/`
- sometimes a small per-session `session.db`

### 2. App-configured headless Copilot state

This app also tells the Copilot SDK where to persist headless session state.

In `apps/api/src/config.ts`, the default config is:

- `COPILOT_CONFIG_DIR = ~/Library/Application Support/github-personal-assistant/copilot`
- `COPILOT_WORKING_DIRECTORY = process.cwd()` unless overridden

Because of that, the app-specific headless state currently lives under:

- `~/Library/Application Support/github-personal-assistant/copilot/`

That directory contains:

- `session-store.db`
- `session-state/thread-.../`

The per-thread workspace folders contain:

- `workspace.yaml`
- `events.jsonl`
- `checkpoints/`
- `files/`
- sometimes `research/`

The important point is:

> Copilot SDK is not secretly inventing some separate hidden product database for this app. We are explicitly configuring where persistent session state should live, and the app-owned headless session store is currently under `Application Support/github-personal-assistant/copilot/`.

### What the app is doing with the SDK

The app currently:

- starts a `CopilotClient`
- reuses or resumes sessions per thread
- enables infinite sessions
- streams assistant output over SSE
- exposes custom tools back into the session
- persists app-side thread/message history separately in the app database

Current SDK integration is centered in:

- `apps/api/src/services/copilot.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/copilot.ts`

## How PDFs are processed right now

PDF handling is already local-first.

### On upload

When a PDF is uploaded, the backend immediately extracts a local PDF context.

Current behavior:

1. the file is stored on disk under the app media directory
2. the backend runs PDF extraction locally
3. extracted context is stored as JSON beside the attachment metadata

### Extraction pipeline

The PDF pipeline lives in `apps/api/src/services/pdf.ts`.

It currently does:

- try native PDF text extraction first using `pdfjs-dist`
- check whether the extracted page text is meaningful
- if not meaningful, render that page to an image
- run Tesseract OCR on the rendered page
- store page-by-page extracted text plus extraction type

Possible extraction results:

- `native`
- `ocr`
- `mixed`

This means scanned PDFs already work locally as long as Tesseract is available on the machine.

### How that context is used

For thread attachments:

- PDF context is formatted into prompt context locally
- the backend injects relevant PDF excerpts into the Copilot prompt

Projects do not add a separate knowledge layer anymore.

- attachments remain thread-local
- project assignment is just grouping
- no RagFlow service is used in the current implementation

## Copilot SDK integration: current adoption

The current implementation already adopts a meaningful part of the SDK:

- client lifecycle and startup
- session create/resume
- infinite sessions
- model listing
- status/auth overview
- session listing and deletion
- SSE streaming with:
  - `assistant.message_delta`
  - `assistant.reasoning_delta`
  - `assistant.reasoning`
  - `assistant.usage`
  - tool execution activity
  - `ask_user`-style user input requests
- `session.getMessages()`-backed replay for thread detail
- app-owned custom tools:
  - `list_thread_attachments`

It also uses:

- model selection
- per-thread reasoning-effort config
- system-message injection
- session reuse tied to app thread IDs
- SDK session history as the canonical chat/event log, with SQLite only storing app-owned metadata and previews

## Copilot SDK features still worth adopting

The SDK surface is broader than what is currently wired. The most relevant remaining opportunities for this product are:

### High priority

- richer hook-driven audit/automation beyond the current activity surface
- more deliberate interactive permission UX beyond the daemon-level approval policy
- better image/vision handling for models that support vision
- surface model capability limits more clearly in the UI

### Medium priority

- deeper session diagnostics and inspection
- richer per-tool permission explanations in the chat UI
- optional session timeline filters / debugging views

### Lower priority

- MCP server expansion
- custom provider overrides
- foreground-session coordination with TUI mode
- built-in tool overrides

## Copilot SDK implementation roadmap

If we want to keep pushing the Copilot SDK integration further, the clean implementation path is:

### Phase 1 — now implemented

Goal: make active sessions safer and more controllable.

Implement:

- add request cancellation using `session.abort()`
- replace the current `send()` + manual `waitForIdle()` pattern with `sendAndWait()` where it simplifies the lifecycle
- stop using blanket permission approval for everything and introduce explicit permission policy by kind:
  - `shell`
  - `write`
  - `mcp`
  - `read`
  - `url`
  - `custom-tool`

Main files:

- `apps/api/src/routes/chat.ts`
- `apps/api/src/services/copilot.ts`
- `packages/shared/src/index.ts`

Expected outcome:

- users can stop long-running responses
- fewer hung session edge cases
- better control over risky tool execution

Implemented:

- request cancellation using `session.abort()`
- `sendAndWait()`-based streaming lifecycle
- daemon-level approval policy (`approve-all` vs `safer-defaults`)

### Phase 2 — now implemented

Goal: expose more of what the SDK already emits and stop duplicating chat history.

Implement:

- subscribe to `assistant.reasoning_delta` and `assistant.reasoning`
- capture `assistant.usage`
- load thread detail from `session.getMessages()`
- support `ask_user`-style user input requests
- surface tool execution activity in the chat UI

Main files:

- `apps/api/src/routes/chat.ts`
- `apps/api/src/services/copilot.ts`
- `apps/api/src/store/thread-store.ts`
- `packages/shared/src/index.ts`
- `apps/client/src/app.tsx`

Expected outcome:

- richer live response UX for reasoning models
- token/cost/performance visibility
- better debugging and session replay without duplicating full transcripts in SQLite

### Phase 3 — interactive agent flows and multimodal polish

Goal: support more advanced agent behavior.

Implement:

- register `onUserInputRequest` so SDK sessions can ask clarifying questions when needed
- improve image/vision handling based on model capabilities
- expose model capability limits more clearly in the UI

Main files:

- `apps/api/src/services/copilot.ts`
- `apps/api/src/routes/chat.ts`
- `packages/shared/src/index.ts`
- `apps/client/src/app.tsx`

Expected outcome:

- more natural multi-step agent conversations
- better use of multimodal models
- clearer model behavior in the UI

### Phase 4 — optional advanced integrations

Goal: add power-user and infrastructure features only if they are still useful after the core product is simplified.

Possible work:

- MCP server wiring
- custom provider / BYOK support
- foreground session coordination with TUI mode
- built-in tool overrides

These are lower priority because they add integration surface area without improving the core single-user Mac daemon experience as much as the earlier phases.

### Recommended implementation order

1. `session.abort()`
2. permission handling cleanup
3. reasoning and usage streaming
4. `sendAndWait()` lifecycle simplification
5. `session.getMessages()` support
6. `onUserInputRequest`
7. image/vision polish
8. optional MCP / provider / TUI work

### Recommended scope cuts

If we want to stay disciplined, the highest-value adoption set is:

- abort
- permissions
- reasoning streaming
- usage events
- message replay via `getMessages()`

That would give the product a much more complete Copilot SDK integration without dragging in lower-value platform complexity too early.

## Getting started

1. Install dependencies:

```bash
pnpm install
```

2. Copy the environment file and fill in the values you want to use:

```bash
cp .env.example .env
```

3. Configure the backend:

```bash
# Single-user app auth
APP_AUTH_MODE=local
DAEMON_OWNER_LOGIN=daemon

# Optional GitHub app auth
# github-device needs GITHUB_CLIENT_ID
# github-oauth also needs GITHUB_CLIENT_SECRET and GITHUB_CALLBACK_URL
GITHUB_CLIENT_ID=...

# Optional Copilot runtime overrides
# By default the SDK can use the logged-in local Copilot/GitHub user on the Mac daemon.
COPILOT_USE_LOGGED_IN_USER=true
# Optional: point at an existing Copilot CLI server
COPILOT_CLI_URL=
# Optional: force a specific token instead of the logged-in local user
COPILOT_GITHUB_TOKEN=

# Optional remote/client access helpers
PUBLIC_API_URL=
TAILSCALE_API_URL=
REMOTE_ACCESS_MODE=local
SERVICE_ACCESS_TOKEN=
CLIENT_DEFAULT_API_URL=
EXPO_PUBLIC_SERVICE_ACCESS_TOKEN=
```

4. Start the API:

```bash
pnpm dev:api
```

5. Start the web client:

```bash
pnpm dev:client:web
```

This starts a small local static dev server that rebuilds the client when files change.

## Notes and operational details

- For Copilot SDK auth on a Mac daemon, the default path is the logged-in local Copilot/GitHub user (`COPILOT_USE_LOGGED_IN_USER=true`).
- `COPILOT_GITHUB_TOKEN` only overrides that behavior.
- `APP_AUTH_MODE=local` is the recommended default for this single-user daemon.
- The frontend negotiates auth with the backend and creates a local session automatically in local mode.
- For GitHub device-flow app auth, set `APP_AUTH_MODE=github-device` and `GITHUB_CLIENT_ID`.
- For redirect-based GitHub OAuth app auth, set `APP_AUTH_MODE=github-oauth` plus `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`.
- For hosted frontends such as GitHub Pages, set the repository Actions variable `CLIENT_DEFAULT_API_URL` to your Tailscale HTTPS URL so first load points at the daemon instead of `localhost`.
- The client stores session tokens per daemon origin and auth config version, so switching daemon URLs or auth modes does not reuse stale sessions.
- `TAILSCALE_API_URL` is the preferred static remote URL for this setup.
- `REMOTE_ACCESS_MODE` controls how the daemon advertises itself in `/api/health` (`local`, `tailscale`, or `public`).
- For direct Tailscale access, either run the API with `HOST=0.0.0.0` and use `http://your-mac.tailnet-name.ts.net:4000`, or keep the API bound locally and front it with `tailscale serve` for a stable HTTPS URL.

## GitHub Pages frontend

The React web client is exported statically and deployed to GitHub Pages. The workflow in `.github/workflows/deploy-pages.yml` builds `apps/client` and publishes it to Pages on every push to `main`.

The client is also configured as a PWA:

- the app shell is cached after first load
- the browser can install it like an app
- the app can detect when an update is waiting
- the UI can prompt the user to apply the update

For hosted frontends, the user can still override the daemon URL at runtime in connection settings without rebuilding the frontend.
