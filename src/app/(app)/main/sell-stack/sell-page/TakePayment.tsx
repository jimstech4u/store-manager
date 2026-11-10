'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './TakePayment.module.css';
import { Button } from '@/components/ui/Button';
import { useBankAccounts } from '@/lib/stacks/bank-accounts';
import { InfoPanel } from '@/components/ui/Explain';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon, PlusIcon } from '@/components/ui/Icon';
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
import { formatMoney, formatQtySpoken, messageOf, shapeWord } from '@/lib/format';
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
  type PayChoices,
} from '@/lib/stacks/draft-orders';
import { ProblemDialog, useProblem } from '@/components/ui/Dialog';
import { parseLabelAmount } from '@/lib/label-amount';

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
 * The choices with every default filled in, and the box left out when nothing is in it — the one
 * form they are compared and kept in.
 */
function normalChoices(c: PayChoices | null | undefined) {
  const composing = c?.composing;
  const started =
    composing &&
    (composing.amount.trim() !== '' || composing.reference.trim() !== '' || composing.method !== 'cash');
  return {
    toOldDebt: c?.toOldDebt ?? true,
    changeHow: c?.changeHow ?? ('now' as const),
    changeMethod: c?.changeMethod ?? ('cash' as Method),
    // Rebuilt rather than spread: the shop hands jsonb back with its keys sorted, and the same box
    // must compare equal however its keys arrived.
    ...(started
      ? {
          composing: {
            method: composing.method,
            amount: composing.amount,
            reference: composing.reference,
            bankAccountId: composing.bankAccountId ?? null,
          },
        }
      : {}),
  };
}

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
  due,
  onNeedCustomer,
  onRemoveCustomer,
  entered,
  onEnteredChange,
  choices,
  onChoicesChange,
  commit,
  settledLabel = 'Mark as paid',
  onUpdateOrder,
  gatePrices = true,
  onOpenLine,
  itemActions,
  already,
  compact = false,
}: {
  order: DraftOrder;
  /** Needed to look up the shop's bank accounts; a draft does not carry its store. */
  storeId: string;
  total: number;
  /**
   * WHAT IS LEFT TO PAY NOW, when that is not the whole bill — a correction of a receipt already
   * paid. `total` is the BILL (items, charges, deposit, "Total for this sale"); `due` is what the
   * payments, "Pay all", the change and "goes on account" count against. A correction handed its
   * left-to-pay as `total`, and the bill read "Items N0 · Total for this sale N0" over four lines
   * of goods. Left out, it is the total — the till's case.
   */
  due?: number;
  /** Asked for only when part of the money is going on account. */
  onNeedCustomer: () => void;
  /** Takes the customer off the sale. Left out where the name cannot be removed (a correction). */
  onRemoveCustomer?: () => void;
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
  /** What was decided about the change, and the amount still being typed — kept like the payments. */
  choices?: PayChoices | null;
  onChoicesChange?: (next: PayChoices) => void;
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
   * THE SHORT FORM, for the till: what is being bought folds to one row (they have just built it),
   * and a charge, a deposit and a note are each a "+" that opens its editor. The payment box comes
   * up a screen and a half sooner. A correction leaves it off and reads the receipt in full.
   */
  compact?: boolean;
  /**
   * WHAT THE RECEIPT ALREADY HOLDS — a correction's deposit and payments, drawn with the same lines
   * this screen draws its own with ("reuse the same payment line and deposit line and charges line
   * Take payment already uses, not a new one again"). Each cross calls back: taking a payment back
   * or cancelling a deposit needs a reason, which the correction asks for. The till leaves it out.
   */
  already?: {
    deposit?: {
      amount: number;
      unpaid: number;
      onRemove: () => void;
      /** Marked to come off with the correction: drawn struck through, with a way to put it back. */
      removed?: boolean;
      onRestore?: () => void;
    } | null;
    payments?: {
      key: string;
      amount: number;
      method: string;
      reference: string | null;
      onRemove?: () => void;
      removed?: boolean;
      onRestore?: () => void;
    }[];
  };
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
   * WHAT IS SHOWN AND WHAT IS BEING TYPED. The item list folds (closed on the till's short form —
   * they have just built it), and ONE box at a time is open: the composer under the bill for a
   * charge, a deposit or the note, or the payment box — whose purpose turns to a transfer's
   * reference when one is being added (`refFor`). One input, never a wall of them.
   */
  const [showItems, setShowItems] = useState(!compact);
  const [composer, setComposer] = useState<'charge' | 'deposit' | 'note' | null>(null);
  const [composerText, setComposerText] = useState('');
  /*
   * WHAT IT IS FOR, when that was typed on its own. "Add never gets active" (10 Nov): typing
   * "Transport" and waiting for the button left a seller stuck, because the box wanted the amount
   * too. Now a name alone is a step — Next — and the same box asks how much, with the number pad.
   * "Transport 2000" in one go still adds at once.
   */
  const [forWhat, setForWhat] = useState<string | null>(null);
  const [refFor, setRefFor] = useState<string | null>(null);
  const [refText, setRefText] = useState('');

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
  /*
   * WHAT WAS LAST SAID EITHER WAY, so an echo is not news.
   *
   * The till keeps these on the order and saves them (0276), so they can also change from OUTSIDE —
   * the order read back from the shop after another phone took a payment on it. A list that differs
   * from the last one reported came from there and replaces what is shown; one that matches is this
   * screen's own report coming back, and reporting it again would save an unchanged order.
   */
  const enteredJson = JSON.stringify(entered ?? []);
  const lastEntered = useRef(enteredJson);
  useEffect(() => {
    if (enteredJson === lastEntered.current) return;
    lastEntered.current = enteredJson;
    setRows(
      (entered ?? []).map((p, i) => ({
        key: `kept-${i}-${newKey()}`,
        method: p.method as Method,
        amount: String(p.amount),
        reference: p.reference ?? '',
        bankAccountId: p.bankAccountId ?? null,
      })),
    );
    // `entered` is read through its JSON, which is the dependency that means something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enteredJson]);
  useEffect(() => {
    const next = rows
      .filter((r) => Number(r.amount) > 0)
      .map((r) => ({
        amount: Number(r.amount),
        method: r.method,
        reference: r.reference || null,
        bankAccountId: r.bankAccountId ?? null,
      }));
    const json = JSON.stringify(next);
    if (json === lastEntered.current) return;
    lastEntered.current = json;
    reportRef.current?.(next);
  }, [rows]);

  // The payment being composed — and the decisions about the change, below — start from what the
  // order kept (`choices`), so the next customer does not cost this one what was typed.
  const [draftMethod, setDraftMethod] = useState<Method>(choices?.composing?.method ?? 'cash');
  const [draftAmount, setDraftAmount] = useState(choices?.composing?.amount ?? '');
  const [draftReference, setDraftReference] = useState(choices?.composing?.reference ?? '');
  const [draftAccount, setDraftAccount] = useState<string | null>(
    choices?.composing?.bankAccountId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const error = useProblem();

  // A charge or deposit being typed is held in the composer's own text (`composerText`), not as a
  // blank row on the order, so an abandoned half-typed figure never reaches the shop.

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
  // What the money on this screen is measured against: the bill, or what is left of it (`due`).
  const owed = due ?? total;

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

  const remaining = Math.max(owed - paid, 0);

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
  const over = Math.max(paid - owed, 0);
  const owedBefore = outstanding ?? 0;
  /*
   * THE BOX: "before we mark as paid, a checkbox if there is an overpayment — whether it clears the
   * old balance; unticked, it is change." Ticked by default, because money handed over by somebody
   * who owes is most often meant for the debt.
   */
  const [clearOld, setClearOld] = useState(choices?.toOldDebt ?? true);
  const towardsOldDebt = clearOld ? Math.min(over, owedBefore) : 0;
  const change = Math.max(over - towardsOldDebt, 0);
  /*
   * THE CHANGE: given now, by whatever it went back in, or owed on the receipt so they bring it back
   * for it. Owing needs a name — there has to be somebody to give it to.
   */
  const [changeHow, setChangeHow] = useState<'now' | 'owe'>(choices?.changeHow ?? 'now');
  const [changeMethod, setChangeMethod] = useState<Method>(choices?.changeMethod ?? 'cash');
  const owingChange = changeHow === 'owe' && Boolean(order.customerId);

  /*
   * EVERYTHING DECIDED HERE IS KEPT ON THE ORDER, both ways — the same echo rule as the payments.
   * Compared in its settled form (defaults filled in), so opening the page saves nothing.
   */
  const choicesJson = JSON.stringify(normalChoices(choices));
  const lastChoices = useRef(choicesJson);
  const choicesRef = useRef(onChoicesChange);
  choicesRef.current = onChoicesChange;
  useEffect(() => {
    if (choicesJson === lastChoices.current) return;
    lastChoices.current = choicesJson;
    const c = normalChoices(choices);
    setClearOld(c.toOldDebt);
    setChangeHow(c.changeHow);
    setChangeMethod(c.changeMethod);
    setDraftMethod(c.composing?.method ?? 'cash');
    setDraftAmount(c.composing?.amount ?? '');
    setDraftReference(c.composing?.reference ?? '');
    setDraftAccount(c.composing?.bankAccountId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choicesJson]);
  useEffect(() => {
    const next = normalChoices({
      toOldDebt: clearOld,
      changeHow,
      changeMethod,
      composing: {
        method: draftMethod,
        amount: draftAmount,
        reference: draftReference,
        bankAccountId: draftAccount,
      },
    });
    const json = JSON.stringify(next);
    if (json === lastChoices.current) return;
    lastChoices.current = json;
    choicesRef.current?.(next);
  }, [clearOld, changeHow, changeMethod, draftMethod, draftAmount, draftReference, draftAccount]);


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

  /*
   * WHY THIS SALE NEEDS A NAME, said once, in a line — not three warning panels at the foot.
   *
   * The rule stays exactly as it was (credit, containers and a deposit each open a ledger against a
   * person). What changed is where it is said and how it is fixed: the "Recording for" row at the top
   * says it as soon as it is true, and the button that would have been grey becomes "Choose who this
   * is for", one tap to the picker.
   */
  const needsCustomer =
    !order.customerId && (remaining > 0 || comingBack.length > 0 || depositTaken > 0);
  const whyCustomer = [
    // Counted, not listed: the items are one tap away, and three long names made the row a paragraph.
    comingBack.length > 0
      ? `${comingBack.length === 1 ? comingBack[0] : `${comingBack.length} kinds of crate`} go out with them`
      : null,
    remaining > 0 ? `${formatMoney(remaining)} goes on account` : null,
    depositTaken > 0 ? `a ${formatMoney(depositTaken)} deposit is held for them` : null,
  ].filter(Boolean) as string[];

  /* The composer's text, read as a name and an amount ("Transport 2000") — or, once the name is
     in (`forWhat`), as the amount alone. */
  const parsed = parseLabelAmount(composerText);
  const typed =
    forWhat !== null ? { label: forWhat, amount: parsed.amount } : parsed;
  /* A name with no amount yet: the button moves on to ask for the amount instead of adding. */
  const askAmountNext = forWhat === null && composerText.trim() !== '' && !(typed.amount && typed.amount > 0);
  const chargeLabel = (label: string) => {
    const t = label.trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Charge';
  };
  // "deposit 5000 crates" said in full is still a deposit for crates.
  const depositNote = (label: string) => label.replace(/^deposit\b\s*(for\s+)?/i, '').trim();

  const openComposer = (kind: 'charge' | 'deposit' | 'note') => {
    setRefFor(null);
    if (kind !== composer) {
      setComposerText('');
      setForWhat(null);
    }
    setComposer(kind);
  };
  const closeComposer = () => {
    setComposer(null);
    setComposerText('');
    setForWhat(null);
  };
  /* Added, and the box stays open and empty: two charges in a row is the common case. */
  const addExtra = () => {
    if (askAmountNext) {
      setForWhat(composerText.trim());
      setComposerText('');
      return;
    }
    if (!(typed.amount && typed.amount > 0)) return;
    if (composer === 'charge') {
      onUpdateOrder({
        charges: [
          ...(order.charges ?? []),
          { key: newKey(), label: chargeLabel(typed.label), amount: String(typed.amount), note: '' },
        ],
      });
    } else if (composer === 'deposit') {
      onUpdateOrder({
        deposits: [
          ...(order.deposits ?? []),
          { key: newKey(), amount: String(typed.amount), note: depositNote(typed.label) },
        ],
      });
    }
    setComposerText('');
    setForWhat(null);
  };

  const methodName = (m: string) =>
    m === 'cash' ? 'Cash' : m === 'transfer' ? 'Transfer' : m === 'pos' ? 'POS' : m;
  const accountName = (id: string | null | undefined) => {
    if (accounts.length < 2) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? a.bank_name : null;
  };

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
      if (!order.customerId && paid < owed) {
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
        A FAILURE INTERRUPTS; it does not sit on the page.

        As a panel this was the first thing pushed off the top when a keyboard opened, so an action
        that failed looked exactly like one that did nothing — and the button gets pressed again.
      */}
      <ProblemDialog problem={error} title="Could not record this payment" />

      {/*
        THE BILL — what they are buying, what was added to it, and what it comes to, in one card.

        "There is show and no hide … once a deposit or charge is added I have to open Show to remove
        it" (10 Nov). Only the item list folds, and its head says Show or Hide either way. What was
        ADDED to the goods — a charge, a deposit, the note — is always a line in the card with its own
        cross: it is what gets checked and put right at the counter, and it is never more than a few.
      */}
      <section className={styles.bill} aria-label="The bill">
        <button
          type="button"
          className={styles.billHead}
          aria-expanded={showItems}
          onClick={() => setShowItems((v) => !v)}
        >
          <span className={styles.billHeadText}>
            <span className={styles.itemsLabel}>What they are buying</span>
            <span className={styles.billCount}>
              {order.lines.length} {order.lines.length === 1 ? 'item' : 'items'} ·{' '}
              {formatMoney(itemsTotal)}
            </span>
          </span>
          <span className={styles.billToggle}>
            {showItems ? 'Hide' : 'Show'}
            {showItems ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </span>
        </button>

        {showItems && (
          <div className={styles.billItems}>
            {order.lines.map((line) => {
              const body = (
                <>
                  <span className={styles.itemName}>{line.productName}</span>
                  <span className={styles.itemQty}>
                    {formatQtySpoken(line.qty || '0')}
                    {line.saleUnitName ? ` ${shapeWord(line.qty, line.saleUnitName)}` : ''} ×{' '}
                    {formatMoney(Number(line.unitPrice) || 0)}
                  </span>
                  <span className={styles.itemTotal}>{formatMoney(lineTotal(line))}</span>
                </>
              );
              /*
               * A LINE OPENS, where the page allows it — the till's own row on a page of its own, so
               * a quantity or a price is put right from here without going back to the sell screen.
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
            {itemActions && <div className={styles.itemActions}>{itemActions}</div>}
          </div>
        )}

        {/*
          WHAT THE RECEIPT ALREADY HOLDS, on a correction — drawn as the lines below are, with a cross
          that asks for a reason (the correction's), or struck through with a way to put it back.
        */}
        {already?.deposit && already.deposit.amount > 0.005 && (
          <div className={`${styles.charge} ${already.deposit.removed ? styles.lineGone : ''}`}>
            {already.deposit.removed ? (
              <button type="button" className={styles.putBack} onClick={already.deposit.onRestore}>
                Put back
              </button>
            ) : (
              <button
                type="button"
                className={styles.chargeRemove}
                onClick={already.deposit.onRemove}
                aria-label="Cancel the deposit put down with this sale"
              >
                <CloseIcon />
              </button>
            )}
            <span className={styles.chargeBody}>
              <span className={styles.chargeName}>Deposit held</span>
              <span className={styles.chargeNote}>
                {already.deposit.removed
                  ? 'Cancelled with this correction'
                  : already.deposit.unpaid > 0.005
                    ? `Put down with this sale — ${formatMoney(already.deposit.unpaid)} not paid yet`
                    : 'Put down with this sale — paid'}
              </span>
            </span>
            <span className={styles.chargeAmount}>{formatMoney(already.deposit.amount)}</span>
          </div>
        )}

        {(order.charges ?? []).map((c) => (
          <div className={styles.charge} key={c.key}>
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() => onUpdateOrder({ charges: order.charges.filter((x) => x.key !== c.key) })}
              aria-label={`Remove ${c.label.trim() || 'this charge'}`}
            >
              <CloseIcon />
            </button>
            <span className={styles.chargeBody}>
              <span className={styles.chargeName}>{c.label.trim() || 'Charge'}</span>
              {c.note ? <span className={styles.chargeNote}>{c.note}</span> : null}
            </span>
            <span className={styles.chargeAmount}>{formatMoney(Number(c.amount) || 0)}</span>
          </div>
        ))}

        {/*
          EACH DEPOSIT ITS OWN LINE. A deposit is the customer's money the shop holds — it comes back,
          or the shop keeps it and says why — so it is named as one, never folded into the goods.
        */}
        {(order.deposits ?? []).map((d) => (
          <div className={styles.charge} key={d.key}>
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() =>
                onUpdateOrder({ deposits: (order.deposits ?? []).filter((x) => x.key !== d.key) })
              }
              aria-label="Remove this deposit"
            >
              <CloseIcon />
            </button>
            <span className={styles.chargeBody}>
              <span className={styles.chargeName}>Deposit held</span>
              <span className={styles.chargeNote}>
                {[d.note, alreadyHeld > 0 ? `${formatMoney(alreadyHeld)} already held for them` : null]
                  .filter(Boolean)
                  .join(' · ') || 'Theirs — it comes back to them'}
              </span>
            </span>
            <span className={styles.chargeAmount}>{formatMoney(Number(d.amount) || 0)}</span>
          </div>
        ))}

        {order.note && composer !== 'note' && (
          <div className={styles.charge}>
            <button
              type="button"
              className={styles.chargeRemove}
              onClick={() => onUpdateOrder({ note: '' })}
              aria-label="Remove the note"
            >
              <CloseIcon />
            </button>
            <button type="button" className={styles.noteBody} onClick={() => openComposer('note')}>
              <span className={styles.chargeName}>Note</span>
              <span className={styles.chargeNote}>{order.note}</span>
            </button>
          </div>
        )}

        {/*
          ADDING ONE: a "+" for each, and then ONE box. The kind is a tap away at the top of the box,
          and Done folds it back — "a proper toggle to show and hide that is very easy and flowing".
          A charge and a deposit are typed the way they are said: "Transport 2000", "5000 crates".
        */}
        {composer === null ? (
          <div className={styles.extras}>
            <button type="button" className={styles.extra} onClick={() => openComposer('charge')}>
              <PlusIcon /> Charge
            </button>
            <button type="button" className={styles.extra} onClick={() => openComposer('deposit')}>
              <PlusIcon /> Deposit
            </button>
            {!order.note && (
              <button type="button" className={styles.extra} onClick={() => openComposer('note')}>
                <PlusIcon /> Note
              </button>
            )}
          </div>
        ) : (
          <div className={styles.composer}>
            <div className={styles.composerHead}>
              <div className={styles.kinds} role="group" aria-label="What to add">
                {(['charge', 'deposit', 'note'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`${styles.kind} ${composer === k ? styles.kindOn : ''}`}
                    aria-pressed={composer === k}
                    onClick={() => openComposer(k)}
                  >
                    {k === 'charge' ? 'Charge' : k === 'deposit' ? 'Deposit' : 'Note'}
                  </button>
                ))}
              </div>
              <button type="button" className={styles.composerDone} onClick={closeComposer}>
                Done
              </button>
            </div>
            {composer === 'note' ? (
              <textarea
                className={`${styles.box} ${styles.boxNote}`}
                rows={2}
                value={order.note}
                onChange={(e) => onUpdateOrder({ note: e.target.value })}
                placeholder="Anything to remember about this sale"
                aria-label="Note on the whole sale"
                autoFocus
              />
            ) : (
              <form
                className={styles.boxRow}
                onSubmit={(e) => {
                  e.preventDefault();
                  addExtra();
                }}
              >
                <input
                  className={styles.box}
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  placeholder={
                    forWhat !== null
                      ? `How much for ${forWhat}?`
                      : composer === 'charge'
                        ? 'e.g. Transport 2000'
                        : 'e.g. 5000 crates'
                  }
                  aria-label={
                    forWhat !== null
                      ? `How much for ${forWhat}`
                      : composer === 'charge'
                        ? 'The charge'
                        : 'The deposit'
                  }
                  inputMode={forWhat !== null ? 'decimal' : 'text'}
                  autoComplete="off"
                  enterKeyHint={askAmountNext ? 'next' : 'done'}
                  autoFocus
                />
                <button
                  type="submit"
                  className={styles.boxAdd}
                  disabled={composerText.trim() === '' || (!askAmountNext && !(typed.amount && typed.amount > 0))}
                >
                  {askAmountNext ? 'Next' : 'Add'}
                </button>
              </form>
            )}
            {composer !== 'note' && (
              <p className={styles.boxHint} aria-live="polite">
                {forWhat !== null && !(typed.amount && typed.amount > 0) ? (
                  <>
                    {composer === 'charge' ? chargeLabel(forWhat) : `Deposit for ${depositNote(forWhat) || forWhat}`}{' '}
                    — now the amount.{' '}
                    <button
                      type="button"
                      className={styles.refLink}
                      onClick={() => {
                        setComposerText(forWhat);
                        setForWhat(null);
                      }}
                    >
                      Change the name
                    </button>
                  </>
                ) : typed.amount && typed.amount > 0
                  ? composer === 'charge'
                    ? `Adds ${chargeLabel(typed.label)} · ${formatMoney(typed.amount)} to the bill`
                    : `Holds ${formatMoney(typed.amount)} of theirs${
                        depositNote(typed.label) ? ` for ${depositNote(typed.label)}` : ''
                      }${alreadyHeld > 0 ? `, with the ${formatMoney(alreadyHeld)} already held` : ''}`
                  : askAmountNext
                    ? 'Next asks how much.'
                    : composer === 'charge'
                      ? 'What it is for and how much — or the name first, then Next.'
                      : 'How much, and what for if you like. It is theirs: it comes back.'}
              </p>
            )}
          </div>
        )}

        <div className={styles.billTotal}>
          <span>Total for this sale</span>
          <span className={styles.billTotalValue}>{formatMoney(total)}</span>
        </div>
      </section>

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
          <span>{order.customerName || 'This customer'} already owes</span>
          <span className={styles.outstandingValue}>{formatMoney(outstanding)}</span>
        </div>
      )}

      {/*
        THE MONEY — what was already paid (a correction), the payments added, and ONE box for the
        next. A typed amount counts towards the totals without being listed (see `pending`); Enter or
        Add lists it. A transfer's reference is added from its line, in the same box.
      */}
      <section className={styles.payBox} aria-label="The payment">
        {(already?.payments?.length ?? 0) > 0 && (
          <div className={styles.payList}>
            <span className={styles.payListLabel}>Already paid on this receipt</span>
            {(already?.payments ?? []).map((pay) => (
              <div className={`${styles.payRow} ${pay.removed ? styles.lineGone : ''}`} key={pay.key}>
                {pay.removed ? (
                  <button type="button" className={styles.putBack} onClick={pay.onRestore}>
                    Put back
                  </button>
                ) : pay.onRemove ? (
                  <button
                    type="button"
                    className={styles.payRemove}
                    onClick={pay.onRemove}
                    aria-label={`Take back the ${formatMoney(pay.amount)} ${pay.method}`}
                  >
                    <CloseIcon />
                  </button>
                ) : (
                  <span className={styles.payRemove} aria-hidden="true" />
                )}
                <span className={styles.payBody}>
                  <span className={styles.payMethod}>{methodName(pay.method)}</span>
                  {pay.reference ? <span className={styles.payRef}>{pay.reference}</span> : null}
                </span>
                <span className={styles.payAmount}>{formatMoney(pay.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div className={styles.payList}>
            <span className={styles.payListLabel}>Paying with</span>
            {rows.map((row) => (
              <div className={styles.payRow} key={row.key}>
                <button
                  type="button"
                  className={styles.payRemove}
                  onClick={() => {
                    setRows((prev) => prev.filter((r) => r.key !== row.key));
                    if (refFor === row.key) setRefFor(null);
                  }}
                  aria-label={`Remove this ${row.method} payment`}
                >
                  <CloseIcon />
                </button>
                <span className={styles.payBody}>
                  <span className={styles.payMethod}>
                    {methodName(row.method)}
                    {row.method === 'transfer' && accountName(row.bankAccountId) ? (
                      <span className={styles.payRef}> · {accountName(row.bankAccountId)}</span>
                    ) : null}
                  </span>
                  {row.method !== 'cash' || row.reference ? (
                    <button
                      type="button"
                      className={styles.refLink}
                      onClick={() => {
                        setComposer(null);
                        setRefFor(row.key);
                        setRefText(row.reference);
                      }}
                    >
                      {row.reference || '+ Reference'}
                    </button>
                  ) : null}
                </span>
                <span className={styles.payAmount}>{formatMoney(row.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {refFor ? (
          <div className={styles.composer}>
            <div className={styles.composerHead}>
              <span className={styles.payLabel}>
                Reference for the {formatMoney(rows.find((r) => r.key === refFor)?.amount ?? 0)}{' '}
                {methodName(rows.find((r) => r.key === refFor)?.method ?? 'transfer').toLowerCase()}
              </span>
              <button type="button" className={styles.composerDone} onClick={() => setRefFor(null)}>
                Cancel
              </button>
            </div>
            <form
              className={styles.boxRow}
              onSubmit={(e) => {
                e.preventDefault();
                setRows((prev) =>
                  prev.map((r) => (r.key === refFor ? { ...r, reference: refText.trim() } : r)),
                );
                setRefFor(null);
              }}
            >
              <input
                className={styles.box}
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                placeholder="Last 4 digits, or the sender's name"
                aria-label="Reference"
                autoComplete="off"
                enterKeyHint="done"
                autoFocus
              />
              <button type="submit" className={styles.boxAdd}>
                Save
              </button>
            </form>
          </div>
        ) : (
          <>
            <span className={styles.payLabel}>
              {rows.length > 0 ? 'Another payment?' : 'How are they paying?'}
            </span>

            <div className={styles.methods} role="group" aria-label="Payment method">
              {(['cash', 'transfer', 'pos'] as Method[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`${styles.method} ${draftMethod === m ? styles.methodActive : ''}`}
                  onClick={() => setDraftMethod(m)}
                  aria-pressed={draftMethod === m}
                >
                  {methodName(m)}
                </button>
              ))}
            </div>

            {/* WHICH ACCOUNT IT LANDED IN — a tap each, the shop's main account chosen to start. */}
            {draftMethod === 'transfer' && accounts.length > 1 && (
              <div className={styles.intoChips} role="group" aria-label="Into which account">
                {accounts.map((a) => {
                  const on =
                    (draftAccount ?? accounts.find((x) => x.is_default)?.id ?? accounts[0]?.id) === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      className={`${styles.into} ${on ? styles.intoOn : ''}`}
                      aria-pressed={on}
                      onClick={() => setDraftAccount(a.id)}
                    >
                      <span className={styles.intoBank}>{a.bank_name}</span>
                      <span className={styles.intoNumber}>{a.account_number}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {draftMethod === 'transfer' && accounts.length === 1 && (
              <span className={styles.intoOne}>
                Into {accounts[0].bank_name} · {accounts[0].account_number}
              </span>
            )}

            <form
              className={styles.boxRow}
              onSubmit={(e) => {
                e.preventDefault();
                addPayment(draftAmount);
              }}
            >
              <span className={styles.boxPrefix} aria-hidden="true">
                ₦
              </span>
              <input
                className={`${styles.box} ${styles.boxAmount}`}
                value={draftAmount}
                onChange={(e) => setDraftAmount(e.target.value.replace(/[^\d.]/g, ''))}
                placeholder="Amount"
                aria-label="Amount"
                inputMode="decimal"
                autoComplete="off"
                enterKeyHint="done"
              />
              <button type="submit" className={styles.boxAdd} disabled={!(Number(draftAmount) > 0)}>
                Add
              </button>
            </form>

            {/*
              THE WHOLE REMAINING AMOUNT, IN ONE TAP — and gone once there is nothing left owing.
              After ₦5,000 of ₦7,700 it reads "The rest (₦2,700)"; after that it is gone.
            */}
            {remaining > 0 && (
              <button
                type="button"
                className={styles.quick}
                onClick={() => addPayment(String(remaining))}
              >
                {paid > 0 ? `The rest (${formatMoney(remaining)})` : `Pay all (${formatMoney(owed)})`}
              </button>
            )}
          </>
        )}
      </section>

      {/*
        WHO IT IS FOR, just above the sums — "move the customer section above the total" (10 Nov).
        It is the sums that make a name necessary (what goes on account, what they will then owe),
        so the name sits where those are read, and the button under them asks for it when it is
        missing. With a customer chosen it can be changed or taken off; without one, the whole row
        adds one.

        The label over the name, not beside it: on one line a long name wrapped between the label and
        the action and read as three unrelated fragments.
      */}
      {order.customerId ? (
        <div className={styles.forRow}>
          <span className={styles.forBody}>
            <span className={styles.forLabel}>Recording for</span>
            <span className={styles.forValue}>{order.customerName}</span>
          </span>
          <span className={styles.forActions}>
            <button type="button" className={styles.forAction} onClick={onNeedCustomer}>
              Change
            </button>
            {onRemoveCustomer && (
              <button
                type="button"
                className={`${styles.forAction} ${styles.forRemove}`}
                onClick={onRemoveCustomer}
              >
                Remove
              </button>
            )}
          </span>
        </div>
      ) : (
        <button
          type="button"
          className={`${styles.forRow} ${needsCustomer ? styles.forNeeded : ''}`}
          onClick={onNeedCustomer}
        >
          <span className={styles.forBody}>
            <span className={styles.forLabel}>Recording for</span>
            <span className={styles.forValue}>
              {needsCustomer ? 'Who is this for? Needed' : 'Anonymous walk-in'}
            </span>
            {needsCustomer && <span className={styles.forWhy}>{whyCustomer.join(' · ')}</span>}
          </span>
          <span className={styles.forAction}>Add customer</span>
        </button>
      )}

      {/* ── Summary ─────────────────────────────────────────────────────────────── */}
      <div className={styles.summary}>
        <div className={styles.row}>
          <span>{due !== undefined ? 'Left to pay' : 'Total'}</span>
          <span className={styles.value}>{formatMoney(owed)}</span>
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
            (balanceUnknown && paid > owed)
          }
          // Needing a name is not a dead end: the button asks for it.
          onClick={needsCustomer ? onNeedCustomer : settle}
        >
          {needsCustomer
            ? 'Choose who this is for'
            : paid >= owed
              ? settledLabel
              : paid > 0
                ? `Take ${formatMoney(paid)}, rest on account`
                : 'Put it all on account'}
        </Button>
      </div>
    </>
  );
}
