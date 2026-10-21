BEGIN;

-- Retry identities stay on the existing tenant-protected audit records.
ALTER TABLE order_edit_events ADD COLUMN idempotency_key uuid;
ALTER TABLE order_edit_events ADD COLUMN request_hash text;
CREATE UNIQUE INDEX order_edit_events_retry_key
  ON order_edit_events (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
