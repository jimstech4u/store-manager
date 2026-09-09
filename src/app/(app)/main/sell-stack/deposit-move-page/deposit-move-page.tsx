'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { LoadArea, useLoadArea } from '@/components/ui/LoadArea';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import {
  depositLedger,
  settleDeposit,
  takeDeposit,
  type DepositMove,
} from '@/lib/stacks/customer-ledgers';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './deposit-move-page.module.css';

/**
 * Moving a deposit — a PAGE, because it is a form.
 *
 * It was a bottom sheet. *A form is a page, a choice is a sheet* is a rule this project already
 * had, and it is not a matter of taste: on a phone the keyboard covers the half of the sheet being
 * typed into, and a sheet's local state does not survive a rotation. This form moves somebody's
 * money.
 *
 * THREE MODES, ONE FORM, because they are one gesture with three meanings — and the meanings are
 * what matter. Taking and giving back move the customer's own money; KEEPING it is income, and a
 * shop that cannot tell the last from the middle cannot say what it earned.
 */
export default function DepositMovePage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();
  const showProblem = problem.show;

  const customerId = (location?.params?.id as string | undefined) ?? null;
  const mode = (location?.params?.mode as 'take' | 'give' | 'keep' | undefined) ?? 'take';

  // Read here, not handed over: what is held moves as the shop works, and a form that settles
  // against a stale figure is one that refuses at the server after somebody has counted the cash.
  const area = useLoadArea<DepositMove[]>(() => depositLedger(customerId!), [customerId], {
    onFail: showProblem,
    whenNot: !customerId,
  });

  const moves = area.data ?? [];
  const held = moves.length > 0 ? moves[0].running : 0;

  const [amount, setAmount] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);

  const tooMuch = mode !== 'take' && Number(amount) > held;

  const save = async () => {
    if (!store || !customerId) return;
    setBusy(true);
    try {
      if (mode === 'take') {
        await takeDeposit(store.id, customerId, Number(amount), why);
      } else {
        await settleDeposit({
          storeId: store.id,
          customerId,
          amount: Number(amount),
          keep: mode === 'keep',
          reason: why,
        });
      }
      await nav.pop();
    } catch (e) {
      showProblem(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'take' ? 'Take a deposit' : mode === 'give' ? 'Give some back' : 'Keep some of it';

  return (
    <PageScaffold
      onBack={goBack}
      title={title}
      subtitle={
        mode === 'keep' ? 'Money you are keeping, and why' : 'Money of theirs you are minding'
      }
    >
      <ProblemDialog problem={problem} title="Not recorded" />

      {mode === 'keep' && (
        <InfoPanel tone="info" title="Keeping it is income">
          Giving a deposit back moves the customer&rsquo;s own money; keeping it is money the shop
          has earned, and it is recorded as such. That is why this one needs a reason.
        </InfoPanel>
      )}

      <LoadArea area={area} what="their deposit">
        {() => (
          <>
            <div className={styles.headline}>
              <span className={styles.headlineLabel}>You are holding</span>
              <span className={styles.headlineValue}>{formatMoney(held)}</span>
            </div>

            <Field
              label="How much"
              numeric
              prefix="₦"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              hint={
                mode === 'take'
                  ? 'Added to whatever you already hold for them.'
                  : 'Part of it is fine — the rest stays held.'
              }
              error={tooMuch ? `You are only holding ${formatMoney(held)}.` : null}
              autoFocus
            />

            <Field
              label={mode === 'take' ? 'What for' : 'Why'}
              optional={mode === 'take'}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              placeholder={
                mode === 'keep'
                  ? 'Two crates never came back'
                  : mode === 'give'
                    ? 'Settled up'
                    : 'Crates and bottles'
              }
              hint={
                mode === 'take'
                  ? undefined
                  : 'Required. Money leaving a deposit with no reason is money nobody can explain.'
              }
            />

            {/* The actions END the page rather than being pinned to its foot — see CLAUDE.md. */}
            <div className={styles.actions}>
              <Button variant="secondary" onClick={goBack} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant={mode === 'keep' ? 'danger' : 'primary'}
                busy={busy}
                busyLabel="Recording"
                disabled={!(Number(amount) > 0) || tooMuch || (mode !== 'take' && !why.trim())}
                onClick={() => void save()}
              >
                Record it
              </Button>
            </div>
          </>
        )}
      </LoadArea>
    </PageScaffold>
  );
}
