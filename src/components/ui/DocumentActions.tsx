'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { ShareIcon, WhatsAppIcon } from '@/components/ui/Icon';
import { useResource } from '@/lib/stacks/resource';
import { useThisPrinter } from '@/lib/stacks/printer';
import { getSupabase } from '@/lib/supabase/client';
import { renderReceiptCanvas, renderReceiptImage, shareImage, type ReceiptImageInput } from '@/lib/share';
import { receiptLines } from '@/lib/escpos-text';
import { pagesPdf, receiptPdf, sharePdf } from '@/lib/pdf';
import { printDocument, printRouteOf } from '@/lib/print-document';
import { messageOf } from '@/lib/format';
import styles from './DocumentActions.module.css';

/** The shop's roll width, as the receipt reads it. */
export function usePrintWidth(storeId: string | null): number {
  const r = useResource<number>({
    key: `print-width:${storeId ?? 'none'}`,
    scope: 'store_settings',
    enabled: Boolean(storeId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('ensure_store_settings', { p_store_id: storeId });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as { printer_width_mm: string } | null;
      return Number(row?.printer_width_mm ?? 80) || 80;
    },
  });
  return r.data ?? 80;
}

/**
 * EVERYTHING A RECEIPT CAN DO, FOR ANY DOCUMENT — share, send on WhatsApp, send as a picture,
 * print, save as PDF.
 *
 * "the payment receipt page and other pages that share or export should have what the receipt page
 * had: share, share on WhatsApp, print, and all — and this is supposed to be everywhere ... also
 * share as image, basically how the receipt is shared."
 *
 * One component, so every document offers the same five things in the same order and they behave
 * alike: a payment receipt, the items on an open order, an exported report. It takes the document
 * as roll lines (`doc`) — the shape the receipt printer, the picture and the roll PDF already
 * understand — and, for a report, its A4 pages too.
 *
 * PRINTING GOES WHERE THE SHOP PRINTS. A paired roll printer (Bluetooth or USB) or the iPhone
 * printer app gets the roll; anything else is the browser's print, which prints the page's
 * `data-print-root` — on A4 when `a4Print` is set.
 */
export function DocumentActions({
  storeId,
  doc,
  filename,
  title,
  message,
  link,
  whatsapp,
  pages,
  a4Print = false,
}: {
  storeId: string;
  doc: ReceiptImageInput;
  /** Without an extension: "payment-busayo-2026-09-29". */
  filename: string;
  title: string;
  /** The words for Share and WhatsApp. */
  message: string;
  /** A link to send with the words (a receipt's), made when it is needed. */
  link?: () => Promise<string | null>;
  /** Who WhatsApp goes to by default; the next screen lets it be changed. */
  whatsapp?: { phone?: string | null; customerId?: string | null; customerName?: string | null };
  /** A4 pages, for a report: the PDF is these instead of the roll. */
  pages?: () => HTMLCanvasElement[];
  /** The browser's print uses A4 (the page shows a `data-print-root="page"` table). */
  a4Print?: boolean;
}) {
  const nav = useNav();
  const width = usePrintWidth(storeId);
  const printer = useThisPrinter(storeId, width);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (what: string, fn: () => Promise<string | null | void>) => {
    setBusy(what);
    setNote(null);
    try {
      const said = await fn();
      if (said) setNote(said);
    } catch (e) {
      setNote(messageOf(e, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const words = async () => {
    const url = link ? await link() : null;
    return { url, text: url ? `${message}\n${url}` : message };
  };

  const printA4 = () => {
    const root = document.documentElement;
    root.style.setProperty('--print-size', 'A4 portrait');
    root.style.setProperty('--print-margin', '12mm');
    const restore = () => {
      root.style.removeProperty('--print-size');
      root.style.removeProperty('--print-margin');
    };
    window.addEventListener('afterprint', restore, { once: true });
    try {
      window.print();
    } finally {
      setTimeout(restore, 1500);
    }
  };

  return (
    <div className={styles.wrap} data-print-no-print>
      <div className={styles.actions}>
        <Button
          fullWidth
          busy={busy === 'share'}
          busyLabel="Preparing"
          onClick={() =>
            run('share', async () => {
              const { url, text } = await words();
              if (typeof navigator.share === 'function') {
                try {
                  await navigator.share({ title, text: url ? message : text, ...(url ? { url } : {}) });
                  return null;
                } catch (e) {
                  if (e instanceof Error && e.name === 'AbortError') return null;
                }
              }
              await navigator.clipboard.writeText(text);
              return 'Copied. Paste it into a chat.';
            })
          }
        >
          <ShareIcon /> Share
        </Button>

        <Button
          variant="secondary"
          fullWidth
          busy={busy === 'whatsapp'}
          busyLabel="Preparing"
          onClick={() =>
            run('whatsapp', async () => {
              const { text } = await words();
              void nav.push('share_whatsapp_page', {
                message: text,
                phone: whatsapp?.phone ?? '',
                customerId: whatsapp?.customerId ?? '',
                customerName: whatsapp?.customerName ?? '',
              });
            })
          }
        >
          <WhatsAppIcon /> Send on WhatsApp
        </Button>

        <Button
          variant="secondary"
          fullWidth
          busy={busy === 'picture'}
          busyLabel="Preparing"
          onClick={() =>
            run('picture', async () => {
              // A picture previews in a chat, where a link is text somebody has to decide to tap.
              const blob = await renderReceiptImage(doc, width);
              if (!blob) throw new Error('Could not draw the picture');
              const how = await shareImage(blob, `${filename}.png`, title);
              return how === 'downloaded' ? 'Saved to your downloads.' : null;
            })
          }
        >
          Send as picture
        </Button>

        <Button
          variant="secondary"
          fullWidth
          busy={busy === 'print'}
          busyLabel="Printing"
          onClick={() =>
            run('print', async () => {
              if (printRouteOf(printer) === 'browser') {
                if (a4Print) printA4();
                else window.print();
                return null;
              }
              return printDocument({
                printer,
                input: doc,
                lines: receiptLines(doc, printer.layout),
                widthMm: width,
                filename: `${filename}.png`,
                title,
              });
            })
          }
        >
          Print
        </Button>

        <Button
          variant="secondary"
          fullWidth
          busy={busy === 'pdf'}
          busyLabel="Preparing"
          onClick={() =>
            run('pdf', async () => {
              let pdf: Blob;
              if (pages) {
                const sheets = pages();
                if (sheets.length === 0) throw new Error('Could not draw the pages');
                pdf = await pagesPdf(sheets);
              } else {
                const canvas = await renderReceiptCanvas(doc, width);
                if (!canvas) throw new Error('Could not draw it');
                pdf = await receiptPdf(canvas, { widthMm: width });
              }
              const how = await sharePdf(pdf, `${filename}.pdf`, title);
              return how === 'downloaded' ? 'PDF saved to your downloads.' : null;
            })
          }
        >
          Save as PDF
        </Button>
      </div>

      {printRouteOf(printer) === 'direct' && (
        <p className={styles.note}>Printing straight to {printer.printerName}.</p>
      )}
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </div>
  );
}
