-- =============================================================================
-- 0014 · Small-cell suppression for disease trends
-- -----------------------------------------------------------------------------
-- analytics.trend('disease:<ICD>') previously returned exact weekly counts to
-- any DASHBOARD reader. For viewers without EMR:READ on the unit, bucket
-- counts of 1–4 are now returned as NULL (same rule as top_diseases), so rare
-- diagnoses in small estates cannot be traced back to individual workers.
-- Also excludes soft-deleted (ruled-out) diagnoses from the series.
-- =============================================================================

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
     WHERE icd IS NOT NULL AND d.icd10_code = icd AND d.diagnosis_type = 'PRIMARY' AND d.deleted_at IS NULL AND c.path <@ sp AND e.started_at::date BETWEEN p_from AND p_to
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
  SELECT bu.bk,
         CASE WHEN icd IS NULL OR coalesce(sum(d.v), 0) = 0 THEN coalesce(sum(d.v), 0)
              ELSE analytics.suppress(sum(d.v)::bigint, p_unit)::numeric END
    FROM buckets bu LEFT JOIN data d ON d.bk = bu.bk GROUP BY bu.bk ORDER BY bu.bk;
END $$;
