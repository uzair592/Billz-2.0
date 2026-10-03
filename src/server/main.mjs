import pg from "pg";
import { buildHttpApp } from "./http/app.mjs";
import { createBillingWebhookService } from "./billing/billing-webhook-service.mjs";
import { createSubscriptionService } from "./billing/subscription-service.mjs";
import { createAuthService } from "./auth/auth-service.mjs";
import { createPostgresAuthRepository } from "./auth/postgres-auth-repository.mjs";
import { createTenantContextService } from "./tenancy/tenant-context-service.mjs";
import { createLoggingMailer } from "./mail/logging-mailer.mjs";
import {
  loadBillingConfiguration,
  loadServerConfiguration,
} from "./config/environment.mjs";

/**
 * Assembles the runnable server from configuration.
 *
 * Wiring lives here rather than inside any service, so the composition is
 * visible in one place and can be asserted in a test without opening a socket.
 */
export async function createServer({
  env = process.env,
  logger = { info() {}, warn() {}, error() {} },
  pool = null,
} = {}) {
  const config = loadServerConfiguration(env);
  const billing = loadBillingConfiguration(env);

  const database = pool ?? new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    // The application role is deliberately not a superuser: forced row-level
    // security has to apply to it, or tenant isolation would be untested.
    options: "-c statement_timeout=15000",
  });

  const billingWebhookService = createBillingWebhookService({
    pool: database,
    provider: billing.provider,
    graceDays: billing.graceDays,
    maxAttempts: billing.maxAttempts,
    leaseSeconds: billing.leaseSeconds,
    logger,
  });

  const subscriptionService = createSubscriptionService(database, {
    provider: billing.provider,
    trustedOrigins: [config.trustedOrigin],
  });

  const authService = createAuthService({
    repository: createPostgresAuthRepository(database),
    mailer: createLoggingMailer({
      nodeEnv: config.nodeEnv,
      log: (payload) => logger.info?.(payload),
    }),
    passwordPepper: config.pepper,
  });

  const app = await buildHttpApp({
    authService,
    tenantContextService: createTenantContextService(database),
    subscriptionService,
    billingWebhookService,
    trustedOrigin: config.trustedOrigin,
    secureCookies: config.secureCookies,
    logger: { level: config.nodeEnv === "production" ? "info" : "warn" },
  });

  return {
    app,
    config,
    billing,
    pool: database,
    authService,
    subscriptionService,
    billingWebhookService,
    async close() {
      await app.close();
      if (!pool) await database.end();
    },
  };
}

export async function startServer(options = {}) {
  const server = await createServer(options);
  await server.app.listen({ port: server.config.port, host: server.config.host });
  (options.logger ?? console).info?.({
    message: "pos_server_started",
    port: server.config.port,
    host: server.config.host,
    paymentProvider: server.billing.providerName,
  });
  return server;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href;

if (invokedDirectly) {
  startServer({ logger: console }).catch((error) => {
    console.error({ message: "pos_server_start_failed", error: error.message });
    process.exitCode = 1;
  });
}