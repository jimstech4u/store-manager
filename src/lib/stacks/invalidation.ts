'use client';

import { StateStack } from '@academix-admin/state-stack';

/**
 * Saying that something changed, without throwing away what is on screen.
 *
 * Every "x changed" function in this folder used to call `StateStack.core.clearScope`, which DELETES
 * every cached value in the scope. For a hook that refetches on mount that is merely redundant. For
 * a paginated list it is destructive, and it produced the bug this exists to fix:
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
 * answer arrives.
 *
 * THE LISTENER BUS THAT USED TO LIVE HERE IS NOW state-stack's (0.4.0). It had nothing in it that
 * knew about this app, and the package already owned the other half — `invalidateScope` marks the
 * keys stale. Screens that own their loader import `useInvalidation` from the package directly; what
 * is left here is this project's own word for the thing.
 */
export function invalidate(scope: string) {
  StateStack.core.invalidateScope(scope);
}
