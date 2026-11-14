@echo off
cd /d "%~dp0.."
set CC_REMOTE_PORT=4280
set CC_REMOTE_ORIGINS=https://cc.example.com,http://localhost:5173,http://127.0.0.1:5173
if not exist "%LOCALAPPDATA%\cc-remote" mkdir "%LOCALAPPDATA%\cc-remote"
node server\index.js >> "%LOCALAPPDATA%\cc-remote\cc-remote.log" 2>&1
