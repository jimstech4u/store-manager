'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';
import styles from './supplier-payment-page.module.css';

type Kind = 'paid' | 'charge' | 'credit';

const TITLES: Record<Kind, string> = {
  paid: 'Record a payment',
  charge: 'Record a charge',
  credit: 'Record what they owe you',
};

const SUBTITLES: Record<Kind, string> = {
  paid: 'Money you handed over',
  charge: 'Something you owe that no delivery carried',
  credit: 'A rebate, or a load sent back',
};

/**
 * Money on a supplier's account — a PAGE, because it is a form.
 *
 * The same shape as the customer version, and for the same reasons: a sheet's local state does not
 * survive a rotation, the keyboard covers the half being typed into, and these record money.
 *
 * A PAYMENT NEEDS NO REASON; the other two do. An amount and a method explain a payment on their
 * own. "Why do we owe another two thousand" is the question the other two exist to answer, and a
 * charge nobody can explain is one that gets written off.
 */
export default function SupplierPaymentPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const problem = useProblem();

  const supplierId = (location?.params?.id as string | undefined) ?? null;
  const kind = (location?.params?.kind as Kind | undefined) ?? 'paid';

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('transfer');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (!store || !supplierId) return null;

  const ready = Number(amount) > 0 && (kind === 'paid' || reason.trim() !== '');

  const save = async () => {
    setBusy(true);
    try {
      const { error } = await getSupabase().rpc('record_supplier_payment', {
        p_store_id: store.id,
        p_supplier_id: supplierId,
        p_amount: Number(amount),
        p_direction: kind,
        p_method: kind === 'paid' ? method : null,
        p_reason: reason.trim() || null,
      });
      if (error) throw error;
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageScaffold onBack={goBack} title={TITLES[kind]} subtitle={SUBTITLES[kind]}>
      <ProblemDialog problem={problem} title="Not recorded" />

      {kind === 'credit' && (
        <InfoPanel tone="info" title="This is not money coming in">
          It comes off what you owe them rather than into your takings — a rebate on a load, or
          goods sent back. Recording it as income would count money twice.
        </InfoPanel>
      )}

      <Field
        label={
          kind === 'paid'
            ? 'How much did you pay?'
            : kind === 'charge'
              ? 'How much are they charging?'
              : 'How much do they owe you?'
        }
        numeric
        prefix="₦"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0"
        autoFocus
      />

      {kind === 'paid' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="how-paid">
            How did it go out?
          </label>
          <select
            id="how-paid"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="transfer">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="cheque">Cheque</option>
            <option value="other">Something else</option>
          </select>
        </div>
      )}

      <Field
        label={kind === 'paid' ? 'Reference' : 'What it is for'}
        optional={kind === 'paid'}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={
          kind === 'paid'
            ? 'Teller number, or who took it'
            : kind === 'charge'
              ? 'Haulage on the Tuesday load'
              : 'Rebate on 200 crates'
        }
        hint={
          kind === 'paid'
            ? undefined
            : 'Required. This is what makes the figure answerable months later.'
        }
      />

      {/* The actions END the page rather than being pinned to its foot — see CLAUDE.md. */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={goBack} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} busyLabel="Recording" disabled={!ready} onClick={() => void save()}>
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}
