# Github Personal Assistant

Mac-hosted personal developer assistant with a React web client, a Rust daemon, local SQLite metadata, and GitHub Copilot conversations powered through ACP.

This project is intentionally built as a **single-user daemon** running on your Mac. The frontend is a remote shell for that daemon, not a multi-tenant SaaS app. The product entrypoint is the `gcpa` CLI.

## Workspace

- `apps/client` — static React web client and PWA shell
- `apps/daemon` — Rust + Axum backend and the `gcpa` product CLI
- `packages/shared` — shared TypeScript API shapes used by the client
- `projects/acp-sdk-research` — preserved ACP SDK research notes and the vendored reference SDK, kept out of the repo root for a cleaner open-source layout

## Product model

### One CLI, two surfaces

`gcpa` is the product control plane:

- `gcpa daemon ...` runs and manages the local backend
- the browser UI is the day-to-day conversation surface
- the Settings modal is the lightweight in-app “menu” for version, lifecycle, log path, and deployment hints
- `gcpa ui deploy ...` publishes the hosted frontend to a GitHub Pages repo

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
- explicit `COPILOT_BIN` override when the `copilot` executable is not on PATH

For this product, `APP_AUTH_MODE=local` is the recommended default.

## Data and state

The daemon stores app-owned data under `APP_SUPPORT_DIR`, which defaults to:

- macOS: `~/Library/Application Support/github-personal-assistant/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/github-personal-assistant/`
- Windows: `%APPDATA%/github-personal-assistant/`

Important paths include:

- `config/daemon.env` — stable daemon config used by auto-start installs
- `logs/daemon.log` — persistent daemon log file
- `data/assistant.sqlite` — projects, threads, preferences, auth sessions, and attachment metadata
- `media/` — uploaded attachment files

The daemon talks to Copilot through ACP (`copilot --acp --stdio`). Transcript history is replayed from ACP sessions when the client loads a thread, so the Copilot runtime remains the source of truth for message content while SQLite stores only app-owned metadata.

## Getting started

1. Install dependencies for the web packages:

```bash
pnpm install
```

2. Copy the environment file and fill in the values you want to use:

```bash
cp .env.example .env
```

3. Run the daemon locally:

```bash
cargo run --manifest-path apps/daemon/Cargo.toml --bin gcpa -- daemon run
```

You can override the port directly from the CLI when needed:

```bash
cargo run --manifest-path apps/daemon/Cargo.toml --bin gcpa -- daemon run --port 4310
```

4. Start the web client:

```bash
pnpm dev:client:web
```

This starts a small local static dev server that rebuilds the client when files change.

## Install / restart / update story

`gcpa` now has an explicit lifecycle model instead of ad-hoc shell commands:

- Diagnose the local environment: `gcpa daemon doctor`
- Show config/log/data paths: `gcpa daemon paths`
- Install start-at-login service: `gcpa daemon service install`
- Check status: `gcpa daemon service status`
- Restart after config or binary changes: `gcpa daemon service restart`
- Remove start-at-login service: `gcpa daemon service uninstall`

The auto-start implementation uses the native user-level service manager for each platform:

- macOS: `launchd` (`~/Library/LaunchAgents/...`)
- Linux: `systemd --user` (`~/.config/systemd/user/...`)
- Windows: Task Scheduler (login task + runner script under `APP_SUPPORT_DIR`)

The default config file path is `APP_SUPPORT_DIR/config/daemon.env`. If it does not exist yet, `gcpa daemon service install` will create one from the current resolved settings so the background service has a stable config source.

The current update flow is intentionally simple and explicit: replace the `gcpa` binary with a newer build/release, then run `gcpa daemon service restart`. The app Settings modal also shows the exact restart/update command hints returned by `/api/health`.

## Hosted frontend deploy flow

The same CLI can publish or update the hosted web UI in another repo:

```bash
gcpa ui deploy --repo OWNER/REPO --client-default-api-url https://your-daemon-url
```

What it does:

- builds `apps/client`
- creates the target repo if needed
- syncs the built static app into the target repo’s `docs/` directory
- pushes the commit to the chosen branch
- configures GitHub Pages to serve from `BRANCH:/docs` (unless `--skip-pages-config` is used)

That gives you a safe deployment path for an existing repo without wiping unrelated files outside `docs/`.

## Runtime UX in the browser

There is not a separate native tray/menu app in this build. Instead:

- the browser/PWA is the primary user interface
- the Settings modal shows daemon version, lifecycle mode, Copilot CLI detection, config/log paths, and the exact `gcpa` restart/update/deploy commands
- connection settings still let the hosted frontend point at any daemon URL

That keeps the product simple while still giving users a discoverable place to find lifecycle instructions.

## Notes and operational details

- For Copilot auth on a Mac daemon, the default path is the logged-in local Copilot/GitHub user (`COPILOT_USE_LOGGED_IN_USER=true`).
- `COPILOT_GITHUB_TOKEN` only overrides that behavior.
- `APP_AUTH_MODE=local` is the recommended default for this single-user daemon.
- The frontend negotiates auth with the backend and creates a local session automatically in local mode.
- For GitHub device-flow app auth, set `APP_AUTH_MODE=github-device` and `GITHUB_CLIENT_ID`.
- For redirect-based GitHub OAuth app auth, set `APP_AUTH_MODE=github-oauth` plus `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL`.
- For hosted frontends such as GitHub Pages, set `CLIENT_DEFAULT_API_URL` to your Tailscale HTTPS URL so first load points at the daemon instead of `localhost`.
- `TAILSCALE_API_URL` is the preferred static remote URL for this setup.
- `REMOTE_ACCESS_MODE` controls how the daemon advertises itself in `/api/health` (`local`, `tailscale`, or `public`).

## PWA / Pages behavior

The React web client is exported statically and deployed to GitHub Pages. The in-repo workflow in `.github/workflows/deploy-pages.yml` still builds `apps/client` and publishes it to Pages on every push to `main`, and `gcpa ui deploy` can publish the same UI to another repo’s `docs/` directory when you want a separate hosted frontend repo.
