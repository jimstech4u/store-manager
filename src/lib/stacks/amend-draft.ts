'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import {
  saleCharges,
  saleDeposits,
  saleDocument,
  salePaid,
  type SaleDocument,
} from '@/lib/stacks/amend';
import type { DraftLine, DraftOrder } from '@/lib/stacks/draft-orders';

/**
 * A CORRECTION BEING BUILT, across the three screens it takes.
 *
 * Correcting a receipt is the till again — add what was missed, fix what was keyed wrong, take off
 * what should not be there, then the money, then why. That is three pushed pages, and `nav.push`
 * carries an id and an intent, never a record. So the correction itself lives here, under one key,
 * and each page reads and writes the same thing.
 *
 * SHAPED AS A `DraftOrder` ON PURPOSE. Not because a correction is a draft — it is a settled
 * receipt being restated — but because `TakePayment` composes money against that shape, and the
 * money on a correction is the same job: several methods, a reference, named charges, a deposit,
 * and what is left. Giving the correction its own shape would have meant a second payment screen,
 * and two screens that count money are two screens that can disagree about what was counted.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE: the customer. A receipt belongs to whoever it was made
 * out to, and a correction that could move it to somebody else would move the debt with it. The one
 * exception is a WALK-IN, which has nobody — the server refuses a correction that leaves money
 * owing with no account to carry it, so naming somebody is the only way to finish, and that is
 * naming rather than changing.
 */

export const AMEND_DRAFT_SCOPE = 'amend_draft';

export interface AmendDraft {
  saleId: string;
  /** The receipt as it stands, kept so a screen can say what changed. */
  was: SaleDocument | null;
  /** The correction, in the shape the till and the payment screen already understand. */
  order: DraftOrder | null;
  /**
   * What this receipt has ALREADY been paid, before the correction.
   *
   * The payment screen has to ask for the DIFFERENCE, not the corrected total — a receipt of
   * ₦10,000 already settled, corrected up to ₦15,000, owes ₦5,000 and not ₦15,000. Asking for the
   * whole amount again is how a customer pays twice, and the first walk of this flow did exactly
   * that.
   */
  alreadyPaid: number;
  /** Payments taken DURING the correction. What the receipt already took is on `was`. */
  taking: { amount: number; method: string; reference: string | null; bankAccountId: string | null }[];
  /** A deposit taken now, for containers this correction puts out. */
  depositNow: number;
  /**
   * Cash handed back across the counter as change on this correction's payment — recorded as money
   * going out once the correction lands, so it never sits on the account as a credit (see Take
   * payment, which does the same for a new sale).
   */
  changeBack?: number;
  depositReason: string | null;
  /** Why, asked last — after the money and before the receipt. */
  reason: string;
  /**
   * WHAT COMES OFF WITH THIS CORRECTION (0249): payments on the receipt taken back, and whether the
   * deposit put down with it is cancelled. Marked on Correct payment with a cross, like the till's
   * own lines, and written with the correction under its one reason — never on their own.
   */
  takeBack?: string[];
  cancelDeposit?: boolean;
}

const empty = (saleId: string): AmendDraft => ({
  saleId,
  was: null,
  order: null,
  alreadyPaid: 0,
  taking: [],
  depositNow: 0,
  depositReason: null,
  reason: '',
  takeBack: [],
  cancelDeposit: false,
});

/** The receipt's lines, in the shape the till's own row component edits. */
function toOrder(
  doc: SaleDocument,
  charges: { label: string; amount: number }[],
  deposits: { productName: string; amount: number }[],
): DraftOrder {
  return {
    id: doc.saleId,
    clientUuid: doc.saleId,
    code: null,
    customerId: doc.customer?.id ?? null,
    customerName: doc.customer?.name ?? '',
    customerPhone: '',
    label: '',
    lines: doc.lines.map((l, i) => ({
      key: `${l.productId}-${l.saleUnitId ?? 'base'}-${i}`,
      productId: l.productId,
      productName: l.productName,
      baseUnit: '',
      qty: String(l.enteredQty),
      packId: null,
      packName: null,
      packQty: null,
      unitPrice: String(l.unitPrice),
      containersOut: String(l.containersOut),
      depositCharged: '0',
      saleUnitId: l.saleUnitId,
      saleUnitName: l.unitName,
      /*
       * How many BASE units one of this shape is, recovered from the line rather than looked up.
       * The line already states both figures, and the shape's definition may have been edited since
       * the sale — in which case the receipt's own arithmetic is the one that has to be corrected,
       * not today's.
       */
      saleUnitBaseQty: l.enteredQty > 0 ? String(l.baseQty / l.enteredQty) : '1',
    })) as DraftLine[],
    feeAmount: '0',
    feeLabel: '',
    /*
     * THE RECEIPT'S OWN CHARGES, read separately because `sale_document` does not carry them.
     *
     * Seeded empty at first, and that was wrong twice over: the corrected total left the shop's
     * transport out, so the screen disagreed with the receipt it was correcting — and saving sent
     * an empty list, which `amend_sale` reads as "there are none" and deletes. Correcting a
     * quantity silently dropped the transport.
     */
    charges: charges.map((c, i) => ({
      key: `charge-${i}`,
      label: c.label,
      amount: String(c.amount),
      note: undefined,
    })),
    /*
     * WHAT IT IS HOLDING ON DEPOSIT, so the corrected total matches the receipt.
     *
     * Seeded empty before, which made the correction compute a total lower than the paper it was
     * correcting by exactly the deposit, and show a breakdown missing a line the customer can see
     * on their copy. `amend_sale` now preserves the figure through the rewrite (0190); this is so
     * the screen agrees with what will be preserved.
     */
    deposits: deposits.map((d, i) => ({
      key: `deposit-${i}`,
      amount: String(d.amount),
      note: d.productName || undefined,
    })),
    note: doc.note ?? '',
    synced: true,
  };
}

/**
 * The correction for one receipt.
 *
 * Seeded from the server ONCE per sale and never re-seeded while it is being edited — the pages
 * push and pop around it, and a re-seed on return would throw away everything typed. Keyed on the
 * sale, so a genuinely different receipt does seed.
 */
export function useAmendDraft(saleId: string | null) {
  const [state, , setState] = useDemandState<AmendDraft>(empty(saleId ?? 'none'), {
    key: `amend-draft:${saleId ?? 'none'}`,
    scope: AMEND_DRAFT_SCOPE,
    persist: true,
    deps: [saleId ?? ''],
    revalidateOnMount: false,
  });

  /*
   * SEEDED FROM THE RECEIPT whenever there is no correction in progress — the first time, and again
   * after one has been made and cleared. Direct reads and `setState`: a `demand` is spent once it
   * has answered, so a seed through it would not run a second time and the next correction on the
   * same receipt would sit on "loading" for ever.
   */
  const checkedFor = useRef<string | null>(null);
  const seeding = useRef(false);
  const seed = useCallback(async () => {
    if (!saleId || seeding.current) return;
    seeding.current = true;
    try {
      const [doc, paid, charges, deposits] = await Promise.all([
        saleDocument(saleId),
        salePaid(saleId),
        saleCharges(saleId),
        saleDeposits(saleId),
      ]);
      setState(() =>
        doc
          ? { ...empty(saleId), was: doc, order: toOrder(doc, charges, deposits), alreadyPaid: paid }
          : empty(saleId),
      );
      checkedFor.current = saleId; // freshly read: nothing to check
    } finally {
      seeding.current = false;
    }
  }, [saleId, setState]);

  useEffect(() => {
    if (!saleId || state.order) return;
    void seed();
  }, [saleId, state.order, seed]);

  /*
   * A RESUMED CORRECTION IS CHECKED AGAINST THE RECEIPT FIRST.
   *
   * The draft is saved on the phone so a correction survives pushing and popping — and it outlived
   * the correction itself: nothing cleared it, so the next "something on this is wrong" on that
   * receipt resumed a correction already made, with the "already paid", deposit and payments of
   * before it, and payments marked to come off that had already come off. Its figures were wrong on
   * screen and on the paper, and saving could fail outright.
   *
   * So once per visit, a resumed draft is compared with the receipt as it stands: corrected since it
   * was started (another revision) → start again from the receipt; otherwise keep what was typed and
   * re-read what the receipt holds — paid, payments, deposit — dropping marks on payments no longer
   * on it. Direct reads and `setState`, never `demand`: a spent demand does nothing (see below).
   */
  useEffect(() => {
    if (!saleId || !state.order || checkedFor.current === saleId) return;
    checkedFor.current = saleId;
    const startedAt = state.was?.revision ?? null;
    void (async () => {
      try {
        const [doc, paid] = await Promise.all([saleDocument(saleId), salePaid(saleId)]);
        if (!doc) return;
        if (startedAt === null || doc.revision !== startedAt) {
          const [charges, deposits] = await Promise.all([saleCharges(saleId), saleDeposits(saleId)]);
          setState(() => ({ ...empty(saleId), was: doc, order: toOrder(doc, charges, deposits), alreadyPaid: paid }));
          return;
        }
        const onReceipt = new Set((doc.payments ?? []).map((pay) => pay.paymentId).filter(Boolean));
        setState((prev) => ({
          ...prev,
          was: doc,
          alreadyPaid: paid,
          takeBack: (prev.takeBack ?? []).filter((id) => onReceipt.has(id)),
          cancelDeposit: Boolean(prev.cancelDeposit) && (doc.depositTaken ?? 0) > 0.005,
        }));
      } catch {
        // Kept as it was; the reason step's save is refused by the server if the receipt disagrees.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saleId, state.order]);

  /** A correction that has been made is over: the next one on this receipt starts from it. */
  const clear = useCallback(() => {
    if (!saleId) return;
    checkedFor.current = null;
    setState(() => empty(saleId));
  }, [saleId, setState]);

  /*
   * EDITS GO THROUGH `setState`, NOT `demand`.
   *
   * A demand is SPENT once it has answered. The first version patched through `demand()`, so the
   * seed landed and every edit after it was silently dropped — a seller could change a quantity,
   * watch the row update from local React state, and arrive at the payment screen with the figure
   * the receipt started with. Found by walking the flow: the pill still said ₦10,000 after the line
   * was changed to three.
   *
   * The same trap is recorded in `useProduct`, where a spent demand made every "Try again" a no-op.
   * `demand` is for fetching; `setState` is for editing.
   */
  const patch = useCallback(
    (next: Partial<AmendDraft>) => {
      setState((prev) => ({ ...prev, ...next }));
    },
    [setState],
  );

  const patchOrder = useCallback(
    (next: Partial<DraftOrder>) => {
      setState((prev) => (prev.order ? { ...prev, order: { ...prev.order, ...next } } : prev));
    },
    [setState],
  );

  /*
   * Each of these reads the PREVIOUS state rather than the one this render closed over. Two taps of
   * a stepper land in the same frame often enough on a real phone, and a closure over `state` makes
   * the second overwrite the first with a figure one tap old.
   */
  const updateLine = useCallback(
    (key: string, next: Partial<DraftLine>) => {
      setState((prev) =>
        prev.order
          ? {
              ...prev,
              order: {
                ...prev.order,
                lines: prev.order.lines.map((l) => (l.key === key ? { ...l, ...next } : l)),
              },
            }
          : prev,
      );
    },
    [setState],
  );

  const removeLine = useCallback(
    (key: string) => {
      setState((prev) =>
        prev.order
          ? { ...prev, order: { ...prev.order, lines: prev.order.lines.filter((l) => l.key !== key) } }
          : prev,
      );
    },
    [setState],
  );

  const addLine = useCallback(
    (line: DraftLine) => {
      setState((prev) =>
        prev.order ? { ...prev, order: { ...prev.order, lines: [...prev.order.lines, line] } } : prev,
      );
    },
    [setState],
  );

  /** Start again from what the receipt actually says. */
  const reset = useCallback(() => {
    void seed();
  }, [seed]);

  /**
   * Re-read only WHAT THE RECEIPT HAS ALREADY TAKEN, keeping everything the seller has typed.
   *
   * Taking back a payment keyed the wrong way changes `was.payments` and `alreadyPaid`, and
   * nothing else on this correction. `reset` would be the obvious call and it is the wrong one:
   * it starts again from `empty(saleId)`, so a seller who had added two lines and a charge before
   * noticing the wrong payment would lose all of it — silently, which is how this codebase has
   * lost typed work before.
   */
  const refreshTaken = useCallback(async () => {
    if (!saleId) return;
    // Direct reads and `setState` (a spent demand would do nothing).
    const [doc, paid] = await Promise.all([saleDocument(saleId), salePaid(saleId)]);
    if (!doc) return;
    setState((prev) => ({ ...prev, was: doc, alreadyPaid: paid }));
  }, [saleId, setState]);

  return {
    draft: state,
    loaded: Boolean(state.order),
    patch,
    patchOrder,
    updateLine,
    removeLine,
    addLine,
    reset,
    refreshTaken,
    clear,
  };
}

/** What the corrected receipt comes to: the lines, plus the named charges. */
/** The goods alone, before anything is added to them. */
export function amendItems(draft: AmendDraft): number {
  return (draft.order?.lines ?? []).reduce(
    (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0),
    0,
  );
}

/** Everything the shop added by name — transport, loading. */
export function amendCharges(draft: AmendDraft): number {
  return (draft.order?.charges ?? []).reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
}

/** And what is being held against the containers going out. */
export function amendDeposits(draft: AmendDraft): number {
  return (draft.order?.deposits ?? []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
}

/**
 * What the corrected receipt should come to.
 *
 * THE DEPOSIT COUNTS. This was `lines + charges`, while a sale's own total is lines + charges +
 * deposits — so a correction to a receipt carrying a deposit computed a total lower than the
 * receipt it was correcting, and the screen disagreed with the paper before anybody changed
 * anything.
 */
export function amendTotal(draft: AmendDraft): number {
  return amendItems(draft) + amendCharges(draft) + amendDeposits(draft);
}
