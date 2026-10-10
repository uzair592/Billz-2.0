import { hashPassword, verifyPassword } from "./passwords.mjs";
import { createTokenPair, hashOpaqueToken } from "./tokens.mjs";

const ADMIN_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

function publicAdmin(admin) {
  return {
    id: admin.id,
    username: admin.username,
    displayName: admin.displayName,
    role: "super_admin",
  };
}

export function createPlatformAdminService({ repository, passwordPepper, clock = () => new Date() }) {
  if (!repository) throw new TypeError("A platform admin repository is required.");

  return Object.freeze({
    async bootstrapAdmin({ username, password, displayName = "Super Admin" }) {
      const existing = await repository.findAdminByUsername(username);
      if (existing) {
        return { created: false, admin: publicAdmin(existing) };
      }
      const passwordHash = await hashPassword(password, passwordPepper);
      const admin = await repository.createAdmin({ username, passwordHash, displayName });
      await repository.recordAuditLog({
        adminId: admin.id,
        action: "platform_admin.bootstrap",
        resourceType: "platform_administrator",
        resourceId: admin.id,
        metadata: { username: admin.username },
      });
      return { created: true, admin: publicAdmin(admin) };
    },

    async login({ username, password, ipAddress = null, userAgent = null }) {
      const admin = await repository.findAdminByUsername(username);
      if (!admin || !(await verifyPassword(admin.passwordHash, password, passwordPepper))) {
        const error = new Error("Invalid administrator username or password.");
        error.code = "INVALID_ADMIN_CREDENTIALS";
        error.statusCode = 401;
        throw error;
      }
      if (admin.status !== "active") {
        const error = new Error("This administrator account is disabled.");
        error.code = "ADMIN_DISABLED";
        error.statusCode = 403;
        throw error;
      }

      const session = createTokenPair();
      const now = clock();
      const expiresAt = new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS);
      await repository.createAdminSession({
        adminId: admin.id,
        tokenHash: session.tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
      });

      await repository.recordAuditLog({
        adminId: admin.id,
        action: "platform_admin.login",
        resourceType: "platform_administrator",
        resourceId: admin.id,
        metadata: { ipAddress, userAgent },
      });

      return { token: session.token, expiresAt, admin: publicAdmin(admin) };
    },

    async authenticate(token) {
      if (!token) return null;
      return repository.findActiveAdminSession(hashOpaqueToken(token), clock());
    },

    async logout(token) {
      if (!token) return;
      const session = await repository.findActiveAdminSession(hashOpaqueToken(token), clock());
      if (session) {
        await repository.recordAuditLog({
          adminId: session.admin.id,
          action: "platform_admin.logout",
          resourceType: "platform_administrator",
          resourceId: session.admin.id,
        });
      }
      await repository.revokeAdminSession(hashOpaqueToken(token), clock());
    },
  });
}
