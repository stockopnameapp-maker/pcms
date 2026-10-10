// Registration & queue (Phase 4), EMR (Phase 5), laboratory and referrals from the EMR.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, db, parse, requirePerm, zDate, zUuid } from '../core/http.js';
import { badRequest, notFound } from '../core/errors.js';
import type { Tx } from '../core/db.js';
import { decryptField, encryptField } from '../core/security.js';
import { today } from '../core/time.js';
import { currentStaff, employeeBrief } from './resources.hooks.js';

const PREFIX: Record<string, string> = { NORMAL: 'A', PRIORITY: 'P', EMERGENCY: 'E' };

async function clinicCode(tx: Tx, clinicId: string) {
  const c = await tx.val<string>('SELECT code FROM org_unit WHERE id = $1 AND unit_type = $2', [clinicId, 'CLINIC']);
  if (!c) throw notFound('Klinik');
  return c;
}

async function loadEncounter(tx: Tx, id: string) {
  const e = await tx.one(`SELECT e.*, c.name AS clinic_name, d.full_name AS doctor_name, n.full_name AS nurse_name, sb.full_name AS signed_by_name
                            FROM encounter e JOIN org_unit c ON c.id = e.clinic_id LEFT JOIN medical_staff d ON d.id = e.doctor_id
                            LEFT JOIN medical_staff n ON n.id = e.nurse_id LEFT JOIN medical_staff sb ON sb.id = e.signed_by WHERE e.id = $1`, [id]);
  if (!e) throw notFound('Rekam medis');
  e.doctor_notes = decryptField(e.doctor_notes);
  return e;
}

export default async function clinicalRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ================================================================ PATIENT LOOKUP & REGISTRATION
  app.get('/patients/lookup', async (req: FastifyRequest<{ Querystring: { q?: string } }>) =>
    db(req, async (tx) => { await requirePerm(tx, 'PATIENT', 'READ'); return { data: await tx.q('SELECT * FROM app.patient_lookup($1, 25)', [req.query.q ?? '']) }; }));

  app.post('/patients/register', async (req) => {
    const b = parse(z.object({ kind: z.enum(['EMPLOYEE', 'FAMILY']), refId: zUuid, clinicId: zUuid }), req.body);
    return db(req, async (tx) => ({ patientId: await tx.val('SELECT app.register_patient($1, $2, $3)', [b.kind, b.refId, b.clinicId]) }));
  });

  // ================================================================ QUEUE
  app.get('/queue/board', async (req: FastifyRequest<{ Querystring: { clinicId: string; date?: string } }>) => {
    const clinicId = parse(zUuid, req.query.clinicId);
    const date = req.query.date ? parse(zDate, req.query.date) : today();
    return db(req, async (tx) => {
      await requirePerm(tx, 'QUEUE', 'READ', clinicId);
      const tickets = await tx.q(`
        SELECT q.id, q.queue_code, q.queue_no, q.priority, q.triage_level, q.status, q.source, q.registered_at, q.triage_at, q.consult_start_at, q.consult_end_at,
               q.pharmacy_at, q.completed_at, q.patient_id, p.full_name AS patient_name, p.mrn, p.gender, date_part('year', age(p.birth_date))::int AS age,
               p.patient_type, s.full_name AS doctor_name, e.id AS encounter_id, e.status AS encounter_status, coalesce(e.chief_complaint, q.complaint) AS chief_complaint,
               (SELECT rx.id FROM prescription rx WHERE rx.encounter_id = e.id ORDER BY rx.prescribed_at DESC LIMIT 1) AS prescription_id,
               (SELECT count(*) FROM patient_allergy a WHERE a.patient_id = p.id AND a.status = 'ACTIVE' AND a.deleted_at IS NULL) AS allergies,
               round(extract(epoch FROM (coalesce(q.consult_start_at, CASE WHEN q.status IN ('COMPLETED','CANCELLED') THEN q.completed_at END, now()) - q.registered_at)) / 60) AS wait_min
          FROM queue_ticket q JOIN patient p ON p.id = q.patient_id LEFT JOIN medical_staff s ON s.id = q.assigned_staff_id
          LEFT JOIN encounter e ON e.queue_ticket_id = q.id
         WHERE q.clinic_id = $1 AND q.visit_date = $2::date AND q.deleted_at IS NULL
         ORDER BY CASE q.status WHEN 'IN_CONSULTATION' THEN 0 WHEN 'TRIAGE' THEN 1 WHEN 'WAITING_DOCTOR' THEN 2 WHEN 'WAITING' THEN 3 WHEN 'PHARMACY' THEN 4 ELSE 9 END,
                  CASE q.priority WHEN 'EMERGENCY' THEN 0 WHEN 'PRIORITY' THEN 1 ELSE 2 END, q.registered_at`, [clinicId, date]);
      const counts: Record<string, number> = {};
      for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1;
      const transitions = await tx.q(`SELECT from_status, to_status, label FROM workflow_transition WHERE entity = 'queue_ticket'`);
      return { date, tickets, counts, transitions };
    });
  });

  app.post('/queue/register', async (req) => {
    const b = parse(z.object({
      clinicId: zUuid, patientId: zUuid.optional(), kind: z.enum(['EMPLOYEE', 'FAMILY']).optional(), refId: zUuid.optional(),
      priority: z.enum(['NORMAL', 'PRIORITY', 'EMERGENCY']).default('NORMAL'),
      source: z.enum(['WALK_IN', 'APPOINTMENT', 'ACCIDENT', 'REFERRAL_RETURN', 'MCU', 'FOLLOW_UP']).default('WALK_IN'),
      appointmentId: zUuid.optional(), complaint: z.string().max(500).optional(),
    }).refine((v) => v.patientId || (v.kind && v.refId), 'pilih pasien atau karyawan/keluarga'), req.body);
    return db(req, async (tx) => {
      await requirePerm(tx, 'QUEUE', 'CREATE', b.clinicId);
      const status = await tx.val('SELECT operational_status FROM clinic_profile WHERE id = $1', [b.clinicId]);
      if (status === 'CLOSED') throw badRequest('Klinik sedang tutup');
      if (status === 'EMERGENCY_ONLY' && b.priority !== 'EMERGENCY') throw badRequest('Klinik hanya melayani kasus gawat darurat saat ini');
      const patientId = b.patientId ?? await tx.val('SELECT app.register_patient($1, $2, $3)', [b.kind, b.refId, b.clinicId]);
      const date = today();
      const dup = await tx.val(`SELECT queue_code FROM queue_ticket WHERE clinic_id = $1 AND patient_id = $2 AND visit_date = $3 AND status NOT IN ('COMPLETED','CANCELLED')`, [b.clinicId, patientId, date]);
      if (dup) throw badRequest(`Pasien sudah berada di antrian (${dup})`);
      // serialise numbering per clinic & day
      await tx.q('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue:${b.clinicId}:${date}`]);
      const next = await tx.one(`SELECT coalesce(max(queue_no), 0) + 1 AS no,
                                        count(*) FILTER (WHERE priority = $3) + 1 AS pno FROM queue_ticket WHERE clinic_id = $1 AND visit_date = $2`, [b.clinicId, date, b.priority]);
      const code = `${PREFIX[b.priority]}-${String(next.pno).padStart(3, '0')}`;
      const t = await tx.one(`INSERT INTO queue_ticket (clinic_id, patient_id, appointment_id, visit_date, queue_no, queue_code, source, priority, triage_level, complaint)
                              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, queue_code`,
        [b.clinicId, patientId, b.appointmentId ?? null, date, next.no, code, b.source, b.priority, b.priority === 'EMERGENCY' ? 'RED' : null, b.complaint?.trim() || null]);
      if (b.appointmentId) await tx.q(`UPDATE appointment SET status = 'CHECKED_IN' WHERE id = $1 AND status IN ('BOOKED','CONFIRMED')`, [b.appointmentId]);
      return { ticketId: t!.id, queueCode: t!.queue_code, patientId };
    });
  });

  app.post('/queue/:id/transition', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ to: z.enum(['TRIAGE', 'WAITING_DOCTOR', 'IN_CONSULTATION', 'PHARMACY', 'COMPLETED', 'CANCELLED']), reason: z.string().max(300).optional(),
      triageLevel: z.enum(['RED', 'YELLOW', 'GREEN', 'BLACK']).optional() }), req.body);
    return db(req, async (tx) => {
      const t = await tx.one('SELECT * FROM queue_ticket WHERE id = $1', [req.params.id]);
      if (!t) throw notFound('Antrian');
      const now = new Date().toISOString();
      const stamp: Record<string, string> = { TRIAGE: 'triage_at', IN_CONSULTATION: 'consult_start_at', PHARMACY: 'pharmacy_at', COMPLETED: 'completed_at', CANCELLED: 'cancelled_at' };
      const sets = ['status = $1'], params: unknown[] = [b.to];
      if (stamp[b.to]) { params.push(now); sets.push(`${stamp[b.to]} = $${params.length}`); }
      if ((b.to === 'PHARMACY' || b.to === 'COMPLETED') && !t.consult_end_at && t.consult_start_at) { params.push(now); sets.push(`consult_end_at = $${params.length}`); }
      if (b.to === 'CANCELLED') { params.push(b.reason ?? 'Dibatalkan petugas'); sets.push(`cancel_reason = $${params.length}`); }
      if (b.triageLevel) { params.push(b.triageLevel); sets.push(`triage_level = $${params.length}`); }
      let encounterId: string | undefined;
      if (b.to === 'IN_CONSULTATION') {
        const staff = await currentStaff(tx, ['DOCTOR']);
        params.push(staff.id); sets.push(`assigned_staff_id = $${params.length}`);
        encounterId = await tx.val('SELECT id FROM encounter WHERE queue_ticket_id = $1', [t.id]);
        if (!encounterId) {
          encounterId = await tx.val(`INSERT INTO encounter (encounter_no, clinic_id, patient_id, queue_ticket_id, doctor_id, encounter_type, started_at, chief_complaint)
                                      VALUES (app.next_document_no('ENC', $1, 'YYYYMM'), $2, $3, $4, $5, $6, now(), $7) RETURNING id`,
            [await clinicCode(tx, t.clinic_id), t.clinic_id, t.patient_id, t.id, staff.id, t.priority === 'EMERGENCY' ? 'EMERGENCY' : t.source === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'OUTPATIENT', t.complaint ?? null]);
        } else {
          await tx.q('UPDATE encounter SET doctor_id = coalesce(doctor_id, $2) WHERE id = $1', [encounterId, staff.id]);
        }
      }
      params.push(req.params.id);
      await tx.q(`UPDATE queue_ticket SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      return { ok: true, encounterId };
    });
  });

  // Triage at the nurse station: create the encounter early so vitals can be recorded before the doctor.
  app.post('/queue/:id/triage', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({
      chiefComplaint: z.string().min(2).max(500), triageLevel: z.enum(['RED', 'YELLOW', 'GREEN', 'BLACK']),
      vitals: z.object({
        systolic: z.number().int().min(40).max(300).optional(), diastolic: z.number().int().min(20).max(200).optional(), heart_rate: z.number().int().min(20).max(250).optional(),
        respiratory_rate: z.number().int().min(4).max(80).optional(), temperature_c: z.number().min(30).max(45).optional(), spo2: z.number().int().min(50).max(100).optional(),
        weight_kg: z.number().min(1).max(350).optional(), height_cm: z.number().min(30).max(250).optional(), blood_glucose: z.number().int().min(10).max(900).optional(),
        pain_score: z.number().int().min(0).max(10).optional(), gcs: z.number().int().min(3).max(15).optional(),
      }),
    }), req.body);
    return db(req, async (tx) => {
      const t = await tx.one('SELECT * FROM queue_ticket WHERE id = $1', [req.params.id]);
      if (!t) throw notFound('Antrian');
      const staff = await currentStaff(tx, ['NURSE', 'MIDWIFE', 'DOCTOR', 'PARAMEDIC']);
      let encId = await tx.val('SELECT id FROM encounter WHERE queue_ticket_id = $1', [t.id]);
      if (!encId) {
        encId = await tx.val(`INSERT INTO encounter (encounter_no, clinic_id, patient_id, queue_ticket_id, nurse_id, encounter_type, chief_complaint)
                              VALUES (app.next_document_no('ENC', $1, 'YYYYMM'), $2, $3, $4, $5, $6, $7) RETURNING id`,
          [await clinicCode(tx, t.clinic_id), t.clinic_id, t.patient_id, t.id, staff.id, t.priority === 'EMERGENCY' ? 'EMERGENCY' : 'OUTPATIENT', b.chiefComplaint]);
      } else {
        await tx.q('UPDATE encounter SET chief_complaint = $2, nurse_id = $3 WHERE id = $1', [encId, b.chiefComplaint, staff.id]);
      }
      const v = b.vitals; const keys = Object.keys(v);
      if (keys.length) {
        await tx.q(`INSERT INTO vital_sign (encounter_id, recorded_by, ${keys.join(', ')}) VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')})`,
          [encId, staff.id, ...keys.map((k) => (v as any)[k])]);
      }
      const sets = [`triage_level = $2`];
      if (t.status === 'WAITING') await tx.q(`UPDATE queue_ticket SET status = 'TRIAGE', triage_at = now() WHERE id = $1`, [t.id]);
      await tx.q(`UPDATE queue_ticket SET ${sets.join(', ')}, status = 'WAITING_DOCTOR' WHERE id = $1`, [t.id, b.triageLevel]);
      return { encounterId: encId };
    });
  });

  // ================================================================ EMR
  app.get('/emr/encounters/:id', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    parse(zUuid, req.params.id);
    return db(req, async (tx) => {
      await requirePerm(tx, 'EMR', 'READ');
      const e = await loadEncounter(tx, req.params.id);
      await tx.q(`SELECT app.log_access('VIEW', 'encounter', $1, 'EMR')`, [e.id]);
      const [patient, allergies, history, vitals, diagnoses, procedures, prescriptions, labs, referrals, sickLeaves, certificates, addenda, transitions, canEdit] = await Promise.all([
        tx.one(`SELECT p.id, p.mrn, p.full_name, p.gender, p.birth_date, date_part('year', age(p.birth_date))::int AS age, p.patient_type, p.blood_type, p.phone, p.payer_type,
                       p.employee_id, e.employee_no, jp.name AS position_name, rc.name AS risk_name, u.name AS unit_name
                  FROM patient p LEFT JOIN employee e ON e.id = p.employee_id LEFT JOIN job_position jp ON jp.id = e.position_id
                  LEFT JOIN risk_category rc ON rc.id = e.risk_category_id LEFT JOIN org_unit u ON u.id = e.org_unit_id WHERE p.id = $1`, [e.patient_id]),
        tx.q(`SELECT id, allergen_type, allergen, reaction, severity, medicine_id FROM patient_allergy WHERE patient_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`, [e.patient_id]),
        tx.q(`SELECT id, history_type, icd10_code, description, onset_date FROM patient_history WHERE patient_id = $1 AND is_active AND deleted_at IS NULL`, [e.patient_id]),
        tx.q(`SELECT v.*, s.full_name AS recorded_by_name FROM vital_sign v LEFT JOIN medical_staff s ON s.id = v.recorded_by WHERE v.encounter_id = $1 AND v.deleted_at IS NULL ORDER BY v.recorded_at DESC`, [e.id]),
        tx.q(`SELECT d.id, d.icd10_code, coalesce(i.title_id, i.title_en) AS title, d.diagnosis_type, d.certainty, d.is_occupational, d.notes
                FROM diagnosis d JOIN icd10_code i ON i.code = d.icd10_code WHERE d.encounter_id = $1 AND d.deleted_at IS NULL ORDER BY d.diagnosis_type, d.created_at`, [e.id]),
        tx.q(`SELECT pr.*, s.full_name AS performed_by_name FROM encounter_procedure pr LEFT JOIN medical_staff s ON s.id = pr.performed_by WHERE pr.encounter_id = $1 AND pr.deleted_at IS NULL`, [e.id]),
        tx.q(`SELECT rx.id, rx.prescription_no, rx.status, rx.prescribed_at, rx.dispensed_at,
                     coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'medicine_id', i.medicine_id, 'medicine', m.name, 'unit', m.unit, 'qty', i.qty, 'dose', i.dose, 'frequency', i.frequency,
                       'route', i.route, 'duration_days', i.duration_days, 'instructions', i.instructions, 'dispensed_qty', i.dispensed_qty) ORDER BY m.name) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
                FROM prescription rx LEFT JOIN prescription_item i ON i.prescription_id = rx.id AND i.deleted_at IS NULL LEFT JOIN medicine m ON m.id = i.medicine_id
               WHERE rx.encounter_id = $1 GROUP BY rx.id ORDER BY rx.prescribed_at`, [e.id]),
        tx.q(`SELECT l.id, l.order_no, l.status, l.priority, l.ordered_at,
                     coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'test', t.name, 'code', t.code, 'value_numeric', r.value_numeric, 'value_text', r.value_text, 'unit', r.unit,
                       'ref_range', r.ref_range, 'flag', r.flag, 'verified_at', r.verified_at) ORDER BY t.code) FILTER (WHERE r.id IS NOT NULL), '[]') AS results
                FROM lab_order l LEFT JOIN lab_result r ON r.lab_order_id = l.id LEFT JOIN lab_test t ON t.id = r.lab_test_id
               WHERE l.encounter_id = $1 GROUP BY l.id ORDER BY l.ordered_at`, [e.id]),
        tx.q(`SELECT r.id, r.referral_no, r.status, r.urgency, h.name AS hospital_name, r.reason FROM referral r JOIN hospital h ON h.id = r.hospital_id WHERE r.encounter_id = $1`, [e.id]),
        tx.q(`SELECT id, certificate_no, leave_type, start_date, end_date, days, status FROM sick_leave WHERE encounter_id = $1 AND deleted_at IS NULL`, [e.id]),
        tx.q(`SELECT id, certificate_no, certificate_type, fit_status, valid_until, status, verification_code FROM medical_certificate WHERE encounter_id = $1`, [e.id]),
        tx.q(`SELECT a.*, s.full_name AS author_name FROM encounter_addendum a JOIN medical_staff s ON s.id = a.author_id WHERE a.encounter_id = $1 ORDER BY a.created_at`, [e.id]),
        tx.q(`SELECT to_status, label FROM workflow_transition WHERE entity = 'encounter' AND from_status = $1`, [e.status]),
        tx.val<boolean>(`SELECT app.can('EMR', 'UPDATE', $1)`, [e.clinic_id]),
      ]);
      return { encounter: e, patient, allergies, history, vitals, diagnoses, procedures, prescriptions, labs, referrals, sickLeaves, certificates, addenda, transitions, canEdit };
    });
  });

  app.post('/emr/encounters', async (req) => {
    const b = parse(z.object({ patientId: zUuid, clinicId: zUuid, encounterType: z.enum(['OUTPATIENT', 'EMERGENCY', 'FOLLOW_UP', 'HOME_VISIT', 'TELECONSULT', 'MCU']).default('OUTPATIENT'),
      chiefComplaint: z.string().max(500).optional(), accidentId: zUuid.optional() }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR', 'NURSE', 'MIDWIFE', 'PARAMEDIC']);
      const id = await tx.val(`INSERT INTO encounter (encounter_no, clinic_id, patient_id, doctor_id, nurse_id, encounter_type, chief_complaint, accident_id, is_work_related)
                               VALUES (app.next_document_no('ENC', $1, 'YYYYMM'), $2, $3, $4, $5, $6, $7, $8, $8 IS NOT NULL) RETURNING id`,
        [await clinicCode(tx, b.clinicId), b.clinicId, b.patientId, staff.staff_type === 'DOCTOR' ? staff.id : null, staff.staff_type !== 'DOCTOR' ? staff.id : null,
          b.encounterType, b.chiefComplaint ?? null, b.accidentId ?? null]);
      if (b.accidentId) await tx.q('UPDATE accident SET encounter_id = $2 WHERE id = $1 AND encounter_id IS NULL', [b.accidentId, id]);
      return { id };
    });
  });

  app.patch('/emr/encounters/:id', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({
      chief_complaint: z.string().max(2000).nullable().optional(), history_of_present_illness: z.string().max(8000).nullable().optional(),
      physical_exam: z.string().max(8000).nullable().optional(), assessment: z.string().max(8000).nullable().optional(), plan: z.string().max(8000).nullable().optional(),
      doctor_notes: z.string().max(8000).nullable().optional(), disposition: z.enum(['HOME', 'REST', 'REFERRED', 'ADMITTED', 'RETURN_TO_WORK', 'DECEASED', 'LEFT_AGAINST_ADVICE']).nullable().optional(),
      follow_up_date: zDate.nullable().optional(), is_work_related: z.boolean().optional(), version: z.number().int().optional(),
    }).strict(), req.body);
    const { version, ...fields } = b;
    if ('doctor_notes' in fields) fields.doctor_notes = encryptField(fields.doctor_notes ?? null);   // confidential: encrypted at rest
    const keys = Object.keys(fields);
    if (!keys.length) throw badRequest('Tidak ada perubahan');
    return db(req, async (tx) => {
      const params: unknown[] = [...keys.map((k) => (fields as any)[k]), req.params.id];
      let sql = `UPDATE encounter SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${params.length}`;
      if (version) { params.push(version); sql += ` AND version = $${params.length}`; }
      const r = await tx.q(sql + ' RETURNING version', params);
      if (!r.length) throw badRequest('Rekam medis tidak dapat diubah (sudah berubah oleh pengguna lain atau di luar izin Anda)');
      return { version: r[0].version };
    });
  });

  app.post('/emr/encounters/:id/vitals', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const v = parse(z.object({
      systolic: z.number().int().min(40).max(300).optional(), diastolic: z.number().int().min(20).max(200).optional(), heart_rate: z.number().int().min(20).max(250).optional(),
      respiratory_rate: z.number().int().min(4).max(80).optional(), temperature_c: z.number().min(30).max(45).optional(), spo2: z.number().int().min(50).max(100).optional(),
      weight_kg: z.number().min(1).max(350).optional(), height_cm: z.number().min(30).max(250).optional(), blood_glucose: z.number().int().min(10).max(900).optional(),
      pain_score: z.number().int().min(0).max(10).optional(), gcs: z.number().int().min(3).max(15).optional(), notes: z.string().max(500).optional(),
    }).strict().refine((x) => Object.keys(x).length > 0, 'minimal satu tanda vital'), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx);
      const keys = Object.keys(v);
      const id = await tx.val(`INSERT INTO vital_sign (encounter_id, recorded_by, ${keys.join(', ')}) VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
        [req.params.id, staff.id, ...keys.map((k) => (v as any)[k])]);
      return { id };
    });
  });

  app.post('/emr/encounters/:id/diagnoses', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ icd10Code: z.string().regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/), diagnosisType: z.enum(['PRIMARY', 'SECONDARY', 'DIFFERENTIAL']).default('PRIMARY'),
      certainty: z.enum(['PROVISIONAL', 'CONFIRMED', 'RULED_OUT']).default('CONFIRMED'), isOccupational: z.boolean().default(false), notes: z.string().max(1000).optional() }), req.body);
    return db(req, async (tx) => ({
      id: await tx.val(`INSERT INTO diagnosis (encounter_id, icd10_code, diagnosis_type, certainty, is_occupational, notes) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [req.params.id, b.icd10Code, b.diagnosisType, b.certainty, b.isOccupational, b.notes ?? null]),
    }));
  });

  app.delete('/emr/encounters/:id/diagnoses/:dxId', async (req: FastifyRequest<{ Params: { id: string; dxId: string } }>) =>
    db(req, async (tx) => {
      // clinical rows are never deleted: an erroneous diagnosis on an unsigned record is marked RULED_OUT (trail is kept)
      const r = await tx.q(`UPDATE diagnosis SET certainty = 'RULED_OUT', diagnosis_type = 'DIFFERENTIAL'
                             WHERE id = $1 AND encounter_id = $2 AND EXISTS (SELECT 1 FROM encounter e WHERE e.id = $2 AND e.status = 'OPEN') RETURNING id`,
        [req.params.dxId, req.params.id]);
      if (!r.length) throw notFound('Diagnosis');
      return { ok: true };
    }));

  app.post('/emr/encounters/:id/procedures', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ description: z.string().min(2).max(500), procedureCode: z.string().max(20).optional(), notes: z.string().max(1000).optional() }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx);
      return { id: await tx.val(`INSERT INTO encounter_procedure (encounter_id, procedure_code, description, performed_by, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.params.id, b.procedureCode ?? null, b.description, staff.id, b.notes ?? null]) };
    });
  });

  // Prescription with allergy safety check (override requires an explicit reason)
  app.post('/emr/encounters/:id/prescriptions', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({
      items: z.array(z.object({ medicineId: zUuid, qty: z.number().positive().max(10000), dose: z.string().min(1).max(60), frequency: z.string().min(1).max(60),
        route: z.enum(['ORAL', 'TOPICAL', 'IV', 'IM', 'SC', 'INHALATION', 'OPHTHALMIC', 'OTIC', 'RECTAL', 'OTHER']).default('ORAL'),
        durationDays: z.number().int().min(1).max(365).optional(), instructions: z.string().max(300).optional() })).min(1).max(20),
      notes: z.string().max(500).optional(), allergyOverrideReason: z.string().min(10).max(300).optional(),
    }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const e = await loadEncounter(tx, req.params.id);
      if (e.status !== 'OPEN') throw badRequest('Resep hanya dapat ditambahkan pada rekam medis yang belum ditandatangani');
      const conflicts = await tx.q(`SELECT a.allergen, a.severity, m.name FROM patient_allergy a JOIN medicine m ON m.id = ANY($2::uuid[])
                                     WHERE a.patient_id = $1 AND a.status = 'ACTIVE' AND a.deleted_at IS NULL AND a.allergen_type = 'DRUG'
                                       AND (a.medicine_id = m.id OR m.generic_name ILIKE '%' || a.allergen || '%')`, [e.patient_id, b.items.map((i) => i.medicineId)]);
      if (conflicts.length && !b.allergyOverrideReason) {
        return { warning: 'ALLERGY', conflicts, message: `Pasien alergi terhadap: ${conflicts.map((c) => `${c.allergen} (${c.severity})`).join(', ')}. Konfirmasi dengan alasan untuk melanjutkan.` };
      }
      const rxId = await tx.val(`INSERT INTO prescription (prescription_no, clinic_id, encounter_id, patient_id, prescriber_id, notes, status)
                                 VALUES (app.next_document_no('RX', $1, 'YYYYMM'), $2, $3, $4, $5, $6, 'SUBMITTED') RETURNING id`,
        [await clinicCode(tx, e.clinic_id), e.clinic_id, e.id, e.patient_id, staff.id,
          [b.notes, b.allergyOverrideReason ? `OVERRIDE ALERGI: ${b.allergyOverrideReason}` : null].filter(Boolean).join(' | ') || null]);
      for (const i of b.items) {
        await tx.q(`INSERT INTO prescription_item (prescription_id, medicine_id, qty, dose, frequency, route, duration_days, instructions) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [rxId, i.medicineId, i.qty, i.dose, i.frequency, i.route, i.durationDays ?? null, i.instructions ?? null]);
      }
      if (b.allergyOverrideReason) await tx.q(`SELECT app.log_access('APPROVE', 'prescription', $1, 'PHARMACY', $2)`, [rxId, 'allergy override: ' + b.allergyOverrideReason]);
      return { id: rxId };
    });
  });

  app.post('/emr/encounters/:id/lab-orders', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ testIds: z.array(zUuid).min(1).max(30), priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'), clinicalInfo: z.string().max(500).optional(),
      externalLab: z.string().max(200).optional() }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const e = await loadEncounter(tx, req.params.id);
      const id = await tx.val(`INSERT INTO lab_order (order_no, clinic_id, patient_id, encounter_id, ordered_by, priority, clinical_info, external_lab)
                               VALUES (app.next_document_no('LAB', $1, 'YYYYMM'), $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [await clinicCode(tx, e.clinic_id), e.clinic_id, e.patient_id, e.id, staff.id, b.priority, b.clinicalInfo ?? e.assessment ?? null, b.externalLab ?? null]);
      for (const t of b.testIds) await tx.q('INSERT INTO lab_result (lab_order_id, lab_test_id) VALUES ($1, $2)', [id, t]);
      return { id };
    });
  });

  app.post('/emr/encounters/:id/referrals', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ hospitalId: zUuid, urgency: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']).default('ROUTINE'), reason: z.string().min(5).max(2000),
      specialtyNeeded: z.string().max(100).optional(), icd10Code: z.string().optional(), transportMode: z.enum(['AMBULANCE', 'COMPANY_VEHICLE', 'PRIVATE', 'OTHER']).optional(),
      estimatedCost: z.number().min(0).optional(), payerType: z.enum(['COMPANY', 'BPJS', 'INSURANCE', 'SELF']).default('BPJS') }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const e = await loadEncounter(tx, req.params.id);
      const icd = b.icd10Code ?? await tx.val(`SELECT icd10_code FROM diagnosis WHERE encounter_id = $1 AND diagnosis_type = 'PRIMARY' AND deleted_at IS NULL`, [e.id]);
      const id = await tx.val(`INSERT INTO referral (referral_no, clinic_id, patient_id, encounter_id, accident_id, hospital_id, referring_doctor_id, urgency, icd10_code, reason,
                                                    specialty_needed, transport_mode, estimated_cost, payer_type, status)
                               VALUES (app.next_document_no('REF', $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'ISSUED') RETURNING id`,
        [await clinicCode(tx, e.clinic_id), e.clinic_id, e.patient_id, e.id, e.accident_id, b.hospitalId, staff.id, b.urgency, icd ?? null, b.reason,
          b.specialtyNeeded ?? null, b.transportMode ?? null, b.estimatedCost ?? null, b.payerType]);
      await tx.q(`UPDATE encounter SET disposition = 'REFERRED' WHERE id = $1 AND status = 'OPEN'`, [e.id]);
      return { id };
    });
  });

  app.post('/emr/encounters/:id/sick-leave', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ leaveType: z.enum(['SICK_LEAVE', 'REST_RECOMMENDATION', 'WORK_ACCIDENT_LEAVE', 'MATERNITY']).default('SICK_LEAVE'), startDate: zDate, endDate: zDate,
      adminRemarks: z.string().max(300).optional() }).refine((v) => v.endDate >= v.startDate, 'tanggal akhir harus setelah tanggal mulai'), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const e = await loadEncounter(tx, req.params.id);
      const p = await tx.one('SELECT employee_id FROM patient WHERE id = $1', [e.patient_id]);
      const emp = p?.employee_id ? await employeeBrief(tx, p.employee_id) : null;
      const id = await tx.val(`INSERT INTO sick_leave (certificate_no, clinic_id, patient_id, employee_id, employee_unit_id, encounter_id, accident_id, leave_type, start_date, end_date, issued_by, admin_remarks)
                               VALUES (app.next_document_no('SKS', $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [await clinicCode(tx, e.clinic_id), e.clinic_id, e.patient_id, emp?.id ?? null, emp?.org_unit_id ?? null, e.id, e.accident_id, b.leaveType, b.startDate, b.endDate, staff.id, b.adminRemarks ?? null]);
      await tx.q(`UPDATE encounter SET disposition = coalesce(disposition, 'REST') WHERE id = $1 AND status = 'OPEN'`, [e.id]);
      return { id };
    });
  });

  app.post('/emr/encounters/:id/certificates', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ certificateType: z.enum(['MEDICAL_CERTIFICATE', 'FIT_TO_WORK', 'RETURN_TO_WORK', 'REST_RECOMMENDATION', 'HEALTH_STATEMENT']),
      fitStatus: z.enum(['FIT', 'FIT_WITH_RESTRICTION', 'TEMPORARILY_UNFIT', 'UNFIT']).optional(), restrictions: z.string().max(500).optional(), purpose: z.string().max(300).optional(),
      validFrom: zDate.optional(), validUntil: zDate.optional() }), req.body);
    if (['FIT_TO_WORK', 'RETURN_TO_WORK'].includes(b.certificateType) && !b.fitStatus) throw badRequest('Status fit wajib untuk surat fit/return to work');
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      const e = await loadEncounter(tx, req.params.id);
      const p = await tx.one('SELECT employee_id FROM patient WHERE id = $1', [e.patient_id]);
      const emp = p?.employee_id ? await employeeBrief(tx, p.employee_id) : null;
      const id = await tx.val(`INSERT INTO medical_certificate (certificate_no, clinic_id, patient_id, employee_id, employee_unit_id, encounter_id, certificate_type, fit_status, restrictions,
                                                               purpose, valid_from, valid_until, issued_by)
                               VALUES (app.next_document_no('SKD', $1), $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::date, current_date), $12, $13) RETURNING id`,
        [await clinicCode(tx, e.clinic_id), e.clinic_id, e.patient_id, emp?.id ?? null, emp?.org_unit_id ?? null, e.id, b.certificateType, b.fitStatus ?? null, b.restrictions ?? null,
          b.purpose ?? null, b.validFrom ?? null, b.validUntil ?? null, staff.id]);
      // fit-to-work / return-to-work also updates the employee's current fitness status
      if (emp && b.fitStatus && ['FIT_TO_WORK', 'RETURN_TO_WORK'].includes(b.certificateType)) {
        await tx.q(`UPDATE health_assessment SET status = 'SUPERSEDED' WHERE employee_id = $1 AND status = 'ACTIVE'`, [emp.id]);
        await tx.q(`INSERT INTO health_assessment (assessment_no, clinic_id, employee_id, employee_unit_id, assessment_type, encounter_id, accident_id, fit_status, restrictions, valid_from, valid_until, assessed_by)
                    VALUES (app.next_document_no('HA', $1), $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::date, current_date), $11, $12)`,
          [emp.company_code, e.clinic_id, emp.id, emp.org_unit_id, b.certificateType, e.id, e.accident_id, b.fitStatus, b.restrictions ?? null, b.validFrom ?? null, b.validUntil ?? null, staff.id]);
      }
      return { id };
    });
  });

  app.post('/emr/encounters/:id/sign', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      await tx.q(`UPDATE encounter SET status = 'SIGNED' WHERE id = $1`, [req.params.id]);
      // move the visit along: to pharmacy if there is an open prescription, otherwise complete
      const t = await tx.one(`SELECT q.id, q.status, EXISTS (SELECT 1 FROM prescription rx WHERE rx.encounter_id = e.id AND rx.status = 'SUBMITTED') AS has_rx
                                FROM encounter e JOIN queue_ticket q ON q.id = e.queue_ticket_id WHERE e.id = $1`, [req.params.id]);
      if (t && t.status === 'IN_CONSULTATION') {
        await tx.q(`UPDATE queue_ticket SET status = $2, consult_end_at = now(), ${t.has_rx ? 'pharmacy_at' : 'completed_at'} = now() WHERE id = $1`, [t.id, t.has_rx ? 'PHARMACY' : 'COMPLETED']);
      }
      return { ok: true };
    }));

  app.post('/emr/encounters/:id/addenda', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ reason: z.string().min(5).max(300), content: z.string().min(5).max(8000) }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      return { id: await tx.val('INSERT INTO encounter_addendum (encounter_id, author_id, reason, content) VALUES ($1, $2, $3, $4) RETURNING id', [req.params.id, staff.id, b.reason, b.content]) };
    });
  });

  // Medical history timeline (all visits the user may see — own clinic, care relationship, break-glass)
  app.get('/emr/patients/:id/timeline', async (req: FastifyRequest<{ Params: { id: string } }>) => {
    parse(zUuid, req.params.id);
    return db(req, async (tx) => {
      await requirePerm(tx, 'EMR', 'READ');
      const patient = await tx.one(`SELECT p.id, p.mrn, p.full_name, p.gender, p.birth_date, date_part('year', age(p.birth_date))::int AS age, p.patient_type, p.blood_type,
                                           c.name AS clinic_name, e.employee_no, jp.name AS position_name, rc.name AS risk_name
                                      FROM patient p JOIN org_unit c ON c.id = p.primary_clinic_id LEFT JOIN employee e ON e.id = p.employee_id
                                      LEFT JOIN job_position jp ON jp.id = e.position_id LEFT JOIN risk_category rc ON rc.id = e.risk_category_id WHERE p.id = $1`, [req.params.id]);
      if (!patient) throw notFound('Pasien');
      await tx.q(`SELECT app.log_access('VIEW', 'patient', $1, 'EMR', 'timeline')`, [req.params.id]);
      const visits = await tx.q(`
        SELECT e.id, e.encounter_no, e.started_at, e.encounter_type, e.status, c.name AS clinic_name, s.full_name AS doctor_name, e.chief_complaint, e.assessment, e.plan, e.disposition,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('code', d.icd10_code, 'title', coalesce(i.title_id, i.title_en), 'type', d.diagnosis_type) ORDER BY d.diagnosis_type), '[]')
                  FROM diagnosis d JOIN icd10_code i ON i.code = d.icd10_code WHERE d.encounter_id = e.id AND d.deleted_at IS NULL) AS diagnoses,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('medicine', m.name, 'qty', pi.qty, 'dose', pi.dose, 'frequency', pi.frequency)), '[]')
                  FROM prescription rx JOIN prescription_item pi ON pi.prescription_id = rx.id JOIN medicine m ON m.id = pi.medicine_id WHERE rx.encounter_id = e.id) AS medications,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('test', t.code, 'value', coalesce(r.value_numeric::text, r.value_text), 'unit', r.unit, 'flag', r.flag)), '[]')
                  FROM lab_order l JOIN lab_result r ON r.lab_order_id = l.id JOIN lab_test t ON t.id = r.lab_test_id WHERE l.encounter_id = e.id) AS labs,
               (SELECT jsonb_build_object('systolic', v.systolic, 'diastolic', v.diastolic, 'temperature_c', v.temperature_c, 'heart_rate', v.heart_rate, 'spo2', v.spo2, 'weight_kg', v.weight_kg)
                  FROM vital_sign v WHERE v.encounter_id = e.id ORDER BY v.recorded_at DESC LIMIT 1) AS vitals,
               (SELECT h.name FROM referral r JOIN hospital h ON h.id = r.hospital_id WHERE r.encounter_id = e.id LIMIT 1) AS referred_to
          FROM encounter e JOIN org_unit c ON c.id = e.clinic_id LEFT JOIN medical_staff s ON s.id = e.doctor_id
         WHERE e.patient_id = $1 AND e.deleted_at IS NULL ORDER BY e.started_at DESC LIMIT 200`, [req.params.id]);
      const allergies = await tx.q(`SELECT allergen, allergen_type, severity, reaction FROM patient_allergy WHERE patient_id = $1 AND status = 'ACTIVE' AND deleted_at IS NULL`, [req.params.id]);
      const history = await tx.q(`SELECT history_type, icd10_code, description, onset_date FROM patient_history WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY onset_date DESC NULLS LAST`, [req.params.id]);
      const mcu = await tx.q(`SELECT mcu_no, mcu_type, exam_date, status, fit_status, restrictions FROM mcu WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY coalesce(exam_date, due_date) DESC`, [req.params.id]);
      return { patient, visits, allergies, history, mcu, restricted: visits.length === 0 };
    });
  });

  app.post('/emr/break-glass', async (req) => {
    const b = parse(z.object({ patientId: zUuid, reason: z.string().min(15).max(500), minutes: z.number().int().min(5).max(240).default(60) }), req.body);
    return db(req, async (tx) => ({ grantId: await tx.val('SELECT app.break_glass($1, $2, $3)', [b.patientId, b.reason, b.minutes]) }));
  });

  // ================================================================ LABORATORY
  app.get('/lab/worklist', async (req: FastifyRequest<{ Querystring: { clinicId?: string; status?: string } }>) =>
    db(req, async (tx) => {
      await requirePerm(tx, 'LAB', 'READ');
      const params: unknown[] = [];
      let where = `l.status IN ('ORDERED','COLLECTED','IN_PROGRESS','RESULTED')`;
      if (req.query.status) { params.push(req.query.status); where = `l.status = $${params.length}`; }
      if (req.query.clinicId) { params.push(req.query.clinicId); where += ` AND l.clinic_id = $${params.length}`; }
      return { data: await tx.q(`
        SELECT l.id, l.order_no, l.status, l.priority, l.ordered_at, l.clinical_info, p.full_name AS patient_name, p.mrn, p.gender, c.name AS clinic_name, s.full_name AS ordered_by_name,
               coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'lab_test_id', t.id, 'code', t.code, 'name', t.name, 'unit', t.unit, 'result_type', t.result_type,
                 'value_numeric', r.value_numeric, 'value_text', r.value_text, 'flag', r.flag, 'ref_range', r.ref_range) ORDER BY t.code), '[]') AS results
          FROM lab_order l JOIN patient p ON p.id = l.patient_id JOIN org_unit c ON c.id = l.clinic_id LEFT JOIN medical_staff s ON s.id = l.ordered_by
          LEFT JOIN lab_result r ON r.lab_order_id = l.id LEFT JOIN lab_test t ON t.id = r.lab_test_id
         WHERE ${where} GROUP BY l.id, p.id, c.name, s.full_name
         ORDER BY CASE l.priority WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, l.ordered_at LIMIT 200`, params) };
    }));

  app.post('/lab/orders/:id/results', async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const b = parse(z.object({ results: z.array(z.object({ labTestId: zUuid, valueNumeric: z.number().nullable().optional(), valueText: z.string().max(500).nullable().optional(),
      notes: z.string().max(500).optional() })).min(1) }), req.body);
    return db(req, async (tx) => {
      const staff = await currentStaff(tx);
      const o = await tx.one('SELECT status FROM lab_order WHERE id = $1', [req.params.id]);
      if (!o) throw notFound('Order lab');
      for (const r of b.results) {
        const flag = r.valueText && /^(POS|POSITIF|REAKTIF)/i.test(r.valueText) ? 'POSITIVE' : r.valueText && /^(NEG|NEGATIF|NON)/i.test(r.valueText) ? 'NEGATIVE' : null;
        await tx.q(`INSERT INTO lab_result (lab_order_id, lab_test_id, value_numeric, value_text, flag, notes, resulted_at, resulted_by)
                    VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
                    ON CONFLICT (lab_order_id, lab_test_id) DO UPDATE SET value_numeric = EXCLUDED.value_numeric, value_text = EXCLUDED.value_text,
                      flag = coalesce(EXCLUDED.flag, lab_result.flag), notes = EXCLUDED.notes, resulted_at = now(), resulted_by = EXCLUDED.resulted_by`,
          [req.params.id, r.labTestId, r.valueNumeric ?? null, r.valueText ?? null, flag, r.notes ?? null, staff.id]);
      }
      if (['ORDERED', 'COLLECTED', 'IN_PROGRESS'].includes(o.status)) await tx.q(`UPDATE lab_order SET status = 'RESULTED' WHERE id = $1`, [req.params.id]);
      return { ok: true };
    });
  });

  app.post('/lab/orders/:id/verify', async (req: FastifyRequest<{ Params: { id: string } }>) =>
    db(req, async (tx) => {
      const staff = await currentStaff(tx, ['DOCTOR']);
      await tx.q(`UPDATE lab_result SET verified_at = now(), verified_by = $2 WHERE lab_order_id = $1 AND verified_at IS NULL`, [req.params.id, staff.id]);
      await tx.q(`UPDATE lab_order SET status = 'VERIFIED' WHERE id = $1`, [req.params.id]);
      return { ok: true };
    }));
}
