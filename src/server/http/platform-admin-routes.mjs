import { z } from "zod";

const PLATFORM_COOKIE_NAME = "platform_admin_session";

const adminLoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

const createRestaurantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().min(2).max(64),
  ownerUsername: z.string().trim().min(2).max(64),
  ownerPassword: z.string().min(8).max(200),
  ownerDisplayName: z.string().trim().min(1).max(120).optional(),
  planCode: z.string().trim().min(1).max(64).default("GROWTH"),
});

const manualPaymentSchema = z.object({
  planCode: z.string().trim().min(1).max(64),
  amountMinor: z.number().int().min(0),
  currencyCode: z.string().regex(/^[A-Z]{3}$/).default("PKR"),
  paymentDate: z.string(),
  coveredFrom: z.string(),
  coveredUntil: z.string(),
  paymentMethod: z.string().trim().default("manual_bank_transfer"),
  externalReference: z.string().trim().min(1).max(200),
  whatsappReferenceText: z.string().trim().max(1000).optional(),
  administratorNote: z.string().trim().max(1000).optional(),
});

const rejectPaymentSchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

const updateStorageSchema = z.object({
  maxStorageBytes: z.number().int().min(0),
});

export async function registerPlatformAdminRoutes(app, { platformAdminService, platformAdminPortalService, secureCookies = true }) {
  // Authentication Guard Helper for Platform Admin Routes
  async function requirePlatformAdmin(request, reply) {
    const token = request.cookies[PLATFORM_COOKIE_NAME];
    const session = await platformAdminService.authenticate(token);
    if (!session) {
      return reply.code(401).send({ error: "Platform administrator authentication is required.", code: "UNAUTHENTICATED" });
    }
    request.adminSession = session;
  }

  // Guard: Reject non-admins trying to access /platform-admin
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/platform-admin/api/") && !request.url.startsWith("/platform-admin/api/auth/login")) {
      await requirePlatformAdmin(request, reply);
    }
  });

  app.post("/platform-admin/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const input = adminLoginSchema.parse(request.body);
    try {
      const session = await platformAdminService.login({
        username: input.username,
        password: input.password,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      });
      reply.setCookie(PLATFORM_COOKIE_NAME, session.token, {
        path: "/",
        httpOnly: true,
        secure: secureCookies,
        sameSite: "lax",
        expires: session.expiresAt,
      });
      return { admin: session.admin };
    } catch (err) {
      if (err.code === "INVALID_ADMIN_CREDENTIALS") {
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
    return { admin: request.adminSession.admin, expiresAt: request.adminSession.expiresAt };
  });

  app.get("/platform-admin/api/dashboard", async () => {
    return platformAdminPortalService.getDashboardStats();
  });

  app.get("/platform-admin/api/restaurants", async (request) => {
    const query = request.query || {};
    const statusVal = (query.status && query.status.trim() !== "" && query.status !== "all") ? query.status.trim() : null;
    return platformAdminPortalService.listRestaurants({
      search: query.search || null,
      status: statusVal,
      limit: query.limit ? Number(query.limit) : 50,
      page: query.page ? Number(query.page) : 1,
    });
  });

  app.post("/platform-admin/api/restaurants", async (request, reply) => {
    const input = createRestaurantSchema.parse(request.body);
    const result = await platformAdminPortalService.createRestaurant({
      adminId: request.adminSession.admin.id,
      ...input,
    });
    return reply.code(201).send(result);
  });

  app.get("/platform-admin/api/restaurants/:id", async (request, reply) => {
    const { id } = request.params;
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
