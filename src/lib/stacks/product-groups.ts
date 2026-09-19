/**
 * The groups a shop sorts its products into — NBL, Guinness, Beer, PET.
 *
 * MANY per product, and that is the whole point. One category per product cannot say what a shop
 * means: Goldberg is a beer, it comes in a PET bottle, and NIGERIAN BREWERIES made it.
 *
 * The maker is the one that earns its keep, because the empties belong to the brewery and are
 * interchangeable across everything bought from it — an NBL crate takes any NBL bottle, a Guinness
 * crate any Guinness bottle. That is why `empties_categories` names its pools "NBL crate" and
 * "NBL bottle" rather than one per brand, and why "who made it" is worth recording next to "what
 * shelf does it sit on", which is a different question with a different answer.
 *
 * `product_categories` held three rows since the shop was seeded and every product form sent
 * `p_category_id: null`, so the column was read and never written. 0093 gave it a join table, a way
 * to make one, and a way to retire one.
 */

'use client';

import { useCallback, useMemo } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import { invalidate } from '@/lib/stacks/invalidation';
import { useResource } from '@/lib/stacks/resource';

export interface ProductGroup {
  id: string;
  name: string;
  /** How many products are in it — so a picker can lead with the ones a shop actually uses. */
  products: number;
}

/**
 * Every group in the shop.
 *
 * In its own scope rather than the catalogue's, which is where the product LIST lives: a group
 * changing must not re-read every product in the shop. This is the shop's own vocabulary, and it
 * changes about never. Putting it in the account scope would have leaving a customer's account
 * delete it, which is exactly the bug that scope separation exists to prevent.
 */
export function useProductGroups(storeId: string | null) {
  /*
   * A RESOURCE, so the list says whether it has been read. It started as `[]`, so a picker or a
   * page said "none yet" before the first answer — the same words as a shop with none — and a read
   * that failed said it for good. Same key and shape: what was cached carries over.
   */
  const r = useResource<ProductGroup[]>({
    key: `product-groups:${storeId ?? 'none'}`,
    scope: GROUPS_SCOPE,
    enabled: Boolean(storeId),
    read: async () => {
      const { data, error } = await getSupabase().rpc('store_product_groups', {
        p_store_id: storeId,
      });
      if (error) throw error;
      return ((data ?? []) as { id: string; name: string; products: number }[]).map((row) => ({
        id: row.id,
        name: row.name,
        products: Number(row.products) || 0,
      }));
    },
  });
  const setList = r.set;
  const groups = useMemo(() => r.data ?? [], [r.data]);

  const add = useCallback(
    (group: ProductGroup) =>
      setList((prev) => {
        const list = prev ?? [];
        if (list.some((g) => g.id === group.id)) return list;
        return [...list, group].sort((a, b) => a.name.localeCompare(b.name));
      }),
    [setList],
  );

  return { groups, add, reload: r.reload, loaded: r.loaded, loading: r.loading, error: r.error };
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

/**
 * The shop's groups changed — and ONLY the groups.
 *
 * This invalidated `CATALOG_SCOPE`, which is where the product LIST lives. Every product save calls
 * `setProductGroups`, so saving anything re-read every product in the shop to learn something this
 * device had just decided — the exact round trip `probe-no-round-trip.mjs` exists to forbid, and it
 * caught this the moment the probe itself was repaired enough to run.
 *
 * The groups have their own scope now. What genuinely IS server-computed here is each group's
 * product count, which is why this invalidates at all rather than doing nothing: a group that has
 * just gained its first product should stop saying "not used yet".
 */
export const GROUPS_SCOPE = 'product_groups';

export function groupsChanged() {
  invalidate(GROUPS_SCOPE);
}
