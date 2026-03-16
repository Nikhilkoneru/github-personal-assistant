# GitHub Personal Assistant

`gcpa` is a local GitHub Copilot companion that runs a Rust daemon on your machine and serves the web UI from the same process. You install one CLI, run one daemon, and open one same-origin app for chat, projects, threads, ACP tool activity, attachments, and device-auth flows.

## Install the CLI

The official distribution channel is **GitHub Releases**.

1. Open the latest release: `https://github.com/nikhilkoneru/github-personal-assistant/releases/latest`
2. Download the archive for your platform:
   - macOS Apple Silicon: `gcpa-aarch64-apple-darwin.tar.gz`
   - macOS Intel: `gcpa-x86_64-apple-darwin.tar.gz`
   - Linux x86_64: `gcpa-x86_64-unknown-linux-gnu.tar.gz`
   - Windows x86_64: `gcpa-x86_64-pc-windows-msvc.zip`
3. Extract the archive and place `gcpa` (or `gcpa.exe`) somewhere on your `PATH`

Example for macOS Apple Silicon:

```bash
curl -L \
  https://github.com/nikhilkoneru/github-personal-assistant/releases/latest/download/gcpa-aarch64-apple-darwin.tar.gz \
  -o gcpa.tar.gz
tar -xzf gcpa.tar.gz
install -m 755 gcpa ~/.local/bin/gcpa
```

After the first install, use:

```bash
gcpa update
```

to upgrade in place from future releases.

## Package manager status

`gcpa` is **not published to Homebrew, Winget, Scoop, apt, or Chocolatey yet**.

Those ecosystems require additional external repositories or package registries that cannot be fully managed from this repo alone. The release workflow now produces versioned archives and checksums so adding Homebrew and Winget next is straightforward, but GitHub Releases are the supported install path today.

## Run the daemon

Start the local daemon:

```bash
gcpa run daemon
```

Then open the UI:

```bash
gcpa open
```

The UI is served directly by the daemon, so the browser talks to the API over the same origin. There is no separate GitHub Pages deployment anymore.

Useful lifecycle commands:

```bash
gcpa status
gcpa restart
gcpa update --check
gcpa update
```

## Auto-start and service management

The long-term product model is:

- `gcpa run daemon` for foreground/local runs
- `gcpa` service/install commands for starting on login
- `gcpa restart` for a clean daemon restart after upgrades or config changes

If you are packaging or distributing `gcpa` internally, prefer shipping the CLI binary and letting the CLI own daemon lifecycle instead of wrapping the Rust binary directly.

## Configuration

The daemon serves both the API and bundled UI locally. Port and runtime behavior are configured through the CLI/runtime config rather than a separate frontend deployment.

If you change config that affects the listening port or network binding, restart the daemon so the UI and API stay aligned on the same origin.

## Features

- Rust daemon with bundled React SPA
- GitHub Copilot chat via ACP
- Same-origin UI and API
- Thread/project persistence
- Attachment upload and rendering
- Device-auth and local session flows
- Tool call activity and interactive ACP permission/input handling
- CLI-driven updates via GitHub Releases

## Repository layout

- `apps/daemon` — Rust CLI + daemon
- `apps/client` — React UI bundled into the daemon at build time
- `projects/` — local project material and non-product experiments

## Development

Install dependencies:

```bash
npx pnpm@10.26.1 install
```

Validate the client:

```bash
pnpm exec tsc -p apps/client/tsconfig.build.json --noEmit
node apps/client/scripts/build.mjs
```

Validate the daemon:

```bash
cargo build --manifest-path apps/daemon/Cargo.toml --bin gcpa
cargo test --manifest-path apps/daemon/Cargo.toml
```

## Release process

Tagged releases build platform archives for macOS, Linux, and Windows and publish them to GitHub Releases. The same release feed powers `gcpa update`.

## Notes

- The old GitHub Pages deployment path has been removed.
- The old shared TypeScript package has been folded into the client package.
- Local research material under `projects/` is not part of the shipped product surface.
