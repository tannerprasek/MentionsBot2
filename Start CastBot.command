#!/bin/bash
# Double-click to start CastBot on a Mac. Updates itself, then opens the page in Chrome.
cd "$(dirname "$0")"

# Already running? Just open the page.
if curl -fs -m 2 http://localhost:8787/api/version >/dev/null 2>&1; then
  open -a "Google Chrome" "http://localhost:8787" 2>/dev/null || open "http://localhost:8787"
  exit 0
fi

ZIP="https://github.com/tannerprasek/MentionsBot2/archive/refs/heads/claude/polymarket-mispricing-bot-01LWTtedp1AEAh3X33y5Gps2.zip"
TMP="$(mktemp -d)"
echo "Checking for updates..."
if curl -fsSL "$ZIP" -o "$TMP/castbot.zip" && unzip -q "$TMP/castbot.zip" -d "$TMP/x"; then
  SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
  OLD="$(shasum package-lock.json 2>/dev/null)"
  rsync -a --exclude node_modules --exclude runtime --exclude downloads --exclude settings.json --exclude .env --exclude castbot.log --exclude "Start CastBot.command" "$SRC/" ./
  [ "$OLD" != "$(shasum package-lock.json)" ] && touch .needs-install
  echo "Up to date."
else
  echo "Couldn't check for updates. Starting the version you have."
fi
rm -rf "$TMP"

exec bash launch.sh
