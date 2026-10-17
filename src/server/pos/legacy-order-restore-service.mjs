import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError, businessDateInTimezone } from "./business-date.mjs";

export const legacyOrderRestoreSchema = z.object({
  orders: z.array(z.record(z.string(), z.unknown())).min(1).max(250),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(message) { throw apiError(message, "INVALID_BACKUP_ORDER", 400); }
function money(value, label) {
  const amount = Number(value);
  if (value === null || value === "" || !Number.isFinite(amount) || amount < 0 || amount > 1e10) invalid(`${label} must be a non-negative amount.`);
  return Math.round(amount * 100);
}
function text(value, limit = 200) { return String(value ?? "").slice(0, limit); }

export function normalizeRestoredOrder(order, today) {
  const sourceId = text(order.id, 128);
  if (!sourceId || !["string", "number"].includes(typeof order.id)) invalid("Each historical bill needs its original ID.");
  const date = text(order.date, 10);
  const parsedDate = new Date(`${date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || date < "1900-01-01" || date > today) invalid(`Bill ${sourceId}: invalid or future bill date.`);
  const timeMatch = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(order.time || "00:00:00").trim());
  if (!timeMatch) invalid(`Bill ${sourceId}: invalid bill time.`);
  let hour = Number(timeMatch[1]);
  if (timeMatch[4]) {
    if (hour < 1 || hour > 12) invalid(`Bill ${sourceId}: invalid bill time.`);
    hour = hour % 12 + (timeMatch[4].toUpperCase() === "PM" ? 12 : 0);
  }
  if (hour > 23 || Number(timeMatch[2]) > 59 || Number(timeMatch[3] || 0) > 59) invalid(`Bill ${sourceId}: invalid bill time.`);
  const time = `${String(hour).padStart(2, "0")}:${timeMatch[2]}:${timeMatch[3] || "00"}`;
  const orderType = { "Dine-In": "dine_in", Takeaway: "takeaway", Delivery: "delivery", dine_in: "dine_in", takeaway: "takeaway", delivery: "delivery" }[order.orderType];
  if (!orderType) invalid(`Bill ${sourceId}: unsupported order type.`);
  const status = String(order.orderStatus || "completed").toLowerCase();
  if (!["completed", "cancelled"].includes(status)) invalid(`Bill ${sourceId}: only completed or cancelled historical bills can be restored.`);
  if (!Array.isArray(order.items) || !order.items.length || order.items.length > 500) invalid(`Bill ${sourceId}: items are missing or too numerous.`);
  const items = order.items.map(item => {
    if (!item || typeof item !== "object") invalid(`Bill ${sourceId}: invalid item record.`);
    const quantity = Number(item.qty);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6) invalid(`Bill ${sourceId}: invalid item quantity.`);
    const price = money(item.price, "Item price");
    const unitCost = item.unitCostAtSale == null ? 0 : money(item.unitCostAtSale, "Item cost");
    if (!Number.isSafeInteger(Math.round(price * quantity))) invalid(`Bill ${sourceId}: item total is too large.`);
    return { name: text(item.name || "Historical item"), quantity, price, unitCost,
      total: Math.round(price * quantity), notes: text(item.notes, 2000) };
  });
  const subtotal = order.subtotal == null ? items.reduce((sum, item) => sum + item.total, 0) : money(order.subtotal, "Subtotal");
  const discount = money(order.discountAmount ?? 0, "Discount");
  const delivery = money(order.deliveryCharges ?? 0, "Delivery");
  const charges = money(order.additionalChargesTotal ?? 0, "Additional charges");
  const total = money(order.totalBill, "Bill total");
  if (discount > subtotal || subtotal - discount + delivery + charges !== total) invalid(`Bill ${sourceId}: recorded bill totals do not reconcile. No bills were imported.`);
  const cost = order.costOfGoods == null ? 0 : money(order.costOfGoods, "Recorded cost");
  const incompleteCosting = order.incompleteCosting === true || !order.costSnapshotVersion || order.costSnapshotSource === "legacy_estimate"
    || order.costOfGoods == null || order.items.some(item => item.unitCostAtSale == null)
    || Math.round(items.reduce((sum, item) => sum + item.unitCost * item.quantity, 0)) !== cost;
  const paymentStatus = String(order.paymentStatus || "Paid").toLowerCase();
  if (!["paid", "unpaid", "partially_paid"].includes(paymentStatus)) invalid(`Bill ${sourceId}: unsupported payment status.`);
  const paid = status === "cancelled" || paymentStatus === "unpaid" ? 0 : paymentStatus === "paid" ? total : Math.min(total, money(order.amountReceived ?? 0, "Amount received"));
  const paymentMethod = order.paymentMethod === "Cash" || order.paymentMethod === "cash" ? "cash" : "other";
  return { sourceId, date, time, orderType, status, paymentStatus, subtotal, discount, delivery, charges, total, cost, incompleteCosting,
    customerName: text(order.customerName), customerPhone: text(order.customerPhone, 80), riderName: text(order.riderName),
    tableNumber: text(order.tableNumber, 80), paid, paymentMethod, items };
}

export function createLegacyOrderRestoreService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    async restore({ tenant, userId, orders }) {
      const restaurantId = tenant.restaurant.id, branchId = tenant.membership.defaultBranchId;
      const timezone = tenant.restaurant.timezone || "Asia/Karachi";
      const records = legacyOrderRestoreSchema.parse({ orders }).orders.map(order => normalizeRestoredOrder(order, businessDateInTimezone(clock(), timezone)));
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`restore-orders:${restaurantId}:${branchId}`]);
        let imported = 0, skipped = 0;
        for (const record of records) {
          const restoreKey = `${branchId}:${record.date}:${record.sourceId}`;
          const hash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
          const existing = (await client.query(`SELECT id, restore_hash FROM orders WHERE restaurant_id=$1 AND branch_id=$2
            AND (restore_key=$3 OR ($4::uuid IS NOT NULL AND id=$4::uuid))`, [restaurantId, branchId, restoreKey, UUID.test(record.sourceId) ? record.sourceId : null])).rows[0];
          if (existing) {
            if (existing.restore_hash && existing.restore_hash !== hash) throw apiError(`Historical bill ${record.sourceId} was already restored with different details. Existing data was kept.`, "RESTORE_ORDER_CONFLICT", 409);
            skipped++; continue;
          }
          // Use the live sequence lock so imports and simultaneous checkout never
          // collide. Preserve the backup's number as provenance, not a new sale ID.
          const sequence = (await client.query(`INSERT INTO order_sequences (restaurant_id, branch_id, next_number)
            VALUES ($1,$2,2) ON CONFLICT (restaurant_id,branch_id) DO UPDATE SET next_number=order_sequences.next_number+1
            RETURNING next_number-1 AS number`, [restaurantId, branchId])).rows[0];
          const id = randomUUID();
          await client.query(`INSERT INTO orders (id,restaurant_id,branch_id,order_number,order_type,order_status,payment_status,
            customer_name,customer_phone,rider_name,subtotal_minor,discount_minor,delivery_minor,additional_charges_minor,total_minor,
            cost_of_goods_minor,business_date,ordered_at,completed_at,cancelled_at,created_by_user_id,updated_by_user_id,idempotency_key,
            incomplete_costing,restore_key,restore_hash,restore_metadata)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::date,
            ($17::date+$18::time) AT TIME ZONE $19,
            CASE WHEN $6='completed' THEN ($17::date+$18::time) AT TIME ZONE $19 ELSE NULL END,
            CASE WHEN $6='cancelled' THEN ($17::date+$18::time) AT TIME ZONE $19 ELSE NULL END,
            $20,$20,$21,$22,$23,$24,$25)`,
          [id,restaurantId,branchId,sequence.number,record.orderType,record.status,record.paymentStatus,
            record.customerName,record.customerPhone,record.riderName,record.subtotal,record.discount,record.delivery,record.charges,record.total,
            record.cost,record.date,record.time,timezone,userId,randomUUID(),record.incompleteCosting,restoreKey,hash,
            JSON.stringify({ originalNumber: record.sourceId, tableNumber: record.tableNumber, source: "legacy-backup", financialReconciliationRequired: true })]);
          for (let index=0; index<record.items.length; index++) {
            const item=record.items[index];
            await client.query(`INSERT INTO order_items (restaurant_id,order_id,item_name_snapshot,quantity,unit_price_minor,line_total_minor,unit_cost_minor,notes,sort_order)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [restaurantId,id,item.name,item.quantity,item.price,item.total,item.unitCost,item.notes,index]);
          }
          if (record.charges) await client.query(`INSERT INTO order_charges (restaurant_id,order_id,name,charge_type,charge_value,amount_minor)
            VALUES ($1,$2,'Historical additional charges','flat',$3,$4)`, [restaurantId,id,record.charges/100,record.charges]);
          if (record.paid) await client.query(`INSERT INTO order_payments (restaurant_id,order_id,payment_method,amount_minor,idempotency_key,received_at,created_by_user_id)
            VALUES ($1,$2,$3,$4,$5,($6::date+$7::time) AT TIME ZONE $8,$9)`, [restaurantId,id,record.paymentMethod,record.paid,randomUUID(),record.date,record.time,timezone,userId]);
          imported++;
        }
        await client.query(`INSERT INTO audit_logs (restaurant_id,actor_user_id,actor_type,action,resource_type,metadata)
          VALUES ($1,$2,'user','orders.backup_restored','orders',$3)`, [restaurantId,userId,JSON.stringify({ imported, skipped })]);
        // Restored sales are historical records. Never replay stock movements,
        // kitchen jobs or credits into today's live cash/bank ledger.
        return { imported, skipped, financialReconciliationRequired: true };
      });
    },
  });
}
