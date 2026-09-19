'use client';

import { useMemo } from 'react';
import { invalidate } from '@/lib/stacks/invalidation';
import { whichNeedCount } from '@/lib/stacks/mid-sale';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';

/**
 * Which items on an open sale have not been counted today.
 *
 * ONE ANSWER FOR THREE SCREENS. The till pushes the count page, the count page lists what is left,
 * and Take payment refuses to settle until nothing is — and all three used to work from a list the
 * till built up as items were ADDED. A sale left open overnight kept yesterday's answer, so a draft
 * started on Monday could be settled on Tuesday with Tuesday's shelf never counted. Asking the server
 * for the lines that are actually on the sale, whenever those lines change, is the only version that
 * cannot go stale across a day.
 *
 * NOT PERSISTED. "Counted today" is a fact about today; a cached yes carried into tomorrow is exactly
 * the bug this replaces.
 */

export const COUNTS_SCOPE = 'counts-today';

/** Something was counted: every holder re-asks. */
export function countsChanged() {
  invalidate(COUNTS_SCOPE);
}

export function useUncountedToday(storeId: string | null, productIds: string[]) {
  const ids = useMemo(() => [...new Set(productIds)].sort(), [productIds]);
  const key = ids.join(',');

  /*
   * CHECKED, OR NOT YET — never "all counted" by default.
   *
   * This started as `[]`, which reads as "nothing on this sale needs counting" — so until the
   * answer arrived Take payment offered to settle, and a check that FAILED left it saying so for
   * good. `checked` is false until the server has answered for these exact items. Not persisted:
   * "counted today" is a fact about today, and a cached yes carried into tomorrow is the bug this
   * gate was built to prevent.
   */
  const r = useResource<string[]>({
    key: `uncounted:${storeId ?? 'none'}:${key}`,
    scope: COUNTS_SCOPE,
    persist: false,
    enabled: Boolean(storeId) && ids.length > 0,
    read: async () => {
      const owing = await whichNeedCount(ids);
      return ids.filter((id) => owing.has(id));
    },
  });

  // No products means nothing can be uncounted, whatever an earlier key left behind.
  return {
    uncounted: ids.length === 0 ? [] : r.data ?? [],
    checked: ids.length === 0 || r.loaded,
    error: r.error,
    reload: r.reload,
  };
}

/* ── Who counted what today, and what has been changed since ─────────────────────── */

/** Today's count of one item, as the server recorded it. Quantities are in BASE units. */
export interface TodaysCount {
  productId: string;
  periodId: string;
  periodStatus: 'open' | 'closed' | 'locked';
  countedBase: number;
  /** What was said first, before any correction. */
  firstBase: number;
  countedBy: string;
  countedByYou: boolean;
  countedAt: string;
  /** The first walk of the shelf today — who, and when — whatever has replaced it since. */
  firstBy: string;
  firstAt: string;
  edits: number;
  lastEditedBy: string | null;
  lastEditedAt: string | null;
  lastReason: string | null;
}

/** One step in the day's history: the first count, then every fresh count that replaced it. */
export interface CountTrailStep {
  kind: 'counted' | 'recount' | 'correction';
  qtyBase: number;
  oldBase: number | null;
  reason: string | null;
  by: string;
  byYou: boolean;
  at: string;
}

/**
 * Today's counts for these items — who said it, when, and whether it has been corrected.
 *
 * Its own key and shape (`todays-counts:`), in the same scope as the uncounted list, so recording
 * or correcting a count re-asks both.
 */
export function useTodaysCounts(storeId: string | null, productIds: string[]) {
  const ids = useMemo(() => [...new Set(productIds)].sort(), [productIds]);
  const key = ids.join(',');

  /*
   * A resource, not persisted (today's counts must never be carried into tomorrow). It started as
   * `[]`, which reads exactly like "nobody has counted these today" — so for the moment before the
   * answer, a counted item offered itself to be counted again. `loaded` tells the two apart.
   */
  const r = useResource<TodaysCount[]>({
    key: `todays-counts:${storeId ?? 'none'}:${key}`,
    scope: COUNTS_SCOPE,
    persist: false,
    enabled: Boolean(storeId) && ids.length > 0,
    read: async () => {
      const { data, error } = await getSupabase().rpc('todays_counts', { p_product_ids: ids });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        productId: row.product_id as string,
        periodId: row.period_id as string,
        periodStatus: row.period_status as TodaysCount['periodStatus'],
        countedBase: Number(row.counted_qty ?? 0),
        firstBase: Number(row.first_qty ?? 0),
        countedBy: (row.counted_by_name as string) ?? 'Someone',
        countedByYou: Boolean(row.counted_by_you),
        countedAt: row.counted_at as string,
        firstBy: (row.first_by_name as string) ?? 'Someone',
        firstAt: (row.first_at as string) ?? (row.counted_at as string),
        edits: Number(row.edits ?? 0),
        lastEditedBy: (row.last_edited_by as string | null) ?? null,
        lastEditedAt: (row.last_edited_at as string | null) ?? null,
        lastReason: (row.last_reason as string | null) ?? null,
      }));
    },
  });

  const byProduct = useMemo(() => {
    const m = new Map<string, TodaysCount>();
    if (ids.length > 0) for (const row of r.data ?? []) m.set(row.productId, row);
    return m;
  }, [r.data, ids.length]);

  // Nothing to ask about is an answer too: no items, nothing counted.
  const loaded = ids.length === 0 || r.loaded;
  return { byProduct, reload: r.reload, loaded, error: r.error };
}

/** The day's history of one item's count, oldest first. */
export function useCountTrail(storeId: string | null, productId: string | null) {
  const r = useResource<CountTrailStep[]>({
    key: `count-trail:${storeId ?? 'none'}:${productId ?? 'none'}`,
    scope: COUNTS_SCOPE,
    persist: false,
    enabled: Boolean(storeId && productId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('todays_count_trail', {
        p_product_id: productId,
      });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        kind: row.kind as CountTrailStep['kind'],
        qtyBase: Number(row.qty ?? 0),
        oldBase: row.old_qty === null || row.old_qty === undefined ? null : Number(row.old_qty),
        reason: (row.reason as string | null) ?? null,
        by: (row.by_name as string) ?? 'Someone',
        byYou: Boolean(row.by_you),
        at: row.at as string,
      }));
    },
  });
  const steps = useMemo(() => (productId ? (r.data ?? []) : []), [productId, r.data]);
  return { steps, reload: r.reload, loaded: !productId || r.loaded, error: r.error };
}

/**
 * Count the shelf again, with a reason.
 *
 * The same two calls the count screen makes for a first count — open the day, say the figure — and
 * the server does the rest: it refuses anybody without `counts.correct`, and writes the figure being
 * replaced to the trail before it moves anything (0146). `countedBase` is in base units.
 *
 * The TILL never comes here. Counting mid-sale is once a day for everybody.
 */
export async function recountToday(productId: string, countedBase: number, reason: string) {
  const supabase = getSupabase();
  const { data: periodId, error: pErr } = await supabase.rpc('ensure_open_period', {
    p_product_id: productId,
  });
  if (pErr) throw pErr;

  const { error } = await supabase.rpc('enter_stock_count', {
    p_period_id: periodId,
    p_counted: countedBase,
    p_reason: reason.trim(),
  });
  if (error) throw error;
  countsChanged();
  return periodId as string;
}

/** "9:14" today — every count this reads is from today, so the date is never worth saying. */
export function countTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "counted by you at 9:14" / "counted by Ade at 9:14". */
export function countedByWords(c: { countedBy: string; countedByYou: boolean; countedAt: string }) {
  return `by ${c.countedByYou ? 'you' : c.countedBy} at ${countTime(c.countedAt)}`;
}
