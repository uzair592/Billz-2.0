import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "002_tenant_pos.sql",
);

const tenantTables = [
  "business_settings",
  "receipt_settings",
  "dining_areas",
  "restaurant_tables",
  "menu_categories",
  "menu_subcategories",
  "menu_items",
  "menu_item_components",
  "stock_items",
  "menu_item_recipe_items",
  "inventory_balances",
  "financial_accounts",
  "orders",
  "order_items",
  "order_item_extras",
  "order_charges",
  "order_payments",
  "order_edit_events",
  "stock_purchases",
  "stock_purchase_items",
  "stock_movements",
  "expense_categories",
  "expenses",
  "expense_attachments",
  "account_transfers",
  "ledger_entries",
];

describe("tenant POS migration contract", () => {
  it("creates each existing POS domain collection as a tenant-owned table", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of tenantTables) {
      const tableStart = sql.indexOf(`CREATE TABLE ${table} (`);
      assert.notEqual(tableStart, -1, `Missing table: ${table}`);

      const tableEnd = sql.indexOf(";", tableStart);
      const definition = sql.slice(tableStart, tableEnd);
      assert.match(
        definition,
        /restaurant_id uuid (?:NOT NULL )?(?:PRIMARY KEY )?REFERENCES restaurants\(id\)/i,
        `${table} is missing its restaurant ownership column`,
      );
    }
  });

  it("enables and forces row-level security for every POS table", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of tenantTables) {
      assert.ok(
        sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`),
        `RLS is not enabled for ${table}`,
      );
      assert.ok(
        sql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`),
        `RLS is not forced for ${table}`,
      );
    }
  });

  it("scopes business sequence numbers and idempotency keys by restaurant", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /UNIQUE\s*\(restaurant_id, branch_id, order_number\)/i);
    assert.ok(
      (sql.match(/UNIQUE\s*\(restaurant_id, idempotency_key\)/gi) ?? []).length >= 3,
    );
  });

  it("uses tenant-composite references for order-owned records", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of ["order_items", "order_charges", "order_payments", "order_edit_events"]) {
      const start = sql.indexOf(`CREATE TABLE ${table} (`);
      const end = sql.indexOf(";", start);
      const definition = sql.slice(start, end);
      assert.match(definition, /FOREIGN KEY\s*\(restaurant_id, order_id\)/i);
      assert.match(definition, /REFERENCES orders\(restaurant_id, id\)/i);
    }
  });

  it("stores customer details as order snapshots without inventing a customer directory", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /customer_name text/i);
    assert.match(sql, /customer_phone text/i);
    assert.doesNotMatch(sql, /CREATE TABLE customers/i);
  });
});
