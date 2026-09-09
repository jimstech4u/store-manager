'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged, useCustomerAccount } from '@/lib/stacks/customer-account';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './account-action-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

/**
 * Money on a customer's account: a PAGE, not a sheet.
 *
 * These used to be a bottom sheet on the account screen. Every one is a form — an amount, a reason
 * — and a form inside a sheet on a phone is a bad trade: the keyboard covers the half you are
 * typing into, dragging to reach a field reads as a dismiss gesture, and there is no back button,
 * so the way out is a gesture people have to already know. A page has a title, a back arrow, a URL,
 * and it survives a rotation. These forms record money.
 *
 * THREE KINDS NOW, WHERE THERE WERE SIX.
 *
 * `return`, `deposit`, `refund` and `breakage` have gone. All four wrote to a ledger that recorded
 * a QUANTITY OF CONTAINERS at a rate — so giving a deposit back was expressed in crates, and a
 * shop holding a round twenty thousand naira could not say so at all. Containers and deposits are
 * separate ledgers now (0108/0109) with a screen each, because both are running accounts whose
 * history has to be read before anything is decided. A one-shot form cannot show a history.
 *
 * `opening` has gone too. What a customer already owed is asked once, on the customer form, where
 * somebody is entering that customer — not offered for ever afterwards as something to do on a
 * Tuesday.
 */

type ActionKind = 'payment' | 'charge' | 'excess';

const SUBTITLES: Record<ActionKind, string> = {
  payment: 'Money they have handed over',
  charge: 'Something they owe you that was not a sale',
  excess: 'Money you owe them',
};

const TITLES: Record<ActionKind, string> = {
  payment: 'Record a payment',
  charge: 'Record a charge',
  excess: 'Record what you owe them',
};

export default function AccountActionPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const customerId = (location?.params?.id as string | undefined) ?? null;
  const kind = (location?.params?.kind as ActionKind | undefined) ?? 'payment';

  /*
   * What they owe, read live — NOT carried in the URL.
   *
   * It used to arrive as an `owed` param: a money figure frozen at the moment of the tap. Record a
   * payment, go back, tap through again from a card that had not refreshed, and this form said
   * "They owe ₦40,000" over an account that no longer did — directly above the box where somebody
   * types how much is being paid. `useCustomerAccount` is the same cache the account page behind
   * this one reads, so the two cannot disagree.
   */
  const { account } = useCustomerAccount(customerId);
  const owed = Number(account?.balance ?? 0);

  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  if (!store || !customerId) return null;

  const run = async () => {
    setBusy(true);
    const supabase = getSupabase();
    try {
      if (kind === 'payment') {
        const { error } = await supabase.rpc('record_payment', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_amount: Number(amount),
          p_method: method,
          p_reference: note.trim() || null,
          p_client_uuid: crypto.randomUUID(),
          p_bank_account_id: null,
        });
        if (error) throw error;
      } else {
        /*
         * A charge and an excess are the same row with the direction turned round, which is why
         * they share a writer. Neither is a sale — a sale through here would invent a line that
         * moves stock — and neither is a payment, which would claim money changed hands.
         */
        const { error } = await supabase.rpc('record_customer_charge', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_amount: Number(amount),
          p_reason: note.trim(),
          p_owed_to_them: kind === 'excess',
        });
        if (error) throw error;
      }

      /*
       * Say that the figures moved, then go back.
       *
       * Invalidating the scope is what makes the account, the debtor list and the statement all
       * correct on their next look — without any of them polling, and without this page having to
       * know which screens exist. The write knows it happened; it announces it.
       */
      accountsChanged();
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That could not be recorded.'));
    } finally {
      setBusy(false);
    }
  };

  // A reason is what makes a charge answerable weeks later, so it is required for both directions
  // and optional only on a payment, where the amount and the method already say what happened.
  const ready = Number(amount) > 0 && (kind === 'payment' || note.trim() !== '');

  return (
    <PageScaffold onBack={goBack} title={TITLES[kind]} subtitle={SUBTITLES[kind]}>
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not recorded" />

      {kind === 'excess' && (
        <InfoPanel tone="info" title="This is not a deposit">
          A deposit is their money you are minding, and it lives on its own screen. This is money
          you owe them — an overpayment, a load credited back — and it comes off what they owe.
        </InfoPanel>
      )}

      <Field
        label={
          kind === 'payment'
            ? 'How much did they pay?'
            : kind === 'charge'
              ? 'How much are you charging?'
              : 'How much do you owe them?'
        }
        numeric
        prefix="₦"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0"
        hint={owed ? `They owe ${formatMoney(Math.abs(owed))} at the moment.` : undefined}
        autoFocus
      />

      {kind === 'payment' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pay-method">
            How did it come in?
          </label>
          <select
            id="pay-method"
            className={styles.select}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="cash">Cash</option>
            <option value="transfer">Bank transfer</option>
            <option value="pos">Card / POS</option>
            <option value="other">Something else</option>
          </select>
        </div>
      )}

      <Field
        label={kind === 'payment' ? 'Reference' : 'What it is for'}
        optional={kind === 'payment'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          kind === 'payment'
            ? 'Teller number, or who brought it'
            : kind === 'charge'
              ? 'Delivery to Ikeja'
              : 'Overpaid on Tuesday'
        }
        hint={
          kind === 'payment'
            ? undefined
            : 'Required. "Why do I owe another two thousand" is what this answers.'
        }
      />

      {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={goBack} disabled={busy}>
          Cancel
        </Button>
        <Button busy={busy} busyLabel="Recording" disabled={!ready} onClick={() => void run()}>
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}
