import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "008_billing_checkout_and_routes.sql",
);

describe("billing checkout migration contract", () => {
  it("allows a subscription row to exist before any money moves", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;/);
    assert.match(sql, /ADD CONSTRAINT subscriptions_status_check\s+CHECK \(status IN \([\s\S]*?'pending_checkout'/i);
    // The one-slot-per-restaurant index has to cover the new state, otherwise a
    // restaurant could start a second checkout and pay twice.
    assert.match(sql, /CREATE UNIQUE INDEX subscriptions_one_current_per_restaurant\s+ON subscriptions \(restaurant_id\)\s+WHERE status IN \([\s\S]*?'pending_checkout'/i);
  });

  it("maps a verified provider reference to a restaurant without tenant context", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const start = sql.indexOf("CREATE TABLE provider_tenant_routes (");
    const definition = sql.slice(start, sql.indexOf(");", start));

    assert.notEqual(start, -1);
    assert.match(definition, /provider text NOT NULL/i);
    assert.match(definition, /provider_reference text NOT NULL/i);
    assert.match(
      definition,
      /CHECK \(provider_reference_type IN \('customer', 'subscription', 'checkout_session'\)\)/i,
    );
    assert.match(definition, /restaurant_id uuid NOT NULL REFERENCES restaurants\(id\) ON DELETE RESTRICT/i);
    assert.match(definition, /PRIMARY KEY \(provider, provider_reference\)/i);
    assert.match(
      sql,
      /CREATE INDEX provider_tenant_routes_restaurant_idx\s+ON provider_tenant_routes \(restaurant_id, provider\)/i,
    );
  });

  it("stores no payment details in the routing table", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const start = sql.indexOf("CREATE TABLE provider_tenant_routes (");
    const definition = sql.slice(start, sql.indexOf(");", start));

    const forbidden = ["card", "pan", "cvc", "secret", "token", "amount"];
    for (const word of forbidden) {
      assert.ok(
        !new RegExp(word, "i").test(definition),
        `provider_tenant_routes must not hold ${word}`,
      );
    }
  });

  it("leaves the routing table reachable from the webhook boundary", async () => {
    const sql = await readFile(migrationPath, "utf8");

    // A verified webhook has no tenant context, so row-level security on this
    // table would make every event unattributable and silently unapplied.
    assert.ok(!/ALTER TABLE provider_tenant_routes ENABLE ROW LEVEL SECURITY/i.test(sql));
    assert.ok(!/CREATE POLICY.*ON provider_tenant_routes/is.test(sql));
  });
});