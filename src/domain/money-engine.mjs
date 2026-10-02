/**
 * Exact, framework-independent extraction of the legacy POS money rules.
 *
 * Values exposed to the application remain in rupees for compatibility, while
 * calculations cross an integer-paisa boundary to avoid floating-point drift.
 */
export const MoneyEngine = Object.freeze({
  toMinor(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  },

  fromMinor(value) {
    return Math.round(Number(value) || 0) / 100;
  },

  calculate({
    items = [],
    discountType = "flat",
    discountValue = 0,
    deliveryFee = 0,
    additionalCharges = [],
    paid = null,
  } = {}) {
    const subtotalMinor = Math.max(
      0,
      items.reduce((sum, item) => {
        const qty = Math.max(0, Number(item && item.qty) || 0);
        return sum + Math.round(this.toMinor(item && item.price) * qty);
      }, 0),
    );
    const safeDiscountValue = Math.max(0, Number(discountValue) || 0);
    const requestedDiscountMinor =
      discountType === "percent"
        ? Math.round(
            (subtotalMinor * Math.min(safeDiscountValue, 100)) / 100,
          )
        : this.toMinor(safeDiscountValue);
    const discountMinor = Math.min(
      subtotalMinor,
      Math.max(0, requestedDiscountMinor),
    );
    const deliveryMinor = Math.max(0, this.toMinor(deliveryFee));
    const chargeBaseMinor = Math.max(
      0,
      subtotalMinor - discountMinor + deliveryMinor,
    );
    const normalizedCharges = (
      Array.isArray(additionalCharges) ? additionalCharges : []
    )
      .filter((charge) => charge && charge.enabled !== false)
      .map((charge) => {
        const type = charge.type === "percent" ? "percent" : "flat";
        const value = Math.max(0, Number(charge.value) || 0);
        const amountMinor =
          type === "percent"
            ? Math.round((chargeBaseMinor * Math.min(value, 100)) / 100)
            : this.toMinor(value);

        return {
          ...charge,
          type,
          value,
          amount: this.fromMinor(amountMinor),
          amountMinor,
        };
      });
    const additionalChargesMinor = normalizedCharges.reduce(
      (sum, charge) => sum + charge.amountMinor,
      0,
    );
    const totalMinor = Math.max(
      0,
      subtotalMinor - discountMinor + deliveryMinor + additionalChargesMinor,
    );
    const paidMinor =
      paid === null || paid === undefined || paid === ""
        ? null
        : Math.max(0, this.toMinor(paid));
    const dueMinor =
      paidMinor === null ? null : Math.max(totalMinor - paidMinor, 0);
    const changeMinor =
      paidMinor === null ? null : Math.max(paidMinor - totalMinor, 0);

    return Object.freeze({
      subtotal: this.fromMinor(subtotalMinor),
      discountAmount: this.fromMinor(discountMinor),
      deliveryFee: this.fromMinor(deliveryMinor),
      additionalCharges: normalizedCharges.map(
        ({ amountMinor: _amountMinor, ...charge }) => charge,
      ),
      additionalChargesTotal: this.fromMinor(additionalChargesMinor),
      total: this.fromMinor(totalMinor),
      paid: paidMinor === null ? null : this.fromMinor(paidMinor),
      due: dueMinor === null ? null : this.fromMinor(dueMinor),
      change: changeMinor === null ? null : this.fromMinor(changeMinor),
      minor: Object.freeze({
        subtotal: subtotalMinor,
        discount: discountMinor,
        delivery: deliveryMinor,
        additionalCharges: additionalChargesMinor,
        total: totalMinor,
        paid: paidMinor,
        due: dueMinor,
        change: changeMinor,
      }),
    });
  },
});
