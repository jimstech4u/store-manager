'use client';

import { rasterFromCanvas, dotsFor } from '@/lib/escpos';

/**
 * PRINTING OVER USB, which is the most reliable of the lot and the one nobody expects to work.
 *
 * WebUSB is in Chrome on Android and on the desktop. Two things make it better than Bluetooth where
 * it is available:
 *
 *   · `navigator.usb.getDevices()` hands back every device this origin was already permitted, with
 *     NO prompt and NO user gesture. So a counter that was set up once reconnects silently on every
 *     page load — which is what "seamless" actually means.
 *   · a cable does not go out of range, run out of battery, or get paired to somebody's phone.
 *
 * An Android phone reaches a USB printer through an OTG cable, which is how plenty of counters here
 * are already wired.
 */

/*
 * WEBUSB, TYPED HERE. TypeScript's DOM library does not describe it. This uses five calls, so the
 * five are written down rather than pulling in the whole API — and it doubles as a statement of what
 * a page is allowed to do with a printer.
 */
interface USBEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}
interface USBAlternateInterface {
  endpoints: USBEndpoint[];
  interfaceClass: number;
}
interface USBInterface {
  interfaceNumber: number;
  alternate: USBAlternateInterface;
  claimed: boolean;
}
interface USBConfiguration {
  interfaces: USBInterface[];
}
interface USBDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  opened: boolean;
  configuration: USBConfiguration | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<{ status: string }>;
}
interface USB {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(options: { filters: { classCode?: number; vendorId?: number }[] }): Promise<USBDevice>;
}

/** Printers announce themselves as USB class 7. It is the one filter worth applying. */
const PRINTER_CLASS = 0x07;

interface Claimed {
  device: USBDevice;
  interfaceNumber: number;
  endpoint: number;
}

let held: Claimed | null = null;

function usb(): USB | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { usb?: USB }).usb ?? null;
}

export function canPrintOverUsb(): boolean {
  return usb() !== null;
}

/**
 * Open the device and find the endpoint that takes bytes.
 *
 * A printer exposes a printer-class interface with one bulk OUT endpoint. Searched for rather than
 * assumed: interface 0 is the right answer on most printers and the wrong one on any device that
 * also presents a hub or a card reader, and claiming the wrong interface fails in a way that reads
 * like the printer being busy.
 */
async function claim(device: USBDevice): Promise<Claimed> {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);

  for (const iface of device.configuration?.interfaces ?? []) {
    const isPrinter = iface.alternate.interfaceClass === PRINTER_CLASS;
    const out = iface.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
    if (!isPrinter || !out) continue;
    if (!iface.claimed) await device.claimInterface(iface.interfaceNumber);
    return { device, interfaceNumber: iface.interfaceNumber, endpoint: out.endpointNumber };
  }
  throw new Error('That device is not offering a printer connection.');
}

/**
 * Reconnect to a printer this shop already permitted — silently.
 *
 * No prompt, no gesture, nothing on screen. Matched by vendor and product id when the shop's saved
 * setting names one; otherwise the first printer-class device, which is the right guess on a counter
 * with one printer plugged into it.
 */
export async function reconnectUsb(
  want?: { vendorId: number | null; productId: number | null },
): Promise<string | null> {
  const api = usb();
  if (!api) return null;
  try {
    const devices = await api.getDevices();
    const match =
      want?.vendorId != null
        ? devices.find((d) => d.vendorId === want.vendorId && (want.productId == null || d.productId === want.productId))
        : devices[0];
    if (!match) return null;
    held = await claim(match);
    return match.productName ?? match.manufacturerName ?? 'USB printer';
  } catch {
    // A device that was unplugged, or an interface something else has claimed. Not an error worth
    // showing: the shop simply has no USB printer right now.
    return null;
  }
}

/** Ask which printer. Needs a real tap, like every device chooser. */
export async function chooseUsbPrinter(): Promise<{
  name: string;
  vendorId: number;
  productId: number;
}> {
  const api = usb();
  if (!api) throw new Error('This browser cannot talk to a USB printer.');
  const device = await api.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
  held = await claim(device);
  return {
    name: device.productName ?? device.manufacturerName ?? 'USB printer',
    vendorId: device.vendorId,
    productId: device.productId,
  };
}

export function usbPrinterName(): string | null {
  return held ? (held.device.productName ?? 'USB printer') : null;
}

async function send(bytes: Uint8Array): Promise<void> {
  if (!held) throw new Error('No USB printer is connected.');
  /*
   * 4KB at a time. USB bulk transfers are happy with far more than BLE, and a receipt goes out in a
   * handful of writes — but a single transfer of a whole 80mm bitmap stalls on some printers whose
   * buffer is smaller than the image.
   */
  const CHUNK = 4096;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    await held.device.transferOut(held.endpoint, bytes.slice(at, at + CHUNK));
  }
}

/** The same canvas the shop shares and saves as a PDF. See escpos.ts for why it goes as a bitmap. */
export async function printCanvasOverUsb(canvas: HTMLCanvasElement, widthMm: number): Promise<void> {
  await send(rasterFromCanvas(canvas, dotsFor(widthMm)));
}

export async function printBytesOverUsb(bytes: Uint8Array): Promise<void> {
  await send(bytes);
}
