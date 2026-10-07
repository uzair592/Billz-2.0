import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createSupplierService } from "../src/server/pos/supplier-service.mjs";
import { createInventoryService } from "../src/server/pos/inventory-service.mjs";
import { createPurchaseService } from "../src/server/pos/purchase-service.mjs";
import { createRecipeService } from "../src/server/pos/recipe-service.mjs";
import { createInventoryConsumptionService } from "../src/server/pos/inventory-consumption-service.mjs";
import {
  decodeInventoryCursor,
  encodeInventoryCursor,
  lineTotalMinor,
  quantizeQuantity,
  weightedAverageCostMinor,
} from "../src/server/pos/inventory-ledger.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";
import { PERMISSION } from "../src/server/authorization/permissions.mjs";
import { hasPermission } from "../src/server/authorization/permissions.mjs";

const restaurantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-06T08:00:00.000Z");
const NOW_TEXT = "2026-10-06 08:00:00+00";

/**
 * An in-memory PostgreSQL stand-in. It answers exactly the
 * queries the Milestone 14 services issue, so the services'
 * SQL, normalization, and transaction boundaries are exercised
 * for real while the storage stays deterministic.
 */
function createFakeDb() {
  const state = {
    suppliers: new Map(),
    inventoryItems: new Map(),
    movements: [],
    purchases: new Map(),
    purchaseItems: [],
    purchaseSequences: new Map(),
    recipes: [],
    consumptions: [],
    menuItems: new Map(),
  };
  const failures = [];

  const asTs = (value) => (value instanceof Date ? ts(value) : value);
  const ts = (date) => date.toISOString().replace("T", " ").replace(".000Z", "+00");

  function failOn(match, error) {
    failures.push({ match, error });
  }

  async function query(text, values) {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    if (sql.startsWith("SET LOCAL") || sql.includes("set_config(")) {
      return { rows: [] };
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }

    for (const failure of failures) {
      if (failure.match(sql)) throw failure.error;
    }

    // ── Suppliers ─────────────────────────────────────
    if (sql.startsWith("SELECT * FROM suppliers") && sql.includes("$2::boolean IS NULL OR is_active = $2")) {
      const [rid, isActive] = values;
      const rows = [...state.suppliers.values()]
        .filter((s) => s.restaurant_id === rid && (isActive === null || s.is_active === isActive))
        .sort((a, b) => (b.is_active - a.is_active) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
      return { rows };
    }
    if (sql.startsWith("INSERT INTO suppliers")) {
      const [rid, name, contactPerson, phone, email, address, notes, isActive] = values;
      const row = {
        id: randomUUID(), restaurant_id: rid, name, contact_person: contactPerson,
        phone, email, address, notes, is_active: isActive,
        created_at: NOW_TEXT, updated_at: NOW_TEXT,
      };
      state.suppliers.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE suppliers")) {
      const setMatch = sql.match(/SET (.+?) WHERE/);
      const [rid, id, ...setValues] = values;
      const row = [...state.suppliers.values()].find((s) => s.restaurant_id === rid && s.id === id);
      if (!row) return { rows: [] };
      setMatch[1].split(", ").forEach((clause, index) => {
        row[clause.split(" = ")[0]] = setValues[index];
      });
      row.updated_at = NOW_TEXT;
      return { rows: [row] };
    }

    // ── Inventory items ───────────────────────────────
    if (sql.startsWith("SELECT i.*, i.created_at::text AS created_at_text FROM inventory_items i") && sql.includes("i.current_quantity <= i.reorder_level")) {
      const [rid, limit] = values;
      const rows = [...state.inventoryItems.values()]
        .filter((i) => i.restaurant_id === rid && i.is_active && Number(i.current_quantity) <= Number(i.reorder_level))
        .sort((a, b) => Number(a.current_quantity) - Number(b.current_quantity) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
        .slice(0, Number(limit));
      return { rows: rows.map((i) => ({ ...i, created_at_text: i.created_at })) };
    }
    if (sql.startsWith("SELECT i.*, i.created_at::text AS created_at_text FROM inventory_items i")) {
      const [rid, searchTerm, isActive] = values;
      let rows = [...state.inventoryItems.values()].filter((i) => i.restaurant_id === rid);
      if (searchTerm) {
        const term = searchTerm.replace(/^%|%$/g, "").toLowerCase();
        rows = rows.filter((i) => i.name.toLowerCase().includes(term) || (i.sku && i.sku.toLowerCase().includes(term)));
      }
      if (isActive !== null && isActive !== undefined) {
        rows = rows.filter((i) => i.is_active === isActive);
      }
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
      const { cursorTs, cursorId } = cursorFrom(values);
      if (cursorTs) {
        rows = rows.filter((row) => row.created_at < cursorTs || (row.created_at === cursorTs && row.id < cursorId));
      }
      return { rows: rows.map((i) => ({ ...i, created_at_text: i.created_at })) };
    }
    if (sql.startsWith("SELECT id, name, sku, base_unit, current_quantity") && sql.includes("WHERE restaurant_id = $1 AND id = $2")) {
      const [rid, id] = values;
      const row = state.inventoryItems.get(id);
      if (!row || row.restaurant_id !== rid) return { rows: [] };
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT * FROM inventory_items") && sql.includes("WHERE restaurant_id = $1 AND id = $2")) {
      const [rid, id] = values;
      const row = state.inventoryItems.get(id);
      if (!row || row.restaurant_id !== rid) return { rows: [] };
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT id FROM inventory_items") && sql.includes("idempotency_key = $2")) {
      const [rid, key] = values;
      const row = [...state.inventoryItems.values()].find((i) => i.restaurant_id === rid && i.idempotency_key === key);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (sql.startsWith("SELECT id FROM inventory_items") && sql.includes("id = ANY($2::uuid[])")) {
      const [rid, ids] = values;
      const rows = [...state.inventoryItems.values()].filter((i) => i.restaurant_id === rid && ids.includes(i.id));
      return { rows: rows.map((i) => ({ id: i.id })) };
    }
    if (sql.startsWith("INSERT INTO inventory_items")) {
      const [rid, name, sku, baseUnit, reorderLevel, averageCostMinor, idempotencyKey] = values;
      const row = {
        id: randomUUID(), restaurant_id: rid, name, sku, base_unit: baseUnit,
        current_quantity: 0, reorder_level: reorderLevel, average_cost_minor: averageCostMinor,
        is_active: true, idempotency_key: idempotencyKey,
        created_at: NOW_TEXT, updated_at: NOW_TEXT,
      };
      state.inventoryItems.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.startsWith("UPDATE inventory_items") && sql.includes("current_quantity = current_quantity + $3")) {
      const [rid, id, delta] = values;
      const row = state.inventoryItems.get(id);
      if (row && row.restaurant_id === rid) {
        row.current_quantity = Number(row.current_quantity) + Number(delta);
        row.updated_at = NOW_TEXT;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE inventory_items") && sql.includes("current_quantity = current_quantity - $3")) {
      const [rid, id, delta] = values;
      const row = state.inventoryItems.get(id);
      if (row && row.restaurant_id === rid) {
        row.current_quantity = Number(row.current_quantity) - Number(delta);
        row.updated_at = NOW_TEXT;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE inventory_items") && sql.includes("current_quantity = $3") && sql.includes("average_cost_minor = $4")) {
      const [rid, id, quantity, averageCostMinor] = values;
      const row = state.inventoryItems.get(id);
      if (row && row.restaurant_id === rid) {
        row.current_quantity = Number(quantity);
        row.average_cost_minor = Number(averageCostMinor);
        row.updated_at = NOW_TEXT;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE inventory_items")) {
      const setMatch = sql.match(/SET (.+?) WHERE/);
      const [rid, id, ...setValues] = values;
      const row = state.inventoryItems.get(id);
      if (!row || row.restaurant_id !== rid) return { rows: [] };
      setMatch[1].split(", ").forEach((clause, index) => {
        row[clause.split(" = ")[0]] = setValues[index];
      });
      row.updated_at = NOW_TEXT;
      return { rows: [row] };
    }

    // ── Movement ledger ───────────────────────────────
    if (sql.startsWith("INSERT INTO inventory_movements")) {
      const [id, rid, itemId, movementType, quantityDelta, quantityAfter, unitCostMinor, totalCostMinor, referenceType, referenceId, idempotencyKey, notes, actorUserId, createdAt] = values;
      state.movements.push({
        id, restaurant_id: rid, inventory_item_id: itemId, movement_type: movementType,
        quantity_delta: quantityDelta, quantity_after: quantityAfter,
        unit_cost_minor: unitCostMinor, total_cost_minor: totalCostMinor,
        reference_type: referenceType, reference_id: referenceId,
        idempotency_key: idempotencyKey, notes, actor_user_id: actorUserId,
        created_at: asTs(createdAt),
      });
      return { rows: [] };
    }
    if (sql.includes("FROM inventory_movements m") && sql.includes("WHERE m.id = $1")) {
      const [id] = values;
      const movement = state.movements.find((m) => m.id === id);
      if (!movement) return { rows: [] };
      return { rows: [withItemDetails(movement)] };
    }
    if (sql.includes("FROM inventory_movements m") && sql.includes("WHERE m.restaurant_id = $1")) {
      const [rid] = values;
      const itemId = sql.includes("m.inventory_item_id = $2") ? values[1] : null;
      let rows = state.movements.filter((m) => m.restaurant_id === rid && (!itemId || m.inventory_item_id === itemId));
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
      const { cursorTs, cursorId } = cursorFrom(values);
      if (cursorTs) {
        rows = rows.filter((row) => row.created_at < cursorTs || (row.created_at === cursorTs && row.id < cursorId));
      }
      return { rows: rows.map(withItemDetails) };
    }
    if (sql.startsWith("SELECT id, inventory_item_id, movement_type") && sql.includes("idempotency_key = $2")) {
      const [rid, key] = values;
      const movement = state.movements.find((m) => m.restaurant_id === rid && m.idempotency_key === key);
      return { rows: movement ? [movement] : [] };
    }

    // ── Purchase sequences ────────────────────────────
    if (sql.startsWith("INSERT INTO purchase_sequences")) {
      const [rid] = values;
      const current = state.purchaseSequences.get(rid) ?? 1;
      state.purchaseSequences.set(rid, current + 1);
      return { rows: [{ number: current }] };
    }

    // ── Purchases ─────────────────────────────────────
    if (sql.startsWith("SELECT p.*, s.name AS supplier_name, p.created_at::text AS created_at_text FROM purchases p")) {
      const [rid, status] = values;
      let rows = [...state.purchases.values()].filter((p) => p.restaurant_id === rid && (status === null || p.status === status));
      rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
      const { cursorTs, cursorId } = cursorFrom(values);
      if (cursorTs) {
        rows = rows.filter((row) => row.created_at < cursorTs || (row.created_at === cursorTs && row.id < cursorId));
      }
      return { rows: rows.map(withSupplierName) };
    }
    if (sql.startsWith("SELECT p.*, s.name AS supplier_name FROM purchases p")) {
      const [rid, id] = values;
      const purchase = state.purchases.get(id);
      if (!purchase || purchase.restaurant_id !== rid) return { rows: [] };
      return { rows: [withSupplierName(purchase)] };
    }
    if (sql.startsWith("SELECT * FROM purchase_items")) {
      const [rid, purchaseId] = values;
      const rows = state.purchaseItems.filter((pi) => pi.restaurant_id === rid && pi.purchase_id === purchaseId);
      return { rows };
    }
    if (sql.startsWith("SELECT pi.*, i.name AS item_name")) {
      const [rid, purchaseId] = values;
      const rows = state.purchaseItems
        .filter((pi) => pi.restaurant_id === rid && pi.purchase_id === purchaseId)
        .map((pi) => {
          const item = state.inventoryItems.get(pi.inventory_item_id);
          return { ...pi, item_name: item?.name ?? null, item_sku: item?.sku ?? null, base_unit: item?.base_unit ?? null };
        });
      return { rows };
    }
    if (sql.startsWith("SELECT * FROM purchases") && sql.includes("FOR UPDATE")) {
      const [rid, id] = values;
      const purchase = state.purchases.get(id);
      if (!purchase || purchase.restaurant_id !== rid) return { rows: [] };
      return { rows: [purchase] };
    }
    if (sql.startsWith("SELECT id FROM purchases") && sql.includes("idempotency_key = $2")) {
      const [rid, key] = values;
      const purchase = [...state.purchases.values()].find((p) => p.restaurant_id === rid && p.idempotency_key === key);
      return { rows: purchase ? [{ id: purchase.id }] : [] };
    }
    if (sql.startsWith("SELECT id FROM suppliers") && sql.includes("WHERE restaurant_id = $1 AND id = $2")) {
      const [rid, id] = values;
      const supplier = state.suppliers.get(id);
      return { rows: supplier && supplier.restaurant_id === rid ? [{ id: supplier.id }] : [] };
    }
    if (sql.startsWith("INSERT INTO purchases")) {
      const [id, rid, supplierId, purchaseNumber, supplierInvoiceNumber, purchaseDate, subtotalMinor, discountMinor, taxMinor, totalMinor, notes, idempotencyKey, createdByUserId, createdAt] = values;
      const row = {
        id, restaurant_id: rid, supplier_id: supplierId, purchase_number: purchaseNumber,
        supplier_invoice_number: supplierInvoiceNumber, status: "draft", purchase_date: purchaseDate,
        subtotal_minor: subtotalMinor, discount_minor: discountMinor, tax_minor: taxMinor,
        total_minor: totalMinor, notes, idempotency_key: idempotencyKey,
        created_by_user_id: createdByUserId, created_at: asTs(createdAt), updated_at: asTs(createdAt),
        received_at: null, receive_idempotency_key: null,
      };
      state.purchases.set(id, row);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO purchase_items")) {
      const [rid, purchaseId, inventoryItemId, quantity, unitCostMinor, lineTotalMinor] = values;
      state.purchaseItems.push({
        id: randomUUID(), restaurant_id: rid, purchase_id: purchaseId,
        inventory_item_id: inventoryItemId, quantity, unit_cost_minor: unitCostMinor,
        line_total_minor: lineTotalMinor, created_at: NOW_TEXT,
      });
      return { rows: [] };
    }
    if (sql.startsWith("DELETE FROM purchase_items")) {
      const [rid, purchaseId] = values;
      state.purchaseItems = state.purchaseItems.filter((pi) => !(pi.restaurant_id === rid && pi.purchase_id === purchaseId));
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE purchases") && sql.includes("status = 'received'")) {
      const [rid, id, receivedAt, receiveIdempotencyKey] = values;
      const purchase = state.purchases.get(id);
      if (purchase && purchase.restaurant_id === rid) {
        purchase.status = "received";
        purchase.received_at = asTs(receivedAt);
        purchase.receive_idempotency_key = receiveIdempotencyKey;
        purchase.updated_at = NOW_TEXT;
      }
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE purchases")) {
      const [rid, id, supplierId, invoiceNumber, purchaseDate, subtotalMinor, discountMinor, taxMinor, totalMinor, notes] = values;
      const purchase = state.purchases.get(id);
      if (purchase && purchase.restaurant_id === rid) {
        Object.assign(purchase, {
          supplier_id: supplierId, supplier_invoice_number: invoiceNumber, purchase_date: purchaseDate,
          subtotal_minor: subtotalMinor, discount_minor: discountMinor, tax_minor: taxMinor,
          total_minor: totalMinor, notes, updated_at: NOW_TEXT,
        });
      }
      return { rows: [] };
    }

    // ── Recipes ───────────────────────────────────────
    if ((sql.startsWith("SELECT id, name FROM menu_items") || sql.startsWith("SELECT id FROM menu_items")) && sql.includes("WHERE restaurant_id = $1 AND id = $2")) {
      const [rid, id] = values;
      const item = state.menuItems.get(id);
      return { rows: item && item.restaurant_id === rid ? [item] : [] };
    }
    if (sql.startsWith("SELECT r.inventory_item_id, r.quantity_required")) {
      const [rid, productId] = values;
      const rows = state.recipes
        .filter((r) => r.restaurant_id === rid && r.product_id === productId)
        .map((r) => {
          const item = state.inventoryItems.get(r.inventory_item_id);
          return {
            inventory_item_id: r.inventory_item_id, quantity_required: r.quantity_required,
            name: item?.name ?? null, sku: item?.sku ?? null, base_unit: item?.base_unit ?? null,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name) || (a.inventory_item_id < b.inventory_item_id ? -1 : 1));
      return { rows };
    }
    if (sql.startsWith("SELECT product_id, inventory_item_id, quantity_required FROM product_recipes")) {
      const [rid, productIds] = values;
      const rows = state.recipes.filter((r) => r.restaurant_id === rid && productIds.includes(r.product_id));
      return { rows };
    }
    if (sql.startsWith("DELETE FROM product_recipes")) {
      const [rid, productId] = values;
      state.recipes = state.recipes.filter((r) => !(r.restaurant_id === rid && r.product_id === productId));
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO product_recipes")) {
      const [rid, productId, inventoryItemId, quantityRequired] = values;
      state.recipes.push({ restaurant_id: rid, product_id: productId, inventory_item_id: inventoryItemId, quantity_required: quantityRequired });
      return { rows: [] };
    }

    // ── Order consumption ─────────────────────────────
    if (sql.startsWith("INSERT INTO inventory_consumptions")) {
      const [rid, orderId, itemCount] = values;
      const existing = state.consumptions.find((c) => c.restaurant_id === rid && c.order_id === orderId);
      if (existing) return { rows: [] };
      const row = { id: randomUUID(), restaurant_id: rid, order_id: orderId, item_count: itemCount, created_at: NOW_TEXT };
      state.consumptions.push(row);
      return { rows: [row] };
    }

    throw new Error(`Unhandled query in fake database: ${sql}`);
  }

  function withSupplierName(purchase) {
    return { ...purchase, supplier_name: state.suppliers.get(purchase.supplier_id)?.name ?? null, created_at_text: purchase.created_at };
  }

  function withItemDetails(movement) {
    const item = state.inventoryItems.get(movement.inventory_item_id);
    return { ...movement, created_at_text: movement.created_at, item_name: item?.name ?? null, item_sku: item?.sku ?? null, base_unit: item?.base_unit ?? null };
  }

  // The keyset cursor is always the two values before the
  // trailing LIMIT parameter.
  function cursorFrom(values) {
    if (values.length < 3) return { cursorTs: null, cursorId: null };
    const cursorId = values[values.length - 2];
    const cursorTs = values[values.length - 3];
    if (typeof cursorTs !== "string" || !/^\d{4}-\d{2}-\d{2} /.test(cursorTs)) {
      return { cursorTs: null, cursorId: null };
    }
    return { cursorTs, cursorId };
  }

  function pool() {
    return {
      async connect() {
        return { query: (text, values) => query(text, values), release() {} };
      },
    };
  }

  return {
    state,
    pool,
    failOn,
    seedSupplier({ id = randomUUID(), name, ...rest }) {
      const row = {
        id, restaurant_id: restaurantId, name, contact_person: null, phone: null,
        email: null, address: null, notes: null, is_active: true,
        created_at: NOW_TEXT, updated_at: NOW_TEXT, ...rest,
      };
      state.suppliers.set(id, row);
      return row;
    },
    seedItem({ id = randomUUID(), name, baseUnit = "piece", currentQuantity = 0, reorderLevel = 0, averageCostMinor = 0, ...rest }) {
      const row = {
        id, restaurant_id: restaurantId, name, sku: null, base_unit: baseUnit,
        current_quantity: currentQuantity, reorder_level: reorderLevel,
        average_cost_minor: averageCostMinor, is_active: true, idempotency_key: null,
        created_at: NOW_TEXT, updated_at: NOW_TEXT, ...rest,
      };
      state.inventoryItems.set(id, row);
      return row;
    },
    seedMenuItem({ id = randomUUID(), name, ...rest }) {
      const row = { id, restaurant_id: restaurantId, name, ...rest };
      state.menuItems.set(id, row);
      return row;
    },
  };
}

describe("inventory ledger helpers", () => {
  it("quantizes quantities to the column scale", () => {
    assert.equal(quantizeQuantity(1.23456), 1.2346);
    assert.equal(quantizeQuantity("2.5"), 2.5);
    assert.equal(quantizeQuantity(123456.78901), 123456.789);
    assert.equal(quantizeQuantity(0.00005), 0.0001);
    assert.throws(() => quantizeQuantity("abc"), /valid quantity/i);
  });

  it("round-trips pagination cursors and rejects tampered values", () => {
    const cursor = encodeInventoryCursor(NOW_TEXT, restaurantId);
    const decoded = decodeInventoryCursor(cursor);
    assert.equal(decoded.createdAtText, NOW_TEXT);
    assert.equal(decoded.id, restaurantId);
    assert.throws(() => decodeInventoryCursor("not-a-cursor"), /cursor/i);
    const tampered = Buffer.from(`${NOW_TEXT}.not-a-uuid`, "utf8").toString("base64url");
    assert.throws(() => decodeInventoryCursor(tampered), /cursor/i);
  });

  it("computes exact line totals with half-up rounding", () => {
    assert.equal(lineTotalMinor(2.5, 100), 250);
    assert.equal(lineTotalMinor(0.3333, 300), 100);
    assert.equal(lineTotalMinor(1, 1250), 1250);
  });

  it("computes the weighted average cost", () => {
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: 0, currentAverageCostMinor: 0, receivedQuantity: 10, unitCostMinor: 250 }),
      250,
    );
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: 10, currentAverageCostMinor: 100, receivedQuantity: 10, unitCostMinor: 300 }),
      200,
    );
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: 1, currentAverageCostMinor: 100, receivedQuantity: 1, unitCostMinor: 101 }),
      101,
    );
  });

  it("treats a zero or negative balance like empty stock when receiving", () => {
    // Zero existing quantity: the receipt cost becomes the average.
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: 0, currentAverageCostMinor: 0, receivedQuantity: 10, unitCostMinor: 250 }),
      250,
    );
    // A receipt that moves a negative balance toward zero
    // revalues the position at the receipt cost, which keeps
    // the average non-negative.
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: -5, currentAverageCostMinor: 100, receivedQuantity: 10, unitCostMinor: 300 }),
      300,
    );
    // A receipt that does not clear the negative balance.
    assert.equal(
      weightedAverageCostMinor({ currentQuantity: -10, currentAverageCostMinor: 100, receivedQuantity: 5, unitCostMinor: 300 }),
      300,
    );
  });

  it("costs large quantities exactly", () => {
    assert.equal(
      weightedAverageCostMinor({
        currentQuantity: 1_000_000,
        currentAverageCostMinor: 100,
        receivedQuantity: 1_000_000,
        unitCostMinor: 300,
      }),
      200,
    );
    assert.equal(
      weightedAverageCostMinor({
        currentQuantity: 999_999.9999,
        currentAverageCostMinor: 1,
        receivedQuantity: 0.0001,
        unitCostMinor: 1,
      }),
      1,
    );
  });
});

describe("supplier service", () => {
  it("lists a restaurant's suppliers", async () => {
    const db = createFakeDb();
    db.seedSupplier({ name: "Alpha Farms" });
    const result = await createSupplierService(db.pool()).list({ restaurantId });
    assert.equal(result.suppliers.length, 1);
    assert.equal(result.suppliers[0].name, "Alpha Farms");
    assert.equal(result.suppliers[0].isActive, true);
  });

  it("creates a supplier and maps every field", async () => {
    const db = createFakeDb();
    const result = await createSupplierService(db.pool()).create({
      restaurantId, userId,
      input: { name: "Alpha Farms", contactPerson: "Ayesha", phone: "0300-1234567", email: "a@alpha.example" },
    });
    assert.equal(result.supplier.name, "Alpha Farms");
    assert.equal(result.supplier.contactPerson, "Ayesha");
    assert.equal(result.supplier.phone, "0300-1234567");
    assert.equal(result.supplier.email, "a@alpha.example");
  });

  it("rejects a duplicate active supplier name", async () => {
    const db = createFakeDb();
    const service = createSupplierService(db.pool());
    await service.create({ restaurantId, userId, input: { name: "Alpha Farms" } });
    db.failOn(
      (sql) => sql.startsWith("INSERT INTO suppliers"),
      new Error('duplicate key value violates unique constraint "suppliers_restaurant_active_name_idx"'),
    );
    await assert.rejects(
      () => service.create({ restaurantId, userId, input: { name: "Alpha Farms" } }),
      (error) => error.statusCode === 409 && error.code === "DUPLICATE_SUPPLIER_NAME",
    );
  });

  it("updates a supplier and rejects empty change sets", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const service = createSupplierService(db.pool());
    const updated = await service.update({
      restaurantId, userId, supplierId: supplier.id,
      changes: { phone: "0300-7654321" },
    });
    assert.equal(updated.supplier.phone, "0300-7654321");
    await assert.rejects(
      () => service.update({ restaurantId, userId, supplierId: supplier.id, changes: {} }),
      (error) => error.statusCode === 400 && error.code === "NO_CHANGES",
    );
    await assert.rejects(
      () => service.update({ restaurantId, userId, supplierId: randomUUID(), changes: { phone: "1" } }),
      (error) => error.statusCode === 404 && error.code === "SUPPLIER_NOT_FOUND",
    );
  });

  it("deactivates a supplier without deleting it", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const result = await createSupplierService(db.pool()).deactivate({ restaurantId, userId, supplierId: supplier.id });
    assert.equal(result.supplier.isActive, false);
    assert.ok(db.state.suppliers.has(supplier.id));
  });
});

describe("inventory service", () => {
  it("creates an item and records the opening balance as a movement", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const result = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), name: "Tomatoes", sku: "TOM-1",
        baseUnit: "kilogram", openingQuantity: 25, reorderLevel: 10, averageCostMinor: 120,
      },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.item.currentQuantity, 25);
    assert.equal(result.item.reorderLevel, 10);
    assert.equal(result.item.isLowStock, false);

    const movements = db.state.movements.filter((m) => m.movement_type === "adjustment_increase");
    assert.equal(movements.length, 1);
    assert.equal(Number(movements[0].quantity_delta), 25);
    assert.equal(Number(movements[0].quantity_after), 25);
    assert.equal(movements[0].notes, "Opening balance");
    assert.equal(movements[0].actor_user_id, userId);
  });

  it("is idempotent per creation key", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const key = randomUUID();
    const first = await service.create({ restaurantId, userId, input: { idempotencyKey: key, name: "Tomatoes", baseUnit: "piece" } });
    const second = await service.create({ restaurantId, userId, input: { idempotencyKey: key, name: "Tomatoes", baseUnit: "piece" } });
    assert.equal(second.replayed, true);
    assert.equal(second.item.id, first.item.id);
    assert.equal(db.state.inventoryItems.size, 1);
  });

  it("rejects an unsupported base unit", async () => {
    const db = createFakeDb();
    await assert.rejects(
      () => createInventoryService(db.pool()).create({
        restaurantId, userId,
        input: { idempotencyKey: randomUUID(), name: "Tomatoes", baseUnit: "crate" },
      }),
      (error) => error.statusCode === 400 && error.code === "INVALID_BASE_UNIT",
    );
  });

  it("adjusts stock and records the movement, idempotently", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 10 });
    const key = randomUUID();
    const result = await service.adjust({
      restaurantId, userId,
      input: { idempotencyKey: key, itemId: item.id, direction: "increase", quantity: 5, reason: "Stock count correction" },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.quantityAfter, 15);
    assert.equal(result.movement.movementType, "adjustment_increase");
    assert.equal(Number(result.movement.quantityDelta), 5);
    assert.equal(Number(db.state.inventoryItems.get(item.id).current_quantity), 15);

    const replay = await service.adjust({
      restaurantId, userId,
      input: { idempotencyKey: key, itemId: item.id, direction: "increase", quantity: 5, reason: "Stock count correction" },
    });
    assert.equal(replay.replayed, true);
    assert.equal(db.state.movements.filter((m) => m.idempotency_key === key).length, 1);
  });

  it("records waste as its own movement type", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const item = db.seedItem({ name: "Milk", baseUnit: "litre", currentQuantity: 12 });
    const result = await service.waste({
      restaurantId, userId,
      input: { idempotencyKey: randomUUID(), itemId: item.id, quantity: 2, reason: "Expired" },
    });
    assert.equal(result.movement.movementType, "waste");
    assert.equal(result.quantityAfter, 10);
    assert.equal(Number(db.state.inventoryItems.get(item.id).current_quantity), 10);
  });

  it("rejects an adjustment key reused for a different item", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const a = db.seedItem({ name: "A", baseUnit: "piece" });
    const b = db.seedItem({ name: "B", baseUnit: "piece" });
    const key = randomUUID();
    await service.adjust({ restaurantId, userId, input: { idempotencyKey: key, itemId: a.id, direction: "increase", quantity: 1, reason: "First" } });
    await assert.rejects(
      () => service.adjust({ restaurantId, userId, input: { idempotencyKey: key, itemId: b.id, direction: "increase", quantity: 1, reason: "Second" } }),
      (error) => error.statusCode === 409 && error.code === "IDEMPOTENCY_KEY_CONFLICT",
    );
  });

  it("surfaces low-stock and negative-stock warnings", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 2, reorderLevel: 5 });
    db.seedItem({ name: "Milk", baseUnit: "litre", currentQuantity: -1, reorderLevel: 0 });
    db.seedItem({ name: "Flour", baseUnit: "kilogram", currentQuantity: 50, reorderLevel: 5 });

    const low = await service.lowStock({ restaurantId });
    assert.equal(low.items.length, 2);
    assert.equal(low.items[0].name, "Milk");
    assert.equal(low.items[0].isNegativeStock, true);
    assert.equal(low.items[1].isLowStock, true);

    const item = await service.get({ restaurantId, itemId: db.state.inventoryItems.values().next().value.id });
    assert.ok(item.item);
  });

  it("paginates the movement ledger with a lossless cursor", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const stamps = ["2026-10-06 07:00:00+00", "2026-10-06 07:01:00+00", "2026-10-06 07:02:00+00"];
    for (const [index, createdAt] of stamps.entries()) {
      db.state.movements.push({
        id: randomUUID(), restaurant_id: restaurantId, inventory_item_id: item.id,
        movement_type: "adjustment_increase", quantity_delta: 1, quantity_after: index + 1,
        unit_cost_minor: null, total_cost_minor: null, reference_type: "manual",
        reference_id: null, idempotency_key: randomUUID(), notes: `seed ${index}`,
        actor_user_id: userId, created_at: createdAt,
      });
    }

    const first = await service.movements({ restaurantId, itemId: item.id, limit: 2 });
    assert.equal(first.movements.length, 2);
    assert.equal(first.movements[0].notes, "seed 2");
    assert.ok(first.nextCursor);

    const second = await service.movements({ restaurantId, itemId: item.id, limit: 2, cursor: first.nextCursor });
    assert.equal(second.movements.length, 1);
    assert.equal(second.movements[0].notes, "seed 0");
    assert.equal(second.nextCursor, null);
  });

  it("rejects an invalid page size", async () => {
    const db = createFakeDb();
    await assert.rejects(
      () => createInventoryService(db.pool()).list({ restaurantId, limit: 0 }),
      (error) => error.statusCode === 400 && error.code === "INVALID_PAGE_SIZE",
    );
  });

  it("is idempotent even when the replay carries a different payload", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const key = randomUUID();
    const first = await service.create({
      restaurantId, userId,
      input: { idempotencyKey: key, name: "Original Name", baseUnit: "piece" },
    });
    // A retry may carry a different body; the stored outcome
    // is always returned, never a second item.
    const second = await service.create({
      restaurantId, userId,
      input: { idempotencyKey: key, name: "Different Name", baseUnit: "kilogram" },
    });
    assert.equal(second.replayed, true);
    assert.equal(second.item.name, "Original Name");
    assert.equal(second.item.baseUnit, "piece");
    assert.equal(db.state.inventoryItems.size, 1);
  });

  it("values stock as quantity times the weighted average cost", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const item = db.seedItem({
      name: "Valued Stock",
      baseUnit: "kilogram",
      currentQuantity: 10.5,
      averageCostMinor: 120,
    });
    const result = await service.get({ restaurantId, itemId: item.id });
    assert.equal(result.item.stockValueMinor, 1260);
    assert.equal(result.item.isLowStock, false);
    assert.equal(result.item.isNegativeStock, false);
  });

  it("warns at exactly the reorder threshold and below it", async () => {
    const db = createFakeDb();
    const service = createInventoryService(db.pool(), { clock: () => NOW });
    const atThreshold = db.seedItem({
      name: "At Threshold",
      baseUnit: "piece",
      currentQuantity: 5,
      reorderLevel: 5,
    });
    const aboveThreshold = db.seedItem({
      name: "Above Threshold",
      baseUnit: "piece",
      currentQuantity: 5.0001,
      reorderLevel: 5,
    });
    const belowThreshold = db.seedItem({
      name: "Below Threshold",
      baseUnit: "piece",
      currentQuantity: 4.9999,
      reorderLevel: 5,
    });

    const at = await service.get({ restaurantId, itemId: atThreshold.id });
    assert.equal(at.item.isLowStock, true);
    const above = await service.get({ restaurantId, itemId: aboveThreshold.id });
    assert.equal(above.item.isLowStock, false);
    const below = await service.get({ restaurantId, itemId: belowThreshold.id });
    assert.equal(below.item.isLowStock, true);

    // The low-stock report surfaces both warning states.
    const low = await service.lowStock({ restaurantId });
    const names = low.items.map((item) => item.name);
    assert.ok(names.includes("At Threshold"));
    assert.ok(names.includes("Below Threshold"));
    assert.ok(!names.includes("Above Threshold"));
  });
});

describe("purchase service", () => {
  it("creates a draft with server-computed totals", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const cheese = db.seedItem({ name: "Cheese", baseUnit: "gram" });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const result = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(),
        supplierId: supplier.id,
        purchaseDate: "2026-10-06",
        supplierInvoiceNumber: "INV-42",
        discountMinor: 20,
        taxMinor: 10,
        items: [
          { inventoryItemId: tomatoes.id, quantity: 2.5, unitCostMinor: 100 },
          { inventoryItemId: cheese.id, quantity: 1, unitCostMinor: 50 },
        ],
      },
    });
    assert.equal(result.replayed, false);
    assert.equal(result.purchase.status, "draft");
    assert.equal(result.purchase.purchaseNumber, "PO-000001");
    assert.equal(result.purchase.supplierName, "Alpha Farms");
    assert.equal(result.purchase.subtotalMinor, 300);
    assert.equal(result.purchase.discountMinor, 20);
    assert.equal(result.purchase.taxMinor, 10);
    assert.equal(result.purchase.totalMinor, 290);
  });

  it("rejects an unknown supplier or inventory item", async () => {
    const db = createFakeDb();
    const service = createPurchaseService(db.pool());
    await assert.rejects(
      () => service.create({
        restaurantId, userId,
        input: {
          idempotencyKey: randomUUID(), supplierId: randomUUID(), purchaseDate: "2026-10-06",
          items: [{ inventoryItemId: randomUUID(), quantity: 1, unitCostMinor: 100 }],
        },
      }),
      (error) => error.statusCode === 404 && error.code === "SUPPLIER_NOT_FOUND",
    );
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    await assert.rejects(
      () => service.create({
        restaurantId, userId,
        input: {
          idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
          items: [{ inventoryItemId: randomUUID(), quantity: 1, unitCostMinor: 100 }],
        },
      }),
      (error) => error.statusCode === 404 && error.code === "PURCHASE_ITEM_NOT_FOUND",
    );
  });

  it("rejects a discount larger than the subtotal", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    await assert.rejects(
      () => createPurchaseService(db.pool()).create({
        restaurantId, userId,
        input: {
          idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
          discountMinor: 500, taxMinor: 600,
          items: [{ inventoryItemId: item.id, quantity: 1, unitCostMinor: 100 }],
        },
      }),
      (error) => error.statusCode === 400 && error.code === "DISCOUNT_EXCEEDS_SUBTOTAL",
    );
  });

  it("is idempotent per creation key", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const key = randomUUID();
    const input = {
      idempotencyKey: key, supplierId: supplier.id, purchaseDate: "2026-10-06",
      items: [{ inventoryItemId: item.id, quantity: 1, unitCostMinor: 100 }],
    };
    const first = await service.create({ restaurantId, userId, input });
    const second = await service.create({ restaurantId, userId, input });
    assert.equal(second.replayed, true);
    assert.equal(second.purchase.id, first.purchase.id);
    assert.equal(db.state.purchases.size, 1);
  });

  it("edits a draft and recomputes every total", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const cheese = db.seedItem({ name: "Cheese", baseUnit: "gram" });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const created = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: tomatoes.id, quantity: 1, unitCostMinor: 100 }],
      },
    });

    const updated = await service.update({
      restaurantId, userId, purchaseId: created.purchase.id,
      changes: {
        discountMinor: 10,
        items: [
          { inventoryItemId: tomatoes.id, quantity: 2, unitCostMinor: 100 },
          { inventoryItemId: cheese.id, quantity: 1, unitCostMinor: 50 },
        ],
      },
    });
    assert.equal(updated.purchase.subtotalMinor, 250);
    assert.equal(updated.purchase.discountMinor, 10);
    assert.equal(updated.purchase.totalMinor, 240);
    assert.equal(updated.items.length, 2);
  });

  it("refuses to edit a purchase that is not a draft", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const created = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 1, unitCostMinor: 100 }],
      },
    });
    await service.receive({ restaurantId, userId, purchaseId: created.purchase.id, idempotencyKey: randomUUID() });
    await assert.rejects(
      () => service.update({
        restaurantId, userId, purchaseId: created.purchase.id,
        changes: { notes: "Too late" },
      }),
      (error) => error.statusCode === 409 && error.code === "PURCHASE_NOT_DRAFT",
    );
  });

  it("receives a draft, adding stock and receipt movements with the weighted average cost", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 10, averageCostMinor: 100 });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const created = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 10, unitCostMinor: 300 }],
      },
    });

    const result = await service.receive({ restaurantId, userId, purchaseId: created.purchase.id, idempotencyKey: randomUUID() });
    assert.equal(result.replayed, false);
    assert.equal(result.purchase.status, "received");
    assert.equal(result.purchase.receivedAt, NOW_TEXT);

    // 10 kg @ 100 + 10 kg @ 300 → 20 kg at an average of 200.
    const stored = db.state.inventoryItems.get(item.id);
    assert.equal(Number(stored.current_quantity), 20);
    assert.equal(Number(stored.average_cost_minor), 200);

    assert.equal(result.receipts.length, 1);
    assert.equal(result.receipts[0].quantity, 10);
    assert.equal(result.receipts[0].averageCostMinor, 200);

    const movements = db.state.movements.filter((m) => m.movement_type === "purchase_receipt");
    assert.equal(movements.length, 1);
    assert.equal(movements[0].reference_type, "purchase");
    assert.equal(movements[0].reference_id, created.purchase.id);
    assert.equal(Number(movements[0].quantity_delta), 10);
    assert.equal(Number(movements[0].quantity_after), 20);
    assert.equal(Number(movements[0].total_cost_minor), 3000);
  });

  it("is idempotent when receiving and conflicts on a second key", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 0 });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    const created = await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 5, unitCostMinor: 100 }],
      },
    });
    const key = randomUUID();
    const first = await service.receive({ restaurantId, userId, purchaseId: created.purchase.id, idempotencyKey: key });
    assert.equal(first.replayed, false);

    const replay = await service.receive({ restaurantId, userId, purchaseId: created.purchase.id, idempotencyKey: key });
    assert.equal(replay.replayed, true);
    assert.equal(Number(db.state.inventoryItems.get(item.id).current_quantity), 5);
    assert.equal(db.state.movements.filter((m) => m.movement_type === "purchase_receipt").length, 1);

    await assert.rejects(
      () => service.receive({ restaurantId, userId, purchaseId: created.purchase.id, idempotencyKey: randomUUID() }),
      (error) => error.statusCode === 409 && error.code === "PURCHASE_ALREADY_RECEIVED",
    );
  });

  it("lists purchases with an optional status filter", async () => {
    const db = createFakeDb();
    const supplier = db.seedSupplier({ name: "Alpha Farms" });
    const item = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const service = createPurchaseService(db.pool(), { clock: () => NOW });
    await service.create({
      restaurantId, userId,
      input: {
        idempotencyKey: randomUUID(), supplierId: supplier.id, purchaseDate: "2026-10-06",
        items: [{ inventoryItemId: item.id, quantity: 1, unitCostMinor: 100 }],
      },
    });
    const all = await service.list({ restaurantId });
    assert.equal(all.purchases.length, 1);
    const drafts = await service.list({ restaurantId, status: "draft" });
    assert.equal(drafts.purchases.length, 1);
    const received = await service.list({ restaurantId, status: "received" });
    assert.equal(received.purchases.length, 0);
  });
});

describe("recipe service", () => {
  it("replaces a product recipe transactionally", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const cheese = db.seedItem({ name: "Cheese", baseUnit: "gram" });
    const service = createRecipeService(db.pool(), { clock: () => NOW });

    const result = await service.replace({
      restaurantId, userId, productId: product.id,
      items: [
        { inventoryItemId: tomatoes.id, quantityRequired: 0.2 },
        { inventoryItemId: cheese.id, quantityRequired: 120 },
      ],
    });
    assert.equal(result.productId, product.id);
    assert.equal(result.items.length, 2);
    // Ingredients are read back ordered by name.
    assert.equal(result.items[0].name, "Cheese");
    assert.equal(result.items[0].quantityRequired, 120);
    assert.equal(result.items[1].quantityRequired, 0.2);

    const next = await service.replace({
      restaurantId, userId, productId: product.id,
      items: [{ inventoryItemId: tomatoes.id, quantityRequired: 0.25 }],
    });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].quantityRequired, 0.25);
    assert.equal(db.state.recipes.length, 1);
  });

  it("accepts an empty recipe, removing every ingredient", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const service = createRecipeService(db.pool(), { clock: () => NOW });
    await service.replace({
      restaurantId, userId, productId: product.id,
      items: [{ inventoryItemId: tomatoes.id, quantityRequired: 0.2 }],
    });
    const result = await service.replace({ restaurantId, userId, productId: product.id, items: [] });
    assert.deepEqual(result.items, []);
    assert.equal(db.state.recipes.length, 0);
  });

  it("rejects duplicate ingredients and unknown products or ingredients", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram" });
    const service = createRecipeService(db.pool());
    await assert.rejects(
      () => service.replace({
        restaurantId, userId, productId: product.id,
        items: [
          { inventoryItemId: tomatoes.id, quantityRequired: 0.2 },
          { inventoryItemId: tomatoes.id, quantityRequired: 0.3 },
        ],
      }),
      (error) => error.statusCode === 400 && error.code === "DUPLICATE_RECIPE_ITEM",
    );
    await assert.rejects(
      () => service.replace({ restaurantId, userId, productId: randomUUID(), items: [] }),
      (error) => error.statusCode === 404 && error.code === "PRODUCT_NOT_FOUND",
    );
    await assert.rejects(
      () => service.replace({
        restaurantId, userId, productId: product.id,
        items: [{ inventoryItemId: randomUUID(), quantityRequired: 0.2 }],
      }),
      (error) => error.statusCode === 404 && error.code === "RECIPE_ITEM_NOT_FOUND",
    );
  });

  it("reads an empty recipe for a product without one", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const result = await createRecipeService(db.pool()).get({ restaurantId, productId: product.id });
    assert.deepEqual(result.items, []);
    assert.equal(result.productName, "Margherita");
  });
});

describe("inventory consumption", () => {
  it("deducts ingredient stock exactly once per order", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 10 });
    const cheese = db.seedItem({ name: "Cheese", baseUnit: "gram", currentQuantity: 1000 });
    db.state.recipes.push(
      { restaurant_id: restaurantId, product_id: product.id, inventory_item_id: tomatoes.id, quantity_required: 0.25 },
      { restaurant_id: restaurantId, product_id: product.id, inventory_item_id: cheese.id, quantity_required: 120 },
    );
    const service = createInventoryConsumptionService(db.pool(), { clock: () => NOW });
    const orderId = randomUUID();

    const result = await service.consumeOrder({
      tenant: { restaurant: { id: restaurantId } },
      orderId,
      lines: [{ menuItemId: product.id, quantity: 2 }],
      userId,
    });
    assert.equal(result.replayed, false);
    assert.equal(result.consumedItemCount, 2);
    assert.equal(Number(db.state.inventoryItems.get(tomatoes.id).current_quantity), 9.5);
    assert.equal(Number(db.state.inventoryItems.get(cheese.id).current_quantity), 760);

    const movements = db.state.movements.filter((m) => m.movement_type === "sale_consumption");
    assert.equal(movements.length, 2);
    assert.equal(movements[0].reference_type, "order");
    assert.equal(movements[0].reference_id, orderId);
    assert.ok(db.state.consumptions.some((c) => c.order_id === orderId));

    const replay = await service.consumeOrder({
      tenant: { restaurant: { id: restaurantId } },
      orderId,
      lines: [{ menuItemId: product.id, quantity: 2 }],
      userId,
    });
    assert.equal(replay.replayed, true);
    assert.equal(Number(db.state.inventoryItems.get(tomatoes.id).current_quantity), 9.5);
    assert.equal(db.state.movements.filter((m) => m.movement_type === "sale_consumption").length, 2);
  });

  it("warns instead of failing for missing recipes and negative stock", async () => {
    const db = createFakeDb();
    const withRecipe = db.seedMenuItem({ name: "With Recipe" });
    const withoutRecipe = db.seedMenuItem({ name: "No Recipe" });
    const tomatoes = db.seedItem({ name: "Tomatoes", baseUnit: "kilogram", currentQuantity: 0.25 });
    db.state.recipes.push(
      { restaurant_id: restaurantId, product_id: withRecipe.id, inventory_item_id: tomatoes.id, quantity_required: 0.5 },
    );
    const service = createInventoryConsumptionService(db.pool(), { clock: () => NOW });

    const result = await service.consumeOrder({
      tenant: { restaurant: { id: restaurantId } },
      orderId: randomUUID(),
      lines: [
        { menuItemId: withRecipe.id, quantity: 1 },
        { menuItemId: withoutRecipe.id, quantity: 1 },
      ],
      userId,
    });
    assert.equal(result.replayed, false);
    assert.ok(result.warnings.some((warning) => warning.type === "missing_recipe"));
    assert.ok(result.warnings.some((warning) => warning.type === "negative_stock"));
    assert.equal(Number(db.state.inventoryItems.get(tomatoes.id).current_quantity), -0.25);
  });

  it("warns when a recipe references a deleted inventory item", async () => {
    const db = createFakeDb();
    const product = db.seedMenuItem({ name: "Margherita" });
    const ghost = randomUUID();
    db.state.recipes.push(
      { restaurant_id: restaurantId, product_id: product.id, inventory_item_id: ghost, quantity_required: 0.25 },
    );
    const service = createInventoryConsumptionService(db.pool(), { clock: () => NOW });
    const result = await service.consumeOrder({
      tenant: { restaurant: { id: restaurantId } },
      orderId: randomUUID(),
      lines: [{ menuItemId: product.id, quantity: 1 }],
      userId,
    });
    assert.equal(result.replayed, false);
    assert.ok(result.warnings.some((warning) => warning.type === "missing_item"));
    assert.equal(result.consumedItemCount, 0);
  });
});

describe("role permissions for inventory and purchasing", () => {
  it("grants managers the full inventory and purchasing set", () => {
    for (const permission of [
      PERMISSION.INVENTORY_VIEW,
      PERMISSION.INVENTORY_MANAGE,
      PERMISSION.INVENTORY_ADJUST,
      PERMISSION.PURCHASES_VIEW,
      PERMISSION.PURCHASES_MANAGE,
      PERMISSION.RECIPES_MANAGE,
    ]) {
      assert.equal(hasPermission("manager", permission), true, `manager lacks ${permission}`);
    }
    // Billing stays owner-only.
    assert.equal(hasPermission("manager", PERMISSION.BILLING_MANAGE), false);
  });

  it("grants cashiers read-only inventory access", () => {
    assert.equal(hasPermission("cashier", PERMISSION.INVENTORY_VIEW), true);
    assert.equal(hasPermission("cashier", PERMISSION.INVENTORY_MANAGE), false);
    assert.equal(hasPermission("cashier", PERMISSION.INVENTORY_ADJUST), false);
    assert.equal(hasPermission("cashier", PERMISSION.PURCHASES_VIEW), false);
  });

  it("grants accountants read-only inventory and purchasing access", () => {
    assert.equal(hasPermission("accountant", PERMISSION.INVENTORY_VIEW), true);
    assert.equal(hasPermission("accountant", PERMISSION.PURCHASES_VIEW), true);
    assert.equal(hasPermission("accountant", PERMISSION.INVENTORY_MANAGE), false);
    assert.equal(hasPermission("accountant", PERMISSION.INVENTORY_ADJUST), false);
    assert.equal(hasPermission("accountant", PERMISSION.PURCHASES_MANAGE), false);
    assert.equal(hasPermission("accountant", PERMISSION.RECIPES_MANAGE), false);
  });

  it("keeps owners unrestricted", () => {
    for (const permission of Object.values(PERMISSION)) {
      assert.equal(hasPermission("owner", permission), true, `owner lacks ${permission}`);
    }
  });
});

describe("inventory and purchasing HTTP endpoints", () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function tenant(role, subscriptionStatus = "active") {
    return {
      restaurant: { id: restaurantId, name: "Example Cafe", status: "active" },
      membership: { userId, role, status: "active", defaultBranchId: "branch-1" },
      subscription: { status: subscriptionStatus, currentPeriodEnd: "2999-01-01T00:00:00Z" },
    };
  }

  async function makeApp({ role = "owner", subscriptionStatus = "active" } = {}) {
    const calls = [];
    const app = await buildHttpApp({
      trustedOrigin: "https://pos.example.com",
      secureCookies: true,
      authService: {
        async authenticate(token) {
          return token ? { user: { id: userId, email: "owner@example.com" } } : null;
        },
        async register() {}, async verifyEmail() {}, async login() {}, async logout() {},
      },
      tenantContextService: {
        async load() { return tenant(role, subscriptionStatus); },
      },
      supplierService: {
        async list(input) { calls.push(["suppliers:list", input]); return { suppliers: [] }; },
        async create(input) { calls.push(["suppliers:create", input]); return { supplier: { id: "supplier-1" } }; },
        async update(input) { calls.push(["suppliers:update", input]); return { supplier: { id: input.supplierId } }; },
      },
      inventoryService: {
        async list(input) { calls.push(["inventory:list", input]); return { items: [], nextCursor: null }; },
        async create(input) { calls.push(["inventory:create", input]); return { item: { id: "item-1" }, replayed: false }; },
        async get(input) { calls.push(["inventory:get", input]); return { item: { id: input.itemId } }; },
        async update(input) { calls.push(["inventory:update", input]); return { item: { id: input.itemId } }; },
        async lowStock(input) { calls.push(["inventory:low-stock", input]); return { items: [], hasMore: false }; },
        async movements(input) { calls.push(["inventory:movements", input]); return { movements: [], nextCursor: null }; },
        async adjust(input) { calls.push(["inventory:adjust", input]); return { movement: { id: "movement-1" }, quantityAfter: 5, replayed: false }; },
        async waste(input) { calls.push(["inventory:waste", input]); return { movement: { id: "movement-1" }, quantityAfter: 5, replayed: false }; },
      },
      recipeService: {
        async get(input) { calls.push(["recipe:get", input]); return { productId: input.productId, items: [] }; },
        async replace(input) { calls.push(["recipe:replace", input]); return { productId: input.productId, items: input.items }; },
      },
      purchaseService: {
        async list(input) { calls.push(["purchases:list", input]); return { purchases: [], nextCursor: null }; },
        async create(input) { calls.push(["purchases:create", input]); return { purchase: { id: "purchase-1" }, replayed: false }; },
        async get(input) { calls.push(["purchases:get", input]); return { purchase: { id: input.purchaseId }, items: [] }; },
        async update(input) { calls.push(["purchases:update", input]); return { purchase: { id: input.purchaseId }, items: [] }; },
        async receive(input) { calls.push(["purchases:receive", input]); return { purchase: { id: input.purchaseId, status: "received" }, receipts: [], replayed: false }; },
      },
    });
    apps.push(app);
    return { app, calls };
  }

  const authenticatedHeaders = {
    cookie: `pos_session=${"s".repeat(43)}`,
    "x-restaurant-id": restaurantId,
  };

  it("lets accountants read suppliers, inventory, and purchases", async () => {
    const { app, calls } = await makeApp({ role: "accountant" });
    for (const url of [
      "/api/pos/suppliers",
      "/api/pos/inventory/items",
      "/api/pos/inventory/low-stock",
      "/api/pos/inventory/movements",
      "/api/pos/purchases",
      `/api/pos/products/${randomUUID()}/recipe`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: authenticatedHeaders });
      assert.equal(response.statusCode, 200, `GET ${url} failed for accountant`);
    }
    assert.equal(calls.length, 6);
  });

  it("blocks accountants from every mutating endpoint", async () => {
    const { app, calls } = await makeApp({ role: "accountant" });
    const itemId = randomUUID();
    const productId = randomUUID();
    const purchaseId = randomUUID();
    const attempts = [
      { method: "POST", url: "/api/pos/suppliers", payload: { name: "Alpha Farms" } },
      { method: "PATCH", url: `/api/pos/suppliers/${randomUUID()}`, payload: { name: "Alpha Farms" } },
      { method: "POST", url: "/api/pos/inventory/items", payload: { idempotencyKey: randomUUID(), name: "Tomatoes", baseUnit: "piece" } },
      { method: "PATCH", url: `/api/pos/inventory/items/${itemId}`, payload: { name: "Tomatoes" } },
      { method: "POST", url: "/api/pos/inventory/adjustments", payload: { idempotencyKey: randomUUID(), itemId, direction: "increase", quantity: 1, reason: "Count" } },
      { method: "POST", url: "/api/pos/inventory/waste", payload: { idempotencyKey: randomUUID(), itemId, quantity: 1, reason: "Expired" } },
      { method: "PUT", url: `/api/pos/products/${productId}/recipe`, payload: { items: [] } },
      { method: "POST", url: "/api/pos/purchases", payload: { idempotencyKey: randomUUID(), supplierId: randomUUID(), purchaseDate: "2026-10-06", items: [] } },
      { method: "PATCH", url: `/api/pos/purchases/${purchaseId}`, payload: { notes: "edit" } },
      { method: "POST", url: `/api/pos/purchases/${purchaseId}/receive`, payload: {}, headers: { "Idempotency-Key": randomUUID() }, },
    ];
    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { ...authenticatedHeaders, ...(attempt.headers ?? {}) },
        payload: attempt.payload,
      });
      assert.equal(response.statusCode, 403, `${attempt.method} ${attempt.url} should be forbidden for accountant`);
    }
    assert.equal(calls.length, 0);
  });

  it("lets cashiers read inventory but not purchases", async () => {
    const { app, calls } = await makeApp({ role: "cashier" });
    const readable = await app.inject({ method: "GET", url: "/api/pos/inventory/items", headers: authenticatedHeaders });
    assert.equal(readable.statusCode, 200);
    const purchases = await app.inject({ method: "GET", url: "/api/pos/purchases", headers: authenticatedHeaders });
    assert.equal(purchases.statusCode, 403);
    const suppliers = await app.inject({ method: "GET", url: "/api/pos/suppliers", headers: authenticatedHeaders });
    assert.equal(suppliers.statusCode, 403);
    assert.deepEqual(calls, [["inventory:list", { restaurantId, search: null, isActive: null, limit: undefined, cursor: undefined }]]);
  });

  it("lets managers adjust stock and edit recipes", async () => {
    const { app, calls } = await makeApp({ role: "manager" });
    const itemId = randomUUID();
    const productId = randomUUID();
    const adjust = await app.inject({
      method: "POST",
      url: "/api/pos/inventory/adjustments",
      headers: authenticatedHeaders,
      payload: { idempotencyKey: randomUUID(), itemId, direction: "increase", quantity: 5, reason: "Stock count" },
    });
    assert.equal(adjust.statusCode, 201);
    const recipe = await app.inject({
      method: "PUT",
      url: `/api/pos/products/${productId}/recipe`,
      headers: authenticatedHeaders,
      payload: { items: [{ inventoryItemId: itemId, quantityRequired: 0.25 }] },
    });
    assert.equal(recipe.statusCode, 200);
    assert.deepEqual(calls[0], ["inventory:adjust", {
      restaurantId, userId,
      input: { idempotencyKey: calls[0][1].input.idempotencyKey, itemId, direction: "increase", quantity: 5, reason: "Stock count" },
    }]);
    assert.deepEqual(calls[1], ["recipe:replace", {
      restaurantId, userId, productId,
      items: [{ inventoryItemId: itemId, quantityRequired: 0.25 }],
    }]);
  });

  it("requires an idempotency key for receiving a purchase", async () => {
    const { app, calls } = await makeApp();
    const purchaseId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: `/api/pos/purchases/${purchaseId}/receive`,
      headers: authenticatedHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "MISSING_IDEMPOTENCY_KEY");
    assert.equal(calls.length, 0);
  });

  it("resolves the receive idempotency key from the header or the body", async () => {
    const { app, calls } = await makeApp();
    const purchaseId = randomUUID();
    const headerKey = randomUUID();
    const fromHeader = await app.inject({
      method: "POST",
      url: `/api/pos/purchases/${purchaseId}/receive`,
      headers: { ...authenticatedHeaders, "Idempotency-Key": headerKey },
      payload: {},
    });
    assert.equal(fromHeader.statusCode, 201);
    assert.equal(calls[0][1].idempotencyKey, headerKey);

    const bodyKey = randomUUID();
    const fromBody = await app.inject({
      method: "POST",
      url: `/api/pos/purchases/${purchaseId}/receive`,
      headers: authenticatedHeaders,
      payload: { idempotencyKey: bodyKey },
    });
    assert.equal(fromBody.statusCode, 201);
    assert.equal(calls[1][1].idempotencyKey, bodyKey);
  });

  it("passes the purchase idempotency key through to the service", async () => {
    const { app, calls } = await makeApp();
    const key = randomUUID();
    const supplierId = randomUUID();
    const itemId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/purchases",
      headers: authenticatedHeaders,
      payload: {
        idempotencyKey: key,
        supplierId,
        purchaseDate: "2026-10-06",
        discountMinor: 20,
        taxMinor: 10,
        items: [{ inventoryItemId: itemId, quantity: 2.5, unitCostMinor: 100 }],
      },
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(calls[0], ["purchases:create", {
      restaurantId, userId,
      input: {
        idempotencyKey: key,
        supplierId,
        purchaseDate: "2026-10-06",
        discountMinor: 20,
        taxMinor: 10,
        items: [{ inventoryItemId: itemId, quantity: 2.5, unitCostMinor: 100 }],
      },
    }]);
  });

  it("validates purchase payloads before they reach the service", async () => {
    const { app, calls } = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/pos/purchases",
      headers: authenticatedHeaders,
      payload: { idempotencyKey: randomUUID(), supplierId: randomUUID(), purchaseDate: "not-a-date", items: [] },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  it("blocks every inventory endpoint when the subscription has expired", async () => {
    const { app, calls } = await makeApp({ subscriptionStatus: "expired" });
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/inventory/items",
      headers: authenticatedHeaders,
    });
    assert.equal(response.statusCode, 402);
    assert.equal(calls.length, 0);
  });

  it("requires authentication for every inventory endpoint", async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/pos/inventory/items",
      headers: { "x-restaurant-id": restaurantId },
    });
    assert.equal(response.statusCode, 401);
  });
});
