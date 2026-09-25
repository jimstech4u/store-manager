'use client';

import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { formatMoney } from '@/lib/format';
import { useOnlineOrders } from '@/lib/stacks/online-orders';
import styles from './orders-page.module.css';

/**
 * ORDERS ASKED FOR FROM THE MARKETPLACE, WAITING ON AN ANSWER.
 *
 * A shopper fills a basket on the public side and asks this shop for it. Nothing has happened yet:
 * no stock has moved, nothing is owed, and the shop has agreed to nothing. That is the whole reason
 * this screen exists rather than the order simply turning up in Sales — a request typed at midnight
 * by somebody the shop has never met is not a sale, and a ledger that counted it as one would lie
 * about what the shop is owed.
 *
 * THIS SCREEN ONLY LISTS. It used to carry Accept and Decline on every card, under a line reading
 * "4 items · ₦18,400" — which asked somebody to commit stock on the strength of a total. A card
 * opens the order; the order is answered on its own screen, where the lines are.
 */
export default function OrdersPage() {
  const nav = useNav();
  const { store } = useAuth();
  const orders = useOnlineOrders(store?.id ?? null);

  const list = orders.data ?? [];
  const status: PageStatus = !orders.loaded
    ? orders.error
      ? { state: 'error', what: 'orders', error: orders.error, onRetry: orders.reload }
      : { state: 'loading', what: 'orders' }
    : list.length === 0
      ? {
          state: 'empty',
          title: 'No orders waiting',
          body: 'When somebody orders from your shop on the marketplace, it waits here until you accept it.',
        }
      : { state: 'ready' };

  return (
    <PageScaffold
      title="Orders"
      subtitle="Asked for from the marketplace"
      onBack={() => void nav.pop()}
    >
      <PageState status={status}>
        {() => (
          <ul className={styles.list}>
            {list.map((order) => (
              <li key={order.id}>
                {/*
                  The whole card is the target. A chevron with a small "View" beside it would be two
                  things to aim at, one of them small, on a screen used one-handed.
                */}
                <button
                  type="button"
                  className={styles.order}
                  onClick={() => void nav.push('order_page', { id: order.id })}
                >
                  <span className={styles.head}>
                    <span className={styles.who}>
                      {order.customer_name ?? order.label ?? 'A shopper'}
                    </span>
                    <span className={styles.code}>{order.code}</span>
                  </span>

                  {/* What is on it, so one order is distinguishable from another without opening
                      both. Truncated by CSS rather than by cutting the text, so the count beside
                      it stays the truth about how much more there is. */}
                  {order.preview && <span className={styles.preview}>{order.preview}</span>}

                  <span className={styles.what}>
                    {order.lines} {order.lines === 1 ? 'item' : 'items'} ·{' '}
                    {formatMoney(order.total)}
                  </span>

                  <span className={styles.go}>
                    Look at this order <ChevronRightIcon size="1em" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PageState>
    </PageScaffold>
  );
}
