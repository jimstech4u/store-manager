'use client';
import type { ReceiptLayout } from '@/lib/escpos-text';
import { drawDocument, paperImageUrls, type MakeCanvas, type PaperImages } from '@/lib/paper-canvas';

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
  /**
   * THE SHOP'S LOGO, at the head of the paper (`paper-logo.ts`): where the picture is and how much
   * of the roll's width it takes. Set wherever the header is — the shop's letterhead is both.
   */
  logo?: PaperLogo | null;
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

export interface PaperLogo {
  url: string;
  /** Of the paper's printable width, 10–100. */
  widthPct: number;
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
 * Draw the receipt and hand back the CANVAS — the browser's, drawn by the one drawing everything
 * shares (`paper-canvas.ts`).
 *
 * Split out from `renderReceiptImage` so the PDF writer can embed exactly these pixels rather than
 * decoding a PNG and re-encoding it. Two renderings of the same receipt could differ; one cannot.
 */
export async function renderReceiptCanvas(
  input: ReceiptImageInput,
  widthMm = 80,
  layout?: ReceiptLayout,
): Promise<HTMLCanvasElement | null> {
  if (typeof document === 'undefined') return null;
  const browser: MakeCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const images: PaperImages = new Map();
  for (const url of paperImageUrls(input)) {
    const img = await loadImage(url);
    if (img) images.set(url, img);
  }
  return drawDocument(input, widthMm, browser, layout, undefined, images) as HTMLCanvasElement | null;
}

const loading = new Map<string, Promise<HTMLImageElement | null>>();

/**
 * A picture for the paper, loaded once per address. CORS-clean (`anonymous`), or the canvas it is
 * drawn on could not be read back for the PNG, the PDF or the printer. One that does not load is
 * left off: a receipt without its logo still prints, a receipt that fails does not.
 */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = loading.get(url);
  if (!p) {
    p = new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => {
        loading.delete(url);
        resolve(null);
      };
      img.src = url;
    });
    loading.set(url, p);
  }
  return p;
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
