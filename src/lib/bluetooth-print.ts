'use client';

import { rasterFromCanvas, dotsFor } from '@/lib/escpos';

/**
 * PRINTING STRAIGHT TO A PAIRED THERMAL PRINTER, from the web page.
 *
 * Chrome on Android has Web Bluetooth, so this is real: one tap, no companion app, no extra
 * hardware, no share sheet. Safari and every browser on iOS have no Web Bluetooth at all, which is
 * why `printing.ts` exists and why iOS goes a different way.
 *
 * WHICH SERVICE. There is no standard for this. Cheap ESC/POS printers expose a serial-over-BLE
 * service and each family picked its own uuid, so the list below is the ones that actually turn up
 * on the printers shops here buy. `optionalServices` has to name every one of them up front:
 * Chrome will not let a page touch a service it did not ask for, and the error when it refuses
 * ("SecurityError: Origin is not allowed to access the service") reads like a permissions problem
 * rather than a missing declaration.
 */

/*
 * WEB BLUETOOTH, TYPED HERE RATHER THAN PULLED IN.
 *
 * TypeScript's DOM library does not describe Web Bluetooth — it is not a settled standard and Safari
 * has never implemented it. `@types/web-bluetooth` exists and would bring the whole API; this uses
 * five calls, so the five are written down instead. It is also documentation: what a page is allowed
 * to do with a printer is exactly this and no more.
 */
interface BluetoothCharacteristicProperties {
  write: boolean;
  writeWithoutResponse: boolean;
}

interface BluetoothRemoteGATTCharacteristic {
  properties: BluetoothCharacteristicProperties;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
}

interface BluetoothRemoteGATTService {
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  /**
   * Stable per origin, and the only handle on a device that can be WRITTEN DOWN.
   *
   * It is not the MAC address and is no use to anybody else — it is how this origin recognises a
   * device it was already granted. Saved with the shop's printer setting so the reconnect below can
   * pick the right one out when a counter has several Bluetooth things around it.
   */
  id: string;
  name?: string;
  gatt?: { connected: boolean; connect(): Promise<BluetoothRemoteGATTServer> };
}

interface Bluetooth {
  requestDevice(options: {
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }): Promise<BluetoothDevice>;
  /**
   * Devices this origin has ALREADY been permitted — no prompt, no user gesture.
   *
   * Newer Chrome only, and absent in older ones, so it is optional and the caller treats a miss as
   * "not near the printer" rather than an error.
   */
  getDevices?(): Promise<BluetoothDevice[]>;
}

/** Serial-over-BLE services seen on ESC/POS printers, commonest first. */
const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // the usual on Chinese ESC/POS modules
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 style modules
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Issc / BT-based Zebra, Munbyn
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

/**
 * How much goes out in one write.
 *
 * BLE negotiates an MTU and the page is never told what it is. 180 bytes is under the floor every
 * module honours; larger writes are quietly truncated on some of them, which prints the top of a
 * receipt and then stops — a failure that looks like the printer running out of paper.
 */
const CHUNK = 180;

interface Connected {
  device: BluetoothDevice;
  characteristic: BluetoothRemoteGATTCharacteristic;
}

/**
 * The printer this session is talking to.
 *
 * Kept in memory only. A `BluetoothDevice` cannot be serialised, and Chrome will not reconnect to
 * one without either a user gesture or the persistent-permissions flag — so a shop picks the printer
 * once per session and the pill it taps afterwards reuses this.
 */
let held: Connected | null = null;

export function canPrintOverBluetooth(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { bluetooth?: unknown }).bluetooth !== 'undefined'
  );
}

/** The name of the printer already chosen, for a screen that wants to say which. */
export function chosenPrinterName(): string | null {
  return held?.device.name ?? null;
}

/**
 * Find the characteristic that accepts bytes.
 *
 * Asked of the device rather than assumed, because the same service uuid carries different
 * characteristic layouts across modules: some expose one writable characteristic, some expose a
 * read/notify one beside it. Picking the first WRITABLE one is the only rule that holds.
 */
async function writableCharacteristic(
  server: BluetoothRemoteGATTServer,
): Promise<BluetoothRemoteGATTCharacteristic> {
  for (const uuid of PRINTER_SERVICES) {
    try {
      const service = await server.getPrimaryService(uuid);
      for (const c of await service.getCharacteristics()) {
        if (c.properties.write || c.properties.writeWithoutResponse) return c;
      }
    } catch {
      // Not this service. A printer advertises one of them, not all.
    }
  }
  throw new Error(
    'That device is not answering as a printer. If it prints from its own app, it may use a ' +
      'connection a web page cannot reach.',
  );
}

/**
 * Ask the shop which printer, and connect.
 *
 * MUST be called from a real tap. Chrome requires a user gesture for the chooser, and calling this
 * from an effect fails with a message about user activation that says nothing about printing.
 */
export async function choosePrinter(): Promise<{ name: string; id: string }> {
  if (!canPrintOverBluetooth()) {
    throw new Error('This browser cannot talk to a Bluetooth printer.');
  }
  const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth;

  /*
   * EVERY DEVICE, filtered by nothing.
   *
   * `filters` by service would be tidier and hides most printers: plenty advertise their name and
   * not their services, so a filtered chooser comes up empty and the shop concludes the printer is
   * broken. `acceptAllDevices` shows everything and the shop picks by the name on the label, which
   * is what they were going to do anyway.
   */
  const device = await bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: PRINTER_SERVICES,
  });

  const server = await device.gatt?.connect();
  if (!server) throw new Error('Could not connect to that printer.');
  const characteristic = await writableCharacteristic(server);

  /*
   * A printer that walks out of range must not look like one that is still there.
   *
   * Without this the held characteristic stays in memory, every write throws, and the seller is told
   * the print failed rather than that the printer is off.
   */
  device.addEventListener('gattserverdisconnected', () => {
    if (held?.device === device) held = null;
  });

  held = { device, characteristic };
  return { name: device.name ?? 'printer', id: device.id };
}


/**
 * RECONNECT WITHOUT ASKING, to a printer this shop already paired.
 *
 * `getDevices()` returns only what this origin was already granted, so there is nothing to consent
 * to and no gesture needed — which is what makes a counter print on the first tap of the morning
 * instead of after somebody walks through a chooser.
 *
 * Returns null for every ordinary miss: an older Chrome without `getDevices`, a printer switched
 * off, a phone that has walked away from it. None of those is an error to show. A seller told
 * "printer error" every morning stops reading the messages, and then misses the one that matters.
 */
export async function reconnectBluetooth(wantedId: string | null): Promise<string | null> {
  if (!canPrintOverBluetooth()) return null;
  const bluetooth = (navigator as Navigator & { bluetooth: Bluetooth }).bluetooth;
  if (typeof bluetooth.getDevices !== 'function') return null;
  try {
    const granted = await bluetooth.getDevices();
    const device = wantedId ? granted.find((d) => d.id === wantedId) : granted[0];
    if (!device) return null;

    const server = await device.gatt?.connect();
    if (!server) return null;
    const characteristic = await writableCharacteristic(server);
    device.addEventListener('gattserverdisconnected', () => {
      if (held?.device === device) held = null;
    });
    held = { device, characteristic };
    return device.name ?? 'printer';
  } catch {
    return null;
  }
}

/** Reconnect if the printer dropped, or ask for one if none was ever chosen. */
async function ready(): Promise<Connected> {
  if (held && held.device.gatt?.connected) return held;
  if (held) {
    const server = await held.device.gatt?.connect();
    if (server) {
      held = { device: held.device, characteristic: await writableCharacteristic(server) };
      return held;
    }
  }
  throw new Error('No printer is connected. Choose one first.');
}

async function send(bytes: Uint8Array): Promise<void> {
  const { characteristic } = await ready();
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const slice = bytes.slice(at, at + CHUNK);
    /*
     * `writeValueWithoutResponse` where the printer offers it: with-response waits for an
     * acknowledgement per chunk and an 80mm receipt is a few hundred chunks, which turns a
     * half-second print into ten.
     */
    if (characteristic.properties.writeWithoutResponse) {
      await characteristic.writeValueWithoutResponse(slice);
    } else {
      await characteristic.writeValue(slice);
    }
  }
}

/**
 * Print a rendered receipt. One tap, if a printer has been chosen.
 *
 * Takes the CANVAS, not a payload to lay out again — the same canvas the shop shares as a picture
 * and saves as a PDF, so the paper cannot say something different from the copy the customer was
 * sent. See escpos.ts for why it goes as a bitmap.
 */
export async function printCanvas(canvas: HTMLCanvasElement, widthMm: number): Promise<void> {
  await send(rasterFromCanvas(canvas, dotsFor(widthMm)));
}

export async function printBytes(bytes: Uint8Array): Promise<void> {
  await send(bytes);
}
