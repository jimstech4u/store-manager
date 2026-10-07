'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE, accountsChanged } from '@/lib/stacks/customer-account';

/**
 * COMBINED RECEIPTS (0253) — several of one customer's receipts printed and shared as one.
 *
 * Each sale stays exactly as it was recorded; the newest is the one the group prints under, and the
 * customer's balance and empties are said once on it. The receipt screen reads the combined paper
 * through `receipt_detail`; this module is choosing, combining and taking apart.
 */
export interface CombinableReceipt {
  saleId: string;
  occurredAt: string;
  total: number;
  /** What is still open on THIS receipt alone. */
  outstanding: number;
  lineCount: number;
  /** The receipt it prints under now — itself when it is not combined. */
  headId: string;
}

/** The customer's standing receipts, newest first, from any one of them. */
export function useCombinableReceipts(saleId: string | null) {
  return useResource<CombinableReceipt[]>({
    key: `combinable-receipts:${saleId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(saleId),
    deps: [saleId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('combinable_receipts', { p_sale_id: saleId });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        saleId: String(r.sale_id),
        occurredAt: String(r.occurred_at),
        total: Number(r.total) || 0,
        outstanding: Number(r.outstanding) || 0,
        lineCount: Number(r.line_count) || 0,
        headId: String(r.head_id),
      }));
    },
  });
}

/** Combine them; the newest is the head, and its id comes back. */
export async function combineReceipts(saleIds: string[], reason?: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('combine_receipts', {
    p_sale_ids: saleIds,
    p_reason: reason?.trim() || null,
  });
  if (error) throw error;
  // Every receipt and account that reads them re-reads.
  accountsChanged();
  return String(data);
}

/** One receipt out of its group — or, from the head, the whole group apart. */
export async function uncombineReceipt(saleId: string): Promise<void> {
  const { error } = await getSupabase().rpc('uncombine_receipt', { p_sale_id: saleId });
  if (error) throw error;
  accountsChanged();
}
