import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import { PERMISSION } from "../authorization/permissions.mjs";
import { ACCESS_LEVEL } from "../subscriptions/access-policy.mjs";
import { SESSION_COOKIE_NAME } from "./request-guards.mjs";
import { createRequestGuards } from "./request-guards.mjs";

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

export async function buildHttpApp({
  authService,
  tenantContextService = null,
  menuService = null,
  businessSettingsService = null,
  orderService = null,
  orderHistoryService = null,
  orderCancellationService = null,
  catalogImportService = null,
  subscriptionService = null,
  billingWebhookService = null,
  trustedOrigin,
  secureCookies = true,
  logger = false,
}) {
  if (!authService) throw new TypeError("authService is required.");
  if (!trustedOrigin) throw new TypeError("trustedOrigin is required.");

  const app = Fastify({ logger, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const fetchSite = request.headers["sec-fetch-site"];
    const origin = request.headers.origin;
    if (fetchSite === "cross-site" || (origin && origin !== trustedOrigin)) {
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

  app.get("/health", async () => ({ status: "ok" }));

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
        || orderHistoryService || orderCancellationService || catalogImportService
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
