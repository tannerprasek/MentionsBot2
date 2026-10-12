@echo off
rem Double-click to start CastBot on Windows. Updates itself, then opens the page in Chrome.
cd /d "%~dp0"
set "NODE_VERSION=22.23.2"

rem Use the installed Node.js, or a private copy in .\runtime (downloaded the first time).
where node >nul 2>nul
if not errorlevel 1 goto haveNode
if exist "runtime\node.exe" goto useRuntime
echo Node.js isn't installed. Downloading a private copy for CastBot, one time, about 30 MB...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $v='%NODE_VERSION%'; $zip=Join-Path $env:TEMP ('node-'+$v+'.zip'); $tmp=Join-Path $env:TEMP 'castbot-node'; Invoke-WebRequest ('https://nodejs.org/dist/v'+$v+'/node-v'+$v+'-win-x64.zip') -OutFile $zip -UseBasicParsing; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive $zip $tmp; Move-Item (Join-Path $tmp ('node-v'+$v+'-win-x64')) 'runtime'; Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force"
if exist "runtime\node.exe" goto useRuntime
echo Couldn't download Node.js. Install it from https://nodejs.org, then double-click this file again.
start https://nodejs.org/en/download
pause
exit /b 1
:useRuntime
set "PATH=%~dp0runtime;%PATH%"
:haveNode

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
