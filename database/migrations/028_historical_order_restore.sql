BEGIN;
ALTER TABLE orders ADD COLUMN restore_key text;
ALTER TABLE orders ADD COLUMN restore_hash text;
ALTER TABLE orders ADD COLUMN restore_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(restore_metadata)='object');
CREATE UNIQUE INDEX orders_restore_key_unique ON orders (restaurant_id, restore_key) WHERE restore_key IS NOT NULL;
COMMIT;
