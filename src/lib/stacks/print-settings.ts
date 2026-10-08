'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';

/**
 * THE SHOP'S PAPER — roll width, letterhead and footer — as a receipt prints with them. Its own key:
 * All items reads `print-settings:` in a narrower shape, and one key holds one shape.
 */
export function usePrintSettings(storeId: string | null) {
  return useResource<{ width: number; header: string | null; footer: string | null }>({
    key: `print-paper:${storeId ?? 'none'}`,
    scope: 'store_settings',
    enabled: Boolean(storeId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('ensure_store_settings', { p_store_id: storeId });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | { printer_width_mm: string; receipt_header: string | null; receipt_footer: string | null }
        | null;
      return {
        width: Number(row?.printer_width_mm ?? 80) || 80,
        header: row?.receipt_header ?? null,
        footer: row?.receipt_footer ?? null,
      };
    },
  });
}
