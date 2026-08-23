'use client';

import { useEffect, useRef } from 'react';
import {
  readOverlayFragment,
  writeOverlayFragment,
} from '@academix-admin/navigation-stack';

/**
 * Make an overlay a real history entry, so the platform back gesture closes it.
 *
 * Uses navigation-stack's own overlay-fragment codec rather than writing history here. That codec
 * exists for exactly this and is careful in ways an app-level version would not be: it owns a
 * single `ax=` segment of the fragment and passes every other segment through untouched, so a
 * `#section` deep link or a `scrollIntoView` anchor still works; it writes to the FRAGMENT, which
 * never round-trips to the server, so opening a sheet cannot trigger a server render; and its push
 * does not inherit the previous entry's state, which is the bug that made a closing sheet pop a
 * page that had just been pushed.
 *
 * Needed because `SelectionViewer` and `SearchViewer` portal themselves and do not register with
 * the navigation stack. Measured before this existed: pressing back with the product picker open
 * closed the picker AND left the sell screen behind it — back walked straight out of the app
 * mid-sale.
 *
 * `name` identifies which overlay is open, so two of them cannot mistake each other's entry.
 */
export function useOverlayRoute(name: string, open: boolean, onClose: () => void) {
  /*
   * `onClose` is nearly always an inline arrow, so its identity changes on every render of the
   * parent. Held in a ref so the effect below depends on `open` ALONE.
   *
   * Depending on it directly is what broke the first version of this: every parent re-render tore
   * the effect down, the cleanup went back a step, and the sheet dismissed itself about 400ms
   * after opening. It looked like a rendering glitch and was a dependency-array bug.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    writeOverlayFragment(name, 'push');

    const onPop = () => {
      // Our segment is gone from the fragment, so this overlay is no longer the open one.
      if (readOverlayFragment() !== name) closeRef.current();
    };

    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);

      /*
       * Closed by a button rather than by back: our entry is still on the stack, so take it off,
       * or the next back press appears to do nothing at all.
       *
       * Deferred by a tick, and only if the entry on top is still OURS.
       *
       * Choosing something inside an overlay usually closes it and pushes a page in the same
       * handler. React runs this cleanup before the push completes, so the immediate version saw
       * its own fragment, queued a step back, and that step landed on the page that had just been
       * pushed — tapping a customer in the search results dismissed the search and went nowhere,
       * every time. `axOverlay` is the marker navigation-stack's codec puts on the entry it
       * created; once a page has been pushed the top entry carries the stack's own state instead,
       * which is how we tell "still our overlay" from "already moved on".
       */
      const ours = name;
      window.setTimeout(() => {
        const state = window.history.state as { axOverlay?: string } | null;
        if (readOverlayFragment() === ours && state?.axOverlay === ours) window.history.back();
      }, 0);
    };
  }, [name, open]);
}
