BEGIN;

-- One namespace for username-only and email login. Existing collisions are
-- reserved rather than silently changing customer credentials. Administrators
-- can rename those users; ambiguous username-only login fails closed.
CREATE TABLE user_login_identifiers (
  identifier text PRIMARY KEY CHECK (identifier = lower(btrim(identifier))),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE
);
INSERT INTO user_login_identifiers(identifier, user_id)
SELECT identifier, CASE WHEN count(DISTINCT user_id) = 1 THEN (array_agg(user_id))[1] ELSE NULL END
FROM (
  SELECT normalized_username AS identifier, id AS user_id FROM users WHERE normalized_username IS NOT NULL
  UNION
  SELECT normalized_email, id FROM users WHERE normalized_email IS NOT NULL
) identifiers
GROUP BY identifier;

CREATE FUNCTION claim_user_login_identifiers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE login_identifier text; claimed_user uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.normalized_username IS NOT DISTINCT FROM OLD.normalized_username
     AND NEW.normalized_email IS NOT DISTINCT FROM OLD.normalized_email THEN
    RETURN NEW;
  END IF;
  -- Sorted claims give concurrent renames a consistent locking order. The
  -- unique key enforces the rule across all provisioning/reset entry points.
  FOR login_identifier IN
    SELECT DISTINCT value FROM unnest(ARRAY[NEW.normalized_username, NEW.normalized_email]) value
    WHERE value IS NOT NULL ORDER BY value
  LOOP
    claimed_user := NULL;
    INSERT INTO public.user_login_identifiers(identifier, user_id) VALUES(login_identifier, NEW.id)
    ON CONFLICT(identifier) DO UPDATE SET user_id = EXCLUDED.user_id
      WHERE user_login_identifiers.user_id = EXCLUDED.user_id
    RETURNING user_id INTO claimed_user;
    IF claimed_user IS NULL THEN
      RAISE EXCEPTION 'Login identifier already exists'
        USING ERRCODE = '23505', CONSTRAINT = 'users_global_username_unique';
    END IF;
  END LOOP;
  DELETE FROM public.user_login_identifiers WHERE user_id = NEW.id
    AND identifier IS DISTINCT FROM NEW.normalized_username
    AND identifier IS DISTINCT FROM NEW.normalized_email;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_claim_login_identifiers
AFTER INSERT OR UPDATE OF normalized_username, normalized_email ON users
FOR EACH ROW EXECUTE FUNCTION claim_user_login_identifiers();
-- No runtime role receives access to this control registry. The narrowly
-- scoped trigger owns claims; no tenant data is read outside the RLS context.
REVOKE ALL ON user_login_identifiers FROM PUBLIC;
COMMIT;
