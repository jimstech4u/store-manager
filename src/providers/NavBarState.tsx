'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { NavigationBarVisibility } from '@academix-admin/navigation-bar';

/**
 * What the tab bar is currently doing, for anything anchored to it.
 *
 * The bar reports its own state through `onVisibilityChange` (navigation-bar 0.1.5). This holds
 * the latest report and hands it to whoever is interested.
 *
 * DELIBERATELY OUTSIDE REACT STATE.
 *
 * The first version was a context provider holding `useState`. Every report re-rendered the shell,
 * which re-rendered the tab bar, which reset the bar's own hidden state — so the bar stopped
 * hiding altogether, and the thing that was supposed to observe it had broken it. A module-level
 * store with `useSyncExternalStore` means a report re-renders only the components that actually
 * read it, and never the shell that renders the bar.
 *
 * Two earlier attempts at this problem are worth recording, because both looked fine:
 *
 *   RE-IMPLEMENTING the bar's autohide rules in the consumer. Two copies of a rule drift, and they
 *   did — the running total ended up a bar's height away from the bar's own floating button.
 *
 *   SNIFFING `transitionrun` on the bar's DOM node. It worked, but it reached into another
 *   component's internals and missed every move the bar makes without a transition.
 */

let current: NavigationBarVisibility | null = null;
const listeners = new Set<() => void>();

/** Called by the shell with each report from the bar. */
export function reportNavBarState(state: NavigationBarVisibility) {
  // Identity-compare the fields that matter, so a repeated report does not wake every reader.
  if (
    current &&
    current.hidden === state.hidden &&
    current.height === state.height &&
    current.mode === state.mode
  ) {
    return;
  }
  current = state;
  listeners.forEach((l) => l());
}

/** Null until the bar has reported once — before that, assume it is showing, which it does. */
export function useNavBarState(): NavigationBarVisibility | null {
  const subscribe = useCallback((onChange: () => void) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, []);

  // The server has no bar, so the server snapshot is null and the first client paint matches it.
  const serverSnapshot = useRef<NavigationBarVisibility | null>(null);
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => serverSnapshot.current,
  );
}
