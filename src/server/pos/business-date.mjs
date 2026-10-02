/**
 * Business dates are calendar days in the restaurant's own timezone. They are
 * kept separate from the stored instant so a late-night order and its reports
 * agree with the restaurant's clock rather than the server's.
 */
export function businessDateInTimezone(now, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function apiError(message, code, statusCode = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (details !== undefined) error.details = details;
  return error;
}
