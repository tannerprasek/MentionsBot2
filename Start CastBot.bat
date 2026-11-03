@echo off
rem Double-click to start CastBot on Windows. Updates itself, then runs hidden and opens the page in Chrome.
cd /d "%~dp0"
curl -s -m 2 http://localhost:8787/api/version >nul 2>nul
if not errorlevel 1 goto openPage
powershell -NoProfile -ExecutionPolicy Bypass -File update.ps1
call launch.bat
exit /b 0
:openPage
start chrome http://localhost:8787 || start http://localhost:8787
exit /b 0
