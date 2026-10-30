# POS Content Security Policy (CSP) Staged Migration Guide

## 1. Current State & Intentional Report-Only Posture

The POS application (`Fast_Food_POS_Custom_Bill_Header_XXXL.html`) currently serves the header:
```http
Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; report-uri /api/csp-report
```

### Why `'unsafe-inline'` Must NOT Be Added to `script-src`
Adding `'unsafe-inline'` to `script-src` would eliminate report generation at the cost of completely destroying the protective value of CSP against Cross-Site Scripting (XSS).
The report-only header with `script-src 'self'` is intentionally designed to capture all instances of inline handlers and scripts without breaking customer workflows in production.

### Report Sanitization and Rate Limiting
CSP violation reports are received by `POST /api/csp-report`.
- **Rate Limiting**: Enforced at `max: 60` reports per minute per IP address.
- **Payload Size**: Limited to `bodyLimit: 8192` bytes (8 KiB) to prevent memory exhaustion.
- **Sanitization via `summarizeCspReport()`**:
  - Drops raw URLs, scripts, query strings, and payload samples to guarantee that sensitive customer data, tokens, and PII are never logged.
  - Retains only safe metadata: directive (e.g. `script-src`), classification (`inline`, `eval`, `self`, `data`, `blob`), and line/column numbers bounded to reasonable ranges.

---

## 2. Staged Migration Roadmap

Transitioning the legacy POS from inline handlers to a fully enforced Content Security Policy requires a phased approach:

### Phase 1: Report-Only Monitoring and Audit (Current Phase)
- Keep `Content-Security-Policy-Report-Only`.
- Collect and aggregate violation reports via `/api/csp-report` across POS desktop, tablet, and mobile browsers.
- Catalog all inline script blocks (`<script>...</script>`) and inline HTML event attributes (`onclick`, `onchange`, `onsubmit`, `onkeydown`, etc.).

### Phase 2: External Script Extraction & Module Separation
- Extract inline scripts from `Fast_Food_POS_Custom_Bill_Header_XXXL.html` into separate bundled or modular JavaScript files (e.g. `src/client/pos/*.mjs` or bundled `/pos.js`).
- Serve static scripts strictly with `'self'`.
- Eliminate any residual `eval()`, `new Function()`, or `setTimeout("string")` patterns.

### Phase 3: Event Listener Migration (`addEventListener`)
- Replace inline HTML event attributes with DOM event delegation or programmatic `addEventListener`.
- Note: Nonces and hashes do NOT authorize inline HTML event handlers (`onclick="..."`) in standard CSP; event attributes must be converted to programmatic listeners.
- Maintain existing event timing and keyboard shortcuts for offline operations, cash drawer, and thermal ESC/POS receipt printing.

### Phase 4: Full Suite and Browser Acceptance Test Verification
Before flipping `Content-Security-Policy-Report-Only` to `Content-Security-Policy`, execute:
1. `npm test` (Unit test suite)
2. `npm run test:legacy` (Legacy parity suite)
3. `npm run test:postgres` (PostgreSQL RLS suite)
4. `npm run test:integration` (Billing and accounting integration)
5. `npm run test:fullstack` (Fullstack test suite)
6. `npm run test:browser:saas-core` (Playwright browser acceptance tests)
7. Specific POS browser journeys (`tests/browser/pos-xss-acceptance.spec.mjs` and order workflow journeys) to ensure zero broken DOM interactions or console CSP errors.

### Phase 5: Staged Production Enforcement
- Enable `Content-Security-Policy` in a staging / pilot environment first.
- Monitor error rates and receipt printing workflows.
- Once verified with zero customer disruption, roll out enforced CSP to production.
- Retain `/api/csp-report` (or `report-to`) endpoint with sanitization and rate limits for ongoing telemetry.
