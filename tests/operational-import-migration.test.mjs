import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

describe("legacy operational key migration", () => {
  it("makes legacy financial-account reconciliation tenant unique", async () => {
    const sql = await readFile(path.join(
      projectRoot, "database", "migrations", "005_legacy_operational_keys.sql",
    ), "utf8");
    assert.match(sql, /ALTER TABLE financial_accounts ADD COLUMN legacy_account_id text/i);
    assert.match(sql, /UNIQUE\s*\(restaurant_id, legacy_account_id\)/i);
  });
});
