'use client';

/**
 * ESC/POS — what a thermal printer actually understands.
 *
 * WHY A BITMAP AND NOT TEXT. ESC/POS text is faster, sharper and the obvious first answer, and it
 * cannot print ₦. The code pages a receipt printer ships with are CP437 and friends; the naira sign
 * is in none of them. A till in Lagos printing "N12,500" or "?12,500" on every line is not a receipt
 * anybody wants to hand a customer.
 *
 * So the receipt is drawn once, by `renderReceiptCanvas`, and sent as a raster. That is the same
 * canvas the shop already shares on WhatsApp and saves as a PDF, which means the paper, the picture
 * and the PDF cannot disagree — and they have disagreed before: a receipt shared as an image once
 * showed one lumped "extra charge" while the paper itemised transport and loading separately. Two
 * renderers is two documents for one sale.
 *
 * The cost is a slower print — a few hundred milliseconds of Bluetooth for an 80mm receipt — and
 * that is the right trade for a document with the shop's name on it.
 */

/**
 * Printable dots across, by PAPER width — which is not the same as the printing width.
 *
 * From the manual of the roll this was built against: "Dot pitch 576 dots/line, Printing width
 * 72mm, Paper width 80mm, resolution 203 dpi". So 80mm paper prints 72mm of it, and 203dpi is 8
 * dots per millimetre to within a rounding error (203 / 25.4 = 7.99). 58mm paper prints 48mm on the
 * same head geometry.
 */
export function dotsFor(widthMm: number): number {
  if (widthMm >= 76) return 576;
  if (widthMm >= 56) return 384;
  // Narrower rolls, at the same 8 dots per mm, rounded down to a whole byte.
  return Math.max(8, Math.floor(Math.max(1, widthMm - 8)) * 8);
}

/**
 * THE WIDTH TO LAY A RECEIPT OUT AT, in millimetres, for a given roll.
 *
 * THIS IS THE FIX FOR A BLURRY PRINT. The receipt was drawn at 8px per millimetre of PAPER — 640px
 * for an 80mm roll — and then scaled down to the head's 576 dots on the way to the printer.
 * Downscaling text by 0.9 does not make smaller text; it makes grey, half-covered pixels, and a
 * printer that can only burn a dot or not burn it then has to guess at every one of them. The
 * result reads as smudged and thin, which is exactly how the first real print came back.
 *
 * Drawn at 72mm instead, the layout lands on 576 pixels natively: one pixel, one dot, nothing
 * resampled, and every stroke either full black or nothing.
 */
export function printableMm(paperMm: number): number {
  return dotsFor(paperMm) / 8;
}

/**
 * Pure black and white, with nothing in between.
 *
 * A thermal head burns a dot or it does not. Anti-aliased edges — the grey halo a browser puts
 * around every glyph — are not something it can render, so whatever receives the image decides for
 * itself: some threshold it, some dither it into stipple, and stippled text on 203dpi paper is the
 * "did not come out well" everybody recognises. Deciding here means the picture that goes to the
 * printer is the picture that comes out.
 *
 * The same threshold `rasterFromCanvas` uses, so the direct routes and the hand-off to a printer app
 * produce identical paper.
 */
export function flatten(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    // Transparent is PAPER. Read as dark it would burn every margin solid black, which wastes a
    // roll and a battery and hides the receipt.
    const luma =
      data[i + 3] < 128
        ? 255
        : data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const v = luma < 160 ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const ESC = 0x1b;
const GS = 0x1d;

/**
 * A canvas as ESC/POS raster, ready to send.
 *
 * `GS v 0` rather than the older bit-image commands: it takes the whole image in one command with a
 * height in dots, so there is no per-row overhead and no printer-specific line spacing to get
 * wrong.
 *
 * THRESHOLD, NOT DITHER. A receipt is already black text on white — dithering it would turn solid
 * glyphs into stipple and cost legibility on 8-dot-per-mm paper. Dithering is for photographs, and
 * a receipt's only photograph is a logo somebody chose to be legible.
 */
export function rasterFromCanvas(canvas: HTMLCanvasElement, maxDots: number): Uint8Array {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the receipt image');

  /*
   * Scaled to the paper, never up.
   *
   * `renderReceiptCanvas` draws at 8px per mm so the picture stays sharp on a phone, which is
   * already about the printer's own resolution — but a shop can set a roll narrower than the canvas
   * was drawn for, and sending more dots than the head has silently wraps every line.
   */
  const scale = Math.min(1, maxDots / canvas.width);
  const width = Math.floor(canvas.width * scale);
  const height = Math.floor(canvas.height * scale);

  let source = canvas;
  if (scale < 1) {
    const shrunk = document.createElement('canvas');
    shrunk.width = width;
    shrunk.height = height;
    const sctx = shrunk.getContext('2d');
    if (!sctx) throw new Error('Could not resize the receipt image');
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(canvas, 0, 0, width, height);
    source = shrunk;
  }

  const { data } = (source.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0, 0, width, height,
  );

  // Whole bytes across, because the printer reads the row eight dots at a time and a partial byte
  // at the end would be read as ink.
  const bytesPerRow = Math.ceil(width / 8);
  const bitmap = new Uint8Array(bytesPerRow * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = data[i + 3];
      /*
       * TRANSPARENT IS PAPER, not ink.
       *
       * The canvas is drawn on a white background, but a transparent pixel read as dark would make
       * every margin print solid black — which on a thermal head is also how you burn through a
       * roll and a lot of battery.
       */
      const luma = alpha < 128 ? 255 : (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      if (luma < 160) {
        bitmap[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  const header = [
    ESC, 0x40,                                    // initialise: a printer may be mid-anything
    ESC, 0x61, 0x01,                              // centre, so a narrow receipt is not left-hugging
    GS, 0x76, 0x30, 0x00,                         // GS v 0, normal density
    bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
    height & 0xff, (height >> 8) & 0xff,
  ];

  const tail = [
    0x0a, 0x0a, 0x0a,                             // clear of the tear bar
    /*
     * A partial cut, and tolerated if the printer has no cutter.
     *
     * `GS V 66 n` feeds then cuts; a printer without a blade ignores it. The feed above is what
     * makes the receipt tearable by hand on the ones that do ignore it, so both kinds end up with
     * something a customer can take.
     */
    GS, 0x56, 0x42, 0x00,
  ];

  const out = new Uint8Array(header.length + bitmap.length + tail.length);
  out.set(header, 0);
  out.set(bitmap, header.length);
  out.set(tail, header.length + bitmap.length);
  return out;
}

/** Enough ESC/POS to prove a printer is listening, without needing a sale. */
export function testTicket(shopName: string): Uint8Array {
  const text =
    `${shopName}\n` +
    'Printer test\n' +
    new Date().toLocaleString() +
    '\n\nIf you can read this, printing works.\n';
  const body = new TextEncoder().encode(text);
  const head = [ESC, 0x40, ESC, 0x61, 0x01, ESC, 0x45, 0x01];
  const tail = [ESC, 0x45, 0x00, 0x0a, 0x0a, 0x0a, GS, 0x56, 0x42, 0x00];
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}
