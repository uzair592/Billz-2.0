import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { z } from "zod";
import { PERMISSION } from "../authorization/permissions.mjs";
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
}).passthrough();
const legacyCatalogSchema = z.object({
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
  catalogImportService = null,
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

  app.get("/health", async () => ({ status: "ok" }));

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
    return { user: session.user, expiresAt: session.expiresAt };
  });

  if (tenantContextService
      && (menuService || businessSettingsService || orderService || catalogImportService)) {
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
