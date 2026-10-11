@echo off
rem Double-click to start CastBot on Windows. Updates itself, then opens the page in Chrome.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed. Opening the download page; install it, then double-click this file again.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1
if not exist node_modules goto install
if exist .needs-install goto install
goto run
:install
call npm install --omit=dev --loglevel=error --no-audit --no-fund
del .needs-install 2>nul
:run
start "" cmd /c "timeout /t 2 >nul & start chrome http://localhost:8787 || start http://localhost:8787"
echo.
echo CastBot is running. Keep this window open while you watch. Close it to stop.
node src\server.js
pause
