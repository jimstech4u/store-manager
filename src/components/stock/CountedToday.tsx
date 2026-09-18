'use client';

import type { ReactNode } from 'react';
import { CheckIcon } from '@/components/ui/Icon';
import { stockInShapes, type SellingUnit } from '@/lib/stacks/selling-units';
import { formatQty } from '@/lib/format';
import {
  countTime,
  countedByWords,
  useCountTrail,
  type TodaysCount,
} from '@/lib/stacks/count-gate';
import styles from './CountedToday.module.css';

/**
 * Today's count of one item, and everything that has happened to it since.
 *
 * A day's count is said ONCE (0145). Somebody opening an item that has already been counted must see
 * that straight away — the figure, who said it and when — rather than a set of empty boxes that
 * invite a second count the server will refuse. When a manager has corrected it, the whole trail is
 * shown: the first figure with its counter, then each change with who made it and why. A number that
 * has changed without saying so is the thing a count exists to prevent.
 */
export function CountedToday({
  storeId,
  count,
  shapes,
  baseUnit,
  children,
}: {
  storeId: string;
  count: TodaysCount;
  /** The item's shapes, so a figure reads "3 crates 4 bottles" rather than 40. */
  shapes: SellingUnit[];
  baseUnit?: string;
  /** What may be done about it — the correction button, or why there is none. */
  children?: ReactNode;
}) {
  // The trail is only interesting once something has replaced something — one count says itself.
  const { steps } = useCountTrail(storeId, count.edits > 0 ? count.productId : null);

  const say = (base: number) =>
    shapes.length > 0
      ? stockInShapes(shapes.map((u) => ({ ...u, onHandBase: base })))
      : `${formatQty(base)} ${baseUnit ?? ''}`.trim();

  return (
    <section className={styles.card} aria-label="Counted today">
      <p className={styles.head}>
        <CheckIcon /> Counted today
      </p>
      <p className={styles.figure}>{say(count.countedBase)}</p>
      <p className={styles.who}>
        {count.edits > 0
          ? `Counted ${count.edits + 1} times today · this one ${countedByWords(count)}`
          : `Counted ${countedByWords(count)}`}
      </p>

      {count.edits > 0 && steps.length > 0 && (
        <ol className={styles.trail}>
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} className={styles.step}>
              <span className={styles.stepTime}>{countTime(s.at)}</span>
              <span className={styles.stepBody}>
                {s.kind === 'counted' ? (
                  <>
                    <strong>{s.byYou ? 'You' : s.by}</strong> counted {say(s.qtyBase)}
                  </>
                ) : (
                  <>
                    <strong>{s.byYou ? 'You' : s.by}</strong> counted again:{' '}
                    {say(s.oldBase ?? 0)} → {say(s.qtyBase)}
                    {s.reason && <span className={styles.reason}>“{s.reason}”</span>}
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}

      {children && <div className={styles.actions}>{children}</div>}
    </section>
  );
}
