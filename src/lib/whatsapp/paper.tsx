import { ImageResponse } from 'next/og';
import { columnsAt, defaultLayout, receiptLines, type PrintedLine, type ReceiptLayout } from '@/lib/escpos-text';
import type { ReceiptImageInput } from '@/lib/share';

/**
 * A DOCUMENT AS A FILE, ON THE SERVER — a PDF or a picture for WhatsApp. Server only.
 *
 * Both are drawn from `receiptLines`, the same lines the printer is sent and the screen shows, so
 * what arrives in a chat is the paper the app prints. The app makes its files on a canvas, which a
 * server does not have: the PDF here is real text in a built-in font (small, and readable by a
 * phone), and the picture comes from Next's own image renderer, so nothing new has to be installed.
 */
function layoutFor(widthMm: number): ReceiptLayout {
  return defaultLayout(widthMm >= 76 ? 576 : 384);
}

/** The PDF's built-in font has no ₦ or curly quotes; the printer's flattening does most of this. */
function plain(text: string): string {
  return text
    .replace(/₦/g, 'N')
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
}

const escaped = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** One roll, cut into pages: a PDF page has a size limit and a phone reads pages better anyway. */
export function documentPdf(doc: ReceiptImageInput, widthMm = 80): Buffer {
  const layout = layoutFor(widthMm);
  const lines = receiptLines(doc, layout);
  const pt = 72 / 25.4;
  const pageW = widthMm * pt;
  const pad = 3 * pt;
  const paper = pageW - pad * 2;
  const RATIO = 0.6; // Courier's advance width, by definition

  const rows = lines.map((line: PrintedLine) => {
    const spans = line.spans.length > 0 ? line.spans : [{ size: 'ss' as const, text: ' ' }];
    const parts = spans.map((s) => {
      const cell = paper / columnsAt(s.size, layout);
      return { s, cell, font: cell / RATIO };
    });
    return { parts, h: parts.reduce((m, p) => Math.max(m, p.font), 0) * 1.25 };
  });

  const MAX_H = 780;
  const pages: (typeof rows)[] = [[]];
  let used = 0;
  for (const r of rows) {
    if (used + r.h > MAX_H - pad * 2) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1].push(r);
    used += r.h;
  }

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in below
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');

  const kids: number[] = [];
  for (const page of pages) {
    const height = Math.max(120, page.reduce((s, r) => s + r.h, 0) + pad * 2);
    let y = height - pad;
    const ops: string[] = [];
    for (const r of page) {
      y -= r.h;
      let x = pad;
      for (const p of r.parts) {
        const text = plain(p.s.text);
        if (text.trim()) {
          const f = p.s.size.startsWith('sl') ? 'F2' : 'F1';
          ops.push(`BT /${f} ${p.font.toFixed(2)} Tf ${x.toFixed(2)} ${(y + r.h * 0.2).toFixed(2)} Td (${escaped(text)}) Tj ET`);
        }
        x += text.length * p.cell;
      }
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW.toFixed(2)} ${height.toFixed(2)}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * The same paper as a picture. The renderer has no fixed-width font, so a line's two ends are set
 * apart by layout rather than by spaces, and the rule characters become real rules.
 */
export async function documentPng(doc: ReceiptImageInput, widthMm = 80): Promise<Buffer> {
  const layout = layoutFor(widthMm);
  const lines = receiptLines(doc, layout);
  const W = 720;
  const rows = lines.map((line) => {
    const text = line.spans.map((s) => s.text).join('');
    const big = line.spans.some((s) => s.size.endsWith('w'));
    const trimmed = text.trim();
    if (/^=+$/.test(trimmed)) return { kind: 'double' as const, h: 16 };
    if (/^-+$/.test(trimmed)) return { kind: 'single' as const, h: 14 };
    if (!trimmed) return { kind: 'gap' as const, h: 14 };
    const [left, ...rest] = text.split(/\s{3,}/).filter((p) => p.length > 0);
    const centred = /^\s{4,}/.test(text) && rest.length === 0;
    return { kind: 'text' as const, left, right: rest.join('   '), big, centred, indent: /^\s/.test(text) && !centred, h: big ? 46 : 34 };
  });
  const height = rows.reduce((s, r) => s + r.h, 0) + 40;

  const response = new ImageResponse(
    (
      <div style={{ display: 'flex', flexDirection: 'column', width: W, height, padding: 20, background: '#ffffff', color: '#000000' }}>
        {rows.map((r, i) => {
          if (r.kind === 'gap') return <div key={i} style={{ display: 'flex', height: r.h }} />;
          if (r.kind === 'double' || r.kind === 'single') {
            return (
              <div key={i} style={{ display: 'flex', height: r.h, alignItems: 'center' }}>
                <div
                  style={{
                    display: 'flex',
                    width: '100%',
                    height: r.kind === 'double' ? 5 : 1,
                    borderTop: '1px solid #000',
                    borderBottom: r.kind === 'double' ? '1px solid #000' : 'none',
                  }}
                />
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: r.centred ? 'center' : 'space-between',
                height: r.h,
                fontSize: r.big ? 32 : 24,
                fontWeight: r.big ? 700 : 400,
                paddingLeft: r.indent ? 20 : 0,
              }}
            >
              <span>{r.left}</span>
              {r.right ? <span>{r.right}</span> : null}
            </div>
          );
        })}
      </div>
    ),
    { width: W, height },
  );
  return Buffer.from(await response.arrayBuffer());
}
