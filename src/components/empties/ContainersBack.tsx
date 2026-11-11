'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { CheckIcon, MinusIcon, PlusIcon } from '@/components/ui/Icon';
import { formatQtySpoken } from '@/lib/format';
import { saidInShapes, splitShapes, type Shape } from '@/lib/empties-back';
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
  /**
   * The shapes it can come back in, the container's own first (`shapesOf`): crates, packs, bottles.
   * Fewer than two: counted in the container alone, with its fraction.
   */
  shapes?: Shape[];
}

/** "1 crate 3 bottles" — the figure the way the shop counts it. */
export const saidRow = (r: ContainerRow, n: number) =>
  saidInShapes(n, r.shapes ?? [], { name: r.unitName, plural: r.unitPlural }, formatQtySpoken);

/**
 * WHAT CAME BACK WITH THIS RECEIPT.
 *
 * "Recording and undoing empties returned should be better and faster, with less input, because
 * sometimes the same quantity out is the same in." So the two common answers are one tap each and
 * stand alone: All came back, None came back. Everything else is folded under them —
 * "maybe we could have the individual breakdowns under a dropdown" (11 Nov) — and opens by itself
 * only when the answer already is a part, or a count has been changed.
 *
 * COUNTED IN EVERY SHAPE IT COMES BACK IN. "We can have part returned, not always all or none, or even
 * the smaller shapes, like 3 bottles from 1 crate of Goldberg of 12 bottles", and "plan for when we
 * have a larger number of shapes for a product". So under each item, one line per shape — crates,
 * packs, bottles, as many as the item has — each with − and + and a figure that takes typing. Counts
 * carry: 15 bottles of a 12-bottle crate is 1 crate 3 bottles. The − below what was recorded is the
 * undo. ONLY THE SHAPES THAT FIT what went out: half a crate sold is six bottles back at most, so it
 * is asked in bottles, with no crate line to press.
 *
 * TWO BUTTONS THAT SAY WHAT THEY DO. They were a pair of tabs, read as a switch between two views: a
 * tap saved with nothing to say so, and the owner tapped back and forth eleven times on one receipt.
 * Each is a button naming the answer; the recorded one is ticked and cannot be pressed again — except
 * while the question is still being ASKED (at the counter, before the paper prints), when neither is
 * ticked and either is the answer, even one that needs nothing written ("None" on a fresh sale).
 *
 * Only the figures: saving is the page's — the receipt saves at once, a correction with the rest of it.
 */
export function ContainersBack({
  rows,
  onChange,
  onAll,
  onAnswer,
  asking = false,
  disabled = false,
  saving = false,
  status,
}: {
  rows: ContainerRow[];
  onChange: (id: string, back: number) => void;
  /** All came back / None came back as one finished answer (the receipt saves it at once); else row by row. */
  onAll?: (targets: Record<string, number>) => void;
  /** The tapped answer is already what stands: nothing to write, but it is an answer. */
  onAnswer?: (which: 'all' | 'none') => void;
  /** Still being asked: neither answer is ticked, and both can be given. */
  asking?: boolean;
  disabled?: boolean;
  /** A save is under way: the buttons say so and wait. */
  saving?: boolean;
  /** What was just saved, said under the buttons ("Saved: … · Undo"). */
  status?: ReactNode;
}) {
  const allTarget = (r: ContainerRow) => Math.max(r.out, Math.min(r.back, r.max));
  const give = (which: 'all' | 'none') => {
    const targets = Object.fromEntries(rows.map((r) => [r.id, which === 'all' ? allTarget(r) : 0]));
    const same = rows.every((r) => Math.abs(targets[r.id] - r.back) < 1e-6);
    if (same) return onAnswer?.(which);
    if (onAll) onAll(targets);
    else rows.forEach((r) => onChange(r.id, targets[r.id]));
  };
  const allBack = rows.every((r) => r.back >= r.out - 1e-6);
  const noneBack = rows.every((r) => r.back <= 1e-6);
  const shut = (isIt: boolean) => disabled || saving || (isIt && !asking);

  // The breakdown: shut until it is the answer — a part already recorded, or a count changed here.
  const changed = rows.some((r) => r.was !== undefined && Math.abs(r.was - r.back) > 1e-6);
  const part = !allBack && !noneBack;
  const [open, setOpen] = useState(part || changed);
  useEffect(() => {
    if (part || changed) setOpen(true);
  }, [part, changed]);
  const outAll = rows.reduce((n, r) => n + r.out, 0);
  const backAll = rows.reduce((n, r) => n + Math.min(r.back, r.out), 0);
  const unit = (rows[0]?.unitPlural || 'containers').toLowerCase();

  return (
    <div className={styles.box}>
      <div className={styles.quick} role="group" aria-label="All at once">
        <Button
          size="small"
          variant={allBack && !asking ? 'secondary' : 'primary'}
          disabled={shut(allBack)}
          busy={saving}
          busyLabel="Saving"
          onClick={() => give('all')}
        >
          {allBack && !asking ? <><CheckIcon /> All came back</> : 'All came back'}
        </Button>
        <Button size="small" variant="secondary" disabled={shut(noneBack)} onClick={() => give('none')}>
          {noneBack && !asking ? <><CheckIcon /> None came back</> : 'None came back'}
        </Button>
      </div>
      {status && (
        <p className={styles.status} role="status">
          {status}
        </p>
      )}

      <button
        type="button"
        className={styles.more}
        aria-expanded={open}
        aria-controls="containers-back-rows"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.moreWhat}>{open ? 'Each item' : 'Some came back? Count each item'}</span>
        <span className={styles.moreSum}>
          {formatQtySpoken(backAll)} of {formatQtySpoken(outAll)} {unit} back
        </span>
        <span className={`${styles.chev} ${open ? styles.chevOpen : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul className={styles.list} id="containers-back-rows">
          {rows.map((r) => (
            <Row key={r.id} r={r} onChange={onChange} off={disabled || saving} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One item: what went out and what is still with them, then a line per shape it comes back in. */
function Row({ r, onChange, off }: { r: ContainerRow; onChange: (id: string, back: number) => void; off: boolean }) {
  const left = Math.max(r.out - r.back, 0);
  const changed = r.was !== undefined && Math.abs(r.was - r.back) > 1e-6;
  const shapes = r.shapes ?? [];
  const many = shapes.length >= 2;

  let lines: ReactNode;
  if (!many) {
    // One shape: the container, with its fraction ("1/2" stays a half), stepped a whole at a time.
    const set = (n: number) => onChange(r.id, Math.max(0, Math.min(r.max, Math.round(n * 10000) / 10000)));
    lines = (
      <ShapeLine
        label={r.unitPlural.toLowerCase()}
        name={r.name}
        value={r.back}
        disabled={off}
        canDown={r.back > 1e-6}
        canUp={r.back < r.max - 1e-6}
        onDown={() => set(Number.isInteger(r.back) ? r.back - 1 : Math.floor(r.back))}
        onUp={() => set(Math.floor(r.back) + 1)}
        onType={set}
      />
    );
  } else {
    // In base units (bottles), so every shape steps by its own size and counts carry between them.
    const C = shapes[0].base;
    // To the smallest shape: the ledger's four places make 23 of 24 cans 22.999 of them.
    const grain = shapes[shapes.length - 1].base;
    const total = Math.round((r.back * C) / grain) * grain;
    const cap = r.max * C;
    const counts = splitShapes(r.back, shapes);
    const set = (base: number) =>
      onChange(r.id, Math.max(0, Math.round((Math.min(base, cap) / C) * 10000) / 10000));
    lines = shapes.map((s, i) =>
      // Only the shapes that fit what went out: half a crate is asked in bottles, not crates.
      s.base > cap + 1e-6 ? null : (
        <ShapeLine
          key={s.base}
          label={s.plural.toLowerCase()}
          name={r.name}
          value={counts[i]}
          disabled={off}
          canDown={total >= s.base - 1e-6}
          canUp={total + s.base <= cap + 1e-6}
          onDown={() => set(total - s.base)}
          onUp={() => set(total + s.base)}
          onType={(n) => set(total - counts[i] * s.base + n * s.base)}
        />
      ),
    );
  }

  return (
    <li className={styles.row}>
      <span className={styles.what}>
        <span className={styles.name}>{r.name}</span>
        <span className={styles.meta}>
          {saidRow(r, r.out)} went out
          {' · '}
          {left > 1e-6 ? (
            <span className={styles.left}>{saidRow(r, left)} still with them</span>
          ) : r.back > r.out + 1e-6 ? (
            <span>{saidRow(r, r.back - r.out)} older too</span>
          ) : (
            <span className={styles.done}>all back</span>
          )}
          {changed && <span className={styles.was}> (was {saidRow(r, r.was!)})</span>}
        </span>
      </span>
      <span className={styles.shapes}>{lines}</span>
    </li>
  );
}

/**
 * ONE SHAPE'S LINE: its name, then − , the figure (typed into when stepping would take too long —
 * twenty crates is twenty taps), + . A line per shape, so five shapes are five lines, not a row that
 * runs off a phone.
 */
function ShapeLine({
  label,
  name,
  value,
  disabled,
  canDown,
  canUp,
  onDown,
  onUp,
  onType,
}: {
  label: string;
  name: string;
  value: number;
  disabled: boolean;
  canDown: boolean;
  canUp: boolean;
  onDown: () => void;
  onUp: () => void;
  onType: (n: number) => void;
}) {
  const shown = formatQtySpoken(value);
  const [text, setText] = useState(shown);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setText(shown);
  }, [shown, typing]);

  return (
    <span className={styles.shapeLine}>
      <span className={styles.shapeName}>{label}</span>
      <span className={styles.stepper}>
        <button
          type="button"
          className={styles.step}
          disabled={disabled || !canDown}
          onClick={onDown}
          aria-label={`One less ${label} of ${name} back`}
        >
          <MinusIcon />
        </button>
        <input
          className={styles.qtyInput}
          inputMode="numeric"
          value={text}
          disabled={disabled}
          aria-label={`${label} of ${name} back`}
          onFocus={(e) => {
            setTyping(true);
            e.currentTarget.select();
          }}
          onBlur={() => setTyping(false)}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d]/g, '');
            setText(t);
            if (t !== '') onType(Number(t));
          }}
        />
        <button
          type="button"
          className={styles.step}
          disabled={disabled || !canUp}
          onClick={onUp}
          aria-label={`One more ${label} of ${name} back`}
        >
          <PlusIcon />
        </button>
      </span>
    </span>
  );
}
