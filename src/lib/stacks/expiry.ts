'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { useInvalidation } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';
/*
 * The DERIVED scope, which is where anything the server computes about the shelf lives.
 *
 * Not a scope of its own: what is going off is a fact about stock on hand, so a delivery or a
 * write-off should refresh it for the same reason it refreshes what the shelf is worth. And
 * `stockMoved()` is the existing publisher for exactly that.
 */
import { DERIVED_SCOPE, stockMoved } from '@/lib/stacks/catalog-stack';

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
  const [summary, demand, setSummary] = useDemandState<ExpirySummary | null>(null, {
    key: `expiry-summary:${storeId ?? 'none'}:${withinDays}`,
    scope: DERIVED_SCOPE,
    persist: true,
    deps: [storeId ?? '', String(withinDays)],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('expiring_summary', {
        p_store_id: storeId,
        p_within_days: withinDays,
      });
      if (error) throw error;
      const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      set(
        r
          ? {
              expiredItems: Number(r.expired_items) || 0,
              expiredValue: Number(r.expired_value) || 0,
              soonItems: Number(r.soon_items) || 0,
              soonValue: Number(r.soon_value) || 0,
              nextDate: (r.next_date as string | null) ?? null,
            }
          : null,
      );
    });
  }, [storeId, withinDays, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? DERIVED_SCOPE : null, load);

  return { summary, reload: load, setSummary };
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
