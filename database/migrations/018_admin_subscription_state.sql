BEGIN;

-- Restoring access must retain trial expiry and cancellation semantics.
ALTER TABLE subscriptions ADD COLUMN status_before_suspend text
  CHECK (status_before_suspend IN ('trialing', 'active', 'past_due', 'cancel_at_period_end'));

COMMIT;
