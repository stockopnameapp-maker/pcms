-- =============================================================================
-- 0002 ORGANIZATION — dynamic hierarchy
--   tenant (= Group/Holding)  →  org_unit tree (ltree materialised path)
-- Any number of Groups, PTs, Regions, Estates, Mills, Divisions/Afdelings,
-- Departments, Clinics and Warehouses can be added as DATA — no code change.
-- Allowed parent→child combinations live in org_unit_type_rule (also data).
-- =============================================================================

CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        citext NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name        text   NOT NULL CHECK (length(trim(name)) >= 2),
  legal_name  text,
  status      text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','INACTIVE')),
  timezone    text   NOT NULL DEFAULT 'Asia/Jakarta',
  settings    jsonb  NOT NULL DEFAULT '{}'::jsonb,   -- e.g. alert thresholds, MCU policy
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_unit_type (
  code        text PRIMARY KEY,
  label_id    text NOT NULL,      -- Bahasa Indonesia label
  label_en    text NOT NULL,
  sort_order  int  NOT NULL,
  is_care_site boolean NOT NULL DEFAULT false,   -- can host patients (clinic)
  is_stock_site boolean NOT NULL DEFAULT false   -- can hold inventory
);

INSERT INTO org_unit_type VALUES
  ('GROUP',      'Grup / Holding',        'Group / Holding', 1, false, false),
  ('COMPANY',    'PT / Perusahaan',       'Company',         2, false, false),
  ('REGION',     'Region / Wilayah',      'Region',          3, false, false),
  ('ESTATE',     'Kebun / Estate',        'Estate',          4, false, false),
  ('MILL',       'Pabrik Kelapa Sawit',   'Mill',            4, false, false),
  ('DIVISION',   'Divisi',                'Division',        5, false, false),
  ('AFDELING',   'Afdeling',              'Afdeling',        6, false, false),
  ('DEPARTMENT', 'Departemen',            'Department',      5, false, false),
  ('CLINIC',     'Klinik',                'Clinic',          5, true,  true ),
  ('WAREHOUSE',  'Gudang Farmasi Pusat',  'Central Warehouse',5, false, true );

CREATE TABLE org_unit_type_rule (
  parent_type text NOT NULL REFERENCES org_unit_type(code),
  child_type  text NOT NULL REFERENCES org_unit_type(code),
  PRIMARY KEY (parent_type, child_type)
);

INSERT INTO org_unit_type_rule VALUES
  ('GROUP','COMPANY'), ('GROUP','CLINIC'), ('GROUP','WAREHOUSE'), ('GROUP','DEPARTMENT'),
  ('COMPANY','REGION'), ('COMPANY','ESTATE'), ('COMPANY','MILL'), ('COMPANY','DEPARTMENT'),
  ('COMPANY','CLINIC'), ('COMPANY','WAREHOUSE'),
  ('REGION','ESTATE'), ('REGION','MILL'), ('REGION','CLINIC'), ('REGION','WAREHOUSE'),
  ('ESTATE','DIVISION'), ('ESTATE','AFDELING'), ('ESTATE','DEPARTMENT'), ('ESTATE','CLINIC'),
  ('ESTATE','WAREHOUSE'), ('ESTATE','MILL'),
  ('DIVISION','AFDELING'), ('DIVISION','DEPARTMENT'),
  ('MILL','DEPARTMENT'), ('MILL','CLINIC');

CREATE TABLE org_unit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  parent_id   uuid REFERENCES org_unit(id),
  unit_type   text NOT NULL REFERENCES org_unit_type(code),
  code        citext NOT NULL CHECK (code ~ '^[A-Z0-9_.-]{2,30}$'),
  name        text NOT NULL CHECK (length(trim(name)) >= 2),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  path        ltree,                       -- maintained by trigger, never written by API
  depth       int,
  address     text,
  city        text,
  province    text,
  postal_code text,
  phone       text CHECK (phone IS NULL OR phone ~ '^[0-9+() -]{6,20}$'),
  email       citext CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  latitude    numeric(9,6) CHECK (latitude  BETWEEN -90  AND 90),
  longitude   numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
  area_ha     numeric(12,2) CHECK (area_ha IS NULL OR area_ha >= 0),   -- estate/division size
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version     int NOT NULL DEFAULT 1,
  deleted_at  timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code),
  CHECK ((unit_type = 'GROUP') = (parent_id IS NULL))
);
CREATE INDEX org_unit_path_gist   ON org_unit USING gist (path);
CREATE INDEX org_unit_parent_idx  ON org_unit (parent_id);
CREATE INDEX org_unit_type_idx    ON org_unit (tenant_id, unit_type);
CREATE INDEX org_unit_name_trgm   ON org_unit USING gin (name gin_trgm_ops);
CREATE UNIQUE INDEX org_unit_one_group_per_tenant ON org_unit (tenant_id) WHERE unit_type = 'GROUP';

CREATE OR REPLACE FUNCTION app.unit_label(p_id uuid) RETURNS ltree
LANGUAGE sql IMMUTABLE AS $$ SELECT text2ltree('u' || replace(p_id::text, '-', '')) $$;

-- Validate hierarchy & compute path/depth.
CREATE OR REPLACE FUNCTION app.tg_org_unit_path() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p org_unit%ROWTYPE;
BEGIN
  IF NEW.parent_id IS NULL THEN
    NEW.path := app.unit_label(NEW.id);
    NEW.depth := 1;
    RETURN NEW;
  END IF;

  SELECT * INTO p FROM org_unit WHERE id = NEW.parent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent org unit % not found', NEW.parent_id USING ERRCODE = '23503';
  END IF;
  IF p.tenant_id <> NEW.tenant_id THEN
    RAISE EXCEPTION 'parent belongs to another tenant' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_unit_type_rule
                  WHERE parent_type = p.unit_type AND child_type = NEW.unit_type) THEN
    RAISE EXCEPTION 'a % cannot be placed under a %', NEW.unit_type, p.unit_type USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND p.path <@ OLD.path THEN
    RAISE EXCEPTION 'cannot move an org unit under its own descendant' USING ERRCODE = '23514';
  END IF;

  NEW.path  := p.path || app.unit_label(NEW.id);
  NEW.depth := p.depth + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER org_unit_path BEFORE INSERT OR UPDATE OF parent_id, unit_type ON org_unit
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_unit_path();

-- Re-parenting cascades the new path to the whole subtree (e.g. Estate moved to another Region).
CREATE OR REPLACE FUNCTION app.tg_org_unit_move_subtree() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE org_unit
       SET path  = NEW.path || subpath(path, nlevel(OLD.path)),
           depth = NEW.depth + nlevel(path) - nlevel(OLD.path)
     WHERE path <@ OLD.path AND id <> NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER org_unit_move AFTER UPDATE OF parent_id ON org_unit
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_unit_move_subtree();

-- An org unit that still has active children cannot be deactivated or deleted.
CREATE OR REPLACE FUNCTION app.tg_org_unit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE' OR NEW.status = 'INACTIVE' OR NEW.deleted_at IS NOT NULL)
     AND EXISTS (SELECT 1 FROM org_unit c WHERE c.parent_id = OLD.id
                   AND c.status = 'ACTIVE' AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'org unit % still has active children', OLD.code USING ERRCODE = '23503';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER org_unit_guard BEFORE UPDATE OF status, deleted_at OR DELETE ON org_unit
  FOR EACH ROW EXECUTE FUNCTION app.tg_org_unit_guard();

-- Ancestor of a given type (e.g. the COMPANY that owns a division) — used by
-- reports/dashboards for roll-ups.
CREATE OR REPLACE FUNCTION app.ancestor_of_type(p_unit uuid, p_type text) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT a.id FROM org_unit u JOIN org_unit a ON a.path @> u.path AND a.tenant_id = u.tenant_id
   WHERE u.id = p_unit AND a.unit_type = p_type
   ORDER BY a.depth DESC LIMIT 1
$$;

-- -----------------------------------------------------------------------------
-- Clinic profile (1:1 extension of org_unit where unit_type = 'CLINIC')
-- -----------------------------------------------------------------------------
CREATE TABLE clinic_profile (
  id                 uuid PRIMARY KEY REFERENCES org_unit(id),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  clinic_type        text NOT NULL DEFAULT 'PRIMARY' CHECK (clinic_type IN ('PRIMARY','MAIN','MILL','MOBILE','FIRST_AID_POST')),
  operational_status text NOT NULL DEFAULT 'OPEN' CHECK (operational_status IN ('OPEN','CLOSED','EMERGENCY_ONLY')),
  license_no         text,
  license_valid_until date,
  emergency_phone    text CHECK (emergency_phone IS NULL OR emergency_phone ~ '^[0-9+() -]{3,20}$'),
  bed_capacity       int NOT NULL DEFAULT 0 CHECK (bed_capacity >= 0),
  has_pharmacy       boolean NOT NULL DEFAULT true,
  has_laboratory     boolean NOT NULL DEFAULT false,
  has_inpatient      boolean NOT NULL DEFAULT false,
  operating_hours    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"mon":[["07:00","15:00"]],...}
  service_area_unit_ids uuid[] NOT NULL DEFAULT '{}',     -- estates/divisions primarily served
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);

CREATE OR REPLACE FUNCTION app.tg_clinic_profile_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.id AND unit_type = 'CLINIC' AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'clinic_profile must reference a CLINIC org unit of the same tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clinic_profile_check BEFORE INSERT OR UPDATE ON clinic_profile
  FOR EACH ROW EXECUTE FUNCTION app.tg_clinic_profile_check();

CREATE TABLE clinic_room (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  clinic_id  uuid NOT NULL REFERENCES clinic_profile(id),
  code       text NOT NULL,
  name       text NOT NULL,
  room_type  text NOT NULL CHECK (room_type IN ('REGISTRATION','TRIAGE','CONSULTATION','EMERGENCY','INPATIENT','PHARMACY','LABORATORY','OBSERVATION','MCU')),
  status     text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','MAINTENANCE')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (clinic_id, code)
);

CREATE TABLE clinic_bed (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  clinic_id  uuid NOT NULL REFERENCES clinic_profile(id),
  room_id    uuid NOT NULL REFERENCES clinic_room(id),
  code       text NOT NULL,
  bed_type   text NOT NULL DEFAULT 'GENERAL' CHECK (bed_type IN ('GENERAL','OBSERVATION','EMERGENCY','ISOLATION')),
  status     text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','OCCUPIED','CLEANING','OUT_OF_SERVICE')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (clinic_id, code)
);

-- Medical equipment & clinic assets (QR-tagged)
CREATE TABLE clinic_asset (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  clinic_id        uuid NOT NULL REFERENCES clinic_profile(id),
  asset_code       text NOT NULL,
  name             text NOT NULL,
  asset_class      text NOT NULL CHECK (asset_class IN ('MEDICAL_EQUIPMENT','FURNITURE','IT','VEHICLE_EQUIPMENT','OTHER')),
  category         text,
  brand            text,
  serial_no        text,
  purchase_date    date,
  purchase_cost    numeric(16,2) CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  status           text NOT NULL DEFAULT 'IN_USE' CHECK (status IN ('IN_USE','IN_STORAGE','UNDER_MAINTENANCE','BROKEN','DISPOSED')),
  last_calibration date,
  next_maintenance date,
  qr_token         text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, asset_code)
);

-- Typed convenience views over the single hierarchy (the minimal entity list
-- Group/Company/Region/Estate/Mill/Division/Department/Clinic). They use
-- security_invoker so RLS of org_unit applies to the caller.
CREATE VIEW v_group      WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'GROUP';
CREATE VIEW v_company    WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'COMPANY';
CREATE VIEW v_region     WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'REGION';
CREATE VIEW v_estate     WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'ESTATE';
CREATE VIEW v_mill       WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'MILL';
CREATE VIEW v_division   WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type IN ('DIVISION','AFDELING');
CREATE VIEW v_department WITH (security_invoker = true) AS SELECT * FROM org_unit WHERE unit_type = 'DEPARTMENT';
CREATE VIEW v_clinic     WITH (security_invoker = true) AS
  SELECT u.*, c.clinic_type, c.operational_status, c.emergency_phone, c.bed_capacity,
         c.has_pharmacy, c.has_laboratory, c.has_inpatient, c.operating_hours
    FROM org_unit u JOIN clinic_profile c ON c.id = u.id;
