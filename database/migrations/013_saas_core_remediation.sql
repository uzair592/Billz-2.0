BEGIN;

-- 1. Add restaurant_code / code to restaurants
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS code text;

-- Populate code for existing restaurants if null
UPDATE restaurants
   SET code = lower(btrim(slug))
 WHERE code IS NULL;

-- Add check constraint and unique index for restaurant code
ALTER TABLE restaurants
  ALTER COLUMN code SET NOT NULL,
  ADD CONSTRAINT restaurants_code_format CHECK (code = lower(btrim(code)) AND length(code) >= 2);

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_code_unique_idx ON restaurants (code);

-- 2. Update users table to support tenant-scoped usernames & optional emails
ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN normalized_email DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS normalized_username text;

-- Add constraint for username format and tenant uniqueness
ALTER TABLE users
  ADD CONSTRAINT users_username_format CHECK (
    normalized_username IS NULL OR normalized_username = lower(btrim(username))
  );

CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_username_unique_idx
  ON users (restaurant_id, normalized_username)
  WHERE restaurant_id IS NOT NULL AND normalized_username IS NOT NULL;

-- 3. Dedicated Platform Administrators Table & Sessions
CREATE TABLE IF NOT EXISTS platform_administrators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL CHECK (length(btrim(username)) BETWEEN 3 AND 64),
  normalized_username text NOT NULL UNIQUE CHECK (normalized_username = lower(btrim(username))),
  password_hash text NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER platform_administrators_set_updated_at
  BEFORE UPDATE ON platform_administrators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS platform_admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES platform_administrators(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS platform_admin_sessions_active_idx
  ON platform_admin_sessions (admin_id, expires_at)
  WHERE revoked_at IS NULL;

-- Add actor_admin_id column to audit_logs
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS actor_admin_id uuid REFERENCES platform_administrators(id) ON DELETE SET NULL;

-- 4. Manual Subscription Payments Table
CREATE TABLE IF NOT EXISTS manual_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency_code text NOT NULL DEFAULT 'PKR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  payment_date timestamptz NOT NULL,
  covered_from timestamptz NOT NULL,
  covered_until timestamptz NOT NULL,
  payment_method text NOT NULL DEFAULT 'manual_bank_transfer',
  external_reference text NOT NULL,
  whatsapp_reference_text text,
  administrator_note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by_admin_id uuid REFERENCES platform_administrators(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (covered_until > covered_from)
);

CREATE INDEX IF NOT EXISTS manual_payments_restaurant_idx
  ON manual_payments (restaurant_id, created_at DESC);

CREATE TRIGGER manual_payments_set_updated_at
  BEFORE UPDATE ON manual_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. Tenant Storage Plan Allowances & File Assets Table
CREATE TABLE IF NOT EXISTS tenant_storage_allowances (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE RESTRICT,
  max_storage_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (max_storage_bytes >= 0), -- 5 GB
  used_storage_bytes bigint NOT NULL DEFAULT 0 CHECK (used_storage_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER tenant_storage_allowances_set_updated_at
  BEFORE UPDATE ON tenant_storage_allowances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS managed_file_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  file_name text NOT NULL CHECK (length(btrim(file_name)) > 0),
  mime_type text NOT NULL CHECK (length(btrim(mime_type)) > 0),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS managed_file_assets_restaurant_idx
  ON managed_file_assets (restaurant_id, created_at DESC);

-- Enable RLS for newly created tenant tables
ALTER TABLE manual_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_storage_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_file_assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE manual_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_storage_allowances FORCE ROW LEVEL SECURITY;
ALTER TABLE managed_file_assets FORCE ROW LEVEL SECURITY;

-- Update RLS policies to allow platform admin (un-scoped) queries while strictly scoping tenant transactions when app.restaurant_id is set
DROP POLICY IF EXISTS restaurants_tenant_isolation ON restaurants;
CREATE POLICY restaurants_tenant_isolation ON restaurants
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR id = current_restaurant_id());

DROP POLICY IF EXISTS branches_tenant_isolation ON branches;
CREATE POLICY branches_tenant_isolation ON branches
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS memberships_tenant_isolation ON restaurant_memberships;
CREATE POLICY memberships_tenant_isolation ON restaurant_memberships
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS subscriptions_tenant_isolation ON subscriptions;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS manual_payments_tenant_isolation ON manual_payments;
CREATE POLICY manual_payments_tenant_isolation ON manual_payments
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS tenant_storage_allowances_tenant_isolation ON tenant_storage_allowances;
CREATE POLICY tenant_storage_allowances_tenant_isolation ON tenant_storage_allowances
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS managed_file_assets_tenant_isolation ON managed_file_assets;
CREATE POLICY managed_file_assets_tenant_isolation ON managed_file_assets
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id())
  WITH CHECK (current_setting('app.restaurant_id', true) IS NULL OR current_setting('app.restaurant_id', true) = '' OR restaurant_id = current_restaurant_id());

COMMIT;
