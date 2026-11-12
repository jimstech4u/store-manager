'use client';

import { getSupabase } from '@/lib/supabase/client';
import { accountsChanged } from '@/lib/stacks/customer-account';
import type { SaleContainer } from '@/lib/empties-back';

/**
 * ONE RECEIPT'S CONTAINERS (0280) — per shape, what went out with it, what came back with it, what is
 * still out — and the one way to change "came back": set it to a figure. Up records a return against
 * the receipt; down undoes the newest returns first ("they did not bring those back after all"). The
 * receipt, the correction and the agent all go through `setSaleEmptiesBack`, so there is one rule.
 */

export type { SaleContainer } from '@/lib/empties-back';
export { correctedBack } from '@/lib/empties-back';

export async function saleEmpties(saleId: string): Promise<SaleContainer[]> {
  const { data, error } = await getSupabase().rpc('sale_empties', { p_sale_id: saleId });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    productId: String(r.product_id),
    productName: String(r.product_name ?? ''),
    productUnitId: String(r.product_unit_id),
    unitName: String(r.unit_name ?? ''),
    unitPlural: String(r.unit_plural ?? ''),
    groupName: (r.group_name as string | null) ?? null,
    wentOut: Number(r.went_out) || 0,
    cameBack: Number(r.came_back) || 0,
    stillOut: Number(r.still_out) || 0,
  }));
}

/** Set what came back with this receipt, shape by shape. Only the shapes that change need be sent. */
export async function setSaleEmptiesBack(
  saleId: string,
  units: { productUnitId: string; qty: number }[],
  opts: { reason?: string | null; atSale?: boolean } = {},
): Promise<void> {
  if (units.length === 0) return;
  const { error } = await getSupabase().rpc('set_sale_empties_back', {
    p_sale_id: saleId,
    p_units: units.map((u) => ({ product_unit_id: u.productUnitId, qty: u.qty })),
    p_reason: opts.reason ?? null,
    p_at_sale: Boolean(opts.atSale),
  });
  if (error) throw error;
  accountsChanged();
}

/** Undo one return or write-off on an account, or part of it. */
export async function undoEmptiesMove(moveId: string, qty?: number | null, reason?: string | null): Promise<void> {
  const { error } = await getSupabase().rpc('undo_empties_move', {
    p_move_id: moveId,
    p_qty: qty ?? null,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  accountsChanged();
}

/**
 * WHAT CAME BACK AT THE SALE, per item (0281): returns against the receipt at or before its moment,
 * less what was undone — rows shaped like `sale_detail.empties`, for the paper's out · in · left.
 */
export async function saleEmptiesIn(saleId: string): Promise<unknown[]> {
  const { data, error } = await getSupabase().rpc('sale_empties_in', { p_sale_id: saleId });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
