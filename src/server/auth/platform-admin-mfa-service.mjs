import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { base32, createTotpCrypto, verifyTotp } from "./totp.mjs";
import { verifyPassword } from "./passwords.mjs";
import { hashOpaqueToken } from "./tokens.mjs";

const invalid = () =>
  Object.assign(new Error("Authentication could not be verified."), {
    code: "MFA_INVALID",
    statusCode: 401,
  });
export function createPlatformAdminMfaService({
  pool,
  sessionSecret,
  passwordPepper,
  clock = () => new Date(),
}) {
  const crypto = createTotpCrypto(sessionSecret);
  function recovery(adminId) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString("hex").toUpperCase().match(/.{6}/g).join("-"),
    );
    return {
      codes,
      hashes: codes.map((code) => crypto.recoveryHash(code, adminId)),
    };
  }
  async function audit(client, adminId, action) {
    await client.query(
      `INSERT INTO audit_logs(actor_admin_id,actor_type,action,resource_type,resource_id,metadata)
      VALUES($1,'platform_admin',$2,'platform_administrator',$1,'{}')`,
      [adminId, `platform_admin.2fa.${action}`],
    );
  }
  async function locked({ adminId, sessionToken }, work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const admin = (
        await client.query(
          "SELECT * FROM platform_administrators WHERE id=$1 AND status='active' FOR UPDATE",
          [adminId],
        )
      ).rows[0];
      const session = (
        await client.query(
          `SELECT id FROM platform_admin_sessions WHERE admin_id=$1 AND token_hash=$2
        AND revoked_at IS NULL AND expires_at>$3 FOR SHARE`,
          [adminId, hashOpaqueToken(sessionToken || ""), clock()],
        )
      ).rows[0];
      if (!admin || !session) throw invalid();
      const result = await work(client, admin);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function password(admin, value) {
    if (!(await verifyPassword(admin.password_hash, value, passwordPepper)))
      throw invalid();
  }
  async function consumeTotp(client, admin, code) {
    if (!admin.totp_enabled) throw invalid();
    const counter = verifyTotp(
      crypto.decrypt(admin.totp_secret_encrypted, admin.id),
      code,
      clock(),
      admin.totp_last_counter,
    );
    if (counter === null) throw invalid();
    await client.query(
      "UPDATE platform_administrators SET totp_last_counter=$2 WHERE id=$1",
      [admin.id, counter],
    );
  }
  return {
    async status(input) {
      return locked(input, async (_client, admin) => ({
        enabled: admin.totp_enabled,
        pending: Boolean(
          admin.totp_pending_id &&
            new Date(admin.totp_pending_expires_at) > clock(),
        ),
        recoveryCodesRemaining: admin.totp_enabled
          ? admin.totp_recovery_hashes.length
          : 0,
      }));
    },
    async start(input) {
      return locked(input, async (client, admin) => {
        await password(admin, input.currentPassword);
        if (admin.totp_enabled)
          throw Object.assign(
            new Error(
              "2FA is already enabled. Disable it before enrolling a new authenticator.",
            ),
            { code: "MFA_ALREADY_ENABLED", statusCode: 409 },
          );
        const secret = base32(randomBytes(20)),
          enrollmentId = randomUUID();
        const generated = recovery(admin.id),
          expiresAt = new Date(clock().getTime() + 600000);
        await client.query(
          `UPDATE platform_administrators SET totp_pending_encrypted=$2,totp_pending_id=$3,
          totp_pending_expires_at=$4,totp_pending_recovery_hashes=$5 WHERE id=$1`,
          [
            admin.id,
            crypto.encrypt(secret, admin.id),
            enrollmentId,
            expiresAt,
            JSON.stringify(generated.hashes),
          ],
        );
        await audit(client, admin.id, "enrollment_started");
        const uri = new URL(
          `otpauth://totp/${encodeURIComponent(`Billz:${admin.username}`)}`,
        );
        uri.search = new URLSearchParams({
          secret,
          issuer: "Billz",
          algorithm: "SHA1",
          digits: "6",
          period: "30",
        }).toString();
        return {
          enrollmentId,
          expiresAt,
          otpauthUri: uri.toString(),
          recoveryCodes: generated.codes,
        };
      });
    },
    async enable(input) {
      return locked(input, async (client, admin) => {
        if (
          admin.totp_enabled ||
          admin.totp_pending_id !== input.enrollmentId ||
          new Date(admin.totp_pending_expires_at) <= clock()
        )
          throw invalid();
        const counter = verifyTotp(
          crypto.decrypt(admin.totp_pending_encrypted, admin.id),
          input.code,
          clock(),
        );
        if (counter === null) throw invalid();
        await client.query(
          `UPDATE platform_administrators SET totp_enabled=true,totp_secret_encrypted=totp_pending_encrypted,
          totp_last_counter=$2,totp_recovery_hashes=totp_pending_recovery_hashes,totp_pending_encrypted=NULL,
          totp_pending_id=NULL,totp_pending_expires_at=NULL,totp_pending_recovery_hashes='[]' WHERE id=$1`,
          [admin.id, counter],
        );
        await client.query(
          "UPDATE platform_admin_sessions SET revoked_at=$3 WHERE admin_id=$1 AND token_hash<>$2 AND revoked_at IS NULL",
          [admin.id, hashOpaqueToken(input.sessionToken), clock()],
        );
        await audit(client, admin.id, "enabled");
        return { enabled: true };
      });
    },
    async disable(input) {
      return locked(input, async (client, admin) => {
        await password(admin, input.currentPassword);
        await consumeTotp(client, admin, input.code);
        await client.query(
          `UPDATE platform_administrators SET totp_enabled=false,totp_secret_encrypted=NULL,totp_last_counter=-1,
          totp_recovery_hashes='[]',totp_pending_encrypted=NULL,totp_pending_id=NULL,totp_pending_expires_at=NULL,
          totp_pending_recovery_hashes='[]' WHERE id=$1`,
          [admin.id],
        );
        await client.query(
          "UPDATE platform_admin_sessions SET revoked_at=$3 WHERE admin_id=$1 AND token_hash<>$2 AND revoked_at IS NULL",
          [admin.id, hashOpaqueToken(input.sessionToken), clock()],
        );
        await audit(client, admin.id, "disabled");
        return { enabled: false };
      });
    },
    async regenerate(input) {
      return locked(input, async (client, admin) => {
        await password(admin, input.currentPassword);
        await consumeTotp(client, admin, input.code);
        const generated = recovery(admin.id);
        await client.query(
          "UPDATE platform_administrators SET totp_recovery_hashes=$2 WHERE id=$1",
          [admin.id, JSON.stringify(generated.hashes)],
        );
        return { recoveryCodes: generated.codes };
      });
    },
    async verifyLogin(client, admin, code) {
      if (!admin.totp_enabled) return;
      if (/^\d{6}$/.test(code || "")) return consumeTotp(client, admin, code);
      const hash = crypto.recoveryHash(code || "", admin.id);
      const hashes = admin.totp_recovery_hashes;
      const index = hashes.findIndex((value) =>
        timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(hash, "hex")),
      );
      if (index < 0) throw invalid();
      await client.query(
        "UPDATE platform_administrators SET totp_recovery_hashes=$2 WHERE id=$1",
        [admin.id, JSON.stringify(hashes.filter((_hash, i) => i !== index))],
      );
    },
  };
}
