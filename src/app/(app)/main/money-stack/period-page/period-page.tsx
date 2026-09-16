'use client';

import { useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import styles from './period-page.module.css';

/**
 * Two dates, for a report or a list.
 *
 * A PAGE rather than the bottom sheet it started as: nothing is typed inside a bottom viewer.
 *
 * The push carries `then` — the name the calling filter bar published its callback under — and
 * nothing else. Pushed-under pages stay mounted, so two filter bars can be alive at once, and each
 * listens under its own name so this page answers only the one that opened it.
 */
export default function PeriodPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const channel = String(location?.params?.then ?? '');

  const picked = useObject<(from: string, to: string) => void>(channel || 'onPeriodPicked:none', {
    global: true,
    scope: 'periods',
  });

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const backwards = Boolean(from && to && from > to);

  return (
    <PageScaffold onBack={goBack} title="Which dates?" subtitle="From one day to another">
      <div className={styles.fields}>
        <Field label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field
          label="To"
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          hint="This day counts too."
        />
      </div>

      {/* A condition, not a failure: it is true before anything is pressed. */}
      {backwards && (
        <InfoPanel tone="warning" title="The dates are the wrong way round">
          The first date has to be on or before the second.
        </InfoPanel>
      )}

      <div className={styles.actions}>
        <Button
          fullWidth
          disabled={!from || !to || backwards}
          onClick={() => {
            if (picked.isProvided) picked.getter()?.(from, to);
            void nav.pop();
          }}
        >
          Use these dates
        </Button>
      </div>
    </PageScaffold>
  );
}
