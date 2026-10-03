BEGIN;

-- A checkout is started before any money moves, so the subscription record has
-- to be able to exist in a state that grants nothing. Row-level security and
-- the entitlement policy both treat an unknown state as billing-only, so this
-- fails closed: no access until a verified payment event arrives.
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN (
    'pending_checkout', 'trialing', 'active', 'past_due', 'cancel_at_period_end',
    'cancelled', 'expired', 'suspended'
  ));

DROP INDEX subscriptions_one_current_per_restaurant;
CREATE UNIQUE INDEX subscriptions_one_current_per_restaurant
  ON subscriptions (restaurant_id)
  WHERE status IN (
    'pending_checkout', 'trialing', 'active', 'past_due', 'cancel_at_period_end',
    'suspended'
  );

-- A verified webhook has to find the restaurant it belongs to before any tenant
-- context exists, while subscriptions and billing customers are protected by
-- forced row-level security. This platform-level table is written only by our
-- own API at checkout time, when the restaurant is already known, and it holds
-- provider references only — no money, no card data, no customer details.
CREATE TABLE provider_tenant_routes (
  provider text NOT NULL,
  provider_reference text NOT NULL,
  provider_reference_type text NOT NULL
    CHECK (provider_reference_type IN ('customer', 'subscription', 'checkout_session')),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_reference)
);

CREATE INDEX provider_tenant_routes_restaurant_idx
  ON provider_tenant_routes (restaurant_id, provider);

COMMIT;