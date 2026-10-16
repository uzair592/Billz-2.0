import { randomUUID } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";

function error(message, code, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}
function publicExpense(row) {
  return { id: row.id, categoryName: row.category_name, amountMinor: Number(row.amount_minor), description: row.description,
    businessDate: row.business_date instanceof Date ? row.business_date.toLocaleDateString("en-CA") : row.business_date, financialAccountId: row.financial_account_id };
}

export function createFinanceService(pool) {
  return Object.freeze({
    async accounts({ restaurantId, userId }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        const rows = (await client.query(`SELECT f.id, f.display_name, f.account_type,
          f.opening_balance_minor + COALESCE(sum(CASE WHEN l.entry_type = 'credit' THEN l.amount_minor ELSE -l.amount_minor END), 0) AS balance
          FROM financial_accounts f LEFT JOIN ledger_entries l ON l.financial_account_id = f.id AND l.restaurant_id = f.restaurant_id
          WHERE f.is_active = true GROUP BY f.id ORDER BY f.display_name, f.id`)).rows;
        return { accounts: rows.map(row => ({ id: row.id, displayName: row.display_name, accountType: row.account_type, balanceMinor: Number(row.balance) })) };
      });
    },
    async listExpenses({ restaurantId, userId, startDate, endDate, page = 1, limit = 50 }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        const values = [startDate, endDate];
        const total = (await client.query("SELECT count(*) AS count, COALESCE(sum(amount_minor), 0) AS total FROM expenses WHERE business_date BETWEEN $1::date AND $2::date", values)).rows[0];
        const rows = (await client.query(`SELECT e.id, e.amount_minor, e.description, e.business_date::text AS business_date, e.financial_account_id, c.name AS category_name
          FROM expenses e JOIN expense_categories c ON c.id = e.category_id AND c.restaurant_id = e.restaurant_id
          WHERE e.business_date BETWEEN $1::date AND $2::date ORDER BY e.business_date DESC, e.id DESC LIMIT $3 OFFSET $4`, [...values, limit, (page - 1) * limit])).rows;
        return { expenses: rows.map(publicExpense), totalCount: Number(total.count), totalMinor: Number(total.total), page, limit };
      });
    },
    async createExpense({ restaurantId, branchId, userId, input }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`expense:${restaurantId}:${input.idempotencyKey}`]);
        const previous = (await client.query(`SELECT e.*, e.business_date::text AS business_date, c.name AS category_name FROM expenses e
          JOIN expense_categories c ON c.id = e.category_id AND c.restaurant_id = e.restaurant_id WHERE e.idempotency_key = $1`, [input.idempotencyKey])).rows[0];
        if (previous) {
          if (Number(previous.amount_minor) !== input.amountMinor || previous.category_name !== input.categoryName
            || previous.business_date !== input.businessDate || (previous.description ?? "") !== (input.description ?? "")
            || previous.financial_account_id !== input.financialAccountId) throw error("The retry key belongs to a different expense.", "IDEMPOTENCY_CONFLICT");
          return { expense: publicExpense(previous), replayed: true };
        }
        const account = (await client.query("SELECT id FROM financial_accounts WHERE id = $1 AND is_active = true AND (branch_id IS NULL OR branch_id = $2) FOR SHARE", [input.financialAccountId, branchId])).rows[0];
        if (!account) throw error("Select an active account in this restaurant.", "ACCOUNT_NOT_FOUND", 404);
        const category = (await client.query(`INSERT INTO expense_categories (restaurant_id, name) VALUES ($1, $2)
          ON CONFLICT (restaurant_id, name) DO UPDATE SET is_active = true RETURNING id`, [restaurantId, input.categoryName])).rows[0];
        const id = randomUUID();
        const row = (await client.query(`INSERT INTO expenses (id, restaurant_id, branch_id, category_id, financial_account_id, amount_minor,
          description, business_date, occurred_at, created_by_user_id, idempotency_key)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10) RETURNING id, amount_minor, description, business_date::text AS business_date, financial_account_id`,
          [id, restaurantId, branchId, category.id, account.id, input.amountMinor, input.description ?? null, input.businessDate, userId, input.idempotencyKey])).rows[0];
        await client.query(`INSERT INTO ledger_entries (restaurant_id, branch_id, financial_account_id, expense_id, entry_type, amount_minor,
          description, source_type, source_key, occurred_at) VALUES ($1, $2, $3, $4, 'debit', $5, $6, 'expense', $7, now())`,
          [restaurantId, branchId, account.id, id, input.amountMinor, `Expense / ${input.categoryName}`, `expense:${id}`]);
        await client.query(`INSERT INTO audit_logs (restaurant_id, actor_user_id, actor_type, action, resource_type, resource_id, metadata)
          VALUES ($1, $2, 'user', 'expense.created', 'expense', $3, $4)`, [restaurantId, userId, id, JSON.stringify({ amountMinor: input.amountMinor, categoryId: category.id })]);
        return { expense: publicExpense({ ...row, category_name: input.categoryName }), replayed: false };
      });
    },
    async createTransfer({ restaurantId, branchId, userId, input }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`transfer:${restaurantId}:${input.idempotencyKey}`]);
        const previous = (await client.query(`SELECT l.* FROM ledger_entries l WHERE l.restaurant_id = $1 AND l.source_key = $2`, [restaurantId, `transfer:${input.idempotencyKey}:out`])).rows[0];
        if (previous) {
          return { replayed: true };
        }
        const fromAccount = (await client.query("SELECT id, display_name FROM financial_accounts WHERE id = $1 AND is_active = true AND (branch_id IS NULL OR branch_id = $2) FOR UPDATE", [input.fromAccountId, branchId])).rows[0];
        if (!fromAccount) throw error("From account not found or inactive.", "ACCOUNT_NOT_FOUND", 404);
        const toAccount = (await client.query("SELECT id, display_name FROM financial_accounts WHERE id = $1 AND is_active = true AND (branch_id IS NULL OR branch_id = $2) FOR UPDATE", [input.toAccountId, branchId])).rows[0];
        if (!toAccount) throw error("To account not found or inactive.", "ACCOUNT_NOT_FOUND", 404);
        if (fromAccount.id === toAccount.id) throw error("Cannot transfer to the same account.", "INVALID_TRANSFER", 400);

        const amountMinor = Number(input.amountMinor);
        if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw error("Transfer amount must be positive.", "INVALID_AMOUNT", 400);

        const now = new Date();
        const transferId = randomUUID();
        await client.query(`INSERT INTO ledger_entries (id, restaurant_id, branch_id, financial_account_id, entry_type, amount_minor,
          description, source_type, source_key, occurred_at) VALUES ($1, $2, $3, $4, 'debit', $5, $6, 'transfer', $7, $8)`,
          [randomUUID(), restaurantId, branchId, fromAccount.id, amountMinor, `Transfer to ${fromAccount.display_name}: ${input.description || ''}`.trim(), `transfer:${input.idempotencyKey}:out`, now]);
        await client.query(`INSERT INTO ledger_entries (id, restaurant_id, branch_id, financial_account_id, entry_type, amount_minor,
          description, source_type, source_key, occurred_at) VALUES ($1, $2, $3, $4, 'credit', $5, $6, 'transfer', $7, $8)`,
          [randomUUID(), restaurantId, branchId, toAccount.id, amountMinor, `Transfer from ${fromAccount.display_name}: ${input.description || ''}`.trim(), `transfer:${input.idempotencyKey}:in`, now]);

        return { transferId, amountMinor, replayed: false };
      });
    },
    async profitLoss({ restaurantId, userId, startDate, endDate }) {
      return withTenantTransaction(pool, { restaurantId, userId }, async client => {
        const values = [startDate, endDate];
        const sales = (await client.query(`SELECT COALESCE(sum(CASE WHEN o.order_status = 'completed' THEN o.total_minor ELSE 0 END), 0) AS revenue,
          COALESCE(sum(CASE WHEN o.order_status = 'completed' THEN o.cost_of_goods_minor ELSE COALESCE(ref.unreturned_cost, 0) END), 0) AS cogs,
          COALESCE(sum(CASE WHEN o.order_status = 'completed' THEN ref.refunded ELSE 0 END), 0) AS refunds,
          COALESCE(sum(CASE WHEN o.order_status = 'completed' THEN ref.restocked_cost ELSE 0 END), 0) AS returned_cost, count(*) FILTER (WHERE o.order_status = 'completed') AS orders,
          count(*) FILTER (WHERE o.order_status = 'completed' AND o.incomplete_costing = true) AS incomplete_costing_orders,
          (SELECT COALESCE(sum(amount_minor), 0) FROM expenses WHERE business_date BETWEEN $1::date AND $2::date) AS expenses
          FROM orders o LEFT JOIN LATERAL (
            SELECT sum(r.total_refunded_minor) AS refunded, sum((SELECT COALESCE(sum(ri.quantity * oi.unit_cost_minor), 0)
              FROM order_refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id AND oi.restaurant_id = ri.restaurant_id
              WHERE ri.refund_id = r.id AND ri.restaurant_id = r.restaurant_id AND ri.restock = true)) AS restocked_cost
            , sum((SELECT COALESCE(sum(ri.quantity * oi.unit_cost_minor), 0)
              FROM order_refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id AND oi.restaurant_id = ri.restaurant_id
              WHERE ri.refund_id = r.id AND ri.restaurant_id = r.restaurant_id AND ri.restock = false)) AS unreturned_cost
            FROM order_refunds r WHERE r.order_id = o.id AND r.restaurant_id = o.restaurant_id AND r.status = 'completed'
          ) ref ON true WHERE o.order_status IN ('completed', 'cancelled') AND o.business_date BETWEEN $1::date AND $2::date`, values)).rows[0];
        const netSalesMinor = Number(sales.revenue) - Number(sales.refunds);
        const costOfGoodsMinor = Math.round(Number(sales.cogs) - Number(sales.returned_cost));
        const grossProfitMinor = netSalesMinor - costOfGoodsMinor;
        const operatingExpensesMinor = Number(sales.expenses);
        const incompleteCostingOrders = Number(sales.incomplete_costing_orders || 0);
        return { startDate, endDate, completedOrders: Number(sales.orders), netSalesMinor, costOfGoodsMinor, grossProfitMinor, operatingExpensesMinor,
          netProfitMinor: grossProfitMinor - operatingExpensesMinor, basis: "accrual", costBasis: "checkout_snapshot",
          incompleteCostingOrders, hasIncompleteCosting: incompleteCostingOrders > 0, historicalCostsRequireReview: true };
      });
    },
  });
}
