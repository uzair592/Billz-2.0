import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloudSessionClient, CLOUD_SESSION_KEY } from "../src/client/cloud-session.mjs";

const restaurantA = "11111111-1111-4111-8111-111111111111";
const restaurantB = "22222222-2222-4222-8222-222222222222";

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
  };
}

function account(restaurantIds) {
  return {
    user: { id: "user-1", email: "owner@example.com" },
    expiresAt: "2026-10-03T00:00:00.000Z",
    restaurants: restaurantIds.map((restaurantId) => ({
      restaurantId,
      name: `Restaurant ${restaurantId.slice(0, 8)}`,
      status: "active",
      currencyCode: "PKR",
      role: "owner",
      defaultBranchId: "99999999-9999-4999-8999-999999999999",
    })),
  };
}

function router(restaurants = [restaurantA], { meStatus = 200 } = {}) {
  const requests = [];
  return {
    requests,
    async fetchImpl(url, options = {}) {
      requests.push({ url, options });
      if (url === "/api/auth/login") {
        return { ok: true, status: 200, async json() { return { user: { id: "user-1" } }; } };
      }
      if (url === "/api/auth/logout") {
        return { ok: true, status: 204, async json() { return null; } };
      }
      if (url === "/api/auth/me") {
        if (meStatus !== 200) {
          return {
            ok: false,
            status: meStatus,
            async json() { return { error: "Authentication is required.", code: "UNAUTHENTICATED" }; },
          };
        }
        return { ok: true, status: 200, async json() { return account(restaurants); } };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
}

describe("browser cloud session client", () => {
  it("signs in with the cookie session and auto-selects a single restaurant", async () => {
    const storage = memoryStorage();
    const { fetchImpl, requests } = router([restaurantA]);
    const session = createCloudSessionClient({
      storage,
      fetchImpl,
      clock: () => new Date("2026-10-02T12:00:00.000Z"),
    });

    const result = await session.signIn({ email: " Owner@Example.com ", password: "secret" });

    assert.equal(result.restaurantId, restaurantA);
    assert.deepEqual(requests.map((request) => request.url), [
      "/api/auth/login",
      "/api/auth/me",
    ]);
    const [login] = requests;
    assert.equal(login.options.credentials, "same-origin");
    assert.deepEqual(JSON.parse(login.options.body), {
      email: "Owner@Example.com",
      password: "secret",
    });
    assert.equal((await storage.get(CLOUD_SESSION_KEY)).restaurantId, restaurantA);
    assert.equal(await session.activeRestaurant(), restaurantA);
  });

  it("never guesses a restaurant when the account has more than one", async () => {
    const session = createCloudSessionClient({
      storage: memoryStorage(),
      ...router([restaurantA, restaurantB]),
    });

    const result = await session.signIn({ email: "owner@example.com", password: "secret" });

    assert.equal(result.restaurantId, null);
    assert.equal(await session.activeRestaurant(), null);
  });

  it("selects only a restaurant the account actually belongs to", async () => {
    const storage = memoryStorage();
    const session = createCloudSessionClient({
      storage,
      ...router([restaurantA, restaurantB]),
    });
    await session.signIn({ email: "owner@example.com", password: "secret" });

    await assert.rejects(
      session.selectRestaurant("33333333-3333-4333-8333-333333333333"),
      (error) => error.code === "RESTAURANT_NOT_ALLOWED" && error.status === 403,
    );
    assert.equal(await session.activeRestaurant(), null);

    await session.selectRestaurant(restaurantB);
    assert.equal(await session.activeRestaurant(), restaurantB);
  });

  it("rejects a malformed restaurant identifier without a request", async () => {
    const session = createCloudSessionClient({
      storage: memoryStorage(),
      ...router([restaurantA]),
    });

    await assert.rejects(
      session.selectRestaurant("from-the-page"),
      (error) => error.code === "RESTAURANT_INVALID",
    );
  });

  it("forgets a restaurant the account can no longer use", async () => {
    const storage = memoryStorage();
    await storage.set(CLOUD_SESSION_KEY, { user: null, restaurantId: restaurantA });
    const session = createCloudSessionClient({
      storage,
      ...router([restaurantB]),
    });

    const result = await session.currentUser();

    assert.equal(result.restaurantId, null);
    assert.equal((await storage.get(CLOUD_SESSION_KEY)).restaurantId, null);
  });

  it("clears the session but keeps the selected restaurant on sign-out", async () => {
    const storage = memoryStorage();
    await storage.set(CLOUD_SESSION_KEY, {
      user: { id: "user-1" },
      restaurantId: restaurantA,
    });
    const session = createCloudSessionClient({ storage, ...router([restaurantA]) });

    await session.signOut();

    assert.equal((await storage.get(CLOUD_SESSION_KEY)).user, null);
    assert.equal(await session.activeRestaurant(), restaurantA);
  });

  it("can forget the restaurant completely when leaving a till", async () => {
    const storage = memoryStorage();
    await storage.set(CLOUD_SESSION_KEY, {
      user: { id: "user-1" },
      restaurantId: restaurantA,
    });
    const session = createCloudSessionClient({ storage, ...router([restaurantA]) });

    await session.signOut({ forgetRestaurant: true });

    assert.equal(await session.activeRestaurant(), null);
  });

  it("surfaces the server's reason when sign-in is refused", async () => {
    const session = createCloudSessionClient({
      storage: memoryStorage(),
      async fetchImpl(url) {
        if (url === "/api/auth/login") {
          return {
            ok: false,
            status: 401,
            async json() {
              return { error: "Invalid email or password.", code: "INVALID_CREDENTIALS" };
            },
          };
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await assert.rejects(
      session.signIn({ email: "owner@example.com", password: "wrong" }),
      (error) => error.code === "INVALID_CREDENTIALS" && error.status === 401,
    );
  });

  it("reports an unreachable cloud service instead of pretending to be signed in", async () => {
    const session = createCloudSessionClient({
      storage: memoryStorage(),
      async fetchImpl() { throw new Error("network down"); },
    });

    await assert.rejects(
      session.currentUser(),
      (error) => error.code === "CLOUD_UNREACHABLE" && error.retriable === false,
    );
  });

  it("reports an expired session rather than an empty account", async () => {
    const session = createCloudSessionClient({
      storage: memoryStorage(),
      ...router([restaurantA], { meStatus: 401 }),
    });

    await assert.rejects(
      session.currentUser(),
      (error) => error.code === "UNAUTHENTICATED" && error.status === 401,
    );
  });
  it("managed login writes the shared session without accessing an unselected tenant namespace", async t => {
    const previous=globalThis.BILLZ_MANAGED;globalThis.BILLZ_MANAGED=true;
    t.after(()=>{if(previous===undefined)delete globalThis.BILLZ_MANAGED;else globalThis.BILLZ_MANAGED=previous});
    const values=new Map();
    const storage={get:async key=>values.get(key),set:async(key,value)=>{
      assert.equal(key,CLOUD_SESSION_KEY,"business storage is unavailable before managed boot selects a tenant");
      values.set(key,value);
    }};
    const session=createCloudSessionClient({storage,...router([restaurantA])});
    assert.equal((await session.signIn({restaurantCode:"restaurant-a",username:"owner",password:"long-password"})).restaurantId,restaurantA);
  });

});