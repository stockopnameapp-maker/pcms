-- =============================================================================
-- 0016 · Event notifications: per-table branches + working deep links
-- -----------------------------------------------------------------------------
-- Found by the API integration tests: app.tg_notify_events() evaluated
-- "TG_TABLE_NAME = 'sick_leave' AND NEW.employee_unit_id …" while firing on
-- accident updates. PL/pgSQL resolves record fields regardless of the earlier
-- operands, so every accident status change failed with 42703. The function now
-- branches on the table first. Deep links point at routes the web app serves.
-- =============================================================================

CREATE OR REPLACE FUNCTION app.tg_notify_events() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_unit text;
BEGIN
  IF app.current_user_id() IS NULL THEN RETURN NULL; END IF;

  CASE TG_TABLE_NAME
  WHEN 'accident' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT name INTO v_unit FROM org_unit WHERE id = NEW.org_unit_id;
      PERFORM app.notify_scope(NEW.tenant_id, NEW.org_unit_id, ARRAY['HSE_MANAGER','HSE_OFFICER','ESTATE_MANAGER'], 'ACCIDENT',
              CASE NEW.severity WHEN 'MINOR' THEN 'MEDIUM' WHEN 'MODERATE' THEN 'HIGH' ELSE 'CRITICAL' END,
              'Kecelakaan kerja baru ' || NEW.incident_no, 'Severity ' || NEW.severity || ' di ' || v_unit || ' — ' || NEW.victim_name,
              'accident', NEW.id, '/r/accidents?id=' || NEW.id);
      IF NEW.clinic_id IS NOT NULL AND NEW.severity IN ('SERIOUS','MAJOR','FATAL') THEN
        PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR','NURSE','CLINIC_MANAGER'], 'EMERGENCY', 'CRITICAL',
                'DARURAT: kecelakaan ' || NEW.severity, NEW.victim_name || ' — ' || v_unit, 'accident', NEW.id, '/r/accidents?id=' || NEW.id);
      END IF;
    ELSIF NEW.status = 'PENDING_APPROVAL' AND OLD.status IS DISTINCT FROM 'PENDING_APPROVAL' THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.org_unit_id, ARRAY['HSE_MANAGER','ESTATE_MANAGER'], 'APPROVAL_REQUEST', 'MEDIUM',
              'Persetujuan investigasi ' || NEW.incident_no, 'Hasil investigasi menunggu persetujuan', 'accident', NEW.id, '/r/accidents?id=' || NEW.id);
    END IF;

  WHEN 'queue_ticket' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.priority = 'EMERGENCY' THEN
        PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR','NURSE'], 'EMERGENCY', 'CRITICAL',
                'Pasien gawat darurat ' || NEW.queue_code, 'Segera ke ruang tindakan', 'queue_ticket', NEW.id, '/queue');
      ELSE
        PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['DOCTOR'], 'NEW_PATIENT', 'LOW',
                'Pasien baru ' || NEW.queue_code, 'Pasien terdaftar di antrian', 'queue_ticket', NEW.id, '/queue');
      END IF;
    END IF;

  WHEN 'referral' THEN
    IF TG_OP = 'INSERT' AND NEW.status = 'ISSUED' THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.clinic_id, ARRAY['MEDICAL_MANAGER','CLINIC_MANAGER'], 'REFERRAL',
              CASE NEW.urgency WHEN 'EMERGENCY' THEN 'CRITICAL' WHEN 'URGENT' THEN 'HIGH' ELSE 'LOW' END,
              'Rujukan baru ' || NEW.referral_no, 'Urgensi ' || NEW.urgency, 'referral', NEW.id, '/r/referrals?id=' || NEW.id);
    END IF;

  WHEN 'stock_transfer' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT name INTO v_unit FROM org_unit WHERE id = NEW.to_unit_id;
      PERFORM app.notify_scope(NEW.tenant_id, NEW.from_unit_id, ARRAY['PHARMACIST','CLINIC_MANAGER'], 'APPROVAL_REQUEST',
              CASE NEW.priority WHEN 'URGENT' THEN 'HIGH' ELSE 'MEDIUM' END,
              'Permintaan transfer ' || NEW.transfer_no, 'Permintaan obat dari ' || v_unit, 'stock_transfer', NEW.id, '/pharmacy/transfers/' || NEW.id);
    ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('APPROVED','REJECTED','IN_TRANSIT') THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.to_unit_id, ARRAY['PHARMACIST','CLINIC_MANAGER'], 'APPROVAL_REQUEST', 'LOW',
              'Transfer ' || NEW.transfer_no || ': ' || NEW.status, coalesce(NEW.reject_reason, 'Status permintaan obat diperbarui'),
              'stock_transfer', NEW.id, '/pharmacy/transfers/' || NEW.id);
    END IF;

  WHEN 'sick_leave' THEN
    IF TG_OP = 'INSERT' AND NEW.employee_unit_id IS NOT NULL THEN
      PERFORM app.notify_scope(NEW.tenant_id, NEW.employee_unit_id, ARRAY['HR_OFFICER','HR_MANAGER'], 'FOLLOW_UP', 'LOW',
              'Surat sakit ' || NEW.certificate_no, NEW.days || ' hari (' || NEW.start_date || ' s/d ' || NEW.end_date || ')',
              'sick_leave', NEW.id, '/r/sick-leaves?id=' || NEW.id);
    END IF;
  ELSE
    NULL;
  END CASE;
  RETURN NULL;
END $$;

-- existing rows created before this fix: repoint old links to real routes
UPDATE notification SET action_url = regexp_replace(action_url, '^/accidents/(.+)$', '/r/accidents?id=\1') WHERE action_url LIKE '/accidents/%';
UPDATE notification SET action_url = regexp_replace(action_url, '^/referrals/(.+)$', '/r/referrals?id=\1') WHERE action_url LIKE '/referrals/%';
UPDATE notification SET action_url = '/pharmacy/transfers/' || entity_id WHERE action_url = '/pharmacy/transfers' AND entity_id IS NOT NULL;
UPDATE notification SET action_url = '/r/sick-leaves?id=' || entity_id WHERE action_url = '/sick-leave' AND entity_id IS NOT NULL;
