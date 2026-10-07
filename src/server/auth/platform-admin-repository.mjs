import { randomUUID } from "node:crypto";
import { hashOpaqueToken } from "./tokens.mjs";

function mapAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    passwordHash: row.password_hash,
  };
}

export function createPlatformAdminRepository(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("A PostgreSQL connection pool is required.");
  }

  return Object.freeze({
    async createAdmin({ username, passwordHash, displayName }) {
      const id = randomUUID();
      const normUsername = String(username).trim().toLowerCase();
      const result = await pool.query(
        `INSERT INTO platform_administrators (id, username, normalized_username, password_hash, display_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, display_name, status, password_hash`,
        [id, String(username).trim(), normUsername, passwordHash, String(displayName).trim()],
      );
      return mapAdmin(result.rows[0]);
    },

    async findAdminByUsername(username) {
      const normUsername = String(username ?? "").trim().toLowerCase();
      const result = await pool.query(
        `SELECT id, username, display_name, status, password_hash
           FROM platform_administrators
          WHERE normalized_username = $1`,
        [normUsername],
      );
      return mapAdmin(result.rows[0]);
    },

    async createAdminSession({ adminId, tokenHash, ipAddress, userAgent, expiresAt }) {
      await pool.query(
        `INSERT INTO platform_admin_sessions (admin_id, token_hash, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, tokenHash, ipAddress, userAgent, expiresAt],
      );
    },

    async findActiveAdminSession(tokenHash, now) {
      const result = await pool.query(
        `SELECT s.admin_id, s.expires_at, a.id, a.username, a.display_name, a.status, a.password_hash
           FROM platform_admin_sessions s
           JOIN platform_administrators a ON a.id = s.admin_id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND a.status = 'active'`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      return row ? { admin: mapAdmin(row), expiresAt: row.expires_at } : null;
    },

    async revokeAdminSession(tokenHash, now) {
      await pool.query(
        `UPDATE platform_admin_sessions SET revoked_at = COALESCE(revoked_at, $2)
          WHERE token_hash = $1`,
        [tokenHash, now],
      );
    },

    async recordAuditLog({ restaurantId = null, adminId, action, resourceType, resourceId = null, metadata = {} }) {
      await pool.query(
        `INSERT INTO audit_logs (restaurant_id, actor_admin_id, actor_type, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, 'platform_admin', $3, $4, $5, $6)`,
        [restaurantId, adminId, action, resourceType, resourceId, JSON.stringify(metadata)],
      );
    },
  });
}
