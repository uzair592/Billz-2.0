BEGIN;

ALTER TABLE orders ADD COLUMN idempotency_key uuid;
UPDATE orders SET idempotency_key = gen_random_uuid() WHERE idempotency_key IS NULL;
ALTER TABLE orders ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_restaurant_idempotency_unique
  UNIQUE (restaurant_id, idempotency_key);

CREATE TABLE order_sequences (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (restaurant_id, branch_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT
);

INSERT INTO order_sequences (restaurant_id, branch_id, next_number)
SELECT b.restaurant_id, b.id, COALESCE(MAX(o.order_number), 0) + 1
  FROM branches b
  LEFT JOIN orders o
    ON o.restaurant_id = b.restaurant_id
   AND o.branch_id = b.id
 GROUP BY b.restaurant_id, b.id;

ALTER TABLE order_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY order_sequences_tenant_isolation ON order_sequences
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
