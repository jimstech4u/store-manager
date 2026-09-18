'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { addVarianceReason, type VarianceDirection } from '@/lib/stacks/variance-reasons';
import { messageOf } from '@/lib/format';
import styles from './variance-reason-page.module.css';

/**
 * A reason this shop uses, named by the shop.
 *
 * Reached from the picker that accounts for a count's difference — the same shape as adding a
 * customer or a product where one is chosen, so nobody abandons a half-finished count to go and
 * file something on another screen.
 *
 * TWO QUESTIONS, and the second one is asked in money rather than in ledger words. "Treatment" is
 * our word: what a shop knows is whether the stock really went, whether it was broken, whether the
 * paperwork is simply behind, or whether the count itself was wrong — and those are exactly the
 * choices the books need.
 */
const MEANS = [
  {
    treatment: 'theft',
    label: 'It is gone — a loss',
    hint: 'Nobody can say where it went. Booked at what the stock cost you.',
    direction: 'short' as VarianceDirection,
  },
  {
    treatment: 'unlogged_damage',
    label: 'It was broken or spoiled',
    hint: 'Booked as damage, at what the stock cost you.',
    direction: 'short' as VarianceDirection,
  },
  {
    treatment: 'unrecorded_sale',
    label: 'It was sold, but never entered',
    hint: 'The stock leaves the books. No money is recorded.',
    direction: 'short' as VarianceDirection,
  },
  {
    treatment: 'unrecorded_receipt',
    label: 'It came in, but was never entered',
    hint: 'Added to the books as stock received.',
    direction: 'over' as VarianceDirection,
  },
  {
    treatment: 'miscount',
    label: 'The count was wrong',
    hint: 'Nothing is lost. The count is corrected to what the records say.',
    direction: 'both' as VarianceDirection,
  },
  {
    treatment: 'other',
    label: 'Something else',
    hint: 'Recorded with your note, at what the stock cost you.',
    direction: 'both' as VarianceDirection,
  },
] as const;

const WHEN: { code: VarianceDirection; label: string; hint: string }[] = [
  { code: 'short', label: 'When some is missing', hint: 'Fewer on the shelf than expected' },
  { code: 'over', label: 'When there is more', hint: 'More on the shelf than expected' },
  { code: 'both', label: 'Either way', hint: 'It can explain both' },
];

export default function VarianceReasonPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();

  const [label, setLabel] = useState('');
  const [means, setMeans] = useState<string | null>(null);
  const [when, setWhen] = useState<VarianceDirection | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  if (!store) return null;

  const chosen = MEANS.find((m) => m.treatment === means) ?? null;
  const canSave = label.trim().length > 0 && !!chosen && !!when && !busy;

  const save = async () => {
    if (!chosen || !when) return;
    setBusy(true);
    try {
      await addVarianceReason(store.id, label, chosen.treatment, when);
      void nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That reason could not be saved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold onBack={goBack} title="A reason of your own" subtitle="Used every time you count">
      <ProblemDialog problem={problem} title="Could not save this reason" />

      <InfoPanel tone="info" title="Name it the way your shop says it">
        “Went with the delivery van”, “spoilt in the sun”, “taken for the party”. It joins the list
        everywhere a count is accounted for, and stays there for whoever counts next.
      </InfoPanel>

      <Field
        label="What do you call it?"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Went with the delivery van"
        autoFocus
      />

      {label.trim().length > 0 && (
        <>
          <h2 className={styles.ask}>What does it mean for your money?</h2>
          <div className={styles.options}>
            {MEANS.map((m) => (
              <button
                key={m.treatment}
                type="button"
                className={`${styles.option} ${means === m.treatment ? styles.optionOn : ''}`}
                aria-pressed={means === m.treatment}
                onClick={() => {
                  setMeans(m.treatment);
                  // The commonest answer to the next question, already given.
                  setWhen((w) => w ?? m.direction);
                }}
              >
                <span className={styles.optionName}>{m.label}</span>
                <span className={styles.optionHint}>{m.hint}</span>
              </button>
            ))}
          </div>

          {chosen && (
            <>
              <h2 className={styles.ask}>When does it come up?</h2>
              <div className={styles.options}>
                {WHEN.map((w) => (
                  <button
                    key={w.code}
                    type="button"
                    className={`${styles.option} ${when === w.code ? styles.optionOn : ''}`}
                    aria-pressed={when === w.code}
                    onClick={() => setWhen(w.code)}
                  >
                    <span className={styles.optionName}>{w.label}</span>
                    <span className={styles.optionHint}>{w.hint}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className={styles.action}>
        <Button
          size="large"
          fullWidth
          busy={busy}
          busyLabel="Saving"
          disabled={!canSave}
          onClick={() => void save()}
        >
          Add this reason
        </Button>
      </div>
    </PageScaffold>
  );
}
