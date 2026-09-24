'use client';

import { connectNextRouter } from '@academix-admin/state-stack/next';

/**
 * TELLS state-stack WHICH PAGE IT IS ON.
 *
 * Without this, `useResolvedPathname()` answers null and anything relying on route scoping lands in
 * one shared bucket called `route:unknown` — where two screens using the same key would read each
 * other's value.
 *
 * Nothing in this app relies on that today: every hook names its own scope, which is the rule here
 * ("one key = one hook = one shape") and a stronger guarantee than a route can give, since one route
 * is five mounted stacks in this app. This is in place so that the day somebody omits a scope, the
 * fallback is the page they are actually on rather than a bucket shared with every other page.
 *
 * CALLED AT MODULE SCOPE, not in an effect: the hook has to be registered before the first
 * `useDemandState` renders, and an effect runs after. `connectNextRouter` is idempotent.
 */
connectNextRouter();

/**
 * Renders nothing. It exists so the module above is part of the page's client bundle and runs — an
 * import for its side effect alone is the kind of thing a bundler is entitled to drop.
 */
export function StateStackRouter() {
  return null;
}
