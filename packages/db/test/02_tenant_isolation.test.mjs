import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, owner, tenantTables, appPool, closeAll } from './helpers.mjs';

after(closeAll);

async function readableTables() {
  const tables = await tenantTables();
  const rows = await owner(`SELECT t FROM unnest($1::text[]) t WHERE has_any_column_privilege('pcms_app', t::regclass, 'SELECT')`, [tables]);
  return rows.map(r => r.t);
}

test('without a security context every tenant table returns zero rows (fail closed)', async () => {
  const tables = await readableTables();
  assert.ok(tables.length > 55);
  await asUser(null, async db => {
    for (const t of tables) {
      const n = await db.val(`SELECT count(tenant_id)::int FROM "${t}"`);
      assert.equal(n, 0, `${t} leaked ${n} rows without context`);
    }
    assert.equal(await db.val('SELECT count(*)::int FROM audit.audit_log'), 0);
  });
});

test('a forged session variable (no valid signature) is ignored', async () => {
  const [{ id, tenant_id }] = await owner(`SELECT id, tenant_id FROM app_user WHERE username = 'sng.superadmin'`);
  await asUser(null, async db => {
    await db.q(`SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true), set_config('app.ctx_sig', 'deadbeef', true)`, [id, tenant_id]);
    assert.equal(await db.val('SELECT app.current_user_id()'), null);
    assert.equal(await db.val('SELECT count(*)::int FROM employee'), 0);
    assert.equal(await db.val('SELECT count(*)::int FROM org_unit'), 0);
  });
});

test('the security context cannot be set for an inactive user', async () => {
  const [{ id }] = await owner(`SELECT id FROM app_user WHERE username = 'aag.corporate'`);
  await ownerPoolTx(async c => {
    await c.query(`UPDATE app_user SET status = 'DISABLED' WHERE id = $1`, [id]);
  }, async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(client.query('SELECT app.set_context($1)', [id]), /not active/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});

for (const username of ['sng.superadmin', 'sng.meddirector', 'aag.superadmin', 'aag.meddirector']) {
  test(`${username} never sees another Group's rows in any table`, async () => {
    const tables = await readableTables();
    await asUser(username, async db => {
      const mine = await db.val('SELECT app.current_tenant_id()');
      assert.ok(mine);
      for (const t of tables) {
        const foreign = await db.val(`SELECT count(*)::int FROM "${t}" WHERE tenant_id IS DISTINCT FROM $1 ${t === 'role' ? 'AND tenant_id IS NOT NULL' : ''}`, [mine]);
        assert.equal(foreign, 0, `${username} sees ${foreign} foreign rows in ${t}`);
      }
      const auditForeign = await db.val('SELECT count(*)::int FROM audit.audit_log WHERE tenant_id <> $1', [mine]);
      assert.equal(auditForeign, 0);
    });
  });
}

test('group-wide roles see their whole Group (scope inheritance through the hierarchy)', async () => {
  const [{ n: expected }] = await owner(`SELECT count(*)::int AS n FROM employee e JOIN tenant t ON t.id = e.tenant_id WHERE t.code = 'SNG'`);
  await asUser('sng.superadmin', async db => {
    assert.equal(await db.val('SELECT count(*)::int FROM employee'), expected);
  });
});

test('writing into another tenant is rejected by the database', async () => {
  const [aag] = await owner(`SELECT t.id AS tenant_id, g.id AS group_id FROM tenant t JOIN org_unit g ON g.tenant_id = t.id AND g.unit_type = 'GROUP' WHERE t.code = 'AAG'`);
  await asUser('sng.superadmin', async db => {
    await db.rejects(`INSERT INTO org_unit (tenant_id, parent_id, unit_type, code, name) VALUES ($1, $2, 'COMPANY', 'HACK-PT', 'Hacked PT')`,
      [aag.tenant_id, aag.group_id], /row-level security|another tenant|not found/);
    // omitting tenant_id: the trigger fills the caller's tenant, but the foreign parent is still refused
    await db.rejects(`INSERT INTO org_unit (parent_id, unit_type, code, name) VALUES ($1, 'COMPANY', 'HACK-PT2', 'Hacked PT')`,
      [aag.group_id], /row-level security|another tenant|not found/);
    // updating a foreign row silently affects nothing
    const res = await db.q(`UPDATE org_unit SET name = 'pwned' WHERE id = $1 RETURNING id`, [aag.group_id]);
    assert.equal(res.length, 0);
  });
});

test('tenant_id of an existing row is immutable', async () => {
  const [aag] = await owner(`SELECT id FROM tenant WHERE code = 'AAG'`);
  await asUser('sng.superadmin', async db => {
    const emp = await db.one('SELECT id FROM employee LIMIT 1');
    await db.rejects('UPDATE employee SET tenant_id = $1 WHERE id = $2', [aag.id, emp.id], /immutable|row-level security/);
  });
});

// helper: run setup as owner in a transaction, run the check, then roll back setup
async function ownerPoolTx(setup, check) {
  const { ownerPool } = await import('./helpers.mjs');
  const c = await ownerPool.connect();
  try {
    await c.query('BEGIN');
    await setup(c);
    await c.query('COMMIT');
    await check();
  } finally {
    await c.query(`UPDATE app_user SET status = 'ACTIVE' WHERE username = 'aag.corporate'`);
    c.release();
  }
}
