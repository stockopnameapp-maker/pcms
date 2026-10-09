// Reports & export (Phase 10). Every report runs inside the requesting user's
// security context: row-level reports are filtered by RLS, aggregate reports go
// through the scope-checked analytics functions (with small-cell suppression).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, dateRange, db, parse, requirePerm, sendFile, zUuid } from '../core/http.js';
import { notFound } from '../core/errors.js';
import type { Tx } from '../core/db.js';
import type { ColumnDef } from './resources.def.js';
import { exportRows } from './export.js';

interface Ctx { unitId: string; from: string; to: string; dimension?: string }
interface ReportDef {
  code: string; title: string; description: string; module: string; category: string; needsUnit: boolean; defaultDays: number;
  dimensions?: string[];
  run: (tx: Tx, c: Ctx) => Promise<{ columns: ColumnDef[]; rows: any[] }>;
}
const c = (spec: string): ColumnDef[] => spec.split(',').map((s) => { const [name, label, kind] = s.trim().split(':'); return { name, label, kind: (kind as any) || 'text' }; });
const sub = `(SELECT path FROM org_unit WHERE id = $1)`;

export const REPORTS: ReportDef[] = [
  { code: 'PATIENT_VISIT', title: 'Laporan Kunjungan Pasien', category: 'Pelayanan', module: 'QUEUE', needsUnit: true, defaultDays: 30,
    description: 'Kunjungan per pasien dengan waktu tunggu dan status (tanpa data klinis)',
    run: async (tx, x) => ({ columns: c('visit_date:Tanggal:date,clinic_name:Klinik,queue_code:No. antrian,mrn:No. RM,patient_name:Pasien,patient_type:Jenis:badge,priority:Prioritas,status:Status,wait_min:Tunggu (mnt):number,consult_min:Konsultasi (mnt):number'),
      rows: await tx.q(`SELECT q.visit_date, c.name AS clinic_name, q.queue_code, p.mrn, p.full_name AS patient_name, p.patient_type, q.priority, q.status,
                               round(extract(epoch FROM q.consult_start_at - q.registered_at) / 60) AS wait_min, round(extract(epoch FROM q.consult_end_at - q.consult_start_at) / 60) AS consult_min
                          FROM queue_ticket q JOIN org_unit c ON c.id = q.clinic_id LEFT JOIN patient p ON p.id = q.patient_id
                         WHERE c.path <@ ${sub} AND q.visit_date BETWEEN $2 AND $3 ORDER BY q.visit_date DESC, c.name, q.queue_no`, [x.unitId, x.from, x.to]) }) },
  { code: 'DISEASE', title: 'Laporan Penyakit (ICD-10)', category: 'Health Intelligence', module: 'DASHBOARD', needsUnit: true, defaultDays: 30,
    description: '50 diagnosis teratas; jumlah < 5 disamarkan bila tanpa akses klinis',
    run: async (tx, x) => ({ columns: c('icd10_code:ICD-10,title:Diagnosis,cases:Kasus:number,share:Persentase (%):number,occupational:Terkait kerja:bool,suppressed:Disamarkan:bool'),
      rows: await tx.q('SELECT * FROM analytics.top_diseases($1, $2, $3, 50)', [x.unitId, x.from, x.to]) }) },
  { code: 'MEDICINE_USAGE', title: 'Laporan Pemakaian Obat', category: 'Farmasi', module: 'DASHBOARD', needsUnit: true, defaultDays: 30,
    description: 'Kuantitas dan nilai obat yang diserahkan',
    run: async (tx, x) => ({ columns: c('code:Kode,name:Obat,unit:Satuan,qty:Qty:number,cost:Nilai:money,prescriptions:Resep:number'),
      rows: await tx.q('SELECT * FROM analytics.medicine_consumption($1, $2, $3, 500)', [x.unitId, x.from, x.to]) }) },
  { code: 'INVENTORY', title: 'Laporan Persediaan', category: 'Farmasi', module: 'INVENTORY', needsUnit: true, defaultDays: 1,
    description: 'Posisi stok per lokasi dengan stok minimum dan kedaluwarsa terdekat',
    run: async (tx, x) => ({ columns: c('site_name:Lokasi,code:Kode,name:Obat,unit:Satuan,qty_on_hand:Stok:number,qty_usable:Layak pakai:number,min_qty:Minimum:number,nearest_expiry:ED terdekat:date,is_low_stock:Di bawah minimum:bool,stock_value:Nilai:money'),
      rows: await tx.q(`SELECT u.name AS site_name, m.code, m.name, m.unit, sp.qty_on_hand, sp.qty_usable, sp.min_qty, sp.nearest_expiry, sp.is_low_stock, round(sp.qty_on_hand * m.standard_cost) AS stock_value
                          FROM v_stock_position sp JOIN medicine m ON m.id = sp.medicine_id JOIN org_unit u ON u.id = sp.org_unit_id
                         WHERE u.path <@ ${sub} ORDER BY u.name, m.name`, [x.unitId]) }) },
  { code: 'EXPIRED_MEDICINE', title: 'Laporan Obat Kedaluwarsa', category: 'Farmasi', module: 'INVENTORY', needsUnit: true, defaultDays: 1,
    description: 'Batch kedaluwarsa dan yang akan kedaluwarsa dalam 90 hari',
    run: async (tx, x) => ({ columns: c('site_name:Lokasi,medicine:Obat,batch_no:Batch,expiry_date:Kedaluwarsa:date,days_to_expiry:Sisa hari:number,qty_on_hand:Qty:number,value:Nilai:money,state:Status'),
      rows: await tx.q(`SELECT u.name AS site_name, m.name AS medicine, b.batch_no, b.expiry_date, (b.expiry_date - current_date) AS days_to_expiry, s.qty_on_hand,
                               round(s.qty_on_hand * b.unit_cost) AS value, CASE WHEN b.expiry_date < current_date THEN 'EXPIRED' ELSE 'NEAR EXPIRY' END AS state
                          FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id JOIN medicine m ON m.id = s.medicine_id JOIN org_unit u ON u.id = s.org_unit_id
                         WHERE u.path <@ ${sub} AND s.qty_on_hand > 0 AND b.expiry_date < current_date + 90 ORDER BY b.expiry_date`, [x.unitId]) }) },
  { code: 'REFERRAL', title: 'Laporan Rujukan', category: 'Pelayanan', module: 'REFERRAL', needsUnit: true, defaultDays: 90,
    description: 'Rujukan ke rumah sakit dengan status dan biaya',
    run: async (tx, x) => ({ columns: c('referral_date:Tanggal:date,referral_no:No.,clinic_name:Klinik,patient_name:Pasien,hospital_name:Rumah sakit,icd10_code:ICD-10,urgency:Urgensi,status:Status,admitted:Rawat inap:bool,actual_cost:Biaya:money,payer_type:Penjamin'),
      rows: await tx.q(`SELECT r.referral_date, r.referral_no, c.name AS clinic_name, p.full_name AS patient_name, h.name AS hospital_name, r.icd10_code, r.urgency, r.status, r.admitted, r.actual_cost, r.payer_type
                          FROM referral r JOIN org_unit c ON c.id = r.clinic_id LEFT JOIN patient p ON p.id = r.patient_id JOIN hospital h ON h.id = r.hospital_id
                         WHERE c.path <@ ${sub} AND r.referral_date BETWEEN $2 AND $3 ORDER BY r.referral_date DESC`, [x.unitId, x.from, x.to]) }) },
  { code: 'ACCIDENT', title: 'Laporan Kecelakaan Kerja', category: 'K3', module: 'ACCIDENT', needsUnit: true, defaultDays: 180,
    description: 'Insiden, severity, hari kerja hilang dan status investigasi',
    run: async (tx, x) => ({ columns: c('occurred_at:Waktu:datetime,incident_no:No.,company:PT,estate:Kebun,location:Unit,victim_name:Korban,activity:Aktivitas,incident_type:Jenis,severity:Severity,body_part:Bagian tubuh,lost_time_days:Hari hilang:number,is_lti:LTI:bool,status:Status'),
      rows: await tx.q(`SELECT a.occurred_at, a.incident_no, co.name AS company, es.name AS estate, u.name AS location, a.victim_name, a.activity, a.incident_type, a.severity, a.body_part,
                               a.lost_time_days, a.is_lti, a.status
                          FROM accident a JOIN org_unit u ON u.id = a.org_unit_id LEFT JOIN org_unit co ON co.id = a.company_id LEFT JOIN org_unit es ON es.id = a.estate_id
                         WHERE u.path <@ ${sub} AND a.occurred_at::date BETWEEN $2 AND $3 AND a.deleted_at IS NULL ORDER BY a.occurred_at DESC`, [x.unitId, x.from, x.to]) }) },
  { code: 'MCUP', title: 'Laporan Medical Check Up', category: 'Kesehatan Kerja', module: 'OCC_HEALTH', needsUnit: true, defaultDays: 365,
    description: 'Program MCU: jadwal, pelaksanaan dan hasil kelaikan (tanpa temuan klinis)',
    run: async (tx, x) => ({ columns: c('mcu_no:No.,employee_no:No. karyawan,employee_name:Nama,unit_name:Unit,risk:Risiko,mcu_type:Jenis,due_date:Jatuh tempo:date,exam_date:Diperiksa:date,status:Status,fit_status:Status fit,restrictions:Pembatasan'),
      rows: await tx.q(`SELECT m.mcu_no, e.employee_no, e.full_name AS employee_name, u.name AS unit_name, rc.name AS risk, m.mcu_type, m.due_date, m.exam_date, m.status, m.fit_status, m.restrictions
                          FROM mcu m JOIN employee e ON e.id = m.employee_id JOIN org_unit u ON u.id = m.employee_unit_id LEFT JOIN risk_category rc ON rc.id = m.risk_category_id
                         WHERE u.path <@ ${sub} AND coalesce(m.exam_date, m.due_date) BETWEEN $2 AND $3 AND m.deleted_at IS NULL ORDER BY coalesce(m.exam_date, m.due_date) DESC`, [x.unitId, x.from, x.to]) }) },
  { code: 'FIT_TO_WORK', title: 'Laporan Status Fit-to-Work', category: 'Kesehatan Kerja', module: 'OCC_HEALTH', needsUnit: true, defaultDays: 1,
    description: 'Status kelaikan kerja dan kepatuhan MCU per karyawan aktif',
    run: async (tx, x) => ({ columns: c('employee_no:No. karyawan,full_name:Nama,unit_name:Unit,position_name:Jabatan,risk_name:Risiko,risk_level:Level,last_mcu_date:MCU terakhir:date,fit_status:Status fit,restrictions:Pembatasan,next_mcu_due:MCU berikut:date,mcu_compliance:Kepatuhan'),
      rows: await tx.q(`SELECT h.*, u.name AS unit_name FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id WHERE u.path <@ ${sub} ORDER BY u.name, h.full_name`, [x.unitId]) }) },
  { code: 'SICK_LEAVE', title: 'Laporan Surat Sakit', category: 'Administrasi Medis', module: 'SICK_LEAVE', needsUnit: true, defaultDays: 90,
    description: 'Surat sakit/istirahat — administratif, tanpa diagnosis',
    run: async (tx, x) => ({ columns: c('certificate_no:No.,start_date:Mulai:date,end_date:Sampai:date,days:Hari:number,employee_no:No. karyawan,patient_name:Nama,unit_name:Unit,leave_type:Jenis,clinic_name:Klinik,status:Status'),
      rows: await tx.q(`SELECT s.certificate_no, s.start_date, s.end_date, s.days, e.employee_no, coalesce(p.full_name, e.full_name) AS patient_name, u.name AS unit_name, s.leave_type, c.name AS clinic_name, s.status
                          FROM sick_leave s LEFT JOIN patient p ON p.id = s.patient_id JOIN org_unit c ON c.id = s.clinic_id LEFT JOIN employee e ON e.id = s.employee_id LEFT JOIN org_unit u ON u.id = s.employee_unit_id
                         WHERE coalesce(u.path, c.path) <@ ${sub} AND s.start_date BETWEEN $2 AND $3 AND s.deleted_at IS NULL ORDER BY s.start_date DESC`, [x.unitId, x.from, x.to]) }) },
  { code: 'CLINIC_PERFORMANCE', title: 'Laporan Kinerja Klinik', category: 'Health Intelligence', module: 'DASHBOARD', needsUnit: true, defaultDays: 30,
    description: 'Kunjungan, waktu tunggu, rasio rujukan, biaya per kunjungan, beban dokter',
    run: async (tx, x) => ({ columns: c('clinic:Klinik,status:Status,visits:Kunjungan:number,avg_wait_min:Tunggu rata2 (mnt):number,avg_consult_min:Konsultasi rata2 (mnt):number,referral_rate:Rasio rujukan (%):number,items_per_visit:Item obat/kunjungan:number,cost_per_visit:Biaya/kunjungan:money,doctors:Dokter:number,nurses:Perawat:number,visits_per_doctor_day:Kunjungan/dokter/hari:number'),
      rows: await tx.q('SELECT * FROM analytics.clinic_performance($1, $2, $3)', [x.unitId, x.from, x.to]) }) },
  { code: 'MEDICAL_COST', title: 'Laporan Biaya Medis', category: 'Keuangan', module: 'FINANCE', needsUnit: true, defaultDays: 180, dimensions: ['category', 'company', 'estate', 'clinic', 'disease', 'employee', 'payer', 'month'],
    description: 'Biaya medis per kategori / PT / kebun / klinik / penyakit / karyawan / bulan',
    run: async (tx, x) => ({ columns: c('label:Dimensi,amount:Jumlah:money,transactions:Transaksi:number,per_employee:Per karyawan:money'),
      rows: await tx.q('SELECT * FROM analytics.cost_breakdown($1, $2, $3, $4, 500)', [x.unitId, x.from, x.to, x.dimension ?? 'category']) }) },
  { code: 'OCCUPATIONAL_HEALTH', title: 'Laporan Kesehatan Kerja per Risiko', category: 'Kesehatan Kerja', module: 'DASHBOARD', needsUnit: true, defaultDays: 1,
    description: 'Kepatuhan MCU dan status kelaikan per kategori risiko pekerjaan',
    run: async (tx, x) => {
      const d = await tx.val('SELECT analytics.occupational_health($1)', [x.unitId]);
      return { columns: c('risk_name:Kategori risiko,risk_level:Level,employees:Karyawan:number,compliant:Patuh MCU:number,overdue:Terlambat:number,never:Belum pernah:number,restricted:Fit dgn pembatasan:number,unfit:Unfit:number'), rows: d.by_risk };
    } },
  { code: 'EMPLOYEE_HEALTH', title: 'Laporan Kesehatan Karyawan', category: 'SDM', module: 'EMPLOYEE', needsUnit: true, defaultDays: 180,
    description: 'Ringkasan per karyawan: hari sakit, kecelakaan, status fit (administratif)',
    run: async (tx, x) => ({ columns: c('employee_no:No. karyawan,full_name:Nama,unit_name:Unit,position_name:Jabatan,sick_leaves:Surat sakit:number,sick_days:Hari sakit:number,accidents:Kecelakaan:number,lost_days:Hari hilang:number,fit_status:Status fit,mcu_compliance:Kepatuhan MCU'),
      rows: await tx.q(`SELECT e.employee_no, e.full_name, u.name AS unit_name, jp.name AS position_name,
                               (SELECT count(*) FROM sick_leave s WHERE s.employee_id = e.id AND s.start_date BETWEEN $2 AND $3 AND s.status <> 'CANCELLED') AS sick_leaves,
                               (SELECT coalesce(sum(s.days), 0) FROM sick_leave s WHERE s.employee_id = e.id AND s.start_date BETWEEN $2 AND $3 AND s.status <> 'CANCELLED') AS sick_days,
                               (SELECT count(*) FROM accident a WHERE a.employee_id = e.id AND a.occurred_at::date BETWEEN $2 AND $3) AS accidents,
                               (SELECT coalesce(sum(a.lost_time_days), 0) FROM accident a WHERE a.employee_id = e.id AND a.occurred_at::date BETWEEN $2 AND $3) AS lost_days,
                               h.fit_status, h.mcu_compliance
                          FROM employee e JOIN org_unit u ON u.id = e.org_unit_id JOIN job_position jp ON jp.id = e.position_id
                          LEFT JOIN v_employee_health_status h ON h.employee_id = e.id
                         WHERE u.path <@ ${sub} AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE' ORDER BY sick_days DESC, e.full_name`, [x.unitId, x.from, x.to]) }) },
  { code: 'CONSOLIDATED', title: 'Laporan Konsolidasi Grup', category: 'Health Intelligence', module: 'DASHBOARD', needsUnit: true, defaultDays: 30,
    description: 'KPI per PT/kebun/klinik di bawah unit terpilih (drill-down) dengan total',
    run: async (tx, x) => {
      const rows = (await tx.q('SELECT d FROM analytics.drilldown($1, $2, $3) d', [x.unitId, x.from, x.to])).map((r) => r.d);
      const k = await tx.val('SELECT analytics.kpi_summary($1, $2, $3)', [x.unitId, x.from, x.to]);
      rows.push({ name: 'TOTAL', unit_type: '', employees: k.total_employees, clinics: k.total_clinics, visits: k.patient_visits, accidents: k.accident_cases, lti: k.lti_cases,
        referrals: k.referrals, sick_leave_days: k.sick_leave_days, medical_cost: k.medical_cost, cost_per_employee: k.cost_per_employee, mcu_completion_pct: k.mcu_completion_pct,
        unfit: (k.unfit ?? 0) + (k.temporarily_unfit ?? 0), open_alerts: k.open_alerts });
      return { columns: c('name:Unit,unit_type:Tipe,employees:Karyawan:number,clinics:Klinik:number,visits:Kunjungan:number,accidents:Kecelakaan:number,lti:LTI:number,referrals:Rujukan:number,sick_leave_days:Hari sakit:number,medical_cost:Biaya medis:money,cost_per_employee:Biaya/karyawan:money,mcu_completion_pct:Kepatuhan MCU (%):number,unfit:Unfit:number,open_alerts:Alert:number'), rows };
    } },
];

export default async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/reports', async (req) => db(req, async (tx) => {
    const perms = await tx.q<{ module: string; action: string }>('SELECT DISTINCT module, action FROM app.my_permissions()');
    const has = (m: string, a: string) => perms.some((p) => p.module === m && p.action === a);
    return { data: REPORTS.map(({ run, ...r }) => ({ ...r, allowed: has(r.module, 'READ') && (has('REPORT', 'READ') || ['QUEUE', 'INVENTORY', 'SICK_LEAVE', 'OCC_HEALTH', 'ACCIDENT', 'REFERRAL', 'EMPLOYEE', 'FINANCE'].includes(r.module)),
      canExport: has(r.module, 'EXPORT') || has('REPORT', 'EXPORT') })) };
  }));

  app.get('/reports/:code', async (req: FastifyRequest<{ Params: { code: string }; Querystring: any }>, reply) => {
    const r = REPORTS.find((x) => x.code === req.params.code);
    if (!r) throw notFound('Laporan');
    const q = parse(z.object({ unitId: zUuid, from: z.string().optional(), to: z.string().optional(), dimension: z.string().optional(),
      format: z.enum(['json', 'xlsx', 'csv', 'pdf']).default('json') }), req.query);
    const range = dateRange(q, r.defaultDays);
    const result = await db(req, async (tx) => {
      await requirePerm(tx, r.module, 'READ');
      if (q.format !== 'json') {
        const ok = await tx.val<boolean>(`SELECT app.has_perm($1, 'EXPORT') OR app.has_perm('REPORT', 'EXPORT')`, [r.module]);
        if (!ok) { const { forbidden } = await import('../core/errors.js'); throw forbidden('Izin EXPORT diperlukan untuk mengunduh laporan'); }
      }
      const unitName = await tx.val('SELECT name FROM org_unit WHERE id = $1', [q.unitId]);
      const data = await r.run(tx, { unitId: q.unitId, from: range.from, to: range.to, dimension: q.dimension });
      await tx.q(`SELECT app.log_access($1, 'report', NULL, $2, $3)`, [q.format === 'json' ? 'VIEW' : q.format === 'pdf' ? 'PRINT' : 'EXPORT', r.module,
        `${r.code} ${q.format} unit=${unitName} ${range.from}..${range.to} rows=${data.rows.length}`]);
      return { ...data, unitName };
    });
    if (q.format === 'json') return { report: { code: r.code, title: r.title, ...range, unitName: result.unitName }, columns: result.columns, rows: result.rows.slice(0, 2000), total: result.rows.length };
    const meta: Record<string, string> = { Unit: result.unitName, Periode: `${range.from} s/d ${range.to}` };
    if (q.dimension) meta.Dimensi = q.dimension;
    const out = await exportRows(q.format, r.title, result.columns, result.rows, meta);
    return sendFile(reply, out.buffer, out.mime, `${r.code}-${range.from}_${range.to}.${q.format}`);
  });
}
