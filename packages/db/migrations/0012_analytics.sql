-- =============================================================================
-- 0012 HEALTH INTELLIGENCE & ANALYTICS (Phase 9)
-- Dashboards need aggregates over clinical data that managers may not read
-- row-by-row. These SECURITY DEFINER functions:
--   1. verify DASHBOARD:READ on the requested org unit (scope),
--   2. aggregate only within that unit's subtree,
--   3. apply small-cell suppression (counts < 5 hidden) to disease data when
--      the caller has no EMR:READ on the unit — so aggregates cannot be used
--      to re-identify individual patients.
-- =============================================================================
CREATE SCHEMA IF NOT EXISTS analytics;
GRANT USAGE ON SCHEMA analytics TO pcms_app;

CREATE OR REPLACE FUNCTION analytics.scope(p_unit uuid) RETURNS ltree
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v ltree;
BEGIN
  IF p_unit IS NULL OR NOT app.can('DASHBOARD', 'READ', p_unit) THEN
    RAISE EXCEPTION 'permission DASHBOARD:READ required for this organisation unit' USING ERRCODE = '42501';
  END IF;
  SELECT path INTO v FROM org_unit WHERE id = p_unit;
  RETURN v;
END $$;

-- small-cell suppression threshold
CREATE OR REPLACE FUNCTION analytics.suppress(p_count bigint, p_unit uuid) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_count IS NULL OR p_count >= 5 OR app.can('EMR', 'READ', p_unit) THEN p_count ELSE NULL END
$$;

-- ---------------------------------------------------------------------------
-- KPI summary with previous-period comparison
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.kpi_summary(p_unit uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  sp ltree := analytics.scope(p_unit);
  len int := (p_to - p_from) + 1;
  pf date := p_from - len; pt date := p_from - 1;
  r jsonb;
BEGIN
  WITH clinics AS (SELECT u.id FROM org_unit u WHERE u.unit_type = 'CLINIC' AND u.path <@ sp AND u.deleted_at IS NULL),
  enc AS (SELECT e.started_at::date AS d, e.patient_id FROM encounter e WHERE e.clinic_id IN (SELECT id FROM clinics)
            AND e.status <> 'CANCELLED' AND e.deleted_at IS NULL AND e.started_at::date BETWEEN pf AND p_to),
  emp AS (SELECT e.id FROM employee e JOIN org_unit u ON u.id = e.org_unit_id WHERE u.path <@ sp AND e.employment_status = 'ACTIVE' AND e.deleted_at IS NULL),
  acc AS (SELECT a.occurred_at::date AS d, a.is_lti, a.lost_time_days, a.incident_type FROM accident a JOIN org_unit u ON u.id = a.org_unit_id
           WHERE u.path <@ sp AND a.deleted_at IS NULL AND a.status <> 'CANCELLED' AND a.occurred_at::date BETWEEN pf AND p_to),
  ref AS (SELECT r.referral_date AS d FROM referral r WHERE r.clinic_id IN (SELECT id FROM clinics) AND r.status <> 'CANCELLED' AND r.deleted_at IS NULL
           AND r.referral_date BETWEEN pf AND p_to),
  sl AS (SELECT s.start_date AS d, s.days FROM sick_leave s
           LEFT JOIN org_unit eu ON eu.id = s.employee_unit_id JOIN org_unit cu ON cu.id = s.clinic_id
          WHERE (eu.path <@ sp OR cu.path <@ sp) AND s.status <> 'CANCELLED' AND s.deleted_at IS NULL AND s.start_date BETWEEN pf AND p_to),
  cost AS (SELECT c.txn_date AS d, c.cost_category, c.amount FROM cost_transaction c JOIN org_unit u ON u.id = coalesce(c.charged_unit_id, c.org_unit_id)
            WHERE u.path <@ sp AND c.deleted_at IS NULL AND c.txn_date BETWEEN pf AND p_to),
  dx AS (SELECT count(*) AS n FROM diagnosis d JOIN encounter e ON e.id = d.encounter_id
          WHERE e.clinic_id IN (SELECT id FROM clinics) AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL
            AND e.started_at::date BETWEEN p_from AND p_to),
  hs AS (SELECT h.mcu_compliance, h.fit_status FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id WHERE u.path <@ sp)
  SELECT jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'previous_from', pf, 'previous_to', pt),
    'total_employees', (SELECT count(*) FROM emp),
    'total_clinics', (SELECT count(*) FROM clinics),
    'patient_visits', (SELECT count(*) FROM enc WHERE d >= p_from),
    'patient_visits_prev', (SELECT count(*) FROM enc WHERE d < p_from),
    'unique_patients', (SELECT count(DISTINCT patient_id) FROM enc WHERE d >= p_from),
    'disease_cases', (SELECT n FROM dx),
    'accident_cases', (SELECT count(*) FROM acc WHERE d >= p_from AND incident_type <> 'NEAR_MISS'),
    'accident_cases_prev', (SELECT count(*) FROM acc WHERE d < p_from AND incident_type <> 'NEAR_MISS'),
    'near_miss', (SELECT count(*) FROM acc WHERE d >= p_from AND incident_type = 'NEAR_MISS'),
    'lti_cases', (SELECT count(*) FROM acc WHERE d >= p_from AND is_lti),
    'lost_days', (SELECT coalesce(sum(lost_time_days), 0) FROM acc WHERE d >= p_from),
    'referrals', (SELECT count(*) FROM ref WHERE d >= p_from),
    'referrals_prev', (SELECT count(*) FROM ref WHERE d < p_from),
    'sick_leave_cases', (SELECT count(*) FROM sl WHERE d >= p_from),
    'sick_leave_days', (SELECT coalesce(sum(days), 0) FROM sl WHERE d >= p_from),
    'sick_leave_days_prev', (SELECT coalesce(sum(days), 0) FROM sl WHERE d < p_from),
    'medicine_cost', (SELECT coalesce(sum(amount), 0) FROM cost WHERE d >= p_from AND cost_category = 'MEDICINE'),
    'medical_cost', (SELECT coalesce(sum(amount), 0) FROM cost WHERE d >= p_from),
    'medical_cost_prev', (SELECT coalesce(sum(amount), 0) FROM cost WHERE d < p_from),
    'cost_per_employee', (SELECT round(coalesce(sum(amount), 0) / nullif((SELECT count(*) FROM emp), 0)) FROM cost WHERE d >= p_from),
    'mcu_total', (SELECT count(*) FROM hs),
    'mcu_up_to_date', (SELECT count(*) FROM hs WHERE mcu_compliance IN ('UP_TO_DATE','DUE_SOON')),
    'mcu_overdue', (SELECT count(*) FROM hs WHERE mcu_compliance IN ('OVERDUE','NEVER_EXAMINED')),
    'mcu_completion_pct', (SELECT round(100.0 * count(*) FILTER (WHERE mcu_compliance IN ('UP_TO_DATE','DUE_SOON')) / nullif(count(*), 0), 1) FROM hs),
    'fit', (SELECT count(*) FROM hs WHERE fit_status = 'FIT'),
    'fit_with_restriction', (SELECT count(*) FROM hs WHERE fit_status = 'FIT_WITH_RESTRICTION'),
    'temporarily_unfit', (SELECT count(*) FROM hs WHERE fit_status = 'TEMPORARILY_UNFIT'),
    'unfit', (SELECT count(*) FROM hs WHERE fit_status = 'UNFIT'),
    'open_alerts', (SELECT count(*) FROM health_alert a JOIN org_unit u ON u.id = a.org_unit_id WHERE u.path <@ sp AND a.status IN ('OPEN','ACKNOWLEDGED')),
    'critical_alerts', (SELECT count(*) FROM health_alert a JOIN org_unit u ON u.id = a.org_unit_id WHERE u.path <@ sp AND a.status IN ('OPEN','ACKNOWLEDGED') AND a.severity IN ('HIGH','CRITICAL'))
  ) INTO r;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------------
-- Time series
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.trend(p_unit uuid, p_from date, p_to date, p_metric text, p_bucket text DEFAULT 'week')
RETURNS TABLE (bucket date, value numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit); b text := CASE WHEN p_bucket IN ('day','week','month') THEN p_bucket ELSE 'week' END;
        icd text := CASE WHEN p_metric LIKE 'disease:%' THEN substr(p_metric, 9) END;
BEGIN
  RETURN QUERY
  WITH buckets AS (SELECT generate_series(date_trunc(b, p_from::timestamp), date_trunc(b, p_to::timestamp), ('1 ' || b)::interval)::date AS bk),
  data AS (
    SELECT date_trunc(b, e.started_at)::date AS bk, 1::numeric AS v FROM encounter e JOIN org_unit c ON c.id = e.clinic_id
     WHERE p_metric = 'visits' AND c.path <@ sp AND e.status <> 'CANCELLED' AND e.deleted_at IS NULL AND e.started_at::date BETWEEN p_from AND p_to
    UNION ALL
    SELECT date_trunc(b, e.started_at)::date, 1 FROM diagnosis d JOIN encounter e ON e.id = d.encounter_id JOIN org_unit c ON c.id = e.clinic_id
     WHERE icd IS NOT NULL AND d.icd10_code = icd AND d.diagnosis_type = 'PRIMARY' AND c.path <@ sp AND e.started_at::date BETWEEN p_from AND p_to
    UNION ALL
    SELECT date_trunc(b, a.occurred_at)::date, 1 FROM accident a JOIN org_unit u ON u.id = a.org_unit_id
     WHERE p_metric = 'accidents' AND u.path <@ sp AND a.incident_type <> 'NEAR_MISS' AND a.status <> 'CANCELLED' AND a.occurred_at::date BETWEEN p_from AND p_to
    UNION ALL
    SELECT date_trunc(b, r.referral_date)::date, 1 FROM referral r JOIN org_unit c ON c.id = r.clinic_id
     WHERE p_metric = 'referrals' AND c.path <@ sp AND r.status <> 'CANCELLED' AND r.referral_date BETWEEN p_from AND p_to
    UNION ALL
    SELECT date_trunc(b, s.start_date)::date, s.days FROM sick_leave s LEFT JOIN org_unit eu ON eu.id = s.employee_unit_id JOIN org_unit cu ON cu.id = s.clinic_id
     WHERE p_metric = 'sick_leave_days' AND (eu.path <@ sp OR cu.path <@ sp) AND s.status <> 'CANCELLED' AND s.start_date BETWEEN p_from AND p_to
    UNION ALL
    SELECT date_trunc(b, c.txn_date)::date, c.amount FROM cost_transaction c JOIN org_unit u ON u.id = coalesce(c.charged_unit_id, c.org_unit_id)
     WHERE (p_metric = 'medical_cost' OR (p_metric = 'medicine_cost' AND c.cost_category = 'MEDICINE'))
       AND u.path <@ sp AND c.deleted_at IS NULL AND c.txn_date BETWEEN p_from AND p_to
  )
  SELECT bu.bk, coalesce(sum(d.v), 0) FROM buckets bu LEFT JOIN data d ON d.bk = bu.bk GROUP BY bu.bk ORDER BY bu.bk;
END $$;

-- ---------------------------------------------------------------------------
-- Top diseases (suppressed for viewers without clinical access)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.top_diseases(p_unit uuid, p_from date, p_to date, p_limit int DEFAULT 10, p_risk text DEFAULT NULL)
RETURNS TABLE (icd10_code text, title text, cases bigint, share numeric, occupational boolean, suppressed boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit);
BEGIN
  RETURN QUERY
  WITH d AS (
    SELECT d.icd10_code AS code, count(*) AS n, bool_or(d.is_occupational) AS occ
      FROM diagnosis d JOIN encounter e ON e.id = d.encounter_id JOIN org_unit c ON c.id = e.clinic_id
      LEFT JOIN patient p ON p.id = e.patient_id LEFT JOIN employee em ON em.id = p.employee_id LEFT JOIN risk_category rc ON rc.id = em.risk_category_id
     WHERE c.path <@ sp AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL AND e.started_at::date BETWEEN p_from AND p_to
       AND (p_risk IS NULL OR rc.code = p_risk)
     GROUP BY d.icd10_code),
  tot AS (SELECT sum(n) AS t FROM d)
  SELECT d.code, coalesce(i.title_id, i.title_en), analytics.suppress(d.n, p_unit),
         CASE WHEN analytics.suppress(d.n, p_unit) IS NULL THEN NULL ELSE round(100.0 * d.n / nullif(tot.t, 0), 1) END,
         d.occ, analytics.suppress(d.n, p_unit) IS NULL
    FROM d CROSS JOIN tot JOIN icd10_code i ON i.code = d.code
   ORDER BY d.n DESC LIMIT p_limit;
END $$;

-- ---------------------------------------------------------------------------
-- Drill-down: one row per direct child unit (GROUP → PT → ESTATE → CLINIC)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.breakdown(p_unit uuid, p_from date, p_to date)
RETURNS TABLE (unit_id uuid, unit_type text, code text, name text, employees bigint, clinics bigint, visits bigint, accidents bigint, lti bigint,
               referrals bigint, sick_leave_days bigint, medical_cost numeric, cost_per_employee numeric, mcu_completion_pct numeric,
               unfit bigint, open_alerts bigint, can_drill boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit);
BEGIN
  RETURN QUERY
  SELECT ch.id, ch.unit_type, ch.code::text, ch.name,
    (SELECT count(*) FROM employee e JOIN org_unit u ON u.id = e.org_unit_id WHERE u.path <@ ch.path AND e.employment_status = 'ACTIVE' AND e.deleted_at IS NULL),
    (SELECT count(*) FROM org_unit u WHERE u.path <@ ch.path AND u.unit_type = 'CLINIC'),
    (SELECT count(*) FROM encounter e JOIN org_unit c ON c.id = e.clinic_id WHERE c.path <@ ch.path AND e.status <> 'CANCELLED' AND e.started_at::date BETWEEN p_from AND p_to),
    (SELECT count(*) FROM accident a JOIN org_unit u ON u.id = a.org_unit_id WHERE u.path <@ ch.path AND a.incident_type <> 'NEAR_MISS' AND a.status <> 'CANCELLED' AND a.occurred_at::date BETWEEN p_from AND p_to),
    (SELECT count(*) FROM accident a JOIN org_unit u ON u.id = a.org_unit_id WHERE u.path <@ ch.path AND a.is_lti AND a.occurred_at::date BETWEEN p_from AND p_to),
    (SELECT count(*) FROM referral r JOIN org_unit c ON c.id = r.clinic_id WHERE c.path <@ ch.path AND r.status <> 'CANCELLED' AND r.referral_date BETWEEN p_from AND p_to),
    (SELECT coalesce(sum(s.days), 0) FROM sick_leave s JOIN org_unit u ON u.id = coalesce(s.employee_unit_id, s.clinic_id) WHERE u.path <@ ch.path AND s.status <> 'CANCELLED' AND s.start_date BETWEEN p_from AND p_to),
    (SELECT coalesce(sum(c.amount), 0) FROM cost_transaction c JOIN org_unit u ON u.id = coalesce(c.charged_unit_id, c.org_unit_id) WHERE u.path <@ ch.path AND c.txn_date BETWEEN p_from AND p_to),
    NULL::numeric,
    (SELECT round(100.0 * count(*) FILTER (WHERE h.mcu_compliance IN ('UP_TO_DATE','DUE_SOON')) / nullif(count(*), 0), 1)
       FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id WHERE u.path <@ ch.path),
    (SELECT count(*) FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id WHERE u.path <@ ch.path AND h.fit_status IN ('UNFIT','TEMPORARILY_UNFIT')),
    (SELECT count(*) FROM health_alert a JOIN org_unit u ON u.id = a.org_unit_id WHERE u.path <@ ch.path AND a.status IN ('OPEN','ACKNOWLEDGED')),
    EXISTS (SELECT 1 FROM org_unit g WHERE g.parent_id = ch.id AND g.unit_type IN ('COMPANY','REGION','ESTATE','MILL','CLINIC'))
  FROM org_unit ch
  WHERE ch.parent_id = p_unit AND ch.deleted_at IS NULL AND ch.unit_type IN ('COMPANY','REGION','ESTATE','MILL','CLINIC','DIVISION','AFDELING')
  ORDER BY ch.unit_type, ch.name;
END $$;

-- cost per employee filled in a wrapper to keep the main query readable
CREATE OR REPLACE FUNCTION analytics.drilldown(p_unit uuid, p_from date, p_to date) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT to_jsonb(b) || jsonb_build_object('cost_per_employee', CASE WHEN b.employees > 0 THEN round(b.medical_cost / b.employees) END)
    FROM analytics.breakdown(p_unit, p_from, p_to) b
$$;

-- ---------------------------------------------------------------------------
-- Cost analytics: per category / company / estate / clinic / disease / employee / month
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.cost_breakdown(p_unit uuid, p_from date, p_to date, p_dimension text, p_limit int DEFAULT 20)
RETURNS TABLE (key text, label text, amount numeric, transactions bigint, per_employee numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit);
BEGIN
  IF NOT (app.can('FINANCE', 'READ', p_unit) OR app.can('DASHBOARD', 'READ', p_unit)) THEN
    RAISE EXCEPTION 'permission FINANCE:READ required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT c.amount,
           CASE p_dimension
             WHEN 'category' THEN c.cost_category
             WHEN 'company' THEN c.company_id::text
             WHEN 'estate' THEN c.estate_id::text
             WHEN 'clinic' THEN c.org_unit_id::text
             WHEN 'disease' THEN c.icd10_code
             WHEN 'employee' THEN c.employee_id::text
             WHEN 'payer' THEN c.payer_type
             ELSE to_char(c.txn_date, 'YYYY-MM') END AS k
      FROM cost_transaction c JOIN org_unit u ON u.id = coalesce(c.charged_unit_id, c.org_unit_id)
     WHERE u.path <@ sp AND c.deleted_at IS NULL AND c.txn_date BETWEEN p_from AND p_to),
  g AS (SELECT c.k, sum(c.amount) AS a, count(*) AS n FROM c WHERE c.k IS NOT NULL GROUP BY c.k),
  emp AS (SELECT u.path FROM employee e JOIN org_unit u ON u.id = e.org_unit_id WHERE u.path <@ sp AND e.employment_status = 'ACTIVE' AND e.deleted_at IS NULL)
  SELECT g.k,
         CASE p_dimension
           WHEN 'company' THEN (SELECT o.name FROM org_unit o WHERE o.id::text = g.k)
           WHEN 'estate'  THEN (SELECT o.name FROM org_unit o WHERE o.id::text = g.k)
           WHEN 'clinic'  THEN (SELECT o.name FROM org_unit o WHERE o.id::text = g.k)
           WHEN 'disease' THEN (SELECT coalesce(i.title_id, i.title_en) FROM icd10_code i WHERE i.code = g.k)
           WHEN 'employee' THEN (SELECT e.employee_no || ' · ' || e.full_name FROM employee e WHERE e.id::text = g.k)
           ELSE g.k END,
         g.a, g.n,
         CASE WHEN p_dimension IN ('company','estate')
              THEN round(g.a / nullif((SELECT count(*) FROM emp WHERE emp.path <@ (SELECT o.path FROM org_unit o WHERE o.id::text = g.k)), 0)) END
    FROM g
   ORDER BY CASE WHEN p_dimension = 'month' THEN g.k END, g.a DESC
   LIMIT CASE WHEN p_dimension = 'month' THEN 120 ELSE p_limit END;
END $$;

-- ---------------------------------------------------------------------------
-- Medicine consumption, accidents, occupational health, clinic performance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.medicine_consumption(p_unit uuid, p_from date, p_to date, p_limit int DEFAULT 15)
RETURNS TABLE (medicine_id uuid, code text, name text, unit text, qty numeric, cost numeric, prescriptions bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit);
BEGIN
  RETURN QUERY
  SELECT m.id, m.code, m.name, m.unit, sum(-t.qty), sum(-t.qty * t.unit_cost), count(DISTINCT t.ref_id)
    FROM inventory_transaction t JOIN org_unit u ON u.id = t.org_unit_id JOIN medicine m ON m.id = t.medicine_id
   WHERE u.path <@ sp AND t.txn_type = 'DISPENSE' AND t.txn_at::date BETWEEN p_from AND p_to
   GROUP BY m.id, m.code, m.name, m.unit ORDER BY 6 DESC LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION analytics.accident_stats(p_unit uuid, p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit); r jsonb; emp bigint; days int := (p_to - p_from) + 1;
BEGIN
  SELECT count(*) INTO emp FROM employee e JOIN org_unit u ON u.id = e.org_unit_id WHERE u.path <@ sp AND e.employment_status = 'ACTIVE';
  WITH a AS (SELECT a.* FROM accident a JOIN org_unit u ON u.id = a.org_unit_id
              WHERE u.path <@ sp AND a.status <> 'CANCELLED' AND a.deleted_at IS NULL AND a.occurred_at::date BETWEEN p_from AND p_to)
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM a WHERE incident_type <> 'NEAR_MISS'),
    'near_miss', (SELECT count(*) FROM a WHERE incident_type = 'NEAR_MISS'),
    'lti', (SELECT count(*) FROM a WHERE is_lti),
    'lost_days', (SELECT coalesce(sum(lost_time_days), 0) FROM a),
    -- LTIFR per 1,000,000 man-hours (assumes 2,000 h per worker-year)
    'ltifr', round((SELECT count(*) FROM a WHERE is_lti) * 1000000.0 / nullif(emp * 2000.0 * days / 365.0, 0), 2),
    'severity_rate', round((SELECT coalesce(sum(lost_time_days), 0) FROM a) * 1000000.0 / nullif(emp * 2000.0 * days / 365.0, 0), 1),
    'open_cases', (SELECT count(*) FROM a WHERE status NOT IN ('CLOSED')),
    'pending_approval', (SELECT count(*) FROM a WHERE status = 'PENDING_APPROVAL'),
    'by_severity', (SELECT coalesce(jsonb_object_agg(severity, n), '{}') FROM (SELECT severity, count(*) n FROM a GROUP BY 1) s),
    'by_type', (SELECT coalesce(jsonb_object_agg(incident_type, n), '{}') FROM (SELECT incident_type, count(*) n FROM a GROUP BY 1) s),
    'by_activity', (SELECT coalesce(jsonb_object_agg(activity, n), '{}') FROM (SELECT activity, count(*) n FROM a GROUP BY 1) s),
    'by_body_part', (SELECT coalesce(jsonb_object_agg(body_part, n), '{}') FROM (SELECT body_part, count(*) n FROM a WHERE body_part IS NOT NULL GROUP BY 1) s),
    'by_status', (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*) n FROM a GROUP BY 1) s)
  ) INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION analytics.occupational_health(p_unit uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit); r jsonb;
BEGIN
  WITH h AS (SELECT h.* FROM v_employee_health_status h JOIN org_unit u ON u.id = h.org_unit_id WHERE u.path <@ sp)
  SELECT jsonb_build_object(
    'compliance', (SELECT coalesce(jsonb_object_agg(mcu_compliance, n), '{}') FROM (SELECT mcu_compliance, count(*) n FROM h GROUP BY 1) s),
    'fit_status', (SELECT coalesce(jsonb_object_agg(coalesce(fit_status, 'NOT_ASSESSED'), n), '{}') FROM (SELECT fit_status, count(*) n FROM h GROUP BY 1) s),
    'by_risk', (SELECT coalesce(jsonb_agg(x ORDER BY x.risk_level DESC, x.employees DESC), '[]') FROM (
                  SELECT risk_code, risk_name, risk_level, count(*) AS employees,
                         count(*) FILTER (WHERE mcu_compliance IN ('UP_TO_DATE','DUE_SOON')) AS compliant,
                         count(*) FILTER (WHERE mcu_compliance = 'OVERDUE') AS overdue,
                         count(*) FILTER (WHERE mcu_compliance = 'NEVER_EXAMINED') AS never,
                         count(*) FILTER (WHERE fit_status = 'FIT_WITH_RESTRICTION') AS restricted,
                         count(*) FILTER (WHERE fit_status IN ('TEMPORARILY_UNFIT','UNFIT')) AS unfit
                    FROM h GROUP BY 1, 2, 3) x),
    'occupational_cases_90d', (
       SELECT coalesce(jsonb_agg(jsonb_build_object('risk', rc.name, 'icd10', d.icd10_code, 'title', coalesce(i.title_id, i.title_en),
                                                    'cases', analytics.suppress(cnt, p_unit))), '[]')
         FROM (SELECT em.risk_category_id, d.icd10_code, count(*) AS cnt
                 FROM diagnosis d JOIN encounter e ON e.id = d.encounter_id JOIN org_unit c ON c.id = e.clinic_id
                 JOIN patient p ON p.id = e.patient_id JOIN employee em ON em.id = p.employee_id
                WHERE c.path <@ sp AND d.is_occupational AND e.started_at > now() - interval '90 days'
                GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15) d
         JOIN risk_category rc ON rc.id = d.risk_category_id JOIN icd10_code i ON i.code = d.icd10_code),
    'upcoming_mcu_30d', (SELECT count(*) FROM mcu m JOIN org_unit u ON u.id = m.employee_unit_id
                          WHERE u.path <@ sp AND m.status IN ('PLANNED','SCHEDULED') AND coalesce(m.scheduled_date, m.due_date) <= current_date + 30)
  ) INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION analytics.clinic_performance(p_unit uuid, p_from date, p_to date)
RETURNS TABLE (clinic_id uuid, clinic text, status text, visits bigint, avg_wait_min numeric, avg_consult_min numeric, referral_rate numeric,
               items_per_visit numeric, cost_per_visit numeric, doctors bigint, nurses bigint, visits_per_doctor_day numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sp ltree := analytics.scope(p_unit); days int := greatest((p_to - p_from) + 1, 1);
BEGIN
  RETURN QUERY
  SELECT c.id, c.name, cp.operational_status,
    v.n, v.wait, v.consult,
    round(100.0 * (SELECT count(*) FROM referral r WHERE r.clinic_id = c.id AND r.referral_date BETWEEN p_from AND p_to) / nullif(v.n, 0), 1),
    round((SELECT count(*) FROM prescription_item pi JOIN prescription rx ON rx.id = pi.prescription_id
            WHERE rx.clinic_id = c.id AND rx.prescribed_at::date BETWEEN p_from AND p_to)::numeric / nullif(v.n, 0), 2),
    round((SELECT coalesce(sum(ct.amount), 0) FROM cost_transaction ct WHERE ct.org_unit_id = c.id AND ct.cost_category IN ('MEDICINE','LAB')
            AND ct.txn_date BETWEEN p_from AND p_to) / nullif(v.n, 0)),
    (SELECT count(*) FROM medical_staff s WHERE s.home_clinic_id = c.id AND s.staff_type = 'DOCTOR' AND s.status = 'ACTIVE'),
    (SELECT count(*) FROM medical_staff s WHERE s.home_clinic_id = c.id AND s.staff_type IN ('NURSE','MIDWIFE') AND s.status = 'ACTIVE'),
    round(v.n::numeric / nullif((SELECT count(*) FROM medical_staff s WHERE s.home_clinic_id = c.id AND s.staff_type = 'DOCTOR'), 0) / days, 1)
  FROM org_unit c JOIN clinic_profile cp ON cp.id = c.id
  CROSS JOIN LATERAL (
    SELECT count(*) AS n,
           round(avg(extract(epoch FROM q.consult_start_at - q.registered_at) / 60) FILTER (WHERE q.consult_start_at IS NOT NULL), 1) AS wait,
           round(avg(extract(epoch FROM q.consult_end_at - q.consult_start_at) / 60) FILTER (WHERE q.consult_end_at IS NOT NULL), 1) AS consult
      FROM queue_ticket q WHERE q.clinic_id = c.id AND q.visit_date BETWEEN p_from AND p_to AND q.status <> 'CANCELLED') v
  WHERE c.path <@ sp AND c.unit_type = 'CLINIC'
  ORDER BY v.n DESC;
END $$;

-- Live clinic board (Clinic Dashboard)
CREATE OR REPLACE FUNCTION analytics.clinic_today(p_clinic uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; dow int := extract(isodow FROM current_date);
BEGIN
  IF NOT (app.can('DASHBOARD', 'READ', p_clinic) OR app.can('QUEUE', 'READ', p_clinic)) THEN
    RAISE EXCEPTION 'permission DASHBOARD:READ or QUEUE:READ required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'clinic', (SELECT jsonb_build_object('id', u.id, 'name', u.name, 'status', cp.operational_status, 'emergency_phone', cp.emergency_phone,
                                         'beds', cp.bed_capacity, 'operating_hours', cp.operating_hours)
                 FROM org_unit u JOIN clinic_profile cp ON cp.id = u.id WHERE u.id = p_clinic),
    'queue', (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM (SELECT status, count(*) n FROM queue_ticket WHERE clinic_id = p_clinic AND visit_date = current_date GROUP BY 1) s),
    'today_patients', (SELECT count(*) FROM queue_ticket WHERE clinic_id = p_clinic AND visit_date = current_date AND status <> 'CANCELLED'),
    'emergency_today', (SELECT count(*) FROM queue_ticket WHERE clinic_id = p_clinic AND visit_date = current_date AND priority = 'EMERGENCY'),
    'avg_wait_min', (SELECT round(avg(extract(epoch FROM coalesce(consult_start_at, now()) - registered_at) / 60), 0)
                       FROM queue_ticket WHERE clinic_id = p_clinic AND visit_date = current_date AND status <> 'CANCELLED'),
    'doctors_on_duty', (SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', s.id, 'name', coalesce(s.title_prefix || ' ', '') || s.full_name, 'from', sc.start_time, 'to', sc.end_time)), '[]')
                          FROM staff_schedule sc JOIN medical_staff s ON s.id = sc.staff_id
                         WHERE sc.clinic_id = p_clinic AND sc.weekday = dow AND sc.deleted_at IS NULL AND (sc.valid_to IS NULL OR sc.valid_to >= current_date)),
    'nurses', (SELECT count(*) FROM medical_staff WHERE home_clinic_id = p_clinic AND staff_type IN ('NURSE','MIDWIFE') AND status = 'ACTIVE'),
    'inpatients', (SELECT count(*) FROM inpatient_stay WHERE clinic_id = p_clinic AND status = 'ADMITTED'),
    'beds_available', (SELECT count(*) FROM clinic_bed WHERE clinic_id = p_clinic AND status = 'AVAILABLE' AND deleted_at IS NULL),
    'pending_prescriptions', (SELECT count(*) FROM prescription WHERE clinic_id = p_clinic AND status IN ('SUBMITTED','IN_PREPARATION')),
    'referrals_today', (SELECT count(*) FROM referral WHERE clinic_id = p_clinic AND referral_date = current_date),
    'active_referrals', (SELECT count(*) FROM referral WHERE clinic_id = p_clinic AND status IN ('ISSUED','AT_HOSPITAL','IN_TREATMENT','INPATIENT','FOLLOW_UP')),
    'accidents_today', (SELECT count(*) FROM accident WHERE clinic_id = p_clinic AND occurred_at::date = current_date),
    'low_stock', (SELECT count(*) FROM v_stock_position WHERE org_unit_id = p_clinic AND is_low_stock),
    'expiring_batches', (SELECT count(*) FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id
                          WHERE s.org_unit_id = p_clinic AND s.qty_on_hand > 0 AND b.expiry_date < current_date + 60),
    'ambulance', (SELECT coalesce(jsonb_agg(jsonb_build_object('code', code, 'vehicle_no', vehicle_no, 'status', status)), '[]') FROM ambulance WHERE clinic_id = p_clinic),
    'daily_visits', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', d::date, 'visits', (SELECT count(*) FROM queue_ticket q WHERE q.clinic_id = p_clinic AND q.visit_date = d::date AND q.status <> 'CANCELLED')) ORDER BY d), '[]')
                       FROM generate_series(current_date - 13, current_date, interval '1 day') d)
  ) INTO r;
  RETURN r;
END $$;

-- ---------------------------------------------------------------------------
-- ALERT ENGINE (scheduled job; runs as owner for all tenants)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION analytics.raise_alert(p_tenant uuid, p_unit uuid, p_type text, p_module text, p_severity text,
                                                 p_title text, p_message text, p_metric jsonb, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; v_old text;
BEGIN
  SELECT id, severity INTO v_id, v_old FROM health_alert WHERE tenant_id = p_tenant AND dedupe_key = p_key AND status IN ('OPEN','ACKNOWLEDGED');
  IF v_id IS NOT NULL THEN
    -- refresh the numbers; escalate severity if it got worse
    UPDATE health_alert SET message = p_message, metric = p_metric, title = p_title,
           severity = CASE WHEN array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'], p_severity) > array_position(ARRAY['LOW','MEDIUM','HIGH','CRITICAL'], severity)
                           THEN p_severity ELSE severity END
     WHERE id = v_id AND (message IS DISTINCT FROM p_message OR severity <> p_severity);
    RETURN false;
  END IF;
  INSERT INTO health_alert (tenant_id, org_unit_id, alert_type, module, severity, title, message, metric, dedupe_key)
  VALUES (p_tenant, p_unit, p_type, p_module, p_severity, p_title, p_message, p_metric, p_key) RETURNING id INTO v_id;
  PERFORM app.notify_scope(p_tenant, p_unit,
    CASE WHEN p_type IN ('LOW_STOCK','NEAR_EXPIRY','EXPIRED') THEN ARRAY['CLINIC_MANAGER','PHARMACIST']
         WHEN p_type IN ('MCU_OVERDUE','OCCUPATIONAL_DISEASE') THEN ARRAY['HSE_MANAGER','HR_MANAGER','MEDICAL_DIRECTOR','MEDICAL_MANAGER','ESTATE_MANAGER']
         WHEN p_type = 'ACCIDENT_SPIKE' THEN ARRAY['HSE_MANAGER','ESTATE_MANAGER','CORPORATE_MGMT']
         ELSE ARRAY['MEDICAL_DIRECTOR','MEDICAL_MANAGER','ESTATE_MANAGER','CLINIC_MANAGER','CORPORATE_MGMT'] END,
    CASE WHEN p_type = 'LOW_STOCK' THEN 'LOW_STOCK' WHEN p_type IN ('NEAR_EXPIRY','EXPIRED') THEN 'MEDICINE_EXPIRY'
         WHEN p_type = 'MCU_OVERDUE' THEN 'MCU_DUE' ELSE 'ALERT' END,
    p_severity, p_title, p_message, 'health_alert', v_id, '/alerts');
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION analytics.run_alert_engine() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; raised int := 0; resolved int := 0; reminders int := 0; n int; s jsonb; thr numeric;
BEGIN
  -- 1. Disease spike per estate (14 d vs previous 14 d, ≥10 cases, +threshold%, Poisson z ≥ 2.5)
  FOR r IN
    SELECT x.*, (x.cur - x.prev) * 100.0 / greatest(x.prev, 1) AS pct, (x.cur - x.prev) / sqrt(x.prev + 1.0) AS z
      FROM (SELECT e.tenant_id, est.id AS unit, est.name AS unit_name, d.icd10_code AS icd, coalesce(i.title_id, i.title_en) AS title,
                   count(*) FILTER (WHERE e.started_at >= now() - interval '14 days') AS cur,
                   count(*) FILTER (WHERE e.started_at <  now() - interval '14 days') AS prev
              FROM encounter e JOIN diagnosis d ON d.encounter_id = e.id AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL
              JOIN icd10_code i ON i.code = d.icd10_code JOIN org_unit c ON c.id = e.clinic_id
              JOIN org_unit est ON est.path @> c.path AND est.unit_type = 'ESTATE'
             WHERE e.started_at >= now() - interval '28 days' AND e.deleted_at IS NULL
             GROUP BY 1, 2, 3, 4, 5) x
  LOOP
    SELECT coalesce((settings #>> '{alert,disease_spike_pct}')::numeric, 30) INTO thr FROM tenant WHERE id = r.tenant_id;
    CONTINUE WHEN r.cur < 10 OR r.pct < thr OR r.z < 2.5;
    IF analytics.raise_alert(r.tenant_id, r.unit, 'DISEASE_SPIKE', 'DASHBOARD',
         CASE WHEN r.z >= 4 THEN 'CRITICAL' WHEN r.z >= 3 THEN 'HIGH' ELSE 'MEDIUM' END,
         'Kasus ' || r.title || ' meningkat di ' || r.unit_name,
         'ALERT: Kasus ' || r.title || ' ' || r.unit_name || ' meningkat ' || round(r.pct) || '% dalam 14 hari (' || r.cur || ' vs ' || r.prev || ' kasus).',
         jsonb_build_object('icd10', r.icd, 'current', r.cur, 'previous', r.prev, 'change_pct', round(r.pct, 1), 'z_score', round(r.z, 2), 'window_days', 14),
         'DISEASE_SPIKE:' || r.unit || ':' || r.icd) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 2. Occupational disease rising in a risk group (30 d vs previous 30 d)
  FOR r IN
    SELECT e.tenant_id, g.id AS unit, rc.code, rc.name, string_agg(DISTINCT d.icd10_code, ',') AS codes,
           count(*) FILTER (WHERE e.started_at >= now() - interval '30 days') AS cur,
           count(*) FILTER (WHERE e.started_at < now() - interval '30 days') AS prev
      FROM encounter e JOIN diagnosis d ON d.encounter_id = e.id AND d.is_occupational AND d.deleted_at IS NULL
      JOIN patient p ON p.id = e.patient_id JOIN employee em ON em.id = p.employee_id
      JOIN risk_category rc ON rc.id = em.risk_category_id
      JOIN org_unit g ON g.tenant_id = e.tenant_id AND g.unit_type = 'GROUP'
     WHERE e.started_at >= now() - interval '60 days' AND d.icd10_code NOT LIKE 'S%' AND d.icd10_code NOT LIKE 'T1%'
     GROUP BY 1, 2, 3, 4
  LOOP
    CONTINUE WHEN r.cur < 5 OR r.cur <= 1.3 * greatest(r.prev, 1);
    IF analytics.raise_alert(r.tenant_id, r.unit, 'OCCUPATIONAL_DISEASE', 'OCC_HEALTH', CASE WHEN r.cur >= 2 * greatest(r.prev, 1) THEN 'HIGH' ELSE 'MEDIUM' END,
         'Penyakit akibat kerja meningkat pada pekerja ' || r.name,
         'ALERT: Kasus penyakit akibat kerja (' || r.codes || ') pada pekerja ' || r.name || ' meningkat: ' || r.cur || ' kasus dalam 30 hari vs ' || r.prev || ' pada 30 hari sebelumnya.',
         jsonb_build_object('risk', r.code, 'current', r.cur, 'previous', r.prev, 'icd10', r.codes), 'OCC:' || r.tenant_id || ':' || r.code) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 3. Accident spike per estate (30 d vs previous 30 d)
  FOR r IN
    SELECT a.tenant_id, a.estate_id AS unit, est.name AS unit_name,
           count(*) FILTER (WHERE a.occurred_at >= now() - interval '30 days') AS cur,
           count(*) FILTER (WHERE a.occurred_at < now() - interval '30 days') AS prev
      FROM accident a JOIN org_unit est ON est.id = a.estate_id
     WHERE a.occurred_at >= now() - interval '60 days' AND a.incident_type <> 'NEAR_MISS' AND a.status <> 'CANCELLED'
     GROUP BY 1, 2, 3
  LOOP
    CONTINUE WHEN r.cur < 5 OR r.cur < 1.5 * greatest(r.prev, 1);
    IF analytics.raise_alert(r.tenant_id, r.unit, 'ACCIDENT_SPIKE', 'ACCIDENT', 'HIGH', 'Kecelakaan kerja meningkat di ' || r.unit_name,
         'ALERT: ' || r.cur || ' kecelakaan kerja di ' || r.unit_name || ' dalam 30 hari (sebelumnya ' || r.prev || ').',
         jsonb_build_object('current', r.cur, 'previous', r.prev), 'ACC_SPIKE:' || r.unit) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 4. Low stock per clinic & medicine
  FOR r IN
    SELECT sp.tenant_id, sp.org_unit_id AS unit, u.name AS unit_name, m.id AS med, m.name AS med_name, m.unit AS uom, coalesce(sp.qty_usable, 0) AS qty, sp.min_qty
      FROM v_stock_position sp JOIN medicine m ON m.id = sp.medicine_id JOIN org_unit u ON u.id = sp.org_unit_id
     WHERE sp.is_low_stock AND u.unit_type IN ('CLINIC','WAREHOUSE')
  LOOP
    IF analytics.raise_alert(r.tenant_id, r.unit, 'LOW_STOCK', 'INVENTORY',
         CASE WHEN r.qty = 0 THEN 'CRITICAL' WHEN r.qty < r.min_qty * 0.5 THEN 'HIGH' ELSE 'MEDIUM' END,
         r.med_name || ' di bawah stok minimum',
         'ALERT: ' || r.med_name || ' stock di bawah minimum di ' || r.unit_name || ' (' || r.qty || ' / min ' || r.min_qty || ' ' || r.uom || ').',
         jsonb_build_object('medicine_id', r.med, 'qty', r.qty, 'min', r.min_qty), 'LOW_STOCK:' || r.unit || ':' || r.med) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 5. Near-expiry (≤ near_expiry_days) and expired stock per site
  FOR r IN
    SELECT s.tenant_id, s.org_unit_id AS unit, u.name AS unit_name, k.kind, count(*) AS batches, count(DISTINCT s.medicine_id) AS meds, sum(s.qty_on_hand) AS qty
      FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id JOIN org_unit u ON u.id = s.org_unit_id
      JOIN tenant t ON t.id = s.tenant_id
      CROSS JOIN LATERAL (SELECT CASE WHEN b.expiry_date < current_date THEN 'EXPIRED' ELSE 'NEAR_EXPIRY' END AS kind) k
     WHERE s.qty_on_hand > 0 AND b.expiry_date < current_date + coalesce((t.settings #>> '{alert,near_expiry_days}')::int, 60)
     GROUP BY 1, 2, 3, 4
  LOOP
    IF analytics.raise_alert(r.tenant_id, r.unit, r.kind, 'INVENTORY', CASE WHEN r.kind = 'EXPIRED' THEN 'HIGH' ELSE 'MEDIUM' END,
         CASE WHEN r.kind = 'EXPIRED' THEN r.batches || ' batch obat kedaluwarsa di ' || r.unit_name ELSE r.meds || ' obat akan expired di ' || r.unit_name END,
         CASE WHEN r.kind = 'EXPIRED' THEN 'ALERT: ' || r.batches || ' batch obat sudah kedaluwarsa dan harus dikarantina di ' || r.unit_name || '.'
              ELSE 'ALERT: ' || r.meds || ' medicines akan expired dalam 60 hari di ' || r.unit_name || '.' END,
         jsonb_build_object('batches', r.batches, 'medicines', r.meds, 'qty', r.qty), r.kind || ':' || r.unit) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 6. MCU overdue per estate
  FOR r IN
    SELECT h.tenant_id, h.estate_id AS unit, est.name AS unit_name, count(*) AS n
      FROM v_employee_health_status h JOIN org_unit est ON est.id = h.estate_id
     WHERE h.mcu_compliance IN ('OVERDUE')
     GROUP BY 1, 2, 3
  LOOP
    IF analytics.raise_alert(r.tenant_id, r.unit, 'MCU_OVERDUE', 'OCC_HEALTH', CASE WHEN r.n > 10 THEN 'HIGH' ELSE 'MEDIUM' END,
         r.n || ' karyawan terlambat MCU di ' || r.unit_name, 'ALERT: ' || r.n || ' karyawan di ' || r.unit_name || ' melewati jadwal MCU berkala.',
         jsonb_build_object('overdue', r.n), 'MCU_OVERDUE:' || r.unit) THEN raised := raised + 1; END IF;
  END LOOP;

  -- 7. Auto-resolve inventory / MCU alerts whose condition has cleared
  UPDATE health_alert a SET status = 'RESOLVED', resolved_at = now()
   WHERE a.status IN ('OPEN','ACKNOWLEDGED') AND (
         (a.alert_type = 'LOW_STOCK' AND NOT EXISTS (SELECT 1 FROM v_stock_position sp WHERE sp.org_unit_id = a.org_unit_id
                                                       AND sp.medicine_id = (a.metric ->> 'medicine_id')::uuid AND sp.is_low_stock))
      OR (a.alert_type IN ('NEAR_EXPIRY','EXPIRED') AND NOT EXISTS (SELECT 1 FROM inventory_stock s JOIN medicine_batch b ON b.id = s.batch_id
                                                       WHERE s.org_unit_id = a.org_unit_id AND s.qty_on_hand > 0
                                                         AND CASE a.alert_type WHEN 'EXPIRED' THEN b.expiry_date < current_date ELSE b.expiry_date BETWEEN current_date AND current_date + 60 END))
      OR (a.alert_type = 'MCU_OVERDUE' AND NOT EXISTS (SELECT 1 FROM v_employee_health_status h WHERE h.estate_id = a.org_unit_id AND h.mcu_compliance = 'OVERDUE'))
      OR (a.alert_type IN ('DISEASE_SPIKE','ACCIDENT_SPIKE','OCCUPATIONAL_DISEASE') AND a.detected_at < now() - interval '21 days'));
  GET DIAGNOSTICS resolved = ROW_COUNT;

  -- 8. Follow-up reminders (tomorrow) to the treating doctor
  INSERT INTO notification (tenant_id, recipient_id, category, severity, title, body, entity_type, entity_id, action_url)
  SELECT e.tenant_id, s.user_id, 'FOLLOW_UP', 'LOW', 'Kontrol besok: ' || p.full_name, 'Jadwal kontrol pasien ' || p.mrn || ' pada ' || e.follow_up_date,
         'encounter', e.id, '/emr/' || e.id
    FROM encounter e JOIN medical_staff s ON s.id = e.doctor_id AND s.user_id IS NOT NULL JOIN patient p ON p.id = e.patient_id
   WHERE e.follow_up_date = current_date + 1
     AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.entity_id = e.id AND n.category = 'FOLLOW_UP');
  GET DIAGNOSTICS n = ROW_COUNT; reminders := reminders + n;

  -- 9. MCU due within 14 days → HR officers of the employee's estate
  FOR r IN SELECT m.* FROM mcu m WHERE m.status IN ('PLANNED','SCHEDULED') AND coalesce(m.scheduled_date, m.due_date) BETWEEN current_date AND current_date + 14
             AND NOT EXISTS (SELECT 1 FROM notification n WHERE n.entity_id = m.id AND n.category = 'MCU_DUE')
  LOOP
    n := app.notify_scope(r.tenant_id, r.employee_unit_id, ARRAY['HR_OFFICER'], 'MCU_DUE', 'LOW', 'MCU jatuh tempo ' || r.mcu_no,
                          'Jadwal ' || r.mcu_type || ' tanggal ' || coalesce(r.scheduled_date, r.due_date), 'mcu', r.id, '/occ-health');
    reminders := reminders + n;
  END LOOP;

  RETURN jsonb_build_object('raised', raised, 'resolved', resolved, 'reminders', reminders, 'ran_at', now());
END $$;

REVOKE EXECUTE ON FUNCTION analytics.run_alert_engine(), analytics.raise_alert(uuid, uuid, text, text, text, text, text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics.kpi_summary(uuid, date, date), analytics.trend(uuid, date, date, text, text),
  analytics.top_diseases(uuid, date, date, int, text), analytics.breakdown(uuid, date, date), analytics.drilldown(uuid, date, date),
  analytics.cost_breakdown(uuid, date, date, text, int), analytics.medicine_consumption(uuid, date, date, int),
  analytics.accident_stats(uuid, date, date), analytics.occupational_health(uuid), analytics.clinic_performance(uuid, date, date),
  analytics.clinic_today(uuid), analytics.scope(uuid), analytics.suppress(bigint, uuid) TO pcms_app;
