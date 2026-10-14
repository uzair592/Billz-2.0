import { z } from "zod";
import { PERMISSION } from "../authorization/permissions.mjs";
import { businessDateInTimezone } from "../pos/business-date.mjs";

const rangeSchema = z.object({ startDate: z.iso.date(), endDate: z.iso.date(), page: z.coerce.number().int().min(1).max(1000000).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) })
  .refine(value => value.startDate <= value.endDate, "Start date must not follow end date.");
const expenseSchema = z.object({ idempotencyKey: z.uuid(), categoryName: z.string().trim().min(1).max(120), amountMinor: z.number().int().min(1).max(9000000000000),
  description: z.string().trim().max(1000).optional(), businessDate: z.iso.date(), financialAccountId: z.uuid() }).strict();
const transferSchema = z.object({
  idempotencyKey: z.uuid(),
  fromAccountId: z.uuid(),
  toAccountId: z.uuid(),
  amountMinor: z.number().int().positive(),
  description: z.string().trim().max(1000).optional(),
}).strict();

export async function registerFinanceRoutes(app, { guards, financeService }) {
  const guard = permission => ({ preHandler: [guards.authenticate, guards.tenant(permission)] });
  function context(request) { return { restaurantId: request.tenant.restaurant.id, userId: request.auth.user.id, branchId: request.tenant.membership.defaultBranchId }; }
  function range(request) {
    const today = businessDateInTimezone(new Date(), request.tenant.restaurant.timezone || "Asia/Karachi");
    return rangeSchema.parse({ startDate: today, endDate: today, ...request.query });
  }
  app.get("/api/pos/finance/accounts", guard(PERMISSION.FINANCE_MANAGE), request => financeService.accounts(context(request)));
  app.post("/api/pos/finance/transfers", guard(PERMISSION.FINANCE_MANAGE), async (request, reply) => {
    const result = await financeService.createTransfer({ ...context(request), input: transferSchema.parse(request.body) });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get("/api/pos/expenses", guard(PERMISSION.EXPENSE_MANAGE), request => financeService.listExpenses({ ...context(request), ...range(request) }));
  app.post("/api/pos/expenses", guard(PERMISSION.EXPENSE_MANAGE), async (request, reply) => {
    const result = await financeService.createExpense({ ...context(request), input: expenseSchema.parse(request.body) });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get("/api/pos/reports/profit-loss", guard(PERMISSION.REPORT_VIEW), request => financeService.profitLoss({ ...context(request), ...range(request) }));
}
