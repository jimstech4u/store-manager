'use client';

import { getSupabase } from '@/lib/supabase/client';
/*
 * The DERIVED scope, which is where anything the server computes about the shelf lives.
 *
 * Not a scope of its own: what is going off is a fact about stock on hand, so a delivery or a
 * write-off should refresh it for the same reason it refreshes what the shelf is worth. And
 * `stockMoved()` is the existing publisher for exactly that.
 */
import { DERIVED_SCOPE, stockMoved } from '@/lib/stacks/catalog-stack';
import { useResource } from '@/lib/stacks/resource';

/**
 * What is going off, and when.
 *
 * PER DELIVERY, never per product. The same item arrives on different days at different costs with
 * different dates — ten that came cheap and go off on Friday, forty dearer ones good until July —
 * and `stock_layers` already keeps each delivery apart with its own `unit_cost` and its own
 * `remaining_base`. The date sits at that grain because that is the grain it has.
 */

export interface ExpiringLayer {
  layerId: string;
  productId: string;
  productName: string;
  expiresOn: string;
  /** Negative once it has passed. Counted in the SHOP's day, not the phone's. */
  daysLeft: number;
  remaining: number;
  unitCost: number;
  valueAtCost: number;
  receivedAt: string;
  supplier: string | null;
}

export interface ExpirySummary {
  expiredItems: number;
  expiredValue: number;
  soonItems: number;
  soonValue: number;
  nextDate: string | null;
}

/** A dated (or deliberately undated) lot shown while its product is being corrected. */
export interface ProductExpiryLayer {
  layerId: string;
  qty: number;
  remaining: number;
  expiresOn: string | null;
  receivedAt: string;
}

/**
 * The lots for one product, including undated ones.
 *
 * `expiring_stock` is intentionally a warning list, so it excludes undated stock and anything
 * outside the chosen window. The product form needs the complete shelf in order to repair a date
 * that was missed during setup.
 */
export async function productExpiryLayers(productId: string): Promise<ProductExpiryLayer[]> {
  const { data, error } = await getSupabase()
    .from('stock_layers')
    .select('id, qty_base, remaining_base, expires_on, received_at')
    .eq('product_id', productId)
    .gt('remaining_base', 0)
    .order('received_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((layer) => ({
    layerId: String(layer.id),
    qty: Number(layer.qty_base) || 0,
    remaining: Number(layer.remaining_base) || 0,
    expiresOn: (layer.expires_on as string | null) ?? null,
    receivedAt: String(layer.received_at),
  }));
}

/** Correct a lot's expiry date without changing its quantity, cost or FIFO position. */
export async function setProductExpiry(args: {
  layerId: string;
  expiresOn: string | null;
  reason: string;
}): Promise<void> {
  const { error } = await getSupabase().rpc('set_stock_layer_expiry', {
    p_layer_id: args.layerId,
    p_expires_on: args.expiresOn,
    p_reason: args.reason,
  });
  if (error) throw error;
  stockMoved();
}

/** How far ahead to look. The screen offers these; the alarm uses 30. */
export const WINDOWS = [7, 30, 90] as const;

export async function expiringStock(
  storeId: string,
  withinDays: number,
): Promise<ExpiringLayer[]> {
  const { data, error } = await getSupabase().rpc('expiring_stock', {
    p_store_id: storeId,
    p_within_days: withinDays,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    layerId: String(r.layer_id),
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    expiresOn: String(r.expires_on),
    daysLeft: Number(r.days_left),
    remaining: Number(r.remaining) || 0,
    unitCost: Number(r.unit_cost) || 0,
    valueAtCost: Number(r.value_at_cost) || 0,
    receivedAt: String(r.received_at),
    supplier: (r.supplier as string | null) ?? null,
  }));
}

/**
 * The alarm, in one call.
 *
 * A badge should not have to read a list to find out whether there is anything to worry about.
 * Expired and expiring are counted APART because they are two different things to do: one is
 * "sell these first", the other is "take these off the shelf".
 */
export function useExpirySummary(storeId: string | null, withinDays = 30) {
  /*
   * A resource. `null` from the old hook meant both "not read yet" and "the server had no row", and
   * a failed read was never reported. Nothing at all to report is an honest all-zero summary.
   */
  const r = useResource<ExpirySummary>({
    key: `expiry-summary:v2:${storeId ?? 'none'}:${withinDays}`,
    scope: DERIVED_SCOPE,
    enabled: Boolean(storeId),
    deps: [withinDays],
    read: async () => {
      const { data, error } = await getSupabase().rpc('expiring_summary', {
        p_store_id: storeId,
        p_within_days: withinDays,
      });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      return {
        expiredItems: Number(row?.expired_items) || 0,
        expiredValue: Number(row?.expired_value) || 0,
        soonItems: Number(row?.soon_items) || 0,
        soonValue: Number(row?.soon_value) || 0,
        nextDate: (row?.next_date as string | null) ?? null,
      };
    },
  });
  return { summary: r.data, reload: r.reload, loaded: r.loaded, error: r.error };
}

/**
 * Taking a lot off the shelf.
 *
 * It is booked as DAMAGE, not as a nameless adjustment — the distinction 0129 drew between a crate
 * that broke and a crate that walked. Out-of-date stock is breakage the calendar caused, and a
 * shop's damage report should carry it.
 */
export async function writeOffExpired(args: {
  layerId: string;
  qty?: number;
  reason?: string;
}): Promise<void> {
  const { error } = await getSupabase().rpc('write_off_expired', {
    p_layer_id: args.layerId,
    p_qty: args.qty ?? null,
    p_reason: args.reason ?? null,
  });
  if (error) throw error;
  stockMoved();
}
