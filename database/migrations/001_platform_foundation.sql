BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  normalized_email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  platform_role text NOT NULL DEFAULT 'user'
    CHECK (platform_role IN ('user', 'super_admin')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_verification', 'active', 'suspended', 'disabled')),
  email_verified_at timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = btrim(email)),
  CHECK (normalized_email = lower(btrim(email)))
);

CREATE TABLE restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deactivated')),
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  currency_code text NOT NULL DEFAULT 'PKR'
    CHECK (currency_code ~ '^[A-Z]{3}$'),
  phone text,
  address text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, status)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  timezone text NOT NULL DEFAULT 'Asia/Karachi',
  phone text,
  address text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, code)
);

CREATE UNIQUE INDEX branches_one_default_per_restaurant
  ON branches (restaurant_id)
  WHERE is_default;

CREATE TABLE restaurant_memberships (
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  default_branch_id uuid,
  role text NOT NULL
    CHECK (role IN ('owner', 'manager', 'cashier', 'waiter', 'kitchen')),
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, user_id),
  FOREIGN KEY (restaurant_id, default_branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'active' OR joined_at IS NOT NULL)
);

CREATE INDEX restaurant_memberships_user_idx
  ON restaurant_memberships (user_id, status);

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  branch_id uuid NOT NULL,
  device_uid text NOT NULL,
  name text NOT NULL,
  platform text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'retired')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, branch_id, id),
  UNIQUE (restaurant_id, device_uid),
  FOREIGN KEY (restaurant_id, branch_id)
    REFERENCES branches(restaurant_id, id) ON DELETE RESTRICT
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX sessions_active_user_idx
  ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (restaurant_id, user_id)
    REFERENCES restaurant_memberships(restaurant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name text NOT NULL,
  description text,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(features) = 'object')
);

CREATE TABLE plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  billing_interval text NOT NULL DEFAULT 'month'
    CHECK (billing_interval IN ('month', 'year')),
  provider text NOT NULL,
  provider_price_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, id),
  UNIQUE (provider, provider_price_id),
  UNIQUE (plan_id, currency_code, billing_interval, provider)
);

CREATE TABLE billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (restaurant_id, provider),
  UNIQUE (provider, provider_customer_id)
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  plan_price_id uuid REFERENCES plan_prices(id) ON DELETE RESTRICT,
  billing_customer_id uuid REFERENCES billing_customers(id) ON DELETE RESTRICT,
  provider text,
  provider_subscription_id text,
  status text NOT NULL
    CHECK (status IN (
      'trialing', 'active', 'past_due', 'cancel_at_period_end',
      'cancelled', 'expired', 'suspended'
    )),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  cancelled_at timestamptz,
  provider_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, id),
  UNIQUE (provider, provider_subscription_id),
  FOREIGN KEY (plan_id, plan_price_id)
    REFERENCES plan_prices(plan_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (restaurant_id, billing_customer_id)
    REFERENCES billing_customers(restaurant_id, id) ON DELETE RESTRICT,
  CHECK (
    current_period_end IS NULL
    OR current_period_start IS NULL
    OR current_period_end > current_period_start
  )
);

CREATE UNIQUE INDEX subscriptions_one_current_per_restaurant
  ON subscriptions (restaurant_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'cancel_at_period_end', 'suspended');

CREATE INDEX subscriptions_access_check_idx
  ON subscriptions (restaurant_id, status, current_period_end);

CREATE TABLE billing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  provider_payment_id text,
  provider_invoice_id text,
  status text NOT NULL
    CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'void')),
  currency_code text NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  failure_code text,
  failure_message text,
  paid_at timestamptz,
  provider_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (restaurant_id, subscription_id)
    REFERENCES subscriptions(restaurant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX billing_payments_provider_payment_unique
  ON billing_payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX billing_payments_restaurant_created_idx
  ON billing_payments (restaurant_id, created_at DESC);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_events_retry_idx
  ON webhook_events (processing_status, received_at)
  WHERE processing_status IN ('pending', 'failed');

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user'
    CHECK (actor_type IN ('user', 'platform_admin', 'system', 'webhook')),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  ip_address inet,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_restaurant_created_idx
  ON audit_logs (restaurant_id, created_at DESC);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER restaurants_set_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER branches_set_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER restaurant_memberships_set_updated_at
  BEFORE UPDATE ON restaurant_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plans_set_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER plan_prices_set_updated_at
  BEFORE UPDATE ON plan_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER billing_customers_set_updated_at
  BEFORE UPDATE ON billing_customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER billing_payments_set_updated_at
  BEFORE UPDATE ON billing_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tenant context is set by the API at the start of every transaction:
-- SET LOCAL app.restaurant_id = '<authenticated restaurant UUID>';
CREATE OR REPLACE FUNCTION current_restaurant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.restaurant_id', true), '')::uuid
$$;

ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE restaurants FORCE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;
ALTER TABLE restaurant_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY restaurants_tenant_isolation ON restaurants
  USING (id = current_restaurant_id())
  WITH CHECK (id = current_restaurant_id());
CREATE POLICY branches_tenant_isolation ON branches
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY memberships_tenant_isolation ON restaurant_memberships
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY devices_tenant_isolation ON devices
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY billing_customers_tenant_isolation ON billing_customers
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY billing_payments_tenant_isolation ON billing_payments
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
