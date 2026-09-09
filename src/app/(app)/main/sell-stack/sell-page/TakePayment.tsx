'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './TakePayment.module.css';
import { Button } from '@/components/ui/Button';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import { stockMoved } from '@/lib/stacks/catalog-stack';
import { useListNotifier } from '@/hooks/useListChannel';
import { formatMoney, messageOf } from '@/lib/format';
import {
  chargesTotal,
  depositTotal,
  lineTotal,
  type DraftOrder,
} from '@/lib/stacks/draft-orders';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';

type Method = 'cash' | 'transfer' | 'pos';


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

  /*
   * Starts empty: a payment exists once it has been added, not before.
   *
   * A blank first row meant "paying nothing by cash" was always on the list, and the summary had
   * to pretend it was not there.
   */
  const [rows, setRows] = useState<PaymentRow[]>([]);

  // The payment being composed.
  const [draftMethod, setDraftMethod] = useState<Method>('cash');
  const [draftAmount, setDraftAmount] = useState('');
  const [draftReference, setDraftReference] = useState('');
  const [draftAccount, setDraftAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const error = useProblem();
  const [outstanding, setOutstanding] = useState<number | null>(null);

  // The charge being composed. Held here rather than as a blank row on the order, so an
  // abandoned half-typed charge never reaches the shop.
  const [chargeLabel, setChargeLabel] = useState('');
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeNote, setChargeNote] = useState('');
  // The deposit being composed, held here for the same reason a charge is: an abandoned half-typed
  // figure must never reach the shop.
  const [depositAmount, setDepositAmount] = useState('');
  const [depositNote, setDepositNote] = useState('');

  /*
   * WHAT IS ALREADY HELD FOR THIS CUSTOMER, read from the deposit ledger.
   *
   * Said out loud because the two add up: a shop taking two thousand today when it already holds
   * twenty is holding twenty-two, and a screen that shows only the new figure invites somebody to
   * type the total instead.
   */
  const [alreadyHeld, setAlreadyHeld] = useState(0);

  useEffect(() => {
    const customerId = order.customerId;
    if (!customerId) {
      setAlreadyHeld(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await getSupabase().rpc('customer_deposit_ledger', {
        p_store_customer_id: customerId,
      });
      if (cancelled) return;
      const rows = (data ?? []) as { running: string | number }[];
      // The reader returns newest first and carries the running balance, so the first row is what
      // is held now. No arithmetic here: a balance the screen computes is one that disagrees.
      setAlreadyHeld(rows.length > 0 ? Number(rows[0].running) || 0 : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [order.customerId]);

  // Told about the one sale this screen creates. Unhandled when nobody is showing that list, which
  // is the correct outcome — it will read the truth the next time it loads.
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
   * The People list carries a balance too, and it was never told.
   *
   * It used to be swept up by `accountsChanged()`, which re-read the whole list. Now that only the
   * derived figures re-read, the one row that moved is patched here — otherwise somebody settles a
   * sale, opens People, and reads yesterday's figure.
   */
  const notifyCustomers = useListNotifier<{ id: string; balance: string }>('customers');

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

  /*
   * AN AMOUNT TYPED BUT NOT YET ADDED STILL COUNTS.
   *
   * Splitting payments into a composer and a list introduced a trap: tapping "Pay all" fills the
   * box, and a seller who then goes straight to "Mark as paid" settles a sale with no payments at
   * all. It said the sale was saved, and the sales list showed it unpaid — money apparently taken
   * and no record of it.
   *
   * The typed amount is what they meant. It is counted in the totals, listed with the rest, and
   * sent when the sale settles; pressing "Add payment" is only needed to start a SECOND one.
   */
  const pending: PaymentRow | null = useMemo(
    () =>
      Number(draftAmount) > 0
        ? {
            key: 'pending',
            method: draftMethod,
            amount: draftAmount,
            reference: draftReference,
            bankAccountId:
              draftMethod === 'transfer' ? (draftAccount ?? accounts[0]?.id ?? null) : null,
          }
        : null,
    [draftAmount, draftMethod, draftReference, draftAccount, accounts],
  );

  // Memoised because the total is derived from it; a fresh array each render would recompute the
  // sum on every keystroke.
  const allRows = useMemo(() => (pending ? [...rows, pending] : rows), [rows, pending]);

  const paid = useMemo(
    () => allRows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0),
    [allRows],
  );

  /*
   * The goods alone, and the sale as a whole.
   *
   * `total` arrives with the charges AND the deposit already in it, so the items figure is that
   * less both rather than a second sum over the lines — one arithmetic, one answer, and the lines
   * on screen can never disagree.
   *
   * Subtracting the deposit matters more than it looks. It is money the customer hands over and
   * the shop owes back; left inside "Items" it reads as what the drinks cost, which is exactly the
   * misreading that makes a shop think its prices are higher than they are.
   */
  const held = depositTotal(order);
  const itemsTotal = Math.max(0, total - chargesTotal(order) - held);

  const remaining = Math.max(total - paid, 0);

  /*
   * WHAT IS OVER, AND WHERE IT GOES.
   *
   * There is no "cash handed over" field any more. It existed only to work out change, and it made
   * the seller enter the same money twice — once as the payment and once as the note. The payment
   * lines already say what was handed over: anything beyond this sale's total is over.
   *
   * And over does not automatically mean change. A customer who owes from before very often hands
   * across more precisely to bring that down, so the excess pays the old balance first and only
   * what is left after that is money to give back. Handing back cash that was meant for a debt is
   * the more expensive mistake of the two.
   */
  const over = Math.max(paid - total, 0);
  const owedBefore = outstanding ?? 0;
  const towardsOldDebt = Math.min(over, owedBefore);
  const change = Math.max(over - towardsOldDebt, 0);


  const settle = async () => {
    setBusy(true);
    try {
      const payments = allRows
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
       * THE DEPOSIT GOES TO ITS OWN LEDGER, after the sale and only for a named customer.
       *
       * After, because a deposit taken against a sale that failed to settle is money the shop is
       * recorded as holding for goods that never left. And only for a named customer, because a
       * deposit is an obligation to somebody — a walk-in handing over crate money is taking their
       * change back at the counter, not opening an account.
       *
       * It ADDS to whatever is already held. The two are rows in one ledger, never a replacement,
       * which is the whole reason this is a ledger and not a column.
       */
      const takenNow = (order.deposits ?? []).reduce((sum, d) => {
        const n = Number(d.amount);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);

      if (takenNow > 0 && order.customerId && storeId) {
        const { error: depErr } = await getSupabase().rpc('take_customer_deposit', {
          p_store_id: storeId,
          p_customer_id: order.customerId,
          p_amount: takenNow,
          p_reason:
            (order.deposits ?? [])
              .map((d) => d.note?.trim())
              .filter(Boolean)
              .join(', ') || null,
        });
        if (depErr) throw depErr;
      }

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

      /*
       * A SALE MOVES STOCK, and the stock screens were never told.
       *
       * `accountsChanged()` covers balances and empties. Nothing covered the shelf: what is on
       * hand, what it is worth, the dearest layer a price is warned against. So a shop could sell
       * all afternoon and read this morning's figures.
       */
      stockMoved();

      /*
       * Tell the sales list about THIS sale, rather than telling it to read everything again.
       *
       * The row is built from what was just settled — the id the database returned, the customer
       * on the order, the total that was paid. That is the whole row as the list shows it, so the
       * list can put it at the top and be correct without a request.
       *
       * `accountsChanged()` above still stands and does a different job: balances and empties are
       * derived figures spread across several screens, and no single row describes them.
       */
      const paidNow = payments.reduce((sum, p) => sum + p.amount, 0);
      notifySales({
        type: 'upsert',
        row: {
          id: data as string,
          occurred_at: new Date().toISOString(),
          total: String(total),
          paid: String(paidNow),
          // What is left on account. Every figure here is one this screen just committed, not a
          // guess — which is the difference between patching a list and lying to it.
          outstanding: String(Math.max(0, total - paidNow)),
          customer_id: order.customerId,
          customer_name: order.customerName || null,
          note: order.note || null,
          line_count: order.lines.length,
        },
      });

      /*
       * And the debtor list, when this sale left money on account.
       *
       * That list no longer re-reads itself when you return to it, so the one screen that knows a
       * balance moved has to say so. `outstanding` above is what they owed BEFORE this sale — the
       * figure this screen fetched and showed while deciding whether to extend more credit — so
       * the new balance is that plus whatever went on account just now.
       */
      const wentOnAccount = Math.max(0, total - paidNow);
      if (order.customerId && wentOnAccount > 0) {
        const owedNow = String((outstanding ?? 0) + wentOnAccount);
        notifyDebtors({ type: 'patch', id: order.customerId, patch: { balance: owedNow } });
        // The People list shows the same figure and is a different list.
        notifyCustomers({ type: 'patch', id: order.customerId, patch: { balance: owedNow } });
      }

      onSettled(data as string);
    } catch (e: unknown) {
      error.show(messageOf(e, 'Could not record this payment'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/*
        WHO FIRST, then what, then how much, then how.

        The screen used to open on a number. Reading it top to bottom now answers the questions in
        the order a seller is asked them at a counter: who is this for, what are they taking, what
        was added, what do they already owe, what does it come to, how are they paying.
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

      {/*
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={error} title="Could not record this payment" />

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

        {/*
          The goods on their own, under a double rule.

          Kept apart from "Total for this sale" further down, which adds the charges: a customer
          querying a figure is nearly always querying one of these two, and having them in the same
          place made it impossible to say which was which.
        */}
        <div className={styles.itemsTotal}>
          <span>Items</span>
          <span>{formatMoney(itemsTotal)}</span>
        </div>

        {/*
          THE DEPOSIT, on its own line in the total because the customer hands it over.

          A READOUT NOW, not a box. It used to be typed here and SPREAD across the lines sending
          containers out, in proportion to whatever each already held — a hundred lines of
          arithmetic to turn one figure into per-line `deposit_charged` values, so that a deposit
          could be expressed as a quantity of containers at a rate.

          A deposit is not a quantity of containers. It is a round sum two people agree, and it
          comes back or is kept whatever happens to the crates. It is composed below, beside the
          charges, and lives in its own ledger.
        */}
        {held > 0 && (
          <div className={styles.deposit}>
            <span className={styles.depositLabel}>Deposit held</span>
            <span>{formatMoney(held)}</span>
          </div>
        )}

        {/*
          Charges sit with the goods, under their total.

          They are part of what this customer is being asked to pay, and a seller reading the list
          back needs them in the same breath as the items — not in a separate box further down
          that has to be found and added on.
        */}
        {(order.charges ?? []).map((c) => (
          <div className={styles.charge} key={c.key}>
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() =>
                onUpdateOrder({ charges: order.charges.filter((x) => x.key !== c.key) })
              }
              aria-label={`Remove ${c.label.trim() || 'this charge'}`}
            >
              <CloseIcon />
            </button>
            <span className={styles.chargeBody}>
              <span className={styles.chargeName}>{c.label.trim() || 'Charge'}</span>
              {c.note ? <span className={styles.chargeNote}>{c.note}</span> : null}
            </span>
            <span className={styles.chargeAmount}>{formatMoney(c.amount)}</span>
          </div>
        ))}
      </div>

      {/*
        ONE BOX THAT COMPOSES A CHARGE, and the charges themselves listed above with the items.

        The old shape gave every charge its own stack of fields, so three charges meant nine inputs
        on screen and the thing being described — a short list of amounts — was buried in the
        machinery for describing it. A charge is entered once and then read many times, so entering
        it gets one box and reading it gets one line.
      */}
      <section className={styles.charges}>
        <span className={styles.chargesLabel}>Add a charge</span>

        <div className={styles.chargeForm}>
          <Field
            label="What for"
            value={chargeLabel}
            onChange={(e) => setChargeLabel(e.target.value)}
            placeholder="Transport"
          />
          <Field
            label="Amount"
            numeric
            prefix="₦"
            value={chargeAmount}
            onChange={(e) => setChargeAmount(e.target.value)}
            placeholder="0"
          />
        </div>

        <Field
          label="Note"
          optional
          value={chargeNote}
          onChange={(e) => setChargeNote(e.target.value)}
          placeholder="Anything to remember about this charge"
        />

        <Button
         
          fullWidth
          disabled={!chargeLabel.trim() || !(Number(chargeAmount) > 0)}
          onClick={() => {
            onUpdateOrder({
              charges: [
                ...(order.charges ?? []),
                {
                  key: newChargeKey(),
                  label: chargeLabel.trim(),
                  amount: chargeAmount,
                  note: chargeNote.trim(),
                },
              ],
            });
            // Cleared so the box is ready for the next one, which is what a seller adding two
            // charges in a row expects.
            setChargeLabel('');
            setChargeAmount('');
            setChargeNote('');
          }}
        >
          <PlusIcon /> Add charge
        </Button>
      </section>

      {/*
        THE DEPOSIT, COMPOSED THE SAME WAY AND KEPT PLAINLY APART.

        Beside the charges because it is entered in the same breath, and separated because it is
        the opposite kind of money: a charge is the shop's, a deposit is the customer's and the
        shop is only holding it. Netting them into one figure is how a shop ends up unable to say
        what it actually earned.

        The old deposit and this one add up rather than replace each other — they are rows in one
        ledger — which is why what is already held is said here rather than assumed to be nothing.
      */}
      <section className={styles.deposits}>
        <span className={styles.chargesLabel}>Take a deposit</span>
        <p className={styles.depositWhy}>
          Money of theirs you will be holding. Not a payment — it comes back, or you keep it and
          say why.
          {alreadyHeld > 0 && (
            <> You are already holding {formatMoney(alreadyHeld)} for them.</>
          )}
        </p>

        <div className={styles.chargeForm}>
          <Field
            label="Amount"
            numeric
            prefix="₦"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="0"
          />
          <Field
            label="What for"
            optional
            value={depositNote}
            onChange={(e) => setDepositNote(e.target.value)}
            placeholder="Crates and bottles"
          />
        </div>

        <Button
          fullWidth
          disabled={!(Number(depositAmount) > 0)}
          onClick={() => {
            onUpdateOrder({
              deposits: [
                ...(order.deposits ?? []),
                {
                  key: newChargeKey(),
                  amount: depositAmount,
                  note: depositNote.trim(),
                },
              ],
            });
            setDepositAmount('');
            setDepositNote('');
          }}
        >
          <PlusIcon /> Add deposit
        </Button>

        {(order.deposits ?? []).length > 0 && (
          <ul className={styles.depositList}>
            {(order.deposits ?? []).map((d) => (
              <li key={d.key} className={styles.charge}>
                <button
                  type="button"
                  className={styles.chargeRemove}
                  onClick={() =>
                    onUpdateOrder({
                      deposits: (order.deposits ?? []).filter((x) => x.key !== d.key),
                    })
                  }
                  aria-label="Remove this deposit"
                >
                  <CloseIcon />
                </button>
                <span className={styles.chargeBody}>
                  <span className={styles.chargeName}>Deposit</span>
                  {d.note ? <span className={styles.chargeNote}>{d.note}</span> : null}
                </span>
                <span className={styles.chargeAmount}>{formatMoney(d.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>



      <div className={styles.due}>
        <span className={styles.dueLabel}>Total for this sale</span>
        <span className={styles.dueValue}>{formatMoney(total)}</span>
      </div>

      {outstanding !== null && outstanding > 0 && (
        <div className={styles.outstanding}>
          <span>
            {order.customerName || 'This customer'} already owes
          </span>
          <span className={styles.outstandingValue}>{formatMoney(outstanding)}</span>
        </div>
      )}

      {allRows.length > 0 && (
        <div className={styles.payList}>
          <span className={styles.payListLabel}>Paying with</span>
          {allRows.map((row) => (
            <div className={styles.payRow} key={row.key}>
              <button
                type="button"
                className={styles.payRemove}
                onClick={() =>
                  row.key === 'pending'
                    ? setDraftAmount('')
                    : setRows((prev) => prev.filter((r) => r.key !== row.key))
                }
                aria-label={`Remove this ${row.method} payment`}
              >
                <CloseIcon />
              </button>
              <span className={styles.payBody}>
                <span className={styles.payMethod}>
                  {row.method === 'cash' ? 'Cash' : row.method === 'transfer' ? 'Transfer' : 'POS'}
                </span>
                {row.reference ? <span className={styles.payRef}>{row.reference}</span> : null}
              </span>
              <span className={styles.payAmount}>{formatMoney(row.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {/*
        ONE BOX THAT COMPOSES A PAYMENT, and the payments listed as lines beneath the total.

        Every payment used to be a full editor — method buttons, an amount, a reference, a bank
        picker — so a sale split across cash and transfer put two of those on screen and the two
        numbers that mattered were somewhere inside them. A payment is entered once and read
        several times while the change is counted, so entering it gets the box and reading it gets
        a line.
      */}
      <section className={styles.payBox}>
        <span className={styles.payLabel}>How are they paying?</span>

        <div className={styles.methods} role="group" aria-label="Payment method">
          {(['cash', 'transfer', 'pos'] as Method[]).map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.method} ${draftMethod === m ? styles.methodActive : ''}`}
              onClick={() => setDraftMethod(m)}
              aria-pressed={draftMethod === m}
            >
              {m === 'cash' ? 'Cash' : m === 'transfer' ? 'Transfer' : 'POS'}
            </button>
          ))}
        </div>

        <Field
          label="Amount"
          numeric
          prefix="₦"
          value={draftAmount}
          onChange={(e) => setDraftAmount(e.target.value)}
          placeholder="0"
        />

        {draftMethod === 'transfer' && accounts.length > 0 && (
          <div className={styles.accountRow}>
            <span className={styles.accountLabel}>Into</span>
            <select
              className={styles.accountSelect}
              value={draftAccount ?? accounts[0]?.id ?? ''}
              onChange={(e) => setDraftAccount(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bank_name} · {a.account_number}
                </option>
              ))}
            </select>
          </div>
        )}

        {draftMethod !== 'cash' && (
          <Field
            label="Reference"
            optional
            value={draftReference}
            onChange={(e) => setDraftReference(e.target.value)}
            placeholder="Last 4 digits, or a name"
          />
        )}

        {/*
          The amounts anybody actually enters. Typing an exact total on a phone keypad with a queue
          waiting is a common source of mistyped payments — and after a first payment, "the rest"
          is almost always the second one.
        */}
        <div className={styles.quickRow}>
          <button
            type="button"
            className={styles.quick}
            onClick={() => setDraftAmount(String(remaining > 0 ? remaining : total))}
          >
            {paid > 0 && remaining > 0
              ? `The rest (${formatMoney(remaining)})`
              : `Pay all (${formatMoney(total)})`}
          </button>

        </div>

        <Button
          fullWidth
          disabled={!(Number(draftAmount) > 0)}
          onClick={() => {
            setRows((prev) => [
              ...prev,
              {
                key: newKey(),
                method: draftMethod,
                amount: draftAmount,
                reference: draftReference,
                bankAccountId:
                  draftMethod === 'transfer' ? (draftAccount ?? accounts[0]?.id ?? null) : null,
              },
            ]);
            setDraftAmount('');
            setDraftReference('');
          }}
        >
          <PlusIcon /> Add payment
        </Button>
      </section>



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

        {towardsOldDebt > 0 && (
          <div className={styles.row}>
            <span>Off what they owed</span>
            <span className={`${styles.value} ${styles.big}`}>{formatMoney(towardsOldDebt)}</span>
          </div>
        )}

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

        {outstanding !== null && (remaining > 0 || towardsOldDebt > 0) && (
          <div className={styles.row}>
            <span>They will then owe</span>
            <span className={styles.value}>
              {formatMoney(Math.max(0, owedBefore + remaining - towardsOldDebt))}
            </span>
          </div>
        )}
      </div>

      {/*
        The note on the sale, last.

        It belongs beside the button that files it, not inside the box for adding a charge: a note
        about the sale is the final thing somebody writes before committing it, and sitting among
        the charge fields it read as a note about the charge.
      */}
      <Field
        label="Note on the whole sale"
        optional
        value={order.note}
        onChange={(e) => onUpdateOrder({ note: e.target.value })}
        placeholder="Anything to remember about this sale"
      />

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
