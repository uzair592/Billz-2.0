/**
 * Production registration and mail policy.
 *
 * Transactional email is not implemented. In production that
 * means self-registration must be disabled by default: a
 * verification mail that is never delivered would lock a real
 * restaurant out of its own account with no way to recover. The
 * server therefore starts with registration disabled unless a
 * real transactional mail provider is configured.
 *
 * The policy is explicit and bounded:
 *
 *   * Production self-registration is disabled unless a mail
 *     provider is configured (MAIL_PROVIDER is set to a real
 *     provider name).
 *   * Bootstrap-created users are not self-registrations: the
 *     bootstrap CLI writes the owner directly, so it is
 *     unaffected by this policy.
 *   * A registration attempt while disabled fails clearly with
 *     REGISTRATION_DISABLED and never creates a pending user.
 *   * The production mailer never logs verification tokens or
 *     passwords. It refuses to send rather than echo a secret.
 *   * Development keeps the existing logging mailer behavior.
 *
 * This module never constructs a fake "successful" production
 * mailer. If no provider is configured, delivery is refused.
 */

/**
 * Decides whether self-registration is enabled for the given
 * environment.
 *
 * @param {object} options
 * @param {string} options.nodeEnv - NODE_ENV value.
 * @param {string} [options.mailProvider] - Configured mail provider name, if any.
 * @returns {{ registrationEnabled: boolean, reason: string }}
 */
export function resolveRegistrationPolicy({ nodeEnv = "development", mailProvider = null } = {}) {
  if (nodeEnv !== "production") {
    return { registrationEnabled: true, reason: "development_registration_enabled" };
  }
  const provider = String(mailProvider ?? "").trim().toLowerCase();
  if (provider && provider !== "none" && provider !== "disabled" && provider !== "log") {
    return { registrationEnabled: true, reason: "mail_provider_configured" };
  }
  return {
    registrationEnabled: false,
    reason: "production_registration_disabled_no_mail_provider",
  };
}

/**
 * A production-safe mailer.
 *
 * When registration is enabled with a real provider, the provider
 * adapter is expected to be supplied. When registration is
 * disabled, the mailer refuses to send and never logs the token.
 *
 * @param {object} options
 * @param {boolean} options.registrationEnabled - Whether self-registration is enabled.
 * @param {string} options.nodeEnv - NODE_ENV value.
 * @param {Function} [options.log] - Structured log sink (development only).
 * @param {object} [options.provider] - Real mail provider adapter with sendVerification.
 */
export function createPolicyMailer({
  registrationEnabled,
  nodeEnv = "development",
  log = () => {},
  provider = null,
} = {}) {
  if (nodeEnv !== "production") {
    // Development keeps the existing logging behavior.
    return Object.freeze({
      registrationEnabled: true,
      async sendVerification({ email, token, expiresAt }) {
        log({
          message: "verification_email_not_sent",
          email,
          expiresAt,
          token,
        });
        return { delivered: false, transport: "log" };
      },
    });
  }

  if (!registrationEnabled) {
    // Production with registration disabled: refuse to send and
    // never log the token. There is no transport to deliver it.
    return Object.freeze({
      registrationEnabled: false,
      async sendVerification() {
        const error = new Error(
          "Self-registration is disabled in production because no "
          + "transactional mail provider is configured.",
        );
        error.code = "REGISTRATION_DISABLED";
        error.statusCode = 503;
        throw error;
      },
    });
  }

  if (!provider || typeof provider.sendVerification !== "function") {
    // Registration is enabled in production but no real provider
    // adapter was supplied. Refuse rather than pretend.
    const error = new Error(
      "Production registration is enabled but no transactional mail "
      + "provider adapter is configured.",
    );
    error.code = "MAIL_PROVIDER_REQUIRED";
    error.statusCode = 500;
    throw error;
  }

  return Object.freeze({
    registrationEnabled: true,
    async sendVerification(input) {
      return provider.sendVerification(input);
    },
  });
}
