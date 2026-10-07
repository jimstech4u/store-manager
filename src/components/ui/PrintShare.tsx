'use client';

import { useCallback, useEffect, useId, useRef } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { Button } from '@/components/ui/Button';
import { PrinterIcon } from '@/components/ui/Icon';
import type { ReceiptImageInput } from '@/lib/share';

/**
 * "PRINT OR SHARE", FOR ANY LIST THE SHOP KEEPS — and to the printer the receipt goes to.
 *
 * "In the bank account page we should have actions to print as well (even to the printer on
 * Bluetooth, like the receipt); and we should be able to print histories, statements and reports to
 * the printer just like a receipt, not only PDF or CSV, and share as well, even with prices."
 *
 * A page says what its document is (`PrintSpec`: a title and a `build` that reads EVERYTHING, not
 * just the rows scrolled to) and `usePrintShare().open(spec)` pushes `print_page`, which shows it as
 * it comes out on the roll and offers what a receipt offers — Share, WhatsApp, a picture, Print (the
 * paired Bluetooth/USB printer, or the browser's) and PDF — through the one `DocumentActions`.
 *
 * A PAGE, NOT A PANEL. The lists keep their filters pinned at the top; a paper copy opened there
 * would be pinned over the list. The push carries a CHANNEL, not the document: the builder is
 * published on it (`provideObject`), the way the period picker hands back its answer.
 */
export interface PrintSpec {
  title: string;
  /** Without an extension. */
  filename: string;
  /** The words for Share and WhatsApp; the document itself goes as a picture, PDF or on paper. */
  message?: string;
  whatsapp?: { phone?: string | null; customerId?: string | null; customerName?: string | null };
  build: () => Promise<ReceiptImageInput> | ReceiptImageInput;
}

export const PRINT_SCOPE = 'print';

export function usePrintShare() {
  const nav = useNav();
  const channel = `print:${useId()}`;
  const spec = useRef<PrintSpec | null>(null);

  useEffect(
    () => nav.provideObject(channel, () => spec.current, { global: true, scope: PRINT_SCOPE }),
    [nav, channel],
  );

  return useCallback(
    (next: PrintSpec) => {
      spec.current = next;
      void nav.push('print_page', { then: channel });
    },
    [nav, channel],
  );
}

/** The button itself, for a page with nowhere better to put it. */
export function PrintShareButton({
  spec,
  label = 'Print or share',
  size,
}: {
  spec: () => PrintSpec;
  label?: string;
  size?: 'small';
}) {
  const open = usePrintShare();
  return (
    <Button variant="secondary" fullWidth={size !== 'small'} size={size} onClick={() => open(spec())}>
      <PrinterIcon /> {label}
    </Button>
  );
}

/**
 * Rows of a list as roll lines: a name, what it was, and an amount. Every list prints in this one
 * shape — its title large across the top, as All items says NOT A RECEIPT.
 */
export function listDocument({
  shopName,
  title,
  meta = [],
  rows,
  totals = [],
  note,
  transferDetails,
}: {
  shopName: string;
  title: string;
  meta?: string[];
  rows: { name: string; detail?: string; amount?: string }[];
  totals?: { label: string; value: string; strong?: boolean }[];
  note?: string | null;
  transferDetails?: string | null;
}): ReceiptImageInput {
  return {
    shopName,
    banner: title.toUpperCase(),
    header: null,
    footer: null,
    meta,
    lines: rows.map((r) => ({ name: r.name, detail: r.detail ?? '', amount: r.amount ?? '' })),
    totals,
    note: note ?? null,
    transferDetails: transferDetails ?? null,
  };
}
