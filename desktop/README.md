# imnotcc

Windows app: the imnotcc window onto your server, a tray icon, and an optional server on this PC.

- First run asks for a server address, or sets this PC up as the server. Setting up needs
  Node.js 20+ on PATH and a signed-in Claude Code; it copies the bundled server files and runs
  `npm ci --omit=dev` (about 400 MB, mostly the Agent SDK's Claude Code binary).
- Closing the window keeps the app and the local server in the tray. 結束 in the tray stops both.
  The server runs in a job object, so it also stops if the app is killed or crashes.
- Files live in `%LOCALAPPDATA%\dev.imnotcc.app`: `config.json`, `server-app\`, `data\`
  (password, state), `logs\`. The local server port is `port` in `config.json` (default 4280).
- The remote page loads as its own origin, so the server needs no changes. Only the bundled
  setup page may call the app's commands; Tauri's ACL refuses them from server pages.

Build (needs Rust): `npm install`, then `npm run build` in this folder. The installer lands in
`src-tauri/target/release/bundle/nsis/`.
