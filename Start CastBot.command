#!/bin/bash
# Double-click to start CastBot on a Mac. Updates itself, then opens the page in Chrome.
cd "$(dirname "$0")"

# Use the installed Node.js, or a private copy in ./runtime (downloaded the first time).
NODE_VERSION=22.23.2
if ! command -v node >/dev/null 2>&1; then
  if [ ! -x runtime/bin/node ]; then
    [ "$(uname -m)" = arm64 ] && ARCH=arm64 || ARCH=x64
    echo "Node.js isn't installed. Downloading a private copy for CastBot (one time, about 45 MB)..."
    if curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-$ARCH.tar.gz" | tar xz; then
      mv "node-v$NODE_VERSION-darwin-$ARCH" runtime
    fi
  fi
  if [ ! -x runtime/bin/node ]; then
    echo "Couldn't download Node.js. Install it from nodejs.org, then double-click this file again."
    open "https://nodejs.org/en/download"
    read -n 1 -s -r -p "Press any key to close."
    exit 1
  fi
  export PATH="$PWD/runtime/bin:$PATH"
fi

ZIP="https://github.com/tannerprasek/MentionsBot2/archive/refs/heads/claude/polymarket-mispricing-bot-01LWTtedp1AEAh3X33y5Gps2.zip"
TMP="$(mktemp -d)"
echo "Checking for updates..."
if curl -fsSL "$ZIP" -o "$TMP/castbot.zip" && unzip -q "$TMP/castbot.zip" -d "$TMP/x"; then
  SRC="$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
  OLD="$(shasum package-lock.json 2>/dev/null)"
  rsync -a --exclude node_modules --exclude runtime --exclude downloads --exclude settings.json --exclude .env --exclude "Start CastBot.command" "$SRC/" ./
  [ "$OLD" != "$(shasum package-lock.json)" ] && touch .needs-install
  echo "Up to date."
else
  echo "Couldn't check for updates. Starting the version you have."
fi
rm -rf "$TMP"

if [ ! -d node_modules ] || [ -f .needs-install ]; then
  npm install --omit=dev --loglevel=error --no-audit --no-fund && rm -f .needs-install
fi

(sleep 2; open -a "Google Chrome" "http://localhost:8787" 2>/dev/null || open "http://localhost:8787") &
echo "CastBot is running. Keep this window open while you watch. Close it to stop."
node src/server.js
