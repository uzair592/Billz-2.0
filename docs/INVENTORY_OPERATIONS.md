# Milestone 14 — Inventory & Purchasing Operations Documentation

## Overview
Milestone 14 introduces multi-tenant inventory tracking, recipe-based automatic order stock consumption, supplier management, draft purchasing, receiving with weighted average costing (WAC), manual adjustments, waste tracking, and an append-only immutable stock movements ledger for Bite Tech POS SaaS.

## Key Components & Architecture

### 1. Inventory Units
- **Base Units**: Supported inventory base units are piece, gram, kilogram, millilitre, and litre.
- **Storage Precision**: Stock quantities are stored as high-precision numeric values (NUMERIC(12,4)). Line totals and monetary costs are maintained in PKR integer minor units (INTEGER / BIGINT representing paisa).

### 2. Recipe Deductions & Exact-Once Consumption
- **Authoritative Checkout Gate**: Inventory consumption (consumeOrderInventory) is invoked atomically inside the production createCompletedOrder checkout transaction.
- **Recipe Ingredients**: When a completed order is submitted, the server looks up the current recipe mapping (inventory_recipes + inventory_recipe_items) for each item ordered and deducts the exact required ingredient quantities.
- **Idempotency**: Concurrent checkout replays or repeated calls use the order's unique idempotency constraint/key, ensuring inventory is deducted exactly once per order.
- **Fault Tolerance**: Missing recipes or negative stock do not block checkout.

### 3. Purchase Receiving & Weighted Average Costing (WAC)
- **Draft Purchases**: Purchases begin in DRAFT status and can be updated until received.
- **Receiving Confirmation**: Receiving a purchase requires explicit confirmation and transition to RECEIVED status, rendering the purchase immutable.
- **Weighted Average Cost Formula**: When receiving inventory:
  \text{New WAC} = \frac{(\text{Current Stock} \times \text{Current WAC}) + (\text{Received Qty} \times \text{Unit Cost})}{\text{Current Stock} + \text{Received Qty}}
  Negative stock moving toward positive correctly uses the incoming purchase unit cost for the new stock balance.

### 4. Negative Stock & Low Stock Warnings
- **Negative Stock Allowed**: Stock can drop below zero when orders complete without sufficient stock on hand. Movements record exact negative balances.
- **Low Stock Warnings**: Items with current_stock <= reorder_level render LOW STOCK badges.

### 5. Adjustments & Waste
- Manual adjustments (ADJUSTMENT) and waste recordings (WASTE) write signed movements to inventory_movements and update inventory_items.current_stock.

### 6. Append-Only Immutable Ledger
- inventory_movements table is protected by a PostgreSQL database trigger (inventory_movement_immutable()) preventing UPDATE and DELETE operations.

### 7. Permissions & Authorization
- dmin and manager roles can perform all inventory/purchasing operations.
- cashier cannot access purchase management endpoints.
- ccountant has read-only access.

### 8. Known Limitations
- Accounts payable and supplier payment ledgers are out of scope for Milestone 14.
- Multi-warehouse transfers and batch/expiry tracking are not included in this release.
