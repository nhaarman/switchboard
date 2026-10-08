# Switchboard

Your command center for Claude Code sessions.

Switchboard is a desktop app that gives you a unified view of all your Claude Code sessions across every project. Launch, resume, fork, and monitor sessions from a single window — no more juggling terminal tabs or digging through `~/.claude/projects` to find that one conversation from last week.

![Switchboard](build/screenshot.png)

### Key Features

- **Session Browser** — All your Claude Code sessions in one flat list — active sessions always on top, most recent first — searchable by content
- **Built-in Terminal** — Connect to running sessions or launch new ones without leaving the app
- **Status Notifications** — In-app alerts when a session is waiting for permission approval or user input
- **Fork & Resume** — Branch off from any point in a session's history
- **Full-Text Search** — Find any session by what was discussed, not just when it happened
- **Plans & Memory** — Browse and edit your plan files and CLAUDE.md memory in one place
- **Activity Stats** — Heatmap of your coding activity across all projects
- **Session Names** — Picks up session names from Claude Code's `/rename` command automatically

## Session Grid Overview

Toggle the grid overview from the sidebar for a bird's-eye view of all your open sessions at once, in the same order as the sidebar list.

![Session Grid Overview](build/screenshot-grid.png)

- **Live terminals** — Every open session renders its full terminal in a card, so you can monitor multiple Claude agents simultaneously.
- **Status at a glance** — Each card shows a running/stopped/busy indicator dot and last-activity timestamp.
- **Click to focus, double-click to expand** — Click a card header to focus it; double-click to switch back to single-terminal view for that session.
- **Persistent** — Grid preference is saved across restarts.

## Status Notifications

Switchboard monitors all your sessions in the background and shows status indicators in the sidebar so you can tell at a glance which sessions need attention — even when you're working in a different one.

![Status Notifications](build/screenshot-notifications.png)

- **Waiting for input** — A session that needs your response is highlighted so you don't miss it.
- **Permission approval** — When Claude is blocked waiting for a permission grant, the session badge lets you know immediately.
- **Activity indicators** — See which sessions are actively running, idle, or finished.

## Editor

| Shortcut | Action |
|----------|--------|
| `Cmd+F` / `Ctrl+F` | Find in file (also works in terminal) |
| `Cmd+G` / `Ctrl+G` | Go to line |

## Download

Grab the latest release for your platform:

**[Download Switchboard](https://github.com/doctly/switchboard/releases/latest)**

- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`, `.deb`, or `.pacman` (Arch/Manjaro)

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- Platform build tools for native modules:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential`, `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

## Development Setup

```bash
# Install dependencies (runs postinstall automatically)
npm install

# Start the app
npm start
```

`npm start` bundles CodeMirror and launches Electron. For faster iteration after the first run:

```bash
npm run electron
```

## Building

All build commands bundle CodeMirror first, then invoke electron-builder.

```bash
# Current platform
npm run build

# Platform-specific
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer (x64 + arm64)
npm run build:linux   # AppImage + deb + pacman (x64 + arm64)
```

Output goes to `dist/`.

### Building on Arch / Manjaro

The `deb` and `pacman` targets are built via the `fpm` binary bundled by
electron-builder, which links against `libcrypt.so.1`. Arch ships `libxcrypt`
without that legacy ABI, so install the compat shim once:

```bash
sudo pacman -S libxcrypt-compat
```

`AppImage` builds without it.

The pacman package is published as **`switchboard-doctly`** rather than
`switchboard` because the Arch `extra` repo already ships a package named
`switchboard` (elementary OS's Pantheon Control Center). Renaming avoids the
file-conflict that would block installation alongside it. The app itself is
still called Switchboard everywhere users see it — only the package identity
changes. Uninstall later with `sudo pacman -R switchboard-doctly`.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds for all platforms and publishes to GitHub Releases. You can also release locally:

```bash
npm run release   # builds + publishes to GitHub Releases
```

Set `GH_TOKEN` in your environment (a GitHub personal access token with `repo` scope).

## Auto-Updates

The app uses `electron-updater` to check for updates from GitHub Releases on launch and every 4 hours. Updates are only checked in packaged builds (not during development). The flow:

1. App auto-downloads updates in the background
2. A toast notification appears when the update is ready
3. User can restart immediately or dismiss (installs on next quit)

## Code Signing

For distribution, set these environment variables:

- **macOS**: `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- **Windows**: `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned memory execution, required by native modules (node-pty, better-sqlite3).

## Project Structure

```
main.js            Electron main process
preload.js         Context bridge (IPC bindings)
db.js              SQLite session cache & metadata
public/            Renderer (HTML/CSS/JS)
scripts/           Build & postinstall scripts
build/             Icons, entitlements, builder resources
.github/workflows/ CI/CD
```
