'use client';

import { StateStack } from '@academix-admin/state-stack';

/*
 * WHAT IS MADE FROM WHAT, DECLARED ONCE (state-stack 0.7.0, 13 Nov).
 *
 * The shop's `store_settings` row is cached twice: the printing page's paper (`receipt_paper`) and the
 * till's and the receipt's copy (`store_settings`). A write to either makes the other stale. Writers
 * used to have to remember both — the printing page invalidated only its own, and a removed logo went
 * on printing (11 Nov). Declared here, beside `invalidate`, which every writer goes through.
 */
StateStack.core.scopeDependsOn('receipt_paper', ['store_settings']);
StateStack.core.scopeDependsOn('store_settings', ['receipt_paper']);

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
  noteLocalWrite();
  StateStack.core.invalidateScope(scope);
}

/**
 * WHAT ANOTHER DEVICE DID, heard by `live-shop`: the same re-read, without counting as this device's
 * own write.
 */
export function invalidateHeard(scope: string) {
  StateStack.core.invalidateScope(scope);
}

/*
 * THIS DEVICE'S OWN WRITES, by time rather than by person. `live-shop` skipped any change written by
 * the person signed in, to save re-reading what this phone had just done — and a shop using ONE
 * account on two phones never heard the other phone at all: an order changed on the tablet stayed old
 * on the phone until it was closed and opened again. What this device wrote is what it wrote in the
 * last few seconds; anything else is somebody else, even with the same name.
 */
let lastLocalWrite = 0;
export function noteLocalWrite() {
  lastLocalWrite = Date.now();
}
export function wroteHereRecently(ms = 5000): boolean {
  return Date.now() - lastLocalWrite < ms;
}
