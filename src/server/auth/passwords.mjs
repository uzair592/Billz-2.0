import argon2 from "argon2";

const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 200;

function passwordMaterial(password, pepper) {
  if (typeof password !== "string") throw new TypeError("Password is required.");
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new TypeError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new TypeError(`Password must not exceed ${PASSWORD_MAX_LENGTH} characters.`);
  }
  if (typeof pepper !== "string" || pepper.length < 16) {
    throw new TypeError("A password pepper of at least 16 characters is required.");
  }
  return `${password}\u0000${pepper}`;
}

export async function hashPassword(password, pepper) {
  return argon2.hash(passwordMaterial(password, pepper), {
    type: argon2.argon2id,
    memoryCost: 19 * 1024,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
}

export async function verifyPassword(hash, password, pepper) {
  if (typeof hash !== "string" || !hash.startsWith("$argon2id$")) return false;
  try {
    return await argon2.verify(hash, passwordMaterial(password, pepper));
  } catch {
    return false;
  }
}
