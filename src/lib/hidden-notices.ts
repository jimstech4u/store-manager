'use client';

import { useCallback, useSyncExternalStore } from 'react';

/* =====================================================================================
   Warnings the shop has told us it does not want to see again.

   A warning that cannot be turned off gets ignored rather than read — it becomes furniture at
   the top of a screen the shop looks at forty times a day, and then the NEXT warning, the one
   that matters, is furniture too. So each one can be dismissed, and every dismissal is
   reversible from Settings; nothing is lost, only put away.

   Kept on the device, not the server. "I do not want to see this on the till" is a statement
   about this screen in this shop, not about the business — the owner on their own phone should
   still be told that stock cannot be sold. A server flag would silence everybody at once.
   ===================================================================================== */

const KEY = 'sm.hidden-notices';

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function read(): string[] {
  if (cache) return cache;
  if (typeof window === 'undefined') return (cache = []);
  try {
    const raw = window.localStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    // A browser with storage blocked is not a broken shop — it just remembers nothing.
    cache = [];
  }
  return cache;
}

function write(next: string[]) {
  cache = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* see read() */
  }
  listeners.forEach((fn) => fn());
}

export function hideNotice(id: string) {
  const now = read();
  if (now.includes(id)) return;
  write([...now, id]);
}

export function showNotice(id: string) {
  write(read().filter((x) => x !== id));
}

export function showAllNotices() {
  write([]);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/*
 * `useSyncExternalStore` rather than state in a provider: a panel on one screen and the list in
 * Settings are nowhere near each other in the tree, and putting them under a shared provider
 * would mean every screen in the app re-renders when somebody dismisses one warning.
 *
 * The server snapshot is a stable empty array — on the server nothing is hidden, so the first
 * paint matches the markup and React does not complain about a mismatch.
 */
const NOTHING_HIDDEN: string[] = [];

export function useHiddenNotices() {
  return useSyncExternalStore(subscribe, read, () => NOTHING_HIDDEN);
}

export function useNoticeHidden(id: string | undefined) {
  const hidden = useHiddenNotices();
  return id ? hidden.includes(id) : false;
}

/** Everything that can be put away, so Settings can list them by name rather than by id. */
export const NOTICE_NAMES: Record<string, string> = {
  'stock.gaps': 'Stock that can come in but never go out',
  'stock.estimated': 'Costs that are still estimates',
};

export function useNoticeActions() {
  return {
    hide: useCallback(hideNotice, []),
    show: useCallback(showNotice, []),
    showAll: useCallback(showAllNotices, []),
  };
}
