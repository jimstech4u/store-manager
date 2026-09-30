'use client';

import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { finishInto } from '@/lib/finish-flow';
import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { AsyncAction, type AsyncState } from '@/components/ui/AsyncAction';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { amendTotal, useAmendDraft } from '@/lib/stacks/amend-draft';
import { amendSale } from '@/lib/stacks/amend';
import { formatMoney, messageOf } from '@/lib/format';
import styles from './amend-reason-page.module.css';

/**
 * WHY — asked last, and the only place the correction is actually written.
 *
 * It used to be a box in the middle of the correction form, above the button. That is the wrong
 * moment: a correction is not finished until the money is settled, and until then nobody can say
 * what was done. Somebody who typed "wrong quantity" and then discovered a crate had also gone out
 * unkeyed had already written the wrong reason.
 *
 * EVERYTHING GOES IN ONE CALL. The lines, the charges, the payment taken during the correction, the
 * deposit and this reason all reach `amend_sale` together. Not because it is tidier — because
 * `amend_sale` restates the whole receipt at once, and anything written before it lands would be
 * attached to a document that never existed. A payment recorded early against a correction that
 * then failed is money in the shop pointing at nothing.
 *
 * THE REASON IS THE PART THAT SURVIVES. Six weeks later nobody remembers which crate; the question
 * asked is "why does this receipt say something different from the copy I am holding", and the
 * answer is this sentence or there is no answer.
 */
export default function AmendReasonPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();

  const saleId = (location?.params?.id as string | undefined) ?? null;
  const { draft, loaded, patch, clear } = useAmendDraft(saleId);

  const [state, setState] = useState<AsyncState>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  if (!store) return null;

  const order = draft.order;
  const total = amendTotal(draft);
  const cancelling = (order?.lines.length ?? 0) === 0;

  const status: PageStatus = !saleId
    ? { state: 'empty', title: 'No correction in progress', body: 'Start from a receipt.' }
    : !loaded || !order
      ? { state: 'loading', what: 'this correction' }
      : { state: 'ready' };

  const save = async () => {
    if (!order || !saleId) return;
    setState('busy');
    setFailure(null);
    try {
      const result = await amendSale({
        takeBack: draft.takeBack ?? [],
        cancelDeposit: Boolean(draft.cancelDeposit),
        saleId,
        reason: draft.reason.trim(),
        lines: order.lines.map((l) => ({
          productId: l.productId,
          saleUnitId: l.saleUnitId,
          enteredQty: Number(l.qty) || 0,
          baseQty: (Number(l.qty) || 0) * (Number(l.saleUnitBaseQty) || 1),
          unitPrice: Number(l.unitPrice) || 0,
          lineTotal: (Number(l.qty) || 0) * (Number(l.unitPrice) || 0),
          /*
           * Containers follow the QUANTITY, not the figure the old line happened to carry. A line
           * corrected from three crates to two puts two out, and a stale count would leave the
           * customer owing a crate that came back with the lorry.
           */
          containersOut: Number(l.containersOut) > 0 ? Number(l.qty) || 0 : 0,
        })),
        customerId: order.customerId,
        charges: (order.charges ?? []).map((c) => ({ label: c.label, amount: Number(c.amount) || 0 })),
        payments: draft.taking.map((p) => ({
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          bankAccountId: p.bankAccountId,
        })),
        deposit: draft.depositNow > 0 ? draft.depositNow : null,
        depositReason: draft.depositReason,
      });
      /*
       * THE CHANGE HANDED BACK, as money going out — only Take payment did this, so change given on
       * a corrected receipt sat on the account as a credit the shop did not owe. Not fatal: the
       * correction is recorded, and a credit can still be given back from the account.
       */
      const change = Number(draft.changeBack) || 0;
      if (change > 0.005 && order.customerId) {
        const { error: backErr } = await getSupabase().rpc('record_money_back', {
          p_store_id: store.id,
          p_customer_id: order.customerId,
          p_amount: change,
          p_method: 'cash',
          p_reason: 'Change given at the counter (correction)',
          p_client_uuid: crypto.randomUUID(),
          p_bank_account_id: null,
        });
        if (backErr) console.warn('change was not recorded as money back', backErr.message);
        accountsChanged();
      }
      setState('idle');
      // Made: the next correction on this receipt starts from the receipt, not from this draft.
      clear();

      /*
       * BACK TO THE RECEIPT THE CORRECTION STARTED FROM — the flow unwound, not replaced.
       *
       * `replace` swapped this screen for the receipt but left the correction's other screens, and
       * their browser history, underneath: Back walked into a payment box for a correction already
       * made. `finishInto` pops back to that receipt (which re-reads itself), or shows it fresh
       * when the correction was reached some other way.
       */
      void finishInto(
        nav,
        (entry) => entry.key === 'receipt_page' && entry.params?.id === result.saleId,
        { id: result.saleId, fresh: true },
      );
    } catch (e) {
      setState('failed');
      setFailure(messageOf(e, 'Could not correct that receipt.'));
    }
  };

  return (
    <PageScaffold
      onBack={goBack}
      title={cancelling ? 'Why is it being cancelled?' : 'Why is it being corrected?'}
      subtitle="The last thing, and the part that gets asked about"
    >
      <PageState status={status}>
        {() =>
          order && (
            <>
              {/* WHAT IS ABOUT TO HAPPEN, in one sentence, before the box. */}
              {cancelling ? (
                <InfoPanel tone="warning" title="This cancels the receipt">
                  Nothing is left on it. The stock goes back on your shelf, the containers come off
                  {order.customerName ? ` ${order.customerName}` : ' the customer'}, and anything
                  paid becomes credit to them.
                </InfoPanel>
              ) : (
                <div className={styles.summary}>
                  <div className={styles.row}>
                    <span>It said</span>
                    <span>{formatMoney(draft.was?.total ?? 0)}</span>
                  </div>
                  <div className={styles.row}>
                    <strong>It will say</strong>
                    <strong>{formatMoney(total)}</strong>
                  </div>
                  {draft.taking.length > 0 && (
                    <div className={styles.row}>
                      <span>Taken just now</span>
                      <span>
                        {formatMoney(draft.taking.reduce((sum, p) => sum + p.amount, 0))}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <Field
                label={cancelling ? 'Why is it being cancelled?' : 'Why is it being corrected?'}
                value={draft.reason}
                onChange={(e) => patch({ reason: e.target.value })}
                placeholder={
                  cancelling
                    ? 'The lorry never left'
                    : 'Keyed three crates, only two went'
                }
                hint="Asked weeks later by somebody who was not there. This is the part that settles it."
              />

              {/* The action ENDS the page rather than being pinned to its foot — see CLAUDE.md. */}
              <div className={styles.actions}>
                <AsyncAction
                  state={state}
                  problem={failure}
                  label={cancelling ? 'Cancelling this receipt' : 'Correcting this receipt'}
                >
                  <Button
                    fullWidth
                    disabled={draft.reason.trim() === ''}
                    onClick={() => void save()}
                  >
                    {cancelling ? 'Cancel this receipt' : 'Correct it'}
                  </Button>
                </AsyncAction>
              </div>
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
