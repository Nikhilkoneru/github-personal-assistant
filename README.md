# Github Personal Assistant

Mac-hosted personal developer assistant with a React web client, a Node API, durable chat persistence, and optional RagFlow-backed project knowledge.

## Workspace

- `apps/client` — static React web client and PWA shell
- `apps/api` — Express + TypeScript API with SQLite persistence, app auth/session handling, Copilot SDK chat streaming, and RagFlow integration hooks
- `packages/shared` — shared API and app types

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

# Optional RagFlow knowledge service
RAGFLOW_BASE_URL=http://localhost:9380
RAGFLOW_API_KEY=...

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

## Current capabilities

- Multi-project app shell
- Backend-managed model listing
- Backend-advertised auth capabilities via `/api/auth/capabilities`
- Durable SQLite-backed users, sessions, projects, threads, messages, and attachments
- Streaming chat route with server-side thread persistence and real Copilot errors surfaced inline
- Copilot SDK status/session inspection plus delete support via `/api/copilot/status` and `/api/copilot/sessions/:sessionId`
- Richer Copilot model metadata including capabilities, billing, policy, and reasoning-effort support
- Copilot infinite-session configuration plus app-owned SDK tools for project knowledge and thread attachments
- Single-user local auth with automatic session bootstrap plus optional GitHub device/OAuth sign-in
- Local file attachments stored on the Mac host
- Thread-local uploads by default, with explicit promotion into project knowledge
- RagFlow dataset provisioning and document ingestion hooks for project knowledge
- Retrieval-enriched prompts using RagFlow chunks with PDF-context fallback
- Configurable local service host/public URL plus optional service access token

## Notes

- For Copilot SDK auth on a Mac daemon, the default path is the logged-in local Copilot/GitHub user (`COPILOT_USE_LOGGED_IN_USER=true`). `COPILOT_GITHUB_TOKEN` only overrides that behavior.
- `APP_AUTH_MODE=local` is the recommended default for a single-user Mac daemon. The frontend will auto-negotiate auth with the backend and create a local session automatically.
- For GitHub device-flow app auth, set `APP_AUTH_MODE=github-device` and `GITHUB_CLIENT_ID`.
- For redirect-based GitHub OAuth app auth, set `APP_AUTH_MODE=github-oauth` plus `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`.
- For hosted frontends such as GitHub Pages, set `CLIENT_DEFAULT_API_URL` to your Tailscale HTTPS URL so first load points at the daemon instead of `localhost`.
- The client stores session tokens per daemon origin and auth config version, so switching daemon URLs or auth modes does not reuse stale sessions.
- `SERVICE_ACCESS_TOKEN` is an optional backend gate for client requests, but for hosted frontends the preferred long-term model is user auth and device pairing instead of a shared frontend secret.
- `TAILSCALE_API_URL` is the preferred static remote URL for this setup. Example: `http://your-mac.tailnet-name.ts.net:4000`.
- `REMOTE_ACCESS_MODE` controls how the daemon advertises itself in `/api/health` (`local`, `tailscale`, or `public`).
- `PUBLIC_API_URL` still works for other tunnel/reverse-proxy setups, but Tailscale is now the intended remote path.
- PDF preprocessing still preserves page-level text and OCR output locally, but RagFlow is now the intended reusable knowledge path.

The client supports a runtime API endpoint override in the connection settings screen, so you can point an already-built web frontend at `localhost`, a LAN IP, or your Tailscale hostname without rebuilding.

For direct Tailscale access, either run the API with `HOST=0.0.0.0` and use `http://your-mac.tailnet-name.ts.net:4000`, or keep the API bound locally and front it with `tailscale serve` for a stable HTTPS URL.

## GitHub Pages frontend

The React web client is exported statically and deployed to GitHub Pages. The included workflow in `.github/workflows/deploy-pages.yml` builds `apps/client` and publishes it to Pages on every push to `main`.

For hosted frontends, each user should open the app's connection settings and paste their own daemon URL. For Tailscale-backed setups, prefer an HTTPS URL exposed through `tailscale serve`, for example `https://your-mac.tailnet.ts.net`.

The client is also configured as a PWA. After the site loads once, the app shell and React runtime are cached by the service worker, and supported browsers can install it like an app. On iPhone/iPad Safari, use `Share -> Add to Home Screen`.
