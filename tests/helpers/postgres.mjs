import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { projectRoot } from "./legacy-source.mjs";

export const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_ADMIN_URL
  ?? "postgresql://postgres:validation-only@127.0.0.1:55432/restaurant_pos_test";

export const APP_ROLE = "pos_integration_app";

/**
 * The application role used by the services under test.
 *
 * It is deliberately NOT the owner and NOT a superuser. Every billing table
 * enables *forced* row-level security, which the table owner bypasses unless it
 * is a superuser — so testing isolation as `postgres` would prove nothing.
 */
export const APP_DATABASE_URL =
  process.env.TEST_DATABASE_URL
  ?? `postgresql://${APP_ROLE}:integration-only@127.0.0.1:55432/restaurant_pos_test`;

const MIGRATIONS_DIR = path.join(projectRoot, "database", "migrations");

export async function connectAdmin() {
  const pool = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    await pool.end();
    throw error;
  }
  return pool;
}

/**
 * Prepares a database that behaves like production for isolation purposes:
 * migrations applied, and a non-superuser role holding only the privileges the
 * application role actually needs.
 */
export async function provisionIntegrationDatabase() {
  const admin = await connectAdmin();
  try {
    // Start from an empty schema so the migrations can be replayed on a
    // container that already holds a previous run's tables.
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    await admin.query("GRANT ALL ON SCHEMA public TO public;");

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await admin.query(sql);
    }

    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE ${APP_ROLE} LOGIN PASSWORD 'integration-only' NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await admin.query(`
      DO $$
      DECLARE
        target text;
      BEGIN
        FOR target IN
          SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        LOOP
          EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ${APP_ROLE}', target);
        END LOOP;
        FOR target IN
          SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
        LOOP
          EXECUTE format('GRANT USAGE, SELECT ON public.%I TO ${APP_ROLE}', target);
        END LOOP;
        FOR target IN
          SELECT p.oid::regprocedure::text FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
        LOOP
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ${APP_ROLE}', target);
        END LOOP;
        EXECUTE format('GRANT USAGE ON SCHEMA public TO ${APP_ROLE}');
      END
      $$;
    `);
  } finally {
    await admin.end();
  }
}

export async function createAppPool() {
  const pool = new pg.Pool({
    connectionString: APP_DATABASE_URL,
    max: 10,
    options: "-c statement_timeout=15000",
  });
  await pool.query("SELECT 1");
  return pool;
}

export async function isDatabaseAvailable() {
  try {
    const admin = await connectAdmin();
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a restaurant with an owner membership, a branch, and a paid plan, all
 * through the privileged role so the fixture itself is not tenant-scoped.
 */
export async function seedRestaurant(admin, { name = "Test Cafe", slug } = {}) {
  const uniqueSlug = slug ?? `cafe-${randomUUID().slice(0, 8)}`;
  const results = await admin.query(
    `INSERT INTO users (email, normalized_email, display_name, status, email_verified_at, password_hash)
     VALUES ($1, $1, 'Owner', 'active', now(), '$argon2id$integration-only')
     RETURNING id`,
    [`${uniqueSlug}@example.com`],
  );
  const userId = results.rows[0].id;

  const restaurant = await admin.query(
    `INSERT INTO restaurants (name, slug, timezone, currency_code)
     VALUES ($1, $2, 'Asia/Karachi', 'PKR')
     RETURNING id`,
    [name, uniqueSlug],
  );
  const restaurantId = restaurant.rows[0].id;

  const branch = await admin.query(
    `INSERT INTO branches (restaurant_id, name, code)
     VALUES ($1, 'Main', 'main')
     RETURNING id`,
    [restaurantId],
  );

  await admin.query(
    `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, status, default_branch_id, joined_at)
     VALUES ($1, $2, 'owner', 'active', $3, now())`,
    [restaurantId, userId, branch.rows[0].id],
  );

  return {
    userId,
    restaurantId,
    branchId: branch.rows[0].id,
  };
}

/**
 * Seeds a plan and its price.
 *
 * Plan codes are constrained to uppercase by the schema, and a plan may only
 * have one price per currency, interval, and provider, so both lookups are
 * idempotent.
 */
export async function seedPlan(admin, { code = "STANDARD", provider = "stripe" } = {}) {
  const plan = await admin.query(
    `INSERT INTO plans (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [code, code.charAt(0) + code.slice(1).toLowerCase()],
  );
  const planId = plan.rows[0].id;

  const price = await admin.query(
    `INSERT INTO plan_prices (
       plan_id, provider, provider_price_id, currency_code, amount_minor, billing_interval
     ) VALUES ($1, $2, $3, 'PKR', 25000, 'month')
     ON CONFLICT (plan_id, currency_code, billing_interval, provider) DO UPDATE
       SET provider_price_id = EXCLUDED.provider_price_id
     RETURNING id`,
    [planId, provider, `price_${code.toLowerCase()}_${provider}`],
  );

  return { planId, priceId: price.rows[0].id };
}

export async function resetBillingState(admin) {
  await admin.query(`
    TRUNCATE webhook_events, provider_tenant_routes, billing_payments, audit_logs,
             subscriptions, billing_customers
    RESTART IDENTITY CASCADE
  `);
}