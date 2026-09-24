'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ConfirmDialog, useConfirm } from '@/components/ui/Dialog';
import { useRemindAfterMinutes } from '@/hooks/useRemindAfterMinutes';

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

/** Where a postponed version is remembered, so "not now" survives a reload. */
const HUSH_PREFIX = 'sw-hush:';

/**
 * HOW LONG AFTER OPENING AN UPDATE COUNTS AS "ALREADY THERE".
 *
 * Relaunching is when the browser checks for a new worker, so a shop that opens the app after iOS
 * has thrown it out of memory is told about an update within a second or two of the app appearing —
 * before they have done anything at all. Being interrupted to be asked about a version you have not
 * had time to need is noise, and it trains people to dismiss the one dialog that matters.
 *
 * Inside this window the new version is left alone. It is ALREADY DOWNLOADED and waiting, and a
 * waiting worker takes over by itself once every page using the old one has gone — which is what
 * closing the app does. So the update arrives on the next launch, silently, which is how an app is
 * supposed to update.
 *
 * Nothing is skipped and nothing is reloaded here: forcing the new worker to activate under a page
 * still running the old bundle would leave that page asking a purged cache for its lazy chunks.
 */
const STARTUP_GRACE_MS = 20_000;

/** When this page started. Module scope: one page, one start. */
const startedAt = Date.now();

/** Ask a worker which build it is. Returns null if it does not answer. */
function versionOf(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => done(typeof e.data === 'string' ? e.data : null);
      worker.postMessage({ type: 'version' }, [channel.port2]);
      // A worker from before this message existed will never reply, and must not leave the app
      // waiting on it for ever.
      setTimeout(() => done(null), 2000);
    } catch {
      done(null);
    }
  });
}

/** Until when this build has been put off, or 0. Storage can throw; a failure means "not hushed". */
function hushedUntil(version: string): number {
  try {
    return Number(localStorage.getItem(HUSH_PREFIX + version)) || 0;
  } catch {
    return 0;
  }
}

function hushUntil(version: string, until: number) {
  try {
    localStorage.setItem(HUSH_PREFIX + version, String(until));
    /*
     * Forget every other build while we are here. One key per version would otherwise accumulate
     * one entry per deploy for as long as the app is installed, and none of them can ever matter
     * again: a version that is no longer waiting is a version already running or already gone.
     */
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(HUSH_PREFIX) && k !== HUSH_PREFIX + version) localStorage.removeItem(k);
    }
  } catch {
    // A shop in a private window is asked again sooner. That is the whole cost.
  }
}

export function ServiceWorker() {
  const pathname = usePathname();
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  /** Which build is waiting — the name that makes "not now" mean one specific version. */
  const [version, setVersion] = useState<string | null>(null);
  /** False while the shop is being left alone after saying "Not now". */
  const [hushed, setHushed] = useState(false);
  const remindAfter = useRemindAfterMinutes();
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
    let dropped = false;

    /** A new version has finished downloading and is waiting for us to say when. */
    const ready = async (worker: ServiceWorker | null) => {
      // Only when something is ALREADY running: on a first visit there is no "new" version, just
      // the app arriving.
      if (!worker || !navigator.serviceWorker.controller) return;

      /*
       * A version that was ready before the shop had done anything is not news. It installs itself
       * on the next launch — see STARTUP_GRACE_MS. This is also why a browser tab that is merely
       * refreshed says nothing, while one left open for a day still gets asked.
       */
      if (Date.now() - startedAt < STARTUP_GRACE_MS) return;

      const v = await versionOf(worker);
      if (dropped) return;

      /*
       * ASKED ONCE PER VERSION, NOT ONCE PER PAGE.
       *
       * "Not now" used to live in React state, so it was forgotten the moment anything reloaded —
       * and this app reloads often: a relaunch, a tab change, coming back to a phone that dropped
       * the page. The shop set an interval of twelve hours and got asked again on the next screen.
       * The answer is remembered against the BUILD it was given about, so the same version stays
       * put away for as long as the shop asked, and a genuinely newer one still gets through at
       * once.
       */
      const until = v ? hushedUntil(v) : 0;
      const left = until - Date.now();

      setWaiting(worker);
      setVersion(v);
      setHushed(left > 0);
      if (left > 0) {
        // Come back to it when the wait is up, without needing anything else to happen.
        setTimeout(() => {
          if (!dropped) setHushed(false);
        }, left);
      }
    };

    const register = async () => {
      try {
        registration = await navigator.serviceWorker.register('/sw.js');
      } catch {
        // An app that cannot cache still works; it just needs the network. Nothing to say here.
        return;
      }
      void ready(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const installing = registration?.installing;
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed') void ready(installing);
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
      dropped = true;
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

  const putOff = useCallback(() => {
    setHushed(true);
    if (version) hushUntil(version, Date.now() + remindAfter * 60_000);
  }, [version, remindAfter]);

  /*
   * ASKED AGAIN, AS OFTEN AS THE SHOP SAID — and not once more than that.
   *
   * "Not now" has to be a real answer, but an answer never asked again is how a shop ends up
   * running a version from March, and the reason for a version is usually that something in the
   * last one was wrong. Half an hour to begin with; a shop that would rather be asked at closing
   * time sets twelve hours (Settings → Remind me about updates).
   */
  if (!waiting || hushed) return null;

  return (
    <ConfirmDialog
      controller={updateDialog}
      title="A new version is ready"
      message="It takes a moment and puts you back where you are. Anything you have typed is kept."
      confirmText="Update now"
      cancelText="Not now"
      tone="primary"
      onDismiss={putOff}
      onConfirm={relaunch}
    />
  );
}
