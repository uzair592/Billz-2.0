# Billz 2.0 POS — Actual Backend Route Map & Endpoint Inspection

## Overview
This document registers every actual HTTP endpoint registered in `src/server/http/app.mjs` and explicitly refutes hypothetical `/api/v1/*` route claims.

---

## Actual Registered Fastify Endpoints

| Method | Exact Path | Auth Req | Sub Req | Permission | Database Tables / Action |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `GET` | `/health/live` | No | No | None | Process liveness check |
| `GET` | `/health/ready` | No | No | None | DB pool & migration check |
| `POST` | `/api/auth/register` | No | Exempt | None | Insert `users`, `restaurants`, `memberships` |
| `POST` | `/api/auth/login` | No | Exempt | None | Authenticate user, issue HttpOnly cookie |
| `POST` | `/api/auth/logout` | Yes | Exempt | None | Clear session cookie |
| `GET` | `/api/auth/me` | Yes | Exempt | None | Read current user & active tenant memberships |
| `POST` | `/api/auth/verify` | No | Exempt | None | Verify registration token |
| `GET` | `/api/billing/overview` | Yes | Exempt | `billing:read` | Read restaurant subscription & payments |
| `POST` | `/api/billing/checkout` | Yes | Exempt | `billing:subscribe` | Create Stripe checkout session |
| `POST` | `/api/billing/change-plan` | Yes | Exempt | `billing:subscribe` | Change Stripe plan |
| `POST` | `/api/billing/cancel-subscription` | Yes | Exempt | `billing:cancel` | Cancel Stripe subscription |
| `POST` | `/api/billing/webhook/stripe` | No | Exempt | None | Verify signature, update subscription state |
| `GET` | `/api/pos/menu` | Yes | Required | `pos:menu:read` | Read menu items & categories |
| `GET` | `/api/pos/orders` | Yes | Required | `pos:orders:read` | List tenant orders with cursor pagination |
| `POST` | `/api/pos/orders` | Yes | Required | `pos:orders:create` | Create new order in tenant store |
| `GET` | `/api/pos/orders/:orderId` | Yes | Required | `pos:orders:read` | Read single order detail snapshot |
| `POST` | `/api/pos/orders/:orderId/cancel` | Yes | Required | `pos:orders:cancel` | Cancel order with idempotency check |
| `POST` | `/api/pos/orders/:orderId/refunds` | Yes | Required | `pos:orders:refund` | Post item/order refund |
| `GET` | `/api/pos/reports/sales` | Yes | Required | `pos:reports:sales` | Sales report summary & breakdown |
| `GET` | `/api/pos/inventory/items` | Yes | Required | `pos:inventory:read` | List weighted-average inventory items |
| `POST` | `/api/pos/inventory/items` | Yes | Required | `pos:inventory:manage` | Create inventory item |
| `PATCH` | `/api/pos/inventory/items/:itemId` | Yes | Required | `pos:inventory:manage` | Update inventory item |
| `GET` | `/api/pos/inventory/low-stock` | Yes | Required | `pos:inventory:read` | Query low stock items |
| `POST` | `/api/pos/inventory/adjustments` | Yes | Required | `pos:inventory:manage` | Manual stock audit adjustment |
| `POST` | `/api/pos/inventory/waste` | Yes | Required | `pos:inventory:manage` | Spoilage / waste log |
| `GET` | `/api/pos/inventory/history/:itemId` | Yes | Required | `pos:inventory:read` | Item movement ledger audit |
| `GET` | `/api/pos/suppliers` | Yes | Required | `pos:suppliers:read` | List suppliers |
| `POST` | `/api/pos/suppliers` | Yes | Required | `pos:suppliers:manage` | Create supplier |
| `PATCH` | `/api/pos/suppliers/:supplierId` | Yes | Required | `pos:suppliers:manage` | Update supplier |
| `GET` | `/api/pos/purchases` | Yes | Required | `pos:purchases:read` | List purchase orders |
| `POST` | `/api/pos/purchases` | Yes | Required | `pos:purchases:manage` | Draft purchase order |
| `GET` | `/api/pos/purchases/:purchaseId` | Yes | Required | `pos:purchases:read` | Read single purchase order |
| `POST` | `/api/pos/purchases/:purchaseId/receive` | Yes | Required | `pos:purchases:manage` | Stock receive & inventory cost update |
| `GET` | `/api/pos/recipes` | Yes | Required | `pos:recipes:read` | List product recipes |
| `PUT` | `/api/pos/recipes` | Yes | Required | `pos:recipes:manage` | Save product recipe |

---

## Refutation of Hypothetical `/api/v1/*` Routes

The following routes **DO NOT EXIST** in the codebase:
- `/api/v1/auth/login` (Real: `/api/auth/login`)
- `/api/v1/auth/refresh` (Real: None, HttpOnly session cookie used)
- `/api/v1/tenant/subscription` (Real: `/api/billing/overview`)
- `/api/v1/sync/push` (Real: None, outbox syncs via domain REST APIs)
- `/api/v1/sync/pull` (Real: None, REST endpoint polling)
- `/api/v1/inventory` (Real: `/api/pos/inventory/items`)
- `/api/v1/menu/items` (Real: `/api/pos/menu`)
- `/api/v1/orders` (Real: `/api/pos/orders`)
- `/api/v1/admin/tenants` (Real: None, no platform super-admin routes)
