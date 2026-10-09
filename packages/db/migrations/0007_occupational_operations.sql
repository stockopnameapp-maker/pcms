-- =============================================================================
-- 0007 OCCUPATIONAL HEALTH, ACCIDENT, REFERRAL, AMBULANCE, SICK LEAVE
--
-- Need-to-know split used throughout:
--   ADMINISTRATIVE tables (visible to HR / HSE / management within scope):
--     mcu, health_assessment, sick_leave, medical_certificate, accident
--     → status, dates, fit status, restrictions, lost days. NO diagnosis/notes.
--   CLINICAL tables (EMR module only):
--     encounter, diagnosis, mcu_finding, lab_result, referral clinical fields.
-- =============================================================================

CREATE TABLE hospital (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name         text NOT NULL,
  hospital_type text NOT NULL CHECK (hospital_type IN ('RSUD','RS_SWASTA','RS_BUMN','RS_TNI_POLRI','PUSKESMAS','KLINIK_UTAMA','LAB','OTHER')),
  hospital_class text CHECK (hospital_class IN ('A','B','C','D')),
  is_partner   boolean NOT NULL DEFAULT false,
  is_bpjs      boolean NOT NULL DEFAULT true,
  has_icu      boolean NOT NULL DEFAULT false,
  has_er       boolean NOT NULL DEFAULT true,
  address text, city text, province text, phone text,
  latitude numeric(9,6), longitude numeric(9,6),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

-- -----------------------------------------------------------------------------
-- MCU — Medical Check Up programme
-- -----------------------------------------------------------------------------
CREATE TABLE mcu (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  mcu_no           text NOT NULL,
  clinic_id        uuid NOT NULL REFERENCES clinic_profile(id),
  employee_id      uuid NOT NULL REFERENCES employee(id),
  patient_id       uuid NOT NULL REFERENCES patient(id),
  employee_unit_id uuid NOT NULL REFERENCES org_unit(id),   -- snapshot of work unit → HR/HSE scope
  position_id      uuid REFERENCES job_position(id),        -- snapshot (JOB)
  risk_category_id uuid REFERENCES risk_category(id),       -- snapshot (RISK)
  mcu_type         text NOT NULL CHECK (mcu_type IN ('PRE_EMPLOYMENT','ANNUAL','PERIODIC','SPECIAL','POST_EMPLOYMENT')),
  due_date         date NOT NULL,
  scheduled_date   date,
  exam_date        date,
  status           text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','SCHEDULED','IN_PROGRESS','AWAITING_RESULT','COMPLETED','CANCELLED','NO_SHOW')),
  examiner_id      uuid REFERENCES medical_staff(id),
  encounter_id     uuid REFERENCES encounter(id),
  -- administrative outcome (visible to HR/HSE)
  fit_status       text CHECK (fit_status IN ('FIT','FIT_WITH_RESTRICTION','TEMPORARILY_UNFIT','UNFIT')),
  restrictions     text,
  valid_until      date,
  next_due_date    date,
  completed_at     timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, mcu_no),
  CHECK (status <> 'COMPLETED' OR (fit_status IS NOT NULL AND exam_date IS NOT NULL)),
  CHECK (fit_status <> 'FIT_WITH_RESTRICTION' OR restrictions IS NOT NULL)
);
CREATE INDEX mcu_employee_idx ON mcu (employee_id, exam_date DESC);
CREATE INDEX mcu_due_idx ON mcu (tenant_id, status, due_date);
CREATE INDEX mcu_unit_idx ON mcu (employee_unit_id);

ALTER TABLE lab_order ADD CONSTRAINT lab_order_mcu_fk FOREIGN KEY (mcu_id) REFERENCES mcu(id);

-- Clinical MCU findings (EMR-only)
CREATE TABLE mcu_finding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  mcu_id       uuid NOT NULL REFERENCES mcu(id),
  exam_code    text NOT NULL CHECK (exam_code IN ('PHYSICAL','VISUS','COLOR_BLIND','AUDIOMETRY','SPIROMETRY','XRAY_THORAX','ECG',
                                                  'CHOLINESTERASE','HEMATOLOGY','LIVER_FUNCTION','KIDNEY_FUNCTION','BLOOD_GLUCOSE',
                                                  'LIPID_PROFILE','URINALYSIS','DRUG_SCREEN','MUSCULOSKELETAL','DERMATOLOGY','PSYCHOLOGY','OTHER')),
  result       text NOT NULL,
  flag         text NOT NULL DEFAULT 'NORMAL' CHECK (flag IN ('NORMAL','ABNORMAL','BORDERLINE','CRITICAL')),
  icd10_code   text REFERENCES icd10_code(code),
  notes        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (mcu_id, exam_code)
);

-- Fitness decisions (fit-to-work, return-to-work, job placement, post-accident)
CREATE TABLE health_assessment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  assessment_no    text NOT NULL,
  clinic_id        uuid NOT NULL REFERENCES clinic_profile(id),
  employee_id      uuid NOT NULL REFERENCES employee(id),
  employee_unit_id uuid NOT NULL REFERENCES org_unit(id),
  assessment_type  text NOT NULL CHECK (assessment_type IN ('MCU','FIT_TO_WORK','RETURN_TO_WORK','JOB_PLACEMENT','POST_ACCIDENT','POST_ILLNESS','FITNESS_FOR_DUTY')),
  mcu_id           uuid REFERENCES mcu(id),
  encounter_id     uuid REFERENCES encounter(id),
  accident_id      uuid,                       -- FK below
  fit_status       text NOT NULL CHECK (fit_status IN ('FIT','FIT_WITH_RESTRICTION','TEMPORARILY_UNFIT','UNFIT')),
  restrictions     text,
  valid_from       date NOT NULL DEFAULT current_date,
  valid_until      date,
  assessed_by      uuid NOT NULL REFERENCES medical_staff(id),
  assessed_at      timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, assessment_no),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (fit_status <> 'FIT_WITH_RESTRICTION' OR restrictions IS NOT NULL)
);
CREATE INDEX health_assessment_emp_idx ON health_assessment (employee_id, assessed_at DESC);

-- -----------------------------------------------------------------------------
-- ACCIDENT & INCIDENT
-- REPORT → FIRST_AID → MEDICAL_TREATMENT → INVESTIGATION → APPROVAL → FOLLOW_UP → RETURN_TO_WORK → CLOSED
-- -----------------------------------------------------------------------------
CREATE TABLE accident (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  incident_no        text NOT NULL,
  org_unit_id        uuid NOT NULL REFERENCES org_unit(id),   -- where it happened (division/mill/...)
  clinic_id          uuid REFERENCES clinic_profile(id),      -- treating clinic
  company_id         uuid REFERENCES org_unit(id),            -- derived
  estate_id          uuid REFERENCES org_unit(id),            -- derived
  employee_id        uuid REFERENCES employee(id),
  patient_id         uuid REFERENCES patient(id),
  victim_name        text NOT NULL,                           -- also covers non-employees
  occurred_at        timestamptz NOT NULL,
  reported_at        timestamptz NOT NULL DEFAULT now(),
  location_detail    text NOT NULL,                           -- block / blok TM-12, workshop bay 2
  latitude           numeric(9,6), longitude numeric(9,6),
  activity           text NOT NULL CHECK (activity IN ('HARVESTING','PRUNING','SPRAYING','MANURING','LOADING','TRANSPORT','MILL_PROCESSING','MAINTENANCE','WORKSHOP','CONSTRUCTION','SECURITY_PATROL','OFFICE','OTHER')),
  incident_type      text NOT NULL CHECK (incident_type IN ('INJURY','NEAR_MISS','FIRST_AID_CASE','OCCUPATIONAL_ILLNESS','CHEMICAL_EXPOSURE','ANIMAL_BITE','TRAFFIC','FIRE','PROPERTY_DAMAGE','FATALITY')),
  severity           text NOT NULL CHECK (severity IN ('MINOR','MODERATE','SERIOUS','MAJOR','FATAL')),
  injury_type        text,      -- laceration, fracture, puncture (duri sawit), eye injury, ...
  body_part          text,
  immediate_cause    text NOT NULL,
  root_cause         text,
  first_aid_given    boolean NOT NULL DEFAULT false,
  first_aid_detail   text,
  first_aid_by       text,
  treatment_summary  text,      -- administrative summary only
  encounter_id       uuid REFERENCES encounter(id),
  hospital_id        uuid REFERENCES hospital(id),
  lost_time_days     int NOT NULL DEFAULT 0 CHECK (lost_time_days >= 0),
  is_lti             boolean GENERATED ALWAYS AS (lost_time_days > 0) STORED,
  investigation_findings text,
  corrective_action  text,
  status             text NOT NULL DEFAULT 'REPORTED' CHECK (status IN ('REPORTED','FIRST_AID','MEDICAL_TREATMENT','INVESTIGATION','PENDING_APPROVAL','FOLLOW_UP','RETURN_TO_WORK','CLOSED','CANCELLED')),
  approved_by        uuid, approved_at timestamptz,
  return_to_work_date date,
  closed_at          timestamptz,
  reported_by        uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, incident_no),
  CHECK (reported_at >= occurred_at - interval '5 minutes'),
  CHECK (status NOT IN ('CLOSED') OR closed_at IS NOT NULL),
  CHECK (status NOT IN ('FOLLOW_UP','RETURN_TO_WORK','CLOSED') OR severity = 'MINOR' OR approved_at IS NOT NULL)
);
CREATE INDEX accident_unit_idx ON accident (org_unit_id, occurred_at DESC);
CREATE INDEX accident_estate_idx ON accident (estate_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION app.tg_accident_placement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.company_id := app.ancestor_of_type(NEW.org_unit_id, 'COMPANY');
  NEW.estate_id  := app.ancestor_of_type(NEW.org_unit_id, 'ESTATE');
  RETURN NEW;
END $$;
CREATE TRIGGER accident_placement BEFORE INSERT OR UPDATE OF org_unit_id ON accident
  FOR EACH ROW EXECUTE FUNCTION app.tg_accident_placement();

ALTER TABLE encounter ADD CONSTRAINT encounter_accident_fk FOREIGN KEY (accident_id) REFERENCES accident(id);
ALTER TABLE health_assessment ADD CONSTRAINT health_assessment_accident_fk FOREIGN KEY (accident_id) REFERENCES accident(id);

-- -----------------------------------------------------------------------------
-- REFERRAL: CLINIC → REFERRAL → HOSPITAL → TREATMENT → FOLLOW-UP → RETURN TO CLINIC
-- -----------------------------------------------------------------------------
CREATE TABLE referral (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  referral_no        text NOT NULL,
  clinic_id          uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id         uuid NOT NULL REFERENCES patient(id),
  encounter_id       uuid REFERENCES encounter(id),
  accident_id        uuid REFERENCES accident(id),
  hospital_id        uuid NOT NULL REFERENCES hospital(id),
  referring_doctor_id uuid NOT NULL REFERENCES medical_staff(id),
  referral_date      date NOT NULL DEFAULT current_date,
  urgency            text NOT NULL DEFAULT 'ROUTINE' CHECK (urgency IN ('ROUTINE','URGENT','EMERGENCY')),
  icd10_code         text REFERENCES icd10_code(code),
  reason             text NOT NULL,
  specialty_needed   text,
  transport_mode     text CHECK (transport_mode IN ('AMBULANCE','COMPANY_VEHICLE','PRIVATE','OTHER')),
  status             text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('DRAFT','ISSUED','AT_HOSPITAL','IN_TREATMENT','INPATIENT','FOLLOW_UP','RETURNED','CLOSED','CANCELLED')),
  hospital_diagnosis text,
  treatment_summary  text,
  admitted           boolean NOT NULL DEFAULT false,
  admission_date     date,
  discharge_date     date,
  estimated_cost     numeric(16,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  actual_cost        numeric(16,2) CHECK (actual_cost IS NULL OR actual_cost >= 0),
  payer_type         text CHECK (payer_type IN ('COMPANY','BPJS','INSURANCE','SELF')),
  follow_up_date     date,
  returned_at        timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, referral_no),
  CHECK (discharge_date IS NULL OR admission_date IS NULL OR discharge_date >= admission_date)
);
CREATE INDEX referral_clinic_idx ON referral (clinic_id, referral_date DESC);
CREATE INDEX referral_patient_idx ON referral (patient_id);

-- -----------------------------------------------------------------------------
-- AMBULANCE
-- -----------------------------------------------------------------------------
CREATE TABLE ambulance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  clinic_id       uuid NOT NULL REFERENCES clinic_profile(id),
  code            text NOT NULL,
  vehicle_no      text NOT NULL CHECK (vehicle_no ~ '^[A-Z]{1,2} ?[0-9]{1,4} ?[A-Z]{0,3}$'),   -- Indonesian plate
  vehicle_type    text NOT NULL CHECK (vehicle_type IN ('TRANSPORT','EMERGENCY_BASIC','EMERGENCY_ADVANCED','4WD_RESCUE')),
  brand_model     text,
  year            int CHECK (year BETWEEN 1990 AND 2100),
  status          text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','ON_TRIP','MAINTENANCE','OUT_OF_SERVICE')),
  current_latitude  numeric(9,6), current_longitude numeric(9,6), location_updated_at timestamptz,
  odometer_km     int CHECK (odometer_km >= 0),
  next_service_date date,
  qr_token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, vehicle_no), UNIQUE (tenant_id, code)
);

CREATE TABLE ambulance_trip (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  trip_no         text NOT NULL,
  ambulance_id    uuid NOT NULL REFERENCES ambulance(id),
  clinic_id       uuid NOT NULL REFERENCES clinic_profile(id),
  driver_id       uuid REFERENCES medical_staff(id),
  crew_ids        uuid[] NOT NULL DEFAULT '{}',
  trip_type       text NOT NULL CHECK (trip_type IN ('EMERGENCY','REFERRAL','INTER_CLINIC','RETURN','OTHER')),
  priority        text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT','EMERGENCY')),
  patient_id      uuid REFERENCES patient(id),
  accident_id     uuid REFERENCES accident(id),
  referral_id     uuid REFERENCES referral(id),
  origin          text NOT NULL,
  destination     text NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  departed_at     timestamptz, arrived_at timestamptz, completed_at timestamptz,
  odometer_start  int, odometer_end int,
  distance_km     int GENERATED ALWAYS AS (odometer_end - odometer_start) STORED,
  status          text NOT NULL DEFAULT 'DISPATCHED' CHECK (status IN ('DISPATCHED','EN_ROUTE','ON_SCENE','TRANSPORTING','ARRIVED','COMPLETED','CANCELLED')),
  notes           text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, trip_no),
  CHECK (odometer_end IS NULL OR odometer_start IS NULL OR odometer_end >= odometer_start)
);

CREATE TABLE ambulance_maintenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  ambulance_id    uuid NOT NULL REFERENCES ambulance(id),
  clinic_id       uuid NOT NULL REFERENCES clinic_profile(id),
  maintenance_type text NOT NULL CHECK (maintenance_type IN ('ROUTINE_SERVICE','REPAIR','TIRE','INSPECTION','EQUIPMENT_CHECK')),
  service_date    date NOT NULL,
  description     text NOT NULL,
  vendor          text,
  odometer_km     int,
  cost            numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  next_due_date   date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE ambulance_fuel_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  ambulance_id    uuid NOT NULL REFERENCES ambulance(id),
  clinic_id       uuid NOT NULL REFERENCES clinic_profile(id),
  fuel_date       date NOT NULL,
  liters          numeric(8,2) NOT NULL CHECK (liters > 0 AND liters < 500),
  cost            numeric(14,2) NOT NULL CHECK (cost >= 0),
  odometer_km     int,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);

-- -----------------------------------------------------------------------------
-- SICK LEAVE & MEDICAL CERTIFICATE — administrative only (no diagnosis columns
-- by design; the clinical justification stays in the linked encounter).
-- -----------------------------------------------------------------------------
CREATE TABLE sick_leave (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  certificate_no   text NOT NULL,
  clinic_id        uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id       uuid NOT NULL REFERENCES patient(id),
  employee_id      uuid REFERENCES employee(id),
  employee_unit_id uuid REFERENCES org_unit(id),           -- HR scope
  encounter_id     uuid REFERENCES encounter(id),
  accident_id      uuid REFERENCES accident(id),
  leave_type       text NOT NULL CHECK (leave_type IN ('SICK_LEAVE','REST_RECOMMENDATION','WORK_ACCIDENT_LEAVE','MATERNITY')),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  days             int GENERATED ALWAYS AS (end_date - start_date + 1) STORED,
  issued_by        uuid NOT NULL REFERENCES medical_staff(id),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','ACKNOWLEDGED','EXTENDED','CANCELLED')),
  hr_acknowledged_by uuid, hr_acknowledged_at timestamptz,
  admin_remarks    text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, certificate_no),
  CHECK (end_date >= start_date AND end_date - start_date < 365),
  CHECK (employee_id IS NULL OR employee_unit_id IS NOT NULL)
);
CREATE INDEX sick_leave_unit_idx ON sick_leave (employee_unit_id, start_date DESC);
CREATE INDEX sick_leave_clinic_idx ON sick_leave (clinic_id, start_date DESC);

CREATE TABLE medical_certificate (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  certificate_no   text NOT NULL,
  clinic_id        uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id       uuid NOT NULL REFERENCES patient(id),
  employee_id      uuid REFERENCES employee(id),
  employee_unit_id uuid REFERENCES org_unit(id),
  encounter_id     uuid REFERENCES encounter(id),
  certificate_type text NOT NULL CHECK (certificate_type IN ('MEDICAL_CERTIFICATE','FIT_TO_WORK','RETURN_TO_WORK','REST_RECOMMENDATION','HEALTH_STATEMENT')),
  fit_status       text CHECK (fit_status IN ('FIT','FIT_WITH_RESTRICTION','TEMPORARILY_UNFIT','UNFIT')),
  restrictions     text,
  purpose          text,
  valid_from       date NOT NULL DEFAULT current_date,
  valid_until      date,
  issued_by        uuid NOT NULL REFERENCES medical_staff(id),
  issued_at        timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','REVOKED')),
  verification_code text NOT NULL UNIQUE DEFAULT upper(encode(gen_random_bytes(6), 'hex')),  -- printed + QR
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, certificate_no),
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK (certificate_type NOT IN ('FIT_TO_WORK','RETURN_TO_WORK') OR fit_status IS NOT NULL)
);

-- -----------------------------------------------------------------------------
-- EMPLOYEE → JOB → RISK → MEDICAL EXAMINATION → HEALTH STATUS (one row per employee)
-- -----------------------------------------------------------------------------
CREATE VIEW v_employee_health_status WITH (security_invoker = true) AS
SELECT e.id AS employee_id, e.tenant_id, e.employee_no, e.full_name,
       e.org_unit_id, e.estate_id, e.company_id,
       jp.code AS position_code, jp.name AS position_name,
       rc.code AS risk_code, rc.name AS risk_name, rc.risk_level, rc.mcu_interval_months,
       last_mcu.mcu_type AS last_mcu_type, last_mcu.exam_date AS last_mcu_date,
       coalesce(last_ha.fit_status, last_mcu.fit_status) AS fit_status,
       coalesce(last_ha.restrictions, last_mcu.restrictions) AS restrictions,
       coalesce(last_ha.valid_until, last_mcu.valid_until) AS fitness_valid_until,
       (last_mcu.exam_date + make_interval(months => rc.mcu_interval_months))::date AS next_mcu_due,
       CASE
         WHEN last_mcu.exam_date IS NULL THEN 'NEVER_EXAMINED'
         WHEN last_mcu.exam_date + make_interval(months => rc.mcu_interval_months) < current_date THEN 'OVERDUE'
         WHEN last_mcu.exam_date + make_interval(months => rc.mcu_interval_months) < current_date + 30 THEN 'DUE_SOON'
         ELSE 'UP_TO_DATE' END AS mcu_compliance
  FROM employee e
  JOIN job_position jp  ON jp.id = e.position_id
  JOIN risk_category rc ON rc.id = e.risk_category_id
  LEFT JOIN LATERAL (SELECT m.* FROM mcu m WHERE m.employee_id = e.id AND m.status = 'COMPLETED' AND m.deleted_at IS NULL
                      ORDER BY m.exam_date DESC LIMIT 1) last_mcu ON true
  LEFT JOIN LATERAL (SELECT h.* FROM health_assessment h WHERE h.employee_id = e.id AND h.status = 'ACTIVE' AND h.deleted_at IS NULL
                        AND h.assessed_at::date >= coalesce(last_mcu.exam_date, '1900-01-01')
                      ORDER BY h.assessed_at DESC LIMIT 1) last_ha ON true
 WHERE e.deleted_at IS NULL AND e.employment_status = 'ACTIVE';
