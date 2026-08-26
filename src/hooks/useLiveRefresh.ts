'use client';

import { useEffect, useRef } from 'react';
import { usePageState, type NavStackAPI } from '@academix-admin/navigation-stack';

/**
 * Keep a page's figures current while somebody is looking at them.
 *
 * Every tab stack stays mounted — that is what makes switching instant and keeps each tab's scroll
 * and history — so a page that loaded once goes on showing whatever it loaded. Settle a sale on
 * the Sell tab, come back to Money, and the customer's balance is the one from before that sale:
 * the right screen with stale numbers, which is worse than a spinner because nothing about it
 * looks wrong.
 *
 * Two parts, and the second is not decoration:
 *
 *   THE ACTIVE EDGE catches the common return — another tab, then back to this one.
 *   THE INTERVAL is what makes it reliable. Measured against the real flow, no single signal was
 *   enough: `onResume` misses a return from a page pushed on top of this one, `onEnter` fires
 *   before a just-settled sale is readable so its reload fetches the old figures again, and the
 *   active edge alone still left a balance stale. Passing only when several are combined is timing
 *   luck, not a mechanism, and these screens state what a customer owes.
 *
 * Gated on document visibility so a backgrounded tab costs nothing, and stopped entirely while the
 * page is not the active one.
 *
 * Extracted from the customer account page, which had all of this inline, once the statement page
 * turned out to need exactly the same thing — including the same reasons.
 */
export function useLiveRefresh(
  nav: NavStackAPI,
  reload: () => void | Promise<void>,
  {
    everyMs = 8000,
    /**
     * Turn the refresh off while something is happening that it would interrupt.
     *
     * A list that re-reads itself under an open search sheet re-renders the sheet, and the sheet
     * loses the text being typed into it — the results snap back to everything. Measured: typing a
     * customer's name returned the whole customer list, because the refresh had reset the viewer
     * between the keystroke and the assertion. Refreshing a list nobody is reading is worth
     * nothing; interrupting a search is worth less than nothing.
     */
    enabled = true,
  }: { everyMs?: number; enabled?: boolean } = {},
) {
  const { isActive } = usePageState(nav);
  const live = isActive && enabled;

  const wasActive = useRef(live);
  useEffect(() => {
    if (live && !wasActive.current) void reload();
    wasActive.current = live;
  }, [live, reload]);

  useEffect(() => {
    if (!live || typeof document === 'undefined') return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, everyMs);
    return () => clearInterval(id);
  }, [live, reload, everyMs]);
}
