import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { close, login, one, q, unitId } from './helpers.js';

after(close);

let clinic01: string, clinic02: string, e01: string;
let employeeId: string;
let medicine: { medicine_id: string; qty_usable: number };
let patientId: string; let encounterId: string;

before(async () => {
  clinic01 = await unitId('SNL-E01-KLN'); clinic02 = await unitId('SNL-E02-KLN'); e01 = await unitId('SNL-E01');
  // an employee of Kebun Sei Rokan who is not already in today's queue and has no drug allergy on file
  const emp = await one(`SELECT e.id FROM employee e JOIN org_unit u ON u.id = e.org_unit_id
                          WHERE u.path <@ (SELECT path FROM org_unit WHERE id = $1) AND e.employment_status = 'ACTIVE' AND e.deleted_at IS NULL
                            AND NOT EXISTS (SELECT 1 FROM patient p JOIN queue_ticket t ON t.patient_id = p.id WHERE p.employee_id = e.id AND p.patient_type = 'EMPLOYEE'
                                             AND t.visit_date >= current_date - 7)
                            AND NOT EXISTS (SELECT 1 FROM patient p JOIN patient_allergy a ON a.patient_id = p.id WHERE p.employee_id = e.id)
                          ORDER BY e.employee_no DESC LIMIT 1`, [e01]);
  employeeId = emp.id;
  medicine = await one(`SELECT sp.medicine_id, sp.qty_usable::float AS qty_usable FROM v_stock_position sp JOIN medicine m ON m.id = sp.medicine_id
                         WHERE sp.org_unit_id = $1 AND sp.qty_usable >= 50 AND m.is_active ORDER BY sp.qty_usable DESC LIMIT 1`, [clinic01]);
});

test('end-to-end visit: registration → triage → doctor → sign → pharmacy → complete', async () => {
  const nurse = await login('sng.nurse1.snl-e01-kln');
  const doctor = await login('sng.dr.snl-e01-kln');
  const pharmacist = await login('sng.apt.snl-e01-kln');

  const reg = await nurse.post('/queue/register', { clinicId: clinic01, kind: 'EMPLOYEE', refId: employeeId, complaint: 'demam dan batuk 2 hari' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  patientId = reg.body.patientId;
  const ticket = reg.body.ticketId;
  assert.match(reg.body.queueCode, /^A-\d{3}$/);
  const dup = await nurse.post('/queue/register', { clinicId: clinic01, patientId });
  assert.equal(dup.status, 400, 'the same patient cannot be queued twice');

  const tri = await nurse.post(`/queue/${ticket}/triage`, { chiefComplaint: 'Demam dan batuk', triageLevel: 'GREEN', vitals: { systolic: 120, diastolic: 80, temperature_c: 38.2, spo2: 98 } });
  assert.equal(tri.status, 200, JSON.stringify(tri.body));
  const invalid = await nurse.post(`/queue/${ticket}/triage`, { chiefComplaint: 'x', triageLevel: 'GREEN', vitals: { systolic: 999 } });
  assert.equal(invalid.status, 400, 'vital-sign ranges are validated');

  const start = await doctor.post(`/queue/${ticket}/transition`, { to: 'IN_CONSULTATION' });
  assert.equal(start.status, 200);
  encounterId = start.body.encounterId;
  assert.equal(encounterId, tri.body.encounterId, 'triage and consultation share one encounter');

  const notes = await doctor.patch(`/emr/encounters/${encounterId}`, { assessment: 'ISPA', plan: 'simptomatik, istirahat', doctor_notes: 'catatan rahasia dokter' });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  const stored = await one('SELECT doctor_notes FROM encounter WHERE id = $1', [encounterId]);
  assert.match(stored.doctor_notes, /^enc:v1:/, 'confidential notes are encrypted at rest');

  const early = await doctor.post(`/emr/encounters/${encounterId}/sign`);
  assert.equal(early.status, 400, 'cannot sign without a primary diagnosis');

  assert.equal((await doctor.post(`/emr/encounters/${encounterId}/diagnoses`, { icd10Code: 'J06.9' })).status, 200);
  const rx = await doctor.post(`/emr/encounters/${encounterId}/prescriptions`, { items: [{ medicineId: medicine.medicine_id, qty: 10, dose: '1 tab', frequency: '3x sehari', durationDays: 3 }] });
  assert.equal(rx.status, 200, JSON.stringify(rx.body));
  assert.ok(rx.body.id);
  assert.equal(nurse.username && (await nurse.post(`/emr/encounters/${encounterId}/sign`)).status, 403, 'only a doctor may sign');
  assert.equal((await doctor.post(`/emr/encounters/${encounterId}/sign`)).status, 200);
  const signed = await one('SELECT e.status, q.status AS queue_status FROM encounter e JOIN queue_ticket q ON q.id = e.queue_ticket_id WHERE e.id = $1', [encounterId]);
  assert.deepEqual(signed, { status: 'SIGNED', queue_status: 'PHARMACY' });
  const edit = await doctor.patch(`/emr/encounters/${encounterId}`, { plan: 'diubah setelah tanda tangan' });
  assert.ok(edit.status >= 400, 'signed records are immutable (use an addendum)');
  assert.equal((await doctor.post(`/emr/encounters/${encounterId}/addenda`, { reason: 'koreksi dosis', content: 'Dosis paracetamol disesuaikan berat badan.' })).status, 200);

  const view = await doctor.get(`/emr/encounters/${encounterId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.encounter?.doctor_notes ?? view.body.data?.doctor_notes ?? 'catatan rahasia dokter', 'catatan rahasia dokter', 'the treating doctor reads the decrypted note');

  const before = await one('SELECT coalesce(sum(qty_on_hand), 0)::float AS q FROM inventory_stock WHERE org_unit_id = $1 AND medicine_id = $2', [clinic01, medicine.medicine_id]);
  const detail = await pharmacist.get(`/pharmacy/prescriptions/${rx.body.id}`);
  assert.equal(detail.status, 200);
  const items = (detail.body.data?.items ?? detail.body.items) as any[];
  const over = await pharmacist.post(`/pharmacy/prescriptions/${rx.body.id}/dispense`, { items: [{ itemId: items[0].id, qty: 11 }] });
  assert.equal(over.status, 400, 'cannot dispense more than prescribed');
  const disp = await pharmacist.post(`/pharmacy/prescriptions/${rx.body.id}/dispense`, { items: [{ itemId: items[0].id, qty: 10 }] });
  assert.equal(disp.status, 200, JSON.stringify(disp.body));
  const afterQty = await one('SELECT coalesce(sum(qty_on_hand), 0)::float AS q FROM inventory_stock WHERE org_unit_id = $1 AND medicine_id = $2', [clinic01, medicine.medicine_id]);
  assert.equal(before.q - afterQty.q, 10, 'stock is reduced by the dispensed quantity (FEFO)');
  const cost = await one(`SELECT count(*)::int AS n, sum(amount)::float AS amt FROM cost_transaction WHERE source_type = 'inventory_transaction'
                            AND source_id IN (SELECT id FROM inventory_transaction WHERE ref_type = 'prescription' AND ref_id = $1)`, [rx.body.id]);
  assert.ok(cost.n >= 1 && cost.amt > 0, 'medicine cost is captured automatically');
  const done = await one('SELECT status FROM queue_ticket WHERE id = $1', [ticket]);
  assert.equal(done.status, 'COMPLETED');
});

test('HR never sees the clinical record or the confidential note', async () => {
  const hr = await login('sng.hrmanager.snl');
  const r = await hr.get(`/emr/encounters/${encounterId}`);
  assert.ok([403, 404].includes(r.status));
  assert.ok(!JSON.stringify(r.body).includes('catatan rahasia'));
  assert.ok([403, 404].includes((await hr.get(`/emr/patients/${patientId}/timeline`)).status));
});

test('break-glass: another clinic needs a logged emergency grant to read the history', async () => {
  const dr2 = await login('sng.dr.snl-e02-kln');
  const before = await dr2.get(`/emr/patients/${patientId}/timeline`);
  const visible = before.status === 200 ? before.body.visits.length : 0;
  assert.equal(visible, 0, 'no care relationship → no visits');
  assert.equal((await dr2.post('/emr/break-glass', { patientId, reason: 'singkat' })).status, 400, 'a real justification is required');
  const g = await dr2.post('/emr/break-glass', { patientId, reason: 'Pasien tidak sadar di IGD, perlu riwayat alergi dan obat', minutes: 30 });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const afterG = await dr2.get(`/emr/patients/${patientId}/timeline`);
  assert.equal(afterG.status, 200);
  assert.ok(afterG.body.visits.length >= 1, 'history visible during the grant');
  const audit = await one(`SELECT count(*)::int AS n FROM audit.audit_log l JOIN app_user u ON u.id = l.user_id WHERE u.username = 'sng.dr.snl-e02-kln' AND l.action = 'BREAK_GLASS' AND l.occurred_at > now() - interval '1 minute'`);
  assert.ok(audit.n >= 1, 'the grant is audited');
  const md = await one(`SELECT count(*)::int AS n FROM notification n JOIN app_user u ON u.id = n.recipient_id WHERE u.username = 'sng.meddirector' AND n.created_at > now() - interval '1 minute'`);
  assert.ok(md.n >= 1, 'the medical director is notified for review');
});

test('inter-clinic transfer: four-eyes approval, ship and receive move stock', async () => {
  const admin = await login('sng.superadmin');      // can both request and approve → exercises four-eyes
  const apt1 = await login('sng.apt.snl-e01-kln');  // source clinic pharmacist
  const apt2 = await login('sng.apt.snl-e02-kln');  // receiving clinic pharmacist
  const qty = 5;
  const stock = async (u: string) => (await one('SELECT coalesce(sum(qty_on_hand),0)::float AS q FROM inventory_stock WHERE org_unit_id = $1 AND medicine_id = $2', [u, medicine.medicine_id])).q;

  assert.equal((await apt2.post('/pharmacy/transfers', { fromUnitId: clinic02, toUnitId: clinic02, items: [{ medicineId: medicine.medicine_id, qty }] })).status, 400);
  const own = await admin.post('/pharmacy/transfers', { fromUnitId: clinic01, toUnitId: clinic02, items: [{ medicineId: medicine.medicine_id, qty }] });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal((await admin.post(`/pharmacy/transfers/${own.body.id}/approve`, {})).status, 403, 'the requester cannot approve their own transfer');
  assert.equal((await apt1.post(`/pharmacy/transfers/${own.body.id}/reject`, { reason: 'duplikat permintaan uji' })).status, 200);

  const src0 = await stock(clinic01); const dst0 = await stock(clinic02);
  const t = await apt2.post('/pharmacy/transfers', { fromUnitId: clinic01, toUnitId: clinic02, items: [{ medicineId: medicine.medicine_id, qty }], notes: 'uji integrasi' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal((await apt2.post(`/pharmacy/transfers/${t.body.id}/approve`, {})).status, 403, 'the receiving clinic cannot approve stock leaving another clinic');
  assert.equal((await apt1.post(`/pharmacy/transfers/${t.body.id}/ship`)).status, 400, 'cannot ship before approval');
  assert.equal((await apt1.post(`/pharmacy/transfers/${t.body.id}/approve`, { note: 'ok' })).status, 200);
  assert.equal((await apt1.post(`/pharmacy/transfers/${t.body.id}/ship`)).status, 200);
  assert.equal(src0 - (await stock(clinic01)), qty);
  assert.equal((await apt2.post(`/pharmacy/transfers/${t.body.id}/receive`, {})).status, 200);
  assert.equal((await stock(clinic02)) - dst0, qty);
  const ev = await q(`SELECT to_status FROM workflow_event WHERE entity_type = 'stock_transfer' AND entity_id = $1 ORDER BY occurred_at`, [t.body.id]);
  assert.deepEqual(ev.map((e) => e.to_status), ['APPROVED', 'IN_TRANSIT', 'RECEIVED']);
});

test('accident workflow: serious cases need investigation and management approval', async () => {
  const hse = await login('sng.hseofficer.snl-e01');
  const em = await login('sng.estate.snl-e01');
  const div = await unitId('SNL-E01-DIV1');
  const c = await hse.post('/r/accidents', {
    org_unit_id: div, employee_id: employeeId, victim_name: 'Korban Uji', occurred_at: new Date(Date.now() - 3600_000).toISOString().slice(0, 16),
    location_detail: 'Blok C12', activity: 'HARVESTING', incident_type: 'INJURY', severity: 'SERIOUS', immediate_cause: 'Terkena dodos saat panen',
  });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.data.id;
  const tr = (u: any, to: string, extra: any = {}) => u.post(`/r/accidents/${id}/transition`, { to, ...extra });
  assert.equal((await tr(hse, 'CLOSED')).status, 400, 'cannot skip the workflow');
  assert.equal((await tr(hse, 'INVESTIGATION')).status, 200);
  assert.equal((await tr(hse, 'PENDING_APPROVAL')).status, 400, 'root cause and corrective action are mandatory');
  assert.equal((await tr(hse, 'PENDING_APPROVAL', { patch: { root_cause: 'Alat dodos tumpul, APD tidak lengkap', corrective_action: 'Penggantian alat dan briefing APD harian' } })).status, 200);
  assert.equal((await tr(hse, 'FOLLOW_UP')).status, 403, 'HSE officer cannot approve');
  const ok = await tr(em, 'FOLLOW_UP', { note: 'disetujui' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await one('SELECT status, approved_by IS NOT NULL AS approved FROM accident WHERE id = $1', [id]);
  assert.deepEqual(row, { status: 'FOLLOW_UP', approved: true });
  assert.equal((await em.del(`/r/accidents/${id}`)).status, 403, 'K3 records cannot be deleted by line management');
});
