# Inventory & Purchasing Operations Documentation — FIFO Costing Architecture

## Overview
Billz-2.0 implements First-In, First-Out (FIFO) as the authoritative costing method across multi-tenant purchasing, inventory consumption, POS sales, refunds, cancellations, and financial reporting.

## Key Components & Architecture

### 1. Inventory Units
- **Base Units**: Supported inventory base units are `piece`, `gram`, `kilogram`, `millilitre`, and `litre`.
- **Storage Precision**: Stock quantities are stored as high-precision numeric values (`NUMERIC(18,4)`). Line totals and monetary costs are maintained in integer minor units (`BIGINT` representing paisa/cents/minor units).

### 2. FIFO Cost Batches (`inventory_fifo_batches`)
- **Discrete Cost Layers**: Each received purchase line generates an immutable FIFO batch record preserving:
  - `restaurant_id`: Tenant boundary
  - `inventory_item_id`: Item identifier
  - `purchase_id` and `purchase_item_id`: Source document references
  - `original_quantity`: Base units received
  - `remaining_quantity`: Base units remaining on hand
  - `unit_cost_minor`: Acquisition unit cost in minor currency units
  - `effective_receipt_at`: Deterministic ordering timestamp
  - `batch_ref`: Purchase/Invoice reference number
  - `batch_origin`: `'purchase'`, `'opening_stock'`, `'wac_migration'`, `'manual_adjustment'`, or `'return'`
- **Deterministic Order**: Batches are strictly ordered by `effective_receipt_at ASC, created_at ASC, id ASC`.

### 3. FIFO Consumption & Allocations (`inventory_fifo_allocations`)
- **Authoritative Allocation**: When an order is completed, ingredients are allocated from the oldest available batches. Once an older batch is exhausted (`remaining_quantity = 0`), consumption advances to the next layer.
- **Traceable Cost Breakdown**: Each consumption slice writes an immutable allocation row recording:
  - `batch_id`: Consumed batch
  - `order_id`: Associated sale
  - `allocated_quantity`: Quantity consumed
  - `unit_cost_minor`: Cost snapshot of the batch layer
  - `total_cost_minor`: Exact line cost
- **Order COGS**: Sum of all batch allocation total costs is recorded directly on the `orders` table as `cost_of_goods_minor`.

### 4. Negative Stock & Provisional Deficits (`inventory_fifo_deficits`)
- **Checkout Non-Blocking**: Sales are never blocked by stock deficits.
- **Deficit Tracking**: When available batches are exhausted, the unallocated quantity is recorded in `inventory_fifo_deficits`.
- **Costing Status**:
  - `resolved`: Complete FIFO batch coverage
  - `provisional`: Partial stock shortfall covered by deficit
  - `unresolved`: Entirely uncosted / missing recipe
- **Subsequent Reconciliation**: When new purchases arrive, earlier deficits are reconciled without silently modifying historical invoices.

### 5. Cancellations & Refunds
- **Order Cancellation**: Restores consumed quantities back to their original FIFO batches and records compensating `sale_reversal` allocation rows.
- **Customer Refunds**: Restocking restores the original batch allocations and unit costs, linking movements to the refund.

### 6. WAC Data Migration
- Existing stock balances created prior to FIFO adoption are migrated into initial opening batches tagged with `batch_origin = 'wac_migration'`, using the verified carrying average cost. Historical sale snapshots are preserved without rewriting past invoices.

### 7. Append-Only Immutable Ledgers
- Both `inventory_movements` and `inventory_fifo_allocations` are protected by database triggers that reject `UPDATE` and `DELETE` queries, ensuring complete auditability.
