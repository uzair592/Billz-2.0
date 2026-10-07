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
    displayName: user.displayName,
    platformRole: user.platformRole,
  };
}

function authenticationError() {
  const error = new Error("Invalid restaurant code, username or password.");
  error.code = "INVALID_CREDENTIALS";
  error.statusCode = 401;
  return error;
}

export function createAuthService({ repository, mailer, passwordPepper, clock = () => new Date() }) {
  if (!repository) throw new TypeError("An authentication repository is required.");
  if (!mailer || typeof mailer.sendVerification !== "function") {
    throw new TypeError("A verification mailer is required.");
  }

  async function createSessionForUser(user, { ipAddress, userAgent, now }) {
    const session = createTokenPair();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await repository.createSession({
      userId: user.id,
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

    async login({ restaurantCode, username, email, password, ipAddress = null, userAgent = null }) {
      if (restaurantCode && username) {
        if (typeof repository.findUserByRestaurantAndUsername !== "function") {
          throw authenticationError();
        }
        const { restaurant, user } = await repository.findUserByRestaurantAndUsername({
          restaurantCode,
          username,
        });

        if (!restaurant || !user || !(await verifyPassword(user.passwordHash, password, passwordPepper))) {
          throw authenticationError();
        }

        if (restaurant.status === "suspended") {
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

        return createSessionForUser(user, { ipAddress, userAgent, now: clock() });
      }

      const user = await repository.findUserByEmail(normalizeEmail(email));
      if (!user || !(await verifyPassword(user.passwordHash, password, passwordPepper))) {
        throw authenticationError();
      }
      if (user.status !== "active" || (user.email && !user.emailVerifiedAt)) {
        const error = new Error("Verify your email before signing in.");
        error.code = "EMAIL_VERIFICATION_REQUIRED";
        error.statusCode = 403;
        throw error;
      }
      return createSessionForUser(user, { ipAddress, userAgent, now: clock() });
    },

    async authenticate(token) {
      if (!token) return null;
      return repository.findActiveSession(hashOpaqueToken(token), clock());
    },

    async logout(token) {
      if (!token) return;
      await repository.revokeSession(hashOpaqueToken(token), clock());
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
