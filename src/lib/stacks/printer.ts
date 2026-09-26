'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { isIOS } from '@/lib/printing';
import { canShareFiles } from '@/lib/share';
import {
  canPrintOverBluetooth,
  choosePrinter as chooseBluetooth,
  chosenPrinterName as bluetoothName,
  printCanvas as printBluetooth,
  reconnectBluetooth,
} from '@/lib/bluetooth-print';
import {
  canPrintOverUsb,
  chooseUsbPrinter,
  printCanvasOverUsb,
  reconnectUsb,
  usbPrinterName,
} from '@/lib/usb-print';

/**
 * HOW THIS DEVICE PRINTS — the shop's setting, and the connection it stands for.
 *
 * Two halves that have to be kept apart, because only one of them can be saved:
 *
 *   THE CHOICE syncs. "This counter prints over Bluetooth to XP-58 on a 58mm roll." That lives on
 *   the shop (0175), so a replaced phone is set up in one tap, a shop can see what prints where
 *   without walking to each device, and the roll width travels with the printer rather than sitting
 *   in one browser's storage where a receipt laid out for 80mm gets silently cropped to 58mm.
 *
 *   THE HANDLE cannot. A browser grants permission for a device to an origin and hands back an
 *   object; there is no way to store that object. It is RE-ACQUIRED against the identity in the
 *   saved choice — and both `navigator.usb.getDevices()` and, in newer Chrome,
 *   `navigator.bluetooth.getDevices()` return already-permitted devices with no prompt at all. So
 *   after the first pairing the reconnect is invisible, which is the difference between a printer
 *   that works and a printer somebody has to set up every morning.
 *
 * WHICH DEVICE THIS IS: an id this browser generates once and keeps. Not a fingerprint — it names a
 * counter, not a person, and the shop gives it a word of its own ("Counter", "Ada's phone").
 */

export type PrinterKind = 'bluetooth' | 'usb' | 'ios_app' | 'browser';

export interface PrinterChoice {
  deviceId: string;
  deviceLabel: string | null;
  kind: PrinterKind;
  printerName: string | null;
  widthMm: number;
  usbVendorId: number | null;
  usbProductId: number | null;
  btDeviceId: string | null;
  updatedAt: string;
}

const DEVICE_KEY = 'sm.device-id';

/**
 * This browser's id for itself.
 *
 * Wrapped, because storage throws in a private window and comes back empty when site data is
 * cleared — and a printer setting is not worth a blank screen. A device with no durable id still
 * prints; it just has to be set up again, which is what a fresh browser is.
 */
export function deviceId(): string {
  try {
    const had = localStorage.getItem(DEVICE_KEY);
    if (had) return had;
    const made = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // Per-session, then. Better than refusing to work.
    return 'ephemeral';
  }
}

interface Row {
  device_id: string;
  device_label: string | null;
  kind: PrinterKind;
  printer_name: string | null;
  width_mm: string;
  usb_vendor_id: number | null;
  usb_product_id: number | null;
  bt_device_id: string | null;
  updated_at: string;
}

const toChoice = (r: Row): PrinterChoice => ({
  deviceId: r.device_id,
  deviceLabel: r.device_label,
  kind: r.kind,
  printerName: r.printer_name,
  widthMm: Number(r.width_mm) || 80,
  usbVendorId: r.usb_vendor_id,
  usbProductId: r.usb_product_id,
  btDeviceId: r.bt_device_id,
  updatedAt: r.updated_at,
});

export const PRINTERS_SCOPE = 'printers';

/** Every device the shop has set up. Settings shows the lot; a till only cares about its own. */
export function usePrinters(storeId: string | null) {
  const read = useCallback(async () => {
    if (!storeId) return [] as PrinterChoice[];
    const { data, error } = await getSupabase().rpc('my_printers', { p_store_id: storeId });
    if (error) throw error;
    return ((data ?? []) as Row[]).map(toChoice);
  }, [storeId]);

  return useResource<PrinterChoice[]>({
    key: `printers:${storeId ?? 'none'}`,
    scope: PRINTERS_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read,
  });
}

export async function savePrinter(
  storeId: string,
  choice: Omit<PrinterChoice, 'deviceId' | 'updatedAt'> & { deviceId?: string },
): Promise<void> {
  const { error } = await getSupabase().rpc('set_my_printer', {
    p_store_id: storeId,
    p_device_id: choice.deviceId ?? deviceId(),
    p_kind: choice.kind,
    p_device_label: choice.deviceLabel,
    p_printer_name: choice.printerName,
    p_width_mm: choice.widthMm,
    p_usb_vendor_id: choice.usbVendorId,
    p_usb_product_id: choice.usbProductId,
    p_bt_device_id: choice.btDeviceId,
  });
  if (error) throw error;
}

export async function forgetPrinter(storeId: string, forDeviceId?: string): Promise<void> {
  const { error } = await getSupabase().rpc('forget_my_printer', {
    p_store_id: storeId,
    p_device_id: forDeviceId ?? deviceId(),
  });
  if (error) throw error;
}

/** What this device can offer, asked of the browser rather than guessed from the user agent. */
export function availableKinds(): PrinterKind[] {
  const out: PrinterKind[] = [];
  if (canPrintOverUsb()) out.push('usb');
  if (canPrintOverBluetooth()) out.push('bluetooth');
  if (isIOS() && canShareFiles()) out.push('ios_app');
  out.push('browser');
  return out;
}

/**
 * THE PRINTER THIS DEVICE IS ACTUALLY HOLDING, and how it prints.
 *
 * Reads the shop's saved choice and quietly tries to re-acquire the handle behind it. `ready` is the
 * honest answer to "will one tap print this": false means the tap will have to ask something first,
 * and a screen should say so rather than looking identical and then opening a chooser.
 */
export function useThisPrinter(storeId: string | null, shopWidthMm?: number) {
  const printers = usePrinters(storeId);
  const mine = (printers.data ?? []).find((p) => p.deviceId === deviceId()) ?? null;

  const [live, setLive] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  /*
   * THE SILENT RECONNECT, once the saved choice has arrived.
   *
   * No prompt and no user gesture: both `getDevices()` calls only ever return devices this origin
   * was already permitted. If nothing comes back the shop is simply not near its printer, which is
   * not a failure and must not be reported as one — a seller who is told "printer error" every
   * morning stops reading the messages.
   */
  useEffect(() => {
    let alive = true;
    if (!mine) {
      setLive(null);
      return;
    }
    if (mine.kind !== 'usb' && mine.kind !== 'bluetooth') {
      setLive(null);
      return;
    }
    setReconnecting(true);
    void (async () => {
      const name =
        mine.kind === 'usb'
          ? await reconnectUsb({ vendorId: mine.usbVendorId, productId: mine.usbProductId })
          : await reconnectBluetooth(mine.btDeviceId);
      if (alive) {
        setLive(name);
        setReconnecting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mine?.kind, mine?.usbVendorId, mine?.usbProductId, mine?.btDeviceId]);

  const kind: PrinterKind = mine?.kind ?? (isIOS() && canShareFiles() ? 'ios_app' : 'browser');
  /*
   * THE ROLL: this device's own if it was given one, otherwise the SHOP's.
   *
   * The shop already has a paper width, because it describes the roll a shop buys and prints every
   * receipt at. A second width defaulting to 80 would have quietly overridden it on every device — a
   * shop on 58mm paper would have had its amounts cropped off the right-hand edge with nothing on
   * screen disagreeing. Per-device exists for the counter that genuinely has a different roll.
   */
  const widthMm = mine?.widthMm ?? shopWidthMm ?? 80;

  /*
   * A direct route is only READY when a handle is in hand. `ios_app` and `browser` are always ready:
   * neither holds a connection, so there is nothing to lose.
   */
  const ready =
    kind === 'usb' || kind === 'bluetooth'
      ? Boolean(live ?? (kind === 'usb' ? usbPrinterName() : bluetoothName()))
      : true;

  /** Print the receipt as drawn. Throws when a direct route has no printer, so a caller can fall back. */
  const print = useCallback(
    async (canvas: HTMLCanvasElement) => {
      if (kind === 'usb') return printCanvasOverUsb(canvas, widthMm);
      if (kind === 'bluetooth') return printBluetooth(canvas, widthMm);
      throw new Error('This device does not print directly.');
    },
    [kind, widthMm],
  );

  /** Ask for a printer and remember the choice against this device, on the shop. */
  const connect = useCallback(
    async (wanted: 'usb' | 'bluetooth', label?: string) => {
      if (!storeId) throw new Error('No shop is open.');
      if (wanted === 'usb') {
        const chosen = await chooseUsbPrinter();
        await savePrinter(storeId, {
          kind: 'usb',
          deviceLabel: label ?? mine?.deviceLabel ?? null,
          printerName: chosen.name,
          widthMm,
          usbVendorId: chosen.vendorId,
          usbProductId: chosen.productId,
          btDeviceId: null,
        });
        setLive(chosen.name);
      } else {
        const chosen = await chooseBluetooth();
        await savePrinter(storeId, {
          kind: 'bluetooth',
          deviceLabel: label ?? mine?.deviceLabel ?? null,
          printerName: chosen.name,
          widthMm,
          usbVendorId: null,
          usbProductId: null,
          btDeviceId: chosen.id,
        });
        setLive(chosen.name);
      }
      await printers.reload();
    },
    [storeId, widthMm, mine?.deviceLabel, printers],
  );

  return {
    choice: mine,
    kind,
    widthMm,
    ready,
    reconnecting,
    printerName: live ?? mine?.printerName ?? null,
    print,
    connect,
    loaded: printers.loaded,
    reload: printers.reload,
  };
}
