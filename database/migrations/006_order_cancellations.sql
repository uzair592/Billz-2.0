BEGIN;

-- One durable cancellation record per restaurant order. The unique order
-- constraint is the database-level guarantee that stock can never be reversed
-- twice for the same bill, even if the request is replayed.
CREATE TABLE order_cancellations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  reason text,
  cancelled_by_user_id uuid,
  cancelled_at timestamptz NOT NULL,
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
  restocked jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, order_id),
  UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, cancelled_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(restocked) = 'array')
);

CREATE INDEX order_cancellations_branch_time_idx
  ON order_cancellations (restaurant_id, branch_id, cancelled_at DESC);

ALTER TABLE order_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_cancellations FORCE ROW LEVEL SECURITY;

CREATE POLICY order_cancellations_tenant_isolation ON order_cancellations
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- Deterministic reversal keys make a retried cancellation a no-op instead of a
-- second stock movement. Every reversal key is derived from the order and the
-- stock item, so an identical retry collides on the existing unique index.
CREATE UNIQUE INDEX stock_movements_sale_reversal_key_idx
  ON stock_movements (restaurant_id, order_id, stock_item_id)
  WHERE movement_type = 'sale_reversal';

COMMIT;
