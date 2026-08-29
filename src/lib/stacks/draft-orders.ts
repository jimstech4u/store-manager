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
  label: string;
  amount: string;
}

export interface DraftOrder {
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
   * This was turned OFF for a while because the two raced: state-stack restores its persisted
   * value on mount, and on a device that had never been used that value is an empty list which
   * landed after the shop's answer and erased it. The fix was never to drop persistence — it was
   * to stop guessing when the restore had happened. `isHydrated` says so, and the loader below
   * waits for it, which is how academix-web has always done this.
   */
  const [orders, demandOrders, setOrders, { isHydrated }] = useDemandState<DraftOrder[]>([], {
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
            .map((c) => ({ label: c.label.trim() || 'Charge', amount: Number(c.amount) })),
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
        const next = prev.filter((o) => o.clientUuid !== clientUuid);
        setActiveId((current) =>
          current === clientUuid ? (next[next.length - 1]?.clientUuid ?? null) : current,
        );
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
   * THROUGH `demand`, NOT A BARE `set`.
   *
   * Written as an effect calling the setter directly, this raced state-stack's own restore: the
   * shop's orders landed first and the persisted local copy — empty, on a device that has never
   * been used — arrived a moment later and wiped them. The screen showed a hundred tabs and then
   * dropped to one. `demand` is the mechanism that owns that sequencing, so hydration goes
   * through it and the two can no longer arrive in the wrong order.
   */
  const [hydrated, setHydrated] = useState(false);

  /*
   * Retried until it gets a real answer.
   *
   * A tick that advances only while hydration has not concluded — enough to re-run the effect
   * after a session or a connection that was not ready the first time. It stops as soon as
   * `hydrated` is true, so this is not a poll that runs for the life of the session.
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!storeId || hydrated || !isHydrated) return;
    const t = setTimeout(() => setAttempt((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [storeId, hydrated, isHydrated, attempt]);

  useEffect(() => {
    // Nothing may be decided before the device's own copy is back: reading `get()` too early says
    // "empty" for every till, and that answer is what used to overwrite the shop's.
    if (!storeId || hydrated || !isHydrated) return;

    let cancelled = false;
    void demandOrders(async ({ get, set }) => {
      /*
       * Live work on this device wins.
       *
       * Adopting the shop's copy over a half-typed order would replace what somebody is looking at
       * with an older version of it — the one failure this must never have. Only an empty till
       * asks the shop what it should be holding.
       */
      if ((get()?.length ?? 0) > 0) {
        if (!cancelled) setHydrated(true);
        return;
      }

      /*
       * THE SESSION FIRST, or the answer means nothing.
       *
       * `my_open_drafts` reads the caller from `auth.uid()`. Asked a moment before the session is
       * established it returns no rows — not because the shop has no open orders, but because it
       * does not yet know who is asking. Hydration took that empty answer as final, marked itself
       * done, and let the till start a fresh empty order: a seller signing in on a slow connection
       * watched their open customers simply not appear.
       *
       * Leaving `hydrated` false is the important half. The effect runs again, so a session that
       * arrives late is a delay rather than a lost till.
       */
      const { data: session } = await getSupabase().auth.getSession();
      if (cancelled) return;
      if (!session.session) return;

      const { data, error: err } = await getSupabase().rpc('my_open_drafts', {
        p_store_id: storeId,
      });
      if (cancelled) return;

      // An error is also not an answer. Same reasoning: try again rather than declare the shop
      // empty on the strength of a failed request.
      if (err) return;

      setHydrated(true);
      if (!data) return;

      const rows = data as Record<string, unknown>[];
      if (rows.length === 0) return;

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
        /*
         * The charges come back too.
         *
         * They were written to the shop and never read, so a delivery fee survived only on the
         * device that typed it — pick the order up elsewhere and the items looked complete with
         * the money quietly wrong, which is the worst shape a mistake about money can take.
         */
        charges: ((row.charges ?? []) as Record<string, unknown>[]).map((c) => ({
          key: newId(),
          label: String(c.label ?? ''),
          amount: String(c.amount ?? ''),
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
    });

    return () => {
      cancelled = true;
    };
  }, [storeId, hydrated, isHydrated, attempt, demandOrders, setActiveId]);

  // Push edits shortly after typing stops. Saving on every keystroke would put a request behind
  // each character; saving only on settle would mean a colleague claiming the code receives a
  // stale order.
  useEffect(() => {
    // No `lines.length > 0` any more: an empty tab is a real order in the shop, and the whole
    // point of creating it server-side is that it exists before anything is on it.
    const unsynced = orders.filter((o) => !o.synced);
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
    hydrated,
    /**
     * Still finding out what this till is holding.
     *
     * True until the device's own copy is back AND the shop has answered. A screen that shows
     * "nobody is being served" during that window is telling somebody their customers are gone.
     */
    settling: !isHydrated || !hydrated,
    error,
  };
}
