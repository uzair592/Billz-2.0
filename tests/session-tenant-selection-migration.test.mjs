import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "./helpers/legacy-source.mjs";

const migrationPath = path.join(
  projectRoot,
  "database",
  "migrations",
  "007_session_tenant_selection.sql",
);

describe("session tenant-selection migration contract", () => {
  it("exposes the authenticated user identity to row-level security", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(sql, /CREATE OR REPLACE FUNCTION current_user_id\(\)/i);
    assert.match(sql, /NULLIF\(current_setting\('app\.user_id', true\), ''\)::uuid/i);
  });

  it("lets a caller read only its own membership rows", async () => {
    const sql = await readFile(migrationPath, "utf8");

    assert.match(
      sql,
      /CREATE POLICY restaurant_memberships_self_read ON restaurant_memberships\s+FOR SELECT\s+USING \(user_id = current_user_id\(\)\)/i,
    );
    assert.match(
      sql,
      /CREATE POLICY restaurants_self_read ON restaurants\s+FOR SELECT/i,
    );
    assert.match(sql, /m\.user_id = current_user_id\(\)/i);
    assert.match(sql, /m\.status = 'active'/i);
  });

  it("does not widen write access to any tenant table", async () => {
    const sql = (await readFile(migrationPath, "utf8"))
      .replace(/--[^\n]*/g, "");

    assert.doesNotMatch(sql, /INSERT/i);
    assert.doesNotMatch(sql, /UPDATE/i);
    assert.doesNotMatch(sql, /DELETE/i);
    assert.doesNotMatch(sql, /DROP\s+(POLICY|ROW)/i);
    assert.equal((sql.match(/FOR SELECT/gi) ?? []).length, 2);
  });
});