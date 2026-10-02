const DEFAULT_STORAGE_KEY = "pos_cloud_order_outbox_v1";
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

function clone(value) {
  return structuredClone(value);
}

function errorMessage(error) {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : "Order synchronization failed.";
}

function isRetryable(error) {
  if (typeof error?.retriable === "boolean") return error.retriable;
  const status = Number(error?.status);
  return !status || status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
}

function retryDelay(attempt, baseDelayMs, maxDelayMs) {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

export class OrderSyncError extends Error {
  constructor(message, { status = 0, code = "ORDER_SYNC_FAILED", retriable = false } = {}) {
    super(message);
    this.name = "OrderSyncError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
  }
}

export function createHttpOrderTransport({ fetchImpl = globalThis.fetch, baseUrl = "" } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  return Object.freeze({
    async send(record) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/api/pos/orders`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            "x-restaurant-id": record.restaurantId,
          },
          body: JSON.stringify(record.payload),
        });
      } catch (error) {
        throw new OrderSyncError(errorMessage(error), { retriable: true });
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const status = Number(response.status);
        throw new OrderSyncError(body?.error ?? `Order API returned HTTP ${status}.`, {
          status,
          code: body?.code ?? "ORDER_API_ERROR",
          retriable: status >= 500 || RETRYABLE_HTTP_STATUSES.has(status),
        });
      }
      return body;
    },
  });
}

export function createOrderOutbox({
  storage,
  transport,
  clock = () => new Date(),
  createId = () => crypto.randomUUID(),
  storageKey = DEFAULT_STORAGE_KEY,
  baseDelayMs = 1_000,
  maxDelayMs = 5 * 60_000,
} = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("storage must provide get and set functions.");
  }
  if (!transport || typeof transport.send !== "function") {
    throw new TypeError("transport must provide a send function.");
  }
  let activeFlush = null;
  let mutationQueue = Promise.resolve();

  function serialize(operation) {
    const result = mutationQueue.then(operation, operation);
    mutationQueue = result.catch(() => undefined);
    return result;
  }

  async function read() {
    const records = await storage.get(storageKey);
    return Array.isArray(records) ? records : [];
  }

  async function write(records) {
    await storage.set(storageKey, records);
  }

  async function update(localOrderId, updater) {
    const records = await read();
    const index = records.findIndex((record) => record.localOrderId === localOrderId);
    if (index === -1) return null;
    records[index] = updater(records[index]);
    await write(records);
    return clone(records[index]);
  }

  return Object.freeze({
    async enqueue({ localOrderId, restaurantId, payload }) {
      if (localOrderId === undefined || localOrderId === null || localOrderId === "") {
        throw new TypeError("localOrderId is required.");
      }
      if (!restaurantId) throw new TypeError("restaurantId is required.");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("payload must be an object.");
      }

      return serialize(async () => {
        const records = await read();
        const existing = records.find((record) => record.localOrderId === localOrderId);
        if (existing) return clone(existing);
        const createdAt = clock().toISOString();
        const idempotencyKey = createId();
        const record = {
          localOrderId,
          restaurantId,
          idempotencyKey,
          payload: { ...clone(payload), idempotencyKey },
          status: "pending",
          attempts: 0,
          nextAttemptAt: createdAt,
          createdAt,
          syncedAt: null,
          serverOrder: null,
          lastError: null,
        };
        records.push(record);
        await write(records);
        return clone(record);
      });
    },

    async list() {
      return serialize(async () => clone(await read()));
    },

    async retry(localOrderId) {
      return serialize(() => update(localOrderId, (record) => ({
          ...record,
          status: "pending",
          nextAttemptAt: clock().toISOString(),
          lastError: null,
        })));
    },

    async flush() {
      if (activeFlush) return activeFlush;
      activeFlush = serialize(async () => {
        const records = await read();
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          if (!["pending", "retrying"].includes(record.status)) continue;
          if (new Date(record.nextAttemptAt).getTime() > clock().getTime()) continue;

          try {
            const result = await transport.send(clone(record));
            records[index] = {
              ...record,
              status: "synced",
              attempts: record.attempts + 1,
              syncedAt: clock().toISOString(),
              serverOrder: result?.order ?? null,
              lastError: null,
            };
          } catch (error) {
            const attempts = record.attempts + 1;
            const retriable = isRetryable(error);
            records[index] = {
              ...record,
              status: retriable ? "retrying" : "failed",
              attempts,
              nextAttemptAt: retriable
                ? new Date(clock().getTime() + retryDelay(
                    attempts,
                    baseDelayMs,
                    maxDelayMs,
                  )).toISOString()
                : null,
              lastError: {
                message: errorMessage(error),
                code: error?.code ?? "ORDER_SYNC_FAILED",
                status: Number(error?.status) || 0,
              },
            };
          }
          await write(records);
        }
        return clone(records);
      });

      try {
        return await activeFlush;
      } finally {
        activeFlush = null;
      }
    },
  });
}
