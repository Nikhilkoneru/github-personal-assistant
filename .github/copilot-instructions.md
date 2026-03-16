# Copilot Instructions for github-personal-assistant

## Deployment Checklist

After every code change, always complete these steps:

1. **Type-check web packages**: `pnpm exec tsc -p apps/client/tsconfig.build.json --noEmit`
2. **Build daemon**: `cargo build --manifest-path apps/daemon/Cargo.toml --bin gcpa`
3. **Build client**: `node apps/client/scripts/build.mjs` — this regenerates `dist/`, `service-worker.js`, and the build version hash
4. **Restart backend**: Kill the old process on port 4000, then start `HOST=0.0.0.0 apps/daemon/target/debug/gcpa daemon run`
5. **Verify backend**: `curl -s http://localhost:4000/api/health`
6. **Sync lockfile**: If `pnpm-lock.yaml` changed, regenerate with `npx pnpm@10.26.1 install` (CI uses pnpm 10.26.1; local may be pnpm 9 which produces incompatible lockfiles)
7. **Commit and push**: Always `git add -A && git commit && git push`
8. **Verify release/deploy state**: Check the relevant GitHub Actions run if you changed release or CI automation

**Never skip steps 3 and 7** — the client must be rebuilt (for service worker version) and pushed on every change.
**Always run step 6** when `pnpm-lock.yaml` is in the changeset — CI will fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` otherwise.

## Architecture

- **Monorepo**: pnpm workspaces for the web packages plus a Rust daemon in `apps/daemon`
- **Backend**: `gcpa` is the single product CLI. It runs the Rust + Axum daemon and manages auto-start service installation.
- **Client**: React SPA built with a custom `scripts/build.mjs` (no bundler). Bundled into the daemon binary and served from the same origin.
- **Client types**: `apps/client/src/lib/types.ts` — the client-local TypeScript contract for daemon JSON responses.
- **Database**: SQLite via `rusqlite`, stored under `APP_SUPPORT_DIR/data/assistant.sqlite`.
- **Copilot runtime**: ACP session history is the source of truth for transcript replay; SQLite stores app-owned metadata.

## Backend / CLI

- Dev run: `cargo run --manifest-path apps/daemon/Cargo.toml --bin gcpa -- daemon run`
- Port override: `gcpa daemon run --port 4310`
- Health + diagnostics: `gcpa daemon doctor`, `gcpa daemon paths`
- Start at login: `gcpa daemon service install`
- Status/restart: `gcpa daemon service status`, `gcpa daemon service restart`
- Update the installed CLI: `gcpa update`

## Client / PWA

- Service worker version is a content hash generated at build time
- SW registration URL includes the version: `service-worker.js?v=HASH`
- `updateViaCache: 'none'` ensures the browser always checks for a new worker
- Build version injected into `index.html` as `window.__GPA_BUILD_VERSION__`

## Key Patterns

- **Concurrent streaming**: Multiple chats can stream simultaneously (`streamingChatIds` is a `Set<string>`)
- **Hybrid persistence**: ACP sessions = source of truth for messages. SQLite = metadata only (threads, projects, attachments, preferences)
- **Runtime control surface**: The browser Settings modal shows daemon version, lifecycle mode, log/config paths, and the exact `gcpa` commands for restart/update/opening the UI
