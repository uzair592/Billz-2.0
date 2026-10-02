import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadLegacyOrderStatusFunctions } from "./helpers/legacy-domain.mjs";

describe("legacy order status characterization", () => {
  let status;

  before(async () => {
    status = await loadLegacyOrderStatusFunctions();
  });

  it("treats historical orders without a status as completed", () => {
    assert.equal(status.getOrderStatus({}), "Completed");
    assert.equal(status.isOrderRevenueCounted({}), true);
  });

  it("excludes cancelled orders from revenue", () => {
    const order = { orderStatus: "Cancelled" };

    assert.equal(status.getOrderStatus(order), "Cancelled");
    assert.equal(status.isOrderRevenueCounted(order), false);
  });
});
