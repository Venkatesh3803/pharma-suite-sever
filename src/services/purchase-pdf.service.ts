import PDFDocument from "pdfkit";
import { prisma } from "../lib/prisma";
import { AppError } from "../domain/errors";

const PAGE_WIDTH = 595.28; // A4 portrait
const PAGE_HEIGHT = 841.89;
const LEFT_MARGIN = 43;
const RIGHT_EDGE = 552;
const TOP_MARGIN = 40;
const FOOTER_Y = 812;
const CONTENT_LIMIT = 794; // item rows stop before the footer
const HEADER_BOTTOM = 150;

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  APPROVED: "Approved",
  PARTIALLY_RECEIVED: "Partially Received",
  RECEIVED: "Received",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

function fmtAmount(n: number, currency = "Rs."): string {
  const value = n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${value}`;
}

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  options: { fontSize?: number; font?: string } = {},
): string {
  if (options.font) doc.font(options.font);
  if (options.fontSize) doc.fontSize(options.fontSize);
  if (doc.widthOfString(text) <= maxWidth) return text;
  let result = text;
  while (result.length > 0 && doc.widthOfString(`${result}…`) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}…`;
}

interface PdfResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Generates an A4 Purchase Order PDF mirroring the provided sample template.
 * The vendor/ship-to boxes and payment strip appear once on the first page;
 * the header, table column headers and footer (with page numbers) repeat on
 * every page so orders with many line items paginate cleanly.
 */
export async function generatePurchasePdf(
  organizationId: string,
  purchaseId: string,
): Promise<PdfResult> {
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, organizationId },
    include: {
      supplier: true,
      branch: { include: { organization: true } },
      items: { include: { product: true } },
      createdBy: { select: { fullName: true } },
    },
  });
  if (!purchase) throw new AppError("Purchase not found.", 404, "NOT_FOUND");
  const po = purchase;

  const org = po.branch.organization;
  const branch = po.branch;
  const cur = org.currency === "INR" ? "Rs." : org.currency || "Rs.";

  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));

  let y = TOP_MARGIN;

  // ── Reusable page header (drawn on page 1 and every continuation page) ──
  function drawHeader(): void {
    doc.rect(0, 0, PAGE_WIDTH, 4).fillColor("#0f766e").fill();

    const hy = TOP_MARGIN + 10;
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(15).text(org.name, LEFT_MARGIN, hy);
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8);
    let cy = hy + 18;
    const contact = [branch.phone ? `Phone: ${branch.phone}` : ""].filter(Boolean).join(" | ");
    const orgLines = [org.address, contact, org.gstin ? `GST/TAX ID: ${org.gstin}` : ""].filter(
      (s): s is string => Boolean(s),
    );
    for (const line of orgLines) {
      doc.text(line, LEFT_MARGIN, cy);
      cy = doc.y + 1;
    }

    const px = RIGHT_EDGE - 220;
    doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(19).text("PURCHASE ORDER", px, hy, {
      width: 220,
      align: "right",
    });
    doc.fontSize(13).text(po.poNumber, px, hy + 26, { width: 220, align: "right" });
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8.5);
    const meta = [
      `PO Number: ${po.poNumber}`,
      `PO Date: ${fmtDate(po.createdAt)}`,
      `Delivery Due: ${fmtDate(po.expectedDelivery)}`,
      `Status: ${STATUS_LABEL[po.status] ?? po.status}`,
    ];
    let py = hy + 46;
    for (const line of meta) {
      doc.text(line, px, py, { width: 220, align: "right" });
      py += 12;
    }

    doc.strokeColor("#e5e7eb").lineWidth(1).moveTo(LEFT_MARGIN, 143).lineTo(RIGHT_EDGE, 143).stroke();
  }

  // ── Vendor / supplier + ship-to boxes ──
  function drawPartyBoxes(): void {
    const bw = (RIGHT_EDGE - LEFT_MARGIN - 12) / 2;
    const bh = 112;
    const by = y;

    const supplierLines = [
      po.supplier?.name ?? "—",
      po.supplier?.contactPerson ? `Attn: ${po.supplier.contactPerson}` : "",
      po.supplier?.address ?? "",
      [po.supplier?.phone, po.supplier?.email].filter(Boolean).join(" | ")
        ? `Contact: ${[po.supplier?.phone, po.supplier?.email].filter(Boolean).join(" | ")}`
        : "",
      po.supplier?.code
        ? `Vendor ID: ${po.supplier.code}`
        : po.supplier?.gstin
          ? `GSTIN: ${po.supplier.gstin}`
          : "",
    ].filter(Boolean);

    const shipLines = [
      branch.name ?? org.name,
      `Attn: ${org.name} ${branch.name ? `- ${branch.name}` : ""}`,
      branch.address ?? "",
      [branch.city, branch.state].filter(Boolean).join(", ") ||
        (branch.address ? "" : org.address ?? ""),
      branch.phone ? `Contact: ${branch.phone}` : "",
    ].filter(Boolean);

    drawPartyBox(LEFT_MARGIN, by, bw, bh, "VENDOR / SUPPLIER", supplierLines);
    drawPartyBox(LEFT_MARGIN + bw + 12, by, bw, bh, "SHIP TO / DELIVERY SITE", shipLines);
    y = by + bh;
  }

  function drawPartyBox(
    bx: number,
    by: number,
    bw: number,
    bh: number,
    title: string,
    lines: string[],
  ): void {
    doc.fillColor("#0f766e").rect(bx, by, bw, 18).fill();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(title, bx + 6, by + 5);
    const name = lines.shift() ?? "—";
    doc
      .fillColor("#111827")
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .text(fitText(doc, name, bw - 12, { fontSize: 9.5, font: "Helvetica-Bold" }), bx + 6, by + 24, {
        width: bw - 12,
        lineBreak: false,
      });
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8);
    let ly = by + 40;
    for (const line of lines) {
      if (ly + 11 > by + bh - 4) break;
      doc.text(fitText(doc, line, bw - 12, { fontSize: 8 }), bx + 6, ly, { width: bw - 12, lineBreak: false });
      ly += 11;
    }
    doc.strokeColor("#d1d5db").lineWidth(0.8).rect(bx, by, bw, bh).stroke();
  }

  // ── Payment / shipping / fob / requisitioner strip ──
  function drawMetaStrip(): void {
    const colW = (RIGHT_EDGE - LEFT_MARGIN) / 4;
    const by = y;
    const cols = [
      { label: "PAYMENT TERMS", value: po.supplier?.paymentTerms || "—" },
      { label: "SHIPPING METHOD", value: "Standard" },
      {
        label: "FOB POINT",
        value: branch.city || branch.state || branch.address || "—",
      },
      { label: "REQUISITIONER", value: po.createdBy?.fullName || "—" },
    ];
    doc.strokeColor("#d1d5db").lineWidth(0.8);
    doc.rect(LEFT_MARGIN, by, RIGHT_EDGE - LEFT_MARGIN, 42).stroke();
    for (let i = 0; i < cols.length; i++) {
      const cx = LEFT_MARGIN + i * colW;
      doc.strokeColor("#d1d5db").moveTo(cx, by).lineTo(cx, by + 42).stroke();
      doc.fillColor("#0f766e").font("Helvetica-Bold").fontSize(7).text(cols[i].label, cx + 5, by + 6, {
        width: colW - 10,
        lineBreak: false,
      });
      doc.fillColor("#111827").font("Helvetica").fontSize(8.5).text(
        fitText(doc, cols[i].value, colW - 10, { fontSize: 8.5 }),
        cx + 5,
        by + 19,
        { width: colW - 10, lineBreak: false },
      );
    }
    y = by + 42;
  }

  // ── Items table ──
  const tableCols = [
    { label: "#", x: LEFT_MARGIN, w: 19, align: "right" as const },
    { label: "ITEM DESCRIPTION", x: 66, w: 236, align: "left" as const },
    { label: "QTY", x: 306, w: 38, align: "right" as const },
    { label: "UNIT PRICE", x: 348, w: 68, align: "right" as const },
    { label: "TAX RATE", x: 420, w: 38, align: "right" as const },
    { label: "TOTAL AMOUNT", x: 462, w: 90, align: "right" as const },
  ];

  function drawTableHeader(): void {
    doc.fillColor("#0f766e").rect(LEFT_MARGIN, y, RIGHT_EDGE - LEFT_MARGIN, 20).fill();
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7);
    for (const c of tableCols) {
      doc.text(c.label, c.x + 4, y + 6.5, { width: c.w - 8, align: c.align, lineBreak: false });
    }
    y += 20;
  }

  const rowH = 46;
  function drawItemRow(idx: number, item: (typeof po.items)[number]): void {
    if (idx % 2 === 1) {
      doc.fillColor("#f3f4f6").rect(LEFT_MARGIN, y, RIGHT_EDGE - LEFT_MARGIN, rowH).fill();
    }
    const product = item.product;
    const name = fitText(
      doc,
      [
        product.brand,
        [product.strength, product.dosageForm, product.packSize].filter(Boolean).join(" · "),
      ]
        .filter(Boolean)
        .join(" — "),
      tableCols[1].w - 8,
      { fontSize: 8, font: "Helvetica-Bold" },
    );
    const sub = [
      item.batchNumber ? `Batch: ${item.batchNumber}` : "",
      item.expiryDate ? `Exp: ${fmtDate(item.expiryDate)}` : "",
    ]
      .filter(Boolean)
      .join("   ·   ");

    const cells: { x: number; w: number; align: "left" | "right"; text: string; bold?: boolean; small?: boolean }[] = [
      { x: tableCols[0].x, w: tableCols[0].w, align: "right", text: String(idx + 1) },
      { x: tableCols[1].x, w: tableCols[1].w, align: "left", text: name, bold: true },
      { x: tableCols[2].x, w: tableCols[2].w, align: "right", text: String(item.quantity) },
      {
        x: tableCols[3].x,
        w: tableCols[3].w,
        align: "right",
        text: Number(item.purchasePrice).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      },
      {
        x: tableCols[4].x,
        w: tableCols[4].w,
        align: "right",
        text: Number(item.gstRate) > 0 ? `${item.gstRate}%` : "—",
      },
      { x: tableCols[5].x, w: tableCols[5].w, align: "right", text: fmtAmount(Number(item.total), cur) },
    ];

    for (const c of cells) {
      doc
        .fillColor(c.bold ? "#111827" : "#374151")
        .font(c.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(8)
        .text(c.text, c.x + 4, y + 5, { width: c.w - 8, align: c.align, lineBreak: false });
    }
    if (sub) {
      doc
        .fillColor("#6b7280")
        .font("Helvetica")
        .fontSize(7)
        .text(sub, tableCols[1].x + 4, y + 19, { width: tableCols[1].w - 8, lineBreak: false });
    }
    doc.strokeColor("#e5e7eb").lineWidth(0.5).moveTo(LEFT_MARGIN, y + rowH).lineTo(RIGHT_EDGE, y + rowH).stroke();
  }

  // ── Notes + totals ──
  function drawNotesAndTotals(): void {
    const nbx = LEFT_MARGIN;
    const nbw = 292;
    const nby = y + 10;

    doc.fillColor("#0f766e").rect(nbx, nby, nbw, 16).fill();
    doc
      .fillColor("#ffffff")
      .font("Helvetica-Bold")
      .fontSize(7)
      .text("SPECIAL INSTRUCTIONS & DELIVERY NOTES", nbx + 6, nby + 4.5, { width: nbw - 12 });
    doc.fillColor("#374151").font("Helvetica").fontSize(8);
    doc.text(po.notes?.trim() || "No special instructions.", nbx + 6, nby + 22, {
      width: nbw - 12,
    });
    const nEnd = Math.max(doc.y, nby + 40) + 6;
    doc.strokeColor("#d1d5db").lineWidth(0.8).rect(nbx, nby, nbw, nEnd - nby).stroke();

    const tx = RIGHT_EDGE - 158;
    const ty = y + 10;
    const rows: [string, number][] = [
      ["Subtotal", Number(po.subtotal)],
      ["Discount", -Number(po.discount)],
      ["GST", Number(po.tax)],
    ];
    let ry = ty;
    doc.font("Helvetica").fontSize(8.5);
    for (const [label, value] of rows) {
      doc.fillColor("#4b5563").text(label, tx, ry, { width: 90 });
      doc.fillColor("#111827").text(fmtAmount(value, cur), tx + 90, ry, { width: 68, align: "right" });
      ry += 14;
    }
    ry += 4;
    doc.strokeColor("#0f766e").lineWidth(1.2).moveTo(tx, ry).lineTo(RIGHT_EDGE, ry).stroke();
    ry += 2;
    doc
      .fillColor("#0f766e")
      .font("Helvetica-Bold")
      .fontSize(11)
      .text("Grand Total", tx, ry, { width: 90 });
    doc.text(fmtAmount(Number(po.total), cur), tx + 90, ry, { width: 68, align: "right" });

    y = Math.max(nEnd, ry + 26) + 8;
  }

  // ── Terms + signature page ──
  function drawTermsAndSignatures(): void {
    doc.addPage();
    const ty = TOP_MARGIN + 30;
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(10).text("Standard Terms & Conditions", LEFT_MARGIN, ty);
    doc.fillColor("#4b5563").font("Helvetica").fontSize(8.5);
    const terms = `This Purchase Order is subject to ${org.name}'s standard terms and conditions. The supplier agrees to supply goods and services in strict accordance with the specifications, quantities and pricing detailed herein. Any modifications to this order must be agreed upon in writing by an authorized representative. Prices are exclusive of applicable taxes unless stated otherwise.`;
    doc.text(terms, LEFT_MARGIN, ty + 18, { width: RIGHT_EDGE - LEFT_MARGIN, align: "justify" });

    const sy = doc.y + 40;
    const bw = (RIGHT_EDGE - LEFT_MARGIN - 12) / 2;
    drawSignatureBox(LEFT_MARGIN, sy, bw, 110, "AUTHORIZED PURCHASING AGENT", org.name);
    drawSignatureBox(LEFT_MARGIN + bw + 12, sy, bw, 110, "VENDOR ACCEPTANCE SIGNATURE", po.supplier?.name ?? "Supplier");
  }

  function drawSignatureBox(bx: number, by: number, bw: number, bh: number, title: string, name: string): void {
    doc.strokeColor("#d1d5db").lineWidth(0.8).rect(bx, by, bw, bh).stroke();
    doc.fillColor("#6b7280").font("Helvetica-Bold").fontSize(7).text(title, bx + 6, by + 8, { width: bw - 12 });
    doc.fillColor("#111827").font("Helvetica-Bold").fontSize(9).text(name, bx + 6, by + 22, { width: bw - 12, lineBreak: false });
    doc.strokeColor("#9ca3af").lineWidth(0.5).moveTo(bx + 6, by + bh - 22).lineTo(bx + bw - 6, by + bh - 22).stroke();
    doc.fillColor("#6b7280").font("Helvetica").fontSize(7).text("Signature & Date", bx + 6, by + bh - 16, { width: bw - 12 });
  }

  // ── Footer (stamped on every page once page count is known) ──
  function drawFooter(pageNo: number, total: number): void {
    doc.fillColor("#6b7280").font("Helvetica").fontSize(8.5);
    doc.text(`${org.name} — Purchase Order`, LEFT_MARGIN, FOOTER_Y, { width: 300 });
    doc.text(`Page ${pageNo} of ${total}`, RIGHT_EDGE - 100, FOOTER_Y, { width: 100, align: "right" });
  }

  // ── Compose the document ──
  drawHeader();
  y = HEADER_BOTTOM;

  drawPartyBoxes();
  y += 14;
  drawMetaStrip();
  y += 14;

  drawTableHeader();
  for (let i = 0; i < po.items.length; i++) {
    if (y + rowH > CONTENT_LIMIT) {
      doc.addPage();
      y = TOP_MARGIN;
      drawHeader();
      y = HEADER_BOTTOM;
      drawTableHeader();
    }
    drawItemRow(i, po.items[i]);
    y += rowH;
  }

  y += 10;
  drawNotesAndTotals();

  drawTermsAndSignatures();

  // Stamp page numbers now that the total page count is known.
  const range = doc.bufferedPageRange();
  const total = range.start + range.count;
  for (let i = range.start; i < total; i++) {
    doc.switchToPage(i);
    drawFooter(i + 1, range.count);
  }

  doc.end();
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  return { buffer, filename: `${po.poNumber}.pdf` };
}