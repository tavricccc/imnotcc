<div align="center">
  <img src="web/public/icon.svg" width="80" height="80" alt="imnotcc" />
  <h1>imnotcc</h1>
  <p>Claude Code 的圖形介面：Windows App、手機 PWA，同一份對話到哪都接得上。</p>

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

`imnotcc` 不是 Claude Code，而是它的前端。在電腦上用 Windows App（也能順便當 server），想離開座位時再用手機或任何瀏覽器接著用。底層以 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 打造。對話依資料夾分組，對話紀錄直接讀寫本機的 `~/.claude/projects/`，因此能沿用電腦上既有的 `CLAUDE.md`、MCP、擴充元件與訂閱額度，也能隨時回到電腦執行 `claude --resume <id>` 接續工作。

## 功能

- **依資料夾分組與臨時對話**：在已儲存的專案資料夾下建立對話，或開臨時對話；支援分支（`forkSession`）、改名（`renameSession`）與從列表移除（不刪除 CLI 紀錄檔）。
- **串流對話與工具卡片**：透過 WebSocket 即時串流輸出、展開檢視工具呼叫與結果、預覽圖片與上傳圖片提問。關閉網頁後任務仍會在伺服器繼續執行，重新開啟時自動補回錯過的訊息。
- **檔案預覽與差異**：Claude 提到的檔案會變成可點的標籤，在預覽面板中開啟（寬螢幕在對話右側，手機為 sheet），支援 Markdown 排版、程式碼上色、圖片與 PDF。每回合變更的檔案可逐一開啟左右對照的 diff。本機 HTML 會在新分頁以 sandbox 開啟，與 app 隔離。回合 diff 依賴 git 快照，約兩週後可能被 `git gc` 清除。
- **權限控制**：每個對話可切換權限模式（`default`、`acceptEdits`、`plan`、`auto`、`bypassPermissions`、`dontAsk`），非 bypass 模式下可在手機上即時允許或拒絕工具請求。
- **斜線指令與快捷操作**：支援 SDK 回傳的 `/` 指令選單、切換模型與 effort、調整 `/autocompact` 門檻、中斷執行，以及一鍵複製 `cd <cwd> && claude --resume <id>`。
- **用量檢視**：顯示 context token 細項、autocompact 門檻，以及 5 小時／7 天方案用量。
- **工作中送出訊息**：可「加入佇列」等這一回合結束，或「引導」插進正在跑的回合；預設在設定裡選，長按送出（電腦用 Ctrl+Enter）單次改用另一種。
- **App 內登入 Claude**：Claude Code 未登入或登入過期時，App 會提示並帶你完成登入，不用開終端機。
- **擴充元件管理**：透過 `claude plugin` 檢視、安裝、移除、啟用、停用擴充元件與新增 marketplace。
- **WSL 支援（Windows）**：路徑以 `/` 開頭的資料夾會自動在 WSL（`IMNOTCC_WSL_DISTRO`，預設 `Ubuntu`）中執行。
- **PWA**：可安裝至 iOS／Android 主畫面。

## 架構

```text
手機 / 瀏覽器（React PWA）
  └─ HTTPS + WebSocket ─► Tunnel / 反向代理（例如 Cloudflare Tunnel + Access）
                            └─ 127.0.0.1:4280 ─► Express + ws ─► @anthropic-ai/claude-agent-sdk ─► 本機 Claude Code CLI
```

- 伺服器僅監聽 `127.0.0.1`，不直接對區網或公網開 port。
- App 狀態（對話索引、資料夾清單、偏好設定、密碼雜湊）存於 `data/state.json`，對話歷史直接讀取 `~/.claude/projects/`。

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

首次啟動時若未設定 `IMNOTCC_PASSWORD`，系統會自動產生一組隨機密碼並寫入 `data/password.txt`。開啟 `http://127.0.0.1:4280` 登入後，建議至「設定 → 帳號」更改密碼並刪除 `data/password.txt`。

## 外部連線與安全設定

將 Tunnel 或反向代理指向 `http://127.0.0.1:4280`，並透過 `IMNOTCC_ORIGINS` 指定對外網址：

```bash
IMNOTCC_ORIGINS=https://cc.example.com npm start
```

由於 `imnotcc` 等同於遠端操作本機環境，建議在 Tunnel 前端加上 **Cloudflare Access** 或 **Tailscale** 等身分驗證層，與 app 密碼形成雙層防護。詳見 [SECURITY.md](SECURITY.md)。

## 背景常駐（Windows 工作排程器）

在 Windows 上可透過 Task Scheduler 於登入時自動在背景啟動，不會跳出終端機視窗：

1. 將 [scripts/run.example.cmd](scripts/run.example.cmd) 複製到 `%LOCALAPPDATA%\imnotcc\run.cmd`，再修改內容：
   - **必改：** 把 `cd /d "C:\path\to\cc-remote"` 改成你 clone `imnotcc` 的資料夾。複製後腳本已不在專案內，若用 `%~dp0..` 這類相對路徑會指到 `%LOCALAPPDATA%`，`node server\index.js` 就會啟動失敗。
   - 修改 `IMNOTCC_ORIGINS`。
2. 在 PowerShell 註冊排程工作：

```powershell
$action = New-ScheduledTaskAction `
  -Execute 'C:\Windows\System32\conhost.exe' `
  -Argument "--headless C:\Windows\System32\cmd.exe /c `"$env:LOCALAPPDATA\imnotcc\run.cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT20S'
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName 'imnotcc' -Action $action -Trigger $trigger -Settings $settings
```

- `conhost.exe --headless` 可避免登入時閃出命令提示字元視窗。
- `ExecutionTimeLimit 0` 可停用排程器預設的 72 小時強制中止限制。

更新程式碼後重新 build 並重啟服務：

```powershell
npm run build
Stop-ScheduledTask -TaskName 'imnotcc'
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -match 'server\\index\.js' | ForEach-Object { Stop-Process -Id $_.ProcessId }
Start-ScheduledTask -TaskName 'imnotcc'
```

## 環境變數

| 變數 | 預設值 | 說明 |
|---|---|---|
| `IMNOTCC_PORT` | `4280`（開發模式 `4290`） | 監聽的本機 port（`127.0.0.1`）。 |
| `IMNOTCC_ORIGINS` | — | 允許的來源網域，逗號分隔（例如 `https://cc.example.com`）。 |
| `IMNOTCC_DATA_DIR` | `data/`（開發模式 `data/dev/`） | 存放 `state.json` 與初始 `password.txt` 的目錄。 |
| `IMNOTCC_PASSWORD` | 首次啟動隨機產生 | 尚未建立帳號紀錄時的初始登入密碼。 |
| `IMNOTCC_WSL_DISTRO` | `Ubuntu` | Windows 上路徑為 `/` 開頭時使用的 WSL 發行版名稱。 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | **Windows** 對話讀取 `settings.json` 與對話紀錄的 Claude Code 設定目錄。**WSL** 對話不使用此變數，而是使用 WSL 內的 `~/.claude`（經由 `//wsl.localhost/<distro>` 讀取）。 |

改名為 imnotcc 之前的 `CC_REMOTE_*` 變數名稱仍然有效。

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
