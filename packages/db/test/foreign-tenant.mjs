// A second, throw-away Group used only by the isolation tests (the demo data has a single Group).
// `node test/foreign-tenant.mjs up` creates it, `down` removes it again. Idempotent.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../scripts/env.mjs';

export const FOREIGN = { code: 'ZZT', users: { superadmin: 'zzt.superadmin', corporate: 'zzt.corporate', meddirector: 'zzt.meddirector' } };

async function withOwner(fn) {
  loadEnv();
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { await c.end(); }
}

export async function down() {
  await withOwner(async c => {
    const t = (await c.query('SELECT id FROM tenant WHERE code = $1', [FOREIGN.code])).rows[0];
    if (!t) return;
    // the fixture is test-only scaffolding, so the soft-delete guards are lifted for this transaction only
    await c.query('ALTER TABLE user_role_assignment DISABLE TRIGGER ura_no_delete');
    await c.query('ALTER TABLE app_user DISABLE TRIGGER app_user_no_delete');
    for (const table of ['refresh_token', 'user_session', 'login_attempt', 'notification', 'user_role_assignment']) {
      const exists = (await c.query(`SELECT to_regclass($1) IS NOT NULL AS e`, [table])).rows[0].e;
      if (exists) await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [t.id]);
    }
    await c.query('DELETE FROM app_user WHERE tenant_id = $1', [t.id]);
    await c.query('DELETE FROM org_unit WHERE tenant_id = $1 AND unit_type <> $2', [t.id, 'GROUP']);
    await c.query('DELETE FROM org_unit WHERE tenant_id = $1', [t.id]);
    await c.query('DELETE FROM tenant WHERE id = $1', [t.id]);
    await c.query('ALTER TABLE user_role_assignment ENABLE TRIGGER ura_no_delete');
    await c.query('ALTER TABLE app_user ENABLE TRIGGER app_user_no_delete');
  });
}

export async function up() {
  await down();
  await withOwner(async c => {
    const hash = (await c.query(`SELECT password_hash FROM app_user WHERE username = 'kas.superadmin'`)).rows[0].password_hash;
    const t = (await c.query(`INSERT INTO tenant (code, name, legal_name) VALUES ($1, 'Grup Uji Isolasi', 'Grup Uji Isolasi (fixture test)') RETURNING id`, [FOREIGN.code])).rows[0].id;
    const unit = async (parent, type, code, name) => (await c.query(
      'INSERT INTO org_unit (tenant_id, parent_id, unit_type, code, name) VALUES ($1, $2, $3, $4, $5) RETURNING id', [t, parent, type, code, name])).rows[0].id;
    const grp = await unit(null, 'GROUP', 'ZZT-GRP', 'Grup Uji Isolasi');
    await unit(grp, 'COMPANY', 'ZZT-PT', 'PT Uji Isolasi Kebun Rokan');
    const roles = { superadmin: 'SUPER_ADMIN', corporate: 'CORPORATE_MGMT', meddirector: 'MEDICAL_DIRECTOR' };
    for (const [k, username] of Object.entries(FOREIGN.users)) {
      const u = (await c.query(`INSERT INTO app_user (tenant_id, home_unit_id, username, email, full_name, password_hash, must_change_password, status)
        VALUES ($1, $2, $3, $4, $5, $6, false, 'ACTIVE') RETURNING id`, [t, grp, username, `${username}@test.local`, `Uji ${k}`, hash])).rows[0].id;
      await c.query(`INSERT INTO user_role_assignment (tenant_id, user_id, role_id, scope_unit_id, reason)
        SELECT $1, $2, r.id, $3, 'isolation test fixture' FROM role r WHERE r.code = $4 AND r.tenant_id IS NULL`, [t, u, grp, roles[k]]);
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await (process.argv[2] === 'down' ? down() : up());
}
