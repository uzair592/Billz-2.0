BEGIN;
ALTER TABLE expenses ADD COLUMN idempotency_key uuid;
CREATE UNIQUE INDEX expenses_idempotency_idx ON expenses (restaurant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX expenses_business_date_idx ON expenses (restaurant_id, business_date, id);
COMMIT;
