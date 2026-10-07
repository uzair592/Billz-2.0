# Billz 2.0 POS — Actual Backend Route Map

## Overview
This document registers every actual HTTP route registered in `src/server/http/app.mjs` (35 routes) and refutes hypothetical `/api/v1/*` route strings.

---

## Registered Fastify Routes (`src/server/http/app.mjs`)

| Method | Path | Auth | Sub Gate | Permission | Service Method | Tables | RLS |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- | :---: |
| `GET` | `/health/live` | No | Exempt | None | Liveness check | None | No |
| `GET` | `/health/ready` | No | Exempt | None | DB readiness check | `schema_migrations` | No |
| `POST` | `/api/auth/register` | No | Exempt | None | `authService.register` | `users`, `restaurants`, `memberships` | No |
| `POST` | `/api/auth/login` | No | Exempt | None | `authService.login` | `users`, `memberships` | No |
| `POST` | `/api/auth/logout` | Yes | Exempt | None | Session clear | `session_tokens` | Yes |
| `GET` | `/api/auth/me` | Yes | Exempt | None | `tenantContextService` | `users`, `restaurants`, `memberships` | Yes |
| `POST` | `/api/auth/verify` | No | Exempt | None | `mailPolicyService` | `verification_tokens` | No |
| `GET` | `/api/billing/overview` | Yes | Exempt | `billing:read` | `subscriptionService` | `restaurant_subscriptions` | Yes |
| `POST` | `/api/billing/checkout` | Yes | Exempt | `billing:subscribe` | `subscriptionService` | `restaurant_subscriptions` | Yes |
| `POST` | `/api/billing/change-plan` | Yes | Exempt | `billing:subscribe` | `subscriptionService` | `restaurant_subscriptions` | Yes |
| `POST` | `/api/billing/cancel-subscription` | Yes | Exempt | `billing:cancel` | `subscriptionService` | `restaurant_subscriptions` | Yes |
| `POST` | `/api/billing/webhook/stripe` | No | Exempt | None | `billingWebhookService` | `restaurant_subscriptions` | No |
| `GET` | `/api/pos/menu` | Yes | Required | `pos:menu:read` | `menuService.list` | `menu_items`, `menu_categories` | Yes |
| `GET` | `/api/pos/orders` | Yes | Required | `pos:orders:read` | `orderService.list` | `orders`, `order_items` | Yes |
| `POST` | `/api/pos/orders` | Yes | Required | `pos:orders:create` | `orderService.create` | `orders`, `order_items`, `payments` | Yes |
| `GET` | `/api/pos/orders/:orderId` | Yes | Required | `pos:orders:read` | `orderService.get` | `orders`, `order_items` | Yes |
| `POST` | `/api/pos/orders/:orderId/cancel` | Yes | Required | `pos:orders:cancel` | `orderCancellationService` | `orders`, `stock_ledger` | Yes |
| `POST` | `/api/pos/orders/:orderId/refunds` | Yes | Required | `pos:orders:refund` | `orderRefundService` | `orders`, `refunds` | Yes |
| `GET` | `/api/pos/reports/sales` | Yes | Required | `pos:reports:sales` | `salesReportService` | `orders`, `order_items` | Yes |
| `GET` | `/api/pos/inventory/items` | Yes | Required | `pos:inventory:read` | `inventoryService.list` | `inventory_items` | Yes |
| `POST` | `/api/pos/inventory/items` | Yes | Required | `pos:inventory:manage` | `inventoryService.create` | `inventory_items` | Yes |
| `PATCH` | `/api/pos/inventory/items/:itemId` | Yes | Required | `pos:inventory:manage` | `inventoryService.update` | `inventory_items` | Yes |
| `GET` | `/api/pos/inventory/low-stock` | Yes | Required | `pos:inventory:read` | `inventoryService.lowStock` | `inventory_items` | Yes |
| `POST` | `/api/pos/inventory/adjustments` | Yes | Required | `pos:inventory:manage` | `inventoryService.adjust` | `inventory_items`, `stock_ledger` | Yes |
| `POST` | `/api/pos/inventory/waste` | Yes | Required | `pos:inventory:manage` | `inventoryService.waste` | `inventory_items`, `stock_ledger` | Yes |
| `GET` | `/api/pos/inventory/history/:itemId` | Yes | Required | `pos:inventory:read` | `inventoryService.history` | `stock_ledger` | Yes |
| `GET` | `/api/pos/suppliers` | Yes | Required | `pos:suppliers:read` | `supplierService.list` | `suppliers` | Yes |
| `POST` | `/api/pos/suppliers` | Yes | Required | `pos:suppliers:manage` | `supplierService.create` | `suppliers` | Yes |
| `PATCH` | `/api/pos/suppliers/:supplierId` | Yes | Required | `pos:suppliers:manage` | `supplierService.update` | `suppliers` | Yes |
| `GET` | `/api/pos/purchases` | Yes | Required | `pos:purchases:read` | `purchaseService.list` | `purchase_orders` | Yes |
| `POST` | `/api/pos/purchases` | Yes | Required | `pos:purchases:manage` | `purchaseService.create` | `purchase_orders` | Yes |
| `GET` | `/api/pos/purchases/:purchaseId` | Yes | Required | `pos:purchases:read` | `purchaseService.get` | `purchase_orders` | Yes |
| `POST` | `/api/pos/purchases/:purchaseId/receive` | Yes | Required | `pos:purchases:manage` | `purchaseService.receive` | `purchase_orders`, `inventory_items` | Yes |
| `GET` | `/api/pos/recipes` | Yes | Required | `pos:recipes:read` | `recipeService.get` | `recipes`, `recipe_items` | Yes |
| `PUT` | `/api/pos/recipes` | Yes | Required | `pos:recipes:manage` | `recipeService.save` | `recipes`, `recipe_items` | Yes |

---

## Route String Verification Refutation

The following path strings do **NOT** exist anywhere in the backend codebase:
- `/api/v1/auth/login` (Real: `/api/auth/login`)
- `/api/v1/auth/refresh` (Real: None)
- `/api/v1/tenant/subscription` (Real: `/api/billing/overview`)
- `/api/v1/sync/push` (Real: None, REST outbox push via domain endpoints)
- `/api/v1/sync/pull` (Real: None, REST endpoint polling)
- `/api/v1/inventory` (Real: `/api/pos/inventory/items`)
- `/api/v1/menu/items` (Real: `/api/pos/menu`)
- `/api/v1/orders` (Real: `/api/pos/orders`)
- `/api/v1/admin/tenants` (Real: None)
