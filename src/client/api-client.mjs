/**
 * Unified API client for the POS frontend.
 *
 * A thin wrapper around fetch() with session cookie handling, JSON
 * normalization, and restaurant context via the x-restaurant-id header.
 *
 * The restaurant identity is resolved from the cloud session client,
 * which only ever holds a restaurant the server has already authorized
 * for this account — a value the browser cannot forge is never trusted
 * as authorization, the server re-checks it on every request.
 *
 * Network failures are normalized to CloudApiError with the
 * CLOUD_UNREACHABLE code so callers can distinguish "offline" from a
 * real API error and fall back to local data.
 */

const API_BASE = "/api";

export class CloudApiError extends Error {
  constructor(message, { status = 0, code = "CLOUD_API_ERROR", details } = {}) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function isUnreachable(error) {
  return error instanceof TypeError || error instanceof CloudApiError;
}

async function resolveRestaurantId() {
  const session = globalThis.BiteTechCloudSession;
  if (session && typeof session.activeRestaurant === "function") {
    try {
      const restaurantId = await session.activeRestaurant();
      if (restaurantId) return restaurantId;
    } catch {
      // Fall through — the server still decides what the header may access.
    }
  }
  return document.querySelector('meta[name="restaurant-id"]')?.content || null;
}

async function apiRequest(path, options = {}) {
  const restaurantId = await resolveRestaurantId();
  const headers = { "Content-Type": "application/json" };
  if (restaurantId) headers["x-restaurant-id"] = restaurantId;

  const init = {
    method: options.method || "GET",
    headers: { ...headers, ...options.headers },
    credentials: "include",
  };
  if (options.body !== undefined && !(options.body instanceof FormData)) {
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new CloudApiError("The cloud service is unreachable.", {
      code: "CLOUD_UNREACHABLE",
    });
  }

  const contentType = response.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await response.json();
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    throw new CloudApiError(data?.error || `HTTP ${response.status}`, {
      status: response.status,
      code: data?.code,
      details: data?.details,
    });
  }
  return data;
}

// Order history & detail — GET /api/pos/orders
export const orderHistoryApi = {
  /**
   * @param {Object} params
   * @param {string} [params.businessDate] - YYYY-MM-DD
   * @param {string} [params.from] - YYYY-MM-DD
   * @param {string} [params.to] - YYYY-MM-DD
   * @param {string} [params.orderStatus] - new|preparing|ready|served|completed|cancelled
   * @param {string} [params.paymentStatus] - unpaid|partially_paid|paid|refunded
   * @param {string} [params.search] - customer name or phone fragment
   * @param {number} [params.limit] - page size, 1..200 (default 50)
   * @param {string} [params.cursor] - pagination cursor from nextCursor
   */
  async list(params = {}) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        query.append(key, String(value));
      }
    });
    const suffix = query.toString();
    return apiRequest(`/pos/orders${suffix ? `?${suffix}` : ""}`);
  },

  /** @param {string} orderId - UUID */
  async get(orderId) {
    return apiRequest(`/pos/orders/${encodeURIComponent(orderId)}`);
  },
};

// Order cancellation — POST /api/pos/orders/:orderId/cancel
export const orderCancellationApi = {
  /**
   * @param {string} orderId - UUID
   * @param {Object} options
   * @param {string} [options.reason]
   * @param {string} options.idempotencyKey - UUID; replaying the same key
   *   returns the stored cancellation instead of compensating twice.
   */
  async cancel(orderId, { reason, idempotencyKey }) {
    return apiRequest(`/pos/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: "POST",
      body: { reason, idempotencyKey },
    });
  },
};

// Order creation — POST /api/pos/orders
export const orderApi = {
  /**
   * @param {Object} orderData
   * @param {string} orderData.idempotencyKey - UUID
   * @param {string} orderData.businessDate - YYYY-MM-DD
   * @param {string} orderData.orderType - dine_in|takeaway|delivery
   * @param {string} [orderData.tableId] - UUID
   * @param {string} [orderData.customerName]
   * @param {string} [orderData.customerPhone]
   * @param {string} [orderData.riderName]
   * @param {Array} orderData.items - [{menuItemId, quantity}]
   * @param {Object} [orderData.discount] - {type: flat|percent, valueMinor|value}
   * @param {number} [orderData.deliveryMinor]
   * @param {Array} [orderData.additionalCharges] - [{type, name, valueMinor|value}]
   * @param {Object} [orderData.payment] - {method, amountReceivedMinor, financialAccountId}
   */
  async create(orderData) {
    return apiRequest("/pos/orders", {
      method: "POST",
      body: orderData,
    });
  },
};

// Billing — /api/billing (deliberately reachable without a paid subscription)
export const billingApi = {
  async overview() {
    return apiRequest("/billing");
  },

  /**
   * @param {Object} params
   * @param {string} params.planCode
   * @param {string} params.successUrl - HTTPS URL on the application origin
   * @param {string} params.cancelUrl - HTTPS URL on the application origin
   * @param {string} params.idempotencyKey - UUID
   */
  async startCheckout({ planCode, successUrl, cancelUrl, idempotencyKey }) {
    return apiRequest("/billing/checkout", {
      method: "POST",
      body: { planCode, successUrl, cancelUrl, idempotencyKey },
    });
  },

  async changePlan(planCode) {
    return apiRequest("/billing/change-plan", {
      method: "POST",
      body: { planCode },
    });
  },

  async cancel(cancelAtPeriodEnd = true) {
    return apiRequest("/billing/cancel", {
      method: "POST",
      body: { cancelAtPeriodEnd },
    });
  },

  async resume() {
    return apiRequest("/billing/resume", { method: "POST" });
  },

  async payments(limit = 20) {
    return apiRequest(`/billing/payments?limit=${limit}`);
  },
};

// Cloud session — /api/auth/*
export const cloudSessionApi = {
  async currentUser() {
    return apiRequest("/auth/me");
  },

  async restaurantsForUser() {
    const data = await apiRequest("/auth/me");
    return data.restaurants || [];
  },

  async signIn(email, password) {
    return apiRequest("/auth/login", {
      method: "POST",
      body: { email, password },
    });
  },

  async signOut() {
    return apiRequest("/auth/logout", { method: "POST" });
  },

  async selectRestaurant(restaurantId) {
    return apiRequest("/auth/select-restaurant", {
      method: "POST",
      body: { restaurantId },
    });
  },
};

// Catalog import — POST /api/pos/import/legacy-catalog
export const cloudSyncApi = {
  async importCatalog(snapshot) {
    return apiRequest("/pos/import/legacy-catalog", {
      method: "POST",
      body: snapshot,
    });
  },
};

export function generateIdempotencyKey() {
  return crypto.randomUUID();
}

export const api = {
  orders: orderHistoryApi,
  orderCancellation: orderCancellationApi,
  createOrder: orderApi,
  billing: billingApi,
  cloud: cloudSessionApi,
  sync: cloudSyncApi,
};

export default api;
export { isUnreachable };
