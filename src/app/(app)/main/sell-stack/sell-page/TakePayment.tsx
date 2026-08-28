'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './TakePayment.module.css';
import { Button } from '@/components/ui/Button';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { Collapsible } from '@/components/ui/Collapsible';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { formatMoney } from '@/lib/format';
import { chargesTotal, lineTotal, type DraftOrder } from '@/lib/stacks/draft-orders';

type Method = 'cash' | 'transfer' | 'pos';

const METHOD_LABEL: Record<Method, string> = {
  cash: 'Cash',
  transfer: 'Transfer',
  pos: 'POS',
};

interface PaymentRow {
  key: string;
  method: Method;
  amount: string;
  reference: string;
  /** Which of the shop's accounts a transfer landed in. Null until the shop has any. */
  bankAccountId?: string | null;
}

const newKey = () => Math.random().toString(36).slice(2);

/**
 * Taking payment.
 *
 * Three things this has to get right, all of them named by the domain expert:
 *
 *  · **Several methods on one sale** — part cash, part transfer. Each becomes its own payment
 *    row so the drawer and the bank reconcile separately later.
 *  · **Change**, calculated from what was actually handed over. Doing this arithmetic in your
 *    head while a queue waits is where money goes missing.
 *  · **What they already owe**, visible here rather than a screen away, because it is the fact
 *    that decides whether to extend more credit.
 *
 * Paying less than the total is a normal outcome, not an error: the remainder goes on the
 * customer's account. That is how these businesses actually trade.
 */
/** A charge line's key, generated where one is added. */
const newChargeKey = () => Math.random().toString(36).slice(2, 10);

export function TakePayment({
  order,
  storeId,
  total,
  onNeedCustomer,
  onSettled,
  onUpdateOrder,
}: {
  order: DraftOrder;
  /** Needed to look up the shop's bank accounts; a draft does not carry its store. */
  storeId: string;
  total: number;
  /** Asked for only when part of the money is going on account. */
  onNeedCustomer: () => void;
  onSettled: (saleId: string) => void;
  /**
   * Edits the draft this screen is settling.
   *
   * The extra charge moved here from the till, and a charge is a change to the order — so this
   * screen needs a way to write one. Passed in rather than reached for directly: the page above
   * owns which order is being paid for, and a second component resolving that for itself is how
   * two screens end up editing different orders.
   */
  onUpdateOrder: (patch: Partial<DraftOrder>) => void;
}) {
  const accounts = useBankAccounts(storeId);

  const [rows, setRows] = useState<PaymentRow[]>([
    { key: newKey(), method: 'cash', amount: '', reference: '', bankAccountId: null },
  ]);
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outstanding, setOutstanding] = useState<number | null>(null);

  // What this customer already owes, before today's sale. Fetched when the sheet opens rather
  // than kept live: it is a decision input at this moment, not a value to watch change.
  useEffect(() => {
    if (!order.customerId) {
      setOutstanding(null);
      return;
    }
    let cancelled = false;
    getSupabase()
      .rpc('customer_balance_total', { p_store_customer_id: order.customerId })
      .then(({ data }) => {
        if (!cancelled) setOutstanding(Number(data ?? 0));
      });
    return () => {
      cancelled = true;
    };
  }, [order.customerId]);

  const paid = useMemo(
    () => rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [rows],
  );

  const remaining = Math.max(total - paid, 0);
  const tenderedNum = Number(tendered) || 0;
  const cashRow = rows.find((r) => r.method === 'cash');
  const cashAmount = Number(cashRow?.amount) || 0;
  const change = tenderedNum > 0 ? Math.max(tenderedNum - cashAmount, 0) : 0;

  const patch = (key: string, next: Partial<PaymentRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const settle = async () => {
    setError(null);
    setBusy(true);
    try {
      const payments = rows
        .filter((r) => Number(r.amount) > 0)
        .map((r) => ({
          amount: Number(r.amount),
          method: r.method,
          reference: r.reference || null,
          // Falls back to the shop's main account, which is what the seller was shown and read
          // out. Sending null when the picker was never touched would record a transfer that
          // cannot be matched to any account at reconciliation time.
          bank_account_id:
            r.method === 'transfer'
              ? r.bankAccountId ?? accounts.find((a) => a.is_default)?.id ?? null
              : null,
        }));

      // Credit needs someone to owe it. Without a customer there is no account to carry the
      // remainder, and the money would simply be unaccounted for.
      if (!order.customerId && paid < total) {
        throw new Error(
          'Add a customer before selling on credit, so the balance has somewhere to go.',
        );
      }

      if (!order.id) {
        throw new Error('This order has not saved to the shop yet. Try again in a moment.');
      }

      const { data, error: err } = await getSupabase().rpc('settle_draft_order', {
        p_draft_id: order.id,
        p_payments: payments,
        // The draft's own client id doubles as the idempotency key: a retry after a timeout
        // returns the sale already recorded rather than charging the customer twice.
        p_client_uuid: order.clientUuid,
      });
      if (err) throw err;

      /*
       * A settled sale moves a customer's balance, their empties and the debtor list — so say so
       * before handing back.
       *
       * Without this the account screens kept whatever they had cached until the TTL expired.
       * Measured: settle a sale, open the customer, and their balance was the figure from before
       * it — ₦200,000 where it should have read ₦247,100. The write is the only thing that knows
       * it happened; every screen guessing on a timer is the arrangement this replaced.
       */
      accountsChanged();
      onSettled(data as string);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not record this payment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/*
        WHAT IS BEING PAID FOR, before what it comes to.
        *
        * This screen used to open on a number with nothing behind it. A seller reading a total
        * back to a customer who queries it had to leave the payment, go and look at the receipt,
        * and come back — and the customer is standing there while they do it. The list is short,
        * it is the thing the total is derived from, and it belongs above it.
      */}
      <div className={styles.items}>
        <span className={styles.itemsLabel}>What they are buying</span>
        {order.lines.map((line) => (
          <div className={styles.item} key={line.key}>
            <span className={styles.itemName}>{line.productName}</span>
            <span className={styles.itemQty}>
              {line.qty || 0}
              {line.saleUnitName ? ` ${line.saleUnitName}` : ''} × {formatMoney(Number(line.unitPrice) || 0)}
            </span>
            <span className={styles.itemTotal}>{formatMoney(lineTotal(line))}</span>
          </div>
        ))}
      </div>

      <div className={styles.due}>
        <span className={styles.dueLabel}>Total for this sale</span>
        <span className={styles.dueValue}>{formatMoney(total)}</span>
      </div>

      {/*
        Who this is being recorded for — always visible, always tappable, never blocking.

        A dialog that every sale has to answer would add a step to the commonest transaction in
        the shop, which is an anonymous cash sale that needs no answer at all. But hiding the
        choice unless credit is involved was also wrong: a regular paying cash is someone a
        seller may well want in the history, and previously that could only be done by
        remembering to attach them BEFORE opening this sheet.

        A row states the current answer and offers to change it. Nothing to dismiss, nothing to
        decide, and the option is there at the moment of settling where it belongs.
      */}
      <button type="button" className={styles.forRow} onClick={onNeedCustomer}>
        {/*
          The label over the name, not beside it.

          All three on one line meant a name of any length wrapped between the label and the
          action — "Recording for / Anonymous walk- / in / Add customer" — which read as three
          unrelated fragments. Stacked, the row says one thing and the action stays at the end
          where a thumb expects it.
        */}
        <span className={styles.forBody}>
          <span className={styles.forLabel}>Recording for</span>
          <span className={styles.forValue}>
            {order.customerId ? order.customerName : 'Anonymous walk-in'}
          </span>
        </span>
        <span className={styles.forAction}>
          {order.customerId ? 'Change' : 'Add customer'}
        </span>
      </button>


      {error && (
        <InfoPanel tone="danger" title="Could not record this payment">
          {error}
        </InfoPanel>
      )}

      {outstanding !== null && outstanding > 0 && (
        <div className={styles.outstanding}>
          <span>
            {order.customerName || 'This customer'} already owes
          </span>
          <span className={styles.outstandingValue}>{formatMoney(outstanding)}</span>
        </div>
      )}

      {/*
        The extra charge, immediately before the methods.

        It lived on the till, where it sat between the items and the button that acts on them —
        scrolled past on every sale that does not need it, which is most of them. A delivery fee
        or a note is decided while money is changing hands, and the last thing settled before
        "how are they paying" is what the total has become — so it sits directly above it.
      */}
      <Collapsible
        tone="card"
        title="Extra charge or note"
        defaultOpen={(order.charges?.length ?? 0) > 0 || order.note !== ''}
        summary={
          chargesTotal(order) > 0
            ? `${order.charges.length} · ${formatMoney(chargesTotal(order))}`
            : order.note
              ? 'Note added'
              : 'None'
        }
      >
        {/*
          A list, not one box.
          A distributor's bill routinely carries transport AND loading AND an amount
          carried over. Added together under one name they become a number the customer
          cannot check and the shop cannot explain weeks later.
        */}
        {(order.charges ?? []).map((c, i) => (
          <div key={c.key} className={styles.chargeRow}>
            <Field
              label={`Charge ${i + 1}`}
              value={c.label}
              onChange={(e) =>
                onUpdateOrder({
                  charges: order.charges.map((x) =>
                    x.key === c.key ? { ...x, label: e.target.value } : x,
                  ),
                })
              }
              placeholder="Transport"
            />
            <Field
              label="Amount"
              numeric
              prefix="₦"
              value={c.amount}
              onChange={(e) =>
                onUpdateOrder({
                  charges: order.charges.map((x) =>
                    x.key === c.key ? { ...x, amount: e.target.value } : x,
                  ),
                })
              }
              placeholder="0"
            />
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() =>
                onUpdateOrder({
                  charges: order.charges.filter((x) => x.key !== c.key),
                })
              }
              aria-label={`Remove ${c.label.trim() || `charge ${i + 1}`}`}
            >
              <CloseIcon />
            </button>
          </div>
        ))}

        <Button
          variant="secondary"
          fullWidth
          onClick={() =>
            onUpdateOrder({
              charges: [
                ...(order.charges ?? []),
                { key: newChargeKey(), label: '', amount: '' },
              ],
            })
          }
        >
          <PlusIcon /> Add a charge
        </Button>

        <Field
          label="Note"
          optional
          value={order.note}
          onChange={(e) => onUpdateOrder({ note: e.target.value })}
          placeholder="Anything to remember about this sale"
        />
      </Collapsible>

      {/* ── Payment rows ────────────────────────────────────────────────────────── */}
      <div className={styles.payments}>
        {rows.map((row, index) => (
          <div className={styles.payment} key={row.key}>
            <div className={styles.paymentHead}>
              <span className={styles.paymentTitle}>
                {rows.length > 1 ? `Payment ${index + 1}` : 'How are they paying?'}
              </span>
              {rows.length > 1 && (
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                  aria-label={`Remove payment ${index + 1}`}
                >
                  <CloseIcon />
                </button>
              )}
            </div>

            <div className={styles.methods} role="group" aria-label="Payment method">
              {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`${styles.method} ${row.method === m ? styles.methodActive : ''}`}
                  onClick={() => patch(row.key, { method: m })}
                  aria-pressed={row.method === m}
                >
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>

            <Field
              label="Amount"
              numeric
              prefix="₦"
              value={row.amount}
              onChange={(e) => patch(row.key, { amount: e.target.value })}
              placeholder="0"
            />

            {/*
              Which account the money is going into.
              A distributor collects into more than one and picks depending on the customer, so
              the seller reads the number straight off the screen instead of from memory — the
              single easiest number in this business to get wrong, and getting it wrong sends
              somebody else's money somewhere else.
            */}
            {row.method === 'transfer' && accounts.length > 0 && (
              <div className={styles.accountBlock}>
                <label className={styles.accountLabel} htmlFor={`acct-${row.key}`}>
                  Paid into
                </label>
                <select
                  id={`acct-${row.key}`}
                  className={styles.accountSelect}
                  value={row.bankAccountId ?? accounts.find((a) => a.is_default)?.id ?? ''}
                  onChange={(e) => patch(row.key, { bankAccountId: e.target.value || null })}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.bank_name} · {a.account_number}
                      {a.is_default ? ' (main)' : ''}
                    </option>
                  ))}
                </select>
                {(() => {
                  const chosen =
                    accounts.find(
                      (a) => a.id === (row.bankAccountId ?? accounts.find((x) => x.is_default)?.id),
                    ) ?? accounts[0];
                  // Repeated big, because this is the line the seller reads aloud.
                  return chosen ? (
                    <p className={styles.accountNumber}>
                      {chosen.account_number}
                      <span className={styles.accountName}>{chosen.account_name}</span>
                    </p>
                  ) : null;
                })()}
              </div>
            )}

            {row.method !== 'cash' && (
              <Field
                label="Reference"
                optional
                value={row.reference}
                onChange={(e) => patch(row.key, { reference: e.target.value })}
                placeholder="Transfer or terminal reference"
                hint="Helps you match this against your bank later."
              />
            )}
          </div>
        ))}
      </div>

      {/* Quick fills: the two amounts people actually enter. Typing an exact total on a phone
          keypad with a queue waiting is a common source of mistyped payments. */}
      <div className={styles.quickRow}>
        <button
          type="button"
          className={styles.quick}
          onClick={() => patch(rows[0].key, { amount: String(total) })}
        >
          Pay all ({formatMoney(total)})
        </button>
        {remaining > 0 && paid > 0 && (
          <button
            type="button"
            className={styles.quick}
            onClick={() =>
              patch(rows[0].key, { amount: String((Number(rows[0].amount) || 0) + remaining) })
            }
          >
            Add {formatMoney(remaining)}
          </button>
        )}
      </div>

      <Button
        variant="secondary"
        fullWidth
        onClick={() =>
          setRows((prev) => [
            ...prev,
            { key: newKey(), method: 'transfer', amount: '', reference: '', bankAccountId: null },
          ])
        }
      >
        <PlusIcon /> Split across another method
      </Button>

      {cashRow && (
        <div style={{ marginTop: 'var(--space-5)' }}>
          <Field
            label="Cash handed over"
            optional
            numeric
            prefix="₦"
            value={tendered}
            onChange={(e) => setTendered(e.target.value)}
            placeholder="0"
            hint="Only to work out the change. Not recorded as part of the payment."
          />
        </div>
      )}

      {/* ── Summary ─────────────────────────────────────────────────────────────── */}
      <div className={styles.summary}>
        <div className={styles.row}>
          <span>Total</span>
          <span className={styles.value}>{formatMoney(total)}</span>
        </div>
        <div className={styles.row}>
          <span>Paying now</span>
          <span className={styles.value}>{formatMoney(paid)}</span>
        </div>

        {change > 0 && (
          <div className={styles.row}>
            <span>Change to give</span>
            <span className={`${styles.value} ${styles.big} ${styles.change}`}>
              {formatMoney(change)}
            </span>
          </div>
        )}

        {remaining > 0 && (
          <div className={styles.row}>
            <span>Goes on account</span>
            <span className={`${styles.value} ${styles.big} ${styles.owing}`}>
              {formatMoney(remaining)}
            </span>
          </div>
        )}

        {outstanding !== null && remaining > 0 && (
          <div className={styles.row}>
            <span>They will then owe</span>
            <span className={styles.value}>{formatMoney(outstanding + remaining)}</span>
          </div>
        )}
      </div>

      {/*
        The one moment a customer is genuinely required. Rather than telling the seller to go
        back and start again, this offers the action right here — the question has only just
        become relevant, and answering it should not cost them the screen they are on.
      */}
      {!order.customerId && remaining > 0 && (
        <>
          <InfoPanel tone="warning" title="Who is taking this on credit?">
            {formatMoney(remaining)} is unpaid, so it needs an account to sit in.
          </InfoPanel>
          <Button variant="secondary" size="large" fullWidth onClick={onNeedCustomer}>
            Choose a customer
          </Button>
        </>
      )}
      {/*
        The action ends the page rather than being pinned to its foot.

        This screen is a form — a payment row per method, an amount tendered, a reference — and it
        was a sheet until a keyboard on a 390px phone put the last row and the button somewhere a
        thumb could not reach. Scrolling to the end to commit is the honest gesture anyway: the
        last thing somebody should see before recording money is the arithmetic they just did.
      */}
      <div className={styles.pageActions}>
      <Button
        size="large"
        fullWidth
        busy={busy}
        busyLabel="Recording"
        disabled={!order.customerId && paid < total}
        onClick={settle}
      >
        {paid >= total
          ? 'Mark as paid'
          : paid > 0
            ? `Take ${formatMoney(paid)}, rest on account`
            : 'Put it all on account'}
      </Button>
      </div>
    </>
  );
}
