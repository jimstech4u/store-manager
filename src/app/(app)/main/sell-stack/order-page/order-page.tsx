'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { formatMoney, formatQty, messageOf } from '@/lib/format';
import { acceptOnlineOrder, declineOrder, useOnlineOrder } from '@/lib/stacks/online-orders';
import styles from './order-page.module.css';

/**
 * ONE ORDER FROM THE MARKETPLACE, IN FULL, BEFORE THE SHOP ANSWERS IT.
 *
 * The queue used to offer Accept and Decline under a line reading "4 items · ₦18,400". Deciding
 * from a total is not deciding: what the shop needs to know is which products, how many of each, at
 * what price, and whether it actually has them. So the queue lists orders and this screen answers
 * one.
 *
 * WHAT IT SHOWS ABOUT STOCK is what the shop last recorded, and it is said as a figure rather than
 * a verdict — "wants 8, you have 3" — because the shop knows things the stock count does not. A
 * screen that refused an order on the strength of its own arithmetic would be wrong regularly and
 * annoying always.
 *
 * ACCEPTING OPENS IT AT THE TILL, with the shopper attached as a customer of this shop. Nothing is
 * sold here: the till still confirms the quantities and still takes the money, through the same
 * screen a sale at the counter goes through. There is one way to make a sale in this app.
 */
export default function OrderPage() {
  const nav = useNav();
  const goBack = useStackBack();
  const location = useLocation();
  const id = (location?.params?.id as string | undefined) ?? null;

  const order = useOnlineOrder(id);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const declineDialog = useConfirm();
  const problem = useProblem();

  const accept = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await acceptOnlineOrder(id);
      /*
       * Back to the till, where the order now is. `popToRoot` rather than a push: this screen and
       * the queue behind it are both finished with, and leaving them in the stack would let Back
       * walk into a decision that has already been made.
       */
      await nav.popToRoot();
    } catch (e) {
      problem.show(messageOf(e, 'That order could not be opened.'));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await declineOrder(id);
      await nav.pop();
    } catch (e) {
      problem.show(messageOf(e, 'That order could not be declined.'));
    } finally {
      setBusy(false);
      setDeclining(false);
    }
  };

  const data = order.data;
  const status: PageStatus = !order.loaded
    ? order.error
      ? { state: 'error', what: 'this order', error: order.error, onRetry: order.reload }
      : { state: 'loading', what: 'this order' }
    : !data
      ? {
          state: 'empty',
          title: 'That order is not here',
          body: 'It may have been answered already, or from another shop.',
        }
      : { state: 'ready' };

  const answered = data && data.status !== 'open';

  return (
    <PageScaffold
      title="Order"
      subtitle={data ? `${data.code} · from the marketplace` : 'From the marketplace'}
      onBack={goBack}
    >
      <PageState status={status}>
        {() =>
          data && (
            <>
              <section className={styles.who}>
                <p className={styles.name}>{data.customer_name ?? 'A shopper'}</p>
                {data.customer_phone && (
                  /* A number the shop can ring, as a link — this is a phone. */
                  <a className={styles.phone} href={`tel:${data.customer_phone}`}>
                    {data.customer_phone}
                  </a>
                )}
                {data.note && <p className={styles.note}>“{data.note}”</p>}
              </section>

              <ul className={styles.lines}>
                {data.lines.map((line) => {
                  const short = line.in_stock < line.qty;
                  return (
                    <li key={line.product_id} className={styles.line}>
                      <div className={styles.lineTop}>
                        <span className={styles.lineName}>{line.name}</span>
                        <span className={styles.lineTotal}>{formatMoney(line.line_total)}</span>
                      </div>
                      <p className={styles.lineMeta}>
                        {formatQty(line.qty)} {line.unit} × {formatMoney(line.unit_price)}
                      </p>
                      {/*
                        Said as a figure, not a verdict. The shop knows what is arriving this
                        afternoon and what is miscounted; this screen does not.
                      */}
                      {short && (
                        <p className={styles.short}>
                          Your count says {formatQty(line.in_stock)} in stock.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              <div className={styles.totalRow}>
                <span>Total asked for</span>
                <strong className={styles.total}>{formatMoney(data.total)}</strong>
              </div>

              {answered ? (
                <p className={styles.done}>
                  {data.status === 'settled'
                    ? 'This order has been accepted.'
                    : 'This order was turned down.'}
                </p>
              ) : (
                <div className={styles.actions}>
                  <Button size="large" fullWidth busy={busy} onClick={() => void accept()}>
                    Accept and open at the till
                  </Button>
                  <Button
                    variant="secondary"
                    size="large"
                    fullWidth
                    disabled={busy}
                    onClick={() => setDeclining(true)}
                  >
                    Decline
                  </Button>
                </div>
              )}
            </>
          )
        }
      </PageState>

      {/*
        Mounted only while it is asking — `ConfirmDialog` opens itself on mount, so one rendered
        unconditionally puts a question on screen the moment the page does.
      */}
      {declining && (
        <ConfirmDialog
          controller={declineDialog}
          title="Decline this order?"
          message="The shopper will be told it was not accepted. Nothing has been sold and no stock moves."
          confirmText="Decline it"
          cancelText="Keep it"
          tone="danger"
          onConfirm={() => void decline()}
          onDismiss={() => setDeclining(false)}
        />
      )}
      <ProblemDialog problem={problem} title="Could not answer this order" />
    </PageScaffold>
  );
}
