import { z } from "zod";
import { passwordSchema } from "../auth/password-policy.mjs";

const PLATFORM_COOKIE_NAME = "platform_admin_session";

const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: passwordSchema,
});

const createRestaurantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(2).max(64),
  ownerUsername: z.string().trim().min(2).max(64),
  ownerPassword: passwordSchema,
  ownerDisplayName: z.string().trim().min(1).max(120).optional(),
  planCode: z.string().trim().min(1).max(64).default("GROWTH"),
});

const manualPaymentSchema = z.object({
  planCode: z.string().trim().min(1).max(64),
  amountMinor: z.number().int().min(0),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default("PKR"),
  paymentDate: z.iso.datetime({ offset: true }),
  coveredFrom: z.iso.datetime({ offset: true }),
  coveredUntil: z.iso.datetime({ offset: true }),
  paymentMethod: z.string().trim().default("manual_bank_transfer"),
  externalReference: z.string().trim().min(1).max(200),
  whatsappReferenceText: z.string().trim().max(1000).optional(),
  administratorNote: z.string().trim().max(1000).optional(),
}).refine(value => new Date(value.coveredUntil) > new Date(value.coveredFrom), { message: "Coverage end must follow start." });

const rejectPaymentSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

const updateStorageSchema = z.object({
  maxStorageBytes: z.number().int().min(0),
});

const restaurantUserParams = z.object({ id: z.uuid(), userId: z.uuid() });
const resetPasswordSchema = z.union([
  z.object({ newPassword: passwordSchema }).strict(),
  z.object({ generateTemporary: z.literal(true) }).strict(),
]);

const restaurantParams = z.object({ id: z.uuid() });
const editRestaurantSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  contactEmail: z.email().max(320).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "At least one field is required.");
const userStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const restaurantListSchema = paginationSchema.extend({
  search: z.string().trim().max(200).default(""),
  status: z.enum(["all", "active", "suspended", "deactivated"]).default("all"),
  includeTotal: z.enum(["true", "false"]).default("false"),
});
const auditListSchema = paginationSchema.extend({
  restaurantId: z.uuid().optional(),
  action: z.string().trim().max(200).default(""),
});

export async function registerPlatformAdminRoutes(app, { platformAdminService, platformAdminPortalService, secureCookies = true, loginThrottle = null }) {
  // Authentication Guard Helper for Platform Admin Routes
  async function requirePlatformAdmin(request, reply) {
    const token = request.cookies[PLATFORM_COOKIE_NAME];
    const session = await platformAdminService.authenticate(token);
    if (!session) {
      return reply.code(request.url.split("?")[0].endsWith("/reset-password") ? 403 : 401).send({ error: "Platform administrator authentication is required.", code: "UNAUTHENTICATED" });
    }
    request.adminSession = session;
  }

  // Guard: Reject non-admins trying to access /platform-admin
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/platform-admin/api/") && request.url.split("?")[0] !== "/platform-admin/api/auth/login") {
      await requirePlatformAdmin(request, reply);
    }
  });

  app.post("/platform-admin/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = adminLoginSchema.parse(request.body);
    const attempt = { scope: "platform_admin", username: input.username, ipAddress: request.ip };
    await loginThrottle?.check(attempt);
    try {
      const session = await platformAdminService.login({
        username: input.username,
        password: input.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      await loginThrottle?.succeeded(attempt);
      reply.setCookie(PLATFORM_COOKIE_NAME, session.token, {
        path: "/",
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        expires: session.expiresAt,
      });
      return { admin: { id: session.admin.id, username: session.admin.username, displayName: session.admin.displayName, status: session.admin.status } };
    } catch (err) {
      if (err.code === "INVALID_ADMIN_CREDENTIALS") {
        await loginThrottle?.failed(attempt);
        return reply.code(401).send({ error: err.message, code: err.code });
      }
      if (err.code === "ADMIN_DISABLED") {
        return reply.code(403).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post("/platform-admin/api/auth/logout", async (request, reply) => {
    const token = request.cookies[PLATFORM_COOKIE_NAME];
    await platformAdminService.logout(token);
    reply.clearCookie(PLATFORM_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
    });
    return reply.code(204).send();
  });

  app.get("/platform-admin/api/auth/me", async (request) => {
    return { admin: { id: request.adminSession.admin.id, username: request.adminSession.admin.username, displayName: request.adminSession.admin.displayName, status: request.adminSession.admin.status }, expiresAt: request.adminSession.expiresAt };
  });

  app.get("/platform-admin/api/dashboard", async () => {
    return platformAdminPortalService.getDashboardStats();
  });

  app.post("/platform-admin/api/restaurants/:id/users/:userId/reset-password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async request => {
      const { id, userId } = restaurantUserParams.parse(request.params);
      const input = resetPasswordSchema.parse(request.body);
      return platformAdminPortalService.resetUserPassword({ adminId: request.adminSession.admin.id, restaurantId: id, userId, ...input });
    });

  app.get("/platform-admin/api/restaurants", async (request) => {
    const query = restaurantListSchema.parse(request.query || {});
    return platformAdminPortalService.listRestaurants({
      search: query.search,
      status: query.status === "all" ? null : query.status,
      limit: query.limit,
      page: query.page,
      includeTotal: query.includeTotal === "true",
    });
  });

  app.patch("/platform-admin/api/restaurants/:id", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async request => {
    const { id } = restaurantParams.parse(request.params);
    const input = editRestaurantSchema.parse(request.body);
    return platformAdminPortalService.editRestaurant({ adminId: request.adminSession.admin.id, restaurantId: id, ...input });
  });

  app.post("/platform-admin/api/restaurants/:id/users/:userId/status", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async request => {
    const { id, userId } = restaurantUserParams.parse(request.params);
    const input = userStatusSchema.parse(request.body);
    return platformAdminPortalService.setUserStatus({ adminId: request.adminSession.admin.id, restaurantId: id, userId, ...input });
  });

  app.get("/platform-admin/api/audit-logs", async request => platformAdminPortalService.listAuditLogs(auditListSchema.parse(request.query || {})));

  app.post("/platform-admin/api/restaurants", async (request, reply) => {
    const input = createRestaurantSchema.parse(request.body);
    const result = await platformAdminPortalService.createRestaurant({
      adminId: request.adminSession.admin.id,
      ...input,
    });
    return reply.code(201).send(result);
  });

  app.get("/platform-admin/api/restaurants/:id", async (request, reply) => {
    const { id } = restaurantParams.parse(request.params);
    const details = await platformAdminPortalService.getRestaurantDetails(id);
    if (!details) return reply.code(404).send({ error: "Restaurant not found." });
    return details;
  });

  app.post("/platform-admin/api/restaurants/:id/payments", async (request, reply) => {
    const { id } = request.params;
    const input = manualPaymentSchema.parse(request.body);
    const result = await platformAdminPortalService.recordManualPayment({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
      ...input,
    });
    return reply.code(201).send(result);
  });

  app.post("/platform-admin/api/payments/:paymentId/approve", async (request) => {
    const { paymentId } = request.params;
    return platformAdminPortalService.approveManualPayment({
      adminId: request.adminSession.admin.id,
      paymentId,
    });
  });

  app.post("/platform-admin/api/payments/:paymentId/reject", async (request) => {
    const { paymentId } = request.params;
    const input = rejectPaymentSchema.parse(request.body || {});
    return platformAdminPortalService.rejectManualPayment({
      adminId: request.adminSession.admin.id,
      paymentId,
      note: input.note,
    });
  });

  app.post("/platform-admin/api/restaurants/:id/suspend", async (request) => {
    const { id } = request.params;
    const body = request.body || {};
    return platformAdminPortalService.suspendRestaurant({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
      reason: body.reason,
    });
  });

  app.post("/platform-admin/api/restaurants/:id/restore", async (request) => {
    const { id } = request.params;
    return platformAdminPortalService.restoreRestaurant({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
    });
  });

  app.put("/platform-admin/api/restaurants/:id/storage-allowance", async (request) => {
    const { id } = request.params;
    const input = updateStorageSchema.parse(request.body);
    return platformAdminPortalService.updateStorageAllowance({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
      maxStorageBytes: input.maxStorageBytes,
    });
  });
}
