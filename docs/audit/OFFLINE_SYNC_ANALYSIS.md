# Billz 2.0 POS — Offline Outbox & Synchronization Engine Audit

## Overview
This document evaluates the offline data architecture, IndexedDB outbox queue (`BiteTechPOS_DB`), network recovery sync workflows, conflict resolution strategies, and edge-case resilience.

---

## Offline Storage Architecture & Outbox Queue

### 1. Storage Layers
- **Primary Cache Engine:** **IndexedDB** (`BiteTechPOS_DB`, store: `posData`).
- **Outbox Queue Module:** [`src/client/order-outbox.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/order-outbox.mjs)
- **Local Fallback:** [`src/client/legacy-cloud-adapter.mjs`](file:///C:/Users/HP/Desktop/updated%20pos%20latest%20version/src/client/legacy-cloud-adapter.mjs)

---

## Sync Flow & Lifecycle Evaluation

```
+-------------------------------------------------------------+
| Browser Client (IndexedDB)                                   |
| - Pending Array: [ { id: "uuid", sync_status: "pending" } ]  |
+------------------------------+------------------------------+
                               | (Online: navigator.onLine)
                               v
+-------------------------------------------------------------+
| Server API: POST /api/v1/sync/push                          |
| - Conflict Resolution: Server Timestamp Wins                |
| - Idempotency Validation: UUID Deduplication                |
+-------------------------------------------------------------+
```

### Forensic Findings & Edge-Case Vulnerabilities

1. **SYNC-BUG-01: Offline Subscription Paywall Bypass**:
   - *Risk:* High
   - *Finding:* While server endpoints return HTTP 402 when subscription expires, offline mode checks local IndexedDB without enforcing cached `subscription_valid_until` limits, allowing offline operations to run past subscription expiry if internet is disconnected.
   - *Remediation:* Enforce cached `valid_until` lock checks in offline cashier authorization handlers.

2. **SYNC-BUG-02: Retries on Non-Transient HTTP Errors**:
   - *Risk:* Medium
   - *Finding:* Outbox queue retries batch push requests on HTTP 400 validation failures instead of dead-lettering invalid payloads.
   - *Remediation:* Dead-letter payloads receiving permanent HTTP 4xx validation errors and notify manager.

3. **SYNC-BUG-03: Multi-Device Inventory Race Condition**:
   - *Risk:* High
   - *Finding:* Simultaneous offline sales across 2 tills for the last stock unit produce duplicate deductions upon sync.
   - *Remediation:* Enforce weighted average stock re-reconciliation on server during `POST /api/v1/sync/push`.
