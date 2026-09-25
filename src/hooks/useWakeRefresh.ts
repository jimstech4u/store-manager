'use client';

import { useEffect, useRef } from 'react';

/**
 * ASK AGAIN WHEN THE APP ITSELF COMES BACK.
 *
 * `useLiveRefresh` covers moving between screens: navigation-stack's `onResume` fires when a page
 * is returned to, and that is the right answer for "settle a sale, come back to Money". It cannot
 * fire for the case this exists for — the whole app being put away and picked up again. An installed
 * PWA on a phone is backgrounded constantly, and while it is away nothing in it runs at all. A shop
 * that opened the till at nine and glanced at it at eleven was looking at nine o'clock's figures,
 * with no event of any kind to say so.
 *
 * WHY NOT A TIMER. A timer is the obvious fix and it is wrong twice over: it asks when nothing has
 * happened, which on a metered connection is somebody's money, and it still does not ask at the
 * moment that matters — the second the screen lights up. `visibilitychange` is the browser saying
 * "they are looking at this now", which is exactly the question.
 *
 * WHY NOT ONLY `visibilitychange`. `pageshow` with `persisted` is a page restored from the
 * back-forward cache, where no React state changed and no effect re-ran: iOS Safari does this when
 * a tab is returned to, and it looks identical to the app resuming while behaving nothing like it.
 * `focus` catches the desktop case of another window being brought forward.
 *
 * MINIMUM GAP, because these fire together and often. Switching apps twice in a second is one
 * arrival, not three, and a shop flicking between this and WhatsApp should not be paying for a
 * request per flick.
 */
export function useWakeRefresh(onWake: () => void, minGapMs = 20_000) {
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  useEffect(() => {
    if (typeof document === 'undefined') return;

    // Starts "now", so opening a screen does not immediately re-ask what it has just read.
    let last = Date.now();

    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < minGapMs) return;
      last = now;
      onWakeRef.current();
    };

    const onPageShow = (e: Event) => {
      // A restore from the back-forward cache is an arrival; an ordinary load is not — the page has
      // just read everything it needs.
      if ((e as PageTransitionEvent).persisted) wake();
    };

    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', wake);
    };
  }, [minGapMs]);
}
