'use client';

import { useCallback } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { useResource } from '@/lib/stacks/resource';
import { invalidate } from '@/lib/stacks/invalidation';
import { catalogChanged } from '@/lib/stacks/catalog-stack';

/**
 * WHEN A SHOP WANTS TO BE TOLD IT IS RUNNING OUT.
 *
 * One general level, and the exceptions. Both readable, both writable, and — the part that was
 * missing — the exceptions LISTABLE: a shop that had set five of them over three months had no way
 * to find out which five, because the only place an item's own level appeared was inside that item's
 * own form. A setting nobody can list is a setting nobody trusts, and an untrusted warning gets
 * ignored, which is the whole feature gone.
 *
 * NOTHING IS DEFAULTED HERE. `null` means nobody has asked to be told, and it is not 0 — zero is a
 * real level meaning "only when there are none at all", which is right for something rare that gets
 * ordered in when a customer asks. Every layer keeps the two apart, down to the column.
 */

export const LOW_STOCK_SCOPE = 'low_stock';

export interface OwnLevel {
  productId: string;
  name: string;
  baseUnit: string;
  onHand: number;
  /** What this item was given. Never null here — an item with no level is not on this list. */
  ownLevel: number;
  /** What the shop's general rule says, for the sentence "this one at 5, everything else at 20". */
  shopLevel: number | null;
}

interface Row {
  product_id: string;
  name: string;
  base_unit: string;
  on_hand: string;
  own_level: string;
  shop_level: string | null;
}

/** The shop's general level. Null is off, and off is a real answer. */
export function useLowStockRule(storeId: string | null) {
  const read = useCallback(async () => {
    if (!storeId) return { level: null as number | null };
    const { data, error } = await getSupabase().rpc('low_stock_rule', { p_store_id: storeId });
    if (error) throw error;
    /*
     * WRAPPED IN AN OBJECT, because the answer can legitimately be null and state-stack reads a bare
     * null as "never answered" — so a shop with no level set would have sat on a loading state for
     * ever. The same trap caught the customer-account hook.
     */
    return { level: data === null || data === undefined ? null : Number(data) };
  }, [storeId]);

  return useResource<{ level: number | null }>({
    key: `low-stock-rule:${storeId ?? 'none'}`,
    scope: LOW_STOCK_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read,
  });
}

/** The items that carry their own level, whether or not they are low right now. */
export function useOwnLevels(storeId: string | null) {
  const read = useCallback(async () => {
    if (!storeId) return [] as OwnLevel[];
    const { data, error } = await getSupabase().rpc('products_with_own_low_stock', {
      p_store_id: storeId,
    });
    if (error) throw error;
    return ((data ?? []) as Row[]).map((r) => ({
      productId: r.product_id,
      name: r.name,
      baseUnit: r.base_unit,
      onHand: Number(r.on_hand) || 0,
      ownLevel: Number(r.own_level),
      shopLevel: r.shop_level === null ? null : Number(r.shop_level),
    }));
  }, [storeId]);

  return useResource<OwnLevel[]>({
    key: `low-stock-own:${storeId ?? 'none'}`,
    scope: LOW_STOCK_SCOPE,
    enabled: Boolean(storeId),
    deps: [storeId ?? ''],
    read,
  });
}

/** Everything that reads a level reads it again. */
function levelsChanged() {
  invalidate(LOW_STOCK_SCOPE);
  catalogChanged();
  /*
   * AND THE PRODUCTS LIST RE-READS — the exception to "a list is told its own news".
   *
   * Everywhere else in this app a list is patched by the screen that changed a row, because that
   * screen knows which row and what it now says, and a full re-read to learn something this device
   * just decided is a round trip for nothing. `catalogChanged()` is deliberately built not to touch
   * the list for that reason.
   *
   * A LEVEL IS DIFFERENT. Changing the shop's rule changes the resolved level on EVERY row, and this
   * device cannot work out what the new value is for each one — it does not know which items carry
   * their own override. There is no row-patch that describes it. Found by a probe: the rule saved
   * correctly, and the stock list went on showing yesterday's marks because it was still holding rows
   * fetched before the change.
   */
  invalidate('catalog_flow');
}

/** The shop's general level. Null turns the warnings off entirely. */
export async function setShopLowStock(storeId: string, level: number | null): Promise<void> {
  const { error } = await getSupabase().rpc('set_low_stock_threshold', {
    p_store_id: storeId,
    p_level: level,
  });
  if (error) throw error;
  levelsChanged();
}

/** One item's own level. Null puts it back under the shop's rule — which is not the same as 0. */
export async function setItemLowStock(productId: string, level: number | null): Promise<void> {
  const { error } = await getSupabase().rpc('set_product_low_stock', {
    p_product_id: productId,
    p_level: level,
  });
  if (error) throw error;
  levelsChanged();
}
