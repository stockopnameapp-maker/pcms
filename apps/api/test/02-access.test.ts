import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, login, one, q, server, unitId } from './helpers.js';

after(close);
let e01: string, e02: string, grp: string;
before(async () => { e01 = await unitId('BCPJ-RA'); e02 = await unitId('BCPJ-RB'); grp = await unitId('KAS-GRP'); });

test('module permissions are enforced by the API, not just hidden in the menu', async () => {
  const hr = await login('kas.hrmanager.bcpj');
  assert.equal((await hr.get('/r/encounters')).status, 403, 'HR cannot list medical records');
  assert.equal((await hr.get('/r/prescriptions')).status, 403);
  assert.equal((await hr.get('/lab/worklist')).status, 403);
  const corp = await login('kas.corporate');
  assert.equal((await corp.get('/r/encounters')).status, 403, 'corporate management sees aggregates only');
  const enc = await one(`SELECT e.id FROM encounter e JOIN org_unit c ON c.id = e.clinic_id WHERE c.code = 'BCPJ-RA-KLN' AND e.status = 'SIGNED' LIMIT 1`);
  assert.ok([403, 404].includes((await corp.get(`/emr/encounters/${enc.id}`)).status));
});

test('HR sees sick-leave administration without diagnosis or clinical notes', async () => {
  const hr = await login('kas.hrmanager.bcpj');
  const r = await hr.get('/r/sick-leaves', { pageSize: 20 });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length > 0);
  for (const row of r.body.data) {
    for (const k of Object.keys(row)) assert.ok(!/icd|diagnos|note|complaint|plan|assessment/i.test(k) || k === 'admin_remarks', `HR row exposes ${k}`);
  }
  const d = await hr.get(`/r/sick-leaves/${r.body.data[0].id}`);
  assert.equal(d.status, 200);
  assert.ok(!('diagnosis' in d.body.data) && !('icd10_code' in d.body.data));
});

test('tenant isolation: another group cannot read or address this group\'s data', async () => {
  const other = await login('zzt.corporate');
  const emp = await one(`SELECT e.id, e.employee_no FROM employee e JOIN tenant t ON t.id = e.tenant_id WHERE t.code = 'KAS' LIMIT 1`);
  const list = await other.get('/r/employees', { q: emp.employee_no });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 0);
  assert.equal((await other.get(`/r/employees/${emp.id}`)).status, 404);
  assert.equal((await other.get('/dashboard/summary', { unitId: grp })).status, 403);
  const units = await other.get('/lookup/org_unit', { q: 'Rayon' });
  assert.equal(units.body.data.length, 0);
});

test('org-scope: an estate manager cannot open another estate\'s dashboard', async () => {
  const em = await login('kas.estate.bcpj-ra');
  assert.equal((await em.get('/dashboard/summary', { unitId: e01 })).status, 200);
  assert.equal((await em.get('/dashboard/summary', { unitId: e02 })).status, 403);
  assert.equal((await em.get('/finance/costs', { unitId: e02 })).status, 403);
});

test('small-cell suppression hides rare diagnoses from non-clinical viewers', async () => {
  const em = await login('kas.estate.bcpj-ra');
  const r = await em.get('/dashboard/top-diseases', { unitId: e01, limit: 50, from: '2020-01-01' });
  assert.equal(r.status, 200);
  for (const d of r.body.data) assert.ok(d.cases === null ? d.suppressed : Number(d.cases) >= 5, `${d.icd10_code} leaks a count of ${d.cases}`);
  const rare = await one(`SELECT d.icd10_code FROM diagnosis d JOIN encounter e ON e.id = d.encounter_id JOIN org_unit c ON c.id = e.clinic_id
                           WHERE c.path <@ (SELECT path FROM org_unit WHERE id = $1) AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL
                           GROUP BY 1 ORDER BY count(*) ASC LIMIT 1`, [e01]);
  const t = await em.get('/dashboard/trend', { unitId: e01, metric: `disease:${rare.icd10_code}`, bucket: 'week', from: '2020-01-01' });
  assert.equal(t.status, 200);
  for (const p of t.body.data) assert.ok(p.value === null || Number(p.value) === 0 || Number(p.value) >= 5, `trend leaks ${p.value}`);
});

test('global search only returns sections the user may read', async () => {
  const hr = await login('kas.hrmanager.bcpj');
  const r = await hr.get('/search', { q: 'ENC' });
  assert.ok(!r.body.data.some((s: any) => s.type === 'encounter'));
  const doc = await login('kas.dr.bcpj-ra-kln');
  const d = await doc.get('/search', { q: 'ENC' });
  assert.ok(d.body.data.some((s: any) => s.type === 'encounter'));
});

test('generic resources validate input and use optimistic locking', async () => {
  const admin = await login('kas.superadmin');
  const bad = await admin.post('/r/medicines', { name: 'x' });
  assert.equal(bad.status, 400);
  const sup = await one(`SELECT s.id FROM supplier s JOIN tenant t ON t.id = s.tenant_id WHERE t.code = 'KAS' LIMIT 1`);
  const code = 'TST-' + Date.now().toString(36).toUpperCase();
  const h = await admin.post('/r/hospitals', { code, name: 'RS Uji Integrasi', hospital_type: 'RSUD', city: 'Pekanbaru', is_partner: false });
  assert.equal(h.status, 201, JSON.stringify(h.body));
  const id = h.body.data.id; const v = h.body.data.version;
  const ok = await admin.patch(`/r/hospitals/${id}`, { city: 'Dumai' }, { 'if-match': String(v) });
  assert.equal(ok.status, 200);
  const stale = await admin.patch(`/r/hospitals/${id}`, { city: 'Siak' }, { 'if-match': String(v) });
  assert.equal(stale.status, 409, 'stale version is rejected');
  assert.equal((await admin.del(`/r/hospitals/${id}`)).status, 200);
  const row = await one('SELECT deleted_at FROM hospital WHERE id = $1', [id]);
  assert.ok(row.deleted_at, 'delete is a soft delete');
  void sup;
});

test('report exports require EXPORT permission and are written to the audit trail', async () => {
  const corp = await login('kas.corporate');
  const list = await corp.get('/reports');
  assert.equal(list.body.data.length, 15);
  const j = await corp.get('/reports/CONSOLIDATED', { unitId: grp });
  assert.equal(j.status, 200);
  assert.ok(j.body.rows.length > 0);
  const x = await corp.get('/reports/CONSOLIDATED', { unitId: grp, format: 'xlsx' });
  assert.equal(x.status, 200);
  assert.match(String(x.headers['content-type']), /spreadsheetml/);
  assert.equal(x.raw.subarray(0, 2).toString(), 'PK');
  const p = await corp.get('/reports/CONSOLIDATED', { unitId: grp, format: 'pdf' });
  assert.equal(p.raw.subarray(0, 4).toString(), '%PDF');
  const c = await corp.get('/reports/CONSOLIDATED', { unitId: grp, format: 'csv' });
  assert.match(c.raw.toString('utf8'), /Unit/);
  const audit = await q(`SELECT action FROM audit.audit_log l JOIN app_user u ON u.id = l.user_id WHERE u.username = 'kas.corporate'
                          AND l.table_name = 'report' AND l.occurred_at > now() - interval '1 minute'`);
  assert.ok(audit.some((a) => a.action === 'EXPORT') && audit.some((a) => a.action === 'PRINT') && audit.some((a) => a.action === 'VIEW'));
  const hr = await login('kas.hrmanager.bcpj');
  assert.equal((await hr.get('/reports/INVENTORY', { unitId: e01 })).status, 403, 'HR cannot run the pharmacy inventory report');
});

test('portal users only reach their own and their family\'s records', async () => {
  const emp = await login('kas.employee');
  const s = await emp.get('/portal/summary');
  assert.equal(s.status, 200);
  const mine = s.body.data.patients.map((p: any) => p.id);
  assert.ok(mine.length >= 1);
  const stranger = await one('SELECT id FROM patient WHERE NOT (id = ANY($1::uuid[])) LIMIT 1', [mine]);
  const clinic = s.body.data.clinics[0].id;
  const r = await emp.post('/portal/appointments', { patientId: stranger.id, clinicId: clinic, scheduledAt: '2099-01-01T09:00', reason: 'kontrol' });
  assert.equal(r.status, 403);
  assert.equal((await emp.get('/r/patients')).status, 403);
  const card = await emp.get('/portal/card.png');
  assert.equal(card.status, 200);
  assert.equal(card.raw.subarray(1, 4).toString(), 'PNG');
});

test('role administration: system roles are immutable, escalation is blocked', async () => {
  const admin = await login('kas.superadmin');
  const roles = (await admin.get('/admin/roles')).body.roles;
  const sys = roles.find((r: any) => r.code === 'DOCTOR');
  assert.equal((await admin.put(`/admin/roles/${sys.id}/permissions`, { permissions: [] })).status, 403);
  const cm = await login('kas.dr.bcpj-ra-kln');
  assert.equal((await cm.get('/admin/roles')).status, 403);
});

test('the Android app origin may call the API (CORS), other origins may not', async () => {
  const s = await server();
  const pre = (origin: string) => s.inject({ method: 'OPTIONS', url: '/api/v1/emr/encounters/x', headers: { origin, 'access-control-request-method': 'PATCH' } });
  const ok = await pre('https://localhost');
  assert.equal(ok.headers['access-control-allow-origin'], 'https://localhost');
  assert.match(String(ok.headers['access-control-allow-methods']), /PATCH/);
  const evil = await pre('https://evil.example');
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
});
