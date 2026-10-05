BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded'));

-- A partial refund marks the individual captured payment it compensated
-- 'partially_refunded'; the replacement list is a strict superset of the
-- original one, so every existing row stays valid.
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_status_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_status_check
  CHECK (status IN ('pending', 'captured', 'voided', 'refunded', 'partially_refunded'));

CREATE TABLE order_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  refund_number text NOT NULL,
  idempotency_key uuid NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'failed')),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 1),
  notes text,
  subtotal_refunded_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_refunded_minor >= 0),
  tax_refunded_minor bigint NOT NULL DEFAULT 0 CHECK (tax_refunded_minor >= 0),
  discount_refunded_minor bigint NOT NULL DEFAULT 0 CHECK (discount_refunded_minor >= 0),
  charge_refunded_minor bigint NOT NULL DEFAULT 0 CHECK (charge_refunded_minor >= 0),
  total_refunded_minor bigint NOT NULL CHECK (total_refunded_minor > 0),
  is_full_refund boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE order_refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  refund_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  restock boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, refund_id)
    REFERENCES order_refunds(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_item_id)
    REFERENCES order_items(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE order_refund_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  refund_id uuid NOT NULL,
  order_payment_id uuid NOT NULL,
  financial_account_id uuid,
  payment_method text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, refund_id)
    REFERENCES order_refunds(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_payment_id)
    REFERENCES order_payments(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, financial_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT
);

CREATE INDEX order_refunds_branch_time_idx
  ON order_refunds (restaurant_id, branch_id, created_at DESC);
CREATE INDEX order_refunds_order_idx
  ON order_refunds (restaurant_id, order_id);
CREATE INDEX order_refund_items_refund_idx
  ON order_refund_items (restaurant_id, refund_id);
CREATE INDEX order_refund_tenders_refund_idx
  ON order_refund_tenders (restaurant_id, refund_id);

CREATE TRIGGER order_refunds_set_updated_at BEFORE UPDATE ON order_refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE order_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE order_refund_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_refund_items FORCE ROW LEVEL SECURITY;
ALTER TABLE order_refund_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_refund_tenders FORCE ROW LEVEL SECURITY;

CREATE POLICY order_refunds_tenant_isolation ON order_refunds
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

CREATE POLICY order_refund_items_tenant_isolation ON order_refund_items
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

CREATE POLICY order_refund_tenders_tenant_isolation ON order_refund_tenders
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
