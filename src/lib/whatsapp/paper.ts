import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { defaultLayout, type ReceiptLayout } from '@/lib/escpos-text';
import { drawDocument, type MakeCanvas, type PaperCanvas } from '@/lib/paper-canvas';
import { buildPdfBytes, rollPage } from '@/lib/pdf-core';
import type { ReceiptImageInput } from '@/lib/share';

/**
 * THE APP'S OWN PAPER, ON THE SERVER. Server only.
 *
 * The picture and the PDF the agent sends are drawn by the app's drawing (`paper-canvas.ts`) on a
 * server canvas with the same API, and the PDF is the app's PDF around that picture (`pdf-core.ts`).
 * So a receipt sent on WhatsApp is the receipt "Send as picture" and "Save as PDF" give in the app.
 * The font is bundled, because a server has none of a phone's.
 */

const FONT = 'StoreMono';
let registered = false;
function font(): string {
  if (!registered) {
    /*
     * THE BOLD FACE ONLY. The app asks for medium (500) and semibold (600) and a phone draws both
     * heavy, which is how its paper looks; this font has only regular and bold, so medium came out
     * light beside it and the agent's receipt looked a different document again.
     */
    const dir = path.join(process.cwd(), 'node_modules', 'dejavu-fonts-ttf', 'ttf');
    GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSansMono-Bold.ttf'), FONT);
    registered = true;
  }
  return FONT;
}

/** The roll the app draws when no printer is set up: 576 dots on 80mm, 384 on 58mm. */
function layoutFor(widthMm: number): ReceiptLayout {
  return defaultLayout(widthMm >= 76 ? 576 : 384);
}

const server: MakeCanvas = (w, h) => createCanvas(w, h) as unknown as PaperCanvas;
type Encodable = { encode(format: 'png'): Promise<Buffer>; encode(format: 'jpeg', quality: number): Promise<Buffer> };

function draw(doc: ReceiptImageInput, widthMm: number) {
  const canvas = drawDocument(doc, widthMm, server, layoutFor(widthMm), font());
  if (!canvas) throw new Error('The paper could not be drawn.');
  return canvas as unknown as PaperCanvas & Encodable;
}

export async function documentPng(doc: ReceiptImageInput, widthMm = 80): Promise<Buffer> {
  return draw(doc, widthMm).encode('png');
}

export async function documentPdf(doc: ReceiptImageInput, widthMm = 80): Promise<Buffer> {
  const canvas = draw(doc, widthMm);
  // The app's quality for a receipt PDF (`receiptPdf`).
  const jpeg = new Uint8Array(await canvas.encode('jpeg', 92)) as Uint8Array<ArrayBuffer>;
  return Buffer.from(buildPdfBytes([rollPage(jpeg, canvas.width, canvas.height, widthMm)]));
}
