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

export interface DraftOrder {
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
  feeAmount: string;
  feeLabel: string;
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

export function draftTotal(order: DraftOrder): number {
  const fee = Number(order.feeAmount);
  return draftSubtotal(order) + (Number.isFinite(fee) ? fee : 0);
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
  const [orders, , setOrders] = useDemandState<DraftOrder[]>([], {
    key: 'draftOrders',
    scope: 'sell_flow',
    persist: true,
    deps: [storeId ?? ''],
    // Working state, not fetched data: a remount must restore what was on screen rather than
    // reloading it away mid-sale.
    revalidateOnMount: false,
  });

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
        if (!code) {
          const { data: row } = await getSupabase()
            .from('draft_orders')
            .select('code')
            .eq('id', savedId)
            .maybeSingle();
          code = (row as { code: string } | null)?.code ?? null;
        }

        setOrders((prev) =>
          prev.map((o) =>
            o.clientUuid === order.clientUuid ? { ...o, id: savedId, code, synced: true } : o,
          ),
        );
        return { ...order, id: savedId, code, synced: true };
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
    return order.clientUuid;
  }, [setOrders, setActiveId]);

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

  // Push edits shortly after typing stops. Saving on every keystroke would put a request behind
  // each character; saving only on settle would mean a colleague claiming the code receives a
  // stale order.
  useEffect(() => {
    const unsynced = orders.filter((o) => !o.synced && o.lines.length > 0);
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
    push,
    syncing,
    error,
  };
}
