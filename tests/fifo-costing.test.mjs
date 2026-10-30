import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createFifoBatch,
  allocateFifo,
  reverseFifoAllocations,
  getItemFifoValue,
  getFifoCogsForOrder,
} from "../src/server/pos/fifo-allocation-service.mjs";

describe("FIFO inventory allocation engine", () => {
  function createMockClient() {
    const batches = [];
    const allocations = [];
    const deficits = [];

    return {
      batches,
      allocations,
      deficits,
      async query(sql, params = []) {
        const text = sql.replace(/\s+/g, " ").trim();

        // INSERT INTO inventory_fifo_batches
        if (text.startsWith("INSERT INTO inventory_fifo_batches")) {
          const [
            id, restaurantId, inventoryItemId,
            purchaseId, purchaseItemId,
            quantity, unitCostMinor, effectiveReceiptAt,
            batchRef,
          ] = params;
          const row = {
            id,
            restaurant_id: restaurantId,
            inventory_item_id: inventoryItemId,
            purchase_id: purchaseId,
            purchase_item_id: purchaseItemId,
            original_quantity: quantity,
            remaining_quantity: quantity,
            unit_cost_minor: unitCostMinor,
            effective_receipt_at: effectiveReceiptAt,
            batch_ref: batchRef,
            created_at: new Date(),
          };
          batches.push(row);
          return { rows: [row], rowCount: 1 };
        }

        // SELECT from inventory_fifo_batches FOR UPDATE
        if (text.includes("FROM inventory_fifo_batches") && text.includes("remaining_quantity > 0")) {
          const [restaurantId, inventoryItemId] = params;
          const matched = batches
            .filter(
              (b) =>
                b.restaurant_id === restaurantId &&
                b.inventory_item_id === inventoryItemId &&
                b.remaining_quantity > 0,
            )
            .sort((a, b) => {
              const tDiff = a.effective_receipt_at.getTime() - b.effective_receipt_at.getTime();
              if (tDiff !== 0) return tDiff;
              return a.id.localeCompare(b.id);
            });
          return { rows: matched, rowCount: matched.length };
        }

        // UPDATE inventory_fifo_batches SET remaining_quantity
        if (text.startsWith("UPDATE inventory_fifo_batches SET remaining_quantity = remaining_quantity -")) {
          const [restaurantId, batchId, take] = params;
          const batch = batches.find((b) => b.restaurant_id === restaurantId && b.id === batchId);
          if (batch) {
            batch.remaining_quantity -= take;
          }
          return { rows: [], rowCount: batch ? 1 : 0 };
        }

        // UPDATE inventory_fifo_batches SET remaining_quantity = remaining_quantity + (reversal)
        if (text.startsWith("UPDATE inventory_fifo_batches SET remaining_quantity = remaining_quantity +")) {
          const [restaurantId, batchId, add] = params;
          const batch = batches.find((b) => b.restaurant_id === restaurantId && b.id === batchId);
          if (batch) {
            batch.remaining_quantity += add;
          }
          return { rows: [], rowCount: batch ? 1 : 0 };
        }

        // INSERT INTO inventory_fifo_allocations
        if (text.startsWith("INSERT INTO inventory_fifo_allocations")) {
          const [
            id, restaurantId, batchId, orderId, inventoryItemId,
            take, unitCost, sliceCost, allocationTypeOrDate, dateIfReversal,
          ] = params;
          const row = {
            id,
            restaurant_id: restaurantId,
            batch_id: batchId,
            order_id: orderId,
            inventory_item_id: inventoryItemId,
            allocated_quantity: take,
            unit_cost_minor: unitCost,
            total_cost_minor: sliceCost,
            allocation_type: text.includes("'sale'") ? "sale" : "sale_reversal",
            created_at: new Date(),
          };
          allocations.push(row);
          return { rows: [row], rowCount: 1 };
        }

        // INSERT INTO inventory_fifo_deficits
        if (text.startsWith("INSERT INTO inventory_fifo_deficits")) {
          const [id, restaurantId, inventoryItemId, orderId, deficit, now] = params;
          const row = {
            id,
            restaurant_id: restaurantId,
            inventory_item_id: inventoryItemId,
            order_id: orderId,
            deficit_quantity: deficit,
            resolved_at: null,
            created_at: now,
          };
          deficits.push(row);
          return { rows: [row], rowCount: 1 };
        }

        // SELECT for reversal: sale allocations
        if (text.includes("FROM inventory_fifo_allocations a") && text.includes("allocation_type = 'sale'")) {
          const [restaurantId, orderId] = params;
          const matched = allocations.filter(
            (a) => a.restaurant_id === restaurantId && a.order_id === orderId && a.allocation_type === "sale",
          );
          return { rows: matched, rowCount: matched.length };
        }

        // DELETE FROM inventory_fifo_deficits
        if (text.startsWith("DELETE FROM inventory_fifo_deficits")) {
          const [restaurantId, orderId] = params;
          const initialLen = deficits.length;
          const remaining = deficits.filter(
            (d) => !(d.restaurant_id === restaurantId && d.order_id === orderId && d.resolved_at === null),
          );
          deficits.length = 0;
          deficits.push(...remaining);
          return { rows: [], rowCount: initialLen - remaining.length };
        }

        // getItemFifoValue
        if (text.includes("SELECT COALESCE(SUM(remaining_quantity * unit_cost_minor)") || text.includes("fifo_value")) {
          const [restaurantId, inventoryItemId] = params;
          const matched = batches.filter(
            (b) => b.restaurant_id === restaurantId && b.inventory_item_id === inventoryItemId,
          );
          const fifoValue = matched.reduce((sum, b) => sum + b.remaining_quantity * b.unit_cost_minor, 0);
          const remQty = matched.reduce((sum, b) => sum + b.remaining_quantity, 0);
          return { rows: [{ fifo_value: fifoValue, remaining_qty: remQty }] };
        }

        // getFifoCogsForOrder
        if (text.includes("SELECT COALESCE(SUM(total_cost_minor), 0) AS total")) {
          const [restaurantId, orderId] = params;
          const matched = allocations.filter(
            (a) => a.restaurant_id === restaurantId && a.order_id === orderId && a.allocation_type === "sale",
          );
          const total = matched.reduce((sum, a) => sum + a.total_cost_minor, 0);
          return { rows: [{ total }] };
        }

        throw new Error(`Unhandled mock query: ${text}`);
      },
    };
  }

  it("Scenario A: executes the mandatory FIFO cost scenario with exact math", async () => {
    const client = createMockClient();
    const restaurantId = randomUUID();
    const doughId = randomUUID();

    // 1. Existing dough stock: 8 kg at Rs. 250/kg (= 25000 minor per kg)
    const t0 = new Date("2026-10-01T10:00:00Z");
    await createFifoBatch(client, {
      restaurantId,
      inventoryItemId: doughId,
      purchaseId: randomUUID(),
      purchaseItemId: randomUUID(),
      quantity: 8,
      unitCostMinor: 25000,
      effectiveReceiptAt: t0,
      batchRef: "PO-000001",
    });

    // 2. New purchase: 8 kg at Rs. 300/kg (= 30000 minor per kg)
    const t1 = new Date("2026-10-02T10:00:00Z");
    await createFifoBatch(client, {
      restaurantId,
      inventoryItemId: doughId,
      purchaseId: randomUUID(),
      purchaseItemId: randomUUID(),
      quantity: 8,
      unitCostMinor: 30000,
      effectiveReceiptAt: t1,
      batchRef: "PO-000002",
    });

    // Verify initial inventory valuation: 8*250 + 8*300 = Rs. 4,400 (440000 minor)
    let val = await getItemFifoValue(client, { restaurantId, inventoryItemId: doughId });
    assert.equal(val.remainingQuantity, 16);
    assert.equal(val.fifoValueMinor, 440000);

    // 3. First sale: consume 5 kg
    const order1Id = randomUUID();
    const sale1 = await allocateFifo(client, {
      restaurantId,
      inventoryItemId: doughId,
      orderId: order1Id,
      requiredQuantity: 5,
      now: new Date("2026-10-03T12:00:00Z"),
    });

    // Expected for Sale 1:
    // - Consumes 5 kg from old batch (at 250/kg)
    // - COGS = 5 * 250 = Rs. 1,250 (125000 minor)
    // - Old batch remaining = 3 kg
    // - New batch remaining = 8 kg
    // - Total remaining = 11 kg
    // - Inventory value = 3 * 250 + 8 * 300 = 750 + 2400 = Rs. 3,150 (315000 minor)
    assert.equal(sale1.costingStatus, "resolved");
    assert.equal(sale1.deficit, 0);
    assert.equal(sale1.totalCostMinor, 125000, "First sale COGS must be Rs. 1,250");
    assert.equal(sale1.allocations.length, 1);
    assert.equal(sale1.allocations[0].allocatedQuantity, 5);
    assert.equal(sale1.allocations[0].unitCostMinor, 25000);

    val = await getItemFifoValue(client, { restaurantId, inventoryItemId: doughId });
    assert.equal(val.remainingQuantity, 11, "Remaining stock must be 11 kg");
    assert.equal(val.fifoValueMinor, 315000, "Remaining inventory value must be Rs. 3,150");

    // 4. Second sale: consume 5 kg
    const order2Id = randomUUID();
    const sale2 = await allocateFifo(client, {
      restaurantId,
      inventoryItemId: doughId,
      orderId: order2Id,
      requiredQuantity: 5,
      now: new Date("2026-10-03T15:00:00Z"),
    });

    // Expected for Sale 2:
    // - Consumes remaining 3 kg from old batch (at 250/kg) = Rs. 750 (75000 minor)
    // - Consumes 2 kg from new batch (at 300/kg) = Rs. 600 (60000 minor)
    // - Total COGS = Rs. 1,350 (135000 minor)
    // - Old batch exhausted (0 kg)
    // - New batch remaining = 6 kg
    // - Remaining stock = 6 kg
    // - Inventory value = 6 * 300 = Rs. 1,800 (180000 minor)
    assert.equal(sale2.costingStatus, "resolved");
    assert.equal(sale2.deficit, 0);
    assert.equal(sale2.totalCostMinor, 135000, "Second sale COGS must be Rs. 1,350");
    assert.equal(sale2.allocations.length, 2);
    assert.equal(sale2.allocations[0].allocatedQuantity, 3);
    assert.equal(sale2.allocations[0].unitCostMinor, 25000);
    assert.equal(sale2.allocations[1].allocatedQuantity, 2);
    assert.equal(sale2.allocations[1].unitCostMinor, 30000);

    val = await getItemFifoValue(client, { restaurantId, inventoryItemId: doughId });
    assert.equal(val.remainingQuantity, 6, "Remaining stock must be 6 kg");
    assert.equal(val.fifoValueMinor, 180000, "Remaining inventory value must be Rs. 1,800");

    // Check order-level COGS queries
    const cogsOrder1 = await getFifoCogsForOrder(client, { restaurantId, orderId: order1Id });
    assert.equal(cogsOrder1, 125000);
    const cogsOrder2 = await getFifoCogsForOrder(client, { restaurantId, orderId: order2Id });
    assert.equal(cogsOrder2, 135000);
  });

  it("Scenario B: cancellation cleanly restores batch layers and reverses allocations", async () => {
    const client = createMockClient();
    const restaurantId = randomUUID();
    const itemId = randomUUID();

    // 10 kg at 100
    await createFifoBatch(client, {
      restaurantId,
      inventoryItemId: itemId,
      purchaseId: randomUUID(),
      purchaseItemId: randomUUID(),
      quantity: 10,
      unitCostMinor: 10000,
      effectiveReceiptAt: new Date("2026-10-01T10:00:00Z"),
    });

    const orderId = randomUUID();
    const sale = await allocateFifo(client, {
      restaurantId,
      inventoryItemId: itemId,
      orderId,
      requiredQuantity: 4,
      now: new Date("2026-10-01T12:00:00Z"),
    });
    assert.equal(sale.totalCostMinor, 40000);

    let val = await getItemFifoValue(client, { restaurantId, inventoryItemId: itemId });
    assert.equal(val.remainingQuantity, 6);

    // Cancel order
    const reversal = await reverseFifoAllocations(client, {
      restaurantId,
      orderId,
      now: new Date("2026-10-01T13:00:00Z"),
    });

    assert.equal(reversal.restoredItems.length, 1);
    assert.equal(reversal.restoredItems[0].restoredQuantity, 4);

    val = await getItemFifoValue(client, { restaurantId, inventoryItemId: itemId });
    assert.equal(val.remainingQuantity, 10, "Restored back to full quantity 10");
    assert.equal(val.fifoValueMinor, 100000, "Restored back to full value");
  });

  it("Scenario C: handles negative inventory / stock deficits transparently", async () => {
    const client = createMockClient();
    const restaurantId = randomUUID();
    const itemId = randomUUID();

    // Only 2 kg in stock at 50/kg
    await createFifoBatch(client, {
      restaurantId,
      inventoryItemId: itemId,
      purchaseId: randomUUID(),
      purchaseItemId: randomUUID(),
      quantity: 2,
      unitCostMinor: 5000,
      effectiveReceiptAt: new Date("2026-10-01T10:00:00Z"),
    });

    // Customer orders 5 kg (exceeds stock by 3 kg)
    const orderId = randomUUID();
    const sale = await allocateFifo(client, {
      restaurantId,
      inventoryItemId: itemId,
      orderId,
      requiredQuantity: 5,
      now: new Date("2026-10-01T12:00:00Z"),
    });

    assert.equal(sale.costingStatus, "provisional");
    assert.equal(sale.deficit, 3, "3 kg deficit recorded");
    assert.equal(sale.totalCostMinor, 10000, "COGS covers only the 2 kg available (2 * 50 = Rs. 100)");
    assert.equal(client.deficits.length, 1);
    assert.equal(client.deficits[0].deficit_quantity, 3);
  });
});
