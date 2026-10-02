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

  if (tenantContextService && (menuService || businessSettingsService)) {
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
    return reply.code(statusCode).send({ error: publicMessage, code: error.code });
  });

  return app;
}
