// Test helpers. Every test runs as the real API role (pcms_app) with Row-Level
// Security enforced, inside a transaction that is always rolled back, so the
// demo database is never modified by the test suite.
import pg from 'pg';
import { loadEnv } from '../scripts/env.mjs';

loadEnv();
export const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
export const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_OWNER_URL, max: 2 });

/** Ground truth (owner role, bypasses RLS) — only used to compute expected values. */
export async function owner(sql, params = []) {
  return (await ownerPool.query(sql, params)).rows;
}

/**
 * Run `fn` inside a rolled-back transaction as the given demo user, exactly
 * like the API does: resolve the login via app.auth_lookup(), then
 * app.set_context(). `db.switchUser(name)` changes identity mid-transaction.
 */
export async function asUser(username, fn) {
  const client = await appPool.connect();
  const db = {
    async q(sql, params = []) { return (await client.query(sql, params)).rows; },
    async one(sql, params = []) { return (await client.query(sql, params)).rows[0]; },
    async val(sql, params = []) { const r = (await client.query(sql, params)).rows[0]; return r ? Object.values(r)[0] : undefined; },
    async switchUser(name) {
      const u = (await client.query('SELECT user_id FROM app.auth_lookup($1)', [name])).rows[0];
      if (!u) throw new Error(`demo user ${name} not found`);
      await client.query('SELECT app.set_context($1, $2, $3, $4)', [u.user_id, '10.20.30.40', 'node-test', `test-${Date.now()}`]);
      db.userId = u.user_id;
      return u.user_id;
    },
    /** Expect a statement to fail; uses a savepoint so the transaction stays usable. */
    async rejects(sql, params = [], pattern) {
      await client.query('SAVEPOINT sp');
      try {
        await client.query(sql, params);
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        if (pattern && !pattern.test(e.message)) throw new Error(`Expected error matching ${pattern}, got: ${e.message}`);
        return e.message;
      }
      await client.query('ROLLBACK TO SAVEPOINT sp');
      throw new Error(`Expected statement to fail: ${sql}`);
    },
  };
  try {
    await client.query('BEGIN');
    if (username) await db.switchUser(username);
    return await fn(db);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** All tables in public that carry tenant data. */
export async function tenantTables() {
  return (await owner(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
                       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`)).map(r => r.t);
}

export async function closeAll() {
  await appPool.end();
  await ownerPool.end();
}
