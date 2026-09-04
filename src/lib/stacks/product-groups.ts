/**
 * The groups a shop sorts its products into — NBL, Guinness, Beer, PET.
 *
 * MANY per product, and that is the whole point. One category per product cannot say what a shop
 * means: Goldberg is a Beer, it comes in a PET bottle, and it is an NBL product. Three groupings
 * that answer different questions, and a distributor uses all three — which crate it goes back in
 * is an NBL question, what shelf it sits on is a Beer question.
 *
 * `product_categories` held three rows since the shop was seeded and every product form sent
 * `p_category_id: null`, so the column was read and never written. 0093 gave it a join table, a way
 * to make one, and a way to retire one.
 */

'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { CATALOG_SCOPE } from '@/lib/stacks/customer-account';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';

export interface ProductGroup {
  id: string;
  name: string;
  /** How many products are in it — so a picker can lead with the ones a shop actually uses. */
  products: number;
}

/**
 * Every group in the shop.
 *
 * In `CATALOG_SCOPE`, with the pools and the units: this is the shop's own vocabulary, and it
 * changes about never. Putting it in the account scope would have leaving a customer's account
 * delete it, which is exactly the bug that scope separation exists to prevent.
 */
export function useProductGroups(storeId: string | null) {
  const [groups, demandGroups] = useDemandState<ProductGroup[]>([], {
    key: `product-groups:${storeId ?? 'none'}`,
    scope: CATALOG_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandGroups(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('store_product_groups', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as { id: string; name: string; products: number }[]).map((r) => ({
          id: r.id,
          name: r.name,
          products: Number(r.products) || 0,
        })),
        { override: true },
      );
    });
  }, [storeId, demandGroups]);

  useEffect(load, [load]);
  useInvalidation(CATALOG_SCOPE, load);

  return { groups, reload: load };
}

/** Which groups one product is in. */
export async function groupsFor(productId: string): Promise<ProductGroup[]> {
  const { data, error } = await getSupabase().rpc('product_groups_for', {
    p_product_id: productId,
  });
  if (error) throw error;
  return ((data ?? []) as { id: string; name: string }[]).map((r) => ({
    id: r.id,
    name: r.name,
    products: 0,
  }));
}

/**
 * Make a group, or find the one that is already there.
 *
 * Called from inside a picker by somebody typing "NBL" who does not know whether it exists — the
 * same gesture the customer and product pickers support. The server returns the existing id rather
 * than refusing, because an error there would be the app telling a shop off for not remembering its
 * own data.
 */
export async function createGroup(storeId: string, name: string): Promise<string> {
  const { data, error } = await getSupabase().rpc('create_product_group', {
    p_store_id: storeId,
    p_name: name,
  });
  if (error) throw error;
  groupsChanged();
  return data as string;
}

/** Say which groups a product is in. Replaces the lot — the form owns the whole list. */
export async function setProductGroups(productId: string, groupIds: string[]) {
  const { error } = await getSupabase().rpc('set_product_groups', {
    p_product_id: productId,
    p_group_ids: groupIds,
  });
  if (error) throw error;
  groupsChanged();
}

/** Retire a group, or bring it back. Products keep it; it stops being offered. */
export async function archiveGroup(id: string, restore = false) {
  const { error } = await getSupabase().rpc('archive_product_group', {
    p_category_id: id,
    p_restore: restore,
  });
  if (error) throw error;
  groupsChanged();
}

export function groupsChanged() {
  invalidate(CATALOG_SCOPE);
}
