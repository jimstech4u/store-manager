'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { messageOf } from '@/lib/format';
import {
  daysInWords,
  setCountGate,
  useCountGateSettings,
  type CountGateMode,
} from '@/lib/stacks/count-gate-settings';
import styles from './count-gate-settings-page.module.css';

/**
 * THE COUNT GATE — how strictly the shelf must be counted before it sells.
 *
 * "Ashabi has over 30 items and counting every day is a challenge. We are not removing the count gate
 * but controlling it." Two ways, chosen here; Relaxed's days are picked on the next page, the way an
 * alarm's Repeat is. "Count when an item runs low" lives with the Running low settings.
 */
export default function CountGateSettingsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const problem = useProblem();
  const gate = useCountGateSettings(store?.id ?? null);
  const [saving, setSaving] = useState<CountGateMode | null>(null);

  if (!store) return null;

  const status: PageStatus = gate.data
    ? { state: 'ready' }
    : gate.error
      ? { state: 'error', what: 'the count gate', error: gate.error, onRetry: gate.reload }
      : { state: 'loading', what: 'the count gate' };

  const choose = async (mode: CountGateMode) => {
    if (!gate.data || gate.data.mode === mode) return;
    setSaving(mode);
    try {
      await setCountGate(store.id, mode, gate.data.days);
      gate.reload();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be saved.'));
    } finally {
      setSaving(null);
    }
  };

  const options: { mode: CountGateMode; title: string; body: string }[] = [
    {
      mode: 'aggressive',
      title: 'Aggressive',
      body: 'Every day. An item is counted before anything of it goes out.',
    },
    {
      mode: 'relaxed',
      title: 'Relaxed',
      body: 'Only on the days you pick. On other days items sell without a count.',
    },
  ];

  return (
    <PageScaffold onBack={goBack} title="Count gate" subtitle="When the shelf must be counted before it sells">
      <ProblemDialog problem={problem} title="Not saved" />
      <PageState status={status}>
        {() =>
          gate.data && (
            <>
              <div className={styles.options} role="radiogroup" aria-label="How the count gate works">
                {options.map((o) => {
                  const on = gate.data!.mode === o.mode;
                  return (
                    <button
                      key={o.mode}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`${styles.option} ${on ? styles.optionOn : ''}`}
                      disabled={saving !== null}
                      onClick={() => void choose(o.mode)}
                    >
                      <span className={`${styles.radio} ${on ? styles.radioOn : ''}`} aria-hidden="true" />
                      <span className={styles.optionBody}>
                        <span className={styles.optionTitle}>{o.title}</span>
                        <span className={styles.optionNote}>{o.body}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {gate.data.mode === 'relaxed' && (
                <>
                  <button
                    type="button"
                    className={styles.repeat}
                    onClick={() => void nav.push('count_days_page')}
                  >
                    <span className={styles.repeatLabel}>Repeat</span>
                    <span className={styles.repeatValue}>{daysInWords(gate.data.days)}</span>
                    <ChevronRightIcon />
                  </button>
                  {gate.data.days.length === 0 && (
                    <InfoPanel tone="warning" title="No count days picked">
                      Nothing is counted on any day until you pick at least one — only items that run
                      low, if you have turned that on under Running low.
                    </InfoPanel>
                  )}
                  {gate.data.days.length === 7 && (
                    <p className={styles.note}>Every day is ticked: that works the same as Aggressive.</p>
                  )}
                  <p className={styles.note}>
                    {gate.data.days.includes(gate.data.today)
                      ? 'Today is a count day.'
                      : 'Today is not a count day.'}
                  </p>
                </>
              )}
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
