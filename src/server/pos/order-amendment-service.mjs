import { createHash, randomUUID } from "node:crypto";
import { MoneyEngine } from "../../domain/money-engine.mjs";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";
import { prepareOrderLines, pricingInput } from "./order-service.mjs";
import { resolveExtraBaseUnitsPerItem, formatExtraDisplay } from "./ingredient-unit-converter.mjs";

export function createOrderAmendmentService(pool, { clock = () => new Date(), kitchenService = null } = {}) {
  return Object.freeze({
    async amend({ tenant, userId, orderId, input }) {
      const restaurantId = tenant.restaurant.id;
      const now = clock();
      const hash = createHash("sha256").update(JSON.stringify({ orderId, ...input })).digest("hex");
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`edit:${restaurantId}:${input.idempotencyKey}`]);
        const previous = (await client.query(`SELECT order_id, request_hash FROM order_edit_events
          WHERE restaurant_id=$1 AND idempotency_key=$2`, [restaurantId, input.idempotencyKey])).rows[0];
        if (previous && (previous.order_id !== orderId || previous.request_hash !== hash)) {
          throw apiError("This retry key belongs to different changes.", "IDEMPOTENCY_CONFLICT", 409);
        }
        const order = (await client.query(`SELECT *, business_date::text AS business_day FROM orders
          WHERE restaurant_id=$1 AND id=$2 FOR UPDATE`, [restaurantId, orderId])).rows[0];
        if (!order) throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);
        if (previous) return { order: { id: orderId, version: order.version, totalMinor: Number(order.total_minor) }, replayed: true };
        if (order.restore_key) throw apiError("Restored historical bills require reconciliation before changes.", "HISTORICAL_ORDER_READ_ONLY", 409);
        if (Number(order.version) !== input.expectedVersion) throw apiError("Another device changed this order. Reopen it before editing.", "ORDER_VERSION_CONFLICT", 409);
        if (["completed", "cancelled"].includes(order.order_status) || order.payment_status !== "unpaid") {
          throw apiError("Only unpaid open orders can be edited. Use a refund or cancellation for a paid bill.", "ORDER_NOT_EDITABLE", 409);
        }
        const money = await client.query(`SELECT id FROM order_payments WHERE restaurant_id=$1 AND order_id=$2`, [restaurantId, orderId]);
        const consumed = await client.query(`SELECT id FROM inventory_consumptions WHERE restaurant_id=$1 AND order_id=$2`, [restaurantId, orderId]);
        if (money.rowCount || consumed.rowCount) throw apiError("This bill already has financial activity. Refresh it before continuing.", "ORDER_NOT_EDITABLE", 409);
        const oldItems = (await client.query(`SELECT * FROM order_items WHERE restaurant_id=$1 AND order_id=$2 ORDER BY sort_order, id`, [restaurantId, orderId])).rows;
        const byId = new Map(oldItems.map(row => [row.id, row]));
        const suppliedIds = input.items.filter(line => line.orderItemId).map(line => line.orderItemId);
        if (new Set(suppliedIds).size !== suppliedIds.length || suppliedIds.some(id => !byId.has(id))) {
          throw apiError("One or more order lines have changed.", "ORDER_ITEMS_CHANGED", 409);
        }

        const existingExtrasRes = suppliedIds.length > 0
          ? await client.query(
              `SELECT id, order_item_id, stock_item_id, quantity_base_units, cost_minor, price_minor, name_snapshot
                 FROM order_item_extras
                WHERE restaurant_id = $1 AND order_item_id = ANY($2::uuid[])`,
              [restaurantId, suppliedIds],
            )
          : { rows: [] };
        const existingExtrasByItemId = new Map();
        for (const row of existingExtrasRes.rows) {
          if (!existingExtrasByItemId.has(row.order_item_id)) existingExtrasByItemId.set(row.order_item_id, []);
          existingExtrasByItemId.get(row.order_item_id).push(row);
        }

        const allExtrasStockItemIds = new Set();
        for (const item of input.items) {
          for (const extra of item.extras || []) {
            if (extra?.stockItemId) allExtrasStockItemIds.add(extra.stockItemId);
          }
        }
        for (const row of existingExtrasRes.rows) {
          if (row.stock_item_id) allExtrasStockItemIds.add(row.stock_item_id);
        }

        let extraStockMap = new Map();
        if (allExtrasStockItemIds.size > 0) {
          const res = await client.query(
            `SELECT s.id, s.name, s.base_unit, s.sell_unit, s.base_units_per_sell_unit,
                    COALESCE(b.average_cost_minor_per_base_unit, 0) AS avg_cost
               FROM stock_items s
               LEFT JOIN inventory_balances b
                 ON b.restaurant_id = s.restaurant_id
                AND b.branch_id = $3
                AND b.stock_item_id = s.id
              WHERE s.restaurant_id = $1 AND s.id = ANY($2::uuid[]) AND s.is_active = true`,
            [restaurantId, [...allExtrasStockItemIds], order.branch_id],
          );
          extraStockMap = new Map(res.rows.map(r => [r.id, r]));
        }

        function prepareLineExtras(rawExtras, lineQty, existingLineExtras = []) {
          const existingByStockId = new Map(existingLineExtras.map(e => [e.stock_item_id, e]));
          return (rawExtras || []).map(extra => {
            const def = extraStockMap.get(extra.stockItemId);
            if (!def) throw apiError("One or more extra ingredients are unavailable.", "EXTRA_UNAVAILABLE", 409);
            const baseUnitsPerItem = resolveExtraBaseUnitsPerItem(extra, def);
            const totalBaseUnits = baseUnitsPerItem * lineQty;

            // Preserve frozen costs for unchanged or quantity-amended extras; use current avg_cost for newly added extras
            const existing = existingByStockId.get(extra.stockItemId);
            let costPerBaseUnit;
            if (existing && Number(existing.quantity_base_units) > 0) {
              costPerBaseUnit = Number(existing.cost_minor) / Number(existing.quantity_base_units);
            } else {
              costPerBaseUnit = Number(def.avg_cost) || 0;
            }
            const display = formatExtraDisplay(def.name, totalBaseUnits, def);

            return {
              stockItemId: extra.stockItemId,
              nameSnapshot: def.name,
              quantityBaseUnits: totalBaseUnits,
              priceMinor: Number(extra.priceMinor) || 0,
              costMinor: Math.round(costPerBaseUnit * totalBaseUnits),
              unit: display.unit,
              displayQuantity: display.quantity,
            };
          });
        }

        const prepared = await prepareOrderLines(client, {
          restaurantId, branchId: order.branch_id, businessDate: order.business_day,
          input: { items: input.items.filter(line => !line.orderItemId) },
        });
        let nextNew = 0;
        const lines = input.items.map(line => {
          if (!line.orderItemId) return { ...prepared.menuLines[nextNew++], id: randomUUID() };
          const old = byId.get(line.orderItemId);
          const existingLineExtras = existingExtrasByItemId.get(old.id) || [];
          const oldExtrasTotalCost = existingLineExtras.reduce((s, e) => s + Number(e.cost_minor), 0);
          const oldQty = Number(old.quantity) || 1;
          const baseRecipeUnitCostMinor = Math.max(0, Number(old.unit_cost_minor) - Math.round(oldExtrasTotalCost / oldQty));

          let preparedExistingExtras = undefined;
          let newLineUnitCostMinor = Number(old.unit_cost_minor);

          if (line.extras !== undefined) {
            preparedExistingExtras = prepareLineExtras(line.extras, line.quantity, existingLineExtras);
            const newExtrasTotalCost = preparedExistingExtras.reduce((s, e) => s + e.costMinor, 0);
            newLineUnitCostMinor = Math.round(baseRecipeUnitCostMinor + (newExtrasTotalCost / line.quantity));
          } else if (line.quantity !== oldQty) {
            const ratio = line.quantity / oldQty;
            const scaledExtrasTotalCost = Math.round(oldExtrasTotalCost * ratio);
            newLineUnitCostMinor = Math.round(baseRecipeUnitCostMinor + (scaledExtrasTotalCost / line.quantity));
          }

          return {
            id: old.id,
            menuItemId: old.menu_item_id,
            name: old.item_name_snapshot,
            quantity: line.quantity,
            priceMinor: Number(old.unit_price_minor),
            unitCostMinor: newLineUnitCostMinor,
            snapshot: old.recipe_snapshot,
            notes: old.notes,
            extras: preparedExistingExtras,
          };
        });

        const oldCharges = (await client.query(`SELECT name, charge_type, charge_value FROM order_charges
          WHERE restaurant_id=$1 AND order_id=$2 ORDER BY created_at, id`, [restaurantId, orderId])).rows;
        const charges = oldCharges.map(row => ({ name: row.name, type: row.charge_type,
          ...(row.charge_type === "flat" ? { valueMinor: Number(row.charge_value) } : { value: Number(row.charge_value) }) }));
        const discount = input.discount ?? (order.discount_type === "percent"
          ? { type: "percent", value: Number(order.discount_value) }
          : { type: "flat", valueMinor: Number(order.discount_minor) });
        const pricing = MoneyEngine.calculate(pricingInput(lines, { discount,
          deliveryMinor: input.deliveryMinor ?? Number(order.delivery_minor), additionalCharges: charges }));
        const skipped = [...prepared.skippedDeductions];
        for (const line of lines.filter(line => line.snapshot)) {
          const snapshot = line.snapshot;
          if (snapshot.incompleteCosting || (!snapshot.items?.length && !snapshot.inventoryItems?.length)) {
            skipped.push({ menuItemId: line.menuItemId, name: line.name, quantity: line.quantity, reason: "missing_recipe" });
          }
          for (const deduction of snapshot.skippedDeductions || []) skipped.push({ menuItemId: line.menuItemId, ...deduction });
        }

        const totalCostOfGoodsMinor = lines.reduce((sum, line) => sum + line.unitCostMinor * line.quantity, 0);
        const updated = (await client.query(`UPDATE orders SET customer_name=$3, customer_phone=$4,
          subtotal_minor=$5, discount_type=$6, discount_value=$7, discount_minor=$8, delivery_minor=$9,
          additional_charges_minor=$10, total_minor=$11, cost_of_goods_minor=$12,
          incomplete_costing=$13, skipped_stock_deductions=$14, version=version+1,
          updated_by_user_id=$15, updated_at=$16
          WHERE restaurant_id=$1 AND id=$2 RETURNING version`, [restaurantId, orderId,
          input.customerName ?? order.customer_name, input.customerPhone ?? order.customer_phone,
          pricing.minor.subtotal, discount.type, discount.type === "percent" ? discount.value : discount.valueMinor / 100,
          pricing.minor.discount, pricing.minor.delivery, pricing.minor.additionalCharges, pricing.minor.total,
          totalCostOfGoodsMinor,
          prepared.hasIncompleteCosting || skipped.length > 0, JSON.stringify(skipped), userId, now])).rows[0];

        for (const old of oldItems) {
          if (!suppliedIds.includes(old.id)) {
            await client.query(`DELETE FROM order_item_extras WHERE restaurant_id=$1 AND order_item_id=$2`, [restaurantId, old.id]);
            await client.query(`DELETE FROM order_items WHERE restaurant_id=$1 AND id=$2 AND order_id=$3`, [restaurantId, old.id, orderId]);
          }
        }
        for (const [index, line] of lines.entries()) {
          if (line.snapshot) {
            await client.query(`UPDATE order_items SET quantity=$3, line_total_minor=$4, unit_cost_minor=$5, sort_order=$6
              WHERE restaurant_id=$1 AND id=$2 AND order_id=$7`, [restaurantId, line.id, line.quantity, line.priceMinor * line.quantity, line.unitCostMinor, index, orderId]);
            if (line.extras !== undefined) {
              await client.query(`DELETE FROM order_item_extras WHERE restaurant_id=$1 AND order_item_id=$2`, [restaurantId, line.id]);
              for (const extra of line.extras || []) {
                await client.query(
                  `INSERT INTO order_item_extras (
                     id, restaurant_id, order_item_id, stock_item_id,
                     name_snapshot, quantity_base_units, price_minor, cost_minor
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                  [
                    randomUUID(), restaurantId, line.id, extra.stockItemId,
                    extra.nameSnapshot, extra.quantityBaseUnits, extra.priceMinor, extra.costMinor,
                  ],
                );
              }
            } else {
              const old = byId.get(line.id);
              if (old && Number(old.quantity) !== line.quantity && Number(old.quantity) > 0) {
                const ratio = line.quantity / Number(old.quantity);
                await client.query(
                  `UPDATE order_item_extras
                      SET quantity_base_units = quantity_base_units * $3,
                          cost_minor = ROUND(cost_minor * $3)
                    WHERE restaurant_id = $1 AND order_item_id = $2`,
                  [restaurantId, line.id, ratio],
                );
              }
            }
          } else {
            await client.query(`INSERT INTO order_items (id,restaurant_id,order_id,menu_item_id,item_name_snapshot,
              quantity,unit_price_minor,line_total_minor,unit_cost_minor,recipe_snapshot,sort_order)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [line.id,restaurantId,orderId,line.menuItemId,line.name,
              line.quantity,line.priceMinor,line.priceMinor*line.quantity,line.unitCostMinor,JSON.stringify({version:2,
                items:line.recipe||[],inventoryItems:line.inventoryRecipe||[],components:line.componentSnapshots||[],offer:line.offer,
                incompleteCosting:!!line.incompleteCosting,skippedDeductions:line.skippedInventoryUsage||[]}),index]);
            for (const extra of line.extras || []) {
              await client.query(
                `INSERT INTO order_item_extras (
                   id, restaurant_id, order_item_id, stock_item_id,
                   name_snapshot, quantity_base_units, price_minor, cost_minor
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  randomUUID(), restaurantId, line.id, extra.stockItemId,
                  extra.nameSnapshot, extra.quantityBaseUnits, extra.priceMinor, extra.costMinor,
                ],
              );
            }
          }
        }
        await client.query(`DELETE FROM order_charges WHERE restaurant_id=$1 AND order_id=$2`, [restaurantId,orderId]);
        for (const charge of pricing.additionalCharges) await client.query(`INSERT INTO order_charges
          (restaurant_id,order_id,name,charge_type,charge_value,amount_minor) VALUES($1,$2,$3,$4,$5,$6)`,
          [restaurantId,orderId,charge.name,charge.type,charge.type === "flat" ? Math.round(charge.value*100) : charge.value,Math.round(charge.amount*100)]);

        // Generate kitchen instruction deltas, including accurate deltas for quantity changes and extras-only edits
        const delta = [];
        for (const line of lines) {
          const old = byId.get(line.id);
          const oldQty = old ? Number(old.quantity) : 0;
          const diff = line.quantity - oldQty;
          const existingLineExtras = old ? (existingExtrasByItemId.get(old.id) || []) : [];
          const oldExtrasMap = new Map(existingLineExtras.map(e => [e.stock_item_id, e]));

          if (diff !== 0) {
            // Item quantity changed: send delta item quantity with delta extras
            const itemExtrasDelta = (line.extras || existingLineExtras.map(e => ({
              stockItemId: e.stock_item_id,
              nameSnapshot: e.name_snapshot,
              quantityBaseUnits: e.quantity_base_units,
            }))).map((e) => {
              const def = extraStockMap.get(e.stockItemId);
              const perItemQty = line.quantity > 0 ? (Number(e.quantityBaseUnits) / line.quantity) : 0;
              const deltaQty = perItemQty * Math.abs(diff);
              const display = formatExtraDisplay(e.nameSnapshot || e.name, deltaQty, def);
              return {
                stockItemId: e.stockItemId,
                name: e.nameSnapshot || e.name,
                quantity: display.quantity,
                unit: display.unit,
              };
            });

            delta.push({
              menuItemId: line.menuItemId,
              name: line.name,
              quantity: Math.abs(diff),
              extras: itemExtrasDelta,
              notes: diff > 0 ? "ADD to order" : "REMOVE from order",
              adjustment: diff > 0 ? "add" : "remove",
            });
          } else if (line.extras !== undefined) {
            // Extras-only changes (item quantity did NOT change)
            const newExtras = line.extras || [];
            const newExtrasMap = new Map(newExtras.map(e => [e.stockItemId, e]));

            for (const newEx of newExtras) {
              const oldEx = oldExtrasMap.get(newEx.stockItemId);
              const oldBaseUnits = oldEx ? Number(oldEx.quantity_base_units) : 0;
              const deltaBaseUnits = Number(newEx.quantityBaseUnits) - oldBaseUnits;
              if (deltaBaseUnits !== 0) {
                const def = extraStockMap.get(newEx.stockItemId);
                const display = formatExtraDisplay(newEx.nameSnapshot, Math.abs(deltaBaseUnits), def);
                delta.push({
                  menuItemId: line.menuItemId,
                  name: line.name,
                  quantity: line.quantity,
                  extras: [{
                    stockItemId: newEx.stockItemId,
                    name: newEx.nameSnapshot,
                    quantity: display.quantity,
                    unit: display.unit,
                  }],
                  notes: deltaBaseUnits > 0 ? `ADD extra ${newEx.nameSnapshot}` : `REMOVE extra ${newEx.nameSnapshot}`,
                  adjustment: deltaBaseUnits > 0 ? "add" : "remove",
                });
              }
            }

            for (const oldEx of existingLineExtras) {
              if (!newExtrasMap.has(oldEx.stock_item_id)) {
                const def = extraStockMap.get(oldEx.stock_item_id);
                const display = formatExtraDisplay(oldEx.name_snapshot, Number(oldEx.quantity_base_units), def);
                delta.push({
                  menuItemId: line.menuItemId,
                  name: line.name,
                  quantity: line.quantity,
                  extras: [{
                    stockItemId: oldEx.stock_item_id,
                    name: oldEx.name_snapshot,
                    quantity: display.quantity,
                    unit: display.unit,
                  }],
                  notes: `REMOVE extra ${oldEx.name_snapshot}`,
                  adjustment: "remove",
                });
              }
            }
          }
        }
        for (const old of oldItems.filter(old => !suppliedIds.includes(old.id))) {
          delta.push({
            menuItemId: old.menu_item_id,
            name: old.item_name_snapshot,
            quantity: Number(old.quantity),
            notes: "REMOVE from order",
            adjustment: "remove",
          });
        }

        let kitchenTicket = null;
        if (delta.length && kitchenService) {
          kitchenTicket = await kitchenService.createTicketForOrder(client, {
            restaurantId,
            branchId: order.branch_id,
            orderId,
            items: delta,
            notes: `Order #${order.order_number} changed — follow ADD / REMOVE instructions`,
          });
        }
        if (kitchenTicket) await client.query(`UPDATE orders SET order_status='preparing' WHERE restaurant_id=$1 AND id=$2`, [restaurantId,orderId]);
        await client.query(`INSERT INTO order_edit_events (restaurant_id,order_id,actor_user_id,event_type,changes,note,idempotency_key,request_hash)
          VALUES($1,$2,$3,'edited',$4,'Unpaid order updated',$5,$6)`, [restaurantId,orderId,userId,JSON.stringify([
            {label:"Items",from:oldItems.map(row=>({name:row.item_name_snapshot,quantity:Number(row.quantity)})),to:lines.map(line=>({name:line.name,quantity:line.quantity}))},
            {label:"Total",from:Number(order.total_minor),to:pricing.minor.total},
            {label:"Customer",from:order.customer_name,to:input.customerName ?? order.customer_name},
          ]), input.idempotencyKey,hash]);
        return { order:{id:orderId,version:updated.version,totalMinor:pricing.minor.total}, kitchenTicket, replayed:false };
      });
    },
  });
}
