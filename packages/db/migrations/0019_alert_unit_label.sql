-- Clinic and rayon names repeat across PTs (every PT has "Klinik Rayon A"), so alert texts name the PT as well:
-- "Klinik Rayon E (BCPJ)". app.unit_display_name() gives a unit's name plus the code of the PT above it.
CREATE OR REPLACE FUNCTION app.unit_display_name(p_unit uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT u.name || coalesce(' (' || (SELECT c.code FROM org_unit c WHERE c.unit_type = 'COMPANY' AND u.path <@ c.path AND c.id <> u.id
                                     ORDER BY nlevel(c.path) DESC LIMIT 1) || ')', '')
    FROM org_unit u WHERE u.id = p_unit
$$;
REVOKE ALL ON FUNCTION app.unit_display_name(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.unit_display_name(uuid) TO pcms_app;

CREATE OR REPLACE FUNCTION analytics.run_alert_engine() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE r record; raised int := 0; resolved int := 0; reminders int := 0; n int; s jsonb; thr numeric;
BEGIN
  -- 1. Disease spike per estate (14 d vs previous 14 d, ≥10 cases, +threshold%, Poisson z ≥ 2.5)
  FOR r IN
    SELECT x.*, (x.cur - x.prev) * 100.0 / greatest(x.prev, 1) AS pct, (x.cur - x.prev) / sqrt(x.prev + 1.0) AS z
      FROM (SELECT e.tenant_id, est.id AS unit, app.unit_display_name(est.id) AS unit_name, d.icd10_code AS icd, coalesce(i.title_id, i.title_en) AS title,
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
    SELECT a.tenant_id, a.estate_id AS unit, app.unit_display_name(est.id) AS unit_name,
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
    SELECT sp.tenant_id, sp.org_unit_id AS unit, app.unit_display_name(u.id) AS unit_name, m.id AS med, m.name AS med_name, m.unit AS uom, coalesce(sp.qty_usable, 0) AS qty, sp.min_qty
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
    SELECT s.tenant_id, s.org_unit_id AS unit, app.unit_display_name(u.id) AS unit_name, k.kind, count(*) AS batches, count(DISTINCT s.medicine_id) AS meds, sum(s.qty_on_hand) AS qty
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
    SELECT h.tenant_id, h.estate_id AS unit, app.unit_display_name(est.id) AS unit_name, count(*) AS n
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

-- portal: the employee picks a clinic from a list that now spans two PTs with identical clinic names
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
                                                              'birth_date', p.birth_date, 'qr_token', p.qr_token, 'clinic', app.unit_display_name(c.id), 'clinic_id', c.id) ORDER BY p.patient_type), '[]')
                   FROM patient p JOIN org_unit c ON c.id = p.primary_clinic_id WHERE p.id = ANY (ids)),
    'visits', (SELECT coalesce(jsonb_agg(v ORDER BY v.started_at DESC), '[]') FROM (
                 SELECT e.id, e.started_at, p.full_name AS patient, app.unit_display_name(c.id) AS clinic, e.encounter_type,
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
    'appointments', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'scheduled_at', a.scheduled_at, 'clinic', app.unit_display_name(c.id), 'patient', p.full_name,
                                                                  'status', a.status, 'reason', a.reason) ORDER BY a.scheduled_at DESC), '[]')
                       FROM appointment a JOIN org_unit c ON c.id = a.clinic_id JOIN patient p ON p.id = a.patient_id
                      WHERE a.patient_id = ANY (ids) AND a.scheduled_at > now() - interval '60 days'),
    'clinics', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', app.unit_display_name(u.id)) ORDER BY app.unit_display_name(u.id)), '[]')
                  FROM org_unit u JOIN clinic_profile cp ON cp.id = u.id
                 WHERE u.tenant_id = app.current_tenant_id() AND cp.operational_status = 'OPEN' AND u.deleted_at IS NULL))
  INTO res;
  RETURN res;
END $$;
