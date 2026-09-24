'use client';

import { useState } from 'react';
import { useNav } from '@academix-admin/navigation-stack';
import { useAuth } from '@/providers/AuthProvider';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { formatMoney } from '@/lib/format';
import { useDraftOrders } from '@/lib/stacks/draft-orders';
import { declineOrder, useOnlineOrders, type OnlineOrder } from '@/lib/stacks/online-orders';
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
 * ACCEPTING OPENS IT AT THE TILL. Not "creates a sale": the shop still confirms the quantities and
 * still takes the money, through the same screen it uses for somebody standing at the counter. An
 * accepted order is a claimed draft, and from that moment it is indistinguishable from one written
 * by hand — which is the point. There is one way to make a sale in this app.
 */
export default function OrdersPage() {
  const nav = useNav();
  const { store } = useAuth();
  const orders = useOnlineOrders(store?.id ?? null);
  const { claimByCode } = useDraftOrders(store?.id ?? null);

  const [busy, setBusy] = useState<string | null>(null);
  const [toDecline, setToDecline] = useState<OnlineOrder | null>(null);
  const declineDialog = useConfirm();
  const problem = useProblem();

  const accept = async (order: OnlineOrder) => {
    setBusy(order.id);
    try {
      /*
       * Claim it, then go back to the till — where it is now the open order. The same call the
       * counter makes when a colleague reads out a code, because this IS that: somebody handing the
       * shop an order it has not started.
       */
      await claimByCode(order.code);
      nav.popToRoot();
    } catch (e) {
      problem.show(e instanceof Error ? e.message : 'That order could not be opened.');
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    if (!toDecline) return;
    setBusy(toDecline.id);
    try {
      await declineOrder(toDecline.id);
      setToDecline(null);
    } catch (e) {
      problem.show(e instanceof Error ? e.message : 'That order could not be declined.');
    } finally {
      setBusy(null);
    }
  };

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
    <PageScaffold title="Orders" subtitle="Asked for from the marketplace" onBack={() => void nav.pop()}>
      <PageState status={status}>
        {() => (
          <ul className={styles.list}>
            {list.map((order) => (
              <li key={order.id} className={styles.order}>
                <div className={styles.head}>
                  <span className={styles.who}>{order.customer_name ?? order.label ?? 'A shopper'}</span>
                  <span className={styles.code}>{order.code}</span>
                </div>

                <p className={styles.what}>
                  {order.lines} {order.lines === 1 ? 'item' : 'items'} · {formatMoney(order.total)}
                </p>

                <div className={styles.actions}>
                  <Button
                    size="large"
                    fullWidth
                    busy={busy === order.id}
                    onClick={() => void accept(order)}
                  >
                    Accept and open at the till
                  </Button>
                  <Button
                    variant="secondary"
                    size="large"
                    fullWidth
                    disabled={busy === order.id}
                    onClick={() => {
                      setToDecline(order);
                      declineDialog.open();
                    }}
                  >
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PageState>

      {/*
        Asked before declining, because the shopper is told and it cannot be taken back. Accepting
        needs no such question: the next screen is the till, where anything can still be changed.
      */}
      <ConfirmDialog
        controller={declineDialog}
        title="Decline this order?"
        message="The shopper will be told it was not accepted. Nothing has been sold and no stock moves."
        confirmText="Decline it"
        cancelText="Keep it"
        tone="danger"
        onConfirm={() => void decline()}
        onDismiss={() => setToDecline(null)}
      />
      <ProblemDialog problem={problem} title="Could not answer this order" />
    </PageScaffold>
  );
}
