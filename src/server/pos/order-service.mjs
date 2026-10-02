import { randomUUID } from "node:crypto";
import { MoneyEngine } from "../../domain/money-engine.mjs";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";

function businessDateInTimezone(now, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function publicOrder(row) {
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
    businessDate: row.business_date,
    orderedAt: row.ordered_at,
  };
}

function apiError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}

function pricingInput(menuLines, input) {
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

export function createOrderService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    async create({ tenant, userId, input }) {
      const restaurantId = tenant.restaurant.id;
      const branchId = tenant.membership.defaultBranchId;
      const now = clock();
      const today = businessDateInTimezone(now, tenant.restaurant.timezone ?? "UTC");
      const businessDate = input.businessDate ?? today;
      if (businessDate > today) {
        throw apiError("Order date cannot be in the future.", "FUTURE_ORDER_DATE");
      }

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
                    additional_charges_minor, total_minor, business_date, ordered_at
               FROM orders
              WHERE idempotency_key = $1`,
            [input.idempotencyKey],
          );
          if (existing.rows[0]) {
            return { order: publicOrder(existing.rows[0]), replayed: true };
          }

          const requestedIds = input.items.map((item) => item.menuItemId);
          if (new Set(requestedIds).size !== requestedIds.length) {
            throw apiError("Duplicate menu items must be combined into one line.", "DUPLICATE_ORDER_ITEM");
          }
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

          const menuLines = input.items.map((line) => {
            const expanded = expandMenuItem(line.menuItemId);
            const item = expanded.item;
            const pricing = effectiveItemPrice(item);
            return {
              ...line,
              name: item.name,
              priceMinor: pricing.priceMinor,
              offer: pricing.offer,
              otherCostMinor: expanded.otherCostMinor,
              recipe: expanded.recipe,
              componentSnapshots: expanded.componentSnapshots,
            };
          });

          const stockUsage = new Map();
          for (const line of menuLines) {
            for (const recipeItem of line.recipe) {
              const quantity = Number(recipeItem.quantityBaseUnits) * line.quantity;
              stockUsage.set(
                recipeItem.stockItemId,
                (stockUsage.get(recipeItem.stockItemId) ?? 0) + quantity,
              );
            }
          }
          const stockIds = [...stockUsage.keys()];
          const stockResult = stockIds.length
            ? await client.query(
                `SELECT stock_item_id, quantity_base_units,
                        average_cost_minor_per_base_unit
                   FROM inventory_balances
                  WHERE branch_id = $1 AND stock_item_id = ANY($2::uuid[])
                  FOR UPDATE`,
                [branchId, stockIds],
              )
            : { rows: [] };
          const stockById = new Map(stockResult.rows.map((row) => [row.stock_item_id, row]));
          for (const [stockItemId, required] of stockUsage) {
            const balance = stockById.get(stockItemId);
            if (!balance || Number(balance.quantity_base_units) < required) {
              throw apiError(
                "Insufficient stock for this order.",
                "INSUFFICIENT_STOCK",
                409,
                { stockItemId },
              );
            }
          }

          for (const line of menuLines) {
            const recipeUnitCostMinor = line.recipe.reduce((sum, recipeItem) => {
              const balance = stockById.get(recipeItem.stockItemId);
              return sum + (
                Number(recipeItem.quantityBaseUnits)
                * Number(balance.average_cost_minor_per_base_unit)
              );
            }, 0);
            line.unitCostMinor = Math.round(recipeUnitCostMinor + line.otherCostMinor);
          }

          const pricing = MoneyEngine.calculate(pricingInput(menuLines, input));
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
          const orderId = randomUUID();
          const sequenceResult = await client.query(
            `INSERT INTO order_sequences (restaurant_id, branch_id, next_number)
             VALUES ($1, $2, 2)
             ON CONFLICT (restaurant_id, branch_id)
             DO UPDATE SET next_number = order_sequences.next_number + 1
             RETURNING next_number - 1 AS order_number`,
            [restaurantId, branchId],
          );
          const orderNumber = Number(sequenceResult.rows[0].order_number);
          const orderResult = await client.query(
            `INSERT INTO orders (
               id, restaurant_id, branch_id, idempotency_key, order_number,
               order_type, order_status, payment_status, table_id,
               customer_name, customer_phone, rider_name,
               subtotal_minor, discount_type, discount_value, discount_minor,
               delivery_minor, additional_charges_minor, total_minor,
               cost_of_goods_minor, business_date, ordered_at, completed_at,
               created_by_user_id, updated_by_user_id
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, 'completed', $7, $8,
               $9, $10, $11,
               $12, $13, $14, $15,
               $16, $17, $18,
               $19, $20, $21, $21,
               $22, $22
             )
             RETURNING id, order_number, order_type, order_status, payment_status,
                       subtotal_minor, discount_minor, delivery_minor,
                       additional_charges_minor, total_minor, business_date, ordered_at`,
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
                  items: line.recipe,
                  components: line.componentSnapshots,
                  offer: line.offer,
                }),
                index,
              ],
            );
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

          for (const [stockItemId, required] of stockUsage) {
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

          return { order: publicOrder(orderResult.rows[0]), replayed: false };
        },
      );
    },
  });
}
