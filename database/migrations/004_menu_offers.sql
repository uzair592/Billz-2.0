BEGIN;

CREATE TABLE menu_item_offers (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  menu_item_id uuid NOT NULL,
  offer_price_minor bigint NOT NULL CHECK (offer_price_minor > 0),
  starts_on date,
  ends_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, menu_item_id),
  FOREIGN KEY (restaurant_id, menu_item_id)
    REFERENCES menu_items(restaurant_id, id) ON DELETE CASCADE,
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);

CREATE TABLE menu_category_offers (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('flat', 'percent')),
  discount_minor bigint,
  discount_percent numeric(7, 4),
  starts_on date,
  ends_on date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, category_id),
  FOREIGN KEY (restaurant_id, category_id)
    REFERENCES menu_categories(restaurant_id, id) ON DELETE CASCADE,
  CHECK (
    (discount_type = 'flat' AND discount_minor > 0 AND discount_percent IS NULL)
    OR
    (discount_type = 'percent' AND discount_minor IS NULL
      AND discount_percent > 0 AND discount_percent <= 100)
  ),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on)
);

CREATE TRIGGER menu_item_offers_set_updated_at BEFORE UPDATE ON menu_item_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER menu_category_offers_set_updated_at BEFORE UPDATE ON menu_category_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_item_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_item_offers FORCE ROW LEVEL SECURITY;
ALTER TABLE menu_category_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_category_offers FORCE ROW LEVEL SECURITY;

CREATE POLICY menu_item_offers_tenant_isolation ON menu_item_offers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY menu_category_offers_tenant_isolation ON menu_category_offers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
