export const ORDER_STATUS = Object.freeze({
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
});

/** Historical orders predate the explicit status field and are completed. */
export function getOrderStatus(order) {
  return order.orderStatus || ORDER_STATUS.COMPLETED;
}

export function isOrderRevenueCounted(order) {
  return getOrderStatus(order) === ORDER_STATUS.COMPLETED;
}
