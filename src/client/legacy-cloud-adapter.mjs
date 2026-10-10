import { createHttpOrderTransport, createOrderOutbox, OrderSyncError } from "./order-outbox.mjs";
import {
  buildLegacyCatalogSnapshot,
  readLegacyCollections,
} from "./legacy-catalog-snapshot.mjs";

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

export function createLegacyCloudAdapter({
  storage,
  outbox,
  session = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("storage must provide get and set functions.");
  }
  if (!outbox || typeof outbox.enqueue !== "function" || typeof outbox.flush !== "function") {
    throw new TypeError("outbox must provide enqueue and flush functions.");
  }

  return Object.freeze({
    /**
     * Reads this device's own browser data, builds the import snapshot, and
     * only activates cloud ordering once the server has accepted it and
     * returned authoritative UUID mappings.
     */
    async importCatalog({ restaurantId, snapshot } = {}) {
      const targetRestaurant = restaurantId ?? (await session.activeRestaurant());
      if (!targetRestaurant) {
        throw new OrderSyncError("Sign in and choose a restaurant before importing.", {
          code: "RESTAURANT_REQUIRED",
          retriable: false,
        });
      }
      const body = snapshot ?? buildLegacyCatalogSnapshot(
        await readLegacyCollections(storage),
      );
      const response = await fetchImpl("/api/pos/import/legacy-catalog", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-restaurant-id": targetRestaurant,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        throw new OrderSyncError(result?.error ?? `Catalog import returned HTTP ${response.status}.`, {
          status: Number(response.status),
          code: result?.code ?? "CATALOG_IMPORT_FAILED",
          retriable: Number(response.status) >= 500,
        });
      }
      const context = {
        version: 1,
        restaurantId: targetRestaurant,
        importedAt: new Date().toISOString(),
        mappings: {
          menuItems: result.menuItems ?? {},
          tables: result.tables ?? {},
          financialAccounts: result.financialAccounts ?? {},
        },
      };
      await storage.set(CLOUD_CONTEXT_KEY, context);
      return { result, context };
    },

    async enqueueLegacyOrder(order) {
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      if (!context?.restaurantId || !context?.mappings) {
        return { status: "not_configured" };
      }
      if (session) {
        const authorized = await session.status();
        if (!authorized.user || authorized.restaurantId !== context.restaurantId) throw new OrderSyncError("Catalog belongs to a different or signed-out restaurant.", { code: "CLOUD_TENANT_MISMATCH" });
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

    async checkoutOnline(order) {
      const current = await session.currentUser();
      const context = await storage.get(CLOUD_CONTEXT_KEY);
      if (!current.user || !context || context.restaurantId !== current.restaurantId) throw new Error("Import this restaurant's catalog before checkout.");
      if (order.items.some(item => (item.extras || []).length)) throw new Error("Cloud checkout does not yet support ingredient extras. Remove extras before taking payment.");
      const payload = buildCloudOrderPayload(order, context.mappings);
      payload.expectedTotalMinor = minor(order.totalBill);
      const fingerprint = JSON.stringify(payload);
      let attempt = await storage.get("pos_checkout_attempt");
      if (attempt && attempt.fingerprint !== fingerprint) throw new Error("A previous checkout is unconfirmed. Retry its original cart or reconcile it in cloud history before changing the bill.");
      if (!attempt) { attempt = { fingerprint, idempotencyKey: crypto.randomUUID() }; await storage.set("pos_checkout_attempt", attempt); }
      payload.idempotencyKey = attempt.idempotencyKey;
      try {
        return await createHttpOrderTransport({ fetchImpl }).send({ restaurantId: current.restaurantId, payload });
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) await storage.set("pos_checkout_attempt", null);
        throw error;
      }
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
  function scopedKey(key) {
    if (!globalThis.BILLZ_MANAGED || key === "pos_cloud_session_v1") return key;
    if (!globalThis.BILLZ_TENANT_ID) throw new Error("No authenticated tenant selected.");
    return `tenant:${globalThis.BILLZ_TENANT_ID}:${key}`;
  }
  async function request(mode, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const operation = action(transaction.objectStore(storeName));
      let value;
      operation.onsuccess = () => { value = operation.result; };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
      operation.onerror = () => reject(operation.error);
    });
  }
  return Object.freeze({
    get: (key) => request("readonly", (store) => store.get(scopedKey(key))),
    set: (key, value) => request("readwrite", (store) => store.put(value, scopedKey(key))),
  });
}

export function createBrowserOutbox({ storage, navigatorImpl = globalThis.navigator } = {}) {
  const withLock = navigatorImpl?.locks?.request
    ? (operation) => navigatorImpl.locks.request("bite-tech-cloud-order-outbox", operation)
    : (operation) => operation();
  return createOrderOutbox({
    storage,
    storageKey: CLOUD_OUTBOX_KEY,
    transport: {
      async send(record) {
        const account = await storage.get("pos_cloud_session_v1");
        if (!account?.user || account.restaurantId !== record.restaurantId) throw new OrderSyncError("Sign in to the original restaurant to synchronize this order.", { status: 401, code: "CLOUD_TENANT_MISMATCH" });
        return createHttpOrderTransport().send(record);
      },
    },
    withLock,
  });
}
