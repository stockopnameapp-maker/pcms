#!/bin/bash
# Palmora Health launcher for macOS.
# First launch: creates a private PostgreSQL database in ~/Library/Application Support/Palmora Health,
# generates secrets, loads demo data. Every launch: starts PostgreSQL + the Palmora Health server and
# opens the browser. A small dialog lets the user open or stop Palmora Health.
set -u

CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
RES="$CONTENTS/Resources"
if [ "$(uname -m)" = arm64 ] || [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then PLAT=darwin-arm64; else PLAT=darwin-x64; fi
PLAT="${PCMS_TEST_PLAT:-$PLAT}"   # build-time test hook only
SRCAPP="$RES/app"
APPVER="$(cat "$RES/VERSION" 2>/dev/null || echo dev)"

SUP="$HOME/Library/Application Support/Palmora Health"
APPDIR="$SUP/app"          # working copy of the program files, free of macOS quarantine flags
LOGDIR="$HOME/Library/Logs/Palmora Health"
PGDATA="$SUP/pgdata"
RUN="$SUP/run"
CONF="$SUP/config.env"
PGPORT=54329
WEBPORT=8765
URL="http://localhost:$WEBPORT"
ICON="$RES/AppIcon.icns"
# Upgrade from versions named "PCMS": stop them and move their data to the new folders.
OLDSUP="$HOME/Library/Application Support/PCMS"
if [ -d "$OLDSUP" ] && [ ! -e "$SUP" ]; then
  for c in "$OLDSUP"/runtime/*/*/pgsql/bin/pg_ctl; do [ -x "$c" ] && "$c" -D "$OLDSUP/pgdata" -m fast -w stop >/dev/null 2>&1; done
  /usr/bin/pkill -f "PCMS/app/api/server.mjs" 2>/dev/null
  mv "$OLDSUP" "$SUP" && rm -rf "$SUP/run/launcher.lock"
  [ -d "$HOME/Library/Logs/PCMS" ] && [ ! -e "$LOGDIR" ] && mv "$HOME/Library/Logs/PCMS" "$LOGDIR"
fi
mkdir -p "$SUP" "$LOGDIR" "$RUN" "$SUP/storage"
chmod 700 "$SUP"
exec >>"$LOGDIR/launcher.log" 2>&1
echo "=== $(date) launch ($PLAT) ==="

dialog() { # message, buttons(applescript list), default
  /usr/bin/osascript - "$1" "$2" "$3" "$ICON" <<'OSA'
on run argv
  set msg to item 1 of argv
  set btns to run script ("{" & item 2 of argv & "}")
  try
    set r to display dialog msg with title "Palmora Health" buttons btns default button (item 3 of argv) with icon (POSIX file (item 4 of argv))
  on error
    set r to display dialog msg with title "Palmora Health" buttons btns default button (item 3 of argv)
  end try
  return button returned of r
end run
OSA
}
fail() {
  echo "ERROR: $1"
  dialog "Palmora Health tidak dapat dijalankan.

$1

Log: $LOGDIR" '"Buka folder log", "Tutup"' "Tutup" | grep -q "Buka folder log" && open "$LOGDIR"
  stop_all
  exit 1
}

[ -f "$SRCAPP/api/server.mjs" ] || fail "Komponen aplikasi tidak lengkap. Unduh ulang Palmora Health lalu seret lagi ke Applications."

# ---------------------------------------------------------------- runtime (downloaded once, checksum-verified)
# Official builds: Node.js from nodejs.org, PostgreSQL 16 (with contrib) from the npm registry (embedded-postgres).
RTVER="node-22.23.3_pg-16.14.0-b17"
NODE_BASE="https://nodejs.org/dist/v22.23.3"
PG_BASE="https://registry.npmjs.org/@embedded-postgres"
case "$PLAT" in
  darwin-arm64)
    NODE_URL="$NODE_BASE/node-v22.23.3-darwin-arm64.tar.gz"; NODE_SHA=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53
    PG_URL="$PG_BASE/darwin-arm64/-/darwin-arm64-16.14.0-beta.17.tgz"; PG_SHA=2f34fdd389258e6d79fbce1ea97928b88ce01c8178d77d2bb4c28ddc5ee13d22 ;;
  darwin-x64)
    NODE_URL="$NODE_BASE/node-v22.23.3-darwin-x64.tar.gz"; NODE_SHA=8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8
    PG_URL="$PG_BASE/darwin-x64/-/darwin-x64-16.14.0-beta.17.tgz"; PG_SHA=d34a2c3cf770fe87b8dd9cb5a2ed15994875b019be99b54dc8fe56ed0b7e8f25 ;;
  linux-x64)   # build-time test only
    NODE_URL="$NODE_BASE/node-v22.23.3-linux-x64.tar.gz"; NODE_SHA=1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af
    PG_URL="$PG_BASE/linux-x64/-/linux-x64-16.14.0-beta.17.tgz"; PG_SHA=dfe7ecd8365ab907786e5f3d69179399f9675ac800153219efb2590257c2d551 ;;
esac
RT="$SUP/runtime/$RTVER/$PLAT"
NODE="$RT/node"
PGBIN="$RT/pgsql/bin"

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
fetch() { # url, sha, dest — two attempts; a corrupted or truncated file is never kept
  for attempt in 1 2; do
    rm -f "$3"
    if /usr/bin/curl -fL --retry 3 --connect-timeout 20 -s -o "$3" "$1"; then
      [ "$(sha256 "$3")" = "$2" ] && return 0
      echo "checksum mismatch for $1 (attempt $attempt)"; rm -f "$3"; rc=2
    else
      echo "download failed for $1 (attempt $attempt)"; rc=1
    fi
  done
  return $rc
}
# Copy the program files out of the app bundle once per version. The copy has the macOS
# quarantine flag removed, so nothing inside needs approval beyond opening Palmora Health itself.
sync_app() {
  [ -f "$APPDIR/.version" ] && [ "$(cat "$APPDIR/.version")" = "$APPVER" ] && [ -f "$APPDIR/api/server.mjs" ] && return 0
  echo "installing program files $APPVER"
  rm -rf "$APPDIR.new"
  cp -R "$SRCAPP" "$APPDIR.new" || fail "Gagal menyalin file program ke $SUP."
  [ -x /usr/bin/xattr ] && /usr/bin/xattr -dr com.apple.quarantine "$APPDIR.new" 2>/dev/null
  echo "$APPVER" > "$APPDIR.new/.version"
  rm -rf "$APPDIR" && mv "$APPDIR.new" "$APPDIR"
}

ensure_runtime() {
  [ -x "$NODE" ] && [ -x "$PGBIN/postgres" ] && return 0
  echo "installing runtime $RTVER/$PLAT"
  /usr/bin/osascript -e "display dialog \"Mengunduh komponen Palmora Health (Node.js dan PostgreSQL, sekitar 100 MB).

Ini hanya terjadi sekali dan memerlukan koneksi internet. Tunggu beberapa menit; Palmora Health akan lanjut otomatis.\" with title \"Palmora Health\" buttons {\"OK\"} default button \"OK\" giving up after 1800" >/dev/null 2>&1 &
  NOTE=$!
  DL="$SUP/download.$$"; rm -rf "$DL" "$RT.partial"; rm -rf "$SUP"/download*; mkdir -p "$DL" "$RT.partial"
  fetch "$NODE_URL" "$NODE_SHA" "$DL/node.tgz"; rc1=$?
  [ $rc1 -eq 0 ] && { fetch "$PG_URL" "$PG_SHA" "$DL/pg.tgz"; rc1=$?; }
  if [ $rc1 -ne 0 ]; then
    kill $NOTE 2>/dev/null
    [ $rc1 -eq 2 ] && fail "File yang diunduh tidak cocok dengan checksum resmi, sehingga tidak dipasang demi keamanan. Coba lagi nanti."
    fail "Gagal mengunduh komponen Palmora Health. Periksa koneksi internet lalu buka Palmora Health lagi."
  fi
  ( cd "$DL" && tar xzf node.tgz && tar xzf pg.tgz ) || { kill $NOTE 2>/dev/null; fail "Gagal mengekstrak komponen Palmora Health."; }
  cp "$DL"/node-v*/bin/node "$RT.partial/node" && chmod 755 "$RT.partial/node"
  mv "$DL/package/native" "$RT.partial/pgsql"
  # the PostgreSQL package lists its library symlinks in a manifest
  "$RT.partial/node" -e '
    const fs = require("fs"), path = require("path"); const base = process.argv[1], m = path.join(base, "pgsql/pg-symlinks.json");
    if (fs.existsSync(m)) for (const { source, target } of JSON.parse(fs.readFileSync(m))) {
      const s = path.join(base, source.replace(/^native\//, "pgsql/")), t = path.join(base, target.replace(/^native\//, "pgsql/"));
      try { fs.unlinkSync(t); } catch {} fs.symlinkSync(path.relative(path.dirname(t), s), t);
    }' "$RT.partial" || { kill $NOTE 2>/dev/null; fail "Gagal menyiapkan PostgreSQL."; }
  chmod 755 "$RT.partial/pgsql/bin/"*
  rm -rf "$RT" && mv "$RT.partial" "$RT" && rm -rf "$DL"
  # drop runtimes of older Palmora Health versions
  for d in "$SUP/runtime/"*; do [ "$d" = "$SUP/runtime/$RTVER" ] || rm -rf "$d"; done
  kill $NOTE 2>/dev/null
}

# ---------------------------------------------------------------- secrets (generated once, stay on this Mac)
if [ ! -f "$CONF" ]; then
  umask 077
  {
    echo "PG_ADMIN_PW=$(/usr/bin/openssl rand -hex 24)"
    echo "PCMS_OWNER_PASSWORD=$(/usr/bin/openssl rand -hex 24)"
    echo "PCMS_APP_PASSWORD=$(/usr/bin/openssl rand -hex 24)"
    echo "JWT_SECRET=$(/usr/bin/openssl rand -base64 48 | tr -d '\n')"
    echo "FIELD_ENCRYPTION_KEY=$(/usr/bin/openssl rand -base64 32 | tr -d '\n')"
  } > "$CONF"
  umask 022
fi
set -a; . "$CONF"; set +a

export PG_ADMIN_URL="postgres://pcms_admin:$PG_ADMIN_PW@127.0.0.1:$PGPORT/postgres"
export PCMS_DB_NAME=pcms
export DATABASE_OWNER_URL="postgres://pcms_owner:$PCMS_OWNER_PASSWORD@127.0.0.1:$PGPORT/pcms"
export DATABASE_URL="postgres://pcms_app:$PCMS_APP_PASSWORD@127.0.0.1:$PGPORT/pcms"

api_up() { /usr/bin/curl -fs -m 2 "$URL/healthz" 2>/dev/null | grep -q '"ok"'; }
pg_up() { "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

start_pg() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "initdb"
    PWF="$RUN/pw.tmp"; umask 077; printf '%s\n' "$PG_ADMIN_PW" > "$PWF"; umask 022
    "$PGBIN/initdb" -D "$PGDATA" -U pcms_admin --pwfile="$PWF" -A scram-sha-256 -E UTF8 --no-locale >>"$LOGDIR/postgres.log" 2>&1
    rc=$?; rm -f "$PWF"
    [ $rc -eq 0 ] || fail "Gagal membuat database lokal (initdb)."
  fi
  pg_up && return 0
  rm -f "$PGDATA/postmaster.pid.stale"
  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGDIR/postgres.log" -w -t 60 \
    -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start || fail "PostgreSQL gagal dijalankan (port $PGPORT mungkin terpakai)."
}

seed_db() {
  echo "seeding"
  /usr/bin/osascript -e "display dialog \"Menyiapkan database dan data demo untuk pertama kali.

Ini memerlukan sekitar 1 menit. Browser akan terbuka otomatis setelah selesai.\" with title \"Palmora Health\" buttons {\"OK\"} default button \"OK\" giving up after 600" >/dev/null 2>&1 &
  NOTE=$!
  (cd "$APPDIR/db" && "$NODE" scripts/reset.mjs) >>"$LOGDIR/setup.log" 2>&1
  rc=$?
  kill $NOTE 2>/dev/null
  [ $rc -eq 0 ] || fail "Gagal menyiapkan data demo."
  date > "$SUP/.seeded"
}

start_api() {
  api_up && return 0
  (
    cd "$APPDIR"
    NODE_ENV=production PORT=$WEBPORT HOST=127.0.0.1 STORAGE_DIR="$SUP/storage" WEB_DIST="$APPDIR/web" \
    CORS_ORIGINS="$URL" JOBS_ENABLED=true \
      exec "$NODE" "$APPDIR/api/server.mjs"
  ) >>"$LOGDIR/server.log" 2>&1 &
  echo $! > "$RUN/api.pid"
  for i in $(seq 1 60); do api_up && return 0; sleep 1; done
  fail "Server Palmora Health tidak merespons. Port $WEBPORT mungkin dipakai aplikasi lain."
}

stop_api() {
  [ -f "$RUN/api.pid" ] && kill "$(cat "$RUN/api.pid")" 2>/dev/null
  rm -f "$RUN/api.pid"
  # an orphaned server from a force-quit launcher
  /usr/bin/pkill -f "Palmora Health/app/api/server.mjs" 2>/dev/null || true
  /usr/bin/pkill -f "PCMS/app/api/server.mjs" 2>/dev/null || true   # pre-rename versions
}
stop_all() {
  stop_api
  pg_up && "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null 2>&1
}
trap 'stop_all; exit 0' TERM INT HUP

# ---------------------------------------------------------------- one launcher at a time
LOCK="$RUN/launcher.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  other=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    echo "another launcher ($other) is active"
    if api_up; then open "$URL"; else
      dialog "Palmora Health sedang disiapkan (mengunduh komponen atau menyiapkan database).

Tidak perlu membuka Palmora Health lagi. Browser akan terbuka otomatis setelah selesai." '"OK"' "OK" >/dev/null
    fi
    exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

# ---------------------------------------------------------------- start
if api_up && [ -f "$APPDIR/.version" ] && [ "$(cat "$APPDIR/.version")" != "$APPVER" ]; then
  echo "stopping older version"; stop_api; sleep 1
fi
if api_up; then
  echo "already running"
else
  sync_app
  ensure_runtime
  start_pg
  [ -f "$SUP/.seeded" ] || seed_db
  start_api
fi
open "$URL"

# ---------------------------------------------------------------- control dialog
while true; do
  choice=$(dialog "Palmora Health sedang berjalan di:
$URL

Login demo: sng.superadmin  ·  password Demo@12345
(akun demo lain ada di file \"Baca Dulu\")

Biarkan jendela ini terbuka selama memakai Palmora Health. Pilih \"Hentikan\" untuk mematikan server." \
    '"Opsi…", "Hentikan Palmora Health", "Buka Palmora Health"' "Buka Palmora Health")
  case "$choice" in
    "Buka Palmora Health") open "$URL" ;;
    "Hentikan Palmora Health") stop_all; exit 0 ;;
    "Opsi…")
      opt=$(/usr/bin/osascript -e 'choose from list {"Buka folder data", "Buka folder log", "Reset data demo (hapus semua data)"} with title "Palmora Health" with prompt "Pilih tindakan:"' 2>/dev/null)
      case "$opt" in
        "Buka folder data") open "$SUP" ;;
        "Buka folder log") open "$LOGDIR" ;;
        "Reset data demo"*)
          sure=$(dialog "Semua data di Palmora Health akan dihapus dan diganti dengan data demo baru. Lanjutkan?" '"Batal", "Hapus & reset"' "Batal")
          if [ "$sure" = "Hapus & reset" ]; then
            ensure_runtime; start_pg
            stop_api; seed_db; start_api; open "$URL"
          fi ;;
      esac ;;
    *) sleep 2 ;;  # dialog could not be shown; keep serving
  esac
done
