import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { Writable } from "node:stream";
import { readLegacyApp, extractInlineScript, extractDeclaration } from "./helpers/legacy-source.mjs";
import { buildHttpApp } from "../src/server/http/app.mjs";

test("HTML text, inline JavaScript arguments and CSS values have context-aware encoding", async () => {
  const script = extractInlineScript(await readLegacyApp());
  const helpers = extractDeclaration(script, "function escapeHtmlForExport(str)", "function exportOrdersHistoryToExcel()");
  const context = vm.createContext({});
  vm.runInContext(helpers, context);
  const payload = '<img src=x onerror="window.__xss=1">\'&';
  assert.equal(context.escapeHtml(payload), "&lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;&#39;&amp;");
  const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(JSON.parse(decode(context.htmlJsValue(payload))), payload);
  assert.equal(context.safeCssColor('red; background:url(https://attacker.invalid)'), "#64748b");
  assert.equal(context.safeCssColor("#123abc"), "#123abc");
});

test("expense history encodes imported notes, labels, dates and handler arguments", async () => {
  const script = extractInlineScript(await readLegacyApp());
  const payload = '<img src=x onerror="window.__xss=1">';
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", classList: { toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element }, formatRs: value => String(value),
    expenseFields: [{ key: "canary", label: payload, color: 'red; background:url(x)' }],
    getFilteredExpenseHistoryList: () => [{ id: '1);window.__xss=1;//', date: payload, amount: 10, fieldKey: "canary", note: payload, hasReceipt: true }],
  });
  vm.runInContext(extractDeclaration(script, "function escapeHtmlForExport(str)", "function exportOrdersHistoryToExcel()") +
    extractDeclaration(script, "function renderExpenseHistory()", "function setReportQuickDate(period)") + ";renderExpenseHistory();", context);
  for (const id of ["expense-history-rows", "expense-breakdown-list"]) {
    assert.equal(element(id).innerHTML.includes("<img"), false);
    assert.ok(element(id).innerHTML.includes("&lt;img"));
  }
  assert.ok(element("expense-history-rows").innerHTML.includes("&quot;1);window.__xss=1;//&quot;"));
  assert.equal(element("expense-breakdown-list").innerHTML.includes("background:url"), false);
});

test("POS reports CSP violations without enforcing or logging raw customer/secret data", async t => {
  let logs = "";
  const stream = new Writable({ write(chunk, _encoding, done) { logs += chunk; done(); } });
  const app = await buildHttpApp({ authService: {}, trustedOrigin: "http://localhost:3000", logger: { stream } });
  t.after(() => app.close());
  for (const url of ["/", "/Fast_Food_POS_Custom_Bill_Header_XXXL.html"]) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-security-policy-report-only"], /report-uri \/api\/csp-report/);
    assert.equal(response.headers["content-security-policy"], undefined);
  }
  const secret = "private-report-canary-DO-NOT-LOG";
  const response = await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" },
    payload: JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": `https://example.invalid/${secret}`, "document-uri": secret, "script-sample": secret, "original-policy": secret, "line-number": 123 } }) });
  assert.equal(response.statusCode, 204);
  assert.match(logs, /pos_csp_violation/);
  assert.match(logs, /script-src-elem/);
  assert.equal(logs.includes(secret), false);
  assert.equal((await app.inject({ method: "POST", url: "/api/csp-report", payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: "{" })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: JSON.stringify({ padding: "x".repeat(9000) }) })).statusCode, 413);
});
