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

export function createPlatformAdminService({
  repository,
  passwordPepper,
  mfaService = null,
  clock = () => new Date(),
}) {
  if (!repository)
    throw new TypeError("A platform admin repository is required.");

  return Object.freeze({
    async bootstrapAdmin({ username, password, displayName = "Super Admin" }) {
      const existing = await repository.findAdminByUsername(username);
      if (existing) {
        return { created: false, admin: publicAdmin(existing) };
      }
      const passwordHash = await hashPassword(password, passwordPepper);
      const admin = await repository.createAdmin({
        username,
        passwordHash,
        displayName,
      });
      await repository.recordAuditLog({
        adminId: admin.id,
        action: "platform_admin.bootstrap",
        resourceType: "platform_administrator",
        resourceId: admin.id,
        metadata: { username: admin.username },
      });
      return { created: true, admin: publicAdmin(admin) };
    },

    async login({
      username,
      password,
      code,
      ipAddress = null,
      userAgent = null,
    }) {
      const admin = await repository.findAdminByUsername(username);
      const validPassword = await verifyPassword(
        admin?.passwordHash,
        password,
        passwordPepper,
      );
      if (!admin || !validPassword) {
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
      const sessionInput = {
        adminId: admin.id,
        expectedPasswordHash: admin.passwordHash,
        tokenHash: session.tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
      };
      if (repository.completeAdminLogin) {
        try {
          await repository.completeAdminLogin({
            ...sessionInput,
            verifyMfa: async (client, row) => {
              if (row.totp_enabled) {
                if (!mfaService)
                  throw Object.assign(new Error("2FA is unavailable."), {
                    code: "MFA_INVALID",
                  });
                await mfaService.verifyLogin(client, row, code);
              }
            },
          });
        } catch (error) {
          if (error.code === "MFA_INVALID")
            throw Object.assign(
              new Error(
                "Invalid administrator credentials or verification code.",
              ),
              { code: "INVALID_ADMIN_CREDENTIALS", statusCode: 401 },
            );
          throw error;
        }
      } else {
        if (admin.totpEnabled)
          throw Object.assign(
            new Error("2FA requires a transactional repository."),
            { code: "MFA_CONFIGURATION_INVALID", statusCode: 503 },
          );
        await repository.createAdminSession(sessionInput);

        await repository.recordAuditLog({
          adminId: admin.id,
          action: "platform_admin.login",
          resourceType: "platform_administrator",
          resourceId: admin.id,
          metadata: { ipAddress },
        });
      }

      return { token: session.token, expiresAt, admin: publicAdmin(admin) };
    },

    async authenticate(token) {
      if (!token) return null;
      return repository.findActiveAdminSession(hashOpaqueToken(token), clock());
    },

    async logout(token) {
      if (!token) return;
      const session = await repository.findActiveAdminSession(
        hashOpaqueToken(token),
        clock(),
      );
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
