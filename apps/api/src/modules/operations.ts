// Occupational health (Phase 7), ambulance dispatch (Phase 8), dashboards & analytics (Phase 9),
// organisation tree, notifications, global search, QR codes.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import { authenticate, dateRange, db, parse, requirePerm, zDate, zUuid } from '../core/http.js';
import { badRequest, notFound } from '../core/errors.js';
import { currentStaff, employeeBrief } from './resources.hooks.js';

export default async function operationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ================================================================ ORGANISATION TREE
  app.get('/org/tree', async (req) => db(req, async (tx) => ({
    data: await tx.q(`SELECT u.id, u.parent_id, u.code, u.name, u.unit_type, u.status, u.depth, u.city,
                             (SELECT count(*) FROM employee e WHERE e.org_unit_id = u.id AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE') AS employees,
                             cp.operational_status
                        FROM org_unit u LEFT JOIN clinic_profile cp ON cp.id = u.id WHERE u.deleted_at IS NULL ORDER BY u.depth, u.unit_type, u.name`),
    types: await tx.q('SELECT * FROM org_unit_type ORDER BY sort_order'),
    rules: await tx.q('SELECT * FROM org_unit_type_rule'),
  })));

  // ================================================================ OCCUPATIONAL HEALTH
  app.get('/occ-health/compliance', async (req: FastifyRequest<{ Querystring: { unitId?: string; compliance?: string; risk?: string; fit?: string; q?: string } }>) =>
    db(req, async (tx) => {
      await requirePerm(tx, 'OCC_HEALTH', 'READ');
      const params: unknown[] = []; const w: string[] = [];
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      if (req.query.unitId) w.push(`u.path <@ (SELECT path FROM org_unit WHERE id = ${p(req.query.unitId)})`);
      if (req.query.compliance) w.push(`h.mcu_compliance = ${p(req.query.compliance)}`);
      if (req.query.risk) w.push(`h.risk_code = ${p(req.query.risk)}`);
      if (req.query.fit) w.push(`coalesce(h.fit_status, 'NOT_ASSESSED') = ${p(req.query.fit)}`);
      if (req.query.q) w.push(`(h.full_name ILIKE ${p('%' + req.query.q + '%')} OR h.employee_no ILIKE $${params.length})`);
      const rows = await tx.q(`SELECT h.*, u.name AS unit_name FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id
                                ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY CASE h.mcu_compliance WHEN 'OVERDUE' THEN 0 WHEN 'NEVER_EXAMINED' THEN 1 WHEN 'DUE_SOON' THEN 2 ELSE 3 END,
                                h.next_mcu_due NULLS FIRST LIMIT 2000`, params);
      return { data: rows };
    }));

  // EMPLOYEE → JOB → RISK → MEDICAL EXAMINATION → HEALTH STATUS for one employee
  app.get('/occ-health/employees/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      await requirePerm(tx, 'OCC_HEALTH', 'READ');
      // plain query under RLS: visible to HR (EMPLOYEE), and to clinicians/OH staff for workers whose patient or MCU records they can see
      const e = await tx.one(`SELECT e.id, e.employee_no, e.full_name, e.gender, e.birth_date, e.org_unit_id, u.name AS unit_name, e.position_id, jp.name AS position_name,
                                     e.risk_category_id, rc.name AS risk_name, e.estate_id
                                FROM employee e JOIN org_unit u ON u.id = e.org_unit_id LEFT JOIN job_position jp ON jp.id = e.position_id
                                LEFT JOIN risk_category rc ON rc.id = e.risk_category_id WHERE e.id = $1 AND e.deleted_at IS NULL`, [req.params.id]);
      if (!e) throw notFound('Karyawan');
      const risk = await tx.one('SELECT code, name, risk_level, hazards, mcu_interval_months, required_exams FROM risk_category WHERE id = $1', [e.risk_category_id]);
      const status = await tx.one('SELECT * FROM v_employee_health_status WHERE employee_id = $1', [e.id]);
      const mcu = await tx.q(`SELECT m.id, m.mcu_no, m.mcu_type, m.due_date, m.exam_date, m.status, m.fit_status, m.restrictions, m.valid_until, c.name AS clinic_name,
                                     (SELECT coalesce(jsonb_agg(jsonb_build_object('exam', f.exam_code, 'result', f.result, 'flag', f.flag, 'icd10', f.icd10_code) ORDER BY f.exam_code), '[]')
                                        FROM mcu_finding f WHERE f.mcu_id = m.id) AS findings
                                FROM mcu m JOIN org_unit c ON c.id = m.clinic_id WHERE m.employee_id = $1 AND m.deleted_at IS NULL ORDER BY coalesce(m.exam_date, m.due_date) DESC`, [e.id]);
      const assessments = await tx.q(`SELECT h.assessment_no, h.assessment_type, h.fit_status, h.restrictions, h.valid_from, h.valid_until, h.status, s.full_name AS assessor
                                        FROM health_assessment h JOIN medical_staff s ON s.id = h.assessed_by WHERE h.employee_id = $1 ORDER BY h.assessed_at DESC`, [e.id]);
      const accidents = await tx.q(`SELECT incident_no, occurred_at, severity, lost_time_days, status FROM accident WHERE employee_id = $1 AND deleted_at IS NULL ORDER BY occurred_at DESC`, [e.id]);
      return { employee: e, risk, status, mcu, assessments, accidents };
    }));

  // bulk scheduling of an MCU campaign (e.g. all overdue employees of an estate)
  app.post('/occ-health/mcu/schedule', async (req) => {
    const b = parse(z.object({ unitId: zUuid, clinicId: zUuid, mcuType: z.enum(['ANNUAL', 'PERIODIC', 'SPECIAL', 'PRE_EMPLOYMENT', 'POST_EMPLOYMENT']),
      scheduledDate: zDate, selection: z.enum(['OVERDUE', 'DUE_SOON', 'NEVER_EXAMINED', 'ALL_DUE', 'EMPLOYEES']), employeeIds: z.array(zUuid).optional(), riskCode: z.string().optional() }), req.body);
    return db(req, async (tx) => {
      await requirePerm(tx, 'OCC_HEALTH', 'CREATE', b.clinicId);
      const params: unknown[] = [b.unitId]; let filter = '';
      if (b.selection === 'EMPLOYEES') { params.push(b.employeeIds ?? []); filter = `AND h.employee_id = ANY($2::uuid[])`; }
      else if (b.selection === 'ALL_DUE') filter = `AND h.mcu_compliance IN ('OVERDUE','DUE_SOON','NEVER_EXAMINED')`;
      else { params.push(b.selection); filter = `AND h.mcu_compliance = $2`; }
      if (b.riskCode) { params.push(b.riskCode); filter += ` AND h.risk_code = $${params.length}`; }
      // read placement through the definer helper (works for clinicians without HR access)
      const candidates = await tx.q(`SELECT h.employee_id FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id
                                      WHERE u.path <@ (SELECT path FROM org_unit WHERE id = $1) ${filter}
                                        AND NOT EXISTS (SELECT 1 FROM mcu m WHERE m.employee_id = h.employee_id AND m.status IN ('PLANNED','SCHEDULED','IN_PROGRESS','AWAITING_RESULT'))`, params);
      const ids: string[] = candidates.map((c) => c.employee_id);
      if (b.selection === 'EMPLOYEES' && !ids.length && b.employeeIds?.length) ids.push(...b.employeeIds);
      let created = 0;
      for (const id of ids.slice(0, 500)) {
        const e = await employeeBrief(tx, id);
        const patientId = e.patient_id ?? await tx.val(`SELECT app.register_patient('EMPLOYEE', $1, $2)`, [e.id, b.clinicId]);
        await tx.q(`INSERT INTO mcu (mcu_no, clinic_id, employee_id, patient_id, employee_unit_id, position_id, risk_category_id, mcu_type, due_date, scheduled_date, status)
                    VALUES (app.next_document_no('MCU', $1), $2, $3, $4, $5, $6, $7, $8, $9, $9, 'SCHEDULED')`,
          [e.company_code, b.clinicId, e.id, patientId, e.org_unit_id, e.position_id, e.risk_category_id, b.mcuType, b.scheduledDate]);
        created++;
      }
      return { created, skipped: Math.max(0, ids.length - 500) };
    });
  });

  app.get('/occ-health/mcu/:id', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const m = await tx.one(`SELECT m.*, c.name AS clinic_name, e.full_name AS employee_name, e.employee_no, u.name AS unit_name, jp.name AS position_name,
                                     rc.name AS risk_name, rc.required_exams, rc.hazards
                                FROM mcu m JOIN org_unit c ON c.id = m.clinic_id JOIN employee e ON e.id = m.employee_id JOIN org_unit u ON u.id = m.employee_unit_id
                                LEFT JOIN job_position jp ON jp.id = m.position_id LEFT JOIN risk_category rc ON rc.id = m.risk_category_id WHERE m.id = $1`, [req.params.id]);
      if (!m) throw notFound('MCU');
      const findings = await tx.q(`SELECT f.*, coalesce(i.title_id, i.title_en) AS icd10_title FROM mcu_finding f LEFT JOIN icd10_code i ON i.code = f.icd10_code WHERE f.mcu_id = $1 ORDER BY f.exam_code`, [m.id]);
      const canSeeFindings = await tx.val<boolean>(`SELECT app.can('EMR', 'READ', $1)`, [m.clinic_id]);
      const transitions = await tx.q(`SELECT to_status, label, required_action FROM workflow_transition WHERE entity = 'mcu' AND from_status = $1`, [m.status]);
      return { mcu: m, findings, canSeeFindings, transitions };
    }));

  app.post('/occ-health/mcu/:id/complete', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({
      examDate: zDate, fitStatus: z.enum(['FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT']), restrictions: z.string().max(1000).optional(), validUntil: zDate.optional(),
      findings: z.array(z.object({ examCode: z.enum(['PHYSICAL', 'VISUS', 'COLOR_BLIND', 'AUDIOMETRY', 'SPIROMETRY', 'XRAY_THORAX', 'ECG', 'CHOLINESTERASE', 'HEMATOLOGY', 'LIVER_FUNCTION', 'KIDNEY_FUNCTION', 'BLOOD_GLUCOSE', 'LIPID_PROFILE', 'URINALYSIS', 'DRUG_SCREEN', 'MUSCULOSKELETAL', 'DERMATOLOGY', 'PSYCHOLOGY', 'OTHER']), result: z.string().min(1).max(500), flag: z.enum(['NORMAL', 'ABNORMAL', 'BORDERLINE', 'CRITICAL']),
        icd10Code: z.string().nullable().optional(), notes: z.string().max(500).optional() })).min(1),
    }), req.body);
    if (b.fitStatus === 'FIT_WITH_RESTRICTION' && !b.restrictions) throw badRequest('Pembatasan kerja wajib diisi');
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const m = await tx.one('SELECT * FROM mcu WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!m) throw notFound('MCU');
      for (const f of b.findings) {
        await tx.q(`INSERT INTO mcu_finding (mcu_id, exam_code, result, flag, icd10_code, notes) VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (mcu_id, exam_code) DO UPDATE SET result = EXCLUDED.result, flag = EXCLUDED.flag, icd10_code = EXCLUDED.icd10_code, notes = EXCLUDED.notes`,
          [m.id, f.examCode, f.result, f.flag, f.icd10Code || null, f.notes ?? null]);
      }
      if (['PLANNED', 'SCHEDULED'].includes(m.status)) await tx.q(`UPDATE mcu SET status = 'IN_PROGRESS' WHERE id = $1`, [m.id]);
      await tx.q(`UPDATE mcu SET status = 'COMPLETED', exam_date = $2, fit_status = $3, restrictions = $4, valid_until = $5, examiner_id = $6 WHERE id = $1`,
        [m.id, b.examDate, b.fitStatus, b.restrictions ?? null, b.validUntil ?? null, staff.id]);
      const done = await tx.one('SELECT * FROM mcu WHERE id = $1', [m.id]);
      await tx.q(`UPDATE health_assessment SET status = 'SUPERSEDED' WHERE employee_id = $1 AND status = 'ACTIVE'`, [m.employee_id]);
      await tx.q(`INSERT INTO health_assessment (assessment_no, clinic_id, employee_id, employee_unit_id, assessment_type, mcu_id, fit_status, restrictions, valid_from, valid_until, assessed_by)
                  VALUES (app.next_document_no('HA', $1), $2, $3, $4, 'MCU', $5, $6, $7, $8, $9, $10)`,
        [await tx.val('SELECT code FROM org_unit WHERE id = $1', [m.clinic_id]), m.clinic_id, m.employee_id, m.employee_unit_id, m.id, b.fitStatus, b.restrictions ?? null, b.examDate, done.valid_until, staff.id]);
      return { ok: true, nextDue: done.next_due_date };
    });
  });

  // ================================================================ AMBULANCE DISPATCH
  app.post('/ambulance/dispatch', async (req) => {
    const b = parse(z.object({ ambulanceId: zUuid, tripType: z.enum(['EMERGENCY', 'REFERRAL', 'INTER_CLINIC', 'RETURN', 'OTHER']), priority: z.enum(['NORMAL', 'URGENT', 'EMERGENCY']).default('NORMAL'),
      origin: z.string().min(2).max(200), destination: z.string().min(2).max(200), patientId: zUuid.optional(), accidentId: zUuid.optional(), referralId: zUuid.optional(),
      driverId: zUuid.optional(), notes: z.string().max(500).optional() }), req.body);
    return db(req, async (tx) => {
      const a = await tx.one('SELECT * FROM ambulance WHERE id = $1 FOR UPDATE', [b.ambulanceId]);
      if (!a) throw notFound('Ambulans');
      if (a.status !== 'AVAILABLE') throw badRequest(`Ambulans berstatus ${a.status} — pilih unit lain`);
      const driver = b.driverId ?? await tx.val(`SELECT id FROM medical_staff WHERE home_clinic_id = $1 AND staff_type = 'AMBULANCE_DRIVER' AND status = 'ACTIVE' LIMIT 1`, [a.clinic_id]);
      const id = await tx.val(`INSERT INTO ambulance_trip (trip_no, ambulance_id, clinic_id, driver_id, trip_type, priority, patient_id, accident_id, referral_id, origin, destination, odometer_start, notes)
                               VALUES (app.next_document_no('TRIP', (SELECT code FROM org_unit WHERE id = $1)), $2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [a.clinic_id, a.id, driver ?? null, b.tripType, b.priority, b.patientId ?? null, b.accidentId ?? null, b.referralId ?? null, b.origin, b.destination, a.odometer_km, b.notes ?? null]);
      await tx.q(`UPDATE ambulance SET status = 'ON_TRIP' WHERE id = $1`, [a.id]);
      if (b.priority === 'EMERGENCY') {
        const driverUser = driver ? await tx.val('SELECT user_id FROM medical_staff WHERE id = $1', [driver]) : null;
        if (driverUser) await tx.q(`INSERT INTO notification (recipient_id, category, severity, title, body, entity_type, entity_id, action_url)
                                    VALUES ($1, 'EMERGENCY', 'CRITICAL', 'DISPATCH DARURAT', $2, 'ambulance_trip', $3, '/ambulance')`, [driverUser, `${b.origin} → ${b.destination}`, id]);
      }
      return { id };
    });
  });

  // ================================================================ DASHBOARD & ANALYTICS
  const scopeQ = z.object({ unitId: zUuid, from: zDate.optional(), to: zDate.optional() });
  app.get('/dashboard/summary', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ, req.query); const r = dateRange(q);
    return db(req, async (tx) => ({ data: await tx.val('SELECT analytics.kpi_summary($1, $2, $3)', [q.unitId, r.from, r.to]) }));
  });
  app.get('/dashboard/trend', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ.extend({ metric: z.string().regex(/^(visits|accidents|referrals|sick_leave_days|medical_cost|medicine_cost|disease:[A-Z0-9.]+)$/), bucket: z.enum(['day', 'week', 'month']).default('week') }), req.query);
    const r = dateRange(q, 90);
    return db(req, async (tx) => ({ data: await tx.q('SELECT * FROM analytics.trend($1, $2, $3, $4, $5)', [q.unitId, r.from, r.to, q.metric, q.bucket]) }));
  });
  app.get('/dashboard/top-diseases', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ.extend({ limit: z.coerce.number().int().min(1).max(50).default(10), risk: z.string().optional() }), req.query); const r = dateRange(q);
    return db(req, async (tx) => ({ data: await tx.q('SELECT * FROM analytics.top_diseases($1, $2, $3, $4, $5)', [q.unitId, r.from, r.to, q.limit, q.risk ?? null]) }));
  });
  app.get('/dashboard/drilldown', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ, req.query); const r = dateRange(q);
    return db(req, async (tx) => ({ data: (await tx.q('SELECT * FROM analytics.drilldown($1, $2, $3) AS d', [q.unitId, r.from, r.to])).map((x) => x.d) }));
  });
  app.get('/dashboard/clinic-performance', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ, req.query); const r = dateRange(q);
    return db(req, async (tx) => ({ data: await tx.q('SELECT * FROM analytics.clinic_performance($1, $2, $3)', [q.unitId, r.from, r.to]) }));
  });
  app.get('/dashboard/accidents', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ, req.query); const r = dateRange(q, 180);
    return db(req, async (tx) => ({ data: await tx.val('SELECT analytics.accident_stats($1, $2, $3)', [q.unitId, r.from, r.to]) }));
  });
  app.get('/dashboard/occupational', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ, req.query);
    return db(req, async (tx) => ({ data: await tx.val('SELECT analytics.occupational_health($1)', [q.unitId]) }));
  });
  app.get('/dashboard/medicine', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ.extend({ limit: z.coerce.number().int().min(1).max(100).default(15) }), req.query); const r = dateRange(q);
    return db(req, async (tx) => ({ data: await tx.q('SELECT * FROM analytics.medicine_consumption($1, $2, $3, $4)', [q.unitId, r.from, r.to, q.limit]) }));
  });
  app.get('/dashboard/clinic-today', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(z.object({ clinicId: zUuid }), req.query);
    return db(req, async (tx) => ({ data: await tx.val('SELECT analytics.clinic_today($1)', [q.clinicId]) }));
  });
  app.get('/finance/costs', async (req: FastifyRequest<{ Querystring: any }>) => {
    const q = parse(scopeQ.extend({ dimension: z.enum(['category', 'company', 'estate', 'clinic', 'disease', 'employee', 'payer', 'month']).default('category'),
      limit: z.coerce.number().int().min(1).max(200).default(20) }), req.query);
    const r = dateRange(q, 180);
    return db(req, async (tx) => ({ data: await tx.q('SELECT * FROM analytics.cost_breakdown($1, $2, $3, $4, $5)', [q.unitId, r.from, r.to, q.dimension, q.limit]) }));
  });

  // ================================================================ NOTIFICATIONS
  app.get('/notifications', async (req: FastifyRequest<{ Querystring: { unread?: string; limit?: string } }>) =>
    db(req, async (tx) => ({
      data: await tx.q(`SELECT id, category, severity, title, body, entity_type, entity_id, action_url, read_at, created_at FROM notification
                         WHERE recipient_id = app.current_user_id() ${req.query.unread === '1' ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT $1`, [Math.min(200, Number(req.query.limit) || 50)]),
      unread: await tx.val('SELECT count(*)::int FROM notification WHERE recipient_id = app.current_user_id() AND read_at IS NULL'),
    })));
  app.post('/notifications/:id/read', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => { await tx.q('UPDATE notification SET read_at = now() WHERE id = $1 AND read_at IS NULL', [req.params.id]); return { ok: true }; }));
  app.post('/notifications/read-all', async (req) =>
    db(req, async (tx) => ({ updated: (await tx.q('UPDATE notification SET read_at = now() WHERE recipient_id = app.current_user_id() AND read_at IS NULL RETURNING id')).length })));

  // ================================================================ GLOBAL SEARCH (every section runs under RLS)
  app.get('/search', async (req: FastifyRequest<{ Querystring: { q?: string } }>) => {
    const term = String(req.query.q ?? '').trim();
    if (term.length < 2) return { data: [] };
    return db(req, async (tx) => {
      const like = `%${term}%`;
      const perms = await tx.q<{ module: string }>(`SELECT DISTINCT module FROM app.my_permissions() WHERE action = 'READ'`);
      const has = (m: string) => perms.some((p) => p.module === m);
      const sections: { type: string; label: string; sql: string; module: string }[] = [
        { type: 'patient', label: 'Pasien', module: 'PATIENT', sql: `SELECT p.id, p.full_name AS title, p.mrn || ' · ' || p.patient_type || ' · ' || c.name AS subtitle, '/patients/' || p.id AS url FROM patient p JOIN org_unit c ON c.id = p.primary_clinic_id WHERE p.deleted_at IS NULL AND (p.full_name ILIKE $1 OR p.mrn ILIKE $1 OR p.nik = $2 OR p.phone ILIKE $1) LIMIT 8` },
        { type: 'employee', label: 'Karyawan', module: 'EMPLOYEE', sql: `SELECT e.id, e.full_name AS title, e.employee_no || ' · ' || u.name AS subtitle, '/r/employees?id=' || e.id AS url FROM employee e JOIN org_unit u ON u.id = e.org_unit_id WHERE e.deleted_at IS NULL AND (e.full_name ILIKE $1 OR e.employee_no ILIKE $1 OR e.nik = $2) LIMIT 8` },
        { type: 'encounter', label: 'Rekam Medis', module: 'EMR', sql: `SELECT e.id, e.encounter_no AS title, p.full_name || ' · ' || to_char(e.started_at, 'DD Mon YYYY') AS subtitle, '/emr/' || e.id AS url FROM encounter e LEFT JOIN patient p ON p.id = e.patient_id WHERE e.encounter_no ILIKE $1 LIMIT 5` },
        { type: 'unit', label: 'Klinik & Unit', module: 'ORGANIZATION', sql: `SELECT u.id, u.name AS title, u.unit_type || ' · ' || u.code AS subtitle, CASE WHEN u.unit_type = 'CLINIC' THEN '/dashboard?unitId=' || u.id ELSE '/org?focus=' || u.id END AS url FROM org_unit u WHERE u.deleted_at IS NULL AND (u.name ILIKE $1 OR u.code ILIKE $1) LIMIT 8` },
        { type: 'medicine', label: 'Obat', module: 'MASTER_DATA', sql: `SELECT m.id, m.name AS title, m.code || ' · ' || m.generic_name AS subtitle, '/pharmacy/stock?q=' || m.code AS url FROM medicine m WHERE m.deleted_at IS NULL AND (m.name ILIKE $1 OR m.generic_name ILIKE $1 OR m.code ILIKE $1) LIMIT 6` },
        { type: 'referral', label: 'Rujukan', module: 'REFERRAL', sql: `SELECT r.id, r.referral_no AS title, p.full_name || ' → ' || h.name AS subtitle, '/r/referrals?id=' || r.id AS url FROM referral r LEFT JOIN patient p ON p.id = r.patient_id JOIN hospital h ON h.id = r.hospital_id WHERE r.referral_no ILIKE $1 OR p.full_name ILIKE $1 LIMIT 5` },
        { type: 'accident', label: 'Kecelakaan', module: 'ACCIDENT', sql: `SELECT a.id, a.incident_no AS title, a.victim_name || ' · ' || a.severity AS subtitle, '/r/accidents?id=' || a.id AS url FROM accident a WHERE a.deleted_at IS NULL AND (a.incident_no ILIKE $1 OR a.victim_name ILIKE $1) LIMIT 5` },
      ];
      const out: any[] = [];
      for (const s of sections) {
        if (s.module !== 'ORGANIZATION' && s.module !== 'MASTER_DATA' && !has(s.module)) continue;
        const rows = await tx.q(s.sql, s.sql.includes('$2') ? [like, term.replace(/\D/g, '') || '-'] : [like]);
        if (rows.length) out.push({ type: s.type, label: s.label, items: rows });
      }
      const reports = (await import('./reports.js')).REPORTS.filter((r) => r.title.toLowerCase().includes(term.toLowerCase()));
      if (reports.length) out.push({ type: 'report', label: 'Laporan', items: reports.map((r) => ({ id: r.code, title: r.title, subtitle: r.description, url: `/reports?code=${r.code}` })) });
      return { data: out };
    });
  });

  // ================================================================ QR CODES
  const QR_TABLE: Record<string, { table: string; label: string; module: string }> = {
    employee: { table: 'employee', label: 'full_name', module: 'EMPLOYEE' }, patient: { table: 'patient', label: 'full_name', module: 'PATIENT' },
    medicine: { table: 'medicine', label: 'name', module: 'MASTER_DATA' }, asset: { table: 'clinic_asset', label: 'name', module: 'CLINIC' },
    ambulance: { table: 'ambulance', label: 'code', module: 'AMBULANCE' },
  };
  app.get('/qr/:kind/:id.png', async (req: FastifyRequest<{ Params: { kind: string; id: string } }>, reply) => {
    const k = QR_TABLE[req.params.kind];
    if (!k) throw notFound('Jenis QR');
    const token = await db(req, (tx) => tx.val<string>(`SELECT qr_token FROM ${k.table} WHERE id = $1`, [req.params.id]));
    if (!token) throw notFound();
    const png = await QRCode.toBuffer(`PCMS:${req.params.kind.toUpperCase()}:${token}`, { margin: 1, width: 320, color: { dark: '#0F3D2E' } });
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=300');
    return reply.send(png);
  });
  app.get('/qr/resolve', async (req: FastifyRequest<{ Querystring: { code: string } }>) => {
    const m = String(req.query.code ?? '').match(/^(?:PCMS:([A-Z]+):)?([0-9a-f]{32})$/i);
    if (!m) throw badRequest('Kode QR tidak dikenali');
    const token = m[2].toLowerCase();
    return db(req, async (tx) => {
      for (const [kind, k] of Object.entries(QR_TABLE)) {
        if (m[1] && m[1].toLowerCase() !== kind) continue;
        const row = await tx.one(`SELECT id, ${k.label} AS label FROM ${k.table} WHERE qr_token = $1`, [token]).catch(() => null);
        if (row) {
          await tx.q(`SELECT app.log_access('VIEW', $1, $2, $3, 'qr scan')`, [k.table, row.id, k.module]);
          return { kind, id: row.id, label: row.label };
        }
      }
      // employees may be resolved for registration by clinicians without HR access
      const lookup = await tx.q('SELECT * FROM app.patient_lookup($1, 1)', [token]).catch(() => []);
      if (lookup.length) return { kind: lookup[0].kind.toLowerCase(), id: lookup[0].patient_id ?? lookup[0].employee_id, label: lookup[0].full_name, lookup: lookup[0] };
      throw notFound('Data untuk kode QR ini');
    });
  });
}
