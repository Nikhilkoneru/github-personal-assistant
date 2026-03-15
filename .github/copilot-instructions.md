# Copilot Instructions for github-personal-assistant

## Deployment Checklist

After every code change, always complete these steps:

1. **Type-check**: `pnpm exec tsc -p apps/api/tsconfig.json --noEmit` and `pnpm exec tsc -p apps/client/tsconfig.build.json --noEmit`
2. **Build API**: `pnpm exec tsc -p apps/api/tsconfig.json`
3. **Build client**: `node apps/client/scripts/build.mjs` — this regenerates `dist/`, `service-worker.js`, and the build version hash
4. **Restart backend**: Kill old process on port 4000, start with `HOST=0.0.0.0 node apps/api/dist/index.js`
5. **Verify backend**: `curl -s http://localhost:4000/api/health`
6. **Sync lockfile**: If `pnpm-lock.yaml` changed, regenerate with `npx pnpm@10.26.1 install` (CI uses pnpm 10.26.1; local may be pnpm 9 which produces incompatible lockfiles)
7. **Commit and push**: Always `git add -A && git commit && git push` — this triggers GitHub Pages deployment via `.github/workflows/deploy-pages.yml`
8. **Verify deployment**: Check that the Pages workflow run completed successfully

**Never skip steps 3 and 7** — the client must be rebuilt (for service worker version) and pushed (for Pages deployment) on every change.
**Always run step 6** when pnpm-lock.yaml is in the changeset — CI will fail with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` otherwise.

## Architecture

- **Monorepo**: pnpm workspaces — `apps/api`, `apps/client`, `packages/shared`
- **API**: Node.js + Express, CJS (no "type" field), TypeScript compiled with CommonJS module resolution. Uses `new Function('return import(...)')()` to dynamically import the ESM-only `@github/copilot-sdk`.
- **Client**: React SPA built with a custom `scripts/build.mjs` (no bundler). Served as static files from GitHub Pages.
- **Shared types**: `packages/shared/src/index.ts` — contract between client and API
- **Database**: Node.js built-in SQLite (experimental). Schema in `apps/api/src/db.ts`
- **Copilot SDK**: `@github/copilot-sdk` — ESM-only package. SDK sessions are the source of truth for message history. SQLite stores only thread/project metadata.

## Backend

- Runs on port 4000 (from `.env`)
- Must bind to `0.0.0.0` (not `127.0.0.1`) for Tailscale access: `HOST=0.0.0.0`
- Uses `--experimental-specifier-resolution=node` flag for copilot-sdk ESM resolution
- **vscode-jsonrpc ESM fix**: A pnpm patch (`patches/vscode-jsonrpc@8.2.1.patch`) adds an exports map to vscode-jsonrpc so the SDK's `import "vscode-jsonrpc/node"` resolves correctly. After `pnpm install`, this patch is auto-applied.
- Start command: `HOST=0.0.0.0 node --experimental-specifier-resolution=node apps/api/dist/index.js`
- Tailscale IP for this machine: check `tailscale status`

## Client / PWA

- Service worker version is a content hash generated at build time
- SW registration URL includes the version: `service-worker.js?v=HASH`
- `updateViaCache: 'none'` ensures browser always checks for new worker
- Build version injected into `index.html` as `window.__GPA_BUILD_VERSION__`

## Key Patterns

- **Concurrent streaming**: Multiple chats can stream simultaneously (`streamingChatIds` is a `Set<string>`)
- **Hybrid persistence**: SDK = source of truth for messages. SQLite = metadata only (threads, projects, attachments, preferences)
- **Thread detail hydration**: `GET /api/threads/:id` loads messages from SDK session via `hydrateThreadDetailFromSession()`
