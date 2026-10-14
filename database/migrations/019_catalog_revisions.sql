BEGIN;

CREATE TABLE tenant_catalogs (
  restaurant_id uuid PRIMARY KEY REFERENCES restaurants(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  snapshot jsonb,
  mappings jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant_catalogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_catalogs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_catalogs_isolation ON tenant_catalogs
  USING (restaurant_id = current_restaurant_id())
  WITH CHECK (restaurant_id = current_restaurant_id());

COMMIT;
