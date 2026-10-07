# Billz 2.0 POS — Commercial SaaS Requirements Gap Analysis

## Overview
This document evaluates the owner's commercial multi-tenant SaaS business requirements against the current codebase status.

---

## Business Requirements Verification Table

| Business Requirement | Classification | Current Implementation Status | Gap & Required Action |
| :--- | :---: | :--- | :--- |
| **`restaurant_code` + `username` + `password` login** | `MISSING` | Authentication uses email (`till@bite-tech.example`). | Add `restaurant_code` + `username` fields to user tables & auth API. |
| **Unique username within restaurant** | `MISSING` | Usernames are non-existent; emails are globally unique. | Add composite unique constraint `(restaurant_code, username)`. |
| **Manual WhatsApp subscription payments** | `MISSING` | Billing currently relies on Stripe checkout endpoints. | Implement manual subscription provider & WhatsApp proof reference logger. |
| **Platform super-admin panel (`/platform-admin`)** | `MISSING` | No super-admin route namespace or administration UI exists. | Build `/platform-admin` route namespace, authorization middleware, & UI. |
| **Manual plan activation, renewal, suspension** | `MISSING` | No manual admin activation endpoints exist. | Create Super-Admin actions (`+1 Month`, `+3 Months`, `Suspend`, `Restore`). |
| **Preservation of suspended restaurant data** | `IMPLEMENTED` | PostgreSQL DB schemas retain all records on status change. | Confirmed. Ensure suspension blocks POS mutations while preserving data. |
| **5 GB+ per-tenant storage tiering & quota metering** | `MISSING` | No payload size metering middleware on file uploads. | Add request payload size metering (`content-length` check vs 5 GB cap). |
| **Offline entitlement expiration gate** | `MISSING` | IndexedDB offline mode does not enforce cached valid_until. | Enforce cached `subscription_valid_until` check in offline cashier auth. |
