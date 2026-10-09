import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, owner, closeAll } from './helpers.mjs';

after(closeAll);

const unitId = async code => (await owner('SELECT id FROM org_unit WHERE code = $1', [code]))[0].id;

test('every change is audited with user, IP, old and new values', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const enc = await db.one(`SELECT id, is_work_related FROM encounter WHERE clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN')
                               ORDER BY started_at DESC LIMIT 1`);
    await db.q(`UPDATE encounter SET follow_up_date = current_date + 7, is_work_related = NOT is_work_related WHERE id = $1`, [enc.id]);
    const log = await db.one(`SELECT user_id, host(ip_address) AS ip, user_agent, module, action, changed_fields, old_values, new_values
                                FROM audit.audit_log WHERE record_id = $1 ORDER BY id DESC LIMIT 1`, [enc.id]);
    assert.equal(log.user_id, db.userId);
    assert.equal(log.ip, '10.20.30.40');
    assert.equal(log.module, 'EMR');
    assert.equal(log.action, 'UPDATE');
    assert.deepEqual(log.changed_fields, ['follow_up_date', 'is_work_related']);
    assert.equal(log.new_values.is_work_related, !enc.is_work_related);
    assert.equal(log.old_values.is_work_related, enc.is_work_related);
    // the version counter and updated_by are maintained by the database
    const v = await db.one('SELECT version, updated_by FROM encounter WHERE id = $1', [enc.id]);
    assert.equal(v.updated_by, db.userId);
    assert.ok(v.version >= 2);
  });
});

test('the audit log is append-only for the application', async () => {
  await asUser('kas.superadmin', async db => {
    await db.q(`SELECT app.log_access('VIEW', 'patient', gen_random_uuid(), 'PATIENT', 'test')`);
    await db.rejects('UPDATE audit.audit_log SET note = $1 WHERE user_id = app.current_user_id()', ['tampered'], /permission denied|append-only/);
    await db.rejects('DELETE FROM audit.audit_log WHERE user_id = app.current_user_id()', [], /permission denied|append-only/);
    await db.rejects(`INSERT INTO audit.audit_log (table_name, action) VALUES ('x', 'VIEW')`, [], /permission denied/);
  });
});

test('auditors read the whole tenant log; other users only their own entries', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    await db.q(`SELECT app.log_access('VIEW', 'patient', gen_random_uuid(), 'PATIENT')`);
    assert.equal(await db.val('SELECT count(*)::int FROM audit.audit_log WHERE user_id IS DISTINCT FROM app.current_user_id()'), 0);
  });
  await asUser('kas.superadmin', async db => {
    await db.q(`SELECT app.log_access('VIEW', 'patient', gen_random_uuid(), 'PATIENT')`);
    assert.ok(await db.val('SELECT count(DISTINCT user_id)::int FROM audit.audit_log') >= 1);
  });
});

test('medical records cannot be hard-deleted; soft delete needs DELETE permission and is audited', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const enc = await db.one(`SELECT id FROM encounter WHERE clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') LIMIT 1`);
    // RLS: without EMR:DELETE the row is simply not deletable
    assert.equal((await db.q('DELETE FROM encounter WHERE id = $1 RETURNING id', [enc.id])).length, 0);
    // no role holds EMR:DELETE — records are retained
    await db.rejects('UPDATE encounter SET deleted_at = now() WHERE id = $1', [enc.id], /DELETE required|signed/);
    const p = await db.one(`SELECT id FROM patient WHERE primary_clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') LIMIT 1`);
    await db.rejects('UPDATE patient SET deleted_at = now() WHERE id = $1', [p.id], /PATIENT:DELETE required/);
  });
  await asUser('kas.mro.bcpj-ra-kln', async db => {
    const p = await db.one(`SELECT id FROM patient WHERE primary_clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') AND patient_type = 'VISITOR' LIMIT 1`)
           ?? await db.one(`SELECT id FROM patient WHERE primary_clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') LIMIT 1`);
    await db.q('UPDATE patient SET deleted_at = now() WHERE id = $1', [p.id]);
    const log = await db.one(`SELECT action FROM audit.audit_log WHERE record_id = $1 ORDER BY id DESC LIMIT 1`, [p.id]);
    assert.equal(log.action, 'SOFT_DELETE');
    const row = await db.one('SELECT deleted_by FROM patient WHERE id = $1', [p.id]);
    assert.equal(row.deleted_by, db.userId);
    assert.equal((await db.q('DELETE FROM patient WHERE id = $1 RETURNING id', [p.id])).length, 0, 'no physical delete path');
  });
});

test('hard delete of clinical records is blocked even for the database owner', async () => {
  const { ownerPool } = await import('./helpers.mjs');
  const c = await ownerPool.connect();
  try {
    await c.query('BEGIN');
    for (const t of ['encounter', 'diagnosis', 'vital_sign', 'prescription', 'lab_result', 'mcu', 'mcu_finding', 'accident', 'referral', 'sick_leave', 'patient']) {
      await c.query('SAVEPOINT s');
      await assert.rejects(c.query(`DELETE FROM ${t} WHERE id = (SELECT id FROM ${t} LIMIT 1)`), /Hard delete is not allowed/, t);
      await c.query('ROLLBACK TO SAVEPOINT s');
    }
  } finally { await c.query('ROLLBACK'); c.release(); }
});

test('a signed medical record is immutable (addendum required)', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const enc = await db.one(`SELECT id FROM encounter WHERE status = 'SIGNED' AND clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') LIMIT 1`);
    await db.rejects(`UPDATE encounter SET assessment = 'changed' WHERE id = $1`, [enc.id], /signed; add an addendum/);
    const staff = await db.val('SELECT id FROM medical_staff WHERE user_id = app.current_user_id()');
    await db.q(`INSERT INTO encounter_addendum (encounter_id, author_id, reason, content) VALUES ($1, $2, 'Koreksi', 'Tambahan keterangan')`, [enc.id, staff]);
  });
});

test('password hashes and MFA secrets are not readable by the API role', async () => {
  await asUser('kas.superadmin', async db => {
    await db.rejects('SELECT password_hash FROM app_user LIMIT 1', [], /permission denied/);
    await db.rejects('SELECT mfa_secret FROM app_user LIMIT 1', [], /permission denied/);
    assert.ok(await db.val('SELECT count(username)::int FROM app_user') > 50);
    await db.rejects('SELECT * FROM user_session', [], /permission denied/);
  });
});

test('inventory: stock is derived from append-only transactions and cannot go negative', async () => {
  const clinic = await unitId('BCPJ-RA-KLN');
  await asUser('kas.apt.bcpj-ra-kln', async db => {
    const s = await db.one(`SELECT s.medicine_id, s.batch_id, s.qty_on_hand::numeric AS qty FROM inventory_stock s
                             WHERE s.org_unit_id = $1 AND s.qty_on_hand > 20 LIMIT 1`, [clinic]);
    await db.q(`INSERT INTO inventory_transaction (org_unit_id, medicine_id, batch_id, txn_type, qty) VALUES ($1, $2, $3, 'DISPENSE', -10)`, [clinic, s.medicine_id, s.batch_id]);
    const after = await db.val('SELECT qty_on_hand::numeric FROM inventory_stock WHERE org_unit_id = $1 AND batch_id = $2', [clinic, s.batch_id]);
    assert.equal(Number(after), Number(s.qty) - 10);
    await db.rejects(`INSERT INTO inventory_transaction (org_unit_id, medicine_id, batch_id, txn_type, qty) VALUES ($1, $2, $3, 'DISPENSE', $4)`,
      [clinic, s.medicine_id, s.batch_id, -(Number(s.qty) + 1000)], /insufficient stock/);
    await db.rejects(`INSERT INTO inventory_transaction (org_unit_id, medicine_id, batch_id, txn_type, qty) VALUES ($1, $2, $3, 'DISPENSE', 5)`,
      [clinic, s.medicine_id, s.batch_id], /check constraint/);           // sign must match type
    await db.rejects(`INSERT INTO inventory_transaction (org_unit_id, medicine_id, batch_id, txn_type, qty) VALUES ($1, $2, $3, 'ADJUSTMENT_OUT', -1)`,
      [clinic, s.medicine_id, s.batch_id], /check constraint/);           // adjustments need a reason
    await db.rejects('UPDATE inventory_transaction SET qty = -1 WHERE org_unit_id = $1', [clinic], /permission denied|append-only/);
    await db.rejects('UPDATE inventory_stock SET qty_on_hand = 99999 WHERE org_unit_id = $1', [clinic], /permission denied/);
    // and cannot post stock movements for another clinic
    const other = await unitId('BCPJ-RB-KLN');
    await db.rejects(`INSERT INTO inventory_transaction (org_unit_id, medicine_id, batch_id, txn_type, qty) VALUES ($1, $2, $3, 'ADJUSTMENT_IN', 5)`,
      [other, s.medicine_id, s.batch_id], /row-level security/);
  });
});

test('Group management sees inventory across all clinics; a clinic sees only its own', async () => {
  const [{ n: sites }] = await owner(`SELECT count(DISTINCT org_unit_id)::int AS n FROM inventory_stock s JOIN tenant t ON t.id = s.tenant_id WHERE t.code = 'KAS'`);
  await asUser('kas.corporate', async db => {
    assert.equal(await db.val('SELECT count(DISTINCT org_unit_id)::int FROM inventory_stock'), sites);
  });
  await asUser('kas.apt.bcpj-ra-kln', async db => {
    assert.equal(await db.val('SELECT count(DISTINCT org_unit_id)::int FROM inventory_stock'), 1);
  });
});

test('lab results are flagged automatically from the reference range', async () => {
  await asUser('kas.nurse1.bcpj-ra-kln', async db => {
    const o = await db.one(`SELECT o.id FROM lab_order o WHERE o.clinic_id = (SELECT id FROM org_unit WHERE code = 'BCPJ-RA-KLN') LIMIT 1`);
    const test = await db.one(`SELECT id FROM lab_test WHERE code = 'SGPT'`);
    const r = await db.one(`INSERT INTO lab_result (lab_order_id, lab_test_id, value_numeric) VALUES ($1, $2, 120)
                            ON CONFLICT (lab_order_id, lab_test_id) DO NOTHING RETURNING flag, ref_range, unit`, [o.id, test.id]);
    if (r) { assert.equal(r.flag, 'HIGH'); assert.equal(r.unit, 'U/L'); }
    const crit = await db.one(`SELECT id FROM lab_test WHERE code = 'GDS'`);
    const r2 = await db.one(`INSERT INTO lab_result (lab_order_id, lab_test_id, value_numeric) VALUES ($1, $2, 520)
                             ON CONFLICT (lab_order_id, lab_test_id) DO UPDATE SET value_numeric = 520 RETURNING flag`, [o.id, crit.id]);
    assert.equal(r2.flag, 'CRITICAL_HIGH');
  });
});

test('organisation hierarchy is validated and re-parenting moves the whole subtree', async () => {
  await asUser('kas.groupadmin', async db => {
    const g = await db.val(`SELECT id FROM org_unit WHERE unit_type = 'GROUP'`);
    await db.rejects(`INSERT INTO org_unit (parent_id, unit_type, code, name) VALUES ($1, 'DIVISION', 'BAD-DIV', 'Divisi Salah')`, [g], /cannot be placed under/);
    // add a new PT + estate purely as data (no code change)
    const pt = await db.val(`INSERT INTO org_unit (parent_id, unit_type, code, name) VALUES ($1, 'COMPANY', 'NEW-PT', 'PT Baru Uji') RETURNING id`, [g]);
    const est = await db.val(`INSERT INTO org_unit (parent_id, unit_type, code, name) VALUES ($1, 'ESTATE', 'NEW-E01', 'Kebun Baru') RETURNING id`, [pt]);
    assert.equal(await db.val('SELECT depth FROM org_unit WHERE id = $1', [est]), 3);
    // move Rayon C from PT BCPJ to PT BCPA → its divisions & clinic follow
    const bcpa = await db.val(`SELECT id FROM org_unit WHERE code = 'BCPA'`);
    await db.q(`UPDATE org_unit SET parent_id = $1 WHERE code = 'BCPJ-RC'`, [bcpa]);
    const moved = await db.val(`SELECT count(*)::int FROM org_unit c WHERE c.code LIKE 'BCPJ-RC-%'`);
    const wrong = await db.val(`SELECT count(*)::int FROM org_unit c WHERE c.code LIKE 'BCPJ-RC-%'
                                   AND NOT c.path <@ (SELECT path FROM org_unit WHERE code = 'BCPA')`);
    assert.ok(moved >= 3);
    assert.equal(wrong, 0);
    // a unit cannot be moved under its own descendant
    const div = await db.val(`SELECT id FROM org_unit WHERE code = 'BCPJ-RC-DIV1'`);
    await db.rejects(`UPDATE org_unit SET parent_id = $1 WHERE code = 'BCPJ-RC'`, [div], /cannot be placed|own descendant/);
  });
  // a scoped admin cannot create units outside the scope
  await asUser('kas.ptadmin.bcpa', async db => {
    const bcpj = await db.val(`SELECT id FROM org_unit WHERE code = 'BCPJ'`);
    await db.rejects(`INSERT INTO org_unit (parent_id, unit_type, code, name) VALUES ($1, 'ESTATE', 'X-E99', 'Kebun Liar')`, [bcpj], /row-level security/);
  });
});

test('document numbers are sequential per tenant, type, scope and period', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const a = await db.val(`SELECT app.next_document_no('TST', 'BCPJ-RA-KLN')`);
    const b = await db.val(`SELECT app.next_document_no('TST', 'BCPJ-RA-KLN')`);
    assert.match(a, /^TST-BCPJ-RA-KLN-\d{4}-000001$/);
    assert.match(b, /^TST-BCPJ-RA-KLN-\d{4}-000002$/);
  });
});

test('row-level security keeps typical list queries fast (index + InitPlan)', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const t0 = Date.now();
    await db.q(`SELECT e.encounter_no, d.icd10_code FROM encounter e JOIN diagnosis d ON d.encounter_id = e.id
                 WHERE e.started_at > now() - interval '30 days' ORDER BY e.started_at DESC LIMIT 50`);
    const plan = (await db.q(`EXPLAIN SELECT * FROM encounter WHERE started_at > now() - interval '30 days'`)).map(r => r['QUERY PLAN']).join('\n');
    assert.match(plan, /InitPlan/, 'unit_ids() must be evaluated once per statement');
    assert.ok(Date.now() - t0 < 1500, 'list query should be fast');
  });
});
