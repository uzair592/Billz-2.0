import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { MoneyEngine } from "../src/domain/money-engine.mjs";
import {
  getOrderStatus,
  isOrderRevenueCounted,
} from "../src/domain/order-status.mjs";
import {
  loadLegacyMoneyEngine,
  loadLegacyOrderStatusFunctions,
} from "./helpers/legacy-domain.mjs";

const pricingFixtures = [
  {},
  { items: [{ price: 199.99, qty: 3 }] },
  {
    items: [
      { price: 450, qty: 2 },
      { price: 175.5, qty: 1 },
    ],
    discountType: "flat",
    discountValue: 75,
    deliveryFee: 120,
    paid: 1000,
  },
  {
    items: [{ price: 1000, qty: 1 }],
    discountType: "percent",
    discountValue: 12.5,
    deliveryFee: 100,
    additionalCharges: [
      { id: "tax", name: "Tax", type: "percent", value: 5 },
      { id: "packing", name: "Packing", type: "flat", value: 20 },
      {
        id: "disabled",
        name: "Disabled",
        type: "flat",
        value: 999,
        enabled: false,
      },
    ],
    paid: 1500,
  },
  {
    items: [{ price: "invalid", qty: -2 }],
    discountValue: -1,
    deliveryFee: -1,
    additionalCharges: null,
    paid: "",
  },
];

describe("extracted domain parity", () => {
  let legacyMoney;
  let legacyStatus;

  before(async () => {
    [legacyMoney, legacyStatus] = await Promise.all([
      loadLegacyMoneyEngine(),
      loadLegacyOrderStatusFunctions(),
    ]);
  });

  it("matches the legacy money engine for representative orders", () => {
    for (const fixture of pricingFixtures) {
      const expected = JSON.parse(JSON.stringify(legacyMoney.calculate(fixture)));
      const actual = JSON.parse(JSON.stringify(MoneyEngine.calculate(fixture)));

      assert.deepEqual(actual, expected);
    }
  });

  it("matches conversion and rounding behavior", () => {
    for (const value of [0, 0.1, 10.235, "99.999", null, undefined, "bad"]) {
      assert.equal(MoneyEngine.toMinor(value), legacyMoney.toMinor(value));
    }

    for (const value of [0, 1, 999, 1024, -50, "bad"]) {
      assert.equal(MoneyEngine.fromMinor(value), legacyMoney.fromMinor(value));
    }
  });

  it("matches legacy order-status and revenue behavior", () => {
    const orders = [
      {},
      { orderStatus: "Completed" },
      { orderStatus: "Cancelled" },
      { orderStatus: "Pending" },
    ];

    for (const order of orders) {
      assert.equal(getOrderStatus(order), legacyStatus.getOrderStatus(order));
      assert.equal(
        isOrderRevenueCounted(order),
        legacyStatus.isOrderRevenueCounted(order),
      );
    }
  });
});
