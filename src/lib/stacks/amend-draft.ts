'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { saleCharges, saleDocument, salePaid, type SaleDocument } from '@/lib/stacks/amend';
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
  depositReason: string | null;
  /** Why, asked last — after the money and before the receipt. */
  reason: string;
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
});

/** The receipt's lines, in the shape the till's own row component edits. */
function toOrder(doc: SaleDocument, charges: { label: string; amount: number }[]): DraftOrder {
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
    deposits: [],
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
  const [state, demand, setState] = useDemandState<AmendDraft>(empty(saleId ?? 'none'), {
    key: `amend-draft:${saleId ?? 'none'}`,
    scope: AMEND_DRAFT_SCOPE,
    persist: true,
    deps: [saleId ?? ''],
    revalidateOnMount: false,
  });

  useEffect(() => {
    if (!saleId || state.order) return;
    void demand(async ({ set }) => {
      const [doc, paid, charges] = await Promise.all([
        saleDocument(saleId),
        salePaid(saleId),
        saleCharges(saleId),
      ]);
      if (!doc) return;
      set({ ...empty(saleId), was: doc, order: toOrder(doc, charges), alreadyPaid: paid }, {
        override: true,
      });
    });
  }, [saleId, state.order, demand]);

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
    if (!saleId) return;
    void demand(async ({ set }) => {
      const [doc, paid, charges] = await Promise.all([
        saleDocument(saleId),
        salePaid(saleId),
        saleCharges(saleId),
      ]);
      set(
        doc
          ? { ...empty(saleId), was: doc, order: toOrder(doc, charges), alreadyPaid: paid }
          : empty(saleId),
        { override: true },
      );
    });
  }, [saleId, demand]);

  return {
    draft: state,
    loaded: Boolean(state.order),
    patch,
    patchOrder,
    updateLine,
    removeLine,
    addLine,
    reset,
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
