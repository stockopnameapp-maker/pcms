-- =============================================================================
-- 0011 APPLICATION SERVICES (Phases 2–8, 11)
--   * credential & session management (refresh-token rotation with reuse detection)
--   * self-update guard on app_user
--   * workflow engine: allowed transitions, approval permissions, automatic
--     workflow_event timeline, status stamps
--   * encounter signing rules
--   * break-glass emergency access
--   * patient lookup & registration across clinics (minimal identity only)
--   * finance capture: cost rows generated from clinical/operational events
--   * scoped notifications for events
--   * employee self-service portal
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. CREDENTIALS & USER SELF-UPDATE GUARD
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_app_user_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE is_admin boolean;
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NEW; END IF;          -- owner / jobs
  IF (NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.mfa_secret IS DISTINCT FROM OLD.mfa_secret
      OR NEW.mfa_enabled IS DISTINCT FROM OLD.mfa_enabled)
     AND coalesce(current_setting('app.allow_credential_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'credentials can only be changed through the credential functions' USING ERRCODE = '42501';
  END IF;
  is_admin := app.can('USER_ADMIN', 'UPDATE', OLD.home_unit_id) AND OLD.id <> app.current_user_id();
  IF NOT is_admin AND coalesce(current_setting('app.allow_credential_change', true), '') <> 'on' THEN
    -- self-service: profile fields only
    IF NEW.username IS DISTINCT FROM OLD.username OR NEW.home_unit_id IS DISTINCT FROM OLD.home_unit_id
       OR NEW.status IS DISTINCT FROM OLD.status OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.failed_attempts IS DISTINCT FROM OLD.failed_attempts OR NEW.locked_until IS DISTINCT FROM OLD.locked_until
       OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'you may only change your own name, phone, email and language' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF NEW.home_unit_id IS DISTINCT FROM OLD.home_unit_id AND NOT app.can('USER_ADMIN', 'UPDATE', NEW.home_unit_id) THEN
    RAISE EXCEPTION 'target unit is outside your administration scope' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_user_guard BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION app.tg_app_user_guard();

-- password policy is enforced in the API (hashing happens there); the DB stores argon2id hashes only
CREATE OR REPLACE FUNCTION app.change_own_password(p_new_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'no security context' USING ERRCODE = '42501'; END IF;
  IF p_new_hash !~ '^\$argon2id\$' THEN RAISE EXCEPTION 'invalid password hash format' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('app.allow_credential_change', 'on', true);
  UPDATE app_user SET password_hash = p_new_hash, password_changed_at = now(), must_change_password = false
   WHERE id = app.current_user_id();
  PERFORM set_config('app.allow_credential_change', 'off', true);
  -- revoke every other session of this user
  UPDATE user_session SET revoked_at = now(), revoke_reason = 'PASSWORD_CHANGED'
   WHERE user_id = app.current_user_id() AND revoked_at IS NULL
     AND id::text <> coalesce(current_setting('app.session_id', true), '');
END $$;

CREATE OR REPLACE FUNCTION app.admin_reset_password(p_user uuid, p_new_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_unit uuid;
BEGIN
  SELECT home_unit_id INTO v_unit FROM app_user WHERE id = p_user AND tenant_id = app.current_tenant_id();
  IF v_unit IS NULL OR NOT app.can('USER_ADMIN', 'UPDATE', v_unit) OR p_user = app.current_user_id() THEN
    RAISE EXCEPTION 'not allowed to reset this password' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.allow_credential_change', 'on', true);
  UPDATE app_user SET password_hash = p_new_hash, password_changed_at = now(), must_change_password = true,
                      failed_attempts = 0, locked_until = NULL, mfa_enabled = false, mfa_secret = NULL
   WHERE id = p_user;
  PERFORM set_config('app.allow_credential_change', 'off', true);
  UPDATE user_session SET revoked_at = now(), revoke_reason = 'ADMIN_RESET' WHERE user_id = p_user AND revoked_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION app.set_own_mfa(p_secret_enc text, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'no security context' USING ERRCODE = '42501'; END IF;
  PERFORM set_config('app.allow_credential_change', 'on', true);
  UPDATE app_user SET mfa_secret = p_secret_enc, mfa_enabled = p_enabled WHERE id = app.current_user_id();
  PERFORM set_config('app.allow_credential_change', 'off', true);
END $$;

-- read during login only (before any context exists)
CREATE OR REPLACE FUNCTION app.auth_mfa_secret(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT mfa_secret FROM app_user WHERE id = p_user AND deleted_at IS NULL $$;

-- own MFA secret (enrolment confirmation)
CREATE OR REPLACE FUNCTION app.own_mfa_secret() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT mfa_secret FROM app_user WHERE id = app.current_user_id() $$;

-- ---------------------------------------------------------------------------
-- 2. SESSIONS — opaque refresh tokens (sha256 stored), rotation, reuse detection
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.session_create(p_user uuid, p_token_hash text, p_ip text, p_user_agent text, p_ttl interval)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM app_user WHERE id = p_user AND status = 'ACTIVE' AND deleted_at IS NULL;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'user not active' USING ERRCODE = '28000'; END IF;
  INSERT INTO user_session (tenant_id, user_id, refresh_token_hash, family_id, ip_address, user_agent, expires_at)
  VALUES (v_tenant, p_user, p_token_hash, gen_random_uuid(), nullif(p_ip, '')::inet, left(p_user_agent, 400), now() + p_ttl)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.session_rotate(p_old_hash text, p_new_hash text, p_ttl interval, p_idle interval)
RETURNS TABLE (session_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s user_session%ROWTYPE; v_new uuid;
BEGIN
  SELECT * INTO s FROM user_session WHERE refresh_token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid refresh token' USING ERRCODE = '28000'; END IF;
  IF s.revoked_at IS NOT NULL THEN
    -- a rotated token was presented again → token theft: kill the whole family
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'REUSE_DETECTED'
     WHERE family_id = s.family_id AND revoked_at IS NULL;
    INSERT INTO audit.audit_log (tenant_id, user_id, table_name, record_id, action, note)
    VALUES (s.tenant_id, s.user_id, 'user_session', s.id, 'LOGIN_FAILED', 'refresh token reuse detected; session family revoked');
    RAISE EXCEPTION 'refresh token reuse detected' USING ERRCODE = '28000';
  END IF;
  IF s.expires_at < now() OR s.last_used_at < now() - p_idle THEN
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'EXPIRED' WHERE id = s.id;
    RAISE EXCEPTION 'session expired' USING ERRCODE = '28000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = s.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
                   AND (u.locked_until IS NULL OR u.locked_until < now())) THEN
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'USER_INACTIVE' WHERE id = s.id;
    RAISE EXCEPTION 'user not active' USING ERRCODE = '28000';
  END IF;
  UPDATE user_session SET revoked_at = now(), revoke_reason = 'ROTATED' WHERE id = s.id;
  INSERT INTO user_session (tenant_id, user_id, refresh_token_hash, family_id, ip_address, user_agent, device_label, expires_at)
  VALUES (s.tenant_id, s.user_id, p_new_hash, s.family_id, s.ip_address, s.user_agent, s.device_label, now() + p_ttl)
  RETURNING id INTO v_new;
  RETURN QUERY SELECT v_new, s.user_id;
END $$;

-- Called on every API request (inside the request transaction, after set_context).
CREATE OR REPLACE FUNCTION app.session_check(p_session uuid, p_idle interval) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s user_session%ROWTYPE;
BEGIN
  SELECT * INTO s FROM user_session WHERE id = p_session;
  IF NOT FOUND OR s.user_id IS DISTINCT FROM app.current_user_id() THEN RETURN false; END IF;
  IF s.revoked_at IS NOT NULL OR s.expires_at < now() THEN RETURN false; END IF;
  IF s.last_used_at < now() - p_idle THEN
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'IDLE_TIMEOUT' WHERE id = s.id;
    RETURN false;
  END IF;
  IF s.last_used_at < now() - interval '60 seconds' THEN
    UPDATE user_session SET last_used_at = now() WHERE id = s.id;
  END IF;
  PERFORM set_config('app.session_id', p_session::text, true);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app.session_revoke(p_session uuid, p_reason text DEFAULT 'LOGOUT') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE user_session SET revoked_at = now(), revoke_reason = p_reason
   WHERE id = p_session AND revoked_at IS NULL
     AND (user_id = app.current_user_id()
          OR EXISTS (SELECT 1 FROM app_user u WHERE u.id = user_session.user_id AND app.can('USER_ADMIN', 'UPDATE', u.home_unit_id)));
END $$;

CREATE OR REPLACE FUNCTION app.session_revoke_by_token(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  UPDATE user_session SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE refresh_token_hash = p_token_hash AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION app.my_sessions()
RETURNS TABLE (id uuid, ip_address inet, user_agent text, created_at timestamptz, last_used_at timestamptz, expires_at timestamptz, is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.id, s.ip_address, s.user_agent, s.created_at, s.last_used_at, s.expires_at,
         s.id::text = coalesce(current_setting('app.session_id', true), '')
    FROM user_session s
   WHERE s.user_id = app.current_user_id() AND s.revoked_at IS NULL AND s.expires_at > now()
   ORDER BY s.last_used_at DESC
$$;

-- ---------------------------------------------------------------------------
-- 3. SCOPED NOTIFICATIONS
-- Deliver to every user that holds one of p_roles with a scope that covers the
-- unit (scope is an ancestor of / equal to the unit, or the unit is above the scope).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.notify_scope(p_tenant uuid, p_unit uuid, p_roles text[], p_category text, p_severity text,
                                            p_title text, p_body text, p_entity_type text, p_entity_id uuid, p_url text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE n int;
BEGIN
  INSERT INTO notification (tenant_id, recipient_id, category, severity, title, body, entity_type, entity_id, action_url)
  SELECT DISTINCT p_tenant, a.user_id, p_category, p_severity, p_title, p_body, p_entity_type, p_entity_id, p_url
    FROM user_role_assignment a
    JOIN role r ON r.id = a.role_id AND r.code = ANY (p_roles)
    JOIN org_unit s ON s.id = a.scope_unit_id
    JOIN org_unit u ON u.id = p_unit
    JOIN app_user usr ON usr.id = a.user_id AND usr.status = 'ACTIVE'
   WHERE a.tenant_id = p_tenant AND a.revoked_at IS NULL AND a.deleted_at IS NULL
     AND u.path <@ s.path
     AND a.user_id IS DISTINCT FROM app.current_user_id();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------------
-- 4. WORKFLOW ENGINE
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_transition (
  entity          text NOT NULL,
  from_status     text NOT NULL,
  to_status       text NOT NULL,
  required_action text NOT NULL DEFAULT 'UPDATE' REFERENCES permission_action(code),
  unit_column     text,              -- column holding the org unit the permission is checked on (default: trigger arg)
  label           text,              -- button label for the UI
  four_eyes       boolean NOT NULL DEFAULT false,   -- approver must differ from the record's creator
  PRIMARY KEY (entity, from_status, to_status)
);
GRANT SELECT ON workflow_transition TO pcms_app;

INSERT INTO workflow_transition (entity, from_status, to_status, required_action, unit_column, label) VALUES
 -- queue: REGISTRATION → QUEUE → TRIAGE → DOCTOR → PHARMACY → COMPLETE
 ('queue_ticket','WAITING','TRIAGE','UPDATE',NULL,'Panggil triase'),
 ('queue_ticket','WAITING','WAITING_DOCTOR','UPDATE',NULL,'Langsung ke dokter'),
 ('queue_ticket','WAITING','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('queue_ticket','TRIAGE','WAITING_DOCTOR','UPDATE',NULL,'Selesai triase'),
 ('queue_ticket','TRIAGE','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('queue_ticket','WAITING_DOCTOR','IN_CONSULTATION','UPDATE',NULL,'Mulai konsultasi'),
 ('queue_ticket','WAITING_DOCTOR','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('queue_ticket','IN_CONSULTATION','PHARMACY','UPDATE',NULL,'Kirim ke farmasi'),
 ('queue_ticket','IN_CONSULTATION','COMPLETED','UPDATE',NULL,'Selesai (tanpa obat)'),
 ('queue_ticket','IN_CONSULTATION','WAITING_DOCTOR','UPDATE',NULL,'Kembalikan ke antrian'),
 ('queue_ticket','PHARMACY','COMPLETED','UPDATE',NULL,'Selesai'),
 -- encounter
 ('encounter','OPEN','SIGNED','UPDATE',NULL,'Tanda tangani'),
 ('encounter','OPEN','CANCELLED','UPDATE',NULL,'Batalkan'),
 -- prescription
 ('prescription','DRAFT','SUBMITTED','UPDATE',NULL,'Kirim'),
 ('prescription','DRAFT','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('prescription','SUBMITTED','IN_PREPARATION','UPDATE',NULL,'Siapkan'),
 ('prescription','SUBMITTED','DISPENSED','UPDATE',NULL,'Serahkan'),
 ('prescription','SUBMITTED','PARTIALLY_DISPENSED','UPDATE',NULL,'Serahkan sebagian'),
 ('prescription','SUBMITTED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('prescription','IN_PREPARATION','DISPENSED','UPDATE',NULL,'Serahkan'),
 ('prescription','IN_PREPARATION','PARTIALLY_DISPENSED','UPDATE',NULL,'Serahkan sebagian'),
 ('prescription','PARTIALLY_DISPENSED','DISPENSED','UPDATE',NULL,'Lengkapi'),
 -- laboratory
 ('lab_order','ORDERED','COLLECTED','UPDATE',NULL,'Sampel diambil'),
 ('lab_order','ORDERED','RESULTED','UPDATE',NULL,'Hasil masuk'),
 ('lab_order','COLLECTED','IN_PROGRESS','UPDATE',NULL,'Proses'),
 ('lab_order','COLLECTED','RESULTED','UPDATE',NULL,'Hasil masuk'),
 ('lab_order','IN_PROGRESS','RESULTED','UPDATE',NULL,'Hasil masuk'),
 ('lab_order','RESULTED','VERIFIED','UPDATE',NULL,'Verifikasi dokter'),
 ('lab_order','ORDERED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('lab_order','COLLECTED','CANCELLED','UPDATE',NULL,'Batalkan'),
 -- accident: REPORT → FIRST AID → MEDICAL TREATMENT → INVESTIGATION → APPROVAL → FOLLOW UP → RETURN TO WORK → CLOSED
 ('accident','REPORTED','FIRST_AID','UPDATE',NULL,'P3K diberikan'),
 ('accident','REPORTED','MEDICAL_TREATMENT','UPDATE',NULL,'Penanganan medis'),
 ('accident','REPORTED','INVESTIGATION','UPDATE',NULL,'Mulai investigasi'),
 ('accident','REPORTED','CANCELLED','UPDATE',NULL,'Batalkan (laporan salah)'),
 ('accident','FIRST_AID','MEDICAL_TREATMENT','UPDATE',NULL,'Penanganan medis'),
 ('accident','FIRST_AID','INVESTIGATION','UPDATE',NULL,'Mulai investigasi'),
 ('accident','MEDICAL_TREATMENT','INVESTIGATION','UPDATE',NULL,'Mulai investigasi'),
 ('accident','INVESTIGATION','PENDING_APPROVAL','UPDATE',NULL,'Ajukan persetujuan'),
 ('accident','INVESTIGATION','FOLLOW_UP','UPDATE',NULL,'Tindak lanjut (kasus ringan)'),
 ('accident','INVESTIGATION','CLOSED','UPDATE',NULL,'Tutup (kasus ringan)'),
 ('accident','PENDING_APPROVAL','FOLLOW_UP','APPROVE',NULL,'Setujui'),
 ('accident','PENDING_APPROVAL','INVESTIGATION','APPROVE',NULL,'Kembalikan ke investigasi'),
 ('accident','FOLLOW_UP','RETURN_TO_WORK','UPDATE',NULL,'Kembali bekerja'),
 ('accident','FOLLOW_UP','CLOSED','UPDATE',NULL,'Tutup kasus'),
 ('accident','RETURN_TO_WORK','CLOSED','UPDATE',NULL,'Tutup kasus'),
 -- referral: CLINIC → REFERRAL → HOSPITAL → TREATMENT → FOLLOW-UP → RETURN TO CLINIC
 ('referral','DRAFT','ISSUED','UPDATE',NULL,'Terbitkan rujukan'),
 ('referral','DRAFT','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('referral','ISSUED','AT_HOSPITAL','UPDATE',NULL,'Tiba di RS'),
 ('referral','ISSUED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('referral','AT_HOSPITAL','IN_TREATMENT','UPDATE',NULL,'Dalam perawatan'),
 ('referral','AT_HOSPITAL','INPATIENT','UPDATE',NULL,'Rawat inap'),
 ('referral','AT_HOSPITAL','RETURNED','UPDATE',NULL,'Kembali ke klinik'),
 ('referral','IN_TREATMENT','INPATIENT','UPDATE',NULL,'Rawat inap'),
 ('referral','IN_TREATMENT','FOLLOW_UP','UPDATE',NULL,'Kontrol lanjutan'),
 ('referral','IN_TREATMENT','RETURNED','UPDATE',NULL,'Kembali ke klinik'),
 ('referral','INPATIENT','FOLLOW_UP','UPDATE',NULL,'Pulang - kontrol lanjutan'),
 ('referral','INPATIENT','RETURNED','UPDATE',NULL,'Kembali ke klinik'),
 ('referral','FOLLOW_UP','RETURNED','UPDATE',NULL,'Kembali ke klinik'),
 ('referral','RETURNED','CLOSED','UPDATE',NULL,'Tutup'),
 -- stock transfer: REQUEST → APPROVAL → TRANSFER → RECEIVING → STOCK UPDATE
 ('stock_transfer','REQUESTED','APPROVED','APPROVE','from_unit_id','Setujui'),
 ('stock_transfer','REQUESTED','REJECTED','APPROVE','from_unit_id','Tolak'),
 ('stock_transfer','REQUESTED','CANCELLED','UPDATE','to_unit_id','Batalkan permintaan'),
 ('stock_transfer','APPROVED','IN_TRANSIT','UPDATE','from_unit_id','Kirim'),
 ('stock_transfer','APPROVED','CANCELLED','UPDATE','from_unit_id','Batalkan'),
 ('stock_transfer','IN_TRANSIT','RECEIVED','UPDATE','to_unit_id','Terima barang'),
 -- purchasing
 ('purchase_order','DRAFT','SUBMITTED','UPDATE',NULL,'Ajukan'),
 ('purchase_order','DRAFT','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('purchase_order','SUBMITTED','APPROVED','APPROVE',NULL,'Setujui'),
 ('purchase_order','SUBMITTED','CANCELLED','APPROVE',NULL,'Tolak'),
 ('purchase_order','APPROVED','PARTIALLY_RECEIVED','UPDATE',NULL,'Terima sebagian'),
 ('purchase_order','APPROVED','RECEIVED','UPDATE',NULL,'Terima lengkap'),
 ('purchase_order','PARTIALLY_RECEIVED','RECEIVED','UPDATE',NULL,'Terima sisa'),
 -- stock opname
 ('stock_opname','DRAFT','COUNTING','UPDATE',NULL,'Mulai hitung'),
 ('stock_opname','DRAFT','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('stock_opname','COUNTING','SUBMITTED','UPDATE',NULL,'Ajukan'),
 ('stock_opname','COUNTING','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('stock_opname','SUBMITTED','COUNTING','APPROVE',NULL,'Hitung ulang'),
 ('stock_opname','SUBMITTED','APPROVED','APPROVE',NULL,'Setujui'),
 ('stock_opname','APPROVED','POSTED','UPDATE',NULL,'Posting selisih'),
 -- MCU
 ('mcu','PLANNED','SCHEDULED','UPDATE',NULL,'Jadwalkan'),
 ('mcu','PLANNED','IN_PROGRESS','UPDATE',NULL,'Mulai pemeriksaan'),
 ('mcu','PLANNED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('mcu','SCHEDULED','IN_PROGRESS','UPDATE',NULL,'Mulai pemeriksaan'),
 ('mcu','SCHEDULED','NO_SHOW','UPDATE',NULL,'Tidak hadir'),
 ('mcu','SCHEDULED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('mcu','NO_SHOW','SCHEDULED','UPDATE',NULL,'Jadwalkan ulang'),
 ('mcu','IN_PROGRESS','AWAITING_RESULT','UPDATE',NULL,'Menunggu hasil'),
 ('mcu','IN_PROGRESS','COMPLETED','APPROVE',NULL,'Selesai & tetapkan status fit'),
 ('mcu','AWAITING_RESULT','COMPLETED','APPROVE',NULL,'Selesai & tetapkan status fit'),
 -- appointment
 ('appointment','BOOKED','CONFIRMED','UPDATE',NULL,'Konfirmasi'),
 ('appointment','BOOKED','CHECKED_IN','UPDATE',NULL,'Check-in'),
 ('appointment','BOOKED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('appointment','BOOKED','NO_SHOW','UPDATE',NULL,'Tidak hadir'),
 ('appointment','CONFIRMED','CHECKED_IN','UPDATE',NULL,'Check-in'),
 ('appointment','CONFIRMED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('appointment','CONFIRMED','NO_SHOW','UPDATE',NULL,'Tidak hadir'),
 ('appointment','CHECKED_IN','COMPLETED','UPDATE',NULL,'Selesai'),
 -- sick leave (HR acknowledgement needs SICK_LEAVE:APPROVE on the employee's unit)
 ('sick_leave','ISSUED','ACKNOWLEDGED','APPROVE','employee_unit_id','Diketahui HR'),
 ('sick_leave','ISSUED','EXTENDED','UPDATE',NULL,'Perpanjang'),
 ('sick_leave','EXTENDED','ACKNOWLEDGED','APPROVE','employee_unit_id','Diketahui HR'),
 ('sick_leave','ISSUED','CANCELLED','UPDATE',NULL,'Batalkan'),
 -- medical certificate
 ('medical_certificate','ISSUED','REVOKED','UPDATE',NULL,'Cabut'),
 -- ambulance trip
 ('ambulance_trip','DISPATCHED','EN_ROUTE','UPDATE',NULL,'Berangkat'),
 ('ambulance_trip','DISPATCHED','TRANSPORTING','UPDATE',NULL,'Membawa pasien'),
 ('ambulance_trip','DISPATCHED','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('ambulance_trip','EN_ROUTE','ON_SCENE','UPDATE',NULL,'Tiba di lokasi'),
 ('ambulance_trip','EN_ROUTE','TRANSPORTING','UPDATE',NULL,'Membawa pasien'),
 ('ambulance_trip','EN_ROUTE','CANCELLED','UPDATE',NULL,'Batalkan'),
 ('ambulance_trip','ON_SCENE','TRANSPORTING','UPDATE',NULL,'Membawa pasien'),
 ('ambulance_trip','TRANSPORTING','ARRIVED','UPDATE',NULL,'Tiba di tujuan'),
 ('ambulance_trip','TRANSPORTING','COMPLETED','UPDATE',NULL,'Selesai'),
 ('ambulance_trip','ARRIVED','COMPLETED','UPDATE',NULL,'Selesai'),
 -- inpatient
 ('inpatient_stay','ADMITTED','DISCHARGED','UPDATE',NULL,'Pulangkan'),
 ('inpatient_stay','ADMITTED','TRANSFERRED','UPDATE',NULL,'Pindah'),
 ('inpatient_stay','ADMITTED','REFERRED','UPDATE',NULL,'Dirujuk'),
 -- health alerts
 ('health_alert','OPEN','ACKNOWLEDGED','UPDATE',NULL,'Tandai ditindaklanjuti'),
 ('health_alert','OPEN','RESOLVED','UPDATE',NULL,'Selesaikan'),
 ('health_alert','OPEN','DISMISSED','UPDATE',NULL,'Abaikan'),
 ('health_alert','ACKNOWLEDGED','RESOLVED','UPDATE',NULL,'Selesaikan'),
 ('health_alert','ACKNOWLEDGED','DISMISSED','UPDATE',NULL,'Abaikan');

-- Guard: TG_ARGV[0] = module, TG_ARGV[1] = default unit column
CREATE OR REPLACE FUNCTION app.tg_workflow_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  tr workflow_transition%ROWTYPE; v_unit uuid; j jsonb; patch jsonb := '{}'::jsonb; v_module text := TG_ARGV[0];
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR app.current_user_id() IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO tr FROM workflow_transition WHERE entity = TG_TABLE_NAME AND from_status = OLD.status AND to_status = NEW.status;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid status transition for %: % → %', TG_TABLE_NAME, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  j := to_jsonb(NEW);
  v_unit := (j ->> coalesce(tr.unit_column, TG_ARGV[1]))::uuid;
  IF NOT app.can(v_module, tr.required_action, v_unit) THEN
    RAISE EXCEPTION 'permission %:% required for "%"', v_module, tr.required_action, coalesce(tr.label, NEW.status) USING ERRCODE = '42501';
  END IF;
  IF tr.four_eyes AND (j ->> 'created_by')::uuid = app.current_user_id() THEN
    RAISE EXCEPTION 'four-eyes principle: you cannot approve a record you created' USING ERRCODE = '42501';
  END IF;
  -- generic stamps
  IF tr.required_action = 'APPROVE' AND j ? 'approved_by' AND NEW.status NOT IN ('REJECTED','CANCELLED','INVESTIGATION','COUNTING') THEN
    patch := patch || jsonb_build_object('approved_by', app.current_user_id(), 'approved_at', now());
  END IF;
  IF NEW.status = 'CLOSED' AND j ? 'closed_at' AND (j ->> 'closed_at') IS NULL THEN patch := patch || jsonb_build_object('closed_at', now()); END IF;
  IF NEW.status = 'COMPLETED' AND j ? 'completed_at' AND (j ->> 'completed_at') IS NULL THEN patch := patch || jsonb_build_object('completed_at', now()); END IF;
  IF patch <> '{}'::jsonb THEN NEW := jsonb_populate_record(NEW, patch); END IF;

  INSERT INTO workflow_event (tenant_id, org_unit_id, module, entity_type, entity_id, from_status, to_status, note, actor_id, created_by)
  VALUES (NEW.tenant_id, (to_jsonb(NEW) ->> TG_ARGV[1])::uuid, v_module, TG_TABLE_NAME, NEW.id, OLD.status, NEW.status,
          nullif(current_setting('app.workflow_note', true), ''), app.current_user_id(), app.current_user_id());
  PERFORM set_config('app.workflow_note', '', true);
  RETURN NEW;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('queue_ticket','QUEUE','clinic_id'), ('encounter','EMR','clinic_id'), ('prescription','PHARMACY','clinic_id'),
      ('lab_order','LAB','clinic_id'), ('accident','ACCIDENT','org_unit_id'), ('referral','REFERRAL','clinic_id'),
      ('stock_transfer','INVENTORY','to_unit_id'), ('purchase_order','INVENTORY','org_unit_id'), ('stock_opname','INVENTORY','org_unit_id'),
      ('mcu','OCC_HEALTH','clinic_id'), ('appointment','APPOINTMENT','clinic_id'), ('sick_leave','SICK_LEAVE','clinic_id'),
      ('medical_certificate','SICK_LEAVE','clinic_id'), ('ambulance_trip','AMBULANCE','clinic_id'), ('inpatient_stay','EMR','clinic_id'),
      ('health_alert','ALERT','org_unit_id')) v(t, m, c)
  LOOP
    EXECUTE format('CREATE TRIGGER workflow_guard BEFORE UPDATE OF status ON %I FOR EACH ROW EXECUTE FUNCTION app.tg_workflow_guard(%L, %L)', r.t, r.m, r.c);
  END LOOP;
END $$;

-- Accident: non-minor cases need approval before follow-up / closure.
CREATE OR REPLACE FUNCTION app.tg_accident_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('FOLLOW_UP','RETURN_TO_WORK','CLOSED') AND NEW.severity <> 'MINOR' AND NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'accident with severity % requires approval before %', NEW.severity, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'PENDING_APPROVAL' AND (NEW.root_cause IS NULL OR NEW.corrective_action IS NULL) THEN
    RAISE EXCEPTION 'root cause and corrective action are required before approval' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RETURN_TO_WORK' AND NEW.return_to_work_date IS NULL THEN
    NEW.return_to_work_date := current_date;
  END IF;
  RETURN NEW;
END $$;
-- "zz_" makes this run after workflow_guard, so the approval stamped by the guard is visible here.
CREATE TRIGGER zz_accident_rules BEFORE UPDATE OF status ON accident FOR EACH ROW EXECUTE FUNCTION app.tg_accident_rules();

-- Encounter signing: only a doctor, signing as themself.
CREATE OR REPLACE FUNCTION app.tg_encounter_sign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_staff uuid;
BEGIN
  IF app.current_user_id() IS NULL OR NEW.status <> 'SIGNED' OR OLD.status = 'SIGNED' THEN RETURN NEW; END IF;
  SELECT id INTO v_staff FROM medical_staff WHERE user_id = app.current_user_id() AND staff_type = 'DOCTOR' AND status = 'ACTIVE';
  IF v_staff IS NULL THEN RAISE EXCEPTION 'only a doctor can sign a medical record' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM diagnosis WHERE encounter_id = NEW.id AND diagnosis_type = 'PRIMARY' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a primary diagnosis is required before signing' USING ERRCODE = '23514';
  END IF;
  NEW.signed_by := v_staff; NEW.signed_at := now(); NEW.ended_at := coalesce(NEW.ended_at, now());
  NEW.doctor_id := coalesce(NEW.doctor_id, v_staff);
  RETURN NEW;
END $$;
CREATE TRIGGER encounter_sign BEFORE UPDATE OF status ON encounter FOR EACH ROW EXECUTE FUNCTION app.tg_encounter_sign();

-- MCU completion needs a fit status (constraint) and stamps the next due date from the risk interval.
CREATE OR REPLACE FUNCTION app.tg_mcu_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_months int;
BEGIN
  IF NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED' THEN
    SELECT mcu_interval_months INTO v_months FROM risk_category WHERE id = NEW.risk_category_id;
    NEW.exam_date := coalesce(NEW.exam_date, current_date);
    NEW.completed_at := coalesce(NEW.completed_at, now());
    NEW.next_due_date := coalesce(NEW.next_due_date, NEW.exam_date + make_interval(months => coalesce(v_months, 12)));
    NEW.valid_until := coalesce(NEW.valid_until, NEW.next_due_date);
    IF app.current_user_id() IS NOT NULL AND NEW.examiner_id IS NULL THEN
      SELECT id INTO NEW.examiner_id FROM medical_staff WHERE user_id = app.current_user_id();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mcu_complete BEFORE UPDATE OF status ON mcu FOR EACH ROW EXECUTE FUNCTION app.tg_mcu_complete();

-- ---------------------------------------------------------------------------
-- 5. BREAK-GLASS EMERGENCY ACCESS
-- ---------------------------------------------------------------------------
CREATE TABLE break_glass_grant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  reason      text NOT NULL CHECK (length(trim(reason)) >= 15),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  reviewed_by uuid, reviewed_at timestamptz, review_note text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  version int NOT NULL DEFAULT 1, deleted_at timestamptz, deleted_by uuid
);
CREATE INDEX break_glass_user_idx ON break_glass_grant (user_id, expires_at);
SELECT app.setup_table('break_glass_grant', 'AUDIT', true);
CREATE POLICY sel ON break_glass_grant FOR SELECT USING (tenant_id = (SELECT app.current_tenant_id())
  AND (user_id = (SELECT app.current_user_id()) OR (SELECT app.has_root_perm('AUDIT','READ')) OR (SELECT app.has_perm('EMR','APPROVE'))
       OR EXISTS (SELECT 1 FROM app.my_permissions() p WHERE p.role_code = 'MEDICAL_DIRECTOR')));
CREATE POLICY upd ON break_glass_grant FOR UPDATE USING (tenant_id = (SELECT app.current_tenant_id())
  AND EXISTS (SELECT 1 FROM app.my_permissions() p WHERE p.role_code IN ('MEDICAL_DIRECTOR','MEDICAL_MANAGER'))) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()));

CREATE OR REPLACE FUNCTION app.break_glass_patient_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(patient_id), '{}'::uuid[]) FROM break_glass_grant
   WHERE user_id = app.current_user_id() AND tenant_id = app.current_tenant_id()
     AND revoked_at IS NULL AND expires_at > now()
$$;

CREATE OR REPLACE FUNCTION app.break_glass(p_patient uuid, p_reason text, p_minutes int DEFAULT 60) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; v_unit uuid; v_name text; v_user text;
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'no security context' USING ERRCODE = '42501'; END IF;
  IF NOT app.has_perm('EMR', 'CREATE') THEN
    RAISE EXCEPTION 'break-glass is only available to treating clinicians' USING ERRCODE = '42501';
  END IF;
  IF length(trim(coalesce(p_reason, ''))) < 15 THEN
    RAISE EXCEPTION 'a reason of at least 15 characters is required' USING ERRCODE = '23514';
  END IF;
  SELECT primary_clinic_id, full_name INTO v_unit, v_name FROM patient WHERE id = p_patient AND tenant_id = app.current_tenant_id();
  IF v_unit IS NULL THEN RAISE EXCEPTION 'patient not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO break_glass_grant (tenant_id, user_id, patient_id, reason, expires_at, created_by)
  VALUES (app.current_tenant_id(), app.current_user_id(), p_patient, p_reason, now() + make_interval(mins => least(greatest(p_minutes, 5), 240)), app.current_user_id())
  RETURNING id INTO v_id;
  PERFORM app.log_access('BREAK_GLASS', 'patient', p_patient, 'EMR', p_reason);
  SELECT full_name INTO v_user FROM app_user WHERE id = app.current_user_id();
  PERFORM app.notify_scope(app.current_tenant_id(), v_unit, ARRAY['MEDICAL_DIRECTOR','MEDICAL_MANAGER'], 'EMERGENCY', 'HIGH',
          'Akses darurat (break-glass) rekam medis', v_user || ' membuka rekam medis pasien ' || v_name || '. Alasan: ' || p_reason,
          'break_glass_grant', v_id, '/audit/break-glass');
  RETURN v_id;
END $$;

-- Care relationship now also covers active break-glass grants.
CREATE OR REPLACE FUNCTION app.active_care_patient_ids(p_module text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(DISTINCT pid), '{}'::uuid[]) FROM (
    SELECT q.patient_id AS pid FROM queue_ticket q
     WHERE q.tenant_id = app.current_tenant_id() AND q.visit_date >= current_date - 7
       AND q.status <> 'CANCELLED' AND q.deleted_at IS NULL
       AND q.clinic_id = ANY (app.unit_ids(p_module, 'READ'))
    UNION ALL
    SELECT unnest(app.break_glass_patient_ids()) WHERE p_module IN ('EMR','LAB','PATIENT','PHARMACY')
  ) s
$$;

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
                      WHERE e.patient_id = p.id AND e.clinic_id = ANY (app.unit_ids(p_module, p_action)))
          OR (p_action = 'READ' AND p.id = ANY (app.break_glass_patient_ids()))))
$$;

-- ---------------------------------------------------------------------------
-- 6. PATIENT LOOKUP & REGISTRATION (front desk at any clinic)
-- Returns minimal identity only; every lookup is access-logged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.mask(p text, p_keep int DEFAULT 4) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p IS NULL THEN NULL ELSE repeat('•', greatest(length(p) - p_keep, 0)) || right(p, p_keep) END $$;

CREATE OR REPLACE FUNCTION app.patient_lookup(p_q text, p_limit int DEFAULT 20)
RETURNS TABLE (kind text, patient_id uuid, employee_id uuid, family_member_id uuid, mrn text, full_name text, gender char(1),
               birth_date date, patient_type text, employee_no text, nik_masked text, phone_masked text, primary_clinic text, unit_name text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
#variable_conflict use_column
DECLARE q text := trim(coalesce(p_q, '')); digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g'); t uuid := app.current_tenant_id();
BEGIN
  IF NOT (app.has_perm('QUEUE', 'CREATE') OR app.has_perm('PATIENT', 'CREATE')) THEN
    RAISE EXCEPTION 'permission QUEUE:CREATE or PATIENT:CREATE required' USING ERRCODE = '42501';
  END IF;
  IF length(q) < 3 THEN RETURN; END IF;
  RETURN QUERY
  WITH hits AS (
    SELECT 'PATIENT'::text AS kind, p.id AS patient_id, p.employee_id, p.family_member_id, p.mrn, p.full_name, p.gender, p.birth_date,
           p.patient_type, e.employee_no, app.mask(p.nik), app.mask(p.phone), c.name AS primary_clinic, eu.name AS unit_name,
           CASE WHEN p.mrn = q OR p.nik = digits OR p.qr_token = q OR e.employee_no = upper(q) THEN 0 ELSE 1 END AS rank
      FROM patient p
      JOIN org_unit c ON c.id = p.primary_clinic_id
      LEFT JOIN employee e ON e.id = p.employee_id
      LEFT JOIN org_unit eu ON eu.id = e.org_unit_id
     WHERE p.tenant_id = t AND p.deleted_at IS NULL
       AND (p.mrn = q OR p.qr_token = q OR (length(digits) >= 6 AND (p.nik = digits OR regexp_replace(coalesce(p.phone,''), '\D', '', 'g') LIKE '%' || digits || '%'))
            OR e.employee_no = upper(q) OR p.full_name ILIKE '%' || q || '%')
    UNION ALL
    -- employees / family members not yet registered as patients
    SELECT 'EMPLOYEE', NULL, e.id, NULL, NULL, e.full_name, e.gender, e.birth_date, 'EMPLOYEE', e.employee_no, app.mask(e.nik), app.mask(e.phone),
           NULL, u.name, CASE WHEN e.employee_no = upper(q) OR e.qr_token = q OR e.nik = digits THEN 0 ELSE 1 END
      FROM employee e JOIN org_unit u ON u.id = e.org_unit_id
     WHERE e.tenant_id = t AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM patient p WHERE p.employee_id = e.id AND p.deleted_at IS NULL)
       AND (e.employee_no = upper(q) OR e.qr_token = q OR (length(digits) >= 6 AND e.nik = digits) OR e.full_name ILIKE '%' || q || '%')
    UNION ALL
    SELECT 'FAMILY', NULL, f.employee_id, f.id, NULL, f.full_name, f.gender, f.birth_date,
           CASE f.relationship WHEN 'SPOUSE' THEN 'SPOUSE' WHEN 'CHILD' THEN 'CHILD' ELSE 'DEPENDENT' END, e.employee_no, app.mask(f.nik), app.mask(f.phone),
           NULL, 'Keluarga ' || e.full_name, CASE WHEN f.nik = digits OR e.employee_no = upper(q) THEN 0 ELSE 1 END
      FROM family_member f JOIN employee e ON e.id = f.employee_id
     WHERE f.tenant_id = t AND f.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM patient p WHERE p.family_member_id = f.id AND p.deleted_at IS NULL)
       AND ((length(digits) >= 6 AND f.nik = digits) OR e.employee_no = upper(q) OR f.full_name ILIKE '%' || q || '%')
  )
  SELECT h.kind, h.patient_id, h.employee_id, h.family_member_id, h.mrn, h.full_name, h.gender, h.birth_date, h.patient_type,
         h.employee_no, h.nik, h.phone, h.primary_clinic, h.unit_name
    FROM hits h ORDER BY h.rank, h.full_name LIMIT least(p_limit, 50);
  PERFORM app.log_access('VIEW', 'patient_lookup', NULL, 'PATIENT', left('q=' || q, 100));
END $$;

-- Create (or return) the patient record for an employee / family member at a clinic.
CREATE OR REPLACE FUNCTION app.register_patient(p_kind text, p_ref uuid, p_clinic uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; e employee%ROWTYPE; f family_member%ROWTYPE; v_code text; t uuid := app.current_tenant_id();
BEGIN
  IF NOT app.can('PATIENT', 'CREATE', p_clinic) THEN
    RAISE EXCEPTION 'permission PATIENT:CREATE required at this clinic' USING ERRCODE = '42501';
  END IF;
  SELECT code INTO v_code FROM tenant WHERE id = t;
  IF p_kind = 'EMPLOYEE' THEN
    SELECT id INTO v_id FROM patient WHERE employee_id = p_ref AND deleted_at IS NULL;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    SELECT * INTO e FROM employee WHERE id = p_ref AND tenant_id = t;
    IF NOT FOUND THEN RAISE EXCEPTION 'employee not found' USING ERRCODE = 'P0002'; END IF;
    INSERT INTO patient (tenant_id, mrn, patient_type, employee_id, primary_clinic_id, nik, full_name, gender, birth_date, phone, address, payer_type, bpjs_kesehatan_no, created_by)
    VALUES (t, app.next_document_no('RM', v_code), 'EMPLOYEE', e.id, p_clinic, e.nik, e.full_name, e.gender, e.birth_date, e.phone, e.address, 'COMPANY', e.bpjs_kesehatan_no, app.current_user_id())
    RETURNING id INTO v_id;
  ELSIF p_kind = 'FAMILY' THEN
    SELECT id INTO v_id FROM patient WHERE family_member_id = p_ref AND deleted_at IS NULL;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    SELECT * INTO f FROM family_member WHERE id = p_ref AND tenant_id = t;
    IF NOT FOUND THEN RAISE EXCEPTION 'family member not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO e FROM employee WHERE id = f.employee_id;
    INSERT INTO patient (tenant_id, mrn, patient_type, family_member_id, primary_clinic_id, nik, full_name, gender, birth_date, phone, address, payer_type, bpjs_kesehatan_no, created_by)
    VALUES (t, app.next_document_no('RM', v_code), CASE f.relationship WHEN 'SPOUSE' THEN 'SPOUSE' WHEN 'CHILD' THEN 'CHILD' ELSE 'DEPENDENT' END,
            f.id, p_clinic, f.nik, f.full_name, f.gender, f.birth_date, f.phone, e.address, 'COMPANY', f.bpjs_kesehatan_no, app.current_user_id())
    RETURNING id INTO v_id;
  ELSE
    RAISE EXCEPTION 'unknown registration kind %', p_kind USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 7. FINANCE CAPTURE — every cost-generating event writes cost_transaction.
-- Runs as definer so clinicians do not need FINANCE permissions. Skipped when
-- there is no user context (bulk seeding / migrations write costs explicitly).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_cost_from_dispense() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record;
BEGIN
  IF app.current_user_id() IS NULL OR NEW.txn_type <> 'DISPENSE' THEN RETURN NULL; END IF;
  SELECT rx.patient_id, pa.employee_id, em.org_unit_id AS emp_unit,
         (SELECT d.icd10_code FROM diagnosis d WHERE d.encounter_id = rx.encounter_id AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL LIMIT 1) AS icd,
         rx.prescription_no
    INTO p
    FROM prescription rx JOIN patient pa ON pa.id = rx.patient_id LEFT JOIN employee em ON em.id = pa.employee_id
   WHERE NEW.ref_type = 'prescription' AND rx.id = NEW.ref_id;
  INSERT INTO cost_transaction (tenant_id, org_unit_id, charged_unit_id, cost_category, amount, txn_date, patient_id, employee_id, icd10_code,
                                source_type, source_id, payer_type, description, created_by)
  VALUES (NEW.tenant_id, NEW.org_unit_id, coalesce(p.emp_unit, NEW.org_unit_id), 'MEDICINE', round(-NEW.qty * NEW.unit_cost, 2), NEW.txn_at::date,
          p.patient_id, p.employee_id, p.icd, 'inventory_transaction', NEW.id, 'COMPANY', 'Obat ' || coalesce(p.prescription_no, ''), app.current_user_id());
  RETURN NULL;
END $$;
CREATE TRIGGER cost_from_dispense AFTER INSERT ON inventory_transaction FOR EACH ROW
  WHEN (NEW.txn_type = 'DISPENSE' AND NEW.unit_cost > 0) EXECUTE FUNCTION app.tg_cost_from_dispense();

CREATE OR REPLACE FUNCTION app.tg_cost_from_lab() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_amount numeric; p record;
BEGIN
  IF app.current_user_id() IS NULL OR NEW.status <> 'VERIFIED' OR OLD.status = 'VERIFIED' THEN RETURN NULL; END IF;
  SELECT sum(t.price) INTO v_amount FROM lab_result r JOIN lab_test t ON t.id = r.lab_test_id WHERE r.lab_order_id = NEW.id AND r.deleted_at IS NULL;
  IF coalesce(v_amount, 0) = 0 THEN RETURN NULL; END IF;
  SELECT pa.employee_id, em.org_unit_id AS emp_unit,
         (SELECT d.icd10_code FROM diagnosis d WHERE d.encounter_id = NEW.encounter_id AND d.diagnosis_type = 'PRIMARY' LIMIT 1) AS icd
    INTO p FROM patient pa LEFT JOIN employee em ON em.id = pa.employee_id WHERE pa.id = NEW.patient_id;
  INSERT INTO cost_transaction (tenant_id, org_unit_id, charged_unit_id, cost_category, amount, txn_date, patient_id, employee_id, icd10_code,
                                source_type, source_id, description, created_by)
  VALUES (NEW.tenant_id, NEW.clinic_id, coalesce(p.emp_unit, NEW.clinic_id), 'LAB', v_amount, current_date, NEW.patient_id, p.employee_id, p.icd,
          'lab_order', NEW.id, 'Laboratorium ' || NEW.order_no, app.current_user_id());
  RETURN NULL;
END $$;
CREATE TRIGGER cost_from_lab AFTER UPDATE OF status ON lab_order FOR EACH ROW EXECUTE FUNCTION app.tg_cost_from_lab();

CREATE OR REPLACE FUNCTION app.tg_cost_from_referral() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE p record;
BEGIN
  IF app.current_user_id() IS NULL OR NEW.actual_cost IS NULL OR NEW.actual_cost IS NOT DISTINCT FROM OLD.actual_cost
     OR coalesce(NEW.payer_type, 'COMPANY') <> 'COMPANY' THEN RETURN NULL; END IF;
  SELECT pa.employee_id, em.org_unit_id AS emp_unit INTO p FROM patient pa LEFT JOIN employee em ON em.id = pa.employee_id WHERE pa.id = NEW.patient_id;
  INSERT INTO cost_transaction (tenant_id, org_unit_id, charged_unit_id, cost_category, amount, txn_date, patient_id, employee_id, icd10_code,
                                source_type, source_id, description, created_by)
  VALUES (NEW.tenant_id, NEW.clinic_id, coalesce(p.emp_unit, NEW.clinic_id), 'HOSPITAL', NEW.actual_cost - coalesce(OLD.actual_cost, 0), current_date,
          NEW.patient_id, p.employee_id, NEW.icd10_code, 'referral', NEW.id, 'Biaya RS ' || NEW.referral_no, app.current_user_id());
  RETURN NULL;
END $$;
CREATE TRIGGER cost_from_referral AFTER UPDATE OF actual_cost ON referral FOR EACH ROW EXECUTE FUNCTION app.tg_cost_from_referral();

CREATE OR REPLACE FUNCTION app.tg_cost_from_ambulance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.current_user_id() IS NULL OR NEW.cost = 0 THEN RETURN NULL; END IF;
  INSERT INTO cost_transaction (tenant_id, org_unit_id, cost_category, amount, txn_date, source_type, source_id, description, created_by)
  VALUES (NEW.tenant_id, NEW.clinic_id, 'AMBULANCE', NEW.cost,
          CASE TG_TABLE_NAME WHEN 'ambulance_fuel_log' THEN (to_jsonb(NEW) ->> 'fuel_date')::date ELSE (to_jsonb(NEW) ->> 'service_date')::date END,
          TG_TABLE_NAME, NEW.id, CASE TG_TABLE_NAME WHEN 'ambulance_fuel_log' THEN 'BBM ambulans' ELSE 'Perawatan ambulans' END, app.current_user_id());
  RETURN NULL;
END $$;
CREATE TRIGGER cost_from_fuel AFTER INSERT ON ambulance_fuel_log FOR EACH ROW EXECUTE FUNCTION app.tg_cost_from_ambulance();
CREATE TRIGGER cost_from_maintenance AFTER INSERT ON ambulance_maintenance FOR EACH ROW EXECUTE FUNCTION app.tg_cost_from_ambulance();

CREATE OR REPLACE FUNCTION app.tg_cost_from_mcu() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_n int;
BEGIN
  IF app.current_user_id() IS NULL OR NEW.status <> 'COMPLETED' OR OLD.status = 'COMPLETED' THEN RETURN NULL; END IF;
  SELECT coalesce(cardinality(required_exams), 3) INTO v_n FROM risk_category WHERE id = NEW.risk_category_id;
  INSERT INTO cost_transaction (tenant_id, org_unit_id, charged_unit_id, cost_category, amount, txn_date, patient_id, employee_id, source_type, source_id, description, created_by)
  VALUES (NEW.tenant_id, NEW.clinic_id, NEW.employee_unit_id, 'MCU', 150000 + coalesce(v_n, 3) * 85000, coalesce(NEW.exam_date, current_date),
          NEW.patient_id, NEW.employee_id, 'mcu', NEW.id, 'MCU ' || NEW.mcu_no, app.current_user_id());
  RETURN NULL;
END $$;
CREATE TRIGGER cost_from_mcu AFTER UPDATE OF status ON mcu FOR EACH ROW EXECUTE FUNCTION app.tg_cost_from_mcu();

-- ---------------------------------------------------------------------------
-- 8. EVENT NOTIFICATIONS
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.tg_notify_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_name text; v_unit text;
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NULL; END IF;
  IF TG_TABLE_NAME = 'accident' AND TG_OP = 'INSERT' THEN
    SELECT name INTO v_unit FROM org_unit WHERE id = NEW.org_unit_id;
    PERFORM app.notify_scope(NEW.tenant_id, NEW.org_unit_id, ARRAY['HSE_MANAGER','HSE_OFFICER','ESTATE_MANAGER'], 'ACCIDENT',
            CASE NEW.severity WHEN 'MINOR' THEN 'MEDIUM' WHEN 'MODERATE' THEN 'HIGH' ELSE 'CRITICAL' END,
            'Kecelakaan kerja baru ' || NEW.incident_no, 'Severity ' || NEW.severity || ' di ' || v_unit || ' — ' || NEW.victim_name,
            'accident', NEW.id, '/accidents/' || NEW.id);
    IF NEW.clinic_id IS NOT NULL AND NEW.severity IN ('SERIOUS','MAJOR','FATAL') THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR','NURSE','CLINIC_MANAGER'], 'EMERGENCY', 'CRITICAL',
              'DARURAT: kecelakaan ' || NEW.severity, NEW.victim_name || ' — ' || v_unit, 'accident', NEW.id, '/accidents/' || NEW.id);
    END IF;
  ELSIF TG_TABLE_NAME = 'accident' AND NEW.status = 'PENDING_APPROVAL' AND OLD.status <> 'PENDING_APPROVAL' THEN
    PERFORM app.notify_scope(NEW.tenant_id, NEW.org_unit_id, ARRAY['HSE_MANAGER','ESTATE_MANAGER'], 'APPROVAL_REQUEST', 'MEDIUM',
            'Persetujuan investigasi ' || NEW.incident_no, 'Hasil investigasi menunggu persetujuan', 'accident', NEW.id, '/accidents/' || NEW.id);
  ELSIF TG_TABLE_NAME = 'queue_ticket' AND TG_OP = 'INSERT' THEN
    IF NEW.priority = 'EMERGENCY' THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR','NURSE'], 'EMERGENCY', 'CRITICAL',
              'Pasien gawat darurat ' || NEW.queue_code, 'Segera ke ruang tindakan', 'queue_ticket', NEW.id, '/queue');
    ELSE
      PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR'], 'NEW_PATIENT', 'LOW',
              'Pasien baru ' || NEW.queue_code, 'Pasien terdaftar di antrian', 'queue_ticket', NEW.id, '/queue');
    END IF;
  ELSIF TG_TABLE_NAME = 'referral' AND TG_OP = 'INSERT' AND NEW.status = 'ISSUED' THEN
    PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['MEDICAL_MANAGER','CLINIC_MANAGER'], 'REFERRAL',
            CASE NEW.urgency WHEN 'EMERGENCY' THEN 'CRITICAL' WHEN 'URGENT' THEN 'HIGH' ELSE 'LOW' END,
            'Rujukan baru ' || NEW.referral_no, 'Urgensi ' || NEW.urgency, 'referral', NEW.id, '/referrals/' || NEW.id);
  ELSIF TG_TABLE_NAME = 'stock_transfer' AND TG_OP = 'INSERT' THEN
    SELECT name INTO v_unit FROM org_unit WHERE id = NEW.to_unit_id;
    PERFORM app.notify_scope(NEW.tenant_id, NEW.from_unit_id, ARRAY['PHARMACIST','CLINIC_MANAGER'], 'APPROVAL_REQUEST',
            CASE NEW.priority WHEN 'URGENT' THEN 'HIGH' ELSE 'MEDIUM' END,
            'Permintaan transfer ' || NEW.transfer_no, 'Permintaan obat dari ' || v_unit, 'stock_transfer', NEW.id, '/pharmacy/transfers');
  ELSIF TG_TABLE_NAME = 'stock_transfer' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('APPROVED','REJECTED','IN_TRANSIT') THEN
    PERFORM app.notify_scope(NEW.tenant_id, NEW.to_unit_id, ARRAY['PHARMACIST','CLINIC_MANAGER'], 'APPROVAL_REQUEST', 'LOW',
            'Transfer ' || NEW.transfer_no || ': ' || NEW.status, coalesce(NEW.reject_reason, 'Status permintaan obat diperbarui'), 'stock_transfer', NEW.id, '/pharmacy/transfers');
  ELSIF TG_TABLE_NAME = 'sick_leave' AND TG_OP = 'INSERT' AND NEW.employee_unit_id IS NOT NULL THEN
    PERFORM app.notify_scope(NEW.tenant_id, NEW.employee_unit_id, ARRAY['HR_OFFICER'], 'FOLLOW_UP', 'LOW',
            'Surat sakit ' || NEW.certificate_no, NEW.days || ' hari (' || NEW.start_date || ' s/d ' || NEW.end_date || ')', 'sick_leave', NEW.id, '/sick-leave');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_events AFTER INSERT OR UPDATE OF status ON accident FOR EACH ROW EXECUTE FUNCTION app.tg_notify_events();
CREATE TRIGGER notify_events AFTER INSERT ON queue_ticket FOR EACH ROW EXECUTE FUNCTION app.tg_notify_events();
CREATE TRIGGER notify_events AFTER INSERT ON referral FOR EACH ROW EXECUTE FUNCTION app.tg_notify_events();
CREATE TRIGGER notify_events AFTER INSERT OR UPDATE OF status ON stock_transfer FOR EACH ROW EXECUTE FUNCTION app.tg_notify_events();
CREATE TRIGGER notify_events AFTER INSERT ON sick_leave FOR EACH ROW EXECUTE FUNCTION app.tg_notify_events();

-- ---------------------------------------------------------------------------
-- 9. EMPLOYEE / PATIENT SELF-SERVICE PORTAL (own and dependants' data only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.portal_patient_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce(array_agg(p.id), '{}'::uuid[])
    FROM app_user u
    JOIN patient p ON p.tenant_id = u.tenant_id AND p.deleted_at IS NULL
     AND (p.employee_id = u.employee_id OR p.family_member_id IN (SELECT f.id FROM family_member f WHERE f.employee_id = u.employee_id))
   WHERE u.id = app.current_user_id() AND u.employee_id IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION app.portal_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[] := app.portal_patient_ids(); v_emp uuid; res jsonb;
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'no security context' USING ERRCODE = '42501'; END IF;
  SELECT employee_id INTO v_emp FROM app_user WHERE id = app.current_user_id();
  SELECT jsonb_build_object(
    'employee', (SELECT jsonb_build_object('employee_no', e.employee_no, 'full_name', e.full_name, 'position', jp.name, 'unit', u.name, 'qr_token', e.qr_token,
                                           'bpjs', e.bpjs_kesehatan_no)
                   FROM employee e JOIN job_position jp ON jp.id = e.position_id JOIN org_unit u ON u.id = e.org_unit_id WHERE e.id = v_emp),
    'patients', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'mrn', p.mrn, 'full_name', p.full_name, 'patient_type', p.patient_type,
                                                              'birth_date', p.birth_date, 'qr_token', p.qr_token, 'clinic', c.name) ORDER BY p.patient_type), '[]')
                   FROM patient p JOIN org_unit c ON c.id = p.primary_clinic_id WHERE p.id = ANY (ids)),
    'visits', (SELECT coalesce(jsonb_agg(v ORDER BY v.started_at DESC), '[]') FROM (
                 SELECT e.id, e.started_at, p.full_name AS patient, c.name AS clinic, e.encounter_type,
                        (SELECT string_agg(coalesce(i.title_id, i.title_en), ', ') FROM diagnosis d JOIN icd10_code i ON i.code = d.icd10_code WHERE d.encounter_id = e.id AND d.deleted_at IS NULL) AS diagnosis,
                        (SELECT string_agg(m.name || ' (' || pi.qty || ')', ', ') FROM prescription rx JOIN prescription_item pi ON pi.prescription_id = rx.id JOIN medicine m ON m.id = pi.medicine_id WHERE rx.encounter_id = e.id) AS medicines,
                        e.follow_up_date
                   FROM encounter e JOIN patient p ON p.id = e.patient_id JOIN org_unit c ON c.id = e.clinic_id
                  WHERE e.patient_id = ANY (ids) AND e.deleted_at IS NULL AND e.status = 'SIGNED'
                  ORDER BY e.started_at DESC LIMIT 30) v),
    'sick_leaves', (SELECT coalesce(jsonb_agg(jsonb_build_object('certificate_no', s.certificate_no, 'start_date', s.start_date, 'end_date', s.end_date, 'days', s.days,
                                                                 'leave_type', s.leave_type, 'status', s.status) ORDER BY s.start_date DESC), '[]')
                      FROM sick_leave s WHERE s.patient_id = ANY (ids) AND s.deleted_at IS NULL),
    'mcu', (SELECT coalesce(jsonb_agg(jsonb_build_object('mcu_no', m.mcu_no, 'mcu_type', m.mcu_type, 'status', m.status, 'due_date', m.due_date, 'exam_date', m.exam_date,
                                                         'fit_status', m.fit_status, 'restrictions', m.restrictions, 'next_due_date', m.next_due_date) ORDER BY m.due_date DESC), '[]')
              FROM mcu m WHERE m.employee_id = v_emp AND m.deleted_at IS NULL),
    'appointments', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'scheduled_at', a.scheduled_at, 'clinic', c.name, 'patient', p.full_name,
                                                                  'status', a.status, 'reason', a.reason) ORDER BY a.scheduled_at DESC), '[]')
                       FROM appointment a JOIN org_unit c ON c.id = a.clinic_id JOIN patient p ON p.id = a.patient_id
                      WHERE a.patient_id = ANY (ids) AND a.scheduled_at > now() - interval '60 days'),
    'clinics', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) ORDER BY u.name), '[]')
                  FROM org_unit u JOIN clinic_profile cp ON cp.id = u.id
                 WHERE u.tenant_id = app.current_tenant_id() AND cp.operational_status = 'OPEN' AND u.deleted_at IS NULL))
  INTO res;
  RETURN res;
END $$;

CREATE OR REPLACE FUNCTION app.portal_book_appointment(p_patient uuid, p_clinic uuid, p_at timestamptz, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (p_patient = ANY (app.portal_patient_ids())) THEN RAISE EXCEPTION 'not your patient record' USING ERRCODE = '42501'; END IF;
  IF p_at < now() + interval '1 hour' OR p_at > now() + interval '60 days' THEN
    RAISE EXCEPTION 'appointments can be booked from 1 hour to 60 days ahead' USING ERRCODE = '23514';
  END IF;
  IF extract(hour FROM p_at AT TIME ZONE 'Asia/Jakarta') NOT BETWEEN 7 AND 14 THEN
    RAISE EXCEPTION 'please choose a time within clinic hours (07:00–15:00)' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clinic_profile WHERE id = p_clinic AND tenant_id = app.current_tenant_id() AND operational_status = 'OPEN') THEN
    RAISE EXCEPTION 'clinic is not open for appointments' USING ERRCODE = '23514';
  END IF;
  INSERT INTO appointment (tenant_id, clinic_id, patient_id, scheduled_at, appointment_type, reason, status, created_by)
  VALUES (app.current_tenant_id(), p_clinic, p_patient, p_at, 'CONSULTATION', left(p_reason, 300), 'BOOKED', app.current_user_id())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION app.portal_cancel_appointment(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE appointment SET status = 'CANCELLED', cancel_reason = 'Dibatalkan pasien melalui portal'
   WHERE id = p_id AND patient_id = ANY (app.portal_patient_ids()) AND status IN ('BOOKED','CONFIRMED');
  IF NOT FOUND THEN RAISE EXCEPTION 'appointment not found or cannot be cancelled' USING ERRCODE = 'P0002'; END IF;
END $$;

-- Public verification of a printed certificate (QR) — reveals nothing clinical.
CREATE OR REPLACE FUNCTION app.verify_certificate(p_code text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object('valid', mc.status = 'ISSUED' AND (mc.valid_until IS NULL OR mc.valid_until >= current_date),
                            'certificate_no', mc.certificate_no, 'certificate_type', mc.certificate_type, 'status', mc.status,
                            'patient', left(p.full_name, 1) || repeat('*', greatest(length(p.full_name) - 2, 1)) || right(p.full_name, 1),
                            'clinic', c.name, 'valid_from', mc.valid_from, 'valid_until', mc.valid_until, 'fit_status', mc.fit_status)
    FROM medical_certificate mc JOIN patient p ON p.id = mc.patient_id JOIN org_unit c ON c.id = mc.clinic_id
   WHERE mc.verification_code = upper(p_code)
$$;

UPDATE workflow_transition SET four_eyes = true
 WHERE (entity, from_status, to_status) IN (('accident','PENDING_APPROVAL','FOLLOW_UP'), ('stock_transfer','REQUESTED','APPROVED'),
                                            ('purchase_order','SUBMITTED','APPROVED'), ('stock_opname','SUBMITTED','APPROVED'));

-- Role matrix refinements needed by the workflows
SELECT app._grant('NURSE', 'LAB:U');                  -- sample collection / result entry
SELECT app._grant('ESTATE_MANAGER', 'ACCIDENT:U');    -- approve investigations of the estate
SELECT app._grant('MEDICAL_DIRECTOR', 'INVENTORY:U'); -- approve central purchasing

-- ---------------------------------------------------------------------------
-- 10. GRANTS
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  app.change_own_password(text), app.admin_reset_password(uuid, text), app.set_own_mfa(text, boolean), app.auth_mfa_secret(uuid), app.own_mfa_secret(),
  app.session_create(uuid, text, text, text, interval), app.session_rotate(text, text, interval, interval), app.session_check(uuid, interval),
  app.session_revoke(uuid, text), app.session_revoke_by_token(text), app.my_sessions(),
  app.break_glass(uuid, text, int), app.break_glass_patient_ids(), app.patient_lookup(text, int), app.register_patient(text, uuid, uuid),
  app.portal_patient_ids(), app.portal_summary(), app.portal_book_appointment(uuid, uuid, timestamptz, text), app.portal_cancel_appointment(uuid),
  app.verify_certificate(text), app.mask(text, int)
TO pcms_app;
REVOKE EXECUTE ON FUNCTION app.notify_scope(uuid, uuid, text[], text, text, text, text, text, uuid, text) FROM PUBLIC;
