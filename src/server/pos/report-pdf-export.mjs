/**
 * PDF 1.4 Document Generator for Restaurant Sales & Profitability Reports.
 * Produces valid, standard landscape PDF documents with zero external dependencies.
 */

function sanitizePdfText(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[\r\n\t]/g, " ");
}

function formatPkr(minor) {
  const num = (Math.round(Number(minor) || 0) / 100);
  return num.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function buildSalesReportPdf({ report, rows, isCashier = false, clock = () => new Date() }) {
  const pageWidth = 842;  // A4 Landscape width in points
  const pageHeight = 595; // A4 Landscape height in points

  // Table columns definition
  const columns = [
    { title: "Order #", width: 55, align: "left" },
    { title: "Date", width: 65, align: "left" },
    { title: "Time", width: 45, align: "left" },
    { title: "Type", width: 60, align: "left" },
    { title: "Status", width: 55, align: "left" },
    { title: "Total (PKR)", width: 75, align: "right" },
    { title: "Refund (PKR)", width: 70, align: "right" },
    { title: "Net Sales", width: 75, align: "right" },
  ];

  if (!isCashier) {
    columns.push(
      { title: "COGS", width: 70, align: "right" },
      { title: "Gross Profit", width: 75, align: "right" },
      { title: "Margin", width: 55, align: "right" },
      { title: "Costing", width: 55, align: "center" },
    );
  }

  // Pre-calculate pagination
  // Page 1 has header (title, metadata, KPI cards, table header)
  // Rows per page:
  const firstPageMaxRows = 12;
  const subsequentPagesMaxRows = 22;

  const pagesData = [];
  let remainingRows = [...rows];

  if (remainingRows.length === 0) {
    pagesData.push([]);
  } else {
    pagesData.push(remainingRows.splice(0, firstPageMaxRows));
    while (remainingRows.length > 0) {
      pagesData.push(remainingRows.splice(0, subsequentPagesMaxRows));
    }
  }

  const totalPages = pagesData.length;
  const pageStreamObjects = [];

  // Metrics totals
  const m = report.metrics;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageRows = pagesData[pageNum - 1];
    const stream = [];

    // Helper draw functions
    function fillRect(x, y, w, h, r, g, b) {
      stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      stream.push(`${x} ${y} ${w} ${h} re f`);
    }

    function strokeRect(x, y, w, h, r, g, b, lineWidth = 1) {
      stream.push(`${lineWidth} w`);
      stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
      stream.push(`${x} ${y} ${w} ${h} re S`);
    }

    function drawLine(x1, y1, x2, y2, r = 0.85, g = 0.88, b = 0.92, lineWidth = 0.5) {
      stream.push(`${lineWidth} w`);
      stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
      stream.push(`${x1} ${y1} m ${x2} ${y2} l S`);
    }

    function drawText(text, x, y, size = 9, font = "/F1", r = 0.1, g = 0.1, b = 0.15) {
      stream.push("BT");
      stream.push(`${font} ${size} Tf`);
      stream.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      stream.push(`${x} ${y} Td`);
      stream.push(`(${sanitizePdfText(text)}) Tj`);
      stream.push("ET");
    }

    function drawTextRight(text, rightX, y, size = 9, font = "/F1", r = 0.1, g = 0.1, b = 0.15) {
      // Approximate Helvetica character width (0.55 * size)
      const approxWidth = text.length * (size * 0.52);
      drawText(text, rightX - approxWidth, y, size, font, r, g, b);
    }

    function drawTextCenter(text, centerX, y, size = 9, font = "/F1", r = 0.1, g = 0.1, b = 0.15) {
      const approxWidth = text.length * (size * 0.52);
      drawText(text, centerX - (approxWidth / 2), y, size, font, r, g, b);
    }

    // Top Header Banner
    fillRect(30, pageHeight - 55, pageWidth - 60, 40, 0.96, 0.97, 0.98);
    strokeRect(30, pageHeight - 55, pageWidth - 60, 40, 0.88, 0.91, 0.94);
    drawText(report.restaurant.name, 45, pageHeight - 32, 16, "/F2", 0.06, 0.09, 0.16);
    drawText("SALES & PROFITABILITY REPORT", 45, pageHeight - 48, 9, "/F2", 0.15, 0.39, 0.92);

    drawTextRight(`Date Range: ${report.filters.startDate} to ${report.filters.endDate}`, pageWidth - 45, pageHeight - 30, 9, "/F2", 0.2, 0.25, 0.3);
    drawTextRight(`Currency: ${report.restaurant.currencyCode || "PKR"} | Timezone: ${report.restaurant.timezone}`, pageWidth - 45, pageHeight - 42, 8, "/F1", 0.4, 0.45, 0.5);
    drawTextRight(`Generated: ${clock().toISOString().replace("T", " ").substring(0, 19)}`, pageWidth - 45, pageHeight - 52, 7.5, "/F1", 0.5, 0.55, 0.6);

    let currentY = pageHeight - 70;

    // Render KPI Cards on Page 1
    if (pageNum === 1) {
      const cardY = currentY - 60;
      const cardHeight = 55;
      const cardMargin = 8;
      const totalWidth = pageWidth - 60;
      const numCards = isCashier ? 4 : 6;
      const cardWidth = (totalWidth - (cardMargin * (numCards - 1))) / numCards;

      const cards = [
        { label: "GROSS SALES", val: `PKR ${formatPkr(m.grossSalesMinor)}`, sub: `Disc: ${formatPkr(m.discountsMinor)}` },
        { label: "REFUNDS", val: `-${formatPkr(m.refundTotalMinor)}`, sub: `${m.refundedOrderCount} orders refunded`, color: [0.86, 0.15, 0.15] },
        { label: "NET SALES", val: `PKR ${formatPkr(m.netSalesMinor)}`, sub: `${m.completedOrderCount} orders`, color: [0.02, 0.59, 0.41] },
      ];

      if (!isCashier && m.costOfGoodsMinor !== null && m.costOfGoodsMinor !== undefined) {
        cards.push(
          { label: "COGS", val: `PKR ${formatPkr(m.costOfGoodsMinor)}`, sub: "Sale-time costs" },
          { label: "GROSS PROFIT", val: `PKR ${formatPkr(m.grossProfitMinor)}`, sub: `Margin: ${(m.grossMarginPercent || 0).toFixed(1)}%`, color: [0.02, 0.59, 0.41] },
          { label: "NET PROFIT", val: `PKR ${formatPkr(m.netProfitMinor)}`, sub: `OPEX: ${formatPkr(m.operatingExpensesMinor || 0)}`, color: (m.netProfitMinor || 0) >= 0 ? [0.02, 0.59, 0.41] : [0.86, 0.15, 0.15] },
        );
      } else if (isCashier) {
        cards.push(
          { label: "ORDERS COUNT", val: `${m.completedOrderCount}`, sub: `Avg: ${formatPkr(m.averageOrderValueMinor)}` },
        );
      }

      cards.forEach((card, idx) => {
        const cX = 30 + idx * (cardWidth + cardMargin);
        fillRect(cX, cardY, cardWidth, cardHeight, 1, 1, 1);
        strokeRect(cX, cardY, cardWidth, cardHeight, 0.88, 0.91, 0.94);
        drawText(card.label, cX + 8, cardY + cardHeight - 14, 7.5, "/F2", 0.4, 0.45, 0.5);
        const [cr, cg, cb] = card.color || [0.06, 0.09, 0.16];
        drawText(card.val, cX + 8, cardY + cardHeight - 28, 10, "/F2", cr, cg, cb);
        drawText(card.sub, cX + 8, cardY + 8, 7, "/F1", 0.5, 0.55, 0.6);
      });

      currentY = cardY - 14;

      if (m.hasIncompleteCosting) {
        fillRect(30, currentY - 18, pageWidth - 60, 18, 0.99, 0.95, 0.88);
        strokeRect(30, currentY - 18, pageWidth - 60, 18, 0.98, 0.75, 0.45);
        drawText(`⚠️ Notice: ${m.incompleteCostingOrderCount} completed order(s) have incomplete recipe/stock cost records. Gross profit excludes unknown costs.`, 40, currentY - 13, 7.5, "/F2", 0.6, 0.25, 0.05);
        currentY -= 26;
      }
    }

    // Table Header
    const tableX = 30;
    const tableHeaderY = currentY - 18;
    fillRect(tableX, tableHeaderY, pageWidth - 60, 18, 0.15, 0.23, 0.36); // Dark navy header
    strokeRect(tableX, tableHeaderY, pageWidth - 60, 18, 0.15, 0.23, 0.36);

    let curColX = tableX;
    columns.forEach((col) => {
      const titleY = tableHeaderY + 5;
      if (col.align === "right") {
        drawTextRight(col.title, curColX + col.width - 6, titleY, 8, "/F2", 1, 1, 1);
      } else if (col.align === "center") {
        drawTextCenter(col.title, curColX + (col.width / 2), titleY, 8, "/F2", 1, 1, 1);
      } else {
        drawText(col.title, curColX + 6, titleY, 8, "/F2", 1, 1, 1);
      }
      curColX += col.width;
    });

    currentY = tableHeaderY;

    // Table Rows
    const rowHeight = 17;
    pageRows.forEach((r, rIdx) => {
      const rowY = currentY - rowHeight;
      const isEven = rIdx % 2 === 0;
      if (isEven) {
        fillRect(tableX, rowY, pageWidth - 60, rowHeight, 0.98, 0.99, 1.0);
      } else {
        fillRect(tableX, rowY, pageWidth - 60, rowHeight, 1, 1, 1);
      }
      drawLine(tableX, rowY, pageWidth - 30, rowY, 0.92, 0.94, 0.96);

      const total = Number(r.total_minor || r.totalMinor || 0);
      const ref = Number(r.refunded_minor || r.refundedMinor || 0);
      const net = r.order_status === "cancelled" || r.orderStatus === "cancelled" ? 0 : Math.max(0, total - ref);
      const cogs = Number(r.cogs_minor || r.cogsMinor || 0);
      const profit = Number(r.gross_profit_minor || r.grossProfitMinor || (net - cogs));
      const margin = net > 0 ? ((profit / net) * 100).toFixed(1) + "%" : "0.0%";

      const rowValues = [
        `#${r.order_number || r.orderNumber}`,
        r.business_date || r.businessDate || "",
        r.ordered_at ? new Date(r.ordered_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "",
        r.order_type || r.orderType || "",
        r.order_status || r.orderStatus || "",
        formatPkr(total),
        ref > 0 ? `-${formatPkr(ref)}` : "0.00",
        formatPkr(net),
      ];

      if (!isCashier) {
        rowValues.push(
          formatPkr(cogs),
          formatPkr(profit),
          margin,
          r.incomplete_costing || r.incompleteCosting ? "Missing" : "OK",
        );
      }

      let cellX = tableX;
      columns.forEach((col, cIdx) => {
        const val = rowValues[cIdx] || "";
        const textY = rowY + 5;
        if (col.align === "right") {
          drawTextRight(val, cellX + col.width - 6, textY, 7.5, "/F1", 0.15, 0.2, 0.25);
        } else if (col.align === "center") {
          drawTextCenter(val, cellX + (col.width / 2), textY, 7.5, "/F1", 0.15, 0.2, 0.25);
        } else {
          drawText(val, cellX + 6, textY, 7.5, "/F1", 0.15, 0.2, 0.25);
        }
        cellX += col.width;
      });

      currentY = rowY;
    });

    // Outer table border
    strokeRect(tableX, currentY, pageWidth - 60, tableHeaderY + 18 - currentY, 0.82, 0.85, 0.89);

    // Page footer
    drawLine(30, 32, pageWidth - 30, 32, 0.85, 0.88, 0.92);
    drawText("Bite Tech Billz 2.0 POS — Confidential Financial Report", 30, 20, 8, "/F1", 0.5, 0.55, 0.6);
    drawTextRight(`Page ${pageNum} of ${totalPages}`, pageWidth - 30, 20, 8, "/F2", 0.3, 0.35, 0.4);

    pageStreamObjects.push(stream.join("\n"));
  }

  // Assemble PDF Objects
  const objects = [];
  function addObject(content) {
    objects.push(content);
    return objects.length;
  }

  // 1: Catalog
  // 2: Pages
  // 3: Font Helvetica
  // 4: Font Helvetica-Bold
  const catalogObjNum = 1;
  const pagesObjNum = 2;
  const fontNormObjNum = 3;
  const fontBoldObjNum = 4;

  addObject(""); // Placeholder 1
  addObject(""); // Placeholder 2
  addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`); // 3
  addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`); // 4

  const pageObjNums = [];
  for (let i = 0; i < totalPages; i++) {
    const streamContent = pageStreamObjects[i];
    const streamLength = Buffer.byteLength(streamContent, "utf8");
    const contentObjNum = addObject(`<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream`);
    const pageObjNum = addObject(`<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentObjNum} 0 R /Resources << /Font << /F1 ${fontNormObjNum} 0 R /F2 ${fontBoldObjNum} 0 R >> >> >>`);
    pageObjNums.push(pageObjNum);
  }

  objects[catalogObjNum - 1] = `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`;
  objects[pagesObjNum - 1] = `<< /Type /Pages /Kids [${pageObjNums.map(n => `${n} 0 R`).join(" ")}] /Count ${totalPages} >>`;

  // Write PDF file buffer
  let pdf = "%PDF-1.4\n";
  const xrefOffsets = [];

  for (let i = 0; i < objects.length; i++) {
    xrefOffsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const startXref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of xrefOffsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjNum} 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
}
