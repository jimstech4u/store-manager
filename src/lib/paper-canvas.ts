import { columnsAt, receiptLines, type PrintedLine, type ReceiptLayout, type TextSize } from '@/lib/escpos-text';
import type { ReceiptImageInput } from '@/lib/share';

/**
 * THE PAPER, DRAWN ONCE — the picture and the PDF every way out of the app, and out of the agent.
 *
 * "Why is the PDF and image different to what the app does? Can we reuse the same?" They were two
 * renderers: the app drew on a canvas, the WhatsApp agent had its own image engine and its own PDF,
 * and the same receipt came out in two looks. This is the app's drawing, moved here unchanged and
 * handed its canvas: the browser's in the app (`share.ts`), `@napi-rs/canvas` on the server
 * (`whatsapp/paper.ts`). The one thing that can differ is the font a phone has; the layout, rules and
 * words cannot.
 */

/** A canvas, wherever it comes from: the browser's, or the server's with the same API. */
export interface PaperCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}
export type MakeCanvas = (width: number, height: number) => PaperCanvas;

/**
 * Pictures the paper needs, LOADED BEFORE it is drawn — the drawing is synchronous, a picture is not.
 * The browser's `Image` or the server's, by address. One missing is left off the paper.
 */
export interface PaperImage {
  width: number;
  height: number;
}
export type PaperImages = Map<string, PaperImage>;

/** The addresses a document's pictures are at: what to load before `drawDocument`. */
export function paperImageUrls(input: ReceiptImageInput): string[] {
  return input.logo?.url ? [input.logo.url] : [];
}

/** A logo at `pct` of `room`, its height kept in proportion; null when it is not loaded. */
function logoBox(images: PaperImages | undefined, logo: ReceiptImageInput['logo'], room: number) {
  const img = logo ? images?.get(logo.url) : undefined;
  if (!logo || !img || img.width <= 0 || img.height <= 0) return null;
  const pct = Math.min(100, Math.max(10, Number(logo.widthPct) || 60));
  const w = Math.round((room * pct) / 100);
  return { img, w, h: Math.round((img.height * w) / img.width) };
}

function drawPicture(ctx: CanvasRenderingContext2D, img: PaperImage, x: number, y: number, w: number, h: number) {
  ctx.drawImage(img as unknown as CanvasImageSource, x, y, w, h);
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
function drawReceipt(
  input: ReceiptImageInput,
  widthMm: number,
  make: MakeCanvas,
  font: string,
  images?: PaperImages,
): PaperCanvas | null {

  const scale = 8;                       // px per mm
  const width = Math.round(widthMm * scale);
  const pad = Math.round(3 * scale);
  const inner = width - pad * 2;

  const base = Math.round(width / 26);   // body text size, derived so narrow rolls stay readable
  const lineH = Math.round(base * 1.55);

  // Measure first on a throwaway context, so the canvas can be created at exactly the height the
  // content needs — a fixed height would either clip a long receipt or pad a short one.
  const probe = make(1, 1).getContext('2d');
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

  const bodyFont = `${base}px ${font}`;
  const boldFont = `bold ${base}px ${font}`;
  const titleFont = `bold ${Math.round(base * 1.5)}px ${font}`;

  const logo = logoBox(images, input.logo, inner);
  let height = pad;
  if (logo) height += logo.h + Math.round(base * 0.8);
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

  const canvas = make(width, Math.round(height));
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

  if (logo) {
    drawPicture(ctx, logo.img, Math.round((width - logo.w) / 2), y, logo.w, logo.h);
    y += logo.h + Math.round(base * 0.8);
  }
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
export const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Menlo, Consolas, monospace";

function drawLines(
  lines: PrintedLine[],
  layout: ReceiptLayout,
  widthMm: number,
  make: MakeCanvas,
  mono: string,
  images?: PaperImages,
): PaperCanvas | null {
  const scale = 8; // px per mm
  const width = Math.round(widthMm * scale);
  const pad = Math.round(3 * scale);
  const paper = width - pad * 2;

  const probe = make(1, 1).getContext('2d');
  if (!probe) return null;
  probe.font = `100px ${mono}`;
  const measured = probe.measureText('0'.repeat(100)).width / 100 / 100;
  const ratio = measured > 0.3 && measured < 1 ? measured : 0.6;

  const sized = lines.map((line) => {
    if (line.image) {
      const box = logoBox(images, line.image, paper);
      return { parts: [], rowH: box ? box.h + scale * 2 : 0, box };
    }
    const spans = line.spans.length > 0 ? line.spans : [{ size: 'ss' as TextSize, text: ' ' }];
    const parts = spans.map((sp) => {
      const cell = paper / columnsAt(sp.size, layout);
      const wide = sp.size.endsWith('w') ? 2 : 1;
      const tall = sp.size.endsWith('h') || sp.size.endsWith('hw') ? 2 : 1;
      return { sp, cell, font: cell / ratio, scaleY: tall / wide, height: (cell / ratio) * (tall / wide) };
    });
    const rowH = parts.reduce((m, x) => Math.max(m, x.height), 0) * 1.2;
    return { parts, rowH, box: null };
  });

  const height = Math.round(pad * 2 + sized.reduce((sum, l) => sum + l.rowH, 0));
  const canvas = make(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#000000';
  ctx.textBaseline = 'alphabetic';

  let y = pad;
  for (const line of sized) {
    if (line.box) {
      drawPicture(ctx, line.box.img, Math.round(pad + (paper - line.box.w) / 2), y, line.box.w, line.box.h);
      y += line.rowH;
      continue;
    }
    let x = pad;
    for (const part of line.parts) {
      ctx.save();
      ctx.font = `${part.sp.size.startsWith('sl') ? 600 : 500} ${part.font}px ${mono}`;
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

/**
 * Draw a document. With the shop's roll layout it is drawn from the SAME lines the printer is sent
 * and the screen shows (`receiptLines`).
 */
export function drawDocument(
  input: ReceiptImageInput,
  widthMm: number,
  make: MakeCanvas,
  /**
   * The shop's roll layout. Given, the picture and the PDF are drawn from the SAME lines the printer
   * is sent and the screen shows (`receiptLines`) — one layout, every way out. "The receipt, even
   * the PDF or the image, needs a better format": they had their own, which had no rules between
   * items and no entries, so a statement came out as one run-on list.
   */
  layout?: ReceiptLayout,
  /** The monospace family: the app's system stack, or a font the server registered. */
  font?: string,
  /** The pictures `paperImageUrls` named, already loaded. */
  images?: PaperImages,
): PaperCanvas | null {
  return layout
    ? drawLines(receiptLines(input, layout), layout, widthMm, make, font ?? MONO, images)
    : drawReceipt(input, widthMm, make, font ?? 'ui-monospace, monospace', images);
}
