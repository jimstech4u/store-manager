'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * How wide the scrollbar is on the box a floating button is positioned against.
 *
 * WHY THIS EXISTS. A page slides in with a CSS `transform`, and an ancestor with a transform becomes
 * the containing block for `position: fixed` children. So a floating button's `right: 16px` is
 * measured from the edge of the PAGE'S scroll box rather than the window — and on a desktop browser
 * that box includes its own scrollbar. The pill sat on top of the scrollbar with no gap at all.
 * Phones use overlay scrollbars that take no width, which is why it only ever showed on the web.
 *
 * Returns 0 where scrollbars take no space, so the phone layout is exactly as it was.
 */
export function useScrollbarGutter(ref: RefObject<HTMLElement | null>): number {
  const [gutter, setGutter] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // The nearest ancestor that actually scrolls vertically — the page's own scroll box.
    let box: HTMLElement | null = el.parentElement;
    while (box) {
      const oy = getComputedStyle(box).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && box.clientWidth > 0) break;
      box = box.parentElement;
    }
    if (!box) return;

    const scroller = box;
    const measure = () => {
      const cs = getComputedStyle(scroller);
      const borders = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      setGutter(Math.max(0, scroller.offsetWidth - scroller.clientWidth - borders));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [ref]);

  return gutter;
}
