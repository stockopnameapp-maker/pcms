import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { asUser, owner, closeAll } from './helpers.mjs';

after(closeAll);

const unitId = async code => (await owner('SELECT id FROM org_unit WHERE code = $1', [code]))[0].id;

test('Estate Manager sees exactly the employees of the assigned estate subtree', async () => {
  const [{ n: expected }] = await owner(`
    SELECT count(*)::int AS n FROM employee e JOIN org_unit u ON u.id = e.org_unit_id
     WHERE u.path <@ (SELECT path FROM org_unit WHERE code = 'BCPJ-RA')`);
  await asUser('kas.estate.bcpj-ra', async db => {
    assert.equal(await db.val('SELECT count(*)::int FROM employee'), expected);
    const outside = await db.val(`SELECT count(*)::int FROM employee e JOIN org_unit u ON u.id = e.org_unit_id
                                   WHERE NOT u.path <@ (SELECT path FROM org_unit WHERE code = 'BCPJ-RA')`);
    assert.equal(outside, 0);
  });
});

test('Estate Manager gets administrative data but no clinical records (need-to-know)', async () => {
  await asUser('kas.estate.bcpj-ra', async db => {
    assert.ok(await db.val('SELECT count(*)::int FROM sick_leave') > 0, 'should see sick leave of the estate');
    assert.ok(await db.val('SELECT count(*)::int FROM accident') > 0, 'should see accidents of the estate');
    for (const t of ['encounter', 'diagnosis', 'vital_sign', 'prescription', 'lab_result', 'mcu_finding', 'referral', 'patient_history']) {
      assert.equal(await db.val(`SELECT count(*)::int FROM ${t}`), 0, `estate manager must not read ${t}`);
    }
  });
});

test('HR Manager sees sick-leave status for the PT but never diagnoses or notes', async () => {
  const [{ n: expected }] = await owner(`
    SELECT count(*)::int AS n FROM sick_leave s
     WHERE EXISTS (SELECT 1 FROM org_unit u WHERE u.id IN (s.employee_unit_id, s.clinic_id)
                     AND u.path <@ (SELECT path FROM org_unit WHERE code = 'BCPJ'))`);
  await asUser('kas.hrmanager.bcpj', async db => {
    assert.equal(await db.val('SELECT count(*)::int FROM sick_leave'), expected);
    for (const t of ['encounter', 'diagnosis', 'mcu_finding', 'lab_result', 'referral', 'prescription']) {
      assert.equal(await db.val(`SELECT count(*)::int FROM ${t}`), 0, `HR must not read ${t}`);
    }
    // the fit status of MCUs is visible, the clinical findings are not
    assert.ok(await db.val('SELECT count(*)::int FROM mcu WHERE fit_status IS NOT NULL') > 0);
  });
  // structural guarantee: the administrative tables have no clinical columns at all
  const cols = await owner(`SELECT table_name, column_name FROM information_schema.columns
                             WHERE table_name IN ('sick_leave','medical_certificate','mcu','health_assessment')
                               AND column_name ~ '(diagnos|icd|complaint|assessment_text|notes|finding|exam_result)'`);
  assert.deepEqual(cols, []);
});

test('Corporate Management sees group-wide costs but no patient-level clinical data', async () => {
  const [{ total }] = await owner(`SELECT sum(amount)::numeric AS total FROM cost_transaction c JOIN tenant t ON t.id = c.tenant_id WHERE t.code = 'KAS'`);
  await asUser('kas.corporate', async db => {
    assert.equal(String(await db.val('SELECT sum(amount)::numeric FROM cost_transaction')), String(total));
    for (const t of ['encounter', 'diagnosis', 'patient', 'prescription', 'lab_order', 'referral', 'mcu_finding']) {
      assert.equal(await db.val(`SELECT count(*)::int FROM ${t}`), 0, `management must not read ${t}`);
    }
  });
});

test('Doctor reads medical records of the own clinic only (plus active-care patients)', async () => {
  const clinic = await unitId('BCPJ-RA-KLN');
  await asUser('kas.dr2.bcpj-ra-kln', async db => {
    const rows = await db.q(`SELECT e.clinic_id, e.clinic_id = $1 AS own,
                                    e.patient_id = ANY (app.active_care_patient_ids('EMR')) AS in_care
                               FROM encounter e`, [clinic]);
    assert.ok(rows.length > 100);
    assert.ok(rows.every(r => r.own || r.in_care), 'every visible record is from the own clinic or an active-care patient');
    assert.equal(await db.val('SELECT count(*)::int FROM accident WHERE clinic_id <> $1', [clinic]), 0);
  });
});

test('continuity of care: a doctor sees another clinic’s history only while the patient visits', async () => {
  const clinicB = await unitId('BCPJ-RB-KLN');
  // a patient of clinic A (Rayon A) with history there, no recent visit at B
  const [p] = await owner(`
    SELECT p.id FROM patient p JOIN org_unit c ON c.id = p.primary_clinic_id AND c.code = 'BCPJ-RA-KLN'
     WHERE EXISTS (SELECT 1 FROM encounter e WHERE e.patient_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM queue_ticket q WHERE q.patient_id = p.id AND q.clinic_id = $1)
     LIMIT 1`, [clinicB]);
  await asUser('kas.dr.bcpj-rb-kln', async db => {
    assert.equal(await db.val('SELECT count(*)::int FROM encounter WHERE patient_id = $1', [p.id]), 0, 'no access before the visit');
    assert.equal(await db.val('SELECT count(*)::int FROM patient WHERE id = $1', [p.id]), 0);
    // nurse at clinic B registers the patient (walk-in) — same transaction, different identity
    await db.switchUser('kas.nurse1.bcpj-rb-kln');
    await db.q(`INSERT INTO queue_ticket (clinic_id, patient_id, queue_no, queue_code, priority) VALUES ($1, $2, 999, 'A-999', 'NORMAL')`, [clinicB, p.id]);
    await db.switchUser('kas.dr.bcpj-rb-kln');
    assert.ok(await db.val('SELECT count(*)::int FROM encounter WHERE patient_id = $1', [p.id]) > 0, 'full history visible during care');
    assert.equal(await db.val('SELECT count(*)::int FROM patient WHERE id = $1', [p.id]), 1);
    // ...but the doctor still cannot modify the other clinic's records
    const res = await db.q(`UPDATE encounter SET doctor_notes = 'x' WHERE patient_id = $1 AND clinic_id <> $2 RETURNING id`, [p.id, clinicB]);
    assert.equal(res.length, 0);
  });
});

test('Pharmacist dispenses from prescriptions and sees allergies, but cannot open the medical record', async () => {
  await asUser('kas.apt.bcpj-ra-kln', async db => {
    assert.ok(await db.val('SELECT count(*)::int FROM prescription') > 0);
    assert.ok(await db.val('SELECT count(*)::int FROM prescription_item') > 0);
    assert.equal(await db.val('SELECT count(*)::int FROM encounter'), 0);
    assert.equal(await db.val('SELECT count(*)::int FROM diagnosis'), 0);
    const allergies = await db.val(`SELECT count(*)::int FROM patient_allergy`);
    const [{ n }] = await owner(`SELECT count(*)::int AS n FROM patient_allergy a JOIN patient p ON p.id = a.patient_id JOIN org_unit c ON c.id = p.primary_clinic_id WHERE c.code = 'BCPJ-RA-KLN'`);
    assert.ok(allergies >= n && n > 0);
  });
});

test('actions are enforced per permission, not just visibility', async () => {
  const div = await unitId('BCPJ-RA-DIV1');
  const [pos] = await owner(`SELECT jp.id FROM job_position jp JOIN tenant t ON t.id = jp.tenant_id WHERE t.code = 'KAS' AND jp.code = 'PEMANEN'`);
  const insert = `INSERT INTO employee (employee_no, nik, full_name, gender, birth_date, org_unit_id, position_id, employment_type, join_date)
                  VALUES ('KAS-T0001', '1401011203900001', 'Uji Coba', 'M', '1990-03-12', $1, $2, 'CONTRACT', '2024-01-02') RETURNING id`;
  // Estate Manager has EMPLOYEE:READ only
  await asUser('kas.estate.bcpj-ra', async db => {
    await db.rejects(insert, [div, pos.id], /row-level security/);
  });
  // HR Officer of that estate has EMPLOYEE:CREATE there…
  await asUser('kas.hrofficer.bcpj-ra', async db => {
    const [row] = await db.q(insert, [div, pos.id]);
    assert.ok(row.id);
    // …and the database derived PT and estate automatically
    const e = await db.one(`SELECT c.code AS company, s.code AS estate FROM employee e JOIN org_unit c ON c.id = e.company_id JOIN org_unit s ON s.id = e.estate_id WHERE e.id = $1`, [row.id]);
    assert.deepEqual(e, { company: 'BCPJ', estate: 'BCPJ-RA' });
  });
  // …but not in another estate
  await asUser('kas.hrofficer.bcpj-ra', async db => {
    await db.rejects(insert, [await unitId('BCPJ-RB-DIV1'), pos.id], /row-level security/);
  });
});

test('validation: invalid data is rejected by constraints', async () => {
  const div = await unitId('BCPJ-RA-DIV1');
  const [pos] = await owner(`SELECT jp.id FROM job_position jp JOIN tenant t ON t.id = jp.tenant_id WHERE t.code = 'KAS' AND jp.code = 'PEMANEN'`);
  await asUser('kas.hrmanager.bcpj', async db => {
    const base = [div, pos.id];
    await db.rejects(`INSERT INTO employee (employee_no, nik, full_name, gender, birth_date, org_unit_id, position_id, employment_type, join_date)
                      VALUES ('KAS-T0002', '12345', 'NIK Pendek', 'M', '1990-01-01', $1, $2, 'CONTRACT', '2024-01-01')`, base, /check constraint/);
    await db.rejects(`INSERT INTO employee (employee_no, nik, full_name, gender, birth_date, org_unit_id, position_id, employment_type, join_date)
                      VALUES ('KAS-T0003', '1401011203900002', 'Terlalu Muda', 'M', '2015-01-01', $1, $2, 'CONTRACT', '2024-01-01')`, base, /check constraint/);
    await db.rejects(`INSERT INTO employee (employee_no, nik, full_name, gender, birth_date, org_unit_id, position_id, employment_type, join_date)
                      VALUES ('KAS-T0004', '1401011203900003', 'Gender X', 'X', '1990-01-01', $1, $2, 'CONTRACT', '2024-01-01')`, base, /check constraint/);
  });
});

test('privilege escalation is blocked', async () => {
  const [{ id: doctorRole }] = await owner(`SELECT id FROM role WHERE code = 'DOCTOR' AND tenant_id IS NULL`);
  const [{ id: superRole }] = await owner(`SELECT id FROM role WHERE code = 'SUPER_ADMIN' AND tenant_id IS NULL`);
  const [nurse] = await owner(`SELECT id FROM app_user WHERE username = 'kas.nurse2.bcpj-ra-kln'`);
  const clinic = await unitId('BCPJ-RA-KLN');
  const otherPtClinic = await unitId('BCPA-RA-KLN');
  // Clinic Manager has no USER_ADMIN permission at all
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    await db.rejects(`INSERT INTO user_role_assignment (user_id, role_id, scope_unit_id) VALUES ($1, $2, $3)`, [nurse.id, doctorRole, clinic], /row-level security|cannot grant/);
  });
  await asUser('kas.ptadmin.bcpj', async db => {
    // PT Admin (USER_ADMIN:APPROVE within PT) may onboard a doctor inside the PT…
    const [ok] = await db.q(`INSERT INTO user_role_assignment (user_id, role_id, scope_unit_id) VALUES ($1, $2, $3) RETURNING id`, [nurse.id, doctorRole, clinic]);
    assert.ok(ok.id);
    // …but not in another PT
    await db.rejects(`INSERT INTO user_role_assignment (user_id, role_id, scope_unit_id) VALUES ($1, $2, $3)`, [nurse.id, doctorRole, otherPtClinic], /row-level security|cannot grant/);
    // …and cannot assign anything to themself
    await db.rejects(`INSERT INTO user_role_assignment (user_id, role_id, scope_unit_id) VALUES ($1, $2, $3)`, [db.userId, superRole, clinic], /own role/);
  });
  // HR Manager (USER_ADMIN none) cannot touch assignments; and roles are read-only for non-admins
  await asUser('kas.hrmanager.bcpj', async db => {
    const res = await db.q(`UPDATE role SET name = 'x' WHERE code = 'HR_MANAGER' RETURNING id`);
    assert.equal(res.length, 0, 'system roles cannot be modified through the API role');
  });
});

test('app.my_permissions() reflects the role matrix and scope', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const rows = await db.q('SELECT module, action, scope_unit_type, role_code FROM app.my_permissions()');
    const has = (m, a) => rows.some(r => r.module === m && r.action === a);
    assert.ok(has('EMR', 'CREATE') && has('INVENTORY', 'APPROVE') && has('CLINIC', 'UPDATE'));
    assert.ok(!has('EMR', 'DELETE'), 'nobody deletes medical records');
    assert.ok(!has('USER_ADMIN', 'CREATE'));
    assert.ok(rows.every(r => r.scope_unit_type === 'CLINIC'));
    assert.deepEqual([...new Set(rows.map(r => r.role_code))].sort(), ['CLINIC_MANAGER', 'DOCTOR']);
  });
});

test('users only see their own notifications', async () => {
  await asUser('kas.dr.bcpj-ra-kln', async db => {
    const others = await db.val('SELECT count(*)::int FROM notification WHERE recipient_id <> app.current_user_id()');
    assert.equal(others, 0);
    assert.ok(await db.val('SELECT count(*)::int FROM notification') > 0);
  });
});

test('global-search style query respects permissions automatically', async () => {
  // the same ILIKE query returns different results per user — no special code needed
  const sql = `SELECT (SELECT count(*) FROM patient WHERE full_name ILIKE '%a%')::int AS patients,
                      (SELECT count(*) FROM employee WHERE full_name ILIKE '%a%')::int AS employees,
                      -- employees visible WITHOUT a visible patient record or clinical MCU: must be 0 for clinicians
                      (SELECT count(*) FROM employee e WHERE NOT EXISTS (SELECT 1 FROM patient p WHERE p.employee_id = e.id)
                                                         AND NOT EXISTS (SELECT 1 FROM mcu m WHERE m.employee_id = e.id))::int AS unrelated_employees`;
  const doctor = await asUser('kas.dr.bcpj-ra-kln', db => db.one(sql));
  const hr = await asUser('kas.hrmanager.bcpj', db => db.one(sql));
  const corp = await asUser('kas.corporate', db => db.one(sql));
  assert.ok(doctor.patients > 0, 'doctor: patients');
  assert.equal(doctor.unrelated_employees, 0, 'doctor: only the worker master data of own patients, never the HR register');
  assert.ok(doctor.employees < hr.employees, 'doctor sees fewer employees than HR');
  assert.ok(hr.employees > 0 && hr.patients === 0, 'HR: employees, not patients');
  assert.ok(corp.patients === 0, 'management: no patient search');
});
