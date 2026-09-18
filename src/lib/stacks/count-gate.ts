'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { invalidate, useInvalidation } from '@/lib/stacks/invalidation';
import { whichNeedCount } from '@/lib/stacks/mid-sale';
import { getSupabase } from '@/lib/supabase/client';

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

  const [uncounted, demand] = useDemandState<string[]>([], {
    key: `uncounted:${storeId ?? 'none'}:${key}`,
    scope: COUNTS_SCOPE,
    persist: false,
    deps: [storeId ?? '', key],
    revalidateOnMount: true,
  });

  const load = useCallback(() => {
    if (!storeId || ids.length === 0) return;
    void demand(async ({ set }) => {
      const owing = await whichNeedCount(ids);
      set(ids.filter((id) => owing.has(id)));
    });
    // `key` stands in for `ids`: the same set of products is the same question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, key, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? COUNTS_SCOPE : null, load);

  // No products means nothing can be uncounted, whatever an earlier key left behind.
  return { uncounted: ids.length === 0 ? [] : uncounted, reload: load };
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

  const [rows, demand] = useDemandState<TodaysCount[]>([], {
    key: `todays-counts:${storeId ?? 'none'}:${key}`,
    scope: COUNTS_SCOPE,
    persist: false,
    deps: [storeId ?? '', key],
    revalidateOnMount: true,
  });

  const load = useCallback(() => {
    if (!storeId || ids.length === 0) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('todays_counts', { p_product_ids: ids });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          productId: r.product_id as string,
          periodId: r.period_id as string,
          periodStatus: r.period_status as TodaysCount['periodStatus'],
          countedBase: Number(r.counted_qty ?? 0),
          firstBase: Number(r.first_qty ?? 0),
          countedBy: (r.counted_by_name as string) ?? 'Someone',
          countedByYou: Boolean(r.counted_by_you),
          countedAt: r.counted_at as string,
          firstBy: (r.first_by_name as string) ?? 'Someone',
          firstAt: (r.first_at as string) ?? (r.counted_at as string),
          edits: Number(r.edits ?? 0),
          lastEditedBy: (r.last_edited_by as string | null) ?? null,
          lastEditedAt: (r.last_edited_at as string | null) ?? null,
          lastReason: (r.last_reason as string | null) ?? null,
        })),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, key, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? COUNTS_SCOPE : null, load);

  const byProduct = useMemo(() => {
    const m = new Map<string, TodaysCount>();
    if (ids.length > 0) for (const r of rows) m.set(r.productId, r);
    return m;
  }, [rows, ids.length]);

  return { byProduct, reload: load };
}

/** The day's history of one item's count, oldest first. */
export function useCountTrail(storeId: string | null, productId: string | null) {
  const [steps, demand] = useDemandState<CountTrailStep[]>([], {
    key: `count-trail:${storeId ?? 'none'}:${productId ?? 'none'}`,
    scope: COUNTS_SCOPE,
    persist: false,
    deps: [storeId ?? '', productId ?? ''],
    revalidateOnMount: true,
  });

  const load = useCallback(() => {
    if (!storeId || !productId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('todays_count_trail', {
        p_product_id: productId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          kind: r.kind as CountTrailStep['kind'],
          qtyBase: Number(r.qty ?? 0),
          oldBase: r.old_qty === null || r.old_qty === undefined ? null : Number(r.old_qty),
          reason: (r.reason as string | null) ?? null,
          by: (r.by_name as string) ?? 'Someone',
          byYou: Boolean(r.by_you),
          at: r.at as string,
        })),
      );
    });
  }, [storeId, productId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? COUNTS_SCOPE : null, load);

  return { steps: productId ? steps : [], reload: load };
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
