'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Registers the service worker, which is what makes the app open at all on a dead signal.
 *
 * AFTER LOAD, not during it: registration competes with the first screen for the same connection,
 * and the first screen is what somebody is waiting for.
 *
 * NOT IN DEVELOPMENT. A cache in front of a dev server serves yesterday's module to a hot reload,
 * and the hours lost to that are not worth the fidelity — `next build && next start` exercises the
 * real thing when it needs exercising.
 */
export function ServiceWorker() {
  const pathname = usePathname();

  /*
   * Tell the worker where we are, so this page can be opened again with no signal.
   *
   * Only the first screen is ever fetched as a page; everything after it is a client-side move the
   * browser never asks the network for. Without this the till — the screen a shop lives on — was
   * the one screen that could not be reopened offline.
   */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then(() => {
      if (!cancelled) navigator.serviceWorker.controller?.postMessage({ type: 'warm', path: pathname });
    });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // An app that cannot cache still works; it just needs the network. Nothing to say here.
      });
    };

    if (document.readyState === 'complete') register();
    else {
      window.addEventListener('load', register);
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
