#!/usr/bin/env bash
# Palmora Health — one-command install on a VPS (Ubuntu 22.04 / 24.04, Debian 12).
#
#   curl -fsSL https://raw.githubusercontent.com/stockopnameapp-maker/pcms/main/deploy/install.sh -o install.sh
#   sudo DOMAIN=palmora.perusahaan.co.id EMAIL=it@perusahaan.co.id bash install.sh
#
# Without DOMAIN the app is served on http://<server-ip>/ (no HTTPS) — fine for a first try, not for real data.
# Safe to run again: existing configuration, secrets and data are kept. Running it again later = update
# (pulls the latest code, applies database migrations, rebuilds, restarts).
set -euo pipefail

REPO="${REPO:-https://github.com/stockopnameapp-maker/pcms.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/palmora}"
DATA_DIR="${DATA_DIR:-/var/lib/palmora}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/palmora}"
APP_USER="${APP_USER:-palmora}"
PORT="${PORT:-8080}"
# settings from an earlier run are remembered, so "sudo bash install.sh" alone updates the server
CONF=/etc/palmora.conf
[ -f "$CONF" ] && . "$CONF"
DOMAIN="${DOMAIN:-${SAVED_DOMAIN:-}}"
EMAIL="${EMAIL:-${SAVED_EMAIL:-}}"
TEST_MODE="${PALMORA_TEST:-0}"       # 1 = only the application steps (used to test this script in CI)

say()  { printf '\n\033[1;32m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
as_app() {
  if [ "$TEST_MODE" = 1 ]; then bash -c "$1"
  else runuser -u "$APP_USER" -- env HOME="$DATA_DIR" npm_config_cache="$DATA_DIR/.npm" bash -c "$1"; fi
}

[ "$(id -u)" = 0 ] || die "Jalankan sebagai root: sudo bash install.sh"
if [ "$TEST_MODE" != 1 ]; then
  . /etc/os-release
  case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) warn "OS $PRETTY_NAME belum diuji; dilanjutkan." ;; esac
fi

# ------------------------------------------------------------------------------------------- system packages
if [ "$TEST_MODE" != 1 ]; then
  say "Memasang paket sistem"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git openssl ufw cron lsb-release debian-keyring debian-archive-keyring apt-transport-https >/dev/null

  # swap for small VPSes: npm install + web build need ~2 GB
  if [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -lt 3000 ] && ! swapon --show | grep -q .; then
    say "Menambah swap 2 GB (RAM kecil)"
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi

  if ! command -v psql >/dev/null || ! psql --version | grep -q ' 16\.'; then
    say "Memasang PostgreSQL 16"
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -qq && apt-get install -y -qq postgresql-16 >/dev/null
  fi
  systemctl enable --now postgresql >/dev/null

  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    say "Memasang Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi

  if ! command -v caddy >/dev/null; then
    say "Memasang Caddy (web server + HTTPS otomatis)"
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi

  id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

# ------------------------------------------------------------------------------------------- application code
say "Mengambil kode Palmora Health"
mkdir -p "$APP_DIR" "$DATA_DIR/storage" "$BACKUP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  as_app "git -C '$APP_DIR' fetch -q origin '$BRANCH' && git -C '$APP_DIR' checkout -q '$BRANCH' && git -C '$APP_DIR' pull -q --ff-only"
else
  [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ] || die "$APP_DIR sudah berisi file lain; kosongkan dulu atau pakai APP_DIR=..."
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
[ "$TEST_MODE" = 1 ] || chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"
chmod 750 "$DATA_DIR" "$BACKUP_DIR"

# ------------------------------------------------------------------------------------------- database roles + config
FIRST_INSTALL=0
if [ ! -f "$APP_DIR/apps/api/.env" ]; then
  FIRST_INSTALL=1
  if [ "$TEST_MODE" != 1 ] && runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'pcms'" 2>/dev/null | grep -q 1; then
    die "Database 'pcms' sudah ada tetapi konfigurasi $APP_DIR/apps/api/.env tidak ditemukan. Pulihkan file .env dari $BACKUP_DIR/*.env.keep agar data tidak tertimpa."
  fi
  say "Membuat konfigurasi dan kunci rahasia"
  ADMIN_PW=$(openssl rand -hex 24); OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
  if [ "$TEST_MODE" = 1 ]; then
    ADMIN_URL="${PG_ADMIN_URL:?PG_ADMIN_URL is required in test mode}"; DBHOST="${PG_HOST:-127.0.0.1:5432}"
  else
    # a dedicated bootstrap superuser reachable over 127.0.0.1 (password auth); PostgreSQL itself is not exposed
    runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'palmora_admin') THEN CREATE ROLE palmora_admin LOGIN SUPERUSER; END IF; END \$\$;" \
      -c "ALTER ROLE palmora_admin PASSWORD '$ADMIN_PW';" >/dev/null
    ADMIN_URL="postgres://palmora_admin:$ADMIN_PW@127.0.0.1:5432/postgres"; DBHOST="127.0.0.1:5432"
  fi
  ORIGINS="http://localhost:5173"; [ -n "$DOMAIN" ] && ORIGINS="https://$DOMAIN"
  umask 077
  cat > "$APP_DIR/packages/db/.env" <<ENV
PG_ADMIN_URL=$ADMIN_URL
PCMS_DB_NAME=pcms
PCMS_OWNER_PASSWORD=$OWNER_PW
PCMS_APP_PASSWORD=$APP_PW
DATABASE_OWNER_URL=postgres://pcms_owner:$OWNER_PW@$DBHOST/pcms
DATABASE_URL=postgres://pcms_app:$APP_PW@$DBHOST/pcms
ENV
  cat > "$APP_DIR/apps/api/.env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATABASE_URL=postgres://pcms_app:$APP_PW@$DBHOST/pcms
DATABASE_OWNER_URL=postgres://pcms_owner:$OWNER_PW@$DBHOST/pcms
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
CORS_ORIGINS=$ORIGINS
STORAGE_DIR=$DATA_DIR/storage
JOBS_ENABLED=true
ENV
  umask 022
  [ "$TEST_MODE" = 1 ] || chown "$APP_USER:$APP_USER" "$APP_DIR/packages/db/.env" "$APP_DIR/apps/api/.env"
  # the field-encryption key cannot be recovered: keep a copy next to the backups
  cp "$APP_DIR/apps/api/.env" "$BACKUP_DIR/api.env.keep"; cp "$APP_DIR/packages/db/.env" "$BACKUP_DIR/db.env.keep"; chmod 600 "$BACKUP_DIR"/*.keep
fi

# ------------------------------------------------------------------------------------------- build
say "Memasang dependensi (beberapa menit)"
as_app "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error"

if [ "$FIRST_INSTALL" = 1 ]; then
  say "Membuat database dan data awal (Kalimantan Agro Sukses Group, akun demo)"
  as_app "cd '$APP_DIR' && npm run db:reset --silent"
else
  say "Memperbarui struktur database"
  as_app "cd '$APP_DIR' && npm run db:migrate --silent"
fi

say "Membangun aplikasi web"
as_app "cd '$APP_DIR' && npm run build --silent >/dev/null"

[ "$TEST_MODE" = 1 ] && { say "Mode uji: langkah systemd, Caddy, firewall dan backup dilewati"; exit 0; }
printf 'SAVED_DOMAIN=%q\nSAVED_EMAIL=%q\n' "$DOMAIN" "$EMAIL" > "$CONF"

# ------------------------------------------------------------------------------------------- service
say "Mendaftarkan layanan palmora (systemd)"
cat > /etc/systemd/system/palmora.service <<UNIT
[Unit]
Description=Palmora Health
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/apps/api
ExecStart=$APP_DIR/node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=5
Environment=NODE_OPTIONS=--max-old-space-size=768
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR $APP_DIR

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now palmora >/dev/null
systemctl restart palmora

say "Menyiapkan Caddy"
if [ -n "$DOMAIN" ]; then
  {
    [ -n "$EMAIL" ] && printf '{\n\temail %s\n}\n\n' "$EMAIL"
    printf '%s {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT"
  } > /etc/caddy/Caddyfile
else
  printf ':80 {\n\tencode gzip\n\treverse_proxy 127.0.0.1:%s\n}\n' "$PORT" > /etc/caddy/Caddyfile
fi
systemctl enable caddy >/dev/null; systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Firewall: hanya SSH, HTTP dan HTTPS yang dibuka"
# keep every port sshd listens on open, so enabling the firewall never locks you out
for p in $(sshd -T 2>/dev/null | awk '/^port /{print $2}') 22; do ufw allow "$p/tcp" >/dev/null; done
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Backup harian otomatis (02.30, disimpan 14 hari)"
cat > /usr/local/bin/palmora-backup <<BK
#!/usr/bin/env bash
# Daily backup: database (pg_dump custom format) + uploaded files. Keeps 14 days.
set -euo pipefail
d=\$(date +%Y%m%d-%H%M)
runuser -u postgres -- pg_dump -Fc pcms > "$BACKUP_DIR/pcms-\$d.dump"
tar -czf "$BACKUP_DIR/storage-\$d.tar.gz" -C "$DATA_DIR" storage
find "$BACKUP_DIR" -name 'pcms-*.dump' -mtime +14 -delete
find "$BACKUP_DIR" -name 'storage-*.tar.gz' -mtime +14 -delete
BK
chmod 750 /usr/local/bin/palmora-backup
echo "30 2 * * * root /usr/local/bin/palmora-backup" > /etc/cron.d/palmora-backup

say "Menunggu aplikasi menyala"
for i in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 2; done
curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null || die "Aplikasi tidak menyala. Lihat log: journalctl -u palmora -n 100"

IP=$(curl -fs4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
URL="http://$IP"; [ -n "$DOMAIN" ] && URL="https://$DOMAIN"
printf '\n\033[1;32m✔ Palmora Health terpasang\033[0m\n'
echo "  Alamat        : $URL"
[ "$FIRST_INSTALL" = 1 ] && echo "  Login demo    : kas.superadmin / Demo@12345  (SEGERA ganti password semua akun demo)"
echo "  Aplikasi HP   : isi alamat server $URL"
echo "  Log           : journalctl -u palmora -f"
echo "  Backup        : $BACKUP_DIR (harian); kunci rahasia: $BACKUP_DIR/*.env.keep — salin ke tempat aman"
[ -z "$DOMAIN" ] && echo "  Catatan       : tanpa domain belum ada HTTPS. Jalankan ulang dengan DOMAIN=... setelah DNS diarahkan ke $IP"
exit 0
