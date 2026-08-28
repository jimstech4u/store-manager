'use client';

import { useNav, useObject } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
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
 * NOTHING IS PASSED IN. The order is the shop's ACTIVE draft, which `useDraftOrders` already owns
 * — so this page reads the same working state the sell screen writes, rather than being handed a
 * copy that could go stale between the tap and the save.
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
  const { activeOrder } = useDraftOrders(store?.id ?? null);

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
          // Nobody listening — still show the receipt, which is the point of settling.
          void nav.push('receipt_page', { id: saleId, fresh: '1' });
        }}
      />
    </PageScaffold>
  );
}
