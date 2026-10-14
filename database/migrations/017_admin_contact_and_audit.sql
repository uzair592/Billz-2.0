BEGIN;

ALTER TABLE restaurants ADD COLUMN contact_email text;
CREATE INDEX audit_logs_created_id_idx ON audit_logs(created_at DESC, id DESC);

COMMIT;
