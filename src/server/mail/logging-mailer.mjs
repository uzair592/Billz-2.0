/**
 * Mail delivery for local development.
 *
 * Transactional email is not implemented yet, and pretending otherwise would be
 * dangerous: a verification mail that is never delivered locks a real restaurant
 * out of its own account with no way to recover. This mailer therefore prints
 * the message in development and refuses to run in production, so the
 * deployment fails visibly at the first registration instead of silently
 * stranding users.
 */
export function createLoggingMailer({
  nodeEnv = "development",
  log = (payload) => console.log(payload),
} = {}) {
  if (nodeEnv === "production") {
    throw new Error(
      "No transactional mail provider is configured. "
      + "Refusing to start rather than accept registrations whose verification mail is never sent.",
    );
  }

  return Object.freeze({
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