'use client';

import { renderReceiptCanvas, renderReceiptImage, shareImage, type ReceiptImageInput } from '@/lib/share';
import { asInstruction, type PrintedLine } from '@/lib/escpos-text';
import { openPrinterAppWith } from '@/lib/print-handoff';
import type { useThisPrinter } from '@/lib/stacks/printer';

type Printer = ReturnType<typeof useThisPrinter>;

/**
 * Which way THIS device reaches a printer — the receipt's rule, for any document on a roll.
 *
 *   direct   a paired roll over Bluetooth or USB, ready now
 *   app      iOS: handed to the printer's own app by URL scheme
 *   browser  anything else: the browser's own print, which prints `data-print-root`
 */
export type PrintRoute = 'direct' | 'app' | 'browser';

export function printRouteOf(printer: Printer): PrintRoute {
  return (printer.kind === 'usb' || printer.kind === 'bluetooth') && printer.ready
    ? 'direct'
    : printer.kind === 'ios_app'
      ? 'app'
      : 'browser';
}

/**
 * Print one document the way the receipt prints — see Receipt.tsx for why each route is what it is.
 *
 * Returns a sentence for the screen when there is something to say ("Sent to the printer."), or
 * null when there is not. Throws when the document could not be drawn at all.
 */
export async function printDocument({
  printer,
  input,
  lines,
  widthMm,
  filename,
  title,
}: {
  printer: Printer;
  input: ReceiptImageInput;
  /** Exactly the lines on screen — `receiptLines(input, printer.layout)`. */
  lines: PrintedLine[];
  widthMm: number;
  filename: string;
  title: string;
}): Promise<string | null> {
  const route = printRouteOf(printer);

  if (route === 'browser') {
    window.print();
    return null;
  }

  if (route === 'direct') {
    const canvas = await renderReceiptCanvas(input, widthMm);
    if (!canvas) throw new Error('Could not draw it');
    await printer.print(canvas);
    return 'Sent to the printer.';
  }

  // iOS: the printer's own letters, as ESC/POS text; the share sheet when no app answers.
  if (await openPrinterAppWith(asInstruction(lines))) return null;
  const blob = await renderReceiptImage(input, widthMm);
  if (!blob) throw new Error('Could not draw it');
  const result = await shareImage(blob, filename, title);
  return result === 'downloaded'
    ? 'Saved to your downloads — open it to print.'
    : 'No printer app answered. Pick your printer’s own app in the share sheet.';
}
