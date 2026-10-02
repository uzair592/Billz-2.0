import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "006_order_cancellations.sql",
);

describe("order cancellation migration contract", () => {
  it("records a tenant-owned cancellation for each order", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const start = sql.indexOf("CREATE TABLE order_cancellations (");
    const definition = sql.slice(start, sql.indexOf(";", start));

    assert.notEqual(start, -1);
    assert.match(definition, /restaurant_id uuid NOT NULL REFERENCES restaurants\(id\)/i);
    assert.match(definition, /UNIQUE \(restaurant_id, order_id\)/i);
    assert.match(definition, /FOREIGN KEY \(restaurant_id, order_id\)/i);
    assert.match(definition, /REFERENCES orders\(restaurant_id, id\) ON DELETE RESTRICT/i);
    assert.match(definition, /refunded_minor bigint NOT NULL DEFAULT 0 CHECK \(refunded_minor >= 0\)/i);
    assert.match(definition, /CHECK \(jsonb_typeof\(restocked\) = 'array'\)/i);
  });

  it("isolates cancellations with the same row-level security as other POS data", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.ok(sql.includes("ALTER TABLE order_cancellations ENABLE ROW LEVEL SECURITY;"));
    assert.ok(sql.includes("ALTER TABLE order_cancellations FORCE ROW LEVEL SECURITY;"));
    assert.match(
      sql,
      /CREATE POLICY order_cancellations_tenant_isolation ON order_cancellations\s+USING \(restaurant_id = current_restaurant_id\(\)\)\s+WITH CHECK \(restaurant_id = current_restaurant_id\(\)\)/i,
    );
  });

  it("allows only one stock reversal per order and stock item", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(
      sql,
      /CREATE UNIQUE INDEX stock_movements_sale_reversal_key_idx\s+ON stock_movements \(restaurant_id, order_id, stock_item_id\)\s+WHERE movement_type = 'sale_reversal'/i,
    );
  });
});
