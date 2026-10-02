import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { loadLegacyMoneyEngine } from "./helpers/legacy-domain.mjs";

describe("legacy MoneyEngine characterization", () => {
  let money;

  before(async () => {
    money = await loadLegacyMoneyEngine();
  });

  it("uses integer paisa at the arithmetic boundary", () => {
    assert.equal(money.toMinor(10.235), 1024);
    assert.equal(money.fromMinor(1024), 10.24);
    assert.equal(money.toMinor("invalid"), 0);
  });

  it("calculates a normal multi-item order", () => {
    const result = money.calculate({
      items: [
        { price: 450, qty: 2 },
        { price: 175.5, qty: 1 },
      ],
    });

    assert.equal(result.subtotal, 1075.5);
    assert.equal(result.total, 1075.5);
    assert.equal(result.minor.total, 107550);
  });

  it("applies percentage discounts before delivery and charges", () => {
    const result = money.calculate({
      items: [{ price: 1000, qty: 1 }],
      discountType: "percent",
      discountValue: 10,
      deliveryFee: 100,
      additionalCharges: [
        { id: "tax", name: "Tax", type: "percent", value: 5 },
        { id: "packing", name: "Packing", type: "flat", value: 20 },
      ],
    });

    assert.equal(result.subtotal, 1000);
    assert.equal(result.discountAmount, 100);
    assert.equal(result.deliveryFee, 100);
    assert.equal(result.additionalChargesTotal, 70);
    assert.equal(result.total, 1070);
  });

  it("ignores disabled additional charges", () => {
    const result = money.calculate({
      items: [{ price: 500, qty: 1 }],
      additionalCharges: [
        { name: "Enabled", type: "flat", value: 25 },
        { name: "Disabled", type: "flat", value: 100, enabled: false },
      ],
    });

    assert.equal(result.additionalCharges.length, 1);
    assert.equal(result.additionalChargesTotal, 25);
    assert.equal(result.total, 525);
  });

  it("caps discounts so an order cannot become negative", () => {
    const flat = money.calculate({
      items: [{ price: 100, qty: 1 }],
      discountType: "flat",
      discountValue: 500,
    });
    const percent = money.calculate({
      items: [{ price: 100, qty: 1 }],
      discountType: "percent",
      discountValue: 250,
    });

    assert.equal(flat.discountAmount, 100);
    assert.equal(flat.total, 0);
    assert.equal(percent.discountAmount, 100);
    assert.equal(percent.total, 0);
  });

  it("characterizes partial payment, amount due, and change", () => {
    const partial = money.calculate({
      items: [{ price: 800, qty: 1 }],
      paid: 300,
    });
    const overpaid = money.calculate({
      items: [{ price: 800, qty: 1 }],
      paid: 1000,
    });

    assert.equal(partial.due, 500);
    assert.equal(partial.change, 0);
    assert.equal(overpaid.due, 0);
    assert.equal(overpaid.change, 200);
  });

  it("keeps due and change unknown until a paid amount is supplied", () => {
    const result = money.calculate({ items: [{ price: 250, qty: 1 }] });

    assert.equal(result.paid, null);
    assert.equal(result.due, null);
    assert.equal(result.change, null);
  });

  it("normalizes negative quantities, fees, discounts, and payments", () => {
    const result = money.calculate({
      items: [{ price: 100, qty: -3 }],
      discountValue: -10,
      deliveryFee: -50,
      additionalCharges: [{ name: "Tax", type: "percent", value: -5 }],
      paid: -100,
    });

    assert.equal(result.subtotal, 0);
    assert.equal(result.discountAmount, 0);
    assert.equal(result.deliveryFee, 0);
    assert.equal(result.additionalChargesTotal, 0);
    assert.equal(result.paid, 0);
    assert.equal(result.total, 0);
  });
});
