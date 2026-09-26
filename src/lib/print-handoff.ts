'use client';

import { getSupabase } from '@/lib/supabase/client';

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
 * Hand a URL to the printer app.
 *
 * WHETHER IT WORKED CANNOT BE KNOWN DIRECTLY. iOS gives a page no way to ask whether a scheme is
 * registered, and no event when it is not. So this watches for the page being hidden — which is what
 * happens when iOS switches to the app — and calls it a miss if nothing happened within a second and
 * a half. A miss is not a failure to report: it means the app is not installed, and the caller falls
 * back to the share sheet, which always works.
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
