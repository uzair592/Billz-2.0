# Billz 2.0 POS — Manual Subscription Architecture & Paywall Specification

## Overview
This document specifies the manual subscription lifecycle management system, replacing online card processing dependencies with manual WhatsApp proof-of-payment review, platform admin extensions, and automated status transition logic.

---

## Subscription State Machine

```
               [ Signup / Trial ]
                      |
                      v
             [ Active Subscription ] <----+ (Super-Admin Approves Payment)
                      |                   |
            (valid_until reached)         |
                      v                   |
             [ Grace Period (3 Days) ] ---+
                      |                   |
            (grace period expired)        |
                      v                   |
             [ Suspended Account ] -------+
```

---

## State Definitions & Operational Rules

1. **`trial`**: New restaurant registration default. Full POS features active for 14 days.
2. **`active`**: Paid subscription verified by Super Admin. Full cloud and POS features enabled.
3. **`grace_period`**: Expiry date reached; 3-day grace period allows continuous billing while payment proof is sent to WhatsApp.
4. **`suspended`**: Grace period expired without payment. POS billing locked; server data preserved.
5. **`expired`**: Subscription term concluded; account locked to read-only historical viewing.

---

## Super-Admin Payment Action Workflows

- **`POST /platform-admin/api/v1/subscriptions/approve`**:
  - Payload: `{ tenantId, paymentReference, durationMonths, whatsappProofRef }`
  - Mutation: `valid_until = valid_until + (durationMonths * 30 days)`, `subscription_status = 'active'`.
  - Generates an immutable audit record in `platform_audit_logs`.
