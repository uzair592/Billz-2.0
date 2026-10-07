# Billz 2.0 POS — Storage Quota & File Metering Architecture

## Overview
This document specifies the storage quota metering, object storage tiering ($5\text{GB}$ baseline entitlement), calculation rules, and upload blocking middleware.

---

## Storage Accounting Model

1. **Tracked Assets**:
   - Menu Product Images & Logos (`/uploads/images/*`)
   - Backup Files (`/uploads/backups/*`)
   - Receipt & Attachment Documents (`/uploads/docs/*`)
   - Database Row Size Estimation (calculated via PostgreSQL `pg_total_relation_size()`)

2. **Upload Metering Middleware**:
   ```javascript
   async function enforceStorageQuota(req, res, next) {
     const tenant = await getTenantQuota(req.user.tenantId);
     const incomingBytes = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;
     
     if (tenant.storage_used_bytes + incomingBytes > tenant.storage_limit_bytes) {
       return res.status(413).json({
         error: "Storage quota exceeded (5 GB limit). Contact platform admin to upgrade storage tier.",
         code: "STORAGE_LIMIT_EXCEEDED"
       });
     }
     next();
   }
   ```

3. **Quota Threshold Notifications**:
   - **80% Usage (4.0 GB)**: Soft warning banner on tenant settings page.
   - **90% Usage (4.5 GB)**: High-priority admin alert to tenant owner.
   - **100% Usage (5.0 GB)**: File uploads blocked; core transactional POS billing remains functional.
