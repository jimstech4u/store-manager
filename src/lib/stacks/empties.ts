'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useDemandState } from '@academix-admin/state-stack';
import { getSupabase } from '@/lib/supabase/client';
import { ACCOUNT_DERIVED_SCOPE, accountsChanged } from '@/lib/stacks/customer-account';
import { messageOf } from '@/lib/format';

/**
 * What each receipt still has out, and what is being held against it.
 *
 * PER RECEIPT, not per customer, because that is how a shop remembers it: a name, a day, and a
 * stack of crates that went out with it. The account page already answers "how many NBL bottles
 * does Irekanmi owe"; nobody at a counter thinks in those terms when a man walks in with crates in
 * his boot. They think "these are from Tuesday".
 */

export interface EmptiesPool {
  category_id: string;
  category: string;
  kind: 'content' | 'container';
  units: string;
  suggested_deposit: string;
}

export interface ReceiptEmpties {
  sale_id: string;
  occurred_at: string;
  store_customer_id: string | null;
  customer_name: string;
  sale_total: string;
  expected: EmptiesPool[];
  outstanding_units: string;
  /**
   * What this customer owes across every receipt.
   *
   * Shown beside the per-receipt figure rather than folded into it. `return_empties` settles a
   * customer's pool without naming a receipt — rightly, since somebody handing back twelve bottles
   * is not saying which Tuesday they came from — so the two figures can legitimately disagree.
   * Guessing which receipt an untagged return belonged to would put a number on screen that the
   * shop cannot check.
   */
  pool_outstanding: string;
  held: string;
}

export function useReceiptEmpties(storeId: string | null, customerId?: string | null) {
  const [state, demand] = useDemandState<{
    rows: ReceiptEmpties[];
    error: string | null;
    settled: boolean;
  }>(
    { rows: [], error: null, settled: false },
    {
      key: `empties:${storeId ?? 'none'}:${customerId ?? 'all'}`,
      /*
       * The account's derived scope, because these ARE the account's figures seen from another
       * angle. Settling on this page moves what the account page shows, and the reverse; sharing
       * the scope is what makes `accountsChanged()` correct both without either knowing the other
       * exists.
       */
      scope: ACCOUNT_DERIVED_SCOPE,
      persist: true,
      deps: [storeId ?? '', customerId ?? ''],
      // No ttl. It deletes live state rather than marking it stale, so the page would blank on the
      // way back to it — the thing the persisted cache exists to prevent.
    },
  );

  /*
   * The rows already on screen, reachable from inside the loader.
   *
   * A failed refresh must not blank a page somebody is reading — the rule this project learnt the
   * hard way. `set` here takes a whole value rather than an updater, so the previous rows have to
   * come from somewhere; a ref keeps them without putting `rows` in the loader's dependencies,
   * which would rebuild the loader on every fetch.
   */
  const rowsRef = useRef<ReceiptEmpties[]>([]);
  rowsRef.current = state.rows;

  const load = useCallback(() => {
    if (!storeId) return;
    demand(async ({ set }) => {
      try {
        const { data, error } = await getSupabase().rpc('empties_by_receipt', {
          p_store_id: storeId,
          p_customer_id: customerId ?? null,
          p_limit: 100,
        });
        if (error) throw error;
        set(
          { rows: (data ?? []) as ReceiptEmpties[], error: null, settled: true },
          // A shop that has just settled everything genuinely HAS an empty list; without this
          // state-stack reads that as "no value" and keeps the rows from before they settled.
          { override: true },
        );
      } catch (e) {
        set(
          {
            rows: rowsRef.current,
            error: messageOf(e, 'Could not read what is still out.'),
            settled: true,
          },
          { override: true },
        );
      }
    });
  }, [storeId, customerId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    rows: state.rows,
    error: state.error,
    loading: !state.settled && state.rows.length === 0,
    reload: load,
  };
}

/** What the shop suggests holding for a receipt, before the seller types over it. */
export function suggestedDeposit(pools: EmptiesPool[]): number {
  return pools.reduce((t, p) => t + Number(p.units) * Number(p.suggested_deposit), 0);
}

export async function holdReceiptDeposit(
  storeId: string,
  saleId: string,
  amount: number,
  note?: string,
) {
  const { data, error } = await getSupabase().rpc('hold_receipt_deposit', {
    p_store_id: storeId,
    p_sale_id: saleId,
    p_amount: amount,
    p_note: note ?? null,
  });
  if (error) throw error;
  accountsChanged();
  return data as string;
}

export async function settleEmpties(args: {
  storeId: string;
  saleId: string;
  returned: { category_id: string; qty: number }[];
  applyAmount: number;
  refundAmount: number;
  refundMode: 'cash' | 'credit' | 'none';
  note?: string;
}) {
  const { data, error } = await getSupabase().rpc('settle_empties', {
    p_store_id: args.storeId,
    p_sale_id: args.saleId,
    p_returned: args.returned,
    p_apply_amount: args.applyAmount,
    p_refund_amount: args.refundAmount,
    p_refund_mode: args.refundMode,
    p_note: args.note ?? null,
    p_occurred_at: new Date().toISOString(),
  });
  if (error) throw error;
  accountsChanged();
  return data as {
    returned_units: string;
    applied: string;
    refunded: string;
    still_held: string;
    payment_id: string | null;
  };
}

/**
 * What a product has out in customers' yards.
 *
 * Answered in POOLS, because that is where the obligation lives: a Gulder bottle and a Star bottle
 * are the same NBL bottle to everyone involved. "How many Gulder bottles specifically" cannot be
 * answered once a pool is shared, and answering it anyway would be inventing a number the shop
 * could not check against anything.
 */
export interface ProductEmpties {
  category_id: string;
  category: string;
  kind: 'content' | 'container';
  qty_per_base_unit: string | null;
  suggested_deposit: string;
  units_out: string;
  customers_out: number;
}

export function useProductEmpties(productId: string | null) {
  const [state, demand] = useDemandState<{ rows: ProductEmpties[]; settled: boolean }>(
    { rows: [], settled: false },
    {
      key: `product-empties:${productId ?? 'none'}`,
      scope: ACCOUNT_DERIVED_SCOPE,
      persist: true,
      deps: [productId ?? ''],
    },
  );

  const load = useCallback(() => {
    if (!productId) return;
    demand(async ({ set }) => {
      try {
        const { data, error } = await getSupabase().rpc('product_empties', {
          p_product_id: productId,
        });
        if (error) throw error;
        set({ rows: (data ?? []) as ProductEmpties[], settled: true }, { override: true });
      } catch {
        /*
         * Silent, and the rows already on screen stay.
         *
         * This is a supporting figure on a page whose main job is the shelf and the cost. A failed
         * read of it must not put an error over a product page that is otherwise correct — the
         * section simply does not appear, which is also what a product with no returnables looks
         * like.
         */
        set({ rows: state.rows, settled: true }, { override: true });
      }
    });
    // `state.rows` is read inside the loader only on the failure path; depending on it here would
    // rebuild the loader on every successful fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, demand]);

  useEffect(() => {
    load();
  }, [load]);

  return { empties: state.rows, reload: load };
}
