'use client';

/**
 * HOW A RECEIPT ACTUALLY REACHES A PRINTER, PER DEVICE.
 *
 * A shop reported that it could not print from the app on an iPhone: the printer is an 80mm
 * thermal roll paired over Bluetooth, it prints perfectly from its own app, and Store Manager's
 * Print button produced "No AirPrint printers found".
 *
 * That is not a fault to fix so much as a fact to work around, and it is worth writing down
 * because it will be asked again:
 *
 *   · `window.print()` on iOS hands the page to AirPrint. AirPrint reaches printers over Wi-Fi or
 *     a wired network. It does not reach an ordinary Bluetooth thermal printer and never has.
 *
 *   · A web page cannot open the Bluetooth printer itself. Web Bluetooth does not exist in Safari
 *     or in any iOS browser — they are all Safari underneath — so there is no API for a PWA to
 *     send ESC/POS bytes to a paired printer. This is Apple's decision, not a gap in this app.
 *
 *   · WHAT DOES WORK, TODAY: the printer's own iOS app. Every one of these printers ships with
 *     one, and they accept an image or a PDF through the system share sheet. So the app renders
 *     the receipt at the roll's exact width and hands it over — the same picture it already makes
 *     for WhatsApp.
 *
 * Android is unaffected: Chrome prints to a paired thermal printer through the system print
 * service, so `window.print()` is right there and is left alone.
 *
 * A native companion app could bridge Bluetooth properly. That is a separate piece of work, and
 * nothing here pretends otherwise — what this does is stop the app sending an iPhone down a road
 * that has no printer at the end of it.
 */

/**
 * An iPhone or iPad, including an iPad reporting itself as a Mac.
 *
 * iPadOS 13 onward says "Macintosh" in its user agent, so the touch check is what tells a real Mac
 * (which can AirPrint happily, and where none of this applies) from an iPad that cannot.
 */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return ua.includes('Macintosh') && navigator.maxTouchPoints > 1;
}
