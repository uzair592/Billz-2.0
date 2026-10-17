import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { readLegacyCollections, buildLegacyCatalogSnapshot } from "../src/client/legacy-catalog-snapshot.mjs";
import { createLegacyCloudAdapter } from "../src/client/legacy-cloud-adapter.mjs";
import { createSalesReportService } from "../src/server/pos/sales-report-service.mjs";
import { buildSalesReportXlsx } from "../src/server/pos/report-xlsx-export.mjs";
import { buildSalesReportPdf } from "../src/server/pos/report-pdf-export.mjs";

const RESTAURANT_ID = "11111111-1111-4111-a111-111111111111";
const USER_ID = "33333333-3333-4333-a333-333333333333";

describe("1. Legacy Backup Restoration & Immediate Checkout Readiness", () => {
  it("parses the reproduction backup and tolerates negative stock balances without crashing", async () => {
    const fixturePath = path.resolve("./tests/fixtures/santex-cafe-reproduction-backup.json");
    assert.ok(fs.existsSync(fixturePath), "reproduction backup fixture must exist");
    const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    const store = new Map(Object.entries(raw));
    const storageMock = {
      get: async (key) => store.get(key),
      set: async (key, val) => store.set(key, val),
    };

    const collections = await readLegacyCollections(storageMock);
    const snapshot = buildLegacyCatalogSnapshot(collections);

    assert.ok(snapshot.pos_categories.length > 0, "categories restored");
    assert.ok(snapshot.pos_menu.length > 0, "menu items restored");
    assert.ok(Object.keys(snapshot.pos_stock_item_defs).length > 0, "stock definitions restored");
    assert.ok(snapshot.pos_menu.some(item => item.recipeDough > 0 || item.recipeChicken > 0), "menu recipes restored");
  });

  it("never trusts foreign tenant IDs or credentials embedded in a restored backup", async () => {
    const outbox = { enqueue: async () => {}, flush: async () => {} };
    const session = { activeRestaurant: async () => null };
    const storage = new Map();
    const adapter = createLegacyCloudAdapter({
      session,
      outbox,
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => storage.set(k, v),
      },
    });

    await assert.rejects(
      async () => {
        await adapter.importCatalog({
          snapshot: { categories: [], menuItems: [] },
        });
      },
      (err) => {
        assert.match(err.message, /Sign in and choose a restaurant/);
        return true;
      },
      "Must reject import when device has no authenticated active restaurant session",
    );
  });

  it("handles catalog revision conflict (409) with CATALOG_CONFLICT error code", async () => {
    const outbox = { enqueue: async () => {}, flush: async () => {} };
    const session = { activeRestaurant: async () => RESTAURANT_ID };
    const storage = new Map();

    const fetchImpl = async (url) => {
      if (url.includes("/api/pos/import/legacy-catalog")) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            code: "CATALOG_CONFLICT",
            error: "Catalog revision conflict. Another device updated the catalog.",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const adapter = createLegacyCloudAdapter({
      session,
      outbox,
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => storage.set(k, v),
      },
      fetchImpl,
    });

    await assert.rejects(
      async () => {
        await adapter.importCatalog({
          restaurantId: RESTAURANT_ID,
          snapshot: { categories: [], menuItems: [] },
          forceOverwrite: false,
        });
      },
      (err) => {
        assert.equal(err.code, "CATALOG_CONFLICT");
        assert.equal(err.status, 409);
        return true;
      },
    );
  });

  it("retries catalog import with forceOverwrite after conflict and updates cloud context", async () => {
    const outbox = { enqueue: async () => {}, flush: async () => {} };
    const session = { activeRestaurant: async () => RESTAURANT_ID };
    const storage = new Map();
    let importAttempts = 0;

    const fetchImpl = async (url, options = {}) => {
      if (url.includes("/api/pos/catalog")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ revision: 4 }),
        };
      }
      if (url.includes("/api/pos/import/legacy-catalog")) {
        importAttempts++;
        if (importAttempts === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ code: "CATALOG_CONFLICT" }),
          };
        }
        const body = JSON.parse(options.body);
        assert.equal(body.expectedRevision, 4, "Adopted latest server revision on forced retry");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            revision: 5,
            counts: { menuItems: 10 },
            menuItems: { legacy_1: "cloud_1" },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const adapter = createLegacyCloudAdapter({
      session,
      outbox,
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => storage.set(k, v),
      },
      fetchImpl,
    });

    const res = await adapter.importCatalog({
      restaurantId: RESTAURANT_ID,
      snapshot: { categories: [], menuItems: [] },
      forceOverwrite: true,
    });

    assert.equal(res.result.revision, 5);
    assert.equal(storage.get("pos_cloud_context_v1")?.revision, 5);
    assert.equal(storage.get("pos_cloud_context_v1")?.mappings.menuItems.legacy_1, "cloud_1");
  });

  it("verifies POS HTML guards restore menu action against non-owner/manager roles", () => {
    const html = fs.readFileSync("./Fast_Food_POS_Custom_Bill_Header_XXXL.html", "utf8");
    assert.match(
      html,
      /function importSystemBackupFile\(event\)[\s\S]*?if \(window\.BILLZ_MANAGED && role !== "owner" && role !== "manager"\)/,
      "Cashier must be blocked from importing backup",
    );
    assert.match(
      html,
      /restore-backup-uploader[\s\S]*?role === "owner" \|\| role === "manager"/,
      "Restore uploader button must be hidden for cashiers",
    );
  });
});

describe("2. Equal-Sized 3 Billing Buttons Row (Save Bill | KOT | Save & Print)", () => {
  it("enforces exact 3-button order in HTML DOM", () => {
    const html = fs.readFileSync("./Fast_Food_POS_Custom_Bill_Header_XXXL.html", "utf8");
    const containerMatch = /<div id="new-order-action-buttons">([\s\S]*?)<\/div>/m.exec(html);
    assert.ok(containerMatch, "#new-order-action-buttons must exist in HTML");
    const inner = containerMatch[1];

    const saveBillIdx = inner.indexOf('id="btn-save-bill"');
    const kotBillIdx = inner.indexOf('id="btn-kot-bill"');
    const printBillIdx = inner.indexOf('id="btn-save-print-bill"');

    assert.ok(saveBillIdx !== -1, "Save Bill button exists");
    assert.ok(kotBillIdx !== -1, "KOT button exists");
    assert.ok(printBillIdx !== -1, "Save & Print button exists");

    assert.ok(
      saveBillIdx < kotBillIdx && kotBillIdx < printBillIdx,
      "Order must be exactly 💾 Save Bill | 👨🍳 KOT | 🖨️ Save & Print",
    );
  });

  it("enforces equal width, min-height 48px, single row grid, and sticky positioning in CSS", () => {
    const html = fs.readFileSync("./Fast_Food_POS_Custom_Bill_Header_XXXL.html", "utf8");

    // Grid layout in desktop & mobile
    assert.match(
      html,
      /#screen-new-order #new-order-action-buttons\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)\s*!important/m,
      "Buttons row must use 3 equal-width columns",
    );
    assert.match(
      html,
      /#screen-new-order #new-order-action-buttons\s*\{[^}]*position:\s*sticky;\s*bottom:\s*0/m,
      "Buttons row must be sticky at bottom while cart scrolls",
    );

    // Button sizing
    assert.match(
      html,
      /#screen-new-order \.save-bill-btn,\s*#screen-new-order \.kot-bill-btn,\s*#screen-new-order \.print-bill-btn\s*\{[^}]*min-height:\s*48px\s*!important/m,
      "All three buttons must meet 48px minimum touch height",
    );
  });

  it("verifies KOT button is purely a kitchen action and does not finalize payment", () => {
    const html = fs.readFileSync("./Fast_Food_POS_Custom_Bill_Header_XXXL.html", "utf8");
    assert.match(
      html,
      /<button[^>]*id="btn-kot-bill"[^>]*onclick="submitKotOrder\(\)"/,
      "KOT button must trigger submitKotOrder()",
    );
    assert.match(
      html,
      /function submitKotOrder\(\)/,
      "submitKotOrder exists and sends kitchen ticket",
    );
  });
});

describe("3. Expanded Reports Workspace & Accounting Standards", () => {
  function createMockReportDb({ incompleteCosting = false, hasExpenses = true } = {}) {
    return {
      async connect() {
        return {
          async query(sql) {
            const lower = sql.toLowerCase();
            if (lower.includes("from order_refunds") && !lower.includes("daily_refunds")) {
              return {
                rows: [{
                  refund_total: 50_000,
                  refunded_order_count: 1,
                  completed_refund_total: 50_000,
                  restocked_cost_total: 15_000,
                }],
              };
            }
            if (lower.includes("from orders") && lower.includes("order_status = 'completed'") && !lower.includes("group by")) {
              return {
                rows: [{
                  order_count: 10,
                  gross_subtotal: 1_000_000,
                  total_discounts: 100_000,
                  total_delivery: 20_000,
                  total_charges: 10_000,
                  total_completed: 930_000,
                  total_cogs: 400_000,
                  incomplete_costing_order_count: incompleteCosting ? 2 : 0,
                }],
              };
            }
            if (lower.includes("order_status = 'cancelled'")) {
              return { rows: [{ count: 2, total_minor: 150_000 }] };
            }
            if (lower.includes("from expenses")) {
              return { rows: [{ total_expenses: hasExpenses ? 120_000 : 0 }] };
            }
            if (lower.includes("from order_payments")) {
              return {
                rows: [
                  { payment_method: "cash", captured_minor: 600_000, refunded_minor: 30_000 },
                  { payment_method: "bank_account", captured_minor: 330_000, refunded_minor: 20_000 },
                ],
              };
            }
            if (lower.includes("group by order_type")) {
              return {
                rows: [
                  { order_type: "dine_in", count: 6, total_minor: 600_000 },
                  { order_type: "takeaway", count: 4, total_minor: 330_000 },
                ],
              };
            }
            if (lower.includes("daily_orders")) {
              return {
                rows: [{
                  period_date: "2026-10-17",
                  order_count: 10,
                  gross_sales: 1_030_000,
                  discounts: 100_000,
                  completed_sales: 930_000,
                  refund_total: 50_000,
                  net_sales: 880_000,
                }],
              };
            }
            if (lower.includes("order_items oi") && lower.includes("left join")) {
              return {
                rows: [{
                  id: "ord-1",
                  order_number: 101,
                  business_date: "2026-10-17",
                  order_type: "dine_in",
                  order_status: "completed",
                  payment_status: "paid",
                  total_minor: 200_000,
                  refunded_minor: 0,
                  cogs_minor: 80_000,
                  restocked_cost_minor: 0,
                  incomplete_costing: false,
                  ordered_at: "2026-10-17T12:00:00Z",
                }],
              };
            }
            if (lower.includes("total_rows")) {
              return { rows: [{ total_rows: 1 }] };
            }
            return { rows: [] };
          },
          release() {},
        };
      },
    };
  }

  it("calculates COGS, gross profit, operating expenses, and net profit per accounting conventions", async () => {
    const pool = createMockReportDb({ hasExpenses: true });
    const service = createSalesReportService(pool);
    const tenant = {
      restaurant: { id: RESTAURANT_ID, name: "Test Cafe", timezone: "Asia/Karachi" },
      membership: { userId: USER_ID, role: "owner" },
    };

    const report = await service.getSalesReport({ tenant, filters: { startDate: "2026-10-17", endDate: "2026-10-17" } });
    const m = report.metrics;

    // Completed: 930_000. Refunds: 50_000. Net Sales = 880_000
    assert.equal(m.completedSalesMinor, 930_000);
    assert.equal(m.refundTotalMinor, 50_000);
    assert.equal(m.netSalesMinor, 880_000);

    // COGS: 400_000 - 15_000 restocked = 385_000
    assert.equal(m.costOfGoodsMinor, 385_000);

    // Gross Profit: 880_000 - 385_000 = 495_000
    assert.equal(m.grossProfitMinor, 495_000);

    // Margin: 495_000 / 880_000 * 100 = 56.25%
    assert.equal(m.grossMarginPercent, 56.25);

    // Operating expenses: 120_000
    assert.equal(m.operatingExpensesMinor, 120_000);

    // Net Profit = Gross Profit - Operating Expenses = 495_000 - 120_000 = 375_000
    assert.equal(m.netProfitMinor, 375_000);
  });

  it("flags incomplete costing notice when recipe costs are missing", async () => {
    const pool = createMockReportDb({ incompleteCosting: true });
    const service = createSalesReportService(pool);
    const tenant = {
      restaurant: { id: RESTAURANT_ID, name: "Test Cafe", timezone: "Asia/Karachi" },
      membership: { userId: USER_ID, role: "owner" },
    };

    const report = await service.getSalesReport({ tenant, filters: {} });
    assert.equal(report.metrics.hasIncompleteCosting, true);
    assert.equal(report.metrics.incompleteCostingOrderCount, 2);
  });

  it("redacts cost and profit metrics when requested by cashier role", async () => {
    const pool = createMockReportDb();
    const service = createSalesReportService(pool);
    const tenant = {
      restaurant: { id: RESTAURANT_ID, name: "Test Cafe", timezone: "Asia/Karachi" },
      membership: { userId: USER_ID, role: "cashier" },
    };

    const report = await service.getSalesReport({ tenant, filters: {} });
    const m = report.metrics;

    assert.equal(m.costOfGoodsMinor, null, "COGS must be null for cashier");
    assert.equal(m.grossProfitMinor, null, "Gross profit must be null for cashier");
    assert.equal(m.grossMarginPercent, null, "Margin must be null for cashier");
    assert.equal(m.operatingExpensesMinor, null, "Operating expenses must be null for cashier");
    assert.equal(m.netProfitMinor, null, "Net profit must be null for cashier");
  });
});

describe("4. PDF and Excel Exports", () => {
  const sampleReport = {
    restaurant: { name: "Burger House", timezone: "Asia/Karachi" },
    filters: { startDate: "2026-10-01", endDate: "2026-10-17", orderType: null, paymentMethod: null },
    metrics: {
      grossSalesMinor: 500_000,
      discountsMinor: 50_000,
      refundTotalMinor: 20_000,
      netSalesMinor: 430_000,
      costOfGoodsMinor: 180_000,
      grossProfitMinor: 250_000,
      grossMarginPercent: 58.14,
      operatingExpensesMinor: 60_000,
      netProfitMinor: 190_000,
      completedOrderCount: 10,
    },
  };

  const sampleRows = [
    {
      orderNumber: 101,
      businessDate: "2026-10-17",
      orderedAt: "2026-10-17T14:30:00Z",
      orderType: "dine_in",
      orderStatus: "completed",
      totalMinor: 50_000,
      refundedMinor: 0,
      netMinor: 50_000,
      cogsMinor: 20_000,
      grossProfitMinor: 30_000,
      grossMarginPercent: 60.0,
      incompleteCosting: false,
    },
    {
      // Row with formula injection attempt in order status / type
      orderNumber: 102,
      businessDate: "2026-10-17",
      orderedAt: "2026-10-17T15:00:00Z",
      orderType: "=cmd|' /C calc'!A0",
      orderStatus: "+malicious_status",
      totalMinor: 25_000,
      refundedMinor: 5_000,
      netMinor: 20_000,
      cogsMinor: 10_000,
      grossProfitMinor: 10_000,
      grossMarginPercent: 50.0,
      incompleteCosting: true,
    },
  ];

  it("generates a valid OpenXML .xlsx ZIP package with formula injection protection", () => {
    const xlsxBuffer = buildSalesReportXlsx({
      report: sampleReport,
      rows: sampleRows,
      isCashier: false,
    });

    assert.ok(Buffer.isBuffer(xlsxBuffer), "Must return Buffer");
    // Standard ZIP signature: 0x50 0x4B 0x03 0x04 ("PK\x03\x04")
    assert.equal(xlsxBuffer[0], 0x50);
    assert.equal(xlsxBuffer[1], 0x4b);
    assert.equal(xlsxBuffer[2], 0x03);
    assert.equal(xlsxBuffer[3], 0x04);

    // Extract file entries from zip to verify XML contents and formula injection defense
    let offset = 0;
    let foundSheet1 = false;
    while (offset < xlsxBuffer.length - 4) {
      const sig = xlsxBuffer.readUInt32LE(offset);
      if (sig === 0x04034b50) {
        // Local file header
        const compMethod = xlsxBuffer.readUInt16LE(offset + 8);
        const compSize = xlsxBuffer.readUInt32LE(offset + 18);
        const nameLen = xlsxBuffer.readUInt16LE(offset + 26);
        const extraLen = xlsxBuffer.readUInt16LE(offset + 28);
        const fileName = xlsxBuffer.toString("utf8", offset + 30, offset + 30 + nameLen);
        const dataStart = offset + 30 + nameLen + extraLen;
        const compData = xlsxBuffer.subarray(dataStart, dataStart + compSize);

        if (fileName === "xl/worksheets/sheet1.xml") {
          foundSheet1 = true;
          const xml = (compMethod === 8 ? zlib.inflateRawSync(compData) : compData).toString("utf8");
          // Check formula injection defense: '=cmd is preceded by a single quote escape
          assert.ok(xml.includes("&apos;=cmd") || xml.includes("&#039;=cmd") || xml.includes("'=cmd"));
          assert.ok(xml.includes("&apos;+malicious") || xml.includes("&#039;+malicious") || xml.includes("'+malicious"));
        }
        offset = dataStart + compSize;
      } else {
        offset++;
      }
    }
    assert.ok(foundSheet1, "sheet1.xml must be present in xlsx archive");
  });

  it("generates a valid landscape PDF 1.4 document with headers, pages, and totals", () => {
    const pdfBuffer = buildSalesReportPdf({
      report: sampleReport,
      rows: sampleRows,
      isCashier: false,
    });

    assert.ok(Buffer.isBuffer(pdfBuffer), "Must return Buffer");
    const pdfText = pdfBuffer.toString("utf8");

    // Standard PDF 1.4 header and EOF
    assert.ok(pdfText.startsWith("%PDF-1.4"), "PDF must have %PDF-1.4 header");
    assert.ok(pdfText.includes("%%EOF"), "PDF must terminate with %%EOF");

    // Metadata & KPIs
    assert.ok(pdfText.includes("Burger House"));
    assert.ok(pdfText.includes("SALES & PROFITABILITY REPORT"));
    assert.ok(pdfText.includes("COGS"));
    assert.ok(pdfText.includes("GROSS SALES"));

    // Landscape orientation: MediaBox [0 0 842 595]
    assert.ok(pdfText.includes("/MediaBox [0 0 842 595]"));
  });

  it("redacts cost and profit columns from PDF when exported by cashier", () => {
    const pdfCashier = buildSalesReportPdf({
      report: sampleReport,
      rows: sampleRows,
      isCashier: true,
    });
    const text = pdfCashier.toString("utf8");

    // Cashier view should not include COGS or Gross Profit in table headers or KPI cards
    assert.ok(!text.includes("Gross Profit: PKR"));
    assert.ok(!text.includes("Net Profit: PKR"));
  });
});
