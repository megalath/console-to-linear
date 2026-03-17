#!/usr/bin/env bash

set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
PROFILE_DIR="${CHROME_PROFILE_DIR:-$PWD/.chrome-debug-profile}"
START_URL="${1:-about:blank}"

mkdir -p "$PROFILE_DIR"

open -na "Google Chrome" --args \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --new-window "$START_URL"

cat <<EOF
Chrome launched with remote debugging enabled.

Port: $PORT
Profile: $PROFILE_DIR
Start URL: $START_URL

Leave that Chrome instance open, then run:
  npm run logger
EOF
