'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';

/**
 * Registers the service worker — what makes the app open at all on a dead signal — and tells the
 * shop when a newer version of the app is sitting there waiting.
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
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [asked, setAsked] = useState(false);
  const reloading = useRef(false);
  const updateDialog = useConfirm();

  const enabled =
    process.env.NODE_ENV === 'production' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator;

  /*
   * Tell the worker where we are, so this page can be opened again with no signal.
   *
   * Only the first screen is ever fetched as a page; everything after it is a client-side move the
   * browser never asks the network for. Without this the till — the screen a shop lives on — was
   * the one screen that could not be reopened offline.
   */
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void navigator.serviceWorker.ready.then(() => {
      if (!cancelled) navigator.serviceWorker.controller?.postMessage({ type: 'warm', path: pathname });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, pathname]);

  useEffect(() => {
    if (!enabled) return;
    let registration: ServiceWorkerRegistration | null = null;

    /** A new version has finished downloading and is waiting for us to say when. */
    const ready = (worker: ServiceWorker | null) => {
      // Only when something is ALREADY running: on a first visit there is no "new" version, just
      // the app arriving.
      if (worker && navigator.serviceWorker.controller) setWaiting(worker);
    };

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register('/sw.js');
      } catch {
        // An app that cannot cache still works; it just needs the network. Nothing to say here.
        return;
      }
      ready(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') ready(installing);
        });
      });
    };

    /*
     * Look for a new version when the shop comes back to the app, not on a timer.
     *
     * The browser checks by itself on launch and about once a day; a shop that leaves this open on
     * a counter for a week would otherwise never be asked. Returning to the app is the moment they
     * are not in the middle of anything.
     */
    const lookAgain = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
    };

    if (document.readyState === 'complete') void register();
    else window.addEventListener('load', register);
    document.addEventListener('visibilitychange', lookAgain);

    /*
     * The new worker has taken over: the page must be reloaded to be running the version it now
     * serves. Guarded, because a controller change also happens when a worker claims a page that
     * was loaded without one, and reloading then would be a loop.
     */
    const onControllerChange = () => {
      if (!reloading.current) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      window.removeEventListener('load', register);
      document.removeEventListener('visibilitychange', lookAgain);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, [enabled]);

  const relaunch = useCallback(() => {
    if (!waiting) return;
    reloading.current = true;
    waiting.postMessage({ type: 'skip-waiting' });
  }, [waiting]);

  /*
   * ASKED, NEVER IMPOSED.
   *
   * This is a till. Reloading somebody mid-sale to deliver an improvement is the app putting itself
   * first: the draft would survive (it is kept on the device) but the moment in front of a customer
   * would not. "Not now" is a real answer — the version waits, and the next launch takes it.
   */
  if (!waiting || asked) return null;

  return (
    <ConfirmDialog
      controller={updateDialog}
      title="A new version is ready"
      message="It takes a moment and puts you back where you are. Anything you have typed is kept."
      confirmText="Update now"
      cancelText="Not now"
      tone="primary"
      onDismiss={() => setAsked(true)}
      onConfirm={relaunch}
    />
  );
}
