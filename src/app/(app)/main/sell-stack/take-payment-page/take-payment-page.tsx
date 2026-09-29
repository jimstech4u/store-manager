'use client';

import { useState } from 'react';
import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { PlusIcon } from '@/components/ui/Icon';
import { TakePayment } from '../sell-page/TakePayment';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { draftTotal, useDraftOrders } from '@/lib/stacks/draft-orders';
import { getSupabase } from '@/lib/supabase/client';
import { messageOf } from '@/lib/format';
import { applySaleLocally } from '@/lib/stacks/local-effects';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { ledgersChanged } from '@/lib/stacks/customer-ledgers';
import { stockMoved } from '@/lib/stacks/catalog-stack';
import { useListNotifier } from '@/hooks/useListChannel';

/**
 * Taking payment for the open order — a page.
 *
 * It was a bottom sheet, and it is the longest form in the product: a row per payment method, an
 * amount tendered, a reference, plus the customer's existing balance to read while deciding
 * whether to extend more credit. On a 390px phone a keyboard put the last row and the commit
 * button somewhere a thumb could not reach.
 *
 * AN ID IS PASSED IN, and nothing else. The order itself is read from `useDraftOrders`, the same
 * working state the sell screen writes — never handed across as a copy that could go stale
 * between the tap and the save.
 *
 * The id is what makes this page survive a reload. It used to take whichever draft was active,
 * which is fine until the page is refreshed or opened on another phone: hydration restores the
 * shop's open orders and makes the FIRST one active, so a reload landed on a payment screen for
 * the wrong customer. Resolved by id it is the same order every time, and the fallback to the
 * active one keeps the case where the id is not yet known working exactly as before.
 *
 * WHAT COMES BACK goes through `provideObject`, because a pushed page has no return value. The
 * sell screen publishes two callbacks: one to attach a customer (its picker lives there, over the
 * receipt being built), and one to run when the sale is settled — pushing the receipt and closing
 * the tab. Both are optional; without them this page still records the payment, which is the part
 * that must not depend on anybody listening.
 */
export default function TakePaymentPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const { store } = useAuth();
  const location = useLocation();
  const wantedId = (location?.params?.id as string | undefined) ?? null;

  const { orders, activeOrder: current, updateOrder, syncing } = useDraftOrders(store?.id ?? null);

  // By id first; the active tab only when no id travelled with the push.
  const activeOrder = wantedId ? (orders.find((o) => o.id === wantedId) ?? null) : current;

  /*
   * CHOOSING A CUSTOMER HAPPENS HERE, on this page.
   *
   * It used to pop back to the till, because the picker lived there and the reasoning was that
   * seeing what is being bought is most of how a seller recognises who is buying it. That is true
   * and it was still wrong: THIS PAGE ALREADY LISTS WHAT THEY ARE BUYING, three rows above the
   * customer, so nothing was gained — and popping a pushed page throws away everything typed on
   * it. A seller who had entered a delivery charge and a note, then realised the balance was going
   * on account, came back to an empty form and had to do it again. Measured, not assumed: a probe
   * typed both, tapped "Recording for", and found them gone.
   */
  const [picking, setPicking] = useState(false);

  const settled = useObject<(saleId: string) => void>('onSaleSettled', {
    global: true,
    scope: 'sell',
  });

  /*
   * THE LISTS THIS SALE CHANGES, told rather than asked.
   *
   * These moved here with the writes they belong to. They were inside `TakePayment`, which also
   * serves correcting a settled receipt now — and a correction does not put a NEW row on the sales
   * list or add to a debtor's balance, it changes a row that is already there. Two behaviours
   * sharing one notification block is how the correction path would have started announcing sales
   * that did not happen.
   */
  const notifySales = useListNotifier<{
    id: string;
    occurred_at: string;
    total: string;
    paid: string;
    outstanding: string;
    customer_id: string | null;
    customer_name: string | null;
    note: string | null;
    line_count: number;
  }>('sales');
  const notifyDebtors = useListNotifier<{ id: string; balance: string }>('debtors');
  /*
   * The People list carries a balance too, and it was never told. It used to be swept up by
   * `accountsChanged()`, which re-read the whole list; now that only the derived figures re-read,
   * the one row that moved is patched here.
   */
  const notifyCustomers = useListNotifier<{ id: string; balance: string }>('customers');

  if (!store) return null;

  /*
   * No open order.
   *
   * Reachable by a reload or a pasted link after the tab was closed — the draft is working state,
   * not a record, so there is nothing to restore and nothing to apologise for.
   */
  /*
   * ONE HEADER. Still fetching is not the same as gone: on a reload this page renders before the
   * shop's open orders have come back, and saying "no longer open" for that second is a lie that
   * sends a seller off to start the sale again.
   */
  const status: PageStatus = activeOrder
    ? { state: 'ready' }
    : syncing || (wantedId && orders.length === 0)
      ? { state: 'loading', what: 'this sale' }
      : {
          state: 'empty',
          title: 'This sale is no longer open',
          body: 'It was settled or closed. Start a new one from the Sell screen.',
        };

  return (
    <PageScaffold
      onBack={goBack}
      title="Take payment"
      subtitle="Cash, transfer, or on account"
    >
      <PageState status={status}>
        {() =>
          activeOrder && (
            <>
      {/*
        Back to the receipt, in the same place the till puts "Take payment".

        The two screens are one job seen from two ends, and a seller moves between them more than
        once on a real sale — the customer adds a last item while the change is being counted. The
        header arrow does the same thing, but it is a small target at the top of the screen and
        the thumb is already at the bottom.
      */}
      <FloatingAmount
        who={activeOrder.customerName || 'this sale'}
        label="Add more items"
        amount={<PlusIcon />}
        onClick={() => void nav.pop()}
      />
      <TakePayment
        order={activeOrder}
        onUpdateOrder={(patch) => updateOrder(activeOrder.clientUuid, patch)}
        storeId={store.id}
        total={draftTotal(activeOrder)}
        onNeedCustomer={() => setPicking(true)}
        /*
         * SETTLING A DRAFT — this page's job, and not the payment screen's.
         *
         * `TakePayment` composes the money and hands over the facts; what is written with them
         * depends on what is being paid for. Here it is a draft becoming a sale, which means a new
         * row on the sales list and, when something goes on account, a debtor's balance moving.
         * Correcting a settled receipt writes none of that and calls `amend_sale` instead.
         */
        commit={async ({
          payments,
          depositNow,
          depositReason,
          paidTotal,
          towardsOldDebt,
          previousBalance,
          stockOut,
          containersOut,
        }) => {
          if (!activeOrder.id) {
            throw new Error('This order has not saved to the shop yet. Try again in a moment.');
          }
          const total = draftTotal(activeOrder);

          /*
           * THE SALE AND ITS DEPOSIT, IN ONE TRANSACTION (0152).
           *
           * These were two calls: settle, then take the deposit. A deposit call that failed left
           * the sale settled and the customer's money recorded nowhere. `settle_draft_with_deposit`
           * does both or neither, and a retry after a timeout returns the sale already recorded
           * without taking the deposit twice. The draft's client id is still the idempotency key.
           */
          const { data, error: err } = await getSupabase().rpc('settle_draft_with_deposit', {
            p_draft_id: activeOrder.id,
            p_payments: payments,
            p_client_uuid: activeOrder.clientUuid,
            p_deposit: depositNow > 0 ? depositNow : null,
            p_deposit_reason: depositReason,
          });
          if (err) throw err;
          const saleId = data as string;

          /*
           * ── CHANGE IS MONEY LEAVING, NOT A DEBT ──────────────────────────────
           *
           * "the 250 it shows i owe that is wrong because that was change ... i only owe if a
           * sale settle was opened and edit smaller than the payment i collected."
           *
           * Exactly the distinction. `settle_sale` keeps a payment at its true tendered figure
           * and caps only the ALLOCATION (0188), which is right for somebody who genuinely pays
           * over to sit in credit. Samod handed over N10,000 for a N9,750 bill and took N250
           * back across the counter a second later — and the books read "the shop owes Samod
           * N250" because nothing recorded the money going back out.
           *
           * ONLY THE CASH PART. A transfer that arrives over the bill really is credit: nobody
           * hands cash back for it, and the customer's next purchase draws it down. Change is
           * what came out of the drawer, so it is capped at what went into the drawer.
           */
          const cashIn = payments
            .filter((pay) => pay.method === 'cash')
            .reduce((sum, pay) => sum + Number(pay.amount || 0), 0);
          const change = Math.min(Math.max(paidTotal - total - towardsOldDebt, 0), cashIn);

          if (change > 0.005 && activeOrder.customerId) {
            const { error: backErr } = await getSupabase().rpc('record_money_back', {
              p_store_id: store.id,
              p_customer_id: activeOrder.customerId,
              p_amount: change,
              p_method: 'cash',
              p_reason: 'Change given at the counter',
              p_client_uuid: crypto.randomUUID(),
              p_bank_account_id: null,
            });
            /*
             * Not fatal. The sale is recorded and the customer has their goods and their change;
             * a failure here leaves a credit on the account, which the shop can give back from
             * the account screen. Losing the sale over it would be the worse trade.
             */
            if (backErr) console.warn('change was not recorded as money back', backErr.message);
          }

          /*
           * THIS DEVICE KNOWS WHAT IT JUST DID — so every screen showing a figure this sale moved
           * says the new one now, on screen or not: the shelf, what the customer owes, the
           * containers they took, the deposit taken. The invalidations below then re-read each from
           * the server, which has the last word.
           */
          applySaleLocally({
            storeId: store.id,
            saleId,
            customer: activeOrder.customerId
              ? { id: activeOrder.customerId, name: activeOrder.customerName || 'Customer' }
              : null,
            // What went on account, less whatever paid down an older debt.
            balanceDelta: Math.max(0, total - paidTotal) - towardsOldDebt,
            deposit: depositNow > 0 ? { amount: depositNow, reason: depositReason } : null,
            stockOut,
            containersOut,
          });

          accountsChanged();
          /*
           * AND THE EMPTIES LIST. A sale in a shape that comes back writes a container row for the
           * customer, and the Empties page lives in its own scope that `accountsChanged` never
           * reaches — so a customer who had just taken three crates was missing from the list
           * until the page was reloaded by hand.
           */
          ledgersChanged();
          /*
           * A SALE MOVES STOCK, and the stock screens were never told. `accountsChanged()` covers
           * balances and empties; nothing covered the shelf, so a shop could sell all afternoon
           * and read this morning's figures.
           */
          stockMoved();

          /*
           * Tell the sales list about THIS sale, rather than telling it to read everything again.
           * Every figure here is one this page just committed, not a guess — which is the
           * difference between patching a list and lying to it.
           */
          notifySales({
            type: 'upsert',
            row: {
              id: saleId,
              occurred_at: new Date().toISOString(),
              total: String(total),
              paid: String(paidTotal),
              outstanding: String(Math.max(0, total - paidTotal)),
              customer_id: activeOrder.customerId,
              customer_name: activeOrder.customerName || null,
              note: activeOrder.note || null,
              line_count: activeOrder.lines.length,
            },
          });

          /*
           * And the debtor list, when this sale left money on account. That list no longer re-reads
           * itself when you return to it, so the one screen that knows a balance moved has to say
           * so.
           */
          const wentOnAccount = Math.max(0, total - paidTotal);
          if (activeOrder.customerId && wentOnAccount > 0 && previousBalance !== null) {
            /*
             * `previousBalance` is what they owed BEFORE this sale — the figure the payment screen
             * fetched and showed while the seller decided whether to extend more credit — so the
             * new balance is that plus whatever went on account just now. Only patched when it was
             * actually read: a list told a figure nobody saw is worse than a list not told.
             */
            const owedNow = String(previousBalance + wentOnAccount);
            notifyDebtors({ type: 'patch', id: activeOrder.customerId, patch: { balance: owedNow } });
            notifyCustomers({ type: 'patch', id: activeOrder.customerId, patch: { balance: owedNow } });
          }

          if (settled.isProvided) {
            settled.getter()?.(saleId);
            return;
          }
          /*
           * Nobody listening — still show the receipt, which is the point of settling.
           *
           * `pushAndPopUntil` rather than `push`: the payment screen is finished the moment the
           * sale exists, and leaving it under the receipt means Back walks into a payment for a
           * sale already made.
           */
          void nav.pushAndPopUntil('receipt_page', (entry) => entry.key === 'sell_page', {
            id: saleId,
            fresh: '1',
          });
        }}
      />

      <CustomerPicker
        open={picking}
        onClose={() => setPicking(false)}
        storeId={store.id}
        initialName={activeOrder.customerName}
        onPick={(customer) => {
          updateOrder(activeOrder.clientUuid, {
            customerId: customer.id,
            customerName: customer.name,
            customerPhone: customer.phone,
          });
          setPicking(false);
        }}
        /*
         * Creating one is still a page, and still pushed from HERE.
         *
         * The form hands the new customer back through the callback the sell screen publishes, and
         * that attaches it to the order this page is paying for — the same order, so there is
         * nothing extra to wire. Popping the form lands back on this page with the payment intact,
         * which is the whole point.
         */
        onCreate={(name) => {
          setPicking(false);
          void nav.push('customer_form_page', {
            ...(name.trim() ? { name } : {}),
            then: 'attach-to-sale',
                      // Mid-sale: ask for the opening position while the shop is with them.
            required: 'minimum',
          });
        }}
      />
            </>
          )
        }
      </PageState>
    </PageScaffold>
  );
}
