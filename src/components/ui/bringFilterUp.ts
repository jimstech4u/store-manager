import { pageScrollerOf, scrollIntoViewBelow } from '@academix-admin/navigation-stack';

/**
 * A FILTER TAPPED BRINGS ITS RESULTS INTO VIEW.
 *
 * "Some filter cards do not scroll to view when tapped" (10 Nov). On Stock and People the chips sit
 * below a summary card, tiles and a search box — on a phone, just above the tab bar — so choosing
 * "Running low" changed a list that was entirely below the screen, and the tap looked like it did
 * nothing.
 *
 * WHAT IS BROUGHT UP depends on whether the row is pinned:
 *
 *  - INSIDE A PINNED BAR (`position: sticky` — PinnedTools, on ten list pages) the row itself cannot
 *    be the target. A sticky element never arrives at the top of its scroller the way the glide
 *    measures it — it stops wherever it pins — so the glide kept going to the end of the page, where
 *    the list's sentinel asked for page after page, and the top of the results scrolled away
 *    ("it scrolled to the bottom, making the list paginate endlessly", 10 Nov). The target is the
 *    start of the RESULTS, the first thing after the pinned bar, put just beneath the bar.
 *  - A row that scrolls with the page is put at the top itself, a little clear of the edge.
 *
 * AND KEEPS AT IT WHILE THE ANSWER LANDS. A new filter shows its loading state first, so for a
 * moment there may be too little page to put the results where they belong; it is asked again as the
 * list grows — three more times over the next second and a half — and not at all once the person
 * touches the page: their thumb beats our idea of where the list should be.
 */
export function bringFilterUp(row: HTMLElement | null) {
  if (!row || typeof window === 'undefined') return;

  let touched = false;
  const stop = () => {
    touched = true;
  };
  // Registered after this tap has finished, so the tap that chose the filter does not count.
  const listen = () => {
    window.addEventListener('touchstart', stop, { passive: true, once: true });
    window.addEventListener('wheel', stop, { passive: true, once: true });
  };
  const go = () => {
    if (touched || !row.isConnected) return;
    const pinned = pinnedAncestor(row);
    if (pinned) {
      const results = firstAfter(pinned);
      if (results) void scrollIntoViewBelow(results, { below: () => pinned });
      return;
    }
    void scrollIntoViewBelow(row, { below: 8 });
  };

  requestAnimationFrame(() => {
    listen();
    go();
  });
  const timers = [450, 900, 1500].map((ms) => window.setTimeout(go, ms));
  window.setTimeout(() => {
    timers.forEach((t) => window.clearTimeout(t));
    window.removeEventListener('touchstart', stop);
    window.removeEventListener('wheel', stop);
  }, 1600);
}

/** The row itself or the nearest ancestor that is `position: sticky`, up to the page's scroller. */
function pinnedAncestor(el: HTMLElement): HTMLElement | null {
  // Up to the page's own scroller, as navigation-stack names it (1.12.0) — not by its class.
  const page = pageScrollerOf(el);
  let node: HTMLElement | null = el;
  while (node && node !== page && node !== document.body) {
    if (getComputedStyle(node).position === 'sticky') return node;
    node = node.parentElement;
  }
  return null;
}

/** The first thing after the pinned bar that takes up room — where the results begin. */
function firstAfter(pinned: HTMLElement): HTMLElement | null {
  let next = pinned.nextElementSibling as HTMLElement | null;
  while (next && next.offsetHeight === 0) next = next.nextElementSibling as HTMLElement | null;
  return next;
}
