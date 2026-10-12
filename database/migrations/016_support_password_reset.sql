BEGIN;

-- Launch recovery is an audited support action, not an unused email-token flow.
DROP TABLE password_reset_tokens;

COMMIT;
