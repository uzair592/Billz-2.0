import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "003_order_idempotency.sql",
);

describe("transactional order migration contract", () => {
  it("makes order retries unique inside each restaurant", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(sql, /ALTER TABLE orders ADD COLUMN idempotency_key uuid/i);
    assert.match(sql, /UNIQUE\s*\(restaurant_id, idempotency_key\)/i);
    assert.match(sql, /ALTER COLUMN idempotency_key SET NOT NULL/i);
  });

  it("creates a tenant-isolated per-branch order sequence", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(sql, /CREATE TABLE order_sequences/i);
    assert.match(sql, /PRIMARY KEY\s*\(restaurant_id, branch_id\)/i);
    assert.match(sql, /ALTER TABLE order_sequences ENABLE ROW LEVEL SECURITY/i);
    assert.match(sql, /ALTER TABLE order_sequences FORCE ROW LEVEL SECURITY/i);
    assert.match(sql, /CREATE POLICY order_sequences_tenant_isolation/i);
  });
});
