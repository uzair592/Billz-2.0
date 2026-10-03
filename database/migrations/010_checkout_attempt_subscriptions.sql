BEGIN;

-- A checkout retry must update the exact subscription created for the attempt.
-- The composite foreign key prevents a tenant's attempt from referencing a
-- subscription owned by another restaurant.
ALTER TABLE checkout_attempts
  ADD COLUMN subscription_id uuid;

ALTER TABLE checkout_attempts
  ADD CONSTRAINT checkout_attempts_subscription_tenant_fk
  FOREIGN KEY (restaurant_id, subscription_id)
  REFERENCES subscriptions (restaurant_id, id)
  ON DELETE RESTRICT;

CREATE INDEX checkout_attempts_subscription_idx
  ON checkout_attempts (restaurant_id, subscription_id)
  WHERE subscription_id IS NOT NULL;

COMMENT ON COLUMN checkout_attempts.subscription_id IS
  'The exact tenant-owned subscription prepared for this checkout. Required on
   newly created attempts so retries never infer a subscription from row order.';

COMMIT;
