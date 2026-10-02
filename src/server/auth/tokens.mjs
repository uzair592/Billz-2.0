import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token) {
  if (typeof token !== "string" || token.length < 32) {
    throw new TypeError("A valid opaque token is required.");
  }
  return createHash("sha256").update(token, "utf8").digest();
}

export function createTokenPair() {
  const token = createOpaqueToken();
  return Object.freeze({ token, tokenHash: hashOpaqueToken(token) });
}
