-- =============================================================================
-- 0006 PHARMACY & MULTI-SITE INVENTORY
-- Stock sites are org units of type CLINIC or WAREHOUSE.
-- Stock is NEVER edited directly: every movement is an append-only
-- inventory_transaction and inventory_stock is maintained by trigger.
-- =============================================================================

CREATE TABLE medicine_category (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  code       text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,30}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE medicine (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  code            text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name            text NOT NULL,
  generic_name    text NOT NULL,
  category_id     uuid NOT NULL REFERENCES medicine_category(id),
  dosage_form     text NOT NULL CHECK (dosage_form IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','INJECTION','INFUSION','CREAM','OINTMENT','DROPS','INHALER','SUPPOSITORY','POWDER','CONSUMABLE','OTHER')),
  strength        text,
  unit            text NOT NULL,                -- dispensing unit: tablet, botol, ampul, tube, pcs
  drug_class      text NOT NULL DEFAULT 'OTC' CHECK (drug_class IN ('OTC','LIMITED_OTC','PRESCRIPTION','PSYCHOTROPIC','NARCOTIC','CONSUMABLE')),
  is_fornas       boolean NOT NULL DEFAULT false,   -- Formularium Nasional
  default_min_stock int NOT NULL DEFAULT 0 CHECK (default_min_stock >= 0),
  standard_cost   numeric(14,2) NOT NULL DEFAULT 0 CHECK (standard_cost >= 0),
  barcode         text,
  qr_token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  is_active       boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);
CREATE INDEX medicine_name_trgm ON medicine USING gin ((name || ' ' || generic_name) gin_trgm_ops);

ALTER TABLE patient_allergy ADD CONSTRAINT patient_allergy_medicine_fk FOREIGN KEY (medicine_id) REFERENCES medicine(id);

CREATE TABLE supplier (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  code        text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name        text NOT NULL,
  npwp        text,
  contact_name text, phone text, email citext, address text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE medicine_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  medicine_id  uuid NOT NULL REFERENCES medicine(id),
  batch_no     text NOT NULL,
  expiry_date  date NOT NULL,
  manufacture_date date,
  supplier_id  uuid REFERENCES supplier(id),
  unit_cost    numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, medicine_id, batch_no),
  CHECK (manufacture_date IS NULL OR manufacture_date < expiry_date)
);
CREATE INDEX medicine_batch_expiry_idx ON medicine_batch (expiry_date);

-- Min/max per site & medicine (overrides medicine.default_min_stock)
CREATE TABLE inventory_level (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  medicine_id  uuid NOT NULL REFERENCES medicine(id),
  min_qty      numeric(14,2) NOT NULL CHECK (min_qty >= 0),
  max_qty      numeric(14,2) CHECK (max_qty IS NULL OR max_qty >= min_qty),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (org_unit_id, medicine_id)
);

-- Current on-hand per site × batch. Maintained ONLY by trigger.
CREATE TABLE inventory_stock (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  medicine_id  uuid NOT NULL REFERENCES medicine(id),
  batch_id     uuid NOT NULL REFERENCES medicine_batch(id),
  qty_on_hand  numeric(14,2) NOT NULL DEFAULT 0 CHECK (qty_on_hand >= 0),
  last_movement_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_unit_id, batch_id)
);
CREATE INDEX inventory_stock_med_idx ON inventory_stock (org_unit_id, medicine_id);

CREATE TABLE inventory_transaction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  txn_no       text,
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  medicine_id  uuid NOT NULL REFERENCES medicine(id),
  batch_id     uuid NOT NULL REFERENCES medicine_batch(id),
  txn_type     text NOT NULL CHECK (txn_type IN ('OPENING','RECEIPT','DISPENSE','RETURN_FROM_PATIENT','ADJUSTMENT_IN','ADJUSTMENT_OUT',
                                                 'TRANSFER_OUT','TRANSFER_IN','OPNAME_GAIN','OPNAME_LOSS','EXPIRED_WRITE_OFF','DAMAGED_WRITE_OFF','RETURN_TO_SUPPLIER')),
  qty          numeric(14,2) NOT NULL CHECK (qty <> 0),   -- signed: + in, − out
  unit_cost    numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  ref_type     text,          -- purchase_order / prescription / stock_transfer / stock_opname
  ref_id       uuid,
  reason       text,
  txn_at       timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK ((txn_type IN ('OPENING','RECEIPT','RETURN_FROM_PATIENT','ADJUSTMENT_IN','TRANSFER_IN','OPNAME_GAIN') AND qty > 0)
      OR (txn_type IN ('DISPENSE','ADJUSTMENT_OUT','TRANSFER_OUT','OPNAME_LOSS','EXPIRED_WRITE_OFF','DAMAGED_WRITE_OFF','RETURN_TO_SUPPLIER') AND qty < 0)),
  CHECK (txn_type NOT IN ('ADJUSTMENT_IN','ADJUSTMENT_OUT','DAMAGED_WRITE_OFF') OR reason IS NOT NULL)
);
CREATE INDEX inventory_txn_site_idx ON inventory_transaction (org_unit_id, txn_at DESC);
CREATE INDEX inventory_txn_med_idx  ON inventory_transaction (medicine_id, txn_at DESC);
CREATE INDEX inventory_txn_ref_idx  ON inventory_transaction (ref_type, ref_id);

CREATE OR REPLACE FUNCTION app.tg_inventory_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_new numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM org_unit u JOIN org_unit_type t ON t.code = u.unit_type
                  WHERE u.id = NEW.org_unit_id AND t.is_stock_site AND u.tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'org unit is not a stock site' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM medicine_batch WHERE id = NEW.batch_id AND medicine_id = NEW.medicine_id) THEN
    RAISE EXCEPTION 'batch does not belong to medicine' USING ERRCODE = '23514';
  END IF;

  INSERT INTO inventory_stock (tenant_id, org_unit_id, medicine_id, batch_id, qty_on_hand, last_movement_at)
  VALUES (NEW.tenant_id, NEW.org_unit_id, NEW.medicine_id, NEW.batch_id, 0, NEW.txn_at)
  ON CONFLICT (org_unit_id, batch_id) DO NOTHING;

  -- row lock serialises concurrent movements on the same site × batch
  SELECT qty_on_hand + NEW.qty INTO v_new FROM inventory_stock
   WHERE org_unit_id = NEW.org_unit_id AND batch_id = NEW.batch_id FOR UPDATE;
  IF v_new < 0 THEN
    RAISE EXCEPTION 'insufficient stock: on hand %, requested %', v_new - NEW.qty, -NEW.qty USING ERRCODE = '23514';
  END IF;

  UPDATE inventory_stock
     SET qty_on_hand = v_new, last_movement_at = NEW.txn_at, updated_at = now()
   WHERE org_unit_id = NEW.org_unit_id AND batch_id = NEW.batch_id;
  RETURN NULL;
END $$;
-- (CHECK qty_on_hand >= 0 remains as a last line of defence.)
CREATE TRIGGER inventory_apply AFTER INSERT ON inventory_transaction
  FOR EACH ROW EXECUTE FUNCTION app.tg_inventory_apply();

CREATE OR REPLACE FUNCTION app.tg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a correcting entry instead', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER inventory_txn_append_only BEFORE UPDATE OR DELETE ON inventory_transaction
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();

-- -----------------------------------------------------------------------------
-- Purchasing & receiving
-- -----------------------------------------------------------------------------
CREATE TABLE purchase_order (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  po_no        text NOT NULL,
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),   -- receiving site
  supplier_id  uuid NOT NULL REFERENCES supplier(id),
  order_date   date NOT NULL DEFAULT current_date,
  expected_date date,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  approved_by  uuid, approved_at timestamptz,
  total_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  notes        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, po_no)
);

CREATE TABLE purchase_order_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  purchase_order_id uuid NOT NULL REFERENCES purchase_order(id),
  medicine_id       uuid NOT NULL REFERENCES medicine(id),
  qty_ordered       numeric(14,2) NOT NULL CHECK (qty_ordered > 0),
  qty_received      numeric(14,2) NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_price        numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (qty_received <= qty_ordered)
);

-- -----------------------------------------------------------------------------
-- Inter-clinic / warehouse transfer: REQUEST → APPROVAL → TRANSFER → RECEIVING → STOCK UPDATE
-- -----------------------------------------------------------------------------
CREATE TABLE stock_transfer (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  transfer_no    text NOT NULL,
  from_unit_id   uuid NOT NULL REFERENCES org_unit(id),   -- supplying site
  to_unit_id     uuid NOT NULL REFERENCES org_unit(id),   -- requesting site
  status         text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','IN_TRANSIT','RECEIVED','CANCELLED')),
  priority       text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL','URGENT')),
  requested_by   uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid, approved_at timestamptz,
  shipped_by     uuid, shipped_at timestamptz,
  received_by    uuid, received_at timestamptz,
  reject_reason  text,
  notes          text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, transfer_no),
  CHECK (from_unit_id <> to_unit_id),
  CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL)
);

CREATE TABLE stock_transfer_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  stock_transfer_id uuid NOT NULL REFERENCES stock_transfer(id),
  medicine_id       uuid NOT NULL REFERENCES medicine(id),
  batch_id          uuid REFERENCES medicine_batch(id),    -- chosen by the supplier at shipping
  qty_requested     numeric(14,2) NOT NULL CHECK (qty_requested > 0),
  qty_approved      numeric(14,2) CHECK (qty_approved >= 0),
  qty_shipped       numeric(14,2) CHECK (qty_shipped >= 0),
  qty_received      numeric(14,2) CHECK (qty_received >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);

CREATE TABLE stock_opname (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  opname_no    text NOT NULL,
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  count_date   date NOT NULL DEFAULT current_date,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COUNTING','SUBMITTED','APPROVED','POSTED','CANCELLED')),
  approved_by  uuid, approved_at timestamptz,
  notes        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, opname_no)
);

CREATE TABLE stock_opname_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  stock_opname_id uuid NOT NULL REFERENCES stock_opname(id),
  batch_id        uuid NOT NULL REFERENCES medicine_batch(id),
  system_qty      numeric(14,2) NOT NULL,
  counted_qty     numeric(14,2) NOT NULL CHECK (counted_qty >= 0),
  variance        numeric(14,2) GENERATED ALWAYS AS (counted_qty - system_qty) STORED,
  notes           text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (stock_opname_id, batch_id)
);

-- -----------------------------------------------------------------------------
-- PRESCRIPTION (written by doctor in EMR, dispensed by pharmacy)
-- -----------------------------------------------------------------------------
CREATE TABLE prescription (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  prescription_no text NOT NULL,
  clinic_id      uuid NOT NULL REFERENCES clinic_profile(id),
  encounter_id   uuid NOT NULL REFERENCES encounter(id),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  prescriber_id  uuid NOT NULL REFERENCES medical_staff(id),
  prescribed_at  timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('DRAFT','SUBMITTED','IN_PREPARATION','DISPENSED','PARTIALLY_DISPENSED','CANCELLED')),
  dispensed_by   uuid REFERENCES medical_staff(id),
  dispensed_at   timestamptz,
  notes          text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  UNIQUE (tenant_id, prescription_no)
);
CREATE INDEX prescription_clinic_idx ON prescription (clinic_id, status, prescribed_at DESC);
CREATE INDEX prescription_patient_idx ON prescription (patient_id);

CREATE TABLE prescription_item (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  prescription_id uuid NOT NULL REFERENCES prescription(id),
  medicine_id     uuid NOT NULL REFERENCES medicine(id),
  qty             numeric(10,2) NOT NULL CHECK (qty > 0),
  dose            text NOT NULL,             -- "500 mg"
  frequency       text NOT NULL,             -- "3x1"
  route           text NOT NULL DEFAULT 'ORAL' CHECK (route IN ('ORAL','TOPICAL','IV','IM','SC','INHALATION','OPHTHALMIC','OTIC','RECTAL','OTHER')),
  duration_days   int CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  instructions    text,
  dispensed_qty   numeric(10,2) NOT NULL DEFAULT 0 CHECK (dispensed_qty >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (dispensed_qty <= qty)
);
CREATE INDEX prescription_item_rx_idx ON prescription_item (prescription_id);

-- Convenience view: on-hand per site & medicine with min level and alert state.
CREATE VIEW v_stock_position WITH (security_invoker = true) AS
SELECT s.tenant_id, s.org_unit_id, s.medicine_id,
       sum(s.qty_on_hand)                                         AS qty_on_hand,
       sum(s.qty_on_hand) FILTER (WHERE b.expiry_date >= current_date) AS qty_usable,
       coalesce(l.min_qty, m.default_min_stock)                    AS min_qty,
       min(b.expiry_date) FILTER (WHERE s.qty_on_hand > 0)         AS nearest_expiry,
       CASE WHEN coalesce(sum(s.qty_on_hand) FILTER (WHERE b.expiry_date >= current_date), 0)
                 < coalesce(l.min_qty, m.default_min_stock) THEN true ELSE false END AS is_low_stock
  FROM inventory_stock s
  JOIN medicine m       ON m.id = s.medicine_id
  JOIN medicine_batch b ON b.id = s.batch_id
  LEFT JOIN inventory_level l ON l.org_unit_id = s.org_unit_id AND l.medicine_id = s.medicine_id AND l.deleted_at IS NULL
 GROUP BY s.tenant_id, s.org_unit_id, s.medicine_id, l.min_qty, m.default_min_stock;
