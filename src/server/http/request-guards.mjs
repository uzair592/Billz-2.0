import { hasPermission } from "../authorization/permissions.mjs";
import {
  ACCESS_LEVEL,
  evaluateSubscriptionAccess,
} from "../subscriptions/access-policy.mjs";
import { isUuid } from "../tenancy/tenant-context-service.mjs";

export const SESSION_COOKIE_NAME = "pos_session";

function reject(reply, statusCode, error, code) {
  return reply.code(statusCode).send({ error, code });
}

export function createRequestGuards({ authService, tenantContextService }) {
  if (!authService || !tenantContextService) {
    throw new TypeError("Authentication and tenant-context services are required.");
  }

  async function authenticate(request, reply) {
    let session = null;
    try {
      session = await authService.authenticate(
        request.cookies?.[SESSION_COOKIE_NAME],
      );
    } catch {
      session = null;
    }
    if (!session) {
      return reject(reply, 401, "Authentication is required.", "UNAUTHENTICATED");
    }
    request.auth = session;
  }

  function tenant(permission, { subscriptionRequired = true } = {}) {
    return async function tenantGuard(request, reply) {
      if (!request.auth?.user) {
        return reject(reply, 401, "Authentication is required.", "UNAUTHENTICATED");
      }
      const restaurantId = request.headers["x-restaurant-id"];
      if (!isUuid(restaurantId)) {
        return reject(reply, 400, "A valid restaurant context is required.", "RESTAURANT_REQUIRED");
      }

      const context = await tenantContextService.load({
        userId: request.auth.user.id,
        restaurantId,
      });
      if (!context) {
        return reject(reply, 403, "Restaurant access is not available.", "MEMBERSHIP_REQUIRED");
      }
      if (!hasPermission(context.membership.role, permission)) {
        return reject(reply, 403, "You do not have permission to perform this action.", "FORBIDDEN");
      }

      const subscription = evaluateSubscriptionAccess({
        restaurantStatus: context.restaurant.status,
        subscription: context.subscription,
      });
      if (subscriptionRequired && subscription.level !== ACCESS_LEVEL.FULL) {
        return reject(reply, 402, "An active restaurant subscription is required.", "SUBSCRIPTION_REQUIRED");
      }

      request.tenant = Object.freeze({ ...context, subscriptionAccess: subscription });
    };
  }

  return Object.freeze({ authenticate, tenant });
}
