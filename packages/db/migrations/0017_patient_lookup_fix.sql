-- =============================================================================
-- 0017 · Patient lookup: name the masked columns
-- -----------------------------------------------------------------------------
-- Found by the API latency check: the first branch of the lookup CTE produced
-- unnamed columns for app.mask(nik)/app.mask(phone), so the outer SELECT of
-- h.nik / h.phone failed and registration search returned HTTP 500.
-- =============================================================================

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
           p.patient_type, e.employee_no, app.mask(p.nik) AS nik, app.mask(p.phone) AS phone, c.name AS primary_clinic, eu.name AS unit_name,
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
