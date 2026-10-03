import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudStatus } from "../src/client/cloud-status.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";

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

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setup({ context = null, outbox = [], billing = null, online = true } = {}) {
  const badges = [];
  const storage = {
    async get(key) {
      if (key === "pos_cloud_context_v1") return context;
      if (key === "pos_cloud_order_outbox_v1") return outbox;
      return null;
    },
    async set() {},
  };

  const previous = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    navigatorDescriptor: Object.getOwnPropertyDescriptor(
      globalThis,
      "navigator",
    ),
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };

  globalThis.fetch = async () =>
    billing === null
      ? Promise.reject(new TypeError("network down"))
      : Promise.resolve(jsonResponse(billing));
  globalThis.document = {
    querySelector: () => {
      const badge = {
        style: {},
        className: "status-badge",
        children: [],
        _text: "",
        set textContent(value) {
          this._text = value;
          this.children = [];
        },
        get textContent() {
          return (
            this._text +
            this.children
              .map((child) => child.text ?? child.textContent ?? "")
              .join("")
          );
        },
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
      badges.push(badge);
      return badge;
    },
    createElement: () => ({ style: {} }),
    createTextNode: (text) => ({ text }),
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: online },
    configurable: true,
  });
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };
  globalThis.clearInterval = () => {};

  const status = createCloudStatus({ storage, refreshIntervalMs: 60_000 });

  return {
    badges,
    intervals,
    status,
    async refreshAndWait() {
      await status.refresh();
      await flush();
    },
    restore() {
      status.stop();
      globalThis.fetch = previous.fetch;
      globalThis.document = previous.document;
      if (previous.navigatorDescriptor) {
        Object.defineProperty(
          globalThis,
          "navigator",
          previous.navigatorDescriptor,
        );
      }
      globalThis.addEventListener = previous.addEventListener;
      globalThis.removeEventListener = previous.removeEventListener;
      globalThis.setInterval = previous.setInterval;
      globalThis.clearInterval = previous.clearInterval;
    },
  };
}

function latestLabel(badges) {
  assert.ok(badges.length > 0, "the badge was rendered");
  return badges.at(-1).textContent.trim();
}

describe("cloud status indicator", () => {
  it("reports offline first, before any cloud state", async () => {
    const { badges, restore } = setup({ online: false });
    try {
      await flush();
      assert.match(latestLabel(badges), /Offline — sales keep working locally/);
    } finally {
      restore();
    }
  });

  it("stays on the legacy default until a catalog is imported", async () => {
    const { badges, refreshAndWait, restore } = setup({ context: null });
    try {
      await refreshAndWait();
      assert.equal(latestLabel(badges), "Offline & ready");
    } finally {
      restore();
    }
  });

  it("shows connected once the catalog is imported and synced", async () => {
    const { badges, refreshAndWait, restore } = setup({
      context: { restaurantId },
      outbox: [{ localOrderId: 1, status: "synced" }],
    });
    try {
      await refreshAndWait();
      assert.equal(latestLabel(badges), "Cloud connected");
    } finally {
      restore();
    }
  });

  it("counts pending outbox records", async () => {
    const { badges, refreshAndWait, restore } = setup({
      context: { restaurantId },
      outbox: [
        { localOrderId: 1, status: "pending" },
        { localOrderId: 2, status: "retrying" },
        { localOrderId: 3, status: "synced" },
      ],
    });
    try {
      await refreshAndWait();
      assert.equal(latestLabel(badges), "Cloud syncing (2 pending)");
    } finally {
      restore();
    }
  });

  it("surfaces failed syncs above pending ones", async () => {
    const { badges, refreshAndWait, restore } = setup({
      context: { restaurantId },
      outbox: [
        { localOrderId: 1, status: "failed" },
        { localOrderId: 2, status: "pending" },
      ],
    });
    try {
      await refreshAndWait();
      assert.equal(latestLabel(badges), "Cloud sync failed (1)");
    } finally {
      restore();
    }
  });

  it("flags subscription problems that restrict POS access", async () => {
    const { badges, refreshAndWait, restore } = setup({
      context: { restaurantId },
      billing: {
        plans: [],
        subscription: { id: "sub", status: "expired", plan: null },
      },
    });
    try {
      await refreshAndWait();
      assert.equal(
        latestLabel(badges),
        "Subscription problem — billing access only",
      );
    } finally {
      restore();
    }
  });

  it("ignores healthy subscriptions", async () => {
    const { badges, refreshAndWait, restore } = setup({
      context: { restaurantId },
      billing: {
        plans: [],
        subscription: { id: "sub", status: "active", plan: null },
      },
    });
    try {
      await refreshAndWait();
      assert.equal(latestLabel(badges), "Cloud connected");
    } finally {
      restore();
    }
  });

  it("refreshes on a timer and can be stopped", async () => {
    const { intervals, status, refreshAndWait, restore } = setup({
      context: { restaurantId },
    });
    try {
      await refreshAndWait();
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0].ms, 60_000);
      status.stop();
      await status.refresh();
    } finally {
      restore();
    }
  });
});
