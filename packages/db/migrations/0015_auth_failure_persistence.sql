-- =============================================================================
-- 0015 · Persist security side effects on authentication failure
-- -----------------------------------------------------------------------------
-- Found by the API integration tests: app.session_rotate() revoked the token
-- family on refresh-token reuse and then RAISEd, so the caller's transaction
-- rolled the revocation (and its audit row) back. A stolen-and-replayed token
-- therefore did NOT kill the attacker's rotated session.
--
-- The function now reports the outcome as data instead of raising, so the
-- revocation commits and the API turns the outcome into HTTP 401 afterwards.
-- (The login handler had the same flaw for failed-attempt counting / lockout;
-- that is fixed in apps/api/src/modules/auth.ts.)
-- =============================================================================

DROP FUNCTION IF EXISTS app.session_rotate(text, text, interval, interval);

CREATE FUNCTION app.session_rotate(p_old_hash text, p_new_hash text, p_ttl interval, p_idle interval)
RETURNS TABLE (session_id uuid, user_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s user_session%ROWTYPE; v_new uuid;
BEGIN
  SELECT * INTO s FROM user_session WHERE refresh_token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'INVALID'::text; RETURN;
  END IF;
  IF s.revoked_at IS NOT NULL THEN
    -- a rotated (or revoked) token was presented again → possible theft: kill the whole family
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'REUSE_DETECTED'
     WHERE family_id = s.family_id AND revoked_at IS NULL;
    IF FOUND THEN
      INSERT INTO audit.audit_log (tenant_id, user_id, table_name, record_id, action, note)
      VALUES (s.tenant_id, s.user_id, 'user_session', s.id, 'LOGIN_FAILED', 'refresh token reuse detected; session family revoked');
    END IF;
    RETURN QUERY SELECT NULL::uuid, s.user_id, 'REUSE_DETECTED'::text; RETURN;
  END IF;
  IF s.expires_at < now() OR s.last_used_at < now() - p_idle THEN
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'EXPIRED' WHERE id = s.id;
    RETURN QUERY SELECT NULL::uuid, s.user_id, 'EXPIRED'::text; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = s.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
                   AND (u.locked_until IS NULL OR u.locked_until < now())) THEN
    UPDATE user_session SET revoked_at = now(), revoke_reason = 'USER_INACTIVE' WHERE id = s.id;
    RETURN QUERY SELECT NULL::uuid, s.user_id, 'USER_INACTIVE'::text; RETURN;
  END IF;
  UPDATE user_session SET revoked_at = now(), revoke_reason = 'ROTATED' WHERE id = s.id;
  INSERT INTO user_session (tenant_id, user_id, refresh_token_hash, family_id, ip_address, user_agent, device_label, expires_at)
  VALUES (s.tenant_id, s.user_id, p_new_hash, s.family_id, s.ip_address, s.user_agent, s.device_label, now() + p_ttl)
  RETURNING id INTO v_new;
  RETURN QUERY SELECT v_new, s.user_id, 'OK'::text;
END $$;

REVOKE ALL ON FUNCTION app.session_rotate(text, text, interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.session_rotate(text, text, interval, interval) TO pcms_app;
