#!/usr/bin/env bash
# Runs when the browser editor attaches to the Codespace: starts PCMS in this terminal (foreground, so it keeps running)
# and prints the address. Re-run any time with:  bash .devcontainer/start.sh
cd "$(dirname "$0")/.."
PORT="$(grep -E '^PORT=' apps/api/.env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8080}"
if [ -n "${CODESPACE_NAME:-}" ]; then
  URL="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  URL="http://localhost:$PORT"
fi
banner() {
  printf '\n\033[1;32m%s\033[0m\n' "════════════════════════════════════════════════════════════"
  printf '\033[1;32m  PCMS siap. Buka:  %s\033[0m\n' "$URL"
  printf '\033[1;32m  Login demo:       sng.superadmin  /  Demo@12345\033[0m\n'
  printf '\033[1;32m%s\033[0m\n\n' "════════════════════════════════════════════════════════════"
}

if [ ! -f apps/api/.env ] || [ ! -f apps/web/dist/index.html ]; then
  echo "Persiapan PCMS belum selesai atau gagal. Menjalankan ulang persiapan (3–5 menit)…"
  bash .devcontainer/setup.sh 2>&1 | tee /tmp/pcms-setup.log || { echo "✗ Persiapan gagal. Kirim 30 baris terakhir di atas ke pengembang."; exit 1; }
fi

if curl -fs -m 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1; then banner; exit 0; fi
( for i in $(seq 1 90); do curl -fs -m 2 "http://localhost:$PORT/healthz" >/dev/null 2>&1 && { banner; break; }; sleep 1; done ) &
exec npm start
