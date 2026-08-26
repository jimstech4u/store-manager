'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { scrollBroadcaster } from '@academix-admin/navigation-stack';
import styles from './FloatingAmount.module.css';

/**
 * A running total that floats at the right-hand end of the tab bar's line.
 *
 * OURS, not the library's. `NavigationBar` owns one floating slot and it is spoken for — that is
 * the circular action at the left, the same one academix-web uses. This sits at the other end of
 * the same line.
 *
 * It exists because the sell screen used to pin a bar to the bottom of the page: "Total to pay"
 * over "Take payment". On a 390px phone that cost a full row of the order while a customer was
 * still adding to it, and it sat on top of the last line in the list.
 *
 * IT MEASURES THE BAR RATHER THAN PREDICTING IT.
 *
 * The first version re-implemented the bar's autohide rules — same thresholds, same page-change
 * reset — so the two would agree. They did not. At the bottom of a long scroll the pill sat a
 * bar's height higher than the FAB beside it: two controls on one line, visibly disagreeing about
 * where that line was. Two copies of a rule are two rules, and they drift on the cases nobody
 * enumerated.
 *
 * So this reads the bar's actual position and sits above it. There is nothing left to disagree
 * with: whatever the bar does — hide, return, change height, get replaced — the pill follows,
 * because the bar is the only source.
 */
export function FloatingAmount({
  label,
  amount,
  onClick,
  disabled = false,
}: {
  label: string;
  amount: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  /** Distance from the viewport's bottom edge to the top of the bar, plus a gap. */
  const [bottom, setBottom] = useState<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const GAP = 16;

    const measure = () => {
      const bar = document.querySelector('nav.navigation-bar');
      if (!bar) {
        setBottom(GAP);
        return;
      }
      const rect = bar.getBoundingClientRect();
      // The bar slides below the viewport when it hides, so clamp: once it is off screen the pill
      // should sit at the bottom edge rather than following it out of sight.
      //
      // ROUNDED. `getBoundingClientRect` returns fractional pixels mid-animation, so an unrounded
      // value changed by hundredths every frame — the pill never held still, and anything checking
      // whether it had settled (a click, a screenshot) waited forever on movement nobody could see.
      const above = Math.max(0, Math.round(window.innerHeight - rect.top));
      setBottom(above + GAP);
    };

    /*
     * Follow the bar THROUGH its slide, not just at the ends.
     *
     * The bar animates over 0.3s. Measuring once on a scroll event catches it mid-flight and
     * leaves the pill parked at whatever it read; measuring for the length of the animation lets
     * the pill travel with it. The loop is bounded — it stops as soon as the position settles —
     * so this is not a permanent rAF.
     */
    let settledFor = 0;
    let last = -1;
    const follow = () => {
      const bar = document.querySelector('nav.navigation-bar');
      const top = bar ? Math.round(bar.getBoundingClientRect().top) : -1;
      measure();
      settledFor = top === last ? settledFor + 1 : 0;
      last = top;
      // Roughly a fifth of a second of no movement is the animation being over.
      if (settledFor < 12) frame.current = requestAnimationFrame(follow);
      else frame.current = null;
    };

    /*
     * Start following only if the bar has actually moved.
     *
     * Scroll is broadcast many times a second, and by every mounted stack — restarting the follow
     * loop on each one meant it never reached its settled count, so the pill was permanently
     * "animating" even while nothing moved. Anything waiting for it to hold still waited forever.
     */
    const kick = () => {
      const bar = document.querySelector('nav.navigation-bar');
      const top = bar ? Math.round(bar.getBoundingClientRect().top) : -1;
      if (top === last && frame.current === null) return;
      settledFor = 0;
      if (frame.current === null) frame.current = requestAnimationFrame(follow);
    };

    measure();

    /*
     * Every way the bar can move, and there are three.
     *
     * Scrolling is the obvious one. Resizing is the easy one. The third is the one that was
     * missed: the bar reveals itself on a change of page WITHOUT any scroll — and with nothing
     * listening for that, the pill kept the offset it had measured while the bar was hidden and
     * ended up drawn inside the bar, underneath it, unclickable.
     *
     * `transitionrun` fires as the bar starts moving whatever caused it, so this follows the bar
     * rather than trying to enumerate the reasons it might move. Event-driven, not a poll.
     */
    const unsubscribe = scrollBroadcaster.subscribe(kick);
    window.addEventListener('resize', kick);

    const bar = document.querySelector('nav.navigation-bar');
    bar?.addEventListener('transitionrun', kick);
    bar?.addEventListener('transitionend', kick);

    return () => {
      unsubscribe?.();
      window.removeEventListener('resize', kick);
      bar?.removeEventListener('transitionrun', kick);
      bar?.removeEventListener('transitionend', kick);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <button
      type="button"
      className={`${styles.pill} ${disabled ? styles.disabled : ''}`}
      style={{
        bottom:
          bottom === null
            ? 'calc(16px + var(--nav-height) + env(safe-area-inset-bottom, 0px))'
            : `${bottom}px`,
      }}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.amount}>{amount}</span>
    </button>
  );
}
