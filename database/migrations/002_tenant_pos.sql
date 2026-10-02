BEGIN;

CREATE TABLE business_settings (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE RESTRICT,
  default_branch_id uuid NOT NULL,
  business_name text NOT NULL,
  phone text,
  address text,
  slogan text,
  logo_object_key text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, default_branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE receipt_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  paper_width_mm integer NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58, 80)),
  receipt_format text NOT NULL DEFAULT 'table',
  copies text NOT NULL DEFAULT 'customer'
    CHECK (copies IN ('customer', 'kitchen', 'both')),
  auto_cut boolean NOT NULL DEFAULT true,
  cut_mode text NOT NULL DEFAULT 'partial'
    CHECK (cut_mode IN ('partial', 'full')),
  print_layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, branch_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(print_layout) = 'object')
);

CREATE TABLE dining_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, branch_id, id),
  UNIQUE (restaurant_id, branch_id, name),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  dining_area_id uuid,
  table_number text NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, branch_id, id),
  UNIQUE (restaurant_id, branch_id, table_number),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, branch_id, dining_area_id)
    REFERENCES dining_areas(restaurant_id, branch_id, id) ON DELETE RESTRICT
);

CREATE TABLE menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE menu_subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, category_id, id),
  UNIQUE (restaurant_id, category_id, name),
  FOREIGN KEY (restaurant_id, category_id)
    REFERENCES menu_categories(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  legacy_item_id bigint,
  item_number integer,
  category_id uuid,
  subcategory_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text,
  item_type text NOT NULL DEFAULT 'standard'
    CHECK (item_type IN ('standard', 'deal', 'soft_drink', 'ice_cream')),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  other_cost_minor bigint NOT NULL DEFAULT 0 CHECK (other_cost_minor >= 0),
  image_object_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, legacy_item_id),
  UNIQUE (restaurant_id, item_number),
  FOREIGN KEY (restaurant_id, category_id)
    REFERENCES menu_categories(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, category_id, subcategory_id)
    REFERENCES menu_subcategories(restaurant_id, category_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE menu_item_components (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  menu_item_id uuid NOT NULL,
  component_menu_item_id uuid NOT NULL,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, menu_item_id, component_menu_item_id),
  FOREIGN KEY (restaurant_id, menu_item_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, component_menu_item_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (menu_item_id <> component_menu_item_id)
);

CREATE TABLE stock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  legacy_key text,
  name text NOT NULL,
  stock_type text NOT NULL DEFAULT 'ingredient'
    CHECK (stock_type IN ('ingredient', 'soft_drink', 'ice_cream', 'other')),
  base_unit text NOT NULL CHECK (base_unit IN ('gram', 'millilitre', 'piece')),
  sell_unit text,
  base_units_per_sell_unit numeric(18, 6)
    CHECK (base_units_per_sell_unit IS NULL OR base_units_per_sell_unit > 0),
  low_stock_threshold numeric(18, 4) NOT NULL DEFAULT 0
    CHECK (low_stock_threshold >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, legacy_key),
  UNIQUE (restaurant_id, name),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE menu_item_recipe_items (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  menu_item_id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  quantity_base_units numeric(18, 6) NOT NULL CHECK (quantity_base_units > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, menu_item_id, stock_item_id),
  FOREIGN KEY (restaurant_id, menu_item_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, stock_item_id)
    REFERENCES stock_items(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE inventory_balances (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  quantity_base_units numeric(18, 4) NOT NULL DEFAULT 0,
  average_cost_minor_per_base_unit numeric(20, 8) NOT NULL DEFAULT 0
    CHECK (average_cost_minor_per_base_unit >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, branch_id, stock_item_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, stock_item_id)
    REFERENCES stock_items(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid,
  account_type text NOT NULL CHECK (account_type IN ('cash', 'bank')),
  display_name text NOT NULL,
  bank_name text,
  masked_account_number text,
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  opening_balance_date date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, display_name),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  source_device_id uuid,
  legacy_order_id bigint,
  order_number bigint NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('dine_in', 'takeaway', 'delivery')),
  order_status text NOT NULL DEFAULT 'completed'
    CHECK (order_status IN ('new', 'preparing', 'ready', 'served', 'completed', 'cancelled')),
  payment_status text NOT NULL DEFAULT 'paid'
    CHECK (payment_status IN ('unpaid', 'partially_paid', 'paid', 'refunded')),
  table_id uuid,
  customer_name text,
  customer_phone text,
  rider_name text,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_type text CHECK (discount_type IS NULL OR discount_type IN ('flat', 'percent')),
  discount_value numeric(14, 4) NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  delivery_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_minor >= 0),
  additional_charges_minor bigint NOT NULL DEFAULT 0 CHECK (additional_charges_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  cost_of_goods_minor bigint NOT NULL DEFAULT 0 CHECK (cost_of_goods_minor >= 0),
  business_date date NOT NULL,
  ordered_at timestamptz NOT NULL,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, branch_id, order_number),
  UNIQUE (restaurant_id, legacy_order_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, branch_id, source_device_id)
    REFERENCES devices(restaurant_id, branch_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, branch_id, table_id)
    REFERENCES restaurant_tables(restaurant_id, branch_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, updated_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (discount_minor <= subtotal_minor),
  CHECK (cancelled_at IS NULL OR order_status = 'cancelled')
);

CREATE INDEX orders_branch_business_date_idx
  ON orders (restaurant_id, branch_id, business_date DESC, order_number DESC);
CREATE INDEX orders_kitchen_queue_idx
  ON orders (restaurant_id, branch_id, order_status, ordered_at)
  WHERE order_status IN ('new', 'preparing', 'ready');

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  menu_item_id uuid,
  item_name_snapshot text NOT NULL,
  quantity numeric(12, 4) NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  unit_cost_minor bigint NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),
  recipe_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, menu_item_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(recipe_snapshot) = 'object')
);

CREATE TABLE order_item_extras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_item_id uuid NOT NULL,
  stock_item_id uuid,
  name_snapshot text NOT NULL,
  quantity_base_units numeric(18, 6) NOT NULL CHECK (quantity_base_units > 0),
  price_minor bigint NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  cost_minor bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, order_item_id)
    REFERENCES order_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, stock_item_id)
    REFERENCES stock_items(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE order_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  name text NOT NULL,
  charge_type text NOT NULL CHECK (charge_type IN ('flat', 'percent')),
  charge_value numeric(14, 4) NOT NULL CHECK (charge_value >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  financial_account_id uuid,
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_account', 'other')),
  status text NOT NULL DEFAULT 'captured'
    CHECK (status IN ('pending', 'captured', 'voided', 'refunded')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  idempotency_key uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, financial_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE order_edit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  actor_user_id uuid,
  event_type text NOT NULL,
  changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, actor_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(changes) = 'array')
);

CREATE TABLE stock_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  legacy_purchase_id bigint,
  supplier_name text,
  business_date date NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, legacy_purchase_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE stock_purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  purchase_id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  quantity_base_units numeric(18, 4) NOT NULL CHECK (quantity_base_units > 0),
  total_cost_minor bigint NOT NULL CHECK (total_cost_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  FOREIGN KEY (restaurant_id, purchase_id)
    REFERENCES stock_purchases(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, stock_item_id)
    REFERENCES stock_items(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  stock_item_id uuid NOT NULL,
  order_id uuid,
  purchase_item_id uuid,
  movement_type text NOT NULL
    CHECK (movement_type IN ('purchase', 'sale', 'sale_reversal', 'adjustment', 'waste', 'transfer_in', 'transfer_out')),
  quantity_delta numeric(18, 4) NOT NULL CHECK (quantity_delta <> 0),
  cost_minor bigint CHECK (cost_minor IS NULL OR cost_minor >= 0),
  idempotency_key uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, stock_item_id)
    REFERENCES stock_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_id)
    REFERENCES orders(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, purchase_item_id)
    REFERENCES stock_purchase_items(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX stock_movements_item_time_idx
  ON stock_movements (restaurant_id, branch_id, stock_item_id, occurred_at DESC);

CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  legacy_key text,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, legacy_key),
  UNIQUE (restaurant_id, name)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  legacy_expense_id bigint,
  category_id uuid NOT NULL,
  financial_account_id uuid,
  description text,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  business_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, legacy_expense_id),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, category_id)
    REFERENCES expense_categories(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, financial_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE expense_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  expense_id uuid NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, expense_id)
    REFERENCES expenses(restaurant_id, id) ON DELETE RESTRICT,
  UNIQUE (restaurant_id, object_key)
);

CREATE TABLE account_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  source_account_id uuid NOT NULL,
  destination_account_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  description text,
  transferred_at timestamptz NOT NULL,
  idempotency_key uuid NOT NULL,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, idempotency_key),
  FOREIGN KEY (restaurant_id, source_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, destination_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, created_by_user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE RESTRICT,
  CHECK (source_account_id <> destination_account_id)
);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid,
  financial_account_id uuid NOT NULL,
  order_payment_id uuid,
  expense_id uuid,
  transfer_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('credit', 'debit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  description text NOT NULL,
  source_type text NOT NULL
    CHECK (source_type IN ('opening_balance', 'sale', 'expense', 'transfer', 'refund', 'adjustment')),
  source_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, source_key, financial_account_id, entry_type),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, financial_account_id)
    REFERENCES financial_accounts(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, order_payment_id)
    REFERENCES order_payments(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, expense_id)
    REFERENCES expenses(restaurant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, transfer_id)
    REFERENCES account_transfers(restaurant_id, id) ON DELETE RESTRICT
);

CREATE INDEX ledger_entries_account_time_idx
  ON ledger_entries (restaurant_id, financial_account_id, occurred_at DESC);

-- Every mutable table receives the same updated-at behavior as the foundation.
CREATE TRIGGER business_settings_set_updated_at BEFORE UPDATE ON business_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER receipt_settings_set_updated_at BEFORE UPDATE ON receipt_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dining_areas_set_updated_at BEFORE UPDATE ON dining_areas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER restaurant_tables_set_updated_at BEFORE UPDATE ON restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menu_categories_set_updated_at BEFORE UPDATE ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menu_subcategories_set_updated_at BEFORE UPDATE ON menu_subcategories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menu_items_set_updated_at BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menu_item_recipe_items_set_updated_at BEFORE UPDATE ON menu_item_recipe_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_items_set_updated_at BEFORE UPDATE ON stock_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER inventory_balances_set_updated_at BEFORE UPDATE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER financial_accounts_set_updated_at BEFORE UPDATE ON financial_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER stock_purchases_set_updated_at BEFORE UPDATE ON stock_purchases
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expense_categories_set_updated_at BEFORE UPDATE ON expense_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER expenses_set_updated_at BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenant isolation is deliberately repetitive so a newly added table cannot
-- accidentally inherit access from a frontend-supplied resource identifier.
ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dining_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_subcategories ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_recipe_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_extras ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_edit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE receipt_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE dining_areas FORCE ROW LEVEL SECURITY;
ALTER TABLE restaurant_tables FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_subcategories FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_items FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_item_components FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_items FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_item_recipe_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inventory_balances FORCE ROW LEVEL SECURITY;
ALTER TABLE financial_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
ALTER TABLE order_item_extras FORCE ROW LEVEL SECURITY;
ALTER TABLE order_charges FORCE ROW LEVEL SECURITY;
ALTER TABLE order_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE order_edit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_purchase_items FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE expense_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE expense_attachments FORCE ROW LEVEL SECURITY;
ALTER TABLE account_transfers FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_settings', 'receipt_settings', 'dining_areas', 'restaurant_tables',
    'menu_categories', 'menu_subcategories', 'menu_items', 'menu_item_components',
    'stock_items', 'menu_item_recipe_items', 'inventory_balances',
    'financial_accounts', 'orders', 'order_items', 'order_item_extras',
    'order_charges', 'order_payments', 'order_edit_events', 'stock_purchases',
    'stock_purchase_items', 'stock_movements', 'expense_categories', 'expenses',
    'expense_attachments', 'account_transfers', 'ledger_entries'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (restaurant_id = current_restaurant_id()) WITH CHECK (restaurant_id = current_restaurant_id())',
      table_name || '_tenant_isolation',
      table_name
    );
  END LOOP;
END;
$$;

COMMIT;
