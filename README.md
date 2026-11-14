<div align="center">
  <img src="web/public/icon.svg" width="80" height="80" alt="cc-remote" />
  <h1>cc-remote</h1>
  <p>Operate your local Claude Code CLI from your phone or browser.</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20" />
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20WSL-lightgrey.svg" alt="Platform: Windows | WSL" />
    <img src="https://img.shields.io/badge/PWA-ready-orange.svg" alt="PWA Ready" />
  </p>

  <p>
    <strong>English</strong> · <a href="README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

`cc-remote` wraps the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) in a mobile-first PWA. Sessions are grouped by project folder and stored in Claude Code's own `~/.claude/projects/` directory, so you keep your existing `CLAUDE.md`, MCP servers, plugins, and subscription—and can switch back to `claude --resume <id>` on your desktop anytime.

## Features

- **Folder-grouped & temporary sessions**: Create persistent sessions under saved project folders or quick temporary sessions, fork (`forkSession`), rename (`renameSession`), or remove them from the list without deleting CLI transcripts.
- **Streaming chat & tool cards**: Token-by-token WebSocket streaming, expandable tool call cards, inline/lightbox image previews, and image prompt attachments. Running turns continue on the server if you close the tab and catch up on reconnect.
- **Interactive permission control**: Switch permission modes (`default`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk`) per session, and approve or deny individual tool requests from your phone.
- **Slash commands & session controls**: Trigger SDK-reported `/` commands, switch models and effort levels, adjust `/autocompact` thresholds, interrupt active turns, or copy `cd <cwd> && claude --resume <id>`.
- **Context & plan usage**: Inspect token breakdown, autocompact threshold, and 5-hour / 7-day plan rate limits.
- **Plugin management**: List, install, uninstall, enable, disable, and add marketplaces via `claude plugin`.
- **WSL support (Windows)**: Folders starting with `/` run inside WSL (`CC_REMOTE_WSL_DISTRO`, default `Ubuntu`).
- **PWA**: Installable on iOS and Android with offline shell caching.

> Note: The web UI is currently in Traditional Chinese (`zh-TW`).

## Architecture

```text
Phone / Browser (React PWA)
  └─ HTTPS + WebSocket ─► Tunnel / Reverse Proxy (e.g. Cloudflare Tunnel + Access)
                            └─ 127.0.0.1:4280 ─► Express + ws ─► @anthropic-ai/claude-agent-sdk ─► Local Claude Code CLI
```

- The server binds to `127.0.0.1` only.
- App metadata (session index, folders, preferences, password hash) lives in `data/state.json`. Message transcripts stay in `~/.claude/projects/`.

## Prerequisites

- **Node.js** 20 or newer
- **Claude Code CLI** installed and authenticated on the host machine
- Optional: **Cloudflare Tunnel + Access** (or Tailscale / reverse proxy) for remote HTTPS access

## Quick Start

```bash
git clone https://github.com/tavricccc/cc-remote.git
cd cc-remote
npm install
npm run build
npm start
```

On first start, if `CC_REMOTE_PASSWORD` is not set, a random password is generated and written to `data/password.txt`. Open `http://127.0.0.1:4280`, sign in, and delete `data/password.txt` once you have saved or changed the password in **Settings → Account**.

## Remote Access (Tunnel + Auth)

Point your tunnel or reverse proxy to `http://127.0.0.1:4280` and set `CC_REMOTE_ORIGINS` to your public URL:

```bash
CC_REMOTE_ORIGINS=https://cc.example.com npm start
```

Because `cc-remote` can execute commands on your machine, put an identity layer (such as **Cloudflare Access** or **Tailscale**) in front of the tunnel in addition to the built-in app password. See [SECURITY.md](SECURITY.md) for details.

## Running in the Background (Windows Task Scheduler)

On Windows, you can run `cc-remote` automatically at sign-in without a visible console window:

1. Copy [scripts/run.example.cmd](scripts/run.example.cmd) to `%LOCALAPPDATA%\cc-remote\run.cmd` and update `CC_REMOTE_ORIGINS` (and the `cd` path if needed).
2. Register the scheduled task in PowerShell:

```powershell
$action = New-ScheduledTaskAction `
  -Execute 'C:\Windows\System32\conhost.exe' `
  -Argument "--headless C:\Windows\System32\cmd.exe /c `"$env:LOCALAPPDATA\cc-remote\run.cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT20S'
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'cc-remote' -Action $action -Trigger $trigger -Settings $settings
```

- `conhost.exe --headless` prevents a console window from flashing.
- `ExecutionTimeLimit 0` disables Task Scheduler's default 72-hour timeout.

To apply updates after pulling new code:

```powershell
npm run build
Stop-ScheduledTask -TaskName 'cc-remote'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'server\\index\.js' | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName 'cc-remote'
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CC_REMOTE_PORT` | `4280` (`4290` in dev) | Port to listen on (`127.0.0.1`). |
| `CC_REMOTE_ORIGINS` | — | Comma-separated allowed origins (e.g. `https://cc.example.com`) for API and WebSocket requests. |
| `CC_REMOTE_DATA_DIR` | `data/` (`data/dev/` in dev) | Directory for `state.json` and initial `password.txt`. |
| `CC_REMOTE_PASSWORD` | Random on first run | Initial login password when `state.json` has no auth record yet. |
| `CC_REMOTE_WSL_DISTRO` | `Ubuntu` | WSL distribution used when a session folder starts with `/`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config directory read for `settings.json` and transcripts. |

## Development & Testing

```bash
# Start Vite (5173) + API server (4290) with watch mode
npm run dev

# Or attach Vite to an already-running server on port 4280
npm run dev -- --attach=4280

# End-to-end smoke test against the real Claude Code CLI (uses haiku)
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for project layout and PR guidelines.

## License

[Apache-2.0](LICENSE)
