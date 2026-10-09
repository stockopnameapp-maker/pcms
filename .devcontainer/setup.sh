#!/usr/bin/env bash
# Runs once when the Codespace is created: install, configure, load demo data, build the web app.
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="${PG_ADMIN_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
PORT="${PCMS_PORT:-8080}"

echo "▶ Installing dependencies"
npm ci --no-audit --no-fund

if [ ! -f packages/db/.env ] || [ ! -f apps/api/.env ]; then
  echo "▶ Writing configuration with fresh secrets"
  OWNER_PW=$(openssl rand -hex 24); APP_PW=$(openssl rand -hex 24)
  DBHOST=$(node -e 'const u=new URL(process.argv[1]);console.log(u.host||"localhost:5432")' "$ADMIN_URL")
  cat > packages/db/.env <<ENV
PG_ADMIN_URL=$ADMIN_URL
PCMS_DB_NAME=pcms
PCMS_OWNER_PASSWORD=$OWNER_PW
PCMS_APP_PASSWORD=$APP_PW
DATABASE_OWNER_URL=postgres://pcms_owner:$OWNER_PW@$DBHOST/pcms
DATABASE_URL=postgres://pcms_app:$APP_PW@$DBHOST/pcms
ENV
  cat > apps/api/.env <<ENV
NODE_ENV=production
PORT=$PORT
DATABASE_URL=postgres://pcms_app:$APP_PW@$DBHOST/pcms
DATABASE_OWNER_URL=postgres://pcms_owner:$OWNER_PW@$DBHOST/pcms
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
FIELD_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
STORAGE_DIR=./storage
JOBS_ENABLED=true
ENV
fi

echo "▶ Waiting for PostgreSQL"
ready=0
for i in $(seq 1 60); do node -e 'const pg=require("pg");const c=new pg.Client(process.argv[1]);c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))' "$ADMIN_URL" 2>/dev/null && { ready=1; break; }; sleep 2; done
[ $ready = 1 ] || { echo "✗ PostgreSQL is not reachable at $ADMIN_URL"; exit 1; }

echo "▶ Creating database and demo data"
npm run db:reset
echo "▶ Building web app"
npm run build
echo "✔ PCMS ready — it starts automatically on port $PORT"
