'use client';
import { columnsAt, receiptLines, type PrintedLine, type ReceiptLayout, type TextSize } from '@/lib/escpos-text';

/**
 * Getting a receipt or report out of the app and onto WhatsApp.
 *
 * Three routes, because no single one works everywhere and each suits a different moment:
 *
 *  · **Link** — universal. Works on every platform, nothing to download, and the recipient can
 *    print or save a PDF themselves. This is the default.
 *  · **Image** — best for WhatsApp specifically, where a picture previews inline in the chat
 *    while a link is just blue text somebody has to decide to tap.
 *  · **Print / Save as PDF** — the browser's own dialog, driven by the receipt's print styles.
 *
 * The image is drawn directly to a canvas rather than screenshotting the DOM. That avoids
 * html2canvas (a large dependency that renders CSS approximately) and gives exact control over
 * the output width — which for a receipt is the point, since it is meant to look like paper.
 */

export interface ShareLine {
  name: string;
  /** "2 Crate x N9,600" — the full working, for the picture and the PDF. */
  detail: string;
  /**
   * "2 Crate" — the same line WITHOUT the unit price.
   *
   * A printed receipt reads better without it: "1 Pack x N4,500 ... N4,500" says the same figure
   * twice on a 32-character line, and on the lines where it differs the multiplication is
   * arithmetic the customer is not checking. The picture keeps the working, because a phone screen
   * has room for it. Optional, so anything that has not been taught to send it still prints.
   */
  qty?: string;
  amount: string;
}

export interface ReceiptImageInput {
  shopName: string;
  /**
   * What this paper IS, when it is not a receipt — "NOT A RECEIPT" — set large under the shop's
   * name, on its own line. A receipt leaves it out and prints exactly as it always has.
   */
  banner?: string | null;
  header?: string | null;
  footer?: string | null;
  meta: string[];
  lines: ShareLine[];
  totals: { label: string; value: string; strong?: boolean }[];
  note?: string | null;
  transferDetails?: string | null;
  /**
   * ENTRIES, for a document that is a list of events rather than a bill — a statement. Each one
   * stands on its own: what it was on the left and when on the right; a sale's items numbered
   * between double rules and closed by its total; a payment or a charge between single rules.
   * Drawn after who-and-when, before the totals.
   */
  blocks?: DocBlock[];
}

export interface DocBlock {
  /** "Sale #26EE2FB7", "Payment received" — on the left. */
  title: string;
  /** The date, on the right of the same line. */
  right?: string;
  /** A sale's items: numbered, each its quantity and what it came to. */
  items?: { name: string; qty: string; amount: string }[];
  /** "Total" and the sale's amount, under the items. */
  total?: { label: string; value: string };
  /** Anything else: how it was paid, why it was charged — and its amount. */
  rows?: { label: string; value: string }[];
  /** A heavy rule under the title instead of a light one (the opening balance). */
  heavy?: boolean;
}

/** True when this browser can hand files to the OS share sheet. */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { canShare?: (data: { files?: File[] }) => boolean };
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  try {
    // Probing with a real (tiny) file: some browsers expose canShare but reject files, and the
    // only reliable way to know is to ask about a file.
    const probe = new File(['x'], 'probe.png', { type: 'image/png' });
    return nav.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export function canShareLink(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Render a receipt to a PNG blob at printer-ish proportions.
 *
 * Width is in millimetres so the image matches the paper it represents; the pixel width is
 * scaled up (8px per mm) so the text stays sharp when a phone displays it full-screen.
 */
/**
 * Draw the receipt and hand back the CANVAS.
 *
 * Split out from `renderReceiptImage` so the PDF writer can embed exactly these pixels rather than
 * decoding a PNG and re-encoding it. Two renderings of the same receipt could differ; one cannot.
 */
export async function renderReceiptCanvas(
  input: ReceiptImageInput,
  widthMm = 80,
  /**
   * The shop's roll layout. Given, the picture and the PDF are drawn from the SAME lines the printer
   * is sent and the screen shows (`receiptLines`) — one layout, every way out. "The receipt, even
   * the PDF or the image, needs a better format": they had their own, which had no rules between
   * items and no entries, so a statement came out as one run-on list.
   */
  layout?: ReceiptLayout,
): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined') return null;
  if (layout) return linesCanvas(receiptLines(input, layout), layout, widthMm);

  const scale = 8;                       // px per mm
  const width = Math.round(widthMm * scale);
  const pad = Math.round(3 * scale);
  const inner = width - pad * 2;

  const base = Math.round(width / 26);   // body text size, derived so narrow rolls stay readable
  const lineH = Math.round(base * 1.55);

  // Measure first on a throwaway context, so the canvas can be created at exactly the height the
  // content needs — a fixed height would either clip a long receipt or pad a short one.
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;

  const wrap = (text: string, font: string, maxWidth: number): string[] => {
    probe.font = font;
    const words = text.split(/\s+/);
    const out: string[] = [];
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (probe.measureText(next).width > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) out.push(current);
    return out;
  };

  const bodyFont = `${base}px ui-monospace, monospace`;
  const boldFont = `bold ${base}px ui-monospace, monospace`;
  const titleFont = `bold ${Math.round(base * 1.5)}px ui-monospace, monospace`;

  let height = pad;
  height += Math.round(base * 1.9);                            // shop name
  if (input.banner) height += wrap(input.banner, titleFont, inner).length * Math.round(base * 1.9);
  if (input.header) height += wrap(input.header, bodyFont, inner).length * lineH;
  height += lineH * input.meta.length + lineH;
  /*
   * A LINE'S DETAIL WRAPS BESIDE ITS FIGURE, never under it.
   *
   * The detail and the amount share a row, and the detail was drawn at full width — a long one ran
   * straight through the figure ("Sep 29, ₦52,250" printed over each other). It now wraps inside the
   * room the figure leaves, and the figure sits on its first row.
   */
  const beside = (left: string, right: string, font: string) => {
    probe.font = font;
    const room = Math.max(inner * 0.35, inner - probe.measureText(right).width - scale * 3);
    return wrap(left, font, room);
  };
  for (const l of input.lines) {
    height += wrap(l.name, boldFont, inner).length * lineH;
    height += Math.max(1, beside(l.qty ?? l.detail, l.amount, bodyFont).length) * lineH;
  }
  height += lineH;
  for (const t of input.totals) {
    height += Math.max(1, beside(t.label, t.value, t.strong ? boldFont : bodyFont).length) * lineH;
  }
  height += lineH;
  if (input.note) height += wrap(input.note, bodyFont, inner).length * lineH + lineH;
  if (input.transferDetails) height += input.transferDetails.split('\n').length * lineH + lineH;
  if (input.footer) height += wrap(input.footer, bodyFont, inner).length * lineH + lineH;
  height += pad;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Always black on white, whatever theme the app is in: this is a picture of a receipt, and a
  // dark-mode one looks like a mistake in a chat thread.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'top';

  let y = pad;

  /** The px size out of a CSS font shorthand, whether or not it starts with `bold`. */
  const sizeOf = (font: string): number => Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? base);

  const centred = (text: string, font: string) => {
    ctx.font = font;
    const w = ctx.measureText(text).width;
    ctx.fillText(text, (width - w) / 2, y);
    // `parseInt(font, 10)` was NaN for every bold font — "bold 36px …" does not start with a
    // digit — so drawing the shop name set y to NaN and EVERY LINE AFTER IT drew at NaN, which
    // paints nothing. A shared receipt picture has always been just the shop name on blank paper.
    y += Math.round(sizeOf(font) * 1.45);
  };

  const rule = () => {
    ctx.strokeStyle = '#000000';
    ctx.setLineDash([Math.round(scale / 2), Math.round(scale / 2)]);
    ctx.beginPath();
    ctx.moveTo(pad, y + lineH / 3);
    ctx.lineTo(width - pad, y + lineH / 3);
    ctx.stroke();
    ctx.setLineDash([]);
    y += lineH;
  };

  const row = (left: string, right: string, bold = false) => {
    const font = bold ? boldFont : bodyFont;
    const parts = beside(left, right, font);
    ctx.font = font;
    (parts.length > 0 ? parts : ['']).forEach((part, i) => {
      ctx.fillText(part, pad, y);
      if (i === 0) {
        const w = ctx.measureText(right).width;
        ctx.fillText(right, width - pad - w, y);
      }
      y += lineH;
    });
  };

  centred(input.shopName, titleFont);
  if (input.banner) {
    for (const l of wrap(input.banner, titleFont, inner)) centred(l, titleFont);
  }
  if (input.header) {
    ctx.font = bodyFont;
    for (const l of wrap(input.header, bodyFont, inner)) centred(l, bodyFont);
  }
  rule();

  ctx.font = bodyFont;
  for (const m of input.meta) {
    ctx.fillText(m, pad, y);
    y += lineH;
  }
  rule();

  for (const line of input.lines) {
    ctx.font = boldFont;
    for (const part of wrap(line.name, boldFont, inner)) {
      ctx.fillText(part, pad, y);
      y += lineH;
    }
    /*
     * The bare quantity where the line offers one — "3 Pack", not "3 Pack x N2,400 ... N7,200".
     *
     * The paper stopped repeating the unit price and the shared picture did not, so a customer
     * sent a receipt on WhatsApp got a different document from the one in their hand. Two
     * renderings of one sale that disagree is the trap this codebase already fell into once.
     */
    row(line.qty ?? line.detail, line.amount);
  }
  rule();

  for (const t of input.totals) row(t.label, t.value, t.strong);

  if (input.note) {
    rule();
    ctx.font = bodyFont;
    for (const l of wrap(input.note, bodyFont, inner)) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  if (input.transferDetails) {
    rule();
    ctx.font = bodyFont;
    for (const l of input.transferDetails.split('\n')) {
      ctx.fillText(l, pad, y);
      y += lineH;
    }
  }

  if (input.footer) {
    rule();
    for (const l of wrap(input.footer, bodyFont, inner)) centred(l, bodyFont);
  }

  return canvas;
}

/*
 * THE ROLL'S LINES ON A CANVAS — the printer's own arithmetic, as `PrintPreview` draws it on the
 * screen: one cell is the paper divided by how many of that size fit across it, the font is sized to
 * fill the cell, and a double-height size is stretched from the baseline. Black on white.
 */
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace";

function linesCanvas(lines: PrintedLine[], layout: ReceiptLayout, widthMm: number): HTMLCanvasElement | null {
  const scale = 8; // px per mm
  const width = Math.round(widthMm * scale);
  const pad = Math.round(3 * scale);
  const paper = width - pad * 2;

  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = `100px ${MONO}`;
  const measured = probe.measureText('0'.repeat(100)).width / 100 / 100;
  const ratio = measured > 0.3 && measured < 1 ? measured : 0.6;

  const sized = lines.map((line) => {
    const spans = line.spans.length > 0 ? line.spans : [{ size: 'ss' as TextSize, text: ' ' }];
    const parts = spans.map((sp) => {
      const cell = paper / columnsAt(sp.size, layout);
      const wide = sp.size.endsWith('w') ? 2 : 1;
      const tall = sp.size.endsWith('h') || sp.size.endsWith('hw') ? 2 : 1;
      return { sp, cell, font: cell / ratio, scaleY: tall / wide, height: (cell / ratio) * (tall / wide) };
    });
    const rowH = parts.reduce((m, x) => Math.max(m, x.height), 0) * 1.2;
    return { parts, rowH };
  });

  const height = Math.round(pad * 2 + sized.reduce((sum, l) => sum + l.rowH, 0));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';

  let y = pad;
  for (const line of sized) {
    let x = pad;
    for (const part of line.parts) {
      ctx.save();
      ctx.font = `${part.sp.size.startsWith('sl') ? 600 : 500} ${part.font}px ${MONO}`;
      // Down to the row's baseline, then stretched upward for a tall size.
      ctx.translate(x, y + line.rowH * 0.82);
      ctx.scale(1, part.scaleY);
      ctx.fillText(part.sp.text, 0, 0);
      ctx.restore();
      x += part.sp.text.length * part.cell;
    }
    y += line.rowH;
  }
  return canvas;
}

/** The same receipt as a PNG, for sharing as a picture. */
export async function renderReceiptImage(
  input: ReceiptImageInput,
  widthMm = 80,
  layout?: ReceiptLayout,
): Promise<Blob | null> {
  const canvas = await renderReceiptCanvas(input, widthMm, layout);
  if (!canvas) return null;
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/**
 * Share an image, falling back to a download when the browser cannot.
 *
 * Returns what actually happened so the caller can say so, rather than claiming "shared" when
 * the file merely landed in the Downloads folder.
 */
export async function shareImage(
  blob: Blob,
  filename: string,
  title: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const nav = navigator as Navigator & { canShare?: (d: { files?: File[] }) => boolean };
  const file = new File([blob], filename, { type: blob.type });

  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return 'shared';
    } catch (e) {
      // AbortError means the user closed the share sheet — not a failure, and it must not be
      // followed by a surprise download they did not ask for.
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked on the next tick: revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

/** Share a URL, falling back to the clipboard. */
export async function shareLink(
  url: string,
  title: string,
  text?: string,
): Promise<'shared' | 'copied' | 'cancelled'> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ url, title, text });
      return 'shared';
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return 'cancelled';
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'cancelled';
  }
}
