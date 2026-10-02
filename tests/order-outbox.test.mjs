import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHttpOrderTransport,
  createOrderOutbox,
  OrderSyncError,
} from "../src/client/order-outbox.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

function setup({ send = async () => ({ order: { id: "server-order-1" } }) } = {}) {
  let now = new Date("2026-10-02T12:00:00.000Z");
  const outbox = createOrderOutbox({
    storage: memoryStorage(),
    transport: { send },
    clock: () => now,
    createId: () => idempotencyKey,
    baseDelayMs: 1_000,
  });
  return { outbox, advance(ms) { now = new Date(now.getTime() + ms); } };
}

const payload = {
  orderType: "takeaway",
  items: [{
    menuItemId: "33333333-3333-4333-8333-333333333333",
    quantity: 1,
  }],
};

describe("durable browser order outbox", () => {
  it("reuses one idempotency key when the same local order is enqueued again", async () => {
    const { outbox } = setup();
    const first = await outbox.enqueue({ localOrderId: 7, restaurantId, payload });
    const second = await outbox.enqueue({ localOrderId: 7, restaurantId, payload });

    assert.equal(first.idempotencyKey, idempotencyKey);
    assert.equal(second.idempotencyKey, idempotencyKey);
    assert.equal(second.payload.idempotencyKey, idempotencyKey);
    assert.equal((await outbox.list()).length, 1);
  });

  it("marks an accepted API order as synced", async () => {
    const { outbox } = setup();
    await outbox.enqueue({ localOrderId: 8, restaurantId, payload });
    const records = await outbox.flush();

    assert.equal(records[0].status, "synced");
    assert.equal(records[0].attempts, 1);
    assert.equal(records[0].serverOrder.id, "server-order-1");
  });

  it("backs off temporary failures without changing the idempotency key", async () => {
    let calls = 0;
    const { outbox, advance } = setup({
      async send(record) {
        calls += 1;
        assert.equal(record.payload.idempotencyKey, idempotencyKey);
        if (calls === 1) {
          throw new OrderSyncError("Temporarily unavailable.", {
            status: 503,
            code: "UNAVAILABLE",
            retriable: true,
          });
        }
        return { order: { id: "server-order-2" } };
      },
    });
    await outbox.enqueue({ localOrderId: 9, restaurantId, payload });

    let records = await outbox.flush();
    assert.equal(records[0].status, "retrying");
    assert.equal(records[0].nextAttemptAt, "2026-10-02T12:00:01.000Z");
    await outbox.flush();
    assert.equal(calls, 1);
    advance(1_000);
    records = await outbox.flush();
    assert.equal(records[0].status, "synced");
    assert.equal(records[0].idempotencyKey, idempotencyKey);
  });

  it("holds permanent validation failures until manually retried", async () => {
    const { outbox } = setup({
      async send() {
        throw new OrderSyncError("Menu changed.", {
          status: 409,
          code: "MENU_CHANGED",
          retriable: false,
        });
      },
    });
    await outbox.enqueue({ localOrderId: 10, restaurantId, payload });
    let records = await outbox.flush();
    assert.equal(records[0].status, "failed");
    assert.equal(records[0].nextAttemptAt, null);
    assert.equal(records[0].lastError.code, "MENU_CHANGED");

    await outbox.retry(10);
    records = await outbox.list();
    assert.equal(records[0].status, "pending");
    assert.equal(records[0].idempotencyKey, idempotencyKey);
  });

  it("does not share an idempotency record across restaurants", async () => {
    const { outbox } = setup();
    await outbox.enqueue({ localOrderId: 14, restaurantId, payload });

    const other = await outbox.enqueue({
      localOrderId: 14,
      restaurantId: "99999999-9999-4999-8999-999999999999",
      payload,
    });

    assert.equal(other.localOrderId, 14);
    assert.equal((await outbox.list()).length, 2);
  });

  it("coalesces concurrent flush calls into one network request", async () => {
    let calls = 0;
    let resolveSend;
    const pendingSend = new Promise((resolve) => { resolveSend = resolve; });
    const { outbox } = setup({
      async send() { calls += 1; return pendingSend; },
    });
    await outbox.enqueue({ localOrderId: 11, restaurantId, payload });

    const first = outbox.flush();
    const second = outbox.flush();
    resolveSend({ order: { id: "server-order-3" } });
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  });

  it("does not lose an order enqueued while an earlier order is flushing", async () => {
    let resolveSend;
    const pendingSend = new Promise((resolve) => { resolveSend = resolve; });
    const { outbox } = setup({ async send() { return pendingSend; } });
    await outbox.enqueue({ localOrderId: 12, restaurantId, payload });

    const flushing = outbox.flush();
    const enqueueing = outbox.enqueue({ localOrderId: 13, restaurantId, payload });
    resolveSend({ order: { id: "server-order-4" } });
    await Promise.all([flushing, enqueueing]);

    const records = await outbox.list();
    assert.equal(records.length, 2);
    assert.equal(records[0].status, "synced");
    assert.equal(records[1].status, "pending");
  });
});

describe("browser order HTTP transport", () => {
  it("sends cookies and trusted restaurant context to the order endpoint", async () => {
    let request;
    const transport = createHttpOrderTransport({
      baseUrl: "https://pos.example.com",
      async fetchImpl(url, options) {
        request = { url, options };
        return { ok: true, status: 201, async json() { return { order: { id: "1" } }; } };
      },
    });
    const body = await transport.send({ restaurantId, payload: { ...payload, idempotencyKey } });

    assert.equal(request.url, "https://pos.example.com/api/pos/orders");
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.headers["x-restaurant-id"], restaurantId);
    assert.equal(JSON.parse(request.options.body).idempotencyKey, idempotencyKey);
    assert.equal(body.order.id, "1");
  });
});
