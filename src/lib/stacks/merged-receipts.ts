'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { ACCOUNT_DERIVED_SCOPE } from '@/lib/stacks/customer-account';
import type { SaleDetail } from '@/app/(app)/main/sell-stack/sell-page/Receipt';

/**
 * RECEIPTS PUT TOGETHER (0254) — a VIEW of one customer's receipts as one, for printing and
 * sharing. Nothing is written: every receipt stays exactly as it was recorded.
 */
export interface MergeableReceipt {
  saleId: string;
  occurredAt: string;
  total: number;
  /** What is still open on this receipt alone. */
  outstanding: number;
  lineCount: number;
}

/** The customer's standing receipts, newest first, from any one of them. */
export function useMergeableReceipts(saleId: string | null) {
  return useResource<MergeableReceipt[]>({
    key: `mergeable-receipts:${saleId ?? 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: Boolean(saleId),
    deps: [saleId ?? ''],
    read: async () => {
      const { data, error } = await getSupabase().rpc('mergeable_receipts', { p_sale_id: saleId });
      if (error) throw error;
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        saleId: String(r.sale_id),
        occurredAt: String(r.occurred_at),
        total: Number(r.total) || 0,
        outstanding: Number(r.outstanding) || 0,
        lineCount: Number(r.line_count) || 0,
      }));
    },
  });
}

/**
 * The chosen receipts read as one, in a receipt's own shape so it prints with `receiptDocument`:
 * the same item at the same price added into one line, every charge and payment, and what they owe
 * and what is still with them said once, as it stands now.
 */
export function useMergedReceipts(saleIds: string[]) {
  const ids = [...saleIds].sort();
  return useResource<SaleDetail>({
    key: `merged-receipts:${ids.join(',') || 'none'}`,
    scope: ACCOUNT_DERIVED_SCOPE,
    enabled: ids.length > 0,
    deps: [ids.join(',')],
    read: async () => {
      const { data, error } = await getSupabase().rpc('merged_receipts', { p_sale_ids: ids });
      if (error) throw error;
      return data as unknown as SaleDetail;
    },
  });
}
