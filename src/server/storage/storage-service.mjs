import { randomUUID } from "node:crypto";

const DEFAULT_QUOTA_BYTES = 5368709120; // 5 GB
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "text/csv",
]);

export function createStorageService({ pool, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL connection pool is required.");
  }

  return Object.freeze({
    async getStorageUsage(restaurantId) {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT max_storage_bytes, used_storage_bytes
             FROM tenant_storage_allowances
            WHERE restaurant_id = $1`,
          [restaurantId],
        );
        const row = result.rows[0];
        const maxBytes = Number(row?.max_storage_bytes ?? DEFAULT_QUOTA_BYTES);
        const usedBytes = Number(row?.used_storage_bytes ?? 0);
        const usageRatio = maxBytes > 0 ? usedBytes / maxBytes : 0;

        let warningLevel = null;
        if (usageRatio >= 1.0) warningLevel = "quota_reached_100";
        else if (usageRatio >= 0.9) warningLevel = "warning_90";
        else if (usageRatio >= 0.8) warningLevel = "warning_80";

        return {
          maxStorageBytes: maxBytes,
          usedStorageBytes: usedBytes,
          remainingStorageBytes: Math.max(0, maxBytes - usedBytes),
          usagePercentage: Math.round(usageRatio * 10000) / 100,
          warningLevel,
        };
      } finally {
        client.release();
      }
    },

    async reserveAndStoreAsset({ restaurantId, fileName, mimeType, buffer }) {
      if (!restaurantId || !fileName || !mimeType || !buffer) {
        throw new TypeError("restaurantId, fileName, mimeType, and buffer are required.");
      }

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        const err = new Error(`Unsupported MIME type: ${mimeType}`);
        err.code = "INVALID_MIME_TYPE";
        err.statusCode = 400;
        throw err;
      }

      // Calculate actual size from actual received bytes, NOT Content-Length header
      const actualByteSize = Buffer.isBuffer(buffer) ? buffer.length : Buffer.from(buffer).length;

      const client = await pool.connect();
      const assetId = randomUUID();

      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.restaurant_id', $1, true)", [restaurantId]);

        // Lock storage allowance row FOR UPDATE to prevent concurrent over-allocation
        const allowanceResult = await client.query(
          `SELECT max_storage_bytes, used_storage_bytes
             FROM tenant_storage_allowances
            WHERE restaurant_id = $1
            FOR UPDATE`,
          [restaurantId],
        );

        let maxBytes = DEFAULT_QUOTA_BYTES;
        let usedBytes = 0;

        if (allowanceResult.rows[0]) {
          maxBytes = Number(allowanceResult.rows[0].max_storage_bytes);
          usedBytes = Number(allowanceResult.rows[0].used_storage_bytes);
        } else {
          // Initialize default allowance
          await client.query(
            `INSERT INTO tenant_storage_allowances (restaurant_id, max_storage_bytes, used_storage_bytes)
             VALUES ($1, $2, 0)`,
            [restaurantId, DEFAULT_QUOTA_BYTES],
          );
        }

        if (usedBytes + actualByteSize > maxBytes) {
          const overageErr = new Error(
            `Storage quota exceeded. Allowed: ${maxBytes} bytes, Used: ${usedBytes} bytes, Attempted: ${actualByteSize} bytes.`,
          );
          overageErr.code = "STORAGE_QUOTA_EXCEEDED";
          overageErr.statusCode = 413;
          throw overageErr;
        }

        const newUsed = usedBytes + actualByteSize;

        await client.query(
          `UPDATE tenant_storage_allowances
              SET used_storage_bytes = $2, updated_at = $3
            WHERE restaurant_id = $1`,
          [restaurantId, newUsed, clock()],
        );

        await client.query(
          `INSERT INTO managed_file_assets (id, restaurant_id, file_name, mime_type, byte_size, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [assetId, restaurantId, fileName, mimeType, actualByteSize, clock()],
        );

        await client.query("COMMIT");

        const ratio = maxBytes > 0 ? newUsed / maxBytes : 0;
        let warningLevel = null;
        if (ratio >= 1.0) warningLevel = "quota_reached_100";
        else if (ratio >= 0.9) warningLevel = "warning_90";
        else if (ratio >= 0.8) warningLevel = "warning_80";

        return {
          assetId,
          fileName,
          mimeType,
          byteSize: actualByteSize,
          usedStorageBytes: newUsed,
          maxStorageBytes: maxBytes,
          warningLevel,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
