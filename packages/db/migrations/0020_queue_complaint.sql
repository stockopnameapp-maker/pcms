-- The complaint typed at registration was accepted by the API but never stored. Keep it on the ticket so the
-- queue board and the triage form can show it before an encounter exists.
ALTER TABLE queue_ticket ADD COLUMN IF NOT EXISTS complaint text CHECK (complaint IS NULL OR length(complaint) <= 500);
