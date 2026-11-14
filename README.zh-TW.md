<div align="center">
  <img src="web/public/icon.svg" width="80" height="80" alt="cc-remote" />
  <h1>cc-remote</h1>
  <p>用手機或瀏覽器遠端操作本機的 Claude Code CLI。</p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20" />
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20WSL-lightgrey.svg" alt="Platform: Windows | WSL" />
    <img src="https://img.shields.io/badge/PWA-ready-orange.svg" alt="PWA Ready" />
  </p>

  <p>
    <a href="README.md">English</a> · <strong>繁體中文</strong>
  </p>
</div>

---

`cc-remote` 以 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 搭配行動端優先的 PWA 介面。Session 依資料夾分組，對話紀錄直接讀寫本機的 `~/.claude/projects/`，因此能沿用電腦上既有的 `CLAUDE.md`、MCP、plugin 與訂閱額度，也能隨時回到電腦執行 `claude --resume <id>` 接續工作。

## 功能

- **依資料夾分組與臨時 session**：在已儲存的專案資料夾下建立 session，或開臨時 session；支援分支（`forkSession`）、改名（`renameSession`）與從列表移除（不刪除 CLI 紀錄檔）。
- **串流對話與工具卡片**：透過 WebSocket 即時串流輸出、展開檢視工具呼叫與結果、預覽圖片與上傳圖片提問。關閉網頁後任務仍會在伺服器繼續執行，重新開啟時自動補回錯過的訊息。
- **權限控制**：每個 session 可切換權限模式（`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`、`dontAsk`），非 bypass 模式下可在手機上即時允許或拒絕工具請求。
- **斜線指令與快捷操作**：支援 SDK 回傳的 `/` 指令選單、切換模型與 effort、調整 `/autocompact` 門檻、中斷執行，以及一鍵複製 `cd <cwd> && claude --resume <id>`。
- **用量檢視**：顯示 context token 細項、autocompact 門檻，以及 5 小時／7 天方案用量。
- **Plugin 管理**：透過 `claude plugin` 檢視、安裝、移除、啟用、停用 plugin 與新增 marketplace。
- **WSL 支援（Windows）**：路徑以 `/` 開頭的資料夾會自動在 WSL（`CC_REMOTE_WSL_DISTRO`，預設 `Ubuntu`）中執行。
- **PWA**：可安裝至 iOS／Android 主畫面。

## 架構

```text
手機 / 瀏覽器（React PWA）
  └─ HTTPS + WebSocket ─► Tunnel / 反向代理（例如 Cloudflare Tunnel + Access）
                            └─ 127.0.0.1:4280 ─► Express + ws ─► @anthropic-ai/claude-agent-sdk ─► 本機 Claude Code CLI
```

- 伺服器僅監聽 `127.0.0.1`，不直接對區網或公網開 port。
- App 狀態（session 索引、資料夾清單、偏好設定、密碼雜湊）存於 `data/state.json`，對話歷史直接讀取 `~/.claude/projects/`。

## 系統需求

- **Node.js** 20 以上
- 本機已安裝並登入 **Claude Code CLI**
- 選用：**Cloudflare Tunnel + Access**（或 Tailscale 等反向代理），供手機從外部 HTTPS 連線

## 快速開始

```bash
git clone https://github.com/tavricccc/cc-remote.git
cd cc-remote
npm install
npm run build
npm start
```

首次啟動時若未設定 `CC_REMOTE_PASSWORD`，系統會自動產生一組隨機密碼並寫入 `data/password.txt`。開啟 `http://127.0.0.1:4280` 登入後，建議至「設定 → 帳號」更改密碼並刪除 `data/password.txt`。

## 外部連線與安全設定

將 Tunnel 或反向代理指向 `http://127.0.0.1:4280`，並透過 `CC_REMOTE_ORIGINS` 指定對外網址：

```bash
CC_REMOTE_ORIGINS=https://cc.example.com npm start
```

由於 `cc-remote` 等同於遠端操作本機環境，建議在 Tunnel 前端加上 **Cloudflare Access** 或 **Tailscale** 等身分驗證層，與 app 密碼形成雙層防護。詳見 [SECURITY.md](SECURITY.md)。

## 背景常駐（Windows 工作排程器）

在 Windows 上可透過 Task Scheduler 於登入時自動在背景啟動，不會跳出終端機視窗：

1. 將 [scripts/run.example.cmd](scripts/run.example.cmd) 複製到 `%LOCALAPPDATA%\cc-remote\run.cmd`，再修改內容：
   - **必改：** 把 `cd /d "C:\path\to\cc-remote"` 改成你 clone `cc-remote` 的資料夾。複製後腳本已不在專案內，若用 `%~dp0..` 這類相對路徑會指到 `%LOCALAPPDATA%`，`node server\index.js` 就會啟動失敗。
   - 修改 `CC_REMOTE_ORIGINS`。
2. 在 PowerShell 註冊排程工作：

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

- `conhost.exe --headless` 可避免登入時閃出命令提示字元視窗。
- `ExecutionTimeLimit 0` 可停用排程器預設的 72 小時強制中止限制。

更新程式碼後重新 build 並重啟服務：

```powershell
npm run build
Stop-ScheduledTask -TaskName 'cc-remote'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'server\\index\.js' | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName 'cc-remote'
```

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `CC_REMOTE_PORT` | `4280`（開發模式 `4290`） | 監聽的本機 port（`127.0.0.1`）。 |
| `CC_REMOTE_ORIGINS` | — | 允許的來源網域，逗號分隔（例如 `https://cc.example.com`）。 |
| `CC_REMOTE_DATA_DIR` | `data/`（開發模式 `data/dev/`） | 存放 `state.json` 與初始 `password.txt` 的目錄。 |
| `CC_REMOTE_PASSWORD` | 首次啟動隨機產生 | 尚未建立帳號紀錄時的初始登入密碼。 |
| `CC_REMOTE_WSL_DISTRO` | `Ubuntu` | Windows 上路徑為 `/` 開頭時使用的 WSL 發行版名稱。 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | **Windows** session 讀取 `settings.json` 與對話紀錄的 Claude Code 設定目錄。**WSL** session 不使用此變數，而是使用 WSL 內的 `~/.claude`（經由 `//wsl.localhost/<distro>` 讀取）。 |

## 開發與測試

```bash
# 啟動 Vite (5173) 與開發後端 (4290，含檔案監聽)
npm run dev

# 只啟動 Vite，接到已在 4280 執行的伺服器
npm run dev -- --attach=4280

# 執行端對端測試（會啟動暫存伺服器並呼叫真實 Claude Code haiku）
npm test
```

專案結構與貢獻說明見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權條款

[Apache-2.0](LICENSE)
