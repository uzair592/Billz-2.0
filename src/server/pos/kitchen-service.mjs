import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";
import { apiError } from "./business-date.mjs";

const VALID_STATUSES = new Set(["new", "preparing", "ready", "served", "cancelled"]);

const ALLOWED_TRANSITIONS = {
  new: new Set(["preparing", "cancelled"]),
  preparing: new Set(["ready", "cancelled"]),
  ready: new Set(["served", "cancelled"]),
  served: new Set(),
  cancelled: new Set(),
};

export function createKitchenService(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    async listTickets({ restaurantId, userId, branchId, status = null, station = null }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async (client) => {
        let query = `
          SELECT kt.id, kt.ticket_number, kt.order_id, kt.station, kt.status,
                 kt.items, kt.notes, kt.created_at, kt.started_at, kt.ready_at,
                 kt.served_at, kt.cancelled_at,
                 o.order_number, o.order_type, o.table_id, o.customer_name,
                 rt.table_number AS table_name
            FROM kitchen_tickets kt
            JOIN orders o ON o.restaurant_id = kt.restaurant_id AND o.id = kt.order_id
            LEFT JOIN restaurant_tables rt ON rt.restaurant_id = o.restaurant_id AND rt.id = o.table_id
           WHERE kt.restaurant_id = $1
        `;
        const params = [restaurantId];
        let paramIndex = 2;

        if (branchId) {
          query += ` AND kt.branch_id = $${paramIndex++}`;
          params.push(branchId);
        }

        if (status) {
          query += ` AND kt.status = $${paramIndex++}`;
          params.push(status);
        } else {
          query += ` AND kt.status IN ('new', 'preparing', 'ready')`;
        }

        if (station) {
          query += ` AND kt.station = $${paramIndex++}`;
          params.push(station);
        }

        query += ` ORDER BY kt.created_at ASC`;

        const result = await client.query(query, params);
        return {
          tickets: result.rows.map((row) => ({
            id: row.id,
            ticketNumber: Number(row.ticket_number),
            orderId: row.order_id,
            orderNumber: Number(row.order_number),
            orderType: row.order_type,
            tableId: row.table_id,
            tableName: row.table_name || null,
            customerName: row.customer_name || null,
            station: row.station,
            status: row.status,
            items: row.items,
            notes: row.notes,
            createdAt: row.created_at,
            startedAt: row.started_at,
            readyAt: row.ready_at,
            servedAt: row.served_at,
            cancelledAt: row.cancelled_at,
          })),
        };
      });
    },

    async updateStatus({ restaurantId, userId, ticketId, status }) {
      if (!VALID_STATUSES.has(status)) {
        throw apiError(`Invalid kitchen ticket status: ${status}`, "INVALID_KITCHEN_STATUS", 400);
      }
      const now = clock();

      return withTenantTransaction(pool, { restaurantId, userId }, async (client) => {
        // Use the same order-before-ticket lock order as payment, edits and
        // cancellation. Concurrent stations must not overwrite a newer edit.
        const lookup = (await client.query(`SELECT order_id FROM kitchen_tickets WHERE restaurant_id=$1 AND id=$2`,
          [restaurantId,ticketId])).rows[0];
        if (!lookup) throw apiError("Kitchen ticket not found.", "TICKET_NOT_FOUND", 404);
        await client.query(`SELECT id FROM orders WHERE restaurant_id=$1 AND id=$2 FOR UPDATE`, [restaurantId,lookup.order_id]);
        const ticketResult = await client.query(
          `SELECT id, order_id, status FROM kitchen_tickets
            WHERE restaurant_id = $1 AND id = $2
            FOR UPDATE`,
          [restaurantId, ticketId],
        );
        const ticket = ticketResult.rows[0];
        if (!ticket) {
          throw apiError("Kitchen ticket not found.", "TICKET_NOT_FOUND", 404);
        }

        if (ticket.status === status) {
          return { ticketId, status, unchanged: true };
        }

        const allowed = ALLOWED_TRANSITIONS[ticket.status];
        if (!allowed || !allowed.has(status)) {
          throw apiError(
            `Cannot transition kitchen ticket from '${ticket.status}' to '${status}'.`,
            "INVALID_STATUS_TRANSITION",
            409,
          );
        }

        let timeColumn = null;
        if (status === "preparing") timeColumn = "started_at";
        else if (status === "ready") timeColumn = "ready_at";
        else if (status === "served") timeColumn = "served_at";
        else if (status === "cancelled") timeColumn = "cancelled_at";

        const updateSql = timeColumn
          ? `UPDATE kitchen_tickets
                SET status = $3, ${timeColumn} = $4
              WHERE restaurant_id = $1 AND id = $2
              RETURNING id, ticket_number, order_id, status, started_at, ready_at, served_at, cancelled_at`
          : `UPDATE kitchen_tickets
                SET status = $3
              WHERE restaurant_id = $1 AND id = $2
              RETURNING id, ticket_number, order_id, status, started_at, ready_at, served_at, cancelled_at`;

        const updateParams = timeColumn
          ? [restaurantId, ticketId, status, now]
          : [restaurantId, ticketId, status];

        const updated = (await client.query(updateSql, updateParams)).rows[0];

        // Synchronize underlying order status if all tickets for this order are ready/served/cancelled
        const siblingTickets = (
          await client.query(
            `SELECT status FROM kitchen_tickets WHERE restaurant_id = $1 AND order_id = $2`,
            [restaurantId, ticket.order_id],
          )
        ).rows;

        const allServed = siblingTickets.every((t) => t.status === "served");
        const allReadyOrServed = siblingTickets.every((t) => t.status === "ready" || t.status === "served");
        const anyPreparing = siblingTickets.some((t) => t.status === "preparing");

        let targetOrderStatus = null;
        if (allServed) targetOrderStatus = "served";
        else if (allReadyOrServed) targetOrderStatus = "ready";
        else if (anyPreparing || status === "preparing") targetOrderStatus = "preparing";

        if (targetOrderStatus) {
          await client.query(
            `UPDATE orders
                SET order_status = $3, version = version + 1, updated_at = $4
              WHERE restaurant_id = $1 AND id = $2 AND order_status NOT IN ('cancelled', 'completed')`,
            [restaurantId, ticket.order_id, targetOrderStatus, now],
          );
        }

        return {
          ticket: {
            id: updated.id,
            ticketNumber: Number(updated.ticket_number),
            orderId: updated.order_id,
            status: updated.status,
            startedAt: updated.started_at,
            readyAt: updated.ready_at,
            servedAt: updated.served_at,
            cancelledAt: updated.cancelled_at,
          },
        };
      });
    },

    async createTicketForOrder(client, { restaurantId, branchId, orderId, items, notes = null, station = "kitchen" }) {
      const seqResult = await client.query(
        `INSERT INTO kitchen_ticket_sequences (restaurant_id, branch_id, next_number)
         VALUES ($1, $2, 2)
         ON CONFLICT (restaurant_id, branch_id)
         DO UPDATE SET next_number = kitchen_ticket_sequences.next_number + 1
         RETURNING next_number - 1 AS ticket_number`,
        [restaurantId, branchId],
      );
      const ticketNumber = Number(seqResult.rows[0].ticket_number);
      const ticketId = randomUUID();

      const ticketResult = await client.query(
        `INSERT INTO kitchen_tickets (
           id, restaurant_id, branch_id, order_id, ticket_number,
           station, status, items, notes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'new', $7, $8)
         RETURNING id, ticket_number, status, created_at`,
        [
          ticketId,
          restaurantId,
          branchId,
          orderId,
          ticketNumber,
          station,
          JSON.stringify(items),
          notes,
        ],
      );

      return ticketResult.rows[0];
    },
  });
}
