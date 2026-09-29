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

/** PDF measures in points: 72 per inch, and 25.4mm per inch. */
const MM_TO_PT = 72 / 25.4;

/**
 * Latin-1 bytes for a PDF's structural text.
 *
 * Typed as `Uint8Array<ArrayBuffer>` rather than the default `ArrayBufferLike`, because `Blob`
 * only accepts views over a real `ArrayBuffer` — a `SharedArrayBuffer`-backed view is not a valid
 * BlobPart, and TypeScript is right to insist.
 */
function toBytes(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** One page: a JPEG and its pixel size, drawn edge to edge on a sheet of the given size. */
interface PdfPage {
  jpeg: Uint8Array<ArrayBuffer>;
  pxW: number;
  pxH: number;
  wPt: number;
  hPt: number;
}

/**
 * Assemble the PDF — one image per page.
 *
 * Objects are written in order and their byte offsets recorded, because the cross-reference table
 * at the end has to state exactly where each one starts. Getting an offset wrong produces a file
 * that some readers open and others reject, which is the worst kind of broken.
 *
 * Numbering: 1 catalog, 2 pages; then per page three objects — the page, its image, its content.
 */
function buildPdf(pages: PdfPage[]): Blob {
  const parts: (string | Uint8Array<ArrayBuffer>)[] = [];
  const offsets: number[] = [];
  let length = 0;

  const push = (chunk: string | Uint8Array<ArrayBuffer>) => {
    parts.push(chunk);
    length += chunk.length;
  };
  const startObject = () => {
    offsets.push(length);
  };

  push('%PDF-1.4\n');
  // A binary comment line, which tells naive tools the file is not plain text.
  push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]) as Uint8Array<ArrayBuffer>);

  const pageObj = (i: number) => 3 + i * 3;
  startObject();
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject();
  push(
    `2 0 obj\n<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] ` +
      `/Count ${pages.length} >>\nendobj\n`,
  );

  pages.forEach((pg, i) => {
    const n = pageObj(i);
    startObject();
    push(
      `${n} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pg.wPt.toFixed(2)} ${pg.hPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im${i} ${n + 1} 0 R >> >> /Contents ${n + 2} 0 R >>\nendobj\n`,
    );
    startObject();
    push(
      `${n + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`,
    );
    push(pg.jpeg);
    push('\nendstream\nendobj\n');
    // `cm` sets the transform; without it the image draws into a one-point square in the corner.
    const content = `q\n${pg.wPt.toFixed(2)} 0 0 ${pg.hPt.toFixed(2)} 0 0 cm\n/Im${i} Do\nQ\n`;
    startObject();
    push(`${n + 2} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  });

  const xrefAt = length;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const blobParts: BlobPart[] = parts.map((p) => (typeof p === 'string' ? toBytes(p) : p));
  return new Blob(blobParts, { type: 'application/pdf' });
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
  const jpeg = await jpegOf(canvas, quality);
  // Height follows the image's aspect ratio: a receipt is a continuous roll, not a fixed sheet.
  const wPt = widthMm * MM_TO_PT;
  return buildPdf([{ jpeg, pxW: canvas.width, pxH: canvas.height, wPt, hPt: (canvas.height / canvas.width) * wPt }]);
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
