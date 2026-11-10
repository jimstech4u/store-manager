'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { OrderItems } from '@/components/sell/OrderItems';
import { CustomerPicker } from '@/components/customers/CustomerPicker';
import { useStackBack } from '@/hooks/useStackBack';
import { useAuth } from '@/providers/AuthProvider';
import { orderById, useDraftOrders } from '@/lib/stacks/draft-orders';
import { swapTo } from '@/lib/finish-flow';

/**
 * ALL ITEMS AS A PAGE — kept for a stack restored from before it became a sheet.
 *
 * The till and Take payment open All items as a sheet now (`OrderItemsSheet`, 10 Nov); nothing
 * pushes this route any more. A tab whose saved history still holds it would otherwise come back on
 * "missing route", so the route stays and draws the same `OrderItems` the sheet does.
 */
export default function OrderItemsPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const { store } = useAuth();
  const wantedId = (location?.params?.id as string | undefined) ?? null;
  const { orders, activeOrder, updateOrder } = useDraftOrders(store?.id ?? null);
  const order = wantedId ? orderById(orders, wantedId) : activeOrder;
  const [pickingCustomer, setPickingCustomer] = useState(false);

  if (!store) return null;

  return (
    <PageScaffold layout="record" onBack={goBack} title="All items" subtitle={order?.customerName || 'This order'}>
      <OrderItems
        orderId={wantedId}
        onChooseCustomer={() => setPickingCustomer(true)}
        // Swapped for Take payment, not left underneath: Back from the payment goes to the till.
        onPay={(id) => swapTo(nav, 'take_payment_page', { id })}
      />
      {order && (
        <CustomerPicker
          open={pickingCustomer}
          onClose={() => setPickingCustomer(false)}
          storeId={store.id}
          initialName={order.customerName}
          onPick={(customer) => {
            updateOrder(order.clientUuid, {
              customerId: customer.id,
              customerName: customer.name,
              customerPhone: customer.phone,
            });
            setPickingCustomer(false);
          }}
          onCreate={(name) => {
            setPickingCustomer(false);
            void nav.push('customer_form_page', {
              ...(name.trim() ? { name } : {}),
              then: 'attach-to-payment',
              required: 'minimum',
            });
          }}
        />
      )}
    </PageScaffold>
  );
}
