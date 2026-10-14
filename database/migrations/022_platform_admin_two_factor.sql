BEGIN;
ALTER TABLE platform_administrators
  ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN totp_secret_encrypted text,
  ADD COLUMN totp_last_counter bigint NOT NULL DEFAULT -1,
  ADD COLUMN totp_pending_encrypted text,
  ADD COLUMN totp_pending_id uuid,
  ADD COLUMN totp_pending_expires_at timestamptz,
  ADD COLUMN totp_recovery_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN totp_pending_recovery_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT platform_admin_totp_state CHECK (NOT totp_enabled OR totp_secret_encrypted IS NOT NULL);
COMMIT;
