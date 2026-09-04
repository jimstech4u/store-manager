'use client';

import { useEffect, useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { getSupabase } from '@/lib/supabase/client';
import {
  accountsChanged,
  useCustomerAccount,
  useEmptiesPools,
  type EmptiesPool,
} from '@/lib/stacks/customer-account';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './account-action-page.module.css';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

/**
 * Recording money or containers against a customer: a PAGE, not a sheet.
 *
 * All five of these used to be a bottom sheet on the account screen. Every one of them is a form —
 * an amount, a pool, a quantity, a reason — and a form inside a sheet on a phone is a bad trade:
 * the keyboard covers the half of the sheet you are typing into, dragging to reach a field reads
 * as a dismiss gesture, and there is no back button, so the way out is a gesture people have to
 * already know.
 *
 * A page has a title, a back arrow, the whole screen, and a URL. It also survives a rotation and a
 * reload, which a sheet's local state does not — and these forms record money.
 *
 * The sheet component itself was fixed too (bottom-viewer 0.3.2 keeps a focused field clear of the
 * keyboard and stops a touch on it closing the sheet), because plenty of sheets legitimately hold
 * one field. Five-field forms are not those.
 */

type ActionKind = 'payment' | 'return' | 'deposit' | 'refund' | 'breakage' | 'opening';

/** A line under each title saying what the screen is for, in the words of the counter. */
const SUBTITLES: Record<ActionKind, string> = {
  payment: 'Money they have handed over',
  return: 'Crates or bottles coming back',
  deposit: 'Money you hold against what they took',
  refund: 'Give back a deposit you were holding',
  breakage: 'Keep part of a deposit for what came back broken',
  opening: 'What they owed before you started here',
};

const TITLES: Record<ActionKind, string> = {
  payment: 'Record a payment',
  return: 'Empties brought back',
  deposit: 'Take a deposit',
  refund: 'Give a deposit back',
  breakage: 'Keep some for breakage',
  opening: 'What they already owed',
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
   * It used to arrive as a `owed` param: a money figure frozen at the moment of the tap. Record a
   * payment, go back, tap through again from a card that had not refreshed, and this form said
   * "They owe ₦40,000" over an account that no longer did — while sitting directly above the box
   * where somebody types how much is being paid. `useCustomerAccount` is the same cache the
   * account page behind this one reads, so the two cannot disagree.
   */
  const { account } = useCustomerAccount(customerId);
  const owed = Number(account?.balance ?? 0);

  const pools = useEmptiesPools(store?.id ?? null);

  const [amount, setAmount] = useState('');
  const [qty, setQty] = useState('');
  const [poolId, setPoolId] = useState('');
  const [method, setMethod] = useState('cash');
  const [refundMode, setRefundMode] = useState<'credit' | 'cash' | 'none'>('credit');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = useProblem();

  // Default to the first pool once they load, so the picker is never showing an empty selection
  // over a form that needs one.
  useEffect(() => {
    if (!poolId && pools.length > 0) setPoolId(pools[0].id);
  }, [pools, poolId]);

  if (!store || !customerId) return null;

  const run = async () => {
    setBusy(true);
    const supabase = getSupabase();
    const now = new Date().toISOString();
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
      } else if (kind === 'return') {
        const { error } = await supabase.rpc('return_empties', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_client_uuid: crypto.randomUUID(),
          p_refund_mode: refundMode,
        });
        if (error) throw error;
      } else if (kind === 'deposit') {
        const { error } = await supabase.rpc('take_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_per_unit: amount.trim() === '' ? null : Number(amount),
          p_note: note.trim() || null,
        });
        if (error) throw error;
      } else if (kind === 'refund') {
        const { error } = await supabase.rpc('refund_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_note: note.trim() || null,
        });
        if (error) throw error;
      } else if (kind === 'breakage') {
        const { error } = await supabase.rpc('forfeit_deposit', {
          p_store_id: store.id,
          p_customer_id: customerId,
          p_category_id: poolId,
          p_qty: Number(qty),
          p_amount: Number(amount),
          p_note: note.trim() || null,
        });
        if (error) throw error;
      } else {
        /*
         * Opening position: what this customer already owed before the shop started using the app.
         *
         * Recorded through `backfill_debtor` / `backfill_empties` rather than as a fake sale, so it
         * never pretends goods moved on a day they did not. It lands on the timeline as an opening
         * entry, which is what it is, and every later figure is built on top of it.
         */
        if (amount.trim() !== '' && Number(amount) !== 0) {
          const { error } = await supabase.rpc('backfill_debtor', {
            p_store_id: store.id,
            p_customer_id: customerId,
            p_amount: Number(amount),
            p_as_of: now.slice(0, 10),
            p_note: note.trim() || 'Opening balance',
          });
          if (error) throw error;
        }
        if (qty.trim() !== '' && Number(qty) !== 0 && poolId) {
          const { error } = await supabase.rpc('backfill_empties', {
            p_store_id: store.id,
            p_customer_id: customerId,
            p_category_id: poolId,
            p_qty: Number(qty),
            p_as_of: now.slice(0, 10),
          });
          if (error) throw error;
        }
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

  const pool = pools.find((p: EmptiesPool) => p.id === poolId);

  return (
    <PageScaffold onBack={goBack} title={TITLES[kind]} subtitle={SUBTITLES[kind]}>
      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={problem} title="Not recorded" />

      {kind === 'opening' && (
        <InfoPanel tone="info" title="Only for what happened before you started here">
          Use this once per customer, to bring in what they already owed you and what of yours they
          already had. It is recorded as an opening entry, not as a sale — nothing moves on your
          shelf.
        </InfoPanel>
      )}

      {kind === 'payment' && (
        <>
          <Field
            label="How much did they pay?"
            numeric
            prefix="₦"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            hint={owed ? `They owe ${formatMoney(Math.abs(owed))}.` : undefined}
            autoFocus
          />
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
          <Field
            label="Reference"
            optional
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Teller number, or who brought it"
          />
        </>
      )}

      {kind === 'opening' && (
        <Field
          label="Money they already owed"
          optional
          numeric
          prefix="₦"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
        />
      )}

      {kind !== 'payment' && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="pool">
            {kind === 'opening' ? 'Which of yours do they already have?' : 'Which ones?'}
          </label>
          <select
            id="pool"
            className={styles.select}
            value={poolId}
            onChange={(e) => setPoolId(e.target.value)}
          >
            {pools.map((p: EmptiesPool) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {Number(p.deposit) > 0 ? ` — ${formatMoney(p.deposit)} each` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {kind !== 'payment' && (
        <Field
          label="How many?"
          optional={kind === 'opening'}
          numeric
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          placeholder="0"
        />
      )}

      {kind === 'return' && Number(pool?.deposit ?? 0) > 0 && (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="refund-mode">
            You may be holding a deposit on these — what happens to it?
          </label>
          <select
            id="refund-mode"
            className={styles.select}
            value={refundMode}
            onChange={(e) => setRefundMode(e.target.value as 'credit' | 'cash' | 'none')}
          >
            <option value="credit">Take it off what they owe</option>
            <option value="cash">Give them the cash</option>
            <option value="none">Leave it on deposit — they are taking more</option>
          </select>
          <p className={styles.hint}>
            Whichever you choose is written down with the time and your name, so it can be
            explained later.
          </p>
        </div>
      )}

      {kind === 'deposit' && (
        <Field
          label="Deposit for each"
          optional
          numeric
          prefix="₦"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={formatMoney(pool?.deposit ?? 0)}
          hint="Leave empty to use this shop's usual deposit for that pool."
        />
      )}

      {kind === 'breakage' && (
        <Field
          label="How much are you keeping?"
          numeric
          prefix="₦"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          hint="The rest of their deposit for these goes back to them."
        />
      )}

      {kind !== 'payment' && (
        <Field
          label="Why / note"
          optional
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={kind === 'breakage' ? '3 bottles cracked' : 'Anything worth remembering'}
        />
      )}

      <div className={styles.actions}>
        <Button size="large" fullWidth busy={busy} onClick={() => void run()}>
          Record it
        </Button>
      </div>
    </PageScaffold>
  );
}
