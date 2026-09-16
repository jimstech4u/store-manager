'use client';

import { useEffect, useId, useRef } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { QUICK_PERIODS, type Period, type PeriodKind } from '@/lib/stacks/periods';
import styles from './FilterBar.module.css';

/**
 * When, and what of.
 *
 * ONE BAR for every list and every report, so the gesture is learnt once. The chips are the common
 * windows a shop actually asks for; anything else is a date range.
 *
 * TYPING DATES IS A PUSHED PAGE, not a sheet. The first version opened a bottom sheet with two date
 * boxes in it, and nothing is typed inside a bottom viewer: a sheet's local state does not survive a
 * rotation, and the keyboard covers the half being typed into. "Pick dates" pushes `period_page`,
 * which hands the two dates back through a callback published under THIS bar's own name — pushed-
 * under pages stay mounted, so two bars can be alive at once and must not answer for each other.
 *
 * The chosen window is shown as a sentence rather than as two dates, and the sentence comes from
 * the SERVER — so what is on the screen and what prints on the document are the same words.
 */
export function FilterBar({
  period,
  onPeriod,
  onCustom,
  children,
}: {
  period: Period;
  onPeriod: (kind: PeriodKind) => void;
  onCustom: (fromDate: string, toDate: string) => void;
  /** The screen's own facets — staff, customer, supplier — rendered under the chips. */
  children?: React.ReactNode;
}) {
  const nav = useNav();
  const channel = `onPeriodPicked:${useId()}`;

  // The latest handler, so the published callback never goes stale between renders.
  const onCustomRef = useRef(onCustom);
  onCustomRef.current = onCustom;

  useEffect(() => {
    const cleanup = nav.provideObject(
      channel,
      () => (from: string, to: string) => onCustomRef.current(from, to),
      { global: true, scope: 'periods' },
    );
    return cleanup;
  }, [nav, channel]);

  return (
    <div className={styles.bar}>
      <div className={styles.chips} role="group" aria-label="Which period">
        {QUICK_PERIODS.map((p) => (
          <button
            key={p.kind}
            type="button"
            aria-pressed={period.kind === p.kind}
            className={`${styles.chip} ${period.kind === p.kind ? styles.chipOn : ''}`}
            onClick={() => onPeriod(p.kind)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={period.kind === 'custom'}
          className={`${styles.chip} ${period.kind === 'custom' ? styles.chipOn : ''}`}
          onClick={() => void nav.push('period_page', { then: channel })}
        >
          Pick dates
        </button>
      </div>

      {/*
        THE WINDOW, IN WORDS, and never as a pair of raw dates.

        "1 – 30 September 2026" is what somebody checks a printed report against. It is also the
        only thing on screen that says whether "this month" meant the calendar month or the last
        thirty days — which are different answers a shop will be asked to defend.
      */}
      <p className={styles.window}>{period.label}</p>

      {children}
    </div>
  );
}
