'use client';

import { useCallback } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { invalidate } from '@/lib/stacks/invalidation';

/**
 * THE FEW SHOP SETTINGS A PRINTING SCREEN NEEDS, and no more.
 *
 * The Settings page holds the whole `store_settings` row in one snapshot and saves it with one
 * button — right for a page that edits all of it, wrong for a page that edits the paper width.
 * Reading the whole row here would mean this page could write back a header, a footer and a bank
 * account it never showed, and last-writer-wins between two screens is how a shop loses a setting
 * it changed on the other one.
 *
 * So: the columns this page actually reads, and a write that touches only what it was asked to.
 */

export const RECEIPT_PAPER_SCOPE = 'receipt_paper';

export interface ReceiptPaper {
  printer_width_mm: string;
  receipt_header: string | null;
  receipt_footer: string | null;
  show_transfer_details: boolean;
  transfer_bank_name: string | null;
  transfer_account_no: string | null;
  transfer_account_name: string | null;
  receipt_bank_account_id: string | null;
  receipt_logo_path: string | null;
  receipt_logo_width_pct: number;
}

export function useReceiptPaper(storeId: string | null) {
  const read = useCallback(async () => {
    if (!storeId) return null;
    const { data, error } = await getSupabase()
      .from('store_settings')
      .select(
        'printer_width_mm, receipt_header, receipt_footer, show_transfer_details, ' +
          'transfer_bank_name, transfer_account_no, transfer_account_name, ' +
          'receipt_bank_account_id, receipt_logo_path, receipt_logo_width_pct',
      )
      .eq('store_id', storeId)
      .single();
    if (error) throw error;
    // Through `unknown`: postgrest types a multi-column select loosely and the cast is a
    // statement about the columns named above, not a claim the checker can verify.
    return data as unknown as ReceiptPaper;
  }, [storeId]);

  const resource = useResource<ReceiptPaper | null>({
    key: `receipt-paper:${storeId ?? 'none'}`,
    scope: RECEIPT_PAPER_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read,
  });

  /** Write ONLY the named columns. Never the whole row this page did not show. */
  const patch = useCallback(
    async (next: Partial<ReceiptPaper>) => {
      if (!storeId) return;
      const { error } = await getSupabase()
        .from('store_settings')
        .update(next)
        .eq('store_id', storeId);
      if (error) throw error;
      invalidate(RECEIPT_PAPER_SCOPE);
      await resource.reload();
    },
    [storeId, resource],
  );

  return { ...resource, patch };
}
