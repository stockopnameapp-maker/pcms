import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { owner, closeAll } from './helpers.mjs';

after(closeAll);

// Minimal entity list from the requirements → physical table / view
const REQUIRED = {
  Group: 'v_group', Company: 'v_company', Region: 'v_region', Estate: 'v_estate', Mill: 'v_mill', Division: 'v_division',
  Department: 'v_department', Clinic: 'v_clinic', User: 'app_user', Role: 'role', Permission: 'permission', Employee: 'employee',
  Family: 'family_member', Patient: 'patient', Doctor: 'v_doctor', Nurse: 'v_nurse', Appointment: 'appointment', Queue: 'queue_ticket',
  MedicalRecord: 'encounter', VitalSign: 'vital_sign', Diagnosis: 'diagnosis', Prescription: 'prescription', PrescriptionItem: 'prescription_item',
  Medicine: 'medicine', MedicineBatch: 'medicine_batch', Inventory: 'inventory_stock', InventoryTransaction: 'inventory_transaction',
  LabOrder: 'lab_order', LabResult: 'lab_result', Referral: 'referral', Hospital: 'hospital', Accident: 'accident', Ambulance: 'ambulance',
  AmbulanceTrip: 'ambulance_trip', MCU: 'mcu', HealthAssessment: 'health_assessment', SickLeave: 'sick_leave',
  MedicalCertificate: 'medical_certificate', CostTransaction: 'cost_transaction', Notification: 'notification', AuditLog: 'audit.audit_log',
};

test('every required entity exists', async () => {
  for (const [entity, rel] of Object.entries(REQUIRED)) {
    const [{ exists }] = await owner('SELECT to_regclass($1) IS NOT NULL AS exists', [rel.includes('.') ? rel : `public.${rel}`]);
    assert.ok(exists, `${entity} → ${rel} is missing`);
  }
});

test('every tenant table has RLS enabled, forced and at least one policy', async () => {
  const rows = await owner(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
     WHERE n.nspname IN ('public', 'audit') AND c.relkind IN ('r', 'p') AND c.relispartition = false`);
  assert.ok(rows.length >= 60, `expected ≥60 tenant tables, found ${rows.length}`);
  const bad = rows.filter(r => !r.relrowsecurity || !r.relforcerowsecurity || (r.policies === 0 && !['user_session', 'document_sequence'].includes(r.relname)));
  assert.deepEqual(bad.map(r => r.relname), []);
});

test('API role cannot bypass RLS and owns nothing', async () => {
  const [r] = await owner(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'pcms_app'`);
  assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
  const [{ n }] = await owner(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'pcms_app'`);
  assert.equal(n, 0);
});

test('UUID primary keys and standard audit columns on business tables', async () => {
  const missing = await owner(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id')
       AND c.relname NOT IN ('inventory_stock','user_session','document_sequence','role_permission')
       AND (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
              AND a.attname IN ('created_at','created_by','updated_at','updated_by','deleted_at','version')) < 6`);
  assert.deepEqual(missing.map(r => r.relname), []);
  const nonUuid = await owner(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND array_length(i.indkey, 1) = 1
       AND a.attname = 'id' AND a.atttypid <> 'uuid'::regtype`);
  assert.deepEqual(nonUuid.map(r => r.relname), []);
});

test('demo data volumes match the specification', async () => {
  // the isolation fixture (Group ZZT) only exists while tests run; it is excluded here
  const [c] = await owner(`SELECT
    (SELECT count(*) FROM tenant WHERE code <> 'ZZT')::int AS groups,
    (SELECT count(*) FROM org_unit WHERE unit_type = 'COMPANY' AND code NOT LIKE 'ZZT-%')::int AS pts,
    (SELECT count(*) FROM org_unit WHERE unit_type = 'ESTATE')::int AS estates,
    (SELECT count(*) FROM org_unit WHERE unit_type = 'DIVISION')::int AS divisions,
    (SELECT count(*) FROM org_unit WHERE unit_type = 'CLINIC')::int AS clinics,
    (SELECT count(*) FROM employee)::int AS employees,
    (SELECT count(*) FROM patient)::int AS patients,
    (SELECT count(*) FROM medical_staff WHERE staff_type = 'DOCTOR')::int AS doctors,
    (SELECT count(*) FROM medical_staff WHERE staff_type = 'NURSE')::int AS nurses,
    (SELECT count(DISTINCT code) FROM medicine)::int AS medicines,
    (SELECT count(*) FROM hospital WHERE created_by IS NULL)::int AS hospitals`);
  assert.deepEqual(c, { groups: 1, pts: 2, estates: 12, divisions: 24, clinics: 14, employees: 1000, patients: 2000, doctors: 28, nurses: 56, medicines: 200, hospitals: 11 });
});

test('stock on hand equals the sum of all inventory transactions', async () => {
  const [{ n }] = await owner(`
    SELECT count(*)::int AS n FROM inventory_stock s
     WHERE s.qty_on_hand <> (SELECT coalesce(sum(t.qty), 0) FROM inventory_transaction t WHERE t.org_unit_id = s.org_unit_id AND t.batch_id = s.batch_id)`);
  assert.equal(n, 0);
});

test('every system role has permissions and clinical modules are limited to clinical roles', async () => {
  const leaks = await owner(`
    SELECT r.code, p.module FROM role r JOIN role_permission rp ON rp.role_id = r.id JOIN permission p ON p.id = rp.permission_id
      JOIN permission_module m ON m.code = p.module
     WHERE r.is_system AND m.is_clinical AND NOT r.is_clinical`);
  assert.deepEqual(leaks, [], 'non-clinical roles must not hold clinical module permissions');
  const [{ n }] = await owner(`SELECT count(*)::int AS n FROM role r WHERE is_system AND NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id = r.id)`);
  assert.equal(n, 0);
});
