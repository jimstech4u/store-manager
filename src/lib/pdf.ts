'use client';

/**
 * A one-page PDF containing a receipt, built in the browser with no library.
 *
 * The fallback for when there is no printer — which at a Nigerian counter is most of the time.
 * `window.print()` offers "Save as PDF" on a desktop browser and frequently nothing at all on a
 * phone, so a shop with no thermal printer had no way to hand a customer anything durable. A PDF
 * can be sent on WhatsApp, kept, and printed later from anywhere.
 *
 * No dependency, for the same reason the PNG writer in scripts/ has none: a PDF that wraps a
 * single image is about eighty lines of structure, and the smallest capable library is over a
 * hundred kilobytes of JavaScript shipped to every phone that opens a receipt.
 *
 * The image is embedded as JPEG via `DCTDecode`. PDF understands JPEG natively, so the bytes go in
 * untouched — no re-compression, and no need for a deflate implementation. PNG would have meant
 * decoding to raw samples and re-deflating, for a file that is larger for a photograph-like page.
 */

import { buildPdfBytes, MM_TO_PT, rollPage, type PdfPage } from '@/lib/pdf-core';

/** The PDF's bytes as a file the browser can share or save. */
function buildPdf(pages: PdfPage[]): Blob {
  return new Blob([buildPdfBytes(pages)], { type: 'application/pdf' });
}

async function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not prepare the page');
  return new Uint8Array(await blob.arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

/**
 * A multi-page document — a report on A4 — from one canvas per page.
 *
 * Each page is the canvas it was drawn on, so the PDF is exactly the pages that were previewed.
 */
export async function pagesPdf(
  canvases: HTMLCanvasElement[],
  { widthMm = 210, heightMm = 297, quality = 0.9 }: { widthMm?: number; heightMm?: number; quality?: number } = {},
): Promise<Blob> {
  const pages: PdfPage[] = [];
  for (const c of canvases) {
    pages.push({
      jpeg: await jpegOf(c, quality),
      pxW: c.width,
      pxH: c.height,
      wPt: widthMm * MM_TO_PT,
      hPt: heightMm * MM_TO_PT,
    });
  }
  return buildPdf(pages);
}

/**
 * Turn a rendered receipt image into a shareable PDF.
 *
 * Takes the canvas the on-screen receipt is already rendered to, so the PDF is exactly what was
 * previewed — not a second rendering that could differ.
 */
export async function receiptPdf(
  canvas: HTMLCanvasElement,
  { widthMm = 80, quality = 0.92 }: { widthMm?: number; quality?: number } = {},
): Promise<Blob> {
  // Height follows the image's aspect ratio: a receipt is a continuous roll, not a fixed sheet.
  return buildPdf([rollPage(await jpegOf(canvas, quality), canvas.width, canvas.height, widthMm)]);
}

/**
 * Hand the PDF to the person.
 *
 * Share sheet where there is one — that is how a receipt reaches WhatsApp, which is where these
 * actually go — and a download otherwise. Returns what happened so the caller can say so rather
 * than leaving the seller wondering whether anything was saved.
 */
export async function sharePdf(
  blob: Blob,
  filename: string,
  title: string,
): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: 'application/pdf' });

  const nav = navigator as Navigator & {
    canShare?: (data: { files?: File[] }) => boolean;
    share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  };

  if (nav.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title });
      return 'shared';
    } catch {
      // Cancelled, or the platform refused. Fall through to a download rather than reporting a
      // failure — the person still wants the file.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
