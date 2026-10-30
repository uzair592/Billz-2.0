import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { hashPassword } from "./auth/passwords.mjs";
import { permissionsForRole } from "./authorization/permissions.mjs";
import { createDatabasePool } from "./database/pool.mjs";

/**
 * Production bootstrap CLI for the first restaurant.
 *
 * Creates, idempotently, the minimum viable tenant for a controlled
 * pilot:
 *   * a restaurant (with slug, timezone, currency)
 *   * an initial branch
 *   * an owner user (password hashed with the project's argon2id
 *     implementation and the configured pepper)
 *   * an owner membership with default branch
 *   * default business settings
 *   * default tenant storage allowance (5 GB)
 *   * a default active cash financial account
 *   * default owner permissions
 *   * an optional manual/trial subscription state
 *
 * Security:
 *   * CONTROL_DATABASE_URL is required in production and preferred in all
 *     environments. Provisioning is never permitted using a normal POS role.
 *   * The role is checked for BYPASSRLS or superuser status; fails closed
 *     with UNSUITABLE_PROVISIONING_ROLE if the role is restricted.
 *   * The password is never hardcoded. It is read from the
 *     BOOTSTRAP_OWNER_PASSWORD environment variable or, when absent,
 *     from an interactive prompt that does not echo.
 *   * The password and its hash are never printed.
 *   * Re-running with the same identifiers does not create duplicate
 *     cash accounts, reset passwords, reset balances, or overwrite settings.
 *   * Conflicting existing data (same slug with a different restaurant,
 *     same email with a different user) fails clearly instead of
 *     overwriting.
 */

const OWNER_PERMISSIONS = permissionsForRole("owner");

function fail(message, code = "BOOTSTRAP_FAILED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function promptHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function readPassword(env) {
  const fromEnv = env.BOOTSTRAP_OWNER_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

async function resolvePassword(env, interactive) {
  const fromEnv = readPassword(env);
  if (fromEnv) {
    if (fromEnv.length < 10) {
      fail("BOOTSTRAP_OWNER_PASSWORD must be at least 10 characters.");
    }
    return fromEnv;
  }
  if (!interactive) {
    fail(
      "No owner password provided. Set BOOTSTRAP_OWNER_PASSWORD or run interactively.",
      "BOOTSTRAP_PASSWORD_REQUIRED",
    );
  }
  const password = await promptHidden("Owner password (input hidden): ");
  if (!password || password.length < 10) {
    fail("Owner password must be at least 10 characters.");
  }
  return password;
}

function validateSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug)) {
    fail("Restaurant slug must be lowercase letters, numbers, and hyphens, starting and ending with alphanumeric.");
  }
  return slug;
}

function validateCurrency(code) {
  if (!/^[A-Z]{3}$/.test(code)) {
    fail("Currency must be a three-letter ISO 4217 code (e.g. PKR).");
  }
  return code;
}

function validateTimezone(timezone) {
  if (!timezone || timezone.length === 0) {
    fail("Timezone is required (e.g. Asia/Karachi).");
  }
  return timezone;
}

/**
 * Resolves the provisioning database URL from the environment.
 * Requires CONTROL_DATABASE_URL in production, preserving development
 * compatibility with fallback to DATABASE_URL only when non-production.
 */
export function resolveProvisioningDatabaseUrl(env = process.env) {
  const isProduction = env.NODE_ENV === "production";
  if (isProduction) {
    if (!env.CONTROL_DATABASE_URL) {
      fail("CONTROL_DATABASE_URL is required in production.", "CONFIGURATION_INVALID");
    }
    return env.CONTROL_DATABASE_URL;
  }
  const url = env.CONTROL_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    fail("CONTROL_DATABASE_URL or DATABASE_URL is required.", "CONFIGURATION_INVALID");
  }
  return url;
}

/**
 * Verifies that the connected database role has sufficient privilege (BYPASSRLS or superuser)
 * to provision tenant resources across row-level security boundaries.
 * Never allows normal restricted POS application roles to attempt provisioning.
 */
export async function assertProvisioningRoleSuitability(client) {
  const res = await client.query(
    `SELECT rolname, rolsuper, rolbypassrls
     FROM pg_roles
     WHERE rolname = current_user`,
  );
  const role = res.rows[0];
  if (!role || (!role.rolsuper && !role.rolbypassrls)) {
    const roleName = role?.rolname || "unknown";
    fail(
      `Database role "${roleName}" is unsuitable for restaurant provisioning. Provisioning requires a privileged control role with BYPASSRLS or superuser status (configured via CONTROL_DATABASE_URL). Never use or grant BYPASSRLS to the normal POS application role.`,
      "UNSUITABLE_PROVISIONING_ROLE",
    );
  }
}

/**
 * Runs the bootstrap.
 *
 * @param {object} options
 * @param {pg.Pool} options.pool - connected pool (privileged control or admin role).
 * @param {object} options.input - bootstrap parameters.
 * @param {object} [options.logger] - structured logger.
 * @param {boolean} [options.interactive] - allow an interactive password prompt.
 */
export async function bootstrapFirstRestaurant({
  pool,
  input,
  logger = console,
  interactive = false,
}) {
  const {
    restaurantName,
    slug,
    timezone,
    currencyCode,
    branchName = "Main",
    branchCode = "main",
    ownerEmail,
    ownerDisplayName = "Owner",
    ownerUsername = ownerEmail,
    subscriptionPlan = "STANDARD",
    subscriptionStatus = "trial",
    pepper,
  } = input;

  if (!restaurantName) fail("restaurantName is required.");
  if (!ownerEmail) fail("ownerEmail is required.");
  if (!pepper || pepper.length < 16) fail("A password pepper of at least 16 characters is required.");

  const safeSlug = validateSlug(slug);
  const safeCurrency = validateCurrency(currencyCode);
  const safeTimezone = validateTimezone(timezone);
  const normalizedEmail = String(ownerEmail).trim().toLowerCase();

  const password = await resolvePassword(
    { BOOTSTRAP_OWNER_PASSWORD: input.ownerPassword },
    interactive && !input.ownerPassword,
  );

  const client = await pool.connect();
  try {
    // Check role suitability before mutations.
    await assertProvisioningRoleSuitability(client);

    await client.query("BEGIN");

    // Restaurant (idempotent on slug).
    const restaurantRes = await client.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code, code)
       VALUES ($1, $2, $3, $4, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug`,
      [restaurantName, safeSlug, safeTimezone, safeCurrency],
    );
    const restaurantId = restaurantRes.rows[0].id;

    // Branch (idempotent on restaurant + code).
    const branchRes = await client.query(
      `INSERT INTO branches (restaurant_id, name, code, is_default)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (restaurant_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [restaurantId, branchName, branchCode],
    );
    const branchId = branchRes.rows[0].id;

    // Owner user (idempotent on normalized email). The password hash is
    // computed with the project's argon2id implementation and the
    // configured pepper. The hash is never printed or overwritten on conflict.
    const passwordHash = await hashPassword(password, pepper);
    const userRes = await client.query(
      `INSERT INTO users (email, normalized_email, display_name, status, email_verified_at, password_hash)
       VALUES ($1, $2, $3, 'active', now(), $4)
       ON CONFLICT (normalized_email) DO UPDATE
         SET display_name = EXCLUDED.display_name
       RETURNING id, email`,
      [normalizedEmail, normalizedEmail, ownerDisplayName, passwordHash],
    );
    const ownerId = userRes.rows[0].id;
    const scoped = await client.query(`UPDATE users SET restaurant_id = $2,
      username = COALESCE(username, $3), normalized_username = COALESCE(normalized_username, lower(btrim($3)))
      WHERE id = $1 AND (restaurant_id IS NULL OR restaurant_id = $2) RETURNING id`,
      [ownerId, restaurantId, ownerUsername]);
    if (!scoped.rows[0]) fail("Owner email belongs to another restaurant.");

    // Owner membership (idempotent on restaurant + user).
    await client.query(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, status, default_branch_id, joined_at)
       VALUES ($1, $2, 'owner', 'active', $3, now())
       ON CONFLICT (restaurant_id, user_id) DO UPDATE
         SET role = 'owner', status = 'active', default_branch_id = EXCLUDED.default_branch_id`,
      [restaurantId, ownerId, branchId],
    );

    // Business settings (idempotent; do not overwrite existing settings).
    await client.query(
      `INSERT INTO business_settings (restaurant_id, default_branch_id, business_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurantId, branchId, restaurantName],
    );

    // Tenant storage allowance (5 GB default quota; do not reset on repeat runs).
    await client.query(
      `INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes)
       VALUES ($1, 5368709120, 0)
       ON CONFLICT (restaurant_id) DO NOTHING`,
      [restaurantId],
    );

    // Default active cash financial account (atomically provisioned; avoid duplicate or resetting balances).
    const existingCash = await client.query(
      `SELECT id, is_active FROM financial_accounts
       WHERE restaurant_id = $1 AND branch_id = $2 AND account_type = 'cash'
       LIMIT 1`,
      [restaurantId, branchId],
    );
    if (existingCash.rows.length === 0) {
      const nameConflict = await client.query(
        `SELECT id, account_type FROM financial_accounts
         WHERE restaurant_id = $1 AND display_name = 'Cash'`,
        [restaurantId],
      );
      let cashName = "Cash";
      if (nameConflict.rows.length > 0 && nameConflict.rows[0].account_type !== "cash") {
        cashName = "Default Cash";
      }
      await client.query(
        `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name, is_active)
         VALUES ($1, $2, 'cash', $3, true)
         ON CONFLICT (restaurant_id, display_name) DO NOTHING`,
        [restaurantId, branchId, cashName],
      );
    }

    // Optional trial subscription state for a controlled pilot.
    // If a subscription already exists, do not overwrite it.
    if (subscriptionStatus) {
      const validStatus = subscriptionStatus === "trial" ? "trialing" : subscriptionStatus;
      if (!["trialing", "active", "past_due", "cancel_at_period_end", "cancelled", "expired", "suspended"].includes(validStatus)) {
        fail(`subscriptionStatus must be a valid subscription status, not "${subscriptionStatus}".`);
      }

      const planRes = await client.query(
        `INSERT INTO plans (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [subscriptionPlan, subscriptionPlan.charAt(0) + subscriptionPlan.slice(1).toLowerCase()],
      );
      const planId = planRes.rows[0].id;

      const priceRes = await client.query(
        `INSERT INTO plan_prices (plan_id, currency_code, amount_minor, billing_interval, provider, provider_price_id)
         VALUES ($1, $2, 0, 'month', 'manual', $3)
         ON CONFLICT (plan_id, currency_code, billing_interval, provider) WHERE is_active DO UPDATE
           SET provider_price_id = EXCLUDED.provider_price_id
         RETURNING id`,
        [planId, safeCurrency, `manual_${subscriptionPlan.toLowerCase()}_month`],
      );
      const priceId = priceRes.rows[0].id;

      const existing = await client.query(
        "SELECT id FROM subscriptions WHERE restaurant_id = $1",
        [restaurantId],
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO subscriptions (
             restaurant_id, plan_id, plan_price_id, provider, status,
             current_period_start, current_period_end, trial_ends_at
           ) VALUES ($1, $2, $3, 'manual', $4, now(), now() + interval '30 days', now() + interval '14 days')`,
          [restaurantId, planId, priceId, validStatus],
        );
      }
    }

    await client.query("COMMIT");

    logger.info?.({
      message: "bootstrap_complete",
      restaurantSlug: safeSlug,
      restaurantId,
      branchId,
      ownerEmail: normalizedEmail,
      subscriptionStatus: subscriptionStatus || "none",
    });

    return {
      restaurantId,
      restaurantSlug: safeSlug,
      branchId,
      ownerId,
      ownerEmail: normalizedEmail,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    // Surface a clear conflict without leaking the password or hash.
    if (error.code === "23505" || error.code === "23503") {
      fail(
        `Bootstrap conflict: ${error.constraint ?? "unique constraint"} violated. `
        + "Existing data was not overwritten.",
        "BOOTSTRAP_CONFLICT",
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Idempotently repairs existing restaurants that lack any cash account.
 *
 * Rules:
 * - Finds restaurants that have NO cash account (neither active nor inactive) in financial_accounts.
 * - For each such restaurant, identifies its default or primary branch.
 * - Inserts a default active cash account ('cash', 'Cash', is_active = true) for that branch.
 * - Never reactivates deliberately disabled (is_active = false) accounts.
 *
 * @param {object} options
 * @param {pg.Pool} options.pool - connected privileged pool.
 * @param {object} [options.logger] - structured logger.
 * @returns {Promise<{repairedCount: number, repairedRestaurants: Array<{id: string, name: string, branchId: string}>}>}
 */
export async function repairMissingCashAccounts({ pool, logger = console }) {
  const client = await pool.connect();
  try {
    await assertProvisioningRoleSuitability(client);
    await client.query("BEGIN");

    // Acquire transaction advisory lock to guarantee concurrent repair runs are serialized safely
    await client.query("SELECT pg_advisory_xact_lock(839217421)");

    const candidatesRes = await client.query(`
      SELECT r.id, r.name,
             COALESCE(
               (SELECT b.id FROM branches b WHERE b.restaurant_id = r.id AND b.is_default = true LIMIT 1),
               (SELECT b.id FROM branches b WHERE b.restaurant_id = r.id ORDER BY b.created_at ASC LIMIT 1)
             ) AS branch_id,
             COALESCE(
               (SELECT b.name FROM branches b WHERE b.restaurant_id = r.id AND b.is_default = true LIMIT 1),
               (SELECT b.name FROM branches b WHERE b.restaurant_id = r.id ORDER BY b.created_at ASC LIMIT 1)
             ) AS branch_name
      FROM restaurants r
      WHERE NOT EXISTS (
        SELECT 1 FROM financial_accounts fa
        WHERE fa.restaurant_id = r.id AND fa.account_type = 'cash'
      )
      FOR UPDATE OF r
    `);

    const repaired = [];
    for (const row of candidatesRes.rows) {
      if (!row.branch_id) {
        logger.warn?.({
          message: "repair_missing_cash_account_skipped_no_branch",
          restaurantId: row.id,
          restaurantName: row.name,
        });
        continue;
      }

      // Check whether a cash account already exists for this restaurant and branch
      const cashCheck = await client.query(
        `SELECT id FROM financial_accounts
         WHERE restaurant_id = $1 AND branch_id = $2 AND account_type = 'cash'`,
        [row.id, row.branch_id],
      );
      if (cashCheck.rows.length > 0) continue;

      // Handle account-name conflict clearly if 'Cash' is already taken by a non-cash account
      const existingName = await client.query(
        `SELECT id, account_type FROM financial_accounts
         WHERE restaurant_id = $1 AND display_name = 'Cash'`,
        [row.id],
      );
      let accountName = "Cash";
      if (existingName.rows.length > 0) {
        accountName = row.branch_name ? `Cash - ${row.branch_name}` : "Default Cash";
        logger.warn?.({
          message: "repair_cash_account_name_conflict",
          restaurantId: row.id,
          restaurantName: row.name,
          originalName: "Cash",
          resolvedName: accountName,
        });
      }

      const insertRes = await client.query(
        `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name, is_active)
         VALUES ($1, $2, 'cash', $3, true)
         ON CONFLICT (restaurant_id, display_name) DO NOTHING
         RETURNING id, display_name`,
        [row.id, row.branch_id, accountName],
      );

      // Only report accounts that were actually inserted
      if (insertRes.rows.length > 0) {
        repaired.push({
          id: row.id,
          name: row.name,
          branchId: row.branch_id,
          accountId: insertRes.rows[0].id,
          accountName: insertRes.rows[0].display_name,
        });
      }
    }

    await client.query("COMMIT");
    logger.info?.({
      message: "repair_missing_cash_accounts_complete",
      repairedCount: repaired.length,
      repaired,
    });
    return { repairedCount: repaired.length, repairedRestaurants: repaired };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const env = process.env;
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Restaurant Provisioning CLI

Usage:
  node src/server/bootstrap-first-restaurant.mjs
  node src/server/bootstrap-first-restaurant.mjs --repair-cash-accounts

Environment variables:
  CONTROL_DATABASE_URL    Required in production; PostgreSQL connection URL with BYPASSRLS or superuser role.
  DATABASE_URL            Fallback in development/test environments.
  DATABASE_SSL_MODE       Optional: disable, require, or verify-full.
  DATABASE_SSL_CA         Optional: path or content of custom CA certificate.
  RESTAURANT_NAME         Restaurant display name (e.g. "Pizza Palace").
  RESTAURANT_SLUG         URL slug for restaurant (e.g. "pizza-palace").
  RESTAURANT_TIMEZONE     IANA timezone string (e.g. "Asia/Karachi").
  RESTAURANT_CURRENCY     3-letter ISO currency code (e.g. "PKR").
  OWNER_EMAIL             Email for the primary owner account.
  OWNER_USERNAME          Optional username (defaults to OWNER_EMAIL).
  OWNER_DISPLAY_NAME      Optional display name (defaults to "Owner").
  BOOTSTRAP_OWNER_PASSWORD Owner password (min 10 chars). Prompted if TTY and absent.
  PASSWORD_PEPPER         Server password pepper string (min 16 chars).
  SUBSCRIPTION_PLAN       Subscription plan code (defaults to "STANDARD").
  SUBSCRIPTION_STATUS     Subscription status (defaults to "trial").
`);
    process.exit(0);
  }

  let databaseUrl;
  try {
    databaseUrl = resolveProvisioningDatabaseUrl(env);
  } catch (err) {
    console.error(JSON.stringify({ message: "bootstrap_failed", error: err.message, code: err.code }));
    process.exit(1);
  }

  const pool = createDatabasePool({ ...env, DATABASE_URL: databaseUrl }, console);

  if (args.includes("--repair-cash-accounts")) {
    repairMissingCashAccounts({ pool, logger: console })
      .then((res) => {
        console.log(JSON.stringify({ message: "repair_complete", ...res }));
        return pool.end();
      })
      .catch((error) => {
        console.error(JSON.stringify({
          message: "repair_failed",
          error: error.message,
          code: error.code,
        }));
        pool.end().finally(() => process.exit(1));
      });
  } else {
    const required = ["RESTAURANT_NAME", "RESTAURANT_SLUG", "RESTAURANT_TIMEZONE", "RESTAURANT_CURRENCY", "OWNER_EMAIL"];
    const missing = required.filter((key) => !env[key]);
    if (missing.length > 0) {
      console.error(JSON.stringify({
        message: "bootstrap_failed",
        error: `Missing required environment variables: ${missing.join(", ")}.`,
      }));
      pool.end().finally(() => process.exit(1));
    } else {
      bootstrapFirstRestaurant({
        pool,
        input: {
          restaurantName: env.RESTAURANT_NAME,
          slug: env.RESTAURANT_SLUG,
          timezone: env.RESTAURANT_TIMEZONE,
          currencyCode: env.RESTAURANT_CURRENCY,
          branchName: env.BRANCH_NAME ?? "Main",
          branchCode: env.BRANCH_CODE ?? "main",
          ownerEmail: env.OWNER_EMAIL,
          ownerUsername: env.OWNER_USERNAME || env.OWNER_EMAIL,
          ownerDisplayName: env.OWNER_DISPLAY_NAME ?? "Owner",
          ownerPassword: env.BOOTSTRAP_OWNER_PASSWORD,
          subscriptionPlan: env.SUBSCRIPTION_PLAN ?? "STANDARD",
          subscriptionStatus: env.SUBSCRIPTION_STATUS ?? "trial",
          pepper: env.PASSWORD_PEPPER,
        },
        logger: console,
        interactive: process.stdin.isTTY === true,
      })
        .then(() => pool.end())
        .catch((error) => {
          console.error(JSON.stringify({
            message: "bootstrap_failed",
            error: error.message,
            code: error.code,
          }));
          pool.end().finally(() => process.exit(1));
        });
    }
  }
}
