'use client';

import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { PlusIcon } from '@/components/ui/Icon';
import { InfoPanel } from '@/components/ui/Explain';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { TakePayment } from '../sell-page/TakePayment';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { amendTotal, useAmendDraft } from '@/lib/stacks/amend-draft';
import { formatMoney } from '@/lib/format';
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
  const { draft, loaded, patch, patchOrder } = useAmendDraft(saleId);
  const problem = useProblem();

  /*
   * WHAT COMES OFF, MARKED — NOT WRITTEN HERE.
   *
   * "Correct payment is just like Take payment, no block, because the reason is already done after
   * it." A cross on a payment the receipt already holds, or on its deposit, marks it to come off;
   * nothing is written until the correction is, under its one reason (0249). Put back undoes it.
   */
  const takeBack = draft.takeBack ?? [];
  const cancelDeposit = Boolean(draft.cancelDeposit);
  const comingOff = (draft.was?.payments ?? [])
    .filter((pay) => pay.paymentId && takeBack.includes(pay.paymentId))
    .reduce((sum, pay) => sum + pay.amount, 0);

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
  const paidAfter = draft.alreadyPaid - comingOff;
  const stillOwed = Math.max(0, total - paidAfter) + (cancelDeposit ? 0 : depositUnpaid);

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
                {paidAfter > 0 && <>It has already taken {formatMoney(paidAfter)}. </>}
                {stillOwed > 0
                  ? `That leaves ${formatMoney(stillOwed)} to pay.`
                  : total < paidAfter
                    ? `You owe them ${formatMoney(paidAfter - total)} back.`
                    : 'Nothing is left to pay.'}
              </InfoPanel>

              {/*
                WHAT IT HAS ALREADY TAKEN, and a way back out of each one.

                The screen listed none of this. It showed a total paid inside a sentence and then
                a form for adding more — so the only correction it could express was "and another
                payment", whatever the seller actually meant.
              */}
              <h2 className={styles.section}>What they are paying now</h2>

              <TakePayment
                order={order}
                storeId={store.id}
                /*
                 * THE BILL, AND WHAT IS LEFT OF IT — two figures, not one. Handed only the left-to-pay,
                 * the corrected receipt read "Items N0 · Total for this sale N0".
                 */
                total={total}
                due={stillOwed}
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
                          onRemove: () => patch({ cancelDeposit: true }),
                          removed: cancelDeposit,
                          onRestore: () => patch({ cancelDeposit: false }),
                        }
                      : null,
                  payments: (draft.was?.payments ?? []).map((pay, i) => ({
                    key: pay.paymentId ?? `paid-${i}`,
                    amount: pay.amount,
                    method: pay.method,
                    reference: pay.reference,
                    onRemove: pay.paymentId
                      ? () => patch({ takeBack: [...takeBack, pay.paymentId as string] })
                      : undefined,
                    removed: Boolean(pay.paymentId && takeBack.includes(pay.paymentId)),
                    onRestore: () =>
                      patch({ takeBack: takeBack.filter((id) => id !== pay.paymentId) }),
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
