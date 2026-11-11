'use client';

import { MinusIcon, PlusIcon } from '@/components/ui/Icon';
import { Qty } from '@/components/ui/Qty';
import styles from './ContainersBack.module.css';

export interface ContainerRow {
  /** The shape (product unit) the containers are counted in. */
  id: string;
  name: string;
  unitName: string;
  unitPlural: string;
  /** Went out with the receipt. */
  out: number;
  /** Came back with it — the figure being set. */
  back: number;
  /** The highest it may be set to: what went out, or more when older crates were already recorded. */
  max: number;
  /** What it stood at before this screen, to mark a change. */
  was?: number;
}

/**
 * WHAT CAME BACK WITH THIS RECEIPT, one row per container shape — out, and back with − and +.
 *
 * "Recording and undoing empties returned should be better and faster, with less input, because
 * sometimes the same quantity out is the same in." So the common answer is one tap: All back (or None,
 * which is how "they did not bring those back after all" is said). A row is the exception: the − goes
 * below what was recorded, which is the undo — there is no separate place to take a return back.
 *
 * Only the figures: saving is the page's — the receipt saves at once, a correction with the rest of it.
 */
export function ContainersBack({
  rows,
  onChange,
  onAll,
  disabled = false,
}: {
  rows: ContainerRow[];
  onChange: (id: string, back: number) => void;
  /** All back / None back as one finished answer (the receipt saves it at once); else row by row. */
  onAll?: (targets: Record<string, number>) => void;
  disabled?: boolean;
}) {
  const setAll = (pick: (r: ContainerRow) => number) => {
    const targets = Object.fromEntries(rows.map((r) => [r.id, pick(r)]));
    if (onAll) onAll(targets);
    else rows.forEach((r) => onChange(r.id, targets[r.id]));
  };
  const allBack = rows.every((r) => r.back >= r.out);
  const noneBack = rows.every((r) => r.back <= 0);
  const word = (r: ContainerRow, n: number) => (n === 1 ? r.unitName : r.unitPlural).toLowerCase();

  return (
    <div className={styles.box}>
      <div className={styles.quick} role="group" aria-label="All at once">
        <button
          type="button"
          className={`${styles.quickBtn} ${allBack ? styles.quickOn : ''}`}
          aria-pressed={allBack}
          disabled={disabled}
          onClick={() => setAll((r) => Math.max(r.out, Math.min(r.back, r.max)))}
        >
          All back
        </button>
        <button
          type="button"
          className={`${styles.quickBtn} ${noneBack ? styles.quickOn : ''}`}
          aria-pressed={noneBack}
          disabled={disabled}
          onClick={() => setAll(() => 0)}
        >
          None back
        </button>
      </div>

      <ul className={styles.list}>
        {rows.map((r) => {
          const left = Math.max(r.out - r.back, 0);
          const changed = r.was !== undefined && Math.abs(r.was - r.back) > 1e-9;
          return (
            <li key={r.id} className={styles.row}>
              <span className={styles.what}>
                <span className={styles.name}>{r.name}</span>
                <span className={styles.meta}>
                  <Qty value={r.out} /> {word(r, r.out)} went out
                  {' · '}
                  {left > 0 ? (
                    <span className={styles.left}>
                      <Qty value={left} /> still with them
                    </span>
                  ) : r.back > r.out ? (
                    <span>
                      <Qty value={r.back - r.out} /> older {word(r, r.back - r.out)} too
                    </span>
                  ) : (
                    <span className={styles.done}>all back</span>
                  )}
                  {changed && (
                    <span className={styles.was}>
                      {' '}
                      (was <Qty value={r.was!} />)
                    </span>
                  )}
                </span>
              </span>
              <span className={styles.stepper}>
                <button
                  type="button"
                  className={styles.step}
                  disabled={disabled || r.back <= 0}
                  // A whole step down; from a part ("1½") to the whole below it.
                  onClick={() => onChange(r.id, Math.max(0, Number.isInteger(r.back) ? r.back - 1 : Math.floor(r.back)))}
                  aria-label={`One less ${r.name} back`}
                >
                  <MinusIcon />
                </button>
                <span className={styles.qty} aria-live="polite">
                  <Qty value={r.back} />
                  <span className={styles.qtyWord}>back</span>
                </span>
                <button
                  type="button"
                  className={styles.step}
                  disabled={disabled || r.back >= r.max}
                  onClick={() => onChange(r.id, Math.min(r.max, Math.floor(r.back) + 1))}
                  aria-label={`One more ${r.name} back`}
                >
                  <PlusIcon />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
