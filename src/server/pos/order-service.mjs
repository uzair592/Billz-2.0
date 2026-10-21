import { freezeInventoryRecipes } from "./inventory-sale-snapshot.mjs";
import { randomUUID, createHash } from "node:crypto";
import { MoneyEngine } from "../../domain/money-engine.mjs";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError, businessDateInTimezone } from "./business-date.mjs";
import { createInventoryConsumptionService } from "./inventory-consumption-service.mjs";
import { hasPermission, PERMISSION } from "../authorization/permissions.mjs";

function computeRequestHash(input) {
  const canonical = {
    items: (input.items || []).map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity })),
    orderType: input.orderType ?? null,
    tableId: input.tableId ?? null,
    discount: input.discount ? { type: input.discount.type, value: input.discount.value ?? null, valueMinor: input.discount.valueMinor ?? null } : null,
    deliveryMinor: input.deliveryMinor ?? 0,
    additionalCharges: (input.additionalCharges || []).map((c) => ({ name: c.name, type: c.type, value: c.value ?? null, valueMinor: c.valueMinor ?? null })),
    payment: input.payment ? { method: input.payment.method, amountReceivedMinor: input.payment.amountReceivedMinor } : null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function publicOrder(row, canViewReports = true) {
  return {
    id: row.id,
    orderNumber: Number(row.order_number),
    orderType: row.order_type,
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    deliveryMinor: Number(row.delivery_minor),
    additionalChargesMinor: Number(row.additional_charges_minor),
    totalMinor: Number(row.total_minor),
    ...(row.cost_of_goods_minor == null || !canViewReports ? {} : { costOfGoodsMinor: Number(row.cost_of_goods_minor) }),
    incompleteCosting: Boolean(row.incomplete_costing),
    skippedStockDeductions: typeof row.skipped_stock_deductions === "string"
      ? JSON.parse(row.skipped_stock_deductions)
      : (row.skipped_stock_deductions ?? []),
    businessDate: row.business_date,
    orderedAt: row.ordered_at,
  };
}

export function pricingInput(menuLines, input) {
  return {
    items: menuLines.map((line) => ({ price: line.priceMinor / 100, qty: line.quantity })),
    discountType: input.discount?.type ?? "flat",
    discountValue:
      input.discount?.type === "percent"
        ? input.discount.value
        : (input.discount?.valueMinor ?? 0) / 100,
    deliveryFee: (input.deliveryMinor ?? 0) / 100,
    additionalCharges: (input.additionalCharges ?? []).map((charge) => ({
      name: charge.name,
      type: charge.type,
      value: charge.type === "percent" ? charge.value : charge.valueMinor / 100,
      enabled: true,
    })),
    paid: input.payment ? input.payment.amountReceivedMinor / 100 : 0,
  };
}

function effectiveItemPrice(item) {
  const regularPriceMinor = Number(item.price_minor);
  const itemOfferMinor = Number(item.offer_price_minor);
  if (item.offer_price_minor !== null && item.offer_price_minor !== undefined
      && itemOfferMinor > 0 && itemOfferMinor < regularPriceMinor) {
    return {
      priceMinor: itemOfferMinor,
      offer: { type: "item", regularPriceMinor, offerPriceMinor: itemOfferMinor },
    };
  }

  let categoryPriceMinor = regularPriceMinor;
  if (item.category_discount_type === "percent") {
    const percent = Math.min(100, Math.max(0, Number(item.category_discount_percent)));
    categoryPriceMinor = regularPriceMinor - Math.round((regularPriceMinor * percent) / 100);
  } else if (item.category_discount_type === "flat") {
    categoryPriceMinor = Math.max(0, regularPriceMinor - Number(item.category_discount_minor));
  }
  if (categoryPriceMinor < regularPriceMinor) {
    return {
      priceMinor: categoryPriceMinor,
      offer: {
        type: "category",
        regularPriceMinor,
        discountType: item.category_discount_type,
        discountMinor: item.category_discount_type === "flat"
          ? Number(item.category_discount_minor)
          : null,
        discountPercent: item.category_discount_type === "percent"
          ? Number(item.category_discount_percent)
          : null,
      },
    };
  }
  return { priceMinor: regularPriceMinor, offer: null };
}

function resolveExtraBaseUnitsPerItem(extra, def) {
  const qty = Number(extra.quantity);
  const baseUnitsPerSell = Number(def.base_units_per_sell_unit) || 1;
  const unit = extra.unit ? String(extra.unit).toLowerCase() : null;
  const baseUnit = String(def.base_unit || "").toLowerCase();
  const sellUnit = String(def.sell_unit || "").toLowerCase();

  if (unit) {
    if (unit === baseUnit || (baseUnit === "gram" && unit === "g") || (baseUnit === "piece" && (unit === "pcs" || unit === "pc" || unit === "unit"))) {
      return qty;
    }
    if (unit === "kg" && baseUnit === "gram") {
      return qty * 1000;
    }
    if (unit === sellUnit || (sellUnit === "number" && (unit === "pcs" || unit === "pc" || unit === "piece"))) {
      return qty * baseUnitsPerSell;
    }
  }

  if ((sellUnit === "g" || sellUnit === "gram") && baseUnit === "gram") {
    return qty;
  }
  if ((sellUnit === "number" || sellUnit === "piece") && baseUnit === "piece") {
    return qty;
  }
  return qty * baseUnitsPerSell;
}

export async function prepareOrderLines(client, { restaurantId, branchId, businessDate, input }) {
  const requestedIds = input.items.map((item) => item.menuItemId);
  const menuResult = await client.query(
    `SELECT mi.id, mi.name, mi.item_type, mi.price_minor,
            mi.other_cost_minor,
            io.offer_price_minor,
            co.discount_type AS category_discount_type,
            co.discount_minor AS category_discount_minor,
            co.discount_percent AS category_discount_percent,
            COALESCE(recipes.items, '[]'::jsonb) AS recipe,
            COALESCE(components.items, '[]'::jsonb) AS components
       FROM menu_items mi
       LEFT JOIN menu_item_offers io
         ON io.restaurant_id = mi.restaurant_id
        AND io.menu_item_id = mi.id
        AND io.is_active = true
        AND (io.starts_on IS NULL OR io.starts_on <= $1::date)
        AND (io.ends_on IS NULL OR io.ends_on >= $1::date)
       LEFT JOIN menu_category_offers co
         ON co.restaurant_id = mi.restaurant_id
        AND co.category_id = mi.category_id
        AND co.is_active = true
        AND (co.starts_on IS NULL OR co.starts_on <= $1::date)
        AND (co.ends_on IS NULL OR co.ends_on >= $1::date)
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
                'stockItemId', r.stock_item_id,
                'quantityBaseUnits', r.quantity_base_units
              ) ORDER BY r.stock_item_id) AS items
           FROM menu_item_recipe_items r
          WHERE r.restaurant_id = mi.restaurant_id
            AND r.menu_item_id = mi.id
       ) recipes ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
                'menuItemId', c.component_menu_item_id,
                'quantity', c.quantity
              ) ORDER BY c.component_menu_item_id) AS items
           FROM menu_item_components c
          WHERE c.restaurant_id = mi.restaurant_id
            AND c.menu_item_id = mi.id
       ) components ON true
      WHERE mi.is_active = true`,
    [businessDate],
  );
  const byId = new Map(menuResult.rows.map((row) => [row.id, row]));
  if (requestedIds.some((id) => !byId.has(id))) {
    throw apiError("One or more menu items are no longer available.", "MENU_CHANGED", 409);
  }

  function expandMenuItem(itemId, path = []) {
    if (path.includes(itemId)) {
      throw apiError(
        "A deal contains a circular component reference.",
        "INVALID_DEAL_CONFIGURATION",
        409,
        { menuItemId: itemId },
      );
    }
    const item = byId.get(itemId);
    if (!item) {
      throw apiError(
        "A deal component is no longer available.",
        "DEAL_COMPONENT_UNAVAILABLE",
        409,
        { menuItemId: itemId },
      );
    }

    const recipeByStockItem = new Map();
    for (const recipeItem of item.recipe ?? []) {
      recipeByStockItem.set(
        recipeItem.stockItemId,
        (recipeByStockItem.get(recipeItem.stockItemId) ?? 0)
          + Number(recipeItem.quantityBaseUnits),
      );
    }

    let otherCostMinor = Number(item.other_cost_minor);
    const componentSnapshots = [];
    for (const component of item.components ?? []) {
      const quantity = Number(component.quantity);
      const expanded = expandMenuItem(component.menuItemId, [...path, itemId]);
      for (const recipeItem of expanded.recipe) {
        recipeByStockItem.set(
          recipeItem.stockItemId,
          (recipeByStockItem.get(recipeItem.stockItemId) ?? 0)
            + recipeItem.quantityBaseUnits * quantity,
        );
      }
      otherCostMinor += expanded.otherCostMinor * quantity;
      componentSnapshots.push({
        menuItemId: expanded.item.id,
        name: expanded.item.name,
        itemType: expanded.item.item_type,
        quantity,
        unitPriceMinor: Number(expanded.item.price_minor),
        components: expanded.componentSnapshots,
      });
    }

    return {
      item,
      recipe: [...recipeByStockItem].map(([stockItemId, quantityBaseUnits]) => ({
        stockItemId,
        quantityBaseUnits,
      })),
      otherCostMinor,
      componentSnapshots,
    };
  }

  const extraStockItemIds = new Set();
  for (const line of input.items) {
    for (const extra of line.extras || []) {
      if (extra?.stockItemId) extraStockItemIds.add(extra.stockItemId);
    }
  }

  const extraStockItemsById = new Map();
  if (extraStockItemIds.size > 0) {
    const extraItemsRes = await client.query(
      `SELECT id, name, base_unit, sell_unit, base_units_per_sell_unit
         FROM stock_items
        WHERE restaurant_id = $1 AND id = ANY($2::uuid[]) AND is_active = true`,
      [restaurantId, [...extraStockItemIds]],
    );
    for (const row of extraItemsRes.rows) {
      extraStockItemsById.set(row.id, row);
    }
    for (const line of input.items) {
      for (const extra of line.extras || []) {
        if (!extraStockItemsById.has(extra.stockItemId)) {
          throw apiError("One or more extra ingredients are no longer available.", "EXTRA_UNAVAILABLE", 409);
        }
        const qty = Number(extra.quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw apiError("Extra ingredient quantity must be positive.", "INVALID_EXTRA_QUANTITY", 400);
        }
      }
    }
  }

  const menuLines = input.items.map((line) => {
    const expanded = expandMenuItem(line.menuItemId);
    const item = expanded.item;
    const pricing = effectiveItemPrice(item);
    const preparedExtras = (line.extras || []).map((extra) => {
      const def = extraStockItemsById.get(extra.stockItemId);
      const qtyPerItemBaseUnits = resolveExtraBaseUnitsPerItem(extra, def);
      const totalBaseUnits = qtyPerItemBaseUnits * Number(line.quantity);
      return {
        stockItemId: extra.stockItemId,
        nameSnapshot: def.name,
        quantityBaseUnits: totalBaseUnits,
        quantityBaseUnitsPerItem: qtyPerItemBaseUnits,
        priceMinor: Number(extra.priceMinor) || 0,
      };
    });
    return {
      ...line,
      name: item.name,
      priceMinor: pricing.priceMinor,
      offer: pricing.offer,
      otherCostMinor: expanded.otherCostMinor,
      recipe: expanded.recipe,
      componentSnapshots: expanded.componentSnapshots,
      extras: preparedExtras,
    };
  });

  await freezeInventoryRecipes(client, restaurantId, menuLines, byId);
  const stockUsage = new Map();
  for (const line of menuLines) {
    for (const recipeItem of line.recipe) {
      const quantity = Number(recipeItem.quantityBaseUnits) * line.quantity;
      stockUsage.set(
        recipeItem.stockItemId,
        (stockUsage.get(recipeItem.stockItemId) ?? 0) + quantity,
      );
    }
    for (const extra of line.extras || []) {
      stockUsage.set(
        extra.stockItemId,
        (stockUsage.get(extra.stockItemId) ?? 0) + extra.quantityBaseUnits,
      );
    }
  }
  const stockIds = [...stockUsage.keys()];
  for (const stockItemId of [...stockIds].sort()) await client.query(`INSERT INTO inventory_balances
    (restaurant_id, branch_id, stock_item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [restaurantId, branchId, stockItemId]);
  const stockResult = stockIds.length
    ? await client.query(
        `SELECT stock_item_id, quantity_base_units,
                average_cost_minor_per_base_unit
           FROM inventory_balances
          WHERE branch_id = $1 AND stock_item_id = ANY($2::uuid[])
          ORDER BY stock_item_id FOR UPDATE`,
        [branchId, stockIds],
      )
    : { rows: [] };
  const stockById = new Map(stockResult.rows.map((row) => [row.stock_item_id, row]));
  const legacyWarnings = [];
  const skippedDeductions = [];
  let hasIncompleteCosting = false;

  for (const [stockItemId, required] of stockUsage) {
    const balance = stockById.get(stockItemId);
    if (!balance) {
      hasIncompleteCosting = true;
      skippedDeductions.push({ stockItemId, required, reason: "missing_stock_balance" });
      legacyWarnings.push({ type: "missing_stock_balance", stockItemId, required });
      continue;
    }
    if (Number(balance.quantity_base_units) < required) {
      legacyWarnings.push({ type: "negative_stock", stockItemId, quantityAfter: Number(balance.quantity_base_units) - required });
    }
  }

  for (const line of menuLines) {
    const hasLegacyRecipe = line.recipe && line.recipe.length > 0;
    const hasInvRecipe = line.inventoryRecipe && line.inventoryRecipe.length > 0;
    if (!hasLegacyRecipe && !hasInvRecipe) {
      hasIncompleteCosting = true;
      skippedDeductions.push({ menuItemId: line.menuItemId, name: line.name, quantity: line.quantity, reason: "missing_recipe" });
    }
    if (line.skippedInventoryUsage?.length) {
      hasIncompleteCosting = true;
      for (const sk of line.skippedInventoryUsage) {
        skippedDeductions.push({ menuItemId: line.menuItemId, name: line.name, quantity: line.quantity, inventoryItemId: sk.inventoryItemId, reason: sk.reason });
      }
    }
    if (line.incompleteCosting) {
      hasIncompleteCosting = true;
    }

    const recipeUnitCostMinor = (line.recipe || []).reduce((sum, recipeItem) => {
      const balance = stockById.get(recipeItem.stockItemId);
      if (!balance || balance.average_cost_minor_per_base_unit == null) {
        hasIncompleteCosting = true;
        return sum;
      }
      return sum + (
        Number(recipeItem.quantityBaseUnits)
        * Number(balance.average_cost_minor_per_base_unit)
      );
    }, 0);

    let extrasUnitCostMinor = 0;
    for (const extra of line.extras || []) {
      const balance = stockById.get(extra.stockItemId);
      if (!balance || balance.average_cost_minor_per_base_unit == null) {
        hasIncompleteCosting = true;
        extra.costMinor = 0;
      } else {
        const costPerBaseUnit = Number(balance.average_cost_minor_per_base_unit);
        const unitCost = Math.round(costPerBaseUnit * extra.quantityBaseUnitsPerItem);
        const totalCost = Math.round(costPerBaseUnit * extra.quantityBaseUnits);
        extra.costMinor = totalCost;
        extrasUnitCostMinor += unitCost;
      }
    }

    line.unitCostMinor = Math.round(recipeUnitCostMinor + extrasUnitCostMinor + (line.inventoryUnitCostMinor ?? 0) + (line.otherCostMinor ?? 0));
  }

  return { menuLines, stockUsage, stockById, legacyWarnings, skippedDeductions, hasIncompleteCosting };
}

export function createOrderService(
  pool,
  {
    clock = () => new Date(),
    inventoryConsumption = null,
    kitchenService = null,
  } = {},
) {
  // The inventory consumption service is shared so the
  // order service and the HTTP layer use one instance.
  // It defaults to a pool-backed instance so the order
  // service also works standalone.
  const consumeInventory = inventoryConsumption
    ?? createInventoryConsumptionService(pool, { clock });
  return Object.freeze({
    async create({ tenant, userId, input }) {
      const restaurantId = tenant.restaurant.id;
      const branchId = tenant.membership.defaultBranchId;
      const canViewReports = tenant?.membership?.role ? hasPermission(tenant.membership.role, PERMISSION.REPORT_VIEW) : true;
      const requestHash = computeRequestHash(input);
      const now = clock();
      const today = businessDateInTimezone(now, tenant.restaurant.timezone ?? "UTC");
      const businessDate = input.businessDate ?? today;
      if (businessDate > today) {
        throw apiError("Order date cannot be in the future.", "FUTURE_ORDER_DATE");
      }

      // Filled inside the transaction once the order reaches
      // its authoritative completed state.
      let inventoryConsumption = null;

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            [input.idempotencyKey],
          );
          const existing = await client.query(
            `SELECT id, order_number, order_type, order_status, payment_status,
                    subtotal_minor, discount_minor, delivery_minor,
                    additional_charges_minor, total_minor, cost_of_goods_minor,
                    incomplete_costing, skipped_stock_deductions,
                    business_date, ordered_at,
                    request_hash
               FROM orders
              WHERE idempotency_key = $1`,
            [input.idempotencyKey],
          );
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash && existing.rows[0].request_hash !== requestHash) {
              throw apiError(
                "Idempotency key was previously used with a different request payload.",
                "IDEMPOTENCY_CONFLICT",
                409,
              );
            }
            return { order: publicOrder(existing.rows[0], canViewReports), replayed: true };
          }

          const { menuLines, stockUsage, stockById, legacyWarnings, skippedDeductions, hasIncompleteCosting } =
            await prepareOrderLines(client, { restaurantId, branchId, businessDate, input });

          const pricing = MoneyEngine.calculate(pricingInput(menuLines, input));
          if (input.expectedTotalMinor !== undefined && input.expectedTotalMinor !== pricing.minor.total) throw apiError("Menu prices changed. Refresh the catalog and check the bill before taking payment.", "PRICE_CHANGED", 409);
          const paymentMinor = input.payment?.amountReceivedMinor ?? 0;
          if (paymentMinor > pricing.minor.total) {
            throw apiError("Payment cannot exceed the order total.", "PAYMENT_EXCEEDS_TOTAL");
          }
          const paymentStatus =
            paymentMinor <= 0
              ? "unpaid"
              : paymentMinor >= pricing.minor.total
                ? "paid"
                : "partially_paid";
          const costOfGoodsMinor = menuLines.reduce(
            (sum, line) => sum + line.unitCostMinor * line.quantity,
            0,
          );
          const orderId = input.orderId || randomUUID();
          const sequenceResult = await client.query(
            `INSERT INTO order_sequences (restaurant_id, branch_id, next_number)
             VALUES ($1, $2, 2)
             ON CONFLICT (restaurant_id, branch_id)
             DO UPDATE SET next_number = order_sequences.next_number + 1
             RETURNING next_number - 1 AS order_number`,
            [restaurantId, branchId],
          );
          const orderNumber = Number(sequenceResult.rows[0].order_number);
          let kitchenTicket = null;
          // Posting a POS invoice completes the financial sale. Kitchen tickets
          // have their own fulfillment status; open-order callers can explicitly
          // request "new" or "in_progress" without making finalized sales disappear from reports.
          const initialOrderStatus = input.orderStatus ?? (input.isKot ? "preparing" : "completed");
          const orderResult = await client.query(
            `INSERT INTO orders (
               id, restaurant_id, branch_id, idempotency_key, order_number,
               order_type, order_status, payment_status, table_id,
               customer_name, customer_phone, rider_name,
               subtotal_minor, discount_type, discount_value, discount_minor,
               delivery_minor, additional_charges_minor, total_minor,
               cost_of_goods_minor, business_date, ordered_at, completed_at,
               created_by_user_id, updated_by_user_id, request_hash,
               incomplete_costing, skipped_stock_deductions
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, $23, $7, $8,
               $9, $10, $11,
               $12, $13, $14, $15,
               $16, $17, $18,
               $19, $20, $21, $25,
               $22, $22, $24,
               $26, $27
             )
             RETURNING id, order_number, order_type, order_status, payment_status,
                       subtotal_minor, discount_minor, delivery_minor,
                       additional_charges_minor, total_minor, cost_of_goods_minor,
                       incomplete_costing, skipped_stock_deductions,
                       business_date, ordered_at`,
            [
              orderId, restaurantId, branchId, input.idempotencyKey, orderNumber,
              input.orderType, paymentStatus, input.tableId ?? null,
              input.customerName ?? null, input.customerPhone ?? null,
              input.orderType === "delivery" ? input.riderName ?? null : null,
              pricing.minor.subtotal, input.discount?.type ?? null,
              input.discount?.type === "flat"
                ? (input.discount.valueMinor ?? 0) / 100
                : input.discount?.value ?? 0,
              pricing.minor.discount, pricing.minor.delivery,
              pricing.minor.additionalCharges, pricing.minor.total,
              costOfGoodsMinor, businessDate, now, userId,
              initialOrderStatus, requestHash,
              initialOrderStatus === "completed" ? now : null,
              hasIncompleteCosting, JSON.stringify(skippedDeductions),
            ],
          );

          for (let index = 0; index < menuLines.length; index += 1) {
            const line = menuLines[index];
            const lineId = randomUUID();
            await client.query(
              `INSERT INTO order_items (
                 id, restaurant_id, order_id, menu_item_id, item_name_snapshot,
                 quantity, unit_price_minor, line_total_minor, unit_cost_minor,
                 recipe_snapshot, sort_order
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                lineId, restaurantId, orderId, line.menuItemId, line.name,
                line.quantity, line.priceMinor, line.priceMinor * line.quantity,
                line.unitCostMinor,
                JSON.stringify({
                  version: 2,
                  items: line.recipe || [],
                  inventoryItems: line.inventoryRecipe || [],
                  components: line.componentSnapshots || [],
                  offer: line.offer,
                  ...(line.skippedInventoryUsage?.length ? { skippedDeductions: line.skippedInventoryUsage } : {}),
                  ...(line.incompleteCosting ? { incompleteCosting: true } : {}),
                }),
                index,
              ],
            );

            for (const extra of line.extras || []) {
              await client.query(
                `INSERT INTO order_item_extras (
                   id, restaurant_id, order_item_id, stock_item_id,
                   name_snapshot, quantity_base_units, price_minor, cost_minor
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                  randomUUID(), restaurantId, lineId, extra.stockItemId,
                  extra.nameSnapshot, extra.quantityBaseUnits, extra.priceMinor, extra.costMinor,
                ],
              );
            }
          }

          for (const charge of pricing.additionalCharges) {
            await client.query(
              `INSERT INTO order_charges (
                 id, restaurant_id, order_id, name, charge_type, charge_value, amount_minor
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                randomUUID(), restaurantId, orderId, charge.name, charge.type,
                charge.type === "flat" ? Math.round(charge.value * 100) : charge.value,
                Math.round(charge.amount * 100),
              ],
            );
          }

          if (initialOrderStatus === "completed") {
            for (const [stockItemId, required] of stockUsage) {
              if (!stockById.has(stockItemId)) continue;
              await client.query(
                `UPDATE inventory_balances
                     SET quantity_base_units = quantity_base_units - $4,
                         version = version + 1, updated_at = $5
                   WHERE restaurant_id = $1 AND branch_id = $2 AND stock_item_id = $3`,
                [restaurantId, branchId, stockItemId, required, now],
              );
              await client.query(
                `INSERT INTO stock_movements (
                   id, restaurant_id, branch_id, stock_item_id, order_id,
                   movement_type, quantity_delta, idempotency_key, occurred_at,
                   created_by_user_id
                 ) VALUES ($1, $2, $3, $4, $5, 'sale', $6, $7, $8, $9)`,
                [
                  randomUUID(), restaurantId, branchId, stockItemId, orderId,
                  -required, randomUUID(), now, userId,
                ],
              );
            }

            inventoryConsumption = await consumeInventory.consumeWithinTransaction(
              client,
              {
                restaurantId,
                orderId,
                lines: menuLines,
                userId,
                now,
              },
            );
            inventoryConsumption.warnings.push(...legacyWarnings);
          } else {
            inventoryConsumption = { replayed: false, consumedItemCount: 0, warnings: legacyWarnings, movements: [] };
          }

          inventoryConsumption.warnings.push(...legacyWarnings);
          if (paymentMinor > 0) {
            let accountId = input.payment.financialAccountId ?? null;
            if (accountId) {
              const accountResult = await client.query(
                `SELECT id, account_type FROM financial_accounts
                  WHERE id = $1 AND (branch_id IS NULL OR branch_id = $2)
                    AND is_active = true`,
                [accountId, branchId],
              );
              const account = accountResult.rows[0];
              const expectedType = input.payment.method === "bank_account"
                ? "bank"
                : input.payment.method === "cash" ? "cash" : null;
              if (!account || (expectedType && account.account_type !== expectedType)) {
                throw apiError(
                  "The selected payment account is not available for this payment method.",
                  "INVALID_PAYMENT_ACCOUNT",
                  422,
                );
              }
            }
            if (!accountId && input.payment.method === "cash") {
              const accountResult = await client.query(
                `SELECT id FROM financial_accounts
                  WHERE branch_id = $1 AND account_type = 'cash' AND is_active = true
                  ORDER BY created_at LIMIT 1`,
                [branchId],
              );
              accountId = accountResult.rows[0]?.id ?? null;
            }
            if (["cash", "bank_account"].includes(input.payment.method) && !accountId) {
              throw apiError(
                "An active financial account is required for this payment.",
                "PAYMENT_ACCOUNT_REQUIRED",
                422,
              );
            }
            const paymentId = randomUUID();
            await client.query(
              `INSERT INTO order_payments (
                 id, restaurant_id, order_id, financial_account_id,
                 payment_method, status, amount_minor, idempotency_key,
                 received_at, created_by_user_id
               ) VALUES ($1, $2, $3, $4, $5, 'captured', $6, $7, $8, $9)`,
              [
                paymentId, restaurantId, orderId, accountId,
                input.payment.method, paymentMinor, randomUUID(), now, userId,
              ],
            );
            if (accountId) {
              await client.query(
                `INSERT INTO ledger_entries (
                   id, restaurant_id, branch_id, financial_account_id,
                   order_payment_id, entry_type, amount_minor, description,
                   source_type, source_key, occurred_at
                 ) VALUES ($1, $2, $3, $4, $5, 'credit', $6, $7, 'sale', $8, $9)`,
                [
                  randomUUID(), restaurantId, branchId, accountId, paymentId,
                  paymentMinor, `Sale / Order #${orderNumber}`,
                  `sale:${orderId}:${paymentId}`, now,
                ],
              );
            }
          }

          if (kitchenService && input.sendToKitchen !== false && menuLines.length > 0) {
            kitchenTicket = await kitchenService.createTicketForOrder(client, {
              restaurantId,
              branchId,
              orderId,
              items: menuLines.map((line) => ({
                menuItemId: line.menuItemId,
                name: line.name,
                quantity: line.quantity,
                extras: (line.extras || []).map((e) => ({
                  stockItemId: e.stockItemId,
                  name: e.nameSnapshot,
                  quantity: e.quantityBaseUnits,
                })),
                notes: line.notes || null,
              })),
              notes: input.kitchenNotes || input.notes || null,
              station: input.station || "kitchen",
            });
          }

          return {
            order: publicOrder(orderResult.rows[0], canViewReports),
            ...(kitchenTicket ? { kitchenTicket } : {}),
            replayed: false,
            inventoryConsumption,
          };
        },
      );
    },

    async paymentAccounts({ tenant, userId }) {
      const restaurantId = tenant.restaurant.id;
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        const result = await client.query(`SELECT id, display_name, account_type FROM financial_accounts
          WHERE restaurant_id=$1 AND is_active=true AND (branch_id IS NULL OR branch_id=$2)
          ORDER BY account_type, display_name, id`, [restaurantId, tenant.membership.defaultBranchId]);
        return { accounts: result.rows.map(row => ({id:row.id, displayName:row.display_name, accountType:row.account_type})) };
      });
    },

    async settlePayment({ tenant, userId, orderId, input }) {
      const restaurantId = tenant.restaurant.id;
      const canViewReports = tenant?.membership?.role ? hasPermission(tenant.membership.role, PERMISSION.REPORT_VIEW) : true;
      const now = clock();

      return withTenantTransaction(
        pool,
        { restaurantId, userId },
        async (client) => {
          if (input.idempotencyKey) {
            await client.query(
              "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
              [input.idempotencyKey],
            );
            const existingPayment = await client.query(
              `SELECT id, order_id, financial_account_id, amount_minor, payment_method, status, received_at
                 FROM order_payments
                WHERE restaurant_id = $1 AND idempotency_key = $2`,
              [restaurantId, input.idempotencyKey],
            );
            if (existingPayment.rows[0]) {
              const previous = existingPayment.rows[0];
              if (previous.order_id !== orderId || Number(previous.amount_minor) !== input.amountMinor
                  || previous.payment_method !== input.paymentMethod
                  || (input.financialAccountId && previous.financial_account_id !== input.financialAccountId)) {
                throw apiError("This retry key belongs to another payment.", "IDEMPOTENCY_CONFLICT", 409);
              }
              const orderRes = await client.query(
                `SELECT id, order_number, order_type, order_status, payment_status,
                        subtotal_minor, discount_minor, delivery_minor,
                        additional_charges_minor, total_minor, cost_of_goods_minor,
                        business_date, ordered_at
                   FROM orders
                  WHERE restaurant_id = $1 AND id = $2`,
                [restaurantId, orderId],
              );
              return {
                payment: {
                  id: existingPayment.rows[0].id,
                  orderId: existingPayment.rows[0].order_id,
                  amountMinor: Number(existingPayment.rows[0].amount_minor),
                  paymentMethod: existingPayment.rows[0].payment_method,
                  status: existingPayment.rows[0].status,
                  receivedAt: existingPayment.rows[0].received_at,
                },
                order: publicOrder(orderRes.rows[0], canViewReports),
                replayed: true,
              };
            }
          }

          const orderResult = await client.query(
            `SELECT id, order_number, order_type, order_status, payment_status,
                    subtotal_minor, discount_minor, delivery_minor,
                    additional_charges_minor, total_minor, cost_of_goods_minor,
                    business_date, ordered_at, restore_key, branch_id
               FROM orders
              WHERE restaurant_id = $1 AND id = $2
              FOR UPDATE`,
            [restaurantId, orderId],
          );
          const order = orderResult.rows[0];
          if (!order) {
            throw apiError("Order not found.", "ORDER_NOT_FOUND", 404);
          }
          const branchId = order.branch_id;
          if (order.restore_key) throw apiError("This historical bill is read-only; reconcile its original payments before making adjustments.", "HISTORICAL_ORDER_READ_ONLY", 409);
          if (order.order_status === "cancelled") {
            throw apiError("Cannot settle payment for a cancelled order.", "ORDER_CANCELLED", 409);
          }

          const paymentsResult = await client.query(
            `SELECT COALESCE(SUM(amount_minor), 0) AS total_paid
               FROM order_payments
              WHERE restaurant_id = $1 AND order_id = $2 AND status = 'captured'`,
            [restaurantId, orderId],
          );
          const totalPaid = Number(paymentsResult.rows[0].total_paid);
          const totalMinor = Number(order.total_minor);
          const remainingMinor = Math.max(0, totalMinor - totalPaid);

          if (remainingMinor <= 0 || order.payment_status === "paid") {
            throw apiError("Order is already fully paid.", "ORDER_ALREADY_PAID", 409);
          }

          const amountMinor = Number(input.amountMinor);
          if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
            throw apiError("Settlement amount must be a positive integer.", "INVALID_AMOUNT", 400);
          }
          if (amountMinor > remainingMinor) {
            throw apiError(
              `Payment amount (${amountMinor}) exceeds remaining balance (${remainingMinor}).`,
              "PAYMENT_EXCEEDS_REMAINING",
              409,
              { remainingMinor, requestedMinor: amountMinor },
            );
          }

          let accountId = input.financialAccountId ?? null;
          if (accountId) {
            const accRes = await client.query(
              `SELECT id, account_type FROM financial_accounts
                WHERE id = $1 AND restaurant_id = $2 AND (branch_id IS NULL OR branch_id = $3) AND is_active = true`,
              [accountId, restaurantId, branchId],
            );
            const acc = accRes.rows[0];
            const expectedType = input.paymentMethod === "bank_account" ? "bank" : input.paymentMethod === "cash" ? "cash" : null;
            if (!acc || (expectedType && acc.account_type !== expectedType)) {
              throw apiError("The selected payment account is not available for this payment method.", "INVALID_PAYMENT_ACCOUNT", 422);
            }
          }
          if (!accountId && input.paymentMethod === "cash") {
            const accRes = await client.query(
              `SELECT id FROM financial_accounts
                WHERE restaurant_id = $1 AND branch_id = $2 AND account_type = 'cash' AND is_active = true
                ORDER BY created_at LIMIT 1`,
              [restaurantId, branchId],
            );
            accountId = accRes.rows[0]?.id ?? null;
          }
          if (["cash", "bank_account"].includes(input.paymentMethod) && !accountId) {
            throw apiError("An active financial account is required for this payment.", "PAYMENT_ACCOUNT_REQUIRED", 422);
          }

          const paymentId = randomUUID();
          await client.query(
            `INSERT INTO order_payments (
               id, restaurant_id, order_id, financial_account_id,
               payment_method, status, amount_minor, idempotency_key,
               received_at, created_by_user_id
             ) VALUES ($1, $2, $3, $4, $5, 'captured', $6, $7, $8, $9)`,
            [
              paymentId, restaurantId, orderId, accountId,
              input.paymentMethod, amountMinor, input.idempotencyKey, now, userId,
            ],
          );
          if (accountId) {
            await client.query(
              `INSERT INTO ledger_entries (
                 id, restaurant_id, branch_id, financial_account_id,
                 order_payment_id, entry_type, amount_minor, description,
                 source_type, source_key, occurred_at
               ) VALUES ($1, $2, $3, $4, $5, 'credit', $6, $7, 'sale', $8, $9)`,
              [
                randomUUID(), restaurantId, branchId, accountId, paymentId,
                amountMinor, `Settlement / Order #${order.order_number}`,
                `settlement:${orderId}:${paymentId}`, now,
              ],
            );
          }

          const newTotalPaid = totalPaid + amountMinor;
          const newPaymentStatus = newTotalPaid >= totalMinor ? "paid" : "partially_paid";
          const becomesCompleted = newPaymentStatus === "paid" && order.order_status !== "completed";
          const updatedOrderStatus = becomesCompleted ? "completed" : order.order_status;
          const updatedOrderRes = await client.query(
            `UPDATE orders
                SET payment_status = $3,
                    order_status = $4,
                    completed_at = CASE WHEN $4 = 'completed' AND completed_at IS NULL THEN $5 ELSE completed_at END,
                    version = version + 1, updated_by_user_id = $6, updated_at = $5
              WHERE restaurant_id = $1 AND id = $2
              RETURNING id, order_number, order_type, order_status, payment_status,
                        subtotal_minor, discount_minor, delivery_minor,
                        additional_charges_minor, total_minor, cost_of_goods_minor,
                        incomplete_costing, skipped_stock_deductions,
                        business_date, ordered_at`,
            [restaurantId, orderId, newPaymentStatus, updatedOrderStatus, now, userId],
          );

          if (becomesCompleted && consumeInventory) {
            const existingConsumption = await client.query(
              `SELECT id FROM inventory_consumptions WHERE restaurant_id = $1 AND order_id = $2`,
              [restaurantId, orderId],
            );
            if (existingConsumption.rowCount === 0) {
              const orderItemsRes = await client.query(
                `SELECT id, menu_item_id, quantity, recipe_snapshot
                   FROM order_items
                  WHERE restaurant_id = $1 AND order_id = $2`,
                [restaurantId, orderId],
              );
              const lines = orderItemsRes.rows.map(row => ({
                id: row.id,
                menuItemId: row.menu_item_id,
                quantity: row.quantity,
                inventoryRecipe: row.recipe_snapshot?.inventoryItems || [],
                recipe: row.recipe_snapshot?.items || [],
              }));
              // Match checkout/cancellation lock ordering: migrated inventory
              // first, then sorted legacy balances, across concurrent orders.
              await consumeInventory.consumeWithinTransaction(client, {
                restaurantId,
                orderId,
                lines,
                userId,
                now,
              });
              // KOT defers both stock systems until final settlement. Use the
              // original recipe snapshots, never today's recipe definitions.
              const legacyUsage = new Map();
              for (const line of lines) for (const recipe of line.recipe) legacyUsage.set(recipe.stockItemId,
                (legacyUsage.get(recipe.stockItemId) || 0) + Number(recipe.quantityBaseUnits) * Number(line.quantity));
              const itemIds = orderItemsRes.rows.map((r) => r.id);
              if (itemIds.length > 0) {
                const extrasRes = await client.query(
                  `SELECT stock_item_id, quantity_base_units
                     FROM order_item_extras
                    WHERE restaurant_id = $1 AND order_item_id = ANY($2::uuid[])`,
                  [restaurantId, itemIds],
                );
                for (const extra of extrasRes.rows) {
                  if (extra.stock_item_id) {
                    legacyUsage.set(
                      extra.stock_item_id,
                      (legacyUsage.get(extra.stock_item_id) || 0) + Number(extra.quantity_base_units),
                    );
                  }
                }
              }
              for (const [stockItemId, quantity] of [...legacyUsage].sort(([a],[b]) => a.localeCompare(b))) {
                const balance = await client.query(`UPDATE inventory_balances
                  SET quantity_base_units=quantity_base_units-$4, version=version+1, updated_at=$5
                  WHERE restaurant_id=$1 AND branch_id=$2 AND stock_item_id=$3 RETURNING stock_item_id`,
                  [restaurantId,branchId,stockItemId,quantity,now]);
                if (balance.rowCount) await client.query(`INSERT INTO stock_movements
                  (restaurant_id,branch_id,stock_item_id,order_id,movement_type,quantity_delta,idempotency_key,occurred_at,created_by_user_id)
                  VALUES($1,$2,$3,$4,'sale',$5,$6,$7,$8)`,
                  [restaurantId,branchId,stockItemId,orderId,-quantity,randomUUID(),now,userId]);
              }
            }
          }

          await client.query(`INSERT INTO order_edit_events (restaurant_id,order_id,actor_user_id,event_type,changes,note)
            VALUES($1,$2,$3,'payment',$4,'Payment received')`, [restaurantId,orderId,userId,JSON.stringify([
              {label:"Amount received",from:totalPaid,to:newTotalPaid},
              {label:"Payment status",from:order.payment_status,to:newPaymentStatus},
            ])]);
          return {
            payment: {
              id: paymentId,
              orderId,
              amountMinor,
              paymentMethod: input.paymentMethod,
              status: "captured",
              receivedAt: now,
            },
            order: publicOrder(updatedOrderRes.rows[0], canViewReports),
            remainingMinor: Math.max(0, totalMinor - newTotalPaid),
            replayed: false,
          };
        },
      );
    },
  });
}
