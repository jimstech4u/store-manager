'use client';

import { useMemo } from 'react';
import { invalidate } from '@/lib/stacks/invalidation';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';

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
  // A resource: an empty picker before the first answer read as "this shop has no reasons".
  const r = useResource<VarianceReason[]>({
    key: `variance-reasons:v2:${storeId ?? 'none'}`,
    scope: VARIANCE_REASONS_SCOPE,
    enabled: Boolean(storeId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('variance_reasons_for', {
        p_store_id: storeId,
      });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        id: (row.id as string | null) ?? null,
        label: row.label as string,
        hint: (row.hint as string | null) ?? null,
        treatment: row.treatment as string,
        direction: row.direction as VarianceDirection,
        isCustom: Boolean(row.is_custom),
      }));
    },
  });
  const reasons = useMemo(() => r.data ?? [], [r.data]);
  return { reasons, reload: r.reload, loaded: r.loaded, error: r.error };
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
