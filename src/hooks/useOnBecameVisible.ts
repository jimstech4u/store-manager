'use client';

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Run something when this page's TAB becomes the active one again.
 *
 * For screens showing a live position. All six tab stacks stay mounted — that is what makes
 * switching instant and preserves each tab's scroll and stack — so a page that loaded once keeps
 * showing whatever it loaded. Settling a sale on the Sell tab and returning to People showed the
 * customer's balance from BEFORE the sale: the right screen with stale numbers, which is worse
 * than a spinner because nothing about it looks wrong.
 *
 * Three signals were tried before this one, and it is worth recording why each failed:
 *
 *   · `window.focus` / `visibilitychange` — the browser window never loses focus when the user
 *     moves between tabs INSIDE the app, so nothing fires at all.
 *   · navigation-stack's `useIsTop` — the page never stops being top of its OWN stack; it is the
 *     whole stack that is set aside when another tab is shown.
 *   · IntersectionObserver — the inactive stack is not hidden in a way that changes intersection,
 *     so the element never reports as leaving the viewport.
 *
 * What actually changes is a class on the group container: GroupNavigationStack marks exactly one
 * `.group-stack-container` as `.group-stack-active`. Watching that attribute is watching the
 * thing the library really does.
 *
 * Falls back to IntersectionObserver when no group container is found, so the hook is still
 * meaningful on a screen that is not inside a tab group.
 */
export function useOnBecameVisible(
  ref: RefObject<HTMLElement | null>,
  onVisible: () => void,
) {
  // Held in a ref so a caller passing an inline arrow does not tear the observer down and rebuild
  // it on every render — which would re-fire it.
  const cb = useRef(onVisible);
  cb.current = onVisible;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof MutationObserver === 'undefined') return;

    const container = el.closest('.group-stack-container');

    if (container) {
      let wasActive = container.classList.contains('group-stack-active');
      const observer = new MutationObserver(() => {
        const active = container.classList.contains('group-stack-active');
        if (active && !wasActive) cb.current();
        wasActive = active;
      });
      observer.observe(container, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    }

    if (typeof IntersectionObserver === 'undefined') return;
    let wasVisible = el.offsetParent !== null;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && !wasVisible) cb.current();
        wasVisible = visible;
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
