import { hashPassword, verifyPassword } from "./passwords.mjs";
import { createTokenPair, hashOpaqueToken } from "./tokens.mjs";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const VERIFICATION_LIFETIME_MS = 30 * 60 * 1000;

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    platformRole: user.platformRole,
  };
}

function authenticationError() {
  const error = new Error("Invalid username or password.");
  error.code = "INVALID_CREDENTIALS";
  error.statusCode = 401;
  return error;
}

export function createAuthService({ repository, mailer, passwordPepper, clock = () => new Date() }) {
  if (!repository) throw new TypeError("An authentication repository is required.");
  if (!mailer || typeof mailer.sendVerification !== "function") {
    throw new TypeError("A verification mailer is required.");
  }

  async function createSessionForUser(user, { ipAddress, userAgent, now, restaurantCode, previousSessionToken }) {
    const session = createTokenPair();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await repository.createSession({
      userId: user.id,
      expectedPasswordHash: user.passwordHash,
      expectedUsername: user.username ?? null,
      expectedEmail: user.email,
      previousTokenHash: previousSessionToken ? hashOpaqueToken(previousSessionToken) : null,
      now,
      expectedRestaurantId: user.restaurantId ?? null,
      expectedRestaurantCode: restaurantCode ?? null,
      tokenHash: session.tokenHash,
      ipAddress,
      userAgent,
      expiresAt,
    });
    return { token: session.token, expiresAt, user: publicUser(user) };
  }

  return Object.freeze({
    async register({ email, password, displayName, restaurantName }) {
      // Self-registration is gated by the mail policy. In
      // production without a transactional mail provider it is
      // disabled, and the attempt must fail clearly before any
      // pending user is created. Bootstrap-created owners are
      // written directly by the bootstrap CLI and are not
      // affected by this gate.
      if (mailer.registrationEnabled === false) {
        const error = new Error(
          "Self-registration is disabled. Contact the platform "
          + "operator to provision an account.",
        );
        error.code = "REGISTRATION_DISABLED";
        error.statusCode = 503;
        throw error;
      }

      const normalizedEmail = normalizeEmail(email);
      const passwordHash = await hashPassword(password, passwordPepper);
      const verification = createTokenPair();
      const now = clock();
      const verificationExpiresAt = new Date(
        now.getTime() + VERIFICATION_LIFETIME_MS,
      );

      let account;
      try {
        account = await repository.createPendingOwner({
          email: String(email).trim(),
          normalizedEmail,
          displayName: String(displayName).trim(),
          restaurantName: String(restaurantName).trim(),
          passwordHash,
          verificationTokenHash: verification.tokenHash,
          verificationExpiresAt,
        });
      } catch (error) {
        // Do not disclose whether an account already exists for an email.
        if (error.code === "EMAIL_EXISTS") return { verificationRequired: true };
        throw error;
      }

      await mailer.sendVerification({
        email: account.email,
        displayName: account.displayName,
        token: verification.token,
        expiresAt: verificationExpiresAt,
      });

      return { verificationRequired: true };
    },

    async verifyEmail({ token, ipAddress = null, userAgent = null }) {
      const now = clock();
      const user = await repository.consumeEmailVerification({
        tokenHash: hashOpaqueToken(token),
        now,
      });
      if (!user) {
        const error = new Error("The verification link is invalid or has expired.");
        error.code = "INVALID_VERIFICATION_TOKEN";
        error.statusCode = 400;
        throw error;
      }
      return createSessionForUser(user, { ipAddress, userAgent, now });
    },

    async login({ restaurantCode, username, email, password, ipAddress = null, userAgent = null, previousSessionToken = null }) {
      if (username) {
        let lookup;
        if (restaurantCode) {
          if (typeof repository.findUserByRestaurantAndUsername !== "function") {
            throw authenticationError();
          }
          lookup = await repository.findUserByRestaurantAndUsername({
            restaurantCode,
            username,
          });
        } else if (typeof repository.findUserByUsernameOnly === "function") {
          lookup = await repository.findUserByUsernameOnly({ username });
        } else {
          throw authenticationError();
        }
        const { restaurant, user } = lookup;

        const validPassword = await verifyPassword(user?.passwordHash, password, passwordPepper);
        if (!user || !validPassword) {
          throw authenticationError();
        }

        if (restaurant && restaurant.status === "suspended") {
          const error = new Error("This restaurant subscription is currently suspended.");
          error.code = "RESTAURANT_SUSPENDED";
          error.statusCode = 403;
          error.restaurant = restaurant;
          error.user = publicUser(user);
          throw error;
        }

        if (user.status === "disabled" || user.status === "suspended") {
          const error = new Error("This user account is disabled.");
          error.code = "USER_DISABLED";
          error.statusCode = 403;
          throw error;
        }

        return createSessionForUser(user, { ipAddress, userAgent, now: clock(), restaurantCode: restaurant?.code ?? null, previousSessionToken });
      }

      const user = await repository.findUserByEmail(normalizeEmail(email));
      const validPassword = await verifyPassword(user?.passwordHash, password, passwordPepper);
      if (!user || !validPassword) {
        throw authenticationError();
      }
      if (user.status !== "active" || (user.email && !user.emailVerifiedAt)) {
        const error = new Error("Verify your email before signing in.");
        error.code = "EMAIL_VERIFICATION_REQUIRED";
        error.statusCode = 403;
        throw error;
      }
      return createSessionForUser(user, { ipAddress, userAgent, now: clock(), previousSessionToken });
    },

    async authenticate(token) {
      if (!token) return null;
      return repository.findActiveSession(hashOpaqueToken(token), clock());
    },

    async changePassword({ userId, sessionToken, currentPassword, newPassword, newUsername }) {
      const passwordHash = await hashPassword(newPassword, passwordPepper);
      await repository.changePassword({
        userId, sessionTokenHash: hashOpaqueToken(sessionToken), passwordHash, now: clock(),
        verifyCurrentPassword: hash => verifyPassword(hash, currentPassword, passwordPepper),
        newUsername,
      });
      return { changed: true };
    },

    async logout(token) {
      if (!token) return;
      await repository.revokeSession(hashOpaqueToken(token), clock());
    },

    async revokeAndLogin({ restaurantCode, username, email, password, sessionToRevokeId, ipAddress = null, userAgent = null }) {
      if (!sessionToRevokeId) {
        throw Object.assign(new Error("Session to revoke is required."), { code: "SESSION_ID_REQUIRED", statusCode: 400 });
      }
      let lookup;
      if (username) {
        if (restaurantCode) {
          lookup = await repository.findUserByRestaurantAndUsername({ restaurantCode, username });
        } else {
          lookup = await repository.findUserByUsernameOnly({ username });
        }
      } else if (email) {
        const u = await repository.findUserByEmail(normalizeEmail(email));
        lookup = { user: u, restaurant: u ? { id: u.restaurantId } : null };
      }
      const { restaurant, user } = lookup || {};
      const validPassword = await verifyPassword(user?.passwordHash, password, passwordPepper);
      if (!user || !validPassword) throw authenticationError();
      if (user.status === "disabled" || user.status === "suspended") {
        throw Object.assign(new Error("This user account is disabled."), { code: "USER_DISABLED", statusCode: 403 });
      }

      const now = clock();
      const session = createTokenPair();
      const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
      await repository.revokeAndCreateSession({
        userId: user.id,
        expectedPasswordHash: user.passwordHash,
        expectedUsername: user.username ?? null,
        expectedEmail: user.email,
        sessionToRevokeId,
        now,
        expectedRestaurantId: user.restaurantId ?? restaurant?.id ?? null,
        expectedRestaurantCode: restaurantCode ?? null,
        tokenHash: session.tokenHash,
        ipAddress,
        userAgent,
        expiresAt,
      });
      return { token: session.token, expiresAt, user: publicUser(user) };
    },

    async listSessionsForTenant(restaurantIdOrOpts) {
      if (!repository.listRestaurantSessions) return [];
      const restaurantId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.restaurantId : restaurantIdOrOpts;
      return repository.listRestaurantSessions(restaurantId, clock());
    },

    async revokeSessionForTenant(restaurantIdOrOpts, sessionId) {
      if (!repository.revokeRestaurantSession) return false;
      const restaurantId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.restaurantId : restaurantIdOrOpts;
      const targetSessionId = typeof restaurantIdOrOpts === "object" ? restaurantIdOrOpts?.sessionId : sessionId;
      return repository.revokeRestaurantSession(restaurantId, targetSessionId, clock());
    },

    /**
     * The restaurants this account may sign into. A device needs this before it
     * can send the trusted restaurant header the POS API requires.
     */
    async restaurantsForUser(userId) {
      return repository.listRestaurantsForUser(userId);
    },
  });
}
