import { scrollIntoViewBelow } from '@academix-admin/navigation-stack';

/**
 * A FILTER TAPPED BRINGS ITS ROW UP, so what it chose is on screen.
 *
 * "Some filter cards do not scroll to view when tapped" (10 Nov). On Stock and People the chips sit
 * below a summary card, tiles and a search box — on a phone, just above the tab bar — so choosing
 * "Running low" changed a list that was entirely below the screen, and the tap looked like it did
 * nothing. The row now glides to the top of the page, a little clear of it, with the list it
 * filters under it. A row already there does not move.
 *
 * AND KEEPS AT IT WHILE THE ANSWER LANDS. A new filter swaps the list for its loading state, so for
 * a moment the page is too short to put the row at the top: the glide stops where the page ends, and
 * when the rows arrive a moment later the row is still low. So it is asked again as the list grows —
 * three more times over the next second and a half — and not at all once the person touches the
 * page: their thumb beats our idea of where the list should be.
 *
 * Through `scrollIntoViewBelow`, which re-measures while it travels and gives way to a thumb.
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
