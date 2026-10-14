import argon2 from "argon2";
import { validatePassword, PasswordValidationError } from "./password-policy.mjs";

function passwordMaterial(password, pepper) {
  validatePassword(password);
  if (typeof pepper !== "string" || pepper.length < 16) {
    throw Object.assign(new TypeError("Password pepper configuration is invalid."), { code: "PASSWORD_CONFIGURATION_INVALID", statusCode: 503 });
  }
  return `${password}\u0000${pepper}`;
}

export async function hashPassword(password, pepper) {
  const material = passwordMaterial(password, pepper);
  try { return await argon2.hash(material, {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  }); } catch (error) {
    if (error instanceof TypeError) throw new PasswordValidationError("Password could not be processed.");
    throw error;
  }
}

export async function verifyPassword(hash, password, pepper) {
  if (typeof password !== "string" || !password.length || password.length > 200 || typeof pepper !== "string" || pepper.length < 16) return false;
  const realHash = typeof hash === "string" && hash.startsWith("$argon2id$");
  try {
    // Setting passwords still requires 10 characters. Verification accepts
    // legacy passwords and spends Argon2 work even for an absent account.
    if (!realHash) hash = await (dummyHash ??= hashPassword("dummy-authentication-password", pepper));
    const valid = await argon2.verify(hash, `${password}\u0000${pepper}`);
    return realHash && valid;
  } catch {
    return false;
  }
}
let dummyHash;
