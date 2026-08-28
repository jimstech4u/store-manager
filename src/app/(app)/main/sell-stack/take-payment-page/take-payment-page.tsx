'use client';

import { useLocation, useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { FloatingAmount } from '@/components/ui/FloatingAmount';
import { PlusIcon } from '@/components/ui/Icon';
import { FullPageMessage } from '@/components/ui/FullPageMessage';
import { TakePayment } from '../sell-page/TakePayment';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { draftTotal, useDraftOrders } from '@/lib/stacks/draft-orders';

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

  const { orders, activeOrder: current, syncing } = useDraftOrders(store?.id ?? null);

  // By id first; the active tab only when no id travelled with the push.
  const activeOrder = wantedId ? (orders.find((o) => o.id === wantedId) ?? null) : current;

  const needCustomer = useObject<() => void>('onNeedCustomer', { global: true, scope: 'sell' });
  const settled = useObject<(saleId: string) => void>('onSaleSettled', {
    global: true,
    scope: 'sell',
  });

  if (!store) return null;

  /*
   * No open order.
   *
   * Reachable by a reload or a pasted link after the tab was closed — the draft is working state,
   * not a record, so there is nothing to restore and nothing to apologise for.
   */
  if (!activeOrder) {
    /*
     * Still fetching is not the same as gone.
     *
     * On a reload this page renders before the shop's open orders have come back, and saying "no
     * longer open" for that second is a lie that sends a seller off to start the sale again.
     */
    if (syncing || (wantedId && orders.length === 0)) {
      return <FullPageMessage title="Opening this sale" tone="loading" />;
    }

    return (
      <PageScaffold onBack={goBack} title="Take payment">
        <FullPageMessage title="This sale is no longer open">
          It was settled or closed. Start a new one from the Sell screen.
        </FullPageMessage>
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      onBack={goBack}
      title="Take payment"
      subtitle="Cash, transfer, or on account"
    >
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
        storeId={store.id}
        total={draftTotal(activeOrder)}
        onNeedCustomer={() => {
          /*
           * Back to the sell screen to attach somebody, then here again.
           *
           * The customer picker belongs over the receipt being built, not over the payment: seeing
           * what is being bought is most of how a seller recognises who is buying it.
           */
          void nav.pop();
          if (needCustomer.isProvided) needCustomer.getter()?.();
        }}
        onSettled={(saleId) => {
          if (settled.isProvided) {
            settled.getter()?.(saleId);
            return;
          }
          /*
           * Nobody listening — still show the receipt, which is the point of settling.
           *
           * `pushAndPopUntil` rather than `push`: the payment screen is finished the moment the
           * sale exists, and leaving it under the receipt means Back walks into a payment for a
           * sale already made. Back from the receipt goes to the till, ready for the next
           * customer, which is where a seller is going anyway.
           */
          void nav.pushAndPopUntil('receipt_page', (entry) => entry.key === 'sell_page', {
            id: saleId,
            fresh: '1',
          });
        }}
      />
    </PageScaffold>
  );
}
