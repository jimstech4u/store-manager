'use client';

import { getSupabase } from '@/lib/supabase/client';
import { dotsFor } from '@/lib/escpos';

/**
 * PRINTING ON IOS, IN ONE TAP, WITHOUT A NATIVE APP OF OUR OWN.
 *
 * iOS has no Web Bluetooth, so the page cannot reach the printer itself — see `printing.ts`. What it
 * CAN do is hand the receipt to an app that can, through a custom URL scheme, and there is a
 * thermal-printing utility on the App Store built for exactly this: give it an image URL and it
 * fetches it and prints it over Bluetooth.
 *
 *     com.samathosoft.webprint://#imageurl#https://…/receipt.png#/imageurl#
 *
 * So the receipt is rendered here — the same canvas that goes to WhatsApp and the PDF — uploaded to
 * a public path, and the URL handed over. One tap, no App Store review of ours, no on-site computer,
 * and nothing about the receipt is laid out twice.
 *
 * WHAT THIS COSTS, said plainly because a shop should know: it depends on an app somebody else
 * maintains, installed and configured on the phone. If it is not installed the tap does nothing
 * visible, which is why `openInPrinterApp` reports back and the caller offers the share sheet
 * instead. And the receipt is briefly at a PUBLIC url — unguessable, and removed as soon as the
 * print is triggered, but public, which is why nothing is put in the path that names a customer.
 */

/** The scheme the utility registers. It also answers on `com.fidelier.printfromweb://`. */
const SCHEME = 'com.samathosoft.webprint://';

/**
 * THE RECEIPT AT THE PRINTER'S OWN WIDTH, before it is handed over.
 *
 * `renderReceiptCanvas` draws at 8 pixels per millimetre so the picture stays sharp on a phone —
 * 640px across for an 80mm roll. An 80mm PRINT HEAD is 576 dots. The Bluetooth and USB routes
 * already scale to fit because `rasterFromCanvas` does it; the hand-off to the printer app did not,
 * so it was posting an image wider than any of these printers can put on paper and leaving the app
 * to decide what to do about it. Some scale. Some crop the right-hand column, which on a receipt is
 * the amounts. Some refuse.
 *
 * Never scaled UP: a narrow receipt stays narrow rather than being stretched into a blur.
 */
async function atPaperWidth(canvas: HTMLCanvasElement, widthMm: number): Promise<Blob | null> {
  const dots = dotsFor(widthMm);
  if (canvas.width <= dots) return new Promise((r) => canvas.toBlob(r, 'image/png'));

  const fitted = document.createElement('canvas');
  fitted.width = dots;
  fitted.height = Math.round(canvas.height * (dots / canvas.width));
  const ctx = fitted.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(canvas, 0, 0, fitted.width, fitted.height);
  return new Promise((r) => fitted.toBlob(r, 'image/png'));
}

/** Draw, fit to the paper, and hand back a PNG the printer app can actually put on a roll. */
export async function receiptForPrinterApp(
  canvas: HTMLCanvasElement,
  widthMm: number,
): Promise<Blob | null> {
  return atPaperWidth(canvas, widthMm);
}

/**
 * Put the rendered receipt somewhere the printer app can fetch it, and hand over the link.
 *
 * The path carries a random name and nothing else — not the customer, not the amount. A public
 * object is a public object, and a shop's receipt urls should not be a list of who bought what.
 */
export async function uploadForPrinting(storeId: string, blob: Blob): Promise<string> {
  const supabase = getSupabase();
  const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const path = `${storeId}/print/${name}.png`;

  const { error } = await supabase.storage.from('media').upload(path, blob, {
    contentType: 'image/png',
    /*
     * NOT CACHED, and a short life.
     *
     * This is a one-shot handover, not an asset. A long cache on a path that gets deleted moments
     * later is how a printer app ends up printing a receipt from an hour ago out of a CDN.
     */
    cacheControl: '0',
    upsert: false,
  });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}

/** And take it away again once the printer app has had it. */
export async function removePrinted(url: string): Promise<void> {
  const marker = '/object/public/media/';
  const at = url.indexOf(marker);
  if (at < 0) return;
  try {
    await getSupabase().storage.from('media').remove([url.slice(at + marker.length)]);
  } catch {
    // A file left behind is untidy, not broken. Never worth failing a print over.
  }
}

/**
 * Hand the app a RAW instruction, whatever kind.
 *
 * `openInPrinterApp` below is the ordinary path — an image url. This exists because when the app
 * opens and then reports a problem, the useful question is WHICH part failed, and the only way to
 * find out on somebody else's phone is to try the parts separately:
 *
 *   · the vendor's own sample image  — if that fails, the app or the printer is the problem, not us
 *   · plain ESC/POS text             — no network fetch at all, so it isolates the download
 *   · our own image                  — the real path
 *
 * Guessing at this over messages costs a day; three buttons costs one tap each.
 */
export function openPrinterAppWith(instruction: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (went: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('visibilitychange', onHide);
      resolve(went);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') done(true);
    };
    document.addEventListener('visibilitychange', onHide);
    window.location.href = `${SCHEME}${instruction}`;
    setTimeout(() => done(false), 1500);
  });
}

/** The vendor's own sample. If this does not print, nothing of ours is at fault. */
export const VENDOR_SAMPLE = '#imageurl#https://www.mobileprintutil.com/atestreceipt.png#/imageurl#';

/**
 * Plain text, straight down the wire, with NO download for the app to do.
 *
 * Deliberately no ₦: the code pages these printers ship with are CP437 and friends and the naira
 * sign is in none of them, which is the whole reason a real receipt goes as a picture. For a test
 * that is a feature — it keeps the test to one variable.
 */
export function textTicket(shopName: string): string {
  const line = (t: string) => `#sl#${t}#lf#`;
  return (
    '#escps#' +
    line(shopName) +
    line('Printer app test') +
    line(new Date().toLocaleString()) +
    line('') +
    line('If you can read this, the app and') +
    line('the printer are talking to each other.')
  );
}

/**
 * Hand a URL to the printer app — the ordinary path.
 *
 * WHETHER IT WORKED CANNOT BE KNOWN DIRECTLY. iOS gives a page no way to ask whether a scheme is
 * registered, and no event when it is not. So this watches for the page being hidden — which is what
 * happens when iOS switches to the app — and calls it a miss if nothing happened within a second and
 * a half. A miss is not a failure to report: it means the app is not installed, and the caller falls
 * back to the share sheet, which always works.
 *
 * AND "IT OPENED" IS NOT "IT PRINTED". The app can open and then refuse, which it did on the first
 * real phone this met: "there is an issue with your device connection", while printing from inside
 * the app worked fine. Nothing here can see that, which is why Settings carries a diagnostic that
 * tries the parts one at a time.
 */
export function openInPrinterApp(imageUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (went: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('visibilitychange', onHide);
      resolve(went);
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') done(true);
    };
    document.addEventListener('visibilitychange', onHide);

    /*
     * `location.href`, not a hidden iframe.
     *
     * The iframe trick is the old workaround and Safari stopped honouring it for custom schemes.
     * Assigning `location.href` from a user gesture is what works; when the scheme is unhandled iOS
     * simply does nothing, which is the case the timeout below catches.
     */
    window.location.href = `${SCHEME}#imageurl#${imageUrl}#/imageurl#`;
    setTimeout(() => done(false), 1500);
  });
}
