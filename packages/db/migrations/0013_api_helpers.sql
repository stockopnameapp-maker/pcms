-- =============================================================================
-- 0013 API HELPERS
-- Narrow, permission-checked look-ups that let clinical/HSE staff reference an
-- employee (for MCU, accidents, certificates) without granting them the HR
-- module. Only placement data is returned — no HR details.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.tenant_code() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT code::text FROM tenant WHERE id = app.current_tenant_id() $$;

CREATE OR REPLACE FUNCTION app.unit_company_code(p_unit uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((SELECT c.code::text FROM org_unit u JOIN org_unit c ON c.path @> u.path AND c.unit_type = 'COMPANY' WHERE u.id = p_unit LIMIT 1), app.tenant_code())
$$;

CREATE OR REPLACE FUNCTION app.employee_brief(p_employee uuid)
RETURNS TABLE (id uuid, employee_no text, full_name text, gender char(1), birth_date date, org_unit_id uuid, unit_name text, position_id uuid, position_name text,
               risk_category_id uuid, risk_name text, company_code text, estate_id uuid, patient_id uuid, primary_clinic_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.has_perm('EMPLOYEE','READ') OR app.has_perm('OCC_HEALTH','CREATE') OR app.has_perm('ACCIDENT','CREATE')
          OR app.has_perm('SICK_LEAVE','CREATE') OR app.has_perm('PATIENT','CREATE')) THEN
    RAISE EXCEPTION 'not allowed to reference employees' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.employee_no, e.full_name, e.gender, e.birth_date, e.org_unit_id, u.name, e.position_id, jp.name, e.risk_category_id, rc.name,
         app.unit_company_code(e.org_unit_id), e.estate_id, p.id, p.primary_clinic_id
    FROM employee e JOIN org_unit u ON u.id = e.org_unit_id JOIN job_position jp ON jp.id = e.position_id
    LEFT JOIN risk_category rc ON rc.id = e.risk_category_id
    LEFT JOIN patient p ON p.employee_id = e.id AND p.deleted_at IS NULL
   WHERE e.id = p_employee AND e.tenant_id = app.current_tenant_id() AND e.deleted_at IS NULL;
END $$;

-- Employee picker for clinical/HSE forms (same permission rule, minimal columns)
CREATE OR REPLACE FUNCTION app.employee_pick(p_q text, p_limit int DEFAULT 20)
RETURNS TABLE (id uuid, label text, sub text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT (app.has_perm('EMPLOYEE','READ') OR app.has_perm('OCC_HEALTH','CREATE') OR app.has_perm('ACCIDENT','CREATE')
          OR app.has_perm('SICK_LEAVE','CREATE') OR app.has_perm('PATIENT','CREATE') OR app.has_perm('USER_ADMIN','UPDATE')) THEN
    RAISE EXCEPTION 'not allowed to reference employees' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.id, e.employee_no || ' · ' || e.full_name, jp.name || ' — ' || u.name
    FROM employee e JOIN org_unit u ON u.id = e.org_unit_id JOIN job_position jp ON jp.id = e.position_id
   WHERE e.tenant_id = app.current_tenant_id() AND e.deleted_at IS NULL AND e.employment_status = 'ACTIVE'
     AND (coalesce(p_q, '') = '' OR e.full_name ILIKE '%' || p_q || '%' OR e.employee_no ILIKE '%' || p_q || '%')
   ORDER BY e.full_name LIMIT least(p_limit, 50);
END $$;

-- owner of a freshly rotated session (used to mint the new access token)
CREATE OR REPLACE FUNCTION app.session_owner(p_session uuid) RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT s.user_id, s.tenant_id FROM user_session s WHERE s.id = p_session AND s.revoked_at IS NULL AND s.expires_at > now() $$;

GRANT EXECUTE ON FUNCTION app.session_owner(uuid) TO pcms_app;
GRANT EXECUTE ON FUNCTION app.tenant_code(), app.unit_company_code(uuid), app.employee_brief(uuid), app.employee_pick(text, int) TO pcms_app;

-- The supplying site splits transfer lines per batch when shipping.
DROP POLICY ins ON stock_transfer_item;
CREATE POLICY ins ON stock_transfer_item FOR INSERT WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND EXISTS (
  SELECT 1 FROM stock_transfer s WHERE s.id = stock_transfer_id
     AND (s.to_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','CREATE'))::uuid[]) OR s.from_unit_id = ANY ((SELECT app.unit_ids('INVENTORY','UPDATE'))::uuid[]))));
