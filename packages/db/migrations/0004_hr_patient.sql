-- =============================================================================
-- 0004 HR MASTER & PATIENT
--   risk_category ← job_position ← employee ← family_member
--   patient (employee | family | contractor | visitor | other)
-- =============================================================================

-- Occupational risk profile of a job (Harvester, Sprayer, ...). Drives the
-- MCU programme: which examinations and how often.
CREATE TABLE risk_category (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name                text NOT NULL,
  risk_level          text NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','VERY_HIGH')),
  hazards             text[] NOT NULL DEFAULT '{}',   -- e.g. {PESTICIDE,ERGONOMIC,SHARP_TOOLS}
  mcu_interval_months int NOT NULL DEFAULT 12 CHECK (mcu_interval_months BETWEEN 1 AND 60),
  required_exams      text[] NOT NULL DEFAULT '{}',   -- lab_test / exam codes
  description         text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE job_position (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name             text NOT NULL,
  job_family       text NOT NULL CHECK (job_family IN ('FIELD','MILL','WORKSHOP','TRANSPORT','SECURITY','OFFICE','MEDICAL','MANAGEMENT')),
  risk_category_id uuid NOT NULL REFERENCES risk_category(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE employee (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  employee_no            text NOT NULL CHECK (employee_no ~ '^[A-Z0-9-]{3,30}$'),
  nik                    text NOT NULL CHECK (nik ~ '^[0-9]{16}$'),        -- Indonesian national ID
  full_name              text NOT NULL CHECK (length(trim(full_name)) >= 2),
  gender                 char(1) NOT NULL CHECK (gender IN ('M','F')),
  birth_date             date NOT NULL CHECK (birth_date > '1930-01-01'),
  birth_place            text,
  marital_status         text CHECK (marital_status IN ('SINGLE','MARRIED','DIVORCED','WIDOWED')),
  address                text,
  phone                  text CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{6,20}$'),
  email                  citext,
  -- organisational placement (company_id / estate_id are derived by trigger)
  org_unit_id            uuid NOT NULL REFERENCES org_unit(id),   -- division / afdeling / mill / department
  department_id          uuid REFERENCES org_unit(id),
  company_id             uuid REFERENCES org_unit(id),
  estate_id              uuid REFERENCES org_unit(id),
  position_id            uuid NOT NULL REFERENCES job_position(id),
  risk_category_id       uuid REFERENCES risk_category(id),        -- override; defaults from position
  employment_type        text NOT NULL CHECK (employment_type IN ('PERMANENT','CONTRACT','DAILY_WORKER','SEASONAL','INTERN')),
  employment_status      text NOT NULL DEFAULT 'ACTIVE' CHECK (employment_status IN ('ACTIVE','SUSPENDED','RESIGNED','TERMINATED','RETIRED','DECEASED')),
  join_date              date NOT NULL,
  end_date               date,
  bpjs_kesehatan_no      text CHECK (bpjs_kesehatan_no IS NULL OR bpjs_kesehatan_no ~ '^[0-9]{13}$'),
  bpjs_ketenagakerjaan_no text CHECK (bpjs_ketenagakerjaan_no IS NULL OR bpjs_ketenagakerjaan_no ~ '^[0-9]{11}$'),
  insurance_provider     text,
  insurance_policy_no    text,
  emergency_contact_name text,
  emergency_contact_phone text,
  emergency_contact_relation text,
  photo_key              text,
  qr_token               text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, employee_no),
  CHECK (end_date IS NULL OR end_date >= join_date),
  CHECK (join_date > birth_date + interval '15 years')
);
CREATE UNIQUE INDEX employee_nik_uq ON employee (tenant_id, nik) WHERE deleted_at IS NULL;
CREATE INDEX employee_unit_idx    ON employee (org_unit_id);
CREATE INDEX employee_company_idx ON employee (company_id);
CREATE INDEX employee_estate_idx  ON employee (estate_id);
CREATE INDEX employee_name_trgm   ON employee USING gin (full_name gin_trgm_ops);

ALTER TABLE app_user ADD CONSTRAINT app_user_employee_fk FOREIGN KEY (employee_id) REFERENCES employee(id);

CREATE OR REPLACE FUNCTION app.tg_employee_placement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.org_unit_id AND tenant_id = NEW.tenant_id
                   AND unit_type IN ('DIVISION','AFDELING','MILL','DEPARTMENT','ESTATE','CLINIC','WAREHOUSE','COMPANY','GROUP')) THEN
    RAISE EXCEPTION 'invalid work unit for employee' USING ERRCODE = '23514';
  END IF;
  NEW.company_id := app.ancestor_of_type(NEW.org_unit_id, 'COMPANY');
  NEW.estate_id  := app.ancestor_of_type(NEW.org_unit_id, 'ESTATE');
  IF NEW.risk_category_id IS NULL THEN
    SELECT risk_category_id INTO NEW.risk_category_id FROM job_position WHERE id = NEW.position_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_placement BEFORE INSERT OR UPDATE OF org_unit_id, position_id ON employee
  FOR EACH ROW EXECUTE FUNCTION app.tg_employee_placement();

CREATE TABLE family_member (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  employee_id     uuid NOT NULL REFERENCES employee(id),
  relationship    text NOT NULL CHECK (relationship IN ('SPOUSE','CHILD','PARENT','OTHER_DEPENDENT')),
  nik             text CHECK (nik IS NULL OR nik ~ '^[0-9]{16}$'),
  full_name       text NOT NULL CHECK (length(trim(full_name)) >= 2),
  gender          char(1) NOT NULL CHECK (gender IN ('M','F')),
  birth_date      date NOT NULL,
  phone           text,
  bpjs_kesehatan_no text CHECK (bpjs_kesehatan_no IS NULL OR bpjs_kesehatan_no ~ '^[0-9]{13}$'),
  is_dependent    boolean NOT NULL DEFAULT true,   -- covered by company health benefit
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX family_member_emp_idx ON family_member (employee_id);

-- -----------------------------------------------------------------------------
-- PATIENT — a person who can receive care. Linked to employee or family
-- member when applicable. primary_clinic_id determines default visibility.
-- -----------------------------------------------------------------------------
CREATE TABLE patient (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  mrn                text NOT NULL,               -- medical record number (unique per tenant)
  patient_type       text NOT NULL CHECK (patient_type IN ('EMPLOYEE','SPOUSE','CHILD','DEPENDENT','CONTRACTOR','VISITOR','OTHER')),
  employee_id        uuid REFERENCES employee(id),
  family_member_id   uuid REFERENCES family_member(id),
  primary_clinic_id  uuid NOT NULL REFERENCES clinic_profile(id),
  nik                text CHECK (nik IS NULL OR nik ~ '^[0-9]{16}$'),
  full_name          text NOT NULL CHECK (length(trim(full_name)) >= 2),
  gender             char(1) NOT NULL CHECK (gender IN ('M','F')),
  birth_date         date NOT NULL,
  blood_type         text CHECK (blood_type IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','UNKNOWN')),
  phone              text CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{6,20}$'),
  address            text,
  contractor_company text,
  payer_type         text NOT NULL DEFAULT 'COMPANY' CHECK (payer_type IN ('COMPANY','BPJS','INSURANCE','SELF','OTHER')),
  bpjs_kesehatan_no  text,
  is_deceased        boolean NOT NULL DEFAULT false,
  qr_token           text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, mrn),
  CHECK (patient_type <> 'EMPLOYEE' OR employee_id IS NOT NULL),
  CHECK (patient_type NOT IN ('SPOUSE','CHILD','DEPENDENT') OR family_member_id IS NOT NULL),
  CHECK (patient_type <> 'CONTRACTOR' OR contractor_company IS NOT NULL)
);
CREATE UNIQUE INDEX patient_employee_uq ON patient (employee_id) WHERE employee_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX patient_family_uq   ON patient (family_member_id) WHERE family_member_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX patient_clinic_idx ON patient (primary_clinic_id);
CREATE INDEX patient_nik_idx    ON patient (tenant_id, nik);
CREATE INDEX patient_phone_idx  ON patient (tenant_id, phone);
CREATE INDEX patient_name_trgm  ON patient USING gin (full_name gin_trgm_ops);

CREATE TABLE patient_allergy (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  allergen_type text NOT NULL CHECK (allergen_type IN ('DRUG','FOOD','ENVIRONMENT','OTHER')),
  allergen    text NOT NULL,
  medicine_id uuid,                    -- FK added in 0006 (drug allergies → dispensing check)
  reaction    text,
  severity    text NOT NULL CHECK (severity IN ('MILD','MODERATE','SEVERE','LIFE_THREATENING')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED','REFUTED')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX patient_allergy_patient_idx ON patient_allergy (patient_id);

-- Past medical / chronic / family / surgical history
CREATE TABLE patient_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  patient_id   uuid NOT NULL REFERENCES patient(id),
  history_type text NOT NULL CHECK (history_type IN ('PAST_ILLNESS','CHRONIC','SURGICAL','FAMILY','SOCIAL','IMMUNIZATION','OBSTETRIC')),
  icd10_code   text,
  description  text NOT NULL,
  onset_date   date,
  is_active    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX patient_history_patient_idx ON patient_history (patient_id);
