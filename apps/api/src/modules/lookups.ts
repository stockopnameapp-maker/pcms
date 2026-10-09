import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, db } from '../core/http.js';
import { notFound } from '../core/errors.js';

type Q = { q?: string; id?: string; types?: string; type?: string; clinicId?: string; limit?: string };
interface Lookup { sql: (q: Q, p: (v: unknown) => string) => string }

// Each lookup returns {id, label, sub}. All run under RLS, so options are
// automatically limited to what the user may see.
const term = (q: Q, p: (v: unknown) => string) => p(`%${(q.q ?? '').trim()}%`);
const LOOKUPS: Record<string, Lookup> = {
  org_unit: { sql: (q, p) => `SELECT u.id, app.unit_display_name(u.id) AS label, u.unit_type || ' · ' || u.code AS sub FROM org_unit u WHERE u.deleted_at IS NULL
      ${q.types ? `AND u.unit_type = ANY(${p(q.types.split(','))}::text[])` : ''} AND (u.name ILIKE ${term(q, p)} OR u.code ILIKE ${term(q, p)}) ORDER BY u.depth, u.name` },
  // clinic names repeat across PTs ("Klinik Rayon A"), so the label carries the PT code: "Klinik Rayon A (BCPJ)"
  clinic: { sql: (q, p) => `SELECT u.id, app.unit_display_name(u.id) AS label, cp.operational_status AS sub FROM org_unit u JOIN clinic_profile cp ON cp.id = u.id
      WHERE u.deleted_at IS NULL AND (u.name ILIKE ${term(q, p)} OR u.code ILIKE ${term(q, p)}) ORDER BY 2` },
  stock_site: { sql: (q, p) => `SELECT u.id, app.unit_display_name(u.id) AS label, u.unit_type AS sub FROM org_unit u WHERE u.unit_type IN ('CLINIC','WAREHOUSE') AND u.deleted_at IS NULL
      AND (u.name ILIKE ${term(q, p)} OR u.code ILIKE ${term(q, p)}) ORDER BY u.unit_type DESC, 2` },
  employee: { sql: (q, p) => q.id ? `SELECT id, employee_no || ' · ' || full_name AS label, NULL AS sub FROM app.employee_brief(${p(q.id)})`
      : `SELECT * FROM app.employee_pick(${p(q.q ?? '')}, 25)` },
  patient: { sql: (q, p) => `SELECT p.id, p.full_name AS label, p.mrn || ' · ' || p.patient_type AS sub FROM patient p WHERE p.deleted_at IS NULL
      AND (p.full_name ILIKE ${term(q, p)} OR p.mrn ILIKE ${term(q, p)}) ORDER BY p.full_name` },
  medicine: { sql: (q, p) => `SELECT m.id, m.name AS label, m.code || ' · ' || m.unit AS sub FROM medicine m WHERE m.deleted_at IS NULL AND m.is_active
      AND (m.name ILIKE ${term(q, p)} OR m.generic_name ILIKE ${term(q, p)} OR m.code ILIKE ${term(q, p)}) ORDER BY m.name` },
  medicine_category: { sql: (q, p) => `SELECT id, name AS label, code AS sub FROM medicine_category WHERE deleted_at IS NULL AND name ILIKE ${term(q, p)} ORDER BY name` },
  supplier: { sql: (q, p) => `SELECT id, name AS label, code AS sub FROM supplier WHERE deleted_at IS NULL AND name ILIKE ${term(q, p)} ORDER BY name` },
  hospital: { sql: (q, p) => `SELECT id, name AS label, hospital_type || coalesce(' · ' || city, '') AS sub FROM hospital WHERE deleted_at IS NULL AND name ILIKE ${term(q, p)} ORDER BY is_partner DESC, name` },
  job_position: { sql: (q, p) => `SELECT id, name AS label, code AS sub FROM job_position WHERE deleted_at IS NULL AND name ILIKE ${term(q, p)} ORDER BY name` },
  risk_category: { sql: (q, p) => `SELECT id, name AS label, risk_level AS sub FROM risk_category WHERE deleted_at IS NULL AND name ILIKE ${term(q, p)} ORDER BY name` },
  lab_test: { sql: (q, p) => `SELECT id, name AS label, code || coalesce(' · ' || unit, '') AS sub FROM lab_test WHERE deleted_at IS NULL AND is_active AND (name ILIKE ${term(q, p)} OR code ILIKE ${term(q, p)}) ORDER BY code` },
  icd10: { sql: (q, p) => `SELECT code AS id, code || ' — ' || coalesce(title_id, title_en) AS label, title_en AS sub FROM icd10_code
      WHERE ${q.id ? `code = ${p(q.id)}` : `(code ILIKE ${p((q.q ?? '') + '%')} OR title_en ILIKE ${term(q, p)} OR title_id ILIKE ${term(q, p)})`} ORDER BY code` },
  role: { sql: (q, p) => `SELECT id, name AS label, code AS sub FROM role WHERE deleted_at IS NULL AND (name ILIKE ${term(q, p)} OR code ILIKE ${term(q, p)}) ORDER BY is_system DESC, name` },
  app_user: { sql: (q, p) => `SELECT id, full_name AS label, username AS sub FROM app_user WHERE deleted_at IS NULL AND (full_name ILIKE ${term(q, p)} OR username ILIKE ${term(q, p)}) ORDER BY full_name` },
  medical_staff: { sql: (q, p) => `SELECT s.id, coalesce(s.title_prefix || ' ', '') || s.full_name AS label, s.staff_type || ' · ' || c.name AS sub FROM medical_staff s JOIN org_unit c ON c.id = s.home_clinic_id
      WHERE s.deleted_at IS NULL AND s.status = 'ACTIVE' ${q.type ? `AND s.staff_type = ${p(q.type)}` : ''} ${q.clinicId ? `AND s.home_clinic_id = ${p(q.clinicId)}` : ''}
      AND s.full_name ILIKE ${term(q, p)} ORDER BY s.full_name` },
  ambulance: { sql: (q, p) => `SELECT a.id, a.code || ' · ' || a.vehicle_no AS label, a.status AS sub FROM ambulance a WHERE a.deleted_at IS NULL
      ${q.clinicId ? `AND a.clinic_id = ${p(q.clinicId)}` : ''} AND (a.code ILIKE ${term(q, p)} OR a.vehicle_no ILIKE ${term(q, p)}) ORDER BY a.code` },
  clinic_room: { sql: (q, p) => `SELECT r.id, r.name AS label, r.room_type AS sub FROM clinic_room r WHERE r.deleted_at IS NULL
      ${q.clinicId ? `AND r.clinic_id = ${p(q.clinicId)}` : ''} AND r.name ILIKE ${term(q, p)} ORDER BY r.name` },
  clinic_bed: { sql: (q, p) => `SELECT b.id, b.code AS label, b.status AS sub FROM clinic_bed b WHERE b.deleted_at IS NULL AND b.status = 'AVAILABLE'
      ${q.clinicId ? `AND b.clinic_id = ${p(q.clinicId)}` : ''} ORDER BY b.code` },
};

export default async function lookupRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);
  app.get('/lookup/:kind', async (req: FastifyRequest<{ Params: { kind: string }; Querystring: Q }>) => {
    const l = LOOKUPS[req.params.kind];
    if (!l) throw notFound('Lookup');
    const q = req.query;
    return db(req, async (tx) => {
      const params: unknown[] = [];
      const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
      let sql = l.sql(q, p);
      if (q.id && req.params.kind !== 'icd10' && req.params.kind !== 'employee') sql = `SELECT * FROM (${sql}) x WHERE x.id = ${p(q.id)}`;
      const limit = Math.min(50, Number(q.limit) || 20);
      return { data: await tx.q(`SELECT * FROM (${sql}) x LIMIT ${limit}`, params) };
    });
  });
}
