import { createHttpOrderTransport, createOrderOutbox, OrderSyncError } from "./order-outbox.mjs";

export const CLOUD_CONTEXT_KEY = "pos_cloud_context_v1";
export const CLOUD_OUTBOX_KEY = "pos_cloud_order_outbox_v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function minor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

function requireMapping(collection, legacyId, label) {
  const cloudId = collection?.[String(legacyId)];
  if (!UUID_PATTERN.test(cloudId ?? "")) {
    throw new OrderSyncError(`${label} ${legacyId} has not been mapped to the cloud.`, {
      code: "LEGACY_MAPPING_MISSING",
      retriable: false,
    });
  }
  return cloudId;
}

function orderType(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (["dine_in", "takeaway", "delivery"].includes(normalized)) return normalized;
  throw new OrderSyncError("The legacy order type cannot be synchronized.", {
    code: "LEGACY_ORDER_INVALID",
    retriable: false,
  });
}

function paymentPayload(order, mappings) {
  const paid = order.paymentStatus === "Paid"
    ? Number(order.totalBill)
    : Number(order.amountReceived ?? 0);
  const amountReceivedMinor = minor(paid);
  if (amountReceivedMinor <= 0) return undefined;

  if (order.paymentMethod === "Bank Account") {
    return {
      method: "bank_account",
      amountReceivedMinor,
      financialAccountId: requireMapping(
        mappings.financialAccounts,
        order.paymentAccountId,
        "Bank account",
      ),
    };
  }
  return {
    method: order.paymentMethod === "Cash" ? "cash" : "other",
    amountReceivedMinor,
  };
}

export function buildCloudOrderPayload(order, mappings) {
  if (!order || !Array.isArray(order.items) || order.items.length === 0) {
    throw new OrderSyncError("The local order has no items to synchronize.", {
      code: "LEGACY_ORDER_INVALID",
      retriable: false,
    });
  }

  const type = orderType(order.orderType);
  const payload = {
    businessDate: order.date,
    orderType: type,
    items: order.items.map((item) => ({
      menuItemId: requireMapping(mappings.menuItems, item.id, "Menu item"),
      quantity: Number(item.qty),
    })),
    deliveryMinor: minor(order.deliveryCharges),
    additionalCharges: (order.additionalCharges ?? [])
      .filter((charge) => charge.enabled !== false && Number(charge.value) > 0)
      .map((charge) => charge.type === "percent"
        ? { name: charge.name, type: "percent", value: Number(charge.value) }
        : { name: charge.name, type: "flat", valueMinor: minor(charge.value) }),
  };

  if (type === "dine_in") {
    payload.tableId = requireMapping(mappings.tables, order.tableNumber, "Table");
  }
  if (order.customerName) payload.customerName = order.customerName;
  if (order.customerPhone) payload.customerPhone = order.customerPhone;
  if (order.riderName) payload.riderName = order.riderName;
  if (order.discountType === "percent" && Number(order.discountValue) > 0) {
    payload.discount = { type: "percent", value: Number(order.discountValue) };
  } else if (order.discountType === "flat" && Number(order.discountValue) > 0) {
    payload.discount = { type: "flat", valueMinor: minor(order.discountValue) };
  }
  const payment = paymentPayload(order, mappings);
  if (payment) payload.payment = payment;
  return payload;
}

export function createLegacyCloudAdapter({ storage, outbox, fetchImpl = globalThis.fetch } = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("storage must provide get and set functions.");
  }
  if (!outbox || typeof outbox.enqueue !== "function" || typeof outbox.flush !== "function") {
    throw new TypeError("outbox must provide enqueue and flush functions.");
  }

  return Object.freeze({
    async importCatalog({ restaurantId, snapshot }) {
      const response = await fetchImpl("/api/pos/import/legacy-catalog", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-restaurant-id": restaurantId },
        body: JSON.stringify(snapshot),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new OrderSyncError(body?.error ?? `Catalog import returned HTTP ${response.status}.`, {
          status: Number(response.status),
          code: body?.code ?? "CATALOG_IMPORT_FAILED",
          retriable: Number(response.status) >= 500,
        });
      }
      const context = {
        version: 1,
        restaurantId,
        importedAt: new Date().toISOString(),
        mappings: {
          menuItems: body.menuItems ?? {},
          tables: body.tables ?? {},
          financialAccounts: body.financialAccounts ?? {},
        },
      };
      await storage.set(CLOUD_CONTEXT_KEY, context);
      return { result: body, context };
    },

    async enqueueLegacyOrder(order) {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      if (!context?.restaurantId || !context?.mappings) {
        return { status: "not_configured" };
      }
      const record = await outbox.enqueue({
        localOrderId: order.id,
        restaurantId: context.restaurantId,
        payload: buildCloudOrderPayload(order, context.mappings),
      });
      const records = await outbox.flush();
      return {
        status: records.find((candidate) => (
          candidate.localOrderId === order.id
          && candidate.restaurantId === context.restaurantId
        ))?.status ?? record.status,
      };
    },

    flush: () => outbox.flush(),
  });
}

export function createBrowserIndexedDbStorage({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = "BiteTechPOS_DB",
  storeName = "posData",
} = {}) {
  let connection;
  async function database() {
    if (connection) return connection;
    connection = await new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return connection;
  }
  async function request(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const operation = action(transaction.objectStore(storeName));
      operation.onsuccess = () => resolve(operation.result);
      operation.onerror = () => reject(operation.error);
    });
  }
  return Object.freeze({
    get: (key) => request("readonly", (store) => store.get(key)),
    set: (key, value) => request("readwrite", (store) => store.put(value, key)),
  });
}

export function createBrowserOutbox({ storage, navigatorImpl = globalThis.navigator } = {}) {
  const withLock = navigatorImpl?.locks?.request
    ? (operation) => navigatorImpl.locks.request("bite-tech-cloud-order-outbox", operation)
    : (operation) => operation();
  return createOrderOutbox({
    storage,
    storageKey: CLOUD_OUTBOX_KEY,
    transport: createHttpOrderTransport(),
    withLock,
  });
}
