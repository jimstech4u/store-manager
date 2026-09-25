'use client';

import { useState } from 'react';
import { useLocation, useNav } from '@academix-admin/navigation-stack';
import { PageScaffold } from '@/components/ui/PageScaffold';
import { PageState, type PageStatus } from '@/components/ui/PageState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, ProblemDialog, useConfirm, useProblem } from '@/components/ui/Dialog';
import { useStackBack } from '@/hooks/useStackBack';
import { formatMoney, formatQty, messageOf } from '@/lib/format';
import {
  acceptOnlineOrder,
  declineOrder,
  reopenOnlineOrder,
  useOnlineOrder,
  useOrderHistory,
} from '@/lib/stacks/online-orders';
import { usePermission } from '@/hooks/usePermission';
import { Field } from '@/components/ui/Field';
import { useAuth } from '@/providers/AuthProvider';
import { useDraftOrders } from '@/lib/stacks/draft-orders';
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

  const { store } = useAuth();
  const { claimByCode } = useDraftOrders(store?.id ?? null);
  const order = useOnlineOrder(id);
  const history = useOrderHistory(id);
  const { can } = usePermission();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const declineDialog = useConfirm();
  const problem = useProblem();

  const data = order.data;

  /*
   * PUTTING AN ANSWER BACK is a correction, not an undo, so it asks for `sales.amend` — the same
   * permission as changing a sale after the fact, and for the same reason. Answering an order is a
   * seller's job; changing an answer already given is the owner's and the manager's.
   */
  const mayReopen = can('sales.amend');

  const reopen = async () => {
    if (!id || !reason.trim()) return;
    setBusy(true);
    try {
      await reopenOnlineOrder(id, reason.trim());
      setReopening(false);
      setReason('');
      order.reload();
      history.reload();
    } catch (e) {
      problem.show(messageOf(e, 'That order could not be reopened.'));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!id || !data) return;
    setBusy(true);
    try {
      /*
       * TWO STEPS, AND BOTH ARE NECESSARY.
       *
       * `accept_online_order` attaches the shop's customer record for this shopper — that is the
       * part only the server can do. It also claims the draft, which makes it the shop's, but the
       * TILL does not learn anything from that: its open orders are a list it holds, and an order
       * claimed behind its back is an order it has never heard of. Accepting used to do only this
       * and land on a till saying "No customer being served", with the order sitting in the
       * database perfectly claimed.
       *
       * `claimByCode` is the till's own way of taking on an order — the same call the counter makes
       * when somebody reads a code aloud. It loads the lines, puts it in the list and makes it the
       * customer being served. Claiming twice costs nothing: `claim_draft_order` sets
       * `held_by = auth.uid()` on an open order, which it already is.
       *
       * IN THIS ORDER, because the customer must be on the row before the till reads it. The other
       * way round the till would adopt the order and show no customer on it.
       */
      await acceptOnlineOrder(id);
      const claimed = await claimByCode(data.code);
      if (!claimed) throw new Error('The order was accepted but could not be opened at the till.');

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

  /*
   * ANSWERED means the shop has said something, which is not the same as the sale being over. An
   * accepted order sits at `status = 'open'` while it is at the till — reading that as "still
   * waiting" is what let one be accepted twice.
   */
  const answered = Boolean(data?.answer);

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
                <>
                  <p className={styles.done}>
                    {data.answer === 'accepted'
                      ? data.status === 'settled'
                        ? 'Accepted, and sold at the till.'
                        : 'Accepted. It is open at the till.'
                      : 'Turned down.'}
                  </p>

                  {/*
                    A way back, for an answer given by mistake — and only for somebody allowed to
                    correct one. An order that has become a SALE is not reopened here: that is a
                    void, with its own ledger entries and its own permission, and the server
                    refuses it either way.
                  */}
                  {mayReopen && data.status !== 'settled' && !reopening && (
                    <Button
                      variant="secondary"
                      size="large"
                      fullWidth
                      onClick={() => setReopening(true)}
                    >
                      Put it back in the queue
                    </Button>
                  )}

                  {reopening && (
                    <div className={styles.reopen}>
                      <Field
                        label="Why is this being reopened?"
                        required
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Declined by mistake"
                        hint="Kept with the order, so anyone reviewing it later can see why."
                      />
                      <div className={styles.actions}>
                        <Button
                          size="large"
                          fullWidth
                          busy={busy}
                          disabled={!reason.trim()}
                          onClick={() => void reopen()}
                        >
                          Put it back in the queue
                        </Button>
                        <Button
                          variant="secondary"
                          size="large"
                          fullWidth
                          disabled={busy}
                          onClick={() => {
                            setReopening(false);
                            setReason('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </>
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
        WHAT HAS HAPPENED TO THIS ORDER, in order.
        
        Append-only on the server. It is here because an answer can be taken back: "accepted,
        reopened, turned down" is a real sequence, and a shop that cannot see it cannot review it.
      */}
      {history.loaded && (history.data?.length ?? 0) > 0 && (
        <section className={styles.history}>
          <h2 className={styles.historyTitle}>History</h2>
          <ul className={styles.events}>
            {history.data?.map((e, i) => (
              <li key={i} className={styles.event}>
                <span className={styles.eventWhat}>
                  {e.action === 'placed'
                    ? 'Ordered'
                    : e.action === 'accepted'
                      ? 'Accepted'
                      : e.action === 'declined'
                        ? 'Turned down'
                        : 'Put back in the queue'}
                  {' by '}
                  {e.actor_name}
                </span>
                <span className={styles.eventWhen}>
                  {new Date(e.at).toLocaleString('en-NG', {
                    day: 'numeric',
                    month: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                {e.reason && <span className={styles.eventWhy}>“{e.reason}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

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
