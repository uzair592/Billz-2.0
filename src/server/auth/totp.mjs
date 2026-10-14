import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes) {
  let bits = 0,
    value = 0,
    result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}
function decode(value) {
  let bits = 0,
    buffer = 0;
  const bytes = [];
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Invalid authenticator configuration.");
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}
export function totp(secret, counter, { digits = 6, algorithm = "sha1" } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}
export function verifyTotp(secret, code, now, lastCounter = -1) {
  if (!/^\d{6}$/.test(code || "")) return null;
  const counter = Math.floor(new Date(now).getTime() / 30000);
  let matched = null;
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (candidate < 0) continue;
    const valid = timingSafeEqual(
      Buffer.from(totp(secret, candidate)),
      Buffer.from(code),
    );
    if (valid && candidate > Number(lastCounter)) matched = candidate;
  }
  return matched;
}
export function createTotpCrypto(sessionSecret) {
  if (typeof sessionSecret !== "string" || sessionSecret.length < 16)
    throw new Error("SESSION_SECRET is required for administrator 2FA.");
  const key = Buffer.from(
    hkdfSync("sha256", sessionSecret, "Billz", "platform-admin-totp-v1", 32),
  );
  return {
    encrypt(secret, adminId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(adminId));
      const encrypted = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        iv.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },
    decrypt(value, adminId) {
      try {
        const [version, iv, encrypted, tag] = value.split(".");
        if (version !== "v1") throw new Error();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(iv, "base64url"),
        );
        decipher.setAAD(Buffer.from(adminId));
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(encrypted, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw Object.assign(
          new Error(
            "Administrator 2FA configuration cannot be read. Contact the operator.",
          ),
          { code: "MFA_CONFIGURATION_INVALID", statusCode: 503 },
        );
      }
    },
    recoveryHash(code, adminId) {
      return createHmac("sha256", key)
        .update(`${adminId}:${String(code).replaceAll("-", "").toUpperCase()}`)
        .digest("hex");
    },
  };
}
