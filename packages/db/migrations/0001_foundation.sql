-- =============================================================================
-- 0001 FOUNDATION
-- Schemas, request context, standard-column triggers, audit trail, soft delete.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS app;     -- security & helper functions
CREATE SCHEMA IF NOT EXISTS audit;   -- append-only audit trail

GRANT USAGE ON SCHEMA public, app TO pcms_app;
-- audit schema: app role may only read through RLS; writes happen via triggers.
GRANT USAGE ON SCHEMA audit TO pcms_app;

-- -----------------------------------------------------------------------------
-- Request context. The API sets these per transaction with app.set_context()
-- (defined in 0003 once app_user exists). Everything is fail-closed: when no
-- context is set, current_user_id()/current_tenant_id() return NULL and every
-- RLS policy evaluates to false.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.ctx(p_key text) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT nullif(current_setting('app.' || p_key, true), '') $$;

-- -----------------------------------------------------------------------------
-- Standard columns trigger. Every business table carries:
--   id, tenant_id, created_at, created_by, updated_at, updated_by,
--   version (optimistic locking), deleted_at, deleted_by (soft delete)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_std_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.tenant_id  := coalesce(NEW.tenant_id, app.current_tenant_id());
    IF NEW.tenant_id IS NULL THEN
      RAISE EXCEPTION 'tenant_id is required on %', TG_TABLE_NAME USING ERRCODE = '23502';
    END IF;
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.created_by := coalesce(NEW.created_by, app.current_user_id());
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.version    := 1;
  ELSE
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'tenant_id is immutable (%)', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := coalesce(app.current_user_id(), NEW.updated_by);
    NEW.version    := OLD.version + 1;
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
      NEW.deleted_by := coalesce(NEW.deleted_by, app.current_user_id());
    ELSIF NEW.deleted_at IS NULL THEN
      NEW.deleted_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Medical & legal records must never be physically deleted.
CREATE OR REPLACE FUNCTION app.tg_prevent_hard_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hard delete is not allowed on %. Use soft delete (deleted_at).', TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;

-- -----------------------------------------------------------------------------
-- AUDIT TRAIL — partitioned by month, append-only.
-- -----------------------------------------------------------------------------
CREATE TABLE audit.audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  tenant_id      uuid,
  user_id        uuid,
  ip_address     inet,
  user_agent     text,
  request_id     text,
  module         text,
  table_name     text NOT NULL,
  record_id      uuid,
  action         text NOT NULL CHECK (action IN
                   ('INSERT','UPDATE','DELETE','SOFT_DELETE','RESTORE','VIEW','EXPORT','PRINT',
                    'LOGIN','LOGIN_FAILED','LOGOUT','BREAK_GLASS','APPROVE','STATUS_CHANGE')),
  changed_fields text[],
  old_values     jsonb,
  new_values     jsonb,
  note           text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;

-- Create monthly partitions (called by migration + a monthly scheduled job).
CREATE OR REPLACE FUNCTION audit.ensure_partitions(p_from date, p_months int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE d date; nm text;
BEGIN
  FOR i IN 0..p_months-1 LOOP
    d  := date_trunc('month', p_from)::date + make_interval(months => i);
    nm := 'audit_log_' || to_char(d, 'YYYYMM');
    IF to_regclass('audit.' || nm) IS NULL THEN
      EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.audit_log FOR VALUES FROM (%L) TO (%L)',
                     nm, d, (d + interval '1 month')::date);
    END IF;
  END LOOP;
END $$;
SELECT audit.ensure_partitions((current_date - interval '12 months')::date, 15);

CREATE INDEX audit_log_record_idx ON audit.audit_log (table_name, record_id, occurred_at DESC);
CREATE INDEX audit_log_user_idx   ON audit.audit_log (user_id, occurred_at DESC);
CREATE INDEX audit_log_tenant_idx ON audit.audit_log (tenant_id, occurred_at DESC);

-- Columns that must never be written to the audit log in clear text.
CREATE OR REPLACE FUNCTION audit.mask(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j IS NULL THEN NULL ELSE
    j - ARRAY['password_hash','refresh_token_hash','mfa_secret']
      || CASE WHEN j ? 'password_hash' THEN '{"password_hash":"***"}'::jsonb ELSE '{}'::jsonb END
  END
$$;

CREATE OR REPLACE FUNCTION audit.tg_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  o jsonb; n jsonb; changed text[]; act text; rec uuid; ten uuid;
  ignore text[] := ARRAY['updated_at','updated_by','version'];
BEGIN
  -- Bulk seeding by the owner may switch auditing off. The API role cannot.
  IF current_setting('app.skip_audit', true) = 'on' AND session_user <> 'pcms_app' THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('UPDATE','DELETE') THEN o := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN n := to_jsonb(NEW); END IF;

  rec := coalesce(n->>'id', o->>'id')::uuid;
  ten := coalesce(n->>'tenant_id', o->>'tenant_id')::uuid;

  act := TG_OP;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(k ORDER BY k) INTO changed
      FROM jsonb_object_keys(n) k
     WHERE (o -> k) IS DISTINCT FROM (n -> k) AND k <> ALL (ignore);
    IF changed IS NULL THEN RETURN NULL; END IF;          -- no real change
    IF (o->>'deleted_at') IS NULL AND (n->>'deleted_at') IS NOT NULL THEN act := 'SOFT_DELETE';
    ELSIF (o->>'deleted_at') IS NOT NULL AND (n->>'deleted_at') IS NULL THEN act := 'RESTORE';
    END IF;
    -- keep only changed columns to keep the log compact and readable
    SELECT jsonb_object_agg(k, o->k), jsonb_object_agg(k, n->k) INTO o, n
      FROM unnest(changed) k;
  END IF;

  ten := coalesce(ten, app.current_tenant_id());

  INSERT INTO audit.audit_log (tenant_id, user_id, ip_address, user_agent, request_id, module,
                               table_name, record_id, action, changed_fields, old_values, new_values)
  VALUES (ten, app.current_user_id(), app.ctx('client_ip')::inet, app.ctx('user_agent'),
          app.ctx('request_id'), TG_ARGV[0], TG_TABLE_NAME, rec, act, changed,
          audit.mask(o), audit.mask(n));
  RETURN NULL;
END $$;

-- Audit log is immutable for everyone except superusers doing partition maintenance.
CREATE OR REPLACE FUNCTION audit.tg_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.tg_immutable();

-- Explicit access logging for reads of confidential data (EMR open, export, print,
-- break-glass). Called by the API; cannot be forged for another user because
-- user_id is taken from the transaction context.
CREATE OR REPLACE FUNCTION app.log_access(p_action text, p_table text, p_record uuid,
                                          p_module text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN
    RAISE EXCEPTION 'no security context' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('VIEW','EXPORT','PRINT','BREAK_GLASS','LOGIN','LOGIN_FAILED','LOGOUT','APPROVE','STATUS_CHANGE') THEN
    RAISE EXCEPTION 'invalid access action %', p_action;
  END IF;
  INSERT INTO audit.audit_log (tenant_id, user_id, ip_address, user_agent, request_id, module,
                               table_name, record_id, action, note)
  VALUES (app.current_tenant_id(), app.current_user_id(), app.ctx('client_ip')::inet,
          app.ctx('user_agent'), app.ctx('request_id'), p_module, p_table, p_record, p_action, p_note);
END $$;
