'use client';

import { useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { CheckIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { messageOf } from '@/lib/format';
import { setCountGate, useCountGateSettings, WEEKDAYS } from '@/lib/stacks/count-gate-settings';
import styles from './count-gate-settings-page.module.css';

/**
 * REPEAT — the days a relaxed count gate counts, picked the way an alarm's are: "Every Monday" to
 * "Every Sunday", each a tick. Saved as it is tapped.
 */
export default function CountDaysPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const gate = useCountGateSettings(store?.id ?? null);
  const [busy, setBusy] = useState<number | null>(null);

  if (!store) return null;

  const status: PageStatus = gate.data
    ? { state: 'ready' }
    : gate.error
      ? { state: 'error', what: 'the count days', error: gate.error, onRetry: gate.reload }
      : { state: 'loading', what: 'the count days' };

  const toggle = async (iso: number) => {
    if (!gate.data) return;
    const days = gate.data.days.includes(iso)
      ? gate.data.days.filter((d) => d !== iso)
      : [...gate.data.days, iso];
    setBusy(iso);
    try {
      // Picking days is choosing Relaxed.
      await setCountGate(store.id, 'relaxed', days);
      gate.reload();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be saved.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PageScaffold onBack={goBack} title="Repeat" subtitle="The days the shelf is counted">
      <ProblemDialog problem={problem} title="Not saved" />
      <PageState status={status}>
        {() =>
          gate.data && (
            <ul className={styles.days}>
              {WEEKDAYS.map((w) => {
                const on = gate.data!.days.includes(w.iso);
                return (
                  <li key={w.iso}>
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      className={styles.day}
                      disabled={busy !== null}
                      onClick={() => void toggle(w.iso)}
                    >
                      <span>Every {w.name}</span>
                      {on && (
                        <span className={styles.dayTick}>
                          <CheckIcon />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
