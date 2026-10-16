-- =====================================================================
-- Migration 027: Resilient Billing, KOT Support & Active Session Index
--
-- 1. Incomplete costing tracking: records orders that were successfully billed
--    even when recipe or stock entries were missing/incomplete.
-- 2. Skipped stock deductions: durability array of items where deduction
--    was skipped so the owner can review them in reports.
-- 3. Concurrent active session tracking and performance indexes.
-- =====================================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS incomplete_costing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skipped_stock_deductions jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE inventory_consumptions
  ADD COLUMN IF NOT EXISTS incomplete_costing boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skipped_deductions jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS orders_incomplete_costing_idx
  ON orders (restaurant_id, incomplete_costing, business_date DESC)
  WHERE incomplete_costing = true;

CREATE INDEX IF NOT EXISTS sessions_active_restaurant_idx
  ON sessions (restaurant_id, revoked_at, expires_at)
  WHERE revoked_at IS NULL;
