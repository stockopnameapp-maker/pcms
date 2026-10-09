#!/usr/bin/env bash
# Runs every time the Codespace starts: launch PCMS in the background.
cd "$(dirname "$0")/.."
PORT="$(grep -E '^PORT=' apps/api/.env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8080}"
if curl -fs -m 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then echo "PCMS already running"; exit 0; fi
[ -f apps/web/dist/index.html ] || npm run build
setsid nohup npm start > /tmp/pcms.log 2>&1 < /dev/null &
for i in $(seq 1 60); do curl -fs -m 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { echo "✔ PCMS running on port $PORT (log: /tmp/pcms.log)"; exit 0; }; sleep 1; done
echo "PCMS did not start — see /tmp/pcms.log"; tail -20 /tmp/pcms.log; exit 1
