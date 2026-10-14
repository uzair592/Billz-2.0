export function safeHttpLogger(logger) {
  if (!logger) return false;
  return {
    ...logger,
    redact: {
      paths: [
        "req.body",
        "res.body",
        "req.headers",
        "res.headers",
        "password",
        "currentPassword",
        "newPassword",
        "code",
        "secret",
        "otpauthUri",
        "recoveryCodes",
        "totpSecret",
        "recoveryCode",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req: (request) => ({
        id: request.id,
        method: request.method,
        url: String(request.url || "").split("?")[0],
        remoteAddress: request.ip,
      }),
      res: (reply) => ({ statusCode: reply.statusCode }),
    },
  };
}
