'use client';

import { usePageLifecycle, type NavStackAPI } from '@academix-admin/navigation-stack';

/**
 * Reload a screen's figures when it is returned to, and drop them when it is left.
 *
 * Every tab stack stays mounted — that is what makes switching instant and keeps each tab's scroll
 * and history — so a page that loaded once goes on showing whatever it loaded. Settle a sale on
 * the Sell tab, come back to Money, and the customer's balance is the one from before that sale:
 * the right screen with stale numbers, which is worse than a spinner because nothing about it
 * looks wrong.
 *
 * TWO EVENTS, TWO JOBS — the shape academix-web uses:
 *
 *   onResume  RELOADS. The cached value stays on screen while the request is in flight and is
 *             then OVERRIDDEN with what came back. Nothing is cleared first, so there is no blank
 *             frame and no spinner over a figure that is very nearly right.
 *
 *   onExit    does nothing here any more — see below.
 *             cached about it: the next visit starts from the server rather than from something
 *             saved before an unknown number of sales.
 *
 * This replaced a polling timer. The timer existed because nothing was telling these screens
 * anything had changed — which is both wasteful and still wrong for the first seconds after a
 * sale, exactly when someone is looking at the number. `onResume` is the app saying so.
 */
export function useLiveRefresh(nav: NavStackAPI, reload: () => void | Promise<void>) {
  /*
   * NOTHING IS DROPPED ON THE WAY OUT.
   *
   * This took an optional `scope` and cleared it in `onExit` — "tidy up after yourself on the way
   * out", which sounds thrifty and is destructive. A scope is SHARED: the account page cleared
   * `customer_flow`, and the People list and the customer picker both live there. Opening
   * somebody's account and pressing Back deleted the list of everybody.
   *
   * A page does not own the scope it reads from, so a page has no business emptying one. The only
   * thing that legitimately deletes cached data is signing out or switching shop, and
   * `AuthProvider` does exactly that.
   */
  usePageLifecycle(
    nav,
    {
      onResume: () => {
        void reload();
      },
    },
    [reload],
  );
}
