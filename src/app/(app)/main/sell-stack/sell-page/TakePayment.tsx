'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './TakePayment.module.css';
import { Button } from '@/components/ui/Button';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { Field } from '@/components/ui/Field';
import { InfoPanel } from '@/components/ui/Explain';
import { CloseIcon, PlusIcon } from '@/components/ui/Icon';
import { getSupabase } from '@/lib/supabase/client';
import { ACCOUNT_DERIVED_SCOPE, accountsChanged } from '@/lib/stacks/customer-account';
import {
  LEDGERS_SCOPE,
  depositLedger,
  ledgersChanged,
  type DepositMove,
} from '@/lib/stacks/customer-ledgers';
import { useResource } from '@/lib/stacks/resource';
import { applySaleLocally } from '@/lib/stacks/local-effects';
import { stockMoved } from '@/lib/stacks/catalog-stack';
import { formatMoney, formatQtySpoken, messageOf } from '@/lib/format';
import { useSellingUnits } from '@/lib/stacks/selling-units';
import { useUncountedToday } from '@/lib/stacks/count-gate';
import { unpricedOnSale } from '@/lib/stacks/price-gate';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useNav } from '@academix-admin/navigation-stack';
import {
  chargesTotal,
  depositTotal,
  lineTotal,
  type DraftOrder,
} from '@/lib/stacks/draft-orders';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { ChargesEditor, DepositEditor } from '@/components/sell/OrderExtras';

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

export function TakePayment({
  order,
  storeId,
  total,
  onNeedCustomer,
  entered,
  onEnteredChange,
  commit,
  settledLabel = 'Mark as paid',
  onUpdateOrder,
  gatePrices = true,
  onOpenLine,
  itemActions,
}: {
  order: DraftOrder;
  /** Needed to look up the shop's bank accounts; a draft does not carry its store. */
  storeId: string;
  total: number;
  /** Asked for only when part of the money is going on account. */
  onNeedCustomer: () => void;
  /**
   * WHAT TO DO WITH THE MONEY ONCE IT IS COMPOSED.
   *
   * The till settles a draft and tells the sales list, the debtor list and the shelf what it just
   * did. A correction calls `amend_sale` on a receipt that already exists and tells different
   * screens. Neither of those is this component's business: it counts money and checks it adds up.
   */
  commit: (args: {
    payments: {
      amount: number;
      method: Method;
      reference: string | null;
      bank_account_id: string | null;
    }[];
    /** Deposit being taken now, already checked against there being somebody to hold it for. */
    depositNow: number;
    depositReason: string | null;
    paidTotal: number;
    /** Of any overpayment, how much the seller said was for an older debt. */
    towardsOldDebt: number;
    /**
     * WHAT HAPPENS TO THE CHANGE (0246). `toOldDebt` is the box: ticked, an overpayment clears their
     * old balance first; unticked, all of it is change. The change is given now (`changeGiven`, by
     * `changeMethod`) or owed on the receipt (`changeOwed`, a named customer only). A correction
     * leaves these out.
     */
    toOldDebt?: boolean;
    changeGiven?: number;
    changeOwed?: number;
    changeMethod?: Method;
    changeBankAccountId?: string | null;
    /**
     * What the customer owed BEFORE this, as this screen read it — null when it never arrived.
     *
     * Passed on rather than re-read: it is the figure the seller was looking at while deciding
     * whether to extend more credit, and a caller fetching its own could patch a list with a
     * balance nobody saw.
     */
    previousBalance: number | null;
    /** In base units, per item — what this order takes off the shelf. */
    stockOut: { productId: string; base: number }[];
    /** Only the lines sold in a shape that comes back empty. */
    containersOut: {
      productId: string;
      productName: string;
      productUnitId: string;
      unitName: string;
      unitPlural: string;
      baseQty: number;
      qty: number;
    }[];
  }) => Promise<void>;
  /**
   * Payments ALREADY ENTERED for this sale, to restore when the screen is opened again.
   *
   * Not payments already taken by the shop — those are the server's business. These are the ones
   * somebody typed here and has not committed yet, and they have to survive going back for one
   * more item.
   */
  entered?: { amount: number; method: string; reference: string | null; bankAccountId: string | null }[];
  /** Told whenever they change, so the flow that owns them can hold them. */
  onEnteredChange?: (
    next: { amount: number; method: string; reference: string | null; bankAccountId: string | null }[],
  ) => void;
  /**
   * What the button says when the money covers the total.
   *
   * "Mark as paid" is right for a first sale and wrong for a correction, where the seller is
   * confirming a changed figure on a receipt somebody is already holding.
   */
  settledLabel?: string;
  /**
   * Refuse to settle while a shape on the order has no price. On for a new sale; off for a
   * correction, whose lines were priced when they were sold and whose shape may have lost its
   * price since — which is no reason to stop somebody putting the receipt right.
   */
  gatePrices?: boolean;
  /**
   * Open one line to change it. Given by the page settling a DRAFT; a correction leaves it out,
   * and its lines stay plain rows.
   */
  onOpenLine?: (lineKey: string) => void;
  /** Buttons under "What they are buying" — All items, Add an item, Scan. The page decides. */
  itemActions?: ReactNode;
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
   *
   * SEEDED FROM THE CALLER when there is something to restore. This screen is pushed and popped —
   * a seller adds a payment, goes back for one more item, and comes back — and a component that
   * starts empty every time loses what they entered. Reported on the correction flow, where going
   * back to the items and returning forgot the payment entirely; the same would happen at the till
   * the moment anything popped this page.
   */
  const [rows, setRows] = useState<PaymentRow[]>(() =>
    (entered ?? []).map((p, i) => ({
      key: `kept-${i}`,
      method: p.method as Method,
      amount: String(p.amount),
      reference: p.reference ?? '',
      bankAccountId: p.bankAccountId ?? null,
    })),
  );

  /*
   * And handed back as they change, so whatever owns this flow can keep them.
   *
   * In an effect rather than at each call site: there are four places that add or remove a row,
   * and one of them forgetting to report is exactly the bug this is fixing.
   */
  const reportRef = useRef(onEnteredChange);
  reportRef.current = onEnteredChange;
  useEffect(() => {
    reportRef.current?.(
      rows
        .filter((r) => Number(r.amount) > 0)
        .map((r) => ({
          amount: Number(r.amount),
          method: r.method,
          reference: r.reference || null,
          bankAccountId: r.bankAccountId ?? null,
        })),
    );
  }, [rows]);

  // The payment being composed.
  const [draftMethod, setDraftMethod] = useState<Method>('cash');
  const [draftAmount, setDraftAmount] = useState('');
  const [draftReference, setDraftReference] = useState('');
  const [draftAccount, setDraftAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const error = useProblem();

  // A charge or deposit being typed is held inside its editor (OrderExtras), not as a blank row on
  // the order, so an abandoned half-typed figure never reaches the shop.

  /*
   * WHAT IS ALREADY HELD FOR THIS CUSTOMER, read from the deposit ledger.
   *
   * Said out loud because the two add up: a shop taking two thousand today when it already holds
   * twenty is holding twenty-two, and a screen that shows only the new figure invites somebody to
   * type the total instead.
   */
  /*
   * WHAT IS ALREADY HELD FOR THEM — the same cached ledger the deposit pages read (one key, one
   * shape), so it is on screen at once when it has been read before, and a failed read says so rather
   * than claiming nothing is held.
   */
  const heldLedger = useResource<DepositMove[]>({
    key: `area:deposit-ledger:${order.customerId ?? 'none'}`,
    scope: LEDGERS_SCOPE,
    enabled: Boolean(order.customerId),
    read: () => depositLedger(order.customerId!),
  });
  // Newest first, carrying the running balance: the first row is what is held now.
  const alreadyHeld =
    order.customerId && heldLedger.data && heldLedger.data.length > 0 ? heldLedger.data[0].running : 0;

  // Told about the one sale this screen creates. Unhandled when nobody is showing that list, which
  // is the correct outcome — it will read the truth the next time it loads.

  /*
   * WHAT THIS CUSTOMER ALREADY OWES, before today's sale.
   *
   * It was `useState(null)` filled by a read whose failure was swallowed as `Number(data ?? 0)` — so
   * a read that did not arrive said "owes nothing". That zero then decided whether money handed
   * over was change or a payment towards the old debt, and was patched into the customer lists as
   * their new balance. It is a resource now: `null` until the answer arrives (shown as "checking"),
   * kept for next time, and a failure is a failure with a way to try again.
   */
  const balance = useResource<number>({
    key: `balance:${order.customerId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(order.customerId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('customer_balance_total', {
        p_store_customer_id: order.customerId,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
  });
  const outstanding: number | null = order.customerId ? balance.data : null;
  /* A named customer whose balance has not arrived: the money arithmetic below must not guess. */
  const balanceUnknown = Boolean(order.customerId) && outstanding === null;

  /*
   * AN AMOUNT TYPED BUT NOT YET ADDED STILL COUNTS.
   *
   * Splitting payments into a composer and a list introduced a trap: tapping "Pay all" fills the
   * box, and a seller who then goes straight to "Mark as paid" settles a sale with no payments at
   * all. It said the sale was saved, and the sales list showed it unpaid — money apparently taken
   * and no record of it.
   *
   * The typed amount is what they meant. It is counted in the totals and sent when the sale
   * settles; pressing "Add payment" is only needed to start a SECOND one.
   *
   * IT IS NOT LISTED, though, and that was the other half of getting this right. Listing it put a
   * ₦5 payment on screen while somebody was halfway through typing ₦5,000 — a line they had not
   * added, in a list of lines they had. Counted, not listed.
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

  /*
   * THE THREE THINGS THAT NEED A CUSTOMER, and why they are one rule.
   *
   * Money owed, containers lent, and money held each open a LEDGER against a person. A walk-in
   * has no ledger, so any of the three against nobody is a record with no owner — the crates
   * vanish, the debt has nowhere to sit, the deposit is owed back to no one.
   *
   * Paying in full does not excuse the other two. A customer can settle every naira and still
   * walk out with five crates and N400 of the shop's money against them; that is still an
   * account, and it still needs a name. Only a sale with none of the three — nothing owed,
   * nothing returnable, nothing held — is a true walk-in.
   */
  const depositTaken = (order.deposits ?? []).reduce((sum, d) => {
    const n = Number(d.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
  const charges = chargesTotal(order);
  const itemsTotal = Math.max(0, total - charges - held);

  /*
   * ONE PLACE A PAYMENT IS ADDED, because there are two ways to ask for one: composing an amount
   * and pressing Add, or taking the whole remainder in a tap. Two copies of this drifted once
   * already — the shortcut filled the box and left the adding to the other path, which is why it
   * took two taps and why it went on offering after the sale was paid.
   */
  const addPayment = (amount: string) => {
    if (!(Number(amount) > 0)) return;
    setRows((prev) => [
      ...prev,
      {
        key: newKey(),
        method: draftMethod,
        amount,
        reference: draftReference,
        bankAccountId: draftMethod === 'transfer' ? (draftAccount ?? accounts[0]?.id ?? null) : null,
      },
    ]);
    setDraftAmount('');
    setDraftReference('');
  };

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
  /*
   * THE BOX: "before we mark as paid, a checkbox if there is an overpayment — whether it clears the
   * old balance; unticked, it is change." Ticked by default, because money handed over by somebody
   * who owes is most often meant for the debt.
   */
  const [clearOld, setClearOld] = useState(true);
  const towardsOldDebt = clearOld ? Math.min(over, owedBefore) : 0;
  const change = Math.max(over - towardsOldDebt, 0);
  /*
   * THE CHANGE: given now, by whatever it went back in, or owed on the receipt so they bring it back
   * for it. Owing needs a name — there has to be somebody to give it to.
   */
  const [changeHow, setChangeHow] = useState<'now' | 'owe'>('now');
  const [changeMethod, setChangeMethod] = useState<Method>('cash');
  const owingChange = changeHow === 'owe' && Boolean(order.customerId);


  /*
   * WHAT ON THIS SALE COMES BACK EMPTY, named the way the line names it.
   *
   * Read from the shapes the shop already has loaded store-wide, so it costs no request: a line
   * sold in a shape marked "comes back empty" is a container somebody must owe.
   */
  const { byProduct, loaded: shapesLoaded } = useSellingUnits(storeId);
  /*
   * NO PRICE, NOT SOLD — the count gate's twin. Worked out from the shapes already loaded above,
   * so it costs no request; the server refuses a line at N0 as well (0221).
   */
  const unpriced = useMemo(
    () => (gatePrices && shapesLoaded ? unpricedOnSale(order.lines, byProduct) : []),
    [gatePrices, shapesLoaded, order.lines, byProduct],
  );

  /*
   * NOT COUNTED TODAY, so not sold today.
   *
   * The same answer the till and the count page read, asked of the server for the lines on this sale
   * — so a sale left open overnight is checked against TODAY, not against whenever its items were
   * added. The sale can be built with uncounted items on it; it cannot be settled.
   */
  const nav = useNav();
  const lineIds = useMemo(() => order.lines.map((l) => l.productId), [order.lines]);
  const {
    uncounted,
    checked: countsChecked,
    error: countsError,
    reload: reloadCounts,
  } = useUncountedToday(storeId, lineIds);
  /*
   * RE-ASKED WHENEVER THIS PAGE COMES BACK INTO VIEW.
   *
   * Another device may have counted the item while this receipt sat open, or the day may have turned
   * over. The server's answer on resume is the one that counts — never what this device remembered.
   */
  useLiveRefresh(nav, reloadCounts);
  const uncountedNames = useMemo(
    () =>
      uncounted.map(
        (id) => order.lines.find((l) => l.productId === id)?.productName ?? 'An item',
      ),
    [uncounted, order.lines],
  );
  const comingBack = useMemo(() => {
    const out: string[] = [];
    for (const l of order.lines) {
      if (!l.saleUnitId || !(Number(l.qty) > 0)) continue;
      const shape = (byProduct.get(l.productId) ?? []).find(
        (u) => u.productUnitId === l.saleUnitId,
      );
      if (shape?.isReturnable) out.push(`${l.productName} ${shape.plural.toLowerCase()}`);
    }
    return out;
  }, [order.lines, byProduct]);

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

      const takenNow = (order.deposits ?? []).reduce((sum, d) => {
        const n = Number(d.amount);
        return sum + (Number.isFinite(n) ? n : 0);
      }, 0);

      /*
       * A DEPOSIT NEEDS SOMEBODY TO BE HOLDING IT FOR, exactly like credit does above and like
       * the crates do.
       *
       * This used to send `takenNow > 0 && order.customerId ? takenNow : 0` — so a deposit typed
       * against a walk-in was silently replaced with zero. The server has always refused this
       * ("A deposit needs a customer to hold it for"), and the client made sure it never got the
       * chance: the sale went through, the money was never recorded against anybody, and nothing
       * on the screen said so. A N400 deposit disappeared exactly that way.
       *
       * A deposit is a ledger entry on a customer — it comes back to them, or the shop keeps it
       * and says why — so there is no such thing as one held for nobody.
       */
      if (!order.customerId && takenNow > 0) {
        // The button is already disabled for this; the throw is the backstop for any path that
        // reaches `settle` another way.
        throw new Error(
          'Add a customer before taking a deposit, so there is somebody to give it back to.',
        );
      }

      /*
       * AND WHAT HAPPENS TO IT IS THE CALLER'S BUSINESS.
       *
       * Everything above is about composing money and is the same whether a sale is being settled
       * for the first time or a settled one is being corrected. Everything below used to be about
       * settling a DRAFT specifically — `settle_draft_with_deposit`, a row pushed onto the sales
       * list, a debtor's balance patched — and none of it is true of a correction, which calls
       * `amend_sale` and is looking at a receipt that already exists.
       *
       * The alternative was a `mode` flag threaded through ninety lines of writes and
       * notifications. Two behaviours sharing one function body is how the correction path would
       * have quietly acquired the till's assumptions.
       */
      await commit({
        payments,
        // Sent as it stands. The guard above is what makes this safe; zeroing it here is what
        // made a deposit vanish.
        depositNow: takenNow,
        depositReason:
          (order.deposits ?? [])
            .map((d) => d.note?.trim())
            .filter(Boolean)
            .join(', ') || null,
        paidTotal: payments.reduce((sum, p) => sum + p.amount, 0),
        /*
         * WHAT LEFT THE SHELF, and WHICH CONTAINERS WENT WITH IT.
         *
         * Worked out here because the answer needs `byProduct`, the shapes lookup this screen
         * already holds: whether a line puts a crate out is a fact about the SHAPE it was sold in,
         * not about the line. A caller doing this for itself would need the same lookup, and two
         * lookups are two answers to "does this come back".
         */
        stockOut: order.lines.map((l) => ({
          productId: l.productId,
          base:
            (Number(l.qty) || 0) * (Number(l.saleUnitBaseQty) || Number(l.packQty) || 1),
        })),
        containersOut: order.lines.flatMap((l) => {
          const shape = l.saleUnitId
            ? (byProduct.get(l.productId) ?? []).find((u) => u.productUnitId === l.saleUnitId)
            : undefined;
          return shape?.isReturnable
            ? [
                {
                  productId: l.productId,
                  productName: l.productName,
                  productUnitId: shape.productUnitId,
                  unitName: shape.name,
                  unitPlural: shape.plural,
                  baseQty: shape.baseQty,
                  qty: Number(l.qty) || 0,
                },
              ]
            : [];
        }),
        /*
         * How much of an overpayment is meant for an OLDER debt rather than being change. Worked
         * out here because this screen is the one that read the balance and showed it; a caller
         * recomputing it would be reading a figure the seller never saw.
         */
        towardsOldDebt: outstanding !== null ? towardsOldDebt : 0,
        toOldDebt: clearOld,
        changeGiven: change > 0.005 && !owingChange ? change : 0,
        changeOwed: change > 0.005 && owingChange ? change : 0,
        changeMethod,
        changeBankAccountId:
          changeMethod === 'transfer' ? (accounts.find((a) => a.is_default)?.id ?? null) : null,
        previousBalance: outstanding,
      });
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
        {order.lines.map((line) => {
          const body = (
            <>
              <span className={styles.itemName}>{line.productName}</span>
              <span className={styles.itemQty}>
                {formatQtySpoken(line.qty || '0')}
                {line.saleUnitName ? ` ${line.saleUnitName}` : ''} ×{' '}
                {formatMoney(Number(line.unitPrice) || 0)}
              </span>
              <span className={styles.itemTotal}>{formatMoney(lineTotal(line))}</span>
            </>
          );
          /*
           * A LINE OPENS, where the page allows it — the till's own row on a page of its own, so a
           * quantity or a price is put right from here without going back to the sell screen.
           */
          return onOpenLine ? (
            <button
              type="button"
              className={`${styles.item} ${styles.itemTap}`}
              key={line.key}
              onClick={() => onOpenLine(line.key)}
              aria-label={`Change ${line.productName}`}
            >
              {body}
            </button>
          ) : (
            <div className={styles.item} key={line.key}>
              {body}
            </div>
          );
        })}

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
          /*
            REMOVABLE FROM HERE, where it is read.
            
            The deposit was listed with the goods and could only be taken off further down the page,
            beside the box that composes it — so the one place a seller notices it is wrong is the
            one place they cannot fix it. A charge has always had its cross here; this is the same
            line doing the same job.
            
            It clears every deposit on the sale, because that is what this line totals — and it is
            now the ONLY place a deposit is listed. There was a second list further down, repeating
            each one beside the box that composes them, so a sale with a deposit showed it twice and
            a seller could not tell whether that meant two deposits.
          */
          <div className={styles.charge}>
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() => onUpdateOrder({ deposits: [] })}
              aria-label="Remove the deposit"
            >
              <CloseIcon />
            </button>
            <span className={styles.chargeBody}>
              <span className={styles.chargeName}>Deposit held</span>
            </span>
            <span className={styles.chargeAmount}>{formatMoney(held)}</span>
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

      {itemActions && <div className={styles.itemActions}>{itemActions}</div>}

      {/*
        ONE BOX THAT COMPOSES A CHARGE, and the charges themselves listed above with the items. The
        same form All items uses (`OrderExtras`), so a charge added while the customer reads the
        list back is the charge settled here.
      */}
      <div className={styles.charges}>
        <ChargesEditor
          charges={order.charges ?? []}
          onChange={(charges) => onUpdateOrder({ charges })}
        />
      </div>

      {/*
        THE DEPOSIT, COMPOSED THE SAME WAY AND KEPT PLAINLY APART: a charge is the shop's money, a
        deposit is the customer's and the shop is only holding it. What is already held is said,
        because the two add up.
      */}
      <DepositEditor
        deposits={order.deposits ?? []}
        onChange={(deposits) => onUpdateOrder({ deposits })}
        alreadyHeld={alreadyHeld}
      />



      <div className={styles.due}>
        <span className={styles.dueLabel}>Total for this sale</span>

        {/*
          WHAT THE TOTAL IS MADE OF, above the figure rather than scattered up the page.

          A distributor's bill is goods plus transport plus a deposit, and the one number at the
          bottom is the one a customer queries. Having to scroll back through the items to work out
          why it is ₦7,700 is how an argument at a counter starts. Only the parts that exist are
          listed: a sale with no deposit and no charges says nothing extra.
        */}
        {(held > 0 || charges > 0) && (
          <span className={styles.breakdown}>
            <span className={styles.breakdownRow}>
              <span>Items</span>
              <span>{formatMoney(itemsTotal)}</span>
            </span>
            {charges > 0 && (
              <span className={styles.breakdownRow}>
                <span>Charges</span>
                <span>{formatMoney(charges)}</span>
              </span>
            )}
            {held > 0 && (
              <span className={styles.breakdownRow}>
                <span>Deposit</span>
                <span>{formatMoney(held)}</span>
              </span>
            )}
          </span>
        )}

        <span className={styles.dueValue}>{formatMoney(total)}</span>
      </div>

      {/*
        NEVER A ZERO THAT WAS NOT READ. Until the balance arrives this says it is checking; if it
        could not be read, it says that and offers to try again — in place, without leaving the sale.
      */}
      {balanceUnknown && (
        <div className={styles.outstanding} role="status">
          <span>
            {balance.error
              ? `Could not check what ${order.customerName || 'this customer'} already owes.`
              : `Checking what ${order.customerName || 'this customer'} already owes…`}
          </span>
          {balance.error && (
            <button type="button" className={styles.retryLink} onClick={balance.reload}>
              Try again
            </button>
          )}
        </div>
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
        THE PAYMENTS THAT WERE ADDED — and a typed figure is not one of them.

        This listed `allRows`, which includes the amount still in the box. So a seller typing "5"
        on the way to "5,000" watched a ₦5 payment appear in a list of payments they had not made,
        and had to work out whether it counted. It does count, and that is deliberate — see
        `pending` above, where NOT counting it once settled sales with no payment recorded at all —
        but counting towards a total and being listed as a decision somebody made are different
        things. The total below says what is covered; this list says what was entered.
      */}
      {rows.length > 0 && (
        <div className={styles.payList}>
          <span className={styles.payListLabel}>Paying with</span>
          {rows.map((row) => (
            <div className={styles.payRow} key={row.key}>
              <button
                type="button"
                className={styles.payRemove}
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
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
        <Button
          fullWidth
          disabled={!(Number(draftAmount) > 0)}
          onClick={() => addPayment(draftAmount)}
        >
          <PlusIcon /> Add payment
        </Button>

        {/*
          THE WHOLE REMAINING AMOUNT, IN ONE TAP — and gone once there is nothing left owing.

          Three things were wrong with it. It sat ABOVE "Add payment", so the order read
          "shortcut, then the real button", which is backwards: the shortcut is the exception. It
          only FILLED the box, so "Pay all" still needed a second tap on a button that looked like
          it was for something else. And it stayed on screen after the sale was paid in full,
          offering to pay ₦7,700 again on a sale with nothing owing.

          Now it adds the payment itself and disappears when `remaining` reaches zero. After
          ₦5,000 of ₦7,700 it reads "The rest (₦2,700)"; after that it is gone.
        */}
        {remaining > 0 && (
          <button
            type="button"
            className={styles.quick}
            onClick={() => addPayment(String(remaining))}
          >
            {paid > 0 ? `The rest (${formatMoney(remaining)})` : `Pay all (${formatMoney(total)})`}
          </button>
        )}
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
            <span>{owingChange ? 'Change you owe them' : 'Change to give'}</span>
            <span className={`${styles.value} ${styles.big} ${styles.change}`}>
              {formatMoney(change)}
            </span>
          </div>
        )}

        {/* THE OLD BALANCE, OR CHANGE — only when they are paying over and owe from before. */}
        {over > 0.005 && owedBefore > 0.005 && (
          <label className={styles.changeCheck}>
            <input
              type="checkbox"
              checked={clearOld}
              onChange={(e) => setClearOld(e.target.checked)}
            />
            <span>
              Use the extra to clear their old balance ({formatMoney(Math.min(over, owedBefore))})
            </span>
          </label>
        )}

        {change > 0.005 && (
          <div className={styles.changeBox} role="group" aria-label="The change">
            <div className={styles.methods}>
              <button
                type="button"
                className={`${styles.method} ${changeHow === 'now' ? styles.methodActive : ''}`}
                aria-pressed={changeHow === 'now'}
                onClick={() => setChangeHow('now')}
              >
                Give it now
              </button>
              <button
                type="button"
                className={`${styles.method} ${changeHow === 'owe' ? styles.methodActive : ''}`}
                aria-pressed={changeHow === 'owe'}
                disabled={!order.customerId}
                onClick={() => setChangeHow('owe')}
              >
                Owe it to them
              </button>
            </div>
            {!order.customerId && (
              <p className={styles.changeNote}>Add the customer to owe them change.</p>
            )}
            {owingChange ? (
              <p className={styles.changeNote}>
                It goes on the receipt as change owed to them. Give it before printing if you find
                it, or when they bring the receipt back.
              </p>
            ) : (
              <>
                <span className={styles.changeNote}>Given back by</span>
                <div className={styles.methods} role="group" aria-label="Change given by">
                  {(['cash', 'transfer', 'pos'] as Method[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`${styles.method} ${changeMethod === m ? styles.methodActive : ''}`}
                      aria-pressed={changeMethod === m}
                      onClick={() => setChangeMethod(m)}
                    >
                      {m === 'cash' ? 'Cash' : m === 'transfer' ? 'Transfer' : 'POS'}
                    </button>
                  ))}
                </div>
              </>
            )}
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
      {/*
        CONTAINERS NEED SOMEBODY TO BRING THEM BACK.

        «any returnable product in a receipt needs a customer»

        A walk-in leaving with crates used to settle cleanly and the crates vanished from every
        ledger — there was nobody to owe them to, so nothing was written. The database refuses that
        now (0142); this says so BEFORE the button, as a condition to fix rather than a failure to
        dismiss, and offers the fix on the same screen.
      */}
      {/*
        COUNT FIRST. A condition, not a failure: it is true before anything is pressed, and it stays
        on the page with the way to fix it beside it rather than waiting to be discovered in a dialog.
      */}
      {/*
        STILL CHECKING TODAY'S COUNTS. Before the answer the sale is neither counted nor uncounted,
        and the button waits rather than guessing either way.
      */}
      {!countsChecked && (
        <div className={styles.outstanding} role="status">
          <span>
            {countsError ? "Could not check today's counts." : "Checking today's counts…"}
          </span>
          {countsError && (
            <button type="button" className={styles.retryLink} onClick={reloadCounts}>
              Try again
            </button>
          )}
        </div>
      )}

      {uncounted.length > 0 && (
        <>
          <InfoPanel tone="warning" title="Count the shelf before this is sold">
            {uncountedNames.join(', ')} {uncounted.length === 1 ? 'has' : 'have'} not been counted
            today. The sale settles once {uncounted.length === 1 ? 'it is' : 'they are'} counted.
          </InfoPanel>
          <Button
            variant="secondary"
            size="large"
            fullWidth
            onClick={() => void nav.push('count_gate_page')}
          >
            Count {uncounted.length === 1 ? 'it' : 'them'} now
          </Button>
        </>
      )}

      {unpriced.length > 0 && (
        <>
          <InfoPanel tone="warning" title="Price these before they are sold">
            {unpriced.map((u) => u.productName).join(', ')} {unpriced.length === 1 ? 'has' : 'have'}{' '}
            no price yet. The sale settles once {unpriced.length === 1 ? 'it has' : 'they have'} one.
          </InfoPanel>
          <Button
            variant="secondary"
            size="large"
            fullWidth
            onClick={() => void nav.push('price_gate_page')}
          >
            Price {unpriced.length === 1 ? 'it' : 'them'} now
          </Button>
        </>
      )}

      {!order.customerId && comingBack.length > 0 && (
        <InfoPanel tone="warning" title="Who is taking the containers?">
          {comingBack.join(', ')} {comingBack.length === 1 ? 'comes' : 'come'} back empty, so this
          sale needs a customer to owe {comingBack.length === 1 ? 'it' : 'them'}.
        </InfoPanel>
      )}

      {!order.customerId && remaining > 0 && (
        <InfoPanel tone="warning" title="Who is taking this on credit?">
          {formatMoney(remaining)} is unpaid, so it needs an account to sit in.
        </InfoPanel>
      )}

      {/*
        A DEPOSIT IS MONEY HELD FOR SOMEBODY, so there has to be a somebody.

        It comes back to them when the containers do, or the shop keeps it and says why — and
        neither sentence can be written about a walk-in. Said here as a condition to fix rather
        than left to the server, which refused it correctly and was never reached: the till used
        to replace the figure with zero and settle without it.
      */}
      {!order.customerId && depositTaken > 0 && (
        <InfoPanel tone="warning" title="Who is this deposit being held for?">
          {formatMoney(depositTaken)} is being held against the containers, so it needs somebody
          to give it back to.
        </InfoPanel>
      )}

      {!order.customerId &&
        (remaining > 0 || comingBack.length > 0 || depositTaken > 0) && (
        <Button variant="secondary" size="large" fullWidth onClick={onNeedCustomer}>
          Choose a customer
        </Button>
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
          disabled={
            !countsChecked ||
            uncounted.length > 0 ||
            (gatePrices && !shapesLoaded) ||
            unpriced.length > 0 ||
            // Paid more than the sale while what they owed is still unknown: the extra might be for
            // the old debt rather than change, and nobody can say which until the balance arrives.
            (balanceUnknown && paid > total) ||
            (!order.customerId &&
              (paid < total || comingBack.length > 0 || depositTaken > 0))
          }
          onClick={settle}
        >
          {paid >= total
            ? settledLabel
            : paid > 0
              ? `Take ${formatMoney(paid)}, rest on account`
              : 'Put it all on account'}
        </Button>
      </div>
    </>
  );
}
