#!/bin/sh
# Gem Finder proxy: the persistent start path. Run from anywhere:
#   web/proxy/start.sh [PORT]     (default 8741)
# The proxy loads MODEL_API_KEY itself on start (explicit env value
# first, then ~/.model_api_key); this script only fixes the cwd, port,
# detachment, and log file. Always restart via this script — never via a
# bare `node server.js` from a shell whose env may lack the key.
# Log: /tmp/gem-proxy.log. No key value ever appears here or in the log.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${1:-${PORT:-8741}}"
cd "$REPO"
PORT="$PORT" setsid -f node web/proxy/server.js </dev/null >>/tmp/gem-proxy.log 2>&1
echo "gem proxy starting on :$PORT (log /tmp/gem-proxy.log)"
