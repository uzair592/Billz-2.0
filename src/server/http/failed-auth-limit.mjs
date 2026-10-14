// Peek before authentication and consume only rejected client requests. Successful
// operations behind a shared restaurant IP must not spend the failure budget.
// The durable per-account login throttle remains the restart-safe guessing guard.
export function failedAuthLimit(app, { max, scope }) {
  const limit = app.createRateLimit({
    max,
    timeWindow: "15 minutes",
    keyGenerator: request => `${scope}:${request.ip}`,
  });
  return {
    config: { rateLimit: false },
    onRequest: async (request) => {
      const state = await limit(request, { increment: false });
      if (!state.isAllowed && state.remaining === 0) {
        throw Object.assign(new Error("Too many failed attempts. Please try again later."), {
          code: "AUTH_IP_RATE_LIMITED", statusCode: 429,
          retryAfter: Math.max(1, state.ttlInSeconds),
        });
      }
    },
    onResponse: async (request, reply) => {
      if (reply.statusCode >= 400 && reply.statusCode < 500 && reply.statusCode !== 429) {
        await limit(request);
      }
    },
  };
}
