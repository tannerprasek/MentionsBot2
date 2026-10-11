@echo off
rem Double-click to start CastBot on Windows. Opens the page in Chrome.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed. Opening the download page; install it, then double-click this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
if not exist node_modules call npm install --omit=dev
start "" cmd /c "timeout /t 2 >nul & start chrome http://localhost:8787 || start http://localhost:8787"
echo CastBot is running. Keep this window open while you watch. Close it to stop.
node src\server.js
