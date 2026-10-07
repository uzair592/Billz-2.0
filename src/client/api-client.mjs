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
 * Failures are classified into explicit categories (ApiErrorKind).
 * Only genuine network failures are "unreachable" — an HTTP 401, 402,
 * 403, 404, 409, 422, 429 or 5xx response is a real API answer, not
 * an outage, and callers must not treat it as "offline" or silently
 * fall back to local data because of it.
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

/**
 * Failure categories. These are the only classifications callers
 * should branch on — never on the raw status alone, because the
 * server also uses 402 for subscription gates and 409 for
 * idempotent replays, both of which need distinct handling.
 */
export const ApiErrorKind = Object.freeze({
  UNREACHABLE: "unreachable",
  AUTHENTICATION: "authentication",
  AUTHORIZATION: "authorization",
  SUBSCRIPTION: "subscription",
  VALIDATION: "validation",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  SERVER: "server",
  INVALID_RESPONSE: "invalid_response",
  UNKNOWN: "unknown",
});

const SUBSCRIPTION_CODE_PATTERN = /SUBSCRIPTION|PLAN|BILLING/i;

/**
 * Classify an error thrown by this client.
 *
 * - a TypeError from fetch() or a CLOUD_UNREACHABLE CloudApiError
 *   (status 0) is a genuine network failure;
 * - 401 is an authentication failure (expired/missing session);
 * - 402 is the server's subscription gate on /api/pos routes;
 * - 403 is authorization, unless the server code marks it as a
 *   subscription/plan/billing restriction;
 * - 404 is a missing resource, 409 a conflict or idempotent replay,
 *   422/400 a validation failure, 429 a rate limit, 5xx a server
 *   failure;
 * - an unreadable response body is INVALID_RESPONSE.
 */
export function classifyApiError(error) {
  if (error instanceof TypeError) return ApiErrorKind.UNREACHABLE;
  if (!(error instanceof CloudApiError)) return ApiErrorKind.UNKNOWN;
  if (error.code === "CLOUD_UNREACHABLE" || !error.status) {
    return ApiErrorKind.UNREACHABLE;
  }
  // A malformed body is its own category even when the
  // HTTP status itself is a 5xx.
  if (error.code === "INVALID_RESPONSE") {
    return ApiErrorKind.INVALID_RESPONSE;
  }
  switch (error.status) {
    case 400:
    case 422:
      return ApiErrorKind.VALIDATION;
    case 401:
      return ApiErrorKind.AUTHENTICATION;
    case 402:
      return ApiErrorKind.SUBSCRIPTION;
    case 403:
      return SUBSCRIPTION_CODE_PATTERN.test(String(error.code ?? ""))
        ? ApiErrorKind.SUBSCRIPTION
        : ApiErrorKind.AUTHORIZATION;
    case 404:
      return ApiErrorKind.NOT_FOUND;
    case 409:
      return ApiErrorKind.CONFLICT;
    case 429:
      return ApiErrorKind.RATE_LIMITED;
    default:
      return error.status >= 500 ? ApiErrorKind.SERVER : ApiErrorKind.UNKNOWN;
  }
}

/**
 * Whether retrying the same request can succeed later. Network
 * failures, rate limits and server failures are transient; client
 * errors (auth, validation, not found) are not.
 */
export function isRetriableApiError(error) {
  const kind = classifyApiError(error);
  return (
    kind === ApiErrorKind.UNREACHABLE
    || kind === ApiErrorKind.RATE_LIMITED
    || kind === ApiErrorKind.SERVER
  );
}

/**
 * A short, user-facing message for an error. Never includes raw
 * server output, stack traces or sensitive details.
 */
export function describeCloudError(error) {
  switch (classifyApiError(error)) {
    case ApiErrorKind.UNREACHABLE:
      return "The cloud service is unreachable. Check your connection.";
    case ApiErrorKind.AUTHENTICATION:
      return "Your cloud session expired. Sign in again.";
    case ApiErrorKind.AUTHORIZATION:
      return "You don't have permission to do that.";
    case ApiErrorKind.SUBSCRIPTION:
      return "This restaurant's subscription is not active. Open Billing to restore access.";
    case ApiErrorKind.VALIDATION:
      return "The request was not valid. Review the entered values.";
    case ApiErrorKind.NOT_FOUND:
      return "The requested resource no longer exists.";
    case ApiErrorKind.CONFLICT:
      return "The request conflicted with a recent change. Review and try again.";
    case ApiErrorKind.RATE_LIMITED:
      return "Too many requests. Wait a moment and try again.";
    case ApiErrorKind.SERVER:
      return "The cloud could not complete the request. Try again.";
    case ApiErrorKind.INVALID_RESPONSE:
      return "The cloud returned an unreadable response.";
    default:
      return "The request could not be completed.";
  }
}

function isUnreachable(error) {
  return classifyApiError(error) === ApiErrorKind.UNREACHABLE;
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
  try {
    data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
  } catch {
    throw new CloudApiError("The cloud returned an unreadable response.", {
      status: response.status,
      code: "INVALID_RESPONSE",
    });
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

export const orderRefundApi = {
  async createRefund(orderId, refundPayload, idempotencyKey) {
    const key = idempotencyKey || generateIdempotencyKey();
    return apiRequest(`/pos/orders/${encodeURIComponent(orderId)}/refunds`, {
      method: "POST",
      headers: {
        "Idempotency-Key": key,
      },
      body: {
        ...refundPayload,
        idempotencyKey: key,
      },
    });
  },

  async listRefunds(orderId) {
    return apiRequest(`/pos/orders/${encodeURIComponent(orderId)}/refunds`);
  },

  async getRefund(refundId) {
    return apiRequest(`/pos/refunds/${encodeURIComponent(refundId)}`);
  },
};

export const salesReportApi = {
  async getSalesReport(params = {}) {
    const query = new URLSearchParams();
    if (params.startDate) query.set("startDate", params.startDate);
    if (params.endDate) query.set("endDate", params.endDate);
    if (params.timezone) query.set("timezone", params.timezone);
    if (params.orderType) query.set("orderType", params.orderType);
    if (params.paymentMethod) query.set("paymentMethod", params.paymentMethod);
    if (params.groupBy) query.set("groupBy", params.groupBy);
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));

    const queryString = query.toString();
    const url = `/pos/reports/sales${queryString ? `?${queryString}` : ""}`;
    return apiRequest(url);
  },

  async downloadSalesReportCsv(params = {}) {
    const query = new URLSearchParams();
    if (params.startDate) query.set("startDate", params.startDate);
    if (params.endDate) query.set("endDate", params.endDate);
    if (params.timezone) query.set("timezone", params.timezone);
    if (params.orderType) query.set("orderType", params.orderType);
    if (params.paymentMethod) query.set("paymentMethod", params.paymentMethod);

    const queryString = query.toString();
    const url = `${API_BASE}/pos/reports/sales/export${queryString ? `?${queryString}` : ""}`;
    window.location.href = url;
  },
};

function buildQuery(params, keys) {
  const query = new URLSearchParams();
  for (const key of keys) {
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

// Menu — GET /api/pos/menu, used by the recipe
// editor to list the restaurant's products.
export const menuApi = {
  async list() {
    return apiRequest("/pos/menu");
  },
};

// Suppliers — GET/POST /api/pos/suppliers, PATCH /api/pos/suppliers/:supplierId
export const supplierApi = {
  async list({ isActive } = {}) {
    const query = new URLSearchParams();
    if (isActive !== undefined && isActive !== null) {
      query.set("isActive", String(isActive));
    }
    const queryString = query.toString();
    return apiRequest(`/pos/suppliers${queryString ? `?${queryString}` : ""}`);
  },

  async create(payload) {
    return apiRequest("/pos/suppliers", {
      method: "POST",
      body: payload,
    });
  },

  async update(supplierId, payload) {
    return apiRequest(`/pos/suppliers/${encodeURIComponent(supplierId)}`, {
      method: "PATCH",
      body: payload,
    });
  },
};

// Inventory — items, low-stock warnings, the immutable
// movement ledger, adjustments, and waste.
export const inventoryApi = {
  async list({ search, isActive, limit, cursor } = {}) {
    const query = new URLSearchParams();
    if (search) query.set("search", search);
    if (isActive !== undefined && isActive !== null) {
      query.set("isActive", String(isActive));
    }
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const queryString = query.toString();
    return apiRequest(`/pos/inventory/items${queryString ? `?${queryString}` : ""}`);
  },

  async create(payload) {
    return apiRequest("/pos/inventory/items", {
      method: "POST",
      body: payload,
    });
  },

  async get(itemId) {
    return apiRequest(`/pos/inventory/items/${encodeURIComponent(itemId)}`);
  },

  async update(itemId, payload) {
    return apiRequest(`/pos/inventory/items/${encodeURIComponent(itemId)}`, {
      method: "PATCH",
      body: payload,
    });
  },

  async lowStock({ limit } = {}) {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    const queryString = query.toString();
    return apiRequest(`/pos/inventory/low-stock${queryString ? `?${queryString}` : ""}`);
  },

  async movements({ itemId, limit, cursor } = {}) {
    const query = new URLSearchParams();
    if (itemId) query.set("itemId", itemId);
    if (limit) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const queryString = query.toString();
    return apiRequest(`/pos/inventory/movements${queryString ? `?${queryString}` : ""}`);
  },

  async adjust(payload) {
    return apiRequest("/pos/inventory/adjustments", {
      method: "POST",
      body: payload,
    });
  },

  async waste(payload) {
    return apiRequest("/pos/inventory/waste", {
      method: "POST",
      body: payload,
    });
  },
};

// Recipes — GET/PUT /api/pos/products/:productId/recipe
export const recipeApi = {
  async get(productId) {
    return apiRequest(`/pos/products/${encodeURIComponent(productId)}/recipe`);
  },

  async replace(productId, items) {
    return apiRequest(`/pos/products/${encodeURIComponent(productId)}/recipe`, {
      method: "PUT",
      body: { items },
    });
  },
};

// Purchases — draft purchasing documents and receiving.
export const purchaseApi = {
  async list({ status, limit, cursor } = {}) {
    const queryString = buildQuery({ status, limit, cursor }, ["status", "limit", "cursor"]);
    return apiRequest(`/pos/purchases${queryString}`);
  },

  async create(payload) {
    return apiRequest("/pos/purchases", {
      method: "POST",
      body: payload,
    });
  },

  async get(purchaseId) {
    return apiRequest(`/pos/purchases/${encodeURIComponent(purchaseId)}`);
  },

  async update(purchaseId, payload) {
    return apiRequest(`/pos/purchases/${encodeURIComponent(purchaseId)}`, {
      method: "PATCH",
      body: payload,
    });
  },

  async receive(purchaseId, idempotencyKey) {
    const key = idempotencyKey || generateIdempotencyKey();
    return apiRequest(`/pos/purchases/${encodeURIComponent(purchaseId)}/receive`, {
      method: "POST",
      headers: {
        "Idempotency-Key": key,
      },
      body: { idempotencyKey: key },
    });
  },
};

export const api = {
  menu: menuApi,
  orders: orderHistoryApi,
  orderCancellation: orderCancellationApi,
  refunds: orderRefundApi,
  salesReport: salesReportApi,
  createOrder: orderApi,
  billing: billingApi,
  cloud: cloudSessionApi,
  sync: cloudSyncApi,
  suppliers: supplierApi,
  inventory: inventoryApi,
  recipes: recipeApi,
  purchases: purchaseApi,
};

export default api;
export { isUnreachable };
