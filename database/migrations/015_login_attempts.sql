BEGIN;

-- Authentication is performed through the isolated control role before a
-- tenant is known. No tenant/POS role may read or write these counters.
CREATE TABLE login_attempts (
  scope text NOT NULL CHECK (scope IN ('restaurant', 'platform_admin')),
  account_key bytea NOT NULL CHECK (octet_length(account_key) = 32),
  ip_address inet NOT NULL,
  failures integer NOT NULL CHECK (failures BETWEEN 1 AND 20),
  last_failure_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  PRIMARY KEY (scope, account_key, ip_address)
);
CREATE INDEX login_attempts_expiry_idx ON login_attempts(last_failure_at);
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts FORCE ROW LEVEL SECURITY;

COMMIT;
