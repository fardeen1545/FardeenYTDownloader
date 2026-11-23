#!/bin/sh
# Fardeen YT Downloader - register the native helper on macOS / Linux.
# Usage: ./install.sh [EXTENSION_ID]
set -eu
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1 && python -c 'import sys; sys.exit(sys.version_info[0] != 3)'; then
  PY=python
else
  echo "ERROR: Python 3 was not found."
  echo "  macOS: brew install python      Debian/Ubuntu: sudo apt install python3"
  exit 1
fi

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Open chrome://extensions, enable Developer mode, and copy the ID of 'Fardeen YT Downloader'."
  printf "Paste the extension ID and press Enter: "
  read -r EXT_ID
fi

set +e
"$PY" "$(pwd)/fardeen_host.py" --install "$EXT_ID"
RESULT=$?
set -e

echo
case "$RESULT" in
  0) echo "Done! Restart the browser completely, then click the extension icon." ;;
  2) echo "The helper is registered, but some tools are missing (see above)."
     echo "Quick install:  pip3 install -U yt-dlp   and   brew install ffmpeg  (or: sudo apt install ffmpeg)" ;;
  *) echo "Installation failed. Check the extension ID and try again." ;;
esac
exit "$RESULT"
