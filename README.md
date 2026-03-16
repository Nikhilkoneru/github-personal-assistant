# GitHub Personal Assistant

`gcpa` is a local GitHub Copilot companion that runs a Rust daemon on your machine and serves the web UI from the same process. You install one CLI, run one daemon, and open one same-origin app for chat, projects, threads, ACP tool activity, attachments, and device-auth flows.

## Current product status

`gcpa` should currently be treated as an **early beta**.

- **macOS is the primary tested host platform today**
- Linux and Windows release archives are produced, but macOS is the platform that has been exercised most heavily end-to-end so far
- Expect active iteration around install UX, remote access, and mobile bandwidth optimizations while the product hardens

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

By default, the frontend uses the exact origin you opened in the browser. If you open a Tailscale URL, the frontend uses that Tailscale URL for API requests too.

## Install the web UI as an app

The bundled UI is a **Progressive Web App (PWA)**, so after the daemon is running you can install it like an app on desktop or mobile.

General flow:

1. Start `gcpa`
2. Open the UI with `gcpa open` or your Tailscale `https://...ts.net` URL
3. Use your browser's install/add-to-home-screen action

Common install paths:

- **Safari on macOS**: open the UI, then use **File -> Add to Dock**
- **Chrome or Edge on macOS/Windows/Linux**: open the UI, then click the install icon in the address bar or use **Install app**
- **Safari on iPhone/iPad**: open the UI, tap **Share**, then **Add to Home Screen**
- **Chrome or Edge on Android**: open the UI, then use **Add to Home screen** or **Install app**

After install, the app launches in its own window and reconnects to the same daemon origin you installed it from. If you installed it from a Tailscale URL, that device still needs to be connected to the same tailnet.

Useful lifecycle commands:

```bash
gcpa open
gcpa remote-access tailscale status
gcpa remote-access tailscale enable
gcpa daemon service status
gcpa daemon service restart
gcpa update --check
gcpa update
```

## Remote access with Tailscale

For customer access across devices, install **Tailscale on the machine running `gcpa` and on the customer device**.

Once both devices are signed into the same tailnet:

1. Start the daemon with `gcpa run daemon` or install the login service with `gcpa daemon service install`
2. Run `gcpa remote-access tailscale enable` once on the host machine to configure Tailscale Serve HTTPS for the daemon
3. Use `gcpa open` on the host machine, or copy the secure URL shown by `gcpa remote-access tailscale status` / `gcpa daemon doctor`
4. Open that same `https://<device>.ts.net` URL on the customer device

`gcpa open` prefers the secure Tailscale Serve URL when it exists. The app is same-origin, so the UI and API stay aligned automatically when opened over Tailscale.

## Auto-start and service management

The long-term product model is:

- `gcpa run daemon` for foreground/local runs
- `gcpa` service/install commands for starting on login
- `gcpa daemon service restart` for a clean daemon restart after upgrades or config changes

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
