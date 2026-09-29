'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import styles from './ListFilters.module.css';

/**
 * A LIST'S FILTERS, AND ITS EXPORT — one row above the list.
 *
 * The filter is applied by the SERVER (0228), so it holds across every page scrolled to, and the
 * export takes every matching row rather than the ones on screen. The chips are a choice of one:
 * a shop asks one question of a list at a time ("who owes me?"), and combining them is a report.
 */
export function ListFilters<V extends string>({
  options,
  value,
  onChange,
  onExport,
  exportLabel = 'Export',
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  /** Builds and hands over the file; returns a sentence to show, or null. */
  onExport?: () => Promise<string | null>;
  exportLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className={styles.wrap}>
      <div className={styles.chips} role="tablist" aria-label="Show">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={value === o.value}
            className={`${styles.chip} ${value === o.value ? styles.chipOn : ''}`}
            onClick={() => {
              setNote(null);
              onChange(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {onExport && (
        <Button
          variant="secondary"
          size="small"
          busy={busy}
          busyLabel="Preparing"
          onClick={async () => {
            setBusy(true);
            setNote(null);
            try {
              setNote(await onExport());
            } catch (e) {
              setNote(e instanceof Error ? e.message : 'Could not export the list.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {exportLabel}
        </Button>
      )}
      {note && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
    </div>
  );
}
