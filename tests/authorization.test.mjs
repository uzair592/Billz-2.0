import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PERMISSION,
  hasPermission,
  permissionsForRole,
  requirePermission,
} from "../src/server/authorization/permissions.mjs";

describe("restaurant role permissions", () => {
  it("allows owners to manage subscription and staff", () => {
    assert.equal(hasPermission("owner", PERMISSION.BILLING_MANAGE), true);
    assert.equal(hasPermission("owner", PERMISSION.MEMBERS_MANAGE), true);
  });

  it("allows managers to operate the business but not manage billing", () => {
    assert.equal(hasPermission("manager", PERMISSION.MENU_MANAGE), true);
    assert.equal(hasPermission("manager", PERMISSION.REPORT_VIEW), true);
    assert.equal(hasPermission("manager", PERMISSION.BILLING_MANAGE), false);
  });

  it("limits cashier and kitchen access", () => {
    assert.equal(hasPermission("cashier", PERMISSION.PAYMENT_PROCESS), true);
    assert.equal(hasPermission("cashier", PERMISSION.INVENTORY_MANAGE), false);
    assert.equal(hasPermission("kitchen", PERMISSION.KITCHEN_UPDATE), true);
    assert.equal(hasPermission("kitchen", PERMISSION.PAYMENT_PROCESS), false);
  });

  it("denies unknown roles and raises a consistent authorization error", () => {
    assert.deepEqual(permissionsForRole("unknown"), []);
    assert.throws(
      () => requirePermission("waiter", PERMISSION.BILLING_MANAGE),
      (error) => error.code === "FORBIDDEN" && error.statusCode === 403,
    );
  });
});
