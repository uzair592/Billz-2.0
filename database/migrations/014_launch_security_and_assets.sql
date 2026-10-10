BEGIN;

-- Ordinary app connections deny missing tenant context. Platform administration
-- and account discovery use a separate, explicitly provisioned BYPASSRLS role.
DROP POLICY IF EXISTS restaurants_tenant_isolation ON restaurants;
CREATE POLICY restaurants_tenant_isolation ON restaurants
 USING (id = current_restaurant_id())
 WITH CHECK (id = current_restaurant_id());

DROP POLICY IF EXISTS branches_tenant_isolation ON branches;
CREATE POLICY branches_tenant_isolation ON branches
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS memberships_tenant_isolation ON restaurant_memberships;
CREATE POLICY memberships_tenant_isolation ON restaurant_memberships
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS subscriptions_tenant_isolation ON subscriptions;
CREATE POLICY subscriptions_tenant_isolation ON subscriptions
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS manual_payments_tenant_isolation ON manual_payments;
CREATE POLICY manual_payments_tenant_isolation ON manual_payments
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS tenant_storage_allowances_tenant_isolation ON tenant_storage_allowances;
CREATE POLICY tenant_storage_allowances_tenant_isolation ON tenant_storage_allowances
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS managed_file_assets_tenant_isolation ON managed_file_assets;
CREATE POLICY managed_file_assets_tenant_isolation ON managed_file_assets
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
 USING (restaurant_id = current_restaurant_id())
 WITH CHECK (restaurant_id = current_restaurant_id());

-- Compatibility for pre-SaaS tenant creation paths.
CREATE FUNCTION fill_restaurant_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL THEN NEW.code := lower(btrim(NEW.slug)); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER restaurants_fill_code BEFORE INSERT ON restaurants
 FOR EACH ROW EXECUTE FUNCTION fill_restaurant_code();

ALTER TABLE managed_file_assets ADD COLUMN content bytea,
 ADD COLUMN sha256 text;
-- Metadata-only historical uploads never contained files: remove the false usage
-- reservation, preserving their metadata as a record of the failed old upload.
UPDATE tenant_storage_allowances a SET used_storage_bytes = 0;
ALTER TABLE managed_file_assets ADD CONSTRAINT assets_content_integrity CHECK (
 content IS NULL OR (octet_length(content) = byte_size AND length(sha256) = 64)
);

-- Duplicate external references must not extend access twice. Existing duplicates
-- are preserved and approval checks them; enforce uniqueness for new inserts.
CREATE FUNCTION reject_duplicate_payment_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(lower(btrim(NEW.external_reference)), 7));
 IF EXISTS (SELECT 1 FROM manual_payments WHERE lower(btrim(external_reference)) = lower(btrim(NEW.external_reference))) THEN
  RAISE EXCEPTION 'Payment reference already recorded' USING ERRCODE = '23505';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER manual_payments_unique_reference BEFORE INSERT ON manual_payments
 FOR EACH ROW EXECUTE FUNCTION reject_duplicate_payment_reference();
ALTER TABLE inventory_movements DROP CONSTRAINT inventory_movements_movement_type_check;
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_movement_type_check
 CHECK (movement_type IN ('purchase_receipt', 'sale_consumption', 'sale_reversal', 'adjustment_increase', 'adjustment_decrease', 'waste'));
-- Partial refunds need more than one compensating movement per ingredient.
DROP INDEX IF EXISTS stock_movements_sale_reversal_key_idx;
COMMIT;
