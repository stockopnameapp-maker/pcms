import type { FastifyRequest } from 'fastify';
import type { Tx } from '../core/db.js';
import { badRequest, forbidden, notFound } from '../core/errors.js';

type Data = Record<string, unknown>;
export interface ResourceHooks {
  beforeCreate?: (tx: Tx, data: Data, req: FastifyRequest) => Promise<Data | void>;
  afterCreate?: (tx: Tx, id: string, data: Data, req: FastifyRequest) => Promise<void>;
  beforeUpdate?: (tx: Tx, id: string, data: Data, req: FastifyRequest) => Promise<Data | void>;
  beforeTransition?: (tx: Tx, id: string, to: string, extra: Data, req: FastifyRequest) => Promise<Data | void>;
  afterTransition?: (tx: Tx, id: string, to: string, req: FastifyRequest) => Promise<void>;
  afterRead?: (tx: Tx, row: any) => Promise<void>;
  /** extra columns allowed in transition patches (beyond editable fields) */
  transitionFields?: string[];
}

export async function employeeBrief(tx: Tx, employeeId: string) {
  const e = await tx.one('SELECT * FROM app.employee_brief($1)', [employeeId]);
  if (!e) throw notFound('Karyawan');
  return e;
}

export async function currentStaff(tx: Tx, types?: string[]) {
  const s = await tx.one(`SELECT id, staff_type, home_clinic_id, full_name FROM medical_staff WHERE user_id = app.current_user_id() AND status = 'ACTIVE'`);
  if (!s || (types && !types.includes(s.staff_type))) throw forbidden(`Tindakan ini hanya untuk tenaga medis${types ? ' (' + types.join('/') + ')' : ''} yang terdaftar`);
  return s as { id: string; staff_type: string; home_clinic_id: string; full_name: string };
}

export const HOOKS: Record<string, ResourceHooks> = {
  'org-units': {
    async afterCreate(tx, id, data) {
      if (data.unit_type === 'CLINIC') await tx.q(`INSERT INTO clinic_profile (id) VALUES ($1)`, [id]);
    },
  },
  patients: {
    async beforeCreate(tx) {
      return { mrn: await tx.val(`SELECT app.next_document_no('RM', app.tenant_code())`) };
    },
  },
  mcu: {
    async beforeCreate(tx, data) {
      const e = await employeeBrief(tx, String(data.employee_id));
      let patientId = e.patient_id;
      if (!patientId) patientId = await tx.val(`SELECT app.register_patient('EMPLOYEE', $1, $2)`, [e.id, data.clinic_id]);
      return {
        patient_id: patientId, employee_unit_id: e.org_unit_id, position_id: e.position_id, risk_category_id: e.risk_category_id,
        mcu_no: await tx.val(`SELECT app.next_document_no('MCU', $1)`, [e.company_code]),
        status: data.scheduled_date ? 'SCHEDULED' : 'PLANNED',
      };
    },
    transitionFields: ['fit_status', 'restrictions', 'valid_until', 'exam_date', 'scheduled_date'],
    async beforeTransition(tx, id, to, extra) {
      if (to === 'COMPLETED' && !extra.fit_status) throw badRequest('Status fit wajib ditetapkan saat MCU selesai');
      if (extra.fit_status === 'FIT_WITH_RESTRICTION' && !extra.restrictions) throw badRequest('Pembatasan kerja wajib diisi untuk FIT WITH RESTRICTION');
    },
    async afterTransition(tx, id, to) {
      if (to !== 'COMPLETED') return;
      // fitness decision is recorded as a health assessment (single source for "current fit status")
      const m = await tx.one('SELECT * FROM mcu WHERE id = $1', [id]);
      const staff = await currentStaff(tx, ['DOCTOR']);
      await tx.q(`UPDATE health_assessment SET status = 'SUPERSEDED' WHERE employee_id = $1 AND status = 'ACTIVE'`, [m.employee_id]);
      await tx.q(`INSERT INTO health_assessment (assessment_no, clinic_id, employee_id, employee_unit_id, assessment_type, mcu_id, fit_status, restrictions, valid_from, valid_until, assessed_by)
                  VALUES (app.next_document_no('HA', $1), $2, $3, $4, 'MCU', $5, $6, $7, coalesce($8, current_date), $9, $10)`,
        [await tx.val('SELECT code FROM org_unit WHERE id = $1', [m.clinic_id]), m.clinic_id, m.employee_id, m.employee_unit_id, m.id, m.fit_status, m.restrictions, m.exam_date, m.valid_until, staff.id]);
    },
  },
  'health-assessments': {
    async beforeCreate(tx, data) {
      const e = await employeeBrief(tx, String(data.employee_id));
      const staff = await currentStaff(tx, ['DOCTOR']);
      if (data.fit_status === 'FIT_WITH_RESTRICTION' && !data.restrictions) throw badRequest('Pembatasan kerja wajib diisi');
      await tx.q(`UPDATE health_assessment SET status = 'SUPERSEDED' WHERE employee_id = $1 AND status = 'ACTIVE'`, [e.id]);
      return { employee_unit_id: e.org_unit_id, assessed_by: staff.id, assessment_no: await tx.val(`SELECT app.next_document_no('HA', $1)`, [e.company_code]) };
    },
  },
  accidents: {
    async beforeCreate(tx, data) {
      const extra: Data = { reported_by: await tx.val('SELECT app.current_user_id()') };
      if (data.employee_id) {
        const e = await employeeBrief(tx, String(data.employee_id));
        extra.victim_name = data.victim_name || e.full_name;
        extra.patient_id = e.patient_id;
      }
      if (!data.victim_name && !extra.victim_name) throw badRequest('Nama korban wajib diisi');
      extra.incident_no = await tx.val(`SELECT app.next_document_no('ACC', app.unit_company_code($1))`, [data.org_unit_id]);
      extra.status = data.first_aid_given ? 'FIRST_AID' : 'REPORTED';
      return extra;
    },
    transitionFields: ['investigation_findings', 'root_cause', 'corrective_action', 'return_to_work_date', 'lost_time_days'],
  },
  referrals: {
    transitionFields: ['hospital_diagnosis', 'treatment_summary', 'admitted', 'admission_date', 'discharge_date', 'actual_cost', 'follow_up_date'],
    async beforeTransition(tx, id, to, extra) {
      if (to === 'RETURNED') extra.returned_at = new Date().toISOString();
      return extra;
    },
  },
  'ambulance-maintenance': {
    async beforeCreate(tx, data) {
      return { clinic_id: await tx.val('SELECT clinic_id FROM ambulance WHERE id = $1', [data.ambulance_id]) };
    },
  },
  'ambulance-fuel': {
    async beforeCreate(tx, data) {
      return { clinic_id: await tx.val('SELECT clinic_id FROM ambulance WHERE id = $1', [data.ambulance_id]) };
    },
  },
  'ambulance-trips': {
    transitionFields: ['odometer_start', 'odometer_end', 'notes'],
    async beforeTransition(tx, id, to, extra) {
      const now = new Date().toISOString();
      if (to === 'EN_ROUTE' || to === 'TRANSPORTING') extra.departed_at = extra.departed_at ?? now;
      if (to === 'ARRIVED') extra.arrived_at = now;
      return extra;
    },
    async afterTransition(tx, id, to) {
      if (to === 'COMPLETED' || to === 'CANCELLED') {
        await tx.q(`UPDATE ambulance a SET status = 'AVAILABLE', odometer_km = greatest(coalesce(a.odometer_km, 0), coalesce(t.odometer_end, 0))
                      FROM ambulance_trip t WHERE t.id = $1 AND a.id = t.ambulance_id`, [id]);
        if (to === 'COMPLETED') await tx.q(`UPDATE ambulance_trip SET arrived_at = coalesce(arrived_at, now()) WHERE id = $1`, [id]);
      }
    },
  },
  'sick-leaves': {
    async beforeTransition(tx, id, to) {
      if (to === 'ACKNOWLEDGED') return { hr_acknowledged_by: await tx.val('SELECT app.current_user_id()'), hr_acknowledged_at: new Date().toISOString() };
    },
  },
  'stock-transfers': { transitionFields: ['reject_reason'] },
  alerts: {
    async beforeTransition(tx, id, to) {
      if (to === 'ACKNOWLEDGED') return { acknowledged_by: await tx.val('SELECT app.current_user_id()'), acknowledged_at: new Date().toISOString() };
      if (to === 'RESOLVED' || to === 'DISMISSED') return { resolved_at: new Date().toISOString() };
    },
  },
  inpatients: {
    async beforeTransition() { return { discharged_at: new Date().toISOString() }; },
    async afterTransition(tx, id) {
      await tx.q(`UPDATE clinic_bed b SET status = 'CLEANING' FROM inpatient_stay i WHERE i.id = $1 AND b.id = i.bed_id`, [id]);
    },
  },
  appointments: {
    async beforeCreate(tx, data) { if (!data.appointment_type) return { appointment_type: 'CONSULTATION' }; },
    transitionFields: ['cancel_reason'],
    async beforeTransition(tx, id, to, extra) {
      if (to === 'CANCELLED' && !extra.cancel_reason) extra.cancel_reason = 'Dibatalkan oleh petugas';
      return extra;
    },
  },
  costs: {
    async beforeCreate() { return { source_type: 'manual' }; },
  },
  'role-assignments': {
    async beforeCreate(tx, data) {
      if (!data.reason) throw badRequest('Alasan penugasan wajib diisi');
    },
  },
  'break-glass': {
    async beforeUpdate(tx) { return { reviewed_by: await tx.val('SELECT app.current_user_id()'), reviewed_at: new Date().toISOString() }; },
  },
  employees: {
    async afterRead(tx, row) {
      // never expose more NIK digits than needed in list/detail screens of HR — full value shown only in the edit form
      row.nik_masked = row.nik ? '•'.repeat(12) + String(row.nik).slice(-4) : null;
    },
  },
};
