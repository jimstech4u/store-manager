'use client';

import { usePageLifecycle, type NavStackAPI } from '@academix-admin/navigation-stack';
import { StateStack } from '@academix-admin/state-stack';

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
 *   onExit    CLEARS the scope. Leaving the page for good is the honest moment to drop what was
 *             cached about it: the next visit starts from the server rather than from something
 *             saved before an unknown number of sales.
 *
 * This replaced a polling timer. The timer existed because nothing was telling these screens
 * anything had changed — which is both wasteful and still wrong for the first seconds after a
 * sale, exactly when someone is looking at the number. `onResume` is the app saying so.
 */
export function useLiveRefresh(
  nav: NavStackAPI,
  reload: () => void | Promise<void>,
  {
    /** state-stack scope to drop on exit. Omit to keep the cache across visits. */
    scope,
  }: { scope?: string } = {},
) {
  usePageLifecycle(
    nav,
    {
      onResume: () => {
        void reload();
      },
      onExit: () => {
        if (scope) void StateStack.core.clearScope(scope);
      },
    },
    [reload, scope],
  );
}
