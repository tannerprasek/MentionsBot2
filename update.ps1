# Called by "Start CastBot.bat": pulls the latest CastBot from GitHub, keeping settings and downloads.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$zip = 'https://github.com/tannerprasek/MentionsBot2/archive/refs/heads/claude/polymarket-mispricing-bot-01LWTtedp1AEAh3X33y5Gps2.zip'
$tmp = Join-Path $env:TEMP 'castbot-update'
try {
  Write-Host 'Checking for updates...'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item $tmp -ItemType Directory | Out-Null
  Invoke-WebRequest $zip -OutFile "$tmp\castbot.zip" -UseBasicParsing
  Expand-Archive "$tmp\castbot.zip" "$tmp\x"
  $src = (Get-ChildItem "$tmp\x" -Directory | Select-Object -First 1).FullName
  $oldLock = if (Test-Path package-lock.json) { (Get-FileHash package-lock.json).Hash } else { '' }
  robocopy $src . /E /XF 'Start CastBot.bat' settings.json .env /XD node_modules downloads /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "copy failed ($LASTEXITCODE)" }
  if ($oldLock -ne (Get-FileHash package-lock.json).Hash) { New-Item .needs-install -ItemType File -Force | Out-Null }
  Write-Host 'Up to date.'
} catch {
  Write-Host "Couldn't check for updates: $_"
  Write-Host 'Starting the version you have.'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
