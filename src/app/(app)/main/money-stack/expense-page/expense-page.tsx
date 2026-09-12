'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { recordExpense, useExpenseCategories } from '@/lib/stacks/expenses';
import { messageOf } from '@/lib/format';
import styles from './expense-page.module.css';

const METHODS = [
  { code: 'cash', label: 'Cash' },
  { code: 'transfer', label: 'Transfer' },
  { code: 'pos', label: 'Card' },
  { code: 'other', label: 'Other' },
] as const;

/**
 * Money going out.
 *
 * A FORM, SO A PAGE — the rule every other form here follows, and for the same reasons: a sheet's
 * local state does not survive a rotation, and the keyboard covers the half being typed into.
 *
 * WHAT IT IS FOR IS NEVER OPTIONAL. An amount with no reason cannot be questioned six weeks later,
 * and being questioned is the entire purpose of an expense record. The CATEGORY is optional, and
 * typed rather than chosen from a fixed list: nobody can name every cost a business has, and a
 * screen that tries has ten empty fields for the nine that do not apply today. What the shop has
 * called things before is offered as chips, so the second fuel entry is one tap.
 */
export default function ExpensePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const { categories } = useExpenseCategories(store?.id ?? null);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('');
  const [method, setMethod] = useState<string>('cash');
  const [paidTo, setPaidTo] = useState('');
  const [state, setState] = useState<AsyncState>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  if (!store) return null;

  const save = async () => {
    setState('busy');
    setProblem(null);
    try {
      await recordExpense({
        storeId: store.id,
        amount: Number(amount),
        note: note.trim(),
        category: category.trim() || null,
        method,
        paidTo: paidTo.trim() || null,
      });
      setState('idle');
      void nav.pop();
    } catch (e) {
      setState('failed');
      setProblem(messageOf(e, 'Could not record that.'));
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Money going out" subtitle="What the shop spent">
      <Explain label="What counts as this?">
        Anything that leaves the shop and buys no stock — rent, fuel, the generator, transport,
        wages, a levy. Paying a supplier for a delivery is not one of these: that settles their
        account, and it belongs on the supplier.
      </Explain>

      <Field
        label="How much went out?"
        numeric
        prefix="₦"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0"
      />

      <Field
        label="What was it for?"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Diesel for the generator"
        hint="Never optional. In six weeks this is the only thing that can answer for the money."
      />

      {/*
        WHAT THE SHOP HAS CALLED THINGS BEFORE, offered rather than imposed.

        Commonest first, because the second fuel entry should be one tap. Typing a new one is still
        the way to make a new one — the server finds an existing name case-insensitively, so
        "Fuel" and "fuel" total as one cost rather than as two.
      */}
      {categories.length > 0 && (
        <>
          <span className={styles.label}>Put it under</span>
          <div className={styles.chips}>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-pressed={category.toLowerCase() === c.name.toLowerCase()}
                className={`${styles.chip} ${
                  category.toLowerCase() === c.name.toLowerCase() ? styles.chipOn : ''
                }`}
                onClick={() =>
                  setCategory((prev) =>
                    prev.toLowerCase() === c.name.toLowerCase() ? '' : c.name,
                  )
                }
              >
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}

      <Field
        label="Or a new heading"
        optional
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        placeholder="Fuel"
        hint="So you can total it later. Leave it blank if it is a one-off."
      />

      <span className={styles.label}>How did it leave?</span>
      <div className={styles.methods} role="group" aria-label="How it left">
        {METHODS.map((m) => (
          <button
            key={m.code}
            type="button"
            aria-pressed={method === m.code}
            className={`${styles.method} ${method === m.code ? styles.methodOn : ''}`}
            onClick={() => setMethod(m.code)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <Field
        label="Who did it go to?"
        optional
        value={paidTo}
        onChange={(e) => setPaidTo(e.target.value)}
        placeholder="The landlord"
        hint="Free text on purpose — most of these are people you will never file."
      />

      {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
      <div className={styles.actions}>
        <AsyncAction state={state} problem={problem} label="Recording this">
          <Button
            onClick={() => void save()}
            disabled={Number(amount) <= 0 || note.trim() === ''}
            fullWidth
          >
            Record it
          </Button>
        </AsyncAction>
      </div>
    </PageScaffold>
  );
}
