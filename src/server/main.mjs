import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { buildHttpApp } from "./http/app.mjs";
import { createBillingWebhookService } from "./billing/billing-webhook-service.mjs";
import { createSubscriptionService } from "./billing/subscription-service.mjs";
import { createAuthService } from "./auth/auth-service.mjs";
import { createPostgresAuthRepository } from "./auth/postgres-auth-repository.mjs";
import { createTenantContextService } from "./tenancy/tenant-context-service.mjs";
import { createLoggingMailer } from "./mail/logging-mailer.mjs";
import {
  createPolicyMailer,
  resolveRegistrationPolicy,
} from "./mail/mail-policy.mjs";
import { createOrderHistoryService } from "./pos/order-history-service.mjs";
import { createOrderCancellationService } from "./pos/order-cancellation-service.mjs";
import { createLegacyCatalogImportService } from "./pos/legacy-catalog-import-service.mjs";
import { createBusinessSettingsService } from "./pos/business-settings-service.mjs";
import { createOrderRefundService } from "./pos/order-refund-service.mjs";
import { createSalesReportService } from "./pos/sales-report-service.mjs";
import { createOrderService } from "./pos/order-service.mjs";
import { createMenuService } from "./pos/menu-service.mjs";
import { createSupplierService } from "./pos/supplier-service.mjs";
import { createInventoryService } from "./pos/inventory-service.mjs";
import { createRecipeService } from "./pos/recipe-service.mjs";
import { createPurchaseService } from "./pos/purchase-service.mjs";
import { createInventoryConsumptionService } from "./pos/inventory-consumption-service.mjs";
import {
  loadBillingConfiguration,
  loadServerConfiguration,
} from "./config/environment.mjs";
import {
  checkDatabaseReady,
  closeDatabasePool,
  createDatabasePool,
} from "./database/pool.mjs";
import { createPlatformAdminRepository } from "./auth/platform-admin-repository.mjs";
import { createPlatformAdminService } from "./auth/platform-admin-service.mjs";
import { createPlatformAdminPortalService } from "./subscriptions/platform-admin-portal-service.mjs";
import { createEntitlementService } from "./auth/entitlement-service.mjs";
import { createStorageService } from "./storage/storage-service.mjs";
import { verifyMigrationsCurrent } from "./database/migration-runner.mjs";

/**
 * Assembles the runnable server from configuration.
 *
 * Wiring lives here rather than inside any service, so the composition is
 * visible in one place and can be asserted in a test without opening a
 * socket.
 */
export async function createServer({
  env = process.env,
  logger = { info() {}, warn() {}, error() {} },
  pool = null,
  controlPool = null,
  migrationsDir = "auto",
  verifyMigrations = true,
} = {}) {
  const config = loadServerConfiguration(env);
  const billing = loadBillingConfiguration(env);

  const database = pool ?? createDatabasePool(env, logger);

  if (config.nodeEnv === "production" && !env.CONTROL_DATABASE_URL && !controlPool) {
    if (!pool) await closeDatabasePool(database);
    throw new Error("CONTROL_DATABASE_URL is required for the isolated authentication/admin database boundary.");
  }
  const controlDatabase = controlPool ?? (env.CONTROL_DATABASE_URL
    ? createDatabasePool({ ...env, DATABASE_URL: env.CONTROL_DATABASE_URL }, logger) : database);
  if (config.nodeEnv === "production") {
    const appRole = (await database.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
    const controlRole = (await controlDatabase.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0];
    if (!appRole || appRole.rolsuper || appRole.rolbypassrls || !controlRole?.rolbypassrls || controlRole.rolsuper) {
      if (!pool) await closeDatabasePool(database);
      if (!controlPool && controlDatabase !== database) await closeDatabasePool(controlDatabase);
      throw new Error("Use a non-superuser NOBYPASSRLS POS role and a separate non-superuser BYPASSRLS control role.");
    }
  }

  // Startup readiness: the process must not claim readiness before the
  // database is usable. A deployment that cannot reach PostgreSQL fails
  // fast instead of serving 500s.
  const databaseReady = await checkDatabaseReady(database, { timeoutMs: 10_000 });
  if (!databaseReady) {
    await closeDatabasePool(database);
    throw Object.assign(new Error("PostgreSQL is unavailable at startup."), {
      code: "DATABASE_UNAVAILABLE",
    });
  }

  // Migration verification is wired for the real server (the default
  // "auto" resolves the bundled migrations directory). Tests inject a
  // mock pool that cannot run the verification queries, so they pass
  // migrationsDir: null to opt out.
  const defaultMigrationsDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)), "..", "..", "database", "migrations",
  );
  const resolvedMigrationsDir = migrationsDir === "auto"
    ? defaultMigrationsDir
    : migrationsDir;
  const shouldVerifyMigrations = verifyMigrations && resolvedMigrationsDir !== null;

  const billingWebhookService = createBillingWebhookService({
    pool: controlDatabase,
    provider: billing.provider,
    graceDays: billing.graceDays,
    maxAttempts: billing.maxAttempts,
    leaseSeconds: billing.leaseSeconds,
    logger,
  });

  const subscriptionService = createSubscriptionService(database, {
    provider: billing.provider,
    trustedOrigins: config.trustedOrigins,
  });

  // Registration and mail policy. Production self-registration is
  // disabled unless a real transactional mail provider is configured,
  // so the process can start in production without stranding users.
  // Bootstrap-created owners are written directly and are unaffected.
  const registrationPolicy = resolveRegistrationPolicy({
    nodeEnv: config.nodeEnv,
    mailProvider: config.mailProvider,
  });

  const mailer = createPolicyMailer({
    registrationEnabled: registrationPolicy.registrationEnabled,
    nodeEnv: config.nodeEnv,
    log: (payload) => logger.info?.(payload),
  });

  const authService = createAuthService({
    repository: createPostgresAuthRepository(controlDatabase),
    mailer,
    passwordPepper: config.pepper,
  });

  const platformAdminRepository = createPlatformAdminRepository(controlDatabase);
  const platformAdminService = createPlatformAdminService({
    repository: platformAdminRepository,
    passwordPepper: config.pepper,
  });
  const platformAdminPortalService = createPlatformAdminPortalService({
    pool: controlDatabase,
    passwordPepper: config.pepper,
  });
  const entitlementService = env.OFFLINE_ENTITLEMENT_SECRET
    ? createEntitlementService({ secret: env.OFFLINE_ENTITLEMENT_SECRET }) : null;
  const storageService = createStorageService({ pool: database });

  const orderHistoryService = createOrderHistoryService(database);
  const orderCancellationService = createOrderCancellationService(database);
  const catalogImportService = createLegacyCatalogImportService(database);
  const businessSettingsService = createBusinessSettingsService(database);
  const orderRefundService = createOrderRefundService(database);
  const salesReportService = createSalesReportService(database);
  const inventoryConsumptionService = createInventoryConsumptionService(database);
  const orderService = createOrderService(database, {
    inventoryConsumption: inventoryConsumptionService,
  });
  const menuService = createMenuService(database);
  const supplierService = createSupplierService(database);
  const inventoryService = createInventoryService(database);
  const recipeService = createRecipeService(database);
  const purchaseService = createPurchaseService(database);

  const app = await buildHttpApp({
    authService,
    platformAdminService,
    platformAdminPortalService,
    entitlementService,
    storageService,
    tenantContextService: createTenantContextService(database),
    subscriptionService,
    billingWebhookService,
    menuService,
    orderService,
    orderRefundService,
    orderHistoryService,
    orderCancellationService,
    catalogImportService,
    businessSettingsService,
    salesReportService,
    supplierService,
    inventoryService,
    recipeService,
    purchaseService,
    trustedOrigin: config.trustedOrigin,
    trustedOrigins: config.trustedOrigins,
    secureCookies: config.secureCookies,
    logger: { level: config.logLevel },
    databasePool: database,
    migrationsDir: shouldVerifyMigrations ? resolvedMigrationsDir : null,
    verifyMigrationsCurrent: shouldVerifyMigrations ? verifyMigrationsCurrent : null,
    nodeEnv: config.nodeEnv,
    trustProxy: config.trustProxy,
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
      if (!pool) await closeDatabasePool(database);
      if (!controlPool && controlDatabase !== database) await closeDatabasePool(controlDatabase);
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

/**
 * Runs the server as a process with graceful SIGTERM/SIGINT handling.
 *
 * Lifecycle guarantees:
 *
 *   * A termination signal stops the server, gives in-flight
 *     requests a grace period, closes Fastify and the PostgreSQL
 *     pool cleanly, and exits zero.
 *   * A startup failure exits non-zero.
 *   * A forced shutdown after the grace timeout exits non-zero,
 *     because the process did not shut down cleanly.
 *   * An unhandled rejection triggers an orderly shutdown and
 *     exits non-zero, so a latent error never leaves a half-alive
 *     process behind.
 *   * Pool and app closure errors are logged without credentials.
 *   * No timer or connection keeps the process alive after
 *     shutdown: the force-exit timer is unref'd and cleared, and
 *     the pool is ended.
 */
export async function runServer({ env = process.env, logger = console, shutdownGraceMs = 3_000 } = {}) {
  let server = null;
  let shuttingDown = false;
  let forceExitTimer = null;

  const shutdown = async (signal, { exitCode = 0 } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info?.({ message: "shutdown_initiated", signal });

    // Force-exit after the grace period so a lingering keep-alive
    // connection can never block a deployment from stopping. A
    // forced shutdown is not a clean shutdown, so it exits
    // non-zero to signal that the process did not drain in time.
    forceExitTimer = setTimeout(() => {
      logger.warn?.({ message: "shutdown_forced", signal });
      process.exit(exitCode === 0 ? 1 : exitCode);
    }, shutdownGraceMs);
    forceExitTimer.unref?.();

    if (server) {
      try {
        await server.close();
        logger.info?.({ message: "shutdown_complete" });
      } catch (error) {
        // Closure errors are logged without credentials. The
        // error message from Fastify/pg does not include the
        // connection string, and nothing is added here that does.
        logger.error?.({ message: "shutdown_error", error: error.message });
        clearTimeout(forceExitTimer);
        process.exit(1);
      }
    }
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  // An unhandled rejection is a latent defect. Shut down
  // orderly and exit non-zero so the process is not left
  // half-alive behind a supervisor that only watches signals.
  process.on("unhandledRejection", (reason) => {
    logger.error?.({
      message: "unhandled_rejection",
      error: reason instanceof Error ? reason.message : String(reason),
    });
    void shutdown("unhandledRejection", { exitCode: 1 });
  });

  process.on("uncaughtException", (error) => {
    logger.error?.({
      message: "uncaught_exception",
      error: error instanceof Error ? error.message : String(error),
    });
    void shutdown("uncaughtException", { exitCode: 1 });
  });

  try {
    server = await startServer({ env, logger });
  } catch (error) {
    logger.error?.({
      message: "pos_server_start_failed",
      error: error.message,
      code: error.code,
    });
    process.exit(1);
  }

  return server;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  void runServer({ logger: console });
}
