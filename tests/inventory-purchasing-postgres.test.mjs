import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createSupplierService } from "../src/server/pos/supplier-service.mjs";
import { createInventoryService } from "../src/server/pos/inventory-service.mjs";
import { createPurchaseService } from "../src/server/pos/purchase-service.mjs";
import { createRecipeService } from "../src/server/pos/recipe-service.mjs";
import { createInventoryConsumptionService } from "../src/server/pos/inventory-consumption-service.mjs";
import { createOrderService } from "../src/server/pos/order-service.mjs";
import {
  createAppPool,
  connectAdmin,
  isDatabaseAvailable,
  provisionIntegrationDatabase,
  seedRestaurant,
} from "./helpers/postgres.mjs";
import { projectRoot } from "./helpers/legacy-source.mjs";

const available = await isDatabaseAvailable();
const describeDatabase = available ? describe : describe.skip;

if (!available) {
  console.warn(
    "[skipped] Inventory PostgreSQL integration tests: no database. "
    + "Run `docker compose -f compose.test-database.yaml up -d` then `npm run test:integration`.",
  );
}

const FIXED_CLOCK = new Date("2026-10-06T08:00:00.000Z");
const clock = () => FIXED_CLOCK;

/**
 * Wraps a pool so that any statement matching `failOnSql`
 * throws after `failAfter` matching statements. Used to
 * prove that a mid-transaction failure rolls every earlier
 * statement back. The wrapper delegates to the real client
 * without mutating it, so pooled connections are never
 * permanently altered.
 */
function injectFailure(pool, failOnSql, failAfter = 0) {
  let matches = 0;
  return {
    async connect() {
      const client = await pool.connect();
      return {
        query: async (sql, params) => {
          if (String(sql).toLowerCase().includes(failOnSql)) {
            if (matches++ >= failAfter) {
              throw new Error("injected failure");
            }
          }
          return client.query(sql, params);
        },
        release: () => client.release(),
      };
    },
  };
}

/** The tenant context shape the order service expects. */
function orderTenant(restaurant) {
  return {
    restaurant: {
      id: restaurant.restaurantId,
      name: "Test Restaurant",
      timezone: "Asia/Karachi",
      status: "active",
    },
    membership: {
      userId: restaurant.userId,
      role: "owner",
      status: "active",
      defaultBranchId: restaurant.branchId,
    },
  };
}

describeDatabase("Inventory & Purchasing PostgreSQL Integration Tests", () => {
  let admin;
  let pool;
  let tenantA;
  let tenantB;
  let supplierA;
  let supplierB;
  let tomatoes;
  let cheese;
  let margheritaId;
  let sodaId;
  let cashAccountId;
  let supplierService;
  let inventoryService;
  let purchaseService;
  let recipeService;
  let consumptionService;
  let orderService;

  before(async () => {
    // Applies every migration to a clean schema: if any of
    // the 12 migrations fails, this hook fails the suite.
    await provisionIntegrationDatabase();
    admin = await connectAdmin();
    pool = await createAppPool();

    tenantA = await seedRestaurant(admin, { name: "Restaurant Alpha" });
    tenantB = await seedRestaurant(admin, { name: "Restaurant Beta" });

    supplierService = createSupplierService(pool, { clock });
    inventoryService = createInventoryService(pool, { clock });
    purchaseService = createPurchaseService(pool, { clock });
    recipeService = createRecipeService(pool, { clock });
    consumptionService = createInventoryConsumptionService(pool, { clock });
    orderService = createOrderService(pool, {
      clock,
      inventoryConsumption: consumptionService,
    });

    // Restaurant A fixtures.
    supplierA = (await supplierService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { name: "Alpha Farms", phone: "0300-1234567" },
    })).supplier;
    tomatoes = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Tomatoes",
        sku: "TOM-1",
        baseUnit: "kilogram",
        openingQuantity: 10,
        reorderLevel: 5,
        averageCostMinor: 100,
      },
    })).item;
    cheese = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Cheese",
        baseUnit: "gram",
        openingQuantity: 1000,
        averageCostMinor: 50,
      },
    })).item;

    // Restaurant B fixtures.
    supplierB = (await supplierService.create({
      restaurantId: tenantB.restaurantId,
      userId: tenantB.userId,
      input: { name: "Beta Farms" },
    })).supplier;

    // Menu products for the order-consumption flow. Margherita
    // has a recipe; Soda deliberately has none.
    const menuResult = await admin.query(
      `INSERT INTO menu_items (restaurant_id, name, item_type, price_minor)
       VALUES ($1, 'Margherita', 'standard', 50000),
              ($1, 'Soda', 'soft_drink', 15000)
       RETURNING id, name`,
      [tenantA.restaurantId],
    );
    margheritaId = menuResult.rows.find((row) => row.name === "Margherita").id;
    sodaId = menuResult.rows.find((row) => row.name === "Soda").id;

    await recipeService.replace({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      productId: margheritaId,
      items: [
        { inventoryItemId: tomatoes.id, quantityRequired: 0.25 },
        { inventoryItemId: cheese.id, quantityRequired: 120 },
      ],
    });

    // A cash account so a paid checkout can be captured.
    const accountResult = await admin.query(
      `INSERT INTO financial_accounts (restaurant_id, branch_id, account_type, display_name)
       VALUES ($1, $2, 'cash', 'Register Cash')
       RETURNING id`,
      [tenantA.restaurantId, tenantA.branchId],
    );
    cashAccountId = accountResult.rows[0].id;
  });

  after(async () => {
    await pool.end();
    await admin.end();
  });

  it("applies every available migration and creates the inventory tables", async () => {
    const files = (await readdir(path.join(projectRoot, "database", "migrations")))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const history = await admin.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(history.rows.map(row => row.version), files.map(file => Number(file.split("_")[0])));
    assert.ok(files.includes("012_inventory_purchasing.sql"));

    const tables = await admin.query(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename`,
      [[
        "suppliers",
        "inventory_items",
        "product_recipes",
        "purchase_sequences",
        "purchases",
        "purchase_items",
        "inventory_movements",
        "inventory_consumptions",
      ]],
    );
    assert.equal(tables.rows.length, 8);
  });

  it("runs the application role as a non-superuser that cannot bypass RLS", async () => {
    const role = await admin.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
      ["pos_integration_app"],
    );
    assert.equal(role.rows.length, 1);
    assert.equal(role.rows[0].rolsuper, false);
    assert.equal(role.rows[0].rolbypassrls, false);
  });

  it("hides another restaurant's rows from every new table", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.restaurant_id', $1, true)",
        [tenantA.restaurantId],
      );

      // Restaurant B's supplier, inventory item, and their
      // dependent rows are invisible to Restaurant A.
      const supplierRows = await client.query(
        "SELECT * FROM suppliers WHERE id = $1",
        [supplierB.id],
      );
      assert.equal(supplierRows.rows.length, 0);

      const betaItem = await admin.query(
        `INSERT INTO inventory_items (restaurant_id, name, base_unit, idempotency_key)
         VALUES ($1, 'Beta Stock', 'piece', $2) RETURNING id`,
        [tenantB.restaurantId, randomUUID()],
      );
      const itemRows = await client.query(
        "SELECT * FROM inventory_items WHERE id = $1",
        [betaItem.rows[0].id],
      );
      assert.equal(itemRows.rows.length, 0);

      // Recipes: Restaurant A cannot read Restaurant B's
      // product recipe, and the product itself is invisible.
      const betaProduct = await admin.query(
        `INSERT INTO menu_items (restaurant_id, name, price_minor)
         VALUES ($1, 'Beta Special', 1000) RETURNING id`,
        [tenantB.restaurantId],
      );
      await admin.query(
        `INSERT INTO product_recipes (restaurant_id, product_id, inventory_item_id, quantity_required)
         VALUES ($1, $2, $3, 1)`,
        [tenantB.restaurantId, betaProduct.rows[0].id, betaItem.rows[0].id],
      );
      const recipeRows = await client.query(
        `SELECT r.* FROM product_recipes r
          WHERE r.product_id = $1`,
        [betaProduct.rows[0].id],
      );
      assert.equal(recipeRows.rows.length, 0);

      // Purchases and their lines.
      const betaPurchase = await admin.query(
        `INSERT INTO purchases (restaurant_id, supplier_id, purchase_number, purchase_date, idempotency_key, created_by_user_id)
         VALUES ($1, $2, 'PO-000001', CURRENT_DATE, $3, $4) RETURNING id`,
        [tenantB.restaurantId, supplierB.id, randomUUID(), tenantB.userId],
      );
      const purchaseRows = await client.query(
        "SELECT * FROM purchases WHERE id = $1",
        [betaPurchase.rows[0].id],
      );
      assert.equal(purchaseRows.rows.length, 0);

      // Stock movements and order consumptions.
      const betaMovement = await admin.query(
        `INSERT INTO inventory_movements (restaurant_id, inventory_item_id, movement_type, quantity_delta, quantity_after, idempotency_key)
         VALUES ($1, $2, 'adjustment_increase', 1, 1, $3) RETURNING id`,
        [tenantB.restaurantId, betaItem.rows[0].id, randomUUID()],
      );
      const movementRows = await client.query(
        "SELECT * FROM inventory_movements WHERE id = $1",
        [betaMovement.rows[0].id],
      );
      assert.equal(movementRows.rows.length, 0);

      const betaOrder = await admin.query(
        `INSERT INTO orders (restaurant_id, branch_id, order_number, order_type, order_status, payment_status, subtotal_minor, discount_minor, delivery_minor, additional_charges_minor, total_minor, business_date, ordered_at, idempotency_key, created_by_user_id)
         VALUES ($1, $2, 1, 'dine_in', 'completed', 'paid', 1000, 0, 0, 0, 1000, CURRENT_DATE, now(), $3, $4)
         RETURNING id`,
        [tenantB.restaurantId, tenantB.branchId, randomUUID(), tenantB.userId],
      );
      await admin.query(
        `INSERT INTO inventory_consumptions (restaurant_id, order_id, item_count)
         VALUES ($1, $2, 0)`,
        [tenantB.restaurantId, betaOrder.rows[0].id],
      );
      const consumptionRows = await client.query(
        "SELECT * FROM inventory_consumptions WHERE order_id = $1",
        [betaOrder.rows[0].id],
      );
      assert.equal(consumptionRows.rows.length, 0);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("cannot mutate another restaurant's rows", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.restaurant_id', $1, true)",
        [tenantA.restaurantId],
      );

      // The UPDATE matches zero rows under RLS, so Restaurant
      // B's supplier keeps its name.
      const update = await client.query(
        "UPDATE suppliers SET name = 'Hacked' WHERE id = $1",
        [supplierB.id],
      );
      assert.equal(update.rowCount, 0);
      const unchanged = await admin.query(
        "SELECT name FROM suppliers WHERE id = $1",
        [supplierB.id],
      );
      assert.equal(unchanged.rows[0].name, "Beta Farms");

      // A cross-tenant existence check leaks nothing: the
      // purchase service reports the supplier as not found.
      await assert.rejects(
        () => purchaseService.create({
          restaurantId: tenantA.restaurantId,
          userId: tenantA.userId,
          input: {
            idempotencyKey: randomUUID(),
            supplierId: supplierB.id,
            purchaseDate: "2026-10-06",
            items: [{ inventoryItemId: tomatoes.id, quantity: 1, unitCostMinor: 100 }],
          },
        }),
        (error) => error.statusCode === 404 && error.code === "SUPPLIER_NOT_FOUND",
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  it("enforces active supplier name uniqueness per restaurant", async () => {
    await assert.rejects(
      () => supplierService.create({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        input: { name: "Alpha Farms" },
      }),
      (error) => error.statusCode === 409 && error.code === "DUPLICATE_SUPPLIER_NAME",
    );

    // A deactivated supplier's name may be reused by a new
    // active supplier.
    await supplierService.deactivate({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      supplierId: supplierA.id,
    });
    const reused = await supplierService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { name: "Alpha Farms" },
    });
    assert.equal(reused.supplier.name, "Alpha Farms");

    // Restaurant B keeps its own namespace.
    await assert.rejects(
      () => supplierService.create({
        restaurantId: tenantB.restaurantId,
        userId: tenantB.userId,
        input: { name: "Beta Farms" },
      }),
      (error) => error.statusCode === 409 && error.code === "DUPLICATE_SUPPLIER_NAME",
    );
  });

  it("enforces SKU uniqueness only when a SKU is present", async () => {
    await assert.rejects(
      () => inventoryService.create({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        input: {
          idempotencyKey: randomUUID(),
          name: "More Tomatoes",
          sku: "TOM-1",
          baseUnit: "kilogram",
        },
      }),
      (error) => error.statusCode === 409 && error.code === "DUPLICATE_SKU",
    );

    // NULL SKUs never collide.
    const first = await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { idempotencyKey: randomUUID(), name: "No SKU A", baseUnit: "piece" },
    });
    const second = await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { idempotencyKey: randomUUID(), name: "No SKU B", baseUnit: "piece" },
    });
    assert.notEqual(first.item.id, second.item.id);
  });

  it("records the opening balance and its movement atomically", async () => {
    const key = randomUUID();
    const result = await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: key,
        name: "Atomic Stock",
        baseUnit: "piece",
        openingQuantity: 25,
      },
    });
    assert.equal(result.item.currentQuantity, 25);

    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: result.item.id,
    });
    assert.equal(movements.movements.length, 1);
    assert.equal(movements.movements[0].movementType, "adjustment_increase");
    assert.equal(Number(movements.movements[0].quantityDelta), 25);
    assert.equal(Number(movements.movements[0].quantityAfter), 25);

    // A failure while writing the movement rolls the item
    // insert back: no orphan item without its ledger row.
    const failingPool = injectFailure(pool, "insert into inventory_movements");
    const failingService = createInventoryService(failingPool, { clock });
    await assert.rejects(
      () => failingService.create({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        input: {
          idempotencyKey: randomUUID(),
          name: "Rolled Back Stock",
          baseUnit: "piece",
          openingQuantity: 5,
        },
      }),
      /injected failure/,
    );
    const orphaned = await admin.query(
      "SELECT * FROM inventory_items WHERE name = $1",
      ["Rolled Back Stock"],
    );
    assert.equal(orphaned.rows.length, 0);
  });

  it("does not lose updates under concurrent stock adjustments", async () => {
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { idempotencyKey: randomUUID(), name: "Concurrency Stock", baseUnit: "piece" },
    })).item;

    const adjustments = [];
    for (let index = 0; index < 10; index += 1) {
      adjustments.push(
        inventoryService.adjust({
          restaurantId: tenantA.restaurantId,
          userId: tenantA.userId,
          input: {
            idempotencyKey: randomUUID(),
            itemId: item.id,
            direction: "increase",
            quantity: 1,
            reason: `Concurrent adjustment ${index}`,
          },
        }),
      );
    }
    const results = await Promise.all(adjustments);
    assert.equal(results.length, 10);
    for (const result of results) {
      assert.equal(result.replayed, false);
    }

    const stored = await inventoryService.get({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    assert.equal(stored.item.currentQuantity, 10);

    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    assert.equal(movements.movements.length, 10);
  });

  it("receives a purchase once under concurrent receipt with the same key", async () => {
    const supplier = (await supplierService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { name: "Receipt Supplier" },
    })).supplier;
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Receipt Stock",
        baseUnit: "kilogram",
        openingQuantity: 0,
      },
    })).item;

    const draft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 10, unitCostMinor: 300 }],
      },
    });

    const key = randomUUID();
    const [first, second] = await Promise.all([
      purchaseService.receive({ restaurantId: tenantA.restaurantId, userId: tenantA.userId, purchaseId: draft.purchase.id, idempotencyKey: key }),
      purchaseService.receive({ restaurantId: tenantA.restaurantId, userId: tenantA.userId, purchaseId: draft.purchase.id, idempotencyKey: key }),
    ]);

    const outcomes = [first, second].sort((a, b) => Number(a.replayed) - Number(b.replayed));
    assert.equal(outcomes[0].replayed, false);
    assert.equal(outcomes[1].replayed, true);

    // Stock was created exactly once.
    const stored = await inventoryService.get({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    assert.equal(stored.item.currentQuantity, 10);
    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    const receipts = movements.movements.filter((m) => m.movementType === "purchase_receipt");
    assert.equal(receipts.length, 1);
  });

  it("rejects a second receipt key after the purchase was received", async () => {
    const supplier = (await supplierService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { name: "Second Receipt Supplier" },
    })).supplier;
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Second Receipt Stock",
        baseUnit: "kilogram",
      },
    })).item;

    const draft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 5, unitCostMinor: 100 }],
      },
    });
    await purchaseService.receive({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      purchaseId: draft.purchase.id,
      idempotencyKey: randomUUID(),
    });

    await assert.rejects(
      () => purchaseService.receive({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        purchaseId: draft.purchase.id,
        idempotencyKey: randomUUID(),
      }),
      (error) => error.statusCode === 409 && error.code === "PURCHASE_ALREADY_RECEIVED",
    );

    const stored = await inventoryService.get({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    assert.equal(stored.item.currentQuantity, 5);
  });

  it("computes the weighted average cost exactly", async () => {
    const supplier = (await supplierService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { name: "Costing Supplier" },
    })).supplier;

    // 10 kg @ 100 + 10 kg @ 300 → 20 kg at exactly 200.
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Costed Stock",
        baseUnit: "kilogram",
        openingQuantity: 10,
        averageCostMinor: 100,
      },
    })).item;
    const draft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 10, unitCostMinor: 300 }],
      },
    });
    await purchaseService.receive({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      purchaseId: draft.purchase.id,
      idempotencyKey: randomUUID(),
    });
    let stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: item.id });
    assert.equal(stored.item.currentQuantity, 20);
    assert.equal(stored.item.averageCostMinor, 200);

    // Half-up rounding: 1 @ 100 + 1 @ 101 → average 100.5 → 101.
    const halfUp = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Half-Up Stock",
        baseUnit: "kilogram",
        openingQuantity: 1,
        averageCostMinor: 100,
      },
    })).item;
    const halfUpDraft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: halfUp.id, quantity: 1, unitCostMinor: 101 }],
      },
    });
    await purchaseService.receive({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      purchaseId: halfUpDraft.purchase.id,
      idempotencyKey: randomUUID(),
    });
    stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: halfUp.id });
    assert.equal(stored.item.currentQuantity, 2);
    assert.equal(stored.item.averageCostMinor, 101);

    // Zero existing quantity: the receipt cost becomes the average.
    const empty = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Empty Stock",
        baseUnit: "litre",
      },
    })).item;
    const emptyDraft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: empty.id, quantity: 10, unitCostMinor: 250 }],
      },
    });
    await purchaseService.receive({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      purchaseId: emptyDraft.purchase.id,
      idempotencyKey: randomUUID(),
    });
    stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: empty.id });
    assert.equal(stored.item.currentQuantity, 10);
    assert.equal(stored.item.averageCostMinor, 250);

    // A receipt that moves a negative balance toward zero
    // revalues the position at the receipt cost, keeping the
    // average non-negative.
    const negative = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Negative Stock",
        baseUnit: "kilogram",
        openingQuantity: 5,
        averageCostMinor: 100,
      },
    })).item;
    await inventoryService.waste({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: { idempotencyKey: randomUUID(), itemId: negative.id, quantity: 10, reason: "Oversold" },
    });
    stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: negative.id });
    assert.equal(stored.item.currentQuantity, -5);

    const negativeDraft = await purchaseService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: negative.id, quantity: 10, unitCostMinor: 300 }],
      },
    });
    await purchaseService.receive({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      purchaseId: negativeDraft.purchase.id,
      idempotencyKey: randomUUID(),
    });
    stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: negative.id });
    assert.equal(stored.item.currentQuantity, 5);
    assert.equal(stored.item.averageCostMinor, 300);
  });

  it("consumes recipe inventory exactly once for a completed paid order", async () => {
    const before = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    const result = await orderService.create({
      tenant: orderTenant(tenantA),
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "dine_in",
        items: [{ menuItemId: margheritaId, quantity: 2 }],
        payment: { method: "cash", amountReceivedMinor: 100000, financialAccountId: cashAccountId },
      },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.order.paymentStatus, "paid");
    assert.equal(result.inventoryConsumption.replayed, false);
    assert.equal(result.inventoryConsumption.consumedItemCount, 2);

    // 2 x Margherita consumes 0.5 kg of tomatoes and 240 g of cheese.
    const afterTomatoes = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    const afterCheese = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: cheese.id });
    assert.equal(afterTomatoes.item.currentQuantity, Number(before.item.currentQuantity) - 0.5);
    assert.equal(afterCheese.item.currentQuantity, 1000 - 240);

    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: tomatoes.id,
    });
    const consumption = movements.movements.filter((m) => m.movementType === "sale_consumption");
    assert.equal(consumption.length, 1);
    assert.equal(consumption[0].referenceType, "order");
    assert.equal(consumption[0].referenceId, result.order.id);
    assert.equal(Number(consumption[0].quantityDelta), -0.5);

    // The consumption row is the durable exactly-once proof.
    const rows = await admin.query(
      "SELECT * FROM inventory_consumptions WHERE order_id = $1",
      [result.order.id],
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].item_count, 2);
  });

  it("deducts inventory once when the same checkout is replayed concurrently", async () => {
    const before = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    const key = randomUUID();
    const payload = {
      idempotencyKey: key,
      orderType: "dine_in",
      items: [{ menuItemId: margheritaId, quantity: 1 }],
      payment: { method: "cash", amountReceivedMinor: 50000, financialAccountId: cashAccountId },
    };

    const [first, second] = await Promise.all([
      orderService.create({ tenant: orderTenant(tenantA), userId: tenantA.userId, input: payload }),
      orderService.create({ tenant: orderTenant(tenantA), userId: tenantA.userId, input: payload }),
    ]);

    const outcomes = [first, second].sort((a, b) => Number(a.replayed) - Number(b.replayed));
    assert.equal(outcomes[0].replayed, false);
    assert.equal(outcomes[1].replayed, true);
    assert.equal(outcomes[1].order.id, outcomes[0].order.id);

    // Exactly one 0.25 kg deduction happened.
    const after = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    assert.equal(after.item.currentQuantity, Number(before.item.currentQuantity) - 0.25);

    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: tomatoes.id,
    });
    const forOrder = movements.movements.filter(
      (m) => m.movementType === "sale_consumption" && m.referenceId === outcomes[0].order.id,
    );
    assert.equal(forOrder.length, 1);
  });

  it("allows negative stock and records it without blocking checkout", async () => {
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Oversold Stock",
        baseUnit: "kilogram",
        openingQuantity: 0.25,
        averageCostMinor: 100,
      },
    })).item;
    await recipeService.replace({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      productId: margheritaId,
      items: [
        { inventoryItemId: item.id, quantityRequired: 1 },
        { inventoryItemId: cheese.id, quantityRequired: 120 },
      ],
    });

    // Ordering 100 units drives the balance to -99.75 kg.
    const result = await orderService.create({
      tenant: orderTenant(tenantA),
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "dine_in",
        items: [{ menuItemId: margheritaId, quantity: 100 }],
        payment: { method: "cash", amountReceivedMinor: 5000000, financialAccountId: cashAccountId },
      },
    });
    assert.equal(result.replayed, false);
    assert.ok(result.inventoryConsumption.warnings.some((w) => w.type === "negative_stock"));

    const stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: item.id });
    assert.equal(stored.item.currentQuantity, -99.75);
    assert.equal(stored.item.isNegativeStock, true);

    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    const consumption = movements.movements.find((m) => m.movementType === "sale_consumption");
    assert.equal(Number(consumption.quantityAfter), -99.75);

    // Restore the recipe for the remaining tests.
    await recipeService.replace({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      productId: margheritaId,
      items: [
        { inventoryItemId: tomatoes.id, quantityRequired: 0.25 },
        { inventoryItemId: cheese.id, quantityRequired: 120 },
      ],
    });
  });

  it("does not block checkout when a product has no recipe", async () => {
    const result = await orderService.create({
      tenant: orderTenant(tenantA),
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        orderType: "dine_in",
        items: [{ menuItemId: sodaId, quantity: 1 }],
        payment: { method: "cash", amountReceivedMinor: 15000, financialAccountId: cashAccountId },
      },
    });
    assert.equal(result.replayed, false);
    assert.ok(result.inventoryConsumption.warnings.some((w) => w.type === "missing_recipe"));
    assert.equal(result.inventoryConsumption.consumedItemCount, 0);
  });

  it("rolls back the balance and the ledger when a movement write fails", async () => {
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Rollback Stock",
        baseUnit: "piece",
        openingQuantity: 50,
      },
    })).item;

    const failingPool = injectFailure(pool, "insert into inventory_movements");
    const failingService = createInventoryService(failingPool, { clock });
    await assert.rejects(
      () => failingService.adjust({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        input: {
          idempotencyKey: randomUUID(),
          itemId: item.id,
          direction: "decrease",
          quantity: 10,
          reason: "Should roll back",
        },
      }),
      /injected failure/,
    );

    const stored = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: item.id });
    assert.equal(stored.item.currentQuantity, 50);
    const movements = await inventoryService.movements({
      restaurantId: tenantA.restaurantId,
      itemId: item.id,
    });
    assert.equal(movements.movements.length, 1); // only the opening balance
  });

  it("rolls back the order, consumption, and ledger when the payment write fails", async () => {
    const before = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    const key = randomUUID();
    const failingPool = injectFailure(pool, "insert into order_payments");
    const failingOrderService = createOrderService(failingPool, {
      clock,
      inventoryConsumption: consumptionService,
    });

    await assert.rejects(
      () => failingOrderService.create({
        tenant: orderTenant(tenantA),
        userId: tenantA.userId,
        input: {
          idempotencyKey: key,
          orderType: "dine_in",
          items: [{ menuItemId: margheritaId, quantity: 1 }],
          payment: { method: "cash", amountReceivedMinor: 50000, financialAccountId: cashAccountId },
        },
      }),
      /injected failure/,
    );

    // Nothing committed: no order, no consumption, no movement,
    // and the stock balance is untouched.
    const orders = await admin.query(
      "SELECT * FROM orders WHERE idempotency_key = $1",
      [key],
    );
    assert.equal(orders.rows.length, 0);
    const consumptions = await admin.query(
      "SELECT * FROM inventory_consumptions WHERE order_id = ANY($1::uuid[])",
      [orders.rows.map((row) => row.id)],
    );
    assert.equal(consumptions.rows.length, 0);
    const after = await inventoryService.get({ restaurantId: tenantA.restaurantId, itemId: tomatoes.id });
    assert.equal(after.item.currentQuantity, Number(before.item.currentQuantity));
  });

  it("refuses to modify or delete ledger rows using the application role", async () => {
    const client = await pool.connect();
    try {
      // Each attempt runs in its own transaction: a rejected
      // statement aborts the transaction, so the next attempt
      // needs a fresh one.
      async function attemptAsTenant(sql, params) {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.restaurant_id', $1, true)",
          [tenantA.restaurantId],
        );
        try {
          await client.query(sql, params);
          await client.query("ROLLBACK");
          return null;
        } catch (error) {
          await client.query("ROLLBACK");
          return error;
        }
      }

      const updateError = await attemptAsTenant(
        `UPDATE inventory_movements
            SET notes = 'tampered'
          WHERE restaurant_id = $1`,
        [tenantA.restaurantId],
      );
      assert.ok(updateError, "The ledger update must be rejected");
      assert.match(updateError.message, /append-only/);

      const deleteError = await attemptAsTenant(
        "DELETE FROM inventory_movements WHERE restaurant_id = $1",
        [tenantA.restaurantId],
      );
      assert.ok(deleteError, "The ledger delete must be rejected");
      assert.match(deleteError.message, /append-only/);

      // The ledger is intact.
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.restaurant_id', $1, true)",
        [tenantA.restaurantId],
      );
      const count = await client.query(
        "SELECT count(*)::int AS count FROM inventory_movements WHERE restaurant_id = $1",
        [tenantA.restaurantId],
      );
      await client.query("ROLLBACK");
      assert.ok(count.rows[0].count > 0);
    } finally {
      client.release();
    }
  });

  it("paginates the ledger stably when movements share a timestamp", async () => {
    const item = (await inventoryService.create({
      restaurantId: tenantA.restaurantId,
      userId: tenantA.userId,
      input: {
        idempotencyKey: randomUUID(),
        name: "Paged Stock",
        baseUnit: "piece",
        openingQuantity: 1,
      },
    })).item;

    // The fixed clock gives every movement the same created_at,
    // so only the keyset (timestamp, id) keeps pages stable.
    for (let index = 0; index < 5; index += 1) {
      await inventoryService.adjust({
        restaurantId: tenantA.restaurantId,
        userId: tenantA.userId,
        input: {
          idempotencyKey: randomUUID(),
          itemId: item.id,
          direction: "increase",
          quantity: 1,
          reason: `Page ${index}`,
        },
      });
    }

    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await inventoryService.movements({
        restaurantId: tenantA.restaurantId,
        itemId: item.id,
        limit: 2,
        cursor: cursor ?? undefined,
      });
      for (const movement of page.movements) {
        seen.push(movement.notes);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    // The opening balance plus five adjustments, each exactly once.
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
    assert.ok(seen.includes("Opening balance"));
    for (let index = 0; index < 5; index += 1) {
      assert.ok(seen.includes(`Page ${index}`));
    }
  });
});
