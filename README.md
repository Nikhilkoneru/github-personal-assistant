# Continuum Chat

`continuum` is a local GitHub Copilot companion that runs a Rust daemon on your machine and serves the web UI from the same process. You install one CLI, run one daemon, and open one same-origin app for chat, projects, threads, ACP tool activity, attachments, and device-auth flows.

Continuum Chat is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by GitHub or Microsoft**. References to GitHub Copilot describe interoperability only.

## Current product status

`continuum` should currently be treated as an **early beta**.

- **macOS is the primary tested host platform today**
- Linux and Windows release archives are produced, but macOS is the platform that has been exercised most heavily end-to-end so far
- Expect active iteration around install UX, remote access, and mobile bandwidth optimizations while the product hardens

## Install the CLI

The official distribution channel is **GitHub Releases**.

1. Open the latest release: `https://github.com/nikhilkoneru/continuum-chat/releases/latest`
2. Download the archive for your platform:
   - macOS Apple Silicon: `continuum-aarch64-apple-darwin.tar.gz`
   - macOS Intel: `continuum-x86_64-apple-darwin.tar.gz`
   - Linux x86_64: `continuum-x86_64-unknown-linux-gnu.tar.gz`
   - Windows x86_64: `continuum-x86_64-pc-windows-msvc.zip`
3. Extract the archive and place `continuum` (or `continuum.exe`) somewhere on your `PATH`

Example for macOS Apple Silicon:

```bash
curl -L \
  https://github.com/nikhilkoneru/continuum-chat/releases/latest/download/continuum-aarch64-apple-darwin.tar.gz \
  -o continuum.tar.gz
tar -xzf continuum.tar.gz
install -m 755 continuum ~/.local/bin/continuum
```

After the first install, use:

```bash
continuum update
```

to upgrade in place from future releases.

## Durable macOS install with Tailscale HTTPS

If you want Continuum Chat to come back after daemon crashes and macOS restarts, install Tailscale first, then install Continuum as a login service.

1. Install Tailscale on macOS.
   - Recommended: download the standalone macOS installer from `https://tailscale.com/download`
   - Alternative: install the Mac App Store version
2. Open Tailscale, click **Log in** or **Get Started**, and sign up / sign in with your preferred identity provider.
3. Approve the macOS VPN/network extension prompt if Tailscale asks for it.
4. Confirm your Mac joined the tailnet. A quick check is:

```bash
tailscale status
```

5. Install the Continuum CLI and place `continuum` on your `PATH`.
6. Install the auto-start service and launch it immediately:

```bash
continuum daemon service install --start-now
```

7. Verify local health:

```bash
curl -s http://127.0.0.1:4000/api/health
continuum daemon doctor
```

8. Turn on HTTPS access through Tailscale Serve:

```bash
continuum remote-access tailscale enable
continuum remote-access tailscale status
```

9. Open the secure Tailscale URL shown by `continuum remote-access tailscale status` or `continuum daemon doctor`.

On macOS, `continuum daemon service install --start-now` installs a `launchd` user service with `RunAtLoad` and `KeepAlive`, so Continuum comes back when you sign back in after a reboot and is restarted automatically if the daemon exits unexpectedly.

## Package manager status

`continuum` is **not published to Homebrew, Winget, Scoop, apt, or Chocolatey yet**.

Those ecosystems require additional external repositories or package registries that cannot be fully managed from this repo alone. The release workflow now produces versioned archives and checksums so adding Homebrew and Winget next is straightforward, but GitHub Releases are the supported install path today.

## Run the daemon

Start the local daemon:

```bash
continuum run daemon
```

Then open the UI:

```bash
continuum open
```

The UI is served directly by the daemon, so the browser talks to the API over the same origin. There is no separate GitHub Pages deployment anymore.

By default, the frontend uses the exact origin you opened in the browser. If you open a Tailscale URL, the frontend uses that Tailscale URL for API requests too.

## Install the web UI as an app

The bundled UI is a **Progressive Web App (PWA)**, so after the daemon is running you can install it like an app on desktop or mobile.

General flow:

1. Start `continuum`
2. Open the UI with `continuum open` or your Tailscale `https://...ts.net` URL
3. Use your browser's install/add-to-home-screen action

Common install paths:

- **Safari on macOS**: open the UI, then use **File -> Add to Dock**
- **Chrome or Edge on macOS/Windows/Linux**: open the UI, then click the install icon in the address bar or use **Install app**
- **Safari on iPhone/iPad**: open the UI, tap **Share**, then **Add to Home Screen**
- **Chrome or Edge on Android**: open the UI, then use **Add to Home screen** or **Install app**

After install, the app launches in its own window and reconnects to the same daemon origin you installed it from. If you installed it from a Tailscale URL, that device still needs to be connected to the same tailnet.

Useful lifecycle commands:

```bash
continuum open
continuum remote-access tailscale status
continuum remote-access tailscale enable
continuum daemon service status
continuum daemon service restart
continuum update --check
continuum update
```

## Remote access with Tailscale

For customer access across devices, install **Tailscale on the machine running `continuum` and on the customer device**.

For the macOS host machine, the recommended order is:

1. Install Tailscale from `https://tailscale.com/download`
2. Launch it and complete sign-in / sign-up in the browser
3. Confirm the Mac is connected to your tailnet
4. Install Continuum and run `continuum daemon service install --start-now`
5. Run `continuum remote-access tailscale enable`

Once both devices are signed into the same tailnet:

1. Start the daemon with `continuum run daemon` or install the login service with `continuum daemon service install`
2. Run `continuum remote-access tailscale enable` once on the host machine to configure Tailscale Serve HTTPS for the daemon
3. Use `continuum open` on the host machine, or copy the secure URL shown by `continuum remote-access tailscale status` / `continuum daemon doctor`
4. Open that same `https://<device>.ts.net` URL on the customer device

`continuum open` prefers the secure Tailscale Serve URL when it exists. The app is same-origin, so the UI and API stay aligned automatically when opened over Tailscale.

## Auto-start and service management

The long-term product model is:

- `continuum run daemon` for foreground/local runs
- `continuum daemon service install --start-now` for starting on login and immediately booting the daemon
- `continuum daemon service restart` for a clean daemon restart after upgrades or config changes

If you are packaging or distributing `continuum` internally, prefer shipping the CLI binary and letting the CLI own daemon lifecycle instead of wrapping the Rust binary directly.

## Configuration

The daemon serves both the API and bundled UI locally. Port and runtime behavior are configured through the CLI/runtime config rather than a separate frontend deployment.

If you change config that affects the listening port or network binding, restart the daemon so the UI and API stay aligned on the same origin.

Existing installs that previously used the `gcpa` / `github-personal-assistant` name are migrated forward automatically when possible, and Continuum still preserves legacy browser storage key compatibility so you do not lose local settings during the rename.

## License and contributions

This repository is licensed under the **Apache License 2.0**. See [`LICENSE`](./LICENSE).

You can use, modify, and redistribute the project under that license, and contributions are welcome through issues and pull requests. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the preferred workflow and contribution guidelines.

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
cargo build --manifest-path apps/daemon/Cargo.toml --bin continuum
cargo test --manifest-path apps/daemon/Cargo.toml
```

## Release process

Tagged releases build platform archives for macOS, Linux, and Windows and publish them to GitHub Releases. The same release feed powers `continuum update`.
