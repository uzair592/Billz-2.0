BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_hash text;

CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  ticket_number bigint NOT NULL,
  station text NOT NULL DEFAULT 'kitchen',
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'preparing', 'ready', 'served', 'cancelled')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, branch_id, ticket_number),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS kitchen_ticket_sequences (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (restaurant_id, branch_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT
);

INSERT INTO kitchen_ticket_sequences (restaurant_id, branch_id, next_number)
SELECT b.restaurant_id, b.id, 1
  FROM branches b
ON CONFLICT DO NOTHING;

ALTER TABLE kitchen_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_tickets_tenant_isolation ON kitchen_tickets
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

CREATE INDEX IF NOT EXISTS kitchen_tickets_queue_idx
  ON kitchen_tickets (restaurant_id, branch_id, status, created_at)
  WHERE status IN ('new', 'preparing', 'ready');

ALTER TABLE kitchen_ticket_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchen_ticket_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY kitchen_ticket_sequences_tenant_isolation ON kitchen_ticket_sequences
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
