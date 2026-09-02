'use client';

import { useEffect, useState } from 'react';
import styles from './return-units-page.module.css';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Explain, InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { messageOf } from '@/lib/format';
import { returnUnitsFor, saveReturnUnits, type ReturnUnit } from '@/lib/stacks/empties';

/**
 * What shape a pool comes back in.
 *
 * «goldberg has to be returned in full crate or half»
 * «customer could return heineken full crate back to get gulder and not half»
 *
 * DECLARED ON THE POOL, not the product, and that is what makes the second sentence work rather
 * than being a special case. The obligation is settled against the pool — a Star bottle pays back a
 * Gulder bottle — so "one NBL crate" is the shape a return takes whichever beer was in it. Hang the
 * rule off a product and the same crate means different things depending on which one, which is the
 * confusion the pools exist to end.
 *
 * A pool with nothing declared accepts any quantity, and that is the right default: a shop that has
 * not said "whole crates only" has not said anything, and refusing its returns would be inventing a
 * rule it never made.
 */
export default function ReturnUnitsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const problem = useProblem();
  /*
   * Bound to a local, and the load effect depends on THIS rather than on `problem`.
   *
   * `useProblem` returns a memoised object, but its `controller` comes from `useDialog` and is a
   * fresh object every render — so the memo changes every render too. An effect depending on it
   * therefore re-ran constantly, and this one FETCHES: every keystroke reloaded the shapes from the
   * server and overwrote the one just added. The composer cleared, the list stayed empty, and
   * nothing saved. `show` is `useCallback(..., [])` and never changes.
   */
  const showProblem = problem.show;

  const categoryId = (location?.params?.id as string | undefined) ?? null;

  const [units, setUnits] = useState<ReturnUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // The composer: one set of inputs and an Add button, with what has been added listed above it.
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');

  useEffect(() => {
    if (!categoryId) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await returnUnitsFor(categoryId);
        if (!cancelled) setUnits(rows);
      } catch (e) {
        if (!cancelled) showProblem(messageOf(e, 'Could not read what this comes back in.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [categoryId, showProblem]);

  if (!categoryId) return null;
  if (loading) return <FullPageMessage title="Reading the shapes" tone="loading" />;

  const save = async () => {
    setBusy(true);
    try {
      await saveReturnUnits(
        categoryId,
        units.map((u, i) => ({
          name: u.name,
          base_qty: Number(u.base_qty),
          is_default: i === 0,
        })),
      );
      await nav.pop();
    } catch (e) {
      showProblem(messageOf(e, 'Those shapes could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title="What shape it comes back in"
      subtitle="Shared with every item in this pool"
    >
      <ProblemDialog problem={problem} title="Not saved" />

      <InfoPanel tone="info" id="empties.shapes" title="Why say this?">
        <p>
          If you only take crates back whole, say so and the counter will stop somebody recording
          seven loose bottles. Leave it empty and any amount is accepted, which is how it works
          today.
        </p>
        <p>
          This belongs to the POOL, so it covers every item that settles against it — that is what
          lets a customer bring back a crate of one beer to clear another.
        </p>
      </InfoPanel>

      {units.length > 0 && (
        <ul className={styles.list}>
          {units.map((u) => (
            <li key={u.id || u.name} className={styles.row}>
              <span>
                <span className={styles.name}>{u.name}</span>
                <span className={styles.meta}>{Number(u.base_qty)} to one</span>
              </span>
              <button
                type="button"
                className={styles.remove}
                onClick={() => setUnits((prev) => prev.filter((x) => x.name !== u.name))}
                aria-label={`Remove ${u.name}`}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        ONE COMPOSER, not a fixed row of boxes per possible shape. Nobody can name every shape a
        crate might come in, and a screen that tries has empty fields for the ones that do not apply.
      */}
      <div className={styles.grid}>
        <Field
          label="What you call it"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full crate"
        />
        <Field
          label="How many to one"
          numeric
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="12"
        />
      </div>

      <Button
        fullWidth
        disabled={!name.trim() || !(Number(qty) > 0) || units.some((u) => u.name === name.trim())}
        onClick={() => {
          setUnits((prev) => [
            ...prev,
            { id: '', name: name.trim(), base_qty: qty, is_default: prev.length === 0 },
          ]);
          setName('');
          setQty('');
        }}
      >
        <PlusIcon /> Add this shape
      </Button>

      <Explain label="What counts as a whole one?">
        <p>
          A return has to be a whole number of one of these. With a full crate of 12 and a half of
          6: twelve is fine, six is fine, eighteen is fine — it is three halves. Seven is not, and
          the counter will say so before anything is recorded.
        </p>
      </Explain>

      <div className={styles.actions}>
        <Button variant="secondary" fullWidth onClick={goBack} disabled={busy}>
          Cancel
        </Button>
        <Button fullWidth busy={busy} busyLabel="Saving" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </PageScaffold>
  );
}
