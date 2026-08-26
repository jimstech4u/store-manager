'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { scrollBroadcaster } from '@academix-admin/navigation-stack';
import styles from './FloatingAmount.module.css';

/**
 * A running total that floats at the right-hand end of the tab bar's line.
 *
 * OURS, not the library's. `NavigationBar` owns one floating slot and it is spoken for: that is
 * the circular action at the left, the same one academix-web uses. This sits at the other end of
 * the same line and answers to scrolling on its own terms.
 *
 * It exists because the sell screen used to pin a bar to the bottom of the page — "Total to pay"
 * over "Take payment". On a 390px phone that cost a full row of the order while a customer was
 * still adding to it, and it sat on top of the last line in the list. Floating it gives the row
 * back without hiding the one number the seller is watching.
 *
 * The scroll behaviour is deliberately the SAME SHAPE as the bar's autohide — clears the bar while
 * the bar is up, drops into its place once it has gone — because the two are on one line and
 * anything else reads as one of them being broken. It is computed here rather than read from the
 * bar because the bar exposes no such signal; both simply listen to the same broadcaster, which is
 * what keeps them in step.
 */
export function FloatingAmount({
  label,
  amount,
  onClick,
  disabled = false,
  /** Height of the tab bar, so this can clear it. Matches `--nav-height`. */
  barHeight = 74,
}: {
  label: string;
  amount: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  barHeight?: number;
}) {
  const [barHidden, setBarHidden] = useState(false);

  useEffect(() => {
    let previous = 0;
    let lastSource: string | null = null;

    return scrollBroadcaster.subscribe((e) => {
      const position = typeof e.position === 'number' ? e.position : 0;
      const clientHeight = e.clientHeight ?? 0;
      const scrollHeight = e.scrollHeight ?? 0;

      /*
       * A new page starts with the bar showing.
       *
       * The same rule NavigationBar applies (0.1.4), and it has to be applied here too or the two
       * disagree: measured without it, this pill dropped into the bar's place while the bar was
       * still up, so the total sat on top of the tabs. Scroll state belongs to the page that was
       * scrolled, and every tab stack stays mounted, so events arrive from pages nobody is
       * looking at.
       */
      const source = e.pageKey ?? e.uid ?? null;
      if (source != null && source !== lastSource) {
        lastSource = source;
        previous = position;
        setBarHidden(false);
        return;
      }

      // A page too short to scroll can never scroll back up, so a bar hidden there could never be
      // brought back. Same reasoning as the bar's own guard.
      if (scrollHeight <= clientHeight) {
        setBarHidden(false);
        previous = position;
        return;
      }

      // At the top the bar is always showing, whatever happened on the way there.
      if (position <= 0) {
        setBarHidden(false);
        previous = position;
        return;
      }

      // Only react to actual movement. Scroll is broadcast more than once per frame, and a repeat
      // at the same position would compare as "not scrolling down" and flicker the pill back.
      if (position !== previous) {
        setBarHidden(position > previous && position > 50);
        previous = position;
      }
    });
  }, []);

  return (
    <button
      type="button"
      className={`${styles.pill} ${disabled ? styles.disabled : ''}`}
      style={{
        bottom: barHidden
          ? 'calc(16px + env(safe-area-inset-bottom, 0px))'
          : `calc(16px + ${barHeight}px + env(safe-area-inset-bottom, 0px))`,
      }}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.amount}>{amount}</span>
    </button>
  );
}
