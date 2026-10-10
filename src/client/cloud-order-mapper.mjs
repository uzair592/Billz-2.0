/**
 * Maps cloud API order payloads onto the legacy POS order shape.
 *
 * The legacy renderer (history table, invoice modal, receipt slip)
 * expects orders with rupee amounts, "Dine-In"/"Takeaway"/"Delivery"
 * labels and "Paid"/"Unpaid" payment flags. The cloud API returns
 * minor-unit amounts and snake_case statuses, so this module is the
 * single place that translates between the two — the renderers stay
 * untouched and keep working for both local and cloud orders.
 *
 * Money crosses the minor-unit boundary with rounding, matching
 * MoneyEngine.fromMinor, so no floating-point drift is introduced.
 */

const ORDER_TYPE_LABELS = {
  dine_in: "Dine-In",
  takeaway: "Takeaway",
  delivery: "Delivery",
};

const PAYMENT_METHOD_LABELS = {
  cash: "Cash",
  bank_account: "Bank Account",
  other: "Other",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCloudOrderId(value) {
  return UUID_PATTERN.test(String(value ?? ""));
}

/**
 * Minor units cross into rupees with rounding, matching
 * MoneyEngine.fromMinor. Zero stays zero (it is a real
 * amount, not a missing one), negative values pass
 * through intentionally (refunds), and anything that is
 * not a finite number degrades to zero instead of
 * producing NaN totals.
 */
function fromMinor(value) {
  const number = Number(value);
  return Math.round(Number.isFinite(number) ? number : 0) / 100;
}

/**
 * A malformed collection degrades to an empty list so one
 * bad field cannot break the whole render.
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function orderTypeLabel(value) {
  return ORDER_TYPE_LABELS[value] ?? "Takeaway";
}

function paymentMethodLabel(value) {
  return PAYMENT_METHOD_LABELS[value] ?? "Other";
}

/**
 * The legacy ledger treats every non-cancelled order as "Completed"
 * (that is what counts toward revenue), so cloud lifecycle statuses
 * collapse the same way — only "cancelled" stays distinct.
 */
function legacyOrderStatus(value) {
  return value === "cancelled" ? "Cancelled" : "Completed";
}

function legacyPaymentStatus(value) {
  return value === "unpaid" || value === "partially_paid"
    ? "Unpaid"
    : "Paid";
}

function timeFromIso(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateFromIso(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Offer labels ride on the item snapshot the server stored at sale
 * time (order_items.recipe_snapshot -> offer), so historical orders
 * still show the discount pill they were sold with.
 */
function offerFromSnapshot(recipe) {
  const offer = recipe && typeof recipe === "object" ? recipe.offer : null;
  if (!offer || offer.type !== "item" && offer.type !== "category") {
    return { offerLabel: null, originalPrice: null };
  }
  const originalPrice = fromMinor(offer.regularPriceMinor);
  if (offer.type === "item") {
    return { offerLabel: "🔥 Item Offer", originalPrice };
  }
  const discountLabel = offer.discountType === "percent"
    ? `${offer.discountPercent ?? 0}% off`
    : `Rs. ${fromMinor(offer.discountMinor)} off`;
  return {
    offerLabel: `🏷️ Category Offer (${discountLabel})`,
    originalPrice,
  };
}

/**
 * A list-row shape: enough for the history table (no items — the
 * list endpoint does not return them; the detail view fetches them
 * on demand).
 */
export function mapCloudOrderSummary(summary) {
  const paymentStatus = legacyPaymentStatus(summary.paymentStatus);
  const totalBill = fromMinor(summary.totalMinor);
  return {
    id: summary.id,
    orderNumber: Number(summary.orderNumber) || 0,
    date: summary.businessDate,
    time: timeFromIso(summary.orderedAt),
    customerName: summary.customerName ?? "",
    customerPhone: summary.customerPhone ?? "",
    riderName: summary.riderName ?? "",
    orderType: orderTypeLabel(summary.orderType),
    tableNumber: summary.tableNumber ?? null,
    hall: null,
    items: [],
    subtotal: fromMinor(summary.subtotalMinor),
    discountType: "flat",
    discountValue: fromMinor(summary.discountMinor),
    discountAmount: fromMinor(summary.discountMinor),
    deliveryCharges: fromMinor(summary.deliveryMinor),
    additionalCharges: [],
    totalBill,
    paymentStatus,
    paymentMethod: "Cash",
    amountReceived: paymentStatus === "Paid" ? totalBill : 0,
    editHistory: [],
    orderStatus: legacyOrderStatus(summary.orderStatus),
    statusReason: summary.cancellationReason ?? "",
    legacyOrderId: summary.legacyOrderId ?? null,
    cloudOrder: true,
  };
}

/**
 * The full order shape the invoice modal and receipt slip render,
 * built from GET /api/pos/orders/:orderId.
 */
export function mapCloudOrderDetail(detail) {
  const order = detail?.order ?? {};
  const paymentStatus = legacyPaymentStatus(order.paymentStatus);
  const totalBill = fromMinor(order.totalMinor);

  const items = asArray(detail?.items).map((item) => {
    const { offerLabel, originalPrice } = offerFromSnapshot(item?.recipe);
    const unitCost = fromMinor(item?.unitCostMinor);
    return {
      id: item?.menuItemId ?? item?.id,
      name: item?.name,
      qty: Number(item?.quantity) || 0,
      price: fromMinor(item?.unitPriceMinor),
      offerLabel,
      originalPrice,
      extras: [],
      lineCostAtSale: item?.lineCostMinor != null
        ? fromMinor(item.lineCostMinor) : unitCost * (Number(item?.quantity) || 0),
      unitCostAtSale: unitCost,
      costSnapshotVersion: 1,
    };
  });

  const additionalCharges = asArray(detail?.charges).map((charge) => ({
    name: charge?.name,
    type: charge?.type === "percent" ? "percent" : "flat",
    value: charge?.type === "percent"
      ? Number(charge?.value) || 0
      : fromMinor(charge?.value),
    amount: fromMinor(charge?.amountMinor),
    enabled: true,
  }));

  const payments = asArray(detail?.payments);
  const captured = payments.filter((payment) => payment?.status === "captured");
  const receivedMinor = captured.reduce(
    (sum, payment) => sum + (Number(payment?.amountMinor) || 0),
    0,
  );
  const primaryPayment = captured[0] ?? payments[0];

  const discountType = order.discountType === "percent" ? "percent" : "flat";
  const discountValue = discountType === "percent"
    ? Number(order.discountValue) || 0
    : fromMinor(order.discountMinor);

  const cancellation = detail?.cancellation ?? null;
  const restocked = asArray(cancellation?.restocked);

  return {
    id: order.id,
    orderNumber: Number(order.orderNumber) || 0,
    date: order.businessDate,
    time: timeFromIso(order.orderedAt),
    customerName: order.customerName ?? "",
    customerPhone: order.customerPhone ?? "",
    riderName: order.riderName ?? "",
    orderType: orderTypeLabel(order.orderType),
    tableNumber: order.tableNumber ?? null,
    hall: null,
    items,
    subtotal: fromMinor(order.subtotalMinor),
    discountType,
    discountValue,
    discountAmount: fromMinor(order.discountMinor),
    deliveryCharges: fromMinor(order.deliveryMinor),
    additionalCharges,
    totalBill,
    paymentStatus,
    paymentMethod: primaryPayment
      ? paymentMethodLabel(primaryPayment.method)
      : "Cash",
    paymentAccountId: primaryPayment?.financialAccountId ?? null,
    amountReceived: fromMinor(receivedMinor),
    editHistory: asArray(detail?.events).map((event) => ({
      type: event?.type,
      date: dateFromIso(event?.createdAt),
      time: timeFromIso(event?.createdAt),
      changes: asArray(event?.changes),
      note: event?.note ?? "",
    })),
    lastEditedDate: detail?.events?.length
      ? dateFromIso(detail.events[detail.events.length - 1]?.createdAt)
      : "",
    lastEditedTime: detail?.events?.length
      ? timeFromIso(detail.events[detail.events.length - 1]?.createdAt)
      : "",
    orderStatus: legacyOrderStatus(order.orderStatus),
    statusReason: order.cancellationReason ?? cancellation?.reason ?? "",
    restockSummary: restocked.length
      ? restocked
          .map((entry) => `${entry?.stockItemId} +${entry?.quantityBaseUnits}`)
          .join("; ")
      : "",
    costOfGoods: order.costOfGoodsMinor != null ? fromMinor(order.costOfGoodsMinor) : items.reduce((sum, item) => sum + item.lineCostAtSale, 0),
    costSnapshotVersion: 1,
    costSnapshotSource: "cloud",
    legacyOrderId: order.legacyOrderId ?? null,
    cloudOrder: true,
  };
}

/**
 * Server-side summary block (minor units) converted for display.
 */
export function mapCloudSummary(summary) {
  return {
    orderCount: Number(summary.orderCount) || 0,
    cancelledCount: Number(summary.cancelledCount) || 0,
    sales: fromMinor(summary.salesMinor),
    costOfGoods: fromMinor(summary.costOfGoodsMinor),
    paid: fromMinor(summary.paidMinor),
    due: fromMinor(summary.dueMinor),
  };
}
