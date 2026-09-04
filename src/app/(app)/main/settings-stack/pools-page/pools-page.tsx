'use client';

import { useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { PlusIcon, TrashIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { usePermission } from '@/hooks/usePermission';
import { useAuth } from '@/providers/AuthProvider';
import { archivePool, createPool, savePool, usePools, type Pool } from '@/lib/stacks/empties-pools';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './pools-page.module.css';

/**
 * The crates and bottles this shop deals in, and what it usually holds against them.
 *
 * A pool is what a deposit is charged against and a return is counted in. "NBL crate" holds ₦1,500
 * in this shop and "NBL bottle" ₦125 — and until now both figures were seeded by a migration and
 * could not be changed by anybody. `save_empties_category` was written in 0082 for a screen that
 * was never built; it edits only, so there was no way to make the first pool either.
 *
 * The DEPOSIT here is a starting point, not a price. Deposits are agreed at the counter, per
 * customer and per load, and the till offers this figure and lets the seller type over it. That is
 * why the column is called "usually".
 */
export default function PoolsPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const problem = useProblem();
  const showProblem = problem.show;
  const confirm = useConfirm();

  const { pools } = usePools(store?.id ?? null);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'content' | 'container'>('container');
  const [deposit, setDeposit] = useState('');
  const [busy, setBusy] = useState(false);
  /** The pool being retired, and the question about it. Null when nothing is being asked. */
  const [retiring, setRetiring] = useState<Pool | null>(null);

  /** Which pool is being edited, and what it now says. Kept per id so two are never confused. */
  const [edits, setEdits] = useState<Record<string, { name: string; deposit: string }>>({});

  if (!store) return null;

  if (!can('deposits.manage')) {
    return (
      <PageScaffold onBack={goBack} title="Crates and bottles">
        <InfoPanel tone="info" title="Ask the owner">
          Changing what the shop holds against a crate is an owner&rsquo;s job. You can still take
          deposits and settle returns.
        </InfoPanel>
      </PageScaffold>
    );
  }

  const add = async () => {
    setBusy(true);
    try {
      await createPool({
        storeId: store.id,
        name: name.trim(),
        kind,
        deposit: Number(deposit) || 0,
      });
      setName('');
      setDeposit('');
      setAdding(false);
    } catch (e) {
      showProblem(messageOf(e, 'That pool could not be added.'));
    } finally {
      setBusy(false);
    }
  };

  const save = async (pool: Pool) => {
    const edit = edits[pool.id];
    if (!edit) return;
    setBusy(true);
    try {
      await savePool({
        id: pool.id,
        name: edit.name.trim() || pool.name,
        deposit: Number(edit.deposit) || 0,
      });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[pool.id];
        return next;
      });
    } catch (e) {
      showProblem(messageOf(e, 'That change could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (pool: Pool) => {
    setBusy(true);
    try {
      await archivePool(pool.id);
    } catch (e) {
      // The server refuses while customers are still holding containers, and says how many.
      showProblem(messageOf(e, 'That pool could not be retired.'));
    } finally {
      setBusy(false);
      setRetiring(null);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="Crates and bottles"
      subtitle="What comes back, and what you hold against it"
    >
      <ProblemDialog problem={problem} title="Not saved" />
      {/*
        MOUNTED ONLY WHILE THE QUESTION IS BEING ASKED.

        The package leaves its overlay in the page when the dialog closes, and that overlay swallows
        taps meant for what is behind it — the sell screen once stopped responding to anything at
        all. `unmountOnClose` did not remove it, so the mounting is decided here.
      */}
      {retiring && (
        <ConfirmDialog
          controller={confirm}
          title={`Stop using ${retiring.name}?`}
          message={
            retiring.inUse
              ? 'It stays on every receipt that already mentions it. It just stops being offered on new sales.'
              : 'Nothing has ever gone out against this one, so nothing changes except that it stops being offered.'
          }
          confirmText="Stop using it"
          tone="danger"
          onDismiss={() => setRetiring(null)}
          onConfirm={() => void retire(retiring)}
        />
      )}

      <InfoPanel tone="info" id="pools-what" title="What these are">
        <p>
          A pool is what a deposit is charged against and a return is counted in. Two Gulder crates
          and two Star crates are four <strong>NBL crates</strong>, because that is what goes on the
          pallet and what the depot pays for.
        </p>
        <Explain label="Why is the deposit only a starting point?">
          Because a deposit has no fixed rate in this trade. It is agreed at the counter — ₦125 a
          crate for one customer, nothing for the one who has bought here for ten years, a round
          figure for a load. The till offers this figure and the seller types over it.
        </Explain>
      </InfoPanel>

      {pools.length === 0 && !adding && (
        <InfoPanel tone="warning" title="No pools yet">
          Nothing can be sold as returnable until there is a pool for it to come back into.
        </InfoPanel>
      )}

      <ul className={styles.list}>
        {pools.map((pool) => {
          const edit = edits[pool.id];
          const dirty =
            edit != null &&
            (edit.name.trim() !== pool.name || Number(edit.deposit) !== Number(pool.deposit));

          return (
            <li className={styles.item} key={pool.id}>
              <div className={styles.itemHead}>
                <span className={styles.kind}>
                  {pool.kind === 'container' ? 'A container' : "What is inside it"}
                </span>
                <button
                  type="button"
                  className={styles.retire}
                  onClick={() => setRetiring(pool)}
                  disabled={busy}
                  aria-label={`Stop using ${pool.name}`}
                >
                  <TrashIcon />
                </button>
              </div>

              <Field
                label="What you call it"
                value={edit ? edit.name : pool.name}
                onChange={(e) =>
                  setEdits((prev) => ({
                    ...prev,
                    [pool.id]: {
                      name: e.target.value,
                      deposit: prev[pool.id]?.deposit ?? String(pool.deposit),
                    },
                  }))
                }
              />

              <Field
                label="You usually hold"
                numeric
                prefix="₦"
                value={edit ? edit.deposit : String(pool.deposit)}
                onChange={(e) =>
                  setEdits((prev) => ({
                    ...prev,
                    [pool.id]: {
                      name: prev[pool.id]?.name ?? pool.name,
                      deposit: e.target.value,
                    },
                  }))
                }
                hint={
                  Number(edit ? edit.deposit : pool.deposit) > 0
                    ? `The till will offer ${formatMoney(Number(edit ? edit.deposit : pool.deposit))} and let the seller change it`
                    : 'Nothing offered — the seller types what was agreed'
                }
              />

              {/* Saving only appears once something has changed: a button that does nothing is a
                  button somebody presses to find out what it does. */}
              {dirty && (
                <Button fullWidth busy={busy} onClick={() => void save(pool)}>
                  Save {pool.name}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className={styles.adder}>
          <h2 className={styles.adderTitle}>A new pool</h2>

          <Field
            label="What you call it"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NBL crate"
            autoFocus
          />

          {/*
            THE KIND, asked once and never editable.

            Changing it later would silently re-answer every outstanding obligation — the same
            containers counted a different way — so a pool of the wrong kind is retired and
            replaced rather than corrected.
          */}
          <div className={styles.kindPick}>
            <span className={styles.kindLabel}>What comes back</span>
            <div className={styles.kindRow}>
              <button
                type="button"
                className={`${styles.kindOption} ${kind === 'container' ? styles.kindOn : ''}`}
                aria-pressed={kind === 'container'}
                onClick={() => setKind('container')}
              >
                The container
                <span className={styles.kindWhy}>A crate, a keg, a dispenser bottle</span>
              </button>
              <button
                type="button"
                className={`${styles.kindOption} ${kind === 'content' ? styles.kindOn : ''}`}
                aria-pressed={kind === 'content'}
                onClick={() => setKind('content')}
              >
                What was inside
                <span className={styles.kindWhy}>The bottles that came in the crate</span>
              </button>
            </div>
          </div>

          <Field
            label="You usually hold"
            optional
            numeric
            prefix="₦"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            placeholder="0"
            hint="A starting point for the till. Leave it blank if you never charge one."
          />

          <div className={styles.adderActions}>
            <Button
              variant="secondary"
              fullWidth
              onClick={() => setAdding(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button fullWidth busy={busy} disabled={name.trim() === ''} onClick={() => void add()}>
              Add it
            </Button>
          </div>
        </div>
      ) : (
        /* GREEN, because it is the control that turns what has been typed into a line. */
        <Button size="large" fullWidth onClick={() => setAdding(true)}>
          <PlusIcon /> Add a pool
        </Button>
      )}
    </PageScaffold>
  );
}
