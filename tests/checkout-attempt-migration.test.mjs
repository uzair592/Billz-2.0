import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "010_checkout_attempt_subscriptions.sql",
);

describe("checkout attempt subscription migration contract", () => {
  it("links an attempt to the exact subscription within the same tenant", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /ADD COLUMN subscription_id uuid/i);
    assert.match(
      sql,
      /FOREIGN KEY \(restaurant_id, subscription_id\)\s+REFERENCES subscriptions \(restaurant_id, id\)\s+ON DELETE RESTRICT/i,
    );
  });

  it("indexes retry lookups without weakening checkout-attempt RLS", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(
      sql,
      /CREATE INDEX checkout_attempts_subscription_idx\s+ON checkout_attempts \(restaurant_id, subscription_id\)\s+WHERE subscription_id IS NOT NULL/i,
    );
    assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY/i);
    assert.doesNotMatch(sql, /NO FORCE ROW LEVEL SECURITY/i);
  });
});
