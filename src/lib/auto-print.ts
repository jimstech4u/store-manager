'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * PRINT THE RECEIPT BY ITSELF AFTER A SALE — this device's choice, not the shop's.
 *
 * "after saving order we remember the last printer connected and print to it after the countdown
 * but can cancel within the time." A counter tablet beside its roll wants every sale printed; the
 * owner's phone wants none. So it is kept per DEVICE, like the printer itself, in this browser's
 * storage (a convenience — the shop loses nothing if it is cleared, the default comes back).
 *
 * THE DEFAULT is on, after 3 seconds, where printing is one step — a paired roll, or the printer app
 * on an iPhone. Where it would only open the browser's print window, it is off until somebody turns
 * it on: a dialog that springs up after every sale is in the way, not a help.
 */
export interface AutoPrintSetting {
  /** Undefined means nobody has chosen: the default for this device's way of printing applies. */
  on?: boolean;
  /** Seconds to wait, with a Cancel, before it prints. */
  wait: 0 | 3 | 5 | 10;
  /** After it has printed, go back to the till for the next customer. */
  thenTill: boolean;
}

const KEY = 'sm.auto-print';
const DEFAULTS: AutoPrintSetting = { wait: 3, thenTill: false };
const CHANGED = 'sm-auto-print-changed';

function read(): AutoPrintSetting {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const v = JSON.parse(raw) as Partial<AutoPrintSetting>;
    return {
      ...(typeof v.on === 'boolean' ? { on: v.on } : {}),
      wait: ([0, 3, 5, 10] as const).includes(v.wait as 0) ? (v.wait as AutoPrintSetting['wait']) : 3,
      thenTill: v.thenTill === true,
    };
  } catch {
    return DEFAULTS;
  }
}

/** This device's setting, kept in step across every screen showing it. */
export function useAutoPrint() {
  const [setting, setSetting] = useState<AutoPrintSetting>(DEFAULTS);
  useEffect(() => {
    setSetting(read());
    const sync = () => setSetting(read());
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const change = useCallback((patch: Partial<AutoPrintSetting>) => {
    const next = { ...read(), ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A private window: the choice lasts as long as this screen does.
    }
    setSetting(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return { setting, change };
}

/** Whether it prints by itself on a device that prints this way. */
export function autoPrintOn(setting: AutoPrintSetting, route: 'direct' | 'app' | 'browser'): boolean {
  return setting.on ?? route !== 'browser';
}
