import { randomUUID, createHash } from "node:crypto";
import { withTenantTransaction } from "../database/tenant-transaction.mjs";

const DEFAULT_QUOTA_BYTES = 5368709120;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", "text/plain", "text/csv"]);
function usage(row) {
  const max = Number(row?.max_storage_bytes ?? DEFAULT_QUOTA_BYTES);
  const used = Number(row?.used_storage_bytes ?? 0);
  const ratio = max > 0 ? used / max : 1;
  return { maxStorageBytes: max, usedStorageBytes: used,
    remainingStorageBytes: Math.max(0, max - used), usagePercentage: Math.round(ratio * 10000) / 100,
    warningLevel: ratio >= 1 ? "quota_reached_100" : ratio >= .9 ? "warning_90" : ratio >= .8 ? "warning_80" : null,
    meteringScope: "managed_file_bytes" };
}
function fail(message, code, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
export function createStorageService({ pool, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("A PostgreSQL pool is required.");
  const tx = (restaurantId, operation) => withTenantTransaction(pool, { restaurantId }, operation);
  return Object.freeze({
    async getStorageUsage(restaurantId) {
      return tx(restaurantId, async client => usage((await client.query(
        "SELECT max_storage_bytes, used_storage_bytes FROM tenant_storage_allowances WHERE restaurant_id = $1", [restaurantId])).rows[0]));
    },
    async reserveAndStoreAsset({ restaurantId, fileName, mimeType, buffer }) {
      if (!restaurantId || typeof fileName !== "string" || !fileName.trim() || fileName.length > 255 || !buffer) throw new TypeError("Restaurant, filename and content are required.");
      if (!ALLOWED_MIME_TYPES.has(mimeType)) fail("Unsupported file type.", "INVALID_MIME_TYPE", 400);
      const bytes = Buffer.from(buffer);
      if (!bytes.length || bytes.length > MAX_ASSET_BYTES) fail("Files must contain 1 byte to 10 MB.", "ASSET_SIZE_INVALID", 413);
      return tx(restaurantId, async client => {
        // Insert before locking, so competing first uploads serialize too.
        await client.query(`INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes)
          VALUES ($1, $2, 0) ON CONFLICT (restaurant_id) DO NOTHING`, [restaurantId, DEFAULT_QUOTA_BYTES]);
        const row = (await client.query(`SELECT max_storage_bytes, used_storage_bytes FROM tenant_storage_allowances
          WHERE restaurant_id = $1 FOR UPDATE`, [restaurantId])).rows[0];
        if (Number(row.used_storage_bytes) + bytes.length > Number(row.max_storage_bytes)) fail("Storage quota exceeded.", "STORAGE_QUOTA_EXCEEDED", 413);
        const assetId = randomUUID();
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        await client.query(`INSERT INTO managed_file_assets (id, restaurant_id, file_name, mime_type, byte_size, content, sha256, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [assetId, restaurantId, fileName.trim(), mimeType, bytes.length, bytes, sha256, clock()]);
        await client.query(`UPDATE tenant_storage_allowances SET used_storage_bytes = used_storage_bytes + $2 WHERE restaurant_id = $1`, [restaurantId, bytes.length]);
        return { assetId, fileName: fileName.trim(), mimeType, byteSize: bytes.length, sha256,
          ...usage({ ...row, used_storage_bytes: Number(row.used_storage_bytes) + bytes.length }) };
      });
    },
    async readAsset({ restaurantId, assetId }) {
      return tx(restaurantId, async client => {
        const row = (await client.query(`SELECT file_name, mime_type, byte_size, content, sha256 FROM managed_file_assets
          WHERE restaurant_id = $1 AND id = $2 AND content IS NOT NULL`, [restaurantId, assetId])).rows[0];
        if (!row) fail("File not found.", "ASSET_NOT_FOUND", 404);
        return { fileName: row.file_name, mimeType: row.mime_type, byteSize: Number(row.byte_size), buffer: row.content, sha256: row.sha256 };
      });
    },
    async deleteAsset({ restaurantId, assetId }) {
      return tx(restaurantId, async client => {
        // Same lock order as upload.
        await client.query(`SELECT restaurant_id FROM tenant_storage_allowances WHERE restaurant_id = $1 FOR UPDATE`, [restaurantId]);
        const row = (await client.query(`DELETE FROM managed_file_assets WHERE restaurant_id = $1 AND id = $2 RETURNING byte_size, content IS NOT NULL AS retained`, [restaurantId, assetId])).rows[0];
        if (row?.retained) await client.query(`UPDATE tenant_storage_allowances SET used_storage_bytes = GREATEST(0, used_storage_bytes - $2) WHERE restaurant_id = $1`, [restaurantId, row.byte_size]);
        return { deleted: !!row };
      });
    },
  });
}
