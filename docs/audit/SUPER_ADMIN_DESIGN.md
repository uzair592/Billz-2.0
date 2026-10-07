# Billz 2.0 POS — Super-Admin Platform Administration Specification

## Overview
This document designs the isolated Platform Administration Portal (`/platform-admin`) for platform super-administrators to manage restaurant tenants, verify manual WhatsApp payments, extend access, override storage quotas, and monitor platform health.

---

## Access Control & Routing Security

- **Route Namespace:** `/platform-admin/*`
- **Authentication:** Dedicated super-admin login (`POST /platform-admin/api/v1/auth/login`).
- **Authorization Middleware:** Requires `user.role === 'super_admin'`. Tenant user roles (`owner`, `cashier`, `manager`) receive `HTTP 403 Forbidden` if attempting access.
- **Tenant RLS Separation:** Platform admin queries execute with elevated database connection context (`app.current_tenant_id = NULL`) specifically scoped to platform management APIs.

---

## Key Administrative Features

1. **Tenant Directory Table**:
   - Searchable listing of all restaurants: Name, Restaurant Code, Owner Contact, Signup Date, Current Storage Usage (e.g., `1.2 GB / 5.0 GB`), Status (`Active`, `Expired`, `Suspended`).

2. **1-Click Subscription Extension**:
   - Quick action controls: `+1 Month`, `+3 Months`, `+1 Year`.
   - Option to record WhatsApp proof reference number.

3. **Account Suspension & Kill Switch**:
   - Instant toggle to lock or restore access for any tenant. Data is preserved in PostgreSQL during suspension.

4. **Storage Quota Override**:
   - Ability to upgrade a tenant's storage entitlement from $5\text{GB}$ to $10\text{GB}$, $20\text{GB}$, or custom tier.
