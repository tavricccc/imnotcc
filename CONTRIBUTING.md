# Contributing

## Prerequisites

- Node.js 20 or newer
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and signed in on your machine
- Optional: WSL (for running Linux-path sessions on Windows)

## Local Development

```bash
npm install
npm run dev
```

`npm run dev` starts:
- Vite dev server on `http://127.0.0.1:5173`
- Backend API + WebSocket server on `http://127.0.0.1:4290` with `--watch-path=server` and isolated data in `data/dev/`

To develop the frontend against an already-running server (for example on port `4280`):

```bash
npm run dev -- --attach=4280
```

## Project Layout

- `server/` — Express HTTP API, WebSocket server, `@anthropic-ai/claude-agent-sdk` runner, auth, state (`data/state.json`), git diff/changes, plugin management, and WSL bridge.
- `web/src/` — React 19 + TypeScript + Tailwind CSS v4 frontend and PWA assets (`web/public/`).
- `scripts/` — Dev launcher (`dev.mjs`), icon generator (`icons.mjs`), and Windows startup template (`run.example.cmd`).
- `test/smoke.mjs` — End-to-end smoke test against the real Claude Code CLI (uses `haiku`).

## Running Tests

`test/smoke.mjs` starts a temporary server on port `4291` with a throwaway data directory and runs real Claude Code turns:

```bash
npm test
```

To test WSL session execution on Windows:

```bash
node test/smoke.mjs --wsl
```

## Pull Requests

- Keep changes focused and verify `npm run build` passes before opening a PR.
- Run `npm test` when touching `server/` or WebSocket protocol behavior.
- Note that the UI copy in `web/src/` is currently Traditional Chinese (`zh-TW`).
