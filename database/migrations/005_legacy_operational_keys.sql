BEGIN;

ALTER TABLE financial_accounts ADD COLUMN legacy_account_id text;
ALTER TABLE financial_accounts ADD CONSTRAINT financial_accounts_restaurant_legacy_unique
  UNIQUE (restaurant_id, legacy_account_id);

COMMIT;
