'use client';

import type { ReactNode } from 'react';
import { useNavBarState } from '@/providers/NavBarState';
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
 * IT IS TOLD WHERE THE BAR IS. It does not work it out.
 *
 * Two earlier versions did, and both were wrong in ways that only showed on a real phone:
 *
 *   The first re-implemented the bar's autohide rules so the two would agree. They did not — at
 *   the bottom of a long scroll this sat a bar's height above the floating button beside it. Two
 *   copies of a rule are two rules, and they drift on the cases nobody enumerated.
 *
 *   The second measured the bar's DOM node and followed its CSS transition. Closer, but it missed
 *   every move the bar makes WITHOUT a scroll — tapping the floating button brings the bar back,
 *   and this stayed put and ended up drawn underneath it, unclickable.
 *
 * navigation-bar 0.1.5 reports its own state, for every cause. That is the only source that cannot
 * disagree with the bar.
 */
export function FloatingAmount({
  who,
  label,
  amount,
  onClick,
  disabled = false,
  busy = false,
}: {
  /**
   * Whose money this is, shown above the amount with a rule between them.
   *
   * The button used to say only "Take payment ₦3,700". With several tabs open that is the one
   * number on screen that must not be taken on trust — tapping it settles a sale, and WHICH sale
   * depended on remembering which tab was active. Naming the customer on the button means it says
   * what it is about to do rather than only how much.
   */
  who?: ReactNode;
  label: string;
  amount: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /**
   * Working, and not listening.
   *
   * Taking payment is a round trip to the shop, and without this the pill looked idle while it
   * ran — so a seller tapped it again, and again, and the sale appeared to need three or four
   * presses. It shows what it is doing and refuses the extra taps.
   */
  busy?: boolean;
}) {
  const bar = useNavBarState();

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
      style={{
        bottom: clearsBar
          ? `calc(16px + ${barHeight} + env(safe-area-inset-bottom, 0px))`
          : 'calc(16px + env(safe-area-inset-bottom, 0px))',
      }}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={onClick}
    >
      {who && <span className={styles.who}>{who}</span>}
      <span className={styles.row}>
        {busy && <span className={styles.spinner} aria-hidden="true" />}
        <span className={styles.label}>{label}</span>
        <span className={styles.amount}>{amount}</span>
      </span>
    </button>
  );
}
