# Billz 2.0 POS — Multi-Tenant Authentication & Session Audit

## Overview
This document evaluates the existing authentication system against commercial SaaS requirements: tenant-scoped login (`restaurant_code` + `username` + `password`), role-based access control (RBAC), and session security.

---

## Current Auth Architecture vs Required SaaS Model

| Feature | Current Implementation | Target Multi-Tenant SaaS Model | Status |
| :--- | :--- | :--- | :--- |
| **Login Identifier** | Email (`till@bite-tech.example`) | `restaurant_code` + `username` | 🔴 Defect |
| **Password Hashing** | Bcrypt / Arg2id in backend service | Bcrypt / Argon2id with salt | 🟢 Compliant |
| **Quick Cashier Switch** | Client-side PIN lock overlay | Server-verified 4-digit PIN code | 🔴 Defect |
| **Session Cookie** | HttpOnly Cookie (`pos_cloud_session_v1`) | HttpOnly, SameSite=Strict, Secure | 🟢 Compliant |
| **Tenant Isolation** | PostgreSQL RLS (`restaurant_id`) | RLS Policy + Request middleware | 🟢 Compliant |
| **Platform Admin** | Mixed inside tenant routes | Isolated `/platform-admin` namespace | 🔴 Defect |

---

## Authentication Migration Strategy

1. **User Table Schema Refactoring**:
   ```sql
   ALTER TABLE users ADD COLUMN username VARCHAR(100);
   ALTER TABLE users ADD COLUMN restaurant_code VARCHAR(50);
   CREATE UNIQUE INDEX idx_users_restaurant_username ON users (restaurant_code, username);
   ```

2. **Login API Specification**:
   - `POST /api/v1/auth/login`:
     - Payload: `{ restaurantCode: "REST-101", username: "cashier1", password: "..." }`
     - Response: Sets `HttpOnly` JWT cookie `{ userId, tenantId, role, subscriptionExpiry }`.

3. **Cashier Quick-Switch API**:
   - `POST /api/v1/auth/pin-switch`:
     - Payload: `{ pinCode: "1234" }`
     - Switches cashier identity without terminating tenant session context.
