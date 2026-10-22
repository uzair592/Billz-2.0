CREATE INDEX IF NOT EXISTS order_item_extras_item_idx
  ON order_item_extras (restaurant_id, order_item_id);

CREATE INDEX IF NOT EXISTS order_item_extras_stock_idx
  ON order_item_extras (restaurant_id, stock_item_id);
