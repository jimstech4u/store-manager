'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { QUICK_PERIODS, type Period, type PeriodKind } from '@/lib/stacks/periods';
import styles from './FilterBar.module.css';

/**
 * When, and what of.
 *
 * ONE BAR for every list and every report, so the gesture is learnt once. The chips are the common
 * windows a shop actually asks for; anything else is a date range, and picking two dates is a
 * CHOICE, so it is a sheet — the same rule that puts the customer picker in one.
 *
 * The chosen window is shown as a sentence rather than as two dates, and the sentence comes from
 * the SERVER — so what is on the screen and what prints on the document are the same words, and
 * neither has to reconstruct the other.
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
  const [picking, setPicking] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

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
          onClick={() => setPicking(true)}
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

      <BottomSheet open={picking} onClose={() => setPicking(false)} title="Which dates?">
        <div className={styles.range}>
          <Field
            label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Field
            label="To"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            hint="This day counts too."
          />
          <Button
            fullWidth
            disabled={!from || !to || from > to}
            onClick={() => {
              onCustom(from, to);
              setPicking(false);
            }}
          >
            Use these dates
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
