'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { PlusIcon } from '@/components/ui/Icon';
import { InfoPanel } from '@/components/ui/Explain';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { TakePayment } from '../sell-page/TakePayment';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { amendTotal, useAmendDraft } from '@/lib/stacks/amend-draft';
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './amend-payment-page.module.css';

/**
 * CORRECT PAYMENT — the money half of correcting a receipt.
 *
 * The same screen the till uses to take payment, because it is the same job: several methods, a
 * reference, the named charges, a deposit, and what is left over. `TakePayment` composes money and
 * hands back the facts; what is DONE with them is the caller's, which is the whole reason its
 * commit was lifted out.
 *
 * WHAT IS DIFFERENT HERE, and it is only two things:
 *
 *   · this receipt has already taken money, so what is owed is the corrected total LESS what it
 *     already holds — a correction that asked for the full amount again would have a customer
 *     paying twice
 *   · nothing is written yet. The payment is composed, kept on the correction, and committed on
 *     the NEXT screen, with the reason, in one call — because `amend_sale` restates the whole
 *     receipt at once and a payment recorded before the correction lands would sit against a
 *     document that never existed
 */
export default function AmendPaymentPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const { draft, loaded, patch, patchOrder, refreshTaken } = useAmendDraft(saleId);
  const problem = useProblem();

  /*
   * ── TAKING BACK A PAYMENT THAT WAS KEYED WRONG ────────────────────────────────
   *
   * This screen could only ever ADD money. A seller who keyed N1,600 as cash when it was a
   * transfer had no way to say the cash never came, so they added the transfer — and the receipt
   * held N3,200 against a N1,600 total, with the customer's account showing the shop owing them
   * N1,600 it never took. That is what happened to Destiny's receipt on the 28th.
   *
   * `void_payment` writes the opposite entry rather than deleting anything, so the cash book shows
   * N1,600 in and N1,600 out — a till that took nothing in cash, which is what happened — and the
   * reason stays on the record.
   *
   * THE REASON IS ASKED FOR, not defaulted. This is the only account of why the books moved, and
   * "corrected" with nothing beside it is what makes a statement unreadable weeks later.
   */
  /*
   * THE DEPOSIT PUT DOWN WITH THIS SALE, cancelled here when it was keyed by mistake.
   *
   * "The correction screen should load back the whole breakdown — deposit, charge and payment — so
   * we can press cancel to remove one and add the corrected one." Charges are on the order below,
   * each with its cross; payments are listed with "take it back"; this is the deposit's. Cancelling
   * gives it back on their deposit ledger, marked as a cancellation, with the reason (0247).
   */
  const [cancellingDeposit, setCancellingDeposit] = useState(false);
  const [depositWhy, setDepositWhy] = useState('');
  const [busyDeposit, setBusyDeposit] = useState(false);
  const cancelDeposit = async () => {
    if (!saleId) return;
    setBusyDeposit(true);
    try {
      const { error } = await getSupabase().rpc('cancel_sale_deposit', {
        p_sale_id: saleId,
        p_reason: depositWhy.trim(),
      });
      if (error) throw error;
      setCancellingDeposit(false);
      setDepositWhy('');
      accountsChanged();
      await refreshTaken();
    } catch (e) {
      problem.show(messageOf(e, 'That deposit could not be cancelled.'));
    } finally {
      setBusyDeposit(false);
    }
  };

  const [voiding, setVoiding] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [busyVoid, setBusyVoid] = useState(false);

  const takeItBack = async (paymentId: string) => {
    setBusyVoid(true);
    try {
      const { error } = await getSupabase().rpc('void_payment', {
        p_payment_id: paymentId,
        p_reason: why.trim(),
      });
      if (error) throw error;
      setVoiding(null);
      setWhy('');
      // The receipt and the customer's account both change, so both are re-read.
      accountsChanged();
      await refreshTaken();
    } catch (e) {
      problem.show(messageOf(e, 'That payment could not be taken back.'));
    } finally {
      setBusyVoid(false);
    }
  };

  if (!store) return null;

  const order = draft.order;
  const total = amendTotal(draft);

  /*
   * WHAT THE RECEIPT SAID BEFORE, which is what the difference is measured against.
   *
   * What it has already been PAID is deliberately not shown here: `sale_document` does not carry
   * it, and a figure worked out on this page would be a second opinion about money. The server
   * knows, and it is the server that decides what is left owing when the correction lands.
   */
  const owedBefore = draft.was ? draft.was.total : 0;

  /*
   * WHAT IS ACTUALLY LEFT TO PAY — the corrected total less what this receipt already holds.
   *
   * The payment screen was handed the whole corrected total, so a ₦10,000 receipt corrected up to
   * ₦15,000 asked for ₦15,000 when only ₦5,000 was owed. A seller following the screen would have
   * taken the money twice. Never below zero: a correction DOWNWARD leaves the shop owing them, and
   * that is a refund rather than a negative payment.
   */
  /*
   * AND THE DEPOSIT PUT DOWN WITH IT, WHILE UNPAID (0247). It sits beside the receipt's total, not in
   * it, so "the total less what it holds" never asked for it: Mrs Adeola's correction asked for
   * N32,150 of the N38,150 she handed over. The server says what is unpaid; money over the goods
   * pays it.
   */
  const depositPutDown = draft.was?.depositTaken ?? 0;
  const depositUnpaid = draft.was?.depositUnpaid ?? 0;
  const stillOwed = Math.max(0, total - draft.alreadyPaid) + depositUnpaid;

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'No correction in progress', body: 'Start from a receipt.' }
    : !loaded || !order
      ? { state: 'loading', what: 'this correction' }
      : { state: 'ready' };

  return (
    <PageScaffold
      onBack={goBack}
      title="Correct payment"
      subtitle="What changed, and what they are paying"
    >
      <ProblemDialog problem={problem} title="Not changed" />

      <PageState status={status}>
        {() =>
          order && (
            <>
              {/*
                THE DIFFERENCE, said before any of it is typed.

                A correction is rarely "pay the total" — it is "pay the extra", or "we owe you
                some back". Somebody standing at a counter should not have to work out which by
                comparing two figures on different screens.
              */}
              <InfoPanel
                tone={total > owedBefore ? 'warning' : 'info'}
                title={
                  total > owedBefore
                    ? `${formatMoney(total - owedBefore)} more than it said`
                    : total < owedBefore
                      ? `${formatMoney(owedBefore - total)} less than it said`
                      : 'The total has not changed'
                }
              >
                It said {formatMoney(owedBefore)} and should say {formatMoney(total)}.{' '}
                {draft.alreadyPaid > 0 && <>It has already taken {formatMoney(draft.alreadyPaid)}. </>}
                {stillOwed > 0
                  ? `That leaves ${formatMoney(stillOwed)} to pay.`
                  : total < draft.alreadyPaid
                    ? `You owe them ${formatMoney(draft.alreadyPaid - total)} back.`
                    : 'Nothing is left to pay.'}
              </InfoPanel>

              {/*
                WHAT IT HAS ALREADY TAKEN, and a way back out of each one.

                The screen listed none of this. It showed a total paid inside a sentence and then
                a form for adding more — so the only correction it could express was "and another
                payment", whatever the seller actually meant.
              */}
              {/*
                THE REASON, WHEN A LINE BELOW IS TAKEN OFF. The deposit and the payments this receipt
                already holds are drawn by Take payment with its own lines — the ones the till uses —
                and their crosses land here, because taking one back is on the record and says why.
              */}
                  {cancellingDeposit && (
                    <div className={styles.voidBox}>
                      <Field
                        label="Why is this deposit being cancelled?"
                        required
                        value={depositWhy}
                        onChange={(e) => setDepositWhy(e.target.value)}
                        placeholder="For example: keyed by mistake, they brought their own crates"
                        hint="It is given back on their deposit record and stays there — never rubbed out."
                        autoFocus
                      />
                      <div className={styles.voidActions}>
                        <Button
                          variant="secondary"
                          disabled={busyDeposit}
                          onClick={() => setCancellingDeposit(false)}
                        >
                          Keep it
                        </Button>
                        <Button
                          variant="danger"
                          busy={busyDeposit}
                          busyLabel="Cancelling"
                          disabled={depositWhy.trim() === ''}
                          onClick={() => void cancelDeposit()}
                        >
                          Cancel the deposit
                        </Button>
                      </div>
                    </div>
                  )}
                  {voiding && (
                    <div className={styles.voidBox}>
                      <Field
                        label="Why is this payment being taken back?"
                        required
                        value={why}
                        onChange={(e) => setWhy(e.target.value)}
                        placeholder="For example: keyed as cash, it was a transfer"
                        hint="It stays on the record — the money is reversed, never rubbed out."
                        autoFocus
                      />
                      <div className={styles.voidActions}>
                        <Button
                          variant="secondary"
                          disabled={busyVoid}
                          onClick={() => {
                            setVoiding(null);
                            setWhy('');
                          }}
                        >
                          Keep it
                        </Button>
                        <Button
                          variant="danger"
                          busy={busyVoid}
                          busyLabel="Taking it back"
                          disabled={why.trim() === ''}
                          onClick={() => void takeItBack(voiding)}
                        >
                          Take it back
                        </Button>
                      </div>
                    </div>
                  )}

              <h2 className={styles.section}>What they are paying now</h2>

              <TakePayment
                order={order}
                storeId={store.id}
                total={stillOwed}
                /*
                 * WHAT WAS ALREADY TYPED HERE, restored.
                 *
                 * A seller adds ₦5,000, goes back to the items for one more crate, and comes back.
                 * This screen is pushed and popped, so without these the payment was simply gone —
                 * reported exactly that way, and the next screen then committed a correction with
                 * no money on it.
                 */
                already={{
                  deposit:
                    depositPutDown > 0.005
                      ? {
                          amount: depositPutDown,
                          unpaid: depositUnpaid,
                          onRemove: () => {
                            setCancellingDeposit(true);
                            setDepositWhy('');
                          },
                        }
                      : null,
                  payments: (draft.was?.payments ?? []).map((pay, i) => ({
                    key: pay.paymentId ?? `paid-${i}`,
                    amount: pay.amount,
                    method: pay.method,
                    reference: pay.reference,
                    onRemove: pay.paymentId
                      ? () => {
                          setVoiding(pay.paymentId);
                          setWhy('');
                        }
                      : undefined,
                  })),
                }}
                entered={draft.taking}
                onEnteredChange={(next) => patch({ taking: next })}
                onUpdateOrder={(next) => patchOrder(next)}
                onNeedCustomer={() => {
                  /*
                   * The customer is named on the correction screen, not here: a receipt belongs to
                   * whoever it was made out to, and this page's job is the money. Going back is
                   * safe — the correction lives in its own state, not in this page.
                   */
                  void nav.pop();
                }}
                settledLabel="Say why, and finish"
                gatePrices={false}
                /*
                 * NOTHING IS WRITTEN HERE. The money is kept on the correction and committed with
                 * the reason on the next screen, in one `amend_sale` call — a payment recorded
                 * before the correction lands would sit against a document that never existed.
                 */
                commit={async ({ payments, depositNow, depositReason, paidTotal, towardsOldDebt }) => {
                  /*
                   * CHANGE, worked out the way Take payment works it out: what was handed over, less
                   * what this correction still wanted and whatever went to an older debt — and never
                   * more than came in as cash, because change comes out of the drawer.
                   */
                  const cashIn = payments
                    .filter((pay) => pay.method === 'cash')
                    .reduce((sum, pay) => sum + Number(pay.amount || 0), 0);
                  const changeBack = Math.min(
                    Math.max(paidTotal - stillOwed - towardsOldDebt, 0),
                    cashIn,
                  );
                  /*
                   * The rows are already on the correction, kept by `onEnteredChange` as they were
                   * entered. What is set here is the amount still sitting in the box — counted
                   * towards the total but never "added" — plus the deposit, which this screen owns.
                   */
                  patch({
                    taking: payments.map((p) => ({
                      amount: p.amount,
                      method: p.method,
                      reference: p.reference,
                      bankAccountId: p.bank_account_id,
                    })),
                    depositNow,
                    depositReason,
                    changeBack,
                  });
                  void nav.push('amend_reason_page', { id: saleId ?? '' });
                }}
              />
            </>
          )
        }
      </PageState>

      {/*
        Back to the items, in the same place the till puts it. A seller moves between the two more
        than once on a real correction — the customer remembers another crate while the change is
        being counted.
      */}
      {order && (
        <FloatingAmount
          who={order.customerName || 'this receipt'}
          label="Back to the items"
          amount={<PlusIcon />}
          onClick={() => void nav.pop()}
        />
      )}
    </PageScaffold>
  );
}
