'use client';

import { useEffect, useRef } from 'react';

/**
 * Saying that something changed, without throwing away what is on screen.
 *
 * Every "x changed" function here used to call `StateStack.core.clearScope`, which DELETES every
 * cached value in the scope. For a hook that refetches on mount that is merely redundant. For a
 * paginated list it is destructive, and it produced the bug this exists to fix:
 *
 *   THE STOCK LIST VANISHED AFTER ANY CATALOGUE WRITE. `catalogChanged()` cleared `catalog_flow`,
 *   and the products list lived in it — so saving a unit deleted the list, and coming back gave a
 *   full-screen "Loading your stock" with the reader's place gone.
 *
 *   THE PEOPLE LIST VANISHED ON THE WAY BACK FROM AN ACCOUNT. Worse, because nothing was even
 *   written: the account page cleared `customer_flow` ON EXIT, and the People list and the
 *   customer picker both live there. Leaving a page deleted a list belonging to another page.
 *
 * A cache is dropped for exactly one reason — the data must not be seen again, which means signing
 * out or switching shop. `AuthProvider` still clears for that, and should. Everything else is
 * staleness, and the answer to staleness is to re-read, keeping what is on screen until the new
 * answer arrives. That is what the codebase's own rule already says: a loader must never blank
 * before it fetches.
 */

const listeners = new Map<string, Set<() => void>>();

/**
 * Tell everything holding data in this scope to re-read.
 *
 * Synchronous and best-effort: a screen that is not mounted hears nothing, which is correct — it
 * will read fresh when it mounts.
 */
export function invalidate(scope: string) {
  const set = listeners.get(scope);
  if (!set) return;
  // Copied before iterating: a listener may unsubscribe itself as it runs.
  for (const fn of [...set]) fn();
}

/**
 * Re-read whenever this scope is invalidated.
 *
 * The callback is held in a ref so a caller can pass an inline closure without resubscribing on
 * every render — the subscription follows the scope, not the function identity.
 */
export function useInvalidation(scope: string | null, onChanged: () => void) {
  const ref = useRef(onChanged);
  ref.current = onChanged;

  useEffect(() => {
    if (!scope) return;

    const fn = () => ref.current();
    let set = listeners.get(scope);
    if (!set) {
      set = new Set();
      listeners.set(scope, set);
    }
    set.add(fn);

    return () => {
      set.delete(fn);
      if (set.size === 0) listeners.delete(scope);
    };
  }, [scope]);
}
