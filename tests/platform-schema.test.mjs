import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "001_platform_foundation.sql",
);

const requiredTables = [
  "users",
  "restaurants",
  "branches",
  "restaurant_memberships",
  "devices",
  "sessions",
  "email_verification_tokens",
  "password_reset_tokens",
  "plans",
  "plan_prices",
  "billing_customers",
  "subscriptions",
  "billing_payments",
  "webhook_events",
  "audit_logs",
];

const tenantTables = [
  "restaurants",
  "branches",
  "restaurant_memberships",
  "devices",
  "billing_customers",
  "subscriptions",
  "billing_payments",
  "audit_logs",
];

describe("platform foundation migration contract", () => {
  it("creates the required identity, tenant, billing, and audit tables", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of requiredTables) {
      assert.match(
        sql,
        new RegExp(`CREATE TABLE ${table}\\s*\\(`, "i"),
        `Missing table: ${table}`,
      );
    }
  });

  it("enables row-level security for every tenant-owned foundation table", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of tenantTables) {
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "i"),
        `RLS is not enabled for ${table}`,
      );
      assert.match(
        sql,
        new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "i"),
        `RLS is not forced for ${table}`,
      );
    }
  });

  it("makes provider webhook events idempotent", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /UNIQUE\s*\(provider, provider_event_id\)/i);
    assert.match(sql, /signature_verified boolean NOT NULL DEFAULT false/i);
  });

  it("binds verification tokens to the owner's restaurant membership", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const start = sql.indexOf("CREATE TABLE email_verification_tokens");
    const end = sql.indexOf(";", start);
    const definition = sql.slice(start, end);

    assert.match(definition, /restaurant_id uuid NOT NULL/i);
    assert.match(definition, /FOREIGN KEY\s*\(restaurant_id, user_id\)/i);
    assert.match(definition, /REFERENCES restaurant_memberships\(restaurant_id, user_id\)/i);
  });

  it("keeps restaurant subscriptions separate from employee memberships", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const subscriptions = sql.slice(
      sql.indexOf("CREATE TABLE subscriptions"),
      sql.indexOf("CREATE TABLE billing_payments"),
    );

    assert.match(subscriptions, /restaurant_id uuid NOT NULL/i);
    assert.doesNotMatch(subscriptions, /user_id/i);
  });

  it("uses composite foreign keys to prevent cross-restaurant billing links", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(
      sql,
      /FOREIGN KEY\s*\(restaurant_id, billing_customer_id\)[\s\S]*?REFERENCES billing_customers\(restaurant_id, id\)/i,
    );
    assert.match(
      sql,
      /FOREIGN KEY\s*\(restaurant_id, subscription_id\)[\s\S]*?REFERENCES subscriptions\(restaurant_id, id\)/i,
    );
  });
});
