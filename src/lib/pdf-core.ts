/**
 * A PDF that wraps one image per page — the structure only, with no browser in it, so the app's
 * "Save as PDF" (`pdf.ts`) and the agent's PDF on WhatsApp are the same file around the same picture.
 */

/** PDF measures in points: 72 per inch, and 25.4mm per inch. */
export const MM_TO_PT = 72 / 25.4;

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
export interface PdfPage {
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
export function buildPdfBytes(pages: PdfPage[]): Uint8Array<ArrayBuffer> {
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

  // One run of bytes, so the browser can wrap it in a Blob and the server can send it as it is.
  const out = new Uint8Array(new ArrayBuffer(length));
  let at = 0;
  for (const part of parts) {
    const bytes = typeof part === 'string' ? toBytes(part) : part;
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** A receipt is a continuous roll, not a sheet: its page is as tall as the picture is, at the roll's width. */
export function rollPage(jpeg: Uint8Array<ArrayBuffer>, pxW: number, pxH: number, widthMm: number): PdfPage {
  const wPt = widthMm * MM_TO_PT;
  return { jpeg, pxW, pxH, wPt, hPt: (pxH / pxW) * wPt };
}
