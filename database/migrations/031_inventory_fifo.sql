-- 013_inventory_fifo.sql
-- FIFO costing layer for inventory_items domain.
--
-- This migration adds two tables:
--   inventory_fifo_batches    – one row per received purchase-line cost layer
--   inventory_fifo_allocations – one row per FIFO batch slice consumed by an order
-- and seeds opening batches from the existing average_cost_minor balance.
--
-- Dependencies: 012_inventory_purchasing.sql (inventory_items, purchase_items,
--   inventory_movements, inventory_consumptions, current_restaurant_id())

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- FIFO cost batches
-- One row per received purchase line. "remaining_quantity_base_units" decreases
-- as stock is sold; it never goes below 0 on a real batch (deficits are tracked
-- separately in inventory_fifo_deficits).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_fifo_batches (
  id                        uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id             uuid          NOT NULL,
  inventory_item_id         uuid          NOT NULL,
  -- The originating purchase and line (NULL for migration/opening batches).
  purchase_id               uuid,
  purchase_item_id          uuid,
  -- Quantities in the item's base_unit.
  original_quantity         numeric(18,4) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity        numeric(18,4) NOT NULL CHECK (remaining_quantity >= 0),
  -- Cost in integer minor units per base unit (e.g. paise, fils, cents).
  unit_cost_minor           bigint        NOT NULL CHECK (unit_cost_minor >= 0),
  -- Effective receipt time used for FIFO ordering (oldest first).
  -- For real purchases this is the received_at timestamp of the purchase.
  -- For migration batches it is the time this migration ran.
  effective_receipt_at      timestamptz   NOT NULL,
  -- Human-readable reference (invoice number, "opening stock", etc.)
  batch_ref                 text,
  -- "purchase" | "opening_stock" | "wac_migration" | "manual_adjustment"
  batch_origin              text          NOT NULL DEFAULT 'purchase'
    CHECK (batch_origin IN ('purchase', 'opening_stock', 'wac_migration', 'manual_adjustment', 'return')),
  created_at                timestamptz   NOT NULL DEFAULT now(),
  -- Tenant composite FK – prevents cross-restaurant batch access.
  CONSTRAINT inventory_fifo_batches_restaurant_unique  UNIQUE (restaurant_id, id),
  CONSTRAINT inventory_fifo_batches_purchase_item_unique
    UNIQUE (restaurant_id, purchase_item_id),
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, purchase_id)
    REFERENCES purchases(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, purchase_item_id)
    REFERENCES purchase_items(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (remaining_quantity <= original_quantity),
  CHECK (purchase_item_id IS NULL OR batch_origin = 'purchase')
);

-- The critical query: select oldest available batches for a specific item.
CREATE INDEX inventory_fifo_batches_fifo_idx
  ON inventory_fifo_batches (restaurant_id, inventory_item_id, effective_receipt_at, id)
  WHERE remaining_quantity > 0;

CREATE INDEX inventory_fifo_batches_item_idx
  ON inventory_fifo_batches (restaurant_id, inventory_item_id, created_at DESC, id DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- FIFO allocations (immutable)
-- One row per batch slice consumed by a specific order.
-- Together they represent the full FIFO COGS for the order.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_fifo_allocations (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid          NOT NULL,
  batch_id            uuid          NOT NULL,
  order_id            uuid          NOT NULL,
  inventory_item_id   uuid          NOT NULL,
  -- Quantity consumed from this batch for this order.
  allocated_quantity  numeric(18,4) NOT NULL CHECK (allocated_quantity > 0),
  -- Snapshot of the batch's unit cost at allocation time (immutable).
  unit_cost_minor     bigint        NOT NULL CHECK (unit_cost_minor >= 0),
  -- line_total = round(allocated_quantity * unit_cost_minor)
  total_cost_minor    bigint        NOT NULL CHECK (total_cost_minor >= 0),
  -- "sale" | "sale_reversal" (cancellation puts back the quantity)
  allocation_type     text          NOT NULL DEFAULT 'sale'
    CHECK (allocation_type IN ('sale', 'sale_reversal')),
  -- Links a reversal back to the original allocation it negates.
  original_allocation_id uuid,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT inventory_fifo_allocations_restaurant_unique UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, batch_id)
    REFERENCES inventory_fifo_batches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, original_allocation_id)
    REFERENCES inventory_fifo_allocations(restaurant_id, id) ON DELETE RESTRICT
);

-- Exactly-once guard: one sale allocation per (order, batch) pair.
-- Reversals are allowed once per original allocation.
CREATE UNIQUE INDEX inventory_fifo_allocations_order_batch_sale_idx
  ON inventory_fifo_allocations (restaurant_id, order_id, batch_id)
  WHERE allocation_type = 'sale';

CREATE UNIQUE INDEX inventory_fifo_allocations_reversal_idx
  ON inventory_fifo_allocations (restaurant_id, original_allocation_id)
  WHERE allocation_type = 'sale_reversal';

CREATE INDEX inventory_fifo_allocations_order_idx
  ON inventory_fifo_allocations (restaurant_id, order_id);

CREATE INDEX inventory_fifo_allocations_batch_idx
  ON inventory_fifo_allocations (restaurant_id, batch_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- FIFO deficits (provisional negative stock tracking)
-- When FIFO batches are exhausted but the business still needs to record the
-- sale, a deficit row is created. It is reconciled when the next purchase
-- arrives.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE inventory_fifo_deficits (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       uuid          NOT NULL,
  inventory_item_id   uuid          NOT NULL,
  order_id            uuid          NOT NULL,
  deficit_quantity    numeric(18,4) NOT NULL CHECK (deficit_quantity > 0),
  -- Resolved when a subsequent purchase batch is linked.
  resolved_batch_id   uuid,
  resolved_at         timestamptz,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT inventory_fifo_deficits_restaurant_unique UNIQUE (restaurant_id, id),
  -- One deficit per order/item pair.
  CONSTRAINT inventory_fifo_deficits_order_item_unique UNIQUE (restaurant_id, order_id, inventory_item_id),
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, resolved_batch_id)
    REFERENCES inventory_fifo_batches(restaurant_id, id) ON DELETE RESTRICT
);

CREATE INDEX inventory_fifo_deficits_item_unresolved_idx
  ON inventory_fifo_deficits (restaurant_id, inventory_item_id)
  WHERE resolved_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed opening FIFO batches from existing inventory_items balances.
-- One batch per item with positive current_quantity, using the existing
-- average_cost_minor as the opening unit cost.
-- Negative-balance items are intentionally excluded: they represent genuine
-- deficits and should NOT receive a fabricated batch.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO inventory_fifo_batches (
  restaurant_id,
  inventory_item_id,
  purchase_id,
  purchase_item_id,
  original_quantity,
  remaining_quantity,
  unit_cost_minor,
  effective_receipt_at,
  batch_ref,
  batch_origin
)
SELECT
  restaurant_id,
  id AS inventory_item_id,
  NULL,                          -- no originating purchase
  NULL,                          -- no originating purchase line
  current_quantity,              -- full balance becomes the opening batch
  current_quantity,              -- all of it is still on hand
  average_cost_minor,            -- WAC becomes the opening unit cost
  COALESCE(created_at, now()),   -- use item creation time as receipt time
  'Opening balance (WAC migration)',
  'wac_migration'
FROM inventory_items
WHERE current_quantity > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE inventory_fifo_batches     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_fifo_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_fifo_deficits    ENABLE ROW LEVEL SECURITY;

ALTER TABLE inventory_fifo_batches     FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_fifo_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_fifo_deficits    FORCE ROW LEVEL SECURITY;

CREATE POLICY inventory_fifo_batches_tenant_isolation ON inventory_fifo_batches
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

CREATE POLICY inventory_fifo_allocations_tenant_isolation ON inventory_fifo_allocations
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

CREATE POLICY inventory_fifo_deficits_tenant_isolation ON inventory_fifo_deficits
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

-- ─────────────────────────────────────────────────────────────────────────────
-- Make FIFO allocations and deficits append-only (no UPDATE or DELETE).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_fifo_allocations_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_fifo_allocations is append-only: record a reversal row instead';
END;
$$;

CREATE TRIGGER inventory_fifo_allocations_no_update
  BEFORE UPDATE ON inventory_fifo_allocations
  FOR EACH ROW EXECUTE FUNCTION inventory_fifo_allocations_immutable();

CREATE TRIGGER inventory_fifo_allocations_no_delete
  BEFORE DELETE ON inventory_fifo_allocations
  FOR EACH ROW EXECUTE FUNCTION inventory_fifo_allocations_immutable();

COMMIT;
