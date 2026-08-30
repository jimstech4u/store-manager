'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';

/**
 * Open orders — several customers being served at once, shareable between staff.
 *
 * Server-backed, with a local cache. The local copy is what the screen renders and edits, so
 * typing stays instant and a dropped connection does not freeze the counter; the server copy is
 * what makes an order **shareable** — a colleague claims it by code, which cannot work if the
 * order only exists on one phone.
 *
 * The device copy is a cache, not the truth. On conflict the server wins, because the server is
 * what a colleague just claimed.
 */

export interface DraftLine {
  key: string;
  productId: string;
  productName: string;
  baseUnit: string;
  qty: string;
  packId: string | null;
  packName: string | null;
  packQty: string | null;
  unitPrice: string;
  containersOut: string;
  /**
   * The configured shape this is being sold in — "Half pack", "1kg". When set, `saleUnitBaseQty`
   * is what one of them is worth in base units, which is NOT derivable from the pack: half a
   * 12-pack is 6, and no pack multiple expresses that.
   */
  saleUnitId: string | null;
  saleUnitName: string | null;
  saleUnitBaseQty: string | null;

  /**
   * The seller typed a price themselves, so stop suggesting one.
   *
   * Bulk bands are re-resolved whenever the quantity or the shape changes, which is right up
   * until somebody deliberately charges something else — a favour, a haggle, a mistake being
   * corrected. Overwriting that the next time they nudge the quantity would silently undo a
   * decision they made on purpose, and the shop would never know it happened.
   *
   * Client-side only; never sent to the server, which stores the price that was actually agreed.
   */
  priceTouched?: boolean;

  /** Why the current suggestion was chosen — 'bulk', 'customer' or 'list'. For the hint text. */
  priceReason?: string | null;
}

export interface DraftCharge {
  key: string;
  /** What this charge was for, in the seller's words. One note per charge, not one per sale. */
  note?: string;
  label: string;
  amount: string;
}

export interface DraftOrder {
  /**
   * The shop has turned this into a sale.
   *
   * Kept for the moment between settling and the tab closing, so nothing tries to save an order
   * the shop has already closed — which fails, and tells the seller their completed sale was not
   * saved.
   */
  settled?: boolean;
  /**
   * The stable identifier for a link somebody is SENT.
   *
   * Distinct from `code`, which is the five characters read aloud at the counter: that one is
   * recycled when an order finishes, so a link built on it would eventually point at a stranger's
   * order. This one is never reused.
   */
  shareToken?: string | null;
  id: string | null;
  /** Stable client id, used for idempotency until the server assigns an id. */
  clientUuid: string;
  code: string | null;
  customerId: string | null;
  customerName: string;
  /** Optional at the counter: a walk-in has no number, and demanding one would stall a sale. */
  customerPhone: string;
  label: string;
  lines: DraftLine[];
  /**
   * @deprecated Kept so an order saved by an older build still loads. New charges go in
   * `charges`; anything found here is migrated into it on load.
   */
  feeAmount: string;
  feeLabel: string;

  /**
   * Several named additions to the bill — transport, loading, an amount carried over.
   *
   * A list rather than one box because a distributor's bill routinely carries more than one, and
   * adding them together under a single name destroys the only thing that makes them answerable
   * weeks later: what each was for.
   */
  charges: DraftCharge[];
  note: string;
  /** False while there are edits the server has not accepted yet. */
  synced: boolean;
}

interface DraftRow {
  id: string;
  code: string;
  label: string | null;
  customer_id: string | null;
  customer_name: string | null;
  total: string;
  line_count: number;
  held_by: string | null;
  created_at: string;
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function makeDraft(): DraftOrder {
  return {
    id: null,
    clientUuid: newId(),
    code: null,
    customerId: null,
    customerName: '',
    customerPhone: '',
    label: '',
    lines: [],
    feeAmount: '',
    feeLabel: '',
    charges: [],
    note: '',
    synced: false,
  };
}

export function makeDraftLine(partial: Partial<DraftLine> = {}): DraftLine {
  return {
    key: newId(),
    productId: '',
    productName: '',
    baseUnit: 'piece',
    qty: '1',
    packId: null,
    packName: null,
    packQty: null,
    unitPrice: '',
    containersOut: '',
    saleUnitId: null,
    saleUnitName: null,
    saleUnitBaseQty: null,
    priceTouched: false,
    priceReason: null,
    ...partial,
  };
}

export function lineTotal(line: DraftLine): number {
  const qty = Number(line.qty);
  const price = Number(line.unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0;
  return qty * price;
}

export function draftSubtotal(order: DraftOrder): number {
  return order.lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

export function chargesTotal(order: DraftOrder): number {
  return (order.charges ?? []).reduce((sum, c) => {
    const n = Number(c.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

export function draftTotal(order: DraftOrder): number {
  // `feeAmount` is still counted for an order that was started by an older build and has not been
  // re-saved since. Dropping it would quietly lower a bill someone is part-way through.
  const fee = Number(order.feeAmount);
  return draftSubtotal(order) + chargesTotal(order) + (Number.isFinite(fee) ? fee : 0);
}

/**
 * How many base units one of whatever is being sold amounts to.
 *
 * A sale unit wins over the pack: "half pack" is 6 base units, which no pack multiple can say.
 *
 * Exported, and used everywhere this conversion is needed, because it was previously open-coded
 * in two places that disagreed. The price-vs-cost check divided by the PACK size while the
 * quantity maths divided by the SALE UNIT — so selling a half pack at a healthy margin was
 * flagged as below cost, and the warning only cleared at nearly twice the right price. Anything
 * converting sale units to base units belongs here.
 */
export function baseUnitsPerSaleUnit(line: DraftLine): number {
  if (line.saleUnitBaseQty) {
    const each = Number(line.saleUnitBaseQty);
    if (Number.isFinite(each) && each > 0) return each;
  }
  const factor = line.packId && line.packQty ? Number(line.packQty) : 1;
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

export function lineBaseQty(line: DraftLine): number {
  const qty = Number(line.qty);
  if (!Number.isFinite(qty)) return 0;
  return qty * baseUnitsPerSaleUnit(line);
}

export function useDraftOrders(storeId: string | null) {
  /*
   * PERSISTED, AND RECONCILED AGAINST THE SHOP.
   *
   * Both halves matter. A refresh should show the till instantly, from what this device already
   * had — waiting on the network to learn who you were serving means staring at an empty screen
   * every reload. And the shop is still the truth, so what comes back replaces it.
   *
   * This was turned OFF for a while because the two appeared to race, and a pile of flags grew
   * around it to referee. None of that was needed: `persist` puts the saved orders in `orders` for
   * the very first render, and `demand` runs its loader after that, so there was never a moment
   * to arbitrate. The one thing that does have an order is writing the rows before saying the
   * shop has answered — see the loader below.
   */
  const [orders, demandOrders, setOrders] = useDemandState<DraftOrder[]>([], {
    key: 'draftOrders',
    scope: 'sell_flow',
    persist: true,
    deps: [storeId ?? ''],
    // Working state, not fetched data: a remount must restore what was on screen rather than
    // reloading it away mid-sale.
    revalidateOnMount: false,
  });

  // Follows the orders: the tab you were on is part of what a refresh should give you back.
  const [activeId, , setActiveId] = useDemandState<string | null>(null, {
    key: 'draftActive',
    scope: 'sell_flow',
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Push one order to the server, adopting the id and share code it assigns. */
  const push = useCallback(
    async (order: DraftOrder) => {
      if (!storeId) return order;
      setSyncing(true);
      setError(null);
      try {
        const { data, error: err } = await getSupabase().rpc('save_draft_order', {
          p_store_id: storeId,
          p_draft_id: order.id,
          p_customer_id: order.customerId,
          p_label: order.label || order.customerName || null,
          p_fee_amount: Number(order.feeAmount) || 0,
          p_fee_label: order.feeLabel || null,
          p_charges: (order.charges ?? [])
            .filter((c) => Number(c.amount) > 0)
            .map((c) => ({
              label: c.label.trim() || 'Charge',
              amount: Number(c.amount),
              note: c.note?.trim() || null,
            })),
          p_note: order.note || null,
          p_client_uuid: order.clientUuid,
          p_lines: order.lines
            .filter((l) => l.productId && Number(l.qty) > 0)
            .map((l) => ({
              product_id: l.productId,
              qty: Number(l.qty),
              pack_id: l.packId,
              base_qty: lineBaseQty(l),
              unit_price: Number(l.unitPrice) || 0,
              line_total: lineTotal(l),
              containers_out: Number(l.containersOut) || 0,
            })),
        });
        if (err) throw err;

        const savedId = data as string;

        // Read back the code the server generated. Only needed the first time — afterwards the
        // code is already held locally and does not change.
        let code = order.code;
        let shareToken = order.shareToken ?? null;
        if (!code || !shareToken) {
          const { data: row } = await getSupabase()
            .from('draft_orders')
            .select('code, share_token')
            .eq('id', savedId)
            .maybeSingle();
          const found = row as { code: string; share_token: string } | null;
          code = code ?? found?.code ?? null;
          // Read once and kept: unlike the code, this never changes for the life of the order.
          shareToken = shareToken ?? found?.share_token ?? null;
        }

        setOrders((prev) =>
          prev.map((o) =>
            o.clientUuid === order.clientUuid
              ? { ...o, id: savedId, code, shareToken, synced: true }
              : o,
          ),
        );
        return { ...order, id: savedId, code, shareToken, synced: true };
      } catch (e: unknown) {
        // A failed push is not a lost order — the local copy stands and can be pushed again.
        // Saying "not saved yet" is honest; silently dropping it would not be.
        setError(e instanceof Error ? e.message : 'Could not save this order');
        return order;
      } finally {
        setSyncing(false);
      }
    },
    [storeId, setOrders],
  );

  const startOrder = useCallback(() => {
    const order = makeDraft();
    setOrders((prev) => [...prev, order]);
    setActiveId(order.clientUuid);

    /*
     * Straight to the shop, before it has anything on it.
     *
     * Online-first: an order exists from the moment the "+" is pressed. That is what gives it a
     * handover code a colleague can be told immediately, and what makes it survive a flat battery
     * — sign in on another phone and the customers being served are still there. Waiting for the
     * first item meant a tab that existed only on one device, and a code that could not be read
     * out until something had been added to it.
     */
    void push(order);
    return order.clientUuid;
  }, [setOrders, setActiveId, push]);

  const updateOrder = useCallback(
    (clientUuid: string, patch: Partial<DraftOrder>) => {
      setOrders((prev) =>
        prev.map((o) => (o.clientUuid === clientUuid ? { ...o, ...patch, synced: false } : o)),
      );
    },
    [setOrders],
  );

  const closeOrder = useCallback(
    (clientUuid: string) => {
      setOrders((prev) => {
        const at = prev.findIndex((o) => o.clientUuid === clientUuid);
        const next = prev.filter((o) => o.clientUuid !== clientUuid);

        /*
         * THE ONE TO THE RIGHT, or the left when there is nothing to the right.
         *
         * A counter works left to right — the next person waiting is the next tab along — and
         * jumping to the END of the row after every sale sent the seller to whoever had been
         * waiting longest instead of whoever is standing in front of them.
         */
        setActiveId((current) => {
          if (current !== clientUuid) return current;
          if (next.length === 0) return null;
          return next[Math.min(at, next.length - 1)].clientUuid;
        });

        return next;
      });
    },
    [setOrders, setActiveId],
  );

  const addLine = useCallback(
    (clientUuid: string, line: DraftLine) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.clientUuid === clientUuid ? { ...o, lines: [...o.lines, line], synced: false } : o,
        ),
      );
    },
    [setOrders],
  );

  const updateLine = useCallback(
    (clientUuid: string, lineKey: string, patch: Partial<DraftLine>) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.clientUuid === clientUuid
            ? {
                ...o,
                synced: false,
                lines: o.lines.map((l) => (l.key === lineKey ? { ...l, ...patch } : l)),
              }
            : o,
        ),
      );
    },
    [setOrders],
  );

  const removeLine = useCallback(
    (clientUuid: string, lineKey: string) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.clientUuid === clientUuid
            ? { ...o, synced: false, lines: o.lines.filter((l) => l.key !== lineKey) }
            : o,
        ),
      );
    },
    [setOrders],
  );

  /** Take over a colleague's order by its share code. */
  /*
   * Move one tab's lines onto another and close the empty one.
   *
   * Used when a handover code is claimed onto a tab that already has items and the seller chooses
   * to keep both sets. One tab and one code survive: leaving two open for the same customer is how
   * the same goods get read out twice and sold twice.
   *
   * Pushed to the server before the source is closed, so a merge that fails halfway leaves the
   * items somewhere rather than nowhere.
   */
  const mergeInto = useCallback(
    async (fromClientUuid: string, toClientUuid: string) => {
      let merged: DraftOrder | null = null;

      setOrders((prev) => {
        const from = prev.find((o) => o.clientUuid === fromClientUuid);
        const to = prev.find((o) => o.clientUuid === toClientUuid);
        if (!from || !to) return prev;

        // Fresh keys: two orders built independently can hold the same line key, and React would
        // then draw one row for two lines.
        merged = { ...to, lines: [...to.lines, ...from.lines.map((l) => ({ ...l, key: newId() }))] };
        return prev.map((o) => (o.clientUuid === toClientUuid ? merged! : o));
      });

      if (merged) await push(merged);
      closeOrder(fromClientUuid);
    },
    [setOrders, push, closeOrder],
  );

  const claimByCode = useCallback(
    async (code: string) => {
      if (!storeId) return null;
      setError(null);
      try {
        const supabase = getSupabase();
        const { data: draftId, error: err } = await supabase.rpc('claim_draft_order', {
          p_store_id: storeId,
          p_code: code.trim(),
        });
        if (err) throw err;

        const { data: rows } = await supabase.rpc('search_draft_orders', {
          p_store_id: storeId,
          p_query: code.trim(),
        });
        const row = ((rows ?? []) as DraftRow[])[0];

        const { data: lineRows } = await supabase
          .from('draft_order_lines')
          .select(
            'id, product_id, entered_qty, entered_pack_id, unit_price, containers_out, position,' +
              ' products(name, base_unit), product_packs(name, base_unit_qty)',
          )
          .eq('draft_order_id', draftId)
          .order('position');

        type LineRow = {
          id: string;
          product_id: string;
          entered_qty: string;
          entered_pack_id: string | null;
          unit_price: string;
          containers_out: string;
          products: { name: string; base_unit: string } | null;
          product_packs: { name: string; base_unit_qty: string } | null;
        };

        const claimed: DraftOrder = {
          id: draftId as string,
          clientUuid: newId(),
          code: row?.code ?? code.trim().toUpperCase(),
          customerId: row?.customer_id ?? null,
          customerName: row?.customer_name ?? '',
          customerPhone: '',
          label: row?.label ?? '',
          feeAmount: '',
          feeLabel: '',
          charges: [],
          note: '',
          synced: true,
          lines: ((lineRows ?? []) as unknown as LineRow[]).map((l) => ({
            key: newId(),
            productId: l.product_id,
            productName: l.products?.name ?? '',
            baseUnit: l.products?.base_unit ?? 'piece',
            qty: String(l.entered_qty),
            packId: l.entered_pack_id,
            packName: l.product_packs?.name ?? null,
            packQty: l.product_packs?.base_unit_qty ?? null,
            unitPrice: String(l.unit_price),
            containersOut: String(l.containers_out ?? 0),
            saleUnitId: null,
            saleUnitName: null,
            saleUnitBaseQty: null,
          })),
        };

        setOrders((prev) => {
          // Already open on this device — refresh it rather than opening a second tab for the
          // same order, which would let two tabs settle the same thing.
          const existing = prev.findIndex((o) => o.id === claimed.id);
          if (existing >= 0) {
            const next = [...prev];
            next[existing] = { ...claimed, clientUuid: prev[existing].clientUuid };
            return next;
          }
          return [...prev, claimed];
        });
        setActiveId(claimed.clientUuid);
        return claimed;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Could not find that order');
        return null;
      }
    },
    [storeId, setOrders, setActiveId],
  );

  const activeOrder = useMemo(
    () => orders.find((o) => o.clientUuid === activeId) ?? null,
    [orders, activeId],
  );

  /*
   * Pick up whatever this member already has open in the shop.
   *
   * The point of an online-first till: a seller whose phone dies signs in on another one and the
   * customers they were serving are still there. Orders held by nobody come too — an order that
   * was never claimed is loose in the shop, and whoever opens the till next is who it belongs to.
   *
   * THIS IS DELIBERATELY PLAIN. It grew, at various points, a hydrated flag of its own, a retry
   * tick, a session check and a guard that read the current value before deciding — each added to
   * beat a race, and together they raced each other. `demand` already sequences this: it runs
   * after state-stack has restored, and `set` lands before anything reading the value renders.
   * The only thing that has to happen in a particular order is the one below.
   */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!storeId) return;

    void demandOrders(async ({ set }) => {
      const { data } = await getSupabase().rpc('my_open_drafts', { p_store_id: storeId });
      const rows = (data ?? []) as Record<string, unknown>[];

      if (rows.length > 0) {
        const restored: DraftOrder[] = rows.map((row) => ({
          ...makeDraft(),
          id: String(row.id),
          code: (row.code as string | null) ?? null,
          shareToken: (row.share_token as string | null) ?? null,
          label: (row.label as string | null) ?? '',
          customerId: (row.customer_id as string | null) ?? null,
          customerName: (row.customer_name as string | null) ?? '',
          note: (row.note as string | null) ?? '',
          feeAmount: String(row.fee_amount ?? ''),
          feeLabel: (row.fee_label as string | null) ?? '',
          charges: ((row.charges ?? []) as Record<string, unknown>[]).map((c) => ({
            key: newId(),
            label: String(c.label ?? ''),
            amount: String(c.amount ?? ''),
            note: (c.note as string | null) ?? '',
          })),
          // Already the shop's own copy, so nothing to push back.
          synced: true,
          lines: ((row.lines ?? []) as Record<string, unknown>[]).map((l) =>
            makeDraftLine({
              productId: String(l.product_id),
              productName: String(l.product_name ?? 'Item'),
              qty: String(l.qty ?? ''),
              unitPrice: String(l.unit_price ?? ''),
              packId: (l.pack_id as string | null) ?? null,
            }),
          ),
        }));

        set(restored, { override: true });
        setActiveId(restored[0].clientUuid);
      }

      /*
       * LAST, and that is the whole of the ordering that matters.
       *
       * `loaded` is what tells the till it may start a customer when it is holding none. Raised
       * before the rows were written, the till saw an empty list for one render, created a tab,
       * and that write landed on top of the hundred and sixty-seven the shop had just sent.
       */
      setLoaded(true);
    });
  }, [storeId, demandOrders, setActiveId]);

  // Push edits shortly after typing stops. Saving on every keystroke would put a request behind
  // each character; saving only on settle would mean a colleague claiming the code receives a
  // stale order.
  useEffect(() => {
    /*
     * Only orders that are still OPEN.
     *
     * A settled order is gone from the shop's point of view — `settle_draft_order` closes it — so
     * pushing it again finds nothing to update, tries to insert, and fails. The seller came back
     * from a receipt to "Not saved to the shop yet" over a sale that had gone through perfectly.
     *
     * No `lines.length > 0` condition: an empty tab is a real order in the shop, and the whole
     * point of creating it server-side is that it exists before anything is on it.
     */
    const unsynced = orders.filter((o) => !o.synced && !o.settled);
    if (unsynced.length === 0) return;
    const t = setTimeout(() => {
      unsynced.forEach((o) => void push(o));
    }, 1200);
    return () => clearTimeout(t);
  }, [orders, push]);

  return {
    orders,
    activeOrder,
    activeId,
    setActiveId,
    startOrder,
    updateOrder,
    closeOrder,
    addLine,
    updateLine,
    removeLine,
    claimByCode,
    mergeInto,
    push,
    syncing,
    /** True once the shop has answered — the till may start a customer only after this. */
    hydrated: loaded,
    /**
     * Nothing to show yet, and not because the till is empty.
     *
     * `persist` means the saved orders are already in `orders` on the first render — there is no
     * hydration to wait for and no flag to consult. So the only moment worth covering is a device
     * that has nothing saved AND has not yet heard from the shop. Showing "nobody is being served"
     * then tells a seller their customers are gone; a moment later they all appear.
     */
    settling: !loaded && orders.length === 0,
    error,
  };
}
