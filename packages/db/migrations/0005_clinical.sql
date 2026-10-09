-- =============================================================================
-- 0005 CLINICAL CORE
--   medical_staff, schedules, appointment, queue, encounter (= MedicalRecord),
--   vital signs, diagnosis (ICD-10), procedures, addenda, inpatient stay,
--   laboratory, attachments.
-- =============================================================================

-- Global ICD-10 reference (WHO). Not tenant data.
CREATE TABLE icd10_code (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$'),
  title_en    text NOT NULL,
  title_id    text,
  chapter     text,
  block       text,
  is_notifiable boolean NOT NULL DEFAULT false,   -- reportable to Dinkes
  is_occupational_candidate boolean NOT NULL DEFAULT false
);
CREATE INDEX icd10_title_trgm ON icd10_code USING gin ((title_en || ' ' || coalesce(title_id,'')) gin_trgm_ops);
GRANT SELECT ON icd10_code TO pcms_app;

-- Doctors, nurses, pharmacists, lab analysts, midwives, ambulance drivers.
CREATE TABLE medical_staff (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  user_id          uuid UNIQUE REFERENCES app_user(id),
  employee_id      uuid REFERENCES employee(id),
  home_clinic_id   uuid NOT NULL REFERENCES clinic_profile(id),
  staff_type       text NOT NULL CHECK (staff_type IN ('DOCTOR','NURSE','MIDWIFE','PHARMACIST','PHARMACY_TECH','LAB_ANALYST','RADIOGRAPHER','AMBULANCE_DRIVER','PARAMEDIC','ADMIN')),
  full_name        text NOT NULL,
  title_prefix     text,           -- dr., Ns., apt.
  title_suffix     text,           -- Sp.OK, S.Kep, S.Farm
  specialty        text,
  str_no           text,           -- Surat Tanda Registrasi
  str_valid_until  date,
  sip_no           text,           -- Surat Izin Praktik
  sip_valid_until  date,
  phone            text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_LEAVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX medical_staff_clinic_idx ON medical_staff (home_clinic_id, staff_type);
CREATE VIEW v_doctor WITH (security_invoker = true) AS SELECT * FROM medical_staff WHERE staff_type = 'DOCTOR';
CREATE VIEW v_nurse  WITH (security_invoker = true) AS SELECT * FROM medical_staff WHERE staff_type IN ('NURSE','MIDWIFE');

-- Doctor schedule (may rotate across clinics)
CREATE TABLE staff_schedule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  staff_id    uuid NOT NULL REFERENCES medical_staff(id),
  clinic_id   uuid NOT NULL REFERENCES clinic_profile(id),
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Monday
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  quota       int CHECK (quota IS NULL OR quota > 0),
  valid_from  date NOT NULL DEFAULT current_date,
  valid_to    date,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (end_time > start_time)
);
CREATE INDEX staff_schedule_clinic_idx ON staff_schedule (clinic_id, weekday);

-- Clinic-level schedule exceptions (holiday, closure, emergency-only days)
CREATE TABLE clinic_schedule_exception (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  clinic_id   uuid NOT NULL REFERENCES clinic_profile(id),
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  status      text NOT NULL CHECK (status IN ('CLOSED','EMERGENCY_ONLY','REDUCED_HOURS')),
  reason      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (date_to >= date_from)
);

CREATE TABLE appointment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  clinic_id      uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  staff_id       uuid REFERENCES medical_staff(id),
  scheduled_at   timestamptz NOT NULL,
  duration_min   int NOT NULL DEFAULT 15 CHECK (duration_min BETWEEN 5 AND 240),
  appointment_type text NOT NULL DEFAULT 'CONSULTATION' CHECK (appointment_type IN ('CONSULTATION','FOLLOW_UP','MCU','VACCINATION','RETURN_TO_WORK','OTHER')),
  reason         text,
  status         text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','CONFIRMED','CHECKED_IN','NO_SHOW','CANCELLED','COMPLETED')),
  cancel_reason  text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
CREATE INDEX appointment_clinic_time_idx ON appointment (clinic_id, scheduled_at);
CREATE INDEX appointment_patient_idx ON appointment (patient_id);

-- Queue ticket = one visit's journey: REGISTRATION → TRIAGE → DOCTOR → PHARMACY → COMPLETE
CREATE TABLE queue_ticket (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  clinic_id      uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  appointment_id uuid REFERENCES appointment(id),
  visit_date     date NOT NULL DEFAULT current_date,
  queue_no       int  NOT NULL CHECK (queue_no > 0),
  queue_code     text NOT NULL,                -- e.g. A-012 / P-003 / E-001
  source         text NOT NULL DEFAULT 'WALK_IN' CHECK (source IN ('WALK_IN','APPOINTMENT','ACCIDENT','REFERRAL_RETURN','MCU','FOLLOW_UP')),
  priority       text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','PRIORITY','EMERGENCY')),
  triage_level   text CHECK (triage_level IN ('RED','YELLOW','GREEN','BLACK')),
  status         text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','TRIAGE','WAITING_DOCTOR','IN_CONSULTATION','PHARMACY','COMPLETED','CANCELLED')),
  assigned_staff_id uuid REFERENCES medical_staff(id),
  room_id        uuid REFERENCES clinic_room(id),
  registered_at  timestamptz NOT NULL DEFAULT now(),
  triage_at      timestamptz,
  consult_start_at timestamptz,
  consult_end_at timestamptz,
  pharmacy_at    timestamptz,
  completed_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (clinic_id, visit_date, queue_code)
);
CREATE INDEX queue_ticket_board_idx ON queue_ticket (clinic_id, visit_date, status);
CREATE INDEX queue_ticket_patient_idx ON queue_ticket (patient_id, visit_date DESC);

-- Encounter = one medical record entry (the "MedicalRecord" entity).
CREATE TABLE encounter (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  encounter_no      text NOT NULL,
  clinic_id         uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id        uuid NOT NULL REFERENCES patient(id),
  queue_ticket_id   uuid UNIQUE REFERENCES queue_ticket(id),
  doctor_id         uuid REFERENCES medical_staff(id),
  nurse_id          uuid REFERENCES medical_staff(id),
  encounter_type    text NOT NULL CHECK (encounter_type IN ('OUTPATIENT','EMERGENCY','INPATIENT','MCU','FOLLOW_UP','HOME_VISIT','TELECONSULT')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  -- S.O.A.P — confidential clinical content (EMR module only)
  chief_complaint   text,
  history_of_present_illness text,
  physical_exam     text,
  assessment        text,
  plan              text,
  doctor_notes      text,
  -- disposition
  disposition       text CHECK (disposition IN ('HOME','REST','REFERRED','ADMITTED','RETURN_TO_WORK','DECEASED','LEFT_AGAINST_ADVICE')),
  follow_up_date    date,
  is_work_related   boolean NOT NULL DEFAULT false,
  accident_id       uuid,          -- FK added in 0007
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SIGNED','CANCELLED')),
  signed_at         timestamptz,
  signed_by         uuid REFERENCES medical_staff(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, encounter_no),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (status <> 'SIGNED' OR (signed_at IS NOT NULL AND signed_by IS NOT NULL))
);
CREATE INDEX encounter_patient_idx ON encounter (patient_id, started_at DESC);
CREATE INDEX encounter_clinic_idx  ON encounter (clinic_id, started_at DESC);

-- A signed medical record is legally final. Corrections go to encounter_addendum.
CREATE OR REPLACE FUNCTION app.tg_encounter_signed_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SIGNED' AND (
       NEW.chief_complaint IS DISTINCT FROM OLD.chief_complaint OR
       NEW.history_of_present_illness IS DISTINCT FROM OLD.history_of_present_illness OR
       NEW.physical_exam IS DISTINCT FROM OLD.physical_exam OR
       NEW.assessment IS DISTINCT FROM OLD.assessment OR
       NEW.plan IS DISTINCT FROM OLD.plan OR
       NEW.doctor_notes IS DISTINCT FROM OLD.doctor_notes OR
       NEW.patient_id IS DISTINCT FROM OLD.patient_id OR
       NEW.clinic_id IS DISTINCT FROM OLD.clinic_id OR
       NEW.status <> 'SIGNED') THEN
    RAISE EXCEPTION 'encounter % is signed; add an addendum instead', OLD.encounter_no USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER encounter_signed_lock BEFORE UPDATE ON encounter
  FOR EACH ROW EXECUTE FUNCTION app.tg_encounter_signed_lock();

CREATE TABLE encounter_addendum (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  encounter_id  uuid NOT NULL REFERENCES encounter(id),
  author_id     uuid NOT NULL REFERENCES medical_staff(id),
  reason        text NOT NULL,
  content       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE vital_sign (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  encounter_id  uuid NOT NULL REFERENCES encounter(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  recorded_by   uuid REFERENCES medical_staff(id),
  systolic      smallint CHECK (systolic BETWEEN 40 AND 300),
  diastolic     smallint CHECK (diastolic BETWEEN 20 AND 200),
  heart_rate    smallint CHECK (heart_rate BETWEEN 20 AND 250),
  respiratory_rate smallint CHECK (respiratory_rate BETWEEN 4 AND 80),
  temperature_c numeric(4,1) CHECK (temperature_c BETWEEN 30 AND 45),
  spo2          smallint CHECK (spo2 BETWEEN 50 AND 100),
  weight_kg     numeric(5,1) CHECK (weight_kg BETWEEN 1 AND 350),
  height_cm     numeric(5,1) CHECK (height_cm BETWEEN 30 AND 250),
  bmi           numeric(5,1) GENERATED ALWAYS AS (
                  CASE WHEN weight_kg IS NOT NULL AND height_cm IS NOT NULL
                       THEN round(weight_kg / ((height_cm/100.0)^2), 1) END) STORED,
  blood_glucose smallint CHECK (blood_glucose BETWEEN 10 AND 900),
  pain_score    smallint CHECK (pain_score BETWEEN 0 AND 10),
  gcs           smallint CHECK (gcs BETWEEN 3 AND 15),
  notes         text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (systolic IS NULL OR diastolic IS NULL OR systolic > diastolic)
);
CREATE INDEX vital_sign_encounter_idx ON vital_sign (encounter_id);

CREATE TABLE diagnosis (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  encounter_id    uuid NOT NULL REFERENCES encounter(id),
  icd10_code      text NOT NULL REFERENCES icd10_code(code),
  diagnosis_type  text NOT NULL DEFAULT 'PRIMARY' CHECK (diagnosis_type IN ('PRIMARY','SECONDARY','DIFFERENTIAL')),
  certainty       text NOT NULL DEFAULT 'CONFIRMED' CHECK (certainty IN ('PROVISIONAL','CONFIRMED','RULED_OUT')),
  is_occupational boolean NOT NULL DEFAULT false,
  notes           text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX diagnosis_encounter_idx ON diagnosis (encounter_id);
CREATE INDEX diagnosis_icd_idx ON diagnosis (icd10_code);
CREATE UNIQUE INDEX diagnosis_one_primary ON diagnosis (encounter_id)
  WHERE diagnosis_type = 'PRIMARY' AND deleted_at IS NULL;

-- Treatments / procedures performed (wound care, nebulisation, suturing, ...)
CREATE TABLE encounter_procedure (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  encounter_id  uuid NOT NULL REFERENCES encounter(id),
  procedure_code text,                  -- ICD-9-CM optional
  description   text NOT NULL,
  performed_by  uuid REFERENCES medical_staff(id),
  performed_at  timestamptz NOT NULL DEFAULT now(),
  notes         text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX encounter_procedure_enc_idx ON encounter_procedure (encounter_id);

CREATE TABLE inpatient_stay (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  clinic_id     uuid NOT NULL REFERENCES clinic_profile(id),
  encounter_id  uuid NOT NULL REFERENCES encounter(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  bed_id        uuid REFERENCES clinic_bed(id),
  admitted_at   timestamptz NOT NULL DEFAULT now(),
  discharged_at timestamptz,
  status        text NOT NULL DEFAULT 'ADMITTED' CHECK (status IN ('ADMITTED','DISCHARGED','TRANSFERRED','REFERRED')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (discharged_at IS NULL OR discharged_at >= admitted_at)
);
CREATE INDEX inpatient_stay_clinic_idx ON inpatient_stay (clinic_id, status);

-- -----------------------------------------------------------------------------
-- LABORATORY
-- -----------------------------------------------------------------------------
CREATE TABLE lab_test (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('HEMATOLOGY','CHEMISTRY','URINALYSIS','SEROLOGY','MICROBIOLOGY','TOXICOLOGY','IMAGING','OTHER')),
  specimen    text,
  result_type text NOT NULL DEFAULT 'NUMERIC' CHECK (result_type IN ('NUMERIC','TEXT','POS_NEG')),
  unit        text,
  ref_low_m   numeric, ref_high_m numeric,
  ref_low_f   numeric, ref_high_f numeric,
  critical_low numeric, critical_high numeric,
  ref_text    text,
  price       numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE lab_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  order_no      text NOT NULL,
  clinic_id     uuid NOT NULL REFERENCES clinic_profile(id),
  patient_id    uuid NOT NULL REFERENCES patient(id),
  encounter_id  uuid REFERENCES encounter(id),
  mcu_id        uuid,                        -- FK added in 0007
  ordered_by    uuid REFERENCES medical_staff(id),
  ordered_at    timestamptz NOT NULL DEFAULT now(),
  priority      text NOT NULL DEFAULT 'ROUTINE' CHECK (priority IN ('ROUTINE','URGENT','STAT')),
  status        text NOT NULL DEFAULT 'ORDERED' CHECK (status IN ('ORDERED','COLLECTED','IN_PROGRESS','RESULTED','VERIFIED','CANCELLED')),
  external_lab  text,                        -- when sent out
  clinical_info text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, order_no)
);
CREATE INDEX lab_order_patient_idx ON lab_order (patient_id, ordered_at DESC);
CREATE INDEX lab_order_clinic_idx  ON lab_order (clinic_id, status);

CREATE TABLE lab_result (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  lab_order_id  uuid NOT NULL REFERENCES lab_order(id),
  lab_test_id   uuid NOT NULL REFERENCES lab_test(id),
  value_numeric numeric,
  value_text    text,
  unit          text,
  ref_range     text,
  flag          text CHECK (flag IN ('NORMAL','LOW','HIGH','CRITICAL_LOW','CRITICAL_HIGH','ABNORMAL','POSITIVE','NEGATIVE')),
  resulted_at   timestamptz,
  resulted_by   uuid REFERENCES medical_staff(id),
  verified_at   timestamptz,
  verified_by   uuid REFERENCES medical_staff(id),
  notes         text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (lab_order_id, lab_test_id),
  CHECK (verified_at IS NULL OR verified_by IS NOT NULL)
);

-- Automatic abnormal flag from the reference range (sex-specific).
CREATE OR REPLACE FUNCTION app.tg_lab_result_flag() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE t lab_test%ROWTYPE; sex char(1); lo numeric; hi numeric;
BEGIN
  IF NEW.value_numeric IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO t FROM lab_test WHERE id = NEW.lab_test_id;
  SELECT p.gender INTO sex FROM lab_order o JOIN patient p ON p.id = o.patient_id WHERE o.id = NEW.lab_order_id;
  lo := CASE WHEN sex = 'F' THEN coalesce(t.ref_low_f,  t.ref_low_m)  ELSE t.ref_low_m  END;
  hi := CASE WHEN sex = 'F' THEN coalesce(t.ref_high_f, t.ref_high_m) ELSE t.ref_high_m END;
  NEW.unit := coalesce(NEW.unit, t.unit);
  NEW.ref_range := coalesce(NEW.ref_range, CASE WHEN lo IS NOT NULL OR hi IS NOT NULL THEN coalesce(lo::text,'') || ' - ' || coalesce(hi::text,'') END);
  NEW.flag := CASE
    WHEN t.critical_low  IS NOT NULL AND NEW.value_numeric < t.critical_low  THEN 'CRITICAL_LOW'
    WHEN t.critical_high IS NOT NULL AND NEW.value_numeric > t.critical_high THEN 'CRITICAL_HIGH'
    WHEN lo IS NOT NULL AND NEW.value_numeric < lo THEN 'LOW'
    WHEN hi IS NOT NULL AND NEW.value_numeric > hi THEN 'HIGH'
    ELSE 'NORMAL' END;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_result_flag BEFORE INSERT OR UPDATE OF value_numeric ON lab_result
  FOR EACH ROW EXECUTE FUNCTION app.tg_lab_result_flag();

-- -----------------------------------------------------------------------------
-- ATTACHMENTS (files live in S3/MinIO; DB keeps metadata + checksum).
-- owner_unit_id decides visibility; is_clinical routes it to the EMR module.
-- -----------------------------------------------------------------------------
CREATE TABLE attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  owner_unit_id uuid NOT NULL REFERENCES org_unit(id),
  module        text NOT NULL REFERENCES permission_module(code),
  entity_type   text NOT NULL,     -- encounter, lab_order, accident, referral, ...
  entity_id     uuid NOT NULL,
  file_name     text NOT NULL,
  mime_type     text NOT NULL CHECK (mime_type ~ '^(image/(png|jpeg|webp)|application/pdf|text/plain|application/vnd\.openxmlformats-officedocument\.[a-z.]+)$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),   -- ≤ 25 MB
  storage_key   text NOT NULL UNIQUE,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  description   text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX attachment_entity_idx ON attachment (entity_type, entity_id);
