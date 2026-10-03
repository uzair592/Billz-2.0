BEGIN;

-- A checkout attempt is an idempotency record for a provider checkout session.
-- It prevents duplicate provider calls and allows safe retries.
CREATE TABLE checkout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  idempotency_key_hash text GENERATED ALWAYS AS (encode(sha256(convert_to(idempotency_key, 'UTF8')), 'hex')) STORED,
  plan_code text NOT NULL,
  plan_hash text NOT NULL,
  success_url text NOT NULL,
  cancel_url text NOT NULL,
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'created', 'failed', 'expired')),
  provider_customer_id text,
  provider_checkout_session_id text,
  provider_checkout_url text,
  provider_idempotency_key text,
  error_message text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, idempotency_key)
);

-- Prevent multiple live checkout attempts per restaurant
CREATE UNIQUE INDEX checkout_attempts_one_live_per_restaurant
  ON checkout_attempts (restaurant_id)
  WHERE status IN ('creating', 'created');

CREATE INDEX checkout_attempts_restaurant_status_idx
  ON checkout_attempts (restaurant_id, status)
  WHERE status IN ('creating', 'created');

CREATE INDEX checkout_attempts_expires_idx
  ON checkout_attempts (expires_at)
  WHERE status IN ('creating', 'created');

-- Row-level security
ALTER TABLE checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkout_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY checkout_attempts_tenant_isolation ON checkout_attempts
  USING (restaurant_id = current_setting('app.restaurant_id', true)::uuid)
  WITH CHECK (restaurant_id = current_setting('app.restaurant_id', true)::uuid);

COMMENT ON TABLE checkout_attempts IS
  'Durable idempotency records for provider checkout sessions. Prevents duplicate
   provider calls and allows safe retries. Each attempt is tied to a restaurant
   and an idempotency key provided by the caller.';

COMMENT ON COLUMN checkout_attempts.idempotency_key_hash IS
  'SHA-256 hash of the idempotency key for logging/auditing without exposing the key itself.';

COMMENT ON COLUMN checkout_attempts.plan_hash IS
  'SHA-256 hash of the canonicalized plan code, success_url, and cancel_url.
   Used to detect when the same idempotency key is reused with a different payload.';

COMMENT ON COLUMN checkout_attempts.status IS
  'creating = provider call in progress or not yet made;
   created = provider session created, URL stored, ready for user;
   failed = provider call failed permanently;
   expired = attempt timed out before completion.';

COMMENT ON COLUMN checkout_attempts.provider_idempotency_key IS
  'The idempotency key sent to the provider (e.g., Stripe Idempotency-Key header).
   Allows the provider to deduplicate on its side as well.';

COMMENT ON COLUMN checkout_attempts.expires_at IS
  'When this attempt expires. A creating/created attempt that expires is moved
   to expired by a background job or on next access.';

COMMENT ON INDEX checkout_attempts_restaurant_status_idx IS
  'Finds active checkout attempts for a restaurant (e.g., to block new checkouts).';

COMMENT ON INDEX checkout_attempts_expires_idx IS
  'Finds expired attempts for cleanup or status transition.';

COMMENT ON INDEX checkout_attempts_one_live_per_restaurant IS
  'Enforces at most one live (creating/created) checkout attempt per restaurant.';

COMMIT;