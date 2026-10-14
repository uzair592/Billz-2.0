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
  ownerEmail: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  ownerDisplayName: z.string().trim().min(1).max(120).optional(),
  planCode: z.string().trim().min(1).max(64).default("GROWTH"),
});

const manualPaymentSchema = z
  .object({
    planCode: z.string().trim().min(1).max(64),
    amountMinor: z.number().int().min(0),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("PKR"),
    paymentDate: z.iso.datetime({ offset: true }),
    coveredFrom: z.iso.datetime({ offset: true }),
    coveredUntil: z.iso.datetime({ offset: true }),
    paymentMethod: z.string().trim().default("manual_bank_transfer"),
    externalReference: z.string().trim().min(1).max(200),
    whatsappReferenceText: z.string().trim().max(1000).optional(),
    administratorNote: z.string().trim().max(1000).optional(),
  })
  .refine(
    (value) => new Date(value.coveredUntil) > new Date(value.coveredFrom),
    { message: "Coverage end must follow start." },
  );

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
const editRestaurantSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: z.string().trim().min(2).max(64).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
    contactEmail: z.email().max(320).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required.",
  );
const userStatusSchema = z
  .object({ status: z.enum(["active", "disabled"]) })
  .strict();
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
const userSchema = z
  .object({
    username: z.string().trim().min(2).max(64),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum([
      "owner",
      "manager",
      "cashier",
      "waiter",
      "kitchen",
      "accountant",
    ]),
    password: passwordSchema,
  })
  .strict();
const editUserSchema = userSchema
  .pick({ username: true, displayName: true })
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field is required.",
  );
const paymentParams = z.object({ paymentId: z.uuid() });
const paymentListSchema = paginationSchema.extend({
  status: z.enum(["all", "pending", "approved", "rejected"]).default("pending"),
});
const suspensionSchema = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();

const planSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(
        /^[A-Z][A-Z0-9_]{0,63}$/,
        "Use letters, digits and underscores, starting with a letter.",
      ),
    name: z.string().trim().min(1).max(160),
    billingInterval: z.enum(["month", "quarter", "year", "trial"]),
    amountMinor: z.number().int().min(0).max(9000000000000),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    maxDevices: z.number().int().min(1).max(1000),
    trialDays: z.number().int().min(1).max(3650).default(14),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine(
    (v) => v.billingInterval !== "trial" || v.amountMinor === 0,
    "Trial plans must have a zero price.",
  );
const planParams = z.object({ planId: z.uuid() });
const planQuery = paginationSchema.extend({
  includeInactive: z.enum(["true", "false"]).default("false"),
});
const subscriptionUpdateSchema = z
  .object({
    planId: z.uuid(),
    mode: z.enum(["renew", "trial"]),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
const ownerCredentialsSchema = z
  .object({
    email: z.string().trim().email().max(320).optional(),
    newPassword: passwordSchema.optional(),
    generateTemporary: z.boolean().default(false),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine(
    (v) => v.email || v.newPassword || v.generateTemporary,
    "Change the email or password.",
  )
  .refine(
    (v) => !(v.newPassword && v.generateTemporary),
    "Choose a new password or generate one, not both.",
  );
const logoutDevicesSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();

export async function registerPlatformAdminRoutes(
  app,
  {
    platformAdminService,
    platformAdminPortalService,
    secureCookies = true,
    loginThrottle = null,
  },
) {
  // Authentication Guard Helper for Platform Admin Routes
  async function requirePlatformAdmin(request, reply) {
    const token = request.cookies[PLATFORM_COOKIE_NAME];
    const session = await platformAdminService.authenticate(token);
    if (!session) {
      return reply
        .code(request.url.split("?")[0].endsWith("/reset-password") ? 403 : 401)
        .send({
          error: "Platform administrator authentication is required.",
          code: "UNAUTHENTICATED",
        });
    }
    request.adminSession = session;
  }

  // Guard: Reject non-admins trying to access /platform-admin
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/platform-admin/api/") &&
      request.url.split("?")[0] !== "/platform-admin/api/auth/login"
    ) {
      await requirePlatformAdmin(request, reply);
    }
  });

  app.post(
    "/platform-admin/api/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const input = adminLoginSchema.parse(request.body);
      const attempt = {
        scope: "platform_admin",
        username: input.username,
        ipAddress: request.ip,
      };
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
        return {
          admin: {
            id: session.admin.id,
            username: session.admin.username,
            displayName: session.admin.displayName,
            status: session.admin.status,
          },
        };
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
    },
  );

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
    return {
      admin: {
        id: request.adminSession.admin.id,
        username: request.adminSession.admin.username,
        displayName: request.adminSession.admin.displayName,
        status: request.adminSession.admin.status,
      },
      expiresAt: request.adminSession.expiresAt,
    };
  });

  app.get("/platform-admin/api/dashboard", async () => {
    return platformAdminPortalService.getDashboardStats();
  });

  app.get("/platform-admin/api/plans", async (request) => {
    const q = planQuery.parse(request.query);
    return platformAdminPortalService.listPlans({
      ...q,
      includeInactive: q.includeInactive === "true",
    });
  });
  const mutation = {
    config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
  };
  app.post("/platform-admin/api/plans", mutation, async (request, reply) =>
    reply
      .code(201)
      .send(
        await platformAdminPortalService.createPlan({
          adminId: request.adminSession.admin.id,
          ...planSchema.parse(request.body),
        }),
      ),
  );
  app.patch("/platform-admin/api/plans/:planId", mutation, async (request) =>
    platformAdminPortalService.editPlan({
      adminId: request.adminSession.admin.id,
      ...planParams.parse(request.params),
      ...planSchema.parse(request.body),
    }),
  );
  app.post(
    "/platform-admin/api/plans/:planId/archive",
    mutation,
    async (request) =>
      platformAdminPortalService.archivePlan({
        adminId: request.adminSession.admin.id,
        ...planParams.parse(request.params),
      }),
  );
  app.post(
    "/platform-admin/api/plans/:planId/activate",
    mutation,
    async (request) =>
      platformAdminPortalService.activatePlan({
        adminId: request.adminSession.admin.id,
        ...planParams.parse(request.params),
      }),
  );
  app.delete("/platform-admin/api/plans/:planId", mutation, async (request) =>
    platformAdminPortalService.deletePlan({
      adminId: request.adminSession.admin.id,
      ...planParams.parse(request.params),
    }),
  );
  app.put(
    "/platform-admin/api/restaurants/:id/subscription",
    mutation,
    async (request) =>
      platformAdminPortalService.setSubscription({
        adminId: request.adminSession.admin.id,
        restaurantId: restaurantParams.parse(request.params).id,
        ...subscriptionUpdateSchema.parse(request.body),
      }),
  );
  app.post(
    "/platform-admin/api/restaurants/:id/owner-credentials",
    mutation,
    async (request) =>
      platformAdminPortalService.manageOwnerCredentials({
        adminId: request.adminSession.admin.id,
        restaurantId: restaurantParams.parse(request.params).id,
        ...ownerCredentialsSchema.parse(request.body),
      }),
  );
  app.get("/platform-admin/api/restaurants/:id/sessions", async (request) =>
    platformAdminPortalService.listSessions({
      restaurantId: restaurantParams.parse(request.params).id,
    }),
  );
  app.post(
    "/platform-admin/api/restaurants/:id/sessions/revoke-all",
    mutation,
    async (request) =>
      platformAdminPortalService.logoutDevices({
        adminId: request.adminSession.admin.id,
        restaurantId: restaurantParams.parse(request.params).id,
        ...logoutDevicesSchema.parse(request.body),
      }),
  );
  app.get("/platform-admin/api/payments", async (request) => {
    const query = paymentListSchema.parse(request.query || {});
    return platformAdminPortalService.listPayments({
      ...query,
      status: query.status === "all" ? null : query.status,
    });
  });
  app.post(
    "/platform-admin/api/restaurants/:id/users",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { id } = restaurantParams.parse(request.params);
      const result = await platformAdminPortalService.createUser({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        ...userSchema.parse(request.body),
      });
      return reply.code(201).send(result);
    },
  );
  app.patch(
    "/platform-admin/api/restaurants/:id/users/:userId",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request) => {
      const { id, userId } = restaurantUserParams.parse(request.params);
      return platformAdminPortalService.editUser({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        userId,
        ...editUserSchema.parse(request.body),
      });
    },
  );

  app.post(
    "/platform-admin/api/restaurants/:id/users/:userId/reset-password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { id, userId } = restaurantUserParams.parse(request.params);
      const input = resetPasswordSchema.parse(request.body);
      return platformAdminPortalService.resetUserPassword({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        userId,
        ...input,
      });
    },
  );

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

  app.patch(
    "/platform-admin/api/restaurants/:id",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request) => {
      const { id } = restaurantParams.parse(request.params);
      const input = editRestaurantSchema.parse(request.body);
      return platformAdminPortalService.editRestaurant({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        ...input,
      });
    },
  );

  app.post(
    "/platform-admin/api/restaurants/:id/users/:userId/status",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request) => {
      const { id, userId } = restaurantUserParams.parse(request.params);
      const input = userStatusSchema.parse(request.body);
      return platformAdminPortalService.setUserStatus({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        userId,
        ...input,
      });
    },
  );

  app.get("/platform-admin/api/audit-logs", async (request) =>
    platformAdminPortalService.listAuditLogs(
      auditListSchema.parse(request.query || {}),
    ),
  );

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
    if (!details)
      return reply.code(404).send({ error: "Restaurant not found." });
    return details;
  });

  app.post(
    "/platform-admin/api/restaurants/:id/payments",
    async (request, reply) => {
      const { id } = restaurantParams.parse(request.params);
      const input = manualPaymentSchema.parse(request.body);
      const result = await platformAdminPortalService.recordManualPayment({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        ...input,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/platform-admin/api/payments/:paymentId/approve",
    async (request) => {
      const { paymentId } = paymentParams.parse(request.params);
      return platformAdminPortalService.approveManualPayment({
        adminId: request.adminSession.admin.id,
        paymentId,
      });
    },
  );

  app.post(
    "/platform-admin/api/payments/:paymentId/reject",
    async (request) => {
      const { paymentId } = paymentParams.parse(request.params);
      const input = rejectPaymentSchema.parse(request.body || {});
      return platformAdminPortalService.rejectManualPayment({
        adminId: request.adminSession.admin.id,
        paymentId,
        note: input.note,
      });
    },
  );

  app.post("/platform-admin/api/restaurants/:id/suspend", async (request) => {
    const { id } = restaurantParams.parse(request.params);
    const body = suspensionSchema.parse(request.body || {});
    return platformAdminPortalService.suspendRestaurant({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
      reason: body.reason,
    });
  });

  app.post("/platform-admin/api/restaurants/:id/restore", async (request) => {
    const { id } = restaurantParams.parse(request.params);
    return platformAdminPortalService.restoreRestaurant({
      adminId: request.adminSession.admin.id,
      restaurantId: id,
    });
  });

  app.put(
    "/platform-admin/api/restaurants/:id/storage-allowance",
    async (request) => {
      const { id } = restaurantParams.parse(request.params);
      const input = updateStorageSchema.parse(request.body);
      return platformAdminPortalService.updateStorageAllowance({
        adminId: request.adminSession.admin.id,
        restaurantId: id,
        maxStorageBytes: input.maxStorageBytes,
      });
    },
  );
}
