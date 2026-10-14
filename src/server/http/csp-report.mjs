export const POS_CSP_REPORT_ONLY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; report-uri /api/csp-report";

export function summarizeCspReport(body) {
  const report = body?.["csp-report"];
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const directive = report["effective-directive"] || report["violated-directive"];
  if (typeof directive !== "string" || !/^[a-z-]{1,50}(?:\s.*)?$/.test(directive)) return null;
  const blocked = report["blocked-uri"];
  // URLs, samples and original policy text may carry customer data or secrets.
  // Log a useful classification and source coordinates, never raw report text.
  return {
    message: "pos_csp_violation",
    directive: directive.split(" ")[0],
    blocked: ["inline", "eval", "self", "data", "blob"].includes(blocked) ? blocked : "external_or_unknown",
    line: Number.isInteger(report["line-number"]) && report["line-number"] >= 0 && report["line-number"] < 1000000 ? report["line-number"] : null,
    column: Number.isInteger(report["column-number"]) && report["column-number"] >= 0 && report["column-number"] < 1000000 ? report["column-number"] : null,
  };
}
