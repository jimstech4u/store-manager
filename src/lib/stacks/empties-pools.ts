/**
 * The shop's own empties pools — the crates and bottles it deals in, and what it holds against them.
 *
 * A pool is the thing a deposit is charged against and a return is counted in: "NBL crate" holds
 * ₦1,500 in this shop, "NBL bottle" ₦125. Both figures were seeded by a migration and there has
 * never been a screen that could change one — `save_empties_category` was added in 0082 for a
 * screen nobody built, and it edits only, so there was no way to make the first pool either.
 *
 * Separate from `empties.ts`, which is about what is OUT with customers. This is the shop's
 * configuration: the same distinction as a product versus its stock.
 */

'use client';

import { useCallback, useEffect } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { CATALOG_SCOPE } from '@/lib/stacks/customer-account';
import { useInvalidation, invalidate } from '@/lib/stacks/invalidation';

export interface Pool {
  id: string;
  name: string;
  /**
   * `content` is counted from what was SOLD — twelve bottles in a crate of twelve. `container` is
   * counted from the containers that physically left. `returnables_for_sale` branches on exactly
   * this, so a pool with the wrong kind is owed in the wrong quantity for ever.
   */
  kind: 'content' | 'container';
  /** What the shop usually holds. A starting point at the counter, never a fixed rate. */
  deposit: string;
  /** Whether anything has ever moved through it — so retiring can be offered honestly. */
  inUse: boolean;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  deposit: string;
  in_use: boolean;
}

/**
 * Every pool the shop deals in.
 *
 * In `CATALOG_SCOPE`, not the account scope, and that separation cost a bug once: the account page
 * drops `customer_flow` on exit, which is right for one customer's figures and wrong for a list of
 * pools that belongs to the shop. A customer's balance is stale the moment they pay; the set of
 * crate types a shop deals in changes about never.
 */
export function usePools(storeId: string | null) {
  const [pools, demandPools] = useDemandState<Pool[]>([], {
    key: `empties-pools:${storeId ?? 'none'}`,
    scope: CATALOG_SCOPE,
    persist: true,
    deps: [storeId ?? ''],
    revalidateOnMount: false,
  });

  const load = useCallback(() => {
    if (!storeId) return;
    void demandPools(async ({ set }) => {
      const { data, error } = await getSupabase().rpc('store_empties_categories', {
        p_store_id: storeId,
      });
      if (error) throw error;
      set(
        ((data ?? []) as Row[]).map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind === 'container' ? 'container' : 'content',
          deposit: String(r.deposit ?? 0),
          inUse: Boolean(r.in_use),
        })),
        { override: true },
      );
    });
  }, [storeId, demandPools]);

  useEffect(load, [load]);
  useInvalidation(CATALOG_SCOPE, load);

  return { pools, reload: load };
}

/** Tell every screen holding a pool list that it has changed. */
export function poolsChanged() {
  invalidate(CATALOG_SCOPE);
}

export async function createPool(args: {
  storeId: string;
  name: string;
  kind: 'content' | 'container';
  deposit: number;
}): Promise<string> {
  const { data, error } = await getSupabase().rpc('create_empties_category', {
    p_store_id: args.storeId,
    p_name: args.name,
    p_kind: args.kind,
    p_deposit: args.deposit,
  });
  if (error) throw error;
  poolsChanged();
  return data as string;
}

/**
 * Rename a pool, or change what the shop usually holds against it.
 *
 * The KIND is deliberately not editable. Changing it would silently re-answer every outstanding
 * obligation — the same containers counted a different way — and there is no honest migration for
 * that. A pool of the wrong kind is retired and replaced.
 */
export async function savePool(args: { id: string; name: string; deposit: number }) {
  const { error } = await getSupabase().rpc('save_empties_category', {
    p_category_id: args.id,
    p_name: args.name,
    p_deposit: args.deposit,
  });
  if (error) throw error;
  poolsChanged();
}

/** Retire a pool, or bring one back. Refused server-side while customers still hold its containers. */
export async function archivePool(id: string, restore = false) {
  const { error } = await getSupabase().rpc('archive_empties_category', {
    p_category_id: id,
    p_restore: restore,
  });
  if (error) throw error;
  poolsChanged();
}
