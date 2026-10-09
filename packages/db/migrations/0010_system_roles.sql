-- =============================================================================
-- 0010 SYSTEM ROLES & PERMISSION MATRIX
-- Shorthand: C=CREATE R=READ U=UPDATE D=DELETE A=APPROVE E=EXPORT P=PRINT
-- Principle: need-to-know. Clinical modules (EMR, LAB, PHARMACY, REFERRAL)
-- are granted ONLY to clinical roles. Admin / management / HR roles get
-- administrative modules and aggregated dashboards.
-- Tenants can create additional custom roles as data.
-- =============================================================================

CREATE OR REPLACE FUNCTION app._grant(p_role text, p_spec text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE item text; m text; acts text; a char;
BEGIN
  FOREACH item IN ARRAY string_to_array(p_spec, ' ') LOOP
    CONTINUE WHEN item = '';
    m := split_part(item, ':', 1); acts := split_part(item, ':', 2);
    FOREACH a IN ARRAY regexp_split_to_array(acts, '') LOOP
      INSERT INTO role_permission (role_id, permission_id)
      SELECT r.id, p.id FROM role r, permission p
       WHERE r.code = p_role AND r.tenant_id IS NULL AND p.module = m
         AND p.action = CASE a WHEN 'C' THEN 'CREATE' WHEN 'R' THEN 'READ' WHEN 'U' THEN 'UPDATE'
                               WHEN 'D' THEN 'DELETE' WHEN 'A' THEN 'APPROVE' WHEN 'E' THEN 'EXPORT' WHEN 'P' THEN 'PRINT' END
      ON CONFLICT DO NOTHING;
      IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM permission WHERE module = m) THEN
        RAISE EXCEPTION 'unknown module % in grant for %', m, p_role;
      END IF;
    END LOOP;
  END LOOP;
END $$;

INSERT INTO role (code, name, description, is_system, typical_scope, is_clinical) VALUES
 ('SUPER_ADMIN',        'Super Admin',            'Full administration of the Group. No clinical-record access by default (need-to-know).', true, 'GROUP',   false),
 ('GROUP_ADMIN',        'Group Admin',            'Organisation structure, users, master data for the Group',      true, 'GROUP',   false),
 ('CORPORATE_MGMT',     'Corporate Management',   'Group-wide dashboards and consolidated reports (aggregated)',   true, 'GROUP',   false),
 ('MEDICAL_DIRECTOR',   'Medical Director',       'Clinical governance across the Group',                          true, 'GROUP',   true),
 ('MEDICAL_MANAGER',    'Medical Manager',        'Clinical governance for a PT / region',                         true, 'COMPANY', true),
 ('HR_MANAGER',         'HR Manager',             'Employees, sick-leave administration, fitness status',          true, 'COMPANY', false),
 ('HSE_MANAGER',        'HSE Manager',            'Accidents, occupational health programme',                     true, 'COMPANY', false),
 ('PT_ADMIN',           'PT Admin',               'Administration of one company (PT)',                           true, 'COMPANY', false),
 ('ESTATE_MANAGER',     'Estate Manager',         'Estate-level health & safety overview (no clinical detail)',    true, 'ESTATE',  false),
 ('CLINIC_MANAGER',     'Clinic Manager',         'Clinic operations, queue, stock, staff',                        true, 'CLINIC',  false),
 ('DOCTOR',             'Doctor',                 'Examination, diagnosis, prescription, certificates',           true, 'CLINIC',  true),
 ('NURSE',              'Nurse',                  'Registration, triage, vitals, first aid',                      true, 'CLINIC',  true),
 ('PHARMACIST',         'Pharmacist',             'Dispensing and inventory',                                     true, 'CLINIC',  true),
 ('MEDICAL_RECORD_OFFICER','Medical Record Officer','Custodian of medical records',                                  true, 'CLINIC',  true),
 ('HR_OFFICER',         'HR Officer',             'Employee data entry, sick-leave acknowledgement',               true, 'ESTATE',  false),
 ('HSE_OFFICER',        'HSE Officer',            'Accident reporting & investigation',                           true, 'ESTATE',  false),
 ('FINANCE',            'Finance',                'Medical cost tracking and analytics',                          true, 'COMPANY', false),
 ('AMBULANCE_DRIVER',   'Ambulance Driver',       'Trips and vehicle logs',                                       true, 'CLINIC',  false),
 ('EMPLOYEE_PATIENT',   'Employee / Patient',     'Self-service portal (own data only, via self-service API)',     true, 'GROUP',   false);

SELECT app._grant('SUPER_ADMIN',
  'ORGANIZATION:CRUDAEP USER_ADMIN:CRUDAEP MASTER_DATA:CRUDAEP CLINIC:CRUDAEP EMPLOYEE:CRUDAEP PATIENT:CRUDAEP '
  'APPOINTMENT:CRUDAEP QUEUE:CRUDAEP INVENTORY:CRUDAEP OCC_HEALTH:CRUDAEP ACCIDENT:CRUDAEP AMBULANCE:CRUDAEP '
  'SICK_LEAVE:CRUDAEP FINANCE:CRUDAEP DASHBOARD:REP ALERT:CRUDA REPORT:CREP AUDIT:REP NOTIFICATION:CRUD');
SELECT app._grant('GROUP_ADMIN',
  'ORGANIZATION:CRUDEP USER_ADMIN:CRUDAEP MASTER_DATA:CRUDEP CLINIC:CRUDEP EMPLOYEE:REP DASHBOARD:R REPORT:REP AUDIT:RE ALERT:R NOTIFICATION:RU');
SELECT app._grant('CORPORATE_MGMT',
  'DASHBOARD:REP REPORT:REP ALERT:R FINANCE:REP EMPLOYEE:R INVENTORY:R ACCIDENT:R OCC_HEALTH:R NOTIFICATION:RU');
SELECT app._grant('MEDICAL_DIRECTOR',
  'EMR:REP LAB:REP PHARMACY:R REFERRAL:RAEP PATIENT:REP OCC_HEALTH:RUAEP ACCIDENT:RAEP SICK_LEAVE:REP INVENTORY:RAE '
  'CLINIC:RU MASTER_DATA:CRU DASHBOARD:REP REPORT:REP ALERT:RUA FINANCE:R NOTIFICATION:RU');
SELECT app._grant('MEDICAL_MANAGER',
  'EMR:REP LAB:R PHARMACY:R REFERRAL:RAEP PATIENT:RE OCC_HEALTH:RUAEP ACCIDENT:RAE SICK_LEAVE:RE INVENTORY:RAE '
  'CLINIC:RU DASHBOARD:REP REPORT:REP ALERT:RUA FINANCE:R NOTIFICATION:RU');
SELECT app._grant('HR_MANAGER',
  'EMPLOYEE:CRUDEP SICK_LEAVE:RAEP OCC_HEALTH:REP ACCIDENT:R DASHBOARD:RE REPORT:REP NOTIFICATION:RU');
SELECT app._grant('HSE_MANAGER',
  'ACCIDENT:CRUDAEP OCC_HEALTH:CRUEP EMPLOYEE:R AMBULANCE:R DASHBOARD:RE REPORT:REP ALERT:RU NOTIFICATION:RU');
SELECT app._grant('PT_ADMIN',
  'ORGANIZATION:CRU USER_ADMIN:CRUA EMPLOYEE:CRUE CLINIC:RU DASHBOARD:R REPORT:RE NOTIFICATION:RU');
SELECT app._grant('ESTATE_MANAGER',
  'DASHBOARD:REP EMPLOYEE:R SICK_LEAVE:R ACCIDENT:RA OCC_HEALTH:R INVENTORY:R REPORT:REP ALERT:R NOTIFICATION:RU');
SELECT app._grant('CLINIC_MANAGER',
  'CLINIC:CRUDEP QUEUE:CRUDEP APPOINTMENT:CRUDEP PATIENT:CRUEP INVENTORY:CRUDAEP AMBULANCE:CRUDEP SICK_LEAVE:R '
  'ACCIDENT:R OCC_HEALTH:R DASHBOARD:REP REPORT:REP ALERT:RU FINANCE:R NOTIFICATION:RU');
SELECT app._grant('DOCTOR',
  'EMR:CRUP LAB:CRUP PHARMACY:R PATIENT:CRU QUEUE:RU APPOINTMENT:CRU REFERRAL:CRUP SICK_LEAVE:CRUP '
  'OCC_HEALTH:CRUAP ACCIDENT:CRU AMBULANCE:RC INVENTORY:R DASHBOARD:R NOTIFICATION:RU');
SELECT app._grant('NURSE',
  'EMR:CRU LAB:CR PATIENT:CRU QUEUE:CRU APPOINTMENT:CRU ACCIDENT:CRU OCC_HEALTH:CRU AMBULANCE:CRU REFERRAL:R '
  'INVENTORY:R SICK_LEAVE:R NOTIFICATION:RU');
SELECT app._grant('PHARMACIST',
  'PHARMACY:CRUP INVENTORY:CRUDAEP PATIENT:R QUEUE:RU NOTIFICATION:RU');
SELECT app._grant('MEDICAL_RECORD_OFFICER',
  'PATIENT:CRUDEP EMR:REP LAB:R QUEUE:R SICK_LEAVE:RP REPORT:REP NOTIFICATION:RU');
SELECT app._grant('HR_OFFICER',
  'EMPLOYEE:CRU SICK_LEAVE:RA OCC_HEALTH:R REPORT:R NOTIFICATION:RU');
SELECT app._grant('HSE_OFFICER',
  'ACCIDENT:CRUP OCC_HEALTH:R EMPLOYEE:R REPORT:R NOTIFICATION:RU');
SELECT app._grant('FINANCE',
  'FINANCE:CRUDAEP INVENTORY:R DASHBOARD:RE REPORT:REP NOTIFICATION:RU');
SELECT app._grant('AMBULANCE_DRIVER',
  'AMBULANCE:RU NOTIFICATION:RU');
SELECT app._grant('EMPLOYEE_PATIENT',
  'NOTIFICATION:RU');

REVOKE EXECUTE ON FUNCTION app._grant(text, text) FROM PUBLIC;
