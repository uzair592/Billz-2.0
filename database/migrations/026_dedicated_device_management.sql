BEGIN;

-- 1. Extend the devices table for dedicated enterprise device management
ALTER TABLE devices
  ALTER COLUMN branch_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS device_type text NOT NULL DEFAULT 'desktop' CHECK (device_type IN ('desktop', 'laptop', 'tablet', 'mobile')),
  ADD COLUMN IF NOT EXISTS os text,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revocation_reason text,
  ADD COLUMN IF NOT EXISTS reactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS reactivation_reason text,
  ADD COLUMN IF NOT EXISTS revoked_by_admin_id uuid REFERENCES platform_administrators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reactivated_by_admin_id uuid REFERENCES platform_administrators(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Link authenticated sessions to physical registered devices
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;

-- 3. Indexes for device search, status filtering, and session lookup
CREATE INDEX IF NOT EXISTS devices_restaurant_status_idx
  ON devices (restaurant_id, status);

CREATE INDEX IF NOT EXISTS devices_last_seen_at_idx
  ON devices (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS sessions_device_id_idx
  ON sessions (device_id);

-- 4. Update devices RLS policy to permit platform administration queries across tenants
DROP POLICY IF EXISTS devices_tenant_isolation ON devices;
CREATE POLICY devices_tenant_isolation ON devices
  USING (
    current_setting('app.restaurant_id', true) IS NULL
    OR current_setting('app.restaurant_id', true) = ''
    OR restaurant_id = current_restaurant_id()
  )
  WITH CHECK (
    current_setting('app.restaurant_id', true) IS NULL
    OR current_setting('app.restaurant_id', true) = ''
    OR restaurant_id = current_restaurant_id()
  );

COMMIT;
