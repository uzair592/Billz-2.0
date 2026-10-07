import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_SECRET = "offline-entitlement-secret-key-32-chars!!";
const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createEntitlementService({
  secret = process.env.OFFLINE_ENTITLEMENT_SECRET || DEFAULT_SECRET,
  clock = () => new Date(),
} = {}) {
  function sign(payloadString) {
    return createHmac("sha256", secret).update(payloadString).digest("hex");
  }

  return Object.freeze({
    issueToken({ restaurantId, userId, deviceId, permissions = [], subscriptionState = "active", ttlMs = MAX_TTL_MS }) {
      if (!restaurantId || !userId || !deviceId) {
        throw new TypeError("restaurantId, userId, and deviceId are required.");
      }

      if (subscriptionState === "suspended" || subscriptionState === "expired") {
        const error = new Error("Cannot issue offline entitlement for suspended or expired subscription.");
        error.code = "SUBSCRIPTION_INELIGIBLE";
        error.statusCode = 403;
        throw error;
      }

      const now = clock();
      const actualTtl = Math.min(ttlMs, MAX_TTL_MS);
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + actualTtl).toISOString();

      const claims = {
        restaurantId,
        userId,
        deviceId,
        permissions,
        subscriptionState,
        issuedAt,
        expiresAt,
      };

      const payloadString = JSON.stringify(claims);
      const signature = sign(payloadString);

      return {
        token: Buffer.from(payloadString).toString("base64url") + "." + signature,
        claims,
      };
    },

    verifyToken(token, { currentDeviceId = null, currentRestaurantId = null, lastKnownServerTime = null } = {}) {
      if (!token || typeof token !== "string" || !token.includes(".")) {
        return { valid: false, reason: "malformed_token" };
      }

      const [encodedPayload, signature] = token.split(".");
      let payloadString;
      try {
        payloadString = Buffer.from(encodedPayload, "base64url").toString("utf8");
      } catch {
        return { valid: false, reason: "invalid_encoding" };
      }

      const expectedSignature = sign(payloadString);
      const sigBuffer = Buffer.from(signature, "hex");
      const expBuffer = Buffer.from(expectedSignature, "hex");

      if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
        return { valid: false, reason: "tampered_signature" };
      }

      let claims;
      try {
        claims = JSON.parse(payloadString);
      } catch {
        return { valid: false, reason: "invalid_claims_json" };
      }

      const now = clock();

      if (new Date(claims.expiresAt).getTime() <= now.getTime()) {
        return { valid: false, reason: "token_expired", claims };
      }

      if (currentDeviceId && claims.deviceId !== currentDeviceId) {
        return { valid: false, reason: "device_mismatch", claims };
      }

      if (currentRestaurantId && claims.restaurantId !== currentRestaurantId) {
        return { valid: false, reason: "restaurant_mismatch", claims };
      }

      if (claims.subscriptionState === "suspended") {
        return { valid: false, reason: "subscription_suspended", claims };
      }

      // Defence-in-depth: System clock rollback detection
      if (lastKnownServerTime && now.getTime() < new Date(lastKnownServerTime).getTime() - 60000) {
        return { valid: false, reason: "clock_rollback_detected", claims };
      }

      return { valid: true, claims };
    },
  });
}
