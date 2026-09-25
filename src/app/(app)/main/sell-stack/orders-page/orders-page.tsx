'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { SearchField, useDebounced } from '@/components/ui/SearchField';
import { ChevronRightIcon } from '@/components/ui/Icon';
import { formatMoney } from '@/lib/format';
import { useOnlineOrderList, type OrdersFilter } from '@/lib/stacks/online-orders';
import styles from './orders-page.module.css';

/**
 * ORDERS FROM THE MARKETPLACE — the ones waiting, and every one before them.
 *
 * A shopper fills a basket on the public side and asks this shop for it. Nothing has happened yet:
 * no stock has moved, nothing is owed, and the shop has agreed to nothing. That is why this screen
 * exists rather than the order turning up in Sales — a request typed at midnight by somebody the
 * shop has never met is not a sale, and a ledger that counted it as one would lie about what the
 * shop is owed.
 *
 * THIS SCREEN ONLY LISTS. It used to carry Accept and Decline on every card, under a line reading
 * "4 items · ₦18,400" — which asked somebody to commit stock on the strength of a total. A card
 * opens the order; the order is answered on its own screen, where the lines are.
 *
 * AND IT REMEMBERS. The first version showed only what was waiting, which is the right first
 * question and the only one it could answer. "Did I accept that one?", "what came in today?" and
 * "where is Ade's order?" are the questions a shop asks next, and they are what the tabs, the period
 * and the search are for.
 */
const WHEN: { id: OrdersFilter['when']; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All' },
];

const TABS: { id: OrdersFilter['answer']; label: string }[] = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'declined', label: 'Turned down' },
  { id: 'all', label: 'All' },
];

export default function OrdersPage() {
  const nav = useNav();
  const { store } = useAuth();

  const [answer, setAnswer] = useState<OrdersFilter['answer']>('waiting');
  /*
   * "All" by default, not "today".
   *
   * An order waiting since yesterday is still waiting, and a queue that hid it would be a queue
   * that quietly lost work. The period is there for looking BACK through answered orders, which is
   * where a shop actually wants to narrow.
   */
  const [when, setWhen] = useState<OrdersFilter['when']>('all');
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed);

  const orders = useOnlineOrderList(store?.id ?? null, { answer, when, query });

  const list = orders.data ?? [];
  const searching = query.trim() !== '' || when !== 'all';
  const status: PageStatus = !orders.loaded
    ? orders.error
      ? { state: 'error', what: 'orders', error: orders.error, onRetry: orders.reload }
      : { state: 'loading', what: 'orders' }
    : list.length === 0
      ? {
          state: 'empty',
          title: searching
            ? 'Nothing matches that'
            : answer === 'waiting'
              ? 'No orders waiting'
              : answer === 'accepted'
                ? 'None accepted yet'
                : answer === 'declined'
                  ? 'None turned down'
                  : 'No orders yet',
          body:
            searching
              ? 'Try a different word, or widen the period.'
              : 'When somebody orders from your shop on the marketplace, it waits here until you answer it.',
        }
      : { state: 'ready' };

  return (
    <PageScaffold
      title="Orders"
      subtitle="Asked for from the marketplace"
      onBack={() => void nav.pop()}
    >
      <SearchField
        value={typed}
        onChange={setTyped}
        placeholder="Search a code, a shopper or a product"
        label="Search marketplace orders"
      />

      {/* What the shop said, which is the first thing anybody is filtering by. */}
      <div className={styles.tabs} role="group" aria-label="Show">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={answer === t.id ? styles.tabOn : styles.tab}
            aria-pressed={answer === t.id}
            onClick={() => setAnswer(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.when} role="group" aria-label="When">
        {WHEN.map((w) => (
          <button
            key={w.id}
            type="button"
            className={when === w.id ? styles.whenOn : styles.whenChip}
            aria-pressed={when === w.id}
            onClick={() => setWhen(w.id)}
          >
            {w.label}
          </button>
        ))}
      </div>

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
                    <span className={styles.who}>{order.customer_name ?? 'A shopper'}</span>
                    <span className={styles.code}>{order.code}</span>
                  </span>

                  {/* What the shop said about it, on every card, so a mixed list reads at a
                      glance. Nothing is drawn for one still waiting — that is what the queue IS,
                      and a "waiting" badge on every row of the waiting tab is furniture. */}
                  {order.answer && (
                    <span className={order.answer === 'accepted' ? styles.accepted : styles.declined}>
                      {order.answer === 'accepted'
                        ? order.status === 'settled'
                          ? 'Accepted · sold'
                          : 'Accepted'
                        : 'Turned down'}
                    </span>
                  )}

                  {/* What is on it, so one order is distinguishable from another without opening
                      both. */}
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
