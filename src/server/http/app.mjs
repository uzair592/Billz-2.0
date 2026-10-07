import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PERMISSION } from "../authorization/permissions.mjs";
import { ACCESS_LEVEL } from "../subscriptions/access-policy.mjs";
import { SESSION_COOKIE_NAME } from "./request-guards.mjs";
import { createRequestGuards } from "./request-guards.mjs";
import { createStaticFileHandler } from "./static-files.mjs";

const registrationSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(10).max(200),
  displayName: z.string().trim().min(1).max(120),
  restaurantName: z.string().trim().min(1).max(160),
});

const loginSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(200),
});

const verificationSchema = z.object({
  token: z.string().min(32).max(200),
});

const businessSettingsSchema = z
  .object({
    businessName: z.string().trim().min(1).max(160).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    slogan: z.string().trim().max(200).nullable().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one setting is required.");

const flatChargeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.literal("flat"),
  valueMinor: z.number().int().min(0),
}).strict();

const percentChargeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.literal("percent"),
  value: z.number().min(0).max(100),
}).strict();

const orderSchema = z.object({
  idempotencyKey: z.uuid(),
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderType: z.enum(["dine_in", "takeaway", "delivery"]),
  tableId: z.uuid().nullable().optional(),
  customerName: z.string().trim().max(160).nullable().optional(),
  customerPhone: z.string().trim().max(40).nullable().optional(),
  riderName: z.string().trim().max(120).nullable().optional(),
  items: z.array(z.object({
    menuItemId: z.uuid(),
    quantity: z.number().int().min(1).max(999),
  }).strict()).min(1).max(100),
  discount: z.discriminatedUnion("type", [
    z.object({ type: z.literal("flat"), valueMinor: z.number().int().min(0) }).strict(),
    z.object({ type: z.literal("percent"), value: z.number().min(0).max(100) }).strict(),
  ]).optional(),
  deliveryMinor: z.number().int().min(0).default(0),
  additionalCharges: z.array(
    z.discriminatedUnion("type", [flatChargeSchema, percentChargeSchema]),
  ).max(20).default([]),
  payment: z.object({
    method: z.enum(["cash", "bank_account", "other"]),
    amountReceivedMinor: z.number().int().positive(),
    financialAccountId: z.uuid().optional(),
  }).strict().optional(),
}).strict();

const orderHistoryQuerySchema = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderStatus: z.enum(["new", "preparing", "ready", "served", "completed", "cancelled"]).optional(),
  paymentStatus: z.enum(["unpaid", "partially_paid", "paid", "refunded"]).optional(),
  search: z.string().trim().max(160).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().max(120).optional(),
}).strict();

const orderParamsSchema = z.object({ orderId: z.uuid() }).strict();

const cancelOrderSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: z.uuid(),
}).strict();

const createRefundSchema = z.object({
  idempotencyKey: z.uuid().optional(),
  reason: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(1000).optional(),
  amountMinor: z.number().int().positive().optional(),
  items: z.array(
    z.object({
      orderItemId: z.uuid(),
      quantity: z.number().positive().max(1000),
      restock: z.boolean().default(false),
    }).strict(),
  ).max(100).optional(),
}).strict();

const refundParamsSchema = z.object({ refundId: z.uuid() }).strict();

const salesReportQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().trim().max(100).optional(),
  orderType: z.enum(["dine_in", "takeaway", "delivery"]).optional(),
  paymentMethod: z.enum(["cash", "bank_account", "other"]).optional(),
  groupBy: z.enum(["day", "week", "month"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

const checkoutSchema = z.object({
  planCode: z.string().trim().min(1).max(64),
  successUrl: z.string().trim().min(1).max(2_000),
  cancelUrl: z.string().trim().min(1).max(2_000),
  idempotencyKey: z.uuid(),
}).strict();

const changePlanSchema = z.object({
  planCode: z.string().trim().min(1).max(64),
}).strict();

const cancelSubscriptionSchema = z.object({
  cancelAtPeriodEnd: z.boolean().default(true),
}).strict();

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactPerson: z.string().trim().min(1).max(200).nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  email: z.string().trim().min(1).max(320).nullable().optional(),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

const supplierUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  contactPerson: z.string().trim().min(1).max(200).nullable().optional(),
  phone: z.string().trim().min(1).max(40).nullable().optional(),
  email: z.string().trim().min(1).max(320).nullable().optional(),
  address: z.string().trim().min(1).max(500).nullable().optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict();

const supplierParamsSchema = z.object({ supplierId: z.uuid() }).strict();

const inventoryItemSchema = z.object({
  idempotencyKey: z.uuid(),
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  baseUnit: z.enum(["piece", "gram", "kilogram", "millilitre", "litre"]),
  openingQuantity: z.number().finite().min(0).max(999_999_999).optional(),
  reorderLevel: z.number().finite().min(0).max(999_999_999).optional(),
  averageCostMinor: z.number().int().min(0).max(999_999_999_999).optional(),
}).strict();

const inventoryItemUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().min(1).max(64).nullable().optional(),
  reorderLevel: z.number().finite().min(0).max(999_999_999).optional(),
  averageCostMinor: z.number().int().min(0).max(999_999_999_999).optional(),
  isActive: z.boolean().optional(),
}).strict();

const inventoryItemParamsSchema = z.object({ itemId: z.uuid() }).strict();

const inventoryListQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().max(500).optional(),
}).strict();

const inventoryMovementsQuerySchema = z.object({
  itemId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().max(500).optional(),
}).strict();

const inventoryAdjustmentSchema = z.object({
  idempotencyKey: z.uuid(),
  itemId: z.uuid(),
  direction: z.enum(["increase", "decrease"]),
  quantity: z.number().finite().min(0).max(999_999_999),
  reason: z.string().trim().min(1).max(2000),
}).strict();

const inventoryWasteSchema = z.object({
  idempotencyKey: z.uuid(),
  itemId: z.uuid(),
  quantity: z.number().finite().min(0).max(999_999_999),
  reason: z.string().trim().min(1).max(2000),
}).strict();

const recipeReplaceSchema = z.object({
  items: z.array(z.object({
    inventoryItemId: z.uuid(),
    quantityRequired: z.number().finite().min(0).max(999_999_999),
  }).strict()).max(100),
}).strict();

const recipeParamsSchema = z.object({ productId: z.uuid() }).strict();

const purchaseLineSchema = z.object({
  inventoryItemId: z.uuid(),
  quantity: z.number().finite().min(0).max(999_999_999),
  unitCostMinor: z.number().int().min(0).max(999_999_999_999),
}).strict();

const purchaseSchema = z.object({
  idempotencyKey: z.uuid(),
  supplierId: z.uuid(),
  supplierInvoiceNumber: z.string().trim().min(1).max(100).nullable().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  discountMinor: z.number().int().min(0).max(999_999_999_999).optional(),
  taxMinor: z.number().int().min(0).max(999_999_999_999).optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  items: z.array(purchaseLineSchema).min(1).max(100),
}).strict();

const purchaseUpdateSchema = z.object({
  supplierId: z.uuid().optional(),
  supplierInvoiceNumber: z.string().trim().min(1).max(100).nullable().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  discountMinor: z.number().int().min(0).max(999_999_999_999).optional(),
  taxMinor: z.number().int().min(0).max(999_999_999_999).optional(),
  notes: z.string().trim().min(1).max(2000).nullable().optional(),
  items: z.array(purchaseLineSchema).min(1).max(100).optional(),
}).strict();

const purchaseReceiveSchema = z.object({
  idempotencyKey: z.uuid().optional(),
}).strict();

const purchaseParamsSchema = z.object({ purchaseId: z.uuid() }).strict();

const purchaseListQuerySchema = z.object({
  status: z.enum(["draft", "received", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().max(500).optional(),
}).strict();

const legacyDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
const legacyCategoryOfferSchema = z.object({
  active: z.boolean(),
  discountType: z.enum(["flat", "percent"]),
  discountValue: z.number().positive().max(1_000_000),
  startDate: legacyDateSchema,
  endDate: legacyDateSchema,
}).passthrough().refine(
  (offer) => offer.discountType !== "percent" || offer.discountValue <= 100,
  "Percentage discounts cannot exceed 100.",
);
const legacyMenuItemSchema = z.object({
  id: z.number().int().safe().nonnegative(),
  itemNumber: z.number().int().safe().positive().nullable().optional(),
  category: z.string().trim().min(1).max(160),
  subcategory: z.string().trim().max(160).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  desc: z.string().max(2_000).nullable().optional(),
  price: z.number().finite().min(0).max(10_000_000),
  recipeOthersCost: z.number().finite().min(0).max(10_000_000).optional(),
  dealComponents: z.array(z.object({
    itemId: z.number().int().safe().nonnegative(),
    qty: z.number().positive().max(10_000),
  }).passthrough()).max(500).optional(),
  offerActive: z.boolean().optional(),
  offerPrice: z.number().finite().min(0).max(10_000_000).optional(),
  offerStartDate: legacyDateSchema,
  offerEndDate: legacyDateSchema,
  softDrinkKey: z.string().trim().min(1).max(300).optional(),
  iceCreamKey: z.string().trim().min(1).max(300).optional(),
}).passthrough();
export const legacyCatalogSchema = z.object({
  pos_categories: z.array(z.string().trim().min(1).max(160)).max(1_000),
  pos_subcategories: z.record(
    z.string(),
    z.array(z.string().trim().min(1).max(160)).max(1_000),
  ).default({}),
  pos_category_offers: z.record(z.string(), legacyCategoryOfferSchema).default({}),
  pos_menu: z.array(legacyMenuItemSchema).max(10_000),
  pos_stock_item_defs: z.record(z.string(), z.object({
    label: z.string().trim().min(1).max(200),
    buyUnit: z.enum(["kg", "number"]),
    sellUnit: z.enum(["kg", "number"]),
    gramsPerPiece: z.number().positive().optional(),
  }).passthrough()).default({}),
  pos_ingredient_stock: z.record(z.string(), z.object({
    stockGrams: z.number().finite().default(0),
    avgCostPerGram: z.number().finite().min(0).default(0),
    minThresholdGrams: z.number().finite().min(0).default(0),
    avgUnitWeightGrams: z.number().finite().min(0).optional(),
  }).passthrough()).default({}),
  pos_softdrink_stock: z.record(z.string(), z.object({
    stockUnits: z.number().finite().default(0),
    avgCostPerUnit: z.number().finite().min(0).default(0),
    sellPrice: z.number().finite().min(0).optional(),
  }).passthrough()).default({}),
  pos_softdrink_threshold: z.number().finite().min(0).default(6),
  pos_icecream_stock: z.record(z.string(), z.object({
    stockGrams: z.number().finite().default(0),
    avgCostPerGram: z.number().finite().min(0).default(0),
    sellPrice: z.number().finite().min(0).optional(),
    minThresholdGrams: z.number().finite().min(0).optional(),
  }).passthrough()).default({}),
  pos_icecream_threshold: z.number().finite().min(0).default(500),
  pos_total_tables: z.number().int().min(0).max(10_000).default(0),
  pos_halls_list: z.array(z.string().trim().min(1).max(160)).max(1_000).default([]),
  pos_bank_accounts: z.array(z.object({
    id: z.union([z.string().min(1).max(100), z.number().int().safe()]),
    displayName: z.string().trim().min(1).max(160),
    bankName: z.string().trim().min(1).max(160),
    accountNumber: z.string().trim().max(100).optional(),
    openingBalance: z.number().finite().default(0),
    asOfDate: legacyDateSchema,
    active: z.boolean().optional(),
  }).passthrough()).max(1_000).default([]),
}).strict();

function setSessionCookie(reply, session, secureCookies) {
  reply.setCookie(SESSION_COOKIE_NAME, session.token, {
    path: "/",
    httpOnly: true,
    secure: secureCookies,
    sameSite: "lax",
    expires: session.expiresAt,
  });
}

function requestMetadata(request) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"] ?? null,
  };
}

const IDEMPOTENCY_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the idempotency key for a mutating request from
 * the Idempotency-Key header, falling back to a body field.
 * Returns null when no valid key is present so the caller can
 * answer 400 MISSING_IDEMPOTENCY_KEY.
 */
function resolveIdempotencyKey(request, body) {
  const fromHeader = request.headers["idempotency-key"];
  const candidate = fromHeader || body?.idempotencyKey;
  if (typeof candidate !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(candidate)) {
    return null;
  }
  return candidate;
}

export async function buildHttpApp({
  authService,
  tenantContextService = null,
  menuService = null,
  businessSettingsService = null,
  orderService = null,
  orderHistoryService = null,
  orderCancellationService = null,
  orderRefundService = null,
  salesReportService = null,
  supplierService = null,
  inventoryService = null,
  recipeService = null,
  purchaseService = null,
  catalogImportService = null,
  subscriptionService = null,
  billingWebhookService = null,
  trustedOrigin,
  trustedOrigins = null,
  secureCookies = true,
  logger = false,
  databasePool = null,
  migrationsDir = null,
  verifyMigrationsCurrent = null,
  serveClient = true,
  nodeEnv = "development",
}) {
  if (!authService) throw new TypeError("authService is required.");
  if (!trustedOrigin) throw new TypeError("trustedOrigin is required.");

  const originAllowlist = trustedOrigins ?? [trustedOrigin];

  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 64 * 1024,
    genReqId: (request) =>
      request.headers["x-request-id"]
        ?? randomUUID(),
  });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  // Security headers that do not depend on helmet's CSP. The legacy POS
  // uses inline event handlers and inline scripts, so a restrictive CSP
  // would break it; CSP is deliberately left off and this limitation is
  // documented.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Request-Id", _request.id);
  });

  // Request ID propagation for every request.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Request-Id", request.id);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const fetchSite = request.headers["sec-fetch-site"];
    const origin = request.headers.origin;
    if (fetchSite === "cross-site" || (origin && !originAllowlist.includes(origin))) {
      return reply.code(403).send({ error: "Cross-site request rejected." });
    }
  });

  // Subscription enforcement is attached to each route through its guards,
  // which means a POS route added later without one would silently have no
  // billing gate at all. This hook makes the omission fail closed instead: a
  // `/api/pos` route that never resolved a tenant context is refused, and a
  // route that did is still held to the same FULL-access decision.
  app.addHook("onRoute", (routeOptions) => {
    const path = routeOptions.url ?? "";
    if (!path.startsWith("/api/pos/")) return;
    if (routeOptions.config?.subscriptionExempt === true) return;
    routeOptions.preHandler = [
      ...(routeOptions.preHandler ?? []),
      async (request, reply) => {
        if (request.tenant?.subscriptionAccess?.level !== ACCESS_LEVEL.FULL) {
          return reply.code(402).send({
            error: "An active restaurant subscription is required.",
            code: "SUBSCRIPTION_REQUIRED",
          });
        }
      },
    ];
  });

  // Liveness: confirms the process and event loop are alive. It must not
  // query the database or expose any configuration, so a database outage
  // does not cause the orchestrator to restart a healthy process.
  app.get("/health/live", async () => ({ status: "ok" }));

  // Readiness: confirms the application can safely receive traffic. It
  // verifies PostgreSQL connectivity with a short timeout and that the
  // schema is current. It never exposes hostnames, credentials, stack
  // traces, tenant data, or Stripe configuration.
  app.get("/health/ready", async (_request, reply) => {
    if (!databasePool) {
      return reply.code(503).send({ status: "not_ready", reason: "no_database" });
    }
    try {
      const { checkDatabaseReady } = await import("../database/pool.mjs");
      const reachable = await checkDatabaseReady(databasePool, { timeoutMs: 3_000 });
      if (!reachable) {
        return reply.code(503).send({ status: "not_ready", reason: "database_unreachable" });
      }
    } catch {
      return reply.code(503).send({ status: "not_ready", reason: "database_unreachable" });
    }

    if (verifyMigrationsCurrent && migrationsDir) {
      try {
        const { current, pending, drifted } = await verifyMigrationsCurrent({
          pool: databasePool,
          migrationsDir,
        });
        if (!current) {
          return reply.code(503).send({
            status: "not_ready",
            reason: pending ? "migrations_pending" : "migration_drift",
          });
        }
      } catch {
        return reply.code(503).send({ status: "not_ready", reason: "migration_check_failed" });
      }
    }

    return reply.code(200).send({ status: "ready" });
  });

  // The legacy POS client is served by the application container in
  // production. In development the separate static server is used, so
  // serving can be disabled to avoid a conflict.
  if (serveClient) {
    const serveStatic = createStaticFileHandler();
    app.get("/", { config: { subscriptionExempt: true } }, serveStatic);
    app.get("/src/client/*", { config: { subscriptionExempt: true } }, serveStatic);
    app.get(`/${"Fast_Food_POS_Custom_Bill_Header_XXXL.html"}`, { config: { subscriptionExempt: true } }, serveStatic);
  }

  if (billingWebhookService) {
    // Registered in its own context because a webhook signature is computed over
    // the exact bytes the provider sent. Anything that parses and re-serializes
    // the body first would make a genuine signature unverifiable.
    await app.register(async (instance) => {
      instance.removeContentTypeParser("application/json");
      instance.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_request, body, done) => done(null, body),
      );

      instance.post(
        "/webhook",
        { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const signatureHeaderName = billingWebhookService.webhookSignatureHeader
            ?? "x-billing-signature";
          const result = await billingWebhookService.handle({
            rawBody: request.body,
            signatureHeader: request.headers[signatureHeaderName] ?? null,
          });
          // Three outcomes, deliberately distinct:
          //
          //  * `retryable` — the event is a real billing event we could not
          //    resolve. Answering 200 would take the payment and drop it, so a
          //    non-success status is returned and the provider retries.
          //  * refused — a bad signature or an unmodelled event. Permanent, so
          //    no retry is invited.
          //  * accepted — applied, already processed, or deliberately ignored.
          if (result.retryable) {
            return reply.code(503).send(result);
          }
          return reply.code(result.accepted ? 200 : 400).send(result);
        },
      );
    });
  }

  app.post(
    "/api/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = registrationSchema.parse(request.body);
      const result = await authService.register(input);
      return reply.code(202).send(result);
    },
  );

  app.post(
    "/api/auth/verify-email",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = verificationSchema.parse(request.body);
      const session = await authService.verifyEmail({
        ...input,
        ...requestMetadata(request),
      });
      setSessionCookie(reply, session, secureCookies);
      return { user: session.user };
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const session = await authService.login({
        ...input,
        ...requestMetadata(request),
      });
      setSessionCookie(reply, session, secureCookies);
      return { user: session.user };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    await authService.logout(request.cookies[SESSION_COOKIE_NAME]);
    reply.clearCookie(SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
    });
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request, reply) => {
    let session = null;
    try {
      session = await authService.authenticate(request.cookies[SESSION_COOKIE_NAME]);
    } catch {
      session = null;
    }
    if (!session) {
      return reply.code(401).send({
        error: "Authentication is required.",
        code: "UNAUTHENTICATED",
      });
    }
    // A POS device must learn which restaurants it may use before it can send
    // the trusted restaurant header. The list is limited to this account's own
    // active memberships.
    const restaurants = typeof authService.restaurantsForUser === "function"
      ? await authService.restaurantsForUser(session.user.id)
      : [];
    return { user: session.user, expiresAt: session.expiresAt, restaurants };
  });

  if (tenantContextService
      && (menuService || businessSettingsService || orderService
        || orderHistoryService || orderCancellationService || orderRefundService
        || salesReportService || supplierService || inventoryService
        || recipeService || purchaseService || catalogImportService
        || subscriptionService)) {
    const guards = createRequestGuards({ authService, tenantContextService });

    if (menuService) {
      app.get(
        "/api/pos/menu",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.ORDER_CREATE),
          ],
        },
        async (request) =>
          menuService.list({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
          }),
      );
    }

    if (businessSettingsService) {
      app.get(
        "/api/pos/settings/business",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.SETTINGS_MANAGE),
          ],
        },
        async (request) =>
          businessSettingsService.get({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
          }),
      );

      app.put(
        "/api/pos/settings/business",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.SETTINGS_MANAGE),
          ],
        },
        async (request) =>
          businessSettingsService.update({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            changes: businessSettingsSchema.parse(request.body),
          }),
      );
    }

    if (orderService) {
      app.post(
        "/api/pos/orders",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.ORDER_CREATE),
          ],
        },
        async (request, reply) => {
          const result = await orderService.create({
            tenant: request.tenant,
            userId: request.auth.user.id,
            input: orderSchema.parse(request.body),
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );
    }

    if (orderHistoryService) {
      app.get(
        "/api/pos/orders",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.ORDER_VIEW),
          ],
        },
        async (request) =>
          orderHistoryService.list({
            tenant: request.tenant,
            filters: orderHistoryQuerySchema.parse(request.query ?? {}),
          }),
      );

      app.get(
        "/api/pos/orders/:orderId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.ORDER_VIEW),
          ],
        },
        async (request) =>
          orderHistoryService.get({
            tenant: request.tenant,
            orderId: orderParamsSchema.parse(request.params).orderId,
          }),
      );
    }

    if (orderCancellationService) {
      app.post(
        "/api/pos/orders/:orderId/cancel",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.ORDER_CANCEL),
          ],
        },
        async (request, reply) => {
          const { orderId } = orderParamsSchema.parse(request.params);
          const body = cancelOrderSchema.parse(request.body);
          const result = await orderCancellationService.cancel({
            tenant: request.tenant,
            userId: request.auth.user.id,
            orderId,
            reason: body.reason ?? null,
            idempotencyKey: body.idempotencyKey,
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );
    }

    if (orderRefundService) {
      app.post(
        "/api/pos/orders/:orderId/refunds",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.REFUND_CREATE),
          ],
        },
        async (request, reply) => {
          const { orderId } = orderParamsSchema.parse(request.params);
          const idempotencyHeader = request.headers["idempotency-key"];
          const body = createRefundSchema.parse(request.body ?? {});
          const idempotencyKey = idempotencyHeader || body.idempotencyKey;

          if (!idempotencyKey || typeof idempotencyKey !== "string"
              || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
            return reply.code(400).send({
              error: "A valid Idempotency-Key header is required.",
              code: "MISSING_IDEMPOTENCY_KEY",
            });
          }

          const result = await orderRefundService.createRefund({
            tenant: request.tenant,
            userId: request.auth.user.id,
            orderId,
            input: {
              ...body,
              idempotencyKey,
            },
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );

      app.get(
        "/api/pos/orders/:orderId/refunds",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.REFUND_VIEW),
          ],
        },
        async (request) => {
          const { orderId } = orderParamsSchema.parse(request.params);
          return orderRefundService.listRefunds({
            tenant: request.tenant,
            orderId,
          });
        },
      );

      app.get(
        "/api/pos/refunds/:refundId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.REFUND_VIEW),
          ],
        },
        async (request) => {
          const { refundId } = refundParamsSchema.parse(request.params);
          return orderRefundService.getRefund({
            tenant: request.tenant,
            refundId,
          });
        },
      );
    }

    if (salesReportService) {
      app.get(
        "/api/pos/reports/sales",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.REPORT_VIEW),
          ],
        },
        async (request) => {
          const filters = salesReportQuerySchema.parse(request.query ?? {});
          return salesReportService.getSalesReport({
            tenant: request.tenant,
            filters,
          });
        },
      );

      app.get(
        "/api/pos/reports/sales/export",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.REPORT_EXPORT),
          ],
        },
        async (request, reply) => {
          const filters = salesReportQuerySchema.parse(request.query ?? {});
          const csvData = await salesReportService.exportSalesReportCsv({
            tenant: request.tenant,
            filters,
          });
          const startDate = filters.startDate || "start";
          const endDate = filters.endDate || "end";
          const slug = request.tenant.restaurant.slug || "export";
          const filename = `sales-report-${slug}-${startDate}-to-${endDate}.csv`;

          reply.header("Content-Type", "text/csv; charset=utf-8");
          reply.header("Content-Disposition", `attachment; filename="${filename}"`);
          return reply.send(csvData);
        },
      );
    }

    if (supplierService) {
      app.get(
        "/api/pos/suppliers",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_VIEW),
          ],
        },
        async (request) => {
          const isActive = request.query?.isActive === undefined
            ? null
            : request.query.isActive === "true";
          return supplierService.list({
            restaurantId: request.tenant.restaurant.id,
            isActive,
          });
        },
      );

      app.post(
        "/api/pos/suppliers",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_MANAGE),
          ],
        },
        async (request, reply) => {
          const result = await supplierService.create({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            input: supplierSchema.parse(request.body ?? {}),
          });
          return reply.code(201).send(result);
        },
      );

      app.patch(
        "/api/pos/suppliers/:supplierId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_MANAGE),
          ],
        },
        async (request, reply) => {
          const { supplierId } = supplierParamsSchema.parse(request.params);
          const result = await supplierService.update({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            supplierId,
            changes: supplierUpdateSchema.parse(request.body ?? {}),
          });
          return reply.send(result);
        },
      );
    }

    if (inventoryService) {
      app.get(
        "/api/pos/inventory/items",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_VIEW),
          ],
        },
        async (request) => {
          const filters = inventoryListQuerySchema.parse(request.query ?? {});
          return inventoryService.list({
            restaurantId: request.tenant.restaurant.id,
            search: filters.search ?? null,
            isActive: filters.isActive === undefined
              ? null
              : filters.isActive === "true",
            limit: filters.limit,
            cursor: filters.cursor,
          });
        },
      );

      app.post(
        "/api/pos/inventory/items",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_MANAGE),
          ],
        },
        async (request, reply) => {
          const result = await inventoryService.create({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            input: inventoryItemSchema.parse(request.body ?? {}),
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );

      app.get(
        "/api/pos/inventory/items/:itemId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_VIEW),
          ],
        },
        async (request) => {
          const { itemId } = inventoryItemParamsSchema.parse(request.params);
          return inventoryService.get({
            restaurantId: request.tenant.restaurant.id,
            itemId,
          });
        },
      );

      app.patch(
        "/api/pos/inventory/items/:itemId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_MANAGE),
          ],
        },
        async (request, reply) => {
          const { itemId } = inventoryItemParamsSchema.parse(request.params);
          const result = await inventoryService.update({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            itemId,
            changes: inventoryItemUpdateSchema.parse(request.body ?? {}),
          });
          return reply.send(result);
        },
      );

      app.get(
        "/api/pos/inventory/low-stock",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_VIEW),
          ],
        },
        async (request) => {
          const filters = inventoryListQuerySchema.parse(request.query ?? {});
          return inventoryService.lowStock({
            restaurantId: request.tenant.restaurant.id,
            limit: filters.limit,
          });
        },
      );

      app.get(
        "/api/pos/inventory/movements",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_VIEW),
          ],
        },
        async (request) => {
          const filters = inventoryMovementsQuerySchema.parse(request.query ?? {});
          return inventoryService.movements({
            restaurantId: request.tenant.restaurant.id,
            itemId: filters.itemId ?? null,
            limit: filters.limit,
            cursor: filters.cursor,
          });
        },
      );

      app.post(
        "/api/pos/inventory/adjustments",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_ADJUST),
          ],
        },
        async (request, reply) => {
          const body = inventoryAdjustmentSchema.parse(request.body ?? {});
          const result = await inventoryService.adjust({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            input: body,
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );

      app.post(
        "/api/pos/inventory/waste",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_ADJUST),
          ],
        },
        async (request, reply) => {
          const body = inventoryWasteSchema.parse(request.body ?? {});
          const result = await inventoryService.waste({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            input: body,
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );
    }

    if (recipeService) {
      app.get(
        "/api/pos/products/:productId/recipe",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.INVENTORY_VIEW),
          ],
        },
        async (request) => {
          const { productId } = recipeParamsSchema.parse(request.params);
          return recipeService.get({
            restaurantId: request.tenant.restaurant.id,
            productId,
          });
        },
      );

      app.put(
        "/api/pos/products/:productId/recipe",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.RECIPES_MANAGE),
          ],
        },
        async (request, reply) => {
          const { productId } = recipeParamsSchema.parse(request.params);
          const body = recipeReplaceSchema.parse(request.body ?? {});
          const result = await recipeService.replace({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            productId,
            items: body.items,
          });
          return reply.send(result);
        },
      );
    }

    if (purchaseService) {
      app.get(
        "/api/pos/purchases",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_VIEW),
          ],
        },
        async (request) => {
          const filters = purchaseListQuerySchema.parse(request.query ?? {});
          return purchaseService.list({
            restaurantId: request.tenant.restaurant.id,
            status: filters.status ?? null,
            limit: filters.limit,
            cursor: filters.cursor,
          });
        },
      );

      app.post(
        "/api/pos/purchases",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_MANAGE),
          ],
        },
        async (request, reply) => {
          const result = await purchaseService.create({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            input: purchaseSchema.parse(request.body ?? {}),
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );

      app.get(
        "/api/pos/purchases/:purchaseId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_VIEW),
          ],
        },
        async (request) => {
          const { purchaseId } = purchaseParamsSchema.parse(request.params);
          return purchaseService.get({
            restaurantId: request.tenant.restaurant.id,
            purchaseId,
          });
        },
      );

      app.patch(
        "/api/pos/purchases/:purchaseId",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_MANAGE),
          ],
        },
        async (request, reply) => {
          const { purchaseId } = purchaseParamsSchema.parse(request.params);
          const result = await purchaseService.update({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            purchaseId,
            changes: purchaseUpdateSchema.parse(request.body ?? {}),
          });
          return reply.send(result);
        },
      );

      app.post(
        "/api/pos/purchases/:purchaseId/receive",
        {
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.PURCHASES_MANAGE),
          ],
        },
        async (request, reply) => {
          const { purchaseId } = purchaseParamsSchema.parse(request.params);
          const body = purchaseReceiveSchema.parse(request.body ?? {});
          const idempotencyKey = resolveIdempotencyKey(request, body);
          if (!idempotencyKey) {
            return reply.code(400).send({
              error: "A valid Idempotency-Key header is required.",
              code: "MISSING_IDEMPOTENCY_KEY",
            });
          }
          const result = await purchaseService.receive({
            restaurantId: request.tenant.restaurant.id,
            userId: request.auth.user.id,
            purchaseId,
            idempotencyKey,
          });
          return reply.code(result.replayed ? 200 : 201).send(result);
        },
      );
    }

    if (catalogImportService) {
      app.post(
        "/api/pos/import/legacy-catalog",
        {
          bodyLimit: 5 * 1024 * 1024,
          preHandler: [
            guards.authenticate,
            guards.tenant(PERMISSION.MENU_MANAGE),
          ],
        },
        async (request) => catalogImportService.import({
          restaurantId: request.tenant.restaurant.id,
          branchId: request.tenant.membership.defaultBranchId,
          userId: request.auth.user.id,
          snapshot: legacyCatalogSchema.parse(request.body),
        }),
      );
    }

    if (subscriptionService) {
      // Billing deliberately does not require paid access: a restaurant that has
      // lost POS access must still be able to see the bill and pay to get it
      // back, otherwise it is stuck permanently.
      const billingGuards = [
        guards.authenticate,
        guards.tenant(PERMISSION.BILLING_MANAGE, { subscriptionRequired: false }),
      ];

      app.get(
        "/api/billing",
        { preHandler: billingGuards },
        async (request) =>
          subscriptionService.overview({
            tenant: request.tenant,
            user: request.auth.user,
          }),
      );

      app.post(
        "/api/billing/checkout",
        {
          preHandler: billingGuards,
          config: { rateLimit: { max: 10, timeWindow: "1 hour" } },
        },
        async (request) => {
          const body = checkoutSchema.parse(request.body);
          return subscriptionService.startCheckout({
            tenant: request.tenant,
            user: request.auth.user,
            ...body,
          });
        },
      );

      app.post(
        "/api/billing/change-plan",
        { preHandler: billingGuards },
        async (request) =>
          subscriptionService.changePlan({
            tenant: request.tenant,
            user: request.auth.user,
            planCode: changePlanSchema.parse(request.body).planCode,
          }),
      );

      app.post(
        "/api/billing/cancel",
        { preHandler: billingGuards },
        async (request) =>
          subscriptionService.cancel({
            tenant: request.tenant,
            user: request.auth.user,
            cancelAtPeriodEnd: cancelSubscriptionSchema.parse(request.body ?? {})
              .cancelAtPeriodEnd,
          }),
      );

      app.post(
        "/api/billing/resume",
        { preHandler: billingGuards },
        async (request) =>
          subscriptionService.resume({ tenant: request.tenant, user: request.auth.user }),
      );

      app.get(
        "/api/billing/payments",
        { preHandler: billingGuards },
        async (request) => subscriptionService.paymentHistory({
          tenant: request.tenant,
          limit: request.query?.limit,
        }),
      );
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "Invalid request.",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const statusCode = Number(error.statusCode) || 500;
    const publicMessage = statusCode >= 500 ? "Internal server error." : error.message;
    return reply.code(statusCode).send({
      error: publicMessage,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  });

  return app;
}
