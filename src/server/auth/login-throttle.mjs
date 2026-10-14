import { createHash } from "node:crypto";

function identity({
  scope,
  restaurantCode = "",
  username = "",
  email,
  ipAddress,
}) {
  const normalize = (value) =>
    String(value ?? "")
      .trim()
      .toLowerCase();
  const account =
    scope === "platform_admin"
      ? [normalize(username)]
      : email
        ? ["email", normalize(email)]
        : [normalize(restaurantCode), normalize(username)];
  return [
    scope,
    createHash("sha256").update(JSON.stringify(account)).digest(),
    ipAddress,
  ];
}

export function createLoginThrottle(pool, { clock = () => new Date() } = {}) {
  return Object.freeze({
    async check(input) {
      const now = clock();
      const row = (
        await pool.query(
          `SELECT next_attempt_at FROM login_attempts
        WHERE scope = $1 AND account_key = $2 AND ip_address = $3 AND last_failure_at > $4`,
          [...identity(input), new Date(now.getTime() - 900000)],
        )
      ).rows[0];
      const retryAfter = row
        ? Math.ceil(
            (new Date(row.next_attempt_at).getTime() - now.getTime()) / 1000,
          )
        : 0;
      if (retryAfter > 0)
        throw Object.assign(
          new Error("Please wait briefly before trying again."),
          { code: "LOGIN_RATE_LIMITED", statusCode: 429, retryAfter },
        );
    },
    async failed(input) {
      const now = clock();
      // Atomic increments survive restarts and concurrent requests. Delays are
      // bounded at five seconds, and blocked requests never extend the delay.
      await pool.query(
        `INSERT INTO login_attempts(scope, account_key, ip_address, failures, last_failure_at, next_attempt_at)
        VALUES($1,$2,$3,1,$4,$4::timestamptz + interval '250 milliseconds')
        ON CONFLICT(scope, account_key, ip_address) DO UPDATE SET
          failures = CASE WHEN login_attempts.last_failure_at <= $4::timestamptz - interval '15 minutes' THEN 1 ELSE LEAST(login_attempts.failures + 1,20) END,
          last_failure_at = $4,
          next_attempt_at = $4::timestamptz + LEAST(5000, 250 * power(2, CASE WHEN login_attempts.last_failure_at <= $4::timestamptz - interval '15 minutes' THEN 0 ELSE LEAST(login_attempts.failures,5) END)) * interval '1 millisecond'`,
        [...identity(input), now],
      );
      await pool.query(
        "DELETE FROM login_attempts WHERE last_failure_at < $1",
        [new Date(now.getTime() - 900000)],
      );
    },
    async succeeded(input) {
      await pool.query(
        "DELETE FROM login_attempts WHERE scope = $1 AND account_key = $2 AND ip_address = $3",
        identity(input),
      );
    },
  });
}
