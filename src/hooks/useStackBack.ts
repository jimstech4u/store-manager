'use client';

import { useEffect, useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';

/**
 * A back handler for a page inside a navigation stack — `undefined` at the stack's first page.
 *
 * Every screen here already renders through `PageScaffold`, which has always accepted an
 * `onBack`; nothing ever passed one, so pushed pages had no visible way back and relied on the
 * browser or the Android gesture. On a phone that is a dead end for anyone who does not know the
 * gesture, which is a large share of the people this is built for.
 *
 * Returning `undefined` at the root is the point: a page can call this unconditionally without
 * knowing whether it is the first in its stack, and the arrow appears only where there is
 * somewhere to go. Pages get added and reordered — a rule that has to be restated per page is a
 * rule that goes stale.
 *
 * Subscribes rather than reading `getStack()` once, because the same component instance stays
 * mounted while the stack changes underneath it.
 */
export function useStackBack(): (() => void) | undefined {
  const nav = useNav();
  const [depth, setDepth] = useState(() => nav.getStack().length);

  useEffect(() => {
    setDepth(nav.getStack().length);
    return nav.subscribe((stack) => setDepth(stack.length));
  }, [nav]);

  return depth > 1 ? () => void nav.pop() : undefined;
}
