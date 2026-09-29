'use client';

import { useState } from 'react';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Explain } from '@/components/ui/Explain';
import { AppVersion } from '@/components/ui/AppVersion';
import { NavReport } from '@/components/ui/NavReport';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { usePermission } from '@/hooks/usePermission';
import { useUpdateReminder } from '@/lib/stacks/update-reminder';
import { messageOf } from '@/lib/format';
import styles from './updates-page.module.css';

/**
 * HOW OFTEN A WAITING UPDATE ASKS AGAIN.
 *
 * One setting, on its own page, because Settings is a list of things to go and do rather than a
 * form with a Save button governing a dozen unrelated fields. It saves as it is changed: a select
 * whose value only reaches the shop when somebody scrolls to a button they cannot see is a select
 * that quietly does nothing.
 */

/** The choices, in the order a shop thinks about them: soon, later, tomorrow. */
const REMIND_AFTER = [
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 1440, label: 'Once a day' },
];

export default function UpdatesPage() {
  const goBack = useStackBack();
  const { store } = useAuth();
  const { can } = usePermission();
  const editable = can('store.settings');

  const reminder = useUpdateReminder(store?.id ?? null);
  const [note, setNote] = useState<string | null>(null);

  if (!store) return null;

  const status: PageStatus = !reminder.loaded
    ? { state: 'loading', what: 'your update settings' }
    : reminder.error
      ? {
          state: 'error',
          what: 'your update settings',
          error: String(reminder.error),
          onRetry: reminder.reload,
        }
      : { state: 'ready' };

  return (
    <PageScaffold onBack={goBack} title="Updates" subtitle="When a new version asks to come in">
      <PageState status={status}>
        {() => (
          <>
            <Explain label="Why does it ask at all?">
              An update is never taken while you are in the middle of something. It waits to be let
              in, and comes with the next launch anyway — so the only question is how often it is
              worth interrupting you to offer.
            </Explain>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="update-reminder">
                After &ldquo;Not now&rdquo;, ask again
              </label>
              <select
                id="update-reminder"
                className={styles.select}
                value={String(reminder.minutes)}
                disabled={!editable}
                onChange={async (e) => {
                  setNote(null);
                  try {
                    await reminder.set(Number(e.target.value));
                  } catch (err: unknown) {
                    setNote(messageOf(err, 'Could not save that'));
                  }
                }}
              >
                {REMIND_AFTER.map((r) => (
                  <option key={r.minutes} value={r.minutes}>
                    {r.label}
                  </option>
                ))}
              </select>
              {!editable && (
                <p className={styles.note}>
                  Only somebody who can change the shop&apos;s settings can change this.
                </p>
              )}
            </div>

            {note && (
              <p className={styles.note} role="status">
                {note}
              </p>
            )}

            {/*
              WHICH VERSION THIS DEVICE IS ON, and a way to go and look for a new one.

              On the same page as the reminder because they are one question asked two ways: "am I
              up to date" and "how often should you tell me".
            */}
            <h2 className={styles.section}>This app</h2>
            <AppVersion />

            <h2 className={styles.section}>Something went to the wrong page?</h2>
            <NavReport />
          </>
        )}
      </PageState>
    </PageScaffold>
  );
}
