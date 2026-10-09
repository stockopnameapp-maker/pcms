// Drops and recreates the PCMS database, then migrates and seeds it.
// DEVELOPMENT ONLY. Pure Node (no bash / psql needed) so it runs the same on macOS, Linux and Windows.
// Uses the variables in packages/db/.env (see .env.example).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`✗ ${k} belum diisi di packages/db/.env`); process.exit(1); } return v; };
const adminUrl = need('PG_ADMIN_URL');
const db = process.env.PCMS_DB_NAME || 'pcms';
const ownerPw = need('PCMS_OWNER_PASSWORD');
const appPw = need('PCMS_APP_PASSWORD');
if (!/^[a-z_][a-z0-9_]*$/.test(db)) { console.error('✗ PCMS_DB_NAME hanya boleh huruf kecil, angka dan _'); process.exit(1); }

async function connect(url) {
  const c = new pg.Client({ connectionString: url });
  try { await c.connect(); return c; } catch (e) {
    console.error(`✗ Tidak bisa terhubung ke PostgreSQL (${url.replace(/:[^:@/]*@/, ':***@')}): ${e.message}`);
    console.error('  Pastikan PostgreSQL 16 berjalan dan PG_ADMIN_URL memakai user superuser (di Homebrew/Postgres.app: nama user macOS Anda).');
    process.exit(1);
  }
}

const admin = await connect(adminUrl);
console.log(`Dropping database ${db} (if it exists)...`);
await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
console.log('Bootstrapping roles and database...');
for (const [role, pw, attrs] of [['pcms_owner', ownerPw, 'LOGIN BYPASSRLS'], ['pcms_app', appPw, 'LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE']]) {
  const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount > 0;
  const sql = (await admin.query(`SELECT format(${exists ? "'ALTER ROLE %I PASSWORD %L'" : `'CREATE ROLE %I ${attrs} PASSWORD %L'`}, $1::text, $2::text) AS s`, [role, pw])).rows[0].s;
  await admin.query(sql);
}
await admin.query(`CREATE DATABASE ${db} OWNER pcms_owner ENCODING 'UTF8' TEMPLATE template0`);
await admin.end();

const u = new URL(adminUrl); u.pathname = '/' + db;
const c = await connect(u.toString());
for (const sql of [
  `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`, `GRANT CONNECT ON DATABASE ${db} TO pcms_app`,
  'REVOKE CREATE ON SCHEMA public FROM PUBLIC', 'ALTER SCHEMA public OWNER TO pcms_owner',
  'CREATE EXTENSION IF NOT EXISTS pgcrypto', 'CREATE EXTENSION IF NOT EXISTS ltree', 'CREATE EXTENSION IF NOT EXISTS pg_trgm',
  'CREATE EXTENSION IF NOT EXISTS citext', 'CREATE EXTENSION IF NOT EXISTS btree_gist',
]) await c.query(sql);
await c.end();

for (const script of ['scripts/migrate.mjs', 'seed/seed.mjs']) {
  const r = spawnSync(process.execPath, [path.join(here, '..', script)], { stdio: 'inherit', cwd: path.join(here, '..') });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
