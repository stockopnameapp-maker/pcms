-- =============================================================================
-- 0003 IDENTITY & ACCESS MANAGEMENT
--   permission  = (module, action)            e.g. EMR:READ, PHARMACY:APPROVE
--   role        = named bundle of permissions (system roles + tenant custom roles)
--   assignment  = user × role × SCOPE (an org_unit; covers its whole subtree)
-- A user may hold several assignments, e.g. Doctor @ Clinic A and
-- Clinic Manager @ Clinic B. All checks resolve to "which org units may this
-- user perform ACTION on in MODULE" → app.unit_ids(module, action).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Signed request context (protects against GUC tampering via SQL injection:
-- a forged app.user_id without a valid HMAC is ignored → fail closed).
-- -----------------------------------------------------------------------------
CREATE TABLE app.ctx_secret (
  id     int PRIMARY KEY CHECK (id = 1),
  secret bytea NOT NULL
);
INSERT INTO app.ctx_secret VALUES (1, gen_random_bytes(32));
REVOKE ALL ON app.ctx_secret FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.ctx_valid() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  u text := current_setting('app.user_id', true);
  t text := current_setting('app.tenant_id', true);
  s text := current_setting('app.ctx_sig', true);
BEGIN
  IF coalesce(u, '') = '' OR coalesce(t, '') = '' THEN RETURN false; END IF;
  RETURN s = encode(hmac(convert_to(u || '|' || t, 'UTF8'), (SELECT secret FROM app.ctx_secret WHERE id = 1), 'sha256'), 'hex');
END $$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN app.ctx_valid() THEN current_setting('app.user_id', true)::uuid END $$;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT CASE WHEN app.ctx_valid() THEN current_setting('app.tenant_id', true)::uuid END $$;

-- -----------------------------------------------------------------------------
-- Modules & permissions (global reference data)
-- -----------------------------------------------------------------------------
CREATE TABLE permission_module (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  is_clinical boolean NOT NULL DEFAULT false,  -- contains confidential medical data
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE permission_action (
  code text PRIMARY KEY CHECK (code IN ('CREATE','READ','UPDATE','DELETE','APPROVE','EXPORT','PRINT'))
);
INSERT INTO permission_action VALUES ('CREATE'),('READ'),('UPDATE'),('DELETE'),('APPROVE'),('EXPORT'),('PRINT');

CREATE TABLE permission (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module  text NOT NULL REFERENCES permission_module(code),
  action  text NOT NULL REFERENCES permission_action(code),
  code    text GENERATED ALWAYS AS (module || ':' || action) STORED,
  UNIQUE (module, action)
);

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
CREATE TABLE role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenant(id),       -- NULL = system role shared by all tenants
  code           text NOT NULL CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  name           text NOT NULL,
  description    text,
  is_system      boolean NOT NULL DEFAULT false,
  typical_scope  text REFERENCES org_unit_type(code), -- guidance for admins (e.g. CLINIC)
  is_clinical    boolean NOT NULL DEFAULT false,      -- holder is a licensed clinician
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (is_system = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX role_code_uq ON role (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

CREATE TABLE role_permission (
  role_id       uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permission(id),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX role_permission_perm_idx ON role_permission (permission_id);

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  home_unit_id       uuid NOT NULL REFERENCES org_unit(id),  -- for user administration scope
  username           citext NOT NULL CHECK (username ~ '^[a-zA-Z0-9._-]{3,50}$'),
  email              citext CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name          text NOT NULL CHECK (length(trim(full_name)) >= 2),
  phone              text,
  password_hash      text NOT NULL,              -- argon2id, produced by the API
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT true,
  mfa_enabled        boolean NOT NULL DEFAULT false,
  mfa_secret         text,                       -- encrypted by API (envelope key)
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_attempts    int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  last_login_ip      inet,
  employee_id        uuid,                       -- FK added in 0004
  locale             text NOT NULL DEFAULT 'id' CHECK (locale IN ('id','en')),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
-- usernames are globally unique so login needs no tenant selector
CREATE UNIQUE INDEX app_user_username_uq ON app_user (username);
CREATE UNIQUE INDEX app_user_email_uq ON app_user (email) WHERE email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE user_role_assignment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid NOT NULL REFERENCES app_user(id),
  role_id       uuid NOT NULL REFERENCES role(id),
  scope_unit_id uuid NOT NULL REFERENCES org_unit(id),
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid,
  reason        text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX ura_user_idx ON user_role_assignment (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX ura_active_uq ON user_role_assignment (user_id, role_id, scope_unit_id)
  WHERE revoked_at IS NULL AND deleted_at IS NULL;

-- Refresh-token sessions. Accessed only through SECURITY DEFINER auth functions.
CREATE TABLE user_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  user_id            uuid NOT NULL REFERENCES app_user(id),
  refresh_token_hash text NOT NULL UNIQUE,      -- sha256 of the opaque refresh token
  family_id          uuid NOT NULL,             -- rotation family (reuse detection)
  ip_address         inet,
  user_agent         text,
  device_label       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text
);
CREATE INDEX user_session_user_idx ON user_session (user_id) WHERE revoked_at IS NULL;

-- =============================================================================
-- AUTHORISATION FUNCTIONS
-- =============================================================================

-- All org units (scope subtrees) where the current user holds MODULE:ACTION.
-- Used in RLS as   col = ANY ((SELECT app.unit_ids('EMR','READ'))::uuid[])
-- The scalar sub-select makes PostgreSQL evaluate it ONCE per statement (InitPlan).
CREATE OR REPLACE FUNCTION app.unit_ids(p_module text, p_action text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT ou.id), '{}'::uuid[])
    FROM user_role_assignment a
    JOIN app_user        usr ON usr.id = a.user_id AND usr.status = 'ACTIVE' AND usr.deleted_at IS NULL
    JOIN role_permission rp  ON rp.role_id = a.role_id
    JOIN permission      p   ON p.id = rp.permission_id AND p.module = p_module AND p.action = p_action
    JOIN role            r   ON r.id = a.role_id AND r.deleted_at IS NULL
    JOIN org_unit        s   ON s.id = a.scope_unit_id
    JOIN org_unit        ou  ON ou.tenant_id = s.tenant_id AND ou.path <@ s.path
   WHERE a.user_id   = app.current_user_id()
     AND a.tenant_id = app.current_tenant_id()
     AND a.revoked_at IS NULL AND a.deleted_at IS NULL
     AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
$$;

-- Holds MODULE:ACTION anywhere (any scope).
CREATE OR REPLACE FUNCTION app.has_perm(p_module text, p_action text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT cardinality(app.unit_ids(p_module, p_action)) > 0 $$;

-- Holds MODULE:ACTION at the tenant root (Group-wide). Used for tenant master data.
CREATE OR REPLACE FUNCTION app.has_root_perm(p_module text, p_action text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_unit g
     WHERE g.tenant_id = app.current_tenant_id() AND g.unit_type = 'GROUP'
       AND g.id = ANY (app.unit_ids(p_module, p_action)))
$$;

-- Holds MODULE:ACTION on a specific unit.
CREATE OR REPLACE FUNCTION app.can(p_module text, p_action text, p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT p_unit = ANY (app.unit_ids(p_module, p_action)) $$;

-- Permission summary for the logged-in user (drives menus in the frontend;
-- the frontend never decides access by itself).
CREATE OR REPLACE FUNCTION app.my_permissions()
RETURNS TABLE (module text, action text, scope_unit_id uuid, scope_unit_type text, scope_unit_name text, role_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.module, p.action, s.id, s.unit_type, s.name, r.code
    FROM user_role_assignment a
    JOIN role r ON r.id = a.role_id
    JOIN role_permission rp ON rp.role_id = r.id
    JOIN permission p ON p.id = rp.permission_id
    JOIN org_unit s ON s.id = a.scope_unit_id
   WHERE a.user_id = app.current_user_id() AND a.tenant_id = app.current_tenant_id()
     AND a.revoked_at IS NULL AND a.deleted_at IS NULL
     AND a.valid_from <= now() AND (a.valid_to IS NULL OR a.valid_to > now())
$$;

-- -----------------------------------------------------------------------------
-- Establish the per-transaction security context. The API calls this as the
-- first statement of every request transaction after validating the JWT:
--   BEGIN; SELECT app.set_context($userId, $ip, $ua, $requestId); ...; COMMIT;
-- The tenant is derived from the user record — clients can never choose it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.set_context(p_user_id uuid, p_client_ip text DEFAULT NULL,
                                           p_user_agent text DEFAULT NULL, p_request_id text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_tenant uuid; v_sig text;
BEGIN
  SELECT u.tenant_id INTO v_tenant
    FROM app_user u JOIN tenant t ON t.id = u.tenant_id
   WHERE u.id = p_user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
     AND (u.locked_until IS NULL OR u.locked_until < now())
     AND t.status = 'ACTIVE';
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'user is not active or does not exist' USING ERRCODE = '28000';
  END IF;
  v_sig := encode(hmac(convert_to(p_user_id::text || '|' || v_tenant::text, 'UTF8'),
                       (SELECT secret FROM app.ctx_secret WHERE id = 1), 'sha256'), 'hex');
  PERFORM set_config('app.user_id',    p_user_id::text, true);
  PERFORM set_config('app.tenant_id',  v_tenant::text,  true);
  PERFORM set_config('app.ctx_sig',    v_sig,           true);
  PERFORM set_config('app.client_ip',  coalesce(p_client_ip, ''),  true);
  PERFORM set_config('app.user_agent', left(coalesce(p_user_agent, ''), 400), true);
  PERFORM set_config('app.request_id', coalesce(p_request_id, ''), true);
  RETURN v_tenant;
END $$;

CREATE OR REPLACE FUNCTION app.clear_context() RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('app.user_id', '', true), set_config('app.tenant_id', '', true),
         set_config('app.ctx_sig', '', true);
$$;

-- -----------------------------------------------------------------------------
-- Authentication support (used by the Phase 2 auth service before a context
-- exists). Exposes only what login needs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.auth_lookup(p_login text)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, status text,
               locked_until timestamptz, mfa_enabled boolean, must_change_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.status, u.locked_until, u.mfa_enabled, u.must_change_password
    FROM app_user u JOIN tenant t ON t.id = u.tenant_id AND t.status = 'ACTIVE'
   WHERE (u.username = p_login::citext OR u.email = p_login::citext) AND u.deleted_at IS NULL
   LIMIT 1
$$;

-- Records a login attempt; locks the account for 15 min after 5 consecutive failures.
CREATE OR REPLACE FUNCTION app.auth_record_attempt(p_user_id uuid, p_success boolean,
                                                   p_ip text DEFAULT NULL, p_user_agent text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_tenant uuid;
BEGIN
  PERFORM set_config('app.skip_audit', 'on', true);   -- counters are noise; the event below is logged
  IF p_success THEN
    UPDATE app_user SET failed_attempts = 0, locked_until = NULL, last_login_at = now(),
                        last_login_ip = nullif(p_ip, '')::inet
     WHERE id = p_user_id RETURNING tenant_id INTO v_tenant;
  ELSE
    UPDATE app_user SET failed_attempts = failed_attempts + 1,
                        locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' END
     WHERE id = p_user_id RETURNING tenant_id INTO v_tenant;
  END IF;
  PERFORM set_config('app.skip_audit', 'off', true);
  INSERT INTO audit.audit_log (tenant_id, user_id, ip_address, user_agent, table_name, record_id, action)
  VALUES (v_tenant, p_user_id, nullif(p_ip, '')::inet, p_user_agent, 'app_user', p_user_id,
          CASE WHEN p_success THEN 'LOGIN' ELSE 'LOGIN_FAILED' END);
END $$;

-- Privilege-escalation guard: you can only grant a role whose every permission
-- you yourself hold at (or above) the target scope.
CREATE OR REPLACE FUNCTION app.tg_ura_no_escalation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE missing text;
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NEW; END IF;   -- owner/migrations
  IF NEW.user_id = app.current_user_id() THEN
    RAISE EXCEPTION 'users cannot change their own role assignments' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE id = NEW.user_id AND tenant_id = NEW.tenant_id)
     OR NOT EXISTS (SELECT 1 FROM org_unit WHERE id = NEW.scope_unit_id AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'user and scope must belong to the same tenant' USING ERRCODE = '42501';
  END IF;
  -- Holders of USER_ADMIN:APPROVE at the target scope are the delegated access
  -- administrators: they may assign any role there (e.g. a PT Admin onboarding
  -- a Doctor) without holding clinical permissions themselves. Every grant is audited.
  IF NEW.scope_unit_id = ANY (app.unit_ids('USER_ADMIN', 'APPROVE')) THEN
    RETURN NEW;
  END IF;
  SELECT string_agg(p.code, ', ') INTO missing
    FROM role_permission rp JOIN permission p ON p.id = rp.permission_id
   WHERE rp.role_id = NEW.role_id
     AND NOT (NEW.scope_unit_id = ANY (app.unit_ids(p.module, p.action)));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'cannot grant permissions you do not hold at this scope: %', missing USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ura_no_escalation BEFORE INSERT OR UPDATE OF role_id, scope_unit_id, user_id
  ON user_role_assignment FOR EACH ROW EXECUTE FUNCTION app.tg_ura_no_escalation();

-- =============================================================================
-- POLICY GENERATORS — keep RLS uniform across ~70 tables.
-- =============================================================================

-- Standard triggers + RLS switched on for a business table.
CREATE OR REPLACE FUNCTION app.setup_table(p_table text, p_module text, p_no_hard_delete boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- leading underscore: triggers fire in name order, so standard columns
  -- (tenant_id, created_by, ...) are filled before any table-specific trigger runs
  EXECUTE format('CREATE TRIGGER _std_columns BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.tg_std_columns()', p_table);
  EXECUTE format('CREATE TRIGGER _audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit.tg_audit(%L)', p_table, p_module);
  IF p_no_hard_delete THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.tg_prevent_hard_delete()',
                   p_table || '_no_delete', p_table);
  END IF;
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO pcms_app', p_table);
END $$;

-- Rows owned by an org unit column (clinic_id, org_unit_id, ...).
-- p_read_tenant_wide: non-sensitive reference rows (clinic list, staff names)
-- that every tenant user may read, while writes stay scoped.
CREATE OR REPLACE FUNCTION app.policy_scoped(p_table text, p_module text, p_col text,
                                             p_read_tenant_wide boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text := 'tenant_id = (SELECT app.current_tenant_id())';
BEGIN
  IF p_read_tenant_wide THEN
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'sel', p_table, t);
  ELSE
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s AND %I = ANY ((SELECT app.unit_ids(%L,''READ''))::uuid[]))',
                   'sel', p_table, t, p_col, p_module);
  END IF;
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s AND %I = ANY ((SELECT app.unit_ids(%L,''CREATE''))::uuid[]))',
                 'ins', p_table, t, p_col, p_module);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s AND %I = ANY ((SELECT app.unit_ids(%L,''UPDATE''))::uuid[]))'
                 ' WITH CHECK (%s AND %I = ANY ((SELECT app.unit_ids(%L,''UPDATE''))::uuid[]))',
                 'upd', p_table, t, p_col, p_module, t, p_col, p_module);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s AND %I = ANY ((SELECT app.unit_ids(%L,''DELETE''))::uuid[]))',
                 'del', p_table, t, p_col, p_module);
  -- soft delete (setting deleted_at) requires DELETE permission too
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OF deleted_at ON %I FOR EACH ROW EXECUTE FUNCTION app.tg_soft_delete_perm(%L, %L)',
                 p_table || '_soft_delete', p_table, p_module, p_col);
END $$;

-- Child rows (vital_sign → encounter, prescription_item → prescription, ...).
-- READ follows the parent's own RLS (so any visibility rule on the parent —
-- e.g. care relationship — carries over). WRITES need MODULE:ACTION on the
-- parent's org unit.
CREATE OR REPLACE FUNCTION app.policy_child(p_table text, p_module text, p_fk text,
                                            p_parent text, p_parent_unit_col text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t text := 'tenant_id = (SELECT app.current_tenant_id())';
  w text := format('EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I AND p.%I = ANY ((SELECT app.unit_ids(%L,',
                   p_parent, p_table, p_fk, p_parent_unit_col, p_module);
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s AND EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
                 'sel', p_table, t, p_parent, p_table, p_fk);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s AND %s''CREATE''))::uuid[])))', 'ins', p_table, t, w);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s AND %s''UPDATE''))::uuid[]))) WITH CHECK (%s AND %s''UPDATE''))::uuid[])))',
                 'upd', p_table, t, w, t, w);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s AND %s''DELETE''))::uuid[])))', 'del', p_table, t, w);
END $$;

-- Tenant-wide master data (medicine catalogue, hospitals, lab tests, ...):
-- readable by every authenticated user of the tenant, writable only with the
-- permission at Group (root) scope.
CREATE OR REPLACE FUNCTION app.policy_master(p_table text, p_module text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE t text := 'tenant_id = (SELECT app.current_tenant_id())';
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (%s)', 'sel', p_table, t);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (%s AND (SELECT app.has_root_perm(%L,''CREATE'')))', 'ins', p_table, t, p_module);
  EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (%s AND (SELECT app.has_root_perm(%L,''UPDATE''))) WITH CHECK (%s)', 'upd', p_table, t, p_module, t);
  EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (%s AND (SELECT app.has_root_perm(%L,''DELETE'')))', 'del', p_table, t, p_module);
END $$;

CREATE OR REPLACE FUNCTION app.tg_soft_delete_perm() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_unit uuid;
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NEW; END IF;           -- owner/maintenance
  IF (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL) THEN
    v_unit := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
    IF NOT app.can(TG_ARGV[0], 'DELETE', v_unit) THEN
      RAISE EXCEPTION 'permission %:DELETE required to delete/restore % records', TG_ARGV[0], TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
