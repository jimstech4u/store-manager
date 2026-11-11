'use client';

import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { paperLogo } from '@/lib/paper-logo';
import type { PaperLogo } from '@/lib/share';

/**
 * THE SHOP'S PAPER — roll width, letterhead and footer — as a receipt prints with them. Its own key:
 * All items reads `print-settings:` in a narrower shape, and one key holds one shape.
 */
export function usePrintSettings(storeId: string | null) {
  // v2: with the logo.
  return useResource<{ width: number; header: string | null; footer: string | null; logo: PaperLogo | null }>({
    key: `print-paper:v2:${storeId ?? 'none'}`,
    scope: 'store_settings',
    enabled: Boolean(storeId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('ensure_store_settings', { p_store_id: storeId });
      if (error) throw error;
      const row = (Array.isArray(data) ? data[0] : data) as
        | {
            printer_width_mm: string;
            receipt_header: string | null;
            receipt_footer: string | null;
            receipt_logo_path: string | null;
            receipt_logo_width_pct: number | null;
          }
        | null;
      return {
        width: Number(row?.printer_width_mm ?? 80) || 80,
        header: row?.receipt_header ?? null,
        footer: row?.receipt_footer ?? null,
        logo: paperLogo(row?.receipt_logo_path, row?.receipt_logo_width_pct),
      };
    },
  });
}
