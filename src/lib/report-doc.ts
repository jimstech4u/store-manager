'use client';

import type { ReceiptImageInput } from '@/lib/share';
import { toCsv } from '@/lib/export-csv';

/**
 * A REPORT, DESCRIBED ONCE — and drawn three ways from the same description: A4 pages (for a PDF,
 * or a page printer), lines on a receipt roll (for the shop's thermal printer), and a CSV.
 *
 * "export based on report ... just like a bank fintech does." A bank statement has a header that
 * says whose it is and for when, the filters that made it, a table whose heading repeats on every
 * page, totals at the end, and page numbers. So does this.
 */
export interface ReportColumn {
  head: string;
  /** Figures right-aligned, words left. */
  align?: 'left' | 'right';
  /** Relative width on A4. Default 1. */
  weight?: number;
}

export interface ReportDoc {
  shop: string;
  title: string;
  /** What made this report: "29 Sep 2026 · owes between ₦10,000 and ₦50,000". */
  filters: string;
  generatedAt: Date;
  columns: ReportColumn[];
  rows: string[][];
  totals: { label: string; value: string }[];
  /** Said under the table — what the figures mean, where it matters. */
  note?: string;
}

// ── A4 ───────────────────────────────────────────────────────────────────────────────

const PX_PER_MM = 5; // 1050 × 1485 — sharp when printed, small enough to build on a phone
const PAGE_W = 210 * PX_PER_MM;
const PAGE_H = 297 * PX_PER_MM;
const MARGIN = 14 * PX_PER_MM;
const INK = '#12201d';
const MUTED = '#5a6b66';
const BRAND = '#0b6252';
const ZEBRA = '#f1f5f4';
const RULE = '#c9d3d0';
const FONT = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= width) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function wrapWords(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The report on A4, one canvas per page.
 *
 * The first page carries the shop, the title and the filters; every page repeats the column
 * heading and carries "Page n of N" and when it was made, so a sheet that is separated from the
 * others still says what it is. A row never splits across pages. The totals follow the last row.
 */
export function renderReportPages(doc: ReportDoc): HTMLCanvasElement[] {
  if (typeof document === 'undefined') return [];
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [];

  const innerW = PAGE_W - MARGIN * 2;
  const weights = doc.columns.map((c) => c.weight ?? 1);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => (w / totalW) * innerW);
  const colX = colW.map((_, i) => MARGIN + colW.slice(0, i).reduce((a, b) => a + b, 0));

  const ROW_H = 38;
  const HEAD_H = 42;
  const PAD = 10;
  // ~12pt on the sheet: easy to read, and a month of payments fits on a couple of pages.
  const BODY = `22px ${FONT}`;
  const BODY_BOLD = `600 22px ${FONT}`;

  const first = () => {
    // The header block's height, measured with the fonts it will be drawn in.
    probe.font = `24px ${FONT}`;
    const filterLines = wrapWords(probe, doc.filters, innerW).length;
    return 60 + 52 + filterLines * 34 + 40;
  };
  const footerH = 60;
  const firstBodyTop = MARGIN + first();
  const otherBodyTop = MARGIN + 40;
  const bodyBottom = PAGE_H - MARGIN - footerH;

  // Rows per page, then how many pages — the totals need room after the last row.
  const pages: string[][][] = [];
  let i = 0;
  let top = firstBodyTop;
  while (i < doc.rows.length || pages.length === 0) {
    const fit = Math.max(1, Math.floor((bodyBottom - top - HEAD_H) / ROW_H));
    pages.push(doc.rows.slice(i, i + fit));
    i += fit;
    top = otherBodyTop;
    if (doc.rows.length === 0) break;
  }
  const totalsH = doc.totals.length * 40 + (doc.note ? 80 : 0) + 30;
  const lastPageRows = pages[pages.length - 1].length;
  const lastTop = pages.length === 1 ? firstBodyTop : otherBodyTop;
  if (lastTop + HEAD_H + lastPageRows * ROW_H + totalsH > bodyBottom) pages.push([]);

  const when = doc.generatedAt.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return pages.map((rows, pageIndex) => {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_W;
    canvas.height = PAGE_H;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
    ctx.textBaseline = 'middle';

    let y = MARGIN;
    if (pageIndex === 0) {
      ctx.fillStyle = BRAND;
      ctx.font = `700 38px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, doc.shop, innerW * 0.65), MARGIN, y + 22);
      ctx.fillStyle = MUTED;
      ctx.font = `22px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(`Made ${when}`, PAGE_W - MARGIN, y + 22);
      y += 60;
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.font = `700 34px ${FONT}`;
      ctx.fillText(fitText(ctx, doc.title, innerW), MARGIN, y + 20);
      y += 52;
      ctx.fillStyle = MUTED;
      ctx.font = `24px ${FONT}`;
      for (const line of wrapWords(ctx, doc.filters, innerW)) {
        ctx.fillText(line, MARGIN, y + 14);
        y += 34;
      }
      y += 16;
      ctx.fillStyle = BRAND;
      ctx.fillRect(MARGIN, y, innerW, 4);
      y += 24;
    } else {
      ctx.fillStyle = MUTED;
      ctx.font = `22px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(fitText(ctx, `${doc.shop} · ${doc.title}`, innerW), MARGIN, y + 14);
      y += 40;
    }

    // The column heading, on every page.
    ctx.fillStyle = BRAND;
    ctx.fillRect(MARGIN, y, innerW, HEAD_H);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 21px ${FONT}`;
    doc.columns.forEach((c, ci) => {
      const right = c.align === 'right';
      ctx.textAlign = right ? 'right' : 'left';
      const x = right ? colX[ci] + colW[ci] - PAD : colX[ci] + PAD;
      ctx.fillText(fitText(ctx, c.head, colW[ci] - PAD * 2), x, y + HEAD_H / 2);
    });
    y += HEAD_H;

    rows.forEach((row, ri) => {
      if (ri % 2 === 1) {
        ctx.fillStyle = ZEBRA;
        ctx.fillRect(MARGIN, y, innerW, ROW_H);
      }
      ctx.fillStyle = INK;
      ctx.font = BODY;
      doc.columns.forEach((c, ci) => {
        const right = c.align === 'right';
        ctx.textAlign = right ? 'right' : 'left';
        if (ci === 0) ctx.font = BODY_BOLD;
        else ctx.font = BODY;
        const x = right ? colX[ci] + colW[ci] - PAD : colX[ci] + PAD;
        ctx.fillText(fitText(ctx, row[ci] ?? '', colW[ci] - PAD * 2), x, y + ROW_H / 2);
      });
      y += ROW_H;
    });
    ctx.fillStyle = RULE;
    ctx.fillRect(MARGIN, y, innerW, 2);

    if (pageIndex === pages.length - 1) {
      y += 24;
      if (doc.rows.length === 0) {
        ctx.fillStyle = MUTED;
        ctx.font = `26px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText('Nothing matches these filters.', MARGIN, y + 16);
        y += 50;
      }
      doc.totals.forEach((t) => {
        ctx.textAlign = 'right';
        ctx.fillStyle = MUTED;
        ctx.font = `26px ${FONT}`;
        ctx.fillText(t.label, PAGE_W - MARGIN - innerW * 0.3, y + 16);
        ctx.fillStyle = INK;
        ctx.font = `700 28px ${FONT}`;
        ctx.fillText(t.value, PAGE_W - MARGIN, y + 16);
        y += 40;
      });
      if (doc.note) {
        y += 10;
        ctx.textAlign = 'left';
        ctx.fillStyle = MUTED;
        ctx.font = `22px ${FONT}`;
        for (const line of wrapWords(ctx, doc.note, innerW)) {
          ctx.fillText(line, MARGIN, y + 12);
          y += 30;
        }
      }
    }

    // Footer on every page.
    ctx.fillStyle = MUTED;
    ctx.font = `20px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(fitText(ctx, `${doc.shop} · ${doc.title}`, innerW * 0.7), MARGIN, PAGE_H - MARGIN - 10);
    ctx.textAlign = 'right';
    ctx.fillText(`Page ${pageIndex + 1} of ${pages.length}`, PAGE_W - MARGIN, PAGE_H - MARGIN - 10);
    return canvas;
  });
}

// ── The receipt roll ────────────────────────────────────────────────────────────────

/**
 * The same report as lines on a thermal roll: the first column names each line, the last is its
 * figure (when it is one), and what is between goes under the name. A roll is 32–48 characters
 * wide, so a table becomes a list.
 */
export function reportToRoll(doc: ReportDoc): ReceiptImageInput {
  const lastRight = doc.columns[doc.columns.length - 1]?.align === 'right';
  return {
    shopName: doc.shop,
    banner: doc.title.toUpperCase(),
    header: doc.filters,
    meta: [
      doc.generatedAt.toLocaleString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
      }),
      `${doc.rows.length} ${doc.rows.length === 1 ? 'line' : 'lines'}`,
    ],
    lines: doc.rows.map((r) => {
      const middle = (lastRight ? r.slice(1, -1) : r.slice(1)).filter(Boolean).join(' · ');
      return {
        name: r[0] ?? '',
        detail: middle,
        qty: middle,
        amount: lastRight ? (r[r.length - 1] ?? '') : '',
      };
    }),
    totals: doc.totals.map((t) => ({ label: t.label, value: t.value, strong: true })),
    note: doc.note ?? null,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────

export function reportToCsv(doc: ReportDoc): string {
  return toCsv(doc.rows, doc.columns.map((c, i) => ({ head: c.head, value: (r: string[]) => r[i] ?? '' })));
}
