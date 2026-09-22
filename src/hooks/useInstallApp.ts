'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * PUTTING THIS ON THE PHONE, in as few taps as each platform allows — and saying so honestly.
 *
 * ANDROID / CHROME     the browser hands us the install itself (`beforeinstallprompt`), so it is ONE
 *                      tap. The event fires only when the site qualifies — HTTPS, a manifest with a
 *                      192 and a 512 icon, a service worker with a fetch handler — and it fires
 *                      once, so it is kept when it comes.
 * ANDROID, NO EVENT    the same browsers still install from their own menu. Rather than showing
 *                      nothing (which reads as "this cannot be installed"), we say where it is.
 * iOS / SAFARI         no API exists. Apple keeps installing inside the Share sheet, so the two
 *                      steps are the whole offer, and two is as short as Apple allows.
 * iOS / ANOTHER BROWSER Chrome, Firefox and Edge on iPhone CANNOT install — the Home Screen is
 *                      Safari's alone. The useful thing is to say so and help them get there.
 * ALREADY INSTALLED    nothing is offered. `display-mode: standalone` is how a launched app knows
 *                      it is one; iOS answers `navigator.standalone` instead.
 */

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallWay =
  | 'one-tap'
  | 'browser-menu'
  | 'ios-steps'
  | 'ios-needs-safari'
  | 'installed'
  | 'not-offered';

const isStandalone = () => {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS, which predates the standard and never adopted it.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
};

/** iPhone or iPad, including an iPad reporting itself as a Mac with a touch screen. */
const isIos = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
};

/** Another browser on iOS: it renders with WebKit but cannot reach Add to Home Screen. */
const isIosButNotSafari = () => isIos() && /CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(navigator.userAgent);

/** A phone or tablet, where a home-screen icon is the point. */
const isHandheld = () => {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPad|iPhone|iPod/.test(navigator.userAgent) || isIos();
};

export function useInstallApp() {
  const [event, setEvent] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [iosElsewhere, setIosElsewhere] = useState(false);
  const [handheld, setHandheld] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIos());
    setIosElsewhere(isIosButNotSafari());
    setHandheld(isHandheld());

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

  /**
   * Hand an iPhone over to Safari, which is the only browser there that can install.
   *
   * `x-safari-https:` is Apple's own scheme for opening a page in Safari from another app. It is
   * not a standard and a browser may ignore it, so whatever calls this must keep the address in
   * front of somebody as well — which is why `InstallApp` copies the link in the same breath.
   */
  const openInSafari = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.location.href = `x-safari-${window.location.origin}`;
  }, []);

  const way: InstallWay = installed
    ? 'installed'
    : event
      ? 'one-tap'
      : iosElsewhere
        ? 'ios-needs-safari'
        : ios
          ? 'ios-steps'
          : handheld
            ? 'browser-menu'
            : 'not-offered';

  return { way, install, openInSafari, installed };
}
