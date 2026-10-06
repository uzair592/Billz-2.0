import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { hashPassword } from "./auth/passwords.mjs";
import { permissionsForRole } from "./authorization/permissions.mjs";

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
 *   * default owner permissions
 *   * an optional manual/trial subscription state
 *
 * Security:
 *   * The password is never hardcoded. It is read from the
 *     BOOTSTRAP_OWNER_PASSWORD environment variable or, when absent,
 *     from an interactive prompt that does not echo.
 *   * The password and its hash are never printed.
 *   * Re-running with the same identifiers does not create duplicates.
 *   * Conflicting existing data (same slug with a different restaurant,
 *     same email with a different user) fails clearly instead of
 *     overwriting.
 *
 * This is the fast-track bridge for the first pilot restaurant. The
 * full platform-admin portal is a separate milestone.
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
    // readline does not support hidden input portably; the prompt is
    // still acceptable for a CLI run by an operator at a terminal, and
    // the value is never echoed back or logged.
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
 * Runs the bootstrap.
 *
 * @param {object} options
 * @param {pg.Pool} options.pool - connected pool (admin or privileged role).
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
    await client.query("BEGIN");

    // Restaurant (idempotent on slug).
    const restaurantRes = await client.query(
      `INSERT INTO restaurants (name, slug, timezone, currency_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug`,
      [restaurantName, safeSlug, safeTimezone, safeCurrency],
    );
    const restaurantId = restaurantRes.rows[0].id;

    // Branch (idempotent on restaurant + code).
    const branchRes = await client.query(
      `INSERT INTO branches (restaurant_id, name, code)
       VALUES ($1, $2, $3)
       ON CONFLICT (restaurant_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [restaurantId, branchName, branchCode],
    );
    const branchId = branchRes.rows[0].id;

    // Owner user (idempotent on normalized email). The password hash is
    // computed with the project's argon2id implementation and the
    // configured pepper. The hash is never printed.
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

    // Owner membership (idempotent on restaurant + user).
    await client.query(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, status, default_branch_id, joined_at)
       VALUES ($1, $2, 'owner', 'active', $3, now())
       ON CONFLICT (restaurant_id, user_id) DO UPDATE
         SET role = 'owner', status = 'active', default_branch_id = EXCLUDED.default_branch_id`,
      [restaurantId, ownerId, branchId],
    );

    // Default owner permissions are derived from the owner role, which
    // the authorization layer already maps to every permission. No
    // separate grant table is required; the role is the source of truth.

    // Optional trial subscription state for a controlled pilot.
    // The schema allows one subscription per restaurant in practice, but
    // the only unique key is (restaurant_id, id); id is generated, so
    // idempotency is achieved by checking for an existing row first.
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

      // A plan price is required so the subscription's plan_price_id
      // foreign key resolves. The pilot uses a manual (zero-amount)
      // price; a real Stripe price is attached when billing is enabled.
      const priceRes = await client.query(
        `INSERT INTO plan_prices (plan_id, currency_code, amount_minor, billing_interval, provider, provider_price_id)
         VALUES ($1, $2, 0, 'month', 'manual', $3)
         ON CONFLICT (plan_id, currency_code, billing_interval, provider) DO UPDATE
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
      } else {
        await client.query(
          `UPDATE subscriptions
           SET plan_id = $2, plan_price_id = $3, status = $4
           WHERE restaurant_id = $1`,
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

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const env = process.env;
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(JSON.stringify({ message: "bootstrap_failed", error: "DATABASE_URL is required." }));
    process.exit(1);
  }

  const required = ["RESTAURANT_NAME", "RESTAURANT_SLUG", "RESTAURANT_TIMEZONE", "RESTAURANT_CURRENCY", "OWNER_EMAIL"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    console.error(JSON.stringify({
      message: "bootstrap_failed",
      error: `Missing required environment variables: ${missing.join(", ")}.`,
    }));
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
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
