# Database Backup and Restore Runbook

Operational procedures for backing up and restoring PostgreSQL 17 tenant databases.

> **CRITICAL RULE**: Never restore a database backup into the active production database! Always restore into a separate target database instance to verify data integrity before any migration or failover.

---

## 1. Database Backup Command

To perform a logical backup of the cloud database:

```bash
# Export environment variables
export DATABASE_URL="postgres://billz_admin:SECRET@host:5432/billz_pos_pilot"

# Execute pg_dump
pg_dump --dbname="$DATABASE_URL" \
        --format=custom \
        --file="billz_backup_$(date +%Y%m%d_%H%M%S).dump" \
        --no-owner \
        --no-privileges
```

---

## 2. Backup Verification Procedure

1. Verify dump file size and header:
   ```bash
   pg_restore --list billz_backup_*.dump | head -n 20
   ```
2. Check that tenant tables and RLS policies are present in schema list.

---

## 3. Database Restore Command (Separate Target Instance)

To restore the backup into a **separate target verification database**:

```bash
# Target separate verification database
export TARGET_RESTORE_URL="postgres://billz_admin:SECRET@host:5432/billz_pos_restore_test"

# Create target database if needed
psql "$TARGET_RESTORE_URL" -c "CREATE DATABASE billz_pos_restore_test;"

# Execute restore into target database
pg_restore --dbname="$TARGET_RESTORE_URL" \
           --clean \
           --if-exists \
           --no-owner \
           --no-privileges \
           billz_backup_*.dump
```

---

## 4. Post-Restore Verification Checks

1. Verify table counts match source:
   ```sql
   SELECT count(*) FROM tenant_orders;
   SELECT count(*) FROM stock_items;
   ```
2. Execute migration runner on target to confirm checksum parity:
   ```bash
   npm run validate:database
   ```
