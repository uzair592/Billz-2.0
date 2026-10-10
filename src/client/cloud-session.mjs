import { OrderSyncError } from "./order-outbox.mjs";

export const CLOUD_SESSION_KEY = "pos_cloud_session_v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionError(message, { code, status = 0 } = {}) {
  return new OrderSyncError(message, { code: code ?? "CLOUD_SESSION_FAILED", status });
}

/**
 * The browser side of cloud authentication for a single POS device.
 *
 * The session lives in a server-set HttpOnly cookie, so this client can neither
 * read nor forge it. It only remembers which restaurant the till belongs to; the
 * server still decides whether that restaurant is actually allowed.
 */
export function createCloudSessionClient({
  storage,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new TypeError("storage must provide get and set functions.");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");

  async function call(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: "same-origin",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw sessionError(error.message || "The cloud service is unreachable.", {
        code: "CLOUD_UNREACHABLE",
      });
    }

    const payload = await (async () => {
      try {
        return await response.json();
      } catch {
        return null;
      }
    })();
    if (!response.ok) {
      throw sessionError(payload?.error ?? `Request failed with HTTP ${response.status}.`, {
        code: payload?.code ?? "CLOUD_REQUEST_FAILED",
        status: Number(response.status),
      });
    }
    return payload;
  }

  async function readStored() {
    const stored = await storage.get(CLOUD_SESSION_KEY);
    if (!stored || typeof stored !== "object") return { user: null, restaurantId: null };
    const restaurantId = stored.restaurantId ?? null;
    return {
      user: stored.user ?? null,
      restaurantId: UUID_PATTERN.test(restaurantId ?? "") ? restaurantId : null,
    };
  }

  async function writeStored(session) {
    const stored = { ...session, updatedAt: clock().toISOString() };
    await storage.set(CLOUD_SESSION_KEY, stored);
    return stored;
  }

  async function loadAccount() {
    return call("/api/auth/me");
  }

  async function listRestaurants() {
    return (await loadAccount())?.restaurants ?? [];
  }

  return Object.freeze({
    async currentUser() {
      const account = await loadAccount();
      const stored = await readStored();
      const restaurants = account?.restaurants ?? [];
      // A restaurant the account no longer has must never stay selected.
      const stillAllowed = stored.restaurantId
        && restaurants.some((restaurant) => restaurant.restaurantId === stored.restaurantId);
      const session = {
        user: account?.user ?? null,
        restaurantId: stillAllowed ? stored.restaurantId : null,
      };
      await writeStored(session);
      return { ...account, ...session };
    },

    async signIn(credentials) {
      const body = credentials.restaurantCode && credentials.username
        ? {
            restaurantCode: String(credentials.restaurantCode ?? "").trim(),
            username: String(credentials.username ?? "").trim(),
            password: String(credentials.password ?? ""),
          }
        : {
            email: String(credentials.email ?? "").trim(),
            password: String(credentials.password ?? ""),
          };

      await call("/api/auth/login", {
        method: "POST",
        body,
      });
      const account = await loadAccount();
      const restaurants = account?.restaurants ?? [];
      const previous = await readStored();
      const restaurantId = restaurants.length === 1 ? restaurants[0].restaurantId : null;
      if (previous.restaurantId !== restaurantId) await storage.set("pos_cloud_context_v1", null);
      const result = await writeStored({ user: account?.user ?? null, restaurantId });
      globalThis.dispatchEvent?.(new Event("billz-session-restored"));
      return result;
    },

    async signOut({ forgetRestaurant = false } = {}) {
      try {
        await call("/api/auth/logout", { method: "POST" });
      } finally {
        const stored = await readStored();
        await storage.set("pos_cloud_context_v1", null);
        await writeStored({
          user: null,
          restaurantId: forgetRestaurant ? null : stored.restaurantId,
        });
      }
      return { status: "signed_out" };
    },

    restaurants: listRestaurants,

    async selectRestaurant(restaurantId) {
      if (!UUID_PATTERN.test(String(restaurantId ?? ""))) {
        throw sessionError("A valid restaurant is required.", { code: "RESTAURANT_INVALID" });
      }
      const restaurants = await listRestaurants();
      if (!restaurants.some((restaurant) => restaurant.restaurantId === restaurantId)) {
        throw sessionError("This account does not belong to that restaurant.", {
          code: "RESTAURANT_NOT_ALLOWED",
          status: 403,
        });
      }
      const stored = await readStored();
      return writeStored({ user: stored.user, restaurantId });
    },

    async activeRestaurant() {
      return (await readStored()).restaurantId;
    },

    status: readStored,
  });
}