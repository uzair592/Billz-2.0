BEGIN;

-- Track device synchronization queues, outbox state, and errors for the Super Admin Monitor
CREATE TABLE IF NOT EXISTS device_sync_status (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  device_uid text NOT NULL,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  device_name text,
  platform text,
  app_version text,
  pending_orders_count integer NOT NULL DEFAULT 0,
  failed_sync_count integer NOT NULL DEFAULT 0,
  last_sync_at timestamptz,
  last_error_message text,
  last_error_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, device_uid)
);

CREATE INDEX IF NOT EXISTS device_sync_status_restaurant_idx
  ON device_sync_status (restaurant_id, last_seen_at DESC);

ALTER TABLE device_sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sync_status FORCE ROW LEVEL SECURITY;

CREATE POLICY device_sync_status_tenant_isolation ON device_sync_status
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON device_sync_status TO PUBLIC;

COMMIT;
