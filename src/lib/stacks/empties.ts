'use client';

import { getSupabase } from '@/lib/supabase/client';

/**
 * What is out of one product, in that product's OWN shapes.
 *
 * All that is left of this file. It used to hold the pool era: `useReceiptEmpties`,
 * `useProductEmpties`, `settleEmpties`, `holdReceiptDeposit`, `returnUnitsFor`, `saveReturnUnits`
 * and `returnIsAllowed` — every one of them speaking in `empties_categories`, a vocabulary invented
 * beside the product's own. A product already says what it comes in and which of those shapes come
 * back; the pools said it a second time and could disagree.
 *
 * The rest is in `_unused/store-manager/src/lib/stacks/empties.pool-era.ts`, with the screens that
 * read it. `customer-ledgers.ts` is where the two ledgers live now.
 */
export interface ShapeOut {
  productUnitId: string;
  unitName: string;
  unitPlural: string;
  baseQty: number;
  outNow: number;
  customersOut: number;
  /**
   * What one of these is made of, in the SHOP'S word — "12 bottles".
   *
   * The screen used to say "one is 12 piece", which is `products.base_unit`: a fixed vocabulary of
   * seven storage codes, not something anybody says. Null for the smallest shape on the item,
   * which is made of nothing smaller.
   */
  innerName: string | null;
  innerPlural: string | null;
}

export async function productEmptiesOut(productId: string): Promise<ShapeOut[]> {
  const { data, error } = await getSupabase().rpc('product_empties_out', {
    p_product_id: productId,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productUnitId: String(r.product_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    baseQty: Number(r.base_qty) || 1,
    outNow: Number(r.out_now) || 0,
    customersOut: Number(r.customers_out) || 0,
    innerName: (r.inner_name as string | null) ?? null,
    innerPlural: (r.inner_plural as string | null) ?? null,
  }));
}
