'use client';

import { useEffect, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { countFromTill } from '@/lib/stacks/mid-sale';
import { formatQty, messageOf } from '@/lib/format';
import styles from './CountGate.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

/**
 * "How many are on the shelf?" — asked once, at the counter, the first time an item is sold today.
 *
 * COUNTING EVERYTHING BEFORE TRADING IS THE ALTERNATIVE, and it does not survive contact with a
 * real shop. A distributor carrying eight hundred lines cannot count them before opening, and most
 * of that catalogue will not be touched today, so the counting would be wasted as well as
 * impossible. The item somebody is selling is exactly the item worth counting, and the moment it
 * is first sold is exactly when a person is standing in front of it.
 *
 * IT DOES NOT BLOCK THE SALE. The line is already on the receipt; this asks for a figure and lets
 * the seller carry on. Skipping is allowed and says what it costs — a day's movement for that item
 * cannot be reconciled — because a seller with a customer waiting will find a way past a wall, and
 * the way they find is paper.
 */
export function CountGate({
  open,
  onClose,
  items,
  onCounted,
}: {
  open: boolean;
  onClose: () => void;
  /** The lines on this receipt that owe a count, in the unit the shop sells them in. */
  items: {
    productId: string;
    productName: string;
    unitName: string;
    unitPlural: string;
    /** How many base units one of those is — the count is stored in base units. */
    baseQty: number;
  }[];
  /** Told which items have been answered for, so the till stops asking about them. */
  onCounted: (productIds: string[]) => void;
}) {
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  // A fresh set of items is a fresh set of questions.
  useEffect(() => {
    if (open) {
      setCounts({});
    }
  }, [open, items.length]);

  const answered = items.filter((i) => {
    const n = Number(counts[i.productId]);
    return counts[i.productId]?.trim() !== '' && Number.isFinite(n) && n >= 0;
  });

  const save = async () => {
    setBusy(true);
    try {
      const done: string[] = [];
      for (const i of answered) {
        // Entered in the unit the shop sells in; the ledger speaks base units.
        await countFromTill(i.productId, Number(counts[i.productId]) * i.baseQty);
        done.push(i.productId);
      }
      onCounted(done);
      onClose();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={items.length === 1 ? 'Count this one first' : 'Count these first'}
      footer={
        <div className={styles.actions}>
          {/*
            Skipping is offered, and says what it costs.

            A seller with a customer waiting will get past a wall one way or another, and the way
            they get past it is paper — which is worse than an uncounted day, because then the sale
            is missing too.
          */}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button busy={busy} disabled={answered.length === 0} onClick={() => void save()}>
            {answered.length > 1 ? `Save ${answered.length} counts` : 'Save the count'}
          </Button>
        </div>
      }
    >
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not recorded" />

      <p className={styles.lead}>
        {items.length === 1 ? 'This has' : 'These have'} not been counted today. Say what is on the
        shelf now and the day starts from a figure somebody checked, rather than from what the
        records assumed.
      </p>

      <ul className={styles.list}>
        {items.map((i) => (
          <li key={i.productId} className={styles.row}>
            <Field
              label={i.productName}
              numeric
              autoFocus={items.length === 1}
              value={counts[i.productId] ?? ''}
              onChange={(e) => setCounts((c) => ({ ...c, [i.productId]: e.target.value }))}
              suffix={
                Number(counts[i.productId]) === 1 ? i.unitName : i.unitPlural
              }
              placeholder="0"
              hint={
                i.baseQty !== 1
                  ? `Counted in ${i.unitPlural.toLowerCase()} — one is ${formatQty(i.baseQty)}`
                  : undefined
              }
            />
          </li>
        ))}
      </ul>

      <InfoPanel tone="info" title="Why now and not this morning?">
        Counting a whole shop before opening is not possible past a certain size, and most of it
        would be counting things nobody buys today. This asks about the one item somebody is buying,
        while you are standing in front of it.
      </InfoPanel>
    </BottomSheet>
  );
}
