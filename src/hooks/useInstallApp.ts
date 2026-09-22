'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * PUTTING THIS ON THE PHONE, in as few taps as the platform allows.
 *
 * ANDROID / CHROME  the browser hands us the install itself (`beforeinstallprompt`), so it is ONE
 *                   tap: our button calls it and the system sheet appears. The event fires once and
 *                   must be kept — asking for it later is not possible.
 * iOS / SAFARI      there is no such event and no API. Apple keeps installing behind Share → Add to
 *                   Home Screen, so the honest thing is to say those two steps and nothing more.
 * ALREADY INSTALLED nothing is offered. `display-mode: standalone` is how a launched app knows it
 *                   is one; iOS answers `navigator.standalone` instead.
 *
 * `installed` flips as soon as the browser says so, so the button can thank somebody rather than
 * sitting there inviting them to do what they have just done.
 */

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallWay = 'one-tap' | 'ios-steps' | 'installed' | 'not-offered';

const isStandalone = () => {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS, which predates the standard and never adopted it.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
};

const isIosSafari = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  // Chrome and Firefox on iOS cannot install at all — only Safari's own Share sheet can.
  return iOS && !/CriOS|FxiOS|EdgiOS/.test(ua);
};

export function useInstallApp() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIosSafari());

    const held = (e: Event) => {
      // Chrome shows its own bar otherwise, at its own moment; the app asks when the shop asks.
      e.preventDefault();
      setEvent(e as InstallEvent);
    };
    const done = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener('beforeinstallprompt', held);
    window.addEventListener('appinstalled', done);
    return () => {
      window.removeEventListener('beforeinstallprompt', held);
      window.removeEventListener('appinstalled', done);
    };
  }, []);

  /** Ask the system to install. Resolves true when the shop went through with it. */
  const install = useCallback(async () => {
    if (!event) return false;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // Spent: the browser will not let the same event be used twice.
    setEvent(null);
    return outcome === 'accepted';
  }, [event]);

  const way: InstallWay = installed
    ? 'installed'
    : event
      ? 'one-tap'
      : ios
        ? 'ios-steps'
        : 'not-offered';

  return { way, install, installed };
}
