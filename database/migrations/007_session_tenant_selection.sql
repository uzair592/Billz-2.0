BEGIN;

-- A signed-in device must be able to discover which restaurants it may use
-- before any tenant has been chosen. Setting only the user context leaves
-- `app.restaurant_id` empty, so every tenant table stays invisible; the caller
-- can therefore read its own memberships and nothing else.
CREATE OR REPLACE FUNCTION current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- Read-only and additive: a permissive SELECT policy is OR'ed with the tenant
-- policy, so it cannot widen INSERT, UPDATE, or DELETE access, and it only ever
-- exposes the caller's own membership rows.
CREATE POLICY restaurant_memberships_self_read ON restaurant_memberships
  FOR SELECT
  USING (user_id = current_user_id());

CREATE POLICY restaurants_self_read ON restaurants
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM restaurant_memberships m
       WHERE m.restaurant_id = restaurants.id
         AND m.user_id = current_user_id()
         AND m.status = 'active'
    )
  );

COMMIT;