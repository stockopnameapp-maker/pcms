-- =============================================================================
-- 0008 FINANCE, NOTIFICATIONS, HEALTH ALERTS, DOCUMENT NUMBERING, WORKFLOW EVENTS
-- =============================================================================

-- Every cost is a row here (medicine dispensed, lab, referral/hospital bill,
-- ambulance, equipment, operational). Cost per Employee / PT / Estate / Clinic /
-- Disease are all aggregations of this table.
CREATE TABLE cost_transaction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  org_unit_id     uuid NOT NULL REFERENCES org_unit(id),     -- cost centre (usually the clinic)
  charged_unit_id uuid REFERENCES org_unit(id),               -- unit the cost is allocated to (employee's division)
  company_id      uuid REFERENCES org_unit(id),               -- derived from charged/org unit
  estate_id       uuid REFERENCES org_unit(id),               -- derived
  cost_category   text NOT NULL CHECK (cost_category IN ('MEDICINE','LAB','HOSPITAL','REFERRAL','AMBULANCE','EQUIPMENT','CLINIC_OPERATIONAL','MCU','OTHER')),
  amount          numeric(16,2) NOT NULL CHECK (amount <> 0),
  currency        char(3) NOT NULL DEFAULT 'IDR',
  txn_date        date NOT NULL,
  patient_id      uuid REFERENCES patient(id),
  employee_id     uuid REFERENCES employee(id),
  icd10_code      text REFERENCES icd10_code(code),          -- for cost-per-disease analytics
  source_type     text,          -- inventory_transaction / referral / ambulance_trip / lab_order / manual
  source_id       uuid,
  payer_type      text NOT NULL DEFAULT 'COMPANY' CHECK (payer_type IN ('COMPANY','BPJS','INSURANCE','SELF')),
  description     text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX cost_txn_unit_date_idx ON cost_transaction (org_unit_id, txn_date);
CREATE INDEX cost_txn_company_idx ON cost_transaction (company_id, txn_date);
CREATE INDEX cost_txn_estate_idx  ON cost_transaction (estate_id, txn_date);
CREATE INDEX cost_txn_employee_idx ON cost_transaction (employee_id);
CREATE INDEX cost_txn_source_idx  ON cost_transaction (source_type, source_id);

CREATE OR REPLACE FUNCTION app.tg_cost_placement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE u uuid := coalesce(NEW.charged_unit_id, NEW.org_unit_id);
BEGIN
  NEW.company_id := app.ancestor_of_type(u, 'COMPANY');
  NEW.estate_id  := app.ancestor_of_type(u, 'ESTATE');
  RETURN NEW;
END $$;
CREATE TRIGGER cost_placement BEFORE INSERT OR UPDATE OF org_unit_id, charged_unit_id ON cost_transaction
  FOR EACH ROW EXECUTE FUNCTION app.tg_cost_placement();

-- -----------------------------------------------------------------------------
-- Health intelligence alerts (early warning). Produced by the analytics job
-- (Phase 9) and by DB-side checks (stock/expiry, Phase 6).
-- -----------------------------------------------------------------------------
CREATE TABLE health_alert (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  org_unit_id   uuid NOT NULL REFERENCES org_unit(id),
  alert_type    text NOT NULL CHECK (alert_type IN ('DISEASE_SPIKE','OCCUPATIONAL_DISEASE','ACCIDENT_SPIKE','LOW_STOCK','NEAR_EXPIRY','EXPIRED','MCU_OVERDUE','REFERRAL_COST','SICK_LEAVE_SPIKE','OTHER')),
  module        text NOT NULL REFERENCES permission_module(code),   -- who may see it
  severity      text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title         text NOT NULL,
  message       text NOT NULL,
  metric        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"baseline":12,"current":17,"change_pct":41.7,"window_days":14}
  dedupe_key    text NOT NULL,                         -- prevents re-raising the same alert
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED')),
  detected_at   timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid, acknowledged_at timestamptz,
  resolved_at   timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE UNIQUE INDEX health_alert_dedupe_uq ON health_alert (tenant_id, dedupe_key) WHERE status IN ('OPEN','ACKNOWLEDGED');
CREATE INDEX health_alert_unit_idx ON health_alert (org_unit_id, status, detected_at DESC);

-- -----------------------------------------------------------------------------
-- Notification centre (per recipient)
-- -----------------------------------------------------------------------------
CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  recipient_id  uuid NOT NULL REFERENCES app_user(id),
  category      text NOT NULL CHECK (category IN ('EMERGENCY','NEW_PATIENT','REFERRAL','ACCIDENT','LOW_STOCK','MEDICINE_EXPIRY','MCU_DUE','FOLLOW_UP','APPROVAL_REQUEST','ALERT','SYSTEM')),
  severity      text NOT NULL DEFAULT 'LOW' CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  title         text NOT NULL,
  body          text,                -- never contains diagnosis text
  entity_type   text,
  entity_id     uuid,
  action_url    text,
  channels      text[] NOT NULL DEFAULT '{IN_APP}',   -- IN_APP, EMAIL, PUSH, SMS, WHATSAPP
  delivered_at  timestamptz,
  read_at       timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX notification_inbox_idx ON notification (recipient_id, read_at, created_at DESC);

-- -----------------------------------------------------------------------------
-- Gap-free, concurrency-safe document numbers per tenant/type/period:
--   ACC-PTA-2026-000123, RX-CLN01-202610-00042 ...
-- -----------------------------------------------------------------------------
CREATE TABLE document_sequence (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  doc_type   text NOT NULL,
  scope_key  text NOT NULL,      -- unit code or 'ALL'
  period     text NOT NULL,      -- YYYY or YYYYMM
  last_value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, doc_type, scope_key, period)
);

CREATE OR REPLACE FUNCTION app.next_document_no(p_doc_type text, p_scope_key text DEFAULT 'ALL',
                                                p_period_format text DEFAULT 'YYYY', p_pad int DEFAULT 6)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); v_period text := to_char(now(), p_period_format); v bigint;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no security context' USING ERRCODE = '42501'; END IF;
  INSERT INTO document_sequence AS s (tenant_id, doc_type, scope_key, period, last_value)
  VALUES (v_tenant, p_doc_type, p_scope_key, v_period, 1)
  ON CONFLICT (tenant_id, doc_type, scope_key, period) DO UPDATE SET last_value = s.last_value + 1
  RETURNING last_value INTO v;
  RETURN p_doc_type || '-' || p_scope_key || '-' || v_period || '-' || lpad(v::text, p_pad, '0');
END $$;

-- -----------------------------------------------------------------------------
-- Workflow events — human-readable timeline of every status change with notes
-- (accident, referral, transfer, MCU, prescription, queue ...).
-- -----------------------------------------------------------------------------
CREATE TABLE workflow_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  org_unit_id  uuid NOT NULL REFERENCES org_unit(id),
  module       text NOT NULL REFERENCES permission_module(code),
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  note         text,
  actor_id     uuid,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX workflow_event_entity_idx ON workflow_event (entity_type, entity_id, occurred_at);
