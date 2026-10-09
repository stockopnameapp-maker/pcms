-- =============================================================================
-- 0009 SECURITY — modules, permissions, and Row-Level Security on every table.
-- This is the authoritative enforcement layer: even a buggy API endpoint, a
-- hand-written report query or an export job cannot read outside the user's
-- tenant + org scope + module permissions.
-- =============================================================================

INSERT INTO permission_module (code, name, description, is_clinical, sort_order) VALUES
  ('ORGANIZATION', 'Organization Master',   'Group, PT, Region, Estate, Mill, Division, Department', false, 10),
  ('USER_ADMIN',   'Users & Access',        'Users, roles, role assignments',                         false, 20),
  ('MASTER_DATA',  'Master Data',           'Medicine catalogue, hospitals, lab tests, risk & positions', false, 30),
  ('CLINIC',       'Clinic Management',     'Clinic profile, rooms, beds, assets, staff, schedules', false, 40),
  ('EMPLOYEE',     'Employee Master',       'Employees and family members',                          false, 50),
  ('PATIENT',      'Patient Registry',      'Patient identity & demographics',                       false, 60),
  ('APPOINTMENT',  'Appointment',           'Appointments',                                          false, 70),
  ('QUEUE',        'Queue',                 'Registration & queue',                                  false, 80),
  ('EMR',          'Electronic Medical Record','Encounters, diagnoses, vitals, clinical notes, MCU findings', true, 90),
  ('LAB',          'Laboratory',            'Lab orders & results',                                  true, 100),
  ('PHARMACY',     'Pharmacy',              'Prescriptions & dispensing',                            true, 110),
  ('INVENTORY',    'Inventory',             'Stock, purchasing, transfers, opname',                  false, 120),
  ('OCC_HEALTH',   'Occupational Health',   'MCU programme, fitness status, health assessment',     false, 130),
  ('ACCIDENT',     'Accident & Incident',   'Accident reporting and investigation',                  false, 140),
  ('REFERRAL',     'Referral',              'Hospital referrals',                                    true, 150),
  ('AMBULANCE',    'Ambulance',             'Fleet, trips, maintenance, fuel',                       false, 160),
  ('SICK_LEAVE',   'Sick Leave & Certificates','Administrative sick-leave and certificates (no diagnosis)', false, 170),
  ('FINANCE',      'Medical Finance',       'Medical cost transactions',                             false, 180),
  ('DASHBOARD',    'Dashboards & Analytics','Aggregated KPIs (no patient-level clinical data)',      false, 190),
  ('ALERT',        'Health Intelligence Alerts','Early-warning alerts',                              false, 200),
  ('REPORT',       'Reports & Export',      'Report generation',                                     false, 210),
  ('AUDIT',        'Audit Trail',           'Audit & access logs',                                   false, 220),
  ('NOTIFICATION', 'Notifications',         'Notification centre',                                   false, 230);

INSERT INTO permission (module, action)
SELECT m.code, a.code FROM permission_module m CROSS JOIN permission_action a;

-- Reference data readable by the app role
GRANT SELECT ON permission_module, permission_action, permission, org_unit_type, org_unit_type_rule TO pcms_app;

-- =============================================================================
-- CARE RELATIONSHIP — continuity of care across clinics.
-- A clinician sees a patient's FULL history (also from other clinics) only
-- while the patient has a visit (queue ticket in the last 7 days) at a clinic
-- where that clinician holds MODULE:READ. Afterwards the access lapses.
-- Returned as an array so RLS evaluates it once per statement.
-- =============================================================================
CREATE OR REPLACE FUNCTION app.active_care_patient_ids(p_module text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT q.patient_id), '{}'::uuid[])
    FROM queue_ticket q
   WHERE q.tenant_id = app.current_tenant_id()
     AND q.visit_date >= current_date - 7
     AND q.status <> 'CANCELLED' AND q.deleted_at IS NULL
     AND q.clinic_id = ANY (app.unit_ids(p_module, 'READ'))
$$;

-- Patient-level access test for single-row checks (writes on child tables)
CREATE OR REPLACE FUNCTION app.patient_accessible(p_patient uuid, p_module text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM patient p
     WHERE p.id = p_patient AND p.tenant_id = app.current_tenant_id()
       AND ( p.primary_clinic_id = ANY (app.unit_ids(p_module, p_action))
          OR EXISTS (SELECT 1 FROM queue_ticket q
                      WHERE q.patient_id = p.id AND q.visit_date >= current_date - 7
                        AND q.status <> 'CANCELLED'
                        AND q.clinic_id = ANY (app.unit_ids(p_module, p_action)))
          OR EXISTS (SELECT 1 FROM encounter e
                      WHERE e.patient_id = p.id AND e.clinic_id = ANY (app.unit_ids(p_module, p_action)))))
$$;

DO $$
DECLARE t text := 'tenant_id = (SELECT app.current_tenant_id())';
BEGIN
  -- ---------------------------------------------------------------- tenant
  ALTER TABLE tenant ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
  CREATE POLICY sel ON tenant FOR SELECT USING (id = (SELECT app.current_tenant_id()));
  GRANT SELECT ON tenant TO pcms_app;

  -- ---------------------------------------------------------------- org_unit
  -- Structure is visible to all users of the tenant (needed for filters &
  -- breadcrumbs); changes require ORGANIZATION permission on the parent/unit.
  PERFORM app.setup_table('org_unit', 'ORGANIZATION');
  EXECUTE format('CREATE POLICY sel ON org_unit FOR SELECT USING (%s)', t);
  EXECUTE format('CREATE POLICY ins ON org_unit FOR INSERT WITH CHECK (%s AND parent_id = ANY ((SELECT app.unit_ids(''ORGANIZATION'',''CREATE''))::uuid[]))', t);
  EXECUTE format('CREATE POLICY upd ON org_unit FOR UPDATE USING (%s AND id = ANY ((SELECT app.unit_ids(''ORGANIZATION'',''UPDATE''))::uuid[])) WITH CHECK (%s AND (parent_id IS NULL OR parent_id = ANY ((SELECT app.unit_ids(''ORGANIZATION'',''UPDATE''))::uuid[])))', t, t);
  EXECUTE format('CREATE POLICY del ON org_unit FOR DELETE USING (%s AND id = ANY ((SELECT app.unit_ids(''ORGANIZATION'',''DELETE''))::uuid[]))', t);

  -- ---------------------------------------------------------------- clinic
  PERFORM app.setup_table('clinic_profile', 'CLINIC');
  PERFORM app.policy_scoped('clinic_profile', 'CLINIC', 'id', true);
  PERFORM app.setup_table('clinic_room', 'CLINIC');   PERFORM app.policy_scoped('clinic_room', 'CLINIC', 'clinic_id');
  PERFORM app.setup_table('clinic_bed', 'CLINIC');    PERFORM app.policy_scoped('clinic_bed', 'CLINIC', 'clinic_id');
  PERFORM app.setup_table('clinic_asset', 'CLINIC');  PERFORM app.policy_scoped('clinic_asset', 'CLINIC', 'clinic_id');
  PERFORM app.setup_table('medical_staff', 'CLINIC'); PERFORM app.policy_scoped('medical_staff', 'CLINIC', 'home_clinic_id', true);
  PERFORM app.setup_table('staff_schedule', 'CLINIC'); PERFORM app.policy_scoped('staff_schedule', 'CLINIC', 'clinic_id', true);
  PERFORM app.setup_table('clinic_schedule_exception', 'CLINIC'); PERFORM app.policy_scoped('clinic_schedule_exception', 'CLINIC', 'clinic_id', true);

  -- ---------------------------------------------------------------- IAM
  ALTER TABLE role ENABLE ROW LEVEL SECURITY; ALTER TABLE role FORCE ROW LEVEL SECURITY;
  CREATE TRIGGER role_audit AFTER INSERT OR UPDATE OR DELETE ON role FOR EACH ROW EXECUTE FUNCTION audit.tg_audit('USER_ADMIN');
  CREATE POLICY sel ON role FOR SELECT USING (tenant_id IS NULL OR tenant_id = (SELECT app.current_tenant_id()));
  CREATE POLICY ins ON role FOR INSERT WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND NOT is_system AND (SELECT app.has_root_perm('USER_ADMIN','CREATE')));
  CREATE POLICY upd ON role FOR UPDATE USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.has_root_perm('USER_ADMIN','UPDATE'))) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND NOT is_system);
  CREATE POLICY del ON role FOR DELETE USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.has_root_perm('USER_ADMIN','DELETE')));
  GRANT SELECT, INSERT, UPDATE, DELETE ON role TO pcms_app;

  ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY; ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
  CREATE TRIGGER role_permission_audit AFTER INSERT OR DELETE ON role_permission FOR EACH ROW EXECUTE FUNCTION audit.tg_audit('USER_ADMIN');
  CREATE POLICY sel ON role_permission FOR SELECT USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id));
  CREATE POLICY ins ON role_permission FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.tenant_id = (SELECT app.current_tenant_id())) AND (SELECT app.has_root_perm('USER_ADMIN','UPDATE')));
  CREATE POLICY del ON role_permission FOR DELETE USING (EXISTS (SELECT 1 FROM role r WHERE r.id = role_id AND r.tenant_id = (SELECT app.current_tenant_id())) AND (SELECT app.has_root_perm('USER_ADMIN','UPDATE')));
  GRANT SELECT, INSERT, DELETE ON role_permission TO pcms_app;

  PERFORM app.setup_table('app_user', 'USER_ADMIN');
  EXECUTE format('CREATE POLICY sel ON app_user FOR SELECT USING (%s AND (id = (SELECT app.current_user_id()) OR home_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''READ''))::uuid[])))', t);
  EXECUTE format('CREATE POLICY ins ON app_user FOR INSERT WITH CHECK (%s AND home_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''CREATE''))::uuid[]))', t);
  EXECUTE format('CREATE POLICY upd ON app_user FOR UPDATE USING (%s AND (id = (SELECT app.current_user_id()) OR home_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''UPDATE''))::uuid[]))) WITH CHECK (%s)', t, t);
  -- users are never hard-deleted (audit references); deactivate via status/deleted_at
  CREATE TRIGGER app_user_no_delete BEFORE DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION app.tg_prevent_hard_delete();
  -- column-level: the API may never read password hashes/MFA secrets through normal queries
  REVOKE SELECT ON app_user FROM pcms_app;
  GRANT SELECT (id, tenant_id, home_unit_id, username, email, full_name, phone, password_changed_at, must_change_password,
                mfa_enabled, status, failed_attempts, locked_until, last_login_at, last_login_ip, employee_id, locale,
                created_at, created_by, updated_at, updated_by, version, deleted_at, deleted_by) ON app_user TO pcms_app;

  PERFORM app.setup_table('user_role_assignment', 'USER_ADMIN');
  EXECUTE format('CREATE POLICY sel ON user_role_assignment FOR SELECT USING (%s AND (user_id = (SELECT app.current_user_id()) OR scope_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''READ''))::uuid[])))', t);
  EXECUTE format('CREATE POLICY ins ON user_role_assignment FOR INSERT WITH CHECK (%s AND scope_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''CREATE''))::uuid[]))', t);
  EXECUTE format('CREATE POLICY upd ON user_role_assignment FOR UPDATE USING (%s AND scope_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''UPDATE''))::uuid[])) WITH CHECK (%s AND scope_unit_id = ANY ((SELECT app.unit_ids(''USER_ADMIN'',''UPDATE''))::uuid[]))', t, t);
  CREATE TRIGGER ura_no_delete BEFORE DELETE ON user_role_assignment FOR EACH ROW EXECUTE FUNCTION app.tg_prevent_hard_delete();

  ALTER TABLE user_session ENABLE ROW LEVEL SECURITY; ALTER TABLE user_session FORCE ROW LEVEL SECURITY;  -- no grants: auth functions only
  ALTER TABLE document_sequence ENABLE ROW LEVEL SECURITY; ALTER TABLE document_sequence FORCE ROW LEVEL SECURITY;  -- app.next_document_no() only

  -- ---------------------------------------------------------------- tenant master data
  PERFORM app.setup_table('risk_category', 'MASTER_DATA');     PERFORM app.policy_master('risk_category', 'MASTER_DATA');
  PERFORM app.setup_table('job_position', 'MASTER_DATA');      PERFORM app.policy_master('job_position', 'MASTER_DATA');
  PERFORM app.setup_table('medicine_category', 'MASTER_DATA'); PERFORM app.policy_master('medicine_category', 'MASTER_DATA');
  PERFORM app.setup_table('medicine', 'MASTER_DATA');          PERFORM app.policy_master('medicine', 'MASTER_DATA');
  PERFORM app.setup_table('supplier', 'MASTER_DATA');          PERFORM app.policy_master('supplier', 'MASTER_DATA');
  PERFORM app.setup_table('hospital', 'MASTER_DATA');          PERFORM app.policy_master('hospital', 'MASTER_DATA');
  PERFORM app.setup_table('lab_test', 'MASTER_DATA');          PERFORM app.policy_master('lab_test', 'MASTER_DATA');

  -- batches are created at goods receipt by any site with INVENTORY:CREATE
  PERFORM app.setup_table('medicine_batch', 'INVENTORY');
  EXECUTE format('CREATE POLICY sel ON medicine_batch FOR SELECT USING (%s)', t);
  EXECUTE format('CREATE POLICY ins ON medicine_batch FOR INSERT WITH CHECK (%s AND (SELECT app.has_perm(''INVENTORY'',''CREATE'')))', t);
  EXECUTE format('CREATE POLICY upd ON medicine_batch FOR UPDATE USING (%s AND (SELECT app.has_root_perm(''MASTER_DATA'',''UPDATE''))) WITH CHECK (%s)', t, t);

  -- ---------------------------------------------------------------- HR
  PERFORM app.setup_table('employee', 'EMPLOYEE');       PERFORM app.policy_scoped('employee', 'EMPLOYEE', 'org_unit_id');
  PERFORM app.setup_table('family_member', 'EMPLOYEE');  PERFORM app.policy_child('family_member', 'EMPLOYEE', 'employee_id', 'employee', 'org_unit_id');

  -- ---------------------------------------------------------------- PATIENT
  PERFORM app.setup_table('patient', 'PATIENT', true);
  EXECUTE format($p$CREATE POLICY sel ON patient FOR SELECT USING (%s AND (
        primary_clinic_id = ANY ((SELECT app.unit_ids('PATIENT','READ'))::uuid[])
     OR id = ANY ((SELECT app.active_care_patient_ids('PATIENT'))::uuid[])
     OR EXISTS (SELECT 1 FROM encounter e WHERE e.patient_id = patient.id
                  AND e.clinic_id = ANY ((SELECT app.unit_ids('PATIENT','READ'))::uuid[]))))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON patient FOR INSERT WITH CHECK (%s AND primary_clinic_id = ANY ((SELECT app.unit_ids('PATIENT','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON patient FOR UPDATE USING (%s AND app.patient_accessible(id, 'PATIENT', 'UPDATE')) WITH CHECK (%s)$p$, t, t);
  CREATE TRIGGER patient_soft_delete BEFORE UPDATE OF deleted_at ON patient FOR EACH ROW EXECUTE FUNCTION app.tg_soft_delete_perm('PATIENT', 'primary_clinic_id');

  -- Allergies are also visible to pharmacy (dispensing safety check).
  PERFORM app.setup_table('patient_allergy', 'EMR', true);
  EXECUTE format($p$CREATE POLICY sel ON patient_allergy FOR SELECT USING (%s AND (app.patient_accessible(patient_id, 'EMR', 'READ') OR app.patient_accessible(patient_id, 'PHARMACY', 'READ')))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON patient_allergy FOR INSERT WITH CHECK (%s AND app.patient_accessible(patient_id, 'EMR', 'CREATE'))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON patient_allergy FOR UPDATE USING (%s AND app.patient_accessible(patient_id, 'EMR', 'UPDATE')) WITH CHECK (%s)$p$, t, t);

  FOREACH t IN ARRAY ARRAY['patient_history'] LOOP
    PERFORM app.setup_table(t, 'EMR', true);
    EXECUTE format($p$CREATE POLICY sel ON %I FOR SELECT USING (tenant_id = (SELECT app.current_tenant_id()) AND app.patient_accessible(patient_id, 'EMR', 'READ'))$p$, t);
    EXECUTE format($p$CREATE POLICY ins ON %I FOR INSERT WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND app.patient_accessible(patient_id, 'EMR', 'CREATE'))$p$, t);
    EXECUTE format($p$CREATE POLICY upd ON %I FOR UPDATE USING (tenant_id = (SELECT app.current_tenant_id()) AND app.patient_accessible(patient_id, 'EMR', 'UPDATE')) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
  END LOOP;
  t := 'tenant_id = (SELECT app.current_tenant_id())';

  -- ---------------------------------------------------------------- appointment / queue
  PERFORM app.setup_table('appointment', 'APPOINTMENT');  PERFORM app.policy_scoped('appointment', 'APPOINTMENT', 'clinic_id');
  PERFORM app.setup_table('queue_ticket', 'QUEUE', true); PERFORM app.policy_scoped('queue_ticket', 'QUEUE', 'clinic_id');

  -- ---------------------------------------------------------------- EMR
  PERFORM app.setup_table('encounter', 'EMR', true);
  EXECUTE format($p$CREATE POLICY sel ON encounter FOR SELECT USING (%s AND (
        clinic_id  = ANY ((SELECT app.unit_ids('EMR','READ'))::uuid[])
     OR patient_id = ANY ((SELECT app.active_care_patient_ids('EMR'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON encounter FOR INSERT WITH CHECK (%s AND clinic_id = ANY ((SELECT app.unit_ids('EMR','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON encounter FOR UPDATE USING (%s AND clinic_id = ANY ((SELECT app.unit_ids('EMR','UPDATE'))::uuid[])) WITH CHECK (%s AND clinic_id = ANY ((SELECT app.unit_ids('EMR','UPDATE'))::uuid[]))$p$, t, t);
  CREATE TRIGGER encounter_soft_delete BEFORE UPDATE OF deleted_at ON encounter FOR EACH ROW EXECUTE FUNCTION app.tg_soft_delete_perm('EMR', 'clinic_id');

  PERFORM app.setup_table('vital_sign', 'EMR', true);          PERFORM app.policy_child('vital_sign', 'EMR', 'encounter_id', 'encounter', 'clinic_id');
  PERFORM app.setup_table('diagnosis', 'EMR', true);           PERFORM app.policy_child('diagnosis', 'EMR', 'encounter_id', 'encounter', 'clinic_id');
  PERFORM app.setup_table('encounter_procedure', 'EMR', true); PERFORM app.policy_child('encounter_procedure', 'EMR', 'encounter_id', 'encounter', 'clinic_id');
  PERFORM app.setup_table('encounter_addendum', 'EMR', true);  PERFORM app.policy_child('encounter_addendum', 'EMR', 'encounter_id', 'encounter', 'clinic_id');
  PERFORM app.setup_table('inpatient_stay', 'EMR', true);      PERFORM app.policy_scoped('inpatient_stay', 'EMR', 'clinic_id');

  -- ---------------------------------------------------------------- LAB
  PERFORM app.setup_table('lab_order', 'LAB', true);
  EXECUTE format($p$CREATE POLICY sel ON lab_order FOR SELECT USING (%s AND (
        clinic_id  = ANY ((SELECT app.unit_ids('LAB','READ'))::uuid[])
     OR patient_id = ANY ((SELECT app.active_care_patient_ids('LAB'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON lab_order FOR INSERT WITH CHECK (%s AND clinic_id = ANY ((SELECT app.unit_ids('LAB','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON lab_order FOR UPDATE USING (%s AND clinic_id = ANY ((SELECT app.unit_ids('LAB','UPDATE'))::uuid[])) WITH CHECK (%s)$p$, t, t);
  PERFORM app.setup_table('lab_result', 'LAB', true);   PERFORM app.policy_child('lab_result', 'LAB', 'lab_order_id', 'lab_order', 'clinic_id');

  -- ---------------------------------------------------------------- attachments (module decided per row)
  PERFORM app.setup_table('attachment', 'ATTACHMENT', true);
  EXECUTE format('CREATE POLICY sel ON attachment FOR SELECT USING (%s AND owner_unit_id = ANY (app.unit_ids(module, ''READ'')))', t);
  EXECUTE format('CREATE POLICY ins ON attachment FOR INSERT WITH CHECK (%s AND owner_unit_id = ANY (app.unit_ids(module, ''CREATE'')))', t);
  EXECUTE format('CREATE POLICY upd ON attachment FOR UPDATE USING (%s AND owner_unit_id = ANY (app.unit_ids(module, ''UPDATE''))) WITH CHECK (%s)', t, t);

  -- ---------------------------------------------------------------- PHARMACY (prescription: doctor writes, pharmacy dispenses)
  PERFORM app.setup_table('prescription', 'PHARMACY', true);
  EXECUTE format($p$CREATE POLICY sel ON prescription FOR SELECT USING (%s AND (
        clinic_id  = ANY ((SELECT app.unit_ids('PHARMACY','READ'))::uuid[])
     OR clinic_id  = ANY ((SELECT app.unit_ids('EMR','READ'))::uuid[])
     OR patient_id = ANY ((SELECT app.active_care_patient_ids('EMR'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON prescription FOR INSERT WITH CHECK (%s AND clinic_id = ANY ((SELECT app.unit_ids('EMR','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON prescription FOR UPDATE USING (%s AND (clinic_id = ANY ((SELECT app.unit_ids('EMR','UPDATE'))::uuid[]) OR clinic_id = ANY ((SELECT app.unit_ids('PHARMACY','UPDATE'))::uuid[]))) WITH CHECK (%s)$p$, t, t);

  PERFORM app.setup_table('prescription_item', 'PHARMACY', true);
  EXECUTE format($p$CREATE POLICY sel ON prescription_item FOR SELECT USING (%s AND EXISTS (SELECT 1 FROM prescription p WHERE p.id = prescription_id))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON prescription_item FOR INSERT WITH CHECK (%s AND EXISTS (SELECT 1 FROM prescription p WHERE p.id = prescription_id AND p.clinic_id = ANY ((SELECT app.unit_ids('EMR','CREATE'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON prescription_item FOR UPDATE USING (%s AND EXISTS (SELECT 1 FROM prescription p WHERE p.id = prescription_id AND (p.clinic_id = ANY ((SELECT app.unit_ids('EMR','UPDATE'))::uuid[]) OR p.clinic_id = ANY ((SELECT app.unit_ids('PHARMACY','UPDATE'))::uuid[]))))  WITH CHECK (%s)$p$, t, t);

  -- ---------------------------------------------------------------- INVENTORY
  PERFORM app.setup_table('inventory_level', 'INVENTORY'); PERFORM app.policy_scoped('inventory_level', 'INVENTORY', 'org_unit_id');

  ALTER TABLE inventory_stock ENABLE ROW LEVEL SECURITY; ALTER TABLE inventory_stock FORCE ROW LEVEL SECURITY;
  EXECUTE format($p$CREATE POLICY sel ON inventory_stock FOR SELECT USING (%s AND org_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','READ'))::uuid[]))$p$, t);
  GRANT SELECT ON inventory_stock TO pcms_app;           -- read-only: maintained by trigger

  PERFORM app.setup_table('inventory_transaction', 'INVENTORY');
  EXECUTE format($p$CREATE POLICY sel ON inventory_transaction FOR SELECT USING (%s AND org_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','READ'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON inventory_transaction FOR INSERT WITH CHECK (%s AND org_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','CREATE'))::uuid[]))$p$, t);
  REVOKE UPDATE, DELETE ON inventory_transaction FROM pcms_app;

  PERFORM app.setup_table('purchase_order', 'INVENTORY');      PERFORM app.policy_scoped('purchase_order', 'INVENTORY', 'org_unit_id');
  PERFORM app.setup_table('purchase_order_item', 'INVENTORY'); PERFORM app.policy_child('purchase_order_item', 'INVENTORY', 'purchase_order_id', 'purchase_order', 'org_unit_id');
  PERFORM app.setup_table('stock_opname', 'INVENTORY');        PERFORM app.policy_scoped('stock_opname', 'INVENTORY', 'org_unit_id');
  PERFORM app.setup_table('stock_opname_item', 'INVENTORY');   PERFORM app.policy_child('stock_opname_item', 'INVENTORY', 'stock_opname_id', 'stock_opname', 'org_unit_id');

  PERFORM app.setup_table('stock_transfer', 'INVENTORY');
  EXECUTE format($p$CREATE POLICY sel ON stock_transfer FOR SELECT USING (%s AND (from_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','READ'))::uuid[]) OR to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','READ'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON stock_transfer FOR INSERT WITH CHECK (%s AND to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON stock_transfer FOR UPDATE USING (%s AND (from_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','UPDATE'))::uuid[]) OR to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','UPDATE'))::uuid[]))) WITH CHECK (%s)$p$, t, t);
  PERFORM app.setup_table('stock_transfer_item', 'INVENTORY');
  EXECUTE format($p$CREATE POLICY sel ON stock_transfer_item FOR SELECT USING (%s AND EXISTS (SELECT 1 FROM stock_transfer s WHERE s.id = stock_transfer_id))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON stock_transfer_item FOR INSERT WITH CHECK (%s AND EXISTS (SELECT 1 FROM stock_transfer s WHERE s.id = stock_transfer_id AND s.to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','CREATE'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON stock_transfer_item FOR UPDATE USING (%s AND EXISTS (SELECT 1 FROM stock_transfer s WHERE s.id = stock_transfer_id AND (s.from_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','UPDATE'))::uuid[]) OR s.to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','UPDATE'))::uuid[])))) WITH CHECK (%s)$p$, t, t);

  -- ---------------------------------------------------------------- OCCUPATIONAL HEALTH
  -- Administrative MCU/assessment rows are visible to the examining clinic AND
  -- to HR/HSE responsible for the employee's work unit.
  FOREACH t IN ARRAY ARRAY['mcu','health_assessment'] LOOP
    PERFORM app.setup_table(t, 'OCC_HEALTH', true);
    EXECUTE format($p$CREATE POLICY sel ON %I FOR SELECT USING (tenant_id = (SELECT app.current_tenant_id()) AND (clinic_id = ANY ((SELECT app.unit_ids('OCC_HEALTH','READ'))::uuid[]) OR employee_unit_id = ANY ((SELECT app.unit_ids('OCC_HEALTH','READ'))::uuid[])))$p$, t);
    EXECUTE format($p$CREATE POLICY ins ON %I FOR INSERT WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (clinic_id = ANY ((SELECT app.unit_ids('OCC_HEALTH','CREATE'))::uuid[]) OR employee_unit_id = ANY ((SELECT app.unit_ids('OCC_HEALTH','CREATE'))::uuid[])))$p$, t);
    EXECUTE format($p$CREATE POLICY upd ON %I FOR UPDATE USING (tenant_id = (SELECT app.current_tenant_id()) AND clinic_id = ANY ((SELECT app.unit_ids('OCC_HEALTH','UPDATE'))::uuid[])) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
  END LOOP;
  t := 'tenant_id = (SELECT app.current_tenant_id())';

  -- MCU clinical findings → EMR permission on the examining clinic only
  PERFORM app.setup_table('mcu_finding', 'EMR', true);
  PERFORM app.policy_child('mcu_finding', 'EMR', 'mcu_id', 'mcu', 'clinic_id');
  DROP POLICY sel ON mcu_finding;
  EXECUTE format($p$CREATE POLICY sel ON mcu_finding FOR SELECT USING (%s AND EXISTS (SELECT 1 FROM mcu m WHERE m.id = mcu_id AND m.clinic_id = ANY ((SELECT app.unit_ids('EMR','READ'))::uuid[])))$p$, t);

  -- ---------------------------------------------------------------- ACCIDENT
  PERFORM app.setup_table('accident', 'ACCIDENT', true);
  EXECUTE format($p$CREATE POLICY sel ON accident FOR SELECT USING (%s AND (org_unit_id = ANY ((SELECT app.unit_ids('ACCIDENT','READ'))::uuid[]) OR clinic_id = ANY ((SELECT app.unit_ids('ACCIDENT','READ'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON accident FOR INSERT WITH CHECK (%s AND (org_unit_id = ANY ((SELECT app.unit_ids('ACCIDENT','CREATE'))::uuid[]) OR clinic_id = ANY ((SELECT app.unit_ids('ACCIDENT','CREATE'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON accident FOR UPDATE USING (%s AND (org_unit_id = ANY ((SELECT app.unit_ids('ACCIDENT','UPDATE'))::uuid[]) OR clinic_id = ANY ((SELECT app.unit_ids('ACCIDENT','UPDATE'))::uuid[]))) WITH CHECK (%s)$p$, t, t);
  CREATE TRIGGER accident_soft_delete BEFORE UPDATE OF deleted_at ON accident FOR EACH ROW EXECUTE FUNCTION app.tg_soft_delete_perm('ACCIDENT', 'org_unit_id');

  -- ---------------------------------------------------------------- REFERRAL
  PERFORM app.setup_table('referral', 'REFERRAL', true);  PERFORM app.policy_scoped('referral', 'REFERRAL', 'clinic_id');

  -- ---------------------------------------------------------------- AMBULANCE
  PERFORM app.setup_table('ambulance', 'AMBULANCE');             PERFORM app.policy_scoped('ambulance', 'AMBULANCE', 'clinic_id');
  PERFORM app.setup_table('ambulance_trip', 'AMBULANCE', true);  PERFORM app.policy_scoped('ambulance_trip', 'AMBULANCE', 'clinic_id');
  PERFORM app.setup_table('ambulance_maintenance', 'AMBULANCE'); PERFORM app.policy_scoped('ambulance_maintenance', 'AMBULANCE', 'clinic_id');
  PERFORM app.setup_table('ambulance_fuel_log', 'AMBULANCE');    PERFORM app.policy_scoped('ambulance_fuel_log', 'AMBULANCE', 'clinic_id');

  -- ---------------------------------------------------------------- SICK LEAVE & CERTIFICATES
  FOREACH t IN ARRAY ARRAY['sick_leave','medical_certificate'] LOOP
    PERFORM app.setup_table(t, 'SICK_LEAVE', true);
    EXECUTE format($p$CREATE POLICY sel ON %I FOR SELECT USING (tenant_id = (SELECT app.current_tenant_id()) AND (clinic_id = ANY ((SELECT app.unit_ids('SICK_LEAVE','READ'))::uuid[]) OR employee_unit_id = ANY ((SELECT app.unit_ids('SICK_LEAVE','READ'))::uuid[])))$p$, t);
    EXECUTE format($p$CREATE POLICY ins ON %I FOR INSERT WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND clinic_id = ANY ((SELECT app.unit_ids('SICK_LEAVE','CREATE'))::uuid[]))$p$, t);
    -- clinic edits; HR may update (acknowledge) for its employees
    EXECUTE format($p$CREATE POLICY upd ON %I FOR UPDATE USING (tenant_id = (SELECT app.current_tenant_id()) AND (clinic_id = ANY ((SELECT app.unit_ids('SICK_LEAVE','UPDATE'))::uuid[]) OR employee_unit_id = ANY ((SELECT app.unit_ids('SICK_LEAVE','APPROVE'))::uuid[]))) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()))$p$, t);
  END LOOP;
  t := 'tenant_id = (SELECT app.current_tenant_id())';

  -- ---------------------------------------------------------------- FINANCE
  PERFORM app.setup_table('cost_transaction', 'FINANCE', true);
  EXECUTE format($p$CREATE POLICY sel ON cost_transaction FOR SELECT USING (%s AND (org_unit_id = ANY ((SELECT app.unit_ids('FINANCE','READ'))::uuid[]) OR charged_unit_id = ANY ((SELECT app.unit_ids('FINANCE','READ'))::uuid[])))$p$, t);
  EXECUTE format($p$CREATE POLICY ins ON cost_transaction FOR INSERT WITH CHECK (%s AND org_unit_id = ANY ((SELECT app.unit_ids('FINANCE','CREATE'))::uuid[]))$p$, t);
  EXECUTE format($p$CREATE POLICY upd ON cost_transaction FOR UPDATE USING (%s AND org_unit_id = ANY ((SELECT app.unit_ids('FINANCE','UPDATE'))::uuid[])) WITH CHECK (%s)$p$, t, t);

  -- ---------------------------------------------------------------- ALERTS / WORKFLOW (module decided per row)
  PERFORM app.setup_table('health_alert', 'ALERT');
  EXECUTE format('CREATE POLICY sel ON health_alert FOR SELECT USING (%s AND (org_unit_id = ANY (app.unit_ids(module, ''READ'')) OR org_unit_id = ANY ((SELECT app.unit_ids(''ALERT'',''READ''))::uuid[])))', t);
  EXECUTE format('CREATE POLICY ins ON health_alert FOR INSERT WITH CHECK (%s AND org_unit_id = ANY ((SELECT app.unit_ids(''ALERT'',''CREATE''))::uuid[]))', t);
  EXECUTE format('CREATE POLICY upd ON health_alert FOR UPDATE USING (%s AND (org_unit_id = ANY (app.unit_ids(module, ''UPDATE'')) OR org_unit_id = ANY ((SELECT app.unit_ids(''ALERT'',''UPDATE''))::uuid[]))) WITH CHECK (%s)', t, t);

  PERFORM app.setup_table('workflow_event', 'WORKFLOW', true);
  EXECUTE format('CREATE POLICY sel ON workflow_event FOR SELECT USING (%s AND org_unit_id = ANY (app.unit_ids(module, ''READ'')))', t);
  EXECUTE format('CREATE POLICY ins ON workflow_event FOR INSERT WITH CHECK (%s AND actor_id = (SELECT app.current_user_id()) AND (org_unit_id = ANY (app.unit_ids(module, ''UPDATE'')) OR org_unit_id = ANY (app.unit_ids(module, ''CREATE''))))', t);
  REVOKE UPDATE, DELETE ON workflow_event FROM pcms_app;

  -- ---------------------------------------------------------------- NOTIFICATIONS (own inbox only)
  PERFORM app.setup_table('notification', 'NOTIFICATION');
  EXECUTE format('CREATE POLICY sel ON notification FOR SELECT USING (%s AND recipient_id = (SELECT app.current_user_id()))', t);
  EXECUTE format('CREATE POLICY ins ON notification FOR INSERT WITH CHECK (%s)', t);
  EXECUTE format('CREATE POLICY upd ON notification FOR UPDATE USING (%s AND recipient_id = (SELECT app.current_user_id())) WITH CHECK (%s AND recipient_id = (SELECT app.current_user_id()))', t, t);

  -- ---------------------------------------------------------------- AUDIT (read-only, Group-level auditors + own activity)
  ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
  CREATE POLICY sel ON audit.audit_log FOR SELECT USING (
    tenant_id = (SELECT app.current_tenant_id())
    AND ((SELECT app.has_root_perm('AUDIT','READ')) OR user_id = (SELECT app.current_user_id())));
  GRANT SELECT ON audit.audit_log TO pcms_app;
END $$;

-- Functions callable by the API role
GRANT EXECUTE ON FUNCTION app.set_context(uuid, text, text, text), app.clear_context(), app.my_permissions(),
  app.unit_ids(text, text), app.has_perm(text, text), app.has_root_perm(text, text), app.can(text, text, uuid),
  app.current_user_id(), app.current_tenant_id(), app.log_access(text, text, uuid, text, text),
  app.auth_lookup(text), app.auth_record_attempt(uuid, boolean, text, text), app.next_document_no(text, text, text, int),
  app.active_care_patient_ids(text), app.patient_accessible(uuid, text, text), app.ancestor_of_type(uuid, text)
  TO pcms_app;
-- Internal: policy generators, partition maintenance — owner only.
REVOKE EXECUTE ON FUNCTION app.setup_table(text, text, boolean), app.policy_scoped(text, text, text, boolean),
  app.policy_child(text, text, text, text, text), app.policy_master(text, text), audit.ensure_partitions(date, int)
  FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO pcms_app;  -- views; table-level RLS still applies
REVOKE SELECT ON user_session, document_sequence FROM pcms_app;
REVOKE SELECT ON app_user FROM pcms_app;   -- re-applied column grant below (GRANT ALL TABLES re-added it)
GRANT SELECT (id, tenant_id, home_unit_id, username, email, full_name, phone, password_changed_at, must_change_password,
              mfa_enabled, status, failed_attempts, locked_until, last_login_at, last_login_ip, employee_id, locale,
              created_at, created_by, updated_at, updated_by, version, deleted_at, deleted_by) ON app_user TO pcms_app;
