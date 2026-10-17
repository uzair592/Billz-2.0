import { createZipArchive } from "./zip-archive.mjs";

function escapeXml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitizeFormula(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/^[=+\-@]/.test(s)) {
    return "'" + s;
  }
  return s;
}

function colName(index) {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode((n % 26) + 65) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

export function buildSalesReportXlsx({ report, rows, isCashier = false, clock = () => new Date() }) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sales &amp; Profitability" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="#,##0.00"/>
    <numFmt numFmtId="165" formatCode="0.0%"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="10"/><name val="Segoe UI"/></font>
    <font><b/><sz val="10"/><name val="Segoe UI"/></font>
    <font><b/><sz val="14"/><name val="Segoe UI"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
  </cellXfs>
</styleSheet>`;

  // Build sheet rows
  const m = report.metrics;
  const sheetRows = [];
  let rowIndex = 1;

  function addRow(cells) {
    const rowXml = cells.map((cell, cIdx) => {
      const ref = `${colName(cIdx)}${rowIndex}`;
      if (cell.type === "n") {
        const s = cell.style ? ` s="${cell.style}"` : ' s="2"';
        return `<c r="${ref}" t="n"${s}><v>${Number(cell.value) || 0}</v></c>`;
      }
      const s = cell.style ? ` s="${cell.style}"` : "";
      const textVal = escapeXml(sanitizeFormula(cell.value));
      return `<c r="${ref}" t="inlineStr"${s}><is><t>${textVal}</t></is></c>`;
    }).join("");
    sheetRows.push(`<row r="${rowIndex}">${rowXml}</row>`);
    rowIndex += 1;
  }

  // Header Title
  addRow([{ value: `${report.restaurant.name} — Sales & Profitability Report`, style: 4 }]);
  addRow([{ value: `Date Range: ${report.filters.startDate} to ${report.filters.endDate} | Timezone: ${report.restaurant.timezone} | Currency: ${report.restaurant.currencyCode || "PKR"}` }]);
  addRow([{ value: `Filters: Type=${report.filters.orderType || "All"}, Method=${report.filters.paymentMethod || "All"} | Generated: ${clock().toISOString()}` }]);
  addRow([]);

  // Metrics summary block
  addRow([{ value: "FINANCIAL SUMMARY METRICS", style: 1 }, { value: "", style: 1 }]);
  addRow([{ value: "Gross Subtotal (PKR)" }, { type: "n", value: m.grossSubtotalMinor / 100 }]);
  addRow([{ value: "Discounts (PKR)" }, { type: "n", value: m.discountsMinor / 100 }]);
  addRow([{ value: "Delivery Charges (PKR)" }, { type: "n", value: m.deliveryMinor / 100 }]);
  addRow([{ value: "Additional Charges (PKR)" }, { type: "n", value: m.additionalChargesMinor / 100 }]);
  addRow([{ value: "Gross Sales (PKR)" }, { type: "n", value: m.grossSalesMinor / 100 }]);
  addRow([{ value: "Refunds Total (PKR)" }, { type: "n", value: m.refundTotalMinor / 100 }]);
  addRow([{ value: "Net Sales (PKR)", style: 1 }, { type: "n", value: m.netSalesMinor / 100, style: 3 }]);

  if (!isCashier && m.costOfGoodsMinor !== null && m.costOfGoodsMinor !== undefined) {
    addRow([{ value: "Cost of Goods Sold (COGS) (PKR)" }, { type: "n", value: m.costOfGoodsMinor / 100 }]);
    addRow([{ value: "Gross Profit (PKR)", style: 1 }, { type: "n", value: m.grossProfitMinor / 100, style: 3 }]);
    addRow([{ value: "Gross Profit Margin (%)" }, { type: "n", value: (m.grossMarginPercent || 0) / 100, style: 5 }]);
    addRow([{ value: "Operating Expenses (OPEX) (PKR)" }, { type: "n", value: (m.operatingExpensesMinor || 0) / 100 }]);
    addRow([{ value: "Net Operating Profit (PKR)", style: 1 }, { type: "n", value: (m.netProfitMinor || 0) / 100, style: 3 }]);
  }
  addRow([{ value: "Completed Orders Count" }, { type: "n", value: m.completedOrderCount }]);
  addRow([{ value: "Refunded Orders Count" }, { type: "n", value: m.refundedOrderCount }]);
  addRow([{ value: "Cancelled Orders Count" }, { type: "n", value: m.cancelledOrderCount }]);
  addRow([{ value: "Average Order Value (PKR)" }, { type: "n", value: m.averageOrderValueMinor / 100 }]);
  if (m.hasIncompleteCosting) {
    addRow([{ value: `* NOTE: ${m.incompleteCostingOrderCount} order(s) have incomplete recipe/cost data.` }]);
  }
  addRow([]);

  // Bill-wise table headers
  const headers = [
    { value: "Order #", style: 1 },
    { value: "Business Date", style: 1 },
    { value: "Time", style: 1 },
    { value: "Order Type", style: 1 },
    { value: "Order Status", style: 1 },
    { value: "Payment Status", style: 1 },
    { value: "Total Sales (PKR)", style: 1 },
    { value: "Refunded (PKR)", style: 1 },
    { value: "Net Sales (PKR)", style: 1 },
  ];

  if (!isCashier) {
    headers.push(
      { value: "COGS (PKR)", style: 1 },
      { value: "Gross Profit (PKR)", style: 1 },
      { value: "Margin %", style: 1 },
      { value: "Costing Status", style: 1 },
    );
  }
  addRow(headers);

  // Table rows
  let sumTotal = 0;
  let sumRefunded = 0;
  let sumNet = 0;
  let sumCogs = 0;
  let sumGrossProfit = 0;

  for (const r of rows) {
    const total = Number(r.total_minor || r.totalMinor || 0);
    const ref = Number(r.refunded_minor || r.refundedMinor || 0);
    const net = r.order_status === "cancelled" || r.orderStatus === "cancelled" ? 0 : Math.max(0, total - ref);
    const cogs = Number(r.cogs_minor || r.cogsMinor || 0);
    const profit = Number(r.gross_profit_minor || r.grossProfitMinor || (net - cogs));
    const margin = net > 0 ? (profit / net) : 0;

    sumTotal += total;
    sumRefunded += ref;
    sumNet += net;
    sumCogs += cogs;
    sumGrossProfit += profit;

    const rowCells = [
      { value: `#${r.order_number || r.orderNumber}` },
      { value: r.business_date || r.businessDate || "" },
      { value: r.ordered_at ? new Date(r.ordered_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "" },
      { value: r.order_type || r.orderType || "" },
      { value: r.order_status || r.orderStatus || "" },
      { value: r.payment_status || r.paymentStatus || "" },
      { type: "n", value: total / 100 },
      { type: "n", value: ref / 100 },
      { type: "n", value: net / 100 },
    ];

    if (!isCashier) {
      rowCells.push(
        { type: "n", value: cogs / 100 },
        { type: "n", value: profit / 100 },
        { type: "n", value: margin, style: 5 },
        { value: r.incomplete_costing || r.incompleteCosting ? "Incomplete" : "Verified" },
      );
    }
    addRow(rowCells);
  }

  // Column totals row
  const totalRowCells = [
    { value: "TOTALS", style: 1 },
    { value: "", style: 1 },
    { value: "", style: 1 },
    { value: "", style: 1 },
    { value: "", style: 1 },
    { value: "", style: 1 },
    { type: "n", value: sumTotal / 100, style: 3 },
    { type: "n", value: sumRefunded / 100, style: 3 },
    { type: "n", value: sumNet / 100, style: 3 },
  ];
  if (!isCashier) {
    const totalMargin = sumNet > 0 ? (sumGrossProfit / sumNet) : 0;
    totalRowCells.push(
      { type: "n", value: sumCogs / 100, style: 3 },
      { type: "n", value: sumGrossProfit / 100, style: 3 },
      { type: "n", value: totalMargin, style: 5 },
      { value: "", style: 1 },
    );
  }
  addRow(totalRowCells);

  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="16" customWidth="1"/>
    <col min="2" max="2" width="14" customWidth="1"/>
    <col min="3" max="3" width="10" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="16" customWidth="1"/>
    <col min="7" max="7" width="18" customWidth="1"/>
    <col min="8" max="8" width="16" customWidth="1"/>
    <col min="9" max="9" width="18" customWidth="1"/>
    <col min="10" max="10" width="16" customWidth="1"/>
    <col min="11" max="11" width="18" customWidth="1"/>
    <col min="12" max="12" width="12" customWidth="1"/>
    <col min="13" max="13" width="16" customWidth="1"/>
  </cols>
  <sheetData>
    ${sheetRows.join("\n    ")}
  </sheetData>
</worksheet>`;

  return createZipArchive([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/styles.xml", data: styles },
    { name: "xl/worksheets/sheet1.xml", data: sheet1 },
  ]);
}
