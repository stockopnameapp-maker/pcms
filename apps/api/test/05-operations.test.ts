// Covers the remaining endpoints the web app calls: lookups, lab, MCU, ambulance,
// purchasing, stock opname, documents, QR, attachments, exports, admin and alerts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, login, one, q, server, unitId } from './helpers.js';

after(close);
let clinic01: string, e01: string, grp: string;
before(async () => { clinic01 = await unitId('SNL-E01-KLN'); e01 = await unitId('SNL-E01'); grp = await unitId('SNG-GRP'); });

const ok = (r: any, msg = '') => assert.ok(r.status >= 200 && r.status < 300, `${msg} → ${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`);

test('every lookup used by forms answers under RLS', async () => {
  const admin = await login('sng.superadmin');
  for (const kind of ['org_unit', 'clinic', 'stock_site', 'employee', 'patient', 'medicine', 'medicine_category', 'supplier', 'hospital', 'job_position',
    'risk_category', 'lab_test', 'icd10', 'role', 'app_user', 'medical_staff', 'ambulance', 'clinic_room', 'clinic_bed']) {
    const r = await admin.get(`/lookup/${kind}`, { q: kind === 'icd10' ? 'J0' : '' });
    ok(r, kind);
    if (r.body.data[0]) ok(await admin.get(`/lookup/${kind}`, { id: r.body.data[0].id }), `${kind} by id`);
  }
});

test('registration lookup finds employees by number, name and QR; results are masked', async () => {
  const nurse = await login('sng.nurse1.snl-e01-kln');
  const emp = await one(`SELECT e.employee_no, e.full_name, e.qr_token FROM employee e JOIN tenant t ON t.id = e.tenant_id WHERE t.code = 'SNG' AND e.nik IS NOT NULL LIMIT 1`);
  for (const term of [emp.employee_no, emp.full_name.split(' ')[0], emp.qr_token]) {
    const r = await nurse.get('/patients/lookup', { q: term });
    ok(r, `lookup ${term}`);
    assert.ok(r.body.data.length > 0, `no hits for ${term}`);
    for (const h of r.body.data) assert.ok(!h.nik || /\*/.test(h.nik), 'NIK must be masked in lookups');
  }
});

test('lab: doctor orders, nurse enters results, values are flagged, doctor verifies', async () => {
  const nurse = await login('sng.nurse1.snl-e01-kln');
  const doctor = await login('sng.dr.snl-e01-kln');
  const emp = await one(`SELECT e.id FROM employee e JOIN org_unit u ON u.id = e.org_unit_id
                          WHERE u.path <@ (SELECT path FROM org_unit WHERE id = $1) AND e.employment_status = 'ACTIVE'
                            AND NOT EXISTS (SELECT 1 FROM patient p JOIN queue_ticket t ON t.patient_id = p.id WHERE p.employee_id = e.id AND t.visit_date >= current_date - 7)
                          ORDER BY e.employee_no LIMIT 1`, [e01]);
  const reg = await nurse.post('/queue/register', { clinicId: clinic01, kind: 'EMPLOYEE', refId: emp.id });
  ok(reg, 'register');
  ok(await nurse.post(`/queue/${reg.body.ticketId}/triage`, { chiefComplaint: 'Lemas, pusing', triageLevel: 'GREEN', vitals: { systolic: 110, diastolic: 70 } }), 'triage');
  const st = await doctor.post(`/queue/${reg.body.ticketId}/transition`, { to: 'IN_CONSULTATION' });
  ok(st, 'consult');
  const tests = await one(`SELECT array_agg(t.id ORDER BY t.code) AS ids FROM lab_test t JOIN tenant x ON x.id = t.tenant_id WHERE x.code = 'SNG' AND t.code IN ('HB', 'GDS')`);
  const lo = await doctor.post(`/emr/encounters/${st.body.encounterId}/lab-orders`, { testIds: tests.ids, priority: 'URGENT' });
  ok(lo, 'order');
  const wl = await nurse.get('/lab/worklist', { clinicId: clinic01 });
  const order = wl.body.data.find((o: any) => o.id === lo.body.id);
  assert.ok(order, 'the new order appears on the worklist');
  const results = order.results.map((r: any) => ({ labTestId: r.lab_test_id, valueNumeric: r.code === 'GDS' ? 320 : 13.5 }));
  ok(await nurse.post(`/lab/orders/${order.id}/results`, { results }), 'enter results');
  const flags = await q('SELECT t.code, r.flag FROM lab_result r JOIN lab_test t ON t.id = r.lab_test_id WHERE r.lab_order_id = $1', [order.id]);
  assert.ok(flags.some((f) => f.code === 'GDS' && /HIGH|CRITICAL/.test(f.flag)), 'out-of-range glucose is flagged automatically');
  ok(await doctor.post(`/lab/orders/${order.id}/verify`), 'verify');
  assert.equal((await one('SELECT status FROM lab_order WHERE id = $1', [order.id])).status, 'VERIFIED');
  const cost = await one(`SELECT count(*)::int AS n FROM cost_transaction WHERE source_type = 'lab_order' AND source_id = $1`, [order.id]);
  assert.equal(cost.n, 1, 'verified lab work is costed');
});

test('occupational health: schedule MCU for overdue workers and complete one with findings', async () => {
  const doctor = await login('sng.dr.snl-e01-kln');
  const md = await login('sng.meddirector');
  ok(await md.get('/occ-health/compliance', { unitId: e01 }));
  const s = await doctor.post('/occ-health/mcu/schedule', { unitId: e01, clinicId: clinic01, mcuType: 'PERIODIC', scheduledDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), selection: 'ALL_DUE' });
  ok(s, 'schedule');
  const mcu = await one(`SELECT m.id, m.employee_id FROM mcu m WHERE m.clinic_id = $1 AND m.status = 'SCHEDULED' ORDER BY m.created_at DESC LIMIT 1`, [clinic01]);
  assert.ok(mcu);
  ok(await md.get(`/occ-health/mcu/${mcu.id}`));
  ok(await md.get(`/occ-health/employees/${mcu.employee_id}`));
  const bad = await doctor.post(`/occ-health/mcu/${mcu.id}/complete`, { examDate: new Date().toISOString().slice(0, 10), fitStatus: 'FIT_WITH_RESTRICTION', findings: [{ examCode: 'PHYSICAL', result: 'TD 150/95', flag: 'ABNORMAL' }] });
  assert.equal(bad.status, 400, 'restrictions are required for FIT_WITH_RESTRICTION');
  ok(await doctor.post(`/occ-health/mcu/${mcu.id}/complete`, { examDate: new Date().toISOString().slice(0, 10), fitStatus: 'FIT_WITH_RESTRICTION', restrictions: 'Tidak bekerja di ketinggian',
    findings: [{ examCode: 'PHYSICAL', result: 'TD 150/95', flag: 'ABNORMAL', icd10Code: 'I10' }, { examCode: 'VISUS', result: '6/6', flag: 'NORMAL' }] }), 'complete');
  const done = await one('SELECT status, fit_status, next_due_date FROM mcu WHERE id = $1', [mcu.id]);
  assert.equal(done.status, 'COMPLETED');
  assert.ok(done.next_due_date, 'next due date is derived from the risk interval');
  const hr = await login('sng.hrmanager.snl');
  const view = await hr.get(`/r/mcu/${mcu.id}`);
  if (view.status === 200) assert.ok(!JSON.stringify(view.body).includes('TD 150/95'), 'HR sees the fit status, not the findings');
});

test('ambulance dispatch marks the vehicle as on duty', async () => {
  const mgr = await login('sng.dr.snl-e01-kln');
  const amb = await one(`SELECT id FROM ambulance WHERE clinic_id = $1 AND status = 'AVAILABLE' AND deleted_at IS NULL LIMIT 1`, [clinic01]);
  if (!amb) return;   // all vehicles busy in this seed
  const r = await mgr.post('/ambulance/dispatch', { ambulanceId: amb.id, tripType: 'EMERGENCY', priority: 'EMERGENCY', origin: 'Divisi I blok C12', destination: 'Klinik Sei Rokan' });
  ok(r, 'dispatch');
  const again = await mgr.post('/ambulance/dispatch', { ambulanceId: amb.id, tripType: 'EMERGENCY', origin: 'x1', destination: 'y1' });
  assert.equal(again.status, 400, 'a busy ambulance cannot be dispatched twice');
});

test('purchasing: PO → four-eyes approval → receive creates batches and stock', async () => {
  const apt = await login('sng.apt.snl-e01-kln');
  const mgr = await login('sng.dr.snl-e01-kln');
  const sup = await one(`SELECT s.id FROM supplier s JOIN tenant t ON t.id = s.tenant_id WHERE t.code = 'SNG' LIMIT 1`);
  const med = await one(`SELECT m.id FROM medicine m JOIN tenant t ON t.id = m.tenant_id WHERE t.code = 'SNG' AND m.is_active LIMIT 1`);
  const po = await apt.post('/pharmacy/purchase-orders', { siteId: clinic01, supplierId: sup.id, items: [{ medicineId: med.id, qty: 100, unitPrice: 1500 }] });
  ok(po, 'create PO');
  assert.equal((await apt.post(`/r/purchase-orders/${po.body.id}/transition`, { to: 'APPROVED' })).status, 403, 'creator cannot approve');
  ok(await mgr.post(`/r/purchase-orders/${po.body.id}/transition`, { to: 'APPROVED' }), 'approve');
  const d = await apt.get(`/pharmacy/purchase-orders/${po.body.id}`);
  ok(d);
  const item = (d.body.items ?? d.body.data?.items)[0];
  const before = (await one('SELECT coalesce(sum(qty_on_hand),0)::float AS q FROM inventory_stock WHERE org_unit_id = $1 AND medicine_id = $2', [clinic01, med.id])).q;
  const batchNo = 'IT' + Date.now().toString(36).toUpperCase();
  ok(await apt.post(`/pharmacy/purchase-orders/${po.body.id}/receive`, { items: [{ itemId: item.id, qtyReceived: 100, batchNo, expiryDate: '2028-12-31' }] }), 'receive');
  const after = (await one('SELECT coalesce(sum(qty_on_hand),0)::float AS q FROM inventory_stock WHERE org_unit_id = $1 AND medicine_id = $2', [clinic01, med.id])).q;
  assert.equal(after - before, 100);
  ok(await apt.get(`/pharmacy/stock/${clinic01}/${med.id}`));
});

test('stock opname: counted variance is posted as an adjustment', async () => {
  const apt = await login('sng.apt.snl-e01-kln');
  const mgr = await login('sng.dr.snl-e01-kln');
  const o = await apt.post('/pharmacy/opnames', { siteId: clinic01, notes: 'uji integrasi' });
  ok(o, 'start opname');
  const d = await apt.get(`/pharmacy/opnames/${o.body.id}`);
  ok(d);
  const items = d.body.items ?? d.body.data?.items;
  const it = items.find((i: any) => Number(i.system_qty) >= 2);
  ok(await apt.patch(`/pharmacy/opnames/${o.body.id}/counts`, { items: [{ itemId: it.id, countedQty: Number(it.system_qty) - 1, notes: 'rusak 1' }] }), 'counts');
  ok(await apt.post(`/r/stock-opnames/${o.body.id}/transition`, { to: 'SUBMITTED' }), 'submit');
  ok(await mgr.post(`/r/stock-opnames/${o.body.id}/transition`, { to: 'APPROVED' }), 'approve');
  const post = await apt.post(`/pharmacy/opnames/${o.body.id}/post`);
  ok(post, 'post');
  const adj = await one(`SELECT count(*)::int AS n FROM inventory_transaction WHERE ref_type = 'stock_opname' AND ref_id = $1`, [o.body.id]);
  assert.ok(adj.n >= 1);
});

test('printable documents carry a verification code that the public endpoint confirms', async () => {
  const doctor = await login('sng.dr.snl-e01-kln');
  const hr = await login('sng.hrmanager.snl');
  const sl = await one(`SELECT s.id FROM sick_leave s WHERE s.clinic_id = $1 AND s.status <> 'CANCELLED' LIMIT 1`, [clinic01]);
  for (const c of [doctor, hr]) {
    const pdf = await c.get(`/documents/sick-leave/${sl.id}.pdf`);
    assert.equal(pdf.status, 200, `${c.username} prints sick-leave letter`);
    assert.equal(pdf.raw.subarray(0, 4).toString(), '%PDF');
  }
  const cert = await one(`SELECT id, verification_code FROM medical_certificate WHERE clinic_id = $1 AND status = 'ISSUED' AND verification_code IS NOT NULL LIMIT 1`, [clinic01]);
  if (cert) {
    ok(await doctor.get(`/documents/certificate/${cert.id}.pdf`));
    const s = await server();
    const v = await s.inject({ method: 'GET', url: `/api/v1/public/verify/${cert.verification_code}` });
    assert.equal(v.statusCode, 200);
    const body = v.json();
    assert.ok(body.certificate_no && /\*/.test(body.patient), 'public verification masks the name');
    assert.ok(!('diagnosis' in body));
    assert.equal((await s.inject({ method: 'GET', url: '/api/v1/public/verify/000000000000' })).statusCode, 404);
  }
  const ref = await one(`SELECT id FROM referral WHERE clinic_id = $1 LIMIT 1`, [clinic01]);
  ok(await doctor.get(`/documents/referral/${ref.id}.pdf`));
  assert.ok([403, 404].includes((await hr.get(`/documents/referral/${ref.id}.pdf`)).status), 'HR cannot print a referral (contains diagnosis)');
});

test('QR codes render and resolve only within permission', async () => {
  const admin = await login('sng.superadmin');
  const emp = await one(`SELECT e.id, e.qr_token FROM employee e JOIN tenant t ON t.id = e.tenant_id WHERE t.code = 'SNG' LIMIT 1`);
  const png = await admin.get(`/qr/employee/${emp.id}.png`);
  assert.equal(png.status, 200);
  assert.equal(png.raw.subarray(1, 4).toString(), 'PNG');
  const r = await admin.get('/qr/resolve', { code: `PCMS:EMPLOYEE:${emp.qr_token}` });
  ok(r);
  assert.equal(r.body.id, emp.id);
  const other = await login('aag.superadmin');
  assert.ok([403, 404].includes((await other.get('/qr/resolve', { code: emp.qr_token })).status), 'another tenant cannot resolve the code');
});

test('attachments: type is checked by content, integrity by hash', async () => {
  const hse = await login('sng.hseofficer.snl-e01');
  const acc = await one(`SELECT a.id FROM accident a WHERE a.org_unit_id IN (SELECT id FROM org_unit WHERE path <@ (SELECT path FROM org_unit WHERE id = $1)) LIMIT 1`, [e01]);
  const boundary = '----pcms' + Date.now();
  const part = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = (mime: string, content: Buffer, filename: string) => Buffer.concat([
    Buffer.from(part('entityType', 'accident') + part('entityId', acc.id) + part('description', 'foto lokasi')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const hdr = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  const fake = await hse.raw('POST', '/files', body('application/pdf', Buffer.from('not really a pdf'), 'x.pdf'), hdr);
  assert.equal(fake.status, 400, 'content that does not match the declared type is rejected');
  const pdf = Buffer.from('%PDF-1.4\n%uji\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
  const up = await hse.raw('POST', '/files', body('application/pdf', pdf, 'kronologi.pdf'), hdr);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const dl = await hse.get(`/files/${up.body.data.id}/download`);
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.raw, pdf);
  const doc = await login('sng.dr.snl-e02-kln');
  assert.ok([403, 404].includes((await doc.get(`/files/${up.body.data.id}/download`)).status), 'attachments follow the parent record\'s access');
});

test('list exports respect EXPORT permission and are audited', async () => {
  const hr = await login('sng.hrmanager.snl');
  const x = await hr.get('/r/employees/export', { format: 'xlsx' });
  assert.equal(x.status, 200);
  assert.equal(x.raw.subarray(0, 2).toString(), 'PK');
  const nurse = await login('sng.nurse1.snl-e01-kln');
  assert.equal((await nurse.get('/r/patients/export', { format: 'csv' })).status, 403, 'no PATIENT:EXPORT for nurses');
  const a = await one(`SELECT count(*)::int AS n FROM audit.audit_log l JOIN app_user u ON u.id = l.user_id WHERE u.username = 'sng.hrmanager.snl' AND l.action = 'EXPORT' AND l.occurred_at > now() - interval '1 minute'`);
  assert.ok(a.n >= 1);
});

test('user administration: create, forced password change, reset, unlock, custom role', async () => {
  const admin = await login('sng.superadmin');
  const role = (await admin.get('/admin/roles')).body.roles.find((r: any) => r.code === 'NURSE');
  const uname = 'it.user.' + Date.now().toString(36);
  const weak = await admin.post('/admin/users', { username: uname, fullName: 'Uji Integrasi', homeUnitId: clinic01, password: 'password' });
  assert.equal(weak.status, 400, 'password policy applies to admin-created accounts');
  const c = await admin.post('/admin/users', { username: uname, fullName: 'Uji Integrasi', homeUnitId: clinic01, password: 'Sementara#2026', roles: [{ roleId: role.id, scopeUnitId: clinic01 }] });
  ok(c, 'create user');
  const s = await server();
  const l = await s.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: uname, password: 'Sementara#2026' }, headers: { 'x-forwarded-for': '10.77.0.1' } });
  assert.equal(l.statusCode, 200);
  assert.equal(l.json().mustChangePassword, true);
  ok(await admin.post(`/admin/users/${c.body.id}/reset-password`, { newPassword: 'Baru#Sekali2026' }), 'reset');
  ok(await admin.post(`/admin/users/${c.body.id}/unlock`), 'unlock');
  const code = 'IT_' + Date.now().toString(36).toUpperCase();
  const r = await admin.post('/admin/roles', { code, name: 'Peran uji', permissions: ['QUEUE:READ'] });
  ok(r, 'custom role');
  ok(await admin.put(`/admin/roles/${r.body.id}/permissions`, { permissions: ['QUEUE:READ', 'PATIENT:READ'] }), 'edit custom role');
  const perms = await q(`SELECT p.code FROM role_permission rp JOIN permission p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY 1`, [r.body.id]);
  assert.deepEqual(perms.map((p) => p.code), ['PATIENT:READ', 'QUEUE:READ']);
  const nurse = await login('sng.nurse1.snl-e01-kln');
  assert.equal((await nurse.post('/admin/users', { username: 'x.' + uname, fullName: 'Tidak Boleh', homeUnitId: clinic01, password: 'Sementara#2026' })).status, 403);
});

test('alert engine runs on demand and notifications can be cleared', async () => {
  const admin = await login('sng.superadmin');
  const r = await admin.post('/admin/jobs/alert-engine');
  ok(r, 'alert engine');
  const md = await login('sng.meddirector');
  ok(await md.get('/r/alerts', { status: 'OPEN' }));
  const n = await md.get('/notifications', { limit: 5 });
  ok(n);
  ok(await md.post('/notifications/read-all'));
  const unread = await md.get('/notifications', { unread: '1' });
  assert.equal(unread.body.data.length, 0);
  ok(await md.get('/dashboard/clinic-today', { clinicId: clinic01 }));
  void grp;
});
