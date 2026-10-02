import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(projectRoot, "database", "migrations", "004_menu_offers.sql");

describe("authoritative menu offer migration contract", () => {
  it("stores item and category offers as tenant-owned records", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const table of ["menu_item_offers", "menu_category_offers"]) {
      assert.match(sql, new RegExp(`CREATE TABLE ${table}`, "i"));
      assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, "i"));
      assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, "i"));
      assert.match(sql, new RegExp(`CREATE POLICY ${table}_tenant_isolation`, "i"));
    }
  });

  it("requires internally consistent category discount units", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(sql, /discount_type = 'flat' AND discount_minor > 0 AND discount_percent IS NULL/i);
    assert.match(sql, /discount_type = 'percent' AND discount_minor IS NULL/i);
    assert.match(sql, /discount_percent > 0 AND discount_percent <= 100/i);
  });
});
