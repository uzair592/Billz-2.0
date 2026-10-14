BEGIN;
ALTER TABLE plans ADD COLUMN max_devices integer NOT NULL DEFAULT 20 CHECK (max_devices BETWEEN 1 AND 1000),
  ADD COLUMN trial_days integer NOT NULL DEFAULT 14 CHECK (trial_days BETWEEN 1 AND 3650);
ALTER TABLE plan_prices DROP CONSTRAINT plan_prices_billing_interval_check;
ALTER TABLE plan_prices ADD CONSTRAINT plan_prices_billing_interval_check CHECK (billing_interval IN ('month','quarter','year','trial'));
ALTER TABLE plan_prices DROP CONSTRAINT plan_prices_plan_id_currency_code_billing_interval_provider_key;
CREATE UNIQUE INDEX plan_prices_current_price ON plan_prices(plan_id,currency_code,billing_interval,provider) WHERE is_active;
ALTER TABLE sessions ADD COLUMN restaurant_id uuid REFERENCES restaurants(id) ON DELETE RESTRICT;
UPDATE sessions s SET restaurant_id = COALESCE(u.restaurant_id,
  (SELECT restaurant_id FROM restaurant_memberships m WHERE m.user_id=u.id ORDER BY m.created_at,m.restaurant_id LIMIT 1))
  FROM users u WHERE u.id=s.user_id;
ALTER TABLE sessions ADD CONSTRAINT sessions_restaurant_member_fk FOREIGN KEY(restaurant_id,user_id)
  REFERENCES restaurant_memberships(restaurant_id,user_id) ON DELETE CASCADE;
CREATE INDEX sessions_active_restaurant_idx ON sessions(restaurant_id,expires_at) WHERE revoked_at IS NULL;
COMMIT;
