export const PERMISSION = Object.freeze({
  ORDER_CREATE: "order:create",
  ORDER_VIEW: "order:view",
  ORDER_EDIT: "order:edit",
  ORDER_CANCEL: "order:cancel",
  PAYMENT_PROCESS: "payment:process",
  RECEIPT_PRINT: "receipt:print",
  TABLE_VIEW: "table:view",
  TABLE_MANAGE: "table:manage",
  KITCHEN_VIEW: "kitchen:view",
  KITCHEN_UPDATE: "kitchen:update",
  MENU_MANAGE: "menu:manage",
  INVENTORY_MANAGE: "inventory:manage",
  EXPENSE_MANAGE: "expense:manage",
  FINANCE_MANAGE: "finance:manage",
  REPORT_VIEW: "report:view",
  SETTINGS_MANAGE: "settings:manage",
  MEMBERS_MANAGE: "members:manage",
  BILLING_MANAGE: "billing:manage",
});

const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSION));

const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set(ALL_PERMISSIONS),
  manager: new Set([
    PERMISSION.ORDER_CREATE,
    PERMISSION.ORDER_VIEW,
    PERMISSION.ORDER_EDIT,
    PERMISSION.ORDER_CANCEL,
    PERMISSION.PAYMENT_PROCESS,
    PERMISSION.RECEIPT_PRINT,
    PERMISSION.TABLE_VIEW,
    PERMISSION.TABLE_MANAGE,
    PERMISSION.KITCHEN_VIEW,
    PERMISSION.KITCHEN_UPDATE,
    PERMISSION.MENU_MANAGE,
    PERMISSION.INVENTORY_MANAGE,
    PERMISSION.EXPENSE_MANAGE,
    PERMISSION.FINANCE_MANAGE,
    PERMISSION.REPORT_VIEW,
  ]),
  cashier: new Set([
    PERMISSION.ORDER_CREATE,
    PERMISSION.ORDER_VIEW,
    PERMISSION.PAYMENT_PROCESS,
    PERMISSION.RECEIPT_PRINT,
    PERMISSION.TABLE_VIEW,
  ]),
  waiter: new Set([
    PERMISSION.ORDER_CREATE,
    PERMISSION.ORDER_VIEW,
    PERMISSION.ORDER_EDIT,
    PERMISSION.TABLE_VIEW,
  ]),
  kitchen: new Set([
    PERMISSION.ORDER_VIEW,
    PERMISSION.KITCHEN_VIEW,
    PERMISSION.KITCHEN_UPDATE,
  ]),
});

export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) === true;
}

export function permissionsForRole(role) {
  return Object.freeze([...(ROLE_PERMISSIONS[role] ?? [])]);
}

export function requirePermission(role, permission) {
  if (!hasPermission(role, permission)) {
    const error = new Error("You do not have permission to perform this action.");
    error.code = "FORBIDDEN";
    error.statusCode = 403;
    throw error;
  }
}
