import pg from "pg";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHttpApp } from "./http/app.mjs";
import { createBillingWebhookService } from "./billing/billing-webhook-service.mjs";
import { createSubscriptionService } from "./billing/subscription-service.mjs";
import { createAuthService } from "./auth/auth-service.mjs";
import { createPostgresAuthRepository } from "./auth/postgres-auth-repository.mjs";
import { createTenantContextService } from "./tenancy/tenant-context-service.mjs";
import { createLoggingMailer } from "./mail/logging-mailer.mjs";
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

  const orderRefundService = createOrderRefundService(database);
  const salesReportService = createSalesReportService(database);
  // The order service is wired so the real checkout flow
  // (POST /api/pos/orders, where the legacy POS outbox
  // delivers every completed order) deducts recipe
  // ingredients from the inventory domain inside the
  // authoritative order transaction. The consumption
  // service is shared so the order service and any direct
  // caller use one instance.
  const inventoryConsumptionService = createInventoryConsumptionService(database);
  const orderService = createOrderService(database, {
    inventoryConsumption: inventoryConsumptionService,
  });
  // The menu service is wired so the recipe editor can list
  // the restaurant's products. It is a read-only, existing
  // route (GET /api/pos/menu) guarded by ORDER_CREATE.
  const menuService = createMenuService(database);
  const supplierService = createSupplierService(database);
  const inventoryService = createInventoryService(database);
  const recipeService = createRecipeService(database);
  const purchaseService = createPurchaseService(database);

  const app = await buildHttpApp({
    authService,
    tenantContextService: createTenantContextService(database),
    subscriptionService,
    billingWebhookService,
    menuService,
    orderService,
    orderRefundService,
    salesReportService,
    supplierService,
    inventoryService,
    recipeService,
    purchaseService,
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
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  startServer({ logger: console }).catch((error) => {
    console.error({ message: "pos_server_start_failed", error: error.message });
    process.exitCode = 1;
  });
}