'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { invalidate, useInvalidation } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';
import { useReload } from '@/lib/stacks/resource';

/**
 * Why the shelf and the records disagree — the shop's list, not ours.
 *
 * Six TREATMENTS decide what the books do (a loss, damage, a missed sale, stock that came in, a
 * miscount, or something else) and a shop cannot invent a seventh — that is a migration, not a text
 * box. What a shop does need is its own WORDS: "went with the delivery van", "spoilt in the sun".
 * Each shop reason is a label plus the treatment it behaves as, so the ledger stays exact while the
 * list reads the way the shop talks.
 *
 * Built-ins and the shop's own arrive from one reader, already ordered, because a picker with two
 * sources is a picker that sorts them wrongly.
 */

export const VARIANCE_REASONS_SCOPE = 'variance-reasons';

export type VarianceDirection = 'short' | 'over' | 'both';

export interface VarianceReason {
  /** null for a built-in: it lives in the reader, not in a row. */
  id: string | null;
  label: string;
  hint: string | null;
  treatment: string;
  direction: VarianceDirection;
  isCustom: boolean;
}

/** One line of the account: how many, and what happened to them. */
export interface VariancePart {
  /** A PLAIN quantity in base units. The server gives it the variance's sign. */
  qty: number;
  /** The treatment — one of the six the ledger knows. */
  reason: string;
  /** What the shop called it, kept on the row beside the treatment. */
  label?: string;
  note?: string;
}

export function useVarianceReasons(storeId: string | null) {
  const [reasons, demand] = useDemandState<VarianceReason[]>([], {
    key: `variance-reasons:${storeId ?? 'none'}`,
    scope: VARIANCE_REASONS_SCOPE,
    deps: [storeId ?? ''],
    revalidateOnMount: true,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demand(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('variance_reasons_for', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Record<string, unknown>[]).map((r) => ({
          id: (r.id as string | null) ?? null,
          label: r.label as string,
          hint: (r.hint as string | null) ?? null,
          treatment: r.treatment as string,
          direction: r.direction as VarianceDirection,
          isCustom: Boolean(r.is_custom),
        })),
      );
    });
  }, [storeId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  useInvalidation(storeId ? VARIANCE_REASONS_SCOPE : null, load);

  const reload = useReload(VARIANCE_REASONS_SCOPE, `variance-reasons:${storeId ?? 'none'}`, load);
  return { reasons, reload };
}

/** Name a reason this shop uses. It joins the list everywhere a gap is accounted for. */
export async function addVarianceReason(
  storeId: string,
  label: string,
  treatment: string,
  direction: VarianceDirection,
) {
  const { error } = await getSupabase().rpc('add_variance_reason', {
    p_store_id: storeId,
    p_label: label.trim(),
    p_treatment: treatment,
    p_direction: direction,
  });
  if (error) throw error;
  invalidate(VARIANCE_REASONS_SCOPE);
}

/**
 * Account for a difference, in as many parts as it took.
 *
 * The parts must add up to the gap EXACTLY — the server refuses anything else, because a remainder
 * is an unexplained shortfall and that is the one thing a period must not close on.
 */
export async function resolveVariance(periodId: string, parts: VariancePart[]) {
  const { error } = await getSupabase().rpc('resolve_variance', {
    p_period_id: periodId,
    p_parts: parts.map((p) => ({
      qty: p.qty,
      reason: p.reason,
      label: p.label ?? null,
      note: p.note ?? null,
    })),
    p_note: null,
  });
  if (error) throw error;
}
