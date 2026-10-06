BEGIN;

-- Milestone 14: inventory, recipes, suppliers, and purchasing.
--
-- Naming note: the milestone spec's `stock_movements` ledger name is
-- already taken by migration 002 for the *legacy* imported-stock
-- domain (branch-scoped, keyed to legacy `stock_items`, with a
-- different movement-type vocabulary). The new restaurant-scoped
-- ledger for the `inventory_items` domain is therefore named
-- `inventory_movements`. All other spec table names are free and
-- used as-is. The legacy tables are untouched.

-- A role suggested by the milestone spec: suppliers, purchases, and
-- inventory viewing. The replacement list is a strict superset of the
-- original one, so every existing membership row stays valid.
ALTER TABLE restaurant_memberships DROP CONSTRAINT IF EXISTS restaurant_memberships_role_check;
ALTER TABLE restaurant_memberships ADD CONSTRAINT restaurant_memberships_role_check
  CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'kitchen', 'accountant'));

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  contact_person text,
  phone text,
  email text,
  address text,
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_restaurant_id_unique UNIQUE (restaurant_id, id),
  CHECK (contact_person IS NULL OR length(btrim(contact_person)) BETWEEN 1 AND 200),
  CHECK (phone IS NULL OR length(btrim(phone)) BETWEEN 1 AND 40),
  CHECK (email IS NULL OR length(btrim(email)) BETWEEN 1 AND 320),
  CHECK (address IS NULL OR length(btrim(address)) BETWEEN 1 AND 500),
  CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000)
);

-- Duplicate *active* names are prevented within one restaurant; a
-- deactivated supplier's name may be reused by a new active supplier.
CREATE UNIQUE INDEX suppliers_restaurant_active_name_idx
  ON suppliers (restaurant_id, name) WHERE is_active;

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  sku text,
  base_unit text NOT NULL CHECK (base_unit IN ('piece', 'gram', 'kilogram', 'millilitre', 'litre')),
  -- Deliberately no non-negative CHECK: a negative balance is allowed,
  -- warned about, and must never block checkout. Never trust this
  -- column without the movement ledger beside it; every change writes
  -- an inventory_movements row carrying quantity_after.
  current_quantity numeric(18, 4) NOT NULL DEFAULT 0,
  reorder_level numeric(18, 4) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  -- Weighted average cost per base unit, in integer minor units.
  average_cost_minor bigint NOT NULL DEFAULT 0 CHECK (average_cost_minor >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  CONSTRAINT inventory_items_restaurant_id_unique UNIQUE (restaurant_id, id),
  CONSTRAINT inventory_items_restaurant_name_unique UNIQUE (restaurant_id, name),
  CONSTRAINT inventory_items_restaurant_idempotency_unique UNIQUE (restaurant_id, idempotency_key),
  CHECK (sku IS NULL OR length(btrim(sku)) BETWEEN 1 AND 64)
);

-- SKU is unique per restaurant only when present.
CREATE UNIQUE INDEX inventory_items_restaurant_sku_idx
  ON inventory_items (restaurant_id, sku) WHERE sku IS NOT NULL;

CREATE TABLE product_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_required numeric(18, 6) NOT NULL CHECK (quantity_required > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_recipes_restaurant_id_unique UNIQUE (restaurant_id, id),
  -- The same inventory item cannot appear twice in one product recipe.
  CONSTRAINT product_recipes_restaurant_product_item_unique UNIQUE (restaurant_id, product_id, inventory_item_id),
  -- Tenant-consistent composite foreign keys: a recipe can never link
  -- a product or ingredient that belongs to another restaurant.
  FOREIGN KEY (restaurant_id, product_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT
);

-- Per-restaurant purchase numbering, mirroring order_sequences so
-- purchase numbers are generated safely under concurrency.
CREATE TABLE purchase_sequences (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE RESTRICT,
  next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0)
);

CREATE TABLE purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL,
  purchase_number text NOT NULL,
  supplier_invoice_number text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'received', 'cancelled')),
  purchase_date date NOT NULL,
  -- Server-computed figures; a client-sent total is never read.
  subtotal_minor bigint NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  notes text,
  received_at timestamptz,
  idempotency_key uuid NOT NULL,
  receive_idempotency_key uuid,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchases_restaurant_id_unique UNIQUE (restaurant_id, id),
  CONSTRAINT purchases_restaurant_idempotency_unique UNIQUE (restaurant_id, idempotency_key),
  CONSTRAINT purchases_restaurant_receive_idempotency_unique UNIQUE (restaurant_id, receive_idempotency_key),
  CONSTRAINT purchases_restaurant_purchase_number_unique UNIQUE (restaurant_id, purchase_number),
  FOREIGN KEY (restaurant_id, supplier_id)
    REFERENCES suppliers(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (supplier_invoice_number IS NULL OR length(btrim(supplier_invoice_number)) BETWEEN 1 AND 100),
  CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000),
  CHECK (discount_minor <= subtotal_minor),
  -- The authoritative total is always derivable from the components.
  CONSTRAINT purchases_total_check CHECK (total_minor = subtotal_minor - discount_minor + tax_minor),
  -- received_at is present exactly when the purchase is received.
  CHECK (status <> 'received' OR received_at IS NOT NULL),
  CHECK (status = 'received' OR received_at IS NULL)
);

CREATE TABLE purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  purchase_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_items_restaurant_id_unique UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, purchase_id)
    REFERENCES purchases(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT,
  -- The line total is always quantity * unit cost, computed on the
  -- server with the same rounding rule as the database.
  CONSTRAINT purchase_items_line_total_check CHECK (line_total_minor = round(quantity * unit_cost_minor))
);

-- The immutable inventory ledger. Nothing in the application ever
-- updates or deletes a row; corrections are new movements.
-- reference_type/reference_id name the source document (purchase,
-- order, or manual) and are intentionally not a foreign key because
-- one column serves several parents.
CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  inventory_item_id uuid NOT NULL,
  movement_type text NOT NULL
    CHECK (movement_type IN ('purchase_receipt', 'sale_consumption', 'adjustment_increase', 'adjustment_decrease', 'waste')),
  quantity_delta numeric(18, 4) NOT NULL CHECK (quantity_delta <> 0),
  -- Server-computed under a row lock: the balance after this movement,
  -- which makes every deduction auditable without replaying the whole
  -- ledger.
  quantity_after numeric(18, 4) NOT NULL,
  unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
  total_cost_minor bigint CHECK (total_cost_minor IS NULL OR total_cost_minor >= 0),
  reference_type text CHECK (reference_type IS NULL OR reference_type IN ('purchase', 'order', 'manual')),
  reference_id uuid,
  idempotency_key uuid NOT NULL,
  notes text,
  actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_restaurant_id_unique UNIQUE (restaurant_id, id),
  CONSTRAINT inventory_movements_restaurant_idempotency_unique UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, inventory_item_id)
    REFERENCES inventory_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, actor_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (notes IS NULL OR length(btrim(notes)) BETWEEN 1 AND 2000)
);

-- Exactly-once guards at the ledger level: one receipt movement per
-- purchased inventory item and one consumption movement per consumed
-- inventory item, so a replayed or racing request can never apply the
-- same stock movement twice even if application code regresses.
CREATE UNIQUE INDEX inventory_movements_purchase_receipt_key_idx
  ON inventory_movements (restaurant_id, reference_id, inventory_item_id)
  WHERE reference_type = 'purchase';

CREATE UNIQUE INDEX inventory_movements_order_consumption_key_idx
  ON inventory_movements (restaurant_id, reference_id, inventory_item_id)
  WHERE reference_type = 'order';

-- One row per consumed order: the queryable, provable record that an
-- order's inventory was deducted exactly once. Replaying the order
-- creation returns this row's outcome instead of deducting a second
-- time.
CREATE TABLE inventory_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_consumptions_restaurant_id_unique UNIQUE (restaurant_id, id),
  CONSTRAINT inventory_consumptions_restaurant_order_unique UNIQUE (restaurant_id, order_id),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT
);

CREATE INDEX suppliers_restaurant_active_idx
  ON suppliers (restaurant_id, is_active, name);

CREATE INDEX inventory_items_restaurant_name_idx
  ON inventory_items (restaurant_id, name);

CREATE INDEX inventory_items_reorder_idx
  ON inventory_items (restaurant_id, is_active)
  WHERE is_active = true;

CREATE INDEX product_recipes_product_idx
  ON product_recipes (restaurant_id, product_id);

CREATE INDEX purchases_restaurant_time_idx
  ON purchases (restaurant_id, created_at DESC, id DESC);

CREATE INDEX purchase_items_purchase_idx
  ON purchase_items (restaurant_id, purchase_id);

CREATE INDEX inventory_movements_item_time_idx
  ON inventory_movements (restaurant_id, inventory_item_id, created_at DESC, id DESC);

CREATE INDEX inventory_movements_restaurant_time_idx
  ON inventory_movements (restaurant_id, created_at DESC, id DESC);

CREATE TRIGGER suppliers_set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_items_set_updated_at BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER product_recipes_set_updated_at BEFORE UPDATE ON product_recipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchases_set_updated_at BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The inventory ledger is append-only at the database
-- level, not only by convention: a correction is a new
-- movement row, never an edit or a deletion. The
-- application never issues UPDATE or DELETE against the
-- ledger, and this trigger makes that guarantee hold for
-- a direct SQL connection using the application role too.
CREATE FUNCTION inventory_movement_immutable()
  RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION
    'inventory_movements is append-only: record a correcting movement instead of modifying the ledger';
END;
$$;

CREATE TRIGGER inventory_movements_no_update
  BEFORE UPDATE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movement_immutable();
CREATE TRIGGER inventory_movements_no_delete
  BEFORE DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_movement_immutable();

-- Tenant isolation is deliberately repetitive so a newly added table
-- cannot accidentally inherit access from a frontend-supplied resource
-- identifier.
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_consumptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_items FORCE ROW LEVEL SECURITY;
ALTER TABLE product_recipes FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_sequences FORCE ROW LEVEL SECURITY;
ALTER TABLE purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE purchase_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_consumptions FORCE ROW LEVEL SECURITY;

CREATE POLICY suppliers_tenant_isolation ON suppliers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY inventory_items_tenant_isolation ON inventory_items
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY product_recipes_tenant_isolation ON product_recipes
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY purchase_sequences_tenant_isolation ON purchase_sequences
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY purchases_tenant_isolation ON purchases
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY purchase_items_tenant_isolation ON purchase_items
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY inventory_movements_tenant_isolation ON inventory_movements
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY inventory_consumptions_tenant_isolation ON inventory_consumptions
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
