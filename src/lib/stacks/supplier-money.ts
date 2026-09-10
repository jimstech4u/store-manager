'use client';

import { getSupabase } from '@/lib/supabase/client';
import { suppliersChanged } from '@/lib/stacks/suppliers';

/**
 * Money between the shop and a supplier.
 *
 * Its own file rather than another export on `suppliers.ts`, which already carries the record and
 * the containers. Three things about one counterparty that settle at three different moments, and
 * a module per question is easier to read than one that answers all three.
 *
 *   paid   — the shop handed money over.
 *   charge — the shop owes more, and no delivery carried it: haulage, a levy, a shortfall.
 *   credit — the supplier owes the shop: a rebate, a load sent back, an overpayment.
 */
export async function recordSupplierPayment(args: {
  storeId: string;
  supplierId: string;
  amount: number;
  direction?: 'paid' | 'charge' | 'credit';
  method?: string;
  reason?: string;
  purchaseId?: string | null;
}) {
  const { error } = await getSupabase().rpc('record_supplier_payment', {
    p_store_id: args.storeId,
    p_supplier_id: args.supplierId,
    p_amount: args.amount,
    p_direction: args.direction ?? 'paid',
    p_method: args.method?.trim() || null,
    p_reason: args.reason?.trim() || null,
    p_purchase_id: args.purchaseId ?? null,
  });
  if (error) throw error;
  suppliersChanged();
}
