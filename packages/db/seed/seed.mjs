// =============================================================================
// PCMS demo data generator.
// Deterministic (seeded) and realistic: 2 Groups, 5 PT, 10 Estates, 20 Divisions,
// 5 Mills, 15 Clinics, 1,000 Employees, 2,000 Patients, 30 Doctors, 50 Nurses,
// 200 Medicines and 20 Hospitals, plus ~6 months of clinical, pharmacy,
// occupational-health, accident, referral, ambulance and cost history.
// All names are fictitious. Runs as pcms_owner (bypasses RLS, audit muted).
// =============================================================================
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { fakerID_ID as faker } from '@faker-js/faker';
import { hash } from '@node-rs/argon2';
import { loadEnv } from '../scripts/env.mjs';
import {
  ICD10, DISEASE_MIX, RISK_CATEGORIES, POSITIONS, MILL_POSITIONS, LAB_TESTS, LAB_FOR_DX,
  MEDICINE_CATEGORIES, buildMedicineCatalogue, RX_FOR_DX, HOSPITALS,
} from './reference.mjs';

loadEnv();
faker.seed(20261009);
const DEMO_PASSWORD = process.env.PCMS_DEMO_PASSWORD || 'Demo@12345';

// Confidential doctor notes are stored encrypted (AES-256-GCM, same format as the API's encryptField).
// The key comes from FIELD_ENCRYPTION_KEY, or from apps/api/.env so seed and API always agree.
const FIELD_KEY = (() => {
  let k = process.env.FIELD_ENCRYPTION_KEY;
  const apiEnv = new URL('../../../apps/api/.env', import.meta.url);
  if (!k && existsSync(apiEnv)) k = readFileSync(apiEnv, 'utf8').match(/^FIELD_ENCRYPTION_KEY=(.+)$/m)?.[1]?.trim();
  const b = k ? Buffer.from(k, 'base64') : null;
  if (!b || b.length !== 32) { console.warn('! FIELD_ENCRYPTION_KEY not found: demo doctor notes are left out'); return null; }
  return b;
})();
function encryptNote(plain) {
  if (!plain || !FIELD_KEY) return null;
  const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', FIELD_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
const DAYS = 180;
const NOW = new Date();
const TODAY = isoDate(NOW);

// ------------------------------------------------------------------ helpers
function isoDate(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const int = (a, b) => faker.number.int({ min: a, max: b });
const pick = arr => arr[int(0, arr.length - 1)];
const chance = p => faker.number.float({ min: 0, max: 1 }) < p;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
function weighted(pairs) {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = faker.number.float({ min: 0, max: total });
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
function atTime(dateStr, h, m = 0) { return new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`); }
const ts = d => d.toISOString();
const phone = () => `08${int(11, 59)}-${int(1000, 9999)}-${int(1000, 9999)}`;

const PROVINCE_CODE = { 'Riau': '14', 'Jambi': '15', 'Kalimantan Tengah': '62', 'Sumatera Utara': '12', 'Sumatera Barat': '13' };
const usedNik = new Set();
function nik(province, birth, gender) {
  for (;;) {
    const d = new Date(birth); const day = d.getDate() + (gender === 'F' ? 40 : 0);
    const v = `${PROVINCE_CODE[province] || '14'}${String(int(1, 20)).padStart(2, '0')}${String(int(1, 15)).padStart(2, '0')}` +
      `${String(day).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getFullYear()).slice(2)}${String(int(1, 9999)).padStart(4, '0')}`;
    if (!usedNik.has(v)) { usedNik.add(v); return v; }
  }
}
function person(gender, minAge, maxAge, refDate = NOW) {
  const sex = gender === 'M' ? 'male' : 'female';
  const birth = faker.date.birthdate({ min: minAge, max: maxAge, mode: 'age', refDate });
  return { name: `${faker.person.firstName(sex)} ${faker.person.lastName(sex)}`.replace(/\s+/g, ' ').trim(), birth: isoDate(birth) };
}

// document numbers compatible with app.next_document_no(type, scope, period)
const seqs = new Map();
function docNo(tenant, type, scope, period, pad = 6) {
  const k = `${tenant}|${type}|${scope}|${period}`;
  const v = (seqs.get(k) || 0) + 1; seqs.set(k, v);
  return `${type}-${scope}-${period}-${String(v).padStart(pad, '0')}`;
}

// row buffers, inserted in this order
const ORDER = ['tenant', 'org_unit', 'clinic_profile', 'clinic_room', 'clinic_bed', 'clinic_asset', 'risk_category', 'job_position',
  'employee', 'app_user', 'user_role_assignment', 'family_member', 'medical_staff', 'staff_schedule', 'patient',
  'patient_history', 'medicine_category', 'medicine', 'patient_allergy', 'supplier', 'medicine_batch', 'inventory_level', 'inventory_transaction',
  'purchase_order', 'purchase_order_item', 'stock_transfer', 'stock_transfer_item', 'stock_opname', 'stock_opname_item',
  'hospital', 'lab_test', 'appointment', 'queue_ticket', 'accident', 'encounter', 'vital_sign', 'diagnosis', 'encounter_procedure',
  'prescription', 'prescription_item', 'lab_order', 'lab_result', 'referral', 'mcu', 'mcu_finding', 'health_assessment',
  'sick_leave', 'medical_certificate', 'ambulance', 'ambulance_trip', 'ambulance_maintenance', 'ambulance_fuel_log',
  'cost_transaction', 'inpatient_stay', 'notification', 'workflow_event'];
const R = Object.fromEntries(ORDER.map(t => [t, []]));
const add = (table, row) => { R[table].push(row); return row; };

// ------------------------------------------------------------------ organisation blueprint
// One group, two PTs. Each PT: Klinik Central (also serves the PKS and the head office) and six Rayon (= kebun) each with its own clinic.
const BLUEPRINT = [
  { code: 'KAS', name: 'Kalimantan Agro Sukses Group', legal: 'Kalimantan Agro Sukses Group', city: 'Sampit', province: 'Kalimantan Tengah', pts: [
    { code: 'BCPJ', name: 'PT Borneo Citra Persada Jaya', city: 'Sampit', province: 'Kalimantan Tengah', area: 'Kotawaringin Timur', lat: -2.42, lng: 112.78,
      mill: ['BCPJ-PKS', 'PKS Borneo Citra Persada Jaya'] },
    { code: 'BCPA', name: 'PT Borneo Citra Persada Abadi', city: 'Kuala Pembuang', province: 'Kalimantan Tengah', area: 'Seruyan', lat: -2.55, lng: 112.35,
      mill: ['BCPA-PKS', 'PKS Borneo Citra Persada Abadi'] },
  ] },
];
const RAYONS = ['A', 'B', 'C', 'D', 'E', 'F'];
const FULL = c => c.kind === 'ESTATE' || c.full;   // clinic with lab, inpatient beds, ambulance

const ctx = { tenants: [] };   // structured handles for later steps

function unit(tenant, parent, type, code, name, extra = {}) {
  return add('org_unit', { id: randomUUID(), tenant_id: tenant.id, parent_id: parent?.id ?? null, unit_type: type, code, name, status: 'ACTIVE', ...extra });
}

for (const bp of BLUEPRINT) {
  const tenant = add('tenant', { id: randomUUID(), code: bp.code, name: bp.name, legal_name: bp.legal, timezone: 'Asia/Jakarta',
    settings: { alert: { disease_spike_pct: 30, window_days: 14, near_expiry_days: 60 }, mcu: { reminder_days: 30 } } });
  const T = { tenant, code: bp.code, province: bp.province, pts: [], estates: [], mills: [], clinics: [], divisions: [], depts: [] };
  ctx.tenants.push(T);
  T.group = unit(tenant, null, 'GROUP', `${bp.code}-GRP`, bp.name, { city: bp.city, province: bp.province, address: `Jl. Jend. Sudirman No. ${int(10, 200)}, ${bp.city}` });
  T.warehouse = unit(tenant, T.group, 'WAREHOUSE', `${bp.code}-WH`, `Gudang Farmasi Pusat ${bp.name.split(' ')[0]} ${bp.name.split(' ')[1]}`, { city: bp.city, province: bp.province });

  for (const pt of bp.pts) {
    const company = unit(tenant, T.group, 'COMPANY', pt.code, pt.name, { city: pt.city, province: pt.province, address: `Jl. Raya ${pt.city} Km ${int(2, 15)}`, phone: phone() });
    const P = { company, code: pt.code, province: pt.province, estates: [] };
    T.pts.push(P);
    P.dept = unit(tenant, company, 'DEPARTMENT', `${pt.code}-HRGA`, `Departemen HR & GA ${pt.code}`, { city: pt.city, province: pt.province });
    T.depts.push(P.dept);

    RAYONS.forEach((L, i) => {
      const code = `${pt.code}-R${L}`, name = `Rayon ${L}`;
      const lat = round(pt.lat + (i % 3) * 0.08, 6), lng = round(pt.lng + Math.floor(i / 3) * 0.1 + (i % 3) * 0.03, 6);
      const estate = unit(tenant, company, 'ESTATE', code, name, { city: pt.area, province: pt.province, latitude: lat, longitude: lng, area_ha: int(3500, 7000),
        address: `Desa ${faker.location.city()}, Kec. ${faker.location.city()}, ${pt.area}` });
      const E = { estate, company, P, province: pt.province, divisions: [] };
      for (let d = 1; d <= 2; d++) {
        const div = unit(tenant, estate, 'DIVISION', `${code}-DIV${d}`, `Divisi ${['I', 'II'][d - 1]} ${name}`, { area_ha: int(1500, 3200), latitude: round(lat + d * 0.02, 6), longitude: round(lng + d * 0.02, 6) });
        E.divisions.push(div); T.divisions.push({ div, E });
      }
      E.clinic = unit(tenant, estate, 'CLINIC', `${code}-KLN`, `Klinik ${name}`, { city: pt.area, province: pt.province, phone: phone(), latitude: round(lat + 0.01, 6), longitude: round(lng + 0.01, 6),
        address: `Emplasmen ${name}, ${pt.name}, ${pt.area}` });
      T.estates.push(E); P.estates.push(E);
      T.clinics.push({ unit: E.clinic, kind: 'ESTATE', E, province: pt.province, company });
    });
    const [mcode, mname] = pt.mill;
    const mill = unit(tenant, company, 'MILL', mcode, mname, { city: pt.area, province: pt.province, latitude: round(pt.lat - 0.03, 6), longitude: round(pt.lng - 0.03, 6) });
    const central = unit(tenant, company, 'CLINIC', `${pt.code}-CENTRAL`, 'Klinik Central', { city: pt.city, province: pt.province, phone: phone(),
      latitude: round(pt.lat - 0.02, 6), longitude: round(pt.lng - 0.02, 6), address: `Kantor Pusat ${pt.name}, ${pt.city}` });
    const M = { mill, company, P, province: pt.province, clinic: central, estate: P.estates[0] };
    P.central = central;
    T.mills.push(M);
    T.clinics.push({ unit: central, kind: 'MILL', full: true, M, province: pt.province, company });
  }
}

// ------------------------------------------------------------------ clinics: profile, rooms, beds, assets
const HOURS = { mon: [['07:00', '15:00']], tue: [['07:00', '15:00']], wed: [['07:00', '15:00']], thu: [['07:00', '15:00']], fri: [['07:00', '11:30'], ['13:30', '15:00']], sat: [['07:00', '12:00']], sun: [] };
for (const T of ctx.tenants) {
  for (const C of T.clinics) {
    const estate = FULL(C);
    const status = C.unit.code === 'BCPA-RF-KLN' ? 'EMERGENCY_ONLY' : 'OPEN';
    add('clinic_profile', { id: C.unit.id, tenant_id: T.tenant.id, clinic_type: C.kind === 'ESTATE' ? 'PRIMARY' : 'MAIN', operational_status: status,
      license_no: `503/${int(100, 999)}/DPMPTSP/${2024 + int(0, 2)}`, license_valid_until: isoDate(addDays(NOW, int(200, 1500))),
      emergency_phone: phone(), bed_capacity: estate ? 6 : 2, has_pharmacy: true, has_laboratory: estate, has_inpatient: estate,
      operating_hours: { ...HOURS, emergency: '24h' },
      service_area_unit_ids: C.kind === 'ESTATE' ? C.E.divisions.map(d => d.id) : [C.M.mill.id, C.M.P.dept.id] });
    C.rooms = {};
    const rooms = estate ? [['REG', 'Pendaftaran', 'REGISTRATION'], ['TRI', 'Ruang Triase', 'TRIAGE'], ['K1', 'Ruang Periksa 1', 'CONSULTATION'], ['K2', 'Ruang Periksa 2', 'CONSULTATION'],
      ['UGD', 'Ruang Tindakan / UGD', 'EMERGENCY'], ['RI', 'Ruang Rawat Inap', 'INPATIENT'], ['APT', 'Apotek', 'PHARMACY'], ['LAB', 'Laboratorium', 'LABORATORY']]
      : [['REG', 'Pendaftaran', 'REGISTRATION'], ['K1', 'Ruang Periksa', 'CONSULTATION'], ['UGD', 'Ruang Tindakan', 'EMERGENCY'], ['OBS', 'Ruang Observasi', 'OBSERVATION'], ['APT', 'Apotek', 'PHARMACY']];
    for (const [code, name, type] of rooms) C.rooms[code] = add('clinic_room', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, code, name, room_type: type });
    C.beds = [];
    const bedRoom = C.rooms.RI || C.rooms.OBS;
    for (let b = 1; b <= (estate ? 6 : 2); b++) C.beds.push(add('clinic_bed', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, room_id: bedRoom.id, code: `BED-${b}`, bed_type: b === 1 ? 'OBSERVATION' : 'GENERAL', status: 'AVAILABLE' }));
    const assets = [['Tensimeter Digital', 'Diagnostik'], ['Stetoskop', 'Diagnostik'], ['Nebulizer', 'Terapi'], ['Oksigen Konsentrator', 'Terapi'], ['AED', 'Emergency'],
      ['Tabung Oksigen 6 m3', 'Emergency'], ['Minor Surgery Set', 'Tindakan'], ['Timbangan & Pengukur Tinggi', 'Diagnostik'], ['Lemari Pendingin Vaksin', 'Farmasi'], ['Pulse Oximeter', 'Diagnostik']];
    if (estate) assets.push(['Hematology Analyzer', 'Laboratorium'], ['Mikroskop Binokuler', 'Laboratorium'], ['EKG 12 Lead', 'Diagnostik'], ['Audiometer', 'Kesehatan Kerja'], ['Spirometer', 'Kesehatan Kerja']);
    assets.forEach(([name, cat], i) => {
      const pd = addDays(NOW, -int(100, 1500));
      add('clinic_asset', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, asset_code: `${C.unit.code}-AST-${String(i + 1).padStart(3, '0')}`, name, asset_class: 'MEDICAL_EQUIPMENT', category: cat,
        brand: pick(['Omron', 'Riester', 'Philips', 'Mindray', 'GEA', 'Littmann', 'Olympus', 'Contec']), serial_no: faker.string.alphanumeric({ length: 10, casing: 'upper' }),
        purchase_date: isoDate(pd), purchase_cost: int(2, 120) * 250000, status: chance(0.05) ? 'UNDER_MAINTENANCE' : 'IN_USE',
        last_calibration: isoDate(addDays(NOW, -int(10, 300))), next_maintenance: isoDate(addDays(NOW, int(-10, 180))) });
    });
  }
}

// ------------------------------------------------------------------ master data per tenant
const MED_CATALOGUE = buildMedicineCatalogue(200);
for (const T of ctx.tenants) {
  const tid = T.tenant.id;
  T.risk = {};
  for (const [code, name, level, hazards, interval, exams] of RISK_CATEGORIES)
    T.risk[code] = add('risk_category', { id: randomUUID(), tenant_id: tid, code, name, risk_level: level, hazards, mcu_interval_months: interval, required_exams: exams });
  T.pos = {};
  for (const [code, name, family, risk] of POSITIONS)
    T.pos[code] = add('job_position', { id: randomUUID(), tenant_id: tid, code, name, job_family: family, risk_category_id: T.risk[risk].id, _risk: risk });

  T.medCat = {};
  for (const c of MEDICINE_CATEGORIES) T.medCat[c] = add('medicine_category', { id: randomUUID(), tenant_id: tid, code: c, name: c.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, s => s.toUpperCase()) });
  T.meds = MED_CATALOGUE.map(m => add('medicine', { id: randomUUID(), tenant_id: tid, code: m.code, name: m.name, generic_name: m.generic, category_id: T.medCat[m.cat].id,
    dosage_form: m.form, strength: m.strength, unit: m.unit, drug_class: m.cls, is_fornas: chance(0.7), default_min_stock: m.minStock, standard_cost: m.cost,
    barcode: `899${faker.string.numeric(10)}`, _generic: m.generic, _cost: m.cost, _form: m.form }));
  T.medByGeneric = {};
  for (const m of T.meds) if (!T.medByGeneric[m._generic]) T.medByGeneric[m._generic] = m;

  T.suppliers = ['PT Kimia Farma Trading & Distribution', 'PT Anugerah Pharmindo Lestari', 'PT Enseval Putera Megatrading', 'PT Parit Padang Global', 'PT Bina San Prima', 'PT Antarmitra Sembada']
    .map((n, i) => add('supplier', { id: randomUUID(), tenant_id: tid, code: `SUP-${String(i + 1).padStart(3, '0')}`, name: n, npwp: faker.string.numeric(15), contact_name: person(pick(['M', 'F']), 30, 55).name, phone: phone(), email: `order${i + 1}@${T.code.toLowerCase()}-supplier.co.id`, address: faker.location.streetAddress() }));

  const hospitals = HOSPITALS;
  T.hospitals = hospitals.map(([name, type, cls, city, province], i) => add('hospital', { id: randomUUID(), tenant_id: tid, code: `RS-${String(i + 1).padStart(3, '0')}`, name, hospital_type: type, hospital_class: cls,
    is_partner: chance(0.6), is_bpjs: true, has_icu: cls === 'A' || cls === 'B', has_er: type !== 'LAB', city, province, phone: phone(), address: `Jl. ${faker.location.street()}, ${city}` }));

  T.labTests = {};
  for (const [code, name, cat, specimen, rtype, unitTxt, lm, hm, lf, hf, cl, ch, price] of LAB_TESTS)
    T.labTests[code] = add('lab_test', { id: randomUUID(), tenant_id: tid, code, name, category: cat, specimen, result_type: rtype, unit: unitTxt, ref_low_m: lm, ref_high_m: hm, ref_low_f: lf, ref_high_f: hf, critical_low: cl, critical_high: ch, price, _ref: [lm, hm, lf, hf] });
}

// ------------------------------------------------------------------ employees & families
const EMP_PLAN = { KAS: { perEstate: 74, perMill: 40, perDept: 16 } };
const fieldPositions = POSITIONS.filter(p => p[4] > 0).map(p => [p[0], p[4]]);
for (const T of ctx.tenants) {
  T.employees = [];
  let n = 0;
  const mk = (orgUnit, posCode, E, primaryClinic, province) => {
    n++;
    const gender = ['PEMANEN', 'PENYEMPROT', 'DRIVER', 'OPERATOR_AB', 'MEKANIK', 'SATPAM', 'OPERATOR_PKS', 'TEKNISI_BOILER', 'MANDOR'].includes(posCode) ? (chance(0.93) ? 'M' : 'F')
      : posCode === 'PENGUTIP' || posCode === 'PEMUPUK' ? (chance(0.55) ? 'F' : 'M') : (chance(0.6) ? 'M' : 'F');
    const p = person(gender, 19, 56);
    const joinMin = addDays(new Date(p.birth), 365 * 18 + 30);
    const join = faker.date.between({ from: joinMin < addDays(NOW, -365 * 20) ? addDays(NOW, -365 * 20) : joinMin, to: addDays(NOW, -10) });
    const pos = T.pos[posCode];
    const emp = add('employee', { id: randomUUID(), tenant_id: T.tenant.id, employee_no: `${T.code}-${String(n).padStart(5, '0')}`, nik: nik(province, p.birth, gender),
      full_name: p.name, gender, birth_date: p.birth, birth_place: faker.location.city(), marital_status: weighted([['MARRIED', 70], ['SINGLE', 25], ['DIVORCED', 3], ['WIDOWED', 2]]),
      address: `Perumahan Karyawan ${orgUnit.name}, Blok ${pick('ABCDEFGH')}-${int(1, 40)}`, phone: chance(0.85) ? phone() : null,
      org_unit_id: orgUnit.id, position_id: pos.id,
      employment_type: weighted([['PERMANENT', 55], ['CONTRACT', 25], ['DAILY_WORKER', 18], ['SEASONAL', 2]]), employment_status: 'ACTIVE',
      join_date: isoDate(join), bpjs_kesehatan_no: faker.string.numeric(13), bpjs_ketenagakerjaan_no: faker.string.numeric(11),
      insurance_provider: chance(0.3) ? pick(['Asuransi Jiwa Inhealth', 'Mandiri Inhealth', 'AXA Mandiri']) : null,
      emergency_contact_name: person(pick(['M', 'F']), 20, 60).name, emergency_contact_phone: phone(), emergency_contact_relation: pick(['Istri', 'Suami', 'Orang Tua', 'Saudara']),
      _pos: posCode, _risk: pos._risk, _clinic: primaryClinic, _E: E, _province: province });
    T.employees.push(emp);
    return emp;
  };
  for (const E of T.estates) {
    const C = T.clinics.find(c => c.unit.id === E.clinic.id);
    for (let i = 0; i < EMP_PLAN[T.code].perEstate; i++) mk(E.divisions[i % 2], weighted(fieldPositions), E, C, E.province);
  }
  for (const M of T.mills) {
    const C = T.clinics.find(c => c.unit.id === M.clinic.id);
    for (let i = 0; i < EMP_PLAN[T.code].perMill; i++) mk(M.mill, weighted(MILL_POSITIONS), M.estate, C, M.province);
  }
  for (const P of T.pts) {
    const C = T.clinics.find(c => c.unit.id === P.central.id);   // head-office staff use Klinik Central
    for (let i = 0; i < EMP_PLAN[T.code].perDept; i++) mk(P.dept, pick(['STAF_KANTOR', 'STAF_KANTOR', 'ASISTEN', 'KRANI', 'SATPAM']), P.estates[0], C, P.province);
  }
  // families
  T.families = [];
  for (const e of T.employees) {
    if (e.marital_status === 'MARRIED') {
      const g = e.gender === 'M' ? 'F' : 'M';
      const age = new Date(e.birth_date).getFullYear();
      const p = person(g, Math.max(19, NOW.getFullYear() - age - 6), Math.min(60, NOW.getFullYear() - age + 4));
      T.families.push(add('family_member', { id: randomUUID(), tenant_id: T.tenant.id, employee_id: e.id, relationship: 'SPOUSE', nik: nik(e._province, p.birth, g), full_name: p.name, gender: g, birth_date: p.birth, phone: chance(0.5) ? phone() : null, bpjs_kesehatan_no: faker.string.numeric(13), is_dependent: true, _emp: e }));
      const kids = weighted([[0, 15], [1, 30], [2, 35], [3, 20]]);
      for (let k = 0; k < kids; k++) {
        const kg = pick(['M', 'F']); const kp = person(kg, 0, 17);
        T.families.push(add('family_member', { id: randomUUID(), tenant_id: T.tenant.id, employee_id: e.id, relationship: 'CHILD', nik: chance(0.8) ? nik(e._province, kp.birth, kg) : null, full_name: `${kp.name.split(' ')[0]} ${e.full_name.split(' ').slice(-1)[0]}`, gender: kg, birth_date: kp.birth, bpjs_kesehatan_no: faker.string.numeric(13), is_dependent: true, _emp: e }));
      }
    }
  }
}

// ------------------------------------------------------------------ medical staff (30 doctors, 50 nurses, 15 pharmacists, 10 drivers)
for (const T of ctx.tenants) {
  T.staff = [];
  for (const C of T.clinics) {
    const estate = FULL(C);
    C.doctors = []; C.nurses = []; C.pharmacists = []; C.drivers = [];
    const mkStaff = (type, list, prefix, suffix) => {
      const g = type === 'DOCTOR' ? pick(['M', 'F']) : type === 'NURSE' ? (chance(0.65) ? 'F' : 'M') : type === 'AMBULANCE_DRIVER' ? 'M' : pick(['M', 'F']);
      const p = person(g, 25, 55);
      const s = add('medical_staff', { id: randomUUID(), tenant_id: T.tenant.id, home_clinic_id: C.unit.id, staff_type: type, full_name: p.name, title_prefix: prefix, title_suffix: suffix,
        specialty: type === 'DOCTOR' ? (list.length === 0 && estate && chance(0.4) ? 'Kedokteran Okupasi' : 'Dokter Umum') : null,
        str_no: ['DOCTOR', 'NURSE', 'PHARMACIST'].includes(type) ? faker.string.numeric(16) : null, str_valid_until: isoDate(addDays(NOW, int(-20, 1500))),
        sip_no: ['DOCTOR', 'NURSE', 'PHARMACIST'].includes(type) ? `SIP/${int(100, 999)}/${int(2023, 2026)}` : null, sip_valid_until: isoDate(addDays(NOW, int(30, 1500))),
        phone: phone(), status: 'ACTIVE', _gender: g });
      list.push(s); T.staff.push(s); return s;
    };
    for (let i = 0; i < 2; i++) { const d = mkStaff('DOCTOR', C.doctors, 'dr.', null); if (d.specialty === 'Kedokteran Okupasi') d.title_suffix = 'Sp.Ok'; }
    for (let i = 0; i < (estate ? 4 : 2); i++) mkStaff('NURSE', C.nurses, null, chance(0.6) ? 'S.Kep., Ns.' : 'A.Md.Kep');
    mkStaff('PHARMACIST', C.pharmacists, 'apt.', 'S.Farm');
    if (estate) mkStaff('AMBULANCE_DRIVER', C.drivers, null, null);
    // schedules: Mon–Sat, doctor 1 morning, doctor 2 alternating days
    C.doctors.forEach((d, i) => {
      for (let wd = 1; wd <= 6; wd++) {
        if (i === 1 && wd % 2 === 0 && estate) continue;
        add('staff_schedule', { id: randomUUID(), tenant_id: T.tenant.id, staff_id: d.id, clinic_id: C.unit.id, weekday: wd, start_time: wd === 6 ? '07:00' : '07:30', end_time: wd === 6 ? '12:00' : '15:00', quota: estate ? 40 : 25, valid_from: isoDate(addDays(NOW, -DAYS - 10)) });
      }
    });
  }
}

// ------------------------------------------------------------------ users & role assignments
const PASSWORD_HASH = await hash(DEMO_PASSWORD, { algorithm: 2 });
const ROLE_IDS = {};   // filled from DB later (system roles exist from migration 0010)
const DEMO_USERS = [];
function user(T, username, fullName, homeUnit, roles, extra = {}) {
  const u = add('app_user', { id: randomUUID(), tenant_id: T.tenant.id, home_unit_id: homeUnit.id, username, email: `${username}@demo.pcms.local`, full_name: fullName,
    password_hash: PASSWORD_HASH, must_change_password: false, status: 'ACTIVE', locale: 'id', ...extra });
  for (const [role, scope] of roles) add('user_role_assignment', { id: randomUUID(), tenant_id: T.tenant.id, user_id: u.id, _role: role, scope_unit_id: scope.id, reason: 'Demo seed', valid_from: ts(addDays(NOW, -DAYS - 30)) });
  DEMO_USERS.push({ tenant: T.code, username, role: roles.map(r => r[0]).join(', '), scope: roles.map(r => r[1].name).join(', ') });
  return u;
}
for (const T of ctx.tenants) {
  const t = T.code.toLowerCase();
  const nm = () => person(pick(['M', 'F']), 30, 55).name;
  T.users = {};
  T.users.superadmin = user(T, `${t}.superadmin`, nm(), T.group, [['SUPER_ADMIN', T.group]]);
  T.users.groupadmin = user(T, `${t}.groupadmin`, nm(), T.group, [['GROUP_ADMIN', T.group]]);
  T.users.corporate = user(T, `${t}.corporate`, nm(), T.group, [['CORPORATE_MGMT', T.group]]);
  T.users.meddirector = user(T, `${t}.meddirector`, `dr. ${nm()}, MKK`, T.group, [['MEDICAL_DIRECTOR', T.group]]);
  for (const P of T.pts) {
    const p = P.code.toLowerCase();
    T.users[`medmanager.${p}`] = user(T, `${t}.medmanager.${p}`, `dr. ${nm()}`, P.company, [['MEDICAL_MANAGER', P.company]]);
    T.users[`hrmanager.${p}`] = user(T, `${t}.hrmanager.${p}`, nm(), P.company, [['HR_MANAGER', P.company]]);
    T.users[`hsemanager.${p}`] = user(T, `${t}.hsemanager.${p}`, nm(), P.company, [['HSE_MANAGER', P.company]]);
    T.users[`ptadmin.${p}`] = user(T, `${t}.ptadmin.${p}`, nm(), P.company, [['PT_ADMIN', P.company]]);
    T.users[`finance.${p}`] = user(T, `${t}.finance.${p}`, nm(), P.company, [['FINANCE', P.company]]);
  }
  for (const E of T.estates) {
    const e = E.estate.code.toLowerCase();
    T.users[`estate.${e}`] = user(T, `${t}.estate.${e}`, nm(), E.estate, [['ESTATE_MANAGER', E.estate]]);
    T.users[`hrofficer.${e}`] = user(T, `${t}.hrofficer.${e}`, nm(), E.estate, [['HR_OFFICER', E.estate]]);
    T.users[`hseofficer.${e}`] = user(T, `${t}.hseofficer.${e}`, nm(), E.estate, [['HSE_OFFICER', E.estate]]);
  }
  for (const C of T.clinics) {
    const c = C.unit.code.toLowerCase();
    // the senior doctor is also the clinic manager → two assignments, one user
    const head = C.doctors[0];
    head._user = user(T, `${t}.dr.${c}`, `dr. ${head.full_name}`, C.unit, [['DOCTOR', C.unit], ['CLINIC_MANAGER', C.unit]]);
    const d2 = C.doctors[1];
    d2._user = user(T, `${t}.dr2.${c}`, `dr. ${d2.full_name}`, C.unit, [['DOCTOR', C.unit]]);
    C.nurses.forEach((s, i) => { s._user = user(T, `${t}.nurse${i + 1}.${c}`, s.full_name, C.unit, [['NURSE', C.unit]]); });
    C.pharmacists.forEach(s => { s._user = user(T, `${t}.apt.${c}`, `apt. ${s.full_name}`, C.unit, [['PHARMACIST', C.unit]]); });
    C.drivers.forEach(s => { s._user = user(T, `${t}.driver.${c}`, s.full_name, C.unit, [['AMBULANCE_DRIVER', C.unit]]); });
    if (FULL(C)) user(T, `${t}.mro.${c}`, nm(), C.unit, [['MEDICAL_RECORD_OFFICER', C.unit]]);
    C.manager = head._user;
  }
  // warehouse pharmacist (central stock)
  T.users.warehouse = user(T, `${t}.warehouse`, `apt. ${nm()}`, T.warehouse, [['PHARMACIST', T.warehouse]]);
  // employee self-service account linked to an employee
  const emp = T.employees[0];
  T.users.employee = user(T, `${t}.employee`, emp.full_name, { id: emp.org_unit_id }, [['EMPLOYEE_PATIENT', T.group]], { employee_id: emp.id });
}
for (const T of ctx.tenants) for (const s of T.staff) if (s._user) s.user_id = s._user.id;

// ------------------------------------------------------------------ patients (2,000)
let mrnByTenant = {};
for (const T of ctx.tenants) {
  T.patients = [];
  const regYear = NOW.getFullYear();
  const P = (row) => { const p = add('patient', { id: randomUUID(), tenant_id: T.tenant.id, mrn: docNo(T.code, 'RM', T.code, regYear), qr_token: undefined, ...row }); delete p.qr_token; T.patients.push(p); return p; };
  for (const e of T.employees) {
    e._patient = P({ patient_type: 'EMPLOYEE', employee_id: e.id, primary_clinic_id: e._clinic.unit.id, nik: e.nik, full_name: e.full_name, gender: e.gender, birth_date: e.birth_date,
      blood_type: weighted([['O+', 38], ['A+', 26], ['B+', 28], ['AB+', 6], ['UNKNOWN', 2]]), phone: e.phone, address: e.address, payer_type: 'COMPANY', bpjs_kesehatan_no: e.bpjs_kesehatan_no,
      _emp: e, _clinic: e._clinic, _risk: e._risk });
  }
  const famTarget = 910;
  const fams = faker.helpers.shuffle(T.families).slice(0, famTarget);
  for (const f of fams) {
    f._patient = P({ patient_type: f.relationship === 'SPOUSE' ? 'SPOUSE' : 'CHILD', family_member_id: f.id, primary_clinic_id: f._emp._clinic.unit.id, nik: f.nik, full_name: f.full_name, gender: f.gender,
      birth_date: f.birth_date, blood_type: 'UNKNOWN', phone: f.phone, address: f._emp.address, payer_type: 'COMPANY', bpjs_kesehatan_no: f.bpjs_kesehatan_no, _emp: f._emp, _clinic: f._emp._clinic });
  }
  const contractors = 60, visitors = 30;
  for (let i = 0; i < contractors + visitors; i++) {
    const C = pick(T.clinics); const g = chance(0.85) ? 'M' : 'F'; const p = person(g, 20, 55);
    const contractor = i < contractors;
    P({ patient_type: contractor ? 'CONTRACTOR' : 'VISITOR', primary_clinic_id: C.unit.id, nik: nik(C.province, p.birth, g), full_name: p.name, gender: g, birth_date: p.birth, blood_type: 'UNKNOWN',
      phone: phone(), address: faker.location.streetAddress(), payer_type: contractor ? 'OTHER' : 'SELF',
      contractor_company: contractor ? pick(['CV Karya Tani Mandiri', 'PT Borneo Konstruksi', 'CV Angkut Sawit Jaya', 'PT Tunas Jaya Kontraktor', 'CV Mitra Perawatan Kebun']) : null, _clinic: C });
  }
  // allergies & history
  for (const p of T.patients) {
    if (chance(0.06)) {
      const drug = chance(0.7);
      const med = drug ? T.medByGeneric[pick(['Amoxicillin', 'Cotrimoxazole', 'Asam Mefenamat', 'Ibuprofen', 'Ciprofloxacin', 'Metamizole'].filter(g => T.medByGeneric[g]))] : null;
      add('patient_allergy', { id: randomUUID(), tenant_id: T.tenant.id, patient_id: p.id, allergen_type: drug ? 'DRUG' : pick(['FOOD', 'ENVIRONMENT']), allergen: drug ? med._generic : pick(['Udang', 'Kacang', 'Debu', 'Sengatan tawon', 'Telur']),
        medicine_id: med?.id ?? null, reaction: pick(['Gatal & ruam', 'Urtikaria', 'Bengkak pada bibir', 'Sesak napas ringan']), severity: weighted([['MILD', 50], ['MODERATE', 35], ['SEVERE', 13], ['LIFE_THREATENING', 2]]) });
    }
    const age = NOW.getFullYear() - new Date(p.birth_date).getFullYear();
    if (age > 35 && chance(0.12)) { p._chronic = 'I10'; add('patient_history', { id: randomUUID(), tenant_id: T.tenant.id, patient_id: p.id, history_type: 'CHRONIC', icd10_code: 'I10', description: 'Hipertensi esensial, kontrol rutin', onset_date: isoDate(addDays(NOW, -int(200, 2000))) }); }
    if (age > 40 && chance(0.06)) { p._chronic2 = 'E11.9'; add('patient_history', { id: randomUUID(), tenant_id: T.tenant.id, patient_id: p.id, history_type: 'CHRONIC', icd10_code: 'E11.9', description: 'Diabetes melitus tipe 2', onset_date: isoDate(addDays(NOW, -int(200, 2000))) }); }
  }
}

// ------------------------------------------------------------------ clinical activity simulation
const COMPLAINT = {
  'J06.9': 'Batuk pilek dan demam ringan sejak {d} hari', 'J00': 'Hidung tersumbat, bersin-bersin', 'J02.9': 'Nyeri menelan sejak {d} hari', 'M79.1': 'Pegal-pegal dan nyeri otot seluruh badan setelah bekerja',
  'K29.7': 'Nyeri ulu hati, mual, kembung', 'K30': 'Perut terasa penuh dan perih', 'I10': 'Kontrol tekanan darah, kadang pusing', 'M54.5': 'Nyeri pinggang saat membungkuk/mengangkat',
  'R51': 'Sakit kepala sejak {d} hari', 'L24.9': 'Gatal dan kemerahan pada tangan/lengan', 'L23.9': 'Ruam gatal setelah kontak bahan kimia', 'L30.9': 'Kulit gatal dan bersisik',
  'B35.9': 'Gatal melingkar di lipatan paha/badan', 'A09': 'BAB cair {d}x sejak kemarin', 'R50.9': 'Demam sejak {d} hari', 'H10.9': 'Mata merah dan berair', 'E11.9': 'Kontrol gula darah',
  'K08.8': 'Sakit gigi geraham', 'T14.1': 'Luka robek terkena dodos/egrek saat panen', 'S61.0': 'Jari tertusuk duri sawit / terluka parang', 'T14.0': 'Luka lecet terjatuh di blok',
  'M62.6': 'Nyeri otot bahu setelah mengangkat TBS', 'B54': 'Demam menggigil berkala {d} hari', 'A90': 'Demam tinggi mendadak {d} hari, nyeri sendi', 'T63.4': 'Disengat tawon saat bekerja di blok',
  'T15.9': 'Mata kelilipan serpihan saat memanen', 'N39.0': 'Nyeri saat BAK', 'E78.5': 'Kontrol kolesterol', 'M25.5': 'Nyeri sendi lutut', 'J45.9': 'Sesak napas kambuh', 'R42': 'Pusing berputar',
  'B86': 'Gatal terutama malam hari', 'D64.9': 'Lemas dan mudah lelah', 'T78.4': 'Biduran setelah makan seafood', 'L50.9': 'Bentol-bentol gatal', 'J30.4': 'Bersin pagi hari',
};
const INJURY_DX = new Set(['T14.1', 'S61.0', 'T14.0', 'M62.6', 'T63.4', 'T15.9']);
const dxWeights = new Map(DISEASE_MIX);

function chooseDx(T, clinic, patient, day, daysAgo) {
  let pairs = DISEASE_MIX;
  const isEmployee = !!patient.employee_id;
  if (!isEmployee) pairs = pairs.filter(([c]) => !INJURY_DX.has(c));
  const adj = pairs.map(([c, w]) => {
    let f = 1;
    // Early-warning demo 1: ISPA outbreak at Klinik Sei Rokan in the last 14 days
    if (c === 'J06.9' && clinic.unit.code === 'BCPJ-RA-KLN' && daysAgo < 14) f = 4;
    // Early-warning demo 2: dermatitis among sprayers rising in the last 30 days
    if ((c === 'L24.9' || c === 'L23.9') && patient._risk === 'SPRAYER') f = daysAgo < 30 ? 9 : 3;
    // rainy-season malaria/dengue bump for Kalimantan
    if ((c === 'B54' || c === 'A90') && clinic.province === 'Kalimantan Tengah') f = 2.5;
    if (c === 'I10' && patient._chronic === 'I10') f = 25;
    if (c === 'E11.9' && patient._chronic2 === 'E11.9') f = 25;
    if (INJURY_DX.has(c) && ['PEMANEN', 'PENGUTIP', 'PERAWATAN'].includes(patient._emp?._pos)) f *= 2;
    return [c, w * f];
  });
  return weighted(adj);
}

const ICD_TITLE = Object.fromEntries(ICD10.map(r => [r[0], r[2]]));
const stockUse = new Map();              // `${unitId}|${medId}` → qty dispensed
const dispenseQueue = [];                // dispense txns to place after opening stock
const visitsPerDay = c => (c.full ? 4.5 : c.kind === 'ESTATE' ? 4.2 : 2.6);

for (const T of ctx.tenants) {
  const patientsByClinic = new Map();
  for (const p of T.patients) { const k = p.primary_clinic_id; if (!patientsByClinic.has(k)) patientsByClinic.set(k, []); patientsByClinic.get(k).push(p); }
  T.encounters = [];
  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
    const day = addDays(NOW, -daysAgo);
    const dstr = isoDate(day);
    const dow = day.getDay();
    for (const C of T.clinics) {
      const pool = patientsByClinic.get(C.unit.id) || [];
      if (!pool.length) continue;
      let n = Math.round(visitsPerDay(C) * (dow === 0 ? 0.25 : dow === 6 ? 0.6 : 1) * faker.number.float({ min: 0.6, max: 1.4 }));
      if (C.unit.code === 'BCPA-RF-KLN') n = Math.round(n * 0.4);   // emergency-only clinic
      if (C.unit.code === 'BCPJ-RA-KLN' && daysAgo < 14) n = Math.round(n * 1.3); // outbreak drives extra visits
      let qn = 0;
      const pfx = { NORMAL: 'A', PRIORITY: 'P', EMERGENCY: 'E' };
      const qcount = { A: 0, P: 0, E: 0 };
      for (let v = 0; v < n; v++) {
        const patient = chance(0.92) ? pick(pool) : pick(T.patients);
        const dx = chooseDx(T, C, patient, day, daysAgo);
        const injury = INJURY_DX.has(dx);
        const priority = injury && chance(0.35) ? 'EMERGENCY' : (NOW.getFullYear() - new Date(patient.birth_date).getFullYear() > 60 || chance(0.05)) ? 'PRIORITY' : 'NORMAL';
        qn++; const code = `${pfx[priority]}-${String(++qcount[pfx[priority]]).padStart(3, '0')}`;
        // today's tickets are placed before "now" (later tickets registered more recently) so waits are never negative
        const reg = daysAgo === 0 ? new Date(NOW.getTime() - Math.round((1 - v / Math.max(1, n)) * 360 + 130 + int(0, 20)) * 60000)
                                  : atTime(dstr, int(7, 13), int(0, 59));
        const triage = new Date(reg.getTime() + int(3, 20) * 60000);
        const cs = new Date(triage.getTime() + int(5, 45) * 60000);
        const ce = new Date(cs.getTime() + int(7, 25) * 60000);
        const ph = new Date(ce.getTime() + int(1, 5) * 60000);
        const done = new Date(ph.getTime() + int(5, 20) * 60000);
        // today: leave the tail of the queue in progress so the live queue board has data
        let status = 'COMPLETED';
        if (daysAgo === 0) {
          const r = v / Math.max(1, n);
          status = r > 0.85 ? 'WAITING' : r > 0.75 ? 'TRIAGE' : r > 0.68 ? 'WAITING_DOCTOR' : r > 0.6 ? 'IN_CONSULTATION' : r > 0.52 ? 'PHARMACY' : 'COMPLETED';
        }
        if (chance(0.015) && daysAgo > 0) status = 'CANCELLED';
        const doctor = pick(C.doctors); const nurse = pick(C.nurses);
        const q = add('queue_ticket', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, patient_id: patient.id, visit_date: dstr, queue_no: qn, queue_code: code,
          source: injury && patient.employee_id && chance(0.5) ? 'ACCIDENT' : patient._chronic && dx === 'I10' ? 'FOLLOW_UP' : 'WALK_IN', priority,
          triage_level: priority === 'EMERGENCY' ? pick(['RED', 'YELLOW']) : 'GREEN', status, assigned_staff_id: doctor.id, room_id: (C.rooms.K1).id,
          registered_at: ts(reg),
          triage_at: ['WAITING', 'CANCELLED'].includes(status) ? null : ts(triage),
          consult_start_at: ['WAITING', 'TRIAGE', 'WAITING_DOCTOR', 'CANCELLED'].includes(status) ? null : ts(cs),
          consult_end_at: ['COMPLETED', 'PHARMACY'].includes(status) ? ts(ce) : null,
          pharmacy_at: ['COMPLETED', 'PHARMACY'].includes(status) ? ts(ph) : null,
          completed_at: status === 'COMPLETED' ? ts(done) : null,
          cancelled_at: status === 'CANCELLED' ? ts(triage) : null, cancel_reason: status === 'CANCELLED' ? 'Pasien pulang sebelum dipanggil' : null,
          created_at: ts(reg) });
        if (['WAITING', 'TRIAGE', 'CANCELLED'].includes(status)) continue;
        const signed = ['COMPLETED', 'PHARMACY'].includes(status);
        const enc = add('encounter', { id: randomUUID(), tenant_id: T.tenant.id, encounter_no: docNo(T.code, 'ENC', C.unit.code, dstr.slice(0, 7).replace('-', '')),
          clinic_id: C.unit.id, patient_id: patient.id, queue_ticket_id: q.id, doctor_id: doctor.id, nurse_id: nurse.id,
          encounter_type: priority === 'EMERGENCY' ? 'EMERGENCY' : q.source === 'FOLLOW_UP' ? 'FOLLOW_UP' : 'OUTPATIENT',
          started_at: ts(status === 'WAITING_DOCTOR' ? triage : cs), ended_at: signed ? ts(ce) : null,
          chief_complaint: (COMPLAINT[dx] || 'Keluhan umum').replace('{d}', int(1, 4)),
          history_of_present_illness: status === 'WAITING_DOCTOR' ? null : `Keluhan dirasakan sejak ${int(1, 7)} hari. ${pick(['Sudah minum obat warung, belum membaik.', 'Belum berobat sebelumnya.', 'Keluhan serupa pernah dialami.', 'Tidak ada riwayat alergi obat yang diketahui.'])}`,
          physical_exam: status === 'WAITING_DOCTOR' ? null : `KU baik, kesadaran CM. ${injury ? 'Tampak luka pada regio yang dikeluhkan, perdarahan aktif minimal.' : 'Pemeriksaan fisik dalam batas normal kecuali yang berkaitan dengan keluhan.'}`,
          assessment: status === 'WAITING_DOCTOR' ? null : ICD_TITLE[dx], plan: status === 'WAITING_DOCTOR' ? null : pick(['Terapi simptomatik, edukasi, kontrol bila keluhan menetap.', 'Medikamentosa, istirahat cukup, kontrol 3 hari.', 'Edukasi APD dan kebersihan, terapi sesuai resep.']),
          doctor_notes: chance(0.2) ? encryptNote(pick(['Pasien kooperatif.', 'Disarankan pemeriksaan lanjutan bila tidak membaik.', 'Evaluasi kepatuhan minum obat.'])) : null,
          disposition: signed ? (injury && chance(0.3) ? 'REST' : 'HOME') : null, follow_up_date: chance(0.15) ? isoDate(addDays(day, int(3, 14))) : null,
          is_work_related: injury && !!patient.employee_id, status: signed ? 'SIGNED' : 'OPEN', signed_at: signed ? ts(ce) : null, signed_by: signed ? doctor.id : null,
          created_at: ts(triage), _dx: dx, _day: dstr, _daysAgo: daysAgo, _patient: patient, _clinic: C, _doctor: doctor, _injury: injury });
        T.encounters.push(enc);
        const sys = patient._chronic === 'I10' || dx === 'I10' ? int(140, 175) : int(105, 135);
        add('vital_sign', { id: randomUUID(), tenant_id: T.tenant.id, encounter_id: enc.id, recorded_at: ts(triage), recorded_by: nurse.id, systolic: sys, diastolic: sys - int(35, 55),
          heart_rate: int(64, 100), respiratory_rate: int(16, 22), temperature_c: ['R50.9', 'A90', 'B54', 'J06.9'].includes(dx) ? round(faker.number.float({ min: 37.5, max: 39.6 }), 1) : round(faker.number.float({ min: 36.2, max: 37.2 }), 1),
          spo2: int(95, 99), weight_kg: round(faker.number.float({ min: 45, max: 85 }), 1), height_cm: round(faker.number.float({ min: 150, max: 178 }), 1),
          blood_glucose: patient._chronic2 ? int(140, 260) : null, pain_score: injury ? int(3, 7) : int(0, 4), created_at: ts(triage) });
        if (status === 'WAITING_DOCTOR') continue;
        add('diagnosis', { id: randomUUID(), tenant_id: T.tenant.id, encounter_id: enc.id, icd10_code: dx, diagnosis_type: 'PRIMARY', certainty: 'CONFIRMED',
          is_occupational: injury || ((dx === 'L24.9' || dx === 'L23.9') && patient._risk === 'SPRAYER'), created_at: ts(cs) });
        if (chance(0.12)) add('diagnosis', { id: randomUUID(), tenant_id: T.tenant.id, encounter_id: enc.id, icd10_code: pick(['R51', 'R05', 'R42', 'K30']), diagnosis_type: 'SECONDARY', certainty: 'CONFIRMED', created_at: ts(cs) });
        if (injury) add('encounter_procedure', { id: randomUUID(), tenant_id: T.tenant.id, encounter_id: enc.id, procedure_code: dx === 'S61.0' ? '86.59' : '93.57',
          description: dx === 'S61.0' || dx === 'T14.1' ? 'Hecting / jahit luka + perawatan luka' : dx === 'T15.9' ? 'Irigasi mata, ekstraksi benda asing' : 'Perawatan luka / kompres', performed_by: pick([doctor, nurse]).id, performed_at: ts(cs) });
        // prescription
        if (status === 'IN_CONSULTATION') continue;
        const generics = (RX_FOR_DX[dx] || ['Paracetamol', 'Vitamin B Complex']).filter(() => chance(0.85));
        if (!generics.length) generics.push('Vitamin B Complex');
        const dispensed = status === 'COMPLETED';
        const pharmacist = C.pharmacists[0];
        const rx = add('prescription', { id: randomUUID(), tenant_id: T.tenant.id, prescription_no: docNo(T.code, 'RX', C.unit.code, dstr.slice(0, 7).replace('-', '')), clinic_id: C.unit.id, encounter_id: enc.id,
          patient_id: patient.id, prescriber_id: doctor.id, prescribed_at: ts(ce), status: dispensed ? 'DISPENSED' : 'SUBMITTED', dispensed_by: dispensed ? pharmacist.id : null, dispensed_at: dispensed ? ts(done) : null, created_at: ts(ce) });
        let rxCost = 0;
        for (const g of generics) {
          const med = T.medByGeneric[g]; if (!med) continue;
          const form = med._form;
          const qty = ['TABLET', 'CAPSULE'].includes(form) ? pick([6, 9, 10, 12, 15]) : form === 'CONSUMABLE' ? int(1, 3) : form === 'INJECTION' ? 1 : 1;
          add('prescription_item', { id: randomUUID(), tenant_id: T.tenant.id, prescription_id: rx.id, medicine_id: med.id, qty, dose: med.strength || '1', frequency: pick(['3x1', '2x1', '1x1', '3x1 bila perlu']),
            route: ['CREAM', 'OINTMENT'].includes(form) ? 'TOPICAL' : form === 'DROPS' ? (g.includes('Mata') || g === 'Kloramfenikol' ? 'OPHTHALMIC' : 'TOPICAL') : form === 'INJECTION' ? 'IM' : form === 'INHALER' ? 'INHALATION' : form === 'CONSUMABLE' ? 'OTHER' : 'ORAL',
            duration_days: ['TABLET', 'CAPSULE'].includes(form) ? int(3, 5) : null, instructions: pick(['Sesudah makan', 'Sebelum makan', 'Oleskan tipis 2x sehari', null]), dispensed_qty: dispensed ? qty : 0, created_at: ts(ce) });
          if (dispensed) {
            const k = `${C.unit.id}|${med.id}`;
            stockUse.set(k, (stockUse.get(k) || 0) + qty);
            dispenseQueue.push({ T, unit: C.unit, med, qty, at: done, rx, patient, enc });
            rxCost += qty * med._cost;
          }
        }
        if (dispensed && rxCost > 0) {
          enc._medCost = rxCost;
        }
      }
    }
  }
}

// ------------------------------------------------------------------ batches & opening stock sized from simulated usage
const batchOf = new Map();       // medId → { main, short }
for (const T of ctx.tenants) {
  for (const m of T.meds) {
    const sup = pick(T.suppliers);
    const main = add('medicine_batch', { id: randomUUID(), tenant_id: T.tenant.id, medicine_id: m.id, batch_no: `${faker.string.alpha({ length: 2, casing: 'upper' })}${faker.string.numeric(6)}`,
      expiry_date: isoDate(addDays(NOW, int(240, 900))), manufacture_date: isoDate(addDays(NOW, -int(200, 500))), supplier_id: sup.id, unit_cost: m._cost });
    const short = chance(0.12) ? add('medicine_batch', { id: randomUUID(), tenant_id: T.tenant.id, medicine_id: m.id, batch_no: `${faker.string.alpha({ length: 2, casing: 'upper' })}${faker.string.numeric(6)}`,
      expiry_date: isoDate(addDays(NOW, chance(0.35) ? -int(3, 40) : int(5, 55))), manufacture_date: isoDate(addDays(NOW, -int(600, 800))), supplier_id: sup.id, unit_cost: round(m._cost * 0.95) }) : null;
    batchOf.set(m.id, { main, short });
  }
}

const openingAt = addDays(NOW, -DAYS - 2);
const lowPairs = new Set();
for (const T of ctx.tenants) {
  T.levels = new Map();
  for (const C of T.clinics) {
    // clinic formulary: everything used + ~60 others
    const used = T.meds.filter(m => stockUse.has(`${C.unit.id}|${m.id}`));
    const others = faker.helpers.shuffle(T.meds.filter(m => !stockUse.has(`${C.unit.id}|${m.id}`))).slice(0, 60);
    for (const m of [...used, ...others]) {
      const usage = stockUse.get(`${C.unit.id}|${m.id}`) || 0;
      const monthly = usage / (DAYS / 30);
      const min = Math.max(m._form === 'TABLET' || m._form === 'CAPSULE' ? 30 : 3, Math.round(monthly * 0.6));
      add('inventory_level', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: C.unit.id, medicine_id: m.id, min_qty: min, max_qty: min * 4 });
      const low = usage > 0 && chance(0.03);
      if (low) lowPairs.add(`${C.unit.id}|${m.id}`);
      const qty = Math.ceil(usage + (low ? int(0, Math.max(1, Math.round(min * 0.5))) : min * faker.number.float({ min: 1.5, max: 3.5 })));
      if (qty > 0) add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', C.unit.code, String(openingAt.getFullYear())), org_unit_id: C.unit.id, medicine_id: m.id,
        batch_id: batchOf.get(m.id).main.id, txn_type: 'OPENING', qty, unit_cost: m._cost, reason: 'Saldo awal implementasi PCMS', txn_at: ts(openingAt), created_at: ts(openingAt) });
    }
  }
  // central warehouse opening stock: all 200 items
  for (const m of T.meds) {
    const qty = ['TABLET', 'CAPSULE'].includes(m._form) ? int(3000, 15000) : int(50, 400);
    add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', T.warehouse.code, String(openingAt.getFullYear())), org_unit_id: T.warehouse.id, medicine_id: m.id,
      batch_id: batchOf.get(m.id).main.id, txn_type: 'OPENING', qty, unit_cost: m._cost, reason: 'Saldo awal gudang pusat', txn_at: ts(openingAt), created_at: ts(openingAt) });
  }
}

// dispense transactions (chronological) + medicine cost rows
dispenseQueue.sort((a, b) => a.at - b.at);
for (const d of dispenseQueue) {
  add('inventory_transaction', { id: randomUUID(), tenant_id: d.T.tenant.id, txn_no: docNo(d.T.code, 'INV', d.unit.code, String(d.at.getFullYear())), org_unit_id: d.unit.id, medicine_id: d.med.id,
    batch_id: batchOf.get(d.med.id).main.id, txn_type: 'DISPENSE', qty: -d.qty, unit_cost: d.med._cost, ref_type: 'prescription', ref_id: d.rx.id, txn_at: ts(d.at), created_at: ts(d.at) });
}
for (const T of ctx.tenants) {
  for (const e of T.encounters) {
    if (!e._medCost) continue;
    add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: e.clinic_id, charged_unit_id: e._patient._emp?.org_unit_id ?? e.clinic_id, cost_category: 'MEDICINE', amount: round(e._medCost),
      txn_date: e._day, patient_id: e.patient_id, employee_id: e._patient._emp?.id ?? null, icd10_code: e._dx, source_type: 'prescription', source_id: null, payer_type: 'COMPANY', description: `Obat ${e.encounter_no}`, created_at: e.ended_at || e.started_at });
  }
}

// ------------------------------------------------------------------ purchase orders, transfers, opname
for (const T of ctx.tenants) {
  const wh = T.users.warehouse;
  for (let i = 0; i < 15; i++) {
    const daysAgo = int(5, DAYS - 5); const d = addDays(NOW, -daysAgo);
    const status = daysAgo < 12 ? pick(['SUBMITTED', 'APPROVED']) : weighted([['RECEIVED', 85], ['CANCELLED', 5], ['PARTIALLY_RECEIVED', 10]]);
    const po = add('purchase_order', { id: randomUUID(), tenant_id: T.tenant.id, po_no: docNo(T.code, 'PO', T.code, String(d.getFullYear())), org_unit_id: T.warehouse.id, supplier_id: pick(T.suppliers).id,
      order_date: isoDate(d), expected_date: isoDate(addDays(d, 7)), status, approved_by: status !== 'SUBMITTED' ? T.users.meddirector.id : null, approved_at: status !== 'SUBMITTED' ? ts(addDays(d, 1)) : null, created_by: wh.id, created_at: ts(d) });
    let total = 0;
    for (const m of faker.helpers.shuffle(T.meds).slice(0, int(4, 10))) {
      const q = ['TABLET', 'CAPSULE'].includes(m._form) ? int(10, 50) * 100 : int(20, 200);
      const rec = status === 'RECEIVED' ? q : status === 'PARTIALLY_RECEIVED' ? Math.floor(q / 2) : 0;
      total += q * m._cost;
      add('purchase_order_item', { id: randomUUID(), tenant_id: T.tenant.id, purchase_order_id: po.id, medicine_id: m.id, qty_ordered: q, qty_received: rec, unit_price: m._cost });
      if (rec > 0) add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', T.warehouse.code, String(d.getFullYear())), org_unit_id: T.warehouse.id, medicine_id: m.id,
        batch_id: batchOf.get(m.id).main.id, txn_type: 'RECEIPT', qty: rec, unit_cost: m._cost, ref_type: 'purchase_order', ref_id: po.id, txn_at: ts(addDays(d, 6)), created_by: wh.id, created_at: ts(addDays(d, 6)) });
    }
    po.total_amount = round(total);
  }
  // inter-site transfers warehouse → clinics (short-expiry batches end up in clinics → expiry alerts)
  for (let i = 0; i < 20; i++) {
    const C = pick(T.clinics); const daysAgo = int(1, 90); const d = addDays(NOW, -daysAgo);
    const status = daysAgo < 3 ? pick(['REQUESTED', 'APPROVED', 'IN_TRANSIT']) : weighted([['RECEIVED', 80], ['REJECTED', 8], ['CANCELLED', 4], ['IN_TRANSIT', 8]]);
    const tr = add('stock_transfer', { id: randomUUID(), tenant_id: T.tenant.id, transfer_no: docNo(T.code, 'TRF', T.code, String(d.getFullYear())), from_unit_id: T.warehouse.id, to_unit_id: C.unit.id, status,
      priority: chance(0.2) ? 'URGENT' : 'NORMAL', requested_by: T.users[`apt`]?.id ?? C.pharmacists[0]._user.id, requested_at: ts(d),
      approved_by: ['APPROVED', 'IN_TRANSIT', 'RECEIVED'].includes(status) ? wh.id : null, approved_at: ['APPROVED', 'IN_TRANSIT', 'RECEIVED'].includes(status) ? ts(addDays(d, 0.2)) : null,
      shipped_by: ['IN_TRANSIT', 'RECEIVED'].includes(status) ? wh.id : null, shipped_at: ['IN_TRANSIT', 'RECEIVED'].includes(status) ? ts(addDays(d, 0.5)) : null,
      received_by: status === 'RECEIVED' ? C.pharmacists[0]._user.id : null, received_at: status === 'RECEIVED' ? ts(addDays(d, 1.5)) : null,
      reject_reason: status === 'REJECTED' ? 'Stok gudang dialokasikan untuk kebutuhan darurat' : null, created_by: C.pharmacists[0]._user.id, created_at: ts(d) });
    for (const m of faker.helpers.shuffle(T.meds.filter(x => batchOf.get(x.id).short)).slice(0, int(1, 3)).concat(faker.helpers.shuffle(T.meds).slice(0, int(1, 3)))) {
      const b = batchOf.get(m.id).short && chance(0.7) ? batchOf.get(m.id).short : batchOf.get(m.id).main;
      const q = ['TABLET', 'CAPSULE'].includes(m._form) ? int(1, 5) * 100 : int(5, 30);
      const moved = ['IN_TRANSIT', 'RECEIVED'].includes(status);
      add('stock_transfer_item', { id: randomUUID(), tenant_id: T.tenant.id, stock_transfer_id: tr.id, medicine_id: m.id, batch_id: moved ? b.id : null, qty_requested: q,
        qty_approved: ['APPROVED', 'IN_TRANSIT', 'RECEIVED'].includes(status) ? q : null, qty_shipped: moved ? q : null, qty_received: status === 'RECEIVED' ? q : null });
      if (moved && b === batchOf.get(m.id).short) {
        // short batches are only in clinics via transfer → need a receipt at warehouse first
        add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', T.warehouse.code, String(d.getFullYear())), org_unit_id: T.warehouse.id, medicine_id: m.id, batch_id: b.id, txn_type: 'RECEIPT', qty: q, unit_cost: b.unit_cost, ref_type: 'purchase_order', reason: 'Penerimaan batch', txn_at: ts(addDays(d, -1)), created_at: ts(addDays(d, -1)) });
      }
      if (moved) add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', T.warehouse.code, String(d.getFullYear())), org_unit_id: T.warehouse.id, medicine_id: m.id, batch_id: b.id, txn_type: 'TRANSFER_OUT', qty: -q, unit_cost: b.unit_cost, ref_type: 'stock_transfer', ref_id: tr.id, txn_at: ts(addDays(d, 0.5)), created_at: ts(addDays(d, 0.5)) });
      if (status === 'RECEIVED') add('inventory_transaction', { id: randomUUID(), tenant_id: T.tenant.id, txn_no: docNo(T.code, 'INV', C.unit.code, String(d.getFullYear())), org_unit_id: C.unit.id, medicine_id: m.id, batch_id: b.id, txn_type: 'TRANSFER_IN', qty: q, unit_cost: b.unit_cost, ref_type: 'stock_transfer', ref_id: tr.id, txn_at: ts(addDays(d, 1.5)), created_at: ts(addDays(d, 1.5)) });
    }
    if (status === 'REQUESTED') add('workflow_event', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: C.unit.id, module: 'INVENTORY', entity_type: 'stock_transfer', entity_id: tr.id, from_status: null, to_status: 'REQUESTED', note: 'Permintaan obat ke gudang pusat', actor_id: tr.requested_by, occurred_at: ts(d) });
  }
}

// ------------------------------------------------------------------ lab orders & results
for (const T of ctx.tenants) {
  for (const e of T.encounters) {
    const tests = LAB_FOR_DX[e._dx];
    if (tests && e._clinic.unit && e.status === 'OPEN' && e._day === isoDate(NOW)) {
      // today's open consultations: leave the lab orders pending so the lab worklist has live work
      const at = new Date(e.started_at);
      const order = add('lab_order', { id: randomUUID(), tenant_id: T.tenant.id, order_no: docNo(T.code, 'LAB', e._clinic.unit.code, e._day.slice(0, 7).replace('-', '')), clinic_id: e.clinic_id, patient_id: e.patient_id,
        encounter_id: e.id, ordered_by: e.doctor_id, ordered_at: ts(at), priority: e.encounter_type === 'EMERGENCY' ? 'STAT' : 'ROUTINE', status: chance(0.5) ? 'ORDERED' : 'COLLECTED', clinical_info: e.assessment, created_at: ts(at) });
      for (const code of tests) add('lab_result', { id: randomUUID(), tenant_id: T.tenant.id, lab_order_id: order.id, lab_test_id: T.labTests[code].id, created_at: ts(at) });
      continue;
    }
    if (!tests || !e._clinic.unit || !FULL(e._clinic) || e.status !== 'SIGNED' || !chance(0.7)) continue;
    const at = new Date(e.started_at);
    const order = add('lab_order', { id: randomUUID(), tenant_id: T.tenant.id, order_no: docNo(T.code, 'LAB', e._clinic.unit.code, e._day.slice(0, 7).replace('-', '')), clinic_id: e.clinic_id, patient_id: e.patient_id,
      encounter_id: e.id, ordered_by: e.doctor_id, ordered_at: ts(at), priority: e.encounter_type === 'EMERGENCY' ? 'STAT' : 'ROUTINE', status: 'VERIFIED', clinical_info: e.assessment, created_at: ts(at) });
    let cost = 0;
    for (const code of tests) {
      const t = T.labTests[code]; cost += t.price;
      const [lm, hm, lf, hf] = t._ref; const fem = e._patient.gender === 'F';
      const lo = fem ? (lf ?? lm) : lm, hi = fem ? (hf ?? hm) : hm;
      let vn = null, vt = null;
      if (t.result_type === 'NUMERIC') {
        const abnormal = (code === 'GDS' || code === 'GDP') && e._dx === 'E11.9' ? 0.8 : (code === 'TROMBO' && e._dx === 'A90') ? 0.7 : (code === 'CHOL' && e._dx === 'E78.5') ? 0.8 : 0.12;
        vn = chance(abnormal) ? round(chance(0.5) || code === 'TROMBO' && e._dx !== 'A90' ? hi * faker.number.float({ min: 1.05, max: 1.6 }) : lo * faker.number.float({ min: 0.5, max: 0.95 }), 1)
          : round(faker.number.float({ min: lo + (hi - lo) * 0.1, max: hi - (hi - lo) * 0.1 }), 1);
        if (code === 'TROMBO' && e._dx === 'A90' && chance(0.7)) vn = int(40, 140);
      } else if (t.result_type === 'POS_NEG') vt = (code === 'MAL' && e._dx === 'B54') || (code === 'NS1' && e._dx === 'A90') ? 'POSITIF' : 'NEGATIF';
      else vt = code === 'UL' ? (e._dx === 'N39.0' ? 'Leukosit urin +2, nitrit positif' : 'Dalam batas normal') : 'Lihat lampiran';
      add('lab_result', { id: randomUUID(), tenant_id: T.tenant.id, lab_order_id: order.id, lab_test_id: t.id, value_numeric: vn, value_text: vt,
        flag: vt ? (vt.startsWith('POSITIF') ? 'POSITIVE' : vt.startsWith('NEGATIF') ? 'NEGATIVE' : vt.includes('+') ? 'ABNORMAL' : 'NORMAL') : undefined,
        resulted_at: ts(addDays(at, 0.05)), resulted_by: e.nurse_id, verified_at: ts(addDays(at, 0.08)), verified_by: e.doctor_id, created_at: ts(addDays(at, 0.05)) });
    }
    add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: e.clinic_id, charged_unit_id: e._patient._emp?.org_unit_id ?? e.clinic_id, cost_category: 'LAB', amount: cost, txn_date: e._day,
      patient_id: e.patient_id, employee_id: e._patient._emp?.id ?? null, icd10_code: e._dx, source_type: 'lab_order', source_id: order.id, description: `Laboratorium ${order.order_no}`, created_at: ts(at) });
  }
}

// ------------------------------------------------------------------ accidents (≈150), referrals (≈300), sick leave, certificates
const BODY = { 'T14.1': ['Tangan', 'Lengan bawah', 'Tungkai bawah'], 'S61.0': ['Jari tangan'], 'T14.0': ['Lutut', 'Siku', 'Telapak tangan'], 'M62.6': ['Bahu', 'Punggung'], 'T63.4': ['Wajah', 'Lengan'], 'T15.9': ['Mata'] };
const INJ = { 'T14.1': 'Luka robek (laserasi)', 'S61.0': 'Luka tusuk duri sawit', 'T14.0': 'Luka lecet', 'M62.6': 'Strain otot', 'T63.4': 'Sengatan serangga', 'T15.9': 'Benda asing di mata' };
const ACT = { PEMANEN: 'HARVESTING', PENGUTIP: 'HARVESTING', PERAWATAN: 'PRUNING', PENYEMPROT: 'SPRAYING', PEMUPUK: 'MANURING', DRIVER: 'TRANSPORT', OPERATOR_AB: 'TRANSPORT', MEKANIK: 'WORKSHOP', OPERATOR_PKS: 'MILL_PROCESSING', TEKNISI_BOILER: 'MAINTENANCE', SATPAM: 'SECURITY_PATROL' };
for (const T of ctx.tenants) {
  T.accidents = [];
  const injuryEnc = T.encounters.filter(e => e._injury && e._patient.employee_id && e.status === 'SIGNED');
  const chosen = faker.helpers.shuffle(injuryEnc).slice(0, 90);
  const mkAccident = (e, emp, occurred, kind) => {
    const daysAgo = Math.floor((NOW - occurred) / 86400000);
    const severity = kind === 'NEAR_MISS' ? 'MINOR' : weighted([['MINOR', 60], ['MODERATE', 28], ['SERIOUS', 10], ['MAJOR', 2]]);
    const lost = severity === 'MINOR' ? (chance(0.04) ? 1 : 0) : severity === 'MODERATE' ? (chance(0.5) ? int(1, 3) : 0) : int(5, 30);
    const status = daysAgo < 3 ? pick(['REPORTED', 'FIRST_AID', 'MEDICAL_TREATMENT']) : daysAgo < 10 ? pick(['INVESTIGATION', 'PENDING_APPROVAL', 'FOLLOW_UP']) : daysAgo < 25 && lost > 3 ? 'RETURN_TO_WORK' : 'CLOSED';
    const needsApproval = severity !== 'MINOR' && ['FOLLOW_UP', 'RETURN_TO_WORK', 'CLOSED'].includes(status);
    const unitId = emp.org_unit_id;
    const P = T.pts.find(p => p.company.id === emp._E.company.id);
    const a = add('accident', { id: randomUUID(), tenant_id: T.tenant.id, incident_no: docNo(T.code, 'ACC', P.code, String(occurred.getFullYear())), org_unit_id: unitId, clinic_id: emp._clinic.unit.id,
      employee_id: emp.id, patient_id: emp._patient.id, victim_name: emp.full_name, occurred_at: ts(occurred), reported_at: ts(new Date(occurred.getTime() + int(10, 90) * 60000)),
      location_detail: emp._pos === 'OPERATOR_PKS' || emp._pos === 'TEKNISI_BOILER' ? pick(['Stasiun Rebusan', 'Stasiun Press', 'Boiler House', 'Loading Ramp']) : `Blok ${pick('ABCDEFGHJK')}${int(1, 40)} - ${pick(['TM', 'TBM'])}`,
      activity: ACT[emp._pos] || 'OTHER', incident_type: kind === 'NEAR_MISS' ? 'NEAR_MISS' : e?._dx === 'T63.4' ? 'ANIMAL_BITE' : 'INJURY', severity,
      injury_type: e ? INJ[e._dx] : null, body_part: e ? pick(BODY[e._dx]) : null,
      immediate_cause: kind === 'NEAR_MISS' ? pick(['Pelepah jatuh di dekat pekerja', 'Truk hampir terguling di jalan licin', 'Selang semprot bocor']) : pick(['Tidak menggunakan sarung tangan', 'Egrek terpeleset dari pelepah', 'Terpeleset di jalan licin', 'Tertusuk duri saat mengangkat TBS', 'Serpihan beterbangan saat memotong pelepah', 'Sarang tawon tidak terlihat']),
      root_cause: ['CLOSED', 'RETURN_TO_WORK', 'FOLLOW_UP', 'PENDING_APPROVAL'].includes(status) ? pick(['Kepatuhan APD rendah', 'Kondisi lapangan basah setelah hujan', 'Kurangnya briefing pagi', 'Alat kerja tumpul / tidak layak']) : null,
      first_aid_given: kind !== 'NEAR_MISS', first_aid_detail: kind !== 'NEAR_MISS' ? 'Pembersihan luka dan balut tekan oleh P3K divisi' : null, first_aid_by: kind !== 'NEAR_MISS' ? 'Petugas P3K Divisi' : null,
      treatment_summary: e ? 'Ditangani di klinik, perawatan luka dan obat' : null, encounter_id: e?.id ?? null, lost_time_days: kind === 'NEAR_MISS' ? 0 : lost,
      investigation_findings: ['CLOSED', 'RETURN_TO_WORK', 'FOLLOW_UP', 'PENDING_APPROVAL'].includes(status) ? 'Investigasi selesai, ditemukan faktor perilaku dan kondisi tidak aman.' : null,
      corrective_action: ['CLOSED', 'RETURN_TO_WORK', 'FOLLOW_UP'].includes(status) ? pick(['Safety talk ulang & inspeksi APD harian', 'Penggantian alat kerja', 'Penambahan rambu dan perbaikan jalan']) : null,
      status, approved_by: needsApproval ? T.users[`hsemanager.${P.code.toLowerCase()}`].id : null, approved_at: needsApproval ? ts(addDays(occurred, 5)) : null,
      return_to_work_date: lost > 0 && ['RETURN_TO_WORK', 'CLOSED'].includes(status) ? isoDate(addDays(occurred, lost + 1)) : null,
      closed_at: status === 'CLOSED' ? ts(addDays(occurred, Math.max(7, lost + 3))) : null, reported_by: T.users[`hseofficer.${emp._E.estate.code.toLowerCase()}`]?.id ?? null, created_at: ts(occurred),
      _emp: emp, _lost: lost, _status: status, _P: P });
    if (e) { e.accident_id = a.id; }
    T.accidents.push(a);
    return a;
  };
  for (const e of chosen) mkAccident(e, e._patient._emp, new Date(new Date(e.started_at).getTime() - int(20, 120) * 60000), 'INJURY');
  const fieldEmps = T.employees.filter(x => ['PEMANEN', 'PENYEMPROT', 'DRIVER', 'OPERATOR_PKS', 'OPERATOR_AB'].includes(x._pos));
  for (let i = 0; i < 14; i++) mkAccident(null, pick(fieldEmps), atTime(isoDate(addDays(NOW, -int(1, DAYS))), int(7, 15), int(0, 59)), 'NEAR_MISS');

  // referrals: serious accidents + ~3% of other encounters
  T.referrals = [];
  const signed = T.encounters.filter(e => e.status === 'SIGNED');
  const refCandidates = signed.filter(e => (e.accident_id && T.accidents.find(a => a.id === e.accident_id)?.severity !== 'MINOR') || ['A90', 'B54', 'I10', 'E11.9', 'J45.9', 'R50.9', 'N39.0'].includes(e._dx));
  for (const e of faker.helpers.shuffle(refCandidates).slice(0, 200)) {
    const d = new Date(e.started_at); const daysAgo = e._daysAgo;
    const hosp = pick(T.hospitals.filter(h => h.hospital_type !== 'LAB'));
    const status = daysAgo < 2 ? pick(['ISSUED', 'AT_HOSPITAL']) : daysAgo < 7 ? pick(['IN_TREATMENT', 'INPATIENT', 'FOLLOW_UP']) : weighted([['RETURNED', 45], ['CLOSED', 50], ['CANCELLED', 5]]);
    const admitted = ['A90', 'B54'].includes(e._dx) ? chance(0.6) : chance(0.15);
    const cost = admitted ? int(30, 180) * 100000 : int(3, 25) * 100000;
    const r = add('referral', { id: randomUUID(), tenant_id: T.tenant.id, referral_no: docNo(T.code, 'REF', e._clinic.unit.code, String(d.getFullYear())), clinic_id: e.clinic_id, patient_id: e.patient_id, encounter_id: e.id,
      accident_id: e.accident_id ?? null, hospital_id: hosp.id, referring_doctor_id: e.doctor_id, referral_date: e._day, urgency: e.accident_id || e._dx === 'A90' ? 'URGENT' : 'ROUTINE', icd10_code: e._dx,
      reason: pick(['Memerlukan pemeriksaan penunjang lanjutan', 'Memerlukan penanganan dokter spesialis', 'Kondisi tidak membaik dengan terapi klinik', 'Memerlukan rawat inap']),
      specialty_needed: pick(['Penyakit Dalam', 'Bedah', 'Orthopedi', 'Mata', 'Saraf', 'Anak']), transport_mode: e.accident_id ? 'AMBULANCE' : pick(['AMBULANCE', 'COMPANY_VEHICLE', 'PRIVATE']),
      status, hospital_diagnosis: ['RETURNED', 'CLOSED', 'FOLLOW_UP'].includes(status) ? ICD_TITLE[e._dx] : null, treatment_summary: ['RETURNED', 'CLOSED'].includes(status) ? 'Tatalaksana di RS selesai, kembali ke klinik untuk kontrol' : null,
      admitted, admission_date: admitted ? e._day : null, discharge_date: admitted && ['RETURNED', 'CLOSED', 'FOLLOW_UP'].includes(status) ? isoDate(addDays(d, int(2, 6))) : null,
      estimated_cost: cost, actual_cost: ['RETURNED', 'CLOSED'].includes(status) ? round(cost * faker.number.float({ min: 0.8, max: 1.3 }), 0) : null, payer_type: chance(0.7) ? 'BPJS' : 'COMPANY',
      follow_up_date: ['FOLLOW_UP', 'RETURNED'].includes(status) ? isoDate(addDays(d, 10)) : null, returned_at: ['RETURNED', 'CLOSED'].includes(status) ? ts(addDays(d, int(3, 9))) : null, created_at: ts(d), _e: e });
    e.disposition = 'REFERRED';
    T.referrals.push(r);
    if (r.actual_cost && r.payer_type === 'COMPANY') add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: e.clinic_id, charged_unit_id: e._patient._emp?.org_unit_id ?? e.clinic_id, cost_category: 'HOSPITAL', amount: r.actual_cost,
      txn_date: isoDate(new Date(r.returned_at)), patient_id: e.patient_id, employee_id: e._patient._emp?.id ?? null, icd10_code: e._dx, source_type: 'referral', source_id: r.id, payer_type: 'COMPANY', description: `Biaya RS ${hosp.name} (${r.referral_no})`, created_at: r.returned_at });
    if (r.status !== 'CANCELLED') add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: e.clinic_id, charged_unit_id: e._patient._emp?.org_unit_id ?? e.clinic_id, cost_category: 'REFERRAL', amount: int(2, 8) * 50000,
      txn_date: e._day, patient_id: e.patient_id, employee_id: e._patient._emp?.id ?? null, icd10_code: e._dx, source_type: 'referral', source_id: r.id, payer_type: 'COMPANY', description: `Administrasi & transport rujukan ${r.referral_no}`, created_at: ts(d) });
  }

  // sick leave
  for (const e of signed) {
    const emp = e._patient._emp; if (!emp || e._patient.patient_type !== 'EMPLOYEE') continue;
    const acc = e.accident_id ? T.accidents.find(a => a.id === e.accident_id) : null;
    const p = acc ? (acc._lost > 0 ? 1 : 0) : ['A90', 'B54', 'R50.9', 'A09'].includes(e._dx) ? 0.6 : ['J06.9', 'M54.5'].includes(e._dx) ? 0.1 : 0.03;
    if (!chance(p)) continue;
    const days = acc ? Math.max(1, acc._lost) : ['A90', 'B54'].includes(e._dx) ? int(3, 7) : int(1, 3);
    const start = e._day; const end = isoDate(addDays(new Date(e._day), days - 1));
    const sl = add('sick_leave', { id: randomUUID(), tenant_id: T.tenant.id, certificate_no: docNo(T.code, 'SKS', e._clinic.unit.code, e._day.slice(0, 4)), clinic_id: e.clinic_id, patient_id: e.patient_id, employee_id: emp.id,
      employee_unit_id: emp.org_unit_id, encounter_id: e.id, accident_id: acc?.id ?? null, leave_type: acc ? 'WORK_ACCIDENT_LEAVE' : days <= 1 && chance(0.3) ? 'REST_RECOMMENDATION' : 'SICK_LEAVE', start_date: start, end_date: end,
      issued_by: e.doctor_id, issued_at: e.ended_at, status: e._daysAgo > 2 ? 'ACKNOWLEDGED' : 'ISSUED', hr_acknowledged_by: e._daysAgo > 2 ? T.users[`hrofficer.${emp._E.estate.code.toLowerCase()}`].id : null,
      hr_acknowledged_at: e._daysAgo > 2 ? ts(addDays(new Date(e.ended_at), 1)) : null, admin_remarks: 'Istirahat sesuai rekomendasi dokter', created_at: e.ended_at });
    e.disposition = e.disposition === 'REFERRED' ? 'REFERRED' : 'REST';
    if (days > 3 && e._daysAgo > days) {
      const rtw = isoDate(addDays(new Date(e._day), days));
      add('medical_certificate', { id: randomUUID(), tenant_id: T.tenant.id, certificate_no: docNo(T.code, 'SKD', e._clinic.unit.code, rtw.slice(0, 4)), clinic_id: e.clinic_id, patient_id: e.patient_id, employee_id: emp.id, employee_unit_id: emp.org_unit_id,
        encounter_id: e.id, certificate_type: 'RETURN_TO_WORK', fit_status: chance(0.85) ? 'FIT' : 'FIT_WITH_RESTRICTION', restrictions: null, purpose: 'Kembali bekerja setelah sakit', valid_from: rtw, valid_until: isoDate(addDays(new Date(rtw), 30)),
        issued_by: e.doctor_id, issued_at: ts(atTime(rtw, 8)), created_at: ts(atTime(rtw, 8)) }).restrictions = null;
      if (acc) add('health_assessment', { id: randomUUID(), tenant_id: T.tenant.id, assessment_no: docNo(T.code, 'HA', e._clinic.unit.code, rtw.slice(0, 4)), clinic_id: e.clinic_id, employee_id: emp.id, employee_unit_id: emp.org_unit_id,
        assessment_type: 'POST_ACCIDENT', encounter_id: e.id, accident_id: acc.id, fit_status: 'FIT', valid_from: rtw, valid_until: isoDate(addDays(new Date(rtw), 90)), assessed_by: e.doctor_id, assessed_at: ts(atTime(rtw, 8)), status: 'ACTIVE', created_at: ts(atTime(rtw, 8)) });
    }
  }
  for (const mc of R.medical_certificate) if (mc.fit_status === 'FIT_WITH_RESTRICTION' && !mc.restrictions) mc.restrictions = 'Pekerjaan ringan selama 7 hari, hindari mengangkat beban > 10 kg';
  // general medical certificates (health statements, fit-to-work for drivers)
  for (const e of faker.helpers.shuffle(signed.filter(x => x._patient.employee_id)).slice(0, 120)) {
    const emp = e._patient._emp;
    const type = emp._pos === 'DRIVER' || emp._pos === 'OPERATOR_AB' ? 'FIT_TO_WORK' : pick(['MEDICAL_CERTIFICATE', 'HEALTH_STATEMENT']);
    add('medical_certificate', { id: randomUUID(), tenant_id: T.tenant.id, certificate_no: docNo(T.code, 'SKD', e._clinic.unit.code, e._day.slice(0, 4)), clinic_id: e.clinic_id, patient_id: e.patient_id, employee_id: emp.id, employee_unit_id: emp.org_unit_id,
      encounter_id: e.id, certificate_type: type, fit_status: type === 'FIT_TO_WORK' ? 'FIT' : null, purpose: type === 'FIT_TO_WORK' ? 'Persyaratan SIM / izin operasional unit' : pick(['Persyaratan administrasi', 'Keterangan sehat untuk pelatihan']),
      valid_from: e._day, valid_until: isoDate(addDays(new Date(e._day), 90)), issued_by: e.doctor_id, issued_at: e.ended_at, created_at: e.ended_at });
  }
}

// ------------------------------------------------------------------ MCU programme
const FINDING_TEXT = {
  PHYSICAL: ['Dalam batas normal', 'Obesitas grade I'], VISUS: ['6/6 ODS', '6/9 OD, 6/6 OS'], COLOR_BLIND: ['Tidak buta warna', 'Buta warna parsial'], AUDIOMETRY: ['Normal', 'Penurunan ringan 4 kHz bilateral'],
  SPIROMETRY: ['Normal', 'Restriksi ringan'], XRAY_THORAX: ['Cor & pulmo normal', 'Bronkitis'], ECG: ['Sinus rhythm normal', 'LVH'], CHOLINESTERASE: ['Normal (> 75% baseline)', 'Menurun (< 70% baseline)'],
  HEMATOLOGY: ['Normal', 'Anemia ringan'], LIVER_FUNCTION: ['Normal', 'SGPT meningkat ringan'], KIDNEY_FUNCTION: ['Normal', 'Kreatinin meningkat ringan'], BLOOD_GLUCOSE: ['Normal', 'Hiperglikemia'],
  LIPID_PROFILE: ['Normal', 'Dislipidemia'], DRUG_SCREEN: ['Negatif', 'Negatif'], MUSCULOSKELETAL: ['Normal', 'Nyeri punggung bawah mekanik'], DERMATOLOGY: ['Normal', 'Dermatitis kontak ringan'], PSYCHOLOGY: ['Normal', 'Stres ringan'],
};
const FINDING_ICD = { AUDIOMETRY: 'H83.3', SPIROMETRY: 'J68.0', CHOLINESTERASE: 'T60.0', HEMATOLOGY: 'D64.9', BLOOD_GLUCOSE: 'E11.9', LIPID_PROFILE: 'E78.5', MUSCULOSKELETAL: 'M54.5', DERMATOLOGY: 'L24.9', XRAY_THORAX: 'J68.0', PHYSICAL: null };
for (const T of ctx.tenants) {
  for (const emp of T.employees) {
    const risk = T.risk[emp._risk]; const interval = risk.mcu_interval_months;
    const P = T.pts.find(p => p.company.id === emp._E.company.id);
    const C = emp._clinic; const examiner = C.doctors.find(d => d.specialty === 'Kedokteran Okupasi') || C.doctors[0];
    const joined = new Date(emp.join_date);
    const mk = (type, examDate, status) => {
      const due = examDate || isoDate(addDays(NOW, int(-20, 30)));
      const fit = status === 'COMPLETED' ? weighted([['FIT', 84], ['FIT_WITH_RESTRICTION', 11], ['TEMPORARILY_UNFIT', 4], ['UNFIT', 1]]) : null;
      const m = add('mcu', { id: randomUUID(), tenant_id: T.tenant.id, mcu_no: docNo(T.code, 'MCU', P.code, (examDate || due).slice(0, 4)), clinic_id: C.unit.id, employee_id: emp.id, patient_id: emp._patient.id,
        employee_unit_id: emp.org_unit_id, position_id: emp.position_id, risk_category_id: risk.id, mcu_type: type, due_date: due, scheduled_date: status === 'PLANNED' ? null : (examDate || due),
        exam_date: status === 'COMPLETED' ? examDate : null, status, examiner_id: status === 'COMPLETED' ? examiner.id : null, fit_status: fit,
        restrictions: fit === 'FIT_WITH_RESTRICTION' ? pick(['Tidak bekerja di ketinggian', 'Tidak menyemprot pestisida selama 3 bulan', 'Wajib APD pelindung telinga', 'Tidak mengoperasikan kendaraan malam hari']) : fit === 'TEMPORARILY_UNFIT' ? 'Tidak bekerja sampai evaluasi ulang' : null,
        valid_until: status === 'COMPLETED' ? isoDate(addDays(new Date(examDate), interval * 30)) : null, next_due_date: status === 'COMPLETED' ? isoDate(addDays(new Date(examDate), interval * 30)) : null,
        completed_at: status === 'COMPLETED' ? ts(atTime(examDate, 14)) : null, created_at: ts(atTime(examDate || isoDate(addDays(NOW, -30)), 8)) });
      if (status === 'COMPLETED') {
        for (const exam of risk.required_exams) {
          let abnormal = fit !== 'FIT' ? chance(0.5) : chance(0.08);
          if (exam === 'CHOLINESTERASE' && emp._risk === 'SPRAYER') abnormal = chance(fit === 'FIT' ? 0.1 : 0.7);
          if (exam === 'DERMATOLOGY' && emp._risk === 'SPRAYER') abnormal = chance(0.25);
          const txt = FINDING_TEXT[exam] || ['Normal', 'Abnormal'];
          add('mcu_finding', { id: randomUUID(), tenant_id: T.tenant.id, mcu_id: m.id, exam_code: exam, result: abnormal ? txt[1] : txt[0], flag: abnormal ? 'ABNORMAL' : 'NORMAL',
            icd10_code: abnormal && FINDING_ICD[exam] ? FINDING_ICD[exam] : null, created_at: ts(atTime(examDate, 13)) });
        }
        add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: C.unit.id, charged_unit_id: emp.org_unit_id, cost_category: 'MCU', amount: 150000 + risk.required_exams.length * int(60000, 110000),
          txn_date: examDate, employee_id: emp.id, patient_id: emp._patient.id, source_type: 'mcu', source_id: m.id, description: `MCU ${type.toLowerCase()} ${m.mcu_no}`, created_at: ts(atTime(examDate, 14)) });
      }
      return m;
    };
    if (joined > addDays(NOW, -DAYS)) {           // recent hire: pre-employment MCU
      mk('PRE_EMPLOYMENT', isoDate(addDays(joined, -int(3, 14))), 'COMPLETED');
      continue;
    }
    const r = faker.number.float({ min: 0, max: 1 });
    if (r < 0.84) {                               // compliant
      mk(interval <= 6 ? 'PERIODIC' : 'ANNUAL', isoDate(addDays(NOW, -int(5, interval * 30 - 35))), 'COMPLETED');
    } else if (r < 0.92) {                        // overdue: last exam older than interval
      mk(interval <= 6 ? 'PERIODIC' : 'ANNUAL', isoDate(addDays(NOW, -int(interval * 30 + 10, interval * 30 + 120))), 'COMPLETED');
      mk(interval <= 6 ? 'PERIODIC' : 'ANNUAL', null, 'PLANNED');
    } else {                                      // due now / scheduled
      mk(interval <= 6 ? 'PERIODIC' : 'ANNUAL', isoDate(addDays(NOW, -int(interval * 30 - 30, interval * 30 - 5))), 'COMPLETED');
      const m = mk(interval <= 6 ? 'PERIODIC' : 'ANNUAL', null, 'SCHEDULED');
      m.scheduled_date = isoDate(addDays(NOW, int(1, 21)));
    }
  }
}

// ------------------------------------------------------------------ ambulance fleet
const PLATE = { 'Riau': 'BM', 'Jambi': 'BH', 'Kalimantan Tengah': 'KH', 'Sumatera Utara': 'BK', 'Sumatera Barat': 'BA' };
for (const T of ctx.tenants) {
  for (const C of T.clinics.filter(FULL)) {
    const amb = add('ambulance', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, code: `AMB-${C.unit.code.replace('-KLN', '')}`, vehicle_no: `${PLATE[C.province]} ${int(1000, 9999)} ${pick(['AM', 'KA', 'TR', 'ZX'])}`,
      vehicle_type: pick(['EMERGENCY_BASIC', '4WD_RESCUE', 'TRANSPORT']), brand_model: pick(['Toyota Hilux Ambulance', 'Mitsubishi Triton Ambulance', 'Toyota HiAce Ambulance']), year: int(2017, 2025),
      status: weighted([['AVAILABLE', 80], ['MAINTENANCE', 12], ['ON_TRIP', 8]]), current_latitude: C.unit.latitude, current_longitude: C.unit.longitude, location_updated_at: ts(addDays(NOW, -0.1)),
      odometer_km: int(20000, 160000), next_service_date: isoDate(addDays(NOW, int(-5, 60))) });
    let odo = amb.odometer_km - 6000;
    const refs = T.referrals.filter(r => r.clinic_id === C.unit.id && r.transport_mode === 'AMBULANCE');
    for (const r of refs.slice(0, 25)) {
      const d = new Date(r.created_at); const dist = int(30, 220);
      const done = r.status !== 'ISSUED';
      add('ambulance_trip', { id: randomUUID(), tenant_id: T.tenant.id, trip_no: docNo(T.code, 'TRIP', C.unit.code, String(d.getFullYear())), ambulance_id: amb.id, clinic_id: C.unit.id, driver_id: C.drivers[0].id,
        crew_ids: [pick(C.nurses).id], trip_type: r.urgency === 'URGENT' ? 'EMERGENCY' : 'REFERRAL', priority: r.urgency === 'URGENT' ? 'EMERGENCY' : 'NORMAL', patient_id: r.patient_id, accident_id: r.accident_id, referral_id: r.id,
        origin: C.unit.name, destination: T.hospitals.find(h => h.id === r.hospital_id).name, dispatched_at: ts(d), departed_at: ts(addDays(d, 0.01)), arrived_at: done ? ts(addDays(d, 0.12)) : null, completed_at: done ? ts(addDays(d, 0.25)) : null,
        odometer_start: odo, odometer_end: done ? odo + dist : null, status: done ? 'COMPLETED' : 'TRANSPORTING', created_at: ts(d) });
      if (done) odo += dist;
    }
    for (let m = 0; m < 6; m++) {
      const d = addDays(NOW, -m * 30 - int(0, 10));
      add('ambulance_fuel_log', { id: randomUUID(), tenant_id: T.tenant.id, ambulance_id: amb.id, clinic_id: C.unit.id, fuel_date: isoDate(d), liters: int(40, 70), cost: int(40, 70) * 6800, odometer_km: amb.odometer_km - (6 - m) * 900 });
      if (m % 2 === 0) add('ambulance_maintenance', { id: randomUUID(), tenant_id: T.tenant.id, ambulance_id: amb.id, clinic_id: C.unit.id, maintenance_type: pick(['ROUTINE_SERVICE', 'TIRE', 'EQUIPMENT_CHECK', 'REPAIR']),
        service_date: isoDate(d), description: pick(['Servis berkala 10.000 km', 'Ganti ban depan', 'Pengecekan peralatan medis ambulans', 'Perbaikan sistem rem']), vendor: pick(['Bengkel Resmi Toyota', 'Bengkel Mitra Kebun', 'Workshop Internal']),
        odometer_km: amb.odometer_km - (6 - m) * 900, cost: int(5, 60) * 100000, next_due_date: isoDate(addDays(d, 90)) });
    }
  }
  for (const f of R.ambulance_fuel_log.filter(x => x.tenant_id === T.tenant.id)) add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: f.clinic_id, cost_category: 'AMBULANCE', amount: f.cost, txn_date: f.fuel_date, source_type: 'ambulance_fuel_log', source_id: f.id, description: 'BBM ambulans' });
  for (const m of R.ambulance_maintenance.filter(x => x.tenant_id === T.tenant.id)) add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: m.clinic_id, cost_category: 'AMBULANCE', amount: m.cost, txn_date: m.service_date, source_type: 'ambulance_maintenance', source_id: m.id, description: `Perawatan ambulans: ${m.description}` });
  // monthly clinic operational & equipment costs
  for (const C of T.clinics) {
    for (let m = 0; m < 6; m++) {
      const d = new Date(NOW.getFullYear(), NOW.getMonth() - m, 25);
      if (d > NOW) continue;
      add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: C.unit.id, cost_category: 'CLINIC_OPERATIONAL', amount: (C.full ? int(18, 25) : C.kind === 'ESTATE' ? int(10, 15) : int(5, 8)) * 1000000, txn_date: isoDate(d), source_type: 'manual', description: 'Biaya operasional bulanan (utilitas, ATK, kebersihan, insentif jaga)' });
    }
  }
  for (const a of R.clinic_asset.filter(x => x.tenant_id === T.tenant.id && x.purchase_date >= isoDate(addDays(NOW, -DAYS))))
    add('cost_transaction', { id: randomUUID(), tenant_id: T.tenant.id, org_unit_id: a.clinic_id, cost_category: 'EQUIPMENT', amount: a.purchase_cost, txn_date: a.purchase_date, source_type: 'clinic_asset', source_id: a.id, description: `Pembelian alat: ${a.name}` });
}

// ------------------------------------------------------------------ appointments & inpatient stays
for (const T of ctx.tenants) {
  for (let i = 0; i < 260; i++) {
    const p = pick(T.patients); const C = p._clinic; const off = int(-60, 21); const d = atTime(isoDate(addDays(NOW, off)), int(8, 14), pick([0, 15, 30, 45]));
    const status = off > 0 ? pick(['BOOKED', 'CONFIRMED']) : off === 0 ? pick(['CONFIRMED', 'CHECKED_IN']) : weighted([['COMPLETED', 80], ['NO_SHOW', 12], ['CANCELLED', 8]]);
    add('appointment', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: C.unit.id, patient_id: p.id, staff_id: pick(C.doctors).id, scheduled_at: ts(d), duration_min: 15,
      appointment_type: p._chronic ? 'FOLLOW_UP' : pick(['CONSULTATION', 'FOLLOW_UP', 'VACCINATION', 'RETURN_TO_WORK']), reason: p._chronic ? 'Kontrol hipertensi bulanan' : 'Kontrol',
      status, cancel_reason: status === 'CANCELLED' ? 'Pasien dinas ke luar kebun' : null, created_at: ts(addDays(d, -int(1, 7))) });
  }
  // a few current inpatients for the clinic dashboard
  for (const e of T.encounters.filter(x => x._daysAgo <= 2 && FULL(x._clinic) && ['A90', 'B54', 'A09'].includes(x._dx)).slice(0, 6)) {
    const bed = e._clinic.beds.find(b => b.status === 'AVAILABLE'); if (!bed) continue;
    bed.status = 'OCCUPIED';
    add('inpatient_stay', { id: randomUUID(), tenant_id: T.tenant.id, clinic_id: e.clinic_id, encounter_id: e.id, patient_id: e.patient_id, bed_id: bed.id, admitted_at: e.started_at, status: 'ADMITTED' });
    e.disposition = 'ADMITTED';
  }
}

// ==================================================================== write to database
const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
await client.connect();
const started = Date.now();
try {
  const existing = await client.query('SELECT count(*)::int AS n FROM tenant');
  if (existing.rows[0].n > 0) { console.error('Database already contains tenants — run `npm run reset` for a clean demo database.'); process.exit(1); }
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.skip_audit', 'on', false)");
  const roles = await client.query('SELECT id, code FROM role WHERE tenant_id IS NULL');
  for (const r of roles.rows) ROLE_IDS[r.code] = r.id;
  for (const a of R.user_role_assignment) { a.role_id = ROLE_IDS[a._role]; if (!a.role_id) throw new Error(`role ${a._role} missing`); }
  await client.query('INSERT INTO icd10_code (code, title_en, title_id, chapter, is_notifiable, is_occupational_candidate) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::bool[], $6::bool[]) ON CONFLICT DO NOTHING',
    [ICD10.map(r => r[0]), ICD10.map(r => r[1]), ICD10.map(r => r[2]), ICD10.map(r => r[3]), ICD10.map(r => r[4]), ICD10.map(r => r[5])]);

  // accident ↔ encounter reference each other: insert accidents first, link afterwards
  const accLinks = R.accident.filter(a => a.encounter_id).map(a => [a.id, a.encounter_id]);
  for (const a of R.accident) a.encounter_id = undefined;
  for (const table of ORDER) {
    const rows = R[table]; if (!rows.length) continue;
    // consecutive rows that define the same columns are inserted together; columns a row
    // omits keep their DB defaults, and row order (parents before children) is preserved
    let batch = [], sig = null, cols = [];
    const flush = async () => {
      if (!batch.length) return;
      const list = cols.map(c => `"${c}"`).join(', ');
      await client.query(`INSERT INTO "${table}" (${list}) SELECT ${list} FROM json_populate_recordset(NULL::"${table}", $1::json)`, [JSON.stringify(batch)]);
      batch = [];
    };
    for (const r of rows) {
      const c = Object.keys(r).filter(k => !k.startsWith('_') && r[k] !== undefined && r[k] !== null).sort();
      const s2 = c.join(',');
      if (s2 !== sig || batch.length >= 2000) { await flush(); sig = s2; cols = c; }
      batch.push(Object.fromEntries(c.map(k => [k, r[k]])));
    }
    await flush();
    process.stdout.write(`  ${table.padEnd(24)} ${String(rows.length).padStart(7)}\n`);
  }
  await client.query('UPDATE accident a SET encounter_id = x.e FROM unnest($1::uuid[], $2::uuid[]) AS x(a, e) WHERE a.id = x.a',
    [accLinks.map(l => l[0]), accLinks.map(l => l[1])]);
  // keep document numbering continuous with app.next_document_no()
  const tenantIdByCode = Object.fromEntries(ctx.tenants.map(T => [T.code, T.tenant.id]));
  const seqRows = [...seqs.entries()].map(([k, v]) => { const [t, type, scope, period] = k.split('|'); return [tenantIdByCode[t], type, scope, String(period), v]; });
  await client.query(`INSERT INTO document_sequence (tenant_id, doc_type, scope_key, period, last_value)
                      SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::bigint[])`,
    [seqRows.map(r => r[0]), seqRows.map(r => r[1]), seqRows.map(r => r[2]), seqRows.map(r => r[3]), seqRows.map(r => r[4])]);

  // --------------------------------------------------------------- health-intelligence alerts derived from the data
  // (same engine the API runs on schedule — see migration 0012)
  const engine = await client.query('SELECT analytics.run_alert_engine() AS r');
  console.log('  alert engine:', JSON.stringify(engine.rows[0].r));

  await client.query(`
    INSERT INTO notification (tenant_id, recipient_id, category, severity, title, body, entity_type, entity_id, action_url, created_at)
    SELECT t.tenant_id, wh.id, 'APPROVAL_REQUEST', CASE t.priority WHEN 'URGENT' THEN 'HIGH' ELSE 'MEDIUM' END,
           'Permintaan transfer ' || t.transfer_no || ' menunggu persetujuan', 'Permintaan obat dari ' || u.name, 'stock_transfer', t.id, '/inventory/transfers/' || t.id, t.requested_at
      FROM stock_transfer t JOIN org_unit u ON u.id = t.to_unit_id
      JOIN app_user wh ON wh.home_unit_id = t.from_unit_id
     WHERE t.status = 'REQUESTED';
    INSERT INTO notification (tenant_id, recipient_id, category, severity, title, body, entity_type, entity_id, action_url, created_at)
    SELECT a.tenant_id, ura.user_id, 'ACCIDENT', CASE a.severity WHEN 'MINOR' THEN 'LOW' WHEN 'MODERATE' THEN 'MEDIUM' ELSE 'HIGH' END,
           'Kecelakaan kerja ' || a.incident_no, 'Laporan kecelakaan (' || a.severity || ') di ' || u.name || ' — status ' || a.status, 'accident', a.id, '/accidents/' || a.id, a.reported_at
      FROM accident a JOIN org_unit u ON u.id = a.org_unit_id
      JOIN user_role_assignment ura ON ura.tenant_id = a.tenant_id
      JOIN role r ON r.id = ura.role_id AND r.code IN ('HSE_MANAGER','ESTATE_MANAGER')
      JOIN org_unit su ON su.id = ura.scope_unit_id AND u.path <@ su.path
     WHERE a.status NOT IN ('CLOSED','CANCELLED');
  `);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('\nSeed failed:', e.message, e.detail || '', e.where || '');
  process.exit(1);
}

const summary = await client.query(`SELECT
  (SELECT count(*) FROM tenant) groups, (SELECT count(*) FROM org_unit WHERE unit_type='COMPANY') pts,
  (SELECT count(*) FROM org_unit WHERE unit_type='ESTATE') estates, (SELECT count(*) FROM org_unit WHERE unit_type='DIVISION') divisions,
  (SELECT count(*) FROM org_unit WHERE unit_type='MILL') mills, (SELECT count(*) FROM org_unit WHERE unit_type='CLINIC') clinics,
  (SELECT count(*) FROM employee) employees, (SELECT count(*) FROM patient) patients,
  (SELECT count(*) FROM medical_staff WHERE staff_type='DOCTOR') doctors, (SELECT count(*) FROM medical_staff WHERE staff_type='NURSE') nurses,
  (SELECT count(DISTINCT code) FROM medicine) medicines, (SELECT count(*) FROM hospital) hospitals,
  (SELECT count(*) FROM encounter) encounters, (SELECT count(*) FROM accident) accidents, (SELECT count(*) FROM referral) referrals,
  (SELECT count(*) FROM mcu) mcu, (SELECT count(*) FROM sick_leave) sick_leave, (SELECT count(*) FROM health_alert) alerts,
  (SELECT count(*) FROM app_user) users`);
await client.end();
console.log('\nSeed complete in', ((Date.now() - started) / 1000).toFixed(1), 's');
console.table(summary.rows[0]);
console.log(`\nDemo login password for all ${DEMO_USERS.length} demo users: ${DEMO_PASSWORD}`);
console.log('Examples:', DEMO_USERS.filter(u => /superadmin|corporate|meddirector|hrmanager.bcpj|estate.bcpj-ra|dr.bcpj-ra-kln|apt.bcpj-ra|nurse1.bcpj-ra|dr.bcpj-central/.test(u.username)).map(u => u.username).join(', '));
