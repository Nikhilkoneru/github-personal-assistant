# Github Personal Assistant

Mac-hosted personal developer assistant with an Expo client, a Node API, durable chat persistence, and optional RagFlow-backed project knowledge.

## Workspace

- `apps/client` — Expo app for web and Android
- `apps/api` — Express + TypeScript API with SQLite persistence, GitHub OAuth, Copilot SDK chat streaming, and RagFlow integration hooks
- `packages/shared` — shared API and app types

## Getting started

1. Install dependencies:

```bash
pnpm install
```

2. Copy the environment file and fill in the GitHub OAuth values when you are ready:

```bash
cp .env.example .env
```

3. Configure the backend:

```bash
# Required for sign-in
GITHUB_CLIENT_ID=...

# Optional Copilot runtime
COPILOT_CLI_URL=...
# or
COPILOT_GITHUB_TOKEN=...

# Optional RagFlow knowledge service
RAGFLOW_BASE_URL=http://localhost:9380
RAGFLOW_API_KEY=...

# Optional remote/client access helpers
PUBLIC_API_URL=
TAILSCALE_API_URL=
REMOTE_ACCESS_MODE=local
SERVICE_ACCESS_TOKEN=
EXPO_PUBLIC_SERVICE_ACCESS_TOKEN=
```

4. Start the API:

```bash
pnpm dev:api
```

5. Start the Expo app:

```bash
pnpm dev:client:web
```

For Android development, use:

```bash
pnpm dev:android
```

## Current capabilities

- Multi-project app shell
- Backend-managed model listing
- Durable SQLite-backed users, sessions, projects, threads, messages, and attachments
- Streaming chat route with server-side thread persistence and real Copilot errors surfaced inline
- GitHub device-flow sign-in with persisted session restoration
- Local file attachments stored on the Mac host
- Thread-local uploads by default, with explicit promotion into project knowledge
- RagFlow dataset provisioning and document ingestion hooks for project knowledge
- Retrieval-enriched prompts using RagFlow chunks with PDF-context fallback
- Configurable local service host/public URL plus optional service access token

## Notes

- For real Copilot sessions, provide either `COPILOT_CLI_URL` or `COPILOT_GITHUB_TOKEN`.
- For GitHub device-flow sign-in, set `GITHUB_CLIENT_ID`. The secret and callback URL are only required if you also want the redirect-based OAuth flow.
- `SERVICE_ACCESS_TOKEN` is an optional backend gate for client requests; if you set it, also set `EXPO_PUBLIC_SERVICE_ACCESS_TOKEN` in the Expo client environment.
- `TAILSCALE_API_URL` is the preferred static remote URL for this setup. Example: `http://your-mac.tailnet-name.ts.net:4000`.
- `REMOTE_ACCESS_MODE` controls how the daemon advertises itself in `/api/health` (`local`, `tailscale`, or `public`).
- `PUBLIC_API_URL` still works for other tunnel/reverse-proxy setups, but Tailscale is now the intended remote path.
- PDF preprocessing still preserves page-level text and OCR output locally, but RagFlow is now the intended reusable knowledge path.

The client now supports a runtime API endpoint override in the connection settings screen, so you can point an already-built web/iOS/Android client at `localhost`, a LAN IP, or your Tailscale hostname without rebuilding Expo.

For direct Tailscale access, either run the API with `HOST=0.0.0.0` and use `http://your-mac.tailnet-name.ts.net:4000`, or keep the API bound locally and front it with `tailscale serve` for a stable HTTPS URL.

## GitHub Pages frontend

The Expo web client can now be exported statically and deployed to GitHub Pages. The included workflow in `.github/workflows/deploy-pages.yml` builds `apps/client` and publishes it to Pages on every push to `main`.

For hosted frontends, each user should open the app's connection settings and paste their own daemon URL. For Tailscale-backed setups, prefer an HTTPS URL exposed through `tailscale serve`, for example `https://your-mac.tailnet.ts.net`.
