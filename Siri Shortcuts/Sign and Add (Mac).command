#!/bin/bash
# Double-click on a Mac: signs the shortcuts in this folder (iPhones only accept signed ones)
# and opens them in Shortcuts. Each asks for CastBot's address when you add it.
# Easier when CastBot is running: open CastBot in a browser and use "Set up Siri" instead.
cd "$(dirname "$0")" || exit 1
mkdir -p signed
ok=0
for f in *.shortcut; do
  shortcuts sign --mode anyone --input "$f" --output "signed/$f" 2>/dev/null
  if [ -f "signed/$f" ]; then ok=$((ok+1)); echo "signed: $f"; else echo "FAILED: $f"; fi
done
if [ "$ok" -eq 0 ]; then
  echo "Nothing was signed. Make sure this Mac is signed in to iCloud (System Settings > your name)."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
echo "Opening them in Shortcuts. Click \"Add Shortcut\" for each, and enter CastBot's address when asked"
echo "(the \"from your phone\" line in the CastBot window, e.g. http://10.0.0.194:8787)."
for f in signed/*.shortcut; do open "$f"; sleep 2; done
