#!/bin/bash
# Called by "Start CastBot.command" after it updates. Sets up Node, installs, starts CastBot in the background.
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

if [ ! -d node_modules ] || [ -f .needs-install ]; then
  npm install --omit=dev --loglevel=error --no-audit --no-fund && rm -f .needs-install
fi

# Runs in the background; the page has a Log button (and Quit) if something goes wrong.
nohup node src/server.js >/dev/null 2>&1 &
sleep 2
open -a "Google Chrome" "http://localhost:8787" 2>/dev/null || open "http://localhost:8787"
(sleep 1; osascript -e 'tell application "Terminal" to close (every window whose name contains "Start CastBot")' >/dev/null 2>&1) &
exit 0
