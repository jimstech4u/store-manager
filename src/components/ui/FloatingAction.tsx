'use client';

import { useRef, type ReactNode } from 'react';
import { useNavBarState } from '@/providers/NavBarState';
import { useScrollbarGutter } from '@/hooks/useScrollbarGutter';
import styles from './FloatingAmount.module.css';

/**
 * A floating way through to a job, rather than a readout.
 *
 * `FloatingAmount` is the till's: it carries a customer and a figure, because tapping it settles a
 * sale and WHICH sale must not be taken on trust. This one carries a word, for a screen where the
 * destination is the whole message — Count, reached from Stock.
 *
 * It shares `FloatingAmount`'s stylesheet on purpose. The position is the hard part and it is
 * already solved there: the bar reports its own height and whether it is hidden, so the pill clears
 * it while it is showing and takes its place once it has gone. Two copies of that would drift, and
 * the way they drift is one of them sitting on top of the tab bar at the bottom of a long scroll.
 *
 * STILL THE ONE THING THAT LEGITIMATELY FLOATS. Nothing else on this site is pinned — an action
 * ends its page. A floating control is for reaching a DIFFERENT screen from a list somebody is
 * working down, which is exactly what this is and exactly what Take payment is.
 */
export function FloatingAction({
  label,
  icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  const bar = useNavBarState();
  /*
   * Clear the page's scrollbar as well as the edge. A page slides in with a transform, which makes
   * its scroll box — scrollbar included — the thing `right` is measured from; without this the pill
   * sat on top of the scrollbar on a desktop browser. 0 on a phone, where scrollbars take no width.
   */
  const pillRef = useRef<HTMLButtonElement>(null);
  const gutter = useScrollbarGutter(pillRef);

  /*
   * Clear the bar while it is showing; take its place once it has gone.
   *
   * `null` means the bar has not reported yet — assume it is showing, which is what it does at
   * rest, so the very first paint is never on top of it.
   */
  const clearsBar = bar === null || !bar.hidden;
  const barHeight = bar?.height ?? 'var(--nav-height)';

  return (
    <button
      type="button"
      className={`${styles.pill} ${disabled ? styles.disabled : ''}`}
      ref={pillRef}
      style={{
        right: `calc(var(--space-4) + ${gutter}px)`,
        bottom: clearsBar
          ? `calc(16px + ${barHeight} + env(safe-area-inset-bottom, 0px))`
          : 'calc(16px + env(safe-area-inset-bottom, 0px))',
      }}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.row}>
        {icon}
        <span className={styles.label}>{label}</span>
      </span>
    </button>
  );
}
