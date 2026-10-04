import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "011_partial_refunds_and_sales_reporting.sql",
);

describe("partial refunds & sales reporting migration contract", () => {
  it("is wrapped in a single transaction so it applies atomically", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.ok(sql.includes("BEGIN;"), "migration must open a transaction");
    assert.ok(sql.trimEnd().endsWith("COMMIT;"), "migration must commit");
  });

  it("widens the order payment-status constraint as a strict superset", async () => {
    const sql = await readFile(migrationPath, "utf8");

    // The replacement list must contain every legacy value so existing
    // rows stay valid, plus the new partial-refund states.
    assert.match(
      sql,
      /ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;/,
    );
    assert.match(
      sql,
      /CHECK \(payment_status IN \('unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded'\)\)/,
    );
    assert.match(
      sql,
      /ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_status_check;/,
    );
    assert.match(
      sql,
      /CHECK \(status IN \('pending', 'captured', 'voided', 'refunded', 'partially_refunded'\)\)/,
    );
  });

  it("stores refunds as tenant-owned rows with correct foreign keys", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const start = sql.indexOf("CREATE TABLE order_refunds (");
    const definition = sql.slice(start, sql.indexOf(");", start));

    assert.notEqual(start, -1);
    assert.match(definition, /restaurant_id uuid NOT NULL REFERENCES restaurants\(id\) ON DELETE RESTRICT/);
    assert.match(definition, /FOREIGN KEY \(restaurant_id, order_id\)\s+REFERENCES orders\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(definition, /FOREIGN KEY \(restaurant_id, branch_id\)\s+REFERENCES branches\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(definition, /FOREIGN KEY \(restaurant_id, created_by_user_id\)\s+REFERENCES restaurant_memberships\(restaurant_id, user_id\) ON DELETE RESTRICT/);
    assert.match(definition, /UNIQUE \(restaurant_id, id\)/);
    assert.match(definition, /UNIQUE \(restaurant_id, idempotency_key\)/);
  });

  it("uses integer minor units and positive quantities throughout", async () => {
    const sql = await readFile(migrationPath, "utf8");

    // Every monetary column is a bigint count of minor units, never
    // a floating-point type.
    for (const column of [
      "subtotal_refunded_minor",
      "tax_refunded_minor",
      "discount_refunded_minor",
      "charge_refunded_minor",
      "total_refunded_minor",
    ]) {
      assert.match(
        sql,
        new RegExp(`${column} bigint NOT NULL`),
        `${column} must be a bigint`,
      );
    }
    assert.match(sql, /total_refunded_minor bigint NOT NULL CHECK \(total_refunded_minor > 0\)/);
    assert.match(sql, /subtotal_refunded_minor bigint NOT NULL DEFAULT 0 CHECK \(subtotal_refunded_minor >= 0\)/);
    assert.match(sql, /tax_refunded_minor bigint NOT NULL DEFAULT 0 CHECK \(tax_refunded_minor >= 0\)/);
    assert.match(sql, /discount_refunded_minor bigint NOT NULL DEFAULT 0 CHECK \(discount_refunded_minor >= 0\)/);
    assert.match(sql, /charge_refunded_minor bigint NOT NULL DEFAULT 0 CHECK \(charge_refunded_minor >= 0\)/);

    // Refund item quantities are strictly positive and priced in minor units.
    assert.match(sql, /quantity numeric\(12, 4\) NOT NULL CHECK \(quantity > 0\)/);
    assert.match(sql, /unit_price_minor bigint NOT NULL CHECK \(unit_price_minor >= 0\)/);
    assert.match(sql, /line_total_minor bigint NOT NULL CHECK \(line_total_minor >= 0\)/);

    // Tender compensation amounts are strictly positive minor units.
    assert.match(sql, /amount_minor bigint NOT NULL CHECK \(amount_minor > 0\)/);

    // A non-empty reason is mandatory.
    assert.match(sql, /reason text NOT NULL CHECK \(length\(btrim\(reason\)\) >= 1\)/);
  });

  it("links refund items and tenders to their owning refund and tenant", async () => {
    const sql = await readFile(migrationPath, "utf8");

    const itemsStart = sql.indexOf("CREATE TABLE order_refund_items (");
    const itemsDef = sql.slice(itemsStart, sql.indexOf(");", itemsStart));
    assert.match(itemsDef, /FOREIGN KEY \(restaurant_id, refund_id\)\s+REFERENCES order_refunds\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(itemsDef, /FOREIGN KEY \(restaurant_id, order_item_id\)\s+REFERENCES order_items\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(itemsDef, /UNIQUE \(restaurant_id, id\)/);

    const tendersStart = sql.indexOf("CREATE TABLE order_refund_tenders (");
    const tendersDef = sql.slice(tendersStart, sql.indexOf(");", tendersStart));
    assert.match(tendersDef, /FOREIGN KEY \(restaurant_id, refund_id\)\s+REFERENCES order_refunds\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(tendersDef, /FOREIGN KEY \(restaurant_id, order_payment_id\)\s+REFERENCES order_payments\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(tendersDef, /FOREIGN KEY \(restaurant_id, financial_account_id\)\s+REFERENCES financial_accounts\(restaurant_id, id\) ON DELETE RESTRICT/);
    assert.match(tendersDef, /UNIQUE \(restaurant_id, id\)/);
  });

  it("adds indexes that support the hot refund and report queries", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(sql, /CREATE INDEX order_refunds_branch_time_idx\s+ON order_refunds \(restaurant_id, branch_id, created_at DESC\)/);
    assert.match(sql, /CREATE INDEX order_refunds_order_idx\s+ON order_refunds \(restaurant_id, order_id\)/);
    assert.match(sql, /CREATE INDEX order_refund_items_refund_idx\s+ON order_refund_items \(restaurant_id, refund_id\)/);
    assert.match(sql, /CREATE INDEX order_refund_tenders_refund_idx\s+ON order_refund_tenders \(restaurant_id, refund_id\)/);
  });

  it("enables and forces row-level security on every new tenant table", async () => {
    const sql = await readFile(migrationPath, "utf8");
    for (const table of ["order_refunds", "order_refund_items", "order_refund_tenders"]) {
      assert.ok(
        sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`),
        `${table} must enable RLS`,
      );
      assert.ok(
        sql.includes(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`),
        `${table} must force RLS`,
      );
      assert.match(
        sql,
        new RegExp(
          `CREATE POLICY ${table}_tenant_isolation ON ${table}\\s+USING \\(restaurant_id = current_restaurant_id\\(\\)\\)\\s+WITH CHECK \\(restaurant_id = current_restaurant_id\\(\\)\\)`,
        ),
        `${table} must have a tenant isolation policy`,
      );
    }
  });

  it("never joins across tenants in any new query surface", async () => {
    const sql = await readFile(migrationPath, "utf8");
    // The migration is DDL only; it must not introduce any cross-tenant
    // join or a policy that leaks another restaurant's rows.
    assert.doesNotMatch(sql, /JOIN\s+restaurants\s+ON\s+restaurants\.id\s*=\s*order_refunds\.restaurant_id/i);
    assert.doesNotMatch(sql, /USING\s*\(restaurant_id\s*!=\s*current_restaurant_id\(\)\)/i);
  });

  it("maintains the updated_at trigger on refunds", async () => {
    const sql = await readFile(migrationPath, "utf8");
    assert.match(
      sql,
      /CREATE TRIGGER order_refunds_set_updated_at BEFORE UPDATE ON order_refunds\s+FOR EACH ROW EXECUTE FUNCTION set_updated_at\(\);/,
    );
  });
});
