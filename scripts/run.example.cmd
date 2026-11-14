@echo off
rem Change this to the folder where you cloned imnotcc. Do not use %~dp0 here: once this
rem file is copied to %LOCALAPPDATA%\imnotcc, %~dp0 points there instead of the project.
cd /d "C:\path\to\cc-remote" || exit /b 1
set CC_REMOTE_PORT=4280
set CC_REMOTE_ORIGINS=https://cc.example.com,http://localhost:5173,http://127.0.0.1:5173
if not exist "%LOCALAPPDATA%\imnotcc" mkdir "%LOCALAPPDATA%\imnotcc"
node server\index.js >> "%LOCALAPPDATA%\imnotcc\cc-remote.log" 2>&1
