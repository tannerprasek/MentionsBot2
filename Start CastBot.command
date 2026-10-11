#!/bin/bash
# Double-click to start CastBot on a Mac. Opens the page in Chrome.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed. Opening the download page; install it, then double-click this file again."
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

[ -d node_modules ] || npm install --omit=dev

(sleep 2; open -a "Google Chrome" "http://localhost:8787" 2>/dev/null || open "http://localhost:8787") &
echo "CastBot is running. Keep this window open while you watch. Close it to stop."
node src/server.js
