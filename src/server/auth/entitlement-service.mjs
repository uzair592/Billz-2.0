import { createHmac, timingSafeEqual } from "node:crypto";


const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createEntitlementService({
  secret = process.env.OFFLINE_ENTITLEMENT_SECRET,
  clock = () => new Date(),
} = {}) {
  if (typeof secret !== "string" || secret.length < 32) throw new TypeError("A private entitlement signing secret of at least 32 characters is required.");
  function sign(payloadString) {
    return createHmac("sha256", secret).update(payloadString).digest("hex");
  }

  return Object.freeze({
    issueToken({ restaurantId, userId, deviceId, permissions = [], subscriptionState = "active", validUntil, ttlMs = MAX_TTL_MS }) {
      if (!restaurantId || !userId || !deviceId) {
        throw new TypeError("restaurantId, userId, and deviceId are required.");
      }

      if (!["active", "trialing", "past_due", "cancel_at_period_end"].includes(subscriptionState)) {
        const error = new Error("Cannot issue offline entitlement for suspended or expired subscription.");
        error.code = "SUBSCRIPTION_INELIGIBLE";
        error.statusCode = 403;
        throw error;
      }

      const now = clock();
      const end = new Date(validUntil).getTime();
      if (!Number.isFinite(end) || end <= now.getTime() || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("A future subscription boundary and positive TTL are required.");
      const actualTtl = Math.min(ttlMs, MAX_TTL_MS, end - now.getTime());
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
      const issued = new Date(claims.issuedAt).getTime();
      const expires = new Date(claims.expiresAt).getTime();
      if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > MAX_TTL_MS || issued > now.getTime() + 60000 || !claims.restaurantId || !claims.userId || !claims.deviceId) return { valid: false, reason: "invalid_claims" };

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
