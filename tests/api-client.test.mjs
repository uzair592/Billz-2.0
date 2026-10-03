import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CloudApiError,
  api,
  billingApi,
  cloudSessionApi,
  generateIdempotencyKey,
  orderCancellationApi,
  orderHistoryApi,
} from "../src/client/api-client.mjs";

function withMocks({ fetchImpl, restaurantId, session } = {}) {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const previousSession = globalThis.BiteTechCloudSession;

  globalThis.fetch = fetchImpl ?? (async () => {
    throw new TypeError("fetch should have been mocked");
  });
  globalThis.document = {
    querySelector: () => null,
  };
  globalThis.BiteTechCloudSession = session ?? {
    activeRestaurant: async () => restaurantId ?? null,
  };

  return () => {
    globalThis.fetch = previousFetch;
    globalThis.document = previousDocument;
    globalThis.BiteTechCloudSession = previousSession;
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

describe("api client", () => {
  it("sends the authorized restaurant header and session cookie", async () => {
    const requests = [];
    const restore = withMocks({
      restaurantId: "11111111-1111-4111-8111-111111111111",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ orders: [], summary: {}, nextCursor: null });
      },
    });
    try {
      await orderHistoryApi.list({ limit: 25, search: "ayesha" });
    } finally {
      restore();
    }

    assert.equal(requests[0].url, "/api/pos/orders?limit=25&search=ayesha");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(
      requests[0].init.headers["x-restaurant-id"],
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("omits the restaurant header when no restaurant is selected", async () => {
    const requests = [];
    const restore = withMocks({
      restaurantId: null,
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({});
      },
    });
    try {
      await orderHistoryApi.get("11111111-1111-4111-8111-111111111111");
    } finally {
      restore();
    }

    assert.equal(requests[0].url, "/api/pos/orders/11111111-1111-4111-8111-111111111111");
    assert.equal("x-restaurant-id" in requests[0].init.headers, false);
  });

  it("normalizes network failures to CLOUD_UNREACHABLE", async () => {
    const restore = withMocks({
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
    });
    try {
      await assert.rejects(
        () => orderHistoryApi.list(),
        (error) =>
          error instanceof CloudApiError &&
          error.code === "CLOUD_UNREACHABLE" &&
          error.status === 0,
      );
    } finally {
      restore();
    }
  });

  it("propagates API error status, code and details", async () => {
    const restore = withMocks({
      fetchImpl: async () =>
        jsonResponse(
          { error: "Order not found.", code: "ORDER_NOT_FOUND", details: { orderId: "x" } },
          { status: 404 },
        ),
    });
    try {
      await assert.rejects(
        () => orderHistoryApi.get("x"),
        (error) =>
          error instanceof CloudApiError &&
          error.status === 404 &&
          error.code === "ORDER_NOT_FOUND" &&
          error.message === "Order not found." &&
          error.details.orderId === "x",
      );
    } finally {
      restore();
    }
  });

  it("posts cancellations with the idempotency key", async () => {
    const requests = [];
    const restore = withMocks({
      restaurantId: "11111111-1111-4111-8111-111111111111",
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return jsonResponse({ order: {}, cancellation: {}, replayed: false });
      },
    });
    try {
      await orderCancellationApi.cancel("11111111-1111-4111-8111-111111111111", {
        reason: "wrong order",
        idempotencyKey: "99999999-9999-4999-8999-999999999999",
      });
    } finally {
      restore();
    }

    assert.equal(
      requests[0].url,
      "/api/pos/orders/11111111-1111-4111-8111-111111111111/cancel",
    );
    assert.equal(requests[0].init.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      reason: "wrong order",
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
    });
  });

  it("calls the auth endpoints without doubling the /api prefix", async () => {
    const urls = [];
    const restore = withMocks({
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonResponse({ user: { id: "u" }, restaurants: [] });
      },
    });
    try {
      await cloudSessionApi.signIn("a@b.c", "secret");
      await cloudSessionApi.signOut();
      await cloudSessionApi.selectRestaurant("11111111-1111-4111-8111-111111111111");
      await cloudSessionApi.currentUser();
    } finally {
      restore();
    }

    assert.deepEqual(urls, [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/auth/select-restaurant",
      "/api/auth/me",
    ]);
  });

  it("reaches every billing endpoint", async () => {
    const urls = [];
    const restore = withMocks({
      fetchImpl: async (url) => {
        urls.push(url);
        return jsonResponse({});
      },
    });
    try {
      await billingApi.overview();
      await billingApi.startCheckout({
        planCode: "STANDARD",
        successUrl: "https://app.example/billing",
        cancelUrl: "https://app.example/billing",
        idempotencyKey: "99999999-9999-4999-8999-999999999999",
      });
      await billingApi.changePlan("STANDARD");
      await billingApi.cancel(true);
      await billingApi.resume();
      await billingApi.payments(10);
    } finally {
      restore();
    }

    assert.deepEqual(urls, [
      "/api/billing",
      "/api/billing/checkout",
      "/api/billing/change-plan",
      "/api/billing/cancel",
      "/api/billing/resume",
      "/api/billing/payments?limit=10",
    ]);
  });

  it("generates idempotency keys as UUIDs", () => {
    assert.match(
      generateIdempotencyKey(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("exposes the api facade without key collisions", () => {
    assert.equal(api.orders.list, orderHistoryApi.list);
    assert.equal(api.orderCancellation.cancel, orderCancellationApi.cancel);
    assert.equal(api.billing.overview, billingApi.overview);
    assert.equal(api.cloud.signIn, cloudSessionApi.signIn);
  });
});
